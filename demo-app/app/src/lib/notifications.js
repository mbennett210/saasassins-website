// Notification catalog — single source of truth for the per-user toggle list,
// the role/permission gates that govern visibility, and the labels used in
// the Account → Notifications panel.
//
// Visibility rules:
//   - roleAllowlist: array of role keys ('owner' | 'admin' | 'manager' | 'crew') that
//     may see the toggle. Omitted = all roles.
//   - requiresPermission: a permission key. If set, the user must have it
//     (per `can()` in lib/roles.js) for the toggle to be visible.
//   - labelKey / descKey: the toggle's wording, as catalog keys (src/i18n, CS-193), so the
//     Account page shows it in the reader's language. `label` / `description` still read
//     as the English (getters over the catalog, below) for any code that wants the words.
//
// The default-on event toggles + the default-on (opt-out) mobilePushEnabled
// master flag live alongside in DEFAULT_NOTIFICATION_PREFS (defined in seed.js
// and mirrored in persist.js for migrations) — the catalog here only describes
// presentation + gating, not defaults. mobilePushEnabled is intent only; actual
// OS push delivery additionally requires an explicit per-device subscription
// (lib/push.js) and the server dispatcher (api/push/dispatch.js).

// Explicit .js extensions — this module is imported server-side by
// api/_lib/ingestEmail.js (the inbound-email cron), so it must stay
// Node-ESM-safe and browser-dependency-free, like marketingScheduler.js.
import { can, SUPERVISOR_ROLES } from './roles.js';
import { newId } from './ids.js';
import { resolveJobCrewIds } from './crewResolve.js';
import { pruneByAge, DAY_MS } from './retention.js';
import { english, renderText, msg } from '../i18n/core.js';
import { userLanguage } from '../i18n/languages.js';
import { HR_WARNING_SIGN_EVENT, HR_WARNING_UNSIGNED_EVENT } from './hrWarningReminders.js';

// HUB-7 — the "go back and redo this area" alert's event key. ONE declaration: the
// catalog entry below, the server fan-out (api/_lib/qc/store.notifyCleanersToRedo) and the
// mobile list's icon map all read it, so a renamed key cannot leave a row nobody can see
// a toggle for. (The other keys here predate this and stay string literals; a new one does
// not have to repeat that.)
export const REDO_EVENT_KEY = 'inspectionRedo';

// The client hub redesign (plan §3.4): a CUSTOMER wrote in their building's Messages. One
// declaration — the catalog entry below, the hub's fan-out (api/_lib/clientHub/messages.js) and
// the bell list's icon map read it.
export const CUSTOMER_MESSAGE_EVENT = 'customerMessage';

// Task #468 (Clean Corner's queue, the 2026-11-03 call): a cleaner hasn't used the app for 30
// days, so the office can turn them off if they've left. One declaration — the catalog entry
// below, the cron's walker (lib/crewQuietAlerts, which imports it from here so the catalog has
// it at load time) and the bell list's icon map read it.
export const CREW_QUIET_EVENT = 'crewQuiet';

// Task #507 (Clean Corner's queue): a building's special service (carpet cleaning, strip and wax)
// comes up, to its Account Manager and their Operations Manager. One declaration — the catalog
// entry below, the cron's walker (lib/specialServiceReminders, which imports it from here so the
// catalog has it at load time) and the bell list's icon map read it.
export const SPECIAL_SERVICE_EVENT = 'specialServiceDue';

// The Cleaner Hub (2026-10-13, brief C): a ticket ROUTED to cleaners (lib/crewRequests). One
// declaration each — the catalog entries below, the server's fan-outs (api/_lib/qc/store
// notifyCrewRequestAssigned / notifyCrewRequestCompleted) and the bell list's icon map read them.
//   CREW_REQUEST_ASSIGNED_EVENT   the office put a cleaner on a client request (to that cleaner)
//   CREW_REQUEST_COMPLETED_EVENT  a cleaner marked it complete (to the account manager)
export const CREW_REQUEST_ASSIGNED_EVENT = 'crewRequestAssigned';
export const CREW_REQUEST_COMPLETED_EVENT = 'crewRequestCompleted';

// QR Wave 2 (2026-10-17, Matt's QR-14): a cleaner scanned a building's code and filled in for
// someone on today's clean there. To the building's account manager alone (fanOutAccountAlert,
// NOTIF-02) — one declaration for the catalog entry below, the server's fan-out
// (api/_lib/scanCodes/crewArea notifyFillIn) and the bell list's look (lib/notificationMeta).
export const SCAN_FILL_IN_EVENT = 'scanFillIn';

// THE SUPPLY ORDERS (S131, plan docs/plans/2026-10-14-supply-orders.md §3): an order's news, to the
// person who asked for it (the cleaner, first) and — for each delivery, backorder, cancelled item and
// the completion — the building's account manager too. One declaration: the catalog entries below,
// lib/supplyFlow's fan-outs and the bell list's look (lib/notificationMeta) read it.
export const SUPPLY_ORDER_EVENTS = Object.freeze({
  approved: 'supplyOrderApproved',
  declined: 'supplyOrderDeclined',
  delivered: 'supplyItemsDelivered',
  backordered: 'supplyItemBackordered',
  cancelled: 'supplyItemCancelled',
  completed: 'supplyOrderCompleted',
});

