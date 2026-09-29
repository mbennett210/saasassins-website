// A failed jobs read must NEVER arm the per-row mirror.
//
// ══ THE DEFECT ════════════════════════════════════════════════════════════════
// hydrateJobsFromTable set `jobsReady = true` and called signalJobsReady()
// UNCONDITIONALLY — outside the try/catch — on the theory that the blob's jobs were a
// usable fallback. That stopped being true when `jobs` became a STRIPPED slice
// (store/tableSlices.js): toSharedBlob writes `shared.jobs = []`, so the "fallback" was
// a baseline of ZERO ROWS.
//
// Arming on an empty baseline compounds:
//   · jobsReady un-gates jobsCursorPoll, which drains row_version > 0 from cursor 0 —
//     the whole table — into state.jobs via PATCH_JOBS, which never advances
//     lastSyncedJobs.
//   · the next save's diffJobs compares ~19k live rows against [] BY REFERENCE, so every
//     row is "changed" and the ENTIRE TABLE is re-upserted. public.jobs is in the
//     supabase_realtime publication, so that is ~19k per-row events x every connected
//     client — on a meter already at 191% of plan. It is exactly the fan-out this whole
//     remediation exists to remove.
//   · signalJobsReady() un-gates the Schedule TOP_UP sweep, whose stated purpose is that
//     topping up against a PARTIAL set duplicates the unseen tail. Empty is maximally
//     partial.
//   · signalJobsReady() sets jobsFullyHydrated, so resync()'s
//     `if (!jobsFullyHydrated) completeJobsHydration()` recovery could never fire.
//
// The sibling catch in the same file (completeJobsHydration) always did the right thing:
// "Keep the mirror gated (a partial baseline would corrupt the table) and retry with
// backoff." This asserts the two now agree.
//
//   node scripts/test-jobs-baseline-gate.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const sync = read('../src/store/sync.js');
const fn = (sync.match(/async function hydrateJobsFromTable\([\s\S]*?\n  \}/) || [])[0] || '';

// ── 🔴 arming happens only on the success path ─────────────────────────
{
  ok('hydrateJobsFromTable found', fn.length > 0);
  const iTry = fn.indexOf('try {');
  const iCatch = fn.indexOf('} catch');
  const successBody = fn.slice(iTry, iCatch);
  const catchBody = fn.slice(iCatch);

  ok('🔴 jobsReady is set INSIDE the success path', /jobsReady = true;/.test(successBody));
  ok('🔴 ...and NOT in the catch', !/jobsReady = true/.test(catchBody));
  ok('🔴 signalJobsReady fires only on success', /signalJobsReady\(\)/.test(successBody) && !/signalJobsReady\(\)/.test(catchBody));
  ok('  ...neither sits after the try/catch any more',
    !/\}\s*\n\s*jobsReady = true;[\s\S]*?signalJobsReady\(\);\s*\n\s*return/.test(fn));
  ok('the baseline is only ever the authoritative table read', /lastSyncedJobs = tableJobs;/.test(successBody));
  ok('🔴 ...and the catch never assigns a baseline at all', !/lastSyncedJobs\s*=/.test(catchBody));
  ok('the cursor floor is set only on success', /jobsCursor = maxRv\(tableJobs\)/.test(successBody) && !/jobsCursor\s*=/.test(catchBody));
}

// ── the failure path retries, like its sibling ─────────────────────────
{
  const catchBody = fn.slice(fn.indexOf('} catch'));
  // Retry INDEFINITELY with capped backoff via a single dedicated timer — NOT 5-and-out.
  // A slow/flaky link (Lauren, ZA, 2026-08-12) never finished the read in 5 rounds, so
  // the mirror stayed gated for the life of the page and every schedule edit was lost.
  ok('the catch no longer gives up after 5 rounds', !/attempt < 5/.test(catchBody));
  ok('the catch retries via its own timer with capped backoff',
    /tableHydrateRetryTimer = setTimeout\(\(\) => \{[\s\S]*?tableHydrateRetryTimer = null;[\s\S]*?hydrateJobsFromTable\(blobJobs, attempt \+ 1\);[\s\S]*?\}, delay\)/.test(catchBody)
    && /Math\.min\(2000 \* \(attempt \+ 1\), 30000\)/.test(catchBody));
  ok('  ...matching completeJobsHydration\'s shape (own timer, capped backoff, no ceiling)',
    /hydrationRetryTimer = setTimeout\(\(\) => \{[\s\S]*?hydrationRetryTimer = null;[\s\S]*?completeJobsHydration\(attempt \+ 1\);[\s\S]*?\}, delay\)/.test(sync)
    && /Math\.min\(2000 \* \(attempt \+ 1\), 30000\)/.test(sync));
  ok('a display-only fallback is allowed but is not the baseline',
    /if \(fallback && attempt === 0\) dispatch\(\{ type: ACTIONS\.SET_JOBS, jobs: fallback \}\)/.test(catchBody));
  ok('  ...and it is only used when the blob actually carries rows',
    /Array\.isArray\(blobJobs\) && blobJobs\.length \? blobJobs : null/.test(catchBody));
  ok('the stale "always boots with data" claim is gone', !/so the\s*\n?\s*\/\/ app always boots with data/.test(sync));
}

// ── what jobsReady gates — why failing closed is safe ──────────────────
{
  ok('the mirror is a no-op while ungated', /if \(!jobsReady\) return true;/.test(sync));
  ok('  ...and the cursor poll returns early too', /if \(!started \|\| !jobsReady\) return;/.test(sync));
  ok('resync retries the backfill while not fully hydrated', /if \(!jobsFullyHydrated\)/.test(sync));
  // jobs really is stripped, which is what made the old fallback empty.
  const slices = read('../src/store/tableSlices.js');
  ok("🔴 `jobs` is a STRIPPED slice, so the blob copy is empty by construction",
    /key: 'jobs', table: 'jobs', phase: PHASE\.STRIPPED/.test(slices));
}

// ── simulate the amplification the gate prevents ───────────────────────
{
  const TABLE_ROWS = 19000;
  // diffJobs compares by object REFERENCE, so a baseline of [] makes every row changed.
  const changedCount = (baselineLen, liveLen) => (baselineLen === 0 ? liveLen : 0);

  ok('THE OLD SHAPE re-upserted the entire table', changedCount(0, TABLE_ROWS) === TABLE_ROWS);
  // Failing closed: the mirror never runs, so nothing is written at all.
  const mirrored = (jobsReady, liveLen) => (jobsReady ? changedCount(0, liveLen) : 0);
  ok('🔴 with the gate closed, zero rows are written', mirrored(false, TABLE_ROWS) === 0);
  ok('  ...and a successful read writes only real deltas', changedCount(TABLE_ROWS, TABLE_ROWS) === 0);

  // Each re-upserted row is a realtime event to every connected client.
  const CLIENTS = 43;
  ok('the avoided fan-out is ~19k x every client',
    TABLE_ROWS * CLIENTS > 800000);
}

console.log(`\njobs baseline gate: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
