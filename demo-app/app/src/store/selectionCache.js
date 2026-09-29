// The memoization behind useSelector — extracted so it is unit-testable from plain
// node (store/index.jsx pulls in React), the same reason jobsMerge.js exists.
//
// ══ WHY THIS IS NOT A PERFORMANCE DETAIL ══════════════════════════════════════
//
// useSelector previously cached on OUTPUT-VALUE EQUALITY:
//
//     const next = selector(store.getSnapshot());
//     if (cache.has && isEqual(cache.value, next)) return cache.value;
//     cache = { has: true, value: next };
//     return next;
//
// With the default Object.is and ANY allocating selector — `s => s.jobs.filter(...)`,
// `s => ({ a: s.x })`, or even `s => s.reviews || {}` when the key is absent — `next`
// is a fresh reference every call, so `isEqual` always fails and the cache NEVER hits.
//
// React calls getSnapshot at least twice per render: once to render, and again
// post-commit to verify consistency. Getting a different reference the second time
// makes React force a re-render, which calls getSnapshot again, which allocates
// again... an infinite loop terminating in React error #185 / a white screen.
//
// And the "getSnapshot should be cached" development warning is STRIPPED FROM
// PRODUCTION BUILDS — so the first component to adopt useSelector with an ordinary
// `|| []` selector would white-screen production with no warning anywhere.
//
// ══ THE FIX ═══════════════════════════════════════════════════════════════════
//
// Key the cache on (snapshot, selector, isEqual) IDENTITY rather than on value
// equality. The same snapshot then returns the IDENTICAL reference no matter what the
// selector allocates, which is loop-proof by construction — the semantics
// `use-sync-external-store/shim/with-selector` provides, without adding a dependency
// React 19 does not need.
//
// `isEqual` still runs, but only across DIFFERENT snapshots, where it does the job it
// is actually for: keeping the previous reference when the content is unchanged, so a
// consumer does not re-render on an unrelated dispatch.
//
// Keying on `selector` too preserves parameterised selectors
// (`s => selectUserById(s, props.id)`): a new closure invalidates the cache, so a prop
// change can never serve a stale value.
//
// NOTE the risk profile this creates. It does not make every selector efficient — an
// allocating selector with the default comparer still re-renders on each store change,
// i.e. exactly today's useStore() behaviour. It makes the WORST case "no perf gain"
// instead of "white screen".

export function makeSelectionCache() {
  let has = false;
  let lastSnapshot;
  let lastSelector;
  let lastIsEqual;
  let lastValue;

  return function select(snapshot, selector, isEqual) {
    // Same inputs => the identical reference. This is the loop-breaker: React's
    // consistency re-check lands here and gets back exactly what it was given.
    if (has && lastSnapshot === snapshot && lastSelector === selector && lastIsEqual === isEqual) {
      return lastValue;
    }
    const next = selector(snapshot);
    // Across snapshots, keep the prior reference when the content is unchanged.
    const value = (has && lastIsEqual === isEqual && isEqual(lastValue, next)) ? lastValue : next;
    has = true;
    lastSnapshot = snapshot;
    lastSelector = selector;
    lastIsEqual = isEqual;
    lastValue = value;
    return value;
  };
}
