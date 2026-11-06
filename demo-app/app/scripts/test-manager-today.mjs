// Node unit test for lib/managerToday — the ONE answer behind the manager's "today" screens
// (Shift check-in, the Schedule's Today view, Checklists today, and the Home's band and tiles):
// for each of today's visits in this manager's buildings, where does it stand?
//
// Offline, pure. Every edge the brief names: one minute before the start, at the start, one
// minute before and AT the missed mark, after it, called out (planned and call-out, and a
// cleaner the booking took off the clean), overnight, a done visit (by punch and by the
// office's status), a voided punch, the day / evening split at 2:59 / 3:00 PM, and each
// checklist state. Thresholds are read from their source of truth (opsAlerts'
// missedAfterStartMins, managerToday's EVENING_FROM_MINS), never restated.
//
// The module is loaded dynamically so this suite RUNS (and reports its counts) against a tree
// where it does not exist yet: every check then fails instead of the file crashing.
//   node app/scripts/test-manager-today.mjs
import { composeIso, addDaysKey } from '../src/lib/dates.js';
import { missedAfterStartMins, OPS_ALERT_DEFAULTS } from '../src/lib/opsAlerts.js';

const mod = await import('../src/lib/managerToday.js').catch((e) => {
  console.error(`  (lib/managerToday.js did not load: ${e.code || e.message})`);
  return {};
});
const compute = mod.computeManagerToday || (() => ({ visits: [], counts: {} }));
// An ABSENCE check ("no minutes past", "not in the list") passes vacuously on a stand-in, so
// each one also asks that the real module answered.
const HAVE = typeof mod.computeManagerToday === 'function';
// A missing vocabulary must never compare EQUAL to a missing field (undefined === undefined):
// every read of the stand-in is a fresh Symbol, so a check against it can only fail.
const MISSING = new Proxy({}, { get: () => Symbol('missing') });
const S = mod.VISIT_STATUS || MISSING;
const C = mod.CHECKLIST_STATE || MISSING;
const G = mod.VISIT_GROUP || MISSING;
const EVENING_FROM = mod.EVENING_FROM_MINS;
const NO_MANAGER = mod.NO_MANAGER;
const todayWindow = mod.todayWindow || (() => ({}));

let pass = 0;
let fail = 0;
// ok(condition, message) — this file's own order.
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const TZ = 'America/New_York';
const DAY = '2026-10-09';
const MIN = 60 * 1000;
const at = (hh, mm = 0, key = DAY) => new Date(composeIso(key, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, TZ)).getTime();
const atMins = (mins, key = DAY) => at(Math.floor(mins / 60), mins % 60, key);
const iso = (ms) => new Date(ms).toISOString();

const users = [
  { id: 'u_a', name: 'Andre Baptiste', phone: '1-754-555-0121', role: 'crew', status: 'active' },
  { id: 'u_t', name: 'Tomas Rivera', phone: '1-754-555-0122', role: 'crew', status: 'active' },
  { id: 'u_k', name: 'Keisha Bryant', phone: '1-754-555-0123', role: 'crew', status: 'active' },
  { id: 'u_l', name: 'Luis Ferrer', phone: '', role: 'crew', status: 'active', clockRules: { checklistBlockOff: true } },
  { id: 'u_x', name: 'Gone Person', phone: '1-754-555-0199', role: 'crew', status: 'inactive' },
  { id: 'mgr1', name: 'Renata Cruz', role: 'manager', status: 'active' },
  { id: 'mgr2', name: 'Sam Lee', role: 'manager', status: 'active' },
];
const clients = [
  { id: 'cl1', name: 'Las Olas Medical', supervisorId: 'mgr1', crewChecklists: { u_a: 'tplA', u_l: 'tplL' } },
  { id: 'cl2', name: 'Coral Bay HOA', supervisorId: 'mgr2' },
  { id: 'cl3', name: 'Flagler Townhomes' },
];
const sites = [
  { id: 's1', clientId: 'cl1', name: 'Main Hospital' },
  { id: 's2', clientId: 'cl2', name: 'Clubhouse' },
  { id: 's3', clientId: 'cl3', name: 'Townhomes' },
];
const START = at(18, 0); // a 6:00 PM evening clean
const job = (id, over = {}) => ({
  id, clientId: 'cl2', siteId: 's2', crewIds: ['u_k'], startAt: iso(START), endAt: iso(START + 120 * MIN), status: 'upcoming', ...over,
});
const punch = (jobId, userId, inMs, outMs = null, over = {}) => ({
  id: `te_${jobId}_${userId}_${inMs}`, job_id: jobId, user_id: userId, clock_in_at: iso(inMs), clock_out_at: outMs == null ? null : iso(outMs),
  status: outMs == null ? 'in_progress' : 'completed', ...over,
});
const run = (over = {}) => compute({ jobs: [], timeEntries: [], checklists: [], timeOff: [], users, clients, sites, opsSettings: {}, managerId: null, now: START, tz: TZ, ...over });
const visitOf = (res, id) => (res && Array.isArray(res.visits) ? res.visits.find((v) => v.jobId === id) : undefined);
const one = (over) => visitOf(run(over), over.jobs?.[0]?.id || 'j1');

