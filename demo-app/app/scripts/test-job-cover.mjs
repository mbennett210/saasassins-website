// A cleaner covering someone's shift gets the COVERED cleaner's checklist for that clean
// (R8, Daniel 2026-09-27 — step 3 of docs/plans/2026-09-27-checklists-by-location.md).
//
// The record is `job.coverFor = { [coverUserId]: coveredUserId }` on a SINGLE visit. It
// lives inside public.jobs.data (no migration) and is additive + default-safe (every
// reader defaults to null), so no store-version bump. `lib/crewChecklist.checklistFor`
// reads it; `lib/jobCover.js` owns the shape, the prune and the UI's candidate rule.
//
// TWO halves, both pinned here:
//   the PURE model  — normalizeCoverFor / removeUserFromCoverFor / coverCandidates;
//   the LIFETIME    — the real reducer, driven with the payloads the UI sends. `coverFor`
//                     follows the one-off crew mark: it goes when its cover leaves the
//                     visit or the covered cleaner is back on it, mints never copy it, and
//                     a "this & all future" edit never writes it.
//
// The comment above reducer.js markOneOff lists SIX ways an earlier one-off design broke.
// The ones that can touch `coverFor` are pinned below by name: a series edited before this
// existed (§F1), a later-dated edit then an earlier one (§F2), a template re-homed onto a
// marked row (§F3), DST (§F4), a replay (§F5), the opened visit / anchorId (§F6).
//
// Drives the REAL reducer (loadStore, deletion-core.mjs). The series starts two org-days
// ahead so every visit is still upcoming whenever this runs.
//   node app/scripts/test-job-cover.mjs
import { loadStore } from './deletion-core.mjs';
import { todayKey, addDaysKey, composeIso, composeEndIso, dayKey, dayOfWeekKey } from '../src/lib/dates.js';
import { seriesFromDate } from '../src/lib/seriesScope.js';
import { checklistFor } from '../src/lib/crewChecklist.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };
const eq = (m, got, want) => {
  const g = JSON.stringify(got ?? null), w = JSON.stringify(want ?? null);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${m}\n      got : ${g}\n      want: ${w}`); }
};

// Null-safe load: on a tree without this module every assertion that depends on it must
// FAIL BY NAME rather than crash the suite — and, just as important, never pass
// VACUOUSLY. A missing export therefore answers a sentinel that equals nothing: `eq`
// normalizes undefined to null, so a stub returning undefined silently satisfied every
// `want: null` case (most of §A), which is exactly the theatre II.3 forbids.
let JC = null;
try { JC = await import('../src/lib/jobCover.js'); } catch { JC = null; }
const stub = (name) => (...args) => ({ __missingExport: name, args: args.length });
const need = (name) => {
  ok(typeof JC?.[name] === 'function', `src/lib/jobCover.js exports ${name}()`);
  return JC?.[name] || stub(name);
};
ok(!!JC, 'src/lib/jobCover.js exists (the pure cover model)');
const normalizeCoverFor = need('normalizeCoverFor');
const removeUserFromCoverFor = need('removeUserFromCoverFor');
const coverCandidates = need('coverCandidates');
const coveredCleanerId = need('coveredCleanerId');
const settleCoverFor = need('settleCoverFor');
const coverForNamesUser = need('coverForNamesUser');

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();

// ── §A the pure model ────────────────────────────────────────────────────────
const A = 'u_a', B = 'u_b', C = 'u_c';
eq('normalize: a cover on the visit covering someone off it is kept',
  normalizeCoverFor({ [A]: B }, [A]), { [A]: B });
eq('normalize: the cover is no longer ON the visit → dropped',
  normalizeCoverFor({ [A]: B }, [C]), null);
eq('normalize: the covered cleaner is BACK on the visit → dropped',
  normalizeCoverFor({ [A]: B }, [A, B]), null);
eq('normalize: nobody covers themselves', normalizeCoverFor({ [A]: A }, [A]), null);
eq('normalize: a non-string / empty covered id is dropped',
  normalizeCoverFor({ [A]: B, [C]: '', u_d: 7 }, [A, C, 'u_d']), { [A]: B });
eq('normalize: nullish map → null', normalizeCoverFor(null, [A]), null);
eq('normalize: a non-object → null', normalizeCoverFor('nope', [A]), null);
eq('normalize: nullish crew → null (nobody is on the visit)', normalizeCoverFor({ [A]: B }, null), null);
{
  // Canonical key order, for the same reason markOneOff canonicalizes its flags: the jobs
  // guard compares a protected field by JSON (fieldChanged → norm()), so a key reorder
  // must not read as an authority change.
  const one = normalizeCoverFor({ [A]: 'u_x', [C]: 'u_y' }, [A, C]);
  const two = normalizeCoverFor({ [C]: 'u_y', [A]: 'u_x' }, [C, A]);
  eq('normalize: key order is canonical, so equal covers serialize alike', one, two);
  eq('normalize: idempotent (a replay re-normalizes to the same map)',
    normalizeCoverFor(one, [A, C]), one);
}
// ── §A2 the REGULARS half of the rule (C1) ──────────────────────────────────
// Crew membership alone is not the invariant. A cover is only covering while they are NOT
// one of that day's regulars and the person they name IS a regular who is off the visit.
// Without this, a "this & all future" re-crew that PROMOTES the cover clears the one-off
// mark but leaves the cover live — so the promoted cleaner keeps filling someone else's
// checklist on that visit forever, and (from step 4) clocks out against it.
// `regularCrewIds` null/absent = UNKNOWABLE (a one-off clean, or a series whose master is
// outside the windowed boot): the crew rule alone then applies, so nothing is dropped on a
// guess.
eq('regulars: a genuine cover is kept (cover not a regular, covered one is, and off it)',
  normalizeCoverFor({ [A]: B }, [A], [B]), { [A]: B });
eq('regulars: the cover was PROMOTED to regular → the cover is dead (C1)',
  normalizeCoverFor({ [A]: B }, [A], [A, B]), null);
eq('regulars: the cover is the ONLY regular now → dead (the C1 repro exactly)',
  normalizeCoverFor({ [A]: B }, [A], [A]), null);
eq('regulars: the named cleaner is not a regular of this day → dead',
  normalizeCoverFor({ [A]: B }, [A], [C]), null);
eq('regulars: nobody is a regular → dead', normalizeCoverFor({ [A]: B }, [A], []), null);
eq('regulars: a REGULAR cannot be recorded as their own cover (C1)',
  normalizeCoverFor({ [B]: C }, [B], [B, C]), null);
eq('regulars: unknowable (null) → the crew rule alone, nothing dropped on a guess',
  normalizeCoverFor({ [A]: B }, [A], null), { [A]: B });
// C6 (owner's ruling): one regular is covered by at most ONE cleaner per visit. The first
// by canonical (sorted) cover id wins, so a replay resolves the same way every time.
eq('one cover per regular: a second claim on the same cleaner is dropped (C6)',
  normalizeCoverFor({ [C]: 'u_x', [A]: 'u_x' }, [A, C], ['u_x']), { [A]: 'u_x' });
eq('one cover per regular: two covers naming DIFFERENT regulars both stand',
  normalizeCoverFor({ [A]: 'u_x', [C]: 'u_y' }, [A, C], ['u_x', 'u_y']), { [A]: 'u_x', [C]: 'u_y' });

// settleCoverFor: the same rule, applied to a whole visit row.
eq('settle: a visit whose cover was promoted loses it (C1)',
  settleCoverFor({ crewIds: [A], coverFor: { [A]: B } }, [A]).coverFor, null);
eq('settle: a visit with no cover comes back by REFERENCE (no spurious jobs-delta churn)',
  (() => { const v = { crewIds: [A] }; return settleCoverFor(v, [B]) === v; })(), true);

eq('removeUser: drops an entry naming the user as the COVER', removeUserFromCoverFor({ [A]: B }, A), null);
eq('coverForNamesUser: either side counts', [coverForNamesUser({ [A]: B }, A), coverForNamesUser({ [A]: B }, B), coverForNamesUser({ [A]: B }, C)], [true, true, false]);
eq('removeUser: drops an entry naming the user as the COVERED cleaner', removeUserFromCoverFor({ [A]: B }, B), null);
eq('removeUser: leaves other entries alone', removeUserFromCoverFor({ [A]: B, [C]: 'u_d' }, B), { [C]: 'u_d' });
eq('removeUser: no userId → unchanged', removeUserFromCoverFor({ [A]: B }, null), { [A]: B });
eq('coveredCleanerId: reads the visit\'s own map', coveredCleanerId({ coverFor: { [A]: B } }, A), B);
eq('coveredCleanerId: nobody named → null', coveredCleanerId({ coverFor: { [A]: B } }, C), null);
eq('coveredCleanerId: no clean → null', coveredCleanerId(null, A), null);

// coverCandidates: the UI rule (who gets a "Covering for" choice, among whom). `options`
// is the per-row offer list, which is `left` minus the regulars another row already claims
// (C6) plus this row's own saved pick even when that cleaner has left the team (C3).
eq('candidates: one regular left + one joined → pre-filled',
  coverCandidates({ regularCrewIds: [B], crewIds: [A] }),
  { covers: [A], left: [B], prefill: { [A]: B }, options: { [A]: [B] } });
eq('candidates: two left + two joined → editable, nothing guessed',
  coverCandidates({ regularCrewIds: [B, 'u_d'], crewIds: [A, C] }),
  { covers: [A, C], left: [B, 'u_d'], prefill: { [A]: '', [C]: '' }, options: { [A]: [B, 'u_d'], [C]: [B, 'u_d'] } });
eq('candidates: an already-saved cover pre-fills even at 2×2',
  coverCandidates({ regularCrewIds: [B, 'u_d'], crewIds: [A, C], coverFor: { [C]: 'u_d' } }),
  { covers: [A, C], left: [B, 'u_d'], prefill: { [A]: '', [C]: 'u_d' }, options: { [A]: [B], [C]: [B, 'u_d'] } });
eq('candidates: a saved cover naming someone back ON the visit is not offered back',
  coverCandidates({ regularCrewIds: [B], crewIds: [A, B], coverFor: { [A]: B } }),
  { covers: [A], left: [], prefill: { [A]: '' }, options: { [A]: [] } });
eq('candidates: no regular left → no offer', coverCandidates({ regularCrewIds: [B], crewIds: [A, B] }).left, []);
eq('candidates: the regulars are working their own shift, never covers',
  coverCandidates({ regularCrewIds: [A, B], crewIds: [A, B] }).covers, []);
eq('candidates: an inactive regular is not offered (activeIds)',
  coverCandidates({ regularCrewIds: [B, C], crewIds: [A], activeIds: [A, B] }).left, [B]);
eq('candidates: called with nothing → empty, never throws',
  coverCandidates(), { covers: [], left: [], prefill: {}, options: {} });
// C6: a regular already claimed in one row is not offered in the other.
eq('candidates: a regular claimed by one cover is not offered to the other (C6)',
  coverCandidates({ regularCrewIds: ['u_x', 'u_y'], crewIds: [A, C], coverFor: { [A]: 'u_x' } }).options,
  { [A]: ['u_x', 'u_y'], [C]: ['u_y'] });
// C3: the covered cleaner was DEACTIVATED. activeIds drops them from `left`, but the
// saved entry is still live on the visit, so the row must still show it and be clearable —
// otherwise a cover is stuck filling a departed cleaner's checklist with no way to undo.
{
  const c = coverCandidates({ regularCrewIds: [B, C], crewIds: [A], coverFor: { [A]: C }, activeIds: [A, B] });
  eq('candidates: a deactivated covered cleaner is not OFFERED to anyone new', c.left, [B]);
  eq('candidates: ...but the row that holds them still shows them (C3)', c.prefill[A], C);
  eq('candidates: ...and that row can still be cleared (they are in its options)', (c.options || {})[A], [B, C]);
}

// ── the reducer rig ──────────────────────────────────────────────────────────
const LAT = 'u_cv_latisha';   // the REGULAR cleaner on the series
const KEI = 'u_cv_keisha';    // the cover
const MIS = 'u_cv_misty';     // a third cleaner
const SID = 'ser_cv_cover';
const CLIENT = {
  id: 'cl_cv', name: 'Cover Test Co',
  // Per-cleaner checklists — the ONLY model checklistFor resolves against (R3 retired the
  // location-wide default), so MIS, who has no pick, has no checklist anywhere here.
  crewChecklists: { [LAT]: 'it_latisha', [KEI]: 'it_keisha' },
};
const SITE = { id: 'st_cv', clientId: CLIENT.id, name: 'Cover Test main' };
const D0 = addDaysKey(todayKey(), 2);
const DOW = dayOfWeekKey(D0);
const week = (n) => addDaysKey(D0, 7 * n);
const FAR = new Date(composeIso(addDaysKey(D0, 200), '12:00')).getTime();

const blank = () => ({
  ...INITIAL_STATE,
  clients: [...(INITIAL_STATE.clients || []), CLIENT],
  sites: [...(INITIAL_STATE.sites || []), SITE],
  users: [...(INITIAL_STATE.users || []),
    ...[[LAT, 'Latisha Cover'], [KEI, 'Keisha Cover'], [MIS, 'Misty Cover']]
      .map(([id, name]) => ({ id, name, role: 'crew', status: 'active' }))],
  jobs: [], timeOff: [], notifications: [],
});
const withSeries = (crewIds = [LAT]) => reducer(blank(), {
  type: ACTIONS.ADD_JOB_SERIES, seriesId: SID,
  baseJob: {
    clientId: CLIENT.id, siteId: SITE.id, crewIds, notes: '', tagIds: [],
    startAt: composeIso(D0, '15:30'), endAt: composeEndIso(D0, '15:30', '17:00'),
  },
  recurrence: { frequency: 'weekly', daysOfWeek: [DOW], endType: 'never' },
});
const rows = (s) => (s ? s.jobs.filter((j) => j.seriesId === SID).sort((a, b) => a.startAt.localeCompare(b.startAt)) : []);
const onDay = (s, key) => rows(s).find((j) => dayKey(j.startAt) === key);
const coverOf = (j) => (j?.coverFor ?? null);
// The single-visit edit the UI sends (JobDetail "This visit" → UPDATE_JOB).
const editVisit = (s, id, patch) => reducer(s, { type: ACTIONS.UPDATE_JOB, id, patch });

// ── §B the swap writes the cover, and the resolver honours it ────────────────
{
  const s0 = withSeries([LAT]);
  const v1 = onDay(s0, week(1));
  const s1 = editVisit(s0, v1.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
  const cov = onDay(s1, week(1));
  eq('swap: the cover is recorded on that visit only', coverOf(cov), { [KEI]: LAT });
  eq('swap: the crew change is still marked a one-off', cov.oneOff, { crew: true });
  eq('swap: no other visit gains a cover', rows(s1).filter((j) => j.coverFor).length, 1);

  // R8, the whole point: the cover fills the COVERED cleaner's checklist on this clean.
  eq('resolver: the cover gets the covered cleaner\'s pick on that clean',
    checklistFor({ client: CLIENT, job: cov, userId: KEI }), 'it_latisha');
  eq('resolver: the cover keeps their OWN pick on a regular visit',
    checklistFor({ client: CLIENT, job: onDay(s1, week(2)), userId: KEI }), 'it_keisha');
  eq('resolver: a cleaner nobody is covering for is unaffected — no pick, no checklist',
    checklistFor({ client: CLIENT, job: cov, userId: MIS }), null);
  // The covered cleaner has no pick at this location → the cover keeps their own.
  const noPick = { ...CLIENT, crewChecklists: { [KEI]: 'it_keisha' } };
  eq('resolver: covered cleaner has no pick here → the cover\'s own pick stands',
    checklistFor({ client: noPick, job: cov, userId: KEI }), 'it_keisha');
}

// ── §C the settle: a stale entry never survives its crew change ──────────────
{
  const s0 = withSeries([LAT]);
  const v1 = onDay(s0, week(1));
  const s1 = editVisit(s0, v1.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });

  // (a) the regular is put back on the visit → there is nothing to cover.
  const back = editVisit(s1, v1.id, { crewIds: [KEI, LAT] });
  eq('settle: the covered cleaner is back on the visit → the cover is dropped',
    coverOf(onDay(back, week(1))), null);

  // (b) the cover leaves and someone else takes the visit.
  const swapped = editVisit(s1, v1.id, { crewIds: [MIS] });
  eq('settle: the cover left the visit → the entry is dropped',
    coverOf(onDay(swapped, week(1))), null);

  // (c) a forged / stale cover naming someone not on the visit is sanitized at the
  // write point, never stored (the reducer normalizes whatever the UI sends).
  const forged = editVisit(s1, v1.id, { crewIds: [KEI], coverFor: { [MIS]: LAT, [KEI]: LAT } });
  eq('settle: an entry whose cover is not on the visit is dropped at the write point',
    coverOf(onDay(forged, week(1))), { [KEI]: LAT });

  // (d) an edit that touches nothing else must not disturb the cover.
  const notes = editVisit(s1, v1.id, { notes: 'ring the bell' });
  eq('settle: a notes-only edit leaves the cover alone', coverOf(onDay(notes, week(1))), { [KEI]: LAT });
}

// ── §D the system crew changes the settle serves ─────────────────────────────
{
  const s0 = withSeries([LAT]);
  const v1 = onDay(s0, week(1));
  const s1 = editVisit(s0, v1.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });

  // Time off booked for the COVER takes them off the visit → the entry goes with them.
  const off = reducer(s1, {
    type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: KEI, startDate: week(1), endDate: week(1),
  });
  eq('time off: the cover is taken off the visit → the cover is dropped',
    coverOf(onDay(off, week(1))), null);
  eq('time off: ...and the visit is left with nobody on it', onDay(off, week(1)).crewIds, []);

  // Time off for the COVERED cleaner changes nothing: they were already off this visit,
  // which is exactly why someone is covering.
  const offCovered = reducer(s1, {
    type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: LAT, startDate: week(1), endDate: week(1),
  });
  eq('time off: booking the COVERED cleaner off keeps the cover (they are why it exists)',
    coverOf(onDay(offCovered, week(1))), { [KEI]: LAT });

  // A deleted user, both sides. The covered cleaner is NOT on crewIds, so the crew-side
  // scrub cannot see them — an unswept entry would resolve a ghost's checklist forever.
  const delCover = reducer(s1, { type: ACTIONS.DELETE_USER, id: KEI });
  eq('delete user: the COVER is deleted → the cover is dropped', coverOf(onDay(delCover, week(1))), null);
  const delCovered = reducer(s1, { type: ACTIONS.DELETE_USER, id: LAT });
  eq('delete user: the COVERED cleaner is deleted → the cover is dropped (anti-orphan)',
    coverOf(onDay(delCovered, week(1))), null);
  ok(!rows(delCovered).some((j) => JSON.stringify(j.coverFor || null).includes(LAT)),
    'delete user: no visit anywhere still names the deleted cleaner in a cover');
}

// ── §E mints never carry it; "this & all future" never writes it ─────────────
{
  const s0 = withSeries([LAT]);
  // Put a cover on the MASTER itself — the row that doubles as the series template, the
  // riskiest place for a per-visit mark to leak into every future mint.
  const master = rows(s0).find((j) => j.recurrence);
  const s1 = editVisit(s0, master.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
  eq('mint rig: the master itself carries the cover', coverOf(rows(s1).find((j) => j.recurrence)), { [KEI]: LAT });

  const before = new Set(rows(s1).map((j) => j.id));
  const topped = reducer(s1, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: FAR });
  const minted = rows(topped).filter((j) => !before.has(j.id));
  ok(minted.length > 0, 'mint rig: the top-up actually minted visits');
  ok(minted.every((j) => !j.coverFor), 'TOP_UP: a minted visit never copies the master\'s cover');
  ok(minted.every((j) => !j.oneOff), 'TOP_UP: ...just as it never copies the one-off mark');

  // A "this & all future" crew change: the uniform patch may not carry a cover, even when
  // a stale or forged payload puts one there (it would land on EVERY future visit).
  const s2 = withSeries([LAT]);
  const anchor = onDay(s2, week(2));
  const scope = seriesFromDate(anchor);
  const future = reducer(s2, {
    type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: scope.fromDate,
    patch: { crewIds: [MIS], coverFor: { [MIS]: LAT } }, anchorId: anchor.id,
  });
  ok(rows(future).every((j) => !j.coverFor), '"this & all future": no visit is given a cover');

  // An added-day mint (dayPlan) is the third mint path — it must not carry one either.
  const s3 = editVisit(withSeries([LAT]), onDay(withSeries([LAT]), week(1)).id,
    { crewIds: [KEI], coverFor: { [KEI]: LAT } });
  const otherDow = (dayOfWeekKey(addDaysKey(D0, 1)));
  const added = reducer(s3, {
    type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(onDay(s3, week(1))).fromDate,
    patch: {}, dayPlan: { days: [DOW, otherDow], overrides: {}, full: {} },
    anchorId: onDay(s3, week(1)).id,
  });
  const newDayRows = rows(added).filter((j) => dayOfWeekKey(dayKey(j.startAt)) === otherDow);
  ok(newDayRows.length > 0, 'added-day mint: the new day actually materialized');
  ok(newDayRows.every((j) => !j.coverFor), 'added-day mint: a new visit never carries a cover');
}

// ── §F the six ways an earlier one-off design broke, applied to coverFor ─────
{
  // §F1 a series that predates this: no row carries coverFor, so nothing changes.
  const s0 = withSeries([LAT]);
  ok(rows(s0).every((j) => !('coverFor' in j)), '§F1 a series minted with no cover carries no coverFor key at all');
  eq('§F1 ...and the resolver answers exactly as it did before',
    checklistFor({ client: CLIENT, job: onDay(s0, week(1)), userId: LAT }), 'it_latisha');

  // §F2 a later-dated edit, then an earlier one: each visit keeps its OWN cover.
  let s = withSeries([LAT]);
  s = editVisit(s, onDay(s, week(3)).id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
  s = editVisit(s, onDay(s, week(1)).id, { crewIds: [MIS], coverFor: { [MIS]: LAT } });
  eq('§F2 the later visit keeps its own cover', coverOf(onDay(s, week(3))), { [KEI]: LAT });
  eq('§F2 the earlier visit keeps its own', coverOf(onDay(s, week(1))), { [MIS]: LAT });
  eq('§F2 an untouched visit between them has none', coverOf(onDay(s, week(2))), null);

  // §F3 a re-home moves `recurrence` onto a row; the row's own cover is its own, and
  // mints from the new template still carry none.
  {
    let r = withSeries([LAT]);
    const first = rows(r)[0];
    r = editVisit(r, onDay(r, week(1)).id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
    // Drop the master's own day by moving the series to another weekday: the recurrence
    // re-homes onto the earliest survivor (headless-series guard).
    r = reducer(r, { type: ACTIONS.DELETE_JOB, id: first.id });
    const heir = rows(r).find((j) => j.recurrence);
    ok(!!heir, '§F3 the recurrence re-homed onto a survivor');
    const b4 = new Set(rows(r).map((j) => j.id));
    const after = reducer(r, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: FAR });
    const fresh = rows(after).filter((j) => !b4.has(j.id));
    ok(fresh.every((j) => !j.coverFor),
      '§F3 a template re-homed onto (or beside) a cover-marked row still mints covers-free');
  }

  // §F4 DST: the cover is keyed by user id, so a visit that crosses a DST boundary keeps
  // it exactly. (The series runs weekly for a year here, spanning at least one shift.)
  {
    let d = withSeries([LAT]);
    d = reducer(d, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: FAR });
    const far = rows(d)[rows(d).length - 1];
    ok(dayKey(far.startAt) > week(12), '§F4 the series reaches far enough to cross a DST shift');
    d = editVisit(d, far.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
    eq('§F4 a cover on a far-future visit survives the DST boundary',
      coverOf(rows(d).find((j) => j.id === far.id)), { [KEI]: LAT });
    eq('§F4 ...and resolves the covered cleaner\'s checklist there',
      checklistFor({ client: CLIENT, job: rows(d).find((j) => j.id === far.id), userId: KEI }), 'it_latisha');
  }

  // §F5 a replay: the same recorded action applied twice must leave the same row.
  {
    const base = withSeries([LAT]);
    const v = onDay(base, week(1));
    const once = editVisit(base, v.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
    const twice = editVisit(once, v.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
    eq('§F5 a replayed cover edit is a no-op on the stored value',
      coverOf(onDay(twice, week(1))), coverOf(onDay(once, week(1))));
    eq('§F5 ...and so is a replayed settle',
      coverOf(onDay(reducer(twice, { type: ACTIONS.DELETE_USER, id: KEI }), week(1))), null);
  }

  // §F6 the opened visit (anchorId) always TAKES a "this & all future" edit and loses its
  // marks — so the cover goes with them: the new crew is regular there now.
  {
    let a = withSeries([LAT]);
    const v = onDay(a, week(1));
    a = editVisit(a, v.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
    const scope = seriesFromDate(onDay(a, week(1)));
    const swept = reducer(a, {
      type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: scope.fromDate,
      patch: { crewIds: [MIS] }, anchorId: v.id,
    });
    const anchored = onDay(swept, week(1));
    eq('§F6 the opened visit takes the series crew', [...anchored.crewIds].sort(), [MIS]);
    eq('§F6 ...loses its one-off mark', anchored.oneOff ?? null, null);
    eq('§F6 ...and loses its cover with it', coverOf(anchored), null);

    // A NON-anchor cover visit is SKIPPED by the series crew change (the one-off survives),
    // so its cover must survive too — otherwise the cover fills the wrong checklist.
    let b = withSeries([LAT]);
    const early = onDay(b, week(1));
    b = editVisit(b, early.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
    const laterAnchor = onDay(b, week(2));
    const swept2 = reducer(b, {
      type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(laterAnchor).fromDate,
      patch: { crewIds: [MIS] }, anchorId: laterAnchor.id,
    });
    const kept = onDay(swept2, week(1));
    eq('§F6 a non-anchor cover visit keeps its crew', [...kept.crewIds].sort(), [KEI]);
    eq('§F6 ...and keeps its cover', coverOf(kept), { [KEI]: LAT });
    eq('§F6 ...so the cover still fills the covered cleaner\'s checklist',
      checklistFor({ client: CLIENT, job: kept, userId: KEI }), 'it_latisha');
  }
}

// ── §G a "this & all future" RE-CREW settles a cover it does touch ───────────
{
  // A visit with a cover whose crew the series edit DOES re-crew (the anchor aside, this
  // happens when the visit is not marked — e.g. a cover the office wrote onto a
  // non-series-marked row). The cover must not outlive the crew it named.
  let s = withSeries([LAT]);
  const v = onDay(s, week(2));
  // Write a cover WITHOUT the one-off mark by sending oneOff explicitly (the shape the
  // guard puts back on a sanitized write), so the series edit re-crews this visit.
  s = editVisit(s, v.id, { crewIds: [KEI], coverFor: { [KEI]: LAT }, oneOff: null });
  eq('§G rig: the visit holds a cover with no one-off mark', coverOf(onDay(s, week(2))), { [KEI]: LAT });
  const anchor = onDay(s, week(1));   // the edit is opened from an EARLIER visit
  const swept = reducer(s, {
    type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(anchor).fromDate,
    patch: { crewIds: [MIS] }, anchorId: anchor.id,
  });
  const re = onDay(swept, week(2));
  eq('§G an unmarked visit takes the series crew', [...re.crewIds].sort(), [MIS]);
  eq('§G ...and its cover is settled away with the cleaner who left', coverOf(re), null);
}

// ── §H C1: a re-crew that PROMOTES the cover must not leave a live cover ─────
// The reviewer's repro, end to end through the reducer: the regular is Latisha, W1 is a
// one-night cover by Keisha, and then the office makes Keisha the series' crew from W1
// forward, anchored on W1. The anchor takes the edit and loses `oneOff` — Keisha is simply
// the regular now — but the crew-membership rule alone kept the cover alive, so Keisha
// would fill Latisha's checklist on W1 for ever (and, from step 4, clock out against it).
{
  let s = withSeries([LAT]);
  const w1 = onDay(s, week(1));
  s = editVisit(s, w1.id, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
  eq('§H rig: W1 is a one-night cover', coverOf(onDay(s, week(1))), { [KEI]: LAT });
  const promoted = reducer(s, {
    type: ACTIONS.UPDATE_JOB_SERIES, seriesId: SID, fromDate: seriesFromDate(onDay(s, week(1))).fromDate,
    patch: { crewIds: [KEI] }, anchorId: w1.id,
  });
  const after = onDay(promoted, week(1));
  eq('§H the anchor keeps the promoted crew', [...after.crewIds].sort(), [KEI]);
  eq('§H ...loses the one-off mark (it is the regular crew now)', after.oneOff ?? null, null);
  eq('§H ...AND loses the cover with it (C1)', coverOf(after), null);
  eq('§H ...so Keisha fills her OWN checklist there again',
    checklistFor({ client: CLIENT, job: after, userId: KEI }), 'it_keisha');
  // The promotion reaches the LATER visits too — none of them may keep a cover either.
  ok(rows(promoted).every((j) => !j.coverFor), '§H no visit in the promoted series holds a cover');

  // The same class from the other direction: the office writes a cover naming a cleaner
  // who is the day's REGULAR. There is nothing to cover, so it is never stored.
  let r = withSeries([LAT, KEI]);
  const v = onDay(r, week(1));
  r = editVisit(r, v.id, { crewIds: [LAT, KEI], coverFor: { [KEI]: LAT } });
  eq('§H a regular cannot be recorded as covering another regular', coverOf(onDay(r, week(1))), null);

  // C6 through the reducer: two cleaners cannot both cover the same person on one visit.
  let d = withSeries([LAT]);
  const v2 = onDay(d, week(1));
  d = editVisit(d, v2.id, { crewIds: [KEI, MIS], coverFor: { [KEI]: LAT, [MIS]: LAT } });
  eq('§H one regular is covered by at most one cleaner (C6)', coverOf(onDay(d, week(1))), { [KEI]: LAT });
}

// ── §I C4/C5: a ONE-OFF clean carries a cover too, and ADD_JOB sanitizes it ──
// R8 is about a shift, not about a series. A one-off clean has no weekday pattern, so the
// day's regulars are unknowable to the reducer — the crew rule alone applies there, and
// the office's edit supplies the regulars (the crew the edit opened with) in the UI.
{
  const base = blank();
  const JID = 'j_cv_oneoff';
  const startAt = composeIso(week(1), '09:00');
  // C5: ADD_JOB spreads action.job verbatim — a forged cover naming someone not on the
  // clean must not survive the write point.
  const added = reducer(base, {
    type: ACTIONS.ADD_JOB,
    job: {
      id: JID, clientId: CLIENT.id, siteId: SITE.id, crewIds: [LAT], tagIds: [], notes: '',
      status: 'upcoming', startAt, endAt: composeEndIso(week(1), '09:00', '11:00'),
      coverFor: { [MIS]: KEI },
    },
  });
  const born = added.jobs.find((j) => j.id === JID);
  ok(!!born, '§I rig: the one-off clean was created');
  eq('§I ADD_JOB drops a cover naming someone not on the clean (C5)', born.coverFor ?? null, null);

  // The office then swaps Latisha out for Keisha on that one-off clean and records it.
  const swapped = editVisit(added, JID, { crewIds: [KEI], coverFor: { [KEI]: LAT } });
  const one = swapped.jobs.find((j) => j.id === JID);
  eq('§I a one-off clean can carry a cover (C4)', one.coverFor ?? null, { [KEI]: LAT });
  eq('§I ...and the resolver serves the covered cleaner\'s checklist on it',
    checklistFor({ client: CLIENT, job: one, userId: KEI }), 'it_latisha');
  eq('§I ...with no one-off mark, because a one-off clean has no series to differ from',
    one.oneOff ?? null, undefined);

  // The lifetime rules still bind: the cover leaves → the entry goes.
  const gone = editVisit(swapped, JID, { crewIds: [MIS] });
  eq('§I the one-off clean settles its cover like any other visit',
    gone.jobs.find((j) => j.id === JID).coverFor ?? null, null);
  // ...and a deleted covered cleaner is scrubbed off it (the anti-orphan side).
  const del = reducer(swapped, { type: ACTIONS.DELETE_USER, id: LAT });
  eq('§I DELETE_USER scrubs a one-off clean\'s cover too',
    del.jobs.find((j) => j.id === JID).coverFor ?? null, null);

  // C4's time-off half: the booking that took a cleaner off THIS clean records the job id,
  // which is how the edit knows they were a regular of it. Pinned so the UI rule has a
  // source of truth and the exclusion still settles a cover it invalidates.
  const withOff = reducer(added, {
    type: ACTIONS.ADD_TIME_OFF,
    entry: {
      id: 'to_cv', userId: LAT, startDate: week(1), endDate: week(1), reason: 'test',
      kind: 'callout', scheduledJobIds: [JID], createdBy: LAT, createdAt: new Date().toISOString(),
    },
  });
  const entry = (withOff.timeOff || []).find((t) => t.id === 'to_cv');
  eq('§I the booking records the cleans it took the person off (C4 offers them)',
    entry?.scheduledJobIds, [JID]);
  const excluded = reducer(withOff, {
    type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId: LAT, startDate: week(1), endDate: week(1),
  });
  eq('§I the exclusion takes the regular off the one-off clean',
    excluded.jobs.find((j) => j.id === JID).crewIds, []);
}

console.log(`\njob-cover: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
