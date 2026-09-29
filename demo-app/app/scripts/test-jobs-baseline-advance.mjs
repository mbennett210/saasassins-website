// The ping-pong fix, pinned. Two halves, both pure:
//
//   1. advanceBaseline (store/jobsMerge.js) — server-originated PATCH_JOBS rows
//      must advance the mirror baseline, or the by-reference diff re-POSTs rows
//      the tab never touched on its next flush. That re-POST bumped row_version,
//      fanned a per-row realtime event to every other tab, and drifted THEIR
//      baselines → measured live at ~165 UPDATEs/row (4.2M on 19k rows) with
//      whole-table rewrites hourly. The first block below ASSERTS the pre-fix
//      behavior (the drift is real), then asserts the advance eliminates it
//      without ever masking a genuine local edit.
//
//   2. jsonEq (api/_lib/jsonEq.js) — the server-side backstop compares a posted
//      payload against the stored jsonb, which does NOT preserve key order, so
//      the comparison must be key-order-insensitive or the guard is a no-op.
//
// Offline: imports only the dependency-free pure cores. Run:
//   node scripts/test-jobs-baseline-advance.mjs   (from app/)
import { advanceBaseline, diffJobs, applyJobPatch } from '../src/store/jobsMerge.js';
import { jsonEq } from '../api/_lib/jsonEq.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const job = (id, rv, extra = {}) => ({ id, startAt: '2026-07-22T16:00:00.000Z', status: 'upcoming', crewIds: ['u1'], _rv: rv, ...extra });

// ── 1. the ping-pong scenario ────────────────────────────────────────────────
{
  const j1 = job('j1', 10);
  const j2 = job('j2', 11);
  const baseline = [j1, j2];
  let state = [j1, j2];

  // A realtime patch arrives for j2 — same data, FRESH object identity, newer rv
  // (exactly what subscribeJobsRealtime/jobsCursorPoll construct).
  const j2remote = { ...j2, _rv: 12 };
  const applied = applyJobPatch(state, [j2remote], []);
  ok(applied.changed === true, 'setup: order guard accepts the strictly-newer upsert');
  state = applied.jobs;

  // PRE-FIX behavior: the diff re-posts the untouched row. This assertion is the
  // proof the loop exists — if it ever starts failing, the diff semantics changed.
  const drifted = diffJobs(baseline, state);
  ok(drifted.changed.length === 1 && drifted.changed[0].id === 'j2',
    'pre-fix: a server-originated row reads as a local edit (the ping-pong)');

  // THE FIX: advance the baseline for the patched id → nothing to re-post.
  const advanced = advanceBaseline(baseline, state, [j2remote], []);
  const after = diffJobs(advanced, state);
  ok(after.changed.length === 0 && after.removed.length === 0,
    'fix: after advanceBaseline the server row is not re-posted');
}

// ── 2. a genuine local edit is never masked ──────────────────────────────────
{
  const j1 = job('j1', 10);
  const j2 = job('j2', 11);
  let state = [j1, j2];
  const baseline = [j1, j2];

  // Remote patch for j2 lands and the baseline advances…
  const j2remote = { ...j2, _rv: 12 };
  state = applyJobPatch(state, [j2remote], []).jobs;
  const advanced = advanceBaseline(baseline, state, [j2remote], []);

  // …then the user edits j1 locally (reducer allocates a new object).
  const j1edited = { ...j1, notes: 'bring the floor buffer' };
  state = state.map((j) => (j.id === 'j1' ? j1edited : j));

  const d = diffJobs(advanced, state);
  ok(d.changed.length === 1 && d.changed[0].id === 'j1' && d.changed[0].notes === 'bring the floor buffer',
    'a real local edit still diffs out after an advance');
  ok(!d.changed.some((j) => j.id === 'j2'), 'the advanced server row stays quiet alongside it');
}

// ── 3. server delete → not re-emitted as a local delete ──────────────────────
{
  const j1 = job('j1', 10);
  const j2 = job('j2', 11);
  let state = [j1, j2];
  const baseline = [j1, j2];

  state = applyJobPatch(state, [], ['j2']).jobs;      // tombstone applied — j2 gone
  const advanced = advanceBaseline(baseline, state, [], ['j2']);
  const d = diffJobs(advanced, state);
  ok(d.removed.length === 0, 'server delete: not re-emitted as a local removed[]');
  ok(d.changed.length === 0, 'server delete: no spurious changes either');
}

