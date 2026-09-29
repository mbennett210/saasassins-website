// Node unit test for the attendance report (lib/attendanceReport) — the pure
// "not clocked in / out today" computation behind the Reports tab. Offline. Run:
//   node app/scripts/test-attendance-report.mjs
import {
  computeAttendanceReport, incompleteCount,
  ATT_COMPLETE, ATT_MISSING_OUT, ATT_NO_PUNCH,
} from '../src/lib/attendanceReport.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const DAY = new Date('2026-09-18T12:00:00.000Z').getTime();
const from = new Date('2026-09-18T00:00:00.000Z').getTime();
const to = new Date('2026-09-18T23:59:59.000Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

const usersById = new Map([['u_a', { name: 'Andre' }], ['u_t', { name: 'Tomas' }], ['u_k', { name: 'Keisha' }]]);
const clientsById = new Map([
  ['cl1', { name: 'Las Olas', supervisorId: 'mgr1' }],
  ['cl2', { name: 'Coral Bay', supervisorId: 'mgr2' }],
]);
const sitesById = new Map([['s1', { name: 'Site 1' }], ['s2', { name: 'Site 2' }]]);

const job = (id, clientId, siteId, crew, over = {}) => ({
  id, clientId, siteId, crewIds: crew, startAt: iso(DAY), endAt: iso(DAY + 2 * 3600 * 1000), status: 'upcoming', ...over,
});
const punch = (jobId, userId, outAt) => ({ job_id: jobId, user_id: userId, clock_in_at: iso(DAY - 3600 * 1000), clock_out_at: outAt });

// ── the three statuses ────────────────────────────────────────────────────────
{
  const jobs = [job('j1', 'cl1', 's1', ['u_a', 'u_t']), job('j2', 'cl1', 's2', ['u_k'])];
  const entries = [
    punch('j1', 'u_a', iso(DAY)),   // Andre: complete
    punch('j1', 'u_t', null),       // Tomas: no clock-out
    // Keisha (j2): no punch at all
  ];
  const rows = computeAttendanceReport({ jobs, timeEntries: entries, usersById, clientsById, sitesById, fromMs: from, toMs: to });
  const byUser = Object.fromEntries(rows.map((r) => [r.userId, r.status]));
  ok(byUser.u_a === ATT_COMPLETE, 'A1: a clean with clock-in AND clock-out reads complete');
  ok(byUser.u_t === ATT_MISSING_OUT, 'A2: clocked in with no clock-out reads missing_clock_out');
  ok(byUser.u_k === ATT_NO_PUNCH, 'A3: a scheduled cleaner who never punched reads no_punch');
  ok(rows.length === 3, 'A4: one row per scheduled (cleaner, clean) — the two-crew job yields two rows');
  ok(incompleteCount(rows) === 2, 'A5: incompleteCount counts the no-punch + missing-out rows');
  ok(rows[0].status !== ATT_COMPLETE && rows[rows.length - 1].status === ATT_COMPLETE, 'A6: problems sort before complete');
  ok(rows.find((r) => r.userId === 'u_k').clientName === 'Las Olas', 'A7: rows carry the denormalized account name');
}

// ── window + cancelled exclusions ─────────────────────────────────────────────
{
  const jobs = [
    job('j_out', 'cl1', 's1', ['u_a'], { startAt: iso(DAY - 3 * 24 * 3600 * 1000) }), // 3 days ago
    job('j_x', 'cl1', 's1', ['u_a'], { status: 'cancelled' }),
  ];
  const rows = computeAttendanceReport({ jobs, timeEntries: [], usersById, clientsById, sitesById, fromMs: from, toMs: to });
  ok(rows.length === 0, 'B1: cleans outside the day-window and cancelled cleans are excluded');
}

// ── manager scoping ───────────────────────────────────────────────────────────
{
  const jobs = [job('j1', 'cl1', 's1', ['u_a']), job('j2', 'cl2', 's2', ['u_k'])];
  const mine = computeAttendanceReport({ jobs, timeEntries: [], usersById, clientsById, sitesById, fromMs: from, toMs: to, managerId: 'mgr1' });
  ok(mine.length === 1 && mine[0].clientId === 'cl1', 'C1: a managerId restricts the report to that manager\'s accounts (via client.supervisorId)');
  const all = computeAttendanceReport({ jobs, timeEntries: [], usersById, clientsById, sitesById, fromMs: from, toMs: to });
  ok(all.length === 2, 'C2: no managerId returns every scheduled clean');
}

// ── Reports fix #3 (2026-09-22): judged AS OF NOW, the auto-close cron, voided, time
//    off, overnight. The new statuses are written as literals so this suite also runs
//    against the pre-fix engine (where each of these reads RED). ────────────────────
const HOUR = 3600 * 1000;
const statusOf = (rows, userId) => rows.find((r) => r.userId === userId)?.status;
{
  // A night clean 3h from now, nobody clocked in yet: NOT a no-show (the Today report
  // listed every cleaner on tonight's shift as "No punch" at 2pm).
  const now = DAY - 3 * HOUR;
  const rows = computeAttendanceReport({ jobs: [job('j1', 'cl1', 's1', ['u_a'])], timeEntries: [], usersById, clientsById, sitesById, fromMs: from, toMs: to, now });
  ok(statusOf(rows, 'u_a') === 'upcoming', 'D1: a clean that has not started reads "upcoming", not no_punch');
  ok(incompleteCount(rows) === 0, 'D1b: …and is not counted as incomplete');
}
{
  const inGrace = computeAttendanceReport({ jobs: [job('j1', 'cl1', 's1', ['u_a'])], timeEntries: [], usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 5 * 60000, graceMins: 10 });
  ok(statusOf(inGrace, 'u_a') === 'upcoming', 'D2: 5 min after start, inside the 10-min late grace — still "upcoming"');
  const late = computeAttendanceReport({ jobs: [job('j1', 'cl1', 's1', ['u_a'])], timeEntries: [], usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 15 * 60000, graceMins: 10 });
  ok(statusOf(late, 'u_a') === ATT_NO_PUNCH, 'D2b: 15 min after start with no clock-in — no_punch');
}
{
  // Clocked in, the 2h clean is not over: on the clock, not "missing clock-out".
  const e = [{ job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY), clock_out_at: null, status: 'in_progress' }];
  const mid = computeAttendanceReport({ jobs: [job('j1', 'cl1', 's1', ['u_a'])], timeEntries: e, usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + HOUR });
  ok(statusOf(mid, 'u_a') === 'on_clock', 'D3: clocked in mid-shift reads "on_clock", not missing_clock_out');
  ok(incompleteCount(mid) === 0, 'D3b: …and is not counted as incomplete');
  const after = computeAttendanceReport({ jobs: [job('j1', 'cl1', 's1', ['u_a'])], timeEntries: e, usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 3 * HOUR, graceMins: 10 });
  ok(statusOf(after, 'u_a') === ATT_MISSING_OUT, 'D3c: still clocked in an hour after the clean ended — missing_clock_out');
}
{
  // The hourly cron closes a forgotten clock-out at the scheduled end (status
  // auto_closed). The cleaner never clocked out; it read "Complete", so the Yesterday
  // report hid every forgotten clock-out.
  const e = [{ job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY), clock_out_at: iso(DAY + 2 * HOUR), status: 'auto_closed' }];
  const rows = computeAttendanceReport({ jobs: [job('j1', 'cl1', 's1', ['u_a'])], timeEntries: e, usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 24 * HOUR });
  ok(statusOf(rows, 'u_a') === ATT_MISSING_OUT, 'E1: an auto-closed punch reads missing_clock_out, not complete');
  ok(rows[0].autoClosed === true, 'E1b: …and is flagged autoClosed so the report can say "(auto)"');
  // EVERY session counts: a real clock-out on one session does not clear a system-written
  // one on another — that auto-closed session is still paid on the system's guess until a
  // manager fixes or voids it. (This read "complete" before the review, 2026-09-22.)
  const both = computeAttendanceReport({
    jobs: [job('j1', 'cl1', 's1', ['u_a'])], usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 24 * HOUR,
    timeEntries: [...e, { job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY + 10 * 60000), clock_out_at: iso(DAY + HOUR), status: 'completed' }],
  });
  ok(statusOf(both, 'u_a') === ATT_MISSING_OUT && both[0].autoClosed === true, 'E2: an unfixed auto-closed session still reads missing_clock_out beside a real one');
}
{
  // Two sessions on one clean (a break). The first is finished; the second was never
  // clocked out. A finished first session must not hide the forgotten second clock-out —
  // neither while it is still open past the end, nor once the cron has auto-closed it.
  const jobs = [job('j1', 'cl1', 's1', ['u_a'])];
  const first = { job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY), clock_out_at: iso(DAY + HOUR), status: 'completed' };
  const open2 = { job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY + 70 * 60000), clock_out_at: null, status: 'in_progress' };
  const run = (timeEntries, now = DAY + 24 * HOUR) => computeAttendanceReport({ jobs, timeEntries, usersById, clientsById, sitesById, fromMs: from, toMs: to, now });
  ok(statusOf(run([first, open2]), 'u_a') === ATT_MISSING_OUT, 'E3: finished + still-open second session past the end → missing_clock_out');
  ok(statusOf(run([first, open2], DAY + 90 * 60000), 'u_a') === 'on_clock', 'E3b: …but mid-clean the open second session is just on_clock');
  const closed2 = { ...open2, clock_out_at: iso(DAY + 2 * HOUR), status: 'auto_closed', edit_history: [{ field: 'status', from: 'in_progress', to: 'auto_closed' }] };
  ok(statusOf(run([first, closed2]), 'u_a') === ATT_MISSING_OUT, 'E4: finished + auto-closed second session → missing_clock_out');
  const second = { ...open2, clock_out_at: iso(DAY + 110 * 60000), status: 'completed' };
  const rows = run([second, first]);
  ok(statusOf(rows, 'u_a') === ATT_COMPLETE, 'E5: two finished sessions → complete');
  ok(rows[0].clockInAt === first.clock_in_at && rows[0].clockOutAt === second.clock_out_at, 'E5b: the row shows the FIRST clock-in and the LAST clock-out');
}
{
  // A manager corrected the auto-closed clock-out: the time is now a reviewed one. The
  // correction form never clears the auto_closed status, so this read "Missing clock-out
  // (auto)" forever.
  const jobs = [job('j1', 'cl1', 's1', ['u_a'])];
  const base = { job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY), clock_out_at: iso(DAY + 2 * HOUR), status: 'auto_closed' };
  const run = (edit_history) => statusOf(computeAttendanceReport({ jobs, timeEntries: [{ ...base, edit_history }], usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 24 * HOUR }), 'u_a');
  const closed = { field: 'status', from: 'in_progress', to: 'auto_closed' };
  ok(run([closed, { field: 'clock_out_at', from: iso(DAY + 2 * HOUR), to: iso(DAY + 95 * 60000) }]) === ATT_COMPLETE, 'E6: a clock-out corrected AFTER the auto-close reads complete');
  ok(run([closed, { field: 'clock_in_at,clock_out_at', at: iso(DAY + 26 * HOUR) }]) === ATT_COMPLETE, 'E6b: the demo stub\'s comma-joined field list counts too');
  ok(run([{ field: 'clock_out_at', from: null, to: iso(DAY + HOUR) }, closed]) === ATT_MISSING_OUT, 'E6c: a correction made BEFORE the cron closed it does not count');
  ok(run([closed, { field: 'notes', to: 'x' }]) === ATT_MISSING_OUT, 'E6d: an edit that did not touch the clock-out does not count');
}
{
  const e = [{ job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY), clock_out_at: iso(DAY + HOUR), status: 'voided' }];
  const rows = computeAttendanceReport({ jobs: [job('j1', 'cl1', 's1', ['u_a'])], timeEntries: e, usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 24 * HOUR });
  ok(statusOf(rows, 'u_a') === ATT_NO_PUNCH, 'F1: a voided punch is not a punch — no_punch');
}
{
  // Booked off that day: a known absence (Reports › Called out), not a no-show.
  const timeOff = [
    { id: 't1', userId: 'u_a', startDate: '2026-09-18', endDate: '2026-09-18', kind: 'callout' },
    { id: 't2', userId: 'u_t', startDate: '2026-09-17', endDate: '2026-09-19', kind: 'planned' },
  ];
  const jobs = [job('j1', 'cl1', 's1', ['u_a', 'u_t', 'u_k'])];
  const entries = [{ job_id: 'j1', user_id: 'u_k', clock_in_at: iso(DAY), clock_out_at: iso(DAY + HOUR), status: 'completed' }];
  const rows = computeAttendanceReport({ jobs, timeEntries: entries, usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 24 * HOUR, timeOff });
  const a = rows.find((r) => r.userId === 'u_a');
  const t = rows.find((r) => r.userId === 'u_t');
  ok(a?.status === 'off' && a.offKind === 'callout', 'G1: a called-out cleaner with no punch reads "off" (callout)');
  ok(t?.status === 'off' && t.offKind === 'planned', 'G2: planned time off reads "off" (planned)');
  ok(incompleteCount(rows) === 0, 'G3: known absences are not incomplete');
  const worked = computeAttendanceReport({
    jobs: [job('j1', 'cl1', 's1', ['u_a'])], usersById, clientsById, sitesById, fromMs: from, toMs: to, now: DAY + 24 * HOUR, timeOff,
    timeEntries: [{ job_id: 'j1', user_id: 'u_a', clock_in_at: iso(DAY), clock_out_at: iso(DAY + HOUR), status: 'completed' }],
  });
  ok(statusOf(worked, 'u_a') === ATT_COMPLETE, 'G4: booked off but worked anyway — judged on the punch');
}
{
  // An 11:30pm clean clocked into at 12:10am the next day: matched by clean, not by
  // the clock-in's day (the old punch filter dropped it and called it no_punch).
  const night = job('j9', 'cl1', 's1', ['u_a'], { startAt: iso(to - 30 * 60000), endAt: iso(to + 2 * HOUR) });
  const e = [{ job_id: 'j9', user_id: 'u_a', clock_in_at: iso(to + 10 * 60000), clock_out_at: iso(to + 2 * HOUR), status: 'completed' }];
  const rows = computeAttendanceReport({ jobs: [night], timeEntries: e, usersById, clientsById, sitesById, fromMs: from, toMs: to, now: to + 24 * HOUR });
  ok(statusOf(rows, 'u_a') === ATT_COMPLETE, 'H1: a clean clocked into after midnight still matches its punch');
}

console.log(`\n${pass}/${pass + fail} attendance-report assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
