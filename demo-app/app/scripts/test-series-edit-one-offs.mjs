// A "this & all future" series edit keeps what was changed on a single visit (2026-09-23,
// owner default): a single-visit edit marks what it changed (`oneOff: { crew, time }`,
// reducer markOneOff), and a later series crew / time change skips marked fields, so a
// one-night cover or a one-off time survives it. The visit the edit was opened from
// (anchorId) always takes it. Both screens behave the same: JobDetail's block editor now
// sends only what changed (dayPlanFromBlocks), the Schedule popup (NewJobModal) already did.
//
// The marks are EXPLICIT because the first design inferred one-offs by comparing each
// visit with the template, and an adversarial review broke it six ways (scenarios 15-21
// pin each: series edited before this existed, a later-dated edit then an earlier one,
// a template re-homed onto a one-off row, DST, the opened visit, a replay).
//
// The series TEMPLATE must still be right for the visits TOP_UP adds later, so this also
// pins the ways it went stale:
//   A. a series crew change moved the visits but not the template, so every visit TOP_UP
//      added later came back with the old crew (now: recurrence.crewOverride);
//   B. a series time change on a series with dense day overrides moved the visits, not
//      the template (now: the day overrides take the new times);
//   C. a one-off edit of the series' FIRST visit (the master, which doubles as the
//      template) became the crew and time of every visit added later (now: the regular
//      values are pinned into the recurrence before that visit's own values change).
//
// Drives the REAL reducer (loadStore, deletion-core.mjs) with the payloads the UI sends.
// The series starts two org-days ahead so every visit is still upcoming whenever it runs.
//   node app/scripts/test-series-edit-one-offs.mjs
import { loadStore } from './deletion-core.mjs';
import { todayKey, addDaysKey, composeIso, composeEndIso, dayKey, dayOfWeekKey, splitIso } from '../src/lib/dates.js';
import { seriesFromDate } from '../src/lib/seriesScope.js';
import * as rec from '../src/lib/recurrence.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
const { seriesBlocksOf } = rec;
const dayPlanFromBlocks = rec.dayPlanFromBlocks; // new with this change; undefined before it

const LAT = 'u_t1_latisha';
const MIS = 'u_t1_misty';
const KEI = 'u_t1_keisha';
const SID = 'ser_t1_oneoffs';
const CLIENT = { id: 'cl_t1', name: 'One-off Test Co' };
const SITE = { id: 'st_t1', clientId: CLIENT.id, name: 'One-off Test main' };
const D0 = addDaysKey(todayKey(), 2);
const DOW = dayOfWeekKey(D0);
const week = (n) => addDaysKey(D0, 7 * n);
const FAR = new Date(composeIso(addDaysKey(D0, 150), '12:00')).getTime();

const blank = () => ({
  ...INITIAL_STATE,
  clients: [...(INITIAL_STATE.clients || []), CLIENT],
  sites: [...(INITIAL_STATE.sites || []), SITE],
  users: [...(INITIAL_STATE.users || []),
    ...[[LAT, 'Latisha Test'], [MIS, 'Misty Test'], [KEI, 'Keisha Test']].map(([id, name]) => ({ id, name, role: 'crew', status: 'active' }))],
  jobs: [], timeOff: [], notifications: [],
});
function addSeries(s, { crewIds = [LAT], day = D0, start = '15:30', end = '17:00', recurrence } = {}) {
  return reducer(s, {
    type: ACTIONS.ADD_JOB_SERIES, seriesId: SID,
    baseJob: { clientId: CLIENT.id, siteId: SITE.id, crewIds, notes: '', tagIds: [], startAt: composeIso(day, start), endAt: composeEndIso(day, start, end) },
    recurrence: recurrence || { frequency: 'weekly', daysOfWeek: [DOW], endType: 'never' },
  });
}
const withSeries = (crewIds = [LAT]) => addSeries(blank(), { crewIds });
// Null-safe: a block save that cannot be expressed (pre-change) yields null, and every
// assertion on it must then FAIL, never pass on an empty list.
const rows = (s) => (s ? s.jobs.filter((j) => j.seriesId === SID).sort((a, b) => a.startAt.localeCompare(b.startAt)) : []);
const onDay = (s, key) => rows(s).find((j) => dayKey(j.startAt) === key);
const masterOf = (s) => rows(s).find((j) => j.recurrence);
const crewOf = (j) => [...(j?.crewIds || [])].sort().join('+');
const timeOf = (j) => (j ? `${splitIso(j.startAt).time}-${splitIso(j.endAt).time}` : '?');
const later = (s, key) => rows(s).filter((j) => dayKey(j.startAt) > key);
const allLater = (s, key, pred) => !!s && later(s, key).length > 0 && later(s, key).every(pred);
function topUp(s) {
  const before = new Set(rows(s).map((j) => j.id));
  const n = reducer(s, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: FAR });
  return [n, rows(n).filter((j) => !before.has(j.id))];
}

