// CS-667 — the hourly auto-close never clocks a punch out before it clocked in, and its read
// can't be crowded (F12-06). Drives the REAL /api/time/auto-close cron handler over
// scripts/fake-supabase.mjs (the audit's s18 shape) — no network, no credentials.
//
// The clock-in window runs until the clean's scheduled end + the auto-close grace
// (lib/clockInWindow), so a cleaner can clock in AFTER the scheduled end. The cron used to close
// every forgotten punch AT the scheduled end, so that punch got a clock-out before its clock-in:
// duration null (0 paid), the clean marked done, the cleaner (still working) shown "Clocked out".
//
// Pins:
//   1. s18: a cleaner who clocked in 100 min after the end, 25 min ago, is NOT closed by this run.
//   2. A late start whose fair close is due is closed at clock-in + the clean's scheduled length
//      (at most the grace), never before the clock-in; it pays those minutes, stays pending,
//      carries the late-start note the approver reads, and settles the clean.
//   3. A long clean's late start is capped at the grace.
//   4. PAY-10 is unchanged for a punch that started inside the window: closed AT the scheduled end.
//   5. F12-06: open punches with no scheduled end can't crowd the read (PostgREST's row cap is
//      emulated with world.maxRows), and every due punch closes in one run, whatever the cap.
//   6. The rule itself, over a grid: the close time is never before the clock-in.
//   7. The approver's chip + sentence, and the cleaner's card line, come from the same record.
//
//   node app/scripts/test-auto-close-late-start.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { punchFlags } from '../src/lib/filters/timeApprovals.js';
import { english } from '../src/i18n/core.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const CRON = 'cron-secret-for-the-fake';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG, CRON_SECRET: CRON,
});
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const time = (await import('../api/time/[...path].js')).default;
// The shared rule (new with the fix). Loaded softly so a pre-fix run reports failures, not a crash.
const AC = await import('../src/lib/autoClose.js').catch(() => ({}));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const GRACE = 120;
const MIN = 60000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const roster = [{ id: 'u_crew', email: 'crew@example.test', role: 'crew', status: 'active', name: 'crew', pay: { type: 'hourly', hourlyRate: 20 } }];

