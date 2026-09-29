// A "this & all future" series edit must respect booked time off wherever it RE-CREWS
// a clean (2026-09-23). Every path that MINTS an occurrence runs it through
// store/timeOffRules.applyTimeOffToOccurrence: ADD_JOB_SERIES, the TOP_UP horizon sweep,
// and the added-day mint inside UPDATE_JOB_SERIES. The re-crew of EXISTING future
// occurrences in UPDATE_JOB_SERIES did not:
//
//   if (dp && Array.isArray(dp.crewIds)) nj.crewIds = dp.crewIds;
//
// The block editor (JobDetail) sent every day's crew in its dayPlan, so any block-editor
// save put back a cleaner whom Team › Time off had taken off those cleans. The same went
// for a crew change that rides the uniform patch (NewJobModal's series edit, JobDetail's
// non-weekly fallback). The calendar's warning dot still flagged the clash, but the clean
// was assigned to someone who is off. (Since the one-off change the block editor sends
// only what changed per day, so the crew CHANGE below is what re-crews; the one-off
// rules themselves are pinned in test-series-edit-one-offs.mjs.)
//
// Drives the REAL reducer (loadStore, deletion-core.mjs) with the payloads the UI sends.
// The series starts two org-days ahead so every clean is still upcoming whatever time the
// suite runs (APPLY_TIME_OFF_EXCLUSIONS only pulls people off cleans not yet started).
//   node app/scripts/test-series-edit-time-off.mjs
import { loadStore } from './deletion-core.mjs';
import { todayKey, addDaysKey, composeIso, dayKey, dayOfWeekKey } from '../src/lib/dates.js';
import { seriesFromDate } from '../src/lib/seriesScope.js';
import { seriesBlocksOf, dayPlanFromBlocks } from '../src/lib/recurrence.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
// Imported after loadStore installs its resolve shim (selectors.js has extensionless
// imports). The reducer already loaded this module, so it is the same instance.
const { selectConflictJobIds } = await import(new URL('../src/store/selectors.js', import.meta.url).href);

const LAT = 'u_t_latisha';
const MIS = 'u_t_misty';
const KEI = 'u_t_keisha';
const CLIENT = { id: 'cl_t_series', name: 'Series Test Co' };
const SITE = { id: 'st_t_series', clientId: CLIENT.id, name: 'Series Test main' };
const D0 = addDaysKey(todayKey(), 2);          // the series' first clean (the master)
const DOW = dayOfWeekKey(D0);
const week = (n) => addDaysKey(D0, 7 * n);      // week(1) = the second clean, etc.
const SID = 'ser_t_timeoff';

function withSeries(crewIds) {
  const s = {
    ...INITIAL_STATE,
    clients: [...(INITIAL_STATE.clients || []), CLIENT],
    sites: [...(INITIAL_STATE.sites || []), SITE],
    users: [...(INITIAL_STATE.users || []),
      { id: LAT, name: 'Latisha Test', role: 'crew', status: 'active' },
      { id: MIS, name: 'Misty Test', role: 'crew', status: 'active' },
      { id: KEI, name: 'Keisha Test', role: 'crew', status: 'active' }],
    jobs: [],
    timeOff: [],
    notifications: [],
  };
  return reducer(s, {
    type: ACTIONS.ADD_JOB_SERIES, seriesId: SID,
    baseJob: {
      clientId: CLIENT.id, siteId: SITE.id, crewIds, notes: '', tagIds: [],
      startAt: composeIso(D0, '10:00'), endAt: composeIso(D0, '11:00'),
    },
    recurrence: { frequency: 'weekly', daysOfWeek: [DOW], endType: 'never' },
  });
}

const rows = (s) => s.jobs.filter((j) => j.seriesId === SID);
const onDay = (s, key) => rows(s).find((j) => dayKey(j.startAt) === key);
const masterOf = (s) => rows(s).find((j) => j.recurrence);
const has = (job, id) => !!job && (job.crewIds || []).includes(id);
const flagged = (s) => selectConflictJobIds(s, rows(s));

