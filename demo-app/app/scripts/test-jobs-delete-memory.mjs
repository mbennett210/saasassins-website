// D6 defect (b) — the order guard had no delete memory.
//
// applyJobPatch's guard was `if (cur && (j._rv ?? 0) <= (cur._rv ?? 0))`. With `cur`
// ABSENT — the row was just deleted locally — the condition short-circuits false and
// a REORDERED OLDER upsert applies unconditionally. The job returns to the board, and
// persistJobsDelta then mirrors it, RESURRECTING THE ROW IN THE DATABASE.
//
// Harmless today: postgres_changes delivers in order. Live the moment Increment 2's
// Broadcast lands, because Broadcast is explicitly unordered AND publishes DELETE
// with a row_version. So this must be fixed BEFORE the Broadcast triggers are applied.
//
//   node scripts/test-jobs-delete-memory.mjs
import { applyJobPatch } from '../src/store/jobsMerge.js';
import * as tomb from '../src/store/jobTombstones.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const job = (id, rv, over = {}) => ({ id, _rv: rv, status: 'upcoming', ...over });
const ids = (r) => r.jobs.map((j) => j.id).sort();
const fresh = () => { tomb.__reset(); return tomb; };

// ── THE RESURRECTION BUG ─────────────────────────────────────────────────
{
  const t = fresh();
  // Delete j1 at version 10, then a reordered OLDER upsert (v9) arrives.
  const afterDelete = applyJobPatch([job('j1', 10)], [], ['j1'], t);
  ok('the delete applies', afterDelete.changed && afterDelete.jobs.length === 0);
  t.record('j1', 10);
  const late = applyJobPatch(afterDelete.jobs, [job('j1', 9)], [], t);
  ok('🔴 a REORDERED OLDER upsert does NOT resurrect the job', !late.changed && late.jobs.length === 0);
  ok('  ...and state identity is preserved (no re-render, no dirty save)', late.jobs === afterDelete.jobs);
}
{
  const t = fresh();
  t.record('j1', 10);
  ok('an upsert at exactly the delete version is refused', !applyJobPatch([], [job('j1', 10)], [], t).changed);
  ok('an upsert BELOW the delete version is refused', !applyJobPatch([], [job('j1', 3)], [], t).changed);
}

// ── but a genuine RE-CREATE must still land ──────────────────────────────
// A stale peer tab can legitimately re-POST a deleted job (manager tabs bypass the
// server sanitizer), and the row really does come back with a fresh row_version. If
// the tombstone were unconditional, this tab would hide a row the database holds —
// the local-absent/DB-present divergence that feeds the TOP_UP unique-index wedge.
{
  const t = fresh();
  t.record('j1', 10);
  const r = applyJobPatch([], [job('j1', 11)], [], t);
  ok('a STRICTLY NEWER upsert resurrects (converges on the DB)', r.changed && ids(r).join() === 'j1');
  ok('  ...and the tombstone is cleared', t.get('j1') === undefined);
  const again = applyJobPatch(r.jobs, [job('j1', 12)], [], t);
  ok('  ...so subsequent newer upserts also apply', again.changed);
}

// ── deletes are order-guarded too ────────────────────────────────────────
// Under Broadcast a tombstone at rv 600 can arrive AFTER a re-create at rv 601.
// Applying it would silently drop a LIVE job with the cursor already past it —
// nothing incremental would ever correct that.
{
  const t = fresh();
  t.record('j1', 600);
  const alive = applyJobPatch([], [job('j1', 601)], [], t);
  ok('re-create at 601 lands', alive.changed);
  t.record('j1', 600); // a late tombstone for the OLD delete
  const late = applyJobPatch(alive.jobs, [], ['j1'], t);
  ok('🔴 a LATE tombstone does NOT drop the newer live row', !late.changed && ids(late).join() === 'j1');
}
{
  const t = fresh();
  const r = applyJobPatch([job('j1', 5)], [], ['j1'], t);
  ok('a delete with no tombstone memory still applies', r.changed && r.jobs.length === 0);
}
{
  const t = fresh();
  t.record('j1', 700);
  const r = applyJobPatch([job('j1', 700)], [], ['j1'], t);
  ok('a tombstone at the SAME version as the held row applies (not strictly newer)', r.changed);
}

// ── behaviour that must not change ───────────────────────────────────────
{
  const t = fresh();
  const base = [job('a', 5), job('b', 5)];
  ok('a newer upsert on a HELD row still applies', applyJobPatch(base, [job('a', 6)], [], t).changed);
  ok('a stale upsert on a held row is still dropped', !applyJobPatch(base, [job('a', 4)], [], t).changed);
  ok('a duplicate upsert is still dropped', !applyJobPatch(base, [job('a', 5)], [], t).changed);
  ok('an unknown-id delete is still a no-op', !applyJobPatch(base, [], ['zzz'], t).changed);
  ok('a brand-new id still inserts', applyJobPatch(base, [job('c', 1)], [], t).changed);
  ok('malformed upserts are skipped', !applyJobPatch(base, [null, undefined, {}, 7], [], t).changed);
  ok('state identity preserved when nothing changed', applyJobPatch(base, [], [], t).jobs === base);
}
// The no-op default keeps the old behaviour for any caller that has not adopted the
// memory — which is what makes the 4th parameter safe to add ahead of every call site.
{
  const before = applyJobPatch([], [job('j1', 9)], []);
  ok('with NO tomb injected the guard degrades to the old behaviour', before.changed);
}

// ── the memory itself ────────────────────────────────────────────────────
{
  const t = fresh();
  t.record('j1', 10);
  ok('get returns the recorded version', t.get('j1') === 10);
  ok('get on an unknown id is undefined', t.get('nope') === undefined);
  t.clear('j1');
  ok('clear removes it', t.get('j1') === undefined);
  t.record('', 5);
  ok('an empty id is not recorded', t.__size().ids === 0);
  t.record('j2', 0);
  ok('version 0 is recorded (not treated as absent)', t.get('j2') === 0);
}
{
  const t = fresh();
  // Bounded: an account delete is ~4,935 ids; the cap is 20k. Flooding past it must
  // not grow without limit — the memory must not become its own leak.
  for (let i = 0; i < 25000; i += 1) t.record(`j${i}`, i);
  ok('id memory is bounded under a flood', t.__size().ids <= 20000);
  ok('  ...and the most recent entries survive', t.get('j24999') === 24999);
}
{
  const t = fresh();
  // The vacated recurrence slot: TOP_UP derives its tail from IN-MEMORY jobs, so
  // without this it re-mints into a slot the DB row still occupies under the partial
  // unique index — a 23505 that surfaces as a permanently re-sending delta.
  applyJobPatch([job('j1', 5, { seriesId: 'ser1', startAt: '2026-08-01T17:00:00.000Z' })], [], ['j1'], t);
  ok('deleting an occurrence remembers its recurrence slot', t.hasOcc('ser1', '2026-08-01T17:00:00.000Z'));
  ok('an unrelated slot is not remembered', !t.hasOcc('ser1', '2026-09-09T00:00:00.000Z'));
  ok('a one-off job records no slot', (() => {
    const t2 = fresh();
    applyJobPatch([job('j9', 5)], [], ['j9'], t2);
    return t2.__size().occ === 0;
  })());
}

console.log(`\njobs delete memory: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
