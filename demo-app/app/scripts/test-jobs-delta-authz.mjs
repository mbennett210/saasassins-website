// Route-level drive of POST /api/state/jobs-delta: the REAL handler, the real
// Supabase client and the real authz chain (resolveAuthority → readAuthzSlices →
// jobsGuard → writeJobsDelta), against a small fake of GoTrue + PostgREST served
// from node:http on 127.0.0.1. It pins what the pure guard suite
// (test-jobs-guard.mjs) cannot see: that the ROUTE hands the guard the caller's id and
// the COMMITTED matrix + overrides, reads the matrix only for the manager tier, and
// fails closed when a read fails.
//
// THE BUG IT PINS (2026-09-23): the route skipped the guard only for owner + admin,
// so a 4th-tier Manager (S35, full access by default) had every reschedule,
// reassignment, new clean and delete answered 200 and quietly undone. And a
// claim-less login whose ROSTER read failed resolved as "no role", so the same edit
// was put back with a 200 on a transient read error.
//
// Adapted from the parallel session's suite (worktree wonderful-heisenberg, commit
// b103181), with the strict-roster and unresolved-id cases added (HANDOFF S78).
//
// NEVER a live project: every URL below is the loopback server this file starts, and
// the env is set before the handler is imported (the Supabase client reads it on
// first use and the org id at module load).
//
//   node scripts/test-jobs-delta-authz.mjs
import http from 'node:http';
import { seedPermissions } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const ORG = '00000000-0000-0000-0000-0000000000aa';

// ── identities: tokens → GoTrue users ──────────────────────────────────────
// Managers are CLAIM-LESS, as they are live: claims.js VALID_ROLES has no 'manager',
// so their role and id resolve from the roster. A raw app_metadata role of 'manager'
// is not a valid claim either, so it takes the same path.
const AUTH = {
  'tok-owner': { id: 'auth-owner', email: 'owner@cs.test', app_metadata: { role: 'owner', org_user_id: 'u_owner' } },
  // A role claim with no id claim (a role-only stamp): the role is claimed, only the id
  // comes from the roster, so a roster failure must not tighten it.
  'tok-owner-noid': { id: 'auth-owner', email: 'owner@cs.test', app_metadata: { role: 'owner' } },
  // No email at all: must match no roster row, not the first row without an email.
  'tok-noemail': { id: 'auth-ne', email: '', app_metadata: {} },
  'tok-admin': { id: 'auth-admin', email: 'admin@cs.test', app_metadata: { role: 'admin', org_user_id: 'u_admin' } },
  'tok-mgr': { id: 'auth-mgr', email: 'mgr@cs.test', app_metadata: {} },
  'tok-mgr-raw': { id: 'auth-mgr', email: 'mgr@cs.test', app_metadata: { role: 'manager' } },
  'tok-mgr-noid': { id: 'auth-noid', email: 'noid@cs.test', app_metadata: {} },
  'tok-crew': { id: 'auth-crew', email: 'crew@cs.test', app_metadata: { role: 'crew', org_user_id: 'u_crew' } },
  'tok-crew-claimless': { id: 'auth-crew', email: 'crew@cs.test', app_metadata: {} },
  // Promoted crew → manager in the roster, but the claim re-stamp was refused
  // ('manager' isn't a VALID_ROLE), so the old crew claim is still on the login.
  'tok-promoted': { id: 'auth-prom', email: 'promoted@cs.test', app_metadata: { role: 'crew', org_user_id: 'u_prom' } },
};
const ROSTER = [
  { id: 'u_owner', email: 'owner@cs.test', role: 'owner', status: 'active' },
  { id: 'u_admin', email: 'admin@cs.test', role: 'admin', status: 'active' },
  { id: 'u_mgr', email: 'mgr@cs.test', role: 'manager', status: 'active' },
  { id: 'u_mgr2', email: 'mgr2@cs.test', role: 'manager', status: 'active' },
  // A manager row with no u_* id: their per-user overrides could never be applied.
  { email: 'noid@cs.test', role: 'manager', status: 'active' },
  // A manager row with no email (anyone who may add members can add one).
  { id: 'u_noemail', role: 'manager', status: 'active' },
  { id: 'u_crew', email: 'crew@cs.test', role: 'crew', status: 'active' },
  { id: 'u_prom', email: 'promoted@cs.test', role: 'manager', status: 'active' },
];