// ── A · the status edges, against the ONE missed mark (ALR-11) ──────────────────────────────
const GRACE = missedAfterStartMins({});
ok(GRACE === OPS_ALERT_DEFAULTS.missedAfterStartMins, 'A0: the shipped missed mark is read through its own reader (opsAlerts)');
{
  const jobs = [job('j1')];
  const v = (now) => one({ jobs, now });
  ok(v(START - MIN)?.status === S.UPCOMING, 'A1: one minute before the start, nobody on the clock → upcoming');
  ok(HAVE && v(START - MIN)?.minutesPast == null, 'A1b: …with no minutes past');
  ok(v(START)?.status === S.UPCOMING, 'A2: AT the start → still upcoming (late means PAST the start)');
  ok(v(START + MIN)?.status === S.LATE, 'A3: one minute past the start → late');
  ok(v(START + MIN)?.minutesPast === 1, 'A3b: …1 minute past');
  ok(v(START + (GRACE - 1) * MIN)?.status === S.LATE, 'A4: one minute before the missed mark → late');
  ok(v(START + GRACE * MIN)?.status === S.LATE, 'A5: AT the missed mark → still late (the attendance rule is strictly past the mark)');
  ok(v(START + GRACE * MIN)?.minutesPast === GRACE, 'A5b: …minutesPast equals the mark');
  ok(v(START + (GRACE + 1) * MIN)?.status === S.NO_CHECK_IN, 'A6: one minute past the mark → no_check_in');
  ok(v(START + (GRACE + 1) * MIN)?.minutesPast === GRACE + 1, 'A6b: …with its minutes past');
  // The office's own setting is what moves the mark (opsSettings.missedAfterStartMins).
  const custom = { missedAfterStartMins: GRACE + 15 };
  const g2 = missedAfterStartMins(custom);
  ok(one({ jobs, now: START + (GRACE + 1) * MIN, opsSettings: custom })?.status === S.LATE, 'A7: a longer office setting keeps the visit late past the shipped mark');
  ok(one({ jobs, now: START + (g2 + 1) * MIN, opsSettings: custom })?.status === S.NO_CHECK_IN, 'A7b: …and no_check_in one minute past ITS mark');
  // The same answer the attendance report gives, through the shared rule.
  ok(typeof mod.computeManagerToday === 'function', 'A8: computeManagerToday is exported');
}

