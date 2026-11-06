// test-om-permission-column — CS-858 (plan docs/plans/2026-10-16-om-permission-column.md; Daniel,
// 2026-10-16: "Why aren't there operations manager permission settings in settings?").
//
// The Operations Manager (OM) is the `manager` role at the operations LEVEL (S131). Until now their
// permissions came from the Manager column, so nobody could give OMs different permissions from
// Account Managers (AMs). They get a permission COLUMN of their own, `operations_manager`:
//   A. lib/roles: PERMISSION_COLUMNS (ROLES with the OM column after the manager's — NOT a role:
//      the claim, OFFICE_ROLES and RLS read ROLES), permissionRoleOf(user), the code defaults (OMs
//      start with exactly the manager keys, derived once), can() reading the column, overrides
//      still on top, canGiveColumn (canGiveRole's rule for a column), withOpsManagerColumn (the
//      stored-matrix transform the demo hop and the release data-op share).
//   B. the server agrees: every gate built on permissionChecker reads the caller's column, the
//      level off the roster the gate already read (no second read), and a level that can't be
//      read FAILS CLOSED (a key holds only where both manager columns hold it, so it is never
//      wider than either); jobsGuard and the login routes' matrixAuthority the same.
//   C. the guard: nobody changes their own level; giving the operations level (or moving someone
//      between levels) takes holding everything the target column carries, on top of owner /
//      admin + ops.edit; rows naming operations_manager are accepted; a non-holder can't switch
//      the OM column on.
//   D. the Team screens offer only what the guard accepts (lib/teamLimits roleChoices).
//   G. TeamDetail's Access tab reads a member's role default from their column.
//
// Imports are dynamic and every check is counted, so the pre-change tree reports failures
// instead of dying on a missing export. Offline: the server half drives the real gates through
// fake-supabase.mjs (no network, no credentials). Run: node scripts/test-om-permission-column.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond) — stated, because this repo's suites disagree.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const show = (v) => JSON.stringify(v);
const fn = (mod, name) => (mod && typeof mod[name] === 'function' ? mod[name] : () => undefined);

const ORG = '00000000-0000-0000-0000-000000000001';
// Set BEFORE anything under api/ loads. The URL is a closed local port and fetch is stubbed.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const R = await import('../src/lib/roles.js');
const TS = await import('../src/lib/teamScope.js');
const TL = await import('../src/lib/teamLimits.js').catch(() => ({}));
const authz = await import('../api/_lib/authz.js');
const { withRequestCache } = await import('../api/_lib/requestCache.js');
const G = await import('../api/_lib/orgStateGuard.js');
const TA = await import('../api/_lib/teamAuthority.js');
const JG = await import('../api/_lib/jobsGuard.js');
const claims = await import('../api/_lib/claims.js');

const OM_COL = 'operations_manager';
const KEYS = Object.keys(R.PERMISSIONS);
const can = (u, k, m, o) => { try { return R.can(u, k, m, o) === true; } catch { return false; } };
// A matrix row's roles with one column added / removed (the matrix is otherwise the seed's).
const rowsWith = (base, edits) => base.map((p) => (edits[p.id] ? { ...p, roles: edits[p.id](p.roles) } : p));
const without = (col) => (roles) => roles.filter((r) => r !== col);
const plus = (...cols) => (roles) => [...new Set([...roles, ...cols])];

const OM = { id: 'u_om', role: 'manager', managerLevel: 'operations', status: 'active' };
const AM = { id: 'u_am', role: 'manager', managerLevel: 'account', status: 'active' };
const AM_NOLEVEL = { id: 'u_am0', role: 'manager', status: 'active' };

// ── A. the columns ───────────────────────────────────────────────────────────────────────────
ok(`A1 PERMISSION_COLUMNS: Super Admin, Admin, Account Manager, Operations Manager, Supply Manager, Crew (${show(R.PERMISSION_COLUMNS)})`,
  show(R.PERMISSION_COLUMNS) === show(['owner', 'admin', 'manager', OM_COL, 'supply_manager', 'crew']));
ok('A1 …derived from ROLES: every role is a column, and the OM column sits right after the manager\'s',
  Array.isArray(R.PERMISSION_COLUMNS) && R.ROLES.every((r) => R.PERMISSION_COLUMNS.includes(r))
  && R.PERMISSION_COLUMNS.indexOf(OM_COL) === R.PERMISSION_COLUMNS.indexOf('manager') + 1 && R.OPS_MANAGER_COLUMN === OM_COL);