// "Just this one" (JobDetail single scope / the popup's single edit): UPDATE_JOB.
const oneOff = (s, key, patch) => reducer(s, { type: ACTIONS.UPDATE_JOB, id: onDay(s, key).id, patch });
const oneOffCover = (s, key, crewIds) => oneOff(s, key, { crewIds });
const oneOffTime = (s, key, from, to) => oneOff(s, key, { startAt: composeIso(key, from), endAt: composeIso(key, to) });
// Schedule popup (NewJobModal) "this & all future": diffed fields + timePatch.
const popup = (s, opened, patch, extra = {}) => reducer(s, {
  type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(opened).fromDate, patch, anchorId: opened.id, ...extra,
});
// JobDetail block editor "this & all future". The editor opens on seriesBlocksOf(master).
const openBlocks = (s) => seriesBlocksOf(masterOf(s)).map((b) => ({ ...b, days: [...b.days], crewIds: [...(b.crewIds || [])] }));
// The payload JobDetail sends NOW: only what changed per day (dayPlanFromBlocks).
function blockSave(s, opened, edit, patch = {}) {
  const opening = openBlocks(s);
  const edited = edit(opening.map((b) => ({ ...b, days: [...b.days], crewIds: [...b.crewIds] })));
  if (typeof dayPlanFromBlocks !== 'function') return null; // pre-change: the save cannot be expressed
  const dayPlan = dayPlanFromBlocks(edited, opening);
  return reducer(s, { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(opened).fromDate, patch, dayPlan, anchorId: opened.id });
}
// The payload JobDetail USED to send (every day's crew + times). A replayed action from
// before the change still looks like this, and the reducer must keep one-offs anyway.
function blockSaveFull(s, opened, edit, patch = {}) {
  const blocks = edit(openBlocks(s));
  const overrides = {};
  const days = [];
  for (const b of blocks) for (const dow of b.days) { days.push(dow); overrides[dow] = { startTime: b.startTime, endTime: b.endTime, crewIds: b.crewIds || [] }; }
  return reducer(s, { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(opened).fromDate, patch, dayPlan: { days, overrides } });
}
const retime = (from, to) => (blocks) => blocks.map((b) => ({ ...b, startTime: from, endTime: to }));
const recrew = (crewIds) => (blocks) => blocks.map((b) => ({ ...b, crewIds }));
const same = (blocks) => blocks;

// ── 1. 🔴 A one-night cover survives a time-only series edit, on both screens ──
{
  const base = oneOffCover(withSeries(), week(1), [MIS]);
  const viaPopup = popup(base, masterOf(base), {}, { timePatch: { startTime: '16:00', endTime: '17:30' } });
  ok(crewOf(onDay(viaPopup, week(1))) === MIS && timeOf(onDay(viaPopup, week(1))) === '16:00-17:30', `1a: popup time edit: the cover keeps Misty and moves with the series (${crewOf(onDay(viaPopup, week(1)))} ${timeOf(onDay(viaPopup, week(1)))})`);
  const viaBlocks = blockSave(base, masterOf(base), retime('16:00', '17:30'));
  ok(crewOf(onDay(viaBlocks, week(1))) === MIS && timeOf(onDay(viaBlocks, week(1))) === '16:00-17:30', `🔴 1b: block-editor time edit: the cover keeps Misty (${crewOf(onDay(viaBlocks, week(1)))})`);
  ok(allLater(viaBlocks, week(1), (j) => crewOf(j) === LAT && timeOf(j) === '16:00-17:30'), '1c: the regular visits keep Latisha and move');
  const replayed = blockSaveFull(base, masterOf(base), retime('16:00', '17:30'));
  ok(crewOf(onDay(replayed, week(1))) === MIS, `🔴 1d: even the old full-shape payload keeps the cover (${crewOf(onDay(replayed, week(1)))})`);
}

// ── 2. 🔴 Changing the regular crew leaves the cover alone ──
{
  const base = oneOffCover(withSeries(), week(1), [MIS]);
  const viaPopup = popup(base, masterOf(base), { crewIds: [KEI] });
  ok(crewOf(onDay(viaPopup, week(1))) === MIS, `🔴 2a: popup crew change Latisha → Keisha: the cover keeps Misty (${crewOf(onDay(viaPopup, week(1)))})`);
  ok(allLater(viaPopup, week(1), (j) => crewOf(j) === KEI) && crewOf(masterOf(viaPopup)) === KEI, '2b: every regular visit gets Keisha');
  const viaBlocks = blockSave(base, masterOf(base), recrew([KEI]));
  ok(crewOf(onDay(viaBlocks, week(1))) === MIS && allLater(viaBlocks, week(1), (j) => crewOf(j) === KEI), `🔴 2c: block-editor crew change: same result (${crewOf(onDay(viaBlocks, week(1)))})`);
  const kn = (viaPopup.notifications || []).filter((n) => n.userId === KEI);
  const named = kn.map((n) => viaPopup.jobs.find((j) => `/schedule/${j.id}` === n.url));
  ok(kn.length === 1 && named.every((j) => j && j.crewIds.includes(KEI)), '2d: Keisha is told once, about a clean she is actually on');
  // Opened from the cover visit itself: the old "first eligible row" representative
  // would name the one clean Keisha is NOT on.
  const fromCover = popup(base, onDay(base, week(1)), { crewIds: [KEI] });
  const kn2 = (fromCover.notifications || []).filter((n) => n.userId === KEI).map((n) => fromCover.jobs.find((j) => `/schedule/${j.id}` === n.url));
  ok(kn2.length === 1 && kn2[0]?.crewIds.includes(KEI), '2e: ...even when the edit is opened from the cover visit');
}