// ── B · called out (planned and call-out), and a cleaner a booking took off the clean ──────
{
  const callout = [{ id: 'to1', userId: 'u_k', startDate: DAY, endDate: DAY, kind: 'callout' }];
  const v = one({ jobs: [job('j1')], timeOff: callout, now: START + 3 * 60 * MIN });
  ok(v?.status === S.CALLED_OUT, 'B1: the only cleaner called out → called_out, even hours past the mark (never no_check_in)');
  ok(v?.offKind === 'callout', 'B1b: …offKind callout');
  ok(Array.isArray(v?.calledOut) && v?.calledOut?.length === 1 && v?.calledOut?.[0]?.userId === 'u_k', 'B1c: …and names who');
  ok(Array.isArray(v?.crew) && v?.crew?.length === 0, 'B1d: …with nobody left expected on it');
  const planned = [{ id: 'to2', userId: 'u_k', startDate: addDaysKey(DAY, -1), endDate: addDaysKey(DAY, 1), kind: 'planned' }];
  const p = one({ jobs: [job('j1')], timeOff: planned, now: START + 3 * 60 * MIN });
  ok(p?.status === S.CALLED_OUT && p?.offKind === 'planned', 'B2: planned time off covering today → called_out (planned)');
  // Team › Time off takes the person OFF the clean by default; the booking records it.
  const removed = [{ id: 'to3', userId: 'u_k', startDate: DAY, endDate: DAY, kind: 'callout', scheduledJobIds: ['j1'] }];
  const r = one({ jobs: [job('j1', { crewIds: [] })], timeOff: removed, now: START + 3 * 60 * MIN });
  ok(r?.status === S.CALLED_OUT, 'B3: a cleaner the booking took off the clean → called_out, not an empty no_check_in');
  ok(r?.calledOut?.[0]?.userId === 'u_k' && r?.calledOut?.[0]?.name === 'Keisha Bryant', 'B3b: …naming them from the booking');
  const two = one({ jobs: [job('j1', { crewIds: ['u_k', 'u_t'] })], timeOff: callout, now: START + (GRACE + 5) * MIN });
  ok(two?.status === S.NO_CHECK_IN, 'B4: one of two called out, the other never came → no_check_in (the visit still had someone due)');
  ok(two?.crew?.length === 1 && two?.crew?.[0]?.userId === 'u_t', 'B4b: …the expected crew is the one still due');
  const worked = one({ jobs: [job('j1')], timeOff: callout, timeEntries: [punch('j1', 'u_k', START - 2 * MIN)], now: START + 10 * MIN });
  ok(worked?.status === S.IN_PROGRESS, 'B5: booked off but clocked in anyway → judged on the punch (in_progress)');
}

// ── C · in progress, D · done, E · voided ──────────────────────────────────────────────────
{
  const inAt = START - 2 * MIN;
  const v = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', inAt)], now: START + 30 * MIN });
  ok(v?.status === S.IN_PROGRESS, 'C1: an open punch → in_progress');
  ok(v?.arrivedAt === iso(inAt), 'C1b: …arrivedAt is the clock-in');
  ok(HAVE && v?.minutesPast == null, 'C1c: …and no minutes past');
  ok(v?.arrivedLateMins === 0, 'C1d: clocked in before the start → arrivedLateMins 0');
  const late = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', START + 12 * MIN)], now: START + 20 * MIN });
  ok(late?.status === S.IN_PROGRESS && late?.arrivedLateMins === 12, 'C2: clocked in 12 minutes after the start → arrivedLateMins 12');
  const onTime = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', START)], now: START + 20 * MIN });
  ok(onTime?.arrivedLateMins === 0, 'C2b: clocked in AT the start → not late');
  // Two cleaners: one still on the clock keeps the visit in progress.
  const pair = one({
    jobs: [job('j1', { crewIds: ['u_k', 'u_t'] })], now: START + 90 * MIN,
    timeEntries: [punch('j1', 'u_k', START, START + 60 * MIN), punch('j1', 'u_t', START + 5 * MIN)],
  });
  ok(pair?.status === S.IN_PROGRESS, 'C3: one cleaner out, the other still on the clock → in_progress');
  ok(pair?.arrivedAt === iso(START), 'C3b: …arrivedAt is the FIRST clock-in on the visit');
  // An open punch past the end (a forgotten clock-out) is still someone on the record's clock.
  const forgot = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', START)], now: START + 5 * 60 * MIN }); // 11 PM, still today
  ok(forgot?.status === S.IN_PROGRESS, 'C4: an open punch past the end → still in_progress (the record says on the clock)');
}
{
  const done = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', START, START + 110 * MIN)], now: START + 3 * 60 * MIN });
  ok(done?.status === S.DONE, 'D1: every punch closed → done');
  const auto = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', START, START + 120 * MIN, { status: 'auto_closed' })], now: START + 5 * 60 * MIN });
  ok(auto?.status === S.DONE, 'D2: closed by the auto-close cron → done (the visit is over; the missing clock-out is Approvals\' to fix)');
  const marked = one({ jobs: [job('j1', { status: 'done' })], now: START + 3 * 60 * MIN });
  ok(marked?.status === S.DONE, 'D3: the office marked the clean done with no punch → done, never no_check_in');
  const cancelled = run({ jobs: [job('j1', { status: 'cancelled' })], now: START + 3 * 60 * MIN });
  ok(HAVE && Array.isArray(cancelled.visits) && !visitOf(cancelled, 'j1'), 'D4: a cancelled clean is not a visit');
}
{
  const voided = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', START, START + 60 * MIN, { status: 'voided' })], now: START + (GRACE + 1) * MIN });
  ok(voided?.status === S.NO_CHECK_IN, 'E1: a voided punch is not a punch → no_check_in past the mark');
  ok(HAVE && voided?.arrivedAt == null, 'E1b: …and no arrival time');
  const noShow = one({ jobs: [job('j1')], timeEntries: [punch('j1', 'u_k', START, null, { status: 'no_show' })], now: START + (GRACE + 1) * MIN });
  ok(noShow?.status === S.NO_CHECK_IN, 'E2: a no_show punch is not a punch either');
  const otherJob = one({ jobs: [job('j1')], timeEntries: [punch('j_other', 'u_k', START)], now: START + (GRACE + 1) * MIN });
  ok(otherJob?.status === S.NO_CHECK_IN, 'E3: a punch on another clean does not check this one in (matched by job, not by person)');
}

