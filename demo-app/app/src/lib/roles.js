// Roles + permissions.
// The matrix is the *default*; the live assignment lives in the store (state.permissions)
// and can be edited in Settings → Roles (Super Admin only).
// Per-user overrides live in state.userPermissionOverrides and are applied in can().
//
// Naming: schema is `owner / admin / manager / supply_manager / crew`; UI labels are
// `Super Admin / Admin / Account Manager / Supply Manager / Crew` via ROLE_LABELS (a manager at the
// operations level reads "Operations Manager", memberRoleLabel). Decision: keep the schema keys —
// they're shorter, already wired through the codebase, and the UI display is fully owned by
// ROLE_LABELS / ROLE_DESCRIPTIONS. Renaming a schema key would touch every
// reducer/selector/permission check for zero user-visible benefit — to rename a role's
// DISPLAY, edit its `role.*` lines in the translation catalog (src/i18n/catalog/en.js,
// CS-193): ROLE_LABELS / ROLE_DESCRIPTIONS read their English from there, and a screen in
// another language reads the same keys.
//
// 2026-09-13: added `manager` as a real 4th tier between Admin and Crew. Per the client's
// call it DEFAULTS to full access (every permission, same as owner/Super Admin) and is pared
// back from there in Settings → Roles. Column/display order follows ROLES.
//
// 2026-10-14 (S131, plan 2026-10-14 §0): two jobs Matt and Daniel added, set up differently.
//   · The SUPPLY MANAGER is a 5th role, `supply_manager`: their permissions really differ
//     (supplies only — the order queue, the catalog, deliveries, Supply usage; never approving).
//     It is OFFICE staff, not crew: OFFICE_ROLES below is every tier but crew, and the server, the
//     RLS policies and the browser's read path all follow that one list.
//   · The OPERATIONS MANAGER is NOT a role: it is `manager` at the "operations" level
//     (`users[].managerLevel`, lib/teamScope.js), so the claim, RLS and every `role === 'manager'`
//     behaviour stay `manager`. The picker shows the two levels as "Account Manager" and
//     "Operations Manager" (lib/teamLimits roleChoices).
//
// 2026-10-16 (CS-858; Daniel: "Why aren't there operations manager permission settings in
// settings?"): the Operations Manager gets a permission COLUMN of their own, `operations_manager`
// (PERMISSION_COLUMNS below), so OMs and Account Managers can hold different permissions. Only
// PERMISSION resolution tells the two apart — permissionRoleOf(user) — and the column is never a
// role: ROLES, OFFICE_ROLES, the claim and RLS do not name it. OMs start with exactly what Account
// Managers have (the code defaults derive it; production's stored matrix by the release data-op).

import { english } from '../i18n/core.js';
import { isOpsManager, ACCOUNT_LEVEL, OPERATIONS_LEVEL } from './teamScope.js';

export const ROLES = ['owner', 'admin', 'manager', 'supply_manager', 'crew'];

// The OFFICE tiers: every role but crew. THE one list — the server's (api/_lib/authz.js
// OFFICE_ROLES is this array), the browser's read path (store/sync.js: the full blob, never the
// crew projection), the office-only background workers (App.jsx) and the guard's role floors
// (orgStateGuard OFFICE). The app's own site-visibility rule is the same (`role !== 'crew'` sees
// all, store/selectors). A null or unknown role is in none of them: the server treats an unknown
// role as crew, so a new tier must be IN ROLES to be office — never a hand-kept copy of this list.
export const OFFICE_ROLES = Object.freeze(ROLES.filter((r) => r !== 'crew'));
export function isOfficeRole(role) {
  return typeof role === 'string' && OFFICE_ROLES.includes(role);
}

// The tiers eligible to be an ACCOUNT SUPERVISOR (the single point of contact set
// on ClientDetail → Service setup, `client.supervisorId`). Crew are never eligible.
// Single source of truth — read by ServiceSetupCard (the picker) AND by the
// notification fan-out (`resolveAccountSupervisor` in lib/notifications.js), so a
// supervisor who was demoted to crew stops receiving their account's alerts. Keep
// these in sync; do not re-hardcode the trio anywhere else.
export const SUPERVISOR_ROLES = ['owner', 'admin', 'manager'];

// Roles whose EVENT notifications are MANDATORY — they cannot mute any of them.
// Crew must receive their operational alerts (checklist nudges, job assignment,
// account-ops changes, DMs) for accountability, so the Account page locks their
// toggles and the reducer refuses a mute at the write point (org_state is
// browser-writable, so the UI lock alone is not a boundary). Single source of
// truth — read by settings/Account.jsx AND store/reducer.js. Crew may still
// ENABLE things (e.g. subscribe a device to push); only turning an event OFF is
// blocked.
//
// THAT COVERS THE PER-THREAD SNOOZE TOO, since 2026-09-29 (NTF-3, Matt: "No — cleaners
// can't mute"; CS-291). This comment claimed the reducer refused a crew mute at the write
// point while only UPDATE_NOTIFICATION_PREFS did: TOGGLE_CONVERSATION_MUTE had no such
// check, so a crew member silenced a thread — office DMs included — from the thread header
// instead (lib/notifications.js skips muted recipients before the channel branches). Both
// write points now consult this list, and pages/Messaging.jsx hides the Snooze button for a
// mandatory role rather than for a hardcoded trio.
export const NOTIFICATIONS_MANDATORY_ROLES = ['crew'];

export function areNotificationsMandatory(user) {
  return !!user && NOTIFICATIONS_MANDATORY_ROLES.includes(user.role);
}

// Delivery-CHANNEL prefs (which device/how), not per-event mutes. Exempt from the
// mandatory lock so crew still manage push on their own device — OS push permission
// is device-controlled and can't be forced anyway. Everything else on the prefs
// object is an event toggle a mandatory-role user cannot switch off.
// NTF-2 + NTF-1 (2026-09-29) joined the set: quiet hours (when a push may reach the phone) and
// "text me alerts" (whether the phone is texted as well) are delivery prefs, not event mutes,
// so the mandatory-role rule has nothing to say about them. The POLICY for a mandatory role
// lives in the READER instead — lib/alertDelivery.quietHoursFor returns null for a crew member
// whatever the blob says, because org_state is browser-writable and a reader that ignores a
// value is the only guard that holds. Crew are never texted either: the two SMS events are
// office ones (SMS_ALERT_EVENT_KEYS).
const CHANNEL_PREF_KEYS = new Set([
  'mobilePushEnabled',
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
  'smsAlertsEnabled', 'smsOptedOut', 'smsOptedOutAt',
]);

