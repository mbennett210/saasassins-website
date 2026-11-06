// Every time_entries UPDATE is a compare-and-swap, and the INTERNAL writers re-read and
// retry (wave W5-M, F1). Driven through the REAL api/time/[...path].js handler with
// scripts/fake-supabase.mjs — no network, no credentials.
//
// 🔴 WHY. `updateEntry` bumped row_version to `base + 1` off the WRITER'S OWN READ and only
// rode `.eq('row_version', base)` for a manager write. The internal writers (live clock-out,
// replay clock-out, the late-replay audit append, auto-close, the cancelled-clean labor) were
// therefore last-write-wins: a write parked after its read clobbered a newer one and rolled
// row_version BACKWARDS. The window is real and it got wider when the checklist gate added
// 2-4 reads between a clock-out's row read and its write. The worst shape found in review:
// a cleaner's clock-out reads v3, a manager closes (v4) and approves (v5) the punch in the
// gap, and the parked clock-out then writes a clock_out_at 4 h later onto the APPROVED punch
// — 120 paid minutes become 360, because otLedger.js pays duration_minutes.
//
// The BARRIER is `world.beforeQuery` (fake-supabase.mjs): the suite parks ONE statement (the
// clock-out's UPDATE) and drives the manager's whole request through the handler in the gap,
// so each race is a deterministic test, not a timing hope.
//
//   node app/scripts/test-time-entry-cas.mjs

import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const CRON = 'cron-secret-for-the-fake';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.CRON_SECRET = CRON;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const time = (await import('../api/time/[...path].js')).default;

// The handler logs to console on refusals; keep the suite's own output clean but keep the
// real writers for the summary (a `call()`-local swap would race the parked request).
const say = { log: console.log.bind(console), error: console.error.bind(console) };
console.log = console.warn = console.error = () => {};

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── people ─────────────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true, pay: { type: 'none' } },
  mgr: { id: 'u_mgr', role: 'manager', claim: false, pay: { type: 'salary' } },
  crew: { id: 'u_crew', role: 'crew', claim: true, pay: { type: 'hourly', hourlyRate: 22 } },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k, pay: p.pay }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const tok = (who) => `tok-${who}`;

// ── time ───────────────────────────────────────────────────────────────────
const NOW = Date.now();
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
// The suite's own duration rule, so an assertion reads the ROW rather than a restated number.
const durationOf = (r) => Math.round((Date.parse(r.clock_out_at) - Date.parse(r.clock_in_at)) / 60000);

const openPunch = (o = {}) => ({
  id: 'te_open', organization_id: ORG, user_id: 'u_crew', client_id: 'cl_ever', site_id: 'st_ever', job_id: 'j_ever',
  user_name: 'crew', client_name: 'Las Olas', site_name: 'Main',
  clock_in_at: iso(NOW - 2 * H), clock_out_at: null, duration_minutes: null,
  scheduled_start: iso(NOW - 2 * H), scheduled_end: iso(NOW - 1 * H),
  status: 'in_progress', approval_status: 'pending', approved_by: null, approved_at: null,
  row_version: 3, edit_history: [], updated_at: iso(NOW - 2 * H), client_punch_id: null, ...o,
});

const jobRow = (id, clientId, siteId, crewIds = ['u_crew']) => ({
  organization_id: ORG, id, site_id: siteId, status: 'in_progress', start_at: iso(NOW - 2 * H),
  data: { id, siteId, clientId, crewIds, startAt: iso(NOW - 2 * H), endAt: iso(NOW - 1 * H), status: 'in_progress' },
});

function buildWorld({ entries = [] } = {}) {
  const state = {
    users: roster,
    permissions: seedPermissions(),
    userPermissionOverrides: [],
    // No crewChecklists anywhere: the clock-out checklist gate resolves NONE, so these tests
    // are about the WRITE, not the gate (test-clock-out-checklist-route.mjs owns the gate).
    clients: [{ id: 'cl_ever', name: 'Las Olas', supervisorId: 'u_mgr' }],
    sites: [{ id: 'st_ever', clientId: 'cl_ever', name: 'Main' }],
    opsSettings: {},
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 3 }],
      time_entries: entries.map((e) => ({ ...e })),
      payroll_runs: [],
      jobs: [jobRow('j_ever', 'cl_ever', 'st_ever')],
    },
    logins,
  });
}