ok('A1 🔴 the OM column is NOT a role: ROLES, OFFICE_ROLES and the claim\'s VALID_ROLES never name it',
  !R.ROLES.includes(OM_COL) && !R.OFFICE_ROLES.includes(OM_COL) && Array.isArray(claims.VALID_ROLES) && !claims.VALID_ROLES.includes(OM_COL));
{
  const col = fn(R, 'permissionRoleOf');
  ok(`A2 permissionRoleOf: an OM reads the OM column (${show(col(OM))})`, col(OM) === OM_COL);
  ok('A2 …an AM, with the level written or missing, reads the manager column', col(AM) === 'manager' && col(AM_NOLEVEL) === 'manager');
  ok('A2 …a stale operations level off the Manager role means nothing (crew stays crew; owner stays owner)',
    col({ id: 'x', role: 'crew', managerLevel: 'operations' }) === 'crew' && col({ id: 'o', role: 'owner', managerLevel: 'operations' }) === 'owner');
  ok('A2 …every other role is its own column', ['owner', 'admin', 'supply_manager', 'crew'].every((r) => col({ role: r }) === r));
}
{
  // The code defaults: OMs start with EXACTLY the manager's keys (read off PERMISSIONS, never restated).
  const defs = fn(R, 'defaultColumnsOf');
  const managerKeys = KEYS.filter((k) => R.PERMISSIONS[k].defaultRoles.includes('manager'));
  ok(`A3 defaultColumnsOf names the OM column exactly where defaultRoles names the manager (${managerKeys.length} keys)`,
    managerKeys.length > 50 && KEYS.every((k) => Array.isArray(defs(k)) && defs(k).includes(OM_COL) === R.PERMISSIONS[k].defaultRoles.includes('manager')));
  ok('A3 …right after the manager, every other column kept in order',
    managerKeys.every((k) => show(defs(k)) === show(R.PERMISSIONS[k].defaultRoles.flatMap((r) => (r === 'manager' ? [r, OM_COL] : [r])))));
  ok('A3 🔴 derived ONCE: the hand-written defaultRoles still name roles only', KEYS.every((k) => !R.PERMISSIONS[k].defaultRoles.includes(OM_COL)));
  const same = (matrix) => KEYS.filter((k) => can(OM, k, matrix, []) !== can(AM, k, matrix, []));
  ok(`A3 with no stored matrix (code defaults) an OM holds exactly the AM's keys (differ: ${show(same(null))})`, same(null).length === 0);
  ok(`A3 …and on the seeded matrix (seedPermissions) too (differ: ${show(same(R.seedPermissions()))})`, same(R.seedPermissions()).length === 0);
  ok('A3 the seeded matrix rows name the OM column where the manager is', R.seedPermissions().every((p) => p.roles.includes(OM_COL) === p.roles.includes('manager')));
}
{
  // The column decides: revoke a key in the OM column only, and the reverse.
  const m = rowsWith(R.seedPermissions(), { 'time.approve': without(OM_COL), 'payroll.rates.edit': plus(OM_COL) });
  ok(`A4 🔴 an OM loses a key revoked in the OM column (${can(OM, 'time.approve', m, [])}) while an AM keeps it (${can(AM, 'time.approve', m, [])})`,
    !can(OM, 'time.approve', m, []) && can(AM, 'time.approve', m, []) && can(AM_NOLEVEL, 'time.approve', m, []));
  ok(`A4 🔴 …and the reverse: a key given to the OM column only (${can(OM, 'payroll.rates.edit', m, [])}, AM ${can(AM, 'payroll.rates.edit', m, [])})`,
    can(OM, 'payroll.rates.edit', m, []) && !can(AM, 'payroll.rates.edit', m, []));
  // Overrides still sit on top: revoke > grant > column.
  ok('A5 a per-person grant still wins over the OM column', can(OM, 'time.approve', m, [{ userId: 'u_om', grants: ['time.approve'], revokes: [] }]));
  ok('A5 …and a revoke over it', !can(OM, 'payroll.rates.edit', m, [{ userId: 'u_om', grants: [], revokes: ['payroll.rates.edit'] }]));
  ok('A5 …revoke beats grant, as before', !can(OM, 'time.approve', m, [{ userId: 'u_om', grants: ['time.approve'], revokes: ['time.approve'] }]));
  // A stored row wins over the code default: a matrix saved before the column existed gives an OM
  // nothing on its rows — why the release data-op copies the manager column first.
  const old = R.seedPermissions().map((p) => ({ ...p, roles: p.roles.filter((r) => r !== OM_COL) }));
  ok('A6 a stored row that never names the OM column gives an OM nothing on it (the data-op runs before the deploy)',
    !can(OM, 'clients.view', old, []) && can(AM, 'clients.view', old, []));
  ok('A7 🔴 OWNER_ONLY stays the Super Admin\'s, even on a row naming the OM column', !can(OM, 'settings.company.timezone', rowsWith(R.seedPermissions(), { 'settings.company.timezone': plus(OM_COL) }), []));
  ok('A7 …and the always-granted surfaces stay an OM\'s whatever the matrix says', ['time.clock', 'schedule.view', 'messaging.use', 'settings.account'].every((k) => can(OM, k, [], [])));
}
{
  const give = fn(R, 'canGiveColumn');
  const seed = R.seedPermissions();
  const m = rowsWith(seed, { 'payroll.rates.edit': plus(OM_COL) });
  ok('A8 canGiveColumn: a Super Admin gives the OM column', give({ id: 'o', role: 'owner' }, OM_COL, m, []) === true);
  ok('A8 …a manager holding every manager key gives it while the OM column equals the manager\'s (the release default)', give(AM, OM_COL, seed, []) === true);
  ok('A8 🔴 …but not once the OM column carries a key they lack', give(AM, OM_COL, m, []) === false && give(AM, 'manager', m, []) === true);
  ok('A8 🔴 an Admin by default gives neither manager column (no money keys, Q24)', give({ id: 'a', role: 'admin' }, OM_COL, seed, []) === false && give({ id: 'a', role: 'admin' }, 'manager', seed, []) === false);
  ok('A8 canGiveRole is unchanged for the roles, and never gives the OM column as a role',
    R.ROLES.every((r) => R.canGiveRole(AM, r, seed, []) === (give(AM, r, seed, []) === true)) && R.canGiveRole({ id: 'o', role: 'owner' }, OM_COL, seed, []) === false);
}
{
  const tx = fn(R, 'withOpsManagerColumn');
  const before = [
    { id: 'a', label: 'A', roles: ['owner', 'admin', 'manager', 'supply_manager'] },
    { id: 'b', label: 'B', roles: ['owner'] },
    { id: 'c', label: 'C', roles: ['owner', 'manager', OM_COL] },
    { id: 'd', label: 'D', roles: 'owner,manager' },
    null,
    { id: 'e', label: 'E', roles: ['manager', 'crew'] },
  ];
  const out = tx(before) || {};
  ok(`A9 withOpsManagerColumn adds the OM column after the manager's, only where the manager is (${show(out.added)})`,
    show(out.added) === show(['a', 'e']) && show(out.permissions?.[0]?.roles) === show(['owner', 'admin', 'manager', OM_COL, 'supply_manager'])
    && show(out.permissions?.[5]?.roles) === show(['manager', OM_COL, 'crew']));
  ok('A9 …touches nothing else: other rows, a malformed row and a null row pass through as they were',
    out.permissions?.[1] === before[1] && out.permissions?.[2] === before[2] && out.permissions?.[3] === before[3] && out.permissions?.[4] === null
    && show(out.permissions?.[0]) === show({ id: 'a', label: 'A', roles: ['owner', 'admin', 'manager', OM_COL, 'supply_manager'] }));
  const again = tx(out.permissions || []) || {};
  ok('A9 …and a second run changes nothing', Array.isArray(again.added) && again.added.length === 0 && show(again.permissions) === show(out.permissions));
  ok('A9 no matrix stays no matrix', (tx(null) || {}).permissions === null && show((tx(null) || {}).added) === '[]');
}
{
  // TeamDetail's "Role default" column (G) — the member's column, the stored row else the code default.
  const has = fn(R, 'columnHolds');
  const m = rowsWith(R.seedPermissions(), { 'time.approve': without(OM_COL) });
  ok('A10 columnHolds reads a member\'s own column (an OM\'s time.approve off, an AM\'s on)',
    has(OM, 'time.approve', m) === false && has(AM, 'time.approve', m) === true);
  ok('A10 …a key the stored matrix lacks falls back to the code default, as can() does', has(OM, 'clients.view', []) === true && has({ role: 'crew' }, 'invoices.view', []) === false);
}

