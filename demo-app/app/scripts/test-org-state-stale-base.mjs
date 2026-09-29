// A save from a stale base answers as a CAS miss (409, and the client replays), never as
// a guard refusal (403, and the client drops its whole batch).
//
// THE BUG (pre-existing; found by the S77 adversarial review, 2026-09-23). The route
// api/state/org-state.js ran the field guard (_lib/orgStateGuard.js
// protectedFieldViolations) BEFORE the CAS write, against the LATEST committed protected
// slices, while the write itself replaces `baseVersion`. When a tab's base was behind and a
// teammate had changed a protected field in between (the owner changed someone's pay or
// role, a manager's overrides, the timezone...), the stale save looked like it REVERTED
// that change, so the guard answered 403. store/sync.js treats a guard 403 as final: it
// drops every pending action in the save and adopts the server state. Every role was
// exposed, crew included. The right answer is the CAS miss: 409, after which the client
// adopts the latest state, replays its pending actions on top and saves again, and the
// guard judges the replay against fresh state.
//
// AND (§5) THE STORED DIGEST VOUCHES ONLY FOR THE COMMIT IT WAS STORED IN. The route skips
// the guard when a save's digest equals `org_state.protected_fingerprint`, which only the
// route refreshed. writeOrgState's callers (reconcile-self appending a roster row) and
// operator scripts bumped the version and left it, so a save that put their protected
// change back matched the older digest and committed unchecked (crew removed the member:
// 200). Now the column holds `<digest>@<version>/<updated_at ms>`, the fast path needs it
// to name the commit being replaced, writeOrgState stamps it only after checking the
// stored one still describes the row (so it never launders an outside write), and the
// baseline alarm fires for writes from outside the server paths (the owner's call,
// 2026-09-23).
//
// HOW: the REAL route handler and the REAL client wrapper (src/lib/stateApi.js
// postOrgState), with real supabase-js, against a fake Supabase on 127.0.0.1 (GoTrue
// /auth/v1/user; PostgREST org_state, crew_assignments, the time ledger, and the lead
// webhook's endpoint + delivery tables). The fake can land a teammate's write right after
// one of the route's reads, which pins the race windows too. Nothing
// leaves this machine: SUPABASE_URL points at the fake before anything is imported, and
// the run refuses to go on otherwise.
//
//   node app/scripts/test-org-state-stale-base.mjs
import http from 'node:http';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-000000000001';
const watchdog = setTimeout(() => { console.error('test-org-state-stale-base: timed out'); process.exit(1); }, 60000);

// ── the fake Supabase ─────────────────────────────────────────────────────────
const tokens = {
  'tok-owner': { id: 'auth-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  'tok-admin': { id: 'auth-admin', email: 'admin@cs.co', app_metadata: { role: 'admin', org_user_id: 'u_admin', org_id: ORG } },
  // A manager login WITHOUT a role claim (one made before claims.js knew the role): the
  // route resolves it from the blob by email, its widest path.
  'tok-mgr': { id: 'auth-mgr', email: 'mgr@cs.co', app_metadata: {} },
  // The same manager with the role claim every login made since S80 carries.
  'tok-mgr-claim': { id: 'auth-mgr', email: 'mgr@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
  // CS-002: the digest / CAS / baseline machinery this suite pins is the OFFICE write path;
  // crew now route through the crew MERGE (covered by test-crew-merge-route.mjs), so the cases
  // that used a crew actor to exercise this machinery use tok-admin. (A crew token is no longer
  // needed here.)
  // A claim-backed login whose roster row is missing: what settings reconcile-self repairs.
  'tok-new': { id: 'auth-new', email: 'new@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_new', org_id: ORG } },
};
// The public lead webhook's endpoint row (webhook_endpoints): bearer-token auth, default routing.
const LEAD_EP = { id: 'wh_1', slug: 'lead-test', is_active: true, purpose: 'lead_intake', bearer_token: 'lead-token', signing_secret: null, lead_config: {} };
let row = null; // the org's org_state row; null = the org has no row
let calls = []; // every org_state request the fake answered: { method, select }
const crewSyncCalls = []; // every crew_assignments request (method)
const ledgerReads = []; // the removal pay rule's time_entries reads (user_id filter)
const unexpected = [];
let afterRead = null; // one-shot { when(select), run() }: lands a write right after that read is answered
let failRead = null; // one-shot { when(select) }: answers that read with a 500

// jsonb hands object keys back in its own order (shorter first, then bytewise), not the
// order they were written in; the fake does the same, so an order-sensitive compare shows.
const jsonbOrder = (v) => (Array.isArray(v) ? v.map(jsonbOrder) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, jsonbOrder(v[k])]))
  : v);