// ── 3. 🔴 A one-off time survives ──
{
  const base = oneOffTime(withSeries(), week(1), '18:00', '19:30');
  const notesOnly = blockSave(base, masterOf(base), same, { notes: 'Gate code 1234' });
  ok(timeOf(onDay(notesOnly, week(1))) === '18:00-19:30' && onDay(notesOnly, week(1)).notes === 'Gate code 1234', `🔴 3a: a notes-only block save leaves the 6 PM visit at 6 PM (${timeOf(onDay(notesOnly, week(1)))})`);
  const viaPopup = popup(base, masterOf(base), {}, { timePatch: { startTime: '16:00', endTime: '17:30' } });
  ok(timeOf(onDay(viaPopup, week(1))) === '18:00-19:30', `🔴 3b: a series time change leaves the one-off time alone (${timeOf(onDay(viaPopup, week(1)))})`);
  ok(allLater(viaPopup, week(1), (j) => timeOf(j) === '16:00-17:30'), '3c: the regular visits move to 4:00');
  const crewChange = popup(base, masterOf(base), { crewIds: [KEI] });
  ok(crewOf(onDay(crewChange, week(1))) === KEI && timeOf(onDay(crewChange, week(1))) === '18:00-19:30', '3d: a crew change still reaches the one-off-time visit (crew and time are judged apart)');
}

// ── 4. 🔴 Someone kept on for their day off stays on through a notes-only save ──
// Booked without "Also remove" (or in HR › PTO, which never removes): the office chose to
// keep her on. Only a re-crew re-applies time off, and a notes-only save re-crews nothing.
{
  let s = withSeries([LAT, MIS]);
  s = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t1_keep', userId: LAT, startDate: week(1), endDate: week(1), reason: 'PTO' } });
  s = blockSave(s, masterOf(s), same, { notes: 'Gate code 1234' });
  ok(crewOf(onDay(s, week(1))) === [LAT, MIS].sort().join('+'), `🔴 4: Latisha is still on it (${crewOf(onDay(s, week(1)))})`);
}

// ── 5. 🔴 Gap A: a series crew change moves the template ──
{
  let s = withSeries();
  s = popup(s, onDay(s, week(1)), { crewIds: [KEI] }); // from the SECOND visit: the master is history
  let minted;
  [s, minted] = topUp(s);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === KEI), `🔴 5a: visits added later get Keisha, not the old crew (${[...new Set(minted.map(crewOf))]})`);
  s = popup(s, onDay(s, week(2)), { crewIds: [MIS] });
  ok(allLater(s, week(1), (j) => crewOf(j) === MIS), '🔴 5b: a second crew change reaches every visit the first one changed (none read as one-offs)');
  ok(crewOf(onDay(s, week(1))) === KEI, '5c: ...and not the visit before where it started');
}

// ── 6. 🔴 Gap B: a series time change moves a dense template too ──
{
  const s0 = withSeries();
  let s = blockSaveFull(s0, masterOf(s0), same); // any block save makes the day overrides dense
  s = popup(s, masterOf(s), {}, { timePatch: { startTime: '16:00', endTime: '17:30' } });
  let minted;
  [s, minted] = topUp(s);
  ok(minted.length > 0 && minted.every((j) => timeOf(j) === '16:00-17:30'), `🔴 6a: visits added later run at 4:00 (${[...new Set(minted.map(timeOf))]})`);
  ok(seriesBlocksOf(masterOf(s))?.[0]?.startTime === '16:00', '🔴 6b: the block editor opens on 4:00');
}

// ── 7. 🔴 Gap C: a one-off on the FIRST visit does not become the series ──
{
  let s = withSeries();
  s = oneOff(s, D0, { crewIds: [MIS], startAt: composeIso(D0, '18:00'), endAt: composeIso(D0, '19:30') });
  ok(crewOf(masterOf(s)) === MIS && timeOf(masterOf(s)) === '18:00-19:30', 'SETUP 7: the first visit itself took the cover and the 6 PM time');
  let minted;
  [s, minted] = topUp(s);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === LAT && timeOf(j) === '15:30-17:00'), `🔴 7a: visits added later keep Latisha at 3:30 (${[...new Set(minted.map((j) => `${crewOf(j)} ${timeOf(j)}`))]})`);
  s = popup(s, onDay(s, week(1)), { crewIds: [KEI] });
  ok(allLater(s, D0, (j) => crewOf(j) === KEI), '🔴 7b: a later crew change still reaches every regular visit');
  ok(crewOf(masterOf(s)) === MIS, '7c: the first visit keeps its own cover');
}

// ── 8. A re-crew still respects booked time off (the S75 rule, one-offs or not) ──
{
  let s = withSeries([LAT, MIS]);
  s = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t1_off', userId: LAT, startDate: week(1), endDate: week(1), reason: 'Night off' } });
  s = reducer(s, { type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: LAT, startDate: week(1), endDate: week(1) });
  s = blockSave(s, masterOf(s), recrew([LAT, MIS, KEI]));
  ok(crewOf(onDay(s, week(1))) === [KEI, MIS].sort().join('+'), `8a: Keisha joins the night off, Latisha is not put back (${crewOf(onDay(s, week(1)))})`);
  ok(allLater(s, week(1), (j) => crewOf(j) === [KEI, LAT, MIS].sort().join('+')), '8b: every other visit gets the new crew');
}

