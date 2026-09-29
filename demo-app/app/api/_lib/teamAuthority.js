// Who may do what to a team member: the rules the two halves of Settings → Team share.
//   the ROSTER half: the org_state guard (orgStateGuard.js protectedFieldViolations)
//   the LOGIN half:  /api/settings/users/* (settings/[...path].js): the auth account,
//                    its JWT claims (role, u_* id) and its ban
// PURE (no IO), so the guard, the route and the tests run the same functions.
//
// In live mode every invite, role change, disable and removal hits the login route FIRST
// and saves the roster after. The halves must agree: a login route stricter than the guard
// only refuses sooner, but a looser one changes the login and then has the roster save
// refused, e.g. a claim that says Manager on a roster row that says Crew.
//
// The rules (owner's decisions, 2026-09-23). Each action passes for the role list that
// always could (never tightened), OR for whoever holds the key the app gates it on, read
// from the COMMITTED matrix + per-user overrides, within limits held by ROLE and identity
// (can() puts no key out of a grant's reach, so the limits can't be keys):
//   invite        owner+admin | settings.team.edit   only a Super Admin creates one; a role
//                                                    only if you hold all it carries; never
//                                                    yourself; a Super Admin's login untouched
//   role change   owner       | staff.assignRoles    never your own (a Super Admin's neither);
//                                                    never to or from Super Admin; changing an
//                                                    ADMIN's is admin+ by role (CS-355); a role
//                                                    only if you hold all it carries; never
//                                                    re-links a login to another member
//   disable       owner       | settings.team.edit   never a Super Admin's
//   remove        owner       | settings.team.edit   never yourself (but a Super Admin who
//                                                    leaves another); never a Super Admin;
//                                                    never while they may be owed pay (EVERY
//                                                    role, as in the app)
//   reset link    owner+admin | staff.resetPassword  never a Super Admin's password
//   orphan list   owner+admin | settings.team.edit
// "A role only if you hold all it carries" is lib/roles canGiveRole: it is the GIVER who
// must hold everything the role carries in the matrix; a Super Admin may give any role.
// And a Super Admin never leaves the org without one: no disabling or removing their own
// login unless another Super Admin can still sign in, and no roster left without one.
import { can, canGiveRole, canEndAccess, ROLE_LABELS } from '../../src/lib/roles.js';
import { owedPayBlock, payCutoffKey } from '../../src/lib/deleteCascade.js';
import { matrixForCan, overridesForCan } from './permissionSlices.js';

// What the caller may do through the matrix: holds(key) and mayGive(role), both from the
// COMMITTED state (a save must not grant itself the key it needs). `role` and `selfId` are
// the JWT claim's. A null role holds nothing outside ALWAYS_GRANTED and gives no role. The
// slices are read the way jobsGuard reads them (permissionSlices.js): a malformed stored
// row reads as a missing one, so it can never throw inside can() and 500 every save.
export function matrixAuthority(committed, role, selfId) {
  const permissions = matrixForCan(committed?.permissions);
  const overrides = overridesForCan(committed?.userPermissionOverrides);
  const me = { id: selfId ?? null, role: role ?? null };
  return {
    holds: (key) => can(me, key, permissions, overrides),
    mayGive: (r) => canGiveRole(me, r, permissions, overrides),
  };
}

const rows = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

