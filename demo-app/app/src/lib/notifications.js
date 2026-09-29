// Notification catalog — single source of truth for the per-user toggle list,
// the role/permission gates that govern visibility, and the labels used in
// the Account → Notifications panel.
//
// Visibility rules:
//   - roleAllowlist: array of role keys ('owner' | 'admin' | 'manager' | 'crew') that
//     may see the toggle. Omitted = all roles.
//   - requiresPermission: a permission key. If set, the user must have it
//     (per `can()` in lib/roles.js) for the toggle to be visible.
//   - description: shown beneath the toggle to clarify scope.
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

export const NOTIFICATION_GROUPS = [
  {
    id: 'messaging',
    label: 'Messaging',
    items: [
      {
        key: 'newClientMessage',
        label: 'New client SMS or email',
        description: 'When a client texts or emails a thread you can see.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'newDM',
        label: 'Someone DMs me',
        description: 'Direct messages from teammates.',
      },
      {
        key: 'newInternalMessage',
        label: 'New message in a channel',
        description: 'Internal staff channels you are part of.',
      },
    ],
  },
  {
    id: 'schedule',
    label: 'Schedule',
    items: [
      {
        key: 'jobCreatedOrRescheduled',
        label: 'A job assigned to me is created or rescheduled',
        description: 'Crew receive these only for their own jobs.',
      },
      {
        key: 'jobCancelled',
        label: 'A job I am on is cancelled',
      },
      {
        key: 'shiftLate',
        label: 'A cleaner is late or has not arrived',
        description: 'When a scheduled clean has no clock-in past its start grace. Goes to the account supervisor.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'shiftMissed',
        label: 'A shift is missed',
        description: 'When a scheduled clean has no clock-in after its end. Goes to the account supervisor.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        key: 'accountOpsUpdated',
        label: 'An account I work is updated',
        description: 'Security, cleaning instructions, expected time, or assigned cleaners changed on an account you are assigned to.',
        // No roleAllowlist: the recipients ARE the account's crew (standing crew ∪
        // crew on its current/upcoming jobs), so crew must be able to receive it
        // and see the toggle. Gating it owner/admin-only stripped every recipient.
      },
      {
        key: 'keyCustody',
        label: 'A key is checked out to me',
        description: 'When a manager or teammate checks a key out in your name. Custody transfers stop being silent.',
        requiresPermission: 'keys.view',
      },
      {
        key: 'keyLost',
        label: 'A key is marked lost or unknown',
        description: 'When a key’s whereabouts become unclear. Missing from the lockbox or holder unconfirmed.',
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'keys.view',
      },
      {
        key: 'reminderFailed',
        label: 'A customer reminder fails to send',
        description: 'When an automated appointment reminder (text or email) to a customer cannot be delivered, so a missed reminder is caught instead of failing silently.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      // REMOVED 2026-07-22 — `keyOverdue` ("A key is out past the return window").
      // Keys have no return window and no due-back date/time; nobody is alerted
      // about a key still being out. Removed with SWEEP_OVERDUE_KEYS and
      // opsSettings.keyOverdueDays. Do not reintroduce without the owner asking.
    ],
  },
  {
    id: 'supplies',
    label: 'Supplies',
    items: [
      {
        key: 'supplyRequestSubmitted',
        label: 'A supply request is submitted',
        description: 'When a supervisor requests supplies for a location, so the office can fill the order. Goes to whoever can fulfill requests.',
        // The office fulfills — gate to the fulfill capability so a matrix edit
        // granting/revoking supplies.manage moves this toggle with it.
        roleAllowlist: ['owner', 'admin', 'manager'],
        requiresPermission: 'supplies.manage',
      },
      {
        key: 'supplyRequestCompleted',
        label: 'My supply request is completed',
        description: 'When the office marks a supply request you submitted as complete, so you know it is on the way.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
  {
    id: 'quality',
    label: 'Quality',
    items: [
      {
        key: 'problemReported',
        label: 'Crew reports a problem',
        description: 'When a cleaner files a problem report from the field.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'inspectionFailed',
        label: 'An inspection fails or needs follow-up',
        description: 'When a submitted site inspection scores below its passing threshold (or has no scored items). So a bad clean gets a follow-up instead of dead-ending in the report.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'newGoogleReview',
        label: 'A new Google review comes in',
        description: 'When the Google Business Profile sync finds a new public review on your listing.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'checklistDue',
        label: 'A daily checklist is not logged',
        description: 'When a cleaner has not finished their checklist on a clean. That cleaner is nudged first; once the clean has ended, the account supervisor and the owner get one alert naming who is missing.',
      },
      {
        key: 'inspectionDue',
        label: 'An account is due for inspection',
        description: 'When an account has not been inspected within the cadence set in Operations. Goes to the account supervisor.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
  {
    id: 'invoices',
    label: 'Invoices',
    items: [
      {
        key: 'invoicePaid',
        label: 'An invoice gets paid',
        requiresPermission: 'invoices.view',
      },
      {
        key: 'invoiceOverdue',
        label: 'An invoice goes overdue',
        requiresPermission: 'invoices.view',
      },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    items: [
      {
        key: 'marketingReplyAssigned',
        label: 'A contact replies to a sequence I’m assigned to',
        description: 'When someone replies to a marketing sequence and you’re set as its notify-on-reply owner.',
        // Managers only — crew don't run marketing, so they shouldn't see a
        // toggle they can never trigger (the notify-on-reply owner is always a manager).
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
      {
        key: 'inboxExpired',
        label: 'A sending inbox needs reconnecting',
        description: 'When a marketing inbox’s connection expires or is revoked and it drops out of the sequence rotation. So your drips don’t silently stall.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    items: [
      {
        key: 'newLead',
        label: 'A new inbound lead comes in',
        description: 'When a lead arrives from a connected webhook (Zapier / Make / n8n / your website form). Off by default. Turn on to be pinged for every new lead.',
        roleAllowlist: ['owner', 'admin', 'manager'],
        // Opt-in: high-volume/noise potential, so it stays OFF until a manager
        // explicitly turns it on (unlike the other toggles, which default on).
        defaultOff: true,
      },
      {
        key: 'quoteSigned',
        label: 'A client signs a quote',
        description: 'When a prospect signs a service agreement you sent.',
        roleAllowlist: ['owner', 'admin', 'manager'],
      },
    ],
  },
];

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

// Build the title used in both the bell-inbox row and the toast for a
// message-event notification. Centralized so the reducer fan-out and the
// listener's toast firing produce identical copy.
export function buildMessageNotificationTitle(eventKey, message, conv, users) {
  if (eventKey === 'newClientMessage') {
    return `New ${conv?.channel === 'email' ? 'email' : 'message'} from ${conv?.title || 'a client'}`;
  }
  if (eventKey === 'newDM') {
    const author = (users || []).find((u) => u.id === message.authorUserId);
    return `DM from ${author?.name || 'a teammate'}`;
  }
  if (eventKey === 'newInternalMessage') {
    return `New message in ${conv?.title || 'a channel'}`;
  }
  return 'New message';
}

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
      title: buildMessageNotificationTitle(eventKey, msg, titleConv, users),
      body: previewMessageBody(msg.text || msg.body),
      url: `/messaging/${msg.conversationId}`,
    };
    notifications = capInsert(notifications, recipientId, row);
  }
  return notifications;
}

// True when a client-ops patch changes a CREW-FACING field (anything but the internal
// supervisorId / SPOC assignment), i.e. when the account's crew should be pinged
// (NOTIF-05). ServiceSetupCard resends the whole form, so this is a value-diff against
// the prior client, not a key-presence check. Node-safe.
export function opsPatchTouchesCrew(prevClient, patch) {
  return Object.keys(patch || {})
    .filter((k) => k !== 'supervisorId')
    .some((k) => JSON.stringify(patch[k]) !== JSON.stringify(prevClient?.[k]));
}

// Per-recipient bell-row fan-out when an account's operations config changes.
// Recipients = crew on the account's current/upcoming jobs. Mirrors
// fanOutMessageNotifications, but the 'accountOpsUpdated' pref is OPT-OUT (absent
// = on) because the shared org_state blob isn't backfilled with the new key —
// see CLEANSPACE_SWEPT.md §2.3. Returns the next notifications array.
export function fanOutOpsNotification(state, { clientId, actorName, summary }) {
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
  for (const recipientId of recipientIds) {
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
      title: `${actorName || 'A manager'} updated ${client.name}`,
      body: summary || 'Account operations were updated.',
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
    title: `Key ${key.label || ''} checked out to you`.replace(/\s+/g, ' ').trim(),
    body: [key.clientName || null, actor?.name ? `by ${actor.name}` : null].filter(Boolean).join(' · '),
    url: '/keys',
  };
  return capInsert(notifications, holderUserId, row);
}

// Bell-row copy for a job event. `priorStartAt` distinguishes a reschedule from
// a fresh assignment (both use the 'jobCreatedOrRescheduled' key). Node-safe.
function jobNotificationCopy(eventKey, job, priorStartAt) {
  const when = job.startAt
    ? new Date(job.startAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  if (eventKey === 'jobCancelled') return { title: 'A job you were on was cancelled', body: when };
  if (priorStartAt && priorStartAt !== job.startAt) {
    return { title: 'Job rescheduled', body: when ? `Now ${when}` : '' };
  }
  return { title: 'New job assigned to you', body: when };
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
      title,
      body,
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
      title,
      body: body || '',
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
    const row = {
      id: newId('nt'), createdAt: stamp, readAt: null, userId: uid,
      eventKey, title, body: body || '', url: url || '/',
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
    title,
    body: body || '',
    url: url || '/',
  };
  return capInsert(notifications, supervisor.id, row);
}

// Per-recipient bell-row fan-out for an invoice paid / overdue transition.
// Recipients = every active user who can see invoices (the requiresPermission
// gate on the invoice toggles resolves to invoices.view) and is opted in.
export function fanOutInvoiceNotification(state, { invoice, eventKey }) {
  let notifications = state.notifications || [];
  if (!invoice) return notifications;
  const users = state.users || [];
  const label = invoice.number || invoice.id;
  const title = eventKey === 'invoicePaid'
    ? `Invoice ${label} paid`
    : `Invoice ${label} is overdue`;
  const stamp = new Date().toISOString();
  for (const user of users) {
    if (user.status !== 'active') continue;
    if (!isNotificationEnabled(user.notificationPrefs, eventKey)) continue; // opt-out (or opt-in for defaultOff keys)
    if (!isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides)) continue;
    const row = {
      id: newId('nt'),
      createdAt: stamp,
      readAt: null,
      userId: user.id,
      eventKey,
      title,
      body: '',
      url: '/invoices',
    };
    notifications = capInsert(notifications, user.id, row);
  }
  return notifications;
}
