// CS-054 — time off booked from HR › PTO takes the person off their cleans, exactly as
// Team › a member's Time off card does. ONE booking, ONE action.
//
// THE BUG (re-verified at 6e61596c). Two screens book time off and they did different things:
// Team › Time off dispatched ADD_TIME_OFF and then APPLY_TIME_OFF_EXCLUSIONS (take the person
// off the cleans already on the calendar in those days, on by default); HR › PTO dispatched
// ADD_TIME_OFF alone. So "Maria is off Thursday and Friday", entered by HR, left Maria on
// Thursday's and Friday's cleans: nobody arranged cover, and the cleans went out short.
//
// THE FIX. The booking is built in ONE place (`store/timeOffRules.timeOffBooking`) and is ONE
// action: ADD_TIME_OFF { entry, removeFromCleans } records the time off AND takes the person off
// the cleans `jobsRemovedByTimeOff` names (still ahead of now, in the days booked, not done or
// cancelled, never a series' template row) — the same rule both screens count with for their
// "Also remove …" line. APPLY_TIME_OFF_EXCLUSIONS is deleted (replace means delete).
//
//   node app/scripts/test-time-off-one-path.mjs
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';
import { todayKey, dayKey, addDaysKey, composeIso } from '../src/lib/dates.js';
import * as rules from '../src/store/timeOffRules.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
const HOUR = 3600 * 1000;
const D = addDaysKey(todayKey(), 2);          // Thursday, say: always ahead of the clock
const D2 = addDaysKey(D, 1);                  // Friday
const at = (day, hhmm) => new Date(composeIso(day, hhmm)).toISOString();
const MARIA = 'u_t_maria';
const ANA = 'u_t_ana';

const job = (id, day, hhmm, crewIds, extra = {}) => ({
  id, clientId: 'cl_t_palm', siteId: 'st_t_palm', crewIds, status: 'upcoming',
  startAt: at(day, hhmm), endAt: new Date(new Date(at(day, hhmm)).getTime() + 2 * HOUR).toISOString(), ...extra,
});
function seed() {
  let s = {
    ...INITIAL_STATE,
    clients: [...(INITIAL_STATE.clients || []), { id: 'cl_t_palm', name: 'Palmetto Test' }],
    sites: [...(INITIAL_STATE.sites || []), { id: 'st_t_palm', clientId: 'cl_t_palm', name: 'Palmetto main' }],
    users: [...(INITIAL_STATE.users || []),
      { id: MARIA, name: 'Maria Test', role: 'crew', status: 'active' },
      { id: ANA, name: 'Ana Test', role: 'crew', status: 'active' }],
    timeOff: [],
  };
  for (const j of [
    job('j_t_thu', D, '18:00', [MARIA, ANA]),                                  // in the days off: Maria comes off, Ana stays
    job('j_t_fri', D2, '09:00', [MARIA]),                                      // in the days off
    job('j_t_later', addDaysKey(D, 5), '18:00', [MARIA]),                      // after them: untouched
    job('j_t_done', D, '07:00', [MARIA], { status: 'done' }),                  // done: untouched
    job('j_t_cancel', D, '11:00', [MARIA], { status: 'cancelled' }),           // cancelled: untouched
    job('j_t_series', D, '20:00', [MARIA], { seriesId: 'ser_t', recurrence: { freq: 'weekly', interval: 1 } }), // the TEMPLATE: never
  ]) s = reducer(s, { type: ACTIONS.ADD_JOB, job: j });
  return s;
}
const crewOf = (s, id) => (s.jobs.find((j) => j.id === id)?.crewIds || []).slice().sort().join(',');
const book = typeof rules.timeOffBooking === 'function' ? rules.timeOffBooking : null;
// EXACTLY what HR › PTO builds for "Maria: vacation, Thursday and Friday" with "Also remove" on.
const hrBooking = (s, removeFromCleans = true) => (book ? book({
  jobs: s.jobs, id: 'to_t_maria', userId: MARIA, startDate: D, endDate: D2, reason: ' Vacation ', kind: 'planned',
  removeFromCleans,
}) : null);
const dispatchBooking = (s, b) => reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: b?.entry, removeFromCleans: b?.removeFromCleans });