// Enforce the mandatory-notifications policy on a notificationPrefs patch. For a
// mandatory-notifications role, drop every EVENT key being switched OFF
// (value === false) so a mute never lands; enables and channel prefs pass through.
// Non-mandatory roles pass unchanged. Returns the patch to actually apply (possibly
// empty, in which case the caller should no-op).
export function applyMandatoryNotificationPolicy(user, patch) {
  if (!patch || !areNotificationsMandatory(user)) return patch || {};
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (CHANNEL_PREF_KEYS.has(k) || v !== false) out[k] = v; // keep enables + channel prefs; drop event mutes
  }
  return out;
}

// The org must always keep at least one owner (Super Admin) — the singular
// recoverable top tier (OWNER_CORE + the owner-only settings gates). Deleting or
// demoting the last owner strands everyone off role/permission editing with no way
// back (DEL-05). Returns true when `userId` is an owner AND no other owner remains,
// so the reducer (the write point) and the Team UI both refuse it. Status-agnostic:
// a disabled owner still counts, since an admin can re-enable them, but zero owners
// is unrecoverable.
export function isLastOwner(users, userId) {
  if (!userId) return false;
  const owners = (users || []).filter((u) => u && u.role === 'owner');
  return owners.length <= 1 && owners.some((u) => u.id === userId);
}

// Each role's line in the translation catalog. A screen shows a role in its reader's
// language with `roleLabel(t, role)`; ROLE_LABELS is the English (activity log, exports,
// search) and reads the same lines, so the two cannot disagree.
export const ROLE_LABEL_KEYS = Object.freeze({
  owner: 'role.owner',
  admin: 'role.admin',
  manager: 'role.manager',
  supply_manager: 'role.supply_manager',
  crew: 'role.crew',
});
export function roleLabel(t, role) {
  const key = ROLE_LABEL_KEYS[role];
  return key ? t(key) : (role || '');
}
// The Manager role's operations level has its own name (S131): `role.manager` reads "Account
// Manager", and an Operations Manager reads this. A MEMBER is named by their role AND level.
export const OPS_MANAGER_LABEL_KEY = 'role.opsManager';
export function memberRoleLabel(t, user) {
  return isOpsManager(user) ? t(OPS_MANAGER_LABEL_KEY) : roleLabel(t, user?.role);
}
// The same in English (logs, exports, an invite email): ROLE_LABELS for the role, the operations
// level's own line for an Operations Manager.
export function memberRoleEnglish(user) {
  return isOpsManager(user) ? english(OPS_MANAGER_LABEL_KEY) : (ROLE_LABELS[user?.role] || user?.role || '');
}

export const ROLE_LABELS = Object.fromEntries(
  Object.entries(ROLE_LABEL_KEYS).map(([role, key]) => [role, english(key)]),
);

// ── THE PERMISSION COLUMNS (CS-858) ─────────────────────────────────────────────────────────
// Settings → Roles draws one column per entry, in this order: every role, with the Operations
// Manager's column right after the manager's. NOT a role list: ROLES, OFFICE_ROLES, the claim's
// VALID_ROLES and the RLS policies read ROLES, so the column can never be a login's role. A stored
// matrix row may name `operations_manager`; the org_state guard judges it like any column.
export const OPS_MANAGER_COLUMN = 'operations_manager';
export const PERMISSION_COLUMNS = Object.freeze(ROLES.flatMap((r) => (r === 'manager' ? [r, OPS_MANAGER_COLUMN] : [r])));

// The column a member's permissions come from: an Operations Manager's own, otherwise their role's.
export function permissionRoleOf(user) {
  if (!user) return null;
  return isOpsManager(user) ? OPS_MANAGER_COLUMN : (user.role ?? null);
}

// A column's heading, in the reader's language: a role's line, and for the Operations Manager's
// column the level's own (`role.opsManager`).
export const COLUMN_LABEL_KEYS = Object.freeze({ ...ROLE_LABEL_KEYS, [OPS_MANAGER_COLUMN]: OPS_MANAGER_LABEL_KEY });
export function columnLabel(t, column) {
  const key = COLUMN_LABEL_KEYS[column];
  return key ? t(key) : (column || '');
}

// The member a column stands for, for asking can() about the column itself (the guard's matrix
// deltas, canGiveColumn): nobody's overrides, the column's own level.
export function columnMember(column) {
  return column === OPS_MANAGER_COLUMN
    ? { id: null, role: 'manager', managerLevel: OPERATIONS_LEVEL }
    : { id: null, role: column };
}

// A SERVER caller at each level a check must hold a key at: their own — or, when their level could
// not be read (`managerLevel === null`: the roster read failed, or their rows disagree), BOTH
// manager levels, so the answer is never wider than either column (fail closed). Only a server
// authority carries null this way (api/_lib/authz.js, teamAuthority.js, jobsGuard.js); in the app a
// member with no level is an Account Manager, which permissionRoleOf already reads.
export function levelVariants(caller) {
  if (caller && caller.role === 'manager' && caller.managerLevel === null) {
    return [{ ...caller, managerLevel: ACCOUNT_LEVEL }, { ...caller, managerLevel: OPERATIONS_LEVEL }];
  }
  return [caller];
}

export const ROLE_DESCRIPTIONS = {
  owner: english('role.owner.desc'),
  admin: english('role.admin.desc'),
  manager: english('role.manager.desc'),
  supply_manager: english('role.supply_manager.desc'),
  crew: english('role.crew.desc'),
};

// Every roster list renders alphabetically — UI_RULES §51. The `users` slice keeps
// INSERTION order, so an unsorted list drops each newly-added member at the very
// bottom, below 40 rows of people, which reads as "they were never added at all".
// `sensitivity:'base'` so case and accents don't split the alphabet ("Darè" sits
// with the D's); email tie-breaks so two identical names hold a stable order;
// unnamed rows sink rather than floating above everyone on an empty string.
export function compareUsersByName(a, b) {
  const an = (a?.name || '').trim();
  const bn = (b?.name || '').trim();
  if (!an !== !bn) return an ? -1 : 1;
  return an.localeCompare(bn, undefined, { sensitivity: 'base', numeric: true })
    || (a?.email || '').localeCompare(b?.email || '');
}

