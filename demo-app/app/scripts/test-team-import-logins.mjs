// The Team import's LOGINS, through the REAL sign-in route and the REAL save (offline).
//
// Settings → Team → Import team (task #466 from Clean Corner's queue; Daniel's pick 2026-11-03:
// "Email on every row, invite at import") makes each new person's login with the route Invite
// Member uses (POST /api/settings/users, lib/teamApi createTeamLogin), then saves the run's people
// as one IMPORT_TEAM action. This suite drives the engine's run (lib/teamImport runTeamImport) with
// a createLogin that calls api/settings/[...path].js, and saves what it built through
// api/state/org-state.js, against the local fake GoTrue + PostgREST (scripts/fake-supabase-server.mjs).
// Offline by construction: a fetch guard refuses every host but the fake, and no system sender is
// configured, so no email can be sent (each answer says why: not set up).
//
//   · each login carries the role and the roster id the import saved (the trust root);
//   · an orphan login (an invite that never finished) is adopted: the roster row takes ITS id;
//   · a login the route refuses is left off the roster, with the route's own words;
//   · the run's save is accepted by the real guard, and the one-time links are never kept.
//
//   node app/scripts/test-team-import-logins.mjs
//
// ok(label, cond) — the CONDITION is second in this file.
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { startFakeSupabase } from './fake-supabase-server.mjs';
import * as roles from '../src/lib/roles.js';
import { loadStore } from './deletion-core.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const ORG = '00000000-0000-0000-0000-0000000fab66';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  FORMS_ORG_ID: ORG, CLEANSPACE_ORG_ID: ORG, APP_BASE_URL: 'http://127.0.0.1',
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL']) delete process.env[k];
const realFetch = globalThis.fetch;
const strays = [];
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!u.startsWith(fake.url)) { strays.push(u); return Promise.reject(new Error(`offline suite: refused ${u}`)); }
  return realFetch(input, init);
};
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};

const settings = (await import('../api/settings/[...path].js')).default;
const orgStateRoute = (await import('../api/state/org-state.js')).default;
const { reducer, ACTIONS } = await loadStore();
let ti = {}; let csv = {}; let teamApi = {};
try { ti = await import('../src/lib/teamImport.js'); } catch { /* reported below */ }
try { csv = await import('../src/lib/csv.js'); } catch { /* reported below */ }
try { teamApi = await import('../src/lib/teamApi.js'); } catch { /* reported below */ }
ok('the engine and the id rule load', typeof ti.runTeamImport === 'function' && typeof teamApi.bindRosterId === 'function');

const email = (k) => `${k}@cs.test`;
const idOf = (k) => `u_${k}`;
const PEOPLE = { owner: 'owner', admin: 'admin', crew: 'crew' };
function world() {
  const authUsers = [];
  const tokens = {};
  const users = [];
  for (const [k, role] of Object.entries(PEOPLE)) {
    users.push({ id: idOf(k), role, status: 'active', name: k, email: email(k), hr: { employeeId: `EMP-000${users.length + 1}` } });
    const authId = randomUUID();
    authUsers.push({ id: authId, email: email(k), app_metadata: { provider: 'email', providers: ['email'], role, org_user_id: idOf(k), org_id: ORG }, user_metadata: {}, banned_until: null });
    tokens[`tok_${k}`] = authId;
  }
  // Two invites that never finished: logins with no roster row.
  for (const [k, role] of [['orphancrew', 'crew'], ['orphanowner', 'owner']]) {
    authUsers.push({ id: randomUUID(), email: email(k), app_metadata: { role, org_user_id: idOf(k), org_id: ORG }, user_metadata: {}, banned_until: null });
  }
  return {
    authUsers,
    tokens,
    orgState: {
      organization_id: ORG, version: 3, protected_fingerprint: null, min_client_build: null,
      state: {
        users, permissions: roles.seedPermissions(), userPermissionOverrides: [],
        company: { name: 'Clean Space', timezone: 'America/New_York' },
        opsSettings: { payPeriodCadence: 'biweekly' }, payrollLines: [], reimbursements: [], timeOff: [],
        sites: [], contacts: [], clientActivities: [], invoices: [],
        clients: [{ id: 'c1', name: 'Acme Towers', type: 'customer', customerNumber: '0001', tagIds: [] }],
      },
    },
    timeEntries: [],
  };
}
const mockRes = () => ({
  statusCode: 0, body: null, headers: {},
  status(c) { this.statusCode = c; return this; },
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
  json(o) { this.body = o; return this; },
});
// The route lib/teamApi createTeamLogin posts to, as the importer.
async function invite(token, body) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { authorization: `Bearer ${token}`, host: '127.0.0.1' };
  req.query = { subpath: 'users' };
  const res = mockRes();
  await settings(req, res);
  return res;
}
async function save(token, state, baseVersion) {
  const req = { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { state, baseVersion, build: 0, tab: 'tab_test' } };
  const res = mockRes();
  await orgStateRoute(req, res);
  return res;
}
const login = (e) => fake.db.authUsers.find((u) => u.email === e);

