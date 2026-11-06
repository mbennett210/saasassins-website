// useSharedRead — React's side of lib/sharedRead (one read, many readers; UI_RULES §152).
//
//   const r = useSharedRead(key, reader, { enabled, paused, maxAgeMs, focusGapMs, intervalMs });
//   → { data, error, inFlight, at, refresh() }
//
//   key         what is asked (include the viewer and the scope); a new key is a new answer
//   reader      async () => data — the read itself; the latest one is used, never captured stale
//   enabled     false reads nothing and subscribes to nothing
//   paused      true keeps the last answer on screen but reads nothing (no connection: a
//               screen shows how old its answer is instead of dropping it)
//   maxAgeMs    on mount (a page view), an answer younger than this is reused rather than read
//   focusGapMs  the window regaining focus reads again once the answer is older than this
//   intervalMs  > 0: also read on this cadence while the tab is visible
// The connection returning always reads. `refresh()` reads now (Try again). Every caller of one
// key shares one read in flight and one answer.
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { refreshShared, sharedEntry, sharedVersion, subscribeShared } from '../lib/sharedRead';

export function useSharedRead(key, reader, { enabled = true, paused = false, maxAgeMs = 10000, focusGapMs = 15000, intervalMs = 0 } = {}) {
  const readerRef = useRef(reader);
  useEffect(() => { readerRef.current = reader; });
  const run = useCallback((age) => refreshShared(key, () => readerRef.current(), { maxAgeMs: age }), [key]);

  const subscribe = useCallback((fn) => (enabled ? subscribeShared(key, fn) : () => {}), [enabled, key]);
  const version = useSyncExternalStore(subscribe, () => (enabled ? sharedVersion(key) : 0));

  // A page view: read unless a fresh enough answer is already here (or on its way).
  const reads = enabled && !paused;
  useEffect(() => {
    if (reads) run(maxAgeMs);
  }, [reads, run, maxAgeMs]);

  // Focus, the connection returning, and the optional cadence.
  useEffect(() => {
    if (!reads) return undefined;
    const onFocus = () => run(focusGapMs);
    const onOnline = () => run(0);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    const id = intervalMs > 0
      ? setInterval(() => { if (document.visibilityState !== 'hidden') run(Math.floor(intervalMs / 2)); }, intervalMs)
      : null;
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      if (id) clearInterval(id);
    };
  }, [reads, run, focusGapMs, intervalMs]);

  const e = enabled && version >= 0 ? sharedEntry(key) : null;
  const refresh = useCallback(() => run(0), [run]);
  return {
    data: e ? e.data : undefined,
    error: e ? e.error : null,
    inFlight: !!(e && e.inflight),
    at: e ? e.at : 0,
    refresh,
  };
}

export default useSharedRead;