// The pay half of "can this member be removed?", on the COMMITTED state, for the server:
// deleteCascade.owedPayBlock, the rule the Team page and DELETE_USER run. `facts` comes from
// memberRemoval.removalPayFacts: { payState: { payrollLines, reimbursements, opsSettings },
// recentHours: Set of member ids with a punch since the cutoff, now }. The org zone is
// company.timezone (the server has no ambient one). Returns 'unpaid-salary' |
// 'unsettled-pay' | 'unpaid-hours' | null, or 'unchecked' when the facts are missing or
// unreadable: a pay check that can't run refuses, it never waves the removal through.
export function owedPayFor(committed, facts, userId) {
  if (!facts || !facts.payState || !(facts.recentHours instanceof Set)) return 'unchecked';
  try {
    const state = {
      users: rows(committed?.users),
      company: committed?.company || null,
      payrollLines: rows(facts.payState.payrollLines),
      reimbursements: rows(facts.payState.reimbursements),
      opsSettings: facts.payState.opsSettings && typeof facts.payState.opsSettings === 'object' ? facts.payState.opsSettings : null,
    };
    const tz = typeof state.company?.timezone === 'string' && state.company.timezone ? state.company.timezone : undefined;
    const cutoff = payCutoffKey(state, facts.now || new Date(), tz);
    return owedPayBlock(state, userId, cutoff, { recentHours: facts.recentHours.has(userId), tz });
  } catch {
    return 'unchecked';
  }
}

// How each owed-pay code reads to the person removing them. The way out for a leaver is
// Disabled: it ends their access now and keeps them on the pay run.
const NEXT_STEP = 'Set them to Disabled to end their access now (they stay on the pay run), and remove them after their last pay goes out.';
export const OWED_PAY_WORDS = {
  'unpaid-salary': `They're on salary, so they may still be owed pay for this or the last pay period. ${NEXT_STEP}`,
  'unsettled-pay': `They may still be owed pay: a pay line in this or the last pay period, or a reimbursement waiting for a decision in HR. ${NEXT_STEP}`,
  'unpaid-hours': `They have clocked hours in this or the last pay period that may not be paid yet. ${NEXT_STEP}`,
  unchecked: "Their pay and recent hours couldn't be checked, so they weren't removed. Try again.",
};

// The login routes' actions: the role list each always accepted (never tightened), the
// key the app gates it on, and how a refusal reads.
export const LOGIN_ACTIONS = {
  invite: { roles: ['owner', 'admin'], key: 'settings.team.edit', denied: 'invite team members' },
  role: { roles: ['owner'], key: 'staff.assignRoles', denied: 'change access levels' },
  status: { roles: ['owner'], key: 'settings.team.edit', denied: 'disable or re-enable logins' },
  remove: { roles: ['owner'], key: 'settings.team.edit', denied: 'remove logins' },
  reset: { roles: ['owner', 'admin'], key: 'staff.resetPassword', denied: 'send password-reset links' },
  orphans: { roles: ['owner', 'admin'], key: 'settings.team.edit', denied: 'see logins with no team record' },
};

const emailKey = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const refuse = (status, error, code) => ({ status, error, code });
const giveWords = (role) => `You can't give someone the ${ROLE_LABELS[role] || role} access level: it includes permissions you don't have.`;
const lastOwnerWords = (what) => `You're the only Super Admin who can sign in, so you can't ${what}. Make another member a Super Admin first.`;

/**
 * Whether the caller may take `action` on a team member's LOGIN.
 *
 * @param action  a LOGIN_ACTIONS key
 * @param f.caller    { role, orgUserId, email, claimIdentity }: role from the JWT claim (the
 *                    route refuses a blob-derived role before this); claimIdentity = the u_*
 *                    id is a well-formed claim too. The matrix path needs it: overrides and
 *                    "yourself" key on that id, and the blob's email → id map is writable.
 * @param f.authority { holds, mayGive } from matrixAuthority(committed, role, orgUserId)
 * @param f.target    { email, claimRole, claimOrgUserId, authoritativeRole, rows }: the
 *                    member's login claims, and every roster row with their email or their
 *                    claimed id ({ id, role, email }). authoritativeRole (reset) = the claim, else
 *                    the roster's (users.getAuthoritativeRoleByEmail).
 * @param f.newRole          invite / role: the role asked for (validated by the route)
 * @param f.orgUserId        role: the u_* id asked to be stamped, or null
 * @param f.disabled         status: false re-enables, anything else disables
 * @param f.otherOwnerLogin  status / remove by a Super Admin: another login with a Super
 *                           Admin claim that can still sign in (not banned)
 * @param f.otherOwnerRow    role / remove by a Super Admin: a Super Admin roster row that
 *                           is not the target's (the guard refuses a roster left without one)
 * @param f.owedPay          remove: owedPayFor's code for the member, or null
 * @returns null when allowed, else { status, error, code }
 */
