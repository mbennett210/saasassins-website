// Roles + permissions.
// The matrix is the *default*; the live assignment lives in the store (state.permissions)
// and can be edited in Settings → Roles (Super Admin only).
// Per-user overrides live in state.userPermissionOverrides and are applied in can().
//
// Naming: schema is `owner / admin / manager / crew`; UI labels are
// `Super Admin / Admin / Manager / Crew` via ROLE_LABELS. Decision: keep the schema keys —
// they're shorter, already wired through the codebase, and the UI display is fully owned by
// ROLE_LABELS / ROLE_DESCRIPTIONS. Renaming a schema key would touch every
// reducer/selector/permission check for zero user-visible benefit — to rename a role's
// DISPLAY, edit ROLE_LABELS only.
//
// 2026-09-13: added `manager` as a real 4th tier between Admin and Crew. Per the client's
// call it DEFAULTS to full access (every permission, same as owner/Super Admin) and is pared
// back from there in Settings → Roles. Column/display order follows ROLES.

export const ROLES = ['owner', 'admin', 'manager', 'crew'];

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
export const NOTIFICATIONS_MANDATORY_ROLES = ['crew'];

export function areNotificationsMandatory(user) {
  return !!user && NOTIFICATIONS_MANDATORY_ROLES.includes(user.role);
}

// Delivery-CHANNEL prefs (which device/how), not per-event mutes. Exempt from the
// mandatory lock so crew still manage push on their own device — OS push permission
// is device-controlled and can't be forced anyway. Everything else on the prefs
// object is an event toggle a mandatory-role user cannot switch off.
const CHANNEL_PREF_KEYS = new Set(['mobilePushEnabled']);

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

export const ROLE_LABELS = {
  owner: 'Super Admin',
  admin: 'Admin',
  manager: 'Manager',
  crew: 'Crew',
};

