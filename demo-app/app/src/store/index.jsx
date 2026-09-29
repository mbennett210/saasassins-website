import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { reducer, ACTIONS } from './reducer';
import { createExternalStore } from './externalStore';
import { makeSelectionCache } from './selectionCache';
import { loadState, saveState } from './persist';
import { INITIAL_STATE } from '../data/seed';
import { setOrgTimezone } from '../lib/dates';
import { isAuthConfigured } from '../lib/supabaseClient';
import { useSession } from '../auth/AuthProvider';
import { createSyncManager } from './sync';
import { selectCurrentUser } from './selectors';
import { reconcileSelf } from '../lib/teamApi';

// Holds the external STORE object (not the state value) so useStore/useSelector can
// each subscribe on their own terms — whole-snapshot or a selected slice.
const StoreCtx    = createContext(null);
const DispatchCtx = createContext(null);
const SyncStatusCtx = createContext('synced'); // 'synced' | 'saving' | 'offline'
// Point-in-time sync diagnostics getter for the support "Report an issue" packet
// (org_state CAS version, dirty flag, pending write count). Default (local mode /
// no provider) returns safe zeros. Not reactive — read at submit, not in render.
const SyncDiagnosticsCtx = createContext(() => ({ version: null, dirty: false, pending: 0 }));
// True once the COMPLETE jobs set is in memory. Windowed boot paints a recent window
// first (fast first paint), so anything that materializes occurrences from the loaded
// set — the Schedule TOP_UP sweep — must wait for this, or it would duplicate the
// not-yet-loaded tail. Defaults true so local (non-authed) mode never gates.
const JobsHydratedCtx = createContext(true);

// Local (no-Supabase) mode: hydrate from localStorage like the original
// prototype. Authed mode starts from a seed placeholder that the sync manager
// immediately replaces with the shared document (HYDRATE) before we render.
function initLocal() {
  const persisted = loadState();
  if (persisted && persisted.version === INITIAL_STATE.version) return persisted;
  return INITIAL_STATE;
}

