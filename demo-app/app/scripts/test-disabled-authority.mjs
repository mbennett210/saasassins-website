// A member set to Disabled holds no server authority (2026-09-23).
//
// THE HOLE: resolveAuthority took the role from the JWT claim (or, for a claim-less login,
// from the roster row) and never read `users[].status`. The only thing that stopped a
// login was the Supabase ban, which only an owner may set, while since S77 a
// settings.team.edit holder (admins, managers by default) may set another member to
// Disabled. So a member an admin or manager disabled kept every server power until an
// owner also banned the login. Five routes skipped resolveAuthority entirely with a bare
// session check (inbound mail, sending mail, geocoding, the email health read, the
// settings section).
//
// Three layers:
//   A. rosterStatusVerdict, the pure decision (authz.js), tied to the statuses the app
//      writes (the reducer), never a restated list;
//   B. the REAL route handlers + the real Supabase client against a loopback fake of
//      GoTrue + PostgREST (scripts/fake-postgrest.mjs served over HTTP, plus the org_state
//      CAS write): a requirePermission route, the org_state guard path, and the five routes
//      that used a bare session check. Nothing leaves 127.0.0.1;
//   C. the sweep: no route resolves a session itself (getAuthUser / getClaims), so every
//      authority decision passes the status check.
//
//   node app/scripts/test-disabled-authority.mjs
import http from 'node:http';
import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeDb } from './fake-postgrest.mjs';
import { installResolveShim } from './deletion-core.mjs';

installResolveShim(); // Vite writes extensionless imports; plain node needs `.js`
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = '00000000-0000-0000-0000-000000000001';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── identities ────────────────────────────────────────────────────────────────
// Managers are claim-less, as they are live until 'manager' is a claim role (the raw
// app_metadata role 'manager' is not a valid claim, so it resolves the same way).
const AUTH = {
  'tok-owner': { id: 'a-owner', email: 'owner@cs.test', app_metadata: { role: 'owner', org_user_id: 'u_owner' } },
  'tok-owner2': { id: 'a-owner2', email: 'owner2@cs.test', app_metadata: { role: 'owner', org_user_id: 'u_owner2' } },
  'tok-admin': { id: 'a-admin', email: 'admin@cs.test', app_metadata: { role: 'admin', org_user_id: 'u_admin' } },
  'tok-mgr': { id: 'a-mgr', email: 'mgr@cs.test', app_metadata: {} },
  'tok-mgr-raw': { id: 'a-mgr', email: 'mgr@cs.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr' } },
  'tok-crew': { id: 'a-crew', email: 'crew@cs.test', app_metadata: { role: 'crew', org_user_id: 'u_crew' } },
  'tok-orphan': { id: 'a-ghost', email: 'ghost@cs.test', app_metadata: { role: 'admin', org_user_id: 'u_ghost' } },
  // The disabled manager's own login after a Supabase self-service email change: no claims,
  // and no row carries the new address (adversarial review 2026-09-23, finding 1).
  'tok-mgr-newmail': { id: 'a-mgr', email: 'elsewhere@cs.test', app_metadata: {} },
  'tok-stranger': { id: 'a-x', email: 'stranger@cs.test', app_metadata: {} },
  // A split identity: the claim's id isn't the roster row's (the 2026-07-30 incident class).
  'tok-split': { id: 'a-split', email: 'split@cs.test', app_metadata: { role: 'admin', org_user_id: 'u_splitclaim' } },
};
const member = (id, role, status = 'active', extra = {}) => ({ id, name: id, email: `${id.slice(2)}@cs.test`, role, status, ...extra });
const ROSTER = () => [
  member('u_owner', 'owner'),
  member('u_owner2', 'owner'),
  member('u_admin', 'admin'),
  { ...member('u_mgr', 'manager'), email: 'mgr@cs.test' },
  member('u_crew', 'crew'),
  member('u_crew2', 'crew'),
];