// ── B. the server agrees (the real gates, through fake-supabase) ─────────────────────────────
const MATRIX = rowsWith(R.seedPermissions(), { 'time.approve': without(OM_COL), 'payroll.rates.edit': plus(OM_COL) });
const ROSTER = [
  { id: 'u_owner', role: 'owner', status: 'active', email: 'owner@example.test' },
  { ...OM, email: 'om@example.test' },
  { ...AM, email: 'am@example.test' },
  { id: 'u_om_cl', role: 'manager', managerLevel: 'operations', status: 'active', email: 'omcl@example.test' },
  { id: 'u_dup', role: 'manager', managerLevel: 'operations', status: 'active', email: 'dup@example.test' },
  { id: 'u_dup', role: 'manager', status: 'active', email: 'dup2@example.test' },
];
const login = (id, email, claimed = true, role = 'manager') => ({ id: `auth-${id}`, email, app_metadata: claimed ? { role, org_user_id: id, org_id: ORG } : {} });
const LOGINS = {
  'tok-om': login('u_om', 'om@example.test'),
  'tok-am': login('u_am', 'am@example.test'),
  'tok-omcl': login('u_om_cl', 'omcl@example.test', false),
  'tok-dup': login('u_dup', 'dup@example.test'),
  'tok-owner': login('u_owner', 'owner@example.test', true, 'owner'),
};
const world0 = (overrides = []) => resetWorld({
  tables: { org_state: [{ organization_id: ORG, version: 7, state: { users: ROSTER, permissions: MATRIX, userPermissionOverrides: overrides } }] },
  logins: LOGINS,
});
const fakeRes = () => {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};
const req = (tok) => ({ headers: { authorization: `Bearer ${tok}` } });
const gate = (tok, key) => withRequestCache(async () => {
  const res = fakeRes();
  const a = await authz.requirePermission(req(tok), res, key);
  return { pass: !!a, code: res.code, a };
});
{
  world0();
  const om = await gate('tok-om', 'time.approve');
  const am = await gate('tok-am', 'time.approve');
  ok(`B1 🔴 requirePermission: an OM is refused a key the OM column lacks (${om.code}) while an AM passes (${am.code})`, !om.pass && om.code === 403 && am.pass);
  const om2 = await gate('tok-om', 'payroll.rates.edit');
  const am2 = await gate('tok-am', 'payroll.rates.edit');
  ok(`B1 🔴 …and the reverse: the OM column's own key (${om2.code}, AM ${am2.code})`, om2.pass && !am2.pass && am2.code === 403);
  ok(`B1 the authority carries the level read off the committed roster (${show(om.a?.managerLevel ?? null)} / ${show(am2.a?.managerLevel ?? null)})`,
    om2.a?.managerLevel === 'operations' && am.a?.managerLevel === 'account');
  // holdsPermission, permissionChecker and requireRoleOrPermission run the same checker.
  const both = await withRequestCache(async () => {
    const a = await authz.resolveAuthority(req('tok-om'));
    const holds = await authz.permissionChecker(a);
    return { hp: await authz.holdsPermission(a, 'time.approve'), pc: holds('payroll.rates.edit'), pc2: holds('time.approve') };
  });
  ok(`B2 holdsPermission and permissionChecker read the OM column too (${show(both)})`, both.hp === false && both.pc === true && both.pc2 === false);
  const rop = await withRequestCache(async () => {
    const res = fakeRes();
    return !!(await authz.requireRoleOrPermission(req('tok-om'), res, ['owner', 'admin'], 'time.approve'));
  });
  ok('B2 …and requireRoleOrPermission (a pre-matrix role list, then the key)', rop === false);
  const omcl = await gate('tok-omcl', 'payroll.rates.edit');
  const omcl2 = await gate('tok-omcl', 'time.approve');
  ok(`B3 a claim-less OM resolves role and level from their row (${omcl.code}, ${omcl2.code})`, omcl.pass && !omcl2.pass);
  // B4: the level costs no extra read — it comes off the roster resolveAuthority already read.
  world0();
  await gate('tok-om', 'payroll.rates.edit');
  const rosterReads = world.log.filter((q) => q.table === 'org_state' && /users:state->users/.test(q.cols || '')).length;
  ok(`B4 the level is read off the roster the gate already read: one roster read per request (${rosterReads})`, rosterReads === 1);
}
{
  world0([{ userId: 'u_om', grants: ['time.approve'], revokes: [] }, { userId: 'u_am', grants: [], revokes: ['clients.view'] }]);
  ok('B5 a per-person grant still wins on the server for an OM', (await gate('tok-om', 'time.approve')).pass);
  ok('B5 …and a revoke for an AM', !(await gate('tok-am', 'clients.view')).pass);
}
{
  // An unreadable level FAILS CLOSED: a key holds only where BOTH manager columns hold it. Where OMs
  // hold at least what AMs hold (the release default) that is the AM column; where the OM column was
  // pared below the AM's, it is never wider than the OM's own either.
  world0();
  world.failWhen = (q) => q.table === 'org_state' && /^users:state->users$/.test(q.cols || '');
  const omWide = await gate('tok-om', 'payroll.rates.edit');
  const omNarrow = await gate('tok-om', 'time.approve');
  const omBoth = await gate('tok-om', 'clients.view');
  ok(`B6 🔴 an unreadable level never gives an OM the OM column's extra key (${omWide.code})`, !omWide.pass);
  ok(`B6 🔴 …nor the AM column's key the OM column lacks — never wider than either (${omNarrow.code})`, !omNarrow.pass);
  ok(`B6 …a key both columns hold still holds (${omBoth.code}), and the level reads as unknown (${show(omBoth.a?.managerLevel)})`, omBoth.pass && omBoth.a?.managerLevel === null);
  const amBoth = await gate('tok-am', 'clients.view');
  const amWide = await gate('tok-am', 'payroll.rates.edit');
  ok(`B6 an AM with an unreadable level keeps what both columns hold (${amBoth.code}) and gains nothing (${amWide.code})`, amBoth.pass && !amWide.pass);
  const owner = await gate('tok-owner', 'payroll.rates.edit');
  ok('B6 …the Super Admin is untouched (no level)', owner.pass);
  // A hand-built authority (no level on it) is resolved from the roster, failing closed the same way.
  const handBuilt = await withRequestCache(async () => (await authz.permissionChecker({ orgUserId: 'u_om', role: 'manager' }))('payroll.rates.edit'));
  ok('B6 …and an authority built without the level is resolved from the roster, closed when it can\'t be read', handBuilt === false);
  world.failWhen = null;
  const handBuiltOk = await withRequestCache(async () => (await authz.permissionChecker({ orgUserId: 'u_om', role: 'manager' }))('payroll.rates.edit'));
  ok('B6 …and open to the OM column when it can', handBuiltOk === true);
}
{
  // Rows that disagree on the level (only a Super Admin can make a duplicate) are unknown too.
  world0();
  const dupWide = await gate('tok-dup', 'payroll.rates.edit');
  const dupBoth = await gate('tok-dup', 'clients.view');
  ok(`B7 🔴 two rows for one id that disagree on the level fail closed (${dupWide.code}, ${dupBoth.code})`, !dupWide.pass && dupBoth.pass);
  const lvl = fn(TS, 'managerLevelIn');
  ok('B7 teamScope managerLevelIn: the rows\' level for a manager, \'account\' with no row, null when rows disagree, the role the CLAIM\'s',
    lvl(ROSTER, { id: 'u_om', role: 'manager' }) === 'operations' && lvl(ROSTER, { id: 'u_am', role: 'manager' }) === 'account'
    && lvl(ROSTER, { id: 'u_nobody', role: 'manager' }) === 'account' && lvl(ROSTER, { id: 'u_dup', role: 'manager' }) === null
    && lvl(ROSTER, { id: 'u_om', role: 'admin' }) === 'account' && lvl(null, { id: 'u_om', role: 'manager' }) === 'account');
}
{
  // jobsGuard: a manager's job writes follow schedule.edit in THEIR column.
  const m = rowsWith(R.seedPermissions(), { 'schedule.edit': without(OM_COL) });
  const hse = fn(JG, 'holdsScheduleEdit');
  ok('B8 🔴 jobsGuard: an OM whose column lacks schedule.edit is sanitized; an AM is not',
    hse({ role: 'manager', selfId: 'u_om', managerLevel: 'operations', permissions: m, overrides: [] }) === false
    && hse({ role: 'manager', selfId: 'u_am', managerLevel: 'account', permissions: m, overrides: [] }) === true);
  ok('B8 …an unknown level (null) needs both columns', hse({ role: 'manager', selfId: 'u_am', managerLevel: null, permissions: m, overrides: [] }) === false
    && hse({ role: 'manager', selfId: 'u_am', managerLevel: null, permissions: R.seedPermissions(), overrides: [] }) === true);
  const out = await (fn(JG, 'guardJobsDelta'))({
    role: 'manager', selfId: 'u_om', managerLevel: 'operations', changed: [{ id: 'j_new', siteId: 's1', crewIds: [] }], removed: [],
    readAuthz: async () => ({ permissions: m, overrides: [] }), readRows: async () => new Map(),
  });
  ok('B8 …guardJobsDelta passes the level through (an OM pared off schedule.edit cannot create a job)', Array.isArray(out?.changed) && out.changed.length === 0);
  ok('B8 the jobs route hands the guard the caller\'s level', /managerLevel: a\.managerLevel/.test(read('api/state/jobs-delta.js')));
}
{
  // The login routes and the guard: matrixAuthority reads the caller's AND a member's column.
  const committed = { users: ROSTER, permissions: MATRIX, userPermissionOverrides: [] };
  const omAuth = TA.matrixAuthority(committed, 'manager', 'u_om');
  const amAuth = TA.matrixAuthority(committed, 'manager', 'u_am');
  ok('B9 🔴 matrixAuthority.holds reads an OM caller\'s column', omAuth.holds('payroll.rates.edit') === true && omAuth.holds('time.approve') === false
    && amAuth.holds('time.approve') === true && amAuth.holds('payroll.rates.edit') === false);
  // An Admin granted every key but payroll.rates.edit holds everything an AM holds, not an OM's.
  const adminAll = { ...committed, users: [...ROSTER, { id: 'u_admin', role: 'admin', status: 'active', email: 'a@example.test' }],
    userPermissionOverrides: [{ userId: 'u_admin', grants: KEYS.filter((k) => k !== 'payroll.rates.edit'), revokes: [] }] };
  const admin = TA.matrixAuthority(adminAll, 'admin', 'u_admin');
  ok('B9 🔴 the one-time sign-in link (CS-661): an Admin who lacks a key the OM column carries is not handed an OM\'s link',
    TA.linkHandoverRefusal({ authority: admin, callerRole: 'admin', member: { role: 'manager', ids: ['u_om'] } })?.code === 'link-withheld');
  ok('B9 …but is handed an AM\'s', TA.linkHandoverRefusal({ authority: admin, callerRole: 'admin', member: { role: 'manager', ids: ['u_am'] } }) === null);
  ok('B9 matrixAuthority.mayGiveColumn: that Admin may give the manager column, not the OM column',
    typeof admin.mayGiveColumn === 'function' && admin.mayGiveColumn('manager') === true && admin.mayGiveColumn(OM_COL) === false);
}

