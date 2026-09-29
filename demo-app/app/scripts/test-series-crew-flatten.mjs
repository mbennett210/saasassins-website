// Per-day series crews must survive an edit that did not touch crew.
//
// ══ THE DEFECT ════════════════════════════════════════════════════════════════
// A multi-day weekly series holds a crew PER WEEKDAY in recurrence.dayOverrides.
// UPDATE_JOB_SERIES spreads its uniform `patch` onto every future occurrence, so a
// `crewIds` in that patch overwrites all of them with one value — flattening the series.
//
// JobDetail already knew this. Its weekly-with-blocks branch carries the comment "the
// uniform patch must NOT carry crewIds here or it would flatten the series' per-day
// crews", and routes crew through dayPatches instead. But the condition that selects
// that branch is `isWeeklySeries`, i.e. seriesMaster?.recurrence?.frequency === 'weekly',
// and selectSeriesMaster searches state.jobs — which since E6 holds only a WINDOW
// (~-45/+100 days). For a series that began outside the window the master is absent for
// the first seconds of every session, and permanently on a tab that never finishes the
// detached backfill.
//
// So the guard evaluated FALSE precisely when the data it needed was missing, the
// fallback branch ran, and a user editing only the notes silently flattened every day's
// crew. Same for Schedule's isPerDaySeries, which returned false on an unknown master
// and therefore OFFERED "this & all future".
//
// The fix is at the WRITE point in all three entry points — only send crewIds when the
// user actually changed it — so it holds regardless of whether the master ever loaded.
//
//   node scripts/test-series-crew-flatten.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── 🔴 Schedule: an unknown master must fail SAFE ───────────────────────
{
  const src = read('../src/pages/Schedule.jsx');
  const fn = (src.match(/const isPerDaySeries = \(job\) => \{[\s\S]*?\n  \};/) || [])[0] || '';
  ok('isPerDaySeries found', fn.length > 0);
  ok('🔴 an unloaded/missing master is treated as per-day (the SAFE direction)',
    /if \(!m\) return true;/.test(fn));
  ok('  ...and that check precedes any recurrence read',
    fn.indexOf('if (!m) return true') < fn.indexOf('m.recurrence'));
  ok('a job with no seriesId is still not per-day', /if \(!job\.seriesId\) return false;/.test(fn));
  // The old shape used optional chaining to swallow a missing master into `false`.
  ok('  ...the old swallow-into-false shape is gone', !/const r = m\?\.recurrence;/.test(fn));
  ok('both prompt sites still pass the flag', (src.match(/disableFuture: isPerDaySeries\(job\)/g) || []).length === 2);
}

// ── 🔴 JobDetail: the fallback branch must not carry crewIds blindly ────
{
  const src = read('../src/pages/JobDetail.jsx');
  // The per-day channel was `dayPatches` (re-time days that already run); it became
  // `dayPlan` ({days, overrides}) when the block editor gained day add/remove. The
  // INVARIANT is unchanged and is what this asserts: per-day crew travels on that
  // channel, and the uniform patch — which the reducer spreads onto every occurrence
  // — never carries crewIds. Since 2026-09-23 the channel carries only what CHANGED per
  // day, against the blocks the editor opened with (dayPlanFromBlocks; its behavior is
  // pinned in test-series-edit-one-offs.mjs).
  const recSrc = read('../src/lib/recurrence.js');
  ok('the block branch still routes crew through the per-day channel',
    /const \{ days, overrides, full \} = dayPlanFromBlocks\(editBlocks, openingBlocks\);/.test(src)
    && /o\.crewIds = \[\.\.\.\(b\.crewIds \|\| \[\]\)\];/.test(recSrc));
  ok('  ...and still keeps crewIds out of its uniform patch',
    /patch: shared, dayPlan: \{ days, overrides, full \}/.test(src));
  ok('  ...the uniform patch built for that branch never assigns crewIds',
    !/shared\.crewIds\s*=/.test(src));
  ok('🔴 the FALLBACK branch only sends crewIds when it changed',
    /\.\.\.\(crewChanged \? \{ crewIds: currentForm\.crewIds \} : \{\}\)/.test(src));
  ok('  ...and the unconditional form is gone', !/patch: \{ \.\.\.shared, crewIds: currentForm\.crewIds \}/.test(src));
  // The comparison generalised: `sameCrew(…, initial.crewIds)` became `sameIds(…, base.crewIds)`
  // when EVERY series field was brought under the same diff (test-series-field-diff.mjs).
  // `base` is the edit-time snapshot, which is strictly stronger than `initial` (a useMemo
  // on the live job) — so this still asserts a mount-of-edit baseline, order-insensitively.
  ok('  ...comparing against the edit-time baseline, order-insensitively',
    /sameIds\(currentForm\.crewIds, base\.crewIds\)/.test(src) && /\.sort\(\)\.join\(','\)/.test(src));
  ok('  ...and that baseline is snapshotted when the edit STARTS, not read live',
    /const base = editBaseline \|\| initial;/.test(src)
    // Three calls IN ORDER at the start; trailing statements allowed (see test-series-field-diff.mjs).
    && /const beginEdit = \(\) => \{ setForm\(initial\); setEditBaseline\(initial\); setEditing\(true\);[^}]*\};/.test(src));
}