// ── the fake backend ──────────────────────────────────────────────────────────
const db = fakeDb({}, { maxRows: 1000 });
const log = [];
let failRosterRead = false;
function reset(users = ROSTER()) {
  db.tables.org_state = [{
    organization_id: ORG, version: 7, min_client_build: null, protected_fingerprint: null,
    state: { users, permissions: null, userPermissionOverrides: [], sites: [], clients: [], company: { name: 'Clean Space' }, timeOff: [] },
  }];
  db.tables.client_heartbeats = [];
  db.tables.crew_assignments = [];
  db.tables.financial_snapshot = [];
  log.length = 0;
  failRosterRead = false;
}
const setStatus = (id, status) => { reset(ROSTER().map((u) => (u.id === id ? { ...u, status } : u))); };
// Edit the committed roster IN PLACE (no reset): a real disable → re-enable transition.
const patchStatus = (id, status) => {
  committed().state.users = committed().state.users.map((u) => (u.id === id ? { ...u, status } : u));
};
const committed = () => db.tables.org_state[0];

function applyParam(q, key, raw) {
  const dot = raw.indexOf('.');
  const op = raw.slice(0, dot);
  const val = raw.slice(dot + 1);
  if (op === 'in') return q.in(key, val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')));
  if (op === 'is') return q.is(key, val === 'null' ? null : val);
  if (!['eq', 'neq', 'gte', 'lte', 'gt', 'lt'].includes(op)) throw new Error(`fake: op ${op} unsupported`);
  return q[op](key, val);
}
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => resolve(s ? JSON.parse(s) : null));
});
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const body = await readBody(req);
  if (u.pathname === '/auth/v1/user') {
    const user = AUTH[String(req.headers.authorization || '').replace(/^Bearer /, '')];
    return user ? send(200, { aud: 'authenticated', role: 'authenticated', ...user }) : send(401, { msg: 'invalid JWT' });
  }
  const m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  if (!m) return send(404, { message: 'no route' });
  const table = m[1];
  const select = u.searchParams.get('select') || '*';
  log.push(`${req.method} ${table} ${select}`);
  try {
    if (req.method === 'PATCH' && table === 'org_state') {
      // writeOrgStateFromClient: the CAS UPDATE, then .select('version').
      const row = committed();
      const want = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
      if (want('organization_id') !== ORG || String(row.version) !== want('version')) return send(200, []);
      Object.assign(row, body);
      return send(200, [{ version: row.version }]);
    }
    if (req.method === 'POST' && table === 'crew_assignments') {
      for (const r of [].concat(body || [])) db.tables.crew_assignments.push({ id: `ca_${db.tables.crew_assignments.length + 1}`, ...r });
      return send(201);
    }
    if (req.method === 'DELETE' && table === 'crew_assignments') return send(204);
    if (req.method !== 'GET') return send(405, { message: `fake: ${req.method} ${table}` });
    if (failRosterRead && table === 'org_state' && select === 'users:state->users') return send(500, { code: 'XX000', message: 'fake: roster read failed' });
    let q = db.from(table).select(select);
    for (const [key, raw] of u.searchParams) {
      if (['select', 'offset', 'limit', 'order'].includes(key)) continue;
      q = applyParam(q, key, raw);
    }
    for (const part of (u.searchParams.get('order') || '').split(',').filter(Boolean)) {
      const [col, dir] = part.split('.');
      q = q.order(col, { ascending: dir !== 'desc' });
    }
    if (u.searchParams.has('limit')) q = q.range(0, Number(u.searchParams.get('limit')) - 1);
    const r = await q;
    return r.error ? send(400, r.error) : send(200, r.data);
  } catch (e) {
    return send(400, { message: e.message });
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

// Never a live project: every URL is the loopback server above, and nothing may send mail
// or spend a maps key.
process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG; // the org-id trio is ONE value
for (const k of ['RESEND_API_KEY', 'RESEND_VERIFIED_DOMAIN', 'RESEND_DEFAULT_FROM', 'GOOGLE_MAPS_API_KEY', 'ALERT_WEBHOOK_URL']) delete process.env[k];

const load = async (rel) => (await import(pathToFileURL(path.join(APP, ...rel.split('/'))).href)).default;
const heartbeat = await load('api/state/heartbeat.js');
const orgStateRoute = await load('api/state/org-state.js');
const inbound = await load('api/inbox/inbound.js');
const emailSend = await load('api/email/send.js');
const emailHealth = await load('api/email/health.js');
const geo = await load('api/geo.js');
const settings = await load('api/settings/[...path].js');
const authz = await import(pathToFileURL(path.join(APP, 'api', '_lib', 'authz.js')).href);

function call(handler, { token, method = 'GET', query = {}, body } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader() {},
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query, body: body || {} };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 'threw', body: { error: e.message } }));
  });
}
const quiet = async (fn) => {
  const { warn, error } = console;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.error = error; }
};
const refusedDisabled = (r) => r.status === 403 && r.body?.code === 'account-disabled';
const hb = (token) => quiet(() => call(heartbeat, { token }));

