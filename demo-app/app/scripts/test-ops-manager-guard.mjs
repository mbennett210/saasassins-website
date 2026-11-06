// S131 (plan 2026-10-14 §0, brief R Part 2) — who may build an Operations Manager's team, and
// the cascades that keep it truthful. The server half is api/_lib/orgStateGuard.js; the write
// point is the reducer (UPDATE_USER, DELETE_USER through lib/deleteCascade).
//
//   1. `users[].managerLevel` and `users[].opsManagerId` are AUTHORITY: they decide whose
//      buildings an OM approves time for. Only owner / admin holding `ops.edit` may change them —
//      the same rule as assigning a building's manager (`client.supervisorId`). A manager, an OM
//      included, is refused; so is an admin pared off ops.edit. Both are in the save fingerprint,
//      or the check silently never runs. Since CS-858 the level also picks a permission column,
//      so a level change takes holding that column too (test-om-permission-column.mjs C).
//   2. A pointer must be valid, for EVERY caller (data integrity, like the employee ID): on an
//      account manager, at an ACTIVE operations manager, never yourself.
//   3. Daniel (2026-10-14): an OM moves buildings between their AMs. The guard lets an OM change
//      a building's supervisorId only from one member of their team to another (judged on the
//      COMMITTED team), with ops.edit; owner / admin keep today's rule; an AM keeps today's
//      refusal.
//   4. The cascades: removing an OM, demoting them (level or role) clears their AMs' pointers in
//      the same save — and that clear is authority-neutral, so a member removal or a role change
//      by someone who may make it is never refused for the cascade it carries.
//   5. The fingerprint of a roster that carries neither field is UNCHANGED by this build (golden
//      digest from the base tree 046b3f8c): no baseline alarm on the deploy.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying.
// Offline. Run: node scripts/test-ops-manager-guard.mjs
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const show = (v) => JSON.stringify(v);

const R = await import('../src/lib/roles.js');
const G = await import('../api/_lib/orgStateGuard.js');
const { reducer, ACTIONS } = await import('../src/store/reducer.js');
const { INITIAL_STATE } = await import('../src/data/seed.js');
const DC = await import('../src/lib/deleteCascade.js');
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
const pv = fn(G, 'protectedFieldViolations');
const fp = fn(G, 'protectedFingerprint');