function FullScreenLoader() {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14, background: 'var(--card-bg)',
      color: 'var(--primary)', fontFamily: 'inherit',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%',
        border: '3px solid var(--card-border)', borderTopColor: 'var(--primary)',
        animation: 'rfs-spin 0.8s linear infinite',
      }} />
      <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Loading your workspace…</div>
      <style>{'@keyframes rfs-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}

export function StoreProvider({ children }) {
  const authed = isAuthConfigured();
  const { user } = useSession();

  // State lives in a plain external store, observed via useSyncExternalStore. Lazy
  // useState initialiser (not a ref) so the store is created exactly once with a
  // stable identity and is safe to read during render — StrictMode may invoke the
  // initialiser twice, but only one store is ever retained and it has no side effects.
  const [store] = useState(() => createExternalStore(authed ? INITIAL_STATE : initLocal(), reducer));
  // Whole-snapshot subscription — identical semantics to the previous useReducer state,
  // so this step is behaviour-preserving. Components migrate to useSelector one at a
  // time from here (each an independently revertible commit).
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // Raw dispatch, reserved for the sync manager's HYDRATE/RESET (never recorded).
  const dispatch = store.dispatch;
  const [ready, setReady] = useState(!authed);
  const [syncStatus, setSyncStatus] = useState('synced');
  // Authed mode starts un-hydrated (the sync manager flips it true when the full jobs
  // set lands); local mode has all jobs synchronously from localStorage.
  const [jobsHydrated, setJobsHydrated] = useState(!authed);

  // Point the date layer at the org's timezone so scheduling resolves at the SITE's
  // wall clock rather than each user's (a VA in Manila was booking jobs a day early
  // — see the contract in lib/dates.js). Assigned during render, not in an effect,
  // so it is in place before any child reads a date; lib/dates cannot reach store
  // state itself because store/reducer.js already imports it. Idempotent.
  //
  // The INITIAL_STATE fallback is load-bearing: company.timezone has never been read
  // by anything, so the live org_state blob may predate the key entirely. Reading
  // undefined would silently revert to device-local — i.e. ship the fix inert.
  setOrgTimezone(state.company?.timezone || INITIAL_STATE.company?.timezone);

  // NOTE: the old `stateRef` (assigned in an effect) is gone. store.getSnapshot() is
  // always current, so the sync manager no longer reads a state that lags the latest
  // dispatch by one render — a real staleness window that existed on every save path.
  const pendingRef = useRef([]);
  const syncRef = useRef(null);
  const reconciledRef = useRef(false); // orphan self-heal runs at most once per session

  // Stable point-in-time reader of sync internals for the support diagnostic
  // packet — reads the refs at call time, so it never subscribes/re-renders and
  // is safe as a stable context value. Zeros in local mode (no sync manager).
  const getSyncDiagnostics = useCallback(() => {
    const d = syncRef.current?.getDiagnostics?.() || {};
    return {
      version: typeof d.version === 'number' ? d.version : null,
      dirty: !!d.dirty,
      pending: pendingRef.current.length,
    };
  }, []);

  // Components dispatch through this. In authed mode it records user actions so
  // the sync manager can replay them on top of a remote write (conflict-safe),
  // and pings the manager to schedule a save. Raw `dispatch` is reserved for the
  // sync manager's own HYDRATE/RESET, which must NOT be recorded or re-saved.
  const dispatchLocal = useCallback((action) => {
    if (authed && action && action.type !== ACTIONS.HYDRATE && action.type !== ACTIONS.RESET) {
      pendingRef.current.push(action);
    }
    dispatch(action);
    if (syncRef.current) syncRef.current.notifyChange();
  }, [authed]);

  // Dev-only console hook for driving the store in local verification sessions
  // (e.g. dispatching RECEIVE_EMAIL to exercise inbound paths that have no UI
  // trigger). DEV-gated — dead-code-eliminated from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    window.__ppDispatch = dispatchLocal;
    window.__ppGetState = () => store.getSnapshot();
    return () => { delete window.__ppDispatch; delete window.__ppGetState; };
  }, [dispatchLocal]);

  // Authed mode: boot the shared-state sync once we have a signed-in user.
  const uid = user?.id;
  const email = user?.email;
  // The TAMPER-PROOF identity + role from the JWT app_metadata claim (the same
  // trust root every server gate reads). Threaded into the sync manager so the
  // CLIENT resolves who-you-are and what-you-may-do from the claim, not from the
  // browser-writable blob roster — a valid claim can then never be locked out by
  // a missing/renamed roster row or a stale blob role (2026-08-03 incident).
  // Claim deps mean a mid-session token refresh that carries a new role re-stamps.
  const claimRole = user?.app_metadata?.role ?? null;
  const claimOrgUserId = user?.app_metadata?.org_user_id ?? null;
  useEffect(() => {
    if (!authed || !uid) return undefined;
    setJobsHydrated(false); // new session/manager — hold TOP_UP until its full set lands
    const mgr = createSyncManager({
      dispatch,
      getState: () => store.getSnapshot(),
      getPending: () => pendingRef.current,
      clearPending: () => { pendingRef.current = []; },
      // Restore an offline-cached pending queue so unsaved edits survive a reload
      // during an outage and replay on reconnect.
      setPending: (actions) => { pendingRef.current = Array.isArray(actions) ? actions : []; },
      userId: uid,
      sessionEmail: email,
      claimOrgUserId,
      claimRole,
      onStatus: setSyncStatus,
      onJobsReady: () => setJobsHydrated(true),
    });
    syncRef.current = mgr;
    let alive = true;
    mgr.start()
      .then(() => { if (alive) setReady(true); })
      .catch((e) => {
        console.error('[store] initial sync failed:', e?.message || e);
        if (alive) setReady(true); // fail open onto the seed so the app is usable
      });
    return () => { alive = false; mgr.stop(); syncRef.current = null; };
  }, [authed, uid, email, claimOrgUserId, claimRole]);

  // Orphan self-heal: if this session resolved its identity from the JWT claim
  // ALONE (no roster row — the 2026-08-03 lockout class), ask the server to
  // materialize the missing roster row from the claim. Once per session,
  // fire-and-forget; a successful server write bumps org_state_signal, so the
  // repaired roster arrives over Realtime and __fromClaim clears itself.
  useEffect(() => {
    if (!authed || !ready) return undefined;
    const me = selectCurrentUser(store.getSnapshot());
    if (me?.__fromClaim && !reconciledRef.current) {
      reconciledRef.current = true;
      reconcileSelf().catch(() => { reconciledRef.current = false; }); // allow one retry next load
    }
    return undefined;
  }, [authed, ready, uid]);

  // Local mode only: persist to localStorage on every change (legacy behavior).
  const firstRender = useRef(true);
  useEffect(() => {
    if (authed) return;
    if (firstRender.current) { firstRender.current = false; return; }
    saveState(state);
  }, [state, authed]);

  if (!ready) return <FullScreenLoader />;

  return (
    <StoreCtx.Provider value={store}>
      <DispatchCtx.Provider value={dispatchLocal}>
        <SyncStatusCtx.Provider value={syncStatus}>
          <SyncDiagnosticsCtx.Provider value={getSyncDiagnostics}>
            <JobsHydratedCtx.Provider value={jobsHydrated}>
              {children}
            </JobsHydratedCtx.Provider>
          </SyncDiagnosticsCtx.Provider>
        </SyncStatusCtx.Provider>
      </DispatchCtx.Provider>
    </StoreCtx.Provider>
  );
}