// ── 🔴 NewJobModal: the uniform series patch is diffed ──────────────────
{
  const src = read('../src/components/NewJobModal.jsx');
  ok('🔴 crewIds only rides the series patch when changed',
    /if \(!sameCrew\(form\.crewIds, initialData\.crewIds\)\) seriesPatch\.crewIds = form\.crewIds;/.test(src));
  ok('  ...the unconditional form is gone', !/crewIds: form\.crewIds,\n            notes: form\.notes,/.test(src));
  ok('  ...and every other field is diffed too', /if \(form\.clientId !== initialData\.clientId\)/.test(src));
  ok('the patch passed to the action is the diffed one', /patch: seriesPatch,/.test(src));
  // The day move / timePatch must still ride independently of the uniform
  // patch. (The day move is now an ABSOLUTE targetDayKey — replay idempotence,
  // 2026-07-30 — still keyed off the local dayShift diff, still separate.)
  ok('the day move still rides separately', /\.\.\.\(dayShift \? \{ targetDayKey: form\.date \} : \{\}\)/.test(src));
  ok('timePatch still rides separately', /\.\.\.\(timeChanged \? \{ timePatch:/.test(src));
}

// ── an empty patch must be a safe no-op in the reducer ──────────────────
// Diffing means a day-only move now sends patch:{}. If the reducer did not tolerate
// that, the fix above would break rescheduling.
{
  const src = read('../src/store/reducer.js');
  ok('UPDATE_JOB_SERIES tolerates a missing/empty patch', /const patch = \{ \.\.\.\(action\.patch \|\| \{\}\) \};/.test(src));
  ok('  ...and still strips startAt/endAt', /delete patch\.startAt; delete patch\.endAt;/.test(src));
  // Scoped to the re-sync block itself (nextRecurrence's derivation). Since 2026-09-23 a
  // crew change moves the template too (crewOverride): without it every visit TOP_UP
  // added later came back with the old crew. The invariant this section guards still
  // holds, stated exactly: the re-sync reads patch.crewIds ONLY behind the guard that a
  // crew was actually sent, so an EMPTY patch (a day move) leaves the template alone,
  // and a stray unchanged crew can't arrive, because every dispatcher diffs crew first
  // (asserted above for JobDetail and NewJobModal).
  const resync = (src.match(/let nextRecurrence = null;[\s\S]*?nextRecurrence = changed \? r : null;/) || [])[0] || '';
  ok('the recurrence re-sync keys on dayPatches/timePatch/dayShift, and on patch.crewIds only when a crew is sent',
    /if \(dayPatches\)/.test(resync) && /if \(timePatch\)/.test(resync) && /if \(dayShift\)/.test(resync)
    && /if \(Array\.isArray\(patch\.crewIds\)\) \{\s*const crewIds = patch\.crewIds;/.test(resync)
    && (resync.match(/patch\.crewIds/g) || []).length === 2);
  // Schedule's day-only move already relied on this. (The move now rides an
  // ABSOLUTE targetDayKey — replay idempotence, 2026-07-30 — but the property
  // under test is unchanged: a pure day move sends an EMPTY uniform patch.)
  const sched = read('../src/pages/Schedule.jsx');
  ok('Schedule already dispatches an empty uniform patch for a day move', /patch: \{\}, targetDayKey: move\.targetDayKey/.test(sched));
}

// ── simulate the flatten, before and after ──────────────────────────────
{
  const dayOverrides = {
    1: { crewIds: ['u_mon'] },
    3: { crewIds: ['u_wed'] },
    5: { crewIds: ['u_fri'] },
  };
  const occurrenceCrew = (dow) => dayOverrides[dow].crewIds;

  // OLD: a uniform patch carrying crewIds is spread onto every occurrence.
  const applyUniform = (patch) => Object.keys(dayOverrides)
    .map((dow) => ('crewIds' in patch ? patch.crewIds : occurrenceCrew(dow)));

  const before = applyUniform({ notes: 'x', crewIds: ['u_mon'] }); // editing NOTES only, old code
  ok('THE OLD SHAPE flattened every day to one crew',
    before.every((c) => c.join() === 'u_mon') && new Set(before.map((c) => c.join())).size === 1);

  const after = applyUniform({ notes: 'x' }); // notes-only edit, new code omits crewIds
  ok('🔴 a notes-only edit now leaves each day its own crew',
    after[0].join() === 'u_mon' && after[1].join() === 'u_wed' && after[2].join() === 'u_fri');

  const deliberate = applyUniform({ crewIds: ['u_new'] }); // user DID change crew
  ok('a deliberate crew change still applies to the series',
    deliberate.every((c) => c.join() === 'u_new'));
}

console.log(`\nseries crew flatten: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
