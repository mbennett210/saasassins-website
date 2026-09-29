// What the owner's limits leave a member free to do on Settings → Team. The server
// holds these limits on both halves (the owner's rules of 2026-09-23): the login routes a
// live save calls first (api/_lib/teamAuthority.js, /api/settings/users/*) and every
// org_state save (api/_lib/orgStateGuard.js). A refused login step stops the save with a
// message; a refused org_state save makes store/sync.js DROP every pending action in it.
// So the Team pages offer only what the server accepts and say in visible text why the
// rest is off (touch devices show no tooltips; UI_RULES §118).
//
// The permission keys still gate each control (usePermission: staff.assignRoles,
// settings.team.edit, staff.editOverrides). These are the limits held by ROLE and
// identity on top of the keys, which no grant can lift (can() puts no key out of a
// grant's reach):
//   - only a Super Admin makes, re-roles, disables or removes a Super Admin, or edits a
//     Super Admin's per-user overrides;
//   - nobody changes their own role, a Super Admin neither (the login route refuses it:
//     the claim changes before the roster save, which then runs under the new role);
//   - nobody but a Super Admin edits their own overrides;
//   - a role is given only by someone who holds everything it carries (assignableRoles).
// Beyond their own role a Super Admin is not limited here, because the server doesn't
// limit them. scripts/test-team-limits.mjs runs every case against the server guard and
// the login routes' rules themselves.
import { ROLES, canGiveRole, canEndAccess } from './roles.js';

export const isSuperAdmin = (user) => user?.role === 'owner';

// The roles `actor` may give a member (invite them at, or change them to): lib/roles
// canGiveRole, the function the server runs on both halves, on the matrix + overrides the
// viewer has. All four for a Super Admin; for anyone else only a role whose every
// permission they hold themselves (with the default matrix an Admin gives Admin or Crew, a
// Manager Admin, Manager or Crew), and never Super Admin. AddUserModal and TeamDetail.
export function assignableRoles(actor, permissions, overrides) {
  return ROLES.filter((r) => canGiveRole(actor, r, permissions, overrides));
}

// Why `actor` can't do `action` to team member `target`: 'self' | 'super-admin' | 'admin-status'
// | 'admin-remove' | 'admin-role', or null when the limits allow it (the permission key is
// checked separately).
//   'role'      the access level (TeamDetail › Profile › Role)
//   'overrides' per-user permission overrides (TeamDetail › Access)
//   'status'    Active / Invited / Disabled (TeamDetail › Profile › Status)
//   'revoke'    revoking an invite, which sets the member's status (Team list)
//   'remove'    removing the member (TeamDetail › Remove)
// Your own status isn't limited (the server allows it; the login route alone refuses a
// Super Admin disabling their own login when no other Super Admin can sign in, with a
// message, before anything is saved). Removing yourself is memberDeleteBlock's 'self'
// (lib/deleteCascade.js), for everyone.
export function teamLimit(actor, target, action) {
  const self = !!actor?.id && actor.id === target?.id;
  if (self && action === 'role') return 'self';
  if (isSuperAdmin(actor)) return null;
  if (self && action === 'overrides') return 'self';
  if (isSuperAdmin(target)) return 'super-admin';
  // Ending OR REDUCING an ADMIN's access takes admin+ BY ROLE (lib/roles canEndAccess): a
  // manager or crew is not offered Status / Revoke (a no-access status ends server access,
  // authz.js ROSTER STATUS; owner's call 2026-09-23), Remove (owner's call 2026-09-24, CS-329),
  // NOR a Role change (demoting an Admin reduces their access; owner's call 2026-09-25, CS-355).
  // A self role change already returned 'self' above, and promoting TO Admin passes (the target's
  // CURRENT role decides), so this only blocks a manager/crew changing an existing Admin's role.
  const targetIsAdmin = target?.role === 'admin';
  if (action === 'role' && !canEndAccess(actor?.role, targetIsAdmin)) return 'admin-role';
  if ((action === 'status' || action === 'revoke') && !canEndAccess(actor?.role, targetIsAdmin)) return 'admin-status';
  if (action === 'remove' && !canEndAccess(actor?.role, targetIsAdmin)) return 'admin-remove';
  return null;
}

const REASONS = {
  role: {
    self: "You can't change your own access level. Ask a Super Admin.",
    'super-admin': "Only a Super Admin can change a Super Admin's access level.",
    'admin-role': "Only an Admin or Super Admin can change an Admin's access level.",
  },
  overrides: {
    self: "You can't change your own permission overrides. Ask a Super Admin.",
    'super-admin': "Only a Super Admin can change a Super Admin's permission overrides.",
  },
  status: {
    'super-admin': "Only a Super Admin can change a Super Admin's status.",
    'admin-status': "Only an Admin or Super Admin can change an Admin's status.",
  },
  revoke: {
    'super-admin': 'Only a Super Admin can revoke this invite.',
    'admin-status': "Only an Admin or Super Admin can revoke an Admin's invite.",
  },
  remove: {
    'super-admin': 'Only a Super Admin can remove a Super Admin.',
    'admin-remove': 'Only an Admin or Super Admin can remove an Admin.',
  },
};

// The sentence a blocked control shows under it, or null when nothing is blocked.
export function teamLimitReason(action, code) {
  return (code && REASONS[action]?.[code]) || null;
}