// Universal surfaces every user always keeps — the daily-work hubs + core nav.
// These keys are NON-REVOCABLE: can() short-circuits them to true, and the Roles
// matrix + per-user overrides hide them, so a Super Admin can't toggle them off.
// My Day (time.clock) · Schedule (schedule.view) · Messaging (messaging.use) ·
// Settings → Account (settings.account). The My Day/Schedule split is a nav-level
// role choice (see Sidebar), not a permission difference.
export const ALWAYS_GRANTED = new Set(['time.clock', 'schedule.view', 'messaging.use', 'settings.account']);

// An OWNER's escape hatch. Unlike ALWAYS_GRANTED (universal), these stay
// role-gated for admin/crew — but an owner can NEVER lose them, so a
// permission-matrix edit can't lock the owner out of the ability to FIX it
// (Settings → Roles) or out of the Dashboard. Prevents a self-inflicted lockout
// when "permissions change" (2026-08-03 hardening).
export const OWNER_CORE = new Set(['dashboard.view', 'settings.roles.edit']);

// The reverse of OWNER_CORE: keys ONLY a Super Admin can ever hold. The server keeps the
// field each one gates owner-only BY ROLE (api/_lib/orgStateGuard.js: company.timezone,
// the owner's call 2026-09-23) and refuses it from anyone else whatever the matrix says,
// so can() does the same: a matrix row or per-user grant that names another role would
// only show that member a control whose save is refused (and a refused save drops every
// pending edit with it, store/sync.js). Settings → Roles shows a "Super Admin only" badge
// in place of the other roles' switches; a non-owner member's Access tab marks the row
// "Super Admin only", where an entry left from before can only be cleared. An owner still
// resolves these through the matrix + overrides as before.
export const OWNER_ONLY = new Set(['settings.company.timezone']);

// The per-user override keys that can change what a member may do: all of them for a
// Super Admin; for anyone else, none on an OWNER_ONLY key (can() ignores those). The Team
// pages count these, so an entry left on such a key doesn't read as custom access.
export function liveOverrideKeys(keys, role) {
  return (Array.isArray(keys) ? keys : []).filter((k) => role === 'owner' || !OWNER_ONLY.has(k));
}

