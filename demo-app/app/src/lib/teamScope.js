// The Operations Manager's TEAM (S131, plan 2026-10-14 §0; Matt and Daniel, 2026-10-13/14).
//
// An Operations Manager (OM) is NOT a new role: it is the Manager role at the "operations" LEVEL,
// so the login claim, RLS and every `role === 'manager'` behaviour stay `manager` (Daniel's answer
// 3: "an OM acts like their AMs across the whole team"). Since CS-858 (2026-10-16) their PERMISSIONS
// come from a column of their own in Settings → Roles (lib/roles permissionRoleOf), which starts
// equal to the Account Managers'. Two additive, default-safe fields on a member's row carry it:
//   users[].managerLevel  'account' | 'operations' — missing reads 'account'; it only means
//                         something for role === 'manager'
//   users[].opsManagerId  on an ACCOUNT manager: the active OM they report to (never themselves)
// An OM's scope is "my team": their own buildings plus every building whose supervisor
// (`client.supervisorId`) is one of their ACTIVE account managers. An account manager's scope is
// their own buildings, exactly as before.
//
// ONE module decides it for the app AND the server (api/time, api/qc, api/client-messages, the
// P&L, the activity log, orgStateGuard), so a screen and a route can never disagree about who is
// on whose team. PURE and node-safe: no imports, no store, no browser.
//
// 🔴 WHO decides the LEVEL. Changing `managerLevel` / `opsManagerId` is owner / admin holding
// `ops.edit` (orgStateGuard; the same rule as assigning a building's manager), and an OM's
// authority over a building follows the COMMITTED roster. A server caller's ROLE always comes from
// the login's claim (pass `{ id, role }` from it); only the level is read off the roster here.
//
// The contract other builders rely on (exact names): isOpsManager, teamMemberIds,
// teamClientIds, opsManagerOf, teamLeadFor (whose team a `team` filter means).

export const MANAGER_LEVELS = Object.freeze(['account', 'operations']);
export const ACCOUNT_LEVEL = 'account';
export const OPERATIONS_LEVEL = 'operations';
// The value every manager filter reads as "the whole team" (`?mgr=team`, `supervisorId=team`,
// `managerId=team`). A server resolves it from the CALLER's claim, never from the request.
export const TEAM = 'team';

// The statuses a member keeps access in — the server's ACCESS_STATUSES allowlist (authz.js
// ROSTER STATUS): 'active' and 'invited'; a row with no status is a legacy row, decided as before.
// Anything else ('disabled', 'inactive') is off the team.
const ACCESS = new Set(['active', 'invited']);
export function hasTeamAccess(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.status == null) return true;
  return ACCESS.has(String(user.status).trim().toLowerCase());
}

// 'operations' for a manager at that level, else 'account' (the default, and every other role).
export function managerLevelOf(user) {
  return user && user.role === 'manager' && user.managerLevel === OPERATIONS_LEVEL ? OPERATIONS_LEVEL : ACCOUNT_LEVEL;
}
export function isOpsManager(user) {
  return managerLevelOf(user) === OPERATIONS_LEVEL;
}
// An ACCOUNT manager: the Manager role at the account level (the only row a pointer may sit on).
export function isAccountManager(user) {
  return !!user && user.role === 'manager' && !isOpsManager(user);
}
// An OM who still has access — the only kind an account manager may report to.
export function isActiveOpsManager(user) {
  return isOpsManager(user) && hasTeamAccess(user);
}
// The id a row's pointer names, or null ('' and a non-string read as no pointer).
export function opsManagerIdOf(user) {
  const v = user && user.opsManagerId;
  return typeof v === 'string' && v ? v : null;
}

const rows = (users) => (Array.isArray(users) ? users.filter((u) => u && typeof u === 'object' && u.id) : []);
const byIdOf = (users) => new Map(rows(users).map((u) => [u.id, u]));

// The active OM `userId` (an account manager) reports to — their row, or null: no pointer, a
// pointer at someone who is not an active OM, a row that is not an account manager, or a pointer
// at themselves.
export function opsManagerOf(users, userId) {
  const byId = byIdOf(users);
  const me = byId.get(userId);
  if (!me || !isAccountManager(me)) return null;
  const omId = opsManagerIdOf(me);
  if (!omId || omId === me.id) return null;
  const om = byId.get(omId);
  return om && isActiveOpsManager(om) ? om : null;
}

// THE TEAM: `opsManagerId` first, then their ACTIVE account managers in roster order. Someone who
// is not an active OM is a team of one (just themselves), so a caller can ask this of anyone.
export function teamMemberIds(users, opsManagerId) {
  if (!opsManagerId) return [];
  const list = rows(users);
  const lead = list.find((u) => u.id === opsManagerId);
  if (!lead || !isActiveOpsManager(lead)) return [opsManagerId];
  const out = [opsManagerId];
  for (const u of list) {
    if (u.id === opsManagerId || !isAccountManager(u) || !hasTeamAccess(u)) continue;
    if (opsManagerIdOf(u) === opsManagerId && !out.includes(u.id)) out.push(u.id);
  }
  return out;
}
// The account managers on an OM's team (their rows), by name — the OM's Home section, the
// assignment card, the pickers.
export function teamAccountManagers(users, opsManagerId) {
  const byId = byIdOf(users);
  return teamMemberIds(users, opsManagerId).filter((id) => id !== opsManagerId).map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
}
// THE TEAM'S BUILDINGS (a Set of customer ids): every customer whose supervisor is on
// `userId`'s team. For someone who is not an OM, only their own buildings. Unknown or no id:
// empty — never "everything".
export function teamClientIds(users, clients, userId) {
  const members = new Set(teamMemberIds(users, userId));
  const out = new Set();
  if (!members.size) return out;
  for (const c of Array.isArray(clients) ? clients : []) {
    if (c && c.id && c.supervisorId && members.has(c.supervisorId)) out.add(c.id);
  }
  return out;
}

