// A plain external store (getSnapshot / subscribe / dispatch) that owns app state,
// observed from React via useSyncExternalStore.
//
// WHY (REMEDIATION_PLAN.md Increment 0.4 / SCALE-C06): state currently lives in a
// single useReducer behind one Context, so EVERY dispatch re-renders EVERY consumer —
// 88 files call useStore(). That is tolerable today only because writes are coarse
// (one blob save). Decomposition makes writes FINE-GRAINED: per-row realtime patches
// arriving continuously. Without this swap, Increments 3-9 would make rendering
// dramatically worse, not better — every inbound message would re-render the whole app.
//
// This module is deliberately framework-free and synchronous:
//   • getSnapshot() is ALWAYS current — unlike the previous stateRef, which lagged a
//     dispatch by one render because it was assigned in an effect. The sync manager
//     reads state through this, so that staleness window is now closed.
//   • dispatch() applies the SAME imported reducer, so reducer semantics are unchanged.
//   • A reducer that returns the identical state object is treated as a no-op: the
//     snapshot reference is preserved and listeners are NOT notified. This is what
//     lets useSyncExternalStore bail out, and it mirrors the guarantee the flush
//     content-guard already depends on (same ref ⇒ nothing to persist).

export function createExternalStore(initialState, reducer) {
  let state = initialState;
  const listeners = new Set();

  return {
    getSnapshot() { return state; },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    // Returns the resulting state so callers can act on it synchronously.
    dispatch(action) {
      const next = reducer(state, action);
      // No-op guard: identical reference ⇒ nothing changed ⇒ no re-render, no notify.
      if (next === state) return state;
      state = next;
      // Snapshot the listener set: a listener that subscribes/unsubscribes during
      // notification must not mutate the set we are iterating.
      for (const listener of Array.from(listeners)) {
        try { listener(); } catch { /* one bad subscriber must not stop the rest */ }
      }
      return state;
    },
  };
}