// ── 4. delete REJECTED by the order guard → baseline entry kept ──────────────
{
  const j2newer = job('j2', 20);
  let state = [j2newer];
  const baseline = [j2newer];

  // A stale tombstone (rv 15 < the row's 20) arrives with a tomb memory active —
  // the guard keeps the row. The baseline must keep its entry too, or the
  // surviving row would read as a local re-create and get re-POSTed.
  const tomb = { get: (id) => (id === 'j2' ? 15 : undefined), clear: () => {}, noteOcc: () => {} };
  const applied = applyJobPatch(state, [], ['j2'], tomb);
  ok(applied.changed === false, 'setup: stale tombstone rejected, row survives');
  state = applied.jobs;

  const advanced = advanceBaseline(baseline, state, [], ['j2']);
  const d = diffJobs(advanced, state);
  ok(d.changed.length === 0 && d.removed.length === 0,
    'rejected delete: surviving row is not re-posted as a re-create');
}

// ── 5. upsert absent from state (pending local delete) → delete still emits ──
{
  const j1 = job('j1', 10);
  const j2 = job('j2', 11);
  const baseline = [j1, j2];
  // The user deleted j2 locally (state no longer holds it; flush hasn't run).
  const state = [j1];

  // A remote upsert for j2 arrives but the reducer dropped it (tomb floor) — it
  // is NOT in state. The baseline must keep j2 so the pending delete still diffs.
  const advanced = advanceBaseline(baseline, state, [{ ...j2, _rv: 9 }], []);
  const d = diffJobs(advanced, state);
  ok(d.removed.length === 1 && d.removed[0] === 'j2',
    'pending local delete still emits after an upsert the reducer dropped');
}

// ── 6. jsonEq — the server guard's comparator ────────────────────────────────
{
  ok(jsonEq(
    { a: 1, b: { x: [1, 2, { y: 'z' }], w: null }, c: 'txt' },
    { c: 'txt', b: { w: null, x: [1, 2, { y: 'z' }] }, a: 1 },
  ), 'jsonEq: key order never matters (jsonb does not preserve it)');
  ok(!jsonEq({ a: [1, 2] }, { a: [2, 1] }), 'jsonEq: array order DOES matter');
  ok(!jsonEq({ a: 1 }, { a: 1, b: null }), 'jsonEq: an extra key (even null) is a difference');
  ok(!jsonEq({ a: null }, {}), 'jsonEq: null value vs missing key differ');
  ok(!jsonEq({ a: '1' }, { a: 1 }), 'jsonEq: string vs number differ');
  ok(jsonEq(null, null) && !jsonEq(null, {}) && !jsonEq(0, null), 'jsonEq: null edges');
  ok(jsonEq([], []) && !jsonEq([], {}), 'jsonEq: empty array vs empty object differ');
  const deep = { r: { s: { t: [{ u: 1 }] } } };
  ok(jsonEq(deep, JSON.parse(JSON.stringify(deep))), 'jsonEq: deep round-trip equal');
  ok(!jsonEq(deep, { r: { s: { t: [{ u: 2 }] } } }), 'jsonEq: deep leaf mismatch caught');
}

// ── 7. realtime coalescing — one batched PATCH ≡ N sequential PATCHes ────────
// The sync manager buffers per-row postgres_changes events and dispatches ONE
// PATCH_JOBS per window. The _rv order guard is what makes intra-batch ordering
// a non-issue; pin that equivalence for the mixed same-id cases.
{
  const j1 = job('j1', 10);
  const j2 = job('j2', 11);
  const j3 = job('j3', 12);
  const base = [j1, j2, j3];
  const up2 = { ...j2, notes: 'newer', _rv: 20 };
  const up9 = job('j9', 21);

  const byId = (arr) => [...arr].sort((a, b) => a.id.localeCompare(b.id)).map((j) => `${j.id}@${j._rv}`).join(',');

  // batched: two upserts + one delete in a single window
  const batched = applyJobPatch(base, [up2, up9], ['j3']).jobs;
  // sequential: same events one dispatch each
  let seq = applyJobPatch(base, [up2], []).jobs;
  seq = applyJobPatch(seq, [up9], []).jobs;
  seq = applyJobPatch(seq, [], ['j3']).jobs;
  ok(byId(batched) === byId(seq), 'batched window ≡ sequential dispatches (upserts + delete)');

  // Same id, newer upsert + delete in ONE window. A realtime DELETE carries no
  // version (REPLICA IDENTITY DEFAULT → payload is just the id), so with no
  // tombstone memory it deletes unconditionally — identically in the batched and
  // sequential paths. That EQUIVALENCE is the invariant coalescing must hold;
  // whether the delete *should* win is owned elsewhere (the versioned tombstone
  // feed order-guards real deletes, ids are never reused, and the cursor poll is
  // the authoritative corrector either way).
  const revived = job('j2', 30);
  const batchedMixed = applyJobPatch(base, [revived], ['j2']).jobs;
  let seqMixed = applyJobPatch(base, [revived], []).jobs;
  seqMixed = applyJobPatch(seqMixed, [], ['j2']).jobs;
  ok(byId(batchedMixed) === byId(seqMixed),
    'same-id newer upsert + unversioned delete in one window ≡ sequential dispatches');
}

console.log(`\njobs baseline advance + jsonEq: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