// 🔴 WHOSE TEAM a `team` filter means (`?mgr=team`, `supervisorId=team`, `managerId=team`) — ONE rule
// for every route, its demo stub and the pages (S131 Wave 2: the owner's Operations view's tiles):
//   · a MANAGER's own (an OM's team; an account manager's own buildings, a team of one) — whatever
//     `om` says: a manager never widens their scope through the request;
//   · an UNSCOPED caller (the owner or an admin, who read every building anyway) may name WHOSE with
//     `om`, the id of an ACTIVE Operations Manager — the Operations view's pick, carried into each
//     page by the Home's tiles;
//   · anything else, or an `om` that is no active OM: the caller's own (`selfId`).
// `role` is the CLAIM's on a server. → the lead's id, for teamMemberIds / teamClientIds.
export function teamLeadFor({ role = null, selfId = null, users = [], om = null } = {}) {
  if ((role === 'owner' || role === 'admin') && typeof om === 'string' && om) {
    const lead = rows(users).find((u) => u.id === om);
    if (lead && isActiveOpsManager(lead)) return lead.id;
  }
  return selfId || null;
}

// Whether `user` (from the CLAIM role) is an OM on the committed roster: a server caller passes
// `{ id, role }` from the login and the roster it read; the level is the roster's, the role the
// claim's — a claim that is not `manager` is never an OM, whatever its row says.
export function isOpsManagerIn(users, user) {
  if (!user || user.role !== 'manager' || !user.id) return false;
  const row = rows(users).find((u) => u.id === user.id);
  return !!row && isActiveOpsManager({ ...row, role: 'manager' });
}

// The LEVEL a server caller (`{ id, role }`, the role the CLAIM's) has on the committed roster —
// the level their permission COLUMN follows (lib/roles permissionRoleOf, CS-858). Only a manager has
// one. The rows are the ones carrying their id, as the app reads its current user's row (the claim's
// role over the row's): no row → 'account' (the default, as the app reads a member with no level);
// every row at one level → that level; rows that DISAGREE → null, which a permission check reads as
// unknown and fails closed on (lib/roles levelVariants). Status is not asked: a member without
// access holds no authority at all (authz.js ROSTER STATUS).
export function managerLevelIn(users, user) {
  if (!user || user.role !== 'manager' || !user.id) return ACCOUNT_LEVEL;
  const mine = rows(users).filter((u) => u.id === user.id);
  if (!mine.length) return ACCOUNT_LEVEL;
  const levels = new Set(mine.map((u) => managerLevelOf({ ...u, role: 'manager' })));
  return levels.size === 1 ? [...levels][0] : null;
}

// Who sees the TEAM pages (the Accounts page, the Operations view): the owner, an admin, and an
// Operations Manager. An account manager reads their own buildings on the pages they already have.
export function seesTeamPages(user) {
  return !!user && (user.role === 'owner' || user.role === 'admin' || isOpsManager(user));
}

// Does a building's supervisor match a manager filter? '' / null = every building; a string = that
// one manager; an array or a Set = any of them (a team).
export function managerIdsMatch(managerIds, supervisorId) {
  if (managerIds == null || managerIds === '') return true;
  if (typeof managerIds === 'string') return supervisorId === managerIds;
  const set = managerIds instanceof Set ? managerIds : new Set(Array.isArray(managerIds) ? managerIds : []);
  return !!supervisorId && set.has(supervisorId);
}

// Is `pointer` a valid `opsManagerId` for `row` on `users`? On an ACCOUNT manager, at an ACTIVE OM,
// never themselves. (null always is: no team.) The reducer drops an invalid one at the write point;
// orgStateGuard refuses it for every caller.
export function validOpsPointer(users, row, pointer) {
  if (pointer == null || pointer === '') return true;
  if (!row || !isAccountManager(row) || pointer === row.id) return false;
  const om = byIdOf(users).get(pointer);
  return !!om && isActiveOpsManager(om);
}

// THE CASCADE a change to one member's row carries (UPDATE_USER): `users` is the roster AFTER the
// change. When `before` was an OM and `after` is not (the level went to account, or the role left
// manager), every account manager pointing at them leaves the team (pointer → null). When `after`
// is an OM, or no longer an account manager at all, their OWN pointer clears (an OM reports to no
// OM; a crew row carries no team), and a role away from manager drops the level too. Returns a new
// array only when something changed.
export function teamCascade(users, before, after) {
  if (!after || !after.id) return users;
  let changed = false;
  const lostOm = isOpsManager(before) && !isOpsManager(after);
  const next = (Array.isArray(users) ? users : []).map((u) => {
    if (!u || typeof u !== 'object') return u;
    if (u.id === after.id) {
      let row = u;
      if (opsManagerIdOf(row) && !isAccountManager(row)) { row = { ...row, opsManagerId: null }; }
      if (row.role !== 'manager' && row.managerLevel != null) {
        const { managerLevel: _drop, ...rest } = row;
        row = rest;
      }
      if (row !== u) changed = true;
      return row;
    }
    if (lostOm && opsManagerIdOf(u) === after.id) { changed = true; return { ...u, opsManagerId: null }; }
    return u;
  });
  return changed ? next : users;
}
