// Unit test for the phase-aware slice registry (app/src/store/tableSlices.js),
// Increment 0.3 of REMEDIATION_PLAN.md.
//
// THE LOAD-BEARING ASSERTION: the registry-driven blob transform must be BYTE-
// IDENTICAL to the hardcoded-'jobs' transform it replaces. If it is not, the flush
// content-guard's baseline stops matching, every flush becomes a version-bumping
// UPDATE plus a Realtime fan-out to every connected client, and the entire
// write-frequency cut (f0530c3) silently regresses — on a meter that was 191% over.
//
// Run: node app/scripts/test-table-slices.mjs

import { PHASE, TABLE_SLICES, strippedSliceKeys, tableOwnedSliceKeys, isStripped, toSharedBlob, serializeSharedBlob } from '../src/store/tableSlices.js';
// The content guard's serializer is key-order-independent since 2026-09-03
// (lib/canonicalJson.js — see test-blob-canonical.mjs): org_state is jsonb, and a
// plain JSON.stringify of the live state never matched an adopted copy, so every
// flush was a no-op write. The "same transform" contracts below compare canonical
// output on BOTH sides — the content contract is unchanged, only the encoding.
import { canonicalJson } from '../src/lib/canonicalJson.js';

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// The EXACT transform sync.js used before the registry existed.
const legacyTransform = (s) => {
  const c = { ...s };
  delete c.currentUserId;
  c.jobs = [];
  return canonicalJson(c);
};

// A representative live-shaped state. Deliberately not alphabetical, to stress key order.
const liveState = () => ({
  company: { name: 'CleanSpace', timezone: 'America/Los_Angeles' },
  users: [{ id: 'u1' }, { id: 'u2' }],
  jobs: [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }],
  notifications: [{ id: 'n1' }],
  conversations: [{ id: 'c1' }],
  messages: [{ id: 'm1' }],
  invoices: [],
  currentUserId: 'u2',
  version: 49,
});

// ── 1. THE regression guard: registry output === legacy output, byte for byte ──
{
  const s = liveState();
  assert('registry blob is BYTE-IDENTICAL to the legacy hardcoded-jobs transform',
    serializeSharedBlob(s) === legacyTransform(s));
}

// ── 2. currentUserId is stripped; jobs emptied but the KEY is preserved ──
{
  const blob = toSharedBlob(liveState());
  assert('currentUserId stripped from the blob', !('currentUserId' in blob));
  assert('jobs emptied to [] (PRUNE-TO-[]-NEVER-DELETE-KEY)', Array.isArray(blob.jobs) && blob.jobs.length === 0);
  assert('jobs KEY still present — a deleted key would crash HYDRATE app-wide', 'jobs' in blob);
  assert('non-table slices pass through untouched', blob.notifications.length === 1 && blob.messages.length === 1);
}

// ── 3. Phase semantics: registering must NOT imply stripping ──
{
  assert('jobs is registered', tableOwnedSliceKeys().includes('jobs'));
  assert('jobs is pinned STRIPPED (matches what ships today)', isStripped('jobs'));
  assert('every stripped slice is also table-owned', strippedSliceKeys().every((k) => tableOwnedSliceKeys().includes(k)));
  // Simulate a newly-registered 'mirror' slice: table-owned (kept on adopt, mirrored
  // by the content guard) but NOT stripped from the blob.
  const mirrorOnly = [{ key: 'notifications', table: 'notifications', phase: PHASE.MIRROR }];
  const strippedOf = (reg) => reg.filter((x) => x.phase === PHASE.STRIPPED).map((x) => x.key);
  const ownedOf = (reg) => reg.map((x) => x.key);
  assert("a 'mirror' slice is table-owned but NOT stripped", ownedOf(mirrorOnly).includes('notifications') && !strippedOf(mirrorOnly).includes('notifications'));
}

// ── 4. Registry immutability — a slice must not be flipped to stripped at runtime ──
{
  let threw = false;
  try { TABLE_SLICES.push({ key: 'rogue', phase: PHASE.STRIPPED }); } catch { threw = true; }
  assert('TABLE_SLICES is frozen (no accidental runtime registration)', threw || TABLE_SLICES.length === 1);
}

// ── 5. Guard rails on bad input ──
{
  assert('null state serializes to null, never throws', serializeSharedBlob(null) === null);
  assert('a state missing the slice key still gets it emptied', Array.isArray(toSharedBlob({ a: 1 }).jobs));
}

// ── 6. Idempotence: re-serializing an already-stripped blob is stable ──
{
  const once = serializeSharedBlob(liveState());
  const twice = serializeSharedBlob(JSON.parse(once));
  assert('transform is idempotent (baseline re-serialization is stable)', once === twice);
}

// ── 7. freeze_strip — halts pruning without a deploy (rollback executability) ──
{
  const s = liveState();
  const frozen = toSharedBlob(s, ['jobs']);
  assert('a FROZEN slice is NOT emptied (blob copy survives for reverse-materialization)',
    Array.isArray(frozen.jobs) && frozen.jobs.length === 3);
  const unfrozen = toSharedBlob(s, []);
  assert('an unfrozen slice is still emptied as normal', unfrozen.jobs.length === 0);
  assert('freezing a slice CHANGES the serialized blob (so the guard must use one freeze list)',
    serializeSharedBlob(s, ['jobs']) !== serializeSharedBlob(s, []));
  assert('an unrelated freeze entry does not affect stripping',
    toSharedBlob(s, ['notifications']).jobs.length === 0);
  assert('freeze defaults are inert (undefined/null behave as no freeze)',
    serializeSharedBlob(s, undefined) === serializeSharedBlob(s, []) &&
    serializeSharedBlob(s, null) === serializeSharedBlob(s, []));
}

// ── 8. The baseline contract: both callers must pass the SAME freeze list ──
{
  const s = liveState();
  // serializeShared() (baseline) and flush()'s transform agree when freeze matches...
  assert('same freeze list → baseline matches flush transform (guard stays armed)',
    serializeSharedBlob(s, ['jobs']) === canonicalJson(toSharedBlob(s, ['jobs'])));
  // ...and provably diverge when it does not — the exact drift that would silently
  // disarm the content guard and turn every flush back into a fan-out write.
  assert('mismatched freeze list → baseline DRIFTS (documents why they share one value)',
    serializeSharedBlob(s, ['jobs']) !== canonicalJson(toSharedBlob(s, [])));
  // And the reason the encoding changed: equal content in a different key ORDER
  // must serialize identically (it did not under JSON.stringify — the no-op storm).
  const reordered = Object.fromEntries(Object.entries(s).reverse());
  assert('key order alone never disarms the guard', serializeSharedBlob(s) === serializeSharedBlob(reordered));
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