function call({ method = 'POST', path, token, body, headers = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  req.query = { subpath: path };
  req.body = body;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 10000);
    const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
    const res = {
      statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
      json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
    };
    Promise.resolve(time(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
  });
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const rowNow = (id = 'te_open') => world.tables.time_entries.find((e) => e.id === id);

const clockOut = (who, body) => call({ path: 'clock-out', token: tok(who), body });
const correct = (who, body) => call({ path: 'correct', token: tok(who), body });
const approveBatch = (who, items) => call({ path: 'approve', token: tok(who), body: { items } });
const replay = (who, body) => call({ path: 'replay', token: tok(who), body });
const autoClose = () => call({ path: 'auto-close', headers: { authorization: `Bearer ${CRON}` } });

// Park the FIRST time_entries UPDATE and hand back { arrived, release }. Everything after
// the release runs as it would on a real CAS miss: re-read, rebuild, write again.
function parkFirstPunchWrite() {
  let arrive; const arrived = new Promise((r) => { arrive = r; });
  let go; const released = new Promise((r) => { go = r; });
  let armed = true;
  world.beforeQuery = async (q) => {
    if (armed && q.table === 'time_entries' && q.op === 'update') { armed = false; arrive(); await released; }
  };
  return { arrived, release: () => go() };
}

// ═══ 1. a manager CORRECTS the clock-in while the clock-out is parked ════════
// The clock-out must retry on the FRESH row: row_version strictly increases (3 → 4 → 5)
// and the duration is measured from the CORRECTED clock-in, not the one it read.
{
  buildWorld({ entries: [openPunch()] });
  const newIn = iso(NOW - 1 * H);
  const barrier = parkFirstPunchWrite();
  const crew = clockOut('crew', { entryId: 'te_open' });
  await barrier.arrived;
  const c = await correct('mgr', { entryId: 'te_open', version: 3, patch: { clock_in_at: newIn }, reason: 'clocked in late' });
  ok('race A: the manager\'s correction lands while the clock-out is parked', c.status === 200 && rowNow().row_version === 4, show(c));
  barrier.release();
  const r = await crew;
  const row = rowNow();
  ok('race A: the parked clock-out still succeeds (200)', r.status === 200 && !!r.body?.entry, show(r));
  ok('race A: the correction SURVIVES — clock_in_at is the manager\'s', row.clock_in_at === newIn, `clock_in_at=${row.clock_in_at} want ${newIn}`);
  ok('race A: row_version strictly increases 3 → 4 → 5 (never rolled back)', row.row_version === 5, `row_version=${row.row_version}`);
  ok('race A: duration_minutes is measured from the FRESH clock-in', row.duration_minutes === durationOf(row), `duration_minutes=${row.duration_minutes} want ${durationOf(row)}`);
  ok('race A: the response carries the row that was actually written', r.body?.entry?.row_version === row.row_version && r.body?.entry?.duration_minutes === row.duration_minutes, JSON.stringify(r.body?.entry).slice(0, 160));
}

// ═══ 2. a manager CLOSES + APPROVES while the clock-out is parked ════════════
// The punch is already out when the clock-out wakes: it must answer alreadyOut and leave
// the approved row byte-for-byte alone (this is the 120 → 360 paid-minutes shape).
{
  buildWorld({ entries: [openPunch()] });
  const closedAt = iso(NOW - 1 * H);
  const barrier = parkFirstPunchWrite();
  const crew = clockOut('crew', { entryId: 'te_open' });
  await barrier.arrived;
  await correct('mgr', { entryId: 'te_open', version: 3, patch: { clock_out_at: closedAt }, reason: 'closing for the cleaner' });
  const ap = await approveBatch('mgr', [{ entryId: 'te_open', version: 4 }]);
  ok('race B: the manager closed and approved the punch in the gap', ap.status === 200 && rowNow().approval_status === 'approved' && rowNow().row_version === 5, show(ap));
  const snapshot = structuredClone(rowNow());
  barrier.release();
  const r = await crew;
  const row = rowNow();
  ok('race B: the parked clock-out answers alreadyOut (200)', r.status === 200 && r.body?.alreadyOut === true, show(r));
  ok('race B: the APPROVED punch is byte-for-byte unchanged', JSON.stringify(row) === JSON.stringify(snapshot), `after=${JSON.stringify(row).slice(0, 220)}`);
  ok('race B: row_version never goes backwards', row.row_version === 5, `row_version=${row.row_version}`);
  ok('race B: the paid minutes are the manager\'s, not the parked writer\'s', row.duration_minutes === durationOf(row), `duration_minutes=${row.duration_minutes} want ${durationOf(row)}`);
  ok('race B: the response returns the FRESH row, never undefined', r.body?.entry?.id === 'te_open' && r.body?.entry?.row_version === 5, JSON.stringify(r.body?.entry).slice(0, 160));
}

// ═══ 3. AUTO-CLOSE skips a row that changed under it ═════════════════════════
{
  // Clocked in 6 h ago against a 4-h-old scheduled end, so the cron's grace has expired AND
  // the manager's clock-out is a valid time (after the clock-in).
  buildWorld({ entries: [openPunch({ clock_in_at: iso(NOW - 6 * H), scheduled_start: iso(NOW - 6 * H), scheduled_end: iso(NOW - 4 * H) })] });
  const closedAt = iso(NOW - 3 * H);
  const barrier = parkFirstPunchWrite();
  const cron = autoClose();
  await barrier.arrived;
  const c3 = await correct('mgr', { entryId: 'te_open', version: 3, patch: { clock_out_at: closedAt }, reason: 'the cleaner called it in' });
  ok('auto-close: the manager closed the punch while the cron was parked', c3.status === 200 && rowNow().row_version === 4, show(c3));
  barrier.release();
  const r = await cron;
  const row = rowNow();
  ok('auto-close: a row closed under it is SKIPPED, not re-closed', r.status === 200 && r.body?.closed === 0, show(r));
  ok("auto-close: the manager's clock-out stands", row.clock_out_at === closedAt && row.status === 'completed', `clock_out_at=${row.clock_out_at} status=${row.status}`);
  ok('auto-close: row_version was not bumped by the skipped write', row.row_version === 4, `row_version=${row.row_version}`);
}

// ═══ 4. a REPLAYED clock-out on a row closed in the gap takes the audit path ═
{
  buildWorld({ entries: [openPunch()] });
  const closedAt = iso(NOW - 1 * H);
  const assertedOutAt = iso(NOW - 30 * 60e3);
  const barrier = parkFirstPunchWrite();
  const crew = replay('crew', { clientPunchId: 'op_race4', entryId: 'te_open', assertedOutAt });
  await barrier.arrived;
  await correct('mgr', { entryId: 'te_open', version: 3, patch: { clock_out_at: closedAt }, reason: 'closing for the cleaner' });
  barrier.release();
  const r = await crew;
  const row = rowNow();
  ok('replay: a buffered clock-out is never refused (200)', r.status === 200, show(r));
  ok('replay: the recorded clock-out is NOT overwritten', row.clock_out_at === closedAt, `clock_out_at=${row.clock_out_at} want ${closedAt}`);
  const last = (row.edit_history || []).at(-1);
  ok('replay: the late arrival is recorded in the history instead', last?.field === 'offline_clock_out_arrived' && last?.to === assertedOutAt, JSON.stringify(row.edit_history).slice(0, 220));
  ok('replay: the audit append rides the fresh version (row_version 5)', row.row_version === 5, `row_version=${row.row_version}`);
  ok('replay: the answer says the punch was already out', r.body?.alreadyOut === true, show(r));
}

// ═══ 5. a row that VANISHES under a clock-out is a 404, never 200 + undefined ═
{
  buildWorld({ entries: [openPunch()] });
  let armed = true;
  world.beforeQuery = async (q) => {
    if (armed && q.table === 'time_entries' && q.op === 'update') { armed = false; world.tables.time_entries = []; }
  };
  const r = await clockOut('crew', { entryId: 'te_open' });
  ok('a vanished punch answers 404, never 200 with entry: undefined', r.status === 404, show(r));
  ok('  ...and no 200 body claims an entry it does not have', !(r.status === 200 && r.body && 'entry' in r.body && r.body.entry === undefined), show(r));
}

// ═══ 6. the CANCELLED-CLEAN labor path re-checks the row is still open ═══════
{
  buildWorld({ entries: [openPunch()] });
  // Deliberately NOT the scheduled end — that is exactly what cancelJobLabor would write,
  // so an equal value would let a clobbering write pass this test.
  const closedAt = iso(NOW - 90 * 60e3);
  const barrier = parkFirstPunchWrite();
  const cancel = call({ path: 'job-cancelled', token: tok('owner'), body: { jobId: 'j_ever' } });
  await barrier.arrived;
  await correct('mgr', { entryId: 'te_open', version: 3, patch: { clock_out_at: closedAt }, reason: 'closing for the cleaner' });
  barrier.release();
  const r = await cancel;
  const row = rowNow();
  ok('cancelled clean: the punch closed under it is flagged, not re-closed', r.status === 200 && row.clock_out_at === closedAt, `${show(r)} clock_out_at=${row.clock_out_at}`);
  ok('cancelled clean: the cancel flag still lands on the fresh row', !!row.job_cancelled_at && row.row_version === 5, `job_cancelled_at=${row.job_cancelled_at} row_version=${row.row_version}`);
}

// The SOURCE pin — one write chain in the whole of api/, and it rides the version filter —
// lives in test-time-approval-routes.mjs §7/§7b, which already owns the store-shape claims.
// This suite proves the BEHAVIOUR those pins protect.

console.log = say.log;
console.error = say.error;
console.log(`\ntime-entry CAS: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