// key → { label, description, defaultRoles }
export const PERMISSIONS = {
  'dashboard.view':          { label: 'View Dashboard',           defaultRoles: ['owner', 'admin', 'manager', 'supply_manager'] },
  'schedule.view':           { label: 'View Schedule',            defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'schedule.edit':           { label: 'Create / edit jobs',       defaultRoles: ['owner', 'admin', 'manager'] },
  'schedule.statusTransition': { label: 'Change job status',      defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'schedule.reset':          { label: 'Reset a job to Upcoming',   defaultRoles: ['owner', 'admin', 'manager'] },
  'clients.view':            { label: 'View Customers',             defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'clients.edit':            { label: 'Create / edit customers',    defaultRoles: ['owner', 'admin', 'manager'] },
  // The key kept its id when the customer delete became the ARCHIVE (CS-663 / CS-027: "Never
  // delete customers"), so the live matrix's role lists carry over; only what it does is new.
  'clients.delete':          { label: 'Archive customers',          defaultRoles: ['owner', 'admin', 'manager'] },
  'sites.edit':              { label: 'Manage customer sites',      defaultRoles: ['owner', 'admin', 'manager'] },
  'sites.attachments':       { label: 'Upload site attachments',  defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  // ---------- Contacts (CRM) ----------
  'contacts.view':           { label: 'View Contacts',                    defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'contacts.edit':           { label: 'Create / edit contacts',           defaultRoles: ['owner', 'admin', 'manager'] },
  'contacts.delete':         { label: 'Delete contacts',                  defaultRoles: ['owner', 'admin', 'manager'] },
  'tags.manage':             { label: 'Create / edit tags',               defaultRoles: ['owner', 'admin', 'manager'] },
  'pipeline.view':           { label: 'View sales pipeline',              defaultRoles: ['owner', 'admin', 'manager'] },
  'pipeline.edit':           { label: 'Move deals in pipeline',           defaultRoles: ['owner', 'admin', 'manager'] },
  // ---------- Invoices / Reminders / Messaging ----------
  // Per Clean Space Q24: Admin should not see financials. Owner-only by default;
  // Heather/Lauren get specific grants via per-user overrides if/when needed.
  'invoices.view':           { label: 'View Invoices',            defaultRoles: ['owner', 'manager'] },
  'invoices.edit':           { label: 'Create / edit invoices',   defaultRoles: ['owner', 'manager'] },
  'invoices.recordPayment':  { label: 'Record payments',          defaultRoles: ['owner', 'manager'] },
  'reminders.view':          { label: 'View Reminders',           defaultRoles: ['owner', 'manager'] },
  'reminders.edit':          { label: 'Edit reminder templates',  defaultRoles: ['owner', 'manager'] },
  // ---------- Contracts (CON-1..CON-14, CS-194) ----------
  // The signed service agreements: term, year prices, extra-service lines, the buildings a
  // contract covers, the renewal/price/notice reminders and the signed PDF. Owner + admin +
  // manager (the S35 full-access convention) — the office ENTERS hundreds of these, so admin
  // is in by default, unlike invoices. Crew never: a cleaner has no business in the book.
  //
  // 🔴 THE KEYS DO NOT CARRY THE MONEY. A contract's prices and its annual value are REVENUE,
  // so they follow the billing rule (CS-019 / Q24): the server serves money only to a holder
  // of `invoices.view` and IGNORES money fields written by anyone else, so a stripped read
  // followed by a save cannot blank a price. `contracts.edit` without `invoices.view` can
  // still keep the dates, the buildings and the paperwork straight.
  'contracts.view':          { label: 'View contracts',           defaultRoles: ['owner', 'admin', 'manager'] },
  'contracts.edit':          { label: 'Create / edit contracts',  defaultRoles: ['owner', 'admin', 'manager'] },
  'messaging.use':                  { label: 'Use Messaging',                 defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'messaging.startConversation':    { label: 'Start new conversations',       defaultRoles: ['owner', 'admin', 'manager'] },
  'messaging.startInternalThread':  { label: 'Start internal channels',        defaultRoles: ['owner', 'admin', 'manager'] },
  // 'messaging.internalComment' was removed (2026-07-01): the toggle was read by no
  // code, so revoking it did nothing (CREW_AUDIT #19) — and the roadmap wants every
  // role posting internal notes. remove-dead-perm.mjs drops it from the live matrix.
  'messaging.manageSnippets':       { label: 'Manage message snippets',       defaultRoles: ['owner', 'admin', 'manager'] },
  'messaging.bulkActions':          { label: 'Run bulk conversation actions', defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  // Read and administer EVERY connected mailbox, not just your own: the inbound poll's
  // scope (CS-016) and a Disconnect on someone else's mailbox (CS-088). Its holder does
  // NOT gain the right to SEND as another person's mailbox — that stays ownership-only
  // (api/_lib/inboxOwnership.js). Lives in Messaging, not Marketing, so it is visible in
  // Settings → Roles: `marketing.connectInbox` (what disconnect used to need) is hidden
  // there while marketing is dormant, which is the whole of CS-088.
  'messaging.manageInboxes':        { label: 'Manage all connected mailboxes', defaultRoles: ['owner', 'admin', 'manager'] },
  // ---------- Marketing (v37) ----------
  // Email marketing sequences with company-shared rotation inboxes. Sends are
  // app-owned (not user-owned like Messaging) so Crew defaults are off; Heather
  // / Lauren get specific grants via per-user overrides if/when needed.
  'marketing.view':                 { label: 'View Marketing',                 defaultRoles: ['owner', 'admin', 'manager'] },
  'marketing.manage':               { label: 'Manage marketing sequences',    defaultRoles: ['owner', 'admin', 'manager'] },
  'marketing.connectInbox':         { label: 'Connect marketing inboxes',     defaultRoles: ['owner', 'admin', 'manager'] },
  // ---------- Quotes (e-signature documents) ----------
  'quotes.view':             { label: 'View Quotes',              defaultRoles: ['owner', 'admin', 'manager'] },
  'quotes.create':           { label: 'Create quotes',            defaultRoles: ['owner', 'admin', 'manager'] },
  'quotes.send':             { label: 'Sign & send quotes',       defaultRoles: ['owner', 'admin', 'manager'] },
  'quotes.delete':           { label: 'Void quotes',              defaultRoles: ['owner', 'admin', 'manager'] },
  // ---------- Keys (check-in / check-out) ----------
  // Crew are the people who physically check keys in/out, so they need view +
  // checkout. Inventory management (add/edit/delete) stays admin-and-up.
  'keys.view':               { label: 'View keys',                defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'keys.manage':             { label: 'Add / edit / delete keys',  defaultRoles: ['owner', 'admin', 'manager'] },
  'keys.checkout':           { label: 'Check keys in / out',      defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  // ---------- Supplies (S58) ----------
  // Per-location approved lists + the request queue. A supervisor requests supplies;
  // the office fulfills. Full-access tiers by default (owner/admin/manager, the S35
  // manager convention), pared per client in Settings → Roles; crew never see the queue —
  // they work from their job cards, not the supply queue. Prices here are internal
  // PURCHASING costs, not customer revenue, so these do NOT gate on invoices.view (Q24).
  // The SUPPLY MANAGER (S131) holds view, manage and deliver — the order queue, the catalog, the
  // deliveries — plus dashboard.view and reports.view (Reports → Supply usage), and NOTHING else
  // by default: never supplies.approve (Matt: "only approved orders reach them") and never
  // supplies.request (they fill orders, they don't place them).
  'supplies.view':           { label: 'View Supplies',            defaultRoles: ['owner', 'admin', 'manager', 'supply_manager'] },
  // The Cleaner Hub (D4, 2026-10-13; Matt: "Request Supplies … I need this option to be turned on
  // or off … We can remove their access"): CLEANERS ask for supplies by default, from their own
  // page (/my-day/supplies) — for the buildings they clean (the route checks it) and with no price
  // in sight (their read is api/supplies GET crew-list). Off for one cleaner on their Team page
  // (TeamDetail → Time → "Can request supplies", a revoke through overrideForEffective below);
  // off for every cleaner in Settings → Roles → Crew. ⚠️ A STORED matrix row wins over this
  // default: production's needs crew added to its `supplies.request` row at release.
  'supplies.request':        { label: 'Request supplies',         defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  // SUP-1 (b) + SUP-9 (Matt, 2026-09-29): a request is APPROVED before the office fills it,
  // and by default the approver is the BUILDING'S SUPERVISOR (`client.supervisorId`), with
  // Settings → Operations able to name one person for the whole org instead. This key is the
  // capability, separate from `supplies.manage` so the two halves of the flow can be held by
  // different people: pare the office off it and they can fill but not approve, pare a
  // supervisor off `supplies.manage` and they can approve but not fill. The server enforces
  // both (api/_lib/orgStateGuard.js) — the UI is not the boundary.
  'supplies.approve':        { label: 'Approve / reject supply requests', defaultRoles: ['owner', 'admin', 'manager'] },
  'supplies.manage':         { label: 'Fulfill requests & manage approved items', defaultRoles: ['owner', 'admin', 'manager', 'supply_manager'] },
  // SUP-16 (a) + SUP-17 (a) (Matt, 2026-10-12): "Alberto, who's our delivery driver, would mark
  // it delivered when it's delivered to the property." The DELIVERY DRIVER's key: the Deliveries
  // page (every request the office sent, by building) and its Delivered button — nothing else.
  // Given to one person with a per-person grant (Settings → Team → the person → Access), e.g. a
  // driver on a crew login: the server reads it from the login's claim plus the stored overrides
  // like every key (api/supplies requests/deliver, GET deliveries). Holding it reveals no prices
  // and no budgets — the driver's list carries none. Never crew by default.
  // ⚠️ The office tiers hold it by default — owner, admin AND manager — by the S35 full-access
  // convention (the client's call, 2026-09-13), not owner + admin alone as plan 2026-10-12 §2 S3
  // first wrote: a key the Admin role carries and the Manager role lacks would stop every manager
  // giving the Admin role (canGiveRole, the owner's rule of 2026-09-23). Pare it per role in
  // Settings → Roles.
  'supplies.deliver':        { label: 'Deliveries (mark supplies delivered)', defaultRoles: ['owner', 'admin', 'manager', 'supply_manager'] },
  // Complaints folded into Work Orders (Quality hub) — the standalone complaints.* perms
  // were retired. Customer complaints are now Work Orders of type:complaint, gated by the
  // qc.* / problems.manage vocabulary (see the Swept QC group).
  // ---------- Client review (the Review section: drafts + build decisions) ----------
  // The client's review workspace: the outbound email/SMS/document drafts to sign off AND
  // Matt's build-decision questions. Owner/admin/manager (the reviewing client persona);
  // crew never see it. Review state (draft accept/notes, decision answers/notes, layout
  // picks, section approvals) lives in the shared org_state blob so both sides see it (see
  // lib/clientReview.js). The KEY stays drafts.view — renaming it would transform the matrix.
  'drafts.view':             { label: 'View Review (drafts and build decisions)', defaultRoles: ['owner', 'admin', 'manager'] },
  // ---------- Client hub (customer logins) ----------
  // Who may see, and who may hand out, a CUSTOMER's login to the hub (HUB-4: "the office
  // adds and removes them"). Owner / admin / manager by default — the S35 full-access
  // convention — and NEVER crew: a cleaner giving someone access to a building's record is
  // not a thing this app should be able to express. Crew's "never" is a ROLE floor the
  // SERVER holds as well (the keys gate /api/client-users/*, and requireAuthority refuses a
  // client login there outright), because `can()` puts no key out of a per-user grant's
  // reach. Granting these to a cleaner shows them the page; the route still refuses them.
  'hub.users.view':          { label: 'View customer logins',             defaultRoles: ['owner', 'admin', 'manager'] },
  'hub.users.manage':        { label: 'Add / invite / remove customer logins', defaultRoles: ['owner', 'admin', 'manager'] },
  // The client hub redesign (plan §3.4): each building's Messages thread with its customers —
  // Messaging → Customers and the customer page's Messages tab. READ and REPLY are separate so the
  // office can let someone follow a conversation without answering for the company. Owner / admin
  // / manager by default (the S35 convention), never crew; the server gates /api/client-messages/*
  // on the same keys, and requireAuthority refuses a customer login there before any key is read.
  'hub.messages.view':       { label: 'Read customer messages',          defaultRoles: ['owner', 'admin', 'manager'] },
  'hub.messages.reply':      { label: 'Reply to customer messages',      defaultRoles: ['owner', 'admin', 'manager'] },
  // The documents a customer downloads from the hub (client hub redesign, plan 2026-10-08 §3.6):
  // a building's certificate of insurance, the company's W-9. Matt's team uploads, replaces and
  // hides them; owner / admin / manager by default, never crew. The server re-checks this key
  // on every /api/customer-documents/* branch, and a customer login is refused there outright.
  'hub.documents.manage':    { label: 'Upload / manage customer documents (COI, W-9)', defaultRoles: ['owner', 'admin', 'manager'] },
  // ---------- Settings ----------
  'settings.company':        { label: 'Edit company settings',    defaultRoles: ['owner', 'admin', 'manager'] },
  'settings.services':       { label: 'Edit services / frequencies', defaultRoles: ['owner', 'manager'] },
  'settings.team.view':      { label: 'View team',                defaultRoles: ['owner', 'admin', 'manager'] },
  'settings.team.edit':      { label: 'Invite / edit team',       defaultRoles: ['owner', 'admin', 'manager'] },
  'settings.roles.edit':     { label: 'Edit role permissions',    defaultRoles: ['owner', 'manager'] },
  'settings.account':        { label: 'Edit own account',         defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  // ---------- Integrations ----------
  'integrations.view':       { label: 'View integrations',           defaultRoles: ['owner', 'manager'] },
  'integrations.manage':     { label: 'Connect / manage integrations', defaultRoles: ['owner', 'manager'] },
  // ---------- Operations / Swept replacement (v49) ----------
  // Account-level ops config + access codes (ops.*), crew clock-in + labor (time.*),
  // the variance report (variance.*), and QC inspections/checklists/problems (qc.*).
  // Crew clock in and can add before/after photos; managers edit config, see labor /
  // variance, and reveal codes. Every sensitive API route ALSO re-checks role /
  // site-assignment server-side — the open-RLS posture means UI gating is not a
  // boundary. ops.revealCodes additionally allows assigned crew via a server-side
  // site-assignment check (not a role default). See CLEANSPACE_SWEPT.md §2.4.
  'ops.view':                { label: 'View account operations',         defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'ops.edit':                { label: 'Edit account operations',         defaultRoles: ['owner', 'admin', 'manager'] },
  'ops.security.view':       { label: 'View access / security codes',    defaultRoles: ['owner', 'admin', 'manager'] },
  'ops.revealCodes':         { label: 'Reveal door / alarm codes',       defaultRoles: ['owner', 'admin', 'manager'] },
  'ops.media.upload':        { label: 'Upload account photos / video',   defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'time.clock':              { label: 'Clock in / out',                  defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'time.config':             { label: 'Edit geofence / expected time',   defaultRoles: ['owner', 'admin', 'manager'] },
  'time.edit.all':           { label: 'Correct / manual time entries',   defaultRoles: ['owner', 'admin', 'manager'] },
  'time.approve':            { label: 'Approve time entries',            defaultRoles: ['owner', 'admin', 'manager'] },
  // Per-cleaner clock rules (`users[].clockRules`, checklists step 4b, rules R6/R7): the
  // office turns the clock-out checklist block or the clock-in geofence off for ONE person
  // — the cleaner an account manager hasn't trained on the app yet. Separate from
  // time.config, which sets those gates for the whole org: this one EXEMPTS a named person
  // from them, so it must be revocable on its own. The server keeps the field behind the
  // same key (api/_lib/orgStateGuard.js), your own row included.
  'time.clockRules':         { label: "Turn a cleaner's checklist block or geofence off", defaultRoles: ['owner', 'admin', 'manager'] },
  // The Time Clock surfaces (Sept 3): /time + the punch history on account,
  // crew-member and job pages. Same audience as the variance report.
  'time.view':               { label: 'View crew clock-in/out history',  defaultRoles: ['owner', 'admin', 'manager'] },
  'variance.view':           { label: 'View the variance report',        defaultRoles: ['owner', 'admin', 'manager'] },
  'variance.actions':        { label: 'Act on variance (message / QC)',  defaultRoles: ['owner', 'admin', 'manager'] },
  'variance.export':         { label: 'Export variance CSV',             defaultRoles: ['owner', 'admin', 'manager'] },
  'variance.configThreshold': { label: 'Edit variance flag threshold',   defaultRoles: ['owner', 'manager'] },
  'reports.view':            { label: 'View reports',                   defaultRoles: ['owner', 'admin', 'manager', 'supply_manager'] },
  // The activity log (CS-379; Matt's LOG-4). This key decides whether the surface OPENS;
  // WHAT it serves is a ROLE rule the server applies to the data — the owner everything, an
  // admin everything except pay and money changes, a manager only the customers they
  // supervise, crew nothing at all (src/lib/activityLog.js logVisibilityFor, enforced in
  // api/activity). Crew's "nothing" cannot BE a key: can() puts no key out of a per-user
  // grant's reach, so one granted cleaner would read the whole company's trail (the same
  // reasoning as canEndAccess and time.clockRules). Granting this key to a cleaner therefore
  // does nothing — the route still refuses them.
  'activity.view':           { label: 'View the activity log',           defaultRoles: ['owner', 'admin', 'manager'] },
  // Property profit & loss pulled read-only from QuickBooks Online (the manager dashboard's
  // per-property P&L, CS-066). FINANCIALS data → the owner+manager pattern (admin excluded,
  // cf. invoices/payroll/Q24). Server twin: requirePermission('financials.view') in
  // api/quickbooks/[...path].js (pnl), which additionally scopes a non-owner to the
  // properties they supervise. Connect/link/entities stay owner-only by ROLE (an authority
  // surface — the whole company's books — not a matrix capability).
  'financials.view':         { label: 'View property profit & loss (QuickBooks)', defaultRoles: ['owner', 'manager'] },
  // Payroll — the pay run (hours × rate → gross, custom lines, CSV export). Payroll
  // is COMPENSATION data, so it follows the FINANCIALS pattern (owner + manager, NOT
  // admin — cf. invoices / Clean Space Q24); rate editing is owner-only; crew never
  // see payroll. (Grant a specific admin via a per-user override if needed.)
  'payroll.view':            { label: 'View payroll',                     defaultRoles: ['owner', 'manager'] },
  'payroll.edit':            { label: 'Add / edit payroll lines & export', defaultRoles: ['owner', 'manager'] },
  'payroll.rates.edit':      { label: 'Set team-member pay rates',        defaultRoles: ['owner'] },
  // HR — employee records, special-service pay, reimbursements, PTO, documents.
  // People + compensation-adjacent data → same FINANCIALS pattern as payroll
  // (owner + manager, admin excluded by default; grant per-user if needed). Pay-rate
  // editing stays on the owner-only payroll.rates.edit key (reused in the HR profile).
  'hr.view':                 { label: 'View HR (employees, PTO, reimbursements)', defaultRoles: ['owner', 'manager'] },
  'hr.edit':                 { label: 'Edit HR records, special services & reimbursements', defaultRoles: ['owner', 'manager'] },
  'qc.view':                 { label: 'View inspections / checklists',    defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'qc.inspect':              { label: 'Perform inspections',             defaultRoles: ['owner', 'admin', 'manager'] },
  // Completing per-account checklists is a core crew task (SWEPT §5.6) — separate
  // from qc.inspect so scored inspections stay manager-only. The server re-scopes
  // crew submits to their assigned accounts (api/qc checklists/submit).
  'qc.checklist.perform':    { label: 'Complete checklists',             defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'qc.templates.edit':       { label: 'Edit QC templates',               defaultRoles: ['owner', 'admin', 'manager'] },
  'qc.share':                { label: 'Share inspection reports',        defaultRoles: ['owner', 'admin', 'manager'] },
  'problems.manage':         { label: 'Log / resolve problem reports',   defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  // ---------- Super Admin gates ----------
  'staff.assignRoles':       { label: 'Assign roles to staff',       defaultRoles: ['owner', 'manager'] },
  'staff.editOverrides':     { label: 'Grant / revoke per-user perms', defaultRoles: ['owner', 'manager'] },
  'staff.resetPassword':     { label: 'Send password-reset links',   defaultRoles: ['owner', 'admin', 'manager'] },
  // The org timezone anchors every scheduled job, invoice date and reminder for the
  // whole company — changing it re-interprets what every existing date MEANS, which
  // is why it sits above settings.company as a Super-Admin-only gate. It is in
  // OWNER_ONLY: the manager listed here (S35's every-key default) holds nothing,
  // because can() gives the key to a Super Admin alone, as the server does.
  'settings.company.timezone': { label: 'Change the org timezone',   defaultRoles: ['owner', 'manager'] },
};

// A roles list with the Operations Manager's column right after the manager's, wherever the manager
// is (CS-858: OMs start with exactly what Account Managers have). Already there, or no manager: a copy.
const withOpsColumn = (roles) => (roles.includes('manager') && !roles.includes(OPS_MANAGER_COLUMN)
  ? roles.flatMap((r) => (r === 'manager' ? [r, OPS_MANAGER_COLUMN] : [r]))
  : [...roles]);

// Every key's DEFAULT COLUMNS — its defaultRoles plus the Operations Manager's column where the
// manager's is — derived ONCE here, so the hand-written defaultRoles above keep naming roles only
// (and every test that reads them keeps reading roles). can() falls back to these for a key the
// stored matrix lacks; seedPermissions and the Roles page's schema-default rows and Reset use them.
const DEFAULT_COLUMNS = new Map(Object.entries(PERMISSIONS).map(([key, def]) => [key, Object.freeze(withOpsColumn(def.defaultRoles))]));
export function defaultColumnsOf(key) {
  return DEFAULT_COLUMNS.get(key) || [];
}

// THE STORED-MATRIX TRANSFORM (CS-858): every saved row whose roles name the manager gains the
// Operations Manager's column right after it, so OMs start with exactly what Account Managers have.
// Every other row — one without the manager, one already carrying the column, and one not in the
// app's shape — is left exactly as it is, the same object. Pure and idempotent. ONE function for the
// demo's v59 → v60 hop (store/persist.js) and production's release data-op
// (scripts/dataop-om-permission-column.mjs), so the demo and production cannot drift.
export function withOpsManagerColumn(permissions) {
  if (!Array.isArray(permissions)) return { permissions: permissions ?? null, added: [] };
  const added = [];
  const next = permissions.map((p) => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Array.isArray(p.roles)) return p;
    if (!p.roles.includes('manager') || p.roles.includes(OPS_MANAGER_COLUMN)) return p;
    added.push(p.id);
    return { ...p, roles: withOpsColumn(p.roles) };
  });
  return { permissions: next, added };
}

// Canonical section grouping for the Settings → Roles matrix, one block per section.
// Array order = display order. This is the SINGLE SOURCE OF TRUTH for how permissions
// are grouped in the general editor (Roles.jsx imports it).
//
// Contract (enforced by app/scripts/test-permission-groups.mjs):
//   • Every PERMISSIONS key that is NOT in ALWAYS_GRANTED appears in EXACTLY ONE group.
//   • No group lists a key that PERMISSIONS doesn't define.
//   • ALWAYS_GRANTED keys (My Day, Schedule, Messaging, Account) are never listed —
//     they can't be toggled, so the matrix filters them out.
// The test fails the moment a new permission key is added without a home, so a real
// permission can never silently fall into Roles.jsx's "Other" catch-all again (that
// fallback exists only for stale keys lingering in a returning viewer's saved matrix).
export const PERM_GROUPS = [
  { id: 'dashboard',    label: 'Dashboard',             keys: ['dashboard.view'] },
  { id: 'schedule',     label: 'Schedule & Jobs',       keys: ['schedule.edit', 'schedule.statusTransition', 'schedule.reset'] },
  { id: 'clients',      label: 'Customers & Locations', keys: ['clients.view', 'clients.edit', 'clients.delete', 'sites.edit', 'sites.attachments'] },
  { id: 'contacts',     label: 'Contacts & Pipeline',   keys: ['contacts.view', 'contacts.edit', 'contacts.delete', 'tags.manage', 'pipeline.view', 'pipeline.edit'] },
  { id: 'invoices',     label: 'Invoices & Reminders',  keys: ['invoices.view', 'invoices.edit', 'invoices.recordPayment', 'reminders.view', 'reminders.edit'] },
  { id: 'contracts',    label: 'Contracts',             keys: ['contracts.view', 'contracts.edit'] },
  { id: 'messaging',    label: 'Messaging',             keys: ['messaging.startConversation', 'messaging.startInternalThread', 'messaging.manageSnippets', 'messaging.bulkActions', 'messaging.manageInboxes'] },
  { id: 'marketing',    label: 'Marketing',             keys: ['marketing.view', 'marketing.manage', 'marketing.connectInbox'] },
  { id: 'drafts',       label: 'Review (drafts and decisions)',  keys: ['drafts.view'] },
  { id: 'quotes',       label: 'Quotes',                keys: ['quotes.view', 'quotes.create', 'quotes.send', 'quotes.delete'] },
  { id: 'keys',         label: 'Keys',                  keys: ['keys.view', 'keys.manage', 'keys.checkout'] },
  { id: 'supplies',     label: 'Supplies',              keys: ['supplies.view', 'supplies.request', 'supplies.approve', 'supplies.manage', 'supplies.deliver'] },
  { id: 'ops',          label: 'Operations',            keys: ['ops.view', 'ops.edit', 'ops.security.view', 'ops.revealCodes', 'ops.media.upload'] },
  { id: 'time',         label: 'Time & Labor',          keys: ['time.view', 'time.config', 'time.clockRules', 'time.edit.all', 'time.approve'] },
  { id: 'variance',     label: 'Variance Report',       keys: ['variance.view', 'variance.actions', 'variance.export', 'variance.configThreshold'] },
  { id: 'reports',      label: 'Reports',               keys: ['reports.view', 'financials.view', 'activity.view'] },
  { id: 'payroll',      label: 'Payroll',               keys: ['payroll.view', 'payroll.edit', 'payroll.rates.edit'] },
  { id: 'hr',           label: 'HR',                    keys: ['hr.view', 'hr.edit'] },
  { id: 'qc',           label: 'Quality (Inspections)', keys: ['qc.view', 'qc.inspect', 'qc.checklist.perform', 'qc.templates.edit', 'qc.share', 'problems.manage'] },
  { id: 'clienthub',    label: 'Customer Logins',       keys: ['hub.users.view', 'hub.users.manage', 'hub.documents.manage'] },
  { id: 'clientmessages', label: 'Customer Messages',   keys: ['hub.messages.view', 'hub.messages.reply'] },
  { id: 'settings',     label: 'Settings',              keys: ['settings.company', 'settings.services', 'settings.team.view', 'settings.team.edit', 'settings.roles.edit'] },
  { id: 'integrations', label: 'Integrations',          keys: ['integrations.view', 'integrations.manage'] },
  { id: 'super',        label: 'Super Admin Only',      keys: ['staff.assignRoles', 'staff.editOverrides', 'staff.resetPassword', 'settings.company.timezone'] },
];

// Build the initial permissions list for the store: one row per key, its default COLUMNS (the
// Operations Manager's included).
export function seedPermissions() {
  return Object.entries(PERMISSIONS).map(([key, def]) => ({
    id: key,
    label: def.label,
    roles: [...defaultColumnsOf(key)],
  }));
}

// Resolve the override record for a given user, if any.
function findOverride(overrides, userId) {
  if (!overrides || !userId) return null;
  return overrides.find((o) => o.userId === userId) || null;
}

// The columns a key resolves to: its stored row's roles, else the code default (a key the stored
// matrix doesn't have yet). A stored row WINS over the default, so a saved matrix that predates a
// column gives that column nothing until its rows are updated (the release data-op, CS-858).
function columnsOf(permKey, permissions) {
  const record = permissions?.find((p) => p.id === permKey);
  // Falling back to the code default when a key isn't yet in the live permissions list lets
  // newly-added permission keys take effect on existing localStorage state without forcing a
  // version bump + migration — user customizations in state still take precedence.
  return record ? record.roles : defaultColumnsOf(permKey);
}

// Check if a user can perform a permission, given the live matrix + optional overrides.
// overrides: [{ userId, grants: [key], revokes: [key] }]
// Precedence: explicit revoke > explicit grant > the member's COLUMN (permissionRoleOf: their
// role's, or the Operations Manager's for a manager at that level). OWNER_ONLY, OWNER_CORE,
// ALWAYS_GRANTED and the owner's escape hatch read the real role.
export function can(user, permKey, permissions, overrides) {
  if (!user) return false; // no identity at all → closed
  // Universal surfaces are non-revocable — true for every AUTHENTICATED identity,
  // regardless of the live matrix, per-user overrides, OR a missing/blank role.
  // This check sits ABOVE the role guard so a valid session is never stranded off
  // the daily-work hubs (My Day / Schedule / Messaging / Account) by an identity-
  // or role-resolution gap — the exact "Page not available" lockout of 2026-08-03.
  if (ALWAYS_GRANTED.has(permKey)) return true;
  if (!user.role) return false; // roleless → no ELEVATED permission (still fails closed)
  // Super-Admin-only keys: nobody else holds them, whatever the matrix or a grant says.
  if (OWNER_ONLY.has(permKey) && user.role !== 'owner') return false;
  // Owner escape hatch — an owner keeps these regardless of the live matrix, so a
  // permission-matrix edit can never strip an owner's ability to fix it.
  if (user.role === 'owner' && OWNER_CORE.has(permKey)) return true;
  const ov = findOverride(overrides, user.id);
  if (ov?.revokes?.includes(permKey)) return false;
  if (ov?.grants?.includes(permKey)) return true;
  return columnsOf(permKey, permissions).includes(permissionRoleOf(user));
}

// Whether `member`'s COLUMN carries `key` before any per-person override — the stored row, else
// the code default, exactly as can() reads it. The Team page's "Role default" (TeamDetail › Access,
// the cleaner's "Can request supplies"), so an Operations Manager's reads the OM column.
export function columnHolds(member, key, permissions) {
  return !!member && columnsOf(key, permissions).includes(permissionRoleOf(member));
}

// Whether `user` may GIVE `role` to a member: invite someone at it, or change someone
// to it. The owner's rule (2026-09-23): nobody can give a role that carries a permission
// they don't hold, read from the live matrix plus the giver's own per-user overrides. The
// role is read as a role (its matrix record, else the schema default; nobody's overrides).
// Only a Super Admin gives Super Admin, and a Super Admin (the tier that edits the matrix)
// may give any role. With the default matrix an Admin may give Admin or Crew, and a Manager
// Admin, Manager or Crew; pare Manager down to what Admins hold and Admins may give it too.
// ALWAYS_GRANTED keys are everyone's, so they never count. The invite form, the Team
// page's role picker, the org_state guard and /api/settings/users all run this function.
export function canGiveRole(user, role, permissions, overrides) {
  return ROLES.includes(role) && canGiveColumn(user, role, permissions, overrides);
}

// canGiveRole's rule for a permission COLUMN (CS-858): giving someone a column — a role, or the
// Operations Manager's level (lib/teamLimits mayGiveLevel; orgStateGuard teamViolations, which also
// asks it for moving an OM back to Account Manager) — takes holding every permission the column
// carries (its matrix row, else the code default; ALWAYS_GRANTED never counts). A Super Admin gives
// any column; nobody else the Super Admin's.
export function canGiveColumn(user, column, permissions, overrides) {
  if (!user || !user.role || !PERMISSION_COLUMNS.includes(column)) return false;
  if (user.role === 'owner') return true;
  if (column === 'owner') return false;
  const member = columnMember(column);
  return Object.keys(PERMISSIONS).every((key) => ALWAYS_GRANTED.has(key)
    || !can(member, key, permissions, null)
    || can(user, key, permissions, overrides));
}

// Whether `user` may GRANT the single permission `key` — canGiveRole's rule (above) extended
// from whole roles to individual keys (CS-331, owner's option (b) 2026-09-24). A grant is valid
// only when the caller HOLDS the key, resolved on the COMMITTED matrix + the caller's own
// overrides (can()), never the proposed save — so a same-save self-grant can't bootstrap. A
// Super Admin holds everything, so an owner may grant anything and owners are unaffected; a
// caller with no role gives nothing. OWNER_ONLY keys are held by no other role, so a non-owner
// can never grant them. Turning a permission OFF (a revoke) never goes through this — removing
// access stays available. Used by the Roles matrix + TeamDetail › Access, and mirrored by
// orgStateGuard on the server, so no client control offers a grant the server would refuse.
export function canGrantPermission(user, key, permissions, overrides) {
  if (!user || !user.role) return false;
  if (user.role === 'owner') return true;
  return can(user, key, permissions, overrides);
}

// Whether `actorRole` may END OR REDUCE an Admin's access — a no-access status, an invite
// revoke, a login ban, removal from the team (CS-329, owner's call 2026-09-24), OR a change to
// the Admin's access level, e.g. Admin -> crew (CS-355, owner's call 2026-09-25). Changing an
// Admin's role reduces their access the same way disabling or removing them ends it — and once
// demoted a later save could disable or remove them — so all of it is admin+ BY ROLE: a manager
// or crew member is refused even holding settings.team.edit, staff.assignRoles or a removal
// permission (can() puts no key out of a grant's reach, so the floor can't be a permission key).
// Super Admin (owner) targets keep their own Super-Admin-only rules in each layer, and promoting
// someone TO Admin is NOT gated here (that stays canGiveRole's rule); this helper is ONLY the
// Admin-target floor. Shared by all three layers: teamAuthority.loginRefusal (the login half),
// orgStateGuard (the roster half), and teamLimits (the Team UI), so the halves can't drift.
export function canEndAccess(actorRole, targetIsAdmin) {
  if (!targetIsAdmin) return true;
  return actorRole === 'admin' || actorRole === 'owner';
}

// Whether `actorRole` may REDUCE a whole ROLE's access through the permission MATRIX — turning a
// column's key OFF lowers what EVERY member of that role may do at once, so it is gated BY ROLE, not
// by a key (can() puts no key out of a grant's reach, so a floor can't be a permission). Only a Super
// Admin (owner) may reduce the Super Admin column (CS-371, owner's call 2026-09-25); admin+ may reduce
// the Admin column (CS-370; identical to canEndAccess for an Admin target); the Manager and Crew
// columns carry no floor. This is the ROLE-COLUMN floor — the per-MEMBER floor (a status change, a
// role change, a removal, an override reduction) is canEndAccess. Shared by orgStateGuard's matrix
// branch and Roles.jsx so the server and the page can't drift; the owner column's OWNER_CORE keys are
// always granted to an owner regardless of the matrix, so they are never a reduction (can() gives them).
export function canReduceRole(actorRole, targetRole) {
  if (targetRole === 'owner') return actorRole === 'owner';
  if (targetRole === 'admin') return actorRole === 'admin' || actorRole === 'owner';
  return true;
}

// A member's override row after setting ONE key's EFFECTIVE value to `on` — the Team page's
// per-person switches (the Cleaner Hub's "Can request supplies", D4), on the same data the Access
// tab edits. `roleHas` is whether the member's role holds the key on the committed matrix (else
// the schema default), so:
//   off, role has it      → a revoke (and any stray grant of it dropped)
//   on,  role has it      → the revoke cleared (nothing custom left)
//   on,  role lacks it    → a grant (a stored matrix that predates the default)
//   off, role lacks it    → the grant cleared
// Every other key in the row is left exactly as it was. Pure: the caller still applies the
// Access tab's guards — staff.editOverrides, the owner's limits, and turning a key ON only when
// the viewer holds it (canGrantPermission) — and dispatches SET_USER_PERMISSION_OVERRIDE.
export function overrideForEffective({ grants = [], revokes = [], key, roleHas = false, on = true } = {}) {
  const without = (list) => (Array.isArray(list) ? list : []).filter((k) => k !== key);
  const g = without(grants);
  const r = without(revokes);
  if (on) return roleHas ? { grants: g, revokes: r } : { grants: [...g, key], revokes: r };
  return roleHas ? { grants: g, revokes: [...r, key] } : { grants: g, revokes: r };
}
