// Reports › Called out (Reports fix #2, 2026-09-22). Drives the REAL reducer the way
// Team › Time off books a same-day call-out — ADD_TIME_OFF carrying the cleans it pulls
// the person off, then APPLY_TIME_OFF_EXCLUSIONS (on by default) — and asserts the
// report still names the clean they called out of, under every filter. Before the fix
// the report found cleans only through the crew list, which that same booking empties:
// the cleaner showed "—, 0 cleans", and vanished under a Manager or Customer filter.
// Also pins the call-out vs planned type (owner decision): planned time off is not a
// call-out; an entry from before the type existed still is.
//   node app/scripts/test-called-out.mjs
import { loadStore } from './deletion-core.mjs';
import { calledOutOn } from '../src/lib/reports/calledOut.js';
import { todayKey, addDaysKey, composeIso } from '../src/lib/dates.js';
import { defaultTimeOffKind, jobsCoveredByTimeOff } from '../src/store/timeOffRules.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();

const HOUR = 3600 * 1000;
// The report day: two org-days ahead, so its evening cleans are always still ahead of
// the clock (APPLY_TIME_OFF_EXCLUSIONS only pulls people off cleans not yet started) and
// never straddle midnight whatever time the suite runs.
const D = addDaysKey(todayKey(), 2);
const startMs = new Date(composeIso(D, '18:00')).getTime();
const clientA = { id: 'cl_t_palm', name: 'Palmetto Test', supervisorId: 'u_t_heather' };
const clientB = { id: 'cl_t_bay', name: 'Bayshore Test', supervisorId: 'u_t_other' };
const site = (id, clientId) => ({ id, clientId, name: `${clientId} main` });
const baseJob = (id, clientId, crew, atMs) => ({
  id, clientId, siteId: `st_${clientId}`, crewIds: crew, status: 'upcoming',
  startAt: new Date(atMs).toISOString(), endAt: new Date(atMs + HOUR).toISOString(),
});

let state = {
  ...INITIAL_STATE,
  clients: [...(INITIAL_STATE.clients || []), clientA, clientB],
  sites: [...(INITIAL_STATE.sites || []), site('st_cl_t_palm', clientA.id), site('st_cl_t_bay', clientB.id)],
  users: [...(INITIAL_STATE.users || []), { id: 'u_t_luis', name: 'Luis Test', role: 'crew', status: 'active' }, { id: 'u_t_ana', name: 'Ana Test', role: 'crew', status: 'active' }],
  timeOff: [],
};
const dispatch = (action) => { state = reducer(state, action); };
dispatch({ type: ACTIONS.ADD_JOB, job: baseJob('j_t_tonight', clientA.id, ['u_t_luis'], startMs) });
dispatch({ type: ACTIONS.ADD_JOB, job: baseJob('j_t_other', clientB.id, ['u_t_ana', 'u_t_luis'], startMs + HOUR) });