// Team › Time off (TimeOffCard): the entry, then — with "Also remove" left on, the
// default — the exclusion that takes the person off the cleans already scheduled.
function bookOff(s, userId, startDate, { alsoRemove = true } = {}) {
  let n = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: `to_t_${userId}_${startDate}`, userId, startDate, endDate: startDate, reason: 'Night off' } });
  if (alsoRemove) n = reducer(n, { type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId, startDate, endDate: startDate });
  return n;
}

// JobDetail.save, "this & all future" on a weekly series: the editor opens on
// seriesBlocksOf(master), deep-copied (a second copy is the baseline); the save sends
// the day set plus only what changed per day (dayPlanFromBlocks), and never crewIds in
// the uniform patch.
function blockEditorSave(s, opened, edit) {
  const copy = () => seriesBlocksOf(masterOf(s)).map((b) => ({ ...b, days: [...b.days], crewIds: [...(b.crewIds || [])] }));
  const opening = copy();
  return reducer(s, {
    type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(opened).fromDate,
    patch: {}, dayPlan: dayPlanFromBlocks(edit(copy()), opening),
  });
}

// NewJobModal's series edit (and JobDetail's non-weekly fallback): a crew change rides
// the uniform patch; a date change rides targetDayKey.
function seriesPatchSave(s, opened, patch, extra = {}) {
  return reducer(s, {
    type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(opened).fromDate,
    patch, ...extra,
  });
}

// ── A. 🔴 The reported bug: a block-editor save puts a cleaner who is off back on ──
{
  let s = withSeries([LAT, MIS]);
  s = bookOff(s, LAT, week(1));
  ok(rows(s).length > 4, `SETUP A: the series materialized (${rows(s).length} cleans)`);
  ok(!has(onDay(s, week(1)), LAT) && has(onDay(s, week(1)), MIS), 'SETUP A: the booking took Latisha off her night-off clean');

  // From the first clean, the office adds Keisha to the regular crew and moves the series
  // half an hour later. The crew CHANGE re-crews every regular clean, the night off too.
  s = blockEditorSave(s, masterOf(s), (blocks) => blocks.map((b) => ({ ...b, startTime: '10:30', endTime: '11:30', crewIds: [LAT, MIS, KEI] })));
  const off = onDay(s, week(1));
  ok(off && !has(off, LAT), '🔴 A1: the block-editor save does NOT put Latisha back on the clean she is off for');
  ok(has(off, MIS) && has(off, KEI) && off.startAt === composeIso(week(1), '10:30'), 'A2: that clean still gets the edit (Misty stays, Keisha joins, new time)');
  ok(!flagged(s).has(off?.id), '🔴 A3: the calendar has no clash to flag on it (nobody off is assigned)');
  const others = rows(s).filter((j) => dayKey(j.startAt) !== week(1));
  ok(others.length > 3 && others.every((j) => has(j, LAT) && has(j, MIS) && has(j, KEI)), 'A4: every other clean gets the whole new crew (only the night off differs)');
  const m = masterOf(s);
  ok(has(m, LAT) && (m.recurrence.dayOverrides?.[DOW]?.crewIds || []).includes(LAT), 'A5: the series template keeps Latisha (future weeks still mint her)');
  const before = new Set(rows(s).map((j) => j.id));
  s = reducer(s, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: new Date(composeIso(addDaysKey(D0, 150), '12:00')).getTime() });
  const topped = rows(s).filter((j) => !before.has(j.id));
  ok(topped.length > 0 && topped.every((j) => has(j, LAT) && has(j, MIS) && has(j, KEI)), `A6: a later top-up mints her onto the new weeks (${topped.length} minted)`);
}

// ── B. The master is the series template: its crew is never adjusted ──
// The helper refuses a recurrence-bearing row; that day relies on the warning dot. A fix
// that stripped her from the master would silently drop her from every future week.
{
  let s = withSeries([LAT, MIS]);
  s = bookOff(s, LAT, D0);
  ok(has(masterOf(s), LAT) && flagged(s).has(masterOf(s).id), 'SETUP B: the booking leaves the master alone and the dot flags it');
  // A crew change from the master itself, so the master IS re-crewed.
  s = blockEditorSave(s, masterOf(s), (blocks) => blocks.map((b) => ({ ...b, startTime: '10:30', endTime: '11:30', crewIds: [LAT, MIS, KEI] })));
  const m = masterOf(s);
  ok(m && dayKey(m.startAt) === D0 && has(m, LAT) && has(m, KEI), 'B1: the master keeps Latisha (the template is not adjusted) and takes the new crew');
  ok((m?.recurrence.dayOverrides?.[DOW]?.crewIds || []).includes(LAT), 'B2: the re-synced recurrence keeps her for the day');
  ok(flagged(s).has(m?.id), 'B3: the warning dot still flags the master\'s own day');
  ok(has(onDay(s, week(1)), LAT), 'B4: the next week (not a day off) keeps her');
}

