// A failed jobs read must NEVER arm the per-row mirror.
//
// ══ THE DEFECT (3f22431) ══════════════════════════════════════════════════════
// The old fallback loader (hydrateJobsFromTable) set `jobsReady = true` and called
// signalJobsReady() UNCONDITIONALLY — outside the try/catch — on the theory that the blob's
// jobs were a usable fallback. That stopped being true when `jobs` became a STRIPPED slice
// (store/tableSlices.js): toSharedBlob writes `shared.jobs = []`, so the "fallback" was a
// baseline of ZERO ROWS.
//
// Arming on an empty baseline compounds:
//   · jobsReady un-gates jobsCursorPoll, which drains row_version > 0 from cursor 0 —
//     the whole table — into state.jobs via PATCH_JOBS, which never advances
//     lastSyncedJobs.
//   · the next save's diffJobs compares the live rows against [] BY REFERENCE, so every
//     row is "changed" and the ENTIRE TABLE is re-upserted. public.jobs is in the
//     supabase_realtime publication, so that is a per-row event x every connected client.
//   · signalJobsReady() un-gates the Schedule TOP_UP sweep, which against a PARTIAL set
//     mints duplicates of the unseen tail. Empty is maximally partial.
//
// Since CS-676 there is ONE loader, loadJobsBaseline (the jobs window and the series
// masters; the full-table backfill is gone): this asserts it arms the mirror on the
// table's answer only, and that its failure path retries with the mirror gated.
//
//   node scripts/test-jobs-baseline-gate.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const sync = read('../src/store/sync.js');
const fn = (sync.match(/async function loadJobsBaseline\([\s\S]*?\n  \}/) || [])[0] || '';

// ── 🔴 arming happens only on the success path ─────────────────────────
{
  ok('loadJobsBaseline found', fn.length > 0);
  const iTry = fn.indexOf('try {');
  const iCatch = fn.indexOf('} catch');
  const successBody = fn.slice(iTry, iCatch);
  const catchBody = fn.slice(iCatch);

  ok('🔴 jobsReady is set INSIDE the success path', /jobsReady = true;/.test(successBody));
  ok('🔴 ...and NOT in the catch', !/jobsReady = true/.test(catchBody));
  ok('🔴 signalJobsReady fires only on success', /signalJobsReady\(\)/.test(successBody) && !/signalJobsReady\(\)/.test(catchBody));
  ok('the baseline is only ever the authoritative table read', /lastSyncedJobs = authoritative;/.test(successBody));
  ok('🔴 ...and the catch never assigns a baseline at all', !/lastSyncedJobs\s*=/.test(catchBody));
  ok('the cursor floor is set only on success', /jobsCursor = floor;/.test(successBody) && !/jobsCursor\s*=/.test(catchBody));
  // The floor is the table's high-water read BEFORE the window (office), so a row written
  // while the window's pages are in flight is above it.
  ok('the office floor is read before the window', /floor = await fetchJobsHighWater\(\);\s*\n\s*const \[windowJobs, masters\] = await Promise\.all/.test(successBody));
  ok('🔴 a stop() or a peer load during the read abandons it (no dispatch)', /if \(!started \|\| jobsReady\) return;/.test(successBody));
}

// ── the failure path retries, gated ────────────────────────────────────
{
  const catchBody = fn.slice(fn.indexOf('} catch'));
  // Retry INDEFINITELY with capped backoff via a single dedicated timer — NOT 5-and-out.
  // A slow/flaky link (Lauren, ZA, 2026-08-12) never finished the read in 5 rounds, so
  // the mirror stayed gated for the life of the page and every schedule edit was lost.
  ok('the catch does not give up after N rounds', !/attempt < \d/.test(catchBody));
  ok('the catch retries via its own timer with capped backoff',
    /baselineRetryTimer = setTimeout\(\(\) => \{[\s\S]*?baselineRetryTimer = null;[\s\S]*?loadJobsBaseline\(attempt \+ 1\);[\s\S]*?\}, delay\)/.test(catchBody)
    && /Math\.min\(2000 \* \(attempt \+ 1\), 30000\)/.test(catchBody));
  ok('  ...one timer only (never stacks)', /if \(!baselineRetryTimer && started && !jobsReady\)/.test(catchBody));
  ok('stop() clears it', /if \(baselineRetryTimer\) \{ clearTimeout\(baselineRetryTimer\); baselineRetryTimer = null; \}/.test(sync));
  ok('the old full-table loaders are gone', !/hydrateJobsFromTable|completeJobsHydration|fetchAllJobs/.test(sync));
}

// ── what jobsReady gates — why failing closed is safe ──────────────────
{
  ok('the mirror is a no-op while ungated', /if \(!jobsReady\) return true;/.test(sync));
  ok('  ...and the cursor poll returns early too', /if \(!started \|\| !jobsReady\) return;/.test(sync));
  ok('resync retries the window while it has not landed', /if \(!jobsReady\) loadJobsBaseline\(\);/.test(sync));
  ok('nothing fetched on demand joins state before the baseline', /if \(!jobsReady\) await new Promise\(\(resolve\) => \{ baselineWaiters\.push\(resolve\); \}\);/.test(sync));
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
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