// ── the roster ──────────────────────────────────────────────────────────────────────────────
const U = (id, role, extra = {}) => ({ id, role, status: 'active', name: id, email: `${id}@example.test`, ...extra });
const USERS = [
  U('u_owner', 'owner'),
  U('u_admin', 'admin'),
  U('u_admin_x', 'admin'),                                   // pared off ops.edit
  U('u_mgr', 'manager'),                                     // an AM with every manager key
  U('u_om', 'manager', { managerLevel: 'operations' }),
  U('u_am1', 'manager', { opsManagerId: 'u_om' }),
  U('u_am2', 'manager', { opsManagerId: 'u_om' }),
  U('u_am4', 'manager'),                                     // no OM
  U('u_om_off', 'manager', { managerLevel: 'operations', status: 'disabled' }),
  U('u_crew', 'crew'),
];
const CLIENTS = [
  { id: 'cl_om', name: 'OM own', supervisorId: 'u_om' },
  { id: 'cl_a1', name: 'A1', supervisorId: 'u_am1' },
  { id: 'cl_a2', name: 'A2', supervisorId: 'u_am2' },
  { id: 'cl_a4', name: 'A4', supervisorId: 'u_am4' },
  { id: 'cl_none', name: 'Nobody' },
];
const OVERRIDES = [{ userId: 'u_admin_x', grants: [], revokes: ['ops.edit'] }];
const base = (patch = {}) => ({
  users: USERS, permissions: R.seedPermissions(), userPermissionOverrides: OVERRIDES,
  company: { timezone: 'America/New_York' }, sites: [], clients: CLIENTS, timeOff: [], ...patch,
});
const NO_PAY = { removal: { payState: { payrollLines: [], reimbursements: [], opsSettings: {} }, recentHours: new Set() } };
const withUser = (state, id, patch) => ({ ...state, users: state.users.map((u) => (u.id === id ? { ...u, ...patch } : u)) });
const withClient = (state, id, patch) => ({ ...state, clients: state.clients.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
const roleOf = (id) => USERS.find((u) => u.id === id)?.role;
const judge = (next, actor, prev = base()) => pv(prev, next, roleOf(actor), actor, NO_PAY) || ['(no guard)'];
const allowed = (v) => Array.isArray(v) && v.length === 0;
const refused = (v, phrase) => Array.isArray(v) && v.some((x) => (phrase ? x.includes(phrase) : true));

// ── 1. who may set the level and the pointer ────────────────────────────────────────────────
{
  const makeOm = withUser(base(), 'u_am4', { managerLevel: 'operations' });
  ok('the owner may make an account manager an Operations Manager', allowed(judge(makeOm, 'u_owner')));
  // CS-858: the level picks a permission column, so giving it also takes holding everything the OM
  // column carries (canGiveRole's rule) — by default an Admin lacks the money keys (Q24), so only an
  // Admin who holds them all may (the full rule: test-om-permission-column.mjs C2).
  ok(`🔴 an admin holding ops.edit but not every key the OM column carries may not (${show(judge(makeOm, 'u_admin'))})`, refused(judge(makeOm, 'u_admin'), 'Operations Manager'));
  const adminAllKeys = { ...base(), userPermissionOverrides: [...OVERRIDES, { userId: 'u_admin', grants: Object.keys(R.PERMISSIONS), revokes: [] }] };
  ok('an admin holding ops.edit and every key the OM column carries may', allowed(judge(withUser(adminAllKeys, 'u_am4', { managerLevel: 'operations' }), 'u_admin', adminAllKeys)));
  ok(`🔴 an admin pared off ops.edit may not (${show(judge(makeOm, 'u_admin_x'))})`, refused(judge(makeOm, 'u_admin_x'), 'Operations Manager'));
  ok(`🔴 a manager may not, even holding every manager key (${show(judge(makeOm, 'u_mgr'))})`, refused(judge(makeOm, 'u_mgr'), 'Operations Manager'));
  ok('🔴 an OM may not make another OM', refused(judge(makeOm, 'u_om')));
  const demote = withUser(base(), 'u_om', { managerLevel: 'account' });
  ok('the owner may demote an OM to account level', allowed(judge(demote, 'u_owner')));
  ok('🔴 a manager may not demote an OM by the level', refused(judge(demote, 'u_mgr')));
  ok('🔴 an OM may not demote themselves', refused(judge(demote, 'u_om')));

  const point = withUser(base(), 'u_am4', { opsManagerId: 'u_om' });
  ok('the owner may assign an account manager to an OM', allowed(judge(point, 'u_owner')));
  ok('an admin holding ops.edit may too', allowed(judge(point, 'u_admin')));
  ok('🔴 an admin pared off ops.edit may not', refused(judge(point, 'u_admin_x')));
  ok(`🔴 a manager may not (${show(judge(point, 'u_mgr'))})`, refused(judge(point, 'u_mgr'), 'reports to'));
  ok('🔴 the OM may not pull an AM onto their own team', refused(judge(point, 'u_om')));
  const unpoint = withUser(base(), 'u_am1', { opsManagerId: null });
  ok('🔴 a manager may not take an AM off a team either', refused(judge(unpoint, 'u_mgr')));
  ok('the owner may take an AM off a team', allowed(judge(unpoint, 'u_owner')));

  // A normalized read: a missing level and an explicit 'account' are the same value.
  const explicit = withUser(base(), 'u_am4', { managerLevel: 'account' });
  ok('writing the default level (account) is no change at all, for anyone', allowed(judge(explicit, 'u_mgr')));
}

// ── 2. a pointer must be valid — for every caller ────────────────────────────────────────────
{
  const bad = (id, patch) => judge(withUser(base(), id, patch), 'u_owner');
  ok(`🔴 not at someone who is not an OM (${show(bad('u_am4', { opsManagerId: 'u_mgr' }))})`, refused(bad('u_am4', { opsManagerId: 'u_mgr' }), 'not an active Operations Manager'));
  ok('🔴 not at a disabled OM', refused(bad('u_am4', { opsManagerId: 'u_om_off' })));
  ok('🔴 not at yourself', refused(bad('u_om', { opsManagerId: 'u_om' })));
  ok('🔴 not on a crew row', refused(bad('u_crew', { opsManagerId: 'u_om' })));
  ok('🔴 not on an OM\'s own row (an OM reports to no OM)', refused(bad('u_om', { opsManagerId: 'u_am1' })));
  ok('🔴 not at someone gone from the roster', refused(bad('u_am4', { opsManagerId: 'u_ghost' })));
  // A NEW member: the invite form may set the level; only owner / admin + ops.edit may.
  const hire = (actor, extra) => judge({ ...base(), users: [...USERS, U('u_new', 'manager', extra)] }, actor);
  ok('a new Account Manager may be added by a manager (settings.team.edit), as before', allowed(hire('u_mgr', {})));
  ok('🔴 a new Operations Manager may not be added by a manager', refused(hire('u_mgr', { managerLevel: 'operations' })));
  // An admin gives the Manager role only holding everything it carries (canGiveRole): with every key
  // granted, the level rule is what decides — and it lets an admin holding ops.edit set it.
  const adminAll = { ...base(), userPermissionOverrides: [...OVERRIDES, { userId: 'u_admin', grants: Object.keys(R.PERMISSIONS), revokes: [] }] };
  const hireAs = (prev, actor, extra) => judge({ ...prev, users: [...USERS, U('u_new', 'manager', extra)] }, actor, prev);
  ok('a new Operations Manager may be added by the owner, or by an admin who may give the role and holds ops.edit',
    allowed(hire('u_owner', { managerLevel: 'operations' })) && allowed(hireAs(adminAll, 'u_admin', { managerLevel: 'operations' })));
  ok('🔴 a new member may not arrive already on a team, unless owner / admin + ops.edit', refused(hire('u_mgr', { opsManagerId: 'u_om' }))
    && allowed(hire('u_owner', { opsManagerId: 'u_om' })));
  // A role change that would make someone an OM through a stale level is the level rule's too.
  const stale = { ...base(), users: USERS.map((u) => (u.id === 'u_crew' ? { ...u, managerLevel: 'operations' } : u)) };
  const promote = withUser(stale, 'u_crew', { role: 'manager' });
  ok('🔴 promoting a row that carries a stale operations level is making an OM (owner / admin + ops.edit)',
    refused(judge(promote, 'u_mgr', stale)) && allowed(judge(promote, 'u_owner', stale)));
}

// ── 3. an OM moves buildings between their AMs ───────────────────────────────────────────────
{
  const move = (clientId, to) => withClient(base(), clientId, { supervisorId: to });
  ok('an OM moves a building from one of their AMs to another', allowed(judge(move('cl_a1', 'u_am2'), 'u_om')));
  ok('…or to themselves, or from themselves', allowed(judge(move('cl_a1', 'u_om'), 'u_om')) && allowed(judge(move('cl_om', 'u_am1'), 'u_om')));
  ok(`🔴 …never to a manager outside the team (${show(judge(move('cl_a1', 'u_am4'), 'u_om'))})`, refused(judge(move('cl_a1', 'u_am4'), 'u_om'), "location's manager"));
  ok('🔴 …never from outside the team', refused(judge(move('cl_a4', 'u_am1'), 'u_om')));
  ok('🔴 …never to nobody (an unassigned building is the office\'s to give)', refused(judge(move('cl_a1', null), 'u_om')));
  ok('🔴 …never an unassigned building onto the team', refused(judge(move('cl_none', 'u_am1'), 'u_om')));
  // The committed team decides, never the proposed one: adding an AM and moving a building onto
  // them in one save is refused (the owner adds them first).
  const sneak = withClient(withUser(base(), 'u_am4', { opsManagerId: 'u_om' }), 'cl_a1', { supervisorId: 'u_am4' });
  ok('🔴 the team is the COMMITTED one: no same-save pull-and-move', refused(judge(sneak, 'u_om')));
  const om = { ...base(), userPermissionOverrides: [...OVERRIDES, { userId: 'u_om', grants: [], revokes: ['ops.edit'] }] };
  ok('🔴 an OM pared off ops.edit may not move buildings', refused(judge(withClient(om, 'cl_a1', { supervisorId: 'u_am2' }), 'u_om', om)));
  ok('🔴 an account manager keeps today\'s refusal', refused(judge(move('cl_a1', 'u_am2'), 'u_am1')));
  ok('owner / admin keep the full rule', allowed(judge(move('cl_a4', 'u_am1'), 'u_owner')) && allowed(judge(move('cl_none', 'u_am4'), 'u_admin')));
}

// ── 4. the cascades, through the real reducer ────────────────────────────────────────────────
{
  const state = {
    ...INITIAL_STATE, users: USERS, clients: CLIENTS, permissions: R.seedPermissions(), userPermissionOverrides: OVERRIDES,
    payrollLines: [], reimbursements: [], timeOff: [], jobs: [], notifications: [],
  };
  const removed = reducer(state, { type: ACTIONS.DELETE_USER, id: 'u_om' });
  const ptr = (s, id) => s.users.find((u) => u.id === id)?.opsManagerId ?? null;
  ok('removing an OM clears their AMs\' pointers', !removed.users.some((u) => u.id === 'u_om') && ptr(removed, 'u_am1') === null && ptr(removed, 'u_am2') === null);
  ok('…and nobody else\'s', ptr(removed, 'u_am4') === null && removed.users.length === USERS.length - 1);
  ok('the pure rule lives in lib/deleteCascade (clearOpsManagerPointers)', typeof DC.clearOpsManagerPointers === 'function'
    && show(DC.clearOpsManagerPointers(USERS, 'u_om').filter((u) => u.opsManagerId).map((u) => u.id)) === show([]));
  const mgrRemoves = pv(base(), { ...base(), users: removed.users, clients: removed.clients }, 'manager', 'u_mgr', NO_PAY);
  ok(`a manager removing an OM (settings.team.edit) is not refused for the pointer clears the removal carries (${show(mgrRemoves)})`,
    Array.isArray(mgrRemoves) && !mgrRemoves.some((v) => /reports to|Operations Manager/.test(v)));

  const demoted = reducer(state, { type: ACTIONS.UPDATE_USER, id: 'u_om', patch: { managerLevel: 'account' } });
  ok('demoting an OM (level → account) clears their AMs\' pointers', ptr(demoted, 'u_am1') === null && ptr(demoted, 'u_am2') === null);
  ok('the owner\'s demotion save is accepted, cascade included', allowed(pv(base(), { ...base(), users: demoted.users }, 'owner', 'u_owner', NO_PAY)));

  const recrewed = reducer(state, { type: ACTIONS.UPDATE_USER, id: 'u_om', patch: { role: 'crew' } });
  ok('a role change away from manager clears the AMs\' pointers and the person\'s own level',
    ptr(recrewed, 'u_am1') === null && !recrewed.users.find((u) => u.id === 'u_om')?.managerLevel);
  const mgrRecrews = pv(base(), { ...base(), users: recrewed.users }, 'manager', 'u_mgr', NO_PAY);
  ok(`a manager holding staff.assignRoles may make that role change; the cascade is neutral (${show(mgrRecrews)})`, allowed(mgrRecrews));

  const promoted = reducer(state, { type: ACTIONS.UPDATE_USER, id: 'u_am1', patch: { managerLevel: 'operations' } });
  ok('an AM made an OM leaves their own OM (an OM reports to no OM)', ptr(promoted, 'u_am1') === null
    && promoted.users.find((u) => u.id === 'u_am1')?.managerLevel === 'operations');

  const invalid = reducer(state, { type: ACTIONS.UPDATE_USER, id: 'u_am4', patch: { opsManagerId: 'u_mgr' } });
  ok('🔴 the write point ignores a pointer at someone who is not an active OM', ptr(invalid, 'u_am4') === null);
  const self = reducer(state, { type: ACTIONS.UPDATE_USER, id: 'u_om', patch: { opsManagerId: 'u_om' } });
  ok('🔴 …or at yourself', ptr(self, 'u_om') === null);
  const good = reducer(state, { type: ACTIONS.UPDATE_USER, id: 'u_am4', patch: { opsManagerId: 'u_om' } });
  ok('a valid pointer lands', ptr(good, 'u_am4') === 'u_om');
}

// ── 5. the fingerprint ───────────────────────────────────────────────────────────────────────
{
  // Computed on the base tree for this exact state: a roster that carries neither field digests
  // exactly as before, so the deploy raises no org_state.baseline_mismatch. Re-pinned 2026-10-20
  // (was 20113fd7…, from 046b3f8c) when the `reviews` position left the digest with Google reviews:
  // that one deploy raises ONE baseline_mismatch per org by design (api/_lib/orgStateGuard.js).
  const GOLDEN = '46e4698f5fce9e68995a1dfc57166fc974b15a4d6b0a9b408d5e120675a01d93';
  const plain = {
    users: [
      { id: 'u_owner', role: 'owner', status: 'active', email: 'o@example.test' },
      { id: 'u_mgr', role: 'manager', status: 'active', email: 'm@example.test', pay: { type: 'salary' } },
      { id: 'u_crew', role: 'crew', status: 'active', email: 'c@example.test' },
    ],
    permissions: [{ id: 'ops.edit', roles: ['owner', 'admin', 'manager'] }],
    userPermissionOverrides: [],
    clients: [{ id: 'cl_1', name: 'One', supervisorId: 'u_mgr' }, { id: 'cl_2', name: 'Two' }],
    sites: [{ id: 'st_1', clientId: 'cl_1' }],
    company: { timezone: 'America/New_York' },
  };
  ok('a roster carrying neither field digests exactly as before this build (no baseline alarm)', fp(plain) === GOLDEN);
  const lvl = { ...plain, users: plain.users.map((u) => (u.id === 'u_mgr' ? { ...u, managerLevel: 'operations' } : u)) };
  ok('🔴 a level change moves the digest (else the check silently never runs)', fp(lvl) !== fp(plain));
  const p1 = { ...plain, users: [...plain.users, { id: 'u_am', role: 'manager', status: 'active', email: 'a@example.test', opsManagerId: 'u_mgr' }] };
  const p2 = { ...p1, users: p1.users.map((u) => (u.id === 'u_am' ? { ...u, opsManagerId: null } : u)) };
  ok('🔴 a pointer change moves the digest', fp(p1) !== fp(p2));
}

console.log(`\ntest-ops-manager-guard: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
