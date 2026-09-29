// Every visit TOP_UP_RECURRING_SERIES adds is UPCOMING (2026-09-23). The sweep minted
// each new visit as `{ ...master, ...occurrence }`, and the master is the series' FIRST
// VISIT, a real clean that gets done. So once a never-ending series' first clean was
// marked done, every visit the rolling horizon added from then on was born "done": shown
// as Done on the calendar, skipped by "this & all future" edits (they only reach upcoming
// visits) and by the time-off exclusion. The other two mint paths already set
// status: 'upcoming' (ADD_JOB_SERIES copies a fresh master; the added-day mint sets it).
//
// Drives the REAL reducer (loadStore, deletion-core.mjs). The series starts two org-days
// ahead so it never depends on the wall clock.
//   node app/scripts/test-series-topup-status.mjs
import { loadStore } from './deletion-core.mjs';
import { todayKey, addDaysKey, composeIso, dayOfWeekKey } from '../src/lib/dates.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();

const LAT = 'u_t2_latisha';
const SID = 'ser_t2_status';
const D0 = addDaysKey(todayKey(), 2);
const FAR = new Date(composeIso(addDaysKey(D0, 150), '12:00')).getTime();

let s = {
  ...INITIAL_STATE,
  clients: [...(INITIAL_STATE.clients || []), { id: 'cl_t2', name: 'Status Test Co' }],
  sites: [...(INITIAL_STATE.sites || []), { id: 'st_t2', clientId: 'cl_t2', name: 'Status Test main' }],
  users: [...(INITIAL_STATE.users || []), { id: LAT, name: 'Latisha Test', role: 'crew', status: 'active' }],
  jobs: [], timeOff: [], notifications: [],
};
s = reducer(s, {
  type: ACTIONS.ADD_JOB_SERIES, seriesId: SID,
  baseJob: { clientId: 'cl_t2', siteId: 'st_t2', crewIds: [LAT], notes: '', tagIds: [], startAt: composeIso(D0, '15:30'), endAt: composeIso(D0, '17:00') },
  recurrence: { frequency: 'weekly', daysOfWeek: [dayOfWeekKey(D0)], endType: 'never' },
});
const rows = () => s.jobs.filter((j) => j.seriesId === SID);
const master = rows().find((j) => j.recurrence);
ok(rows().length > 4 && rows().every((j) => j.status === 'upcoming'), 'SETUP: a fresh series is all upcoming');

for (const status of ['in_progress', 'done', 'cancelled']) {
  s = reducer(s, { type: ACTIONS.SET_JOB_STATUS, id: master.id, status });
  const before = new Set(rows().map((j) => j.id));
  const until = FAR + (status === 'done' ? 7 : status === 'cancelled' ? 14 : 0) * 86400000;
  s = reducer(s, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: until });
  const minted = rows().filter((j) => !before.has(j.id));
  ok(minted.length > 0 && minted.every((j) => j.status === 'upcoming'),
    `🔴 first visit ${status} → the ${minted.length} visits the sweep adds are upcoming (got ${[...new Set(minted.map((j) => j.status))]})`);
}
ok(rows().find((j) => j.id === master.id)?.status === 'cancelled', 'the first visit keeps its own status');

console.log(`top-up status: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