// ── 9. "Rescheduled" goes only to crew whose visit actually moved ──
{
  let s = withSeries();
  s = oneOff(s, week(1), { crewIds: [MIS], startAt: composeIso(week(1), '18:00'), endAt: composeIso(week(1), '19:30') });
  const seen = new Set((s.notifications || []).map((n) => n.id));
  s = popup(s, masterOf(s), {}, { timePatch: { startTime: '16:00', endTime: '17:30' } });
  const fresh = (s.notifications || []).filter((n) => !seen.has(n.id));
  const toMisty = fresh.filter((n) => n.userId === MIS);
  ok(timeOf(onDay(s, week(1))) === '18:00-19:30' && toMisty.length === 0, `🔴 9a: Misty's own visit did not move, so she hears nothing (${toMisty.map((n) => n.title)})`);
  ok(fresh.some((n) => n.userId === LAT && /resched/i.test(n.title)), '9b: Latisha, whose visits moved, is told they were rescheduled');
}

// ── 10. Deleting a cleaner scrubs them from the template's crew ──
{
  let s = withSeries([LAT]);
  s = popup(s, onDay(s, week(1)), { crewIds: [KEI, MIS] }); // the template now names Keisha
  s = reducer(s, { type: ACTIONS.DELETE_USER, id: KEI });
  const co = masterOf(s)?.recurrence?.crewOverride;
  ok(Array.isArray(co) ? !co.includes(KEI) : true, '10a: the deleted cleaner is gone from the template crew');
  let minted;
  [s, minted] = topUp(s);
  ok(minted.every((j) => !j.crewIds.includes(KEI)), '10b: visits added later never name them');
}

// ── 11. Replaying the same edit changes nothing (adoptRemote re-runs recorded actions) ──
{
  const base = oneOffCover(oneOffTime(withSeries(), week(2), '18:00', '19:30'), week(1), [MIS]);
  const opened = masterOf(base);
  const action = { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(opened).fromDate, patch: { crewIds: [KEI] }, timePatch: { startTime: '16:00', endTime: '17:30' } };
  const once = reducer(base, action);
  const twice = reducer(once, action);
  ok(JSON.stringify(rows(once)) === JSON.stringify(rows(twice)), '11: a replay leaves every visit and the template exactly as the first run did');
}

// ── 12. A day move still moves every future visit, each keeping its own crew and time ──
{
  const base = oneOffTime(oneOffCover(withSeries(), week(1), [MIS]), week(2), '18:00', '19:30');
  const moved = popup(base, masterOf(base), {}, { targetDayKey: addDaysKey(D0, 1) });
  const v1 = onDay(moved, addDaysKey(week(1), 1));
  const v2 = onDay(moved, addDaysKey(week(2), 1));
  ok(v1 && crewOf(v1) === MIS && v2 && timeOf(v2) === '18:00-19:30', '12: the cover and the one-off time move to the new day with their own values');
}

// ── 14. A departed cleaner lingering in an old template doesn't make every visit a one-off ──
// DELETE_USER scrubs only the loaded rows, so an out-of-window master can keep a removed
// cleaner's id while the visits no longer name them.
{
  let s = withSeries([LAT, KEI]);
  s = { ...s, users: s.users.filter((u) => u.id !== KEI), jobs: s.jobs.map((j) => (j.seriesId === SID && !j.recurrence ? { ...j, crewIds: j.crewIds.filter((id) => id !== KEI) } : j)) };
  s = popup(s, onDay(s, week(1)), { crewIds: [MIS] });
  ok(allLater(s, D0, (j) => crewOf(j) === MIS), '14: visits that only lost the departed cleaner still count as regular and take the change');
}

// ════ The adversarial review's findings, one scenario each ════════════════════════
const firstOnOrAfter = (key, dow) => addDaysKey(key, (dow - dayOfWeekKey(key) + 7) % 7);

// ── 15. Series edited BEFORE marks existed read as regular (review #1) ──
// What the live build leaves after a popup crew change from week 1: visits on Keisha,
// the template still Latisha, no crewOverride, no marks.
{
  const legacy = () => {
    const s = withSeries();
    return { ...s, jobs: s.jobs.map((j) => (j.seriesId === SID && !j.recurrence && dayKey(j.startAt) >= week(1) ? { ...j, crewIds: [KEI] } : j)) };
  };
  const s = popup(legacy(), onDay(legacy(), week(2)), { crewIds: [MIS] });
  ok(allLater(s, week(1), (j) => crewOf(j) === MIS) && crewOf(onDay(s, week(1))) === KEI, '15a: a popup crew change reaches every visit the old build moved');
  const b0 = legacy();
  const b = blockSave(b0, onDay(b0, week(1)), recrew([MIS]));
  ok(allLater(b, D0, (j) => crewOf(j) === MIS), '15b: ...and so does the block editor opened on the stale template');
}

// ── 16. A later-dated edit, then an earlier one (review #2) ──
{
  let s = withSeries();
  s = popup(s, onDay(s, week(3)), { crewIds: [KEI] });
  s = popup(s, onDay(s, week(1)), { crewIds: [MIS] });
  ok(allLater(s, D0, (j) => crewOf(j) === MIS), '16a: weeks 1-2 take the earlier edit too, the opened visit included');
  let t = withSeries();
  t = popup(t, onDay(t, week(3)), {}, { timePatch: { startTime: '16:00', endTime: '17:30' } });
  t = popup(t, onDay(t, week(1)), {}, { timePatch: { startTime: '17:00', endTime: '18:30' } });
  ok(allLater(t, D0, (j) => timeOf(j) === '17:00-18:30'), '16b: same for time');
}