// ── F · overnight: a clean belongs to the day it STARTS (the attendance report's rule) ───────
{
  const lateStart = at(23, 30);
  const night = job('jn', { startAt: iso(lateStart), endAt: iso(lateStart + 3 * 60 * MIN) });
  const v = visitOf(run({ jobs: [night], timeEntries: [punch('jn', 'u_k', lateStart + 10 * MIN)], now: lateStart + 20 * MIN }), 'jn');
  ok(v?.status === S.IN_PROGRESS, 'F1: an 11:30 PM clean clocked into at 11:40 → in today\'s list, in progress');
  const yesterday = job('jy', { startAt: iso(at(23, 0, addDaysKey(DAY, -1))), endAt: iso(at(1, 0)) });
  const res = run({ jobs: [yesterday], timeEntries: [punch('jy', 'u_k', at(23, 5, addDaysKey(DAY, -1)))], now: at(0, 30) });
  ok(HAVE && Array.isArray(res.visits) && !visitOf(res, 'jy'), 'F2: last night\'s 11 PM clean still running at 12:30 AM is yesterday\'s visit, not today\'s');
  const w = todayWindow(at(12, 0), TZ);
  ok(w.dayKey === DAY, 'F3: todayWindow names the org day');
  ok(w.fromMs === at(0, 0) && w.toMs === at(0, 0, addDaysKey(DAY, 1)) - 1, 'F3b: …from the org midnight to one ms before the next');
  ok(Number.isFinite(Date.parse(w.readFromIso)) && Date.parse(w.readFromIso) <= w.fromMs - 12 * 60 * MIN, 'F4: the punch read starts at least 12 h before the day (an early clock-in)');
  ok(Number.isFinite(Date.parse(w.readToIso)) && Date.parse(w.readToIso) >= w.toMs + 18 * 60 * MIN, 'F4b: …and ends at least 18 h after it (a night clean clocked into after midnight)');
}

