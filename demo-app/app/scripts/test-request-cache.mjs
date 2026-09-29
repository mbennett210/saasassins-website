// Per-request memoization — §8 G2 (E5).
//
// readOrgState pulls the ~900 KB blob and is called from 20 files; a single QC request
// resolved crew scope six times, each a full fetch.
//
// ⚠️ THE DANGEROUS VERSION OF THIS IS A MODULE-LEVEL TTL CACHE. Vercel reuses warm
// instances across requests, so a TTL cache would serve one user a snapshot fetched
// during ANOTHER user's request — and org_state is the authorization source. On the
// write path it is worse: writeOrgStateFromClient CASes on `version`, so a cached
// version from a prior request either spuriously conflicts or commits against a
// baseline that has already moved.
//
// These tests pin the properties that make the request-scoped version safe: isolation
// between contexts, pass-through with NO caching outside a context, invalidation on
// write, and no caching of rejections.
//
//   node scripts/test-request-cache.mjs
import { withRequestCache, cached, invalidate, __inContext } from '../api/_lib/requestCache.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── inside a request: one fetch, shared ──────────────────────────────────
await withRequestCache(async () => {
  let calls = 0;
  const fetchIt = async () => { calls += 1; return { v: calls }; };
  const a = await cached('k', fetchIt);
  const b = await cached('k', fetchIt);
  const c = await cached('k', fetchIt);
  ok('three reads in one request perform ONE fetch', calls === 1);
  ok('  ...and all callers get the same value', a === b && b === c);
});

// Concurrent callers must share the in-flight promise, not race two fetches.
await withRequestCache(async () => {
  let calls = 0;
  const slow = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return calls; };
  const [x, y] = await Promise.all([cached('k', slow), cached('k', slow)]);
  ok('CONCURRENT callers share one in-flight fetch', calls === 1);
  ok('  ...and both resolve to it', x === y);
});

// ── 🔴 isolation between requests ────────────────────────────────────────
// This is the property a module-level cache does not have, and the reason it would
// be an authorization bug rather than a perf nit.
{
  let calls = 0;
  const fetchIt = async () => { calls += 1; return calls; };
  const r1 = await withRequestCache(() => cached('k', fetchIt));
  const r2 = await withRequestCache(() => cached('k', fetchIt));
  ok('a SECOND request does not see the first request\'s cache', calls === 2);
  ok('  ...and gets its own fresh value', r1 === 1 && r2 === 2);
}
// Nested/interleaved contexts must not bleed either.
{
  let calls = 0;
  const fetchIt = async () => { calls += 1; return calls; };
  await withRequestCache(async () => {
    await cached('k', fetchIt);
    await withRequestCache(async () => { await cached('k', fetchIt); });
    await cached('k', fetchIt); // still the outer context's value
  });
  ok('an inner context does not clobber the outer one', calls === 2);
}

// ── outside a request: pass-through, never cached ───────────────────────
// This is what makes the cache safe to adopt route by route: an un-wrapped route is
// exactly as correct as before, just uncached.
{
  ok('no context is detectable', __inContext() === false);
  let calls = 0;
  const fetchIt = async () => { calls += 1; return calls; };
  await cached('k', fetchIt);
  await cached('k', fetchIt);
  ok('outside a request NOTHING is cached (always correct)', calls === 2);
  ok('invalidate outside a request does not throw', (() => { invalidate('k'); return true; })());
}

// ── invalidation on write ───────────────────────────────────────────────
// A request that commits org_state and then reads it again must NOT get its own
// pre-write snapshot.
await withRequestCache(async () => {
  let version = 1;
  const read = async () => ({ version });
  const first = await cached('orgState', read);
  ok('pre-write read is cached', first.version === 1);
  version = 2;                       // a write happened
  const stale = await cached('orgState', read);
  ok('  ...still cached before invalidate', stale.version === 1);
  invalidate('orgState');
  const after = await cached('orgState', read);
  ok('🔴 after invalidate the re-read sees the WRITE, not the snapshot', after.version === 2);
});

// ── rejections are not cached ───────────────────────────────────────────
// A transient failure must not poison the rest of the request.
await withRequestCache(async () => {
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) throw new Error('transient'); return 'ok'; };
  let threw = false;
  try { await cached('k', flaky); } catch { threw = true; }
  ok('the first call rejects', threw);
  const second = await cached('k', flaky);
  ok('a rejection is NOT cached — the retry succeeds', second === 'ok');
  ok('  ...and it really did re-invoke', calls === 2);
});

// ── keys are independent ────────────────────────────────────────────────
await withRequestCache(async () => {
  let a = 0; let b = 0;
  await cached('a', async () => { a += 1; return a; });
  await cached('b', async () => { b += 1; return b; });
  await cached('a', async () => { a += 1; return a; });
  ok('distinct keys do not share an entry', a === 1 && b === 1);
});

console.log(`\nrequest cache: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