fake.reset(world());
const committed = JSON.parse(JSON.stringify(fake.db.orgState.state));
const admin = committed.users.find((u) => u.id === 'u_admin');
const perms = typeof ti.teamImportPermissions === 'function'
  ? ti.teamImportPermissions({ actor: admin, permissions: committed.permissions, overrides: committed.userPermissionOverrides }) : {};
const FILE = 'First name,Last name,Employee ID,Email,Role,Account\n'
  + 'Rosa,Delgado,10234,rosa@cs.test,Crew,0001\n'
  + 'Jean,Pierre,10235,jean@cs.test,Crew,0001\n'
  + `Orla,Phan,10236,${email('orphancrew')},Crew,0001\n`
  + `Owen,Orphan,10237,${email('orphanowner')},Crew,\n`;
let plan = { rows: [], counts: {} };
if (typeof ti.planTeamImport === 'function' && typeof csv.parseCsv === 'function') {
  const parsed = csv.parseCsv(FILE);
  plan = ti.planTeamImport({ rows: parsed.rows, mapping: ti.guessTeamMapping(parsed.headers), state: committed, perms, live: true });
}
ok('the plan: four new people for the Admin', plan.counts.create === 4, JSON.stringify(plan.counts));
let idn = 0;
const ops = typeof ti.buildTeamImportOps === 'function' ? ti.buildTeamImportOps(plan, { newId: (p) => `${p}_imp${(idn += 1)}` }) : [];

let store = committed;
const dispatched = [];
const createLogin = async (e, role, orgUserId) => {
  const r = await invite('tok_admin', { email: e, role, orgUserId });
  if (r.statusCode !== 200) throw Object.assign(new Error(r.body?.error || `Request failed (${r.statusCode})`), { status: r.statusCode });
  return r.body;
};
const res = typeof ti.runTeamImport === 'function' ? await ti.runTeamImport({
  ops, live: true, createLogin, bindId: teamApi.bindRosterId,
  dispatch: (a) => { dispatched.push(a); store = reducer(store, a); }, actionType: ACTIONS.IMPORT_TEAM,
  getState: () => store, applyOps: (s, o) => reducer(s, { type: ACTIONS.IMPORT_TEAM, ops: o }),
}) : { added: [], refused: [], skipped: [] };

const rosa = store.users.find((u) => u.email === 'rosa@cs.test');
ok('1 each new person has a login carrying their role and their roster id', rosa && login('rosa@cs.test')?.app_metadata?.org_user_id === rosa.id
  && login('rosa@cs.test')?.app_metadata?.role === 'crew' && login('jean@cs.test')?.app_metadata?.org_user_id === store.users.find((u) => u.email === 'jean@cs.test')?.id);
const orla = store.users.find((u) => u.email === email('orphancrew'));
ok('2 an orphan login is adopted: the roster row takes the id already in its claim', orla?.id === idOf('orphancrew') && res.added.find((x) => x.email === email('orphancrew'))?.adopted === true, JSON.stringify(orla));
ok('3 a login the route refuses (an orphaned Super Admin, re-invited lower) is left off the roster, in the route\'s words',
  res.refused.length === 1 && res.refused[0].email === email('orphanowner') && res.refused[0].why.length > 0
  && !store.users.some((u) => u.email === email('orphanowner')) && login(email('orphanowner'))?.app_metadata?.role === 'owner', JSON.stringify(res.refused));
ok('4 no email could go (no sender): each says so, and no one-time link is kept', res.added.length === 3 && res.added.every((x) => x.invited === false && x.why)
  && !JSON.stringify(store).includes('token=') && !JSON.stringify(res).includes('http://127.0.0.1/'), JSON.stringify(res.added.map((x) => x.why)));
ok('5 one action for the run (three people)', dispatched.length === 1 && dispatched[0].ops.length === 3);
const saved = await save('tok_admin', store, fake.db.orgState.version);
ok('6 the run\'s save is accepted by the real guard', saved.statusCode === 200, `${saved.statusCode} ${JSON.stringify(saved.body)}`);
const roster = fake.db.orgState.state.users;
ok('7 saved: three new rows, their links, and the roster ids match the logins', roster.length === 6
  && roster.filter((u) => ['rosa@cs.test', 'jean@cs.test', email('orphancrew')].includes(u.email)).every((u) => login(u.email)?.app_metadata?.org_user_id === u.id && JSON.stringify(u.worksAt) === '["c1"]'));
ok('8 nothing left the machine', strays.length === 0, strays.join(', '));

console.warn = quiet.warn;
console.error = quiet.error;
await fake.close?.();
console.log(`\ntest-team-import-logins: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