// ── G · the day / evening split (S1: before 3:00 PM is Day) ─────────────────────────────────
{
  ok(Number.isInteger(EVENING_FROM) && EVENING_FROM > 0 && EVENING_FROM < 24 * 60, 'G0: EVENING_FROM_MINS is exported as a minute of the day');
  const s1 = atMins(EVENING_FROM - 1);
  const s2 = atMins(EVENING_FROM);
  const res = run({
    jobs: [job('jd', { startAt: iso(s1), endAt: iso(s1 + 60 * MIN) }), job('je', { startAt: iso(s2), endAt: iso(s2 + 60 * MIN) })],
    now: at(10, 0),
  });
  ok(visitOf(res, 'jd')?.group === G.DAY, 'G1: one minute before the evening mark (2:59 PM) → day');
  ok(visitOf(res, 'je')?.group === G.EVENING, 'G2: AT the evening mark (3:00 PM) → evening');
  ok(visitOf(res, 'jd') && visitOf(res, 'je') && G.DAY !== G.EVENING, 'G3: the two groups are distinct values');
  const order = (res.visits || []).map((v) => v.jobId);
  ok(order.join() === 'jd,je', 'G4: visits come back in start order');
}

// ── H · scope by manager (client.supervisorId) ──────────────────────────────────────────────
{
  const jobs = [
    job('j1', { clientId: 'cl1', siteId: 's1', crewIds: ['u_a'] }),
    job('j2', { clientId: 'cl2', siteId: 's2' }),
    job('j3', { clientId: 'cl3', siteId: 's3', crewIds: ['u_t'] }),
  ];
  const ids = (res) => (res.visits || []).map((v) => v.jobId).sort().join();
  ok(ids(run({ jobs, managerId: null })) === 'j1,j2,j3', 'H1: no manager (All managers) → every building');
  ok(ids(run({ jobs, managerId: 'mgr1' })) === 'j1', 'H2: a manager → only the buildings they supervise');
  ok(NO_MANAGER != null && ids(run({ jobs, managerId: NO_MANAGER })) === 'j3', 'H3: NO_MANAGER → only buildings with no supervisor');
  ok(HAVE && ids(run({ jobs, managerId: 'nobody' })) === '', 'H4: a manager with no buildings → nothing');
}

