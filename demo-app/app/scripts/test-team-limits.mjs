// Team UI ↔ server: the Team pages offer ONLY what the server accepts, on both halves: the
// org_state guard and (S80) the login routes a live save calls first (HANDOFF S79, S80;
// UI_RULES §118).
//
// Since S77 `api/_lib/orgStateGuard.js` holds the owner's limits on every save: only a
// Super Admin makes, re-roles, disables or removes a Super Admin or edits their overrides;
// nobody else changes their own role or overrides; the company timezone is the Super
// Admin's alone. A refused save makes store/sync.js DROP every pending action in it, so a
// control the UI offers and the server refuses costs the user the whole batch. Before S79
// the UI gated these controls on permission keys only, and offered a manager all of them.
//
//   A  can() holds OWNER_ONLY keys (the timezone) to a Super Admin, whatever a grant says.
//   B  lib/teamLimits.js: every code it can return has visible wording.
//   C  THE DIFFERENTIAL. Every actor × target × {role, status, revoke, remove, overrides,
//      timezone} × key variant: a model of what each page offers (its route, tab, key and
//      Save gates, then the limits; D pins the pages to it), and the action the page
//      dispatches → the real reducer → the real server guard, plus (S80) the login step a
//      live save runs FIRST (role → /claims, status → /disable, remove → /delete) → the
//      login routes' own rules (api/_lib/teamAuthority.js loginRefusal) for logins whose
//      claims match their roster rows. What the UI offers must be
//      accepted (sound), and for anyone but a Super Admin what the server accepts must be
//      offered wherever they can reach the control (complete: the limits don't over-block).
//      Invites, the Roles matrix and profile / pay / HR edits are in D's ledger, not here.
//      Plus a STALE FORM: someone changes the member while the page is open.
//   D  the pages are wired to that model (source shape), and every file that writes what the
//      guard protects for Team admin is classified (a new, unclassified writer fails).
//
// WHAT THIS DOES NOT PROVE (adversarial review, S79; updated S80): the differential's
// committed state is also the tab's state, so it can't see (1) a tab that is behind the
// server when it saves (since S80 the org_state endpoint answers the CAS's 409 before any
// guard, and the replay is judged against the newer state), (2) a matrix edit used in the
// same debounce window, (3) a demoted Super Admin whose token still says owner, or (4) a
// login whose claims differ from its roster row. The login routes' two reads (another
// Super Admin login that can sign in; the pay facts for a removal) are modeled here, not
// run: test-team-logins.mjs drives the real routes for those.
//
// Offline. Run: node scripts/test-team-limits.mjs
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const R = await import('../src/lib/roles.js');
const { protectedFieldViolations } = await import('../api/_lib/orgStateGuard.js');
const { reducer, ACTIONS } = await import('../src/store/reducer.js');
const { INITIAL_STATE } = await import('../src/data/seed.js');
const DC = await import('../src/lib/deleteCascade.js');
const { memberDeleteBlock } = DC;
// New in S79: imported dynamically so a pre-fix run reports each failing check instead
// of dying on the import.
let TL = null;
try { TL = await import('../src/lib/teamLimits.js'); } catch { /* pre-fix tree */ }
ok('lib/teamLimits.js exists and exports teamLimit / teamLimitReason / assignableRoles / isSuperAdmin',
  !!TL && ['teamLimit', 'teamLimitReason', 'assignableRoles', 'isSuperAdmin'].every((k) => typeof TL[k] === 'function'));
// New in S80, imported the same way: the login routes' rules.
let TA = null;
try { TA = await import('../api/_lib/teamAuthority.js'); } catch { /* pre-S80 tree */ }
ok('api/_lib/teamAuthority.js exports loginRefusal / matrixAuthority / owedPayFor',
  !!TA && ['loginRefusal', 'matrixAuthority', 'owedPayFor'].every((k) => typeof TA[k] === 'function'));

const { ROLES, can } = R;
const OWNER_ONLY = R.OWNER_ONLY || new Set();
const TZ = 'settings.company.timezone';

// ── A. can() and OWNER_ONLY ──────────────────────────────────────────────────
{
  ok('OWNER_ONLY is exported and holds the timezone key', R.OWNER_ONLY instanceof Set && R.OWNER_ONLY.has(TZ));
  ok('every OWNER_ONLY key is a real permission', [...OWNER_ONLY].every((k) => k in R.PERMISSIONS));
  ok('OWNER_ONLY shares no key with ALWAYS_GRANTED or OWNER_CORE',
    [...OWNER_ONLY].every((k) => !R.ALWAYS_GRANTED.has(k) && !R.OWNER_CORE.has(k)));
  const matrix = R.seedPermissions();
  const everyone = matrix.map((p) => (p.id === TZ ? { ...p, roles: [...ROLES] } : p));
  for (const role of ROLES) {
    const u = { id: `u_${role}`, role };
    const grant = [{ userId: u.id, grants: [TZ], revokes: [] }];
    const want = role === 'owner';
    ok(`🔴 can(${role}, timezone) with the default matrix is ${want}`, can(u, TZ, matrix, []) === want);
    ok(`🔴 can(${role}, timezone) with a row naming every role is ${want}`, can(u, TZ, everyone, []) === want);
    ok(`🔴 can(${role}, timezone) with a per-user grant is ${want}`, can(u, TZ, matrix, grant) === want);
  }
  const owner = { id: 'u_o', role: 'owner' };
  ok('owner unchanged: a per-user revoke still takes the key away', can(owner, TZ, matrix, [{ userId: 'u_o', grants: [], revokes: [TZ] }]) === false);
  ok('owner unchanged: a matrix row without owner still takes it away',
    can(owner, TZ, matrix.map((p) => (p.id === TZ ? { ...p, roles: ['manager'] } : p)), []) === false);
  ok('a roleless user still holds nothing', can({ id: 'u_x', role: null }, TZ, everyone, []) === false);
  ok('other keys unaffected: a manager still holds staff.assignRoles by default', can({ id: 'm', role: 'manager' }, 'staff.assignRoles', matrix, []) === true);
}