// ── 17. 🔴 The template re-homed onto a one-off row stays regular (review #3) ──
{
  // a. The first visit deleted; the heir (week 1) had Latisha taken off for time off.
  let s = withSeries([LAT, MIS]);
  s = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t1_r3', userId: LAT, startDate: week(1), endDate: week(1), reason: 'off' } });
  s = reducer(s, { type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: LAT, startDate: week(1), endDate: week(1) });
  s = reducer(s, { type: ACTIONS.DELETE_JOB, id: masterOf(s).id });
  ok(dayKey(masterOf(s)?.startAt || '') === week(1) && crewOf(masterOf(s)) === MIS, 'SETUP 17a: the recurrence re-homed onto week 1 (Latisha off it)');
  let minted;
  [s, minted] = topUp(s);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === [LAT, MIS].sort().join('+')), `🔴 17a: visits added later keep both regular cleaners (${[...new Set(minted.map(crewOf))]})`);

  // b. NewJobModal's two-block shape: the master's block (Mon 08:00 Latisha) carries no
  // override; Friday (18:00 Misty) does. Deleting the first Monday re-homes onto a Friday.
  const MON = firstOnOrAfter(D0, 1);
  let b = addSeries(blank(), { crewIds: [LAT], day: MON, start: '08:00', end: '09:00', recurrence: {
    frequency: 'weekly', daysOfWeek: [1, 5], endType: 'never', dayOverrides: { 5: { startTime: '18:00', endTime: '19:00', crewIds: [MIS] } } } });
  b = reducer(b, { type: ACTIONS.DELETE_JOB, id: masterOf(b).id });
  const blocks = seriesBlocksOf(masterOf(b)) || [];
  ok(blocks.some((x) => x.days.join() === '1' && x.startTime === '08:00' && crewOf(x) === LAT)
    && blocks.some((x) => x.days.join() === '5' && x.startTime === '18:00' && crewOf(x) === MIS), '🔴 17b: the block editor still shows Mon 08:00 Latisha and Fri 18:00 Misty');
  [b, minted] = topUp(b);
  const mondays = minted.filter((j) => dayOfWeekKey(dayKey(j.startAt)) === 1);
  ok(mondays.length > 0 && mondays.every((j) => timeOf(j) === '08:00-09:00' && crewOf(j) === LAT), '🔴 17c: Mondays added later stay 08:00 with Latisha');

  // c. A biweekly series moved a day from its second visit, which had a cover + 18:00.
  const V2 = addDaysKey(D0, 14);
  let c = addSeries(blank(), { recurrence: { frequency: 'biweekly', endType: 'never' } });
  c = oneOff(c, V2, { crewIds: [MIS], startAt: composeIso(V2, '18:00'), endAt: composeIso(V2, '19:30') });
  c = popup(c, onDay(c, V2), {}, { targetDayKey: addDaysKey(V2, 1) });
  ok(dayKey(masterOf(c)?.startAt || '') === addDaysKey(V2, 1), 'SETUP 17d: the recurrence re-homed onto the moved one-off visit');
  [c, minted] = topUp(c);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === LAT && timeOf(j) === '15:30-17:00'), `🔴 17d: visits added later are Latisha at 15:30 (${[...new Set(minted.map((j) => `${crewOf(j)} ${timeOf(j)}`))]})`);
}

// ── 18. DST: a regular clean across the clock change is still regular (review #4) ──
// Fixed far-future dates; UPDATE_JOB_SERIES never reads the clock. Saturday 22:00-02:00
// across the 2030-11-03 fall-back.
{
  let s = addSeries(blank(), { day: '2030-10-19', start: '22:00', end: '02:00', recurrence: { frequency: 'weekly', daysOfWeek: [6], endType: 'count', endCount: 5 } });
  s = reducer(s, { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: masterOf(s).startAt, anchorId: masterOf(s).id, patch: {}, timePatch: { startTime: '21:00', endTime: '01:00' } });
  ok(rows(s).length === 6 && rows(s).every((j) => splitIso(j.startAt).time === '21:00'), `18: every visit moves to 21:00, the one across the clock change too (${rows(s).map((j) => splitIso(j.startAt).time)})`);
}

// ── 19. 🔴 The visit the edit was opened from takes it, one-off or not (review #5) ──
{
  const base = oneOffCover(withSeries(), week(1), [MIS]);
  const s = popup(base, onDay(base, week(1)), { crewIds: [KEI] });
  ok(crewOf(onDay(s, week(1))) === KEI && !onDay(s, week(1)).oneOff, '🔴 19a: opened on the cover visit: it takes Keisha and loses its mark');
  ok(allLater(s, week(1), (j) => crewOf(j) === KEI), '19b: ...and so does every later visit');
  const t0 = oneOffTime(withSeries(), week(1), '18:00', '19:30');
  const t = popup(t0, onDay(t0, week(1)), {}, { timePatch: { startTime: '15:30', endTime: '17:00' } });
  ok(timeOf(onDay(t, week(1))) === '15:30-17:00', '🔴 19c: a one-off time, opened and set for all future, takes the new time');
  const legacyAction = reducer(base, { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: onDay(base, week(1)).startAt, patch: { crewIds: [KEI] } });
  ok(crewOf(onDay(legacyAction, week(1))) === KEI, '19d: an older recorded action with no anchorId anchors on the visit at fromDate');
}

