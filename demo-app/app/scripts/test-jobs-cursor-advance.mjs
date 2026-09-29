// D6 defect (a) — two-stream keyset cursor arithmetic.
//
// jobsCursorPoll now drains TWO streams past one scalar cursor: upserts from
// public.jobs and tombstones from public.job_deletes (which draws row_version from the
// same sequence). That makes the advance rule subtle, and getting it wrong is SILENT
// AND PERMANENT — nothing ever revisits a cursor once advanced.
//
// THE TRAP: a truncated page means that stream is complete only up to its OWN max, so
// the UNION is complete only up to the LOWER of the two. Taking max() across a
// truncated upsert page and a tombstone page pushes the cursor PAST upsert rows that
// were never fetched, and they are missed forever.
//
// The inertness property is equally load-bearing: while the migration is unapplied the
// delete feed returns null, and the arithmetic must reduce to EXACTLY today's
// behaviour rather than capping the cursor at 0 (which would re-fetch the whole table
// every 60 seconds, forever).
//
//   node scripts/test-jobs-cursor-advance.mjs
import { nextJobsCursor } from '../src/store/jobsMerge.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const at = (o) => nextJobsCursor({ cursor: 0, upsertMax: 0, tombMax: 0, upsertFull: false, tombFull: false, ...o });

// ── INERT: the delete feed is unavailable (migration not applied) ─────────
// tombs === null in the caller => tombMax 0, tombFull false. Must equal today.
ok('inert: advances to the upsert max', at({ cursor: 10, upsertMax: 42 }) === 42);
ok('inert: a truncated upsert page advances only to what arrived',
  at({ cursor: 10, upsertMax: 42, upsertFull: true }) === 42);
ok('inert: nothing new leaves the cursor untouched', at({ cursor: 42, upsertMax: 0 }) === 42);
ok('🔴 inert: an empty tomb stream NEVER caps the cursor at 0',
  at({ cursor: 500, upsertMax: 600, tombMax: 0 }) === 600);

// ── both streams short (fully drained) => the higher max is safe ──────────
ok('both short: takes the higher of the two', at({ cursor: 0, upsertMax: 10, tombMax: 25 }) === 25);
ok('both short: upserts higher', at({ cursor: 0, upsertMax: 30, tombMax: 25 }) === 30);
ok('both short: tombstones only', at({ cursor: 5, upsertMax: 0, tombMax: 9 }) === 9);

// ── 🔴 THE TRAP: a truncated page bounds the union ───────────────────────
ok('truncated upserts + short tombs: bounded by the UPSERT max',
  at({ cursor: 0, upsertMax: 100, tombMax: 900, upsertFull: true }) === 100);
ok('  ...NOT the tombstone max (which would skip unfetched upserts)',
  at({ cursor: 0, upsertMax: 100, tombMax: 900, upsertFull: true }) !== 900);
ok('short upserts + truncated tombs: bounded by the TOMB max',
  at({ cursor: 0, upsertMax: 900, tombMax: 100, tombFull: true }) === 100);
ok('both truncated: bounded by the LOWER max',
  at({ cursor: 0, upsertMax: 700, tombMax: 300, upsertFull: true, tombFull: true }) === 300);
ok('both truncated, upserts lower',
  at({ cursor: 0, upsertMax: 300, tombMax: 700, upsertFull: true, tombFull: true }) === 300);

// ── monotonicity: never backwards, never a spin ──────────────────────────
ok('never moves backwards', at({ cursor: 500, upsertMax: 100, tombMax: 50 }) === 500);
ok('equal to the cursor is not progress', at({ cursor: 500, upsertMax: 500 }) === 500);
ok('a truncated page below the cursor does not rewind',
  at({ cursor: 500, upsertMax: 100, upsertFull: true }) === 500);
ok('one past the cursor IS progress', at({ cursor: 500, upsertMax: 501 }) === 501);

// ── degenerate input ─────────────────────────────────────────────────────
ok('missing maxes are treated as 0', nextJobsCursor({ cursor: 7, upsertFull: false, tombFull: false }) === 7);
ok('a zero cursor with nothing new stays 0', at({ cursor: 0 }) === 0);
ok('large values are handled (bigint-range sequence)',
  at({ cursor: 0, upsertMax: 9007199254740990 }) === 9007199254740990);

// ── the property that matters, stated as an invariant ────────────────────
// Across a grid of inputs, the cursor must never exceed a truncated stream's max —
// that is the "missed forever" condition, expressed directly.
{
  let violated = false;
  for (const upsertMax of [0, 50, 100, 900]) {
    for (const tombMax of [0, 50, 100, 900]) {
      for (const upsertFull of [true, false]) {
        for (const tombFull of [true, false]) {
          const n = nextJobsCursor({ cursor: 0, upsertMax, tombMax, upsertFull, tombFull });
          if (upsertFull && n > upsertMax) violated = true;
          if (tombFull && n > tombMax) violated = true;
        }
      }
    }
  }
  ok('INVARIANT: the cursor never passes a truncated stream\'s max (64 cases)', !violated);
}

console.log(`\njobs cursor advance: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
