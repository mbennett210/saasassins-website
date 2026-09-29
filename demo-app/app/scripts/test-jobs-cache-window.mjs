// Offline jobs cache windowing — SCALE-C14 / §8 G4 (E6).
//
// cacheJobs is a MAIN-THREAD structured clone, so its cost is the row count. Caching
// the full ~19k-row set was ~52.9 MB resident — enough that the browser may evict the
// whole origin's storage under quota pressure, which silently destroys the offline
// cache crew depend on in the field. Only the boot window is persisted now; the
// IN-MEMORY set stays complete.
//
// ⚠️ THE DANGEROUS PART IS NOT THE FILTER, IT IS WHAT READS THE RESULT.
// bootFromCache used the cached array as (a) the save baseline and (b) the TOP_UP
// readiness signal. Against a PARTIAL set that is destructive twice over:
//   • the reconnect flush diffs against it, so every out-of-window job reads as a
//     local deletion and the save emits a delete for each one;
//   • TOP_UP derives its tail from the in-memory set, so a partial set appends
//     duplicate occurrences for the not-yet-loaded tail.
// Hence the `windowed` stamp, and hence a record written before this shipped (no flag)
// must still be treated as a full set.
//
//   node scripts/test-jobs-cache-window.mjs
import { jobsInWindow } from '../src/store/jobsMerge.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const job = (id, startAt) => ({ id, startAt, crewIds: [] });
const FROM = '2026-06-05';
const TO = '2026-10-28';
const ids = (a) => a.map((j) => j.id).sort().join(',');

// ── the window itself ────────────────────────────────────────────────────
{
  const all = [
    job('old', '2026-01-01T17:00:00.000Z'),
    job('justBefore', '2026-06-04T23:59:59.000Z'),
    job('lowEdge', '2026-06-05T00:00:00.000Z'),
    job('mid', '2026-07-20T17:00:00.000Z'),
    job('highEdge', '2026-10-28T23:59:00.000Z'),
    job('justAfter', '2026-10-29T00:00:00.000Z'),
    job('farFuture', '2027-03-01T17:00:00.000Z'),
  ];
  const kept = jobsInWindow(all, FROM, TO);
  ok('keeps only the window', ids(kept) === 'highEdge,lowEdge,mid');
  ok('  ...both edges are INCLUSIVE', kept.some((j) => j.id === 'lowEdge') && kept.some((j) => j.id === 'highEdge'));
  ok('  ...drops the day before', !kept.some((j) => j.id === 'justBefore'));
  ok('  ...drops the day after', !kept.some((j) => j.id === 'justAfter'));
  ok('  ...drops the long tail in both directions', !kept.some((j) => j.id === 'old' || j.id === 'farFuture'));
}

// ── 🔴 an unplaceable job is KEPT, never dropped ─────────────────────────
// It cannot be positioned in the window, and dropping it would lose it from an
// offline boot entirely — the wrong direction to fail when the whole point of the
// cache is preserving usable state offline.
{
  const odd = [
    job('noStart', undefined),
    job('nullStart', null),
    job('emptyStart', ''),
    job('shortStart', '2026'),
    job('numStart', 20260720),
    job('inWindow', '2026-07-20T17:00:00.000Z'),
  ];
  const kept = jobsInWindow(odd, FROM, TO);
  ok('jobs with no/unusable startAt are KEPT', kept.length === 6);
  ok('  ...including the in-window one', kept.some((j) => j.id === 'inWindow'));
}

// ── degenerate bounds must not silently empty the cache ─────────────────
// Returning [] here would cache nothing and quietly break every offline boot.
{
  const all = [job('a', '2026-07-20T00:00:00.000Z'), job('b', '2026-01-01T00:00:00.000Z')];
  ok('a missing `from` returns everything unfiltered', jobsInWindow(all, null, TO).length === 2);
  ok('a missing `to` returns everything unfiltered', jobsInWindow(all, FROM, null).length === 2);
  ok('both missing returns everything unfiltered', jobsInWindow(all, undefined, undefined).length === 2);
  ok('an empty-string bound returns everything unfiltered', jobsInWindow(all, '', TO).length === 2);
}

// ── shape robustness ────────────────────────────────────────────────────
ok('a non-array input yields []', jobsInWindow('nope', FROM, TO).length === 0);
ok('undefined input yields []', jobsInWindow(undefined, FROM, TO).length === 0);
ok('an empty array stays empty', jobsInWindow([], FROM, TO).length === 0);
ok('null entries are kept rather than crashing', jobsInWindow([null, undefined], FROM, TO).length === 2);
ok('object identity is preserved (no clone)', (() => {
  const j = job('a', '2026-07-20T00:00:00.000Z');
  return jobsInWindow([j], FROM, TO)[0] === j;
})());
ok('the input array is not mutated', (() => {
  const all = [job('a', '2026-01-01T00:00:00.000Z'), job('b', '2026-07-20T00:00:00.000Z')];
  jobsInWindow(all, FROM, TO);
  return all.length === 2;
})());

// ── the size claim, at realistic proportions ────────────────────────────
// Live: 19,267 rows across a rolling year. A ~145-day window is roughly 40% of it —
// the reduction is real but this is NOT a 10x win, and overstating it would be worse
// than not measuring at all.
{
  const day = 86400000;
  const base = Date.parse('2026-07-20T12:00:00.000Z');
  const spread = [];
  for (let i = -200; i < 200; i += 1) spread.push(job(`j${i}`, new Date(base + i * day).toISOString()));
  const kept = jobsInWindow(spread, '2026-06-05', '2026-10-28');
  ok(`a +-200-day spread reduces to the window (${kept.length}/${spread.length})`, kept.length < spread.length);
  ok('  ...and keeps a materially smaller share', kept.length / spread.length < 0.5);
  ok('  ...but is not empty (the cache must still boot)', kept.length > 0);
}

console.log(`\njobs cache window: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