// ── 20. A replay changes nothing (review #6: cover + time off kept on + crew change) ──
{
  let s = oneOffCover(withSeries(), week(1), [MIS]);
  s = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t1_r6', userId: MIS, startDate: week(1), endDate: week(1), reason: 'PTO' } });
  const action = { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: masterOf(s).startAt, anchorId: masterOf(s).id, patch: { crewIds: [MIS] } };
  const once = reducer(s, action);
  const twice = reducer(once, action);
  ok(JSON.stringify(rows(once)) === JSON.stringify(rows(twice)) && crewOf(onDay(twice, week(1))) === MIS, '20: applied twice equals applied once');
}

// ── 21. 🔴 A visit moved on its own to another weekday is never deleted (review #7) ──
{
  const moved = addDaysKey(week(1), 1);
  let s = withSeries();
  s = oneOff(s, week(1), { startAt: composeIso(moved, '15:30'), endAt: composeIso(moved, '17:00') }); // Schedule "just this one" drag
  const full = blockSaveFull(s, masterOf(s), same, { notes: 'Gate code 1234' });
  ok(!!onDay(full, moved), '🔴 21a: a notes-only block save (old payload) keeps it');
  const sparse = blockSave(s, masterOf(s), same, { notes: 'Gate code 1234' });
  ok(!!onDay(sparse, moved), '21b: ...and so does the current one');
  // A day the plan really removes still loses its visits.
  const DOW2 = (DOW + 2) % 7;
  let t = addSeries(blank(), { recurrence: { frequency: 'weekly', daysOfWeek: [DOW, DOW2].sort((a, z) => a - z), endType: 'never' } });
  t = blockSave(t, masterOf(t), (bl) => bl.map((x) => ({ ...x, days: x.days.filter((d) => d === DOW) })));
  ok(!!t && rows(t).length > 0 && rows(t).every((j) => dayOfWeekKey(dayKey(j.startAt)) === DOW), '21c: removing a weekday still removes its visits');
}

// ── 22. 🔴 A cover who becomes the regular crew is told (review #8) ──
{
  let s = oneOffCover(withSeries(), week(1), [MIS]);
  const seen = new Set((s.notifications || []).map((n) => n.id));
  s = popup(s, masterOf(s), { crewIds: [MIS] });
  const told = (s.notifications || []).filter((n) => !seen.has(n.id) && n.userId === MIS);
  const named = told.map((n) => s.jobs.find((j) => `/schedule/${j.id}` === n.url));
  ok(told.length === 1 && /assigned/i.test(told[0].title) && named[0] && dayKey(named[0].startAt) !== week(1),
    `🔴 22: told once, about a visit she was just put on (${told.map((n) => n.title)})`);
}

// ── 23. Setting a one-off back to the regular crew clears the mark ──
{
  let s = oneOffCover(withSeries(), week(1), [MIS]);
  ok(onDay(s, week(1)).oneOff?.crew === true, 'SETUP 23: a cover marks the visit');
  s = oneOffCover(s, week(1), [LAT]);
  ok(!onDay(s, week(1)).oneOff, '23a: back to the regular cleaner clears the mark');
  s = popup(s, masterOf(s), { crewIds: [KEI] });
  ok(crewOf(onDay(s, week(1))) === KEI, '23b: so a later series crew change reaches it');
}

// ── 24. Mints never copy the first visit's mark ──
{
  let s = withSeries();
  s = oneOff(s, D0, { crewIds: [MIS] });
  ok(masterOf(s).oneOff?.crew === true, 'SETUP 24: the first visit carries the mark');
  let minted;
  [s, minted] = topUp(s);
  ok(minted.length > 0 && minted.every((j) => !j.oneOff && crewOf(j) === LAT), '24a: visits the sweep adds carry no mark and the regular crew');
  const NEXT = (DOW + 1) % 7;
  const added = blockSave(s, masterOf(s), (bl) => bl.map((x) => ({ ...x, days: [...x.days, NEXT] })));
  const newDay = rows(added).filter((j) => dayOfWeekKey(dayKey(j.startAt)) === NEXT);
  ok(newDay.length > 0 && newDay.every((j) => !j.oneOff && crewOf(j) === LAT), '24b: nor do visits on a newly added day');
}

// ════ The SECOND adversarial review's findings (the marks redesign) ════════════════
// A series as it exists on the live site today: created before the template was written
// down, so its template is the first visit's own crew and times.
const legacySeries = (crewIds = [LAT]) => {
  const s = withSeries(crewIds);
  return { ...s, jobs: s.jobs.map((j) => {
    if (!j.recurrence) return j;
    const { crewOverride, timeOverride, ...rec } = j.recurrence;
    return { ...j, recurrence: rec };
  }) };
};
// What the LIVE build's one-off edit of the first visit left behind: its own crew and
// times changed, nothing pinned, no marks (built directly, not through today's reducer).
const liveBuildLeak = (s) => ({ ...s, jobs: s.jobs.map((j) => (j.seriesId === SID && j.recurrence
  ? { ...j, crewIds: [MIS], startAt: composeIso(D0, '18:00'), endAt: composeIso(D0, '19:30') } : j)) });
const topUpTo = (s, days) => {
  const before = new Set(rows(s).map((j) => j.id));
  const n = reducer(s, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: new Date(composeIso(addDaysKey(D0, days), '12:00')).getTime() });
  return [n, rows(n).filter((j) => !before.has(j.id))];
};