// PostgREST projection: `col`, `alias:col`, `alias:col->key`.
const project = (select) => {
  const out = {};
  for (const item of select.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:(\w+):)?(\w+)(?:->(\w+))?$/.exec(item);
    if (!m) { unexpected.push(`select item ${item}`); continue; }
    const [, alias, col, key] = m;
    out[alias || key || col] = jsonbOrder(key ? (row[col]?.[key] ?? null) : (row[col] ?? null));
  }
  return out;
};
// The fleet gate's `or=(min_client_build.is.null,min_client_build.lte.N)`.
const orMatches = (expr) => {
  if (!expr) return true;
  return expr.replace(/^\(|\)$/g, '').split(',').some((p) => {
    const [col, op, val] = p.split('.');
    if (op === 'is' && val === 'null') return row[col] == null;
    if (op === 'lte') return row[col] != null && row[col] <= Number(val);
    unexpected.push(`or ${p}`);
    return false;
  });
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://fake');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (u.pathname === '/auth/v1/user') {
      const t = (req.headers.authorization || '').replace(/^Bearer /, '');
      return tokens[t] ? send(200, tokens[t]) : send(401, { msg: 'invalid token' });
    }
    if (u.pathname === '/rest/v1/org_state') {
      const select = u.searchParams.get('select') || '';
      calls.push({ method: req.method, select });
      if (u.searchParams.get('organization_id') !== `eq.${ORG}`) { unexpected.push(`org filter ${u.search}`); return send(200, []); }
      if (req.method === 'GET') {
        if (failRead && failRead.when(select)) { failRead = null; return send(500, { message: 'fake read failure', code: 'XX000' }); }
        send(200, row ? [project(select)] : []);
        if (afterRead && afterRead.when(select)) { const h = afterRead; afterRead = null; h.run(); }
        return undefined;
      }
      if (req.method === 'PATCH') {
        if (!row || u.searchParams.get('version') !== `eq.${row.version}` || !orMatches(u.searchParams.get('or'))) return send(200, []);
        Object.assign(row, JSON.parse(raw || '{}'));
        return send(200, select ? [project(select)] : []);
      }
    }
    if (u.pathname === '/rest/v1/crew_assignments') {
      crewSyncCalls.push(req.method); // the post-commit assignment sync (crewAssignments.js)
      if (req.method === 'GET') return send(200, []);
      if (req.method === 'POST') return send(201);
      if (req.method === 'DELETE') return send(204);
    }
    // The guard's removal pay rule (api/_lib/memberRemoval.js) reads the time ledger when a
    // save removes a member: no punches, so it owes nothing and only the authority rule decides.
    if (u.pathname === '/rest/v1/time_entries' && req.method === 'GET') {
      ledgerReads.push(u.searchParams.get('user_id'));
      return send(200, []);
    }
    // The lead webhook's endpoint lookup, its last-received touch, and its delivery log.
    if (u.pathname === '/rest/v1/webhook_endpoints') {
      if (req.method === 'GET') return send(200, u.searchParams.get('slug') === `eq.${LEAD_EP.slug}` ? [LEAD_EP] : []);
      if (req.method === 'PATCH') return send(204);
    }
    if (u.pathname === '/rest/v1/webhook_deliveries' && req.method === 'POST') return send(201);
    unexpected.push(`${req.method} ${u.pathname}${u.search}`);
    return send(404, { message: 'not faked' });
  });
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
const FAKE = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_URL = FAKE;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
delete process.env.ALERT_WEBHOOK_URL; // monitor.js would POST the alarms there