const jobRow = (id, startMs, endMs, status = 'in_progress') => ({
  organization_id: ORG, id, site_id: 'st_a', status, start_at: iso(startMs),
  data: { id, siteId: 'st_a', clientId: 'cl_a', crewIds: ['u_crew'], startAt: iso(startMs), endAt: iso(endMs), status },
});
const openPunch = (id, jobId, { inMs, startMs = null, endMs = null, expected = null }) => ({
  id, organization_id: ORG, user_id: 'u_crew', client_id: 'cl_a', site_id: 'st_a', job_id: jobId,
  user_name: 'crew', client_name: 'Acme', site_name: 'A',
  clock_in_at: iso(inMs), clock_out_at: null, duration_minutes: null,
  scheduled_start: startMs == null ? null : iso(startMs), scheduled_end: endMs == null ? null : iso(endMs),
  expected_minutes_snapshot: expected, status: 'in_progress', approval_status: 'pending',
  row_version: 0, edit_history: [], updated_at: iso(inMs), client_punch_id: null,
});
function buildWorld({ entries = [], jobs = [], maxRows = null } = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: { users: roster, permissions: seedPermissions(), userPermissionOverrides: [], clients: [{ id: 'cl_a', name: 'Acme' }], sites: [{ id: 'st_a', clientId: 'cl_a', name: 'A' }], opsSettings: { autoCloseGraceMins: GRACE } } }],
      time_entries: entries, jobs, payroll_runs: [], crew_assignments: [],
    },
    logins: {},
  });
  world.maxRows = maxRows;
}
async function autoClose() {
  const req = Readable.from([]);
  req.method = 'POST'; req.headers = { authorization: `Bearer ${CRON}` }; req.query = { subpath: 'auto-close' }; req.body = {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auto-close: no response')), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
      Promise.resolve(time(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const row = (id) => world.tables.time_entries.find((e) => e.id === id);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const outMs = (e) => Date.parse(e?.clock_out_at ?? '');
const inMs = (e) => Date.parse(e?.clock_in_at ?? '');

// ═══ 1. s18: a late starter 25 minutes into their clean is left alone ════════════
{
  const end = NOW - 125 * MIN; const start = end - 60 * MIN; const inAt = end + 100 * MIN;
  buildWorld({ jobs: [jobRow('j_late', start, end)], entries: [openPunch('te_late', 'j_late', { inMs: inAt, startMs: start, endMs: end })] });
  const r = await autoClose();
  const e = row('te_late');
  ok('s18: the cron answers 200', r.status === 200, show(r));
  ok('s18: a cleaner who clocked in AFTER the scheduled end, 25 min ago, is still on the clock',
    e && e.clock_out_at === null && e.status === 'in_progress', JSON.stringify({ out: e?.clock_out_at, status: e?.status }));
  ok('s18: …so nothing can be written before the clock-in', !(outMs(e) < inMs(e)), `in=${e?.clock_in_at} out=${e?.clock_out_at}`);
  ok('s18: …and the clean is not marked done under them', world.tables.jobs[0].data.status !== 'done', world.tables.jobs[0].data.status);
}

// ═══ 2. a late start whose fair close is due ═════════════════════════════════════
{
  // A 60-minute clean that ended 10 h ago; the cleaner clocked in 100 min after its end and
  // never clocked out. Fair close = clock-in + the clean's 60 minutes; due a grace after that.
  const end = NOW - 600 * MIN; const start = end - 60 * MIN; const inAt = end + 100 * MIN;
  buildWorld({ jobs: [jobRow('j_late2', start, end)], entries: [openPunch('te_late2', 'j_late2', { inMs: inAt, startMs: start, endMs: end, expected: 60 })] });
  const r = await autoClose();
  const e = row('te_late2');
  ok('late start, due: closed this run', r.status === 200 && r.body?.closed === 1 && e?.status === 'auto_closed', show(r));
  ok('late start: the clock-out is AFTER the clock-in', outMs(e) > inMs(e), `in=${e?.clock_in_at} out=${e?.clock_out_at}`);
  ok('late start: closed at clock-in + the clean\'s scheduled length (60 min)', outMs(e) === inAt + 60 * MIN, `out=${e?.clock_out_at} want ${iso(inAt + 60 * MIN)}`);
  ok('late start: it pays those 60 minutes (not null, not 0)', e?.duration_minutes === 60, `duration=${e?.duration_minutes}`);
  ok('late start: it still needs a manager\'s approval', e?.approval_status === 'pending', e?.approval_status);
  const reasons = (e?.edit_history || []).map((h) => h.reason).join(' | ');
  ok('late start: the history says it was a late start the app closed',
    typeof AC.lateStartAutoCloseOf === 'function' && AC.lateStartAutoCloseOf(e)?.creditedMins === 60, reasons);
  ok('late start: the last cleaner\'s punch closed, so the clean is settled', r.body?.jobsDone === 1, show(r));
}

// ═══ 3. a long clean's late start is capped at the grace ═════════════════════════
{
  const end = NOW - 900 * MIN; const start = end - 240 * MIN; const inAt = end + 30 * MIN;
  buildWorld({ jobs: [jobRow('j_long', start, end)], entries: [openPunch('te_long', 'j_long', { inMs: inAt, startMs: start, endMs: end })] });
  await autoClose();
  const e = row('te_long');
  ok('a 4-hour clean started late: credited at most the grace (120 min)', outMs(e) === inAt + GRACE * MIN && e?.duration_minutes === GRACE,
    `out=${e?.clock_out_at} duration=${e?.duration_minutes}`);
}

// ═══ 4. PAY-10 unchanged for a punch that started inside the window ══════════════
{
  const end = NOW - 300 * MIN; const start = end - 180 * MIN; const inAt = start + 5 * MIN;
  buildWorld({ jobs: [jobRow('j_in', start, end)], entries: [openPunch('te_in', 'j_in', { inMs: inAt, startMs: start, endMs: end })] });
  await autoClose();
  const e = row('te_in');
  ok('PAY-10: a forgotten clock-out is closed AT the scheduled end', e?.status === 'auto_closed' && e?.clock_out_at === iso(end), `out=${e?.clock_out_at} want ${iso(end)}`);
  ok('PAY-10: …and is not called a late start', typeof AC.lateStartAutoCloseOf === 'function' && AC.lateStartAutoCloseOf(e) === null, JSON.stringify(e?.edit_history));
  ok('PAY-10: the queue still shows the plain "Auto-closed" chip', punchFlags(e).includes(english('punch.flag.autoClosed')), JSON.stringify(punchFlags(e)));
}

// ═══ 5. F12-06: the read can't be crowded, and a busy hour closes in one run ══════
{
  // Five open punches with NO scheduled end (nothing to anchor to — the office settles them)
  // sit FIRST in the table; PostgREST answers at most 3 rows a request here.
  const old = NOW - 3 * 24 * 60 * MIN;
  const noEnd = Array.from({ length: 5 }, (_, i) => openPunch(`te_noend_${i}`, null, { inMs: old + i * MIN }));
  const end = NOW - 400 * MIN; const start = end - 120 * MIN;
  const stale = Array.from({ length: 7 }, (_, i) => openPunch(`te_stale_${i}`, `j_s${i}`, { inMs: start + i * MIN, startMs: start, endMs: end }));
  buildWorld({ entries: [...noEnd, ...stale], jobs: stale.map((p, i) => jobRow(`j_s${i}`, start, end)), maxRows: 3 });
  const r = await autoClose();
  const closed = stale.filter((p) => row(p.id)?.status === 'auto_closed').length;
  ok('F12-06: every due punch closes in ONE run (7 of 7), with no-end punches ahead and a 3-row cap', closed === 7, `closed ${closed} of 7; ${show(r)}`);
  ok('F12-06: punches with no scheduled end are left for the office', noEnd.every((p) => row(p.id)?.clock_out_at === null && row(p.id)?.status === 'in_progress'));
}

// ═══ 6. the rule: never before the clock-in, over a grid ══════════════════════════
{
  const anchor = AC.autoCloseAnchor;
  ok('lib/autoClose exports autoCloseAnchor', typeof anchor === 'function');
  if (typeof anchor === 'function') {
    let bad = 0; let checked = 0;
    const end = Date.parse('2026-11-01T06:00:00.000Z');          // the fall-back night, for good measure
    for (const lenMin of [0, 15, 60, 180, 600]) {
      for (const grace of [0, 30, 120, 240]) {
        for (let offset = -lenMin - 120; offset <= grace + 10; offset += 5) {
          const r = { clock_in_at: iso(end + offset * MIN), scheduled_end: iso(end), scheduled_start: iso(end - lenMin * MIN) };
          const a = anchor(r, grace);
          checked += 1;
          if (!a || !(a.closeAtMs > Date.parse(r.clock_in_at))) bad += 1;
        }
      }
    }
    ok(`the close time is after the clock-in in every case (${checked} checked)`, bad === 0, `${bad} bad`);
    ok('no scheduled end → nothing to anchor to (left for the office)', anchor({ clock_in_at: iso(NOW), scheduled_end: null }, GRACE) === null);
  }
}

// ═══ 7. what the approver and the cleaner read ═══════════════════════════════════
{
  const end = NOW - 600 * MIN; const start = end - 60 * MIN; const inAt = end + 100 * MIN;
  buildWorld({ jobs: [jobRow('j_l3', start, end)], entries: [openPunch('te_l3', 'j_l3', { inMs: inAt, startMs: start, endMs: end })] });
  await autoClose();
  const late = row('te_l3');
  ok('the queue chip names the late start', punchFlags(late).includes(english('punch.flag.autoClosedLate')) && !punchFlags(late).includes(english('punch.flag.autoClosed')),
    JSON.stringify(punchFlags(late)));
  ok('…with the recorded sentence for the line under it',
    typeof AC.lateStartAutoCloseText === 'function' && /scheduled end/.test(AC.lateStartAutoCloseText(late) || ''), String(AC.lateStartAutoCloseText?.(late)));
  const key = AC.crewAutoCloseNoteKey;
  ok('the cleaner\'s card says the app closed it, and why', typeof key === 'function' && key(late) === 'clock.autoClosedLate', String(key?.(late)));
  if (typeof key === 'function') {
    ok('…a forgotten clock-out reads the plain auto-close line',
      key({ status: 'auto_closed', clock_out_at: iso(end), edit_history: [{ field: 'status', to: 'auto_closed', reason: 'auto-closed: open past scheduled end + 120m grace' }] }) === 'clock.autoClosed');
    ok('…a clock-out the office corrected afterwards says nothing',
      key({ status: 'auto_closed', clock_out_at: iso(end), edit_history: [{ field: 'status', to: 'auto_closed' }, { field: 'clock_out_at', from: iso(end), to: iso(end + MIN) }] }) === null);
    ok('…an ordinary punch says nothing', key({ status: 'completed', clock_out_at: iso(end) }) === null);
  }
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const cc = strip(readFileSync(new URL('../src/components/ClockControl.jsx', import.meta.url), 'utf8'));
  ok('ClockControl puts that line on the cleaner\'s done card', /crewAutoCloseNoteKey\(/.test(cc));
  const appr = strip(readFileSync(new URL('../src/pages/Approvals.jsx', import.meta.url), 'utf8'));
  ok('Hours Approval shows the recorded sentence under the chips', /lateStartAutoCloseText\(/.test(appr));
}

console.log(`\nauto-close-late-start: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
