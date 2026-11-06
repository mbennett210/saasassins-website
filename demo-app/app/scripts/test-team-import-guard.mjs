// Importing the team, at the REAL save handler — the server agrees with the screen (offline).
//
// Settings → Team → Import team (task #466 from Clean Corner's queue) saves each run of 25 people as
// ONE IMPORT_TEAM action, after each person's login is made. The screen offers only what the save
// accepts (lib/teamImport teamImportPermissions); the save route is the boundary (BUILD_INTEGRITY
// §1.4). This suite drives api/state/org-state.js through scripts/fake-supabase.mjs with the
// importer's OWN output (the file → the plan → the action → the reducer):
//   · a holder of "Edit team" imports: ACCEPTED, the people, their pay and their customer link;
//   · pay without "Edit pay rates", a level the caller can't give, a member added without "Edit
//     team": REFUSED, nothing written — and the engine had already said so for the same caller;
//   · a duplicate employee ID is refused by the server, and the importer's action never makes one;
//   · the customer link (users[].worksAt) is the office's: a cleaner's own save can't change it
//     (api/_lib/crewMerge drops it), and the crew view never serves it.
//
//   node app/scripts/test-team-import-guard.mjs
//
// ok(label, cond) — the CONDITION is second in this file.
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { loadStore } from './deletion-core.mjs';

const ORG = '00000000-0000-0000-0000-000000000001';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
const consoleError = console.error;
console.error = (...args) => { if (args[0] !== '[ALERT]' || process.env.VERBOSE) consoleError(...args); };
installFakeSupabase();
const { default: handler } = await import('../api/state/org-state.js');
const { mergeCrewChanges } = await import('../api/_lib/crewMerge.js');
const { projectCrewView } = await import('../api/_lib/crewView.js');
const { reducer, ACTIONS } = await loadStore();
let ti = {}; let csv = {};
try { ti = await import('../src/lib/teamImport.js'); } catch { /* the pre-change tree has no engine */ }
try { csv = await import('../src/lib/csv.js'); } catch { /* reported by the checks */ }

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
ok('the team import engine loads', typeof ti.planTeamImport === 'function' && !!ACTIONS.IMPORT_TEAM);

const login = (id, email, role, orgUserId) => ({ id, email, app_metadata: { role, org_user_id: orgUserId, org_id: ORG } });
const LOGINS = {
  'tok-owner': login('a-owner', 'owner@cs.co', 'owner', 'u_owner'),
  'tok-mgr': login('a-mgr', 'mgr@cs.co', 'manager', 'u_mgr'),
  // A manager without "Edit pay rates" (the default; revoked here to say so).
  'tok-mgr-nopay': login('a-mgr2', 'mgr2@cs.co', 'manager', 'u_mgr2'),
  // A manager pared off "Create / edit customers", which an Admin holds: they can't give Admin.
  'tok-mgr-noadmin': login('a-mgr3', 'mgr3@cs.co', 'manager', 'u_mgr3'),
  // A manager pared off "Edit team".
  'tok-mgr-noteam': login('a-mgr4', 'mgr4@cs.co', 'manager', 'u_mgr4'),
};

const seedState = () => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York', invoicePrefix: 'INV' },
  permissions: seedPermissions(),
  userPermissionOverrides: [
    // Pay rates are the Super Admin's by default (CS-003): this manager was granted the key.
    { userId: 'u_mgr', grants: ['payroll.rates.edit'], revokes: [] },
    { userId: 'u_mgr2', grants: [], revokes: ['payroll.rates.edit'] },
    { userId: 'u_mgr3', grants: [], revokes: ['clients.edit'] },
    { userId: 'u_mgr4', grants: [], revokes: ['settings.team.edit'] },
  ],
  timeOff: [],
  services: [{ id: 'svc_1', name: 'Nightly clean', defaultDurationMins: 90 }],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona', email: 'mgr@cs.co', pay: { type: 'salary', salaryPerPeriod: 2800 }, hr: { employeeId: 'EMP-0002' } },
    { id: 'u_mgr2', role: 'manager', status: 'active', name: 'Milo', email: 'mgr2@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0003' } },
    { id: 'u_mgr3', role: 'manager', status: 'active', name: 'Mae', email: 'mgr3@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0004' } },
    { id: 'u_mgr4', role: 'manager', status: 'active', name: 'Max', email: 'mgr4@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0005' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl', email: 'crew@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0006' } },
  ],
  clients: [
    { id: 'c1', name: 'Acme Towers', type: 'customer', customerNumber: '0001', tagIds: [] },
    { id: 'c2', name: 'Bayside Plaza', type: 'customer', customerNumber: '0002', tagIds: [] },
  ],
  sites: [], contacts: [], clientActivities: [], invoices: [], payrollLines: [], reimbursements: [],
  opsSettings: { otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0 },
});