// Exactly what TimeOffCard dispatches for "Luis can't make tonight" with the default
// "Also remove Luis from the 2 cleans already scheduled" box checked: the entry records
// every clean it covers (scheduledJobIds), then the exclusion takes him off them.
const affected = ['j_t_tonight', 'j_t_other'];
dispatch({ type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t_luis', userId: 'u_t_luis', startDate: D, endDate: D, reason: 'Car trouble', kind: 'callout', scheduledJobIds: affected } });
dispatch({ type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: 'u_t_luis', startDate: D, endDate: D });

const tonight = state.jobs.find((j) => j.id === 'j_t_tonight');
const other = state.jobs.find((j) => j.id === 'j_t_other');
ok(tonight && tonight.crewIds.length === 0 && !other.crewIds.includes('u_t_luis'), 'SETUP: the booking took Luis off both cleans (the default)');
const entry = state.timeOff.find((t) => t.id === 'to_t_luis');
ok(entry && entry.kind === 'callout' && entry.scheduledJobIds?.length === 2, 'SETUP: the entry keeps its type and the cleans it covers');

const ctx = () => ({
  timeOff: state.timeOff, jobs: state.jobs,
  usersById: new Map(state.users.map((u) => [u.id, u])),
  clientsById: new Map(state.clients.map((c) => [c.id, c])),
  sitesById: new Map(state.sites.map((s) => [s.id, s])),
  dayKey: D,
});

{
  const rows = calledOutOn(ctx());
  const luis = rows.find((r) => r.userId === 'u_t_luis');
  ok(!!luis, 'L1: Luis is listed');
  ok(luis?.cleanCount === 2 && luis.customers.includes('Palmetto Test') && luis.customers.includes('Bayshore Test'), `L2: both cleans he called out of are named (got ${luis?.cleanCount}: ${luis?.customers})`);
  ok(luis?.uncoveredCount === 1, 'L3: the clean now left with NO crew is flagged (tonight\'s), the one Ana still covers is not');
  const byCustomer = calledOutOn({ ...ctx(), clientId: clientA.id });
  ok(byCustomer.some((r) => r.userId === 'u_t_luis' && r.cleanCount === 1), 'L4: filtered to the customer he called out of, he is STILL listed');
  const byManager = calledOutOn({ ...ctx(), managerId: 'u_t_heather' });
  ok(byManager.some((r) => r.userId === 'u_t_luis'), 'L5: filtered to that customer\'s manager, he is still listed');
  const elsewhere = calledOutOn({ ...ctx(), managerId: 'u_nobody' });
  ok(!elsewhere.some((r) => r.userId === 'u_t_luis'), 'L6: another manager\'s view does not list him');
}

// Planned time off is not a call-out; a pre-type entry still is.
dispatch({ type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t_ana', userId: 'u_t_ana', startDate: D, endDate: D, reason: 'Vacation', kind: 'planned' } });
{
  const rows = calledOutOn(ctx());
  ok(!rows.some((r) => r.userId === 'u_t_ana'), 'K1: planned time off (a vacation) is NOT listed as a call-out');
}
{
  const legacy = [{ id: 'to_old', userId: 'u_t_ana', startDate: D, endDate: D, reason: 'sick' }]; // no kind: written before the type existed
  const rows = calledOutOn({ ...ctx(), timeOff: legacy });
  const ana = rows.find((r) => r.userId === 'u_t_ana');
  ok(ana && ana.cleanCount === 1 && ana.customers[0] === 'Bayshore Test', 'K2: an entry with no type still counts, found through the crew list she is still on');
}

// Two call-outs for one person, a removed clean on ANOTHER day, a cancelled clean.
{
  const tomorrow = baseJob('j_t_tomorrow', clientA.id, [], startMs + 24 * HOUR);
  const cancelled = { ...baseJob('j_t_cx', clientA.id, [], startMs), status: 'cancelled' };
  const timeOff = [
    { id: 'a', userId: 'u_t_luis', startDate: D, endDate: D, reason: 'Sick', kind: 'callout', scheduledJobIds: ['j_t_tonight', 'j_t_tomorrow', 'j_t_cx'] },
    { id: 'b', userId: 'u_t_luis', startDate: D, endDate: D, reason: 'Still sick', kind: 'callout', scheduledJobIds: ['j_t_tonight'] },
  ];
  const rows = calledOutOn({ ...ctx(), timeOff, jobs: [...state.jobs, tomorrow, cancelled] });
  const luis = rows.filter((r) => r.userId === 'u_t_luis');
  ok(luis.length === 1, 'M1: one row per cleaner, however many call-outs cover the day');
  ok(luis[0]?.cleanCount === 1 && luis[0].cleans[0].jobId === 'j_t_tonight', 'M2: only THIS day\'s live cleans — not tomorrow\'s, not a cancelled one');
  ok(luis[0]?.reason === 'Sick; Still sick', 'M3: reasons are combined');
}

// HR › PTO books a call-out WITHOUT taking the person off the clean; the office then
// swaps cover in by hand. The booking recorded the clean it covered, so the report still
// names it — and the clean has someone available again. (Review finding B1: this path lost
// the clean — "0 cleans" and gone under a filter — because only Team › Time off recorded.)
{
  let s = state;
  const step = (a) => { s = reducer(s, a); };
  step({ type: ACTIONS.ADD_JOB, job: baseJob('j_t_hr', clientA.id, ['u_t_luis'], startMs + 2 * HOUR) });
  const covered = jobsCoveredByTimeOff(s.jobs, { startDate: D, endDate: D, isOnCrew: (j) => (j.crewIds || []).includes('u_t_luis') && j.id === 'j_t_hr' });
  ok(covered.length === 1 && covered[0].id === 'j_t_hr', 'P0: jobsCoveredByTimeOff finds the clean in the booked days');
  step({ type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_hr', userId: 'u_t_luis', startDate: D, endDate: D, reason: 'Flu', kind: 'callout', scheduledJobIds: covered.map((j) => j.id) } });
  step({ type: ACTIONS.UPDATE_JOB, id: 'j_t_hr', patch: { crewIds: ['u_t_maria'] } }); // cover swapped in by hand
  const ctxHr = { ...ctx(), timeOff: s.timeOff.filter((t) => t.id === 'to_hr'), jobs: s.jobs.filter((j) => j.id === 'j_t_hr') };
  const luis = calledOutOn(ctxHr).find((r) => r.userId === 'u_t_luis');
  ok(luis?.cleanCount === 1 && luis.cleans[0].jobId === 'j_t_hr', 'P1: an HR › PTO call-out still names the clean after cover is swapped in');
  ok(luis?.uncoveredCount === 0, 'P2: …and that clean is covered (Maria is on it and not off)');
  ok(calledOutOn({ ...ctxHr, clientId: clientA.id }).some((r) => r.userId === 'u_t_luis'), 'P3: …and he stays listed under the customer filter');
}

// Nobody available: the only person left on the clean is booked off too (an HR › PTO
// call-out leaves them on the crew). The crew list isn't empty, but no one is coming.
{
  const job = baseJob('j_t_alone', clientA.id, ['u_t_ana'], startMs + 3 * HOUR);
  const timeOff = [{ id: 'to_alone', userId: 'u_t_ana', startDate: D, endDate: D, reason: 'Sick', kind: 'callout', scheduledJobIds: ['j_t_alone'] }];
  const ana = calledOutOn({ ...ctx(), timeOff, jobs: [job] }).find((r) => r.userId === 'u_t_ana');
  ok(ana?.uncoveredCount === 1 && ana.cleans[0].uncovered === true, 'N1: a clean whose only crew member is off is flagged "no crew now" (review finding B2)');
  const withPlannedMate = { ...job, id: 'j_t_pair', crewIds: ['u_t_ana', 'u_t_luis'] };
  const timeOff2 = [...timeOff, { id: 'to_mate', userId: 'u_t_luis', startDate: D, endDate: D, reason: 'Vacation', kind: 'planned' }];
  const ana2 = calledOutOn({ ...ctx(), timeOff: timeOff2, jobs: [withPlannedMate] }).find((r) => r.userId === 'u_t_ana');
  ok(ana2?.cleans[0]?.uncovered === true, 'N2: …also when the other crew member is on PLANNED time off');
}

// The type a booking starts on.
{
  const T = '2026-09-22';
  ok(defaultTimeOffKind(T, T) === 'callout', 'T1: starting today → Call-out');
  ok(defaultTimeOffKind('2026-09-23', T) === 'callout', 'T2: starting tomorrow → Call-out (the evening call about tomorrow morning)');
  ok(defaultTimeOffKind('2026-09-25', T) === 'planned', 'T3: booked further ahead → Planned');
}

// Write-point sanitizing (ADD_TIME_OFF).
{
  let s = state;
  s = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_bad', userId: 'u_t_ana', startDate: D, endDate: D, kind: 'bogus', scheduledJobIds: ['j1', '', null, 5, 'j1', 'j2'] } });
  const e = s.timeOff.find((t) => t.id === 'to_bad');
  ok(e && !('kind' in e), 'W1: an unknown type is dropped (reads as a call-out)');
  ok(JSON.stringify(e.scheduledJobIds) === JSON.stringify(['j1', 'j2']), 'W2: scheduledJobIds keeps distinct string ids only');
  const again = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_bad', userId: 'u_t_ana', startDate: D, endDate: D, kind: 'planned' } });
  ok(again === s, 'W3: replaying the same booking is a no-op (idempotent by id)');
}

console.log(`\ntest-called-out: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