// ── C. the guard ─────────────────────────────────────────────────────────────────────────────
const pv = fn(G, 'protectedFieldViolations');
const U = (id, role, extra = {}) => ({ id, role, status: 'active', name: id, email: `${id}@example.test`, ...extra });
const USERS = [U('u_owner', 'owner'), U('u_admin', 'admin'), U('u_am', 'manager'), U('u_am2', 'manager', { opsManagerId: 'u_om' }), U('u_om', 'manager', { managerLevel: 'operations' }), U('u_crew', 'crew')];
const NO_PAY = { removal: { payState: { payrollLines: [], reimbursements: [], opsSettings: {} }, recentHours: new Set() } };
const ALL = (id, but = []) => ({ userId: id, grants: KEYS.filter((k) => !but.includes(k)), revokes: [] });
const state = ({ users = USERS, permissions = R.seedPermissions(), overrides = [] } = {}) => ({
  users, permissions, userPermissionOverrides: overrides, company: { timezone: 'America/New_York' }, sites: [], clients: [], timeOff: [],
});
const withUser = (s, id, patch) => ({ ...s, users: s.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) });
const roleOf = (id) => USERS.find((u) => u.id === id)?.role;
const judge = (prev, next, actor) => pv(prev, next, roleOf(actor), actor, NO_PAY) || ['(no guard)'];
const allowed = (v) => Array.isArray(v) && v.length === 0;
const refused = (v, phrase) => Array.isArray(v) && v.some((x) => (phrase ? x.includes(phrase) : true));
{
  // C1: nobody changes their own level — an AM, an OM, the Super Admin.
  const ownerFull = state({ overrides: [] });
  const amSelf = withUser(ownerFull, 'u_am', { managerLevel: 'operations' });
  ok(`C1 🔴 an AM can't set their own level (${show(judge(ownerFull, amSelf, 'u_am'))})`, refused(judge(ownerFull, amSelf, 'u_am'), 'your own'));
  const omSelf = withUser(ownerFull, 'u_om', { managerLevel: 'account' });
  ok('C1 🔴 …nor an OM theirs', refused(judge(ownerFull, omSelf, 'u_om'), 'your own'));
  const ownerSelf = withUser(state({ users: [...USERS, U('u_owner2', 'owner')] }), 'u_owner', { role: 'manager', managerLevel: 'operations' });
  ok(`C1 🔴 …nor the Super Admin (no self-made Operations Manager) (${show(judge(state({ users: [...USERS, U('u_owner2', 'owner')] }), ownerSelf, 'u_owner'))})`,
    refused(judge(state({ users: [...USERS, U('u_owner2', 'owner')] }), ownerSelf, 'u_owner'), 'your own'));
}
{
  // C2: giving the operations level takes holding everything the OM column carries.
  const prevAdminDefault = state();
  const makeOm = (prev) => withUser(prev, 'u_am', { managerLevel: 'operations' });
  ok(`C2 🔴 an Admin holding ops.edit but not every OM-column key may not make an OM (${show(judge(prevAdminDefault, makeOm(prevAdminDefault), 'u_admin'))})`,
    refused(judge(prevAdminDefault, makeOm(prevAdminDefault), 'u_admin'), 'Operations Manager'));
  const omWide = rowsWith(R.seedPermissions(), { 'payroll.rates.edit': plus(OM_COL) });
  const prevNearly = state({ permissions: omWide, overrides: [ALL('u_admin', ['payroll.rates.edit'])] });
  ok('C2 🔴 …an Admin holding every AM key but one the OM column carries is refused the level',
    refused(judge(prevNearly, makeOm(prevNearly), 'u_admin'), 'Operations Manager'));
  const prevAll = state({ permissions: omWide, overrides: [ALL('u_admin')] });
  ok(`C2 …an Admin holding everything the OM column carries (and ops.edit) may (${show(judge(prevAll, makeOm(prevAll), 'u_admin'))})`, allowed(judge(prevAll, makeOm(prevAll), 'u_admin')));
  ok('C2 …the Super Admin may', allowed(judge(prevNearly, makeOm(prevNearly), 'u_owner')));
  const hire = (prev, actor) => judge(prev, { ...prev, users: [...prev.users, U('u_new', 'manager', { managerLevel: 'operations' })] }, actor);
  ok('C2 🔴 the same for a NEW member arriving at the operations level', refused(hire(prevNearly, 'u_admin'), 'Operations Manager') && allowed(hire(prevAll, 'u_admin')));
  // Moving between levels the other way takes holding the target (AM) column.
  const amWide = rowsWith(R.seedPermissions(), { 'payroll.rates.edit': plus('manager') });
  const prevDemote = state({ permissions: amWide, overrides: [ALL('u_admin', ['payroll.rates.edit'])] });
  const demote = withUser(prevDemote, 'u_om', { managerLevel: 'account' });
  ok(`C2 🔴 demoting an OM to AM takes holding the AM column (${show(judge(prevDemote, demote, 'u_admin'))})`, refused(judge(prevDemote, demote, 'u_admin'), "Operations Manager's level"));
  const prevDemoteAll = state({ permissions: amWide, overrides: [ALL('u_admin')] });
  ok('C2 …and holding it, an Admin with ops.edit may', allowed(judge(prevDemoteAll, withUser(prevDemoteAll, 'u_om', { managerLevel: 'account' }), 'u_admin')));
  ok('C2 the cascade stays: demoting an OM by the owner, their AMs\' pointers cleared in the same save, is accepted',
    allowed(judge(state(), withUser(withUser(state(), 'u_om', { managerLevel: 'account' }), 'u_am2', { opsManagerId: null }), 'u_owner')));
}
{
  // C3 + C4: rows naming the OM column.
  const mgrPrev = state({ overrides: [] });
  const keep = { ...mgrPrev, permissions: rowsWith(mgrPrev.permissions, { 'clients.view': without('crew') }) };
  ok(`C3 a matrix save (an AM holding settings.roles.edit) that keeps rows naming operations_manager is accepted (${show(judge(mgrPrev, keep, 'u_am'))})`, allowed(judge(mgrPrev, keep, 'u_am')));
  const reduceOm = { ...mgrPrev, permissions: rowsWith(mgrPrev.permissions, { 'quotes.view': without(OM_COL) }) };
  ok('C3 …switching the OM column OFF is free, like the manager\'s (no floor)', allowed(judge(mgrPrev, reduceOm, 'u_am')));
  const oldMatrix = R.seedPermissions().map((p) => ({ ...p, roles: p.roles.filter((r) => r !== OM_COL) }));
  const opPrev = state({ permissions: oldMatrix });
  const opNext = { ...opPrev, permissions: rowsWith(oldMatrix, { 'quotes.view': plus(OM_COL) }) };
  ok('C3 …and a holder switching it ON for a key they hold is accepted', allowed(judge(opPrev, opNext, 'u_am')));
  const paredPrev = state({ overrides: [{ userId: 'u_am', grants: [], revokes: ['quotes.delete'] }], permissions: oldMatrix });
  const sneak = { ...paredPrev, permissions: rowsWith(oldMatrix, { 'quotes.delete': plus(OM_COL) }) };
  ok(`C4 🔴 a non-holder can't switch the OM column on (${show(judge(paredPrev, sneak, 'u_am'))})`, refused(judge(paredPrev, sneak, 'u_am'), 'quotes.delete'));
  ok('C4 canGrantPermission treats a cell in the OM column like any role column (the caller must hold the key)',
    R.canGrantPermission({ id: 'u_am', role: 'manager' }, 'quotes.delete', oldMatrix, [{ userId: 'u_am', grants: [], revokes: ['quotes.delete'] }]) === false);
  // The OM caller's own matrix edits read THEIR column: an OM whose column lacks a key can't grant it.
  const omPrev = state({ permissions: rowsWith(R.seedPermissions(), { 'quotes.send': without(OM_COL) }) });
  const omGrant = { ...omPrev, permissions: rowsWith(omPrev.permissions, { 'quotes.send': plus('crew') }) };
  ok(`C4 🔴 an OM is judged on the OM column: no granting a key their column lacks (${show(judge(omPrev, omGrant, 'u_om'))})`, refused(judge(omPrev, omGrant, 'u_om'), 'quotes.send'));
}