// ── 25. 🔴 Repairing an older series' first visit fixes its template (review 2 #1) ──
// On the live build a cover + 6 PM on the first visit leaked into every visit the sweep
// added. The office then puts the first visit back: that must fix the template, not
// freeze the leak (pinning at a single edit did).
{
  let s = liveBuildLeak(legacySeries());
  let minted;
  [s, minted] = topUpTo(s, 150);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === MIS), 'SETUP 25: the leak the live build left keeps minting Misty');
  s = oneOff(s, D0, { crewIds: [LAT], startAt: composeIso(D0, '15:30'), endAt: composeIso(D0, '17:00') });
  [s, minted] = topUpTo(s, 210);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === LAT && timeOf(j) === '15:30-17:00'), `🔴 25a: after the repair, visits added later are Latisha at 15:30 (${[...new Set(minted.map((j) => `${crewOf(j)} ${timeOf(j)}`))]})`);
  ok(seriesBlocksOf(masterOf(s))?.[0]?.startTime === '15:30' && crewOf(seriesBlocksOf(masterOf(s))[0]) === LAT, '🔴 25b: the block editor opens on Latisha 15:30');
}

// ── 26. 🔴 Deleting an older series' first visit hands the template to the next visit ──
{
  // a. The leaked first visit deleted: the template becomes the next (regular) visit's.
  let s = liveBuildLeak(legacySeries());
  s = reducer(s, { type: ACTIONS.DELETE_JOB, id: masterOf(s).id });
  let minted;
  [s, minted] = topUp(s);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === LAT && timeOf(j) === '15:30-17:00'), `🔴 26a: visits added later are Latisha 15:30, not the deleted visit's leak (${[...new Set(minted.map((j) => `${crewOf(j)} ${timeOf(j)}`))]})`);
  // b. The live build's popup crew change left the template on Latisha while every later
  // visit is Keisha: deleting the first visit hands the series to Keisha, as before.
  let b = legacySeries();
  b = { ...b, jobs: b.jobs.map((j) => (j.seriesId === SID && !j.recurrence ? { ...j, crewIds: [KEI] } : j)) };
  b = reducer(b, { type: ACTIONS.DELETE_JOB, id: masterOf(b).id });
  [b, minted] = topUp(b);
  ok(minted.length > 0 && minted.every((j) => crewOf(j) === KEI), `🔴 26b: visits added later keep Keisha, not the stale template (${[...new Set(minted.map(crewOf))]})`);
}