export const NOTIFICATION_GROUPS = [
  {
    id: 'messaging',
    labelKey: 'notifPrefs.group.messaging',
    items: [
      {
        key: 'newClientMessage',
        labelKey: 'notifPrefs.newClientMessage',
        descKey: 'notifPrefs.newClientMessage.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'newDM',
        labelKey: 'notifPrefs.newDM',
        descKey: 'notifPrefs.newDM.desc',
      },
      {
        key: 'newInternalMessage',
        labelKey: 'notifPrefs.newInternalMessage',
        descKey: 'notifPrefs.newInternalMessage.desc',
      },
    ],
  },
  {
    id: 'schedule',
    labelKey: 'notifPrefs.group.schedule',
    items: [
      {
        key: 'jobCreatedOrRescheduled',
        labelKey: 'notifPrefs.jobCreatedOrRescheduled',
        descKey: 'notifPrefs.jobCreatedOrRescheduled.desc',
      },
      {
        key: 'jobCancelled',
        labelKey: 'notifPrefs.jobCancelled',
      },
      {
        // ALR-11: ONE shift alert. The separate "a cleaner is late" toggle was retired with
        // the alert behind it — a member who had muted it now sees only this one.
        key: 'shiftMissed',
        labelKey: 'notifPrefs.shiftMissed',
        descKey: 'notifPrefs.shiftMissed.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        // PAY-17: a punch taken away from the building (or with no location at all). The
        // time is held for approval either way; this is the supervisor being told at once.
        key: 'offSitePunch',
        labelKey: 'notifPrefs.offSitePunch',
        descKey: 'notifPrefs.offSitePunch.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        // QR-14 (QR Wave 2): a cleaner filled in for someone on today's clean from a scan. The
        // building's account manager's, so the office tiers only.
        key: SCAN_FILL_IN_EVENT,
        labelKey: 'notifPrefs.scanFillIn',
        descKey: 'notifPrefs.scanFillIn.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
  {
    id: 'operations',
    labelKey: 'notifPrefs.group.operations',
    items: [
      {
        key: 'accountOpsUpdated',
        labelKey: 'notifPrefs.accountOpsUpdated',
        descKey: 'notifPrefs.accountOpsUpdated.desc',
        // No roleAllowlist: the recipients ARE the account's crew (standing crew ∪
        // crew on its current/upcoming jobs), so crew must be able to receive it
        // and see the toggle. Gating it owner/admin-only stripped every recipient.
      },
      {
        key: 'keyCustody',
        labelKey: 'notifPrefs.keyCustody',
        descKey: 'notifPrefs.keyCustody.desc',
        requiresPermission: 'keys.view',
      },
      {
        key: 'keyLost',
        labelKey: 'notifPrefs.keyLost',
        descKey: 'notifPrefs.keyLost.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'keys.view',
      },
      {
        key: 'reminderFailed',
        labelKey: 'notifPrefs.reminderFailed',
        descKey: 'notifPrefs.reminderFailed.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        // Task #507: a building's special service is coming up (lib/specialServiceReminders), to
        // its Account Manager and their Operations Manager. On by default; the office tiers alone,
        // and only those who can open the customer page the alert links to.
        key: SPECIAL_SERVICE_EVENT,
        labelKey: 'notifPrefs.specialServiceDue',
        descKey: 'notifPrefs.specialServiceDue.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'clients.view',
      },
      // REMOVED 2026-07-22 — `keyOverdue` ("A key is out past the return window").
      // Keys have no return window and no due-back date/time; nobody is alerted
      // about a key still being out. Removed with SWEEP_OVERDUE_KEYS and
      // opsSettings.keyOverdueDays. Do not reintroduce without the owner asking.
    ],
  },
  {
    id: 'supplies',
    labelKey: 'notifPrefs.group.supplies',
    items: [
      {
        key: 'supplyRequestSubmitted',
        labelKey: 'notifPrefs.supplyRequestSubmitted',
        // SUP-1 (b) / SUP-9 (Matt, 2026-09-29): a request is APPROVED before the office fills
        // it, and the approver is the building's supervisor (or the one person named in
        // Settings → Operations). So this toggle moved from the fulfil capability to the
        // APPROVE one. The key is unchanged, so every saved preference carries over — and
        // supplies.approve defaults to the same tiers supplies.manage does, so nobody who had
        // the toggle loses it.
        descKey: 'notifPrefs.supplyRequestSubmitted.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'supplies.approve',
      },
      {
        // S131: "a new approved order" — the Supply Managers' (lib/supplyFlow: every active
        // `supply_manager`, else whoever holds supplies.manage, as before). The role id is the
        // contract with Builder R, who adds it to ROLES.
        key: 'supplyRequestApproved',
        labelKey: 'notifPrefs.supplyRequestApproved',
        descKey: 'notifPrefs.supplyRequestApproved.desc',
        roleAllowlist: ['owner', 'admin', 'manager', 'supply_manager'],
        requiresPermission: 'supplies.manage',
      },
      // 🔴 THE ORDER'S NEWS (S131, plan §3; Matt: "very important"). The person who asked — a cleaner
      // first — and the building's account manager. NO roleAllowlist and no permission: the
      // recipients ARE cleaners (the `inspectionRedo` precedent: gating a crew-aimed event to the
      // office strips every recipient), and crew hold mandatory notifications, so a cleaner cannot
      // mute them. They replace the delivery step's office-only "rejected", "on the way",
      // "delivered" and "delivered (office)" (II.5).
      {
        key: SUPPLY_ORDER_EVENTS.approved,
        labelKey: 'notifPrefs.supplyOrderApproved',
        descKey: 'notifPrefs.supplyOrderApproved.desc',
      },
      {
        key: SUPPLY_ORDER_EVENTS.declined,
        labelKey: 'notifPrefs.supplyOrderDeclined',
        descKey: 'notifPrefs.supplyOrderDeclined.desc',
      },
      {
        key: SUPPLY_ORDER_EVENTS.delivered,
        labelKey: 'notifPrefs.supplyItemsDelivered',
        descKey: 'notifPrefs.supplyItemsDelivered.desc',
      },
      {
        key: SUPPLY_ORDER_EVENTS.backordered,
        labelKey: 'notifPrefs.supplyItemBackordered',
        descKey: 'notifPrefs.supplyItemBackordered.desc',
      },
      {
        key: SUPPLY_ORDER_EVENTS.cancelled,
        labelKey: 'notifPrefs.supplyItemCancelled',
        descKey: 'notifPrefs.supplyItemCancelled.desc',
      },
      {
        key: SUPPLY_ORDER_EVENTS.completed,
        labelKey: 'notifPrefs.supplyOrderCompleted',
        descKey: 'notifPrefs.supplyOrderCompleted.desc',
      },
      {
        // CS-670 (2026-10-12): a request cancelled before it went out — the requester, and the
        // building's approver, whoever did not cancel it (lib/supplyFlow supplyCancelNotifications).
        key: 'supplyRequestCancelled',
        labelKey: 'notifPrefs.supplyRequestCancelled',
        descKey: 'notifPrefs.supplyRequestCancelled.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'supplyOrderDue',
        labelKey: 'notifPrefs.supplyOrderDue',
        // SUP-8 / CS-380. Goes to the building's supervisor on its order day.
        descKey: 'notifPrefs.supplyOrderDue.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'supplyOrderOverdue',
        labelKey: 'notifPrefs.supplyOrderOverdue',
        descKey: 'notifPrefs.supplyOrderOverdue.desc',
        roleAllowlist: ['owner', 'admin', 'manager', 'supply_manager'],
        requiresPermission: 'supplies.manage',
      },
      {
        key: 'supplyBudgetExceeded',
        labelKey: 'notifPrefs.supplyBudgetExceeded',
        // SUP-7 / SUP-10. One alert per building per calendar month, to its approver.
        descKey: 'notifPrefs.supplyBudgetExceeded.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
  {
    id: 'quality',
    labelKey: 'notifPrefs.group.quality',
    items: [
      {
        key: 'problemReported',
        labelKey: 'notifPrefs.problemReported',
        descKey: 'notifPrefs.problemReported.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      // 🔴 WO-2..7 + WO-16 (Matt, 2026-09-29) — the two TICKET-CHASING events. They are split
      // by URGENCY, not by which nudge it is, because the event key is the only thing the push
      // dispatcher sees: it decides whether the row may wake someone at 2 a.m. (WO-7), whether
      // it breaks a manager's quiet hours (NTF-2) and whether it also goes out as a text
      // (NTF-1). lib/ticketAlerts.ticketAlertEventKey picks between them from the ticket's
      // current priority, so a ticket the office marks urgent (WO-4) moves to the loud key on
      // its next nudge.
      {
        key: 'ticketUrgent',
        labelKey: 'notifPrefs.ticketUrgent',
        descKey: 'notifPrefs.ticketUrgent.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'ticketUnanswered',
        labelKey: 'notifPrefs.ticketUnanswered',
        descKey: 'notifPrefs.ticketUnanswered.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'inspectionFailed',
        labelKey: 'notifPrefs.inspectionFailed',
        descKey: 'notifPrefs.inspectionFailed.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      // 🔴 HUB-7 (Matt, 2026-10-02): "Once the inspection failed, there should be some sort
      // of a tool where the cleaners on site receive a notification that an area needs to
      // be done." NO roleAllowlist, deliberately and unusually for this group — the
      // recipients ARE the cleaners with an open punch in that building, so crew must be
      // able to receive it and to see the toggle (the `accountOpsUpdated` precedent: gating
      // a crew-aimed alert to the office strips every recipient). Crew hold mandatory
      // notifications (lib/roles), so neither a mute nor quiet hours can silence it for
      // them; the supervisor fallback is an office tier and theirs to manage.
      {
        key: REDO_EVENT_KEY,
        labelKey: 'notifPrefs.inspectionRedo',
        descKey: 'notifPrefs.inspectionRedo.desc',
      },
      // The Cleaner Hub's Client Requests (2026-10-13, brief C). The CLEANER's: no roleAllowlist,
      // as `inspectionRedo` — the recipients ARE cleaners, and gating a crew-aimed event to the
      // office strips every recipient. The ACCOUNT MANAGER's: the office tiers, and only someone
      // who can open the ticket (problems.manage) is rung; the route falls through to the office.
      {
        key: CREW_REQUEST_ASSIGNED_EVENT,
        labelKey: 'notifPrefs.crewRequestAssigned',
        descKey: 'notifPrefs.crewRequestAssigned.desc',
      },
      {
        key: CREW_REQUEST_COMPLETED_EVENT,
        labelKey: 'notifPrefs.crewRequestCompleted',
        descKey: 'notifPrefs.crewRequestCompleted.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'problems.manage',
      },
      {
        key: 'checklistDue',
        labelKey: 'notifPrefs.checklistDue',
        descKey: 'notifPrefs.checklistDue.desc',
      },
      {
        key: 'inspectionDue',
        labelKey: 'notifPrefs.inspectionDue',
        descKey: 'notifPrefs.inspectionDue.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      // The client hub redesign (plan §3.4, Matt's routing rule relayed 2026-10-08): a customer
      // wrote in their building's Messages. Routed by fanOutManagerOrAdmins — the building's
      // manager, else every Admin, else the Super Admins. Office tiers only, and gated on the key
      // that opens Messaging → Customers, so a person who cannot open the thread is never rung
      // about it (the routing then falls through to the next tier rather than to nobody).
      {
        key: CUSTOMER_MESSAGE_EVENT,
        labelKey: 'notifPrefs.customerMessage',
        descKey: 'notifPrefs.customerMessage.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'hub.messages.view',
      },
    ],
  },
  {
    id: 'invoices',
    labelKey: 'notifPrefs.group.invoices',
    items: [
      {
        key: 'invoicePaid',
        labelKey: 'notifPrefs.invoicePaid',
        requiresPermission: 'invoices.view',
      },
      {
        key: 'invoiceOverdue',
        labelKey: 'notifPrefs.invoiceOverdue',
        requiresPermission: 'invoices.view',
      },
    ],
  },
  {
    id: 'contracts',
    labelKey: 'notifPrefs.group.contracts',
    items: [
      {
        key: 'contractReminder',
        labelKey: 'notifPrefs.contractReminder',
        descKey: 'notifPrefs.contractReminder.desc',
        // Gated on the key that opens the Contracts surface, so a per-user grant moves the
        // bell with it and a cleaner (who never holds it) is never pinged. Opt-OUT like
        // every other operational toggle: a renewal nobody was told about is the whole
        // defect this exists to prevent (CON-6..9).
        requiresPermission: 'contracts.view',
      },
    ],
  },
  {
    // HR warnings (Matt's HR-1..HR-5, 2026-10-05). The keys are declared ONCE, in
    // lib/hrWarningReminders, which the issue route, the cron walker and the icon map read too.
    id: 'hr',
    labelKey: 'notifPrefs.group.hr',
    items: [
      {
        // The EMPLOYEE's: a warning to read and sign. No roleAllowlist and no permission —
        // the recipients ARE the employees, cleaners first (the `inspectionRedo` precedent:
        // gating a crew-aimed event to the office strips every recipient). Crew hold
        // mandatory notifications, so a cleaner cannot mute it.
        key: HR_WARNING_SIGN_EVENT,
        labelKey: 'notifPrefs.hrWarningToSign',
        descKey: 'notifPrefs.hrWarningToSign.desc',
      },
      {
        // HR-5: the SUPERVISOR's one reminder a day after issuing an unsigned warning. The
        // supervisor is picked from the office tiers, so the toggle is theirs alone.
        key: HR_WARNING_UNSIGNED_EVENT,
        labelKey: 'notifPrefs.hrWarningUnsigned',
        descKey: 'notifPrefs.hrWarningUnsigned.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        // Task #468: a cleaner quiet in the app for 30 days, to their buildings' account managers
        // and the Admins and Super Admins (lib/crewQuietAlerts). On by default; the office tiers
        // alone, and only those who can open the Team page the alert links to.
        key: CREW_QUIET_EVENT,
        labelKey: 'notifPrefs.crewQuiet',
        descKey: 'notifPrefs.crewQuiet.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'settings.team.view',
      },
    ],
  },
  {
    id: 'marketing',
    labelKey: 'notifPrefs.group.marketing',
    items: [
      {
        key: 'marketingReplyAssigned',
        labelKey: 'notifPrefs.marketingReplyAssigned',
        descKey: 'notifPrefs.marketingReplyAssigned.desc',
        // Managers only — crew don't run marketing, so they shouldn't see a
        // toggle they can never trigger (the notify-on-reply owner is always a manager).
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'inboxExpired',
        labelKey: 'notifPrefs.inboxExpired',
        descKey: 'notifPrefs.inboxExpired.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
  {
    id: 'sales',
    labelKey: 'notifPrefs.group.sales',
    items: [
      {
        key: 'newLead',
        labelKey: 'notifPrefs.newLead',
        descKey: 'notifPrefs.newLead.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
        // Opt-in: high-volume/noise potential, so it stays OFF until a manager
        // explicitly turns it on (unlike the other toggles, which default on).
        defaultOff: true,
      },
      {
        key: 'quoteSigned',
        labelKey: 'notifPrefs.quoteSigned',
        descKey: 'notifPrefs.quoteSigned.desc',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
];

// The English words, read from the catalog — never restated here (CS-193).
for (const g of NOTIFICATION_GROUPS) {
  Object.defineProperty(g, 'label', { get: () => english(g.labelKey), enumerable: true });
  for (const item of g.items) {
    Object.defineProperty(item, 'label', { get: () => english(item.labelKey), enumerable: true });
    if (item.descKey) Object.defineProperty(item, 'description', { get: () => english(item.descKey), enumerable: true });
  }
}

// Keys that are OFF by default (opt-in) — a user must explicitly enable them,
// unlike every other toggle which is on/opt-out. Derived from the catalog's
// `defaultOff` flag so the list has a single source of truth.
const DEFAULT_OFF_KEYS = new Set(
  NOTIFICATION_GROUPS.flatMap((g) => g.items).filter((i) => i.defaultOff).map((i) => i.key)
);

// The one place that decides whether a user currently WANTS a given event —
// used by BOTH the fan-out gates and the Account toggle render, so display and
// delivery can never disagree. Opt-out keys: absent/true = on (only explicit
// false is off). Opt-in (defaultOff) keys: only an explicit true is on.
export function isNotificationEnabled(prefs, eventKey) {
  const p = (prefs || {})[eventKey];
  return DEFAULT_OFF_KEYS.has(eventKey) ? p === true : p !== false;
}

// Returns the catalog filtered to the toggles a given user should see.
// Each group is included only if it has at least one visible toggle.
export function getVisibleNotificationGroups(user, permissions, overrides) {
  if (!user) return [];
  return NOTIFICATION_GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((item) => {
        if (item.roleAllowlist && !item.roleAllowlist.includes(user.role)) return false;
        if (item.requiresPermission && !can(user, item.requiresPermission, permissions, overrides)) return false;
        return true;
      }),
    }))
    .filter((g) => g.items.length > 0);
}

// Lookup helper — returns whether a given event toggle key is visible to the
// user. Used by NotificationListener to gate event firing on toggle visibility
// AND user opt-in (the toggle being on).
export function isNotificationVisibleForUser(eventKey, user, permissions, overrides) {
  if (!user) return false;
  for (const g of NOTIFICATION_GROUPS) {
    const item = g.items.find((i) => i.key === eventKey);
    if (!item) continue;
    if (item.roleAllowlist && !item.roleAllowlist.includes(user.role)) return false;
    if (item.requiresPermission && !can(user, item.requiresPermission, permissions, overrides)) return false;
    return true;
  }
  return false;
}

// Decide which notification key (if any) a new message maps to for a given
// recipient. Returns null if the recipient shouldn't be pinged. Lives here
// (not in NotificationListener) so the reducer can use the same logic to
// fan out per-recipient notification rows at message-send time.
export function resolveMessageEvent(message, conv, recipientUserId) {
  if (!conv) return null;
  if (Array.isArray(conv.mutedByUserIds) && conv.mutedByUserIds.includes(recipientUserId)) return null;

  if (conv.channel === 'dm') {
    if (!(conv.participantUserIds || []).includes(recipientUserId)) return null;
    if (!message.authorUserId || message.authorUserId === recipientUserId) return null;
    return 'newDM';
  }

  if (conv.channel === 'internal') {
    if (!(conv.participantUserIds || []).includes(recipientUserId)) return null;
    if (message.authorUserId === recipientUserId) return null;
    return 'newInternalMessage';
  }

  // External (sms / email) — only inbound from the client counts.
  if (message.direction !== 'in') return null;
  return 'newClientMessage';
}

// Trim a body string into the short snippet shown beneath a notification title.
export function previewMessageBody(text) {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? flat.slice(0, 87) + '…' : flat;
}

// The title of a message-event bell row, as a MESSAGE (src/i18n/core.js msg): the fan-out
// renders it in each RECIPIENT's language (CS-193, LANG-4). The names in it — a client's,
// a teammate's, a channel's — are people's and stay as written.
export function buildMessageNotificationTitle(eventKey, message, conv, users) {
  if (eventKey === 'newClientMessage') {
    const email = conv?.channel === 'email';
    if (conv?.title) return msg(email ? 'alerts.message.emailFrom' : 'alerts.message.messageFrom', { name: conv.title });
    return msg(email ? 'alerts.message.emailFromClient' : 'alerts.message.messageFromClient');
  }
  if (eventKey === 'newDM') {
    const author = (users || []).find((u) => u.id === message.authorUserId);
    return author?.name ? msg('alerts.message.dmFrom', { name: author.name }) : msg('alerts.message.dmFromTeammate');
  }
  if (eventKey === 'newInternalMessage') {
    return conv?.title ? msg('alerts.message.inChannel', { name: conv.title }) : msg('alerts.message.inAChannel');
  }
  return msg('alerts.message.new');
}

// 🔴 A BELL ROW IS WRITTEN IN ITS RECIPIENT'S LANGUAGE (CS-193; Matt's LANG-4). Every
// fan-out below takes `title` / `body` as plain text (as before — passed through untouched,
// which is what the office-only callers still hand over) or as a MESSAGE, and renders a
// message in the language of the person the row is FOR: their saved choice, else what
// their phone last reported (lib/i18n userLanguage), else English. The row stores the
// rendered words, so the bell, the push and the text all read the same sentence. On the
// server every catalog is loaded (api/_lib/i18n.js); an office tab loads the roster's
// languages after boot (components/LanguageSync), and a row it writes before then falls
// back to English — never to a key.
// Dates and times render in the ORG's zone (company.timezone), which the server has to be
// told: a cron never sets lib/dates' ambient zone.
const textFor = (x, user, state) => renderText(x, userLanguage(user), state?.company?.timezone || undefined);

// Bell-inbox rows are capped per user so notifications can't grow the shared
// org-state blob unbounded. `notifications` is the single largest blob slice
// (~40% pre-strip, SCALE-C22); 200→100→40: live measurement 2026-07-21 found
// 92% of rows UNREAD (crew rarely open the bell), so the unread-keeps-forever
// TTL never fired and every user marched to the count cap and STAYED there —
// 43 users × 100 converges to ~1.2 MB inside the blob every tab re-downloads
// on any org-wide change. A bell inbox is a recency surface, not an archive;
// 40 still covers weeks of pings for the heaviest recipients.
export const NOTIFICATION_LIMIT_PER_USER = 40;

// A READ notification older than this is swept at the next insert for that user.
export const NOTIFICATION_READ_TTL_DAYS = 30;

// ABSOLUTE age ceiling, read or not. "A stale unread is still an unactioned
// ping" made sub-cap rows immortal — with a 92%-unread population the slice
// could never shrink, only grow to the ceiling. A two-month-old ping nobody
// opened is noise, not a to-do.
export const NOTIFICATION_MAX_AGE_DAYS = 60;

// Insert one new bell row for a recipient. Three bounds, applied to THIS user's rows:
//   1. absolute age — drop rows older than NOTIFICATION_MAX_AGE_DAYS, read or not;
//   2. read-age TTL — drop read rows older than NOTIFICATION_READ_TTL_DAYS (unread kept);
//   3. per-user count cap — keep the newest NOTIFICATION_LIMIT_PER_USER.
// Other users' rows are untouched (they're swept when THEY next receive one; the
// historical bulk cleanup is a separate /data-op). Single source of truth for the
// cap logic across every fan-out — route new paths through here, never re-inline it.
export function capInsert(notifications, userId, row) {
  const list = notifications || [];
  const sameUser = list.filter((n) => n.userId === userId);
  const others = list.filter((n) => n.userId !== userId);
  const alive = pruneByAge(sameUser, NOTIFICATION_MAX_AGE_DAYS * DAY_MS, Date.now(), ['createdAt']);
  // Read-TTL sweep before the count cap; unread (readAt null/absent) is force-kept HERE
  // (the absolute ceiling above is the only thing that outranks unread).
  const fresh = pruneByAge(alive, NOTIFICATION_READ_TTL_DAYS * DAY_MS, Date.now(), ['createdAt'], (n) => !n.readAt);
  return [...[row, ...fresh].slice(0, NOTIFICATION_LIMIT_PER_USER), ...others];
}

// Per-recipient bell-row fan-out for a new message — the single source of
// truth for the reducer's ADD_MESSAGE and RECEIVE_EMAIL cases AND the
// server-side cron ingest (api/_lib/ingestEmail.js), so the three paths can't
// drift (NOTIF-02). Stamping rows at message time (not at the viewer's
// listener) means a recipient's bell is correct even if they had no tab open
// when the message arrived.
//
// `state` needs users / permissions / userPermissionOverrides / notifications
// / contacts. `conv` is the message's conversation row (the post-update copy
// is fine — only channel, participants, muted, title, and contactId are read).
// Returns the next notifications array; rows are gated per recipient on
// notificationPrefs opt-in AND role/permission visibility, and muted threads
// never fire (resolveMessageEvent).
export function fanOutMessageNotifications(state, msg, conv) {
  let notifications = state.notifications || [];
  if (!conv) return notifications;

  const users = state.users || [];
  const recipientIds = (conv.channel === 'dm' || conv.channel === 'internal')
    // DM/internal: the thread's other participants.
    ? (conv.participantUserIds || []).filter((uid) => uid !== msg.authorUserId)
    // External (sms/email): every active user is a potential recipient — the
    // prefs/visibility gates inside the loop strip the rest. The authorUserId
    // guard skips the sender on outbound replies.
    : users.filter((u) => u.status === 'active' && u.id !== msg.authorUserId).map((u) => u.id);

  // Contact-linked threads carry title=null — resolve the contact's name so
  // the bell row reads "New email from Morgan Hayes", not "from a client".
  let titleConv = conv;
  if (!conv.title && conv.contactId) {
    const contact = (state.contacts || []).find((c) => c.id === conv.contactId);
    const name = contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : '';
    if (name) titleConv = { ...conv, title: name };
  }

  const stamp = new Date().toISOString();
  for (const recipientId of recipientIds) {
    const user = users.find((u) => u.id === recipientId);
    if (!user) continue;
    if (user.status !== 'active') continue; // never accrue rows for inactive/invited users
    const eventKey = resolveMessageEvent(msg, conv, recipientId);
    if (!eventKey) continue;
    if (!isNotificationEnabled(user.notificationPrefs, eventKey)) continue; // opt-out (or opt-in for defaultOff keys)
    if (!isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides)) continue;
    const row = {
      id: newId('nt'),
      createdAt: stamp,
      readAt: null,
      userId: recipientId,
      eventKey,
      title: textFor(buildMessageNotificationTitle(eventKey, msg, titleConv, users), user, state),
      body: previewMessageBody(msg.text || msg.body),
      url: `/messaging/${msg.conversationId}`,
    };
    notifications = capInsert(notifications, recipientId, row);
  }
  return notifications;
}

// The ops fields that are the OFFICE's business and never the crew's, so a change to one of
// them pings nobody (NOTIF-05): the supervisor (SPOC) assignment, and — since ALR-9,
// 2026-09-29 — the account's own inspection interval, which only decides when the supervisor
// is reminded to inspect. Everything else on an ops patch (a door code, an access note, the
// reference link) IS the whole crew's business.
// SUP-7 / SUP-8 (2026-09-29) add the two SUPPLY fields: a purchasing budget and the day the
// office chases an order are the OFFICE's business, and a cleaner told "the budget changed" can
// do nothing with it.
export const INTERNAL_OPS_FIELDS = [
  'supervisorId', 'inspectionIntervalDays', 'supplyBudgetMonthly', 'supplyOrderDayOfMonth',
];

// True when a client-ops patch changes a CREW-FACING field, i.e. when the account's crew
// should be pinged (NOTIF-05). ServiceSetupCard resends the whole form, so this is a
// value-diff against the prior client, not a key-presence check. Node-safe.
export function opsPatchTouchesCrew(prevClient, patch) {
  return Object.keys(patch || {})
    .filter((k) => !INTERNAL_OPS_FIELDS.includes(k))
    .some((k) => JSON.stringify(patch[k]) !== JSON.stringify(prevClient?.[k]));
}

// WHO a client-ops patch should reach, when it should reach fewer than everyone.
//
// A door code, an access note or a reference link IS the whole crew's business, so those
// keep the fan-out below. A CHECKLIST ASSIGNMENT is one cleaner's: step 6's Assignments
// screen commits on every click, so five reassignments meant five bell rows for every
// cleaner on that customer's upcoming cleans, each about a checklist that was never
// theirs (L3 review, S5).
//
// Returns NULL for "everyone, as before" — any patch that changes something other than
// `crewChecklists` — and otherwise the cleaners whose own pick GAINED, LOST or MOVED.
// An empty array means the save changed nobody's pick, so nobody hears about it.
// Pure / node-safe.
export function opsPatchAudience(prevClient, patch) {
  const keys = Object.keys(patch || {}).filter((k) => !INTERNAL_OPS_FIELDS.includes(k));
  if (!keys.includes('crewChecklists')) return null;
  // ServiceSetupCard resends its whole form, so a key being PRESENT is not a change: only
  // a real value-diff on another ops field takes this back to the whole crew.
  if (keys.some((k) => k !== 'crewChecklists' && JSON.stringify(patch[k]) !== JSON.stringify(prevClient?.[k]))) return null;
  const before = prevClient?.crewChecklists || {};
  const after = patch.crewChecklists || {};
  const audience = [];
  for (const userId of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[userId] || null) !== (after[userId] || null)) audience.push(userId);
  }
  return audience;
}

// Per-recipient bell-row fan-out when an account's operations config changes.
// Recipients = crew on the account's current/upcoming jobs, or — when the caller names
// `onlyUserIds` (a `crewChecklists`-only change, see opsPatchAudience) — just the cleaners
// whose own pick moved. Mirrors fanOutMessageNotifications, but the 'accountOpsUpdated'
// pref is OPT-OUT (absent = on) because the shared org_state blob isn't backfilled with
// the new key — see CLEANSPACE_SWEPT.md §2.3. Returns the next notifications array.
export function fanOutOpsNotification(state, { clientId, actorName, summary, onlyUserIds = null }) {
  let notifications = state.notifications || [];
  const client = (state.clients || []).find((c) => c.id === clientId);
  if (!client) return notifications;
  const users = state.users || [];
  const clientSites = (state.sites || []).filter((s) => s.clientId === clientId);
  const siteIds = new Set(clientSites.map((s) => s.id));
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recipientIds = new Set();
  for (const j of (state.jobs || [])) {
    const belongs = j.clientId === clientId || siteIds.has(j.siteId);
    if (!belongs) continue;
    if (j.status === 'cancelled' || j.status === 'done') continue;
    if (j.endAt && new Date(j.endAt).getTime() < cutoff) continue;
    for (const id of (j.crewIds || [])) recipientIds.add(id);
  }
  const stamp = new Date().toISOString();
  // A named audience NARROWS the crew set; it never widens it. A cleaner whose pick moved
  // but who is not on one of this customer's upcoming cleans still has nothing to be told
  // here — that is exactly the "stray" the screen's own summary surfaces.
  const audience = Array.isArray(onlyUserIds) ? new Set(onlyUserIds) : null;
  for (const recipientId of recipientIds) {
    if (audience && !audience.has(recipientId)) continue;
    if (recipientId === state.currentUserId) continue; // don't notify the actor of their own ops change (NOTIF-03), same actor-skip as every other human-actor fan-out
    const user = users.find((u) => u.id === recipientId);
    if (!user) continue;
    if (user.status !== 'active') continue; // never accrue rows for inactive/invited users
    if (!isNotificationEnabled(user.notificationPrefs, 'accountOpsUpdated')) continue;
    if (!isNotificationVisibleForUser('accountOpsUpdated', user, state.permissions, state.userPermissionOverrides)) continue;
    const row = {
      id: newId('nt'),
      createdAt: stamp,
      readAt: null,
      userId: recipientId,
      eventKey: 'accountOpsUpdated',
      title: textFor(actorName
        ? msg('alerts.ops.updatedBy', { name: actorName, customer: client.name })
        : msg('alerts.ops.updatedByManager', { customer: client.name }), user, state),
      body: textFor(summary || msg('alerts.ops.accountUpdated'), user, state),
      url: `/clients/${clientId}`,
    };
    notifications = capInsert(notifications, recipientId, row);
  }
  return notifications;
}

// Bell row for a key custody transfer: a key was checked out TO holderUserId by
// someone else (self-checkouts stay silent). Opt-out (absent = on) like
// accountOpsUpdated — the shared blob's prefs aren't backfilled with new keys.
export function fanOutKeyNotification(state, { key, holderUserId }) {
  let notifications = state.notifications || [];
  if (!key || !holderUserId || holderUserId === state.currentUserId) return notifications;
  const user = (state.users || []).find((u) => u.id === holderUserId);
  if (!user || user.status !== 'active') return notifications;
  if (!isNotificationEnabled(user.notificationPrefs, 'keyCustody')) return notifications;
  if (!isNotificationVisibleForUser('keyCustody', user, state.permissions, state.userPermissionOverrides)) return notifications;
  const actor = (state.users || []).find((u) => u.id === state.currentUserId);
  const row = {
    id: newId('nt'),
    createdAt: new Date().toISOString(),
    readAt: null,
    userId: holderUserId,
    eventKey: 'keyCustody',
    title: textFor(key.label ? msg('alerts.key.checkedOut', { key: key.label }) : msg('alerts.key.checkedOutUnnamed'), user, state),
    body: [key.clientName || null, actor?.name ? textFor(msg('alerts.key.byWhom', { name: actor.name }), user, state) : null].filter(Boolean).join(' · '),
    url: '/keys',
  };
  return capInsert(notifications, holderUserId, row);
}

// A key reported LOST, or of UNKNOWN whereabouts, is a security signal the office needs: the
// managers' `keyLost` bell, never the person who reported it. ONE builder for both writers — the
// reducer (MARK_KEY_LOST / MARK_KEY_UNKNOWN, an office report) and the server's crew merge
// (api/_lib/crewMerge.js, a cleaner's report: CS-710 — the crew save dropped every bell addressed to
// someone else and derived only message and check-out bells, so a cleaner's Report Lost alerted
// nobody in the live app). The words are messages rendered per recipient.
export const KEY_ALERT_STATUSES = Object.freeze(['lost', 'unknown']);
export function fanOutKeyStatusAlert(state, { key, status, actorUserId = null }) {
  if (!key || !KEY_ALERT_STATUSES.includes(status)) return state.notifications || [];
  const lost = status === 'lost';
  const title = key.label
    ? msg(lost ? 'alerts.key.lost' : 'alerts.key.unknown', { key: key.label })
    : msg(lost ? 'alerts.key.lostUnnamed' : 'alerts.key.unknownUnnamed');
  return fanOutManagerAlert(state, { eventKey: 'keyLost', title, body: key.clientName || '', url: '/keys', actorUserId });
}

// Bell-row copy for a job event, as MESSAGES rendered per recipient. `priorStartAt`
// distinguishes a reschedule from a fresh assignment (both use the
// 'jobCreatedOrRescheduled' key). The time renders in the ORG's zone (it used to be
// formatted in whatever zone the writing device was in — a cleaner read their shift
// in the office laptop's time). Node-safe.
function jobNotificationCopy(eventKey, job, priorStartAt) {
  const when = job.startAt ? msg('alerts.job.when', { when: job.startAt }) : '';
  if (eventKey === 'jobCancelled') return { title: msg('alerts.job.cancelled'), body: when };
  if (priorStartAt && priorStartAt !== job.startAt) {
    return { title: msg('alerts.job.rescheduled'), body: job.startAt ? msg('alerts.job.now', { when: job.startAt }) : '' };
  }
  return { title: msg('alerts.job.assigned'), body: when };
}

// Per-recipient bell-row fan-out for a job create / reschedule / cancel.
// Recipients = the job's crew (named on job.crewIds), the same resolution as
// isJobAssignedToUser, so everyone who sees the clean on My Day is told about it.
// Gated per recipient on the schedule event opt-in AND role/permission visibility,
// capped per user. Mirrors the message fan-out so crew get a durable bell row —
// see NotificationListener for toasts.
export function fanOutJobNotification(state, { job, eventKey, priorStartAt, url, recipients }) {
  let notifications = state.notifications || [];
  if (!job) return notifications;
  const users = state.users || [];
  const stamp = new Date().toISOString();
  // Default recipients = the job's crew (shared crewResolve rule, so the bell
  // matches exactly who sees the clean on My Day). Callers may pass an explicit
  // `recipients` list (e.g. a crew-ADD notifies only the newly-named people).
  const recipientIds = new Set(recipients || resolveJobCrewIds(job));
  for (const recipientId of recipientIds) {
    if (recipientId === state.currentUserId) continue; // don't notify the actor of their own job action
    const user = users.find((u) => u.id === recipientId);
    if (!user || user.status !== 'active') continue;
    if (!isNotificationEnabled(user.notificationPrefs, eventKey)) continue; // opt-out (or opt-in for defaultOff keys)
    if (!isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides)) continue;
    const { title, body } = jobNotificationCopy(eventKey, job, priorStartAt);
    const row = {
      id: newId('nt'),
      createdAt: stamp,
      readAt: null,
      userId: recipientId,
      eventKey,
      title: textFor(title, user, state),
      body: textFor(body, user, state),
      // Deletions pass url:'/schedule' — a deleted job's detail route is a dead
      // "Job not found" link, so point those rows at the schedule list instead.
      url: url || `/schedule/${job.id}`,
    };
    notifications = capInsert(notifications, recipientId, row);
  }
  return notifications;
}

// Generic office/manager-alert fan-out for operational events whose recipients
// are the back office (owner/admin), NOT a specific account's crew — a crew
// problem report / work order, a key marked lost. Iterates active users and
// gates each on the event's catalog visibility (its roleAllowlist scopes it to
// managers) AND the opt-out pref; skips the actor so the person who logged the
// event isn't pinged about their own action. Same iterate-all-and-gate shape as
// fanOutInvoiceNotification. Node-safe (used server-side by the QC route).
export function fanOutManagerAlert(state, { eventKey, title, body, url, actorUserId }) {
  let notifications = state.notifications || [];
  const users = state.users || [];
  const stamp = new Date().toISOString();
  for (const user of users) {
    if (user.status !== 'active') continue;
    if (actorUserId && user.id === actorUserId) continue; // never ping the actor about their own action
    if (!isNotificationEnabled(user.notificationPrefs, eventKey)) continue; // opt-out (or opt-in for defaultOff keys)
    if (!isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides)) continue;
    const row = {
      id: newId('nt'),
      createdAt: stamp,
      readAt: null,
      userId: user.id,
      eventKey,
      title: textFor(title, user, state),
      body: textFor(body || '', user, state),
      url: url || '/',
    };
    notifications = capInsert(notifications, user.id, row);
  }
  return notifications;
}

// Per-recipient bell-row fan-out to an EXPLICIT set of users (e.g. a job's assigned
// crew for a checklist nudge). Gates each on the event's catalog visibility + opt-out
// pref, skips the actor, caps per user — the same gates as the other fan-outs, just
// with a caller-supplied recipient list instead of "all managers" or a single SPOC.
// `url` may be a function of the recipient's row: a list that mixes cleaners and the office
// links each where they work (a cleaner's ticket row opens their phone app, the office's the
// drawer — api/_lib/qc/store ticketLinkFor; the Cleaner Hub, 2026-10-13).
export function fanOutToUserIds(state, { userIds, eventKey, title, body, url, actorUserId }) {
  let notifications = state.notifications || [];
  const users = state.users || [];
  const stamp = new Date().toISOString();
  for (const uid of new Set((userIds || []).filter(Boolean))) {
    if (actorUserId && uid === actorUserId) continue;
    const user = users.find((u) => u.id === uid);
    if (!user || user.status !== 'active') continue;
    if (!isNotificationEnabled(user.notificationPrefs, eventKey)) continue;
    if (!isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides)) continue;
    const link = typeof url === 'function' ? url(user) : url;
    const row = {
      id: newId('nt'), createdAt: stamp, readAt: null, userId: uid,
      eventKey, title: textFor(title, user, state), body: textFor(body || '', user, state), url: link || '/',
    };
    notifications = capInsert(notifications, uid, row);
  }
  return notifications;
}

// Resolve the VALID account supervisor for a client, or null. A supervisor is the
// account's single point of contact (`client.supervisorId`, set on ClientDetail →
// Service setup). "Valid" = the id is set, the user still exists, is active, and is
// still an eligible tier (SUPERVISOR_ROLES — owner/admin/manager). The Service-setup
// picker keeps a stale/demoted supervisor SELECTABLE for display, so the binding can
// outlive eligibility; every guard here is what makes the notify path skip such a
// binding and fall back to the manager bench. Node-safe (used by the reducer).
export function resolveAccountSupervisor(state, clientId) {
  if (!clientId) return null;
  const client = (state.clients || []).find((c) => c.id === clientId);
  if (!client || !client.supervisorId) return null;
  const sup = (state.users || []).find((u) => u.id === client.supervisorId);
  if (!sup || sup.status !== 'active') return null;
  if (!SUPERVISOR_ROLES.includes(sup.role)) return null;
  return sup;
}

// WHO APPROVES a building's supply orders (SUP-1 b + SUP-9 ★a, Matt 2026-09-29; the ORDER changed
// with the supply orders, S131 — plan §1: "the building's account manager first").
//
//   1. the building's ACCOUNT MANAGER — its supervisor, resolved through resolveAccountSupervisor
//      above, so a demoted or deactivated one is skipped exactly as for every other account alert;
//   2. only for a building with none: the one person named in Settings → Operations
//      (`opsSettings.supplyApproverUserId`, "Approver for buildings with no account manager"),
//      while they are active and an eligible tier;
//   3. else nobody — the order waits in the queue where the office (the owner, an admin) can step
//      in; nothing is auto-approved.
// Before S131 a named approver beat every building's manager. Production's is null (read
// 2026-10-14), so nothing live changes hands.
// Node-safe (the route, the stub, the screens and the ops-alert cron all call it).
export function resolveSupplyApprover(state, clientId) {
  const manager = resolveAccountSupervisor(state, clientId);
  if (manager) return manager;
  const named = state?.opsSettings?.supplyApproverUserId;
  if (typeof named === 'string' && named.trim()) {
    const u = (state.users || []).find((x) => x.id === named.trim());
    if (u && u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)) return u;
  }
  return null;
}

// Account-scoped alert with SUPERVISOR ROUTING (the "single point of contact"
// behaviour behind `client.supervisorId`). It routes ONLY to the account's valid,
// willing SPOC: a valid supervisor who has not muted the event and did not trigger it
// gets the alert alone (not the manager bench), so an account's issues land on its
// owner instead of pinging everyone.
//
// NOTIF-02 (2026-09-16, owner decision): when there is NO available SPOC (none set,
// demoted/inactive, muted, or the actor themselves) we send NO notification and do NOT
// blanket the manager bench. The underlying event is still captured on its own surface
// (e.g. a Work Order in the Quality queue), which is the review surface. This deliberately
// replaces the earlier always-blanket fallback. Node-safe.
export function fanOutAccountAlert(state, { clientId, eventKey, title, body, url, actorUserId }) {
  const notifications = state.notifications || [];
  const supervisor = resolveAccountSupervisor(state, clientId);
  if (!supervisor) return notifications;                                    // no SPOC → captured on its surface only
  if (actorUserId && supervisor.id === actorUserId) return notifications;   // the SPOC logged it → they know
  if (!isNotificationEnabled(supervisor.notificationPrefs, eventKey)) return notifications; // muted → log only
  if (!isNotificationVisibleForUser(eventKey, supervisor, state.permissions, state.userPermissionOverrides)) return notifications;
  const row = {
    id: newId('nt'),
    createdAt: new Date().toISOString(),
    readAt: null,
    userId: supervisor.id,
    eventKey,
    title: textFor(title, supervisor, state),
    body: textFor(body || '', supervisor, state),
    url: url || '/',
  };
  return capInsert(notifications, supervisor.id, row);
}

// 🔴 WO-6 (Matt, 2026-09-29): "Who should a new ticket go to first? — (a) The account's
// supervisor; the office if there's no supervisor or no reply." ★
//
// SUPERVISOR-FIRST, OFFICE-FALLBACK: the account's valid SPOC alone when there is one, and
// the office bench when there is not — never nowhere. This is deliberately NOT
// fanOutAccountAlert's stance (NOTIF-02: no SPOC → send nothing, the event is captured on its
// own surface). A ticket IS captured on its own surface too, but Matt asked for the office to
// hear it, and a client waiting on a reply is a clock nobody is watching if the one person it
// was routed to does not exist.
//
// ONE reader for the creation ping (api/_lib/qc/store.notifyTicketRaised) and every later
// repeat (lib/opsAlertApply), so the first alert and the tenth cannot route differently.
// Node-safe — the server calls it.
export function fanOutSupervisorFirst(state, { clientId, eventKey, title, body, url, actorUserId }) {
  const supervisor = resolveAccountSupervisor(state, clientId);
  if (supervisor) {
    return fanOutToUserIds(state, { userIds: [supervisor.id], eventKey, title, body, url, actorUserId });
  }
  return fanOutManagerAlert(state, { eventKey, title, body, url, actorUserId });
}

// 🔴 MATT'S ROUTING RULE FOR A CUSTOMER'S MESSAGE (relayed by Daniel, 2026-10-08): "messages should
// be routed to the assigned manager to that customer/site, however, if there is no manager, it
// needs to be sent to a fallback Admin role." Daniel's D4 made it exact:
//
//   1. the building's MANAGER — resolveAccountSupervisor: `client.supervisorId`, active, still
//      Super Admin / Admin / Manager — when they have the event on and may see it;
//   2. otherwise (none, inactive, demoted, muted, or unable to open customer messages) EVERY
//      active ADMIN who has it on and may see it;
//   3. otherwise the SUPER ADMIN(s) — every active one, and this tier IGNORES a mute: it is the
//      backstop that makes "never sent to nobody" true. A Super Admin who wants silence names a
//      manager for the building or keeps an Admin on the team.
//
// Crew never (they are not a tier here, and the catalog entry is office-only). The ACTOR is never
// told about their own message — dropped from whichever tier was chosen (a manager who wrote it
// already knows; the tier is not re-chosen around them). One row per recipient (capInsert, and
// the id set below). Node-safe: the hub route calls it inside its CAS loop.
//
// Deliberately NOT fanOutSupervisorFirst (WO-6: the supervisor, else the WHOLE office bench) and
// NOT fanOutAccountAlert (NOTIF-02: the supervisor or nobody): a customer waiting on a reply is
// owed one named tier of people, not everyone and not no one.
export function fanOutManagerOrAdmins(state, { clientId, eventKey, title, body, url, actorUserId }) {
  const users = state.users || [];
  const wants = (u) => isNotificationEnabled(u.notificationPrefs, eventKey)
    && isNotificationVisibleForUser(eventKey, u, state.permissions, state.userPermissionOverrides);
  const manager = resolveAccountSupervisor(state, clientId);
  let tier;
  let backstop = false;
  if (manager && wants(manager)) {
    tier = [manager.id];
  } else {
    const admins = users.filter((u) => u && u.role === 'admin' && u.status === 'active' && wants(u));
    if (admins.length) tier = admins.map((u) => u.id);
    else {
      tier = users.filter((u) => u && u.role === 'owner' && u.status === 'active').map((u) => u.id);
      backstop = true;
    }
  }
  const ids = [...new Set(tier)].filter((id) => !(actorUserId && id === actorUserId));
  if (!ids.length) return state.notifications || [];
  // The Super Admin backstop is told whatever their own mute says (rule 3) — only on that last
  // branch; the manager and the Admins were already chosen on their own switch.
  const target = backstop
    ? { ...state, users: users.map((u) => (u && ids.includes(u.id) ? { ...u, notificationPrefs: { ...(u.notificationPrefs || {}), [eventKey]: true } } : u)) }
    : state;
  return fanOutToUserIds(target, { userIds: ids, eventKey, title, body, url, actorUserId });
}

// 🔴 HUB-21 (Matt, 2026-10-08): "A client sends a request from the Client Hub and their building
// has no manager assigned. Who should be alerted? — (a) The Admins, the same as messages." So a
// PORTAL ticket routes as a customer's message (fanOutManagerOrAdmins: the building's manager,
// else the Admins, else the Super Admins); every other ticket (a cleaner's, a visitor's scan
// report) keeps WO-6 (fanOutSupervisorFirst: the manager, else the whole office bench).
//
// `ticketFanOut(origin)` is the ONE chooser, for the creation bell and the customer-reply bell
// (api/_lib/qc/store.js notifyTicketRaised / notifyClientReplied) AND every repeat (lib/opsAlertApply;
// the walker copies the ticket's origin onto its alerts), so the first alert and the tenth cannot
// route differently (CS-639). The 30-minute and response-time escalations are a separate rule
// (WO-5 / WO-16: the office is told too) and do not come through here.
export const PORTAL_TICKET_NO_MANAGER_ROUTE = 'admins'; // 'admins' (HUB-21 a) | 'office' (WO-6)
export function fanOutPortalTicket(state, args, route = PORTAL_TICKET_NO_MANAGER_ROUTE) {
  return route === 'admins' ? fanOutManagerOrAdmins(state, args) : fanOutSupervisorFirst(state, args);
}
export const ticketFanOut = (origin) => (origin === 'portal' ? fanOutPortalTicket : fanOutSupervisorFirst);

// Per-recipient bell-row fan-out for an invoice paid / overdue transition.
// Recipients = every active user who can see invoices (the requiresPermission
// gate on the invoice toggles resolves to invoices.view) and is opted in.
//
// `actorUserId` SKIPS the person who caused the event (CS-226) — the same gate every
// other fan-out here already had, and the reason it matters is the same: being told
// about the payment you just typed in is noise that trains people to ignore the bell.
// The server sweep has no actor and passes none, so nobody is skipped there.
export function fanOutInvoiceNotification(state, { invoice, eventKey, actorUserId = null }) {
  let notifications = state.notifications || [];
  if (!invoice) return notifications;
  const users = state.users || [];
  const label = invoice.number || invoice.id;
  const title = eventKey === 'invoicePaid'
    ? msg('alerts.invoice.paid', { number: label })
    : msg('alerts.invoice.overdue', { number: label });
  const stamp = new Date().toISOString();
  for (const user of users) {
    if (user.status !== 'active') continue;
    if (actorUserId && user.id === actorUserId) continue; // you did it — you know
    if (!isNotificationEnabled(user.notificationPrefs, eventKey)) continue; // opt-out (or opt-in for defaultOff keys)
    if (!isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides)) continue;
    const row = {
      id: newId('nt'),
      createdAt: stamp,
      readAt: null,
      userId: user.id,
      eventKey,
      title: textFor(title, user, state),
      body: '',
      url: '/invoices',
    };
    notifications = capInsert(notifications, user.id, row);
  }
  return notifications;
}