const job = (over = {}) => ({
  id: 'j1', siteId: 's1', clientId: 'c1', serviceId: 'sv1', seriesId: null, recurrence: null, shiftId: null,
  startAt: '2026-10-01T13:00:00.000Z', endAt: '2026-10-01T15:00:00.000Z',
  status: 'upcoming', crewIds: ['u_other'], tagIds: [], notes: '', ...over,
});

// ── the fake backend ────────────────────────────────────────────────────────
const db = { state: null, jobs: new Map(), calls: [], failSlices: false, failRoster: false };
function reset({ permissions = seedPermissions(), overrides = [], users = ROSTER } = {}) {
  db.state = { users, permissions, userPermissionOverrides: overrides };
  db.jobs = new Map([['j1', job()], ['j2', job({ id: 'j2', startAt: '2026-10-02T13:00:00.000Z', endAt: '2026-10-02T15:00:00.000Z' })]]);
  db.calls = [];
  db.failSlices = false;
  db.failRoster = false;
}

// PostgREST filter values as the client sends them: `eq.x`, `neq.x`, `in.(a,"b")`.
function matches(row, params) {
  for (const [col, raw] of params) {
    if (col === 'select' || col === 'on_conflict') continue;
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const val = raw.slice(dot + 1);
    const cell = row[col] == null ? null : String(row[col]);
    if (op === 'eq' && cell !== val) return false;
    if (op === 'neq' && cell === val) return false;
    if (op === 'in') {
      const set = new Set(val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')));
      if (!set.has(cell)) return false;
    }
  }
  return true;
}
// `state, version` or `alias:state->key, …` → the projected row.
function project(row, select) {
  const out = {};
  for (const item of select.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = item.match(/^(\w+):state->(\w+)$/);
    if (m) out[m[1]] = row.state?.[m[2]] ?? null;
    else out[item] = row[item];
  }
  return out;
}
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => resolve(s ? JSON.parse(s) : null));
});
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake');
  const params = [...url.searchParams.entries()];
  const body = await readBody(req);
  db.calls.push({ method: req.method, path: url.pathname, select: url.searchParams.get('select') || '' });

  if (url.pathname === '/auth/v1/user') {
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    const u = AUTH[tok];
    return u ? send(res, 200, { aud: 'authenticated', role: 'authenticated', ...u }) : send(res, 401, { message: 'invalid JWT' });
  }
  if (url.pathname === '/rest/v1/org_state' && req.method === 'GET') {
    const select = url.searchParams.get('select') || '*';
    if (db.failSlices && select.includes('permissions:')) return send(res, 500, { code: 'XX000', message: 'fake: matrix read failed' });
    // resolveAuthority's roster read (since 2026-09-23 one `users` projection per request,
    // for the claim-less lookup AND the status check; it used to be the whole state).
    if (db.failRoster && select === 'users:state->users') return send(res, 500, { code: 'XX000', message: 'fake: roster read failed' });
    const row = { organization_id: ORG, version: 7, state: db.state };
    return send(res, 200, matches(row, params) ? [project(row, select)] : []);
  }
  if (url.pathname === '/rest/v1/jobs' && req.method === 'GET') {
    const rows = [...db.jobs.values()].map((d) => ({ id: d.id, organization_id: ORG, data: d, status: d.status, site_id: d.siteId }));
    return send(res, 200, rows.filter((r) => matches(r, params)).map((r) => ({ id: r.id, data: r.data })));
  }
  if (url.pathname === '/rest/v1/jobs' && req.method === 'POST') {
    for (const row of body || []) if (row.organization_id === ORG) db.jobs.set(row.id, row.data);
    return send(res, 201);
  }
  if (url.pathname === '/rest/v1/rpc/delete_jobs' && req.method === 'POST') {
    if (body?.p_org === ORG) for (const id of body.p_ids || []) db.jobs.delete(id);
    return send(res, 204);
  }
  if (url.pathname === '/rest/v1/time_entries' && req.method === 'GET') return send(res, 200, []);
  return send(res, 404, { message: `fake: no route ${req.method} ${url.pathname}` });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG; // the org-id trio is ONE value