// ── B. teamLimits: the codes and their wording ───────────────────────────────
const TEAM_ACTIONS = ['role', 'overrides', 'status', 'revoke', 'remove'];
if (TL) {
  const people = ROLES.flatMap((r) => [{ id: `a_${r}`, role: r }, { id: `b_${r}`, role: r }]).concat([{ id: 'n', role: null }, null]);
  let codes = 0;
  for (const actor of people) {
    for (const target of people.filter(Boolean)) {
      for (const action of TEAM_ACTIONS) {
        const code = TL.teamLimit(actor, target, action);
        if (!code) continue;
        codes += 1;
        const text = TL.teamLimitReason(action, code);
        ok(`${action}/${code} has visible wording`, typeof text === 'string' && text.trim().length > 12);
      }
    }
  }
  ok('the limits block something (sanity)', codes > 0);
  const superAdmin = { id: 'a_owner', role: 'owner' };
  ok('🔴 a Super Admin is limited only on their own role (the login route refuses it, S80)',
    people.filter(Boolean).every((t) => TEAM_ACTIONS.every((a) => TL.teamLimit(superAdmin, t, a) === (t.id === superAdmin.id && a === 'role' ? 'self' : null))));
  // assignableRoles is lib/roles canGiveRole's list, on the matrix + overrides given (S80).
  const matrix = R.seedPermissions();
  const editable = Object.keys(R.PERMISSIONS).filter((k) => !R.ALWAYS_GRANTED.has(k));
  const want = { owner: 'owner,admin,manager,crew', admin: 'admin,crew', manager: 'admin,manager,crew', crew: 'crew' };
  ok('🔴 default matrix: a Super Admin gives any role, an Admin Admin / Crew, a Manager Admin / Manager / Crew; Super Admin only from a Super Admin',
    ROLES.every((r) => TL.assignableRoles({ id: `a_${r}`, role: r }, matrix, []).join() === want[r])
    && TL.assignableRoles(null, matrix, []).length === 0 && TL.assignableRoles({ id: 'n', role: null }, matrix, []).length === 0);
  ok('🔴 the matrix decides: pare Manager down to what an Admin holds and an Admin may give it',
    TL.assignableRoles({ id: 'a_admin', role: 'admin' }, matrix.map((p) => (p.roles.includes('admin') ? p : { ...p, roles: p.roles.filter((r) => r !== 'manager') })), []).includes('manager'));
  ok("  ...and the giver's own overrides: an Admin granted every key may give Manager (never Super Admin); a Manager missing one of its keys may not",
    TL.assignableRoles({ id: 'a_admin', role: 'admin' }, matrix, [{ userId: 'a_admin', grants: editable, revokes: [] }]).join() === 'admin,manager,crew'
    && !TL.assignableRoles({ id: 'a_manager', role: 'manager' }, matrix, [{ userId: 'a_manager', grants: [], revokes: ['reports.view'] }]).includes('manager'));
  ok('your own status is not limited (the server allows it)', TL.teamLimit({ id: 'm', role: 'manager' }, { id: 'm', role: 'manager' }, 'status') === null);
  ok('no reason for "nothing blocked"', TL.teamLimitReason('role', null) === null);
}

// ── CS-329: ending an Admin's access is admin+ BY ROLE (owner's call 2026-09-24) ──────────
// Ending access = a no-access status, an invite revoke, a login ban, OR removal. S93 covered
// status / revoke; the owner's 2026-09-24 call adds REMOVAL. The shared decision is lib/roles
// canEndAccess (a manager or crew is refused even holding settings.team.edit / a removal
// permission); teamLimit maps it to 'admin-remove' for Remove, keeping 'admin-status' for
// status / revoke.
{
  const mgr = { id: 'u_m', role: 'manager' };
  const adm = { id: 'u_a', role: 'admin' };
  const own = { id: 'u_o', role: 'owner' };
  const adminT = { id: 'u_t', role: 'admin' };
  const crewT = { id: 'u_c', role: 'crew' };
  const mgrT = { id: 'u_mt', role: 'manager' };
  ok('canEndAccess exists (lib/roles)', typeof R.canEndAccess === 'function');
  if (typeof R.canEndAccess === 'function') {
    ok('canEndAccess: an Admin target needs admin+ (manager/crew refused; admin/owner allowed)',
      R.canEndAccess('manager', true) === false && R.canEndAccess('crew', true) === false
      && R.canEndAccess('admin', true) === true && R.canEndAccess('owner', true) === true);
    ok('canEndAccess: a non-Admin target is unrestricted by this rule',
      R.canEndAccess('manager', false) === true && R.canEndAccess('crew', false) === true);
  }
  if (TL) {
    ok('🔴 a manager cannot REMOVE an Admin (admin-remove)', TL.teamLimit(mgr, adminT, 'remove') === 'admin-remove');
    ok('🔴  ...nor can crew (a removal permission does not lift the role floor)', TL.teamLimit(crewT, adminT, 'remove') === 'admin-remove');
    ok('an Admin CAN remove an Admin', TL.teamLimit(adm, adminT, 'remove') === null);
    ok('the owner CAN remove an Admin', TL.teamLimit(own, adminT, 'remove') === null);
    ok('a manager CAN still remove a crew member or a manager',
      TL.teamLimit(mgr, crewT, 'remove') === null && TL.teamLimit(mgr, mgrT, 'remove') === null);
    ok("'admin-remove' has visible wording", (TL.teamLimitReason('remove', 'admin-remove') || '').length > 12);
    ok('status / revoke keep the Admin floor (admin-status), via the same helper',
      TL.teamLimit(mgr, adminT, 'status') === 'admin-status' && TL.teamLimit(mgr, adminT, 'revoke') === 'admin-status'
      && TL.teamLimit(adm, adminT, 'status') === null && TL.teamLimit(adm, adminT, 'revoke') === null);
  }
}

// ── CS-355: changing an Admin's access level is admin+ BY ROLE (owner's call 2026-09-25) ──────
// A manager holding staff.assignRoles (every manager by default) could DEMOTE an Admin (e.g.
// Admin → crew) in one save; once crew, a later save could disable or remove them. The owner's
// call extends canEndAccess to the ROLE change: reducing an Admin's access is admin+ by role, the
// same floor as ending it. teamLimit maps it to 'admin-role' for the Role field. Promoting someone
// TO Admin stays canGiveRole's rule (not gated here), and self / Super-Admin rules are unchanged.
{
  const mgr = { id: 'u_m', role: 'manager' };
  const adm = { id: 'u_a', role: 'admin' };
  const own = { id: 'u_o', role: 'owner' };
  const crewA = { id: 'u_ca', role: 'crew' };
  const adminT = { id: 'u_t', role: 'admin' };
  const crewT = { id: 'u_c', role: 'crew' };
  const mgrT = { id: 'u_mt', role: 'manager' };
  if (typeof R.canEndAccess === 'function') {
    ok('canEndAccess is the shared floor for a role change too (an Admin target needs admin+)',
      R.canEndAccess('manager', true) === false && R.canEndAccess('crew', true) === false
      && R.canEndAccess('admin', true) === true && R.canEndAccess('owner', true) === true);
  }
  if (TL) {
    ok('🔴 a manager cannot change an Admin\'s role (admin-role)', TL.teamLimit(mgr, adminT, 'role') === 'admin-role');
    ok('🔴  ...nor can crew (staff.assignRoles does not lift the role floor)', TL.teamLimit(crewA, adminT, 'role') === 'admin-role');
    ok('an Admin CAN change another Admin\'s role', TL.teamLimit(adm, adminT, 'role') === null);
    ok('the owner CAN change an Admin\'s role', TL.teamLimit(own, adminT, 'role') === null);
    ok('a manager CAN still change a crew member\'s or a manager\'s role (crew ↔ manager)',
      TL.teamLimit(mgr, crewT, 'role') === null && TL.teamLimit(mgr, mgrT, 'role') === null);
    ok("'admin-role' has visible wording", (TL.teamLimitReason('role', 'admin-role') || '').length > 12);
    ok('a self role change is still \'self\', not \'admin-role\' (owner-only rule unchanged)',
      TL.teamLimit(adminT, adminT, 'role') === 'self' && TL.teamLimit(adm, adm, 'role') === 'self');
  }
}