// stateApi.js reads its session from ./supabaseClient (a browser module). Hand it this
// test's session instead, so postOrgState runs as the app runs it.
const session = { token: null };
globalThis.__orgStateStaleBaseSession = () => (session.token ? { access_token: session.token } : null);
const SESSION_MODULE = 'export const supabase = { auth: { getSession: async () => ({ data: { session: globalThis.__orgStateStaleBaseSession() } }) } };';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './supabaseClient' && context.parentURL?.endsWith('/src/lib/stateApi.js')) {
      return { url: `data:text/javascript,${encodeURIComponent(SESSION_MODULE)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Imported AFTER the env is set: _lib/orgState.js reads the org id at load.
const { default: handler } = await import('../api/state/org-state.js');
const { default: settingsHandler } = await import('../api/settings/[...path].js');
const { default: webhookHandler } = await import('../api/webhooks/[...path].js');
const { protectedFingerprint } = await import('../api/_lib/orgStateGuard.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { postOrgState } = await import('../src/lib/stateApi.js');
const { canonicalJson } = await import('../src/lib/canonicalJson.js');
const { writeOrgState, readOrgState, readProtectedFingerprint } = await import('../api/_lib/orgState.js');
if (process.env.SUPABASE_URL !== FAKE) {
  console.error('test-org-state-stale-base: SUPABASE_URL is not the local fake; refusing to run.');
  process.exit(2);
}

// The route, driven the way Vercel calls it. VERBOSE=1 prints every answer.
const drive = (authorization, bodyText) => new Promise((resolve) => {
  const req = { method: 'POST', query: {}, headers: { authorization, 'content-length': String(Buffer.byteLength(bodyText)) }, body: JSON.parse(bodyText) };
  const done = (out) => {
    if (process.env.VERBOSE) console.log(`  ${authorization.slice(7)} base ${req.body.baseVersion} -> ${out.status} ${JSON.stringify(out.body)}`);
    resolve(out);
  };
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { done({ status: this.statusCode, body: o }); return this; },
    setHeader() {},
    end() { done({ status: this.statusCode, body: null }); },
  };
  Promise.resolve(handler(req, res)).catch((e) => done({ status: 'THREW', body: String(e?.stack || e) }));
});
// Bodies are serialized the way flush() serializes them (canonicalJson: keys sorted).
const raw = (token, state, baseVersion, build = 0) =>
  drive(`Bearer ${token}`, `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":${build},"tab":"t_test"}`);

// postOrgState fetches `/api/state/org-state`; route that to the handler, and anything
// else (supabase-js calling the fake) to the real fetch.
let lastServer = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (url !== '/api/state/org-state') return realFetch(url, init);
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  lastServer = await drive(headers.authorization, init.body);
  return new Response(lastServer.body == null ? null : JSON.stringify(lastServer.body), { status: lastServer.status === 'THREW' ? 500 : lastServer.status });
};
// A save as the app makes it: `client` is what flush() branches on, `server` the route's answer.
const save = async (token, state, baseVersion, build = 0) => {
  session.token = token;
  lastServer = null;
  let client;
  try {
    client = await postOrgState({ stateJson: canonicalJson(state), baseVersion, build, tab: 't_test' });
  } catch (e) {
    client = { threw: e.message };
  }
  return { client, server: lastServer || {} };
};

const alarms = []; // tags, in order
const alarmRecords = []; // the structured record monitor.js logs with each
const realError = console.error;
console.error = (...args) => {
  if (args[0] !== '[ALERT]') { realError(...args); return; }
  alarms.push(String(args[1]));
  try { alarmRecords.push(JSON.parse(args[2])); } catch { alarmRecords.push(null); }
};
const lastAlarm = () => alarmRecords[alarmRecords.length - 1] || null;
const BASELINE_ALARM = 'org_state.baseline_mismatch';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── fixtures ──────────────────────────────────────────────────────────────────
const clone = (x) => JSON.parse(JSON.stringify(x));
const edit = (fn, from) => { const s = clone(from); fn(s); return s; };
const member = (s, id) => s.users.find((u) => u.id === id);
const committed = () => ({
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co' },
    { id: 'u_admin', role: 'admin', status: 'active', name: 'Admin', email: 'admin@cs.co' },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Renata', email: 'mgr@cs.co' },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: 'crew@cs.co', phone: '555-0101' },
    { id: 'u_member', role: 'crew', status: 'active', name: 'Member', email: 'member@cs.co', phone: '555-0100',
      pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0005', hireDate: '2025-01-02' } },
  ],
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  sites: [{ id: 's1', clientId: 'c1', standingCrewIds: [] }],
  clients: [{ id: 'c1', name: 'Acme' }],
  company: { id: 'co', name: 'Clean Space', timezone: 'America/Los_Angeles' },
  timeOff: [],
});
// The digest the route stores on a commit: taken from the client's canonical body.
const storedDigest = (state) => protectedFingerprint(JSON.parse(canonicalJson(state)));
// Every write stamps its own instant, as the writers do (updated_at).
let clock = Date.UTC(2026, 8, 23, 12, 0, 0);
const tick = () => new Date(clock += 1000).toISOString();
// What the code under test keeps in protected_fingerprint: `<digest>@<version>/<updated_at
// ms>` since 2026-09-23, the bare digest before. Probed through the real reader, so the
// fixtures seed the row the way that code's own commits leave it.
{
  const at = tick();
  row = { organization_id: ORG, version: 5, updated_at: at, state: {}, protected_fingerprint: `probe@5/${Date.parse(at)}`, min_client_build: null };
}
const TAGGED = (await readProtectedFingerprint())?.taggedVersion === 5;
const storedValue = (state, version, at) => (TAGGED ? `${storedDigest(state)}@${version}/${Date.parse(at)}` : storedDigest(state));
// The row as the route leaves it: the stored digest is the committed state's.
const seed = (state, version, extra = {}) => {
  const at = tick();
  row = { organization_id: ORG, version, updated_at: at, state: clone(state), protected_fingerprint: storedValue(state, version, at), min_client_build: null, ...extra };
  calls = [];
  crewSyncCalls.length = 0;
  alarms.length = 0;
  alarmRecords.length = 0;
  afterRead = null;
  failRead = null;
};
// A teammate's commit landing in the database mid-request: what writeOrgStateFromClient stores.
const landWrite = (fn) => {
  const next = edit(fn, row.state);
  const at = tick();
  Object.assign(row, { state: next, version: row.version + 1, updated_at: at, protected_fingerprint: storedValue(next, row.version + 1, at) });
};
// The owner saving through the route from the current base (the newer change a stale tab lacks).
const ownerCommits = async (fn, label) => {
  const r = await raw('tok-owner', edit(fn, row.state), row.version);
  ok(`fixture: the owner's save (${label}) commits`, r.status === 200);
  calls = [];
};
const writes = () => calls.filter((c) => c.method === 'PATCH').length;
// "the field guard ran its full read" — counted by a slice UNIQUE to PROTECTED_SELECT.
// `users:state->users` is no longer that sentinel: since S93 resolveAuthority reads it
// once per request for the roster-status check (a disabled member is refused everywhere),
// so it appears on saves the guard never touched. `timeOff:state->timeOff` is in the
// guard's full read but in neither the status read (`users` only) nor readAuthzSlices
// (`permissions,userPermissionOverrides` only), so it still means exactly "the guard read".
const fullReads = () => calls.filter((c) => c.method === 'GET' && c.select.includes('timeOff:state->timeOff')).length;

// Newer protected changes (the owner's), and the stale tab's own edits (each allowed for
// its role on a current base).
const NEWER = {
  pay: (s) => { member(s, 'u_member').pay = { type: 'hourly', hourlyRate: 24 }; },
  role: (s) => { member(s, 'u_member').role = 'admin'; },
  overrides: (s) => { s.userPermissionOverrides = [{ userId: 'u_mgr', grants: [], revokes: ['invoices.view'] }]; },
  timezone: (s) => { s.company.timezone = 'America/New_York'; },
};
const MINE = {
  bookOff: (s) => { s.timeOff = [...(s.timeOff || []), { id: 'to1', userId: 'u_member', startDate: '2026-09-24', endDate: '2026-09-24', kind: 'callout' }]; },
  ownPhone: (s) => { member(s, 'u_crew').phone = '555-0199'; },
  renameCompany: (s) => { s.company.name = 'Clean Space LLC'; },
  renameClient: (s) => { s.clients[0].name = 'Acme Holdings'; },
};

// ── 1. the bug: a stale save that "reverts" a newer protected change, every role ──
const STALE = [
  { token: 'tok-mgr', newer: 'pay', mine: 'bookOff', label: "a manager books time off from v7 after the owner raised a member's pay in v8" },
  { token: 'tok-admin', newer: 'role', mine: 'ownPhone', label: 'crew edit their own phone from v7 after the owner re-roled a member in v8' },
  { token: 'tok-mgr', newer: 'overrides', mine: 'renameCompany', label: "a manager renames the company from v7 after the owner pared back that manager's overrides in v8" },
  { token: 'tok-admin', newer: 'timezone', mine: 'renameClient', label: 'an admin renames an account from v7 after the owner moved the timezone in v8' },
  { token: 'tok-mgr-claim', newer: 'role', mine: 'bookOff', label: 'a claim-backed manager books time off from v7 after the owner re-roled a member in v8' },
];
for (const c of STALE) {
  seed(committed(), 7);
  await ownerCommits(NEWER[c.newer], c.newer);
  const r = await save(c.token, edit(MINE[c.mine], committed()), 7);
  ok(`${c.label}: 409 conflict at v8, no violations (it was a 403, then an unjudged write attempt)`,
    r.server.status === 409 && r.server.body?.conflict === true && r.server.body?.version === 8 && !r.server.body?.violations);
  ok('  ...which the client reads as a conflict to replay, not a refusal that drops the batch',
    r.client.ok === false && r.client.conflict === true && !r.client.rejected && !r.client.gated);
  ok('  ...no write attempted, no protected-slice read', writes() === 0 && fullReads() === 0 && row.version === 8);
  // The client adopts v8 and replays its own edit on top.
  calls = [];
  const replay = await save(c.token, edit(MINE[c.mine], row.state), 8);
  ok("  ...its replay on v8 commits, with the owner's change kept",
    replay.client.ok === true && row.version === 9
      && canonicalJson(row.state) === canonicalJson(edit(MINE[c.mine], edit(NEWER[c.newer], committed()))));
  if (c.mine === 'bookOff') ok('  ...and the guard judged that replay against v8 (it read the protected slices)', fullReads() === 1);
}

// ── 2. no hole: nothing is ever written without a decision about the version it replaces ──
const promote = (s) => { member(s, 'u_crew').role = 'owner'; };
{
  seed(committed(), 7);
  await ownerCommits(NEWER.pay, 'pay');
  let r = await save('tok-admin', edit(promote, committed()), 7);
  ok('an admin promoting a member to Super Admin from a stale base: 409, nothing written', r.server.status === 409 && writes() === 0 && row.version === 8);
  r = await save('tok-admin', edit(promote, row.state), 8);
  ok('  ...the replay is judged against fresh state: 403 with violations, read as a refusal, nothing written',
    r.server.status === 403 && (r.server.body?.violations || []).length > 0 && r.client.rejected === true
      && row.version === 8 && member(row.state, 'u_crew').role === 'crew');
}
{
  seed(committed(), 8);
  const r = await save('tok-admin', edit(promote, committed()), 9);
  ok('a base AHEAD of the committed version (9 vs 8) is a CAS miss as well: 409 at v8, nothing written',
    r.server.status === 409 && r.server.body?.version === 8 && writes() === 0 && row.version === 8);
}
{
  // The same save, with a teammate's ordinary commit landing as v9 right after the route's
  // full read (v8). Waved through unjudged as "stale, can't commit", the CAS on 9 then
  // matched and crew made themselves owner (200). The digest read already shows v8, so
  // the save is answered there and the full read (and the landing) never happen.
  seed(committed(), 8);
  // Fire the teammate's commit right after the GUARD'S FULL READ (PROTECTED_SELECT, which
  // uniquely carries `timeOff`), NOT after the S93 roster-status read (`users` only, earlier
  // in requireAuthority) — keying on `users` here would land the write before the digest read
  // even runs and rewrite the race this scenario is pinning.
  afterRead = { when: (sel) => sel.includes('timeOff:state->timeOff'), run: () => landWrite(MINE.renameClient) };
  let r = await raw('tok-admin', edit(promote, committed()), 9);
  ok('crew promoting themselves from a base AHEAD: 409 at the digest read, before any full read, nothing written, crew stay crew (it was a 200 that made them owner once a commit landed after the full read)',
    r.status === 409 && fullReads() === 0 && writes() === 0 && member(row.state, 'u_crew').role === 'crew');
  // With the digest read failing, the full read is what must catch it, and the commit does land.
  seed(committed(), 8);
  failRead = { when: (sel) => sel.includes('protected_fingerprint') && !sel.includes('users') };
  afterRead = { when: (sel) => sel.includes('timeOff:state->timeOff'), run: () => landWrite(MINE.renameClient) };
  r = await raw('tok-admin', edit(promote, committed()), 9);
  ok('  ...and with the digest read failing, the full read (v8) answers it: 409 at v9, the teammate\x27s commit stands, nothing written, crew stay crew (it was a 200: crew → owner)',
    r.status === 409 && r.body?.version === 9 && row.version === 9 && writes() === 0 && member(row.state, 'u_crew').role === 'crew');
}
{
  seed(committed(), 8);
  const r = await save('tok-admin', edit(promote, committed()), 8);
  ok('a CURRENT base with a forbidden change is still refused: 403, read as a refusal, nothing written',
    r.server.status === 403 && r.client.rejected === true && writes() === 0 && row.version === 8);
}
{
  seed(committed(), 8);
  const r = await save('tok-admin', edit(MINE.ownPhone, committed()), 8);
  ok('an ordinary save on a current base takes the fast path: 200, no protected-slice read',
    r.client.ok === true && row.version === 9 && fullReads() === 0);
}
{
  // The fast-path race. A save whose protected fields equal v8's but whose base claims v9
  // passes the fingerprint compare; the owner demotes the manager (v9) right after that
  // read; a CAS on 9 would then replace the demotion without the guard ever looking.
  seed(committed(), 8);
  afterRead = { when: (sel) => sel.includes('protected_fingerprint'), run: () => landWrite((s) => { member(s, 'u_mgr').role = 'crew'; }) };
  const r = await raw('tok-mgr', edit(MINE.renameCompany, committed()), 9);
  ok("a base claiming a version that lands mid-request can't overwrite it through the fast path: 409, the demotion stands (it was a 200 that undid it)",
    r.status === 409 && row.version === 9 && member(row.state, 'u_mgr').role === 'crew');
}
{
  // The window between the fingerprint read and the full read. The manager's save is
  // current (v8) and moves the digest (time off); the owner moves the timezone (v9) in
  // between. The full read then shows v9.
  seed(committed(), 8);
  afterRead = { when: (sel) => sel.includes('protected_fingerprint') && !sel.includes('users'), run: () => landWrite(NEWER.timezone) };
  const r = await raw('tok-mgr', edit(MINE.bookOff, committed()), 8);
  ok('a write landing between the fingerprint read and the full read: 409 at v9 (it was a 403, then an unjudged write attempt)',
    r.status === 409 && r.body?.conflict === true && r.body?.version === 9 && writes() === 0);
  ok('  ...with no false baseline alarm (the two reads were of different versions)', !alarms.includes(BASELINE_ALARM));
  ok("  ...and the owner's write stands", row.version === 9 && row.state.company.timezone === 'America/New_York');
}
{
  // The fingerprint read fails (its reader turns an error into "unknown"); the full read
  // still pins the version.
  seed(committed(), 7);
  await ownerCommits(NEWER.timezone, 'timezone');
  failRead = { when: (sel) => sel.includes('protected_fingerprint') };
  const r = await raw('tok-admin', edit(MINE.renameClient, committed()), 7);
  ok('the fingerprint read fails on a stale base: the full read still answers 409 (it was a 403, then an unjudged write attempt)',
    r.status === 409 && r.body?.version === 8 && writes() === 0 && row.version === 8);
}
{
  // An unknown digest on a CURRENT base fails closed into the guard, and raises no alarm
  // (there is no stored digest to disagree with).
  seed(committed(), 8);
  failRead = { when: (sel) => sel.includes('protected_fingerprint') };
  let r = await raw('tok-admin', edit(MINE.ownPhone, committed()), 8);
  ok('the fingerprint read fails on a current base: the guard runs (full read) and an ordinary save commits, no alarm',
    r.status === 200 && fullReads() === 1 && row.version === 9 && !alarms.includes(BASELINE_ALARM));
  seed(committed(), 8);
  failRead = { when: (sel) => sel.includes('protected_fingerprint') };
  r = await raw('tok-admin', edit(promote, committed()), 8);
  ok('  ...and a forbidden change is refused: 403, nothing written', r.status === 403 && writes() === 0 && row.version === 8);
}
{
  // The fingerprint read fails, the base claims v9, and the owner's demotion of the
  // manager lands as v9 right after the full read (v8). Judged against v8, the save would
  // pass and then replace v9.
  seed(committed(), 8);
  failRead = { when: (sel) => sel.includes('protected_fingerprint') };
  afterRead = { when: (sel) => sel.includes('timeOff:state->timeOff'), run: () => landWrite((s) => { member(s, 'u_mgr').role = 'crew'; }) };
  const r = await raw('tok-admin', edit(MINE.ownPhone, committed()), 9);
  ok("with no digest, a base AHEAD of the full read is still a miss: 409, the commit that lands mid-request stands (it was a 200 that undid it)",
    r.status === 409 && r.body?.version === 9 && row.version === 9 && member(row.state, 'u_mgr').role === 'crew');
}

// ── 3. answered as a CAS miss would be ────────────────────────────────────────
{
  seed(committed(), 7, { min_client_build: 100 });
  await ownerCommits(NEWER.timezone, 'timezone'); // build 0 = unknown, never gated
  const r = await save('tok-admin', edit(MINE.renameClient, committed()), 7, 50);
  ok('a stale base on a build below min_client_build answers gated, so the client reloads (it was a 403, then an unjudged write attempt)',
    r.server.status === 409 && r.server.body?.gated === true && r.server.body?.minClientBuild === 100
      && r.client.gated === true && writes() === 0 && row.version === 8);
}
{
  seed(committed(), 8, { min_client_build: 100 });
  const r = await save('tok-admin', edit(MINE.renameClient, committed()), 8, 50);
  ok('a current base below min_client_build still answers gated, from the CAS', r.server.status === 409 && r.server.body?.gated === true && row.version === 8);
}
{
  seed(committed(), 7);
  row = null;
  const r = await raw('tok-owner', committed(), 7);
  ok('no org_state row: 500 "row not found" (never a 409 loop), no write attempted',
    r.status === 500 && /not found/.test(r.body?.error || '') && writes() === 0);
}
{
  // The read that tells conflict from gate fails. It used to read as "no row", which
  // answers "org_state row not found — check CLEANSPACE_ORG_ID": a wrong lead.
  const missRead = (sel) => sel.includes('min_client_build');
  seed(committed(), 7);
  await ownerCommits(NEWER.timezone, 'timezone');
  failRead = { when: missRead };
  let r = await raw('tok-admin', edit(MINE.renameClient, committed()), 7);
  ok('the miss read fails on a stale base: 500 naming the failed read, not "row not found", nothing written',
    r.status === 500 && /miss read failed/.test(r.body?.error || '') && !/not found/.test(r.body?.error || '') && row.version === 8);
  seed(committed(), 8);
  afterRead = { when: (sel) => sel.includes('protected_fingerprint'), run: () => landWrite(MINE.renameClient) };
  failRead = { when: missRead };
  r = await raw('tok-admin', edit(MINE.ownPhone, committed()), 8);
  ok('  ...and after a CAS miss on a current base, the same (it said "row not found")',
    r.status === 500 && /miss read failed/.test(r.body?.error || '') && row.version === 9);
}

// ── 4. the baseline alarm (C6) ────────────────────────────────────────────────
{
  // Something wrote around the route: the state changed and the version moved, but the
  // stored digest did not. The admin's stale tab books time off, which moves the digest,
  // so the full check runs.
  seed(committed(), 7);
  Object.assign(row, { state: edit(promote, row.state), version: 8 });
  let r = await raw('tok-admin', edit(MINE.bookOff, committed()), 7);
  ok('a stale save over a tampered baseline is a plain 409 with no alarm: it judged nothing (it was a 403 + an alarm, then an alarm + an unjudged write attempt)',
    r.status === 409 && !alarms.includes(BASELINE_ALARM) && writes() === 0);
  calls = [];
  r = await raw('tok-admin', edit(MINE.bookOff, row.state), 8);
  ok('  ...the replay on the current version raises the baseline alarm, once',
    r.status === 200 && alarms.filter((a) => a === BASELINE_ALARM).length === 1);
}
{
  // A row this route never wrote carries no digest: the full check runs, with nothing to
  // alarm against, and the commit stores one.
  seed(committed(), 8, { protected_fingerprint: null });
  const r = await raw('tok-admin', edit(MINE.ownPhone, committed()), 8);
  ok('no stored digest: the full check runs, no alarm, and the commit stores the digest',
    r.status === 200 && fullReads() === 1 && !alarms.includes(BASELINE_ALARM)
      && row.protected_fingerprint === storedValue(row.state, row.version, row.updated_at));
}

// ── 5. the stored digest vouches only for the commit it was stored in ──────────
// A server writer that changes nothing protected (a cron, a notification): the REAL
// writeOrgState, reading first as its callers do, through supabase-js to the fake.
const serverWrite = async (fn) => {
  const { state, version } = await readOrgState();
  return writeOrgState(edit(fn, state), version);
};
// A server writer that changes a protected field: the REAL settings reconcile-self route,
// appending the roster row a claim-backed login is missing (it hands writeOrgState its read).
const reconcile = (token) => new Promise((resolve) => {
  const req = { method: 'POST', query: { subpath: 'users/reconcile-self' }, headers: { authorization: `Bearer ${token}` } };
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { resolve({ status: this.statusCode, body: o }); return this; },
    setHeader() {},
    end() { resolve({ status: this.statusCode, body: null }); },
  };
  Promise.resolve(settingsHandler(req, res)).catch((e) => resolve({ status: 'THREW', body: String(e?.stack || e) }));
});
const reconciled = (r) => r.status === 200 && r.body?.reconciled === true && !!member(row.state, 'u_new');
// A server writer that can add a customer (a protected change: customer ids are in the
// digest): the REAL public lead webhook, bearer-authenticated, with a lead naming a company
// the org doesn't have yet (it hands writeOrgState its read too).
const leadWebhook = (payload) => new Promise((resolve) => {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))], { objectMode: false }), {
    method: 'POST', query: { path: ['leads', LEAD_EP.slug] }, headers: { authorization: `Bearer ${LEAD_EP.bearer_token}` },
  });
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { resolve({ status: this.statusCode, body: o }); return this; },
    setHeader() {},
    end() { resolve({ status: this.statusCode, body: null }); },
  };
  Promise.resolve(webhookHandler(req, res)).catch((e) => resolve({ status: 'THREW', body: String(e?.stack || e) }));
});
// An operator script (set-user-role, restore-pepin-roster, finalize-harnish…): it writes
// state + version + updated_at straight to the row and never touches the digest.
const scriptWrite = (fn) => { Object.assign(row, { state: edit(fn, row.state), version: row.version + 1, updated_at: tick() }); };
// A hand SQL or Studio edit of `state` alone: version and updated_at stay as they were.
const stateOnlyWrite = (fn) => { row.state = edit(fn, row.state); };
const notify = (s) => { s.notifications = [...(s.notifications || []), { id: `n${clock}`, type: 'opsAlert' }]; };
const withRows = (s) => {
  s.timeOff = [{ id: 'to0', userId: 'u_member', startDate: '2026-09-20', endDate: '2026-09-20', kind: 'planned' }];
  s.userPermissionOverrides = [{ userId: 'u_member', grants: ['invoices.view'], revokes: [] }];
};
const selfGrant = (s) => { s.userPermissionOverrides = [{ userId: 'u_crew', grants: ['settings.roles.edit'], revokes: [] }]; };
const baselineAlarms = () => alarms.filter((a) => a === BASELINE_ALARM).length;
{
  // The reviewers' repro (found in review, 2026-09-23): a server writer's protected
  // change, then a save on the current base that puts the older content back.
  seed(committed(), 8);
  const rr = await reconcile('tok-new');
  ok('fixture: the real reconcile-self route appends the missing roster row: v9', reconciled(rr) && row.version === 9);
  calls = [];
  ledgerReads.length = 0;
  // CS-002: this used a crew actor to show reconcile-self's server write does not launder a
  // forbidden change past the digest; crew now route through the crew MERGE (no digest path),
  // so use an admin doing an owner-only change (timezone) — judged against fresh state (which
  // includes the reconcile-added member), refused, nothing committed (so no post-commit sync).
  const r = await save('tok-admin', edit((s) => { s.company.timezone = 'America/New_York'; }, row.state), 9);
  ok('an admin change after reconcile-self is JUDGED against fresh state, not fast-pathed: 403 owner-only, nothing committed, the server-added member stays',
    r.server.status === 403 && (r.server.body?.violations || []).includes('change the company timezone')
      && row.version === 9 && !!member(row.state, 'u_new'));
}
{
  // A lead naming a new company: the public webhook adds that customer. Customer ids are in
  // the digest, so this is a protected change by a server writer, and it passes its read,
  // so the digest names v9: nothing reads the webhook's customer as an outside write.
  seed(committed(), 8);
  const lead = await leadWebhook({ firstName: 'Lee', lastName: 'Lead', email: 'lee@newco.example', company: 'NewCo LLC' });
  ok('fixture: the real lead webhook files the lead with its new customer: v9',
    lead.status === 200 && lead.body?.status === 'created' && row.version === 9 && row.state.clients.length === 2);
  calls = [];
  const r = await save('tok-admin', edit(MINE.ownPhone, row.state), 9);
  ok("  ...so crew's next ordinary save keeps the fast path: 200, no protected read, no baseline alarm (it alarmed: the webhook's customer read as an outside write)",
    r.client.ok === true && row.version === 10 && fullReads() === 0 && baselineAlarms() === 0);
}
{
  // An operator script demotes the manager; the demoted login puts their old role back.
  seed(committed(), 8);
  scriptWrite((s) => { member(s, 'u_mgr').role = 'crew'; });
  // The claim-backed manager (office; a claim-less one would resolve as the demoted crew role
  // and route through the merge). Restoring their OWN role is a self access-level change → 403.
  const r = await raw('tok-mgr-claim', edit(MINE.renameCompany, edit((s) => { member(s, 'u_mgr').role = 'manager'; }, row.state)), 9);
  ok('after an operator script demotes a manager (v9), their save restoring the role is judged: 403, the demotion stands (it was 200)',
    r.status === 403 && row.version === 9 && member(row.state, 'u_mgr').role === 'crew');
  ok('  ...and the baseline alarm fires once, naming the versions (digest v8, row v9)',
    baselineAlarms() === 1 && lastAlarm()?.digestVersion === 8 && lastAlarm()?.rowVersion === 9);
}
{
  // An outside write, THEN a server write (any cron, or any staff member filing a QC problem
  // report), THEN an honest save. The server write must not vouch for the outside change:
  // stamping blindly laundered it (no alarm, no crew-assignment sync; found in review).
  seed(committed(), 8);
  scriptWrite(selfGrant);
  await serverWrite(notify);
  calls = [];
  const r = await raw('tok-admin', edit(MINE.ownPhone, row.state), 10);
  ok("a server write after an outside write doesn't launder it: the next save runs the full check and the alarm names digest v8, row v10",
    r.status === 200 && fullReads() === 1 && baselineAlarms() === 1
      && lastAlarm()?.digestVersion === 8 && lastAlarm()?.rowVersion === 10);
}
{
  // The same with an edit that keeps version AND updated_at (hand SQL, Studio), which leaves
  // the tag looking current: the server write must check the row itself (found in the second
  // review, 2026-09-23), whether it changes nothing protected (a cron)...
  seed(committed(), 8);
  stateOnlyWrite(selfGrant);
  await serverWrite(notify);
  calls = [];
  let r = await raw('tok-admin', edit(MINE.ownPhone, row.state), 9);
  ok("an edit that kept version and updated_at, then a cron's write: not laundered, the next save runs the full check and alarms (digest v8, row v9)",
    r.status === 200 && fullReads() === 1 && baselineAlarms() === 1
      && lastAlarm()?.digestVersion === 8 && lastAlarm()?.rowVersion === 9);
  // ...or something protected (reconcile-self, which hands over its read).
  seed(committed(), 8);
  stateOnlyWrite(selfGrant);
  const rr = await reconcile('tok-new');
  calls = [];
  r = await raw('tok-admin', edit(MINE.ownPhone, row.state), 9);
  ok('  ...then reconcile-self (a protected server write): still not laundered, the next save alarms',
    reconciled(rr) && r.status === 200 && fullReads() === 1 && baselineAlarms() === 1 && lastAlarm()?.digestVersion === 8);
}
{
  // The cheap digest read fails right after an outside write (its reader turns a failure
  // into "unknown"): the full read carries the stored digest too, so the alarm still fires.
  seed(committed(), 8);
  scriptWrite((s) => { member(s, 'u_mgr').role = 'crew'; });
  failRead = { when: (sel) => sel.includes('protected_fingerprint') && !sel.includes('users') };
  const r = await raw('tok-owner', edit(MINE.renameClient, row.state), 9);
  ok('when the digest read fails after an outside write, the full read still carries the digest: the alarm fires once (digest v8)',
    r.status === 200 && fullReads() === 1 && baselineAlarms() === 1 && lastAlarm()?.digestVersion === 8);
}
{
  // A script revokes standing crew (finalize-harnish writes standingCrewIds: [] and never
  // syncs crew_assignments); a server write follows. The next save must still run the
  // sync, or the revoked crew keep door-code and QC access.
  seed(edit((s) => { s.sites[0].standingCrewIds = ['u_crew']; }, committed()), 8);
  scriptWrite((s) => { s.sites[0].standingCrewIds = []; });
  await serverWrite(notify);
  crewSyncCalls.length = 0;
  const r = await raw('tok-owner', edit(MINE.renameClient, row.state), 10);
  ok('after a script revokes standing crew and a server write follows, the next save runs the crew-assignment sync',
    r.status === 200 && crewSyncCalls.includes('GET') && crewSyncCalls.includes('POST'));
}
{
  // The sync itself, pinned: an authority change syncs, an ordinary save doesn't.
  seed(committed(), 8);
  let r = await raw('tok-owner', edit((s) => { s.sites[0].standingCrewIds = ['u_crew']; }, committed()), 8);
  ok('a save that assigns standing crew runs the crew-assignment sync', r.status === 200 && crewSyncCalls.includes('POST'));
  crewSyncCalls.length = 0;
  r = await raw('tok-admin', edit(MINE.ownPhone, row.state), 9);
  ok('  ...an ordinary save does not', r.status === 200 && crewSyncCalls.length === 0);
}
{
  // A server write that changes nothing protected (a cron adding a notification) must not
  // cost the next save the full read, with rows whose keys jsonb reorders.
  seed(edit(withRows, committed()), 8);
  await serverWrite(notify);
  calls = [];
  const r = await save('tok-admin', edit(MINE.ownPhone, row.state), 9);
  ok('after a server write that changes nothing protected, an ordinary save keeps the fast path (time off + overrides in jsonb key order): 200, no protected read',
    r.client.ok === true && row.version === 10 && fullReads() === 0);
}
{
  // writeOrgState checks the CONTENT, so it needs no tag: after an outside write that
  // changed nothing protected, or at the deploy (a bare digest), a cron's write re-vouches
  // the row and the next save keeps the fast path.
  seed(committed(), 8);
  scriptWrite((s) => { s.clients[0].name = 'Acme (imported)'; });
  await serverWrite(notify);
  calls = [];
  let r = await raw('tok-admin', edit(MINE.ownPhone, row.state), 10);
  ok('an outside write that changed nothing protected, then a cron write: re-vouched, the next save keeps the fast path',
    r.status === 200 && fullReads() === 0 && baselineAlarms() === 0);
  seed(committed(), 8, { protected_fingerprint: storedDigest(committed()) });
  await serverWrite(notify);
  calls = [];
  r = await raw('tok-admin', edit(MINE.ownPhone, row.state), 9);
  ok('  ...and at the deploy, a cron write turns the bare digest into a tagged one: the next save takes the fast path',
    r.status === 200 && fullReads() === 0 && row.protected_fingerprint === `${storedDigest(row.state)}@10/${Date.parse(row.updated_at)}`);
}
{
  seed(committed(), 8);
  const rr = await reconcile('tok-new');
  calls = [];
  alarms.length = 0;
  const r = await raw('tok-owner', edit(NEWER.timezone, row.state), 9);
  ok("reconcile-self's protected change raises no baseline alarm on the next save that runs the guard (it reported a tamper)",
    reconciled(rr) && r.status === 200 && fullReads() === 1 && !alarms.includes(BASELINE_ALARM));
}
{
  // jsonb hands keys back shortest first, the browser sends them sorted (found 2026-09-23).
  seed(edit(withRows, committed()), 8);
  const r = await raw('tok-owner', edit(NEWER.timezone, row.state), 8);
  ok('with time off and overrides present, a legitimate save that runs the guard raises no baseline alarm (key order made every one alarm)',
    r.status === 200 && fullReads() === 1 && !alarms.includes(BASELINE_ALARM));
}
{
  // A direct write that kept the version AND updated_at: the digest's own commit.
  seed(committed(), 8);
  row.state = edit(promote, row.state);
  const r = await raw('tok-admin', edit(MINE.bookOff, row.state), 8);
  ok('a direct write that kept the version and updated_at still alarms, and says so (digest v8 = row v8)',
    r.status === 200 && baselineAlarms() === 1 && lastAlarm()?.digestVersion === 8 && lastAlarm()?.rowVersion === 8);
}
{
  // A restore rewinds the version, and a later write brings the NUMBER back: v12 is then
  // a different commit than the one the digest was stored in. A tab still holding the
  // pre-restore v12 must be judged against the restored content.
  seed(committed(), 11);
  const rr = await reconcile('tok-new'); // v12, stamped
  ok('fixture: reconcile-self commits v12', reconciled(rr) && row.version === 12);
  const pre = clone(row.state); // what the stale tab holds
  Object.assign(row, { state: edit((s) => { member(s, 'u_mgr').role = 'crew'; }, committed()), version: 11, updated_at: tick() }); // the restore
  scriptWrite(notify); // v12 again
  calls = [];
  const r = await raw('tok-mgr-claim', edit(MINE.renameCompany, pre), 12);
  ok('after a restore rewound the version and a write brought v12 back, the pre-restore v12 tab is judged: 403, the restore stands',
    r.status === 403 && fullReads() === 1 && member(row.state, 'u_mgr').role === 'crew' && !member(row.state, 'u_new'));
}
{
  // The deploy: the column still holds a bare digest from before tags.
  seed(committed(), 8, { protected_fingerprint: storedDigest(committed()) });
  let r = await raw('tok-admin', edit(MINE.ownPhone, committed()), 8);
  ok('a digest stored before tags vouches for nothing: one full check, no alarm, and the commit stores a tagged one',
    r.status === 200 && fullReads() === 1 && !alarms.includes(BASELINE_ALARM)
      && row.protected_fingerprint === `${storedDigest(row.state)}@9/${Date.parse(row.updated_at)}`);
  calls = [];
  r = await raw('tok-admin', edit(MINE.renameClient, row.state), 9);
  ok('  ...and the next ordinary save takes the fast path again', r.status === 200 && fullReads() === 0 && row.version === 10);
}
{
  // Only the SAME commit counts: a tag naming another version is no good.
  seed(committed(), 8);
  row.protected_fingerprint = `${storedDigest(committed())}@9/${Date.parse(row.updated_at)}`;
  const r = await raw('tok-admin', edit(MINE.ownPhone, committed()), 8);
  ok('a digest tagged for another commit (v9 on a v8 row) is not trusted: the full check runs', r.status === 200 && fullReads() === 1);
}
{
  // An empty column is garbage, not "no digest": it can't match, so it alarms.
  seed(committed(), 8, { protected_fingerprint: '' });
  const r = await raw('tok-admin', edit(MINE.ownPhone, committed()), 8);
  ok('an empty digest column takes the full check and raises the alarm', r.status === 200 && fullReads() === 1 && baselineAlarms() === 1);
}
{
  // A row the fingerprint can't read (an id that won't convert to a string), written
  // around the route while the digest stayed current: a server write must still land.
  seed(committed(), 8);
  row.state = edit((s) => { s.users.push({ id: { toString: 1 }, role: 'crew' }); }, row.state);
  const before = row.protected_fingerprint;
  let wrote;
  try { wrote = await serverWrite(notify); } catch (e) { wrote = `threw: ${e.message}`; }
  ok("a server write doesn't fail on a row the fingerprint can't read: it lands and leaves the digest alone",
    wrote === true && row.version === 9 && row.protected_fingerprint === before);
}
{
  // A key literally named "__proto__" written around the route into a time-off row. The
  // browser's serializer dropped it, so the guard read every save as changing time off.
  seed(edit(withRows, committed()), 8);
  scriptWrite((s) => { s.timeOff[0] = JSON.parse(JSON.stringify(s.timeOff[0]).replace('{', '{"__proto__":{"x":1},')); });
  calls = [];
  const r = await save('tok-admin', edit(MINE.ownPhone, row.state), 9);
  ok('a "__proto__" key written around the route: the next crew save is judged and passes (no false "change time off"), with one alarm',
    r.server.status === 200 && fullReads() === 1 && baselineAlarms() === 1);
}

ok('the fake saw no unexpected request', unexpected.length === 0);

clearTimeout(watchdog);
server.close();
console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (unexpected.length) console.log(`  unexpected fake calls: ${[...new Set(unexpected)].join(' | ')}`);
console.log('');
process.exit(fails.length ? 1 : 0);