delete process.env.ALERT_WEBHOOK_URL;
const { default: handler } = await import('../api/state/jobs-delta.js');

function post(token, payload) {
  return new Promise((resolve, reject) => {
    const req = { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: payload };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
const matrixReads = () => db.calls.filter((c) => c.path === '/rest/v1/org_state' && c.select.includes('permissions:')).length;
// GET /rest/v1/jobs: writeJobsDelta's own equality pre-read is 1 for every caller; the
// guard's row read (getJobsByIds for the sanitizer) is 1 more, and ONLY for a caller
// without schedule authority. The schedulers generate most job traffic, so this is the
// cost contract the route documents.
const jobReads = () => db.calls.filter((c) => c.path === '/rest/v1/jobs' && c.method === 'GET').length;
const stored = (id) => db.jobs.get(id);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const quiet = async (fn) => {
  const { warn, error } = console; // authz logs a non-strict roster-read failure at error
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.error = error; }
};

// The delta every scenario sends: reassign + reschedule j1, create j_new, delete j2.
const MOVED = '2026-10-03T13:00:00.000Z';
const DELTA = () => ({
  changed: [job({ crewIds: ['u_crew'], startAt: MOVED }), job({ id: 'j_new', crewIds: ['u_crew'], startAt: '2026-10-05T13:00:00.000Z' })],
  removed: ['j2'],
  build: 0,
  tab: 'test',
});
const committedAll = () => sameJson(stored('j1')?.crewIds, ['u_crew']) && stored('j1')?.startAt === MOVED
  && !!stored('j_new') && !stored('j2');
const neutralizedAll = () => sameJson(stored('j1')?.crewIds, ['u_other']) && stored('j1')?.startAt === job().startAt
  && !stored('j_new') && !!stored('j2');
const untouched = () => sameJson(stored('j1'), job()) && !stored('j_new') && !!stored('j2');

const withRoles = (fn) => seedPermissions().map((p) => (p.id === 'schedule.edit' ? { ...p, roles: fn(p.roles) } : p));
const MGR_OFF = withRoles((r) => r.filter((x) => x !== 'manager'));
const CREW_ON = withRoles((r) => [...new Set([...r, 'crew'])]);

try {
  // ── 🔴 the Manager tier, by capability ────────────────────────────────────
  reset();
  let r = await quiet(() => post('tok-mgr', DELTA()));
  ok('🔴 a Manager (claim-less, schedule.edit by default) gets a 200', r.status === 200);
  ok('🔴   ...and the reassign, reschedule, new clean and delete all COMMIT', committedAll());
  ok('  ...after exactly one matrix read', matrixReads() === 1);
  ok('  ...and no guard row read (only the write\'s own equality read)', jobReads() === 1);

  reset();
  r = await quiet(() => post('tok-mgr-raw', DELTA()));
  ok('🔴 a raw app_metadata role "manager" (not a valid claim) resolves the same way', r.status === 200 && committedAll());

  reset({ overrides: [{ userId: 'u_mgr2', grants: [], revokes: ['schedule.edit'] }] });
  r = await quiet(() => post('tok-mgr', DELTA()));
  ok('🔴 another manager\'s per-user revoke does not touch this one', r.status === 200 && committedAll());

  reset({ permissions: MGR_OFF });
  r = await quiet(() => post('tok-mgr', DELTA()));
  ok('a Manager whose ROLE lost schedule.edit gets a 200 (sanitized, never rejected)', r.status === 200);
  ok('  ...and nothing protected moves: crewIds + startAt restored, create dropped, delete dropped', neutralizedAll());

  reset({ overrides: [{ userId: 'u_mgr', grants: [], revokes: ['schedule.edit'] }] });
  r = await quiet(() => post('tok-mgr', DELTA()));
  ok('a Manager with a per-USER revoke is sanitized the same way', r.status === 200 && neutralizedAll());

  reset({ permissions: MGR_OFF, overrides: [{ userId: 'u_mgr', grants: ['schedule.edit'], revokes: [] }] });
  r = await quiet(() => post('tok-mgr', DELTA()));
  ok('a per-user GRANT restores it for a Manager whose role lost it', r.status === 200 && committedAll());

  reset();
  db.failSlices = true;
  r = await quiet(() => post('tok-mgr', DELTA()));
  ok('🔴 a failed matrix read is a 500 (fail closed), never a pass-through', r.status === 500);
  ok('  ...and nothing is written', untouched());

  // ── 🔴 a failed ROSTER read is a 500, never "no role" ─────────────────────
  // A claim-less login's role comes from the roster. That read used to swallow its
  // failure and resolve as "no role", so the jobs guard put the manager's edit back
  // with a 200: lost on a transient read error.
  reset();
  db.failRoster = true;
  r = await quiet(() => post('tok-mgr', DELTA()));
  ok('🔴 a claim-less Manager whose ROSTER read fails gets a 500 (the tab retries)', r.status === 500);
  ok('  ...and nothing is written (before: a 200 with the edit put back)', untouched());

  reset();
  db.failRoster = true;
  r = await quiet(() => post('tok-owner', DELTA()));
  ok('a login whose claims carry role + id is untouched by a failed roster read (its status check falls back to the claim)',
    r.status === 200 && committedAll());

  reset();
  db.failRoster = true;
  r = await quiet(() => post('tok-owner-noid', DELTA()));
  ok('an owner whose login claims the role but not the id keeps the lenient read: a roster failure still commits whole',
    r.status === 200 && committedAll());

  reset();
  r = await quiet(() => post('tok-noemail', DELTA()));
  // Since 2026-09-23 a claim-less login no row carries holds nothing at all (it used to be
  // a roleless caller, sanitized): it has no role and no identity to act as.
  ok('a login with NO email matches no roster row (not the first email-less one): 403 not-on-team',
    r.status === 403 && r.body?.code === 'not-on-team' && untouched());
  ok('  ...and never reads the matrix', matrixReads() === 0);

  // ── a member set to Disabled holds no authority (authz.js ROSTER STATUS) ────
  const disabled = (id) => ROSTER.map((u) => (u.id === id ? { ...u, status: 'disabled' } : u));
  reset({ users: disabled('u_mgr') });
  r = await quiet(() => post('tok-mgr', DELTA()));
  ok('🔴 a DISABLED Manager\'s delta is refused: 403 account-disabled', r.status === 403 && r.body?.code === 'account-disabled');
  ok('  ...and nothing is written (their schedule edits don\'t land)', untouched());
  reset({ users: disabled('u_crew') });
  r = await quiet(() => post('tok-crew', { changed: [job({ status: 'in_progress' })], removed: [] }));
  ok('🔴 a DISABLED crew member can\'t even move a status', r.status === 403 && r.body?.code === 'account-disabled' && stored('j1').status === 'upcoming');

  reset();
  r = await quiet(() => post('tok-mgr-noid', DELTA()));
  ok('a Manager whose roster row carries no u_* id holds nothing: sanitized, with a 200', r.status === 200 && neutralizedAll());
  ok('  ...and the matrix is never read for them', matrixReads() === 0);

  // ── owner + admin: by role, no matrix read ────────────────────────────────
  for (const tok of ['tok-owner', 'tok-admin']) {
    reset({ permissions: withRoles(() => []) });
    r = await quiet(() => post(tok, DELTA()));
    ok(`${tok}: commits everything even with schedule.edit off in the matrix (the floor)`, r.status === 200 && committedAll());
    // The guard reads nothing for them. The one roster read is the authority layer's own
    // (every route since 2026-09-23: a member set to Disabled holds no authority, authz.js
    // ROSTER STATUS), exactly one, and never the matrix.
    const orgReads = db.calls.filter((c) => c.path === '/rest/v1/org_state');
    ok(`${tok}: pays no org_state read but the roster-status one`,
      orgReads.length === 1 && orgReads[0].select === 'users:state->users' && matrixReads() === 0);
    ok(`${tok}: and no guard row read`, jobReads() === 1);
  }

  // ── crew: never, grants included, and the echo stays a no-op ──────────────
  reset();
  r = await quiet(() => post('tok-crew', DELTA()));
  ok('crew get a 200 (sanitized, never rejected)', r.status === 200);
  ok('  ...and nothing protected moves', neutralizedAll());
  ok('  ...with no matrix read (decided by role)', matrixReads() === 0);
  ok('  ...and one guard row read before the write\'s own', jobReads() === 2);

  reset({ permissions: CREW_ON, overrides: [{ userId: 'u_crew', grants: ['schedule.edit'], revokes: [] }] });
  r = await quiet(() => post('tok-crew', DELTA()));
  ok('🔴 crew with a matrix toggle AND a per-user grant are STILL sanitized', r.status === 200 && neutralizedAll());
  ok('  ...still without a matrix read', matrixReads() === 0);

  // The stored clean starts within the day: the guard keeps a sanitized caller's status
  // change only from a day before the start, and never out of 'cancelled' (S81,
  // statusChangeKept). Both relative to the clock, so neither case ages into the other.
  const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  reset();
  db.jobs.set('j1', job({ startAt: soon(2), endAt: soon(4) }));
  r = await quiet(() => post('tok-crew', { changed: [job({ startAt: soon(2), endAt: soon(4), status: 'in_progress', crewIds: ['u_other', 'u_crew'] })], removed: [] }));
  ok('crew status change lands while their self-assignment is undone',
    r.status === 200 && stored('j1').status === 'in_progress' && sameJson(stored('j1').crewIds, ['u_other']));
  reset();
  db.jobs.set('j1', job({ startAt: soon(8 * 24), endAt: soon(8 * 24 + 2) }));
  r = await quiet(() => post('tok-crew', { changed: [job({ startAt: soon(8 * 24), endAt: soon(8 * 24 + 2), status: 'in_progress' })], removed: [] }));
  ok('🔴 ...but on a visit 8 days out the stored status goes back (a 200, never a 403)',
    r.status === 200 && stored('j1').status === 'upcoming');
  reset();
  db.jobs.set('j1', job({ startAt: soon(2), endAt: soon(4), status: 'cancelled' }));
  r = await quiet(() => post('tok-crew', { changed: [job({ startAt: soon(2), endAt: soon(4), status: 'upcoming' })], removed: [] }));
  ok("🔴 ...and crew can't un-cancel today's clean", r.status === 200 && stored('j1').status === 'cancelled');

  reset();
  const mgrRow = job({ crewIds: ['u_a', 'u_b'], siteId: 's9' });
  db.jobs.set('j1', mgrRow);
  r = await quiet(() => post('tok-crew', { changed: [{ ...mgrRow }], removed: [] }));
  ok('a crew ECHO of a manager\'s row is a byte-identical no-op',
    r.status === 200 && r.body?.unchanged === 1 && r.body?.changed === 0 && sameJson(stored('j1'), mgrRow));

  reset({ permissions: CREW_ON });
  r = await quiet(() => post('tok-crew-claimless', DELTA()));
  ok('a claim-less crew login (roster role) is sanitized', r.status === 200 && neutralizedAll());

  reset();
  r = await quiet(() => post('tok-promoted', DELTA()));
  ok('a present crew CLAIM wins over a roster promotion to manager (sanitized)', r.status === 200 && neutralizedAll());

  reset();
  r = await quiet(() => post('tok-nobody', DELTA()));
  ok('no session → 401, nothing written', r.status === 401 && untouched());
} finally {
  server.close();
}

console.log(`\njobs-delta route authz: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
