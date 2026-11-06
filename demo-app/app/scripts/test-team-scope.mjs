// S131 (plan 2026-10-14 §0, brief R Part 2) — the OPERATIONS MANAGER's team scope.
//
// An Operations Manager is the Manager role at the "operations" level (`users[].managerLevel`),
// with account managers pointing at them (`users[].opsManagerId`). Their scope is "my team": the
// OM's own buildings plus every building whose supervisor is one of their active AMs. ONE pure
// helper module, lib/teamScope.js, decides it for the client AND the server, so no screen and no
// route can disagree:
//   1. the helpers: isOpsManager, teamMemberIds, teamClientIds, opsManagerOf (the contract S and
//      the Wave 2 builders rely on), and the edges (a disabled AM, a crew row's stray pointer,
//      another OM's AM, a pointer at someone who is not an OM);
//   2. every scope site, an AM still reading only their own buildings:
//        lib/managerHome homeScope (+ the "All my team / AM" picker; the owner's ?view=ops) and the
//        today engine — ONE resolver for both (the split-scope trap, NEW-CANDIDATE);
//        lib/timeRules timeScopeFor (client + server: api/time), lib/managerFilter (an OM opens on
//        `team`), the today kit's filter, the Client Requests list, Messaging → Customers, the qc
//        reads (`supervisorId=team`), the P&L and the activity log, all resolved from the CLAIM;
//   3. server-enforced time: the real api/time handler, driven offline through fake-supabase —
//      an OM approves a punch at an AM's building, an AM still cannot, nobody reaches outside.
//
// Imports are dynamic where the module is new, so the pre-change tree reports each check as
// failed instead of dying on the first missing export. Offline. Run: node scripts/test-team-scope.mjs
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const show = (v) => JSON.stringify(v);
const sorted = (x) => [...(x || [])].sort();

const TS = await import('../src/lib/teamScope.js').catch(() => ({}));
const TR = await import('../src/lib/timeRules.js');
const MH = await import('../src/lib/managerHome.js').catch(() => ({}));
const MT = await import('../src/lib/managerToday.js');
const MF = await import('../src/lib/managerFilter.js');
const CR = await import('../src/lib/clientRequests.js');
const HM = await import('../src/lib/hubMessages.js');
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);