// ── 27. 🔴 A mark goes when the system returns the visit to its regular crew (review 2 #2) ──
{
  const added = () => oneOffCover(withSeries(), week(1), [LAT, MIS]); // Misty ADDED to Latisha's visit
  let s = added();
  ok(onDay(s, week(1)).oneOff?.crew === true, 'SETUP 27: the added helper marks the visit');
  s = reducer(s, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t1_r27', userId: MIS, startDate: week(1), endDate: week(1), reason: 'off' } });
  s = reducer(s, { type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: MIS, startDate: week(1), endDate: week(1) });
  ok(crewOf(onDay(s, week(1))) === LAT && !onDay(s, week(1)).oneOff, '🔴 27a: she books that night off ("Also remove") → back to Latisha, mark gone');
  s = popup(s, masterOf(s), { crewIds: [KEI] });
  ok(crewOf(onDay(s, week(1))) === KEI, '🔴 27b: a later series crew change reaches it');
  let d = reducer(added(), { type: ACTIONS.DELETE_USER, id: MIS });
  ok(crewOf(onDay(d, week(1))) === LAT && !onDay(d, week(1)).oneOff, '🔴 27c: the helper is deleted → back to Latisha, mark gone');
  d = popup(d, masterOf(d), { crewIds: [KEI] });
  ok(crewOf(onDay(d, week(1))) === KEI, '27d: ...and the series change reaches it');
  // A cover who REPLACED the regular leaves: nobody is on it, so it isn't a one-off
  // anymore and the next series crew change fills it (it used to stay unassigned).
  const replaced = () => oneOffCover(withSeries(), week(1), [MIS]);
  let e = reducer(replaced(), { type: ACTIONS.DELETE_USER, id: MIS });
  ok((onDay(e, week(1)).crewIds || []).length === 0 && !onDay(e, week(1)).oneOff, '🔴 27e: the cover is deleted → nobody on it, mark gone');
  e = popup(e, masterOf(e), { crewIds: [KEI] });
  ok(crewOf(onDay(e, week(1))) === KEI, '🔴 27f: the series change fills it');
  let f = replaced();
  f = reducer(f, { type: ACTIONS.ADD_TIME_OFF, entry: { id: 'to_t1_r27f', userId: MIS, startDate: week(1), endDate: week(1), reason: 'off' } });
  f = reducer(f, { type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: MIS, startDate: week(1), endDate: week(1) });
  f = popup(f, masterOf(f), { crewIds: [KEI] });
  ok(crewOf(onDay(f, week(1))) === KEI, '🔴 27g: same when the cover books that night off');
}

// ── 28. 🔴 A mark goes when the series catches up with it (review 2 #3) ──
{
  let s = oneOffCover(withSeries(), week(1), [MIS]);
  s = popup(s, masterOf(s), { crewIds: [MIS] }); // Misty becomes the regular crew
  ok(!onDay(s, week(1)).oneOff, '🔴 28a: once the regular crew is the cover, the visit is no longer a one-off');
  s = popup(s, masterOf(s), { crewIds: [KEI] });
  ok(crewOf(onDay(s, week(1))) === KEI, '🔴 28b: so the next crew change reaches it');
  let t = oneOffTime(withSeries(), week(1), '18:00', '19:30');
  t = popup(t, masterOf(t), {}, { timePatch: { startTime: '18:00', endTime: '19:30' } });
  t = popup(t, masterOf(t), {}, { timePatch: { startTime: '19:00', endTime: '20:30' } });
  ok(timeOf(onDay(t, week(1))) === '19:00-20:30', '🔴 28c: same for time (series moved to 6 PM, then 7 PM)');
}

// ── 29. A day another user removed, re-added by a stale editor, gets what it showed (review 2 #5) ──
{
  const DOW2 = (DOW + 2) % 7;
  let s = addSeries(blank(), { recurrence: { frequency: 'weekly', daysOfWeek: [DOW, DOW2].sort((a, z) => a - z), endType: 'never',
    dayOverrides: { [DOW2]: { startTime: '18:00', endTime: '19:30', crewIds: [MIS] } } } });
  const openedA = masterOf(s);
  const openingA = openBlocks(s); // A's editor opens
  s = blockSave(s, masterOf(s), (bl) => bl.map((x) => ({ ...x, days: x.days.filter((d) => d !== DOW2) }))); // B removes that day
  ok(!rows(s).some((j) => dayOfWeekKey(dayKey(j.startAt)) === DOW2), 'SETUP 29: B removed the day');
  const plan = dayPlanFromBlocks ? dayPlanFromBlocks(openingA.map((b) => ({ ...b, days: [...b.days], crewIds: [...b.crewIds] })), openingA) : null;
  s = plan ? reducer(s, { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(openedA).fromDate, patch: { notes: 'Gate code' }, dayPlan: plan, anchorId: openedA.id }) : null;
  const back = rows(s).filter((j) => dayKey(j.startAt) >= D0 && dayOfWeekKey(dayKey(j.startAt)) === DOW2);
  ok(back.length > 0 && back.every((j) => timeOf(j) === '18:00-19:30' && crewOf(j) === MIS), `29: A's notes-only save re-adds it (as before) with Misty 18:00, what A showed (${[...new Set(back.map((j) => `${crewOf(j)} ${timeOf(j)}`))]})`);
}

// ── 30. 🔴 A BACKWARD day move replays as a no-op (review 2 #6, pre-existing) ──
// The dragged visit's id makes the "already applied?" check exact; the day test alone
// couldn't tell once the next week's visit slid onto fromDate's day.
{
  const s = withSeries();
  const opened = onDay(s, week(2));
  const action = { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: opened.startAt, patch: {}, targetDayKey: week(1), anchorId: opened.id };
  const once = reducer(s, action);
  const twice = reducer(once, action);
  ok(dayKey(once.jobs.find((j) => j.id === opened.id).startAt) === week(1), 'SETUP 30: the dragged visit moved back a week');
  ok(JSON.stringify(rows(once)) === JSON.stringify(rows(twice)), '🔴 30: a replay moves nothing again');
}

// ── 13. dayPlanFromBlocks: the block editor sends only what changed ──
{
  ok(typeof dayPlanFromBlocks === 'function', '🔴 13a: dayPlanFromBlocks exists (lib/recurrence.js)');
  if (typeof dayPlanFromBlocks === 'function') {
    const opening = [{ days: [1, 3], startTime: '15:30', endTime: '17:00', crewIds: [LAT] }, { days: [5], startTime: '08:00', endTime: '09:00', crewIds: [MIS] }];
    const copy = () => opening.map((b) => ({ ...b, days: [...b.days], crewIds: [...b.crewIds] }));
    const none = dayPlanFromBlocks(copy(), opening);
    ok(JSON.stringify(none.overrides) === '{}' && [...none.days].sort().join() === '1,3,5', '13b: nothing changed → no overrides, the full day set');
    const t = dayPlanFromBlocks(copy().map((b, i) => (i === 0 ? { ...b, startTime: '16:00' } : b)), opening);
    ok(JSON.stringify(t.overrides) === JSON.stringify({ 1: { startTime: '16:00', endTime: '17:00' }, 3: { startTime: '16:00', endTime: '17:00' } }), '13c: a time change → times for that block\'s days only');
    const c = dayPlanFromBlocks(copy().map((b, i) => (i === 1 ? { ...b, crewIds: [MIS, KEI] } : b)), opening);
    ok(JSON.stringify(c.overrides) === JSON.stringify({ 5: { crewIds: [MIS, KEI] } }), '13d: a crew change → crew for that block\'s days only');
    const reordered = dayPlanFromBlocks(copy().map((b, i) => (i === 1 ? { ...b, crewIds: [...b.crewIds].reverse() } : b)), opening);
    ok(JSON.stringify(reordered.overrides) === '{}', '13e: the same crew in another order is no change');
    const added = dayPlanFromBlocks([...copy(), { days: [6], startTime: '10:00', endTime: '11:00', crewIds: [KEI] }], opening);
    ok(JSON.stringify(added.overrides) === JSON.stringify({ 6: { startTime: '10:00', endTime: '11:00', crewIds: [KEI] } }), '13f: an added day carries everything');
    const movedDay = dayPlanFromBlocks([{ ...copy()[0], days: [1] }, { ...copy()[1], days: [3, 5] }], opening);
    ok(JSON.stringify(movedDay.overrides) === JSON.stringify({ 3: { startTime: '08:00', endTime: '09:00', crewIds: [MIS] } }), '13g: a day moved to another block takes that block\'s times and crew');
  }
}

console.log(`series edit × one-off visits: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
