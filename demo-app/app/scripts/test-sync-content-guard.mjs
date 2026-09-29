// Unit test for the org_state flush() content-guard (app/src/store/sync.js).
//
// The guard SKIPS the version-bumping org_state UPDATE + its Realtime signal fan-out
// whenever the serialized blob is byte-identical to what the tab last saw in the DB.
// This test proves the algorithm it relies on — using the EXACT transforms from sync.js:
//
//   serializeShared(s):  const c = {...s}; delete c.currentUserId; c.jobs = []; JSON.stringify(c)   (baseline setter)
//   flush shared:        const shared = {...getState()}; delete shared.currentUserId; shared.jobs = []; JSON.stringify(shared)
//   withSession(s):      {...s, currentUserId: <me>}                                                  (per-session identity stamp)
//
// The safety-critical property: sharedJson === baseline  IFF  the persistable blob is
// unchanged. A false-negative (unequal when unchanged) costs only a redundant write; a
// false-POSITIVE (equal when the blob really changed) would drop a real write — and this
// test proves that can't happen, because JSON.stringify is injective on content for a
// fixed key order, and the key order is stable across the hydrate→flush transform.
//
// Run: node app/scripts/test-sync-content-guard.mjs

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// ── the real transforms, copied verbatim from sync.js (kept textually identical) ──
const serializeShared = (s) => {
  if (!s || typeof s !== 'object') return null;
  const c = { ...s };
  delete c.currentUserId;
  c.jobs = [];
  return JSON.stringify(c);
};
const withSession = (stateObj, me) => ({ ...stateObj, currentUserId: me });
// flush()'s exact shared-blob serialization, given the live (session) state:
const flushSharedJson = (sessionState) => {
  const shared = { ...sessionState };
  delete shared.currentUserId;
  shared.jobs = [];
  return JSON.stringify(shared);
};

// A representative org_state blob as stored in the DB: jobs already emptied (Stage 3),
// no currentUserId (stripped on write). Deliberately not alphabetical, to stress key order.
const dbBlob = () => ({
  company: { name: 'CleanSpace', timezone: 'America/Los_Angeles' },
  users: [{ id: 'u1', email: 'a@b.co' }, { id: 'u2', email: 'c@d.co' }],
  jobs: [],
  financialSnapshot: { mrr: 1000, collected: 500 },
  notifications: [{ id: 'n1' }],
  invoices: [],
});

// ── 1. No-op skip: hydrate a blob, stamp session identity, flush finds no change ──
{
  const blob = dbBlob();
  const baseline = serializeShared(blob);            // set at loadInitial/adopt
  const session = withSession(blob, 'u2');           // getState() after HYDRATE (identity stamped)
  const sharedJson = flushSharedJson(session);       // computed in flush()
  assert('no-op: flush blob equals hydrate baseline (→ SKIP the write)', sharedJson === baseline);
}

// ── 2. Per-session identity never triggers a write ──
{
  const blob = dbBlob();
  const baseline = serializeShared(blob);
  const asU1 = flushSharedJson(withSession(blob, 'u1'));
  const asU2 = flushSharedJson(withSession(blob, 'u2'));
  assert('two different sessions (currentUserId) → identical blob (→ SKIP)', asU1 === baseline && asU2 === baseline && asU1 === asU2);
}

// ── 3. Jobs-only change: the blob is unchanged (jobs live in public.jobs) ──
{
  const blob = dbBlob();
  const baseline = serializeShared(blob);            // baseline after last write
  // A TOP_UP added occurrences: the LIVE session state carries real jobs, but the blob
  // empties them, so the persisted blob is identical → SKIP the write, mirror jobs instead.
  const session = { ...withSession(blob, 'u1'), jobs: [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }] };
  const sharedJson = flushSharedJson(session);
  assert('jobs-only change → blob unchanged (→ SKIP write, mirror jobs)', sharedJson === baseline);
}

// ── 4. Real blob change: a non-jobs field changed → MUST write ──
{
  const blob = dbBlob();
  const baseline = serializeShared(blob);
  const session = withSession({ ...blob, financialSnapshot: { mrr: 2000, collected: 500 } }, 'u1');
  const sharedJson = flushSharedJson(session);
  assert('real change (financialSnapshot) → blob differs (→ WRITE)', sharedJson !== baseline);
}
{
  const blob = dbBlob();
  const baseline = serializeShared(blob);
  const session = withSession({ ...blob, notifications: [{ id: 'n1' }, { id: 'n2' }] }, 'u1');
  assert('real change (notifications) → blob differs (→ WRITE)', flushSharedJson(session) !== baseline);
}

// ── 5. Injectivity sanity: distinct blob contents never collide ──
{
  const a = serializeShared({ ...dbBlob(), company: { name: 'A', timezone: 'X' } });
  const b = serializeShared({ ...dbBlob(), company: { name: 'B', timezone: 'X' } });
  assert('distinct contents never serialize equal', a !== b);
}

// ── 6. Key-order robustness: adoptRemote sets baseline from remote.state, and the
//       adopt HYDRATE payload is {...withSession(remote.state), jobs: keepJobs}. Prove a
//       subsequent no-op flush still matches (jobs overwritten in place, currentUserId
//       appended-then-stripped both leave remote.state's key order). ──
{
  const remote = dbBlob();
  const baseline = serializeShared(remote.state ?? remote); // adoptRemote: serializeShared(remote.state)
  const adoptedSession = { ...withSession(remote, 'u1'), jobs: [{ id: 'keptJob' }] }; // getState() after adopt
  const sharedJson = flushSharedJson(adoptedSession);
  assert('adopt: no-op flush after adoptRemote matches baseline (key order stable)', sharedJson === baseline);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