// ── the team ─────────────────────────────────────────────────────────────────────────────────
const users = [
  { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner' },
  { id: 'u_admin', role: 'admin', status: 'active', name: 'Adam Admin' },
  { id: 'u_om', role: 'manager', managerLevel: 'operations', status: 'active', name: 'Omar Ops' },
  { id: 'u_am1', role: 'manager', status: 'active', opsManagerId: 'u_om', name: 'Ana Account' },
  { id: 'u_am2', role: 'manager', managerLevel: 'account', status: 'active', opsManagerId: 'u_om', name: 'Ben Account' },
  { id: 'u_am3', role: 'manager', status: 'disabled', opsManagerId: 'u_om', name: 'Cal Gone' },
  { id: 'u_am4', role: 'manager', status: 'active', name: 'Dee Solo' },
  { id: 'u_om2', role: 'manager', managerLevel: 'operations', status: 'active', name: 'Ola Other' },
  { id: 'u_am5', role: 'manager', status: 'active', opsManagerId: 'u_om2', name: 'Eve Other' },
  { id: 'u_am6', role: 'manager', status: 'active', opsManagerId: 'u_am4', name: 'Fay Pointer' }, // points at an AM
  { id: 'u_crew', role: 'crew', status: 'active', opsManagerId: 'u_om', managerLevel: 'operations', name: 'Gus Crew' },
  { id: 'u_sm', role: 'supply_manager', status: 'active', name: 'Sam Supply' },
];
const clients = [
  { id: 'cl_om', name: 'OM own', supervisorId: 'u_om' },
  { id: 'cl_a1', name: 'A1', supervisorId: 'u_am1' },
  { id: 'cl_a1b', name: 'A1b', supervisorId: 'u_am1' },
  { id: 'cl_a2', name: 'A2', supervisorId: 'u_am2' },
  { id: 'cl_a3', name: 'A3', supervisorId: 'u_am3' },
  { id: 'cl_a4', name: 'A4', supervisorId: 'u_am4' },
  { id: 'cl_a5', name: 'A5', supervisorId: 'u_am5' },
  { id: 'cl_a6', name: 'A6', supervisorId: 'u_am6' },
  { id: 'cl_none', name: 'Nobody' },
];
const TEAM = ['cl_a1', 'cl_a1b', 'cl_a2', 'cl_om'];
const row = (id) => users.find((u) => u.id === id);

// ── 1. the helpers (the contract) ────────────────────────────────────────────────────────────
{
  const isOM = fn(TS, 'isOpsManager');
  ok('isOpsManager: a manager at the operations level', isOM(row('u_om')) === true && isOM(row('u_om2')) === true);
  ok('isOpsManager: an account manager, a missing level, a crew row or an owner carrying the level are not',
    isOM(row('u_am1')) === false && isOM(row('u_am2')) === false && isOM(row('u_crew')) === false
    && isOM({ role: 'owner', managerLevel: 'operations' }) === false && isOM(null) === false);
  ok("managerLevelOf: missing reads 'account'; it only means something for role manager",
    fn(TS, 'managerLevelOf')(row('u_am1')) === 'account' && fn(TS, 'managerLevelOf')(row('u_om')) === 'operations'
    && fn(TS, 'managerLevelOf')(row('u_crew')) === 'account');
  const members = fn(TS, 'teamMemberIds')(users, 'u_om') || [];
  ok(`teamMemberIds: the OM first, then their ACTIVE account managers (${show(members)})`,
    members[0] === 'u_om' && show(sorted(members)) === show(['u_am1', 'u_am2', 'u_om']));
  ok('…never a disabled AM, a crew row with a stray pointer, or another OM\'s AM',
    !members.includes('u_am3') && !members.includes('u_crew') && !members.includes('u_am5'));
  ok('teamMemberIds of someone who is not an OM is just them (a team of one)',
    show(fn(TS, 'teamMemberIds')(users, 'u_am4')) === show(['u_am4']) && show(fn(TS, 'teamMemberIds')(users, 'u_crew')) === show(['u_crew']));
  const tc = fn(TS, 'teamClientIds');
  ok(`teamClientIds: the OM's own buildings plus their AMs' (${show(sorted(tc(users, clients, 'u_om')))})`,
    tc(users, clients, 'u_om') instanceof Set && show(sorted(tc(users, clients, 'u_om'))) === show(TEAM));
  ok('teamClientIds for an account manager: only their own buildings',
    show(sorted(tc(users, clients, 'u_am1'))) === show(['cl_a1', 'cl_a1b']) && show(sorted(tc(users, clients, 'u_om2'))) === show(['cl_a5']));
  ok('teamClientIds of an unknown id, or nobody: empty (never "everything")', tc(users, clients, 'u_ghost')?.size === 0 && tc(users, clients, null)?.size === 0);
  const of = fn(TS, 'opsManagerOf');
  ok('opsManagerOf: the active OM an AM reports to', of(users, 'u_am1')?.id === 'u_om' && of(users, 'u_am5')?.id === 'u_om2');
  ok('opsManagerOf: none for an AM with no OM, a pointer at someone who is not an OM, or the OM themselves',
    of(users, 'u_am4') === null && of(users, 'u_am6') === null && of(users, 'u_om') === null);
  const disabledOm = users.map((u) => (u.id === 'u_om' ? { ...u, status: 'disabled' } : u));
  ok('a disabled OM leads no team: opsManagerOf null, no members but themselves', of(disabledOm, 'u_am1') === null
    && show(fn(TS, 'teamMemberIds')(disabledOm, 'u_om')) === show(['u_om']));
  ok('seesTeamPages: owner, admin and an OM — never an AM, a supply manager or crew',
    ['u_owner', 'u_admin', 'u_om'].every((id) => fn(TS, 'seesTeamPages')(row(id)) === true)
    && ['u_am1', 'u_sm', 'u_crew'].every((id) => fn(TS, 'seesTeamPages')(row(id)) === false));
}

// ── 2. the scope sites ───────────────────────────────────────────────────────────────────────
// timeScopeFor — the time scope the client AND api/time read. The ROLE comes from the claim
// (the user passed in); the level from the committed roster (`users`).
{
  const scope = (u) => TR.timeScopeFor(u, clients, users);
  ok(`timeScopeFor: an OM's scope is their team (${show(sorted(scope({ id: 'u_om', role: 'manager' })))})`,
    show(sorted(scope({ id: 'u_om', role: 'manager' }))) === show(TEAM));
  ok('timeScopeFor: an AM still reads only their own buildings', show(sorted(scope({ id: 'u_am1', role: 'manager' }))) === show(['cl_a1', 'cl_a1b']));
  ok('timeScopeFor: owner / admin stay unscoped (null)', scope({ id: 'u_owner', role: 'owner' }) === null && scope({ id: 'u_admin', role: 'admin' }) === null);
  ok('🔴 timeScopeFor: a CLAIM that is not manager never gets a team, whatever the roster row says',
    show(sorted(scope({ id: 'u_om', role: 'crew' }))) === show(['cl_om']) && scope({ id: 'u_crew', role: 'crew' }).size === 0);
  ok('timeScopeFor without a roster (an old caller) stays the own-buildings rule', show(sorted(TR.timeScopeFor({ id: 'u_om', role: 'manager' }, clients))) === show(['cl_om']));
}
// homeScope + the today engine: ONE resolver (lib/managerHome resolveManagerScope).
{
  const hs = fn(MH, 'homeScope');
  const om = hs({ viewer: row('u_om'), mgrParam: '', clients, users }) || {};
  ok(`homeScope: an OM's Home covers the team, with a picker (${show(om.clientIds && sorted(om.clientIds))})`,
    om.clientIds instanceof Set && show(sorted(om.clientIds)) === show(TEAM) && om.picker === true && om.propertyCount === 4 && om.mgrId === null);
  const omA = hs({ viewer: row('u_om'), mgrParam: 'u_am1', clients, users }) || {};
  ok('…the picker narrows to one AM of the team', omA.mgrId === 'u_am1' && show(sorted(omA.clientIds)) === show(['cl_a1', 'cl_a1b']));
  const omOut = hs({ viewer: row('u_om'), mgrParam: 'u_am4', clients, users }) || {};
  ok('…a pick outside the team is the whole team, never another manager\'s book', show(sorted(omOut.clientIds)) === show(TEAM) && omOut.mgrId === null);
  const omTeam = hs({ viewer: row('u_om'), mgrParam: 'team', clients, users }) || {};
  ok('…`team` is the whole team', show(sorted(omTeam.clientIds)) === show(TEAM));
  const am = hs({ viewer: row('u_am1'), mgrParam: 'u_am2', clients, users }) || {};
  ok('homeScope: an AM reads their own buildings, no picker', am.mgrId === 'u_am1' && show(sorted(am.clientIds)) === show(['cl_a1', 'cl_a1b']) && am.picker === false);
  const sm = hs({ viewer: row('u_sm'), mgrParam: '', clients, users }) || {};
  ok('🔴 homeScope: any other role reads its own (empty) book — the same answer the today engine gives (the split-scope trap)',
    sm.clientIds instanceof Set && sm.clientIds.size === 0 && sm.picker === false);
  const ops = hs({ viewer: row('u_owner'), mgrParam: '', clients, users, opsManagerId: 'u_om' }) || {};
  ok('the owner\'s Operations view (?view=ops) is that OM\'s Home: their team, the team picker', show(sorted(ops.clientIds)) === show(TEAM) && ops.picker === true);
  const own = hs({ viewer: row('u_owner'), mgrParam: '', clients, users }) || {};
  ok('the owner\'s Manager view is unchanged: All managers, unscoped', own.clientIds === null && own.mgrId === null && own.picker === true);
  const none = hs({ viewer: row('u_owner'), mgrParam: 'none', clients, users }) || {};
  ok('`none` means the buildings with no manager, as the today engine reads it', show(sorted(none.clientIds)) === show(['cl_none']));

  const rs = fn(MH, 'resolveManagerScope');
  const today = (viewer, mgrParam, extra = {}) => rs({ viewer, users, mgrParam, ...extra }) || {};
  ok('resolveManagerScope (the today engine\'s rule): an OM → the team\'s managers', show(sorted(today(row('u_om'), '').managerIds)) === show(['u_am1', 'u_am2', 'u_om']));
  ok('…an AM → themselves; a supply manager → themselves (never "every building")',
    show(today(row('u_am1'), 'u_om').managerIds) === show(['u_am1']) && show(today(row('u_sm'), '').managerIds) === show(['u_sm']));
  ok('…the owner → every building (null)', today(row('u_owner'), '').managerIds === null);
  const ut = read('src/hooks/useManagerToday.js');
  ok('useManagerToday decides its scope with resolveManagerScope (one rule with the Home)', /resolveManagerScope\(/.test(ut) && !/UNSCOPED_ROLES\.includes\(role\)\s*\n?\s*\/\/ A manager reads their own buildings/.test(ut));
  // Every caller of the shared resolvers hands over the roster: an OM's team cannot be resolved
  // without it, and a caller that forgets reads the OM's own (usually empty) book. The manager
  // nav's count pills did (S131): the pills vanished for an OM while their Home showed the team.
  const srcFiles = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|mjs)$/.test(n)) srcFiles.push(p);
    }
  })(path.join(APP, 'src'));
  const noRoster = [];
  let resolverCalls = 0;
  for (const f of srcFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(homeScope|resolveManagerScope)\(\{([^}]*)\}/g)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the definition
      resolverCalls += 1;
      if (!/\busers\b/.test(m[2])) noRoster.push(`${path.relative(APP, f)}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  ok(`every homeScope / resolveManagerScope call passes the roster (${resolverCalls} calls)`, resolverCalls >= 4 && noRoster.length === 0, noRoster.join('; '));
  const reads = read('src/hooks/useManagerHomeReads.js');
  const navCounts = reads.slice(reads.indexOf('export function useManagerNavCounts('));
  ok("🔴 the manager nav's count pills read the Home's scope — an OM's team — and count it the way the tiles do",
    /homeScope\(\{[^}]*\busers\b[^}]*\}\)/.test(navCounts) && /hoursFigures\([^)]*\bscope\b/.test(navCounts) && /suppliesFigures\([^)]*\bscope\b/.test(navCounts));
  const ims = MT.inManagerScope;
  ok('inManagerScope reads a team (a list of managers)', ims({ supervisorId: 'u_am1' }, ['u_om', 'u_am1']) === true && ims({ supervisorId: 'u_am4' }, ['u_om', 'u_am1']) === false);
  const jobs = [
    { id: 'j1', clientId: 'cl_a1', startAt: new Date().toISOString(), crewIds: [] },
    { id: 'j2', clientId: 'cl_a4', startAt: new Date().toISOString(), crewIds: [] },
  ];
  const t = MT.computeManagerToday({ jobs, clients, users, managerId: ['u_om', 'u_am1', 'u_am2'], now: Date.now() });
  ok(`the today engine counts only the team's visits (${show((t?.visits || []).map((v) => v.jobId))})`, show((t?.visits || []).map((v) => v.jobId)) === show(['j1']));
}
// managerFilter (Client Requests, Messaging → Customers): an OM opens on `team`.
{
  ok("defaultManagerFor: an OM opens on 'team'", MF.defaultManagerFor(row('u_om'), clients, users) === 'team');
  ok('defaultManagerFor: an AM opens on themselves, as before', MF.defaultManagerFor(row('u_am1'), clients, users) === 'u_am1');
  const empty = users.map((u) => (u.id === 'u_am1' || u.id === 'u_am2' ? { ...u, opsManagerId: null } : u));
  ok('…an OM whose team holds no building opens on All managers', MF.defaultManagerFor(row('u_om'), clients.filter((c) => c.supervisorId !== 'u_om'), empty) === '');
  ok("managerFilterValue keeps an explicit 'team'", MF.managerFilterValue({ viewer: row('u_om'), clients, users, mgrParam: 'team' }) === 'team');
  ok("managerFilterIds: 'team' → the viewer's team; an id → that id; '' → everyone",
    show(sorted(fn(MF, 'managerFilterIds')('team', { viewer: row('u_om'), users }))) === show(['u_am1', 'u_am2', 'u_om'])
    && fn(MF, 'managerFilterIds')('u_am1', { viewer: row('u_om'), users }) === 'u_am1' && fn(MF, 'managerFilterIds')('', { viewer: row('u_om'), users }) === '');
  const problems = [
    { id: 'p1', client_id: 'cl_a1', status: 'open', created_at: new Date().toISOString() },
    { id: 'p2', client_id: 'cl_a4', status: 'open', created_at: new Date().toISOString() },
  ];
  const supervisorOf = (id) => clients.find((c) => c.id === id)?.supervisorId || null;
  const rows = CR.clientRequestRows(problems, { supervisorOf, managerId: ['u_om', 'u_am1', 'u_am2'] });
  ok(`Client Requests lists a team's requests (${show(rows.map((r) => r.id))})`, show(rows.map((r) => r.id)) === show(['p1']));
  const threads = [{ clientId: 'cl_a1', managerId: 'u_am1' }, { clientId: 'cl_a4', managerId: 'u_am4' }];
  ok('Messaging → Customers filters a team the same way', show(HM.filterOfficeThreads(threads, { managerId: ['u_om', 'u_am1'] }).map((r) => r.clientId)) === show(['cl_a1']));
  // Messaging → Customers end to end. The route resolves `managerId=team` to the caller's team;
  // the DEMO (which mirrors the route) and the inbox's own re-filter of the waiting list both
  // matched the word "team" as a manager id and showed an OM nothing, while their Home counted
  // the team's waiting messages (S131).
  {
    const mem = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } },
    });
    const DEMO = await import('../src/lib/clientMessagesDemo.js').catch(() => ({}));
    const { CLIENT_MESSAGES_STUB_KEY } = await import('../src/data/stubKeys.js');
    const { HUB_MESSAGE_AUTHOR_ROLES } = await import('../src/lib/hubMessages.js');
    const line = (id, clientId, hoursAgo) => ({
      id, client_id: clientId, author_role: HUB_MESSAGE_AUTHOR_ROLES.client, author_client_user_id: 'cu_x', author_user_id: null,
      author_name: 'A customer', body: 'Hello', created_at: new Date(Date.now() - hoursAgo * 3600e3).toISOString(),
    });
    // The demo seed's team: Gabriel (OM) over Renata (Las Olas, …) and Nadia (Gulfstream, …).
    mem.set(CLIENT_MESSAGES_STUB_KEY, JSON.stringify({ messages: [
      line('m1', 'cl_seed_evergreen', 3), line('m2', 'cl_seed_cascade', 2), line('m3', 'cl_seed_aventura', 1),
    ], reads: [] }));
    const ids = (r) => sorted((r?.threads || []).map((x) => x.clientId));
    const office = fn(DEMO, 'officeThreads');
    const omWaiting = await Promise.resolve(office({ waiting: 1, managerId: 'team' }, { user: { id: 'u_seed_ops1' } })).catch(() => null);
    ok(`the demo's waiting list: an OM's "team" is their account managers' buildings (${show(ids(omWaiting))})`,
      show(ids(omWaiting)) === show(['cl_seed_cascade', 'cl_seed_evergreen']));
    const amWaiting = await Promise.resolve(office({ waiting: 1, managerId: 'team' }, { user: { id: 'u_seed_mgr1' } })).catch(() => null);
    ok(`…an account manager asking for "team" gets their own (${show(ids(amWaiting))})`, show(ids(amWaiting)) === show(['cl_seed_evergreen']));
    const omList = await Promise.resolve(office({ filter: 'all', managerId: 'team' }, { user: { id: 'u_seed_ops1' } })).catch(() => null);
    ok(`the demo's thread list reads "team" the same way (${show(ids(omList))})`, show(ids(omList)) === show(['cl_seed_cascade', 'cl_seed_evergreen']));
    const inbox = read('src/components/CustomerMessagesInbox.jsx');
    ok("🔴 the inbox's waiting re-filter keeps a team's threads (it never matches the word `team` as an id)",
      /managerFilterIds\(/.test(inbox) && /managerIdsMatch\(/.test(inbox) && !/w\.managerId === managerId/.test(inbox));
  }
  // The Quality hub's Work Orders queue and Reports → Time to resolve are the two screens on the
  // qc reads that take `supervisorId=team` (api/qc, above): an OM gets "My team" there, opens the
  // queue on it, and the demo's stub resolves `team` the way the route does.
  {
    const wo = read('src/components/WorkOrdersPanel.jsx');
    ok('Work Orders: an OM gets a "My team" queue and opens on it', /isOpsManager\(/.test(wo) && /value=\{TEAM\}/.test(wo) && /teamClientIds\(/.test(wo));
    ok('…the open set is narrowed to the team in the browser and the resolved history asked for `team`',
      /queue === TEAM/.test(wo) && /resolvedQueue = queue === 'all' \? undefined : queue/.test(wo));
    const rt = read('src/pages/reports/ResolveTimeReport.jsx');
    ok('Time to resolve: the Manager filter offers an OM "My team" and the Customer filter follows it',
      /<ManagerFilter [^\n]* team \/>/.test(rt) && /managerFilterIds\(/.test(rt));
    const rk = read('src/pages/reports/reportKit.jsx');
    ok('the shared Customer filter reads one manager or a team (managerIdsMatch)', /export function CustomerFilter[\s\S]{0,400}managerIdsMatch\(/.test(rk));
    const qa = read('src/lib/qcApi.js');
    ok("the demo's qc stub resolves `team` as the route does (the signed-in teammate's team)",
      /function stubProblems[\s\S]{0,1200}supervisorId === TEAM[\s\S]{0,600}teamClientIds\(/.test(qa));
  }
  const kit = read('src/components/ManagerTodayKit.jsx');
  ok('the today kit shows the Manager filter to an OM, over their team', /seesTeamPages|isOpsManager/.test(kit) && /teamMemberIds\(/.test(kit));
  const rk = read('src/pages/reports/reportKit.jsx');
  ok('the shared Manager filter offers "My team" to an OM', /value: TEAM/.test(rk) && /reportKit\.myTeam/.test(rk));
}
// The server sites: each resolves `team` from the CLAIM (never a body or a blob role).
{
  const time = read('api/time/[...path].js');
  ok('api/time: every manager write and read takes the committed roster into timeScopeFor',
    /timeScopeFor\(user, clients, users\)/.test(time) && (time.match(/timeScopeFor\(user, clients, (?:users|slices\.users|rosterOf\(slices\))\)/g) || []).length >= 3
    && !/timeScopeFor\(user, clients\)/.test(time));
  ok('api/time: the overtime approval reads the roster too', /action === 'ot-approve'[\s\S]{0,700}readProtectedSlices\('clients:state->clients,users:state->users,opsSettings:state->opsSettings'\)/.test(time));
  ok('api/time: an OM may narrow the approvals read to one member of the team, never beyond it', /teamMemberIds\(users, g\.orgUserId\)/.test(time));
  const qc = read('api/qc/[...path].js');
  ok("api/qc: supervisorId=team is the caller's team, from the claim (list and resolve-time)", (qc.match(/supervisorId === TEAM/g) || []).length >= 2 && /teamClientIds\(/.test(qc));
  const cm = read('api/client-messages/[...path].js');
  // (S131 Wave 2: through lib/teamScope teamLeadFor — the claim's role and id; an owner or an admin may
  // name whose team with `om`, a manager never widens theirs; test-waiting-messages B12–B15 drive it.)
  ok("api/client-messages: managerId=team is the caller's team, from the claim", /q\.managerId === TEAM/.test(cm)
    && /teamMemberIds\(book\.users, teamLeadFor\(\{ role: a\.role, selfId: a\.orgUserId, users: book\.users, om: q\.om \}\)\)/.test(cm));
  const qb = read('api/quickbooks/[...path].js');
  ok('the P&L: an OM reads the team\'s properties (never another team\'s)', /teamClientIds\(/.test(qb));
  const act = read('api/activity/[...path].js');
  ok('the activity log: an OM reads the team\'s customers', /activityScopeFor\(g, clients, users\)/.test(act)
    && !/activityScopeFor\(g, clients\)/.test(act) && /teamClientIds\(/.test(read('api/_lib/activityLog.js')));
  // The P&L's DISPLAY twin (lib/qboView buildLiveBook) re-scopes the answer for the viewer — the
  // owner's View-as preview depends on it. It must read the team as the route does, or an OM's
  // real login gets the team's figures from the server and then sees only their own buildings.
  {
    const QV = await import('../src/lib/qboView.js');
    const pnl = {
      connected: true, sandbox: false, basis: 'Accrual', asOf: '2026-10-14T12:00:00.000Z', range: 'last30',
      accounts: ['cl_om', 'cl_a1', 'cl_a2', 'cl_a4'].map((clientId) => ({ clientId, incomeCents: 100000, cogsCents: 50000, expenseCents: 60000, grossProfitCents: 50000, netCents: 40000 })),
    };
    const ids = (book) => sorted((book?.accounts || []).map((a) => a.clientId));
    const omBook = QV.buildLiveBook(pnl, { clients, users, currentUser: row('u_om') });
    ok(`🔴 the P&L display twin: an OM sees the team's properties (${show(ids(omBook))})`, show(ids(omBook)) === show(['cl_a1', 'cl_a2', 'cl_om']));
    const amBook = QV.buildLiveBook(pnl, { clients, users, currentUser: row('u_am1') });
    ok(`…an account manager still only their own (${show(ids(amBook))})`, show(ids(amBook)) === show(['cl_a1']));
    const ownerBook = QV.buildLiveBook(pnl, { clients, users, currentUser: row('u_owner') });
    ok('…the owner every linked property', ids(ownerBook).length === 4);
    ok('useQboBook hands the roster to the display twin', /buildLiveBook\(shownPnl, \{[^}]*\busers\b/.test(read('src/hooks/useQboBook.js')));
  }
  const scopeHook = read('src/hooks/useTimeScope.js');
  ok('useTimeScope passes the roster (an OM\'s Approvals and Time Clock cover the team)', /timeScopeFor\(currentUser, clients \|\| \[\], users \|\| \[\]\)/.test(scopeHook));
  ok('the demo stub and the Variance filter pass the roster too',
    /timeScopeFor\(user, s\.clients \|\| \[\], s\.users \|\| \[\]\)/.test(read('src/lib/timeApi.js'))
    && /timeScopeFor\(ctx\.user, ctx\.state\.clients \|\| \[\], ctx\.state\.users \|\| \[\]\)/.test(read('src/lib/filters/varianceFilters.js')));
}

// ── 3. server-enforced: the real api/time handler, offline ───────────────────────────────────
const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();
const timeRoute = (await import('../api/time/[...path].js')).default;
{
  const roster = users.map((u) => ({ ...u, email: `${u.id}@example.test`, pay: u.role === 'crew' ? { type: 'hourly', hourlyRate: 20 } : { type: 'salary' } }));
  const logins = Object.fromEntries(roster.map((u) => [`tok-${u.id}`, { id: `auth-${u.id}`, email: u.email, app_metadata: { role: u.role, org_user_id: u.id, org_id: ORG } }]));
  const H = 3600e3;
  const inIso = new Date(Date.now() - 48 * H).toISOString();
  const outIso = new Date(Date.now() - 46 * H).toISOString();
  const punch = (id, clientId) => ({
    id, organization_id: ORG, user_id: 'u_crew', client_id: clientId, site_id: `st_${clientId}`, job_id: null,
    user_name: 'Gus', client_name: clientId, site_name: 'Main', clock_in_at: inIso, clock_out_at: outIso, duration_minutes: 120,
    status: 'completed', approval_status: 'pending', approved_by: null, approved_at: null, row_version: 0, edit_history: [], updated_at: outIso,
  });
  const build = () => resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state: { users: roster, permissions: seedPermissions(), userPermissionOverrides: [], clients, sites: [], opsSettings: {} }, version: 3 }],
      time_entries: [punch('te_a1', 'cl_a1'), punch('te_a2', 'cl_a2'), punch('te_a4', 'cl_a4')],
      payroll_runs: [],
      jobs: [],
    },
    logins,
  });
  const call = async (who, body) => {
    const raw = JSON.stringify(body);
    const req = Readable.from([Buffer.from(raw)]);
    req.method = 'POST';
    req.headers = { authorization: `Bearer tok-${who}` };
    req.query = { subpath: 'approve' };
    req.body = body;
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no response')), 5000);
        const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
        const res = {
          statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
          json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
        };
        Promise.resolve(timeRoute(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
      });
    } finally { Object.assign(console, quiet); }
  };
  const approve = async (who, entryId) => { build(); return call(who, { items: [{ entryId, version: 0 }] }); };
  const res0 = (r) => r?.body?.results?.[0] || {};
  const status = (id) => world.tables.time_entries.find((e) => e.id === id)?.approval_status;
  let r = await approve('u_om', 'te_a1');
  ok(`🔴 an OM approves a punch at an AM's building (${show(res0(r))})`, r.status === 200 && res0(r).ok === true && status('te_a1') === 'approved');
  r = await approve('u_om', 'te_a2');
  ok(`…at the other AM's building too (${show(res0(r))})`, r.status === 200 && res0(r).ok === true);
  r = await approve('u_om', 'te_a4');
  ok(`🔴 …but never outside the team (${show(res0(r))})`, r.status === 200 && res0(r).ok === false && res0(r).code === 'out-of-scope' && status('te_a4') === 'pending');
  r = await approve('u_am1', 'te_a2');
  ok(`🔴 an AM still cannot approve at another AM's building (${show(res0(r))})`, r.status === 200 && res0(r).ok === false && res0(r).code === 'out-of-scope');
  r = await approve('u_am1', 'te_a1');
  ok(`…and still can at their own (${show(res0(r))})`, r.status === 200 && res0(r).ok === true);
}

console.log(`\ntest-team-scope: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