// Live sync status of the shared store: 'synced' | 'saving' | 'offline'.
// Always 'synced' in local-only mode.
export function useSyncStatus() {
  return useContext(SyncStatusCtx);
}

// Point-in-time sync internals (org_state CAS version, dirty flag, pending write
// count) for the support diagnostic packet. Returns a STABLE getter — call it at
// submit time; it does not subscribe, so it never re-renders the caller.
export function useSyncDiagnostics() {
  return useContext(SyncDiagnosticsCtx);
}

// True once the full jobs set is loaded (see JobsHydratedCtx). Consumers that
// materialize occurrences from the loaded set (Schedule's TOP_UP) must gate on this.
export function useJobsHydrated() {
  return useContext(JobsHydratedCtx);
}

// Whole-snapshot subscription. Re-renders on EVERY state change — identical to the
// previous Context behaviour, so existing callers are unaffected. Prefer useSelector
// in hot components (inbox, chrome, bell, dashboard, schedule): with per-row realtime
// patches arriving continuously after decomposition, whole-snapshot subscribers become
// the dominant render cost.
export function useStore() {
  const store = useContext(StoreCtx);
  if (store === null) throw new Error('useStore must be used inside <StoreProvider>');
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

// Subscribe to a DERIVED slice: re-renders only when the selected value changes.
//
// The cache is required, not an optimisation: useSyncExternalStore calls getSnapshot
// during render and will loop forever if it returns a fresh object each time. We hold
// the last selected value per component instance and return the SAME reference while
// isEqual says it is unchanged.
//
// Pass a shallow comparer when selecting a freshly-built object/array
// (e.g. useSelector(s => s.jobs.filter(...), shallowEqual)); the default Object.is is
// correct for primitives and for slices returned by reference.
export function useSelector(selector, isEqual = Object.is) {
  const store = useContext(StoreCtx);
  if (store === null) throw new Error('useSelector must be used inside <StoreProvider>');
  const cache = useRef(null);
  if (cache.current === null) cache.current = makeSelectionCache();
  const getSelection = useCallback(
    () => cache.current(store.getSnapshot(), selector, isEqual),
    [store, selector, isEqual],
  );
  return useSyncExternalStore(store.subscribe, getSelection);
}

// Shallow equality for selectors that build a new object/array each call.
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

export function useDispatch() {
  const d = useContext(DispatchCtx);
  if (d === null) throw new Error('useDispatch must be used inside <StoreProvider>');
  return d;
}

// Convenience — select a slice via a selector function. Re-renders on every state change
// (acceptable for a localStorage-scale prototype; swap for memoized selector libs if needed).
export function useSelect(selector) {
  const s = useStore();
  return selector(s);
}

// Read state IMPERATIVELY, without subscribing. Returns a stable getter.
//
// ══ WHY THIS IS NEEDED FOR THE 0.4 MIGRATION ═════════════════════════════════
// useSelector covers reads whose value should drive a re-render. It cannot cover the
// other half: reads inside EVENT HANDLERS — a drag-drop resolving conflicts, a save
// composing a patch, a confirm handler checking what it is about to touch. Those need
// the current state at call time, not a subscription, and before this the only way to
// get it was useStore(), which re-subscribes the component to the whole snapshot and
// undoes the entire point of migrating.
//
// That gap is why several hot pages were stuck on useStore() with no path forward:
// Schedule, for instance, reads state in seven handlers.
//
// SAFE BY CONSTRUCTION: the store is created once with a stable identity (the lazy
// useState initialiser above), so getSnapshot is referentially stable and can be used
// in a dependency array without re-running effects. It does NOT call
// useSyncExternalStore, so a component using only this never re-renders on dispatch.
//
// ⚠️ Do not read this DURING RENDER to produce output — the value is not tracked, so
// the component will not update when it changes. Render from useSelector; use this
// only in callbacks, effects, and event handlers.
export function useGetState() {
  const store = useContext(StoreCtx);
  if (store === null) throw new Error('useGetState must be used inside <StoreProvider>');
  return store.getSnapshot;
}

export { ACTIONS } from './reducer';