export const ROLE_DESCRIPTIONS = {
  owner: 'Full access. Can assign roles, edit permissions, and override access per user. The top tier.',
  admin: 'Manages day-to-day ops: customers, jobs, messages, team. Cannot see financials or assign roles.',
  manager: 'Fully configurable. Starts with the same access as Super Admin — pare it back to exactly what a manager should have.',
  crew:  'Sees their own jobs and assigned customers. Can update job status and add notes.',
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
  'dashboard.view':          { label: 'View Dashboard',           defaultRoles: ['owner', 'admin', 'manager'] },
  'schedule.view':           { label: 'View Schedule',            defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'schedule.edit':           { label: 'Create / edit jobs',       defaultRoles: ['owner', 'admin', 'manager'] },
  'schedule.statusTransition': { label: 'Change job status',      defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'schedule.reset':          { label: 'Reset a job to Upcoming',   defaultRoles: ['owner', 'admin', 'manager'] },
  'clients.view':            { label: 'View Customers',             defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'clients.edit':            { label: 'Create / edit customers',    defaultRoles: ['owner', 'admin', 'manager'] },
  'clients.delete':          { label: 'Delete customers',           defaultRoles: ['owner', 'admin', 'manager'] },
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
  'messaging.use':                  { label: 'Use Messaging',                 defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
  'messaging.startConversation':    { label: 'Start new conversations',       defaultRoles: ['owner', 'admin', 'manager'] },
  'messaging.startInternalThread':  { label: 'Start internal channels',        defaultRoles: ['owner', 'admin', 'manager'] },
  // 'messaging.internalComment' was removed (2026-07-01): the toggle was read by no
  // code, so revoking it did nothing (CREW_AUDIT #19) — and the roadmap wants every
  // role posting internal notes. remove-dead-perm.mjs drops it from the live matrix.
  'messaging.manageSnippets':       { label: 'Manage message snippets',       defaultRoles: ['owner', 'admin', 'manager'] },
  'messaging.bulkActions':          { label: 'Run bulk conversation actions', defaultRoles: ['owner', 'admin', 'manager', 'crew'] },
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
  // manager convention), pared per client in Settings → Roles; crew never see it —
  // they work from their job cards, not the supply queue. Prices here are internal
  // PURCHASING costs, not customer revenue, so these do NOT gate on invoices.view (Q24).
  'supplies.view':           { label: 'View Supplies',            defaultRoles: ['owner', 'admin', 'manager'] },
  'supplies.request':        { label: 'Request supplies',         defaultRoles: ['owner', 'admin', 'manager'] },
  'supplies.manage':         { label: 'Fulfill requests & manage approved items', defaultRoles: ['owner', 'admin', 'manager'] },
  // Complaints folded into Work Orders (Quality hub) — the standalone complaints.* perms
  // were retired. Customer complaints are now Work Orders of type:complaint, gated by the
  // qc.* / problems.manage vocabulary (see the Swept QC group).
  'reviews.view':            { label: 'View reviews / reputation', defaultRoles: ['owner', 'admin', 'manager'] },
  // Everything that touches the PUBLIC Google listing — replies, posts,
  // photos, connect/disconnect. Server twin: every /api/reviews route
  // requireRole(['owner','admin']).
  'reviews.manage':          { label: 'Manage the Google listing (replies, posts, photos)', defaultRoles: ['owner', 'admin', 'manager'] },
  // ---------- Client review (the Review section: drafts + build decisions) ----------
  // The client's review workspace: the outbound email/SMS/document drafts to sign off AND
  // Matt's build-decision questions. Owner/admin/manager (the reviewing client persona);
  // crew never see it. Review state (draft accept/notes, decision answers/notes, layout
  // picks, section approvals) lives in the shared org_state blob so both sides see it (see
  // lib/clientReview.js). The KEY stays drafts.view — renaming it would transform the matrix.
  'drafts.view':             { label: 'View Review (drafts and build decisions)', defaultRoles: ['owner', 'admin', 'manager'] },
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
  'reports.view':            { label: 'View reports',                   defaultRoles: ['owner', 'admin', 'manager'] },
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
  { id: 'messaging',    label: 'Messaging',             keys: ['messaging.startConversation', 'messaging.startInternalThread', 'messaging.manageSnippets', 'messaging.bulkActions'] },
  { id: 'marketing',    label: 'Marketing',             keys: ['marketing.view', 'marketing.manage', 'marketing.connectInbox'] },
  { id: 'drafts',       label: 'Review (drafts and decisions)',  keys: ['drafts.view'] },
  { id: 'quotes',       label: 'Quotes',                keys: ['quotes.view', 'quotes.create', 'quotes.send', 'quotes.delete'] },
  { id: 'keys',         label: 'Keys',                  keys: ['keys.view', 'keys.manage', 'keys.checkout'] },
  { id: 'supplies',     label: 'Supplies',              keys: ['supplies.view', 'supplies.request', 'supplies.manage'] },
  { id: 'reviews',      label: 'Reviews',               keys: ['reviews.view', 'reviews.manage'] },
  { id: 'ops',          label: 'Operations',            keys: ['ops.view', 'ops.edit', 'ops.security.view', 'ops.revealCodes', 'ops.media.upload'] },
  { id: 'time',         label: 'Time & Labor',          keys: ['time.view', 'time.config', 'time.clockRules', 'time.edit.all', 'time.approve'] },
  { id: 'variance',     label: 'Variance Report',       keys: ['variance.view', 'variance.actions', 'variance.export', 'variance.configThreshold'] },
  { id: 'reports',      label: 'Reports',               keys: ['reports.view'] },
  { id: 'payroll',      label: 'Payroll',               keys: ['payroll.view', 'payroll.edit', 'payroll.rates.edit'] },
  { id: 'hr',           label: 'HR',                    keys: ['hr.view', 'hr.edit'] },
  { id: 'qc',           label: 'Quality (Inspections)', keys: ['qc.view', 'qc.inspect', 'qc.checklist.perform', 'qc.templates.edit', 'qc.share', 'problems.manage'] },
  { id: 'settings',     label: 'Settings',              keys: ['settings.company', 'settings.services', 'settings.team.view', 'settings.team.edit', 'settings.roles.edit'] },
  { id: 'integrations', label: 'Integrations',          keys: ['integrations.view', 'integrations.manage'] },
  { id: 'super',        label: 'Super Admin Only',      keys: ['staff.assignRoles', 'staff.editOverrides', 'staff.resetPassword', 'settings.company.timezone'] },
];

// Build the initial permissions list for the store.
export function seedPermissions() {
  return Object.entries(PERMISSIONS).map(([key, def]) => ({
    id: key,
    label: def.label,
    roles: [...def.defaultRoles],
  }));
}

// Resolve the override record for a given user, if any.
function findOverride(overrides, userId) {
  if (!overrides || !userId) return null;
  return overrides.find((o) => o.userId === userId) || null;
}

// Check if a user can perform a permission, given the live matrix + optional overrides.
// overrides: [{ userId, grants: [key], revokes: [key] }]
// Precedence: explicit revoke > explicit grant > role default.
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
  const record = permissions?.find((p) => p.id === permKey);
  // Fall back to the schema's defaultRoles when a key isn't yet in the live
  // permissions list. This lets newly-added permission keys take effect on
  // existing localStorage state without forcing a version bump + migration —
  // user customizations in state still take precedence when the record exists.
  const roles = record ? record.roles : (PERMISSIONS[permKey]?.defaultRoles || []);
  return roles.includes(user.role);
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
  if (!user || !user.role || !ROLES.includes(role)) return false;
  if (user.role === 'owner') return true;
  if (role === 'owner') return false;
  return Object.keys(PERMISSIONS).every((key) => ALWAYS_GRANTED.has(key)
    || !can({ id: null, role }, key, permissions, null)
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

// Resolve the effective set of permission keys for a user.
// Useful for settings UIs that need to show role-default vs. custom.
export function effectivePermissions(user, permissions, overrides) {
  if (!user || !user.role || !permissions) return new Set();
  const ov = findOverride(overrides, user.id);
  const out = new Set();
  permissions.forEach((p) => {
    if (p.roles.includes(user.role)) out.add(p.id);
  });
  (ov?.grants || []).forEach((k) => out.add(k));
  (ov?.revokes || []).forEach((k) => out.delete(k));
  return out;
}
