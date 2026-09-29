// Unit tests for applyJobPatch — the ORDER-GUARDED-PATCH invariant (Increment 2).
//
// Why this matters: realtime delivery is unordered, and Broadcast (which replaces
// postgres_changes) is explicitly at-most-once and unordered. Without the guard,
// an older payload arriving after a newer one silently REVERTS a job — and
// because the jobs mirror diffs by reference identity, the reverted payload is
// then written back to the table as if it were the user's intent. That is
// permanent data loss, not a display glitch.
//
//   node scripts/test-jobs-order-guard.mjs
import { applyJobPatch } from '../src/store/jobsMerge.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const job = (id, rv, extra = {}) => ({ id, _rv: rv, ...extra });

// ── the core guard ─────────────────────────────────────────────────────────
const base = [job('a', 10, { title: 'newer' })];

const stale = applyJobPatch(base, [job('a', 5, { title: 'older' })]);
ok('a STALE upsert is dropped', stale.jobs[0].title === 'newer');
ok('a stale upsert reports changed:false', stale.changed === false);
ok('a stale upsert preserves the array reference', stale.jobs === base);

const newer = applyJobPatch(base, [job('a', 11, { title: 'newest' })]);
ok('a NEWER upsert is applied', newer.jobs[0].title === 'newest');
ok('a newer upsert reports changed:true', newer.changed === true);

const equal = applyJobPatch(base, [job('a', 10, { title: 'duplicate' })]);
ok('an EQUAL version is dropped (duplicate delivery)', equal.jobs[0].title === 'newer');
ok('an equal version preserves the reference', equal.jobs === base);

// ── absent / null _rv ──────────────────────────────────────────────────────
// NULL row_version means "not written since the column was added" -> 0.
ok('an upsert with no _rv cannot displace a versioned row',
  applyJobPatch(base, [{ id: 'a', title: 'unversioned' }]).jobs[0].title === 'newer');
ok('an upsert with _rv 0 cannot displace a versioned row',
  applyJobPatch(base, [job('a', 0, { title: 'zero' })]).jobs[0].title === 'newer');
const ontoUnversioned = applyJobPatch([{ id: 'a', title: 'old' }], [job('a', 1, { title: 'new' })]);
ok('a versioned upsert DOES displace an unversioned row', ontoUnversioned.jobs[0].title === 'new');

// ── inserts ────────────────────────────────────────────────────────────────
const inserted = applyJobPatch(base, [job('b', 1)]);
ok('a brand-new id is always inserted', inserted.jobs.length === 2 && inserted.changed === true);
ok('an unversioned brand-new id is still inserted',
  applyJobPatch(base, [{ id: 'c' }]).jobs.length === 2);

// ── deletes ────────────────────────────────────────────────────────────────
const deleted = applyJobPatch(base, [], ['a']);
ok('a delete removes the row', deleted.jobs.length === 0 && deleted.changed === true);
const noopDelete = applyJobPatch(base, [], ['zzz']);
ok('deleting an absent id is a no-op', noopDelete.changed === false);
ok('a no-op delete preserves the reference', noopDelete.jobs === base);

// ── ordering within one batch ──────────────────────────────────────────────
// A batch can itself be out of order; the guard applies pairwise, so the newest
// must win regardless of arrival order within the batch.
ok('newest wins when the batch is newest-then-oldest',
  applyJobPatch(base, [job('a', 30, { t: 'x' }), job('a', 20, { t: 'y' })]).jobs[0].t === 'x');
ok('newest wins when the batch is oldest-then-newest',
  applyJobPatch(base, [job('a', 20, { t: 'y' }), job('a', 30, { t: 'x' })]).jobs[0].t === 'x');

// ── the reversion scenario this exists to prevent ──────────────────────────
// Two writes to one job land out of order. Without the guard the older payload
// wins and the mirror later writes it back as truth.
let s = [job('j', 100, { status: 'scheduled' })];
s = applyJobPatch(s, [job('j', 102, { status: 'done' })]).jobs;     // newer arrives
s = applyJobPatch(s, [job('j', 101, { status: 'scheduled' })]).jobs; // older arrives late
ok('an out-of-order pair does not revert the job', s[0].status === 'done');
ok('and the surviving row keeps the newer version', s[0]._rv === 102);

// ── malformed input must not corrupt state ─────────────────────────────────
const malformed = applyJobPatch(base, [null, undefined, {}, { _rv: 9 }]);
ok('null/idless upserts are ignored', malformed.changed === false && malformed.jobs === base);

// ── empty batch ────────────────────────────────────────────────────────────
ok('an empty patch is a no-op', applyJobPatch(base, [], []).changed === false);
ok('an empty patch preserves the reference', applyJobPatch(base, [], []).jobs === base);

// ── other rows are untouched ───────────────────────────────────────────────
const multi = [job('a', 1, { k: 'A' }), job('b', 1, { k: 'B' })];
const one = applyJobPatch(multi, [job('a', 2, { k: 'A2' })]);
ok('an unrelated row is left intact', one.jobs.find((j) => j.id === 'b').k === 'B');
ok('the updated row is the new object', one.jobs.find((j) => j.id === 'a').k === 'A2');
ok('row count is unchanged by an update', one.jobs.length === 2);

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