// ── 1. Booked from HR: Maria comes off the cleans in her days off ─────────────────────────
{
  const s0 = seed();
  const b = hrBooking(s0);
  ok('1.1 the booking is built in ONE place (timeOffRules.timeOffBooking)', !!book);
  const s1 = dispatchBooking(s0, b);
  ok('1.2 HR books Maria off Thu–Fri → she is off Thursday\'s clean (Ana stays on it)', crewOf(s1, 'j_t_thu') === ANA, crewOf(s1, 'j_t_thu'));
  ok('1.3 …and off Friday\'s', crewOf(s1, 'j_t_fri') === '', crewOf(s1, 'j_t_fri'));
  ok('1.4 a clean after her days off keeps her', crewOf(s1, 'j_t_later') === MARIA);
  ok('1.5 a done and a cancelled clean are left as they are', crewOf(s1, 'j_t_done') === MARIA && crewOf(s1, 'j_t_cancel') === MARIA);
  ok('1.6 the series TEMPLATE row is never touched (it would rewrite every future visit)', crewOf(s1, 'j_t_series') === MARIA);
  const entry = (s1.timeOff || []).find((t) => t.id === 'to_t_maria');
  ok('1.7 the time off itself is recorded (trimmed reason, type)', !!entry && entry.reason === 'Vacation' && entry.kind === 'planned'
    && entry.startDate === D && entry.endDate === D2, JSON.stringify(entry));
  ok('1.8 …with the cleans it covered, for Reports › Called out', !!entry && ['j_t_thu', 'j_t_fri'].every((id) => entry.scheduledJobIds?.includes(id)),
    JSON.stringify(entry?.scheduledJobIds));
  const changed = s1.jobs.filter((j) => crewOf(s1, j.id) !== crewOf(s0, j.id)).map((j) => j.id).sort().join(',');
  ok('1.9 the count the screen shows is the cleans actually changed (one rule: jobsRemovedByTimeOff)',
    !!b && b.removed.map((j) => j.id).sort().join(',') === changed && changed === 'j_t_fri,j_t_thu', `removed=${b?.removed?.map((j) => j.id)} changed=${changed}`);
  ok('1.10 one action did it all (the separate exclusion action is gone: replace means delete)', ACTIONS.APPLY_TIME_OFF_EXCLUSIONS === undefined);
  const again = dispatchBooking(s1, b);
  ok('1.11 a replayed booking changes nothing', JSON.stringify(again.jobs) === JSON.stringify(s1.jobs) && again.timeOff.length === s1.timeOff.length);
}

// ── 2. Someone who may not edit the schedule books the record only ───────────────────────
{
  const s0 = seed();
  const b = hrBooking(s0, false);
  const s1 = dispatchBooking(s0, b);
  ok('2.1 without "remove from cleans", the time off is recorded…', (s1.timeOff || []).some((t) => t.id === 'to_t_maria'));
  ok('2.2 …and every crew is left as it was', s1.jobs.every((j) => crewOf(s1, j.id) === crewOf(s0, j.id)));
  ok('2.3 …and the booking says it removed nothing', !!b && b.removed.length === 0 && !b.removeFromCleans);
}

// ── 3. A clean already underway is never pulled out from under the cleaner ────────────────
{
  let s0 = seed();
  const startedAt = new Date(Date.now() - HOUR).toISOString();
  // the org's day an hour ago, when the clean started. todayKey() takes a timezone, not an instant: handed a
  // Date it fell back to the runner's own zone, so on CI (UTC) from 8 pm to midnight Eastern this was tomorrow.
  const day = rules.timeOffBooking ? dayKey(new Date(Date.now() - HOUR)) : todayKey();
  s0 = reducer(s0, { type: ACTIONS.ADD_JOB, job: { ...job('j_t_now', day, '00:00', [MARIA]), startAt: startedAt, endAt: new Date(Date.now() + HOUR).toISOString() } });
  const b = book ? book({ jobs: s0.jobs, id: 'to_t_now', userId: MARIA, startDate: day, endDate: day, reason: '', kind: 'callout', calloutReason: 'sick', removeFromCleans: true }) : null;
  const s1 = dispatchBooking(s0, b);
  ok('3.1 a clean that already started keeps her (she may still be on the clock there)', crewOf(s1, 'j_t_now') === MARIA, crewOf(s1, 'j_t_now'));
  const entry = (s1.timeOff || []).find((t) => t.id === 'to_t_now');
  ok('3.2 …but the call-out still records it as covered, with its reason', !!entry && entry.kind === 'callout' && entry.calloutReason === 'sick'
    && (entry.scheduledJobIds || []).includes('j_t_now'), JSON.stringify(entry));
}

// ── 4. Both screens book through the one path ───────────────────────────────────────────
{
  const pto = read('../src/pages/hr/PtoTab.jsx');
  const card = read('../src/components/TimeOffCard.jsx');
  for (const [name, src] of [['HR › PTO', pto], ['Team › Time off', card]]) {
    ok(`4.1 ${name} builds the booking with timeOffBooking`, /timeOffBooking\(/.test(src));
    ok(`4.2 ${name} dispatches ONE ADD_TIME_OFF carrying removeFromCleans`, /type: ACTIONS\.ADD_TIME_OFF,[\s\S]{0,120}removeFromCleans/.test(src));
    ok(`4.3 ${name} never dispatches a separate exclusion`, !/APPLY_TIME_OFF_EXCLUSIONS/.test(src));
    ok(`4.4 ${name} counts the "Also remove" cleans with the shared rule`, /jobsRemovedByTimeOff\(/.test(src));
  }
  // The app holds the jobs window, not the table (CS-676): the booked days' cleans load first.
  ok('4.5 HR › PTO offers the removal only once every clean on the booked days is loaded', /const daysLoaded = useJobsDays\(form\.startDate/.test(pto));
  ok('4.6 …and only to someone allowed to edit the schedule (the server would put it back)', /useCanEditJobs\(\)/.test(pto));
  const reducerSrc = read('../src/store/reducer.js');
  ok('4.7 the reducer has no exclusion case left', !/ACTIONS\.APPLY_TIME_OFF_EXCLUSIONS|APPLY_TIME_OFF_EXCLUSIONS:/.test(reducerSrc));
}

console.log(`\ntest-time-off-one-path: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
