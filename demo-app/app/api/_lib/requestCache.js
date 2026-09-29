// Per-REQUEST memoization for server helpers — §8 G2.
//
// THE PROBLEM: `readOrgState()` pulls the ~900 KB blob and is called from 20 files
// with no caching. A single QC request resolves crew scope six times; the org_state
// write path reads it again after committing; `resolveJobContext` is reached from
// three entry points in one module. Each is a full blob fetch across the wire.
//
// ── WHY NOT A MODULE-LEVEL CACHE WITH A TTL ───────────────────────────────────
// That is the obvious version and it is WRONG here. Vercel reuses a warm instance
// across requests, so a TTL cache would serve one user's request a blob snapshot
// fetched during someone else's — and org_state is the authorization source. A stale
// read on the write path is worse: `writeOrgStateFromClient` CASes on `version`, and
// a cached version from a previous request would either spuriously conflict or, if
// paired with a cached state, commit against a baseline that has already moved.
//
// So the cache is scoped to ONE request by AsyncLocalStorage. Outside a context it
// degrades to a straight pass-through — always correct, just uncached — which is what
// makes it safe to adopt route by route rather than in one sweep.
//
// It caches the PROMISE, not the resolved value, so two concurrent callers in the
// same request share a single in-flight fetch instead of racing two.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

// Run `fn` with a fresh cache. Wrap a route handler in this to opt it in.
export function withRequestCache(fn) {
  return als.run(new Map(), fn);
}

// Memoize `fn` under `key` for the current request. No context => no caching.
export function cached(key, fn) {
  const store = als.getStore();
  if (!store) return fn();
  if (!store.has(key)) {
    const p = Promise.resolve().then(fn);
    // A rejection must not be cached — the next caller in this request should be able
    // to retry rather than inherit a failure that may have been transient.
    p.catch(() => { if (store.get(key) === p) store.delete(key); });
    store.set(key, p);
  }
  return store.get(key);
}

// Drop a memoized entry. REQUIRED after any write that invalidates it — a request
// that commits org_state and then re-reads must not get its own pre-write snapshot.
export function invalidate(key) {
  als.getStore()?.delete(key);
}

export const ORG_STATE_KEY = 'orgState';

// Test-only visibility.
export function __inContext() { return !!als.getStore(); }