try {
  // ── A. the decision, pure ───────────────────────────────────────────────────
  const verdict = typeof authz.rosterStatusVerdict === 'function' ? authz.rosterStatusVerdict : () => ({});
  const noAccess = typeof authz.hasNoAccess === 'function' ? authz.hasNoAccess : () => undefined;
  const ACCESS = authz.ACCESS_STATUSES || [];
  const reducer = readFileSync(path.join(APP, 'src', 'store', 'reducer.js'), 'utf8');
  const teamDetail = readFileSync(path.join(APP, 'src', 'pages', 'settings', 'TeamDetail.jsx'), 'utf8');
  // Every status the app writes, read from the writers themselves (never a restated list):
  // Team › Status's options, REVOKE_INVITATION's 'inactive', ADD_USER's default 'invited'.
  const statusOptions = [...(teamDetail.match(/options=\{\[\{ value: 'active'[^\]]*\]/)?.[0] || '').matchAll(/value: '(\w+)'/g)].map((m) => m[1]);
  const written = new Set([...statusOptions,
    ...(/case ACTIONS\.REVOKE_INVITATION:[\s\S]{0,600}status: 'inactive'/.test(reducer) ? ['inactive'] : []),
    ...(/status: 'invited', role: 'crew'/.test(reducer) ? ['invited'] : [])]);
  ok(`A1 the access statuses are an allowlist of exactly "active" + "invited" (the app writes: ${[...written].join(', ')})`,
    ACCESS.length === 2 && ACCESS.includes('active') && ACCESS.includes('invited')
      && ['active', 'invited', 'disabled', 'inactive'].every((s) => written.has(s)));
  ok('A2 every status the app writes is classified: active + invited keep access, the rest end it',
    [...written].every((s) => noAccess({ status: s }) === !['active', 'invited'].includes(s)));
  const R = ROSTER();
  const who = (orgUserId, role) => ({ orgUserId, role });
  const off = (id, status = 'disabled') => R.map((u) => (u.id === id ? { ...u, status } : u));
  ok('A3 an active manager is allowed', verdict(who('u_mgr', 'manager'), R).refused === false);
  ok('A4 a disabled manager is refused', verdict(who('u_mgr', 'manager'), off('u_mgr')).refused === true);
  ok('A5 a disabled admin is refused', verdict(who('u_admin', 'admin'), off('u_admin')).refused === true);
  ok('A6 a disabled crew member is refused', verdict(who('u_crew', 'crew'), off('u_crew')).refused === true);
  ok('A7 "inactive" (a revoked invite) is refused', verdict(who('u_admin', 'admin'), off('u_admin', 'inactive')).refused === true);
  ok('A8 "invited" is allowed', verdict(who('u_admin', 'admin'), off('u_admin', 'invited')).refused === false);
  ok('A9 a Super Admin is never refused by status (claim role)', verdict(who('u_owner', 'owner'), off('u_owner')).refused === false);
  ok('🔴 A10 but a ROW saying owner exempts nobody: an admin who planted `{ id: self, role: \'owner\' }` is still refused',
    verdict(who('u_admin', 'admin'), [member('u_admin', 'owner'), ...off('u_admin')]).refused === true);
  ok('A11 a crafted duplicate disabled crew row cannot lock a Super Admin out',
    verdict(who('u_owner', 'owner'), [...R, member('u_owner', 'crew', 'disabled')]).refused === false);
  ok('A12 ANY disabled row with the caller\'s id refuses (a duplicate can\'t hide one)',
    verdict(who('u_admin', 'admin'), [...R, member('u_admin', 'admin', 'disabled')]).refused === true);
  ok('A13 fallback contract: no matching row is decided as before (allowed)', verdict(who('u_ghost', 'admin'), R).refused === false);
  ok('A14 fallback contract: an unreadable roster is decided as before (allowed)', verdict(who('u_admin', 'admin'), null).refused === false);
  ok('A15 fallback contract: no id is decided as before (allowed)', verdict(who(null, 'admin'), off('u_admin')).refused === false);
  ok('A16 a malformed roster cannot throw', (() => { try { return verdict(who('u_admin', 'admin'), [null, 5, 'x', { id: 'u_admin', status: 'disabled' }]).refused === true; } catch { return false; } })());
  ok('A17 a Super Admin CLAIM is never refused, even when their only row reads admin + disabled (a stale owner claim is the claim layer\'s to end)',
    verdict(who('u_owner', 'owner'), R.map((u) => (u.id === 'u_owner' ? { ...u, role: 'admin', status: 'disabled' } : u))).refused === false);
  ok('🔴 A18 a status is judged trimmed and case-folded: "Disabled", " disabled ", "INACTIVE" end access',
    ['Disabled', ' disabled ', 'INACTIVE'].every((s) => noAccess({ status: s }) === true)
      && verdict(who('u_admin', 'admin'), off('u_admin', 'Disabled ')).refused === true);
  ok('A19 …while "Active" and " invited" keep it, and a row with no status is decided as before',
    noAccess({ status: 'Active' }) === false && noAccess({ status: ' invited' }) === false
      && [undefined, null, ''].every((s) => noAccess({ status: s }) === false));
  ok('🔴 A20 an unknown or malformed status ends access (an allowlist, not a denylist)',
    ['suspended', 'archived'].every((s) => noAccess({ status: s }) === true)
      && [5, ['disabled'], { v: 'disabled' }, true].every((s) => noAccess({ status: s }) === true));
  ok('🔴 A21 a claim-less login no row carries holds nothing (not-on-team)',
    verdict(who(null, null), R, { claimless: true }).refused === true
      && verdict(who(null, null), R, { claimless: true }).reason === 'not-on-team');
  ok('A22 …but a CLAIMED login with no row keeps its claim, and a claim-less one on an absent roster is decided as before',
    verdict(who('u_ghost', 'admin'), R, { claimless: false }).refused === false
      && verdict(who(null, null), null, { claimless: true }).refused === false);
  const splitRow = { id: 'u_splitrow', email: 'split@cs.test', role: 'admin', status: 'disabled' };
  ok('🔴 A23 a split identity (no row has the claim\'s id) is judged by the login\'s email rows: disabled refuses',
    verdict(who('u_splitclaim', 'admin'), [...R, splitRow], { emailRows: [splitRow] }).refused === true
      && verdict(who('u_splitclaim', 'admin'), [...R, { ...splitRow, status: 'active' }], { emailRows: [{ ...splitRow, status: 'active' }] }).refused === false);
  ok('A24 …and an id match wins over the email rows (a disabled email twin can\'t refuse a claimed member whose own row is active)',
    verdict(who('u_admin', 'admin'), [...R, { ...splitRow, email: 'admin@cs.test' }], { emailRows: [{ ...splitRow, email: 'admin@cs.test' }] }).refused === false);

  // ── B1. a requirePermission route (GET /api/state/heartbeat, settings.team.view) ──
  reset();
  ok('B1 control: an active manager reads it', (await hb('tok-mgr')).status === 200);
  setStatus('u_mgr', 'disabled');
  ok('🔴 B2 a DISABLED manager (claim-less) is refused: 403 account-disabled', refusedDisabled(await hb('tok-mgr')));
  ok('🔴 B3 …and with an id claim + a raw "manager" role claim', refusedDisabled(await hb('tok-mgr-raw')));
  setStatus('u_admin', 'disabled');
  ok('🔴 B4 a DISABLED admin (claimed role) is refused: 403 account-disabled', refusedDisabled(await hb('tok-admin')));
  setStatus('u_admin', 'inactive');
  ok('🔴 B5 an admin whose invite was revoked ("inactive") is refused', refusedDisabled(await hb('tok-admin')));
  setStatus('u_admin', 'invited');
  ok('B6 an "invited" admin is allowed', (await hb('tok-admin')).status === 200);
  setStatus('u_mgr', 'disabled');
  const wasRefused = refusedDisabled(await hb('tok-mgr'));
  patchStatus('u_mgr', 'active'); // the same committed roster, re-enabled in place
  ok('🔴 B7 re-enabled, the manager works again (disabled → refused → active → allowed)', wasRefused && (await hb('tok-mgr')).status === 200);
  setStatus('u_owner', 'disabled');
  ok('🔴 B8 a Super Admin is never locked out by status', (await hb('tok-owner')).status === 200);
  reset([...ROSTER(), member('u_owner', 'crew', 'disabled')]);
  ok('B9 …not even by a crafted duplicate disabled row with their id', (await hb('tok-owner')).status === 200);
  reset([...ROSTER(), member('u_admin', 'admin', 'disabled')]);
  ok('🔴 B10 one disabled duplicate row refuses the admin', refusedDisabled(await hb('tok-admin')));
  reset();
  ok('B11 fallback contract: a claimed login with no roster row keeps its claim (not locked out)', (await hb('tok-orphan')).status === 200);
  setStatus('u_admin', 'disabled');
  failRosterRead = true;
  ok('B12 fallback contract: an unreadable roster decides as before, never a lockout (even a disabled admin passes)',
    (await hb('tok-admin')).status === 200);
  reset();
  failRosterRead = true;
  ok('B13 …and an active claimed member is not locked out by a failed roster read', (await hb('tok-admin')).status === 200);
  // A claim-less manager's ROLE comes from that same read, so a failed read leaves them
  // with no role, exactly as before this change when their roster read failed: the
  // permission gate's own 403, never a status refusal. (On the jobs write path S78's strict
  // read makes it a 500 the tab retries instead: test-jobs-delta-authz.)
  const noRole = await hb('tok-mgr');
  ok('B13b …a claim-less manager on a failed read has no role (403 Insufficient), not account-disabled',
    noRole.status === 403 && !refusedDisabled(noRole) && noRole.body?.code !== 'not-on-team');
  reset();
  ok('B14 no session is still 401', (await hb(null)).status === 401);
  ok('B15 a crew member still gets the matrix answer (403, not account-disabled)', (await hb('tok-crew')).status === 403 && !refusedDisabled(await hb('tok-crew')));

  // ── the adversarial review's findings, end to end (2026-09-23) ───────────────
  const notOnTeam = (r) => r.status === 403 && r.body?.code === 'not-on-team';
  setStatus('u_mgr', 'disabled');
  ok('🔴 B29 a disabled manager who changes their LOGIN email holds nothing (was: a roleless caller, 200)',
    notOnTeam(await hb('tok-mgr-newmail'))
      && notOnTeam(await quiet(() => call(inbound, { token: 'tok-mgr-newmail', query: { since: '0' } }))));
  reset();
  ok('🔴 B30 a claim-less login the roster doesn\'t list holds nothing', notOnTeam(await hb('tok-stranger')));
  reset([member('u_admin', 'owner'), ...ROSTER().map((u) => (u.id === 'u_admin' ? { ...u, status: 'disabled' } : u))]);
  ok('🔴 B31 an admin who planted an owner row with their own id is still refused once disabled', refusedDisabled(await hb('tok-admin')));
  setStatus('u_admin', 'Disabled ');
  ok('🔴 B32 a crafted mis-cased status ("Disabled ") is enforced, as the Team page shows it', refusedDisabled(await hb('tok-admin')));
  reset([...ROSTER(), { id: 'u_splitrow', name: 'Split', email: 'split@cs.test', role: 'admin', status: 'disabled' }]);
  const splitRefused = refusedDisabled(await hb('tok-split'));
  patchStatus('u_splitrow', 'active');
  ok('🔴 B33 a split identity is judged by its email row: disabled refuses, re-enabled works',
    splitRefused && (await hb('tok-split')).status === 200);

  // ── B2. the org_state guard path (POST /api/state/org-state) ─────────────────
  // A Team-admin save: set another crew member's status. A manager holds settings.team.edit
  // by default, and the guard runs on it (the committed fingerprint is null).
  const save = (token, users) => quiet(() => call(orgStateRoute, {
    token, method: 'POST', body: { state: { ...committed().state, users }, baseVersion: committed().version, build: 0, tab: 'test' },
  }));
  const withCrew2 = (status) => committed().state.users.map((u) => (u.id === 'u_crew2' ? { ...u, status } : u));
  setStatus('u_mgr', 'disabled');
  let before = JSON.stringify(committed());
  let r = await save('tok-mgr', withCrew2('disabled'));
  ok('🔴 B16 a DISABLED manager\'s save is refused: 403 account-disabled', refusedDisabled(r));
  ok('  …and nothing is written', JSON.stringify(committed()) === before);
  r = await save('tok-mgr', committed().state.users.map((u) => (u.id === 'u_mgr' ? { ...u, status: 'active' } : u)));
  ok('🔴 B17 a disabled manager cannot re-enable themselves', refusedDisabled(r) && committed().state.users.find((u) => u.id === 'u_mgr').status === 'disabled');
  setStatus('u_admin', 'disabled');
  before = JSON.stringify(committed());
  r = await save('tok-admin', withCrew2('disabled'));
  ok('🔴 B18 a DISABLED admin\'s save is refused: 403 account-disabled', refusedDisabled(r));
  ok('  …and nothing is written', JSON.stringify(committed()) === before);
  setStatus('u_mgr', 'active');
  r = await save('tok-mgr', withCrew2('disabled'));
  ok('🔴 B19 re-enabled, the manager\'s Team-admin save commits', r.status === 200 && r.body?.ok === true
    && committed().version === 8 && committed().state.users.find((u) => u.id === 'u_crew2').status === 'disabled');
  reset();
  r = await save('tok-admin', withCrew2('disabled'));
  ok('B20 control: an active admin\'s save commits', r.status === 200 && committed().version === 8);

  // ── B3. the five routes that used a bare session check ──────────────────────
  setStatus('u_admin', 'disabled');
  ok('🔴 B21 inbound mail (GET /api/inbox/inbound) refuses a disabled member',
    refusedDisabled(await quiet(() => call(inbound, { token: 'tok-admin', query: { since: '0' } }))));
  ok('🔴 B22 sending mail (POST /api/email/send) refuses a disabled member',
    refusedDisabled(await quiet(() => call(emailSend, { token: 'tok-admin', method: 'POST', body: { to: 'x@example.test', subject: 's', body: 'b' } }))));
  ok('🔴 B23 geocoding (GET /api/geo) refuses a disabled member',
    refusedDisabled(await quiet(() => call(geo, { token: 'tok-admin', query: { address: '1 Main St' } }))));
  ok('🔴 B24 the email health read refuses a disabled member',
    refusedDisabled(await quiet(() => call(emailHealth, { token: 'tok-admin' }))));
  ok('🔴 B25 the settings section (GET snapshot) refuses a disabled member',
    refusedDisabled(await quiet(() => call(settings, { token: 'tok-admin', query: { subpath: 'snapshot' } }))));
  reset();
  ok('B26 control: an active member still passes those gates (email health 200, geo reaches its key check 503, snapshot 200)',
    (await quiet(() => call(emailHealth, { token: 'tok-admin' }))).status === 200
      && (await quiet(() => call(geo, { token: 'tok-admin', query: { address: '1 Main St' } }))).status === 503
      && (await quiet(() => call(settings, { token: 'tok-admin', query: { subpath: 'snapshot' } }))).status === 200);
  ok('B27 control: no session is still 401 on them', (await quiet(() => call(geo, { query: { address: 'x' } }))).status === 401
    && (await quiet(() => call(inbound, { query: {} }))).status === 401);

  // resolveAuthority itself, for the callers that use it directly (settings' users/*
  // section, webhooks): a disabled member resolves as no authority, not as a role.
  const direct = (token) => quiet(() => authz.resolveAuthority({ headers: { authorization: `Bearer ${token}` } }));
  setStatus('u_admin', 'disabled');
  const gone = await direct('tok-admin');
  reset();
  const here = await direct('tok-admin');
  ok('🔴 B28 resolveAuthority itself returns null for a disabled member (and the authority once re-enabled)',
    gone === null && here?.role === 'admin' && here?.orgUserId === 'u_admin');
} finally {
  server.close();
}

// ── C. the sweep: no route resolves a session on its own ─────────────────────
// A route that calls getAuthUser / getClaims (or brings back a bare session gate) skips
// resolveAuthority, and with it the status check. Code only: comments may name them.
{
  const API = path.join(APP, 'api');
  const files = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(API);
  const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const owners = new Set(['_lib/auth.js', '_lib/claims.js', '_lib/authz.js'].map((r) => path.join(API, ...r.split('/'))));
  const bypass = files.filter((p) => !owners.has(p) && /\b(getAuthUser|getClaims|requireAuth)\s*\(/.test(code(p)));
  ok(`🔴 C1 no route resolves a session itself (${bypass.map((p) => path.relative(API, p)).join(', ') || 'none'})`, bypass.length === 0);
  // By IMPORT, which no alias hides (\`import { getClaims as who }\`), plus a direct GoTrue call;
  // matched on whole import statements, so a comment or a string can't mask one.
  const imports = (p) => [...readFileSync(p, 'utf8').matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)];
  const sessionImports = files.filter((p) => !owners.has(p) && imports(p).some(([, names, from]) =>
    /(^|\/)_lib\/auth\.js$|^\.\/auth\.js$|^\.\.\/auth\.js$/.test(from)
    || (/claims\.js$/.test(from) && /\bgetClaims\b/.test(names))));
  ok(`🔴 C1b no route imports the session primitives, aliased or not (${sessionImports.map((p) => path.relative(API, p)).join(', ') || 'none'})`,
    sessionImports.length === 0);
  const goTrue = files.filter((p) => !owners.has(p) && /\.auth\s*\.\s*getUser\s*\(/.test(readFileSync(p, 'utf8')));
  ok(`🔴 C1c no route asks GoTrue who the caller is (${goTrue.map((p) => path.relative(API, p)).join(', ') || 'none'})`, goTrue.length === 0);
  ok('C1d neither scan is vacuous: they see authz.js\'s own getClaims import and auth.js\'s own GoTrue call',
    imports(path.join(API, '_lib', 'authz.js')).some(([, n, f]) => /claims\.js$/.test(f) && /\bgetClaims\b/.test(n))
      && /\.auth\s*\.\s*getUser\s*\(/.test(readFileSync(path.join(API, '_lib', 'auth.js'), 'utf8')));
  ok('C2 the sweep is not vacuous: it walks every route and sees authz.js\'s own getClaims call',
    files.length > 40 && /\bgetClaims\s*\(/.test(code(path.join(API, '_lib', 'authz.js'))));
  ok('C3 the bare session gate is gone from auth.js', !/export\s+async\s+function\s+requireAuth\b/.test(code(path.join(API, '_lib', 'auth.js'))));
}

console.log(`\ndisabled members hold no authority: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