// ── C. 🔴 A crew change on the uniform patch (NewJobModal / JobDetail fallback) ──
{
  let s = withSeries([LAT]);
  s = bookOff(s, LAT, week(1));
  ok((onDay(s, week(1))?.crewIds || []).length === 0, 'SETUP C: her night-off clean was left with nobody (Unassigned)');
  s = seriesPatchSave(s, masterOf(s), { crewIds: [LAT, MIS] });
  const off = onDay(s, week(1));
  ok(off && !has(off, LAT) && has(off, MIS), '🔴 C1: adding Misty to the series does not put Latisha back on her night off');
  ok(!flagged(s).has(off?.id), '🔴 C2: no clash left to flag on it');
  const others = rows(s).filter((j) => dayKey(j.startAt) !== week(1));
  ok(others.length > 3 && others.every((j) => has(j, LAT) && has(j, MIS)), 'C3: every other clean gets the new crew');
  ok(has(masterOf(s), LAT) && has(masterOf(s), MIS), 'C4: the master (template) gets the new crew');
}

// ── D. 🔴 Crew change + day move: judged on the day the clean now RUNS ──
// NewJobModal opened on the second clean: crew → Latisha + Misty, date → the next day,
// which is Latisha's day off. Checking the row's old day would miss it.
{
  const moved = addDaysKey(week(1), 1);
  let s = withSeries([LAT]);
  s = bookOff(s, LAT, moved);
  s = seriesPatchSave(s, onDay(s, week(1)), { crewIds: [LAT, MIS] }, { targetDayKey: moved });
  const off = onDay(s, moved);
  ok(off && !onDay(s, week(1)), 'SETUP D: the second clean moved to the next day');
  ok(off && !has(off, LAT) && has(off, MIS), '🔴 D1: the moved clean lands on her day off WITHOUT her');
  ok(has(onDay(s, addDaysKey(week(2), 1)), LAT), 'D2: the week after (moved too, not a day off) keeps her');
  ok(has(masterOf(s), LAT) && dayKey(masterOf(s).startAt) === D0, 'D3: the master, before the edit\'s start, is untouched');
}

// ── E. 🔴 No "new assignment" for cleans the person is off for ──
// Misty is on leave for the rest of the materialized series; adding her from the second
// clean on puts her on nothing, so she is not told she was assigned.
{
  let s = withSeries([LAT]);
  s = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t_misty_leave', userId: MIS, startDate: week(1), endDate: addDaysKey(D0, 200), reason: 'Leave' } });
  s = seriesPatchSave(s, onDay(s, week(1)), { crewIds: [LAT, MIS] });
  ok(rows(s).filter((j) => dayKey(j.startAt) >= week(1)).every((j) => !has(j, MIS) && has(j, LAT)), '🔴 E1: she is on none of the cleans in her leave');
  ok(!(s.notifications || []).some((n) => n.userId === MIS), '🔴 E2: no "new job assigned" notification for her');
}

// ── F. An edit that does not re-crew leaves the crew alone ──
// Booked WITHOUT "Also remove" (or through HR › PTO, which never removes), the office kept
// her on; a notes-only edit must not overrule that. The dot keeps flagging it.
{
  let s = withSeries([LAT, MIS]);
  s = bookOff(s, LAT, week(1), { alsoRemove: false });
  s = seriesPatchSave(s, masterOf(s), { notes: 'Gate code changed' });
  const kept = onDay(s, week(1));
  ok(has(kept, LAT) && kept.notes === 'Gate code changed', 'F1: a notes-only edit keeps her where the office left her');
  ok(flagged(s).has(kept?.id), 'F2: and the warning dot still flags it');
}

console.log(`series edit × time off: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