// ── I · the checklist per visit ─────────────────────────────────────────────────────────────
{
  const owed = (over = {}) => job('j1', { clientId: 'cl1', siteId: 's1', crewIds: ['u_a'], ...over });
  const res = (row) => ({ id: `r_${Math.random().toString(36).slice(2)}`, job_id: 'j1', site_id: 's1', completed_by_user_id: 'u_a', performed_at: iso(START + 60 * MIN), ...row });
  const none = one({ jobs: [job('j1')], now: START + 10 * MIN });
  ok(none?.checklist === C.NONE, 'I1: nobody on the visit holds a checklist at that customer → none');
  const notStarted = one({ jobs: [owed()], now: START - 10 * MIN });
  ok(notStarted?.checklist === C.NOT_STARTED, 'I2: owed, nobody clocked in, nothing saved → not_started');
  const inProg = one({ jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], now: START + 30 * MIN });
  ok(inProg?.checklist === C.IN_PROGRESS, 'I3: clocked in, nothing saved yet → in_progress');
  ok(HAVE && inProg?.completed == null && inProg?.total == null, 'I3b: …with NO count (a checklist counts once it is saved, S9)');
  const complete = one({ jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], checklists: [res({ completed_count: 9, total_count: 9 })], now: START + 70 * MIN });
  ok(complete?.checklist === C.COMPLETE, 'I4: a saved checklist with every item done → complete');
  ok(complete?.completed === 9 && complete?.total === 9, 'I4b: …with its stored 9 of 9');
  const short = one({ jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], checklists: [res({ completed_count: 7, total_count: 9 })], now: START + 70 * MIN });
  ok(short?.checklist === C.NOT_FINISHED, 'I5: saved short (crewChecklist.isChecklistComplete false) → not_finished');
  ok(short?.completed === 7 && short?.total === 9, 'I5b: …with its stored 7 of 9');
  const empty = one({ jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], checklists: [res({ completed_count: 0, total_count: 0 })], now: START + 70 * MIN });
  ok(empty?.checklist === C.NOT_FINISHED, 'I6: a 0 of 0 save is never complete');
  const doneWins = one({
    jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], now: START + 100 * MIN,
    checklists: [res({ completed_count: 9, total_count: 9, performed_at: iso(START + 60 * MIN) }), res({ completed_count: 3, total_count: 9, performed_at: iso(START + 90 * MIN) })],
  });
  ok(doneWins?.checklist === C.COMPLETE && doneWins?.completed === 9, 'I7: a later partial re-save never undoes a finished checklist (the clock-out gate\'s rule)');
  const latest = one({
    jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], now: START + 100 * MIN,
    checklists: [res({ completed_count: 2, total_count: 9, performed_at: iso(START + 60 * MIN) }), res({ completed_count: 5, total_count: 9, performed_at: iso(START + 90 * MIN) })],
  });
  ok(latest?.checklist === C.NOT_FINISHED && latest?.completed === 5, 'I8: of two short saves, the newest is the one shown');
  const someoneElse = one({ jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], checklists: [res({ completed_by_user_id: 'u_t', completed_count: 9, total_count: 9 })], now: START + 70 * MIN });
  ok(someoneElse?.checklist === C.IN_PROGRESS, 'I9: another person\'s saved checklist is not this cleaner\'s');
  // The clock-out gate counts only the clean's OWN saves (api/_lib/time/checklistGate: job_id =
  // the clean), so a save filled outside the visit never reads "complete" here either — it
  // would not unlock that cleaner's clock-out. (A loose save from this morning used to be
  // matched to tonight's visit by the reminder's 18-hour window: driven on the demo, 2026-10-09.)
  const loose = one({
    jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], now: START + 70 * MIN,
    checklists: [res({ job_id: null, completed_count: 9, total_count: 9 })],
  });
  ok(loose?.checklist === C.IN_PROGRESS, 'I10: a save with no clean id is not this visit\'s (the clock-out gate\'s rule)');
  const otherVisit = one({
    jobs: [owed()], timeEntries: [punch('j1', 'u_a', START)], now: START + 70 * MIN,
    checklists: [res({ job_id: 'j_other', completed_count: 9, total_count: 9 })],
  });
  ok(otherVisit?.checklist === C.IN_PROGRESS, 'I10b: …nor is a save on another clean');
  const left = one({ jobs: [owed()], timeEntries: [punch('j1', 'u_a', START, START + 90 * MIN)], now: START + 100 * MIN });
  ok(left?.checklist === C.NOT_FINISHED && left?.completed == null, 'I11: clocked out with nothing saved → not_finished, with no count');
  // R8: a cover fills the COVERED cleaner's checklist.
  const cover = one({ jobs: [owed({ crewIds: ['u_t'], coverFor: { u_t: 'u_a' } })], now: START - 10 * MIN });
  ok(cover?.checklist === C.NOT_STARTED, 'I12: a cover owes the covered cleaner\'s checklist (crewChecklist.checklistFor)');
  // The least-finished cleaner decides the visit.
  const pairJob = owed({ crewIds: ['u_a', 'u_l'] });
  const pair = one({
    jobs: [pairJob], now: START + 100 * MIN,
    timeEntries: [punch('j1', 'u_a', START), punch('j1', 'u_l', START)],
    checklists: [res({ completed_count: 9, total_count: 9 })],
  });
  ok(pair?.checklist === C.IN_PROGRESS, 'I13: one cleaner finished, the other still working → in_progress');
  ok(pair?.completed === 9 && pair?.total === 9, 'I13b: …the saved counts are still carried');
  const allDone = one({
    jobs: [pairJob], now: START + 100 * MIN,
    timeEntries: [punch('j1', 'u_a', START), punch('j1', 'u_l', START)],
    checklists: [res({ completed_count: 9, total_count: 9 }), res({ completed_by_user_id: 'u_l', completed_count: 4, total_count: 4 })],
  });
  ok(allDone?.checklist === C.COMPLETE && allDone?.completed === 13 && allDone?.total === 13, 'I14: both saved complete → complete, counts summed');
  ok(Array.isArray(allDone?.results) && allDone.results.length === 2, 'I14b: …and the saved rows are listed so a screen can open them');
  // The clock-out block, per cleaner, from their own clock rules (the office's override).
  ok(complete?.blocksClockOut === true, 'I15: a cleaner with the block on → blocksClockOut');
  const exempt = one({ jobs: [owed({ crewIds: ['u_l'] })], now: START - 10 * MIN });
  ok(exempt?.checklist === C.NOT_STARTED && exempt?.blocksClockOut === false, 'I16: the office turned the block off for the only cleaner → blocksClockOut false');
  ok(none?.blocksClockOut === false, 'I17: no checklist → nothing blocks the clock-out');
  // A called-out visit owes no checklist.
  const out = one({ jobs: [owed()], timeOff: [{ id: 'x', userId: 'u_a', startDate: DAY, endDate: DAY, kind: 'callout' }], now: START + 60 * MIN });
  ok(out?.status === S.CALLED_OUT && out?.checklist === C.NONE, 'I18: a called-out visit owes no checklist');
}

