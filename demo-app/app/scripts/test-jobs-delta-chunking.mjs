// Unit tests for splitDelta (Increment 1d) — the packing that keeps a server
// jobs-delta request under the row cap.
//
// Why this is worth a test: an off-by-one here is invisible in normal use (most
// deltas are a handful of rows) and only bites on a large series operation,
// where the symptom is a platform-layer 413 with no useful error — the same
// failure mode that silently broke base64 uploads before 2026-07-19.
//
//   node scripts/test-jobs-delta-chunking.mjs
import { splitDelta } from '../src/store/jobsMerge.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const mk = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);

// Every chunk respects the cap, and every row survives exactly once, in order.
function check(label, changed, removed, max) {
  const chunks = splitDelta(changed, removed, max);
  ok(`${label}: no chunk exceeds the cap`,
    chunks.every((c) => c.changed.length + c.removed.length <= max));
  ok(`${label}: changed round-trips in order`,
    JSON.stringify(chunks.flatMap((c) => c.changed)) === JSON.stringify(changed));
  ok(`${label}: removed round-trips in order`,
    JSON.stringify(chunks.flatMap((c) => c.removed)) === JSON.stringify(removed));
  ok(`${label}: no empty chunk`, chunks.every((c) => c.changed.length + c.removed.length > 0));
  return chunks;
}

// An empty delta must produce NO chunks — otherwise it would make a pointless
// network call on every no-op flush, which is the whole overage problem.
ok('empty delta yields no chunks', splitDelta([], [], 200).length === 0);

check('changed only, exact multiple', mk(400, 'c'), [], 200);
check('changed only, ragged', mk(505, 'c'), [], 200);
check('removed only', [], mk(450, 'r'), 200);
check('both, changed fills first chunk', mk(250, 'c'), mk(250, 'r'), 200);
check('both, tiny', mk(3, 'c'), mk(2, 'r'), 200);
check('both, exactly at cap', mk(100, 'c'), mk(100, 'r'), 200);
check('cap of 1', mk(3, 'c'), mk(2, 'r'), 1);
check('single changed row', mk(1, 'c'), [], 200);
check('single removed row', [], mk(1, 'r'), 200);

// Packing efficiency: removals should ride along with a partial changed chunk
// rather than waiting for their own request.
const packed = splitDelta(mk(150, 'c'), mk(100, 'r'), 200);
ok('removals pack into the leftover room', packed[0].changed.length === 150 && packed[0].removed.length === 50);
ok('packing does not over-fragment', packed.length === 2);

// A delta at exactly the cap is one request, not two.
ok('exact-cap delta is a single chunk', splitDelta(mk(200, 'c'), [], 200).length === 1);

// The client cap must stay <= the server cap or every full chunk 413s.
const CLIENT_MAX = 200; // src/store/jobsSync.js MAX_ROWS_PER_REQUEST
const SERVER_MAX = 250; // app/api/state/jobs-delta.js MAX_ROWS
ok('client chunk cap <= server row cap', CLIENT_MAX <= SERVER_MAX);

// ── byte budget ────────────────────────────────────────────────────────────
// A row cap alone does not bound the payload: fat job rows can clear the
// platform body cap and 413 before the handler runs, which is NOT retryable at
// the same chunk size — it loops forever. These cover that.
const fat = (n, kb) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, blob: 'x'.repeat(kb * 1024) }));

const byBytes = splitDelta(fat(200, 25), [], 200, 1_500_000);
ok('byte budget splits fat rows below the row cap', byBytes.length > 1);
ok('every fat chunk is under the byte budget',
  byBytes.every((c) => JSON.stringify(c.changed).length <= 1_600_000));
ok('fat rows all survive, in order',
  byBytes.flatMap((c) => c.changed).length === 200
  && byBytes.flatMap((c) => c.changed)[0].id === 'f0'
  && byBytes.flatMap((c) => c.changed)[199].id === 'f199');
ok('no empty chunk under the byte budget', byBytes.every((c) => c.changed.length + c.removed.length > 0));

// A single row bigger than the whole budget must still ship (alone) rather than
// stall the loop or be silently dropped — it has to fail loudly at the server.
const huge = splitDelta([{ id: 'h', blob: 'x'.repeat(3 * 1024 * 1024) }, { id: 'h2' }], [], 200, 1_500_000);
ok('an oversized single row still ships alone', huge.length === 2 && huge[0].changed.length === 1);
ok('oversized row does not swallow the next row', huge[1].changed[0].id === 'h2');

// Small rows must NOT be over-fragmented by the byte budget.
ok('small deltas stay in one chunk under the byte budget',
  splitDelta(mk(50, 'c').map((id) => ({ id })), [], 200, 1_500_000).length === 1);

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