export function loginRefusal(action, f = {}) {
  const rule = LOGIN_ACTIONS[action];
  if (!rule) return refuse(400, 'Unknown action.', 'unknown');
  const caller = f.caller || {};
  const authority = f.authority || {};
  const target = f.target || {};
  const isOwner = caller.role === 'owner';
  const byRole = rule.roles.includes(caller.role);
  const byMatrix = caller.claimIdentity === true && typeof authority.holds === 'function' && authority.holds(rule.key) === true;
  if (!byRole && !byMatrix) return refuse(403, `Your access level doesn't allow you to ${rule.denied}.`, 'not-allowed');
  if (action === 'orphans') return null;

  const members = rows(target.rows);
  const me = typeof caller.orgUserId === 'string' && caller.orgUserId ? caller.orgUserId : null;
  const self = (!!emailKey(caller.email) && emailKey(caller.email) === emailKey(target.email))
    || (!!me && (target.claimOrgUserId === me || members.some((r) => r.id === me) || f.orgUserId === me));
  const targetIsOwner = target.claimRole === 'owner' || members.some((r) => r.role === 'owner');
  // Ending OR REDUCING an ADMIN's access (disable / remove / role change) is admin+ by ROLE
  // (lib/roles canEndAccess, CS-329 + CS-355): judged the way targetIsOwner is — the target's
  // CURRENT role, from the claim role or any roster row.
  const targetIsAdmin = target.claimRole === 'admin' || members.some((r) => r.role === 'admin');
  const mayGive = (r) => typeof authority.mayGive === 'function' && authority.mayGive(r) === true;

  if (action === 'invite') {
    if (f.newRole === 'owner' && !isOwner) return refuse(403, 'Only a Super Admin can create a Super Admin.', 'owner-only');
    if (!isOwner && !mayGive(f.newRole)) return refuse(403, giveWords(f.newRole), 'beyond-reach');
    if (self) return refuse(403, "You can't invite yourself.", 'self');
    // An existing login for the email is adopted and re-stamped with the chosen role.
    if (target.claimRole === 'owner' && !isOwner) return refuse(403, "Only a Super Admin can change a Super Admin's login.", 'owner-target');
    // Only a login with NO team record is adopted. One whose email is on the roster, or whose
    // claim names a member, is a duplicate, for every caller (the guard's rule for a new
    // member, and what the adoption refuses). Decided here, on the roster the route read
    // strictly: the adoption's own read used to take a failed read for "no roster row" and
    // re-stamp a member's login (2026-09-23).
    if (members.length) {
      const byEmail = members.some((r) => emailKey(r.email) === emailKey(target.email));
      return refuse(409, byEmail ? 'That email is already on the team.' : 'That login is already linked to a team member.', 'on-team');
    }
    return null;
  }

  if (action === 'role') {
    // Nobody changes their own role, a Super Admin included: the claim changes first, so
    // the roster save that follows runs under the NEW role, and the guard refuses a role
    // change on your own row to anyone but a Super Admin. A Super Admin who stepped down
    // was left claiming Admin on a roster row still saying Super Admin. Another Super
    // Admin changes theirs. (Re-stamping the role you already hold is a sync, not a change.)
    if (self && f.newRole != null && f.newRole !== caller.role) {
      return refuse(403, "You can't change your own access level. Ask another Super Admin to do it.", 'self');
    }
    if (isOwner) {
      // The roster keeps a Super Admin row (the guard refuses a save leaving none).
      if (f.newRole != null && f.newRole !== 'owner' && members.some((r) => r.role === 'owner') && f.otherOwnerRow !== true) {
        return refuse(403, "The last Super Admin can't be given another access level. Make another member a Super Admin first.", 'last-owner');
      }
      return null;
    }
    if (f.newRole == null) return refuse(400, 'Choose an access level.', 'no-role');
    if (!members.length) return refuse(403, "That email isn't on the team.", 'not-member');
    if (self) return refuse(403, "You can't change your own access level.", 'self');
    if (targetIsOwner) return refuse(403, "Only a Super Admin can change a Super Admin's access level.", 'owner-target');
    // Changing an ADMIN's access level reduces their access (and a demoted Admin could then be
    // disabled or removed), so it is admin+ by ROLE (lib/roles canEndAccess, CS-355, owner's
    // call 2026-09-25): a manager or crew holding staff.assignRoles is refused. Judged on the
    // target's CURRENT role (targetIsAdmin, above), like disable/remove; promoting TO Admin is
    // not gated. Returns here, before syncUserClaims re-stamps the login's role claim.
    if (!canEndAccess(caller.role, targetIsAdmin)) return refuse(403, "Only an Admin or Super Admin can change an Admin's access level.", 'admin-target');
    if (f.newRole === 'owner') return refuse(403, 'Only a Super Admin can make someone a Super Admin.', 'owner-only');
    if (!mayGive(f.newRole)) return refuse(403, giveWords(f.newRole), 'beyond-reach');
    if (f.orgUserId != null) {
      // Re-stamping the id the login already carries (or, before it carries one, its
      // member's only roster id) is a sync; anything else re-links the login to someone else.
      const bound = target.claimOrgUserId || (members.length === 1 ? members[0].id : null);
      if (f.orgUserId !== bound) return refuse(403, 'Only a Super Admin can link a login to a different team member.', 'rebind');
    }
    return null;
  }

  if (action === 'status') {
    if (isOwner) {
      if (self && f.disabled !== false && f.otherOwnerLogin !== true) return refuse(403, lastOwnerWords('disable your own login'), 'last-owner');
      return null;
    }
    if (!members.length) return refuse(403, "That email isn't on the team.", 'not-member');
    if (targetIsOwner) return refuse(403, 'Only a Super Admin can disable or re-enable a Super Admin.', 'owner-target');
    // A no-access status ends server access, so disabling an ADMIN takes admin+ by ROLE (CS-329).
    if (!canEndAccess(caller.role, targetIsAdmin)) return refuse(403, 'Only an Admin or Super Admin can disable or re-enable an Admin.', 'admin-target');
    return null;
  }

  if (action === 'remove') {
    if (isOwner) {
      if (members.some((r) => r.role === 'owner') && f.otherOwnerRow !== true) {
        return refuse(403, "The last Super Admin can't be removed. Make another member a Super Admin first.", 'last-owner');
      }
      if (self && f.otherOwnerLogin !== true) return refuse(403, lastOwnerWords('remove your own login'), 'last-owner');
    } else {
      if (!members.length) return refuse(403, "That email isn't on the team.", 'not-member');
      if (self) return refuse(403, "You can't remove your own account. Ask another admin to do it.", 'self');
      if (targetIsOwner) return refuse(403, 'Only a Super Admin can remove a Super Admin.', 'owner-target');
      // Removing ends access, so removing an ADMIN takes admin+ by ROLE too (CS-329).
      if (!canEndAccess(caller.role, targetIsAdmin)) return refuse(403, 'Only an Admin or Super Admin can remove an Admin.', 'admin-target');
    }
    if (f.owedPay) return refuse(409, OWED_PAY_WORDS[f.owedPay] || OWED_PAY_WORDS.unchecked, f.owedPay);
    return null;
  }

  // reset
  if (!isOwner && target.authoritativeRole === 'owner') return refuse(403, "Only a Super Admin can reset a Super Admin's password.", 'owner-target');
  return null;
}