async function save(token, state, baseVersion) {
  const text = `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":0,"tab":"t1"}`;
  const req = { method: 'POST', query: {}, headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() {}, end() { return res; } };
  await handler(req, res);
  return out;
}
const row = () => world.tables.org_state[0];
async function freshOrg() {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state: seedState(), version: 1, protected_fingerprint: null, min_client_build: null, updated_at: new Date().toISOString() }],
      jobs: [], crew_assignments: [], payroll_runs: [], job_deletes: [],
    },
    logins: LOGINS,
  });
  const boot = await save('tok-owner', JSON.parse(JSON.stringify(row().state)), 1);
  if (boot.status !== 200) throw new Error(`bootstrap save failed: ${boot.status} ${JSON.stringify(boot.body)}`);
}
async function attempt(token, edit) {
  await freshOrg();
  const before = row().version;
  const next = JSON.parse(JSON.stringify(row().state));
  const edited = edit(next) || next;
  const r = await save(token, edited, before);
  return { ...r, wrote: row().version !== before };
}
const refused = (r, words) => r.status === 403 && !r.wrote && (!words || (r.body?.violations || []).includes(words));
const accepted = (r) => r.status === 200 && r.wrote;
const show = (r) => `${r.status} ${JSON.stringify(r.body)}`;

// The importer's OWN output for a caller: their permissions → the plan → the ops → the reducer.
let idn = 0;
const newIdT = (p = 'id') => `${p}_g${(idn += 1)}`;
const H = 'First name,Last name,Employee ID,Email,Role,Pay rate,Account\n';
const userIdOf = { 'tok-owner': 'u_owner', 'tok-mgr': 'u_mgr', 'tok-mgr-nopay': 'u_mgr2', 'tok-mgr-noadmin': 'u_mgr3', 'tok-mgr-noteam': 'u_mgr4' };
const permsOf = (state, token) => (typeof ti.teamImportPermissions === 'function'
  ? ti.teamImportPermissions({ actor: state.users.find((u) => u.id === userIdOf[token]), permissions: state.permissions, overrides: state.userPermissionOverrides })
  : {});
function planFor(state, token, file, perms = permsOf(state, token)) {
  if (typeof ti.planTeamImport !== 'function' || typeof csv.parseCsv !== 'function') return { rows: [], counts: {} };
  const parsed = csv.parseCsv(file);
  return ti.planTeamImport({ rows: parsed.rows, mapping: ti.guessTeamMapping(parsed.headers), state, perms, live: true });
}
function importedState(state, token, file, perms) {
  const p = planFor(state, token, file, perms);
  const ops = typeof ti.buildTeamImportOps === 'function' ? ti.buildTeamImportOps(p, { newId: newIdT }) : [];
  return reducer(state, { type: ACTIONS.IMPORT_TEAM, ops });
}
const FILE = H
  + 'Rosa,Delgado,10234,rosa@example.com,Crew,15.50,0001\n'
  + 'Jean,Pierre,10235,jean@example.com,Janitor,16,Bayside Plaza\n'
  + 'Kim,Nguyen,10236,kim@example.com,Crew,,\n';

// ── accepted ─────────────────────────────────────────────────────────────────────────────
{
  const r = await attempt('tok-mgr', (s) => importedState(s, 'tok-mgr', FILE));
  ok('1 a manager holding "Edit team" and "Edit pay rates" imports three people: accepted', accepted(r), show(r));
  const saved = row().state.users;
  const rosa = saved.find((u) => u.email === 'rosa@example.com');
  ok('2 saved: their role, pay, employee ID and customer link', saved.length === 9 && rosa?.role === 'crew' && rosa?.pay?.hourlyRate === 15.5
    && rosa?.hr?.employeeId === '10234' && JSON.stringify(rosa?.worksAt) === '["c1"]', `${saved.length} ${JSON.stringify(rosa)}`);
  const owner = await attempt('tok-owner', (s) => importedState(s, 'tok-owner', FILE));
  ok('3 the Super Admin\'s import: accepted', accepted(owner), show(owner));
  const fill = await attempt('tok-mgr', (s) => importedState(s, 'tok-mgr', `${H}Carl,,EMP-0006,crew@cs.co,Crew,,0002\n`));
  ok('4 filling a cleaner on file (their customer link): accepted', accepted(fill) && JSON.stringify(row().state.users.find((u) => u.id === 'u_crew').worksAt) === '["c2"]', show(fill));
}

