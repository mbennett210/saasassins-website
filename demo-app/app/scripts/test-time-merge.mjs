// Node unit test for the CLIENT-side offline merge (mergeBufferedPunches +
// entryFromPunch) — the logic that folds buffered offline punches into the fetched
// entries so the crew see their offline clock state without duplicates. Pure — the
// merge core takes punches as an argument (no IndexedDB). Run:
//   node scripts/test-time-merge.mjs   (from app/)
import { mergeBufferedPunches, entryFromPunch } from '../src/lib/timeMerge.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const IN_AT = '2026-07-14T14:00:00.000Z';
const OUT_AT = '2026-07-14T15:00:00.000Z';
const inPunch = (over = {}) => ({
  id: 'op_a', kind: 'in', userId: 'u1', jobId: 'j1',
  ctx: { siteName: 'HQ', userName: 'Marcus', clientId: 'c1', siteId: 's1' },
  assertedInAt: IN_AT, assertedOutAt: null, inLat: 47.5, inLng: -122.3,
  ...over,
});

// entryFromPunch maps a buffered punch to the server-row shape the UI reads.
{
  const e = entryFromPunch(inPunch());
  ok(e.id === 'op_a', 'entryFromPunch: id = punch id');
  ok(e.source === 'offline_replay', 'entryFromPunch: source = offline_replay');
  ok(e.pending_sync === true, 'entryFromPunch: pending_sync flag set');
  ok(e.status === 'in_progress', 'entryFromPunch: open punch → in_progress');
  ok(e.clock_in_at === IN_AT, 'entryFromPunch: clock_in_at = assertedInAt');
  ok(e.site_name === 'HQ', 'entryFromPunch: denormalized site_name from ctx');
}

// 1. buffered 'in' not yet on the server → synthesized entry appears.
{
  const out = mergeBufferedPunches([], [inPunch()], { userId: 'u1' });
  ok(out.length === 1 && out[0].id === 'op_a' && out[0].pending_sync === true, '1: buffered in-punch → synth entry present');
}

// 2. buffered 'in' already replayed (server row carries its client_punch_id) → de-duped.
{
  const server = [{ id: 'srv1', client_punch_id: 'op_a', clock_in_at: IN_AT, clock_out_at: OUT_AT }];
  const out = mergeBufferedPunches(server, [inPunch()], { userId: 'u1' });
  ok(out.length === 1 && out[0].id === 'srv1', '2: synced punch de-duped to the server row');
  ok(!out.some((e) => e.id === 'op_a'), '2: no duplicate synth entry');
}

// 3. buffered 'out' patches the matching OPEN server entry (clock-out captured offline).
{
  const server = [{ id: 'e1', client_punch_id: null, clock_in_at: IN_AT, clock_out_at: null, status: 'in_progress' }];
  const outPunch = { id: 'op_out', kind: 'out', userId: 'u1', entryId: 'e1', assertedOutAt: OUT_AT };
  const out = mergeBufferedPunches(server, [outPunch], { userId: 'u1' });
  const e1 = out.find((e) => e.id === 'e1');
  ok(e1.clock_out_at === OUT_AT, '3: out-punch patched clock_out_at onto the open entry');
  ok(e1.status === 'completed' && e1.pending_sync === true, '3: patched entry → completed + pending_sync');
  ok(e1.duration_minutes === 60, `3: duration computed (got ${e1.duration_minutes})`);
}

// 4. userId filter — a punch belonging to another crew member is excluded.
{
  const out = mergeBufferedPunches([], [inPunch({ userId: 'u2' })], { userId: 'u1' });
  ok(out.length === 0, '4: punch for a different user is excluded');
}

// 5. openOnly — a completed buffered in-punch is dropped from a who's-on-the-clock view.
{
  const out = mergeBufferedPunches([], [inPunch({ assertedOutAt: OUT_AT })], { openOnly: true });
  ok(out.length === 0, '5: openOnly drops a completed buffered punch');
}

console.log(`\noffline clock merge/dedup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