// ── CS-369: reducing an Admin's per-user overrides is admin+ BY ROLE (owner's call 2026-09-25) ──
// A manager (or crew) holding staff.editOverrides could REDUCE an Admin's access on TeamDetail ›
// Access — add a revoke, or clear a grant — and CS-331 only gated GRANTS. The owner's call: it
// shares the canEndAccess floor (admin+ by role). This is NOT a teamLimit code (grants to an Admin
// stay open, CS-331), so it lives per-row in TeamDetail as reduceAdminLocked / reduceLocked. Here:
// the page's reduce-lock decision must AGREE with the server guard for every actor × target, and
// the TeamDetail wiring is pinned to it. Keys from lib/roles PERMISSIONS, never restated literals.
if (TL) {
  const U369 = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@cs.co` });
  const ROSTER369 = [U369('o369', 'owner'), U369('m369', 'manager'), U369('m2_369', 'manager'),
    U369('a369', 'admin'), U369('a2_369', 'admin'), U369('c369', 'crew')];
  const MATRIX369 = R.seedPermissions();
  const REDKEY = 'clients.view'; // every role carries it by default → a revoke is a real reduction for any target
  ok('fixture: REDKEY is a real key every role carries', REDKEY in R.PERMISSIONS && ROLES.every((r) => R.PERMISSIONS[REDKEY].defaultRoles.includes(r)));
  const holds369 = (actor, key, ov) => can(actor, key, MATRIX369, ov);
  // The page's Access-tab reduce decision, modeled from TeamDetail: the tab is reachable
  // (settings.team.view + staff.editOverrides), not blocked whole (teamLimit 'overrides' = self /
  // super-admin), and the row is not reduceAdminLocked (canEndAccess on an Admin target).
  // Reach for the Access tab = settings.team.view + staff.editOverrides (TeamDetail). A control
  // out of reach is not "incomplete" (the page simply doesn't expose it) — section C's rule.
  const reachAccess = (actor, ov) => holds369(actor, 'settings.team.view', ov) && holds369(actor, 'staff.editOverrides', ov);
  const pageOffersReduce = (actor, target, ov) =>
    reachAccess(actor, ov)
    && !TL.teamLimit(actor, target, 'overrides')
    && R.canEndAccess(actor.role, target.role === 'admin');
  let unsound = 0; let incomplete = 0; const firstBad = []; let mgrOnAdminBlocked = 0;
  for (const actor of ROSTER369) {
    // The committed state must let the actor reach the editor: grant staff.editOverrides to actors
    // who lack it by default (admins/crew), so the cross-check is about the reduction floor, not reach.
    const actorOv = holds369(actor, 'staff.editOverrides', []) ? [] : [{ userId: actor.id, grants: ['staff.editOverrides'], revokes: [] }];
    for (const target of ROSTER369) {
      if (target.id === actor.id) continue;
      const prev = {
        ...INITIAL_STATE, users: ROSTER369, permissions: MATRIX369, userPermissionOverrides: actorOv,
        invitations: [], payrollLines: [], reimbursements: [],
      };
      // The reduce edit: add a revoke of REDKEY to the TARGET, preserving the actor's own row.
      const nextOv = [...actorOv.filter((o) => o.userId !== target.id), { userId: target.id, grants: [], revokes: [REDKEY] }];
      const next = { ...prev, userPermissionOverrides: nextOv };
      const guardAccepts = protectedFieldViolations(prev, next, actor.role, actor.id, { removal: { payState: {}, recentHours: new Set() } }).length === 0;
      const offered = pageOffersReduce(actor, target, actorOv);
      // Sound: the page never offers a reduction the guard refuses. Complete WITHIN REACH: where the
      // actor can reach the tab, the page offers every reduction the guard accepts (no over-blocking).
      if (offered && !guardAccepts) { unsound += 1; if (firstBad.length < 8) firstBad.push(`UNSOUND ${actor.role}→${target.role}`); }
      if (!offered && guardAccepts && reachAccess(actor, actorOv)) { incomplete += 1; if (firstBad.length < 8) firstBad.push(`INCOMPLETE ${actor.role}→${target.role}`); }
      if (actor.role === 'manager' && target.role === 'admin' && !offered && !guardAccepts) mgrOnAdminBlocked += 1;
    }
  }
  ok(`🔴 CS-369: the Access reduce-lock is SOUND — offers no reduction the guard refuses (${unsound}${firstBad.length ? `: ${firstBad.join(' · ')}` : ''})`, unsound === 0);
  ok(`🔴 CS-369: ...and COMPLETE within reach — a manager reducing an Admin is blocked, but every reduction the guard accepts is offered (${incomplete} missing)`, incomplete === 0);
  ok('🔴 CS-369: a manager reducing an Admin is blocked on BOTH the page and the guard (the case exists)', mgrOnAdminBlocked > 0);

  // Source pins: TeamDetail wires the reduce-lock (fails pre-fix).
  const td = read('src/pages/settings/TeamDetail.jsx');
  ok('CS-369: TeamDetail imports canEndAccess + computes reduceAdminLocked from the viewer and the Admin target',
    /canEndAccess/.test(td) && /const reduceAdminLocked = !canEndAccess\(currentUser\?\.role, user\?\.role === 'admin'\);/.test(td));
  ok('🔴 CS-369: togglePermOverride refuses BOTH reduction directions (add a revoke AND clear a grant)',
    (td.match(/if \(reduceAdminLocked\) return;/g) || []).length === 2);
  ok('🔴 CS-369: the override row is read-only when it would reduce an Admin (overrideLocked includes reduceLocked)',
    /const reduceLocked = !ownerOnly && effective && reduceAdminLocked;/.test(td)
    && /const overrideLocked = !!overrideLimit \|\| \(ownerOnly && !granted && !revoked\) \|\| grantLocked \|\| reduceLocked;/.test(td));
  ok('CS-369: the reason is shown on Access', /Only an Admin or Super Admin can reduce an Admin's access\./.test(td));
}

// ── C. The differential: real action → real reducer → real server guard ─────
if (TL) {
  const U = (id, role) => ({ id, role, status: 'active', name: `Member ${id}`, email: `${id}@team.test`, phone: '', initials: 'MB' });
  const ROSTER = [
    U('u_own1', 'owner'), U('u_own2', 'owner'), U('u_adm1', 'admin'), U('u_adm2', 'admin'),
    U('u_mgr1', 'manager'), U('u_mgr2', 'manager'), U('u_crw1', 'crew'), U('u_crw2', 'crew'),
  ];
  const BASE = {
    ...INITIAL_STATE,
    users: ROSTER,
    permissions: R.seedPermissions(),
    userPermissionOverrides: [],
    invitations: [],
    payrollLines: [],
    reimbursements: [],
    company: { ...INITIAL_STATE.company, timezone: 'America/Los_Angeles' },
  };
  // The key each control is gated on (usePermission on the page); the key variants grant
  // or revoke it per user.
  const KEY = { role: 'staff.assignRoles', status: 'settings.team.edit', revoke: 'settings.team.edit', remove: 'settings.team.edit', overrides: 'staff.editOverrides', timezone: TZ };
  const holds = (st, actor, key) => can(actor, key, st.permissions, st.userPermissionOverrides);
  const roleOptions = (st, actor, target) => ROLES.filter((r) => r === target.role
    || TL.assignableRoles(actor, st.permissions, st.userPermissionOverrides).includes(r));
  // A MODEL of each page, pinned to the page by D's source checks. `reach` is everything
  // but the limits: the route gate, the tab, the control's own key, and a Save button for a
  // form field. TeamDetail and Team sit behind settings.team.view; Role needs
  // staff.assignRoles plus a Save (Profile's, settings.team.edit, or Pay's, payroll.view +
  // payroll.rates.edit); Status, Remove and Revoke need settings.team.edit; Access needs
  // staff.editOverrides; Company sits behind settings.company, its picker behind the key.
  const reach = {
    role: (st, a) => holds(st, a, 'settings.team.view') && holds(st, a, 'staff.assignRoles')
      && (holds(st, a, 'settings.team.edit') || (holds(st, a, 'payroll.view') && holds(st, a, 'payroll.rates.edit'))),
    status: (st, a) => holds(st, a, 'settings.team.view') && holds(st, a, 'settings.team.edit'),
    revoke: (st, a) => holds(st, a, 'settings.team.view') && holds(st, a, 'settings.team.edit'),
    remove: (st, a) => holds(st, a, 'settings.team.view') && holds(st, a, 'settings.team.edit'),
    overrides: (st, a) => holds(st, a, 'settings.team.view') && holds(st, a, 'staff.editOverrides'),
    timezone: (st, a) => holds(st, a, 'settings.company'),
  };
  // What each page offers: reach, then the limits (and for Remove, the pay rules).
  const offers = {
    role: (st, a, t, to) => reach.role(st, a) && !TL.teamLimit(a, t, 'role') && roleOptions(st, a, t).includes(to),
    status: (st, a, t) => reach.status(st, a) && !TL.teamLimit(a, t, 'status'),
    revoke: (st, a, t) => reach.revoke(st, a) && !TL.teamLimit(a, t, 'revoke'),
    remove: (st, a, t) => reach.remove(st, a) && !(TL.teamLimit(a, t, 'remove') || memberDeleteBlock(st, t.id, a.id)),
    overrides: (st, a, t) => reach.overrides(st, a) && !TL.teamLimit(a, t, 'overrides'),
    timezone: (st, a) => reach.timezone(st, a) && holds(st, a, TZ),
  };
  // The action each page dispatches (TeamDetail's live-mode patch: no email).
  const profile = (t) => ({ name: t.name, phone: t.phone, role: t.role, status: t.status, initials: t.initials });
  const dispatched = {
    role: (st, t, to) => ({ type: ACTIONS.UPDATE_USER, id: t.id, patch: { ...profile(t), role: to } }),
    status: (st, t) => ({ type: ACTIONS.UPDATE_USER, id: t.id, patch: { ...profile(t), status: 'disabled' } }),
    revoke: (st, t) => ({ type: ACTIONS.REVOKE_INVITATION, id: `inv_${t.id}` }),
    remove: (st, t) => ({ type: ACTIONS.DELETE_USER, id: t.id }),
    overrides: (st, t) => {
      const o = st.userPermissionOverrides.find((x) => x.userId === t.id) || { grants: [], revokes: [] };
      return { type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: t.id, grants: [...o.grants, 'reports.view'], revokes: o.revokes };
    },
    timezone: () => ({ type: ACTIONS.UPDATE_COMPANY, patch: { timezone: 'America/New_York' } }),
  };
  // The org_state endpoint hands the guard the pay facts when a save removes someone (S80):
  // here the state's own pay slices and no clocked hours (the model has none; the page's
  // own check reads the ledger).
  const payFacts = (st) => ({ payState: { payrollLines: st.payrollLines, reimbursements: st.reimbursements, opsSettings: st.opsSettings }, recentHours: new Set() });
  // The login step a live save runs FIRST (S80): TeamDetail's role → /claims, its status →
  // /disable, Remove → /delete; revoke, overrides and the timezone have none. The route
  // decides with loginRefusal on the COMMITTED state for a caller whose login carries its
  // claims (role + u_* id: every login S80 makes does) and a target whose login matches its
  // roster row. Its two reads are modeled: another Super Admin login that can sign in =
  // another Super Admin row that isn't disabled; the pay check = the guard's facts.
  const LOGIN_STEP = { role: 'role', status: 'status', remove: 'remove' };
  const emailKey = (e) => String(e || '').trim().toLowerCase();
  const loginAccepts = (st, actor, t, action, to) => {
    const step = LOGIN_STEP[action];
    if (!step || !TA) return true;
    if (!actor.role) return false; // no role claim: the section refuses before the rules
    const rows = st.users.filter((u) => u.id === t.id || emailKey(u.email) === emailKey(t.email)).map((u) => ({ id: u.id, role: u.role }));
    const otherOwners = st.users.filter((u) => u.role === 'owner' && u.id !== t.id && emailKey(u.email) !== emailKey(t.email));
    return TA.loginRefusal(step, {
      caller: { role: actor.role, orgUserId: actor.id, email: actor.email, claimIdentity: true },
      authority: TA.matrixAuthority(st, actor.role, actor.id),
      target: { email: t.email, claimRole: t.role, claimOrgUserId: t.id, rows },
      newRole: step === 'role' ? to : null,
      orgUserId: step === 'role' ? t.id : null,
      disabled: true,
      otherOwnerRow: otherOwners.length > 0,
      otherOwnerLogin: otherOwners.some((u) => u.status !== 'disabled'),
      owedPay: step === 'remove' ? TA.owedPayFor(st, payFacts(st), t.id) : null,
    }) === null;
  };
  const actors = [...ROSTER, { id: 'u_ghost', role: null, name: 'No role', email: 'ghost@team.test', status: 'active' }];
  const counts = { cases: 0, offered: 0, allowed: 0, unsound: 0, incomplete: 0, strictOwner: 0, unreachable: 0, loginRefused: 0 };
  const firstUnsound = [];
  const firstIncomplete = [];
  const ownerStrictOther = [];
  for (const action of Object.keys(offers)) {
    for (const actor of actors) {
      for (const variant of ['default', 'grant', 'revoke']) {
        const key = KEY[action];
        const row = variant === 'default' ? [] : [{ userId: actor.id, grants: variant === 'grant' ? [key] : [], revokes: variant === 'revoke' ? [key] : [] }];
        const targets = action === 'timezone' ? [null] : ROSTER;
        for (const target of targets) {
          const tos = action === 'role' ? ROLES.filter((r) => r !== target.role) : [null];
          for (const to of tos) {
            let prev = { ...BASE, userPermissionOverrides: row };
            let t = target;
            if (action === 'revoke') {
              t = { ...target, status: 'invited' };
              prev = {
                ...prev,
                users: prev.users.map((u) => (u.id === t.id ? t : u)),
                invitations: [{ id: `inv_${t.id}`, userId: t.id, email: t.email, role: t.role, status: 'pending' }],
              };
            }
            const offered = offers[action](prev, actor, t, to);
            const next = reducer(prev, dispatched[action](prev, t, to));
            const guardOk = protectedFieldViolations(prev, next, actor.role, actor.id, { removal: payFacts(prev) }).length === 0;
            const loginOk = loginAccepts(prev, actor, t, action, to);
            if (guardOk && !loginOk) counts.loginRefused += 1;
            const allowed = guardOk && loginOk;
            const label = `${action}${to ? `→${to}` : ''} by ${actor.role || 'no role'} (${actor.id}, key ${variant}) on ${t ? `${t.role} ${t.id}${t.id === actor.id ? ' (self)' : ''}` : 'the company'}`;
            counts.cases += 1;
            if (offered) counts.offered += 1;
            if (allowed) counts.allowed += 1;
            // Sound: nothing offered is refused (that refusal drops the whole save).
            if (offered && !allowed) { counts.unsound += 1; if (firstUnsound.length < 8) firstUnsound.push(label); }
            // Complete for everyone but a Super Admin, where they can reach the control: the
            // limits don't block more than the server does. (Out of reach: no route, tab, key
            // or Save; the server may still accept a hand-made save, but the page offers none.)
            // A Super Admin's controls still follow the keys they hold, as before S79, and
            // Remove still refuses yourself and pay that may be owed, which the server leaves
            // to the app. The only Super Admin controls S79 took away are the timezone's dead
            // switches (other roles' cells on Roles, a non-owner's grant on Access), which
            // this model doesn't include.
            if (allowed && !offered && !reach[action](prev, actor)) counts.unreachable += 1;
            else if (allowed && !offered) {
              if (actor.role === 'owner') {
                counts.strictOwner += 1;
                const expected = variant === 'revoke' || (action === 'remove' && t.id === actor.id);
                if (!expected && ownerStrictOther.length < 8) ownerStrictOther.push(label);
              } else { counts.incomplete += 1; if (firstIncomplete.length < 8) firstIncomplete.push(label); }
            }
          }
        }
      }
    }
  }
  ok(`🔴 SOUND: the UI offers nothing either half of the server refuses (${counts.unsound} of ${counts.offered} offered cases refused${firstUnsound.length ? `: ${firstUnsound.join(' · ')}` : ''})`, counts.unsound === 0);
  ok(`the login half is in the model: it refuses cases the guard alone accepts (${counts.loginRefused})`, !TA || counts.loginRefused > 0);
  ok(`COMPLETE: for everyone but a Super Admin, within reach, the UI offers all the server accepts (${counts.incomplete} missing${firstIncomplete.length ? `: ${firstIncomplete.join(' · ')}` : ''})`, counts.incomplete === 0);
  ok('the enumeration is not vacuous', counts.cases > 1500 && counts.offered > 300 && counts.allowed > counts.offered / 2);
  ok(`a Super Admin is stricter only where the page always was: their own key revoked, or removing themselves (${counts.strictOwner} cases${ownerStrictOther.length ? `; other: ${ownerStrictOther.join(' · ')}` : ''})`,
    ownerStrictOther.length === 0);
  console.log(`  differential: ${counts.cases} cases · ${counts.offered} offered · ${counts.allowed} accepted by both halves (${counts.loginRefused} more by the guard alone) · ${counts.unsound} unsound · ${counts.incomplete} incomplete · ${counts.unreachable} accepted but out of reach · ${counts.strictOwner} stricter-for-Super-Admin`);

  // A STALE FORM (adversarial review, S79). Someone changes the member while the page is
  // open: a Super Admin promotes them to Super Admin, or demotes one. The page keeps only the
  // viewer's own edits and reads the rest from the member as stored NOW; role / status go out
  // only when edited and where the limits (from the stored member) allow. D pins the page to
  // this model. Before S79 the page kept the whole member it opened with and sent all of it.
  const pagePatch = (actor, fresh, edits) => {
    const p = {};
    for (const f of ['name', 'phone', 'initials']) if (f in edits) p[f] = edits[f];
    if ('role' in edits && !TL.teamLimit(actor, fresh, 'role')) p.role = edits.role;
    if ('status' in edits && !TL.teamLimit(actor, fresh, 'status')) p.status = edits.status;
    return p;
  };
  const openedPatch = (opened, edits) => {
    const f = { ...opened, ...edits };
    return { name: f.name, phone: f.phone, role: f.role, status: f.status, initials: f.initials };
  };
  const stale = { cases: 0, refused: 0, oldRefused: 0, superOffered: 0 };
  for (const actor of ROSTER.filter((u) => u.role !== 'owner')) {
    const keys = [{ userId: actor.id, grants: ['settings.team.edit', 'staff.assignRoles'], revokes: [] }];
    for (const other of ['admin', 'manager', 'crew']) {
      const scenes = [
        // promoted: opened as `other`, now a Super Admin; the viewer had edited the phone and the role
        [U('u_changed', other), U('u_changed', 'owner'), { phone: '555-0100', role: other === 'crew' ? 'manager' : 'crew' }],
        // demoted: opened as a Super Admin, now `other`; the viewer had edited the phone
        [U('u_changed', 'owner'), U('u_changed', other), { phone: '555-0100' }],
      ];
      for (const [opened, fresh, edits] of scenes) {
        const prev = { ...BASE, users: [...ROSTER, fresh], userPermissionOverrides: keys };
        const run = (patch) => protectedFieldViolations(prev, reducer(prev, { type: ACTIONS.UPDATE_USER, id: fresh.id, patch }), actor.role, actor.id);
        stale.cases += 1;
        if (run(pagePatch(actor, fresh, edits)).length) stale.refused += 1;
        if (run(openedPatch(opened, edits)).length) stale.oldRefused += 1;
        // The Role field: locked → the stored role; else the viewer's own edit or the stored role.
        const locked = !!TL.teamLimit(actor, fresh, 'role');
        const shown = locked ? fresh.role : ('role' in edits ? edits.role : fresh.role);
        if (!locked && ROLES.filter((r) => r === shown || TL.assignableRoles(actor, prev.permissions, prev.userPermissionOverrides).includes(r)).includes('owner')) stale.superOffered += 1;
      }
    }
  }
  ok(`🔴 a stale form saved by a non-owner is accepted (${stale.refused} of ${stale.cases} refused)`, stale.cases === 36 && stale.refused === 0);
  ok(`  ...where sending the whole form it opened with (before S79) was refused (${stale.oldRefused} of ${stale.cases})`, stale.oldRefused === stale.cases);
  ok(`🔴 a stale form never offers a non-owner "Super Admin" in a live Role field (${stale.superOffered} cases)`, stale.superOffered === 0);
}

// ── D. The pages are wired to the model; every writer is classified ──────────
{
  const td = read('src/pages/settings/TeamDetail.jsx');
  ok('TeamDetail imports the limits', /import \{ assignableRoles, teamLimit, teamLimitReason \} from '\.\.\/\.\.\/lib\/teamLimits'/.test(td));
  ok('TeamDetail computes each limit for (currentUser, user)',
    /const roleLimit = teamLimit\(currentUser, user, 'role'\)/.test(td)
    && /const statusLimit = teamLimit\(currentUser, user, 'status'\)/.test(td)
    && /const overrideLimit = teamLimit\(currentUser, user, 'overrides'\)/.test(td)
    && /const assignable = assignableRoles\(currentUser, permissions, overrides\);/.test(td)
    && /const permissions = selectPermissions\(state\);/.test(td) && /const overrides = selectUserPermissionOverrides\(state\);/.test(td));
  ok('🔴 Role is disabled by the limit as well as the key', /disabled=\{!canAssignRoles \|\| !!roleLimit\}/.test(td));
  ok('🔴 Role offers only assignable roles (plus the one it shows, to read it)',
    /options=\{ROLES\.filter\(\(r\) => r === roleValue \|\| assignable\.includes\(r\)\)\.map/.test(td) && !/options=\{ROLES\.map\(/.test(td));
  ok('🔴 the form holds only the viewer\'s edits; the rest reads the member as stored now',
    /const \[edits, setEdits\] = useState\(\{\}\);/.test(td) && /const current = \{ \.\.\.user, \.\.\.edits \};/.test(td)
    && !/useState\(user\)/.test(td) && !/setForm\(/.test(td));
  ok('  ...a locked field shows the member as stored, never an earlier edit',
    /const roleValue = roleLimit \? user\.role : current\.role;/.test(td) && /const statusValue = statusLimit \? user\.status : current\.status;/.test(td)
    && /value=\{roleValue\}/.test(td) && /value=\{statusValue\}/.test(td));
  ok('Role says why, in visible help text', /help=\{!canAssignRoles \? "You don't have permission to assign roles\." : teamLimitReason\('role', roleLimit\) \|\| undefined\}/.test(td));
  ok('🔴 Status is disabled by the limit, with its reason', /disabled=\{!canEdit \|\| !!statusLimit\}/.test(td) && /teamLimitReason\('status', statusLimit\)/.test(td));
  const saveBody = td.slice(td.indexOf('const save = async'), td.indexOf('const del = async'));
  ok('🔴 save() sends only what the viewer edited; role / status only where the limits allow',
    /const patch = \{\};/.test(saveBody)
    && ['name', 'phone', 'initials'].every((f) => new RegExp(`if \\('${f}' in edits\\) patch\\.${f} = `).test(saveBody))
    && /if \('role' in edits && !roleLimit\) patch\.role = current\.role;/.test(saveBody)
    && /if \('status' in edits && !statusLimit\) patch\.status = current\.status;/.test(saveBody)
    && /if \(!authConfigured && 'email' in edits\) patch\.email = current\.email;/.test(saveBody)
    && /if \(canEditThisPay && 'pay' in edits\) patch\.pay = current\.pay;/.test(saveBody)
    && !/role: current\.role/.test(saveBody) && !/status: current\.status/.test(saveBody));
  ok('  ...and a saved form starts clean', /dispatch\(\{ type: ACTIONS\.UPDATE_USER, id: user\.id, patch \}\);\s*setEdits\(\{\}\);/.test(saveBody));
  ok('🔴 ...and the login steps follow the patch, not the form: applyLoginChanges (status, then role, the status undone if the role is refused) before the dispatch',
    /const failed = await applyLoginChanges\(\{\s*email: user\.email,\s*orgUserId: user\.id,\s*role: \{ from: user\.role, to: 'role' in patch \? patch\.role : user\.role \},\s*status: \{ from: user\.status, to: 'status' in patch \? patch\.status : user\.status \},\s*\}\);\s*if \(failed\) \{[^]*?return;\s*\}/.test(saveBody)
    && saveBody.indexOf('applyLoginChanges(') < saveBody.indexOf('dispatch({ type: ACTIONS.UPDATE_USER')
    && !/syncTeamClaims|setTeamLoginDisabled/.test(td));
  ok('🔴 Remove: the limit comes before the pay rules', /const deleteBlock = teamLimit\(currentUser, user, 'remove'\)\s*\|\| memberDeleteBlock\(/.test(td));
  ok('  ...its wording', /if \(code === 'super-admin'\) return teamLimitReason\('remove', code\);/.test(td));
  ok('  ...and the visible note still renders for it', /canEdit && deleteBlockedReason && deleteBlock !== 'self' &&/.test(td));
  const delBody = td.slice(td.indexOf('const del = async'), td.indexOf('const sendReset'));
  ok('🔴 del() refuses on the limit before touching the login or the ledger',
    /const limit = teamLimit\(currentUser, user, 'remove'\);\s*if \(limit\) \{/.test(delBody)
    && delBody.indexOf("teamLimit(currentUser, user, 'remove')") < delBody.indexOf('checkRecentHours()')
    && delBody.indexOf("teamLimit(currentUser, user, 'remove')") < delBody.indexOf('deleteTeamLogin('));
  ok('🔴 Access: override writes return early on the limit (toggle AND reset)', (td.match(/if \(!canEditOverrides \|\| overrideLimit\) return;/g) || []).length === 2);
  const toggleBody = td.slice(td.indexOf('const togglePermOverride'), td.indexOf('const clearOverrides'));
  const ownerOnlyBranch = toggleBody.slice(toggleBody.indexOf("if (OWNER_ONLY.has(permKey) && user.role !== 'owner') {"), toggleBody.indexOf('const perm = permissions.find'));
  ok('Access: on a non-Super-Admin member an OWNER_ONLY key is only ever cleared, never granted or revoked',
    ownerOnlyBranch.length > 0
    && /const keep = \(list\) => \(list \|\| \[\]\)\.filter\(\(k\) => k !== permKey\);/.test(ownerOnlyBranch)
    && /grants: keep\(override\.grants\), revokes: keep\(override\.revokes\)/.test(ownerOnlyBranch)
    && !/\.push\(/.test(ownerOnlyBranch) && /\breturn;\s*\}\s*$/.test(ownerOnlyBranch.trimEnd() + '\n'));
  ok('🔴 Access: the override button renders only when nothing locks the row (incl. a grant-locked key CS-331, or an Admin reduction CS-369)',
    /const overrideLocked = !!overrideLimit \|\| \(ownerOnly && !granted && !revoked\) \|\| grantLocked \|\| reduceLocked;/.test(td)
    && /\{overrideLocked \? \(\s*<Badge[^]*?\) : \(\s*<button/.test(td));
  ok('Access: the reason replaces the how-to line', /overrideLimit\s*\?\s*teamLimitReason\('overrides', overrideLimit\)/.test(td));
  ok('Access: Reset to role defaults hides when locked', /hasOverrides && !overrideLimit && <button/.test(td));
  ok('Access: an OWNER_ONLY row reads "Super Admin only" and is never effective',
    /const ownerOnly = OWNER_ONLY\.has\(key\) && user\.role !== 'owner';/.test(td) && /const effective = !ownerOnly && /.test(td) && /Super Admin only<\/Badge>/.test(td));

  const team = read('src/pages/settings/Team.jsx');
  ok('🔴 Team: Revoke is limited like a status change', /const revokeLimit = invitation \? teamLimit\(currentUser, u, 'revoke'\) : null;/.test(team));
  ok('  ...the button renders only without the limit, the reason in its place',
    /\{revokeLimit \? \(\s*<span className="text-xs text-muted">\{teamLimitReason\('revoke', revokeLimit\)\}<\/span>\s*\) : \(\s*<button/.test(team));
  const revokeBody = team.slice(team.indexOf('const handleRevoke'), team.indexOf('return (', team.indexOf('const handleRevoke')));
  ok('  ...and the handler refuses on the limit before dispatching (backstop)',
    /const limit = teamLimit\(currentUser, users\.find\(\(x\) => x\.id === userId\), 'revoke'\);\s*if \(limit\) \{/.test(revokeBody)
    && revokeBody.indexOf('if (limit)') < revokeBody.indexOf('ACTIONS.REVOKE_INVITATION')
    && /handleRevoke\(revoking\)/.test(team) && /setRevoking\(\{ invitationId: invitation\.id, userId: u\.id, userName: u\.name \}\)/.test(team));
  ok('an OWNER_ONLY entry on a non-owner is not "custom access" (Team list + member page count live keys)',
    /liveOverrideKeys\(o\.grants, u\.role\)\.length \+ liveOverrideKeys\(o\.revokes, u\.role\)\.length > 0/.test(team)
    && /const overrideCount = liveOverrideKeys\(override\.grants, user\?\.role\)\.length \+ liveOverrideKeys\(override\.revokes, user\?\.role\)\.length;/.test(td)
    && /const hasOverrides = overrideCount > 0;/.test(td));
  ok('liveOverrideKeys drops OWNER_ONLY keys for everyone but a Super Admin',
    typeof R.liveOverrideKeys === 'function'
    && R.liveOverrideKeys([TZ, 'reports.view'], 'manager').join() === 'reports.view'
    && R.liveOverrideKeys([TZ, 'reports.view'], 'owner').join() === `${TZ},reports.view`
    && R.liveOverrideKeys(null, 'crew').length === 0);

  const company = read('src/pages/settings/Company.jsx');
  ok('Company: the picker follows the key (can() holds it to a Super Admin)', /const canEditTimezone = usePermission\('settings\.company\.timezone'\);/.test(company));
  ok('🔴 Company: everyone else gets the zone read-only with the reason',
    /\{canEditTimezone \? \(\s*<FormField[^]*?\) : \(/.test(company)
    && /disabled\s+help=\{isSuperAdmin/.test(company) && /'Only a Super Admin can change the company timezone\.'/.test(company));
  ok('Company: only a Super Admin save carries the timezone', /if \(!canEditTimezone\) \{ commit\(patch\); return; \}/.test(company));

  const roles = read('src/pages/settings/Roles.jsx');
  ok('🔴 Roles: an OWNER_ONLY cell is locked for every other role', /const locked = \(perm, role\) => OWNER_ONLY\.has\(perm\.id\) && role !== 'owner';/.test(roles));
  ok('  ...a write to it is a no-op', /if \(perm\.schemaDefault \|\| locked\(perm, role\)\) return;/.test(roles));
  ok('  ...the section master leaves it (and any grant-locked cell CS-331, or reduce-locked admin cell CS-370) alone', /rows\.filter\(\(r\) => !r\.schemaDefault && !locked\(r, role\) && !grantLocked\(r, role\) && !reduceLocked\(r, role\)\)/.test(roles));
  ok('  ...and shows a "Super Admin only" status badge instead of a switch (§41)',
    /\{locked\(p, r\) \? \(\s*<span className="rp-locked"><Badge variant="slate">Super Admin only<\/Badge><\/span>\s*\) : \(\s*<Toggle/.test(roles));

  const add = read('src/components/AddUserModal.jsx');
  ok('🔴 AddUserModal offers the same roles as TeamDetail (canGiveRole on the matrix + overrides), and refuses any other on submit',
    /const roleChoices = assignableRoles\(currentUser, selectPermissions\(state\), selectUserPermissionOverrides\(state\)\);/.test(add)
    && /options=\{roleChoices\.map\(/.test(add) && /if \(!roleChoices\.includes\(form\.role\)\) \{/.test(add)
    && !/\['admin', 'manager', 'crew'\]/.test(add));

  const css = read('src/index.css');
  ok('.rp-locked wraps its badge inside the narrow role column, from tokens',
    /\.rp-locked \{[^}]*var\(--space-1\)[^}]*\}/.test(css) && /\.rp-locked \.badge \{[^}]*white-space: normal[^}]*var\(--line-height-tight\)[^}]*\}/.test(css));

  // Every call site names a known action (a typo would silently skip the self check).
  const src = [];
  const walk = (dir) => {
    for (const f of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${f}`;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(jsx?|mjs)$/.test(f)) src.push(rel);
    }
  };
  walk('src');
  const calls = src.flatMap((f) => [...read(f).matchAll(/\bteamLimit\([^)]*?'([a-z-]+)'\)/g)].map((m) => ({ f, action: m[1] })));
  ok(`every teamLimit() call names a known action (${calls.length} calls)`, calls.length >= 6 && calls.every((c) => TEAM_ACTIONS.includes(c.action)));

  // THE WRITERS, mechanically (BUILD_INTEGRITY: coverage is enumerated, never judged).
  // Step 1: every reducer case that writes a slice the guard checks for Team admin (the
  // roster, the matrix, per-user overrides, the company record, time off; nothing writes
  // standingCrewIds or re-parents a site since 2026-09-09). A new case fails until classified.
  // Comments are stripped first (a comment between two properties hid `timeOff:` from the
  // first version of this scan). A case that spreads a HELPER's result into the state
  // (`...sweepUserOrphans(state, …)`) writes whatever that helper returns, so each such
  // helper is called and its returned slices counted; an unknown helper fails until added.
  const reducerSrc = read('src/store/reducer.js');
  const strip = (s) => s.replace(/\/\*[^]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const caseAt = [...reducerSrc.matchAll(/case ACTIONS\.([A-Z0-9_]+):/g)].map((m) => ({ name: m[1], at: m.index }));
  const PROTECTED_SLICES = ['users', 'userPermissionOverrides', 'permissions', 'company', 'timeOff'];
  const HELPERS = {
    sweepUserOrphans: () => DC.sweepUserOrphans(INITIAL_STATE, 'u_x', 'Gone'),
    sweepClientOrphans: () => DC.sweepClientOrphans(INITIAL_STATE, 'cl_x', new Set()),
    removeReimbursement: () => DC.removeReimbursement(INITIAL_STATE, 'rmb_x'),
  };
  const unknownHelpers = new Set();
  const enumerated = caseAt.filter((c, i) => {
    const body = strip(reducerSrc.slice(c.at, i + 1 < caseAt.length ? caseAt[i + 1].at : reducerSrc.length));
    if (PROTECTED_SLICES.some((s) => new RegExp(`[{,]\\s*${s}\\s*[:,}]`).test(body))) return true;
    return [...body.matchAll(/\.\.\.([A-Za-z_]\w*)\(/g)].some(([, h]) => {
      if (!HELPERS[h]) { unknownHelpers.add(`${h} (${c.name})`); return true; }
      return Object.keys(HELPERS[h]()).some((k) => PROTECTED_SLICES.includes(k));
    });
  }).map((c) => c.name);
  ok(`every helper spread into a reducer case is known (${[...unknownHelpers].join(', ') || 'none unknown'})`, unknownHelpers.size === 0);
  ok('the helper scan sees a helper write: DELETE_USER\'s sweepUserOrphans returns timeOff',
    Object.keys(HELPERS.sweepUserOrphans()).includes('timeOff'));
  const TEAM_WRITERS = ['ADD_USER', 'UPDATE_USER', 'DELETE_USER', 'UPDATE_NOTIFICATION_PREFS', 'UPDATE_SIGNATURE_PREFS',
    'REVOKE_INVITATION', 'SET_USER_PERMISSION_OVERRIDE', 'UPDATE_PERMISSION', 'UPDATE_COMPANY', 'ADD_TIME_OFF', 'DELETE_TIME_OFF'];
  // Integrations rewrite company.integrations only; proven below, so their many callers
  // (Integrations, Marketing, Messaging) need no classification here.
  const INTEGRATION_WRITERS = ['CONNECT_TWILIO', 'DISCONNECT_TWILIO', 'UPDATE_TWILIO_NUMBER', 'UPDATE_TWILIO_WEBHOOK',
    'UPDATE_TWILIO_ERROR', 'SUBMIT_A2P', 'UPDATE_A2P_STATUS', 'RESET_A2P', 'CONNECT_EMAIL_PROVIDER',
    'DISCONNECT_EMAIL_PROVIDER', 'UPDATE_EMAIL_DOMAIN_STATUS', 'UPDATE_EMAIL_DEFAULT_FROM', 'UPDATE_EMAIL_ERROR'];
  const classified = new Set([...TEAM_WRITERS, ...INTEGRATION_WRITERS]);
  ok(`every reducer case writing a protected slice is classified (${enumerated.length} enumerated == ${classified.size} classified; unclassified: ${enumerated.filter((a) => !classified.has(a)).join(', ') || 'none'}; stale: ${[...classified].filter((a) => !enumerated.includes(a)).join(', ') || 'none'})`,
    enumerated.length === classified.size && enumerated.every((a) => classified.has(a)));
  // Adversarial payloads: every `action.<field>` the case reads carries a timezone (at the
  // top, and under company / integrations), so a case that spread its payload into
  // `company` would move it.
  const tzState = { ...INITIAL_STATE, company: { ...INITIAL_STATE.company, timezone: 'America/Chicago' } };
  const poison = { timezone: 'Etc/Poison', company: { timezone: 'Etc/Poison' }, integrations: { timezone: 'Etc/Poison' } };
  const caseBody = (a) => {
    const i = caseAt.findIndex((c) => c.name === a);
    return strip(reducerSrc.slice(caseAt[i].at, i + 1 < caseAt.length ? caseAt[i + 1].at : reducerSrc.length));
  };
  const heldTz = INTEGRATION_WRITERS.filter((a) => {
    const fields = [...new Set([...caseBody(a).matchAll(/action\.(\w+)/g)].map((m) => m[1]))];
    const action = { type: ACTIONS[a], ...Object.fromEntries(fields.map((f) => [f, { ...poison }])) };
    try { return reducer(tzState, action).company.timezone === 'America/Chicago'; } catch { return false; }
  });
  ok(`the integration writers never touch company.timezone, even with a poisoned payload (${heldTz.length} of ${INTEGRATION_WRITERS.length})`,
    heldTz.length === INTEGRATION_WRITERS.length);

  // Step 2: every dispatch site of a Team writer, file by file, with the rule that covers
  // it. A new site fails here until someone says which limit applies.
  const LEDGER = {
    'src/components/AddUserModal.jsx': { ADD_USER: 2 }, // role from assignableRoles (canGiveRole); both halves refuse any other
    'src/components/EmployeeHrFieldsCard.jsx': { UPDATE_USER: 1 }, // hr only, gated hr.edit; the server gates it the same, with no Super Admin limit
    'src/components/TimeOffCard.jsx': { ADD_TIME_OFF: 1, DELETE_TIME_OFF: 1 }, // settings.team.edit, one of the guard's two time-off keys
    'src/pages/hr/PtoTab.jsx': { ADD_TIME_OFF: 1, DELETE_TIME_OFF: 1 }, // hr.edit, the guard's other time-off key
    'src/pages/settings/Account.jsx': { UPDATE_USER: 1, UPDATE_NOTIFICATION_PREFS: 2, UPDATE_SIGNATURE_PREFS: 2 }, // your own row only; no authority field
    'src/pages/settings/Company.jsx': { UPDATE_COMPANY: 1 }, // the timezone rides only a Super Admin's save (can() OWNER_ONLY)
    'src/pages/settings/Roles.jsx': { UPDATE_PERMISSION: 2 }, // settings.roles.edit; OWNER_ONLY cells locked
    'src/pages/settings/Team.jsx': { REVOKE_INVITATION: 1 }, // teamLimit 'revoke'
    'src/pages/settings/TeamDetail.jsx': { UPDATE_USER: 1, DELETE_USER: 1, SET_USER_PERMISSION_OVERRIDE: 3 }, // teamLimit role / status / remove / overrides
  };
  const names = TEAM_WRITERS.join('|');
  const WRITES = new RegExp(`\\bACTIONS\\.(${names})\\b|type:\\s*['"](${names})['"]`, 'g');
  const found = {};
  for (const f of src.filter((x) => x !== 'src/store/reducer.js')) {
    for (const m of read(f).matchAll(WRITES)) {
      const a = m[1] || m[2];
      found[f] = found[f] || {};
      found[f][a] = (found[f][a] || 0) + 1;
    }
  }
  const same = JSON.stringify(Object.keys(found).sort().map((f) => [f, Object.entries(found[f]).sort()]))
    === JSON.stringify(Object.keys(LEDGER).sort().map((f) => [f, Object.entries(LEDGER[f]).sort()]));
  ok(`every dispatch of a Team writer is classified (${Object.values(found).reduce((n, o) => n + Object.values(o).reduce((a, b) => a + b, 0), 0)} sites; found ${JSON.stringify(found)})`, same);
}

console.log(`\ntest-team-limits: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
