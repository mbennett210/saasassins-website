// One read, many readers — the manager view's in-memory read cache (UI_RULES §152).
//
// The manager's nav carries count pills (Shift Check-in, Hours Approval, Client Requests,
// Supplies) and the manager Home shows the same figures on its tiles, and Shift check-in,
// Checklists today and the Schedule's Today view read the same day. Each surface asking on its
// own would read every figure twice on every page view. This store keys each read by what it
// asks (who is reading, whose buildings): a read already in flight is JOINED, never repeated,
// and an answer younger than the caller's `maxAgeMs` is reused. React reads it through
// hooks/useSharedRead (useSyncExternalStore), so every reader re-renders when an answer lands.
//
// PURE JS, node-safe: no React, no browser globals (test-shared-read.mjs drives it). Memory only,
// for this tab's session — never localStorage (II.7: a figure cache is not a store), and the key
// carries the viewer's id, so one login's answers are never another's.
//
// An entry: { data (undefined until the first answer), error (the last failed attempt, kept
// beside an older answer), at (ms of the last good answer), inflight (the read in progress),
// version (bumps on every change — the snapshot React compares) }.
const store = new Map();

function ensure(key) {
  let e = store.get(key);
  if (!e) {
    e = { key, data: undefined, error: null, at: 0, inflight: null, version: 0, subs: new Set() };
    store.set(key, e);
  }
  return e;
}

function emit(e) {
  e.version += 1;
  for (const fn of [...e.subs]) {
    try { fn(); } catch { /* a reader's re-render must not stop the others */ }
  }
}

// The entry for `key` (null before anything asked for it).
export function sharedEntry(key) {
  return store.get(key) || null;
}

// Be told when `key` changes. Returns the unsubscribe.
export function subscribeShared(key, fn) {
  const e = ensure(key);
  e.subs.add(fn);
  return () => { e.subs.delete(fn); };
}

// The version React compares (0 before anything asked).
export function sharedVersion(key) {
  return store.get(key)?.version || 0;
}

// Read `key` through `reader` — unless a read is already in flight (joined), or the last good
// answer is younger than `maxAgeMs` and nothing failed since (reused; 0 always reads). A failed
// read keeps the last good answer and records the error beside it. Resolves to the entry.
export function refreshShared(key, reader, { maxAgeMs = 0, now = Date.now() } = {}) {
  const e = ensure(key);
  if (e.inflight) return e.inflight;
  if (maxAgeMs > 0 && e.at && !e.error && now - e.at < maxAgeMs) return Promise.resolve(e);
  e.inflight = (async () => {
    try {
      // Through a microtask, so even a reader that throws synchronously settles AFTER
      // `e.inflight` is set (else the finally would run first and leave it set for good).
      const data = await Promise.resolve().then(reader);
      e.data = data;
      e.error = null;
      e.at = Date.now();
    } catch (err) {
      e.error = err instanceof Error ? err : new Error(String(err?.message || err));
    } finally {
      e.inflight = null;
      emit(e);
    }
    return e;
  })();
  emit(e);
  return e.inflight;
}

// Forget every answer (tests; nothing in the app needs it — keys carry the viewer).
export function clearShared() {
  store.clear();
}