// ── refused, and the engine said so first ────────────────────────────────────────────────
{
  const forced = { ...permsOf(seedState(), 'tok-mgr-nopay'), canPay: true };
  const r = await attempt('tok-mgr-nopay', (s) => importedState(s, 'tok-mgr-nopay', FILE, forced));
  ok('5 pay without "Edit pay rates": refused, nothing written', refused(r, "set a new member's pay"), show(r));
  const own = planFor(seedState(), 'tok-mgr-nopay', FILE);
  ok('6 …and the engine had left the pay out for that caller, with a note', own.rows?.every((x) => !x.ops[0]?.user?.pay)
    && own.rows?.some((x) => (x.warnings || []).some((m) => m.$t === 'teamImport.warn.payNotAllowed')));
  const ownSaved = await attempt('tok-mgr-nopay', (s) => importedState(s, 'tok-mgr-nopay', FILE));
  ok('7 the same caller\'s own import (no pay): accepted', accepted(ownSaved), show(ownSaved));

  const adminFile = `${H}Ivy,Stone,10300,ivy@example.com,Admin,,\n`;
  const forcedRole = { ...permsOf(seedState(), 'tok-mgr-noadmin'), choices: ['crew', 'manager', 'supply_manager', 'admin'] };
  const r2 = await attempt('tok-mgr-noadmin', (s) => importedState(s, 'tok-mgr-noadmin', adminFile, forcedRole));
  ok('8 an access level the caller can\'t give: refused', refused(r2, 'give a new member that access level'), show(r2));
  const own2 = planFor(seedState(), 'tok-mgr-noadmin', adminFile);
  ok('9 …and the engine refused that row for that caller', own2.rows?.[0]?.status === 'error' && own2.rows[0].errors.some((m) => m.$t === 'teamImport.err.roleNotAllowed'));

  const forcedTeam = { ...permsOf(seedState(), 'tok-mgr'), canImport: true };
  const r3 = await attempt('tok-mgr-noteam', (s) => importedState(s, 'tok-mgr-noteam', FILE, forcedTeam));
  ok('10 a member added without "Edit team": refused', refused(r3, 'add a team member'), show(r3));
  ok('11 …and the engine doesn\'t offer that caller the import', permsOf(seedState(), 'tok-mgr-noteam').canImport === false);
}

// ── employee IDs stay unique ─────────────────────────────────────────────────────────────
{
  const dup = await attempt('tok-mgr', (s) => ({ ...s, users: [...s.users, { id: 'u_new', role: 'crew', status: 'active', name: 'Dup', email: 'dup@example.com', hr: { employeeId: 'emp-0006' } }] }));
  ok('12 the server refuses a second person with an employee ID on file', dup.status === 403 && !dup.wrote, show(dup));
  const stepped = await attempt('tok-mgr', (s) => reducer(s, { type: ACTIONS.IMPORT_TEAM, ops: [{ op: 'addUser', user: { id: 'u_new', role: 'crew', status: 'active', name: 'Dup', email: 'dup@example.com', hr: { employeeId: 'emp-0006' } } }] }));
  ok('13 the importer\'s own action never makes one (the taken ID is left off): accepted', accepted(stepped) && !row().state.users.find((u) => u.id === 'u_new').hr.employeeId, show(stepped));
  const twice = await attempt('tok-mgr', (s) => ({ ...s, users: [...s.users, { id: 'u_new', role: 'crew', status: 'active', name: 'Twice', email: 'crew@cs.co' }] }));
  ok('14 a second person with an email on the team: refused', twice.status === 403 && !twice.wrote, show(twice));
}

// ── the link is the office's ─────────────────────────────────────────────────────────────
{
  const full = { ...seedState(), jobs: [], notifications: [], conversations: [], messages: [] };
  full.users = full.users.map((u) => (u.id === 'u_crew' ? { ...u, worksAt: ['c1'] } : u));
  const scope = { clientIds: [] };
  const served = projectCrewView(full, { userId: 'u_crew', crewJobs: [], scope });
  ok('15 the crew view never serves the link', !('worksAt' in (served.users.find((u) => u.id === 'u_crew') || {})));
  const posted = structuredClone(served);
  posted.users = posted.users.map((u) => (u.id === 'u_crew' ? { ...u, worksAt: ['c2'] } : u));
  const { next } = mergeCrewChanges({ full, posted, userId: 'u_crew', scope });
  ok('16 a cleaner\'s own save can\'t change it (the crew merge keeps the office\'s)', JSON.stringify(next.users.find((u) => u.id === 'u_crew').worksAt) === '["c1"]');
}

console.log(`\ntest-team-import-guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