// ── D. the Team screens offer only what the guard accepts ────────────────────────────────────
{
  const choices = (actor, permissions, overrides, target) => (fn(TL, 'roleChoices')(actor, permissions, overrides, target) || []).map((c) => c.value);
  const seed = R.seedPermissions();
  const admin = { id: 'u_admin', role: 'admin' };
  // An Admin who may give the Manager role (every AM key) and holds ops.edit, but lacks one key
  // the OM column carries: before CS-858 the picker offered them Operations Manager, which the
  // guard now refuses (a refused save drops the whole batch, store/sync.js).
  const omWideD = rowsWith(seed, { 'payroll.rates.edit': plus(OM_COL) });
  const nearly = [ALL('u_admin', ['payroll.rates.edit'])];
  ok(`D1 🔴 an Admin who may give the Manager role but lacks a key the OM column carries is not offered Operations Manager (${show(choices(admin, omWideD, nearly))})`,
    choices(admin, omWideD, nearly).includes('manager') && !choices(admin, omWideD, nearly).includes('manager:operations'));
  ok('D1 …offered it once they hold everything it carries', choices(admin, omWideD, [ALL('u_admin')]).includes('manager:operations'));
  ok('D1 the Super Admin is offered all six', show(choices({ id: 'o', role: 'owner' }, seed, [])) === show(['owner', 'admin', 'manager', 'manager:operations', 'supply_manager', 'crew']));
  const mgr = { id: 'u_am', role: 'manager' };
  ok('D2 🔴 for an OM\'s page, someone who may not change the level is not offered Account Manager', !choices(mgr, seed, [], USERS[4]).includes('manager'));
  ok('D2 …and for an AM\'s page, not Operations Manager', !choices(mgr, seed, [], USERS[2]).includes('manager:operations') && choices(mgr, seed, [], USERS[2]).includes('manager'));
  ok('D2 …the owner is offered both levels on an OM\'s page', choices({ id: 'o', role: 'owner' }, seed, [], USERS[4]).includes('manager'));
  const mgl = fn(TL, 'mayGiveLevel');
  ok('D3 mayGiveLevel: owner / admin + ops.edit AND the target column held',
    mgl({ id: 'o', role: 'owner' }, 'operations', seed, []) === true && mgl(admin, 'operations', seed, []) === false
    && mgl(admin, 'operations', seed, [ALL('u_admin')]) === true && mgl(mgr, 'operations', seed, []) === false);
  const td = read('src/pages/settings/TeamDetail.jsx');
  ok('D4 TeamDetail asks roleChoices for THIS member (the level rule lives in teamLimits, not a second filter)',
    /const choices = roleChoices\(currentUser, permissions, overrides, user\);/.test(td) && !/c\.level === managerLevelOf\(user\)/.test(td));
}

// ── G. TeamDetail's Access tab reads a member's column ───────────────────────────────────────
{
  const td = read('src/pages/settings/TeamDetail.jsx');
  ok('G1 🔴 TeamDetail reads every "role default" through columnHolds (no perm.roles.includes(user.role) left)',
    (td.match(/columnHolds\(user, /g) || []).length >= 3 && !/\.roles\.includes\(user\.role\)/.test(td) && !/defaultRoles \|\| \[\]\)\.includes\(user\.role\)/.test(td));
}

console.log(`\ntest-om-permission-column: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
