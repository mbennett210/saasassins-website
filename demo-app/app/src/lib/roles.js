// Roles + permissions.
// The matrix is the *default*; the live assignment lives in the store (state.permissions)
// and can be edited in Settings → Roles (Super Admin only).
// Per-user overrides live in state.userPermissionOverrides and are applied in can().
//
// Naming: schema is `owner / admin / crew`; UI labels are `Super Admin / Admin / Crew`
// via ROLE_LABELS. Decision: keep the schema keys — they're shorter, already wired
// through the codebase, and the UI display is fully owned by ROLE_LABELS / ROLE_DESCRIPTIONS.
// Renaming the schema would touch every reducer/selector/permission check for zero user-visible
// benefit. If a client wants different labels (e.g. "Manager" instead of "Admin"), update
// ROLE_LABELS only.

export const ROLES = ['owner', 'admin', 'crew'];

export const ROLE_LABELS = {
  owner: 'Super Admin',
  admin: 'Admin',
  crew: 'Crew',
};

export const ROLE_DESCRIPTIONS = {
  owner: 'Full access — can assign roles, edit permissions, and override access per user. The top tier.',
  admin: 'Manages day-to-day ops: clients, jobs, messages, team. Cannot see financials or assign roles.',
  crew:  'Sees their own jobs and assigned clients. Can update job status and add notes.',
};

// key → { label, description, defaultRoles }
export const PERMISSIONS = {
  'dashboard.view':          { label: 'View Dashboard',           defaultRoles: ['owner', 'admin'] },
  'schedule.view':           { label: 'View Schedule',            defaultRoles: ['owner', 'admin', 'crew'] },
  'schedule.edit':           { label: 'Create / edit jobs',       defaultRoles: ['owner', 'admin'] },
  'schedule.statusTransition': { label: 'Change job status',      defaultRoles: ['owner', 'admin', 'crew'] },
  'clients.view':            { label: 'View Clients',             defaultRoles: ['owner', 'admin', 'crew'] },
  'clients.edit':            { label: 'Create / edit clients',    defaultRoles: ['owner', 'admin'] },
  'clients.delete':          { label: 'Delete clients',           defaultRoles: ['owner', 'admin'] },
  'sites.edit':              { label: 'Manage client sites',      defaultRoles: ['owner', 'admin'] },
  'sites.attachments':       { label: 'Upload site attachments',  defaultRoles: ['owner', 'admin', 'crew'] },
  // ---------- Contacts (CRM) ----------
  'contacts.view':           { label: 'View Contacts',                    defaultRoles: ['owner', 'admin', 'crew'] },
  'contacts.edit':           { label: 'Create / edit contacts',           defaultRoles: ['owner', 'admin'] },
  'contacts.delete':         { label: 'Delete contacts',                  defaultRoles: ['owner', 'admin'] },
  'tags.manage':             { label: 'Create / edit tags',               defaultRoles: ['owner', 'admin'] },
  'pipeline.view':           { label: 'View sales pipeline',              defaultRoles: ['owner', 'admin'] },
  'pipeline.edit':           { label: 'Move deals in pipeline',           defaultRoles: ['owner', 'admin'] },
  // ---------- Invoices / Reminders / Messaging ----------
  // Default policy: Admin should not see financials. Owner-only by default;
  // per-user grants are issued via overrides if/when a non-owner needs access.
  'invoices.view':           { label: 'View Invoices',            defaultRoles: ['owner'] },
  'invoices.edit':           { label: 'Create / edit invoices',   defaultRoles: ['owner'] },
  'invoices.recordPayment':  { label: 'Record payments',          defaultRoles: ['owner'] },
  'reminders.view':          { label: 'View Reminders',           defaultRoles: ['owner'] },
  'reminders.edit':          { label: 'Edit reminder templates',  defaultRoles: ['owner'] },
  'messaging.use':                  { label: 'Use Messaging',                 defaultRoles: ['owner', 'admin', 'crew'] },
  'messaging.startConversation':    { label: 'Start new conversations',       defaultRoles: ['owner', 'admin'] },
  'messaging.startInternalThread':  { label: 'Start internal team threads',   defaultRoles: ['owner', 'admin'] },
  'messaging.internalComment':      { label: 'Post internal comments',        defaultRoles: ['owner', 'admin', 'crew'] },
  'messaging.manageSnippets':       { label: 'Manage message snippets',       defaultRoles: ['owner', 'admin'] },
  'messaging.bulkActions':          { label: 'Run bulk conversation actions', defaultRoles: ['owner', 'admin', 'crew'] },
  // ---------- Marketing (cold-email sequences — v38) ----------
  // App-owned email sequences with company-shared rotation inboxes. Sends are
  // app-owned (not user-owned like Messaging), so Crew is off by default;
  // specific users get access via per-user overrides if needed.
  'marketing.view':          { label: 'View Marketing',              defaultRoles: ['owner', 'admin'] },
  'marketing.manage':        { label: 'Manage marketing sequences',  defaultRoles: ['owner', 'admin'] },
  'marketing.connectInbox':  { label: 'Connect marketing inboxes',   defaultRoles: ['owner', 'admin'] },
  // ---------- Operations: Complaints + Reviews ----------
  'complaints.view':         { label: 'View complaints',             defaultRoles: ['owner', 'admin', 'crew'] },
  'complaints.manage':       { label: 'Log / update complaints',     defaultRoles: ['owner', 'admin', 'crew'] },
  'reviews.view':            { label: 'View reviews / reputation',   defaultRoles: ['owner', 'admin'] },
  // ---------- Settings ----------
  'settings.company':        { label: 'Edit company settings',    defaultRoles: ['owner', 'admin'] },
  'settings.services':       { label: 'Edit services / frequencies', defaultRoles: ['owner'] },
  'settings.team.view':      { label: 'View team',                defaultRoles: ['owner', 'admin'] },
  'settings.team.edit':      { label: 'Invite / edit team',       defaultRoles: ['owner', 'admin'] },
  'settings.roles.edit':     { label: 'Edit role permissions',    defaultRoles: ['owner'] },
  'settings.account':        { label: 'Edit own account',         defaultRoles: ['owner', 'admin', 'crew'] },
  // ---------- Integrations ----------
  'integrations.view':       { label: 'View integrations',           defaultRoles: ['owner'] },
  'integrations.manage':     { label: 'Connect / manage integrations', defaultRoles: ['owner'] },
  // ---------- Super Admin gates ----------
  'staff.assignRoles':       { label: 'Assign roles to staff',       defaultRoles: ['owner'] },
  'staff.editOverrides':     { label: 'Grant / revoke per-user perms', defaultRoles: ['owner'] },
};

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
  if (!user || !user.role) return false;
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
