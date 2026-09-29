// Time-off rules (Sept 1) — pure-function coverage for store/timeOffRules.js:
// the ONE availability rule shared by the reducer's mint paths, the conflict
// selectors, and the bulk-exclusion action. Offline; no network, no browser.
//
//   node scripts/test-time-off.mjs
import { isUserOffOn, timeOffEntryFor, draftEffectiveCrewIds, applyTimeOffToOccurrence } from '../src/store/timeOffRules.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const LATISHA = 'u_latisha';
const MISTY = 'u_misty';
const BEN = 'u_ben';

// Aug 31 org-day (America/Los_Angeles): an evening clean starting 2026-09-01T05:30Z
// is Aug 31, 10:30 PM local — the exact incident shape.
const NIGHT_CLEAN_START = '2026-09-01T05:30:00Z';
const OFF_AUG31 = { id: 'to_1', userId: LATISHA, startDate: '2026-08-31', endDate: '2026-08-31', reason: 'night off' };
const OFF_RANGE = { id: 'to_2', userId: BEN, startDate: '2026-09-10', endDate: '2026-09-12', reason: 'vacation' };

// ── isUserOffOn / timeOffEntryFor ──────────────────────────────────────────
ok('evening clean past midnight UTC counts as the org-day it started',
  isUserOffOn([OFF_AUG31], LATISHA, NIGHT_CLEAN_START) === true);
ok('a different user is not off', isUserOffOn([OFF_AUG31], MISTY, NIGHT_CLEAN_START) === false);
ok('the day before is not off', isUserOffOn([OFF_AUG31], LATISHA, '2026-08-31T05:30:00Z') === false);
ok('range: first day inclusive', isUserOffOn([OFF_RANGE], BEN, '2026-09-10T20:00:00Z') === true);
ok('range: last day inclusive', isUserOffOn([OFF_RANGE], BEN, '2026-09-13T02:00:00Z') === true); // Sep 12 evening local
ok('range: day after excluded', isUserOffOn([OFF_RANGE], BEN, '2026-09-13T20:00:00Z') === false);
ok('empty list / null args are safe',
  isUserOffOn([], LATISHA, NIGHT_CLEAN_START) === false
  && isUserOffOn(null, LATISHA, NIGHT_CLEAN_START) === false
  && isUserOffOn([OFF_AUG31], null, NIGHT_CLEAN_START) === false
  && isUserOffOn([OFF_AUG31], LATISHA, null) === false);
ok('timeOffEntryFor returns the matching entry',
  timeOffEntryFor([OFF_RANGE, OFF_AUG31], LATISHA, NIGHT_CLEAN_START)?.id === 'to_1');
ok('timeOffEntryFor returns null on no match',
  timeOffEntryFor([OFF_AUG31], MISTY, NIGHT_CLEAN_START) === null);

// ── draftEffectiveCrewIds (named crew only — standing/regular crew was removed) ──
const state = {
  timeOff: [OFF_AUG31],
  sites: [{ id: 'st_1', clientId: 'cl_1', standingCrewIds: [LATISHA] }],
  clients: [{ id: 'cl_1', standingCrewIds: [BEN] }],
};
// Sept 3: assignment overrides regular — naming a helper is authoritative, so the
// standing regulars are NOT auto-added to the draft (the create picker materializes
// the intended crew into crewIds instead).
ok('draft with a named helper → exactly the named set, standing NOT auto-added',
  (() => {
    const ids = draftEffectiveCrewIds(state, { clientId: 'cl_1', siteId: 'st_1', crewIds: [MISTY] });
    return ids.length === 1 && ids.includes(MISTY) && !ids.includes(LATISHA) && !ids.includes(BEN);
  })());
ok('crewExcludedIds is inert once crew is named (assignment overrides regular)',
  (() => {
    const ids = draftEffectiveCrewIds(state, { clientId: 'cl_1', siteId: 'st_1', crewIds: [MISTY], crewExcludedIds: [LATISHA, MISTY] });
    return ids.length === 1 && ids.includes(MISTY) && !ids.includes(LATISHA) && !ids.includes(BEN);
  })());
ok('draft with empty crew resolves to nothing (site/account standing is NOT auto-added)',
  draftEffectiveCrewIds(state, { clientId: 'cl_1', crewIds: [] }).length === 0);

// ── applyTimeOffToOccurrence (the mint-time exclusion) ─────────────────────
const occExplicit = { id: 'j1', startAt: NIGHT_CLEAN_START, siteId: 'st_1', clientId: 'cl_1', crewIds: [LATISHA, MISTY], crewExcludedIds: [] };
const adjusted = applyTimeOffToOccurrence(state, occExplicit);
ok('explicit crewId off that day is REMOVED from the occurrence (exclusions cannot beat crewIds)',
  !adjusted.crewIds.includes(LATISHA) && adjusted.crewIds.includes(MISTY));
ok('an off-day cleaner is dropped from crewIds, NOT tracked in a separate crewExcludedIds list',
  !adjusted.crewIds.includes(LATISHA) && !(adjusted.crewExcludedIds || []).includes(LATISHA));
ok('a clean on a working day is returned UNCHANGED by reference (no churn)',
  applyTimeOffToOccurrence(state, { ...occExplicit, startAt: '2026-09-03T05:30:00Z' }).crewIds.includes(LATISHA)
  && applyTimeOffToOccurrence({ ...state, timeOff: [] }, occExplicit) === occExplicit);
ok('idempotent: applying twice equals applying once',
  JSON.stringify(applyTimeOffToOccurrence(state, adjusted)) === JSON.stringify(adjusted));
// 🔴 THE TEMPLATE LAW (adversarial-review critical): a recurrence-bearing row is
// the SERIES TEMPLATE every future mint derives from. Adjusting it for one day
// off would silently remove the person from the ENTIRE series forever. It must
// come back UNTOUCHED, by reference.
ok('recurrence-bearing rows are NEVER adjusted (series-template poisoning guard)',
  (() => {
    const master = { ...occExplicit, recurrence: { frequency: 'weekly' } };
    return applyTimeOffToOccurrence(state, master) === master;
  })());

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\ntime off rules: ${pass}/${pass} passed`);