// ── J · crew, labels, counts ────────────────────────────────────────────────────────────────
{
  const v = one({ jobs: [job('j1', { crewIds: ['u_k', 'u_t'] })], now: START - 5 * MIN });
  ok(v?.crew?.[0]?.userId === 'u_k' && v?.crew?.[0]?.name === 'Keisha Bryant' && v?.crew?.[0]?.phone === '1-754-555-0123', 'J1: crew lists each cleaner with name and phone, in the schedule\'s order (the first is the one to call)');
  ok(v?.customerLabel === 'Coral Bay HOA', 'J2: customerLabel is the customer\'s name');
  ok(v?.clientId === 'cl2' && v?.siteId === 's2' && v?.startAt === iso(START), 'J3: the visit carries its ids and times');
  const inactive = one({ jobs: [job('j1', { crewIds: ['u_x', 'u_k'] })], now: START - 5 * MIN });
  ok(inactive?.crew?.length === 1 && inactive?.crew?.[0]?.userId === 'u_k', 'J4: a deactivated cleaner who never punched is not expected crew');

  const jobs = [
    job('a', { clientId: 'cl1', siteId: 's1', crewIds: ['u_a'] }),                                   // in progress, checklist in progress
    job('b', { clientId: 'cl1', siteId: 's1', crewIds: ['u_l'] }),                                   // late, checklist not started
    job('c', { crewIds: ['u_t'], startAt: iso(START - 60 * MIN) }),                                    // no check-in
    job('d', { crewIds: ['u_k'], startAt: iso(START + 60 * MIN), endAt: iso(START + 120 * MIN) }),     // upcoming
    job('e', { crewIds: ['u_t'], startAt: iso(at(8, 0)), endAt: iso(at(9, 0)), status: 'done' }),      // done (day)
    job('f', { clientId: 'cl3', siteId: 's3', crewIds: ['u_x'] }),                                   // crewless (inactive) → late
  ];
  const now = START + 10 * MIN;
  const res = run({
    jobs, now,
    timeEntries: [punch('a', 'u_a', START - MIN)],
    timeOff: [],
  });
  const c = res.counts || {};
  ok(c.total === 6, 'J5: total counts every visit');
  ok(c.onSite === 1, 'J6: onSite = visits in progress');
  ok(c.late === 2, 'J7: late counted');
  ok(c.noCheckIn === 1, 'J8: noCheckIn counted');
  ok(c.upcoming === 1, 'J9: upcoming counted');
  ok(c.done === 1, 'J10: done counted');
  ok(c.calledOut === 0, 'J11: calledOut counted');
  ok(c.properties === 3, 'J12: properties = the distinct buildings with a visit today');
  ok(c.checklists && c.checklists.inProgress === 1 && c.checklists.notStarted === 1 && c.checklists.none === 4, 'J13: the checklist tallies');
  ok(c.checklists && c.checklists.complete === 0 && c.checklists.notFinished === 0, 'J13b: …complete and not_finished at zero');
  ok(c.day === 1 && c.evening === 5, 'J14: day / evening tallies');
  ok(res.dayKey === DAY && res.asOf === iso(now), 'J15: the result names its org day and the moment it was judged');
  const empty = run({ jobs: [], now });
  ok(Array.isArray(empty.visits) && empty.visits.length === 0 && empty.counts?.total === 0, 'J16: no visits → an empty list and zero counts, never undefined');
}

console.log(`\n${pass}/${pass + fail} manager-today assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
