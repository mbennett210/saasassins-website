import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { reducer, ACTIONS } from './reducer';
import { createExternalStore } from './externalStore';
import { makeSelectionCache } from './selectionCache';
import { loadState, saveState } from './persist';
import { INITIAL_STATE } from '../data/seed';
import { setOrgTimezone, startOfDayKey, addDaysKey } from '../lib/dates';
import { isAuthConfigured } from '../lib/supabaseClient';
import { useSession } from '../auth/AuthProvider';
import { createSyncManager } from './sync';
import { mergeSyncProblems } from './syncProblems';
import { selectCurrentUser } from './selectors';
import { reconcileSelf } from '../lib/teamApi';
import BootScreen from '../components/BootScreen';

// Holds the external STORE object (not the state value) so useStore/useSelector can
// each subscribe on their own terms — whole-snapshot or a selected slice.
const StoreCtx    = createContext(null);
const DispatchCtx = createContext(null);
const SyncStatusCtx = createContext('synced'); // 'synced' | 'saving' | 'offline' | 'error' (CS-009)
// Point-in-time sync diagnostics getter for the support "Report an issue" packet
// (org_state CAS version, dirty flag, pending write count). Default (local mode /
// no provider) returns safe zeros. Not reactive — read at submit, not in render.
const SyncDiagnosticsCtx = createContext(() => ({ version: null, dirty: false, pending: 0 }));
// True once the jobs BASELINE is in memory: the cleans in the window (src/lib/jobsWindow.js,
// −45/+100 days) and every series master, loaded from the table — the moment a schedule edit
// can be saved (the per-row mirror waits for it). The app never holds the whole table any more
// (CS-676): a screen that needs more asks for it (JobsLoaderCtx below). Defaults true so local
// (non-authed) mode never gates.
const JobsHydratedCtx = createContext(true);
// Jobs beyond the window, on demand (CS-676): a date range, one series, one customer's cleans,
// some ids. Each `ensure*` resolves once they are in state and rejects when they could not be
// read; `is*Loaded` answers now. `epoch` moves each time the baseline (re)loads — a screen
// keys its asks on it, so it asks again after a reload let the extra rows go. Local mode holds
// every job, so everything is loaded at once.
// `adoptServerJobs(rows, { rescope })` (QR Wave 2): rows a server route wrote and answered with,
// applied at once as the server's own (the sync manager's; in local mode the store applies them).
const LOCAL_JOBS_LOADER = Object.freeze({
  ensureRange: () => Promise.resolve(),
  ensureSeries: () => Promise.resolve(),
  ensureClient: () => Promise.resolve(),
  ensureIds: () => Promise.resolve(),
  adoptServerJobs: () => Promise.resolve(),
  isRangeLoaded: () => true,
  isSeriesLoaded: () => true,
  isClientLoaded: () => true,
  epoch: 0,
});
const JobsLoaderCtx = createContext(LOCAL_JOBS_LOADER);
// A save problem the person must be TOLD about, not just shown as a status: the changes the
// server refused, each with its reason (CS-008), or the shared record over its size limit
// (CS-009). `components/SyncProblemDialog` shows it as a blocking message until dismissed.
// Null when there is nothing to say (always, in local mode).
const SyncProblemCtx = createContext({ problem: null, dismiss: () => {} });

// Local (no-Supabase) mode: hydrate from localStorage like the original
// prototype. Authed mode starts from a seed placeholder that the sync manager
// replaces with the shared document (HYDRATE); until it has, the store renders the
// boot screen and nothing else. 🔴 CS-672: that placeholder is the DEMO's book, so a
// first load that fails or is slow never "opens anyway" on it — see the effect below.
function initLocal() {
  const persisted = loadState();
  if (persisted && persisted.version === INITIAL_STATE.version) return persisted;
  return INITIAL_STATE;
}

export function StoreProvider({ children }) {
  const authed = isAuthConfigured();
  const { user, signOut } = useSession();

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
  // The first load's phase for the boot screen (CS-672): loading → slow → unreachable, reported
  // by the sync manager (onBoot). `bootKey` restarts the boot after a start() that failed outright.
  const [boot, setBoot] = useState({ phase: 'loading' });
  const [bootKey, setBootKey] = useState(0);
  const [syncStatus, setSyncStatus] = useState('synced');
  const [syncProblem, setSyncProblem] = useState(null);
  const dismissSyncProblem = useCallback(() => setSyncProblem(null), []);
  const syncProblemValue = useMemo(
    () => ({ problem: syncProblem, dismiss: dismissSyncProblem }),
    [syncProblem, dismissSyncProblem],
  );
  // Authed mode starts un-hydrated (the sync manager flips it true when the jobs window
  // lands); local mode has all jobs synchronously from localStorage.
  const [jobsHydrated, setJobsHydrated] = useState(!authed);
  const [jobsEpoch, setJobsEpoch] = useState(0);

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
    let alive = true;
    setJobsHydrated(false); // new session/manager — hold TOP_UP and job saves until its window lands
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
      onJobsReady: () => { setJobsHydrated(true); setJobsEpoch((e) => e + 1); },
      onProblem: (p) => setSyncProblem((prev) => mergeSyncProblems(prev, p)),
      onBoot: (b) => { if (alive) setBoot(b); },
    });
    syncRef.current = mgr;
    // start() settles once the company's data has loaded — from the device's cache, or a read
    // that answered (a failed or slow read keeps the boot screen and is retried by the manager).
    mgr.start()
      .then(() => { if (alive) setReady(true); })
      .catch((e) => {
        // 🔴 CS-672: NEVER ready on a failed start. This used to "fail open onto the seed" — the
        // demo's customers, schedule and pay, as the seed's Super Admin. The boot screen says the
        // server can't be reached, and its Retry starts the boot again from the top.
        console.error('[store] initial sync failed:', e?.message || e);
        if (alive) setBoot({ phase: 'unreachable', failed: true, retryAt: null, retrying: false });
      });
    return () => { alive = false; mgr.stop(); syncRef.current = null; };
  }, [authed, uid, email, claimOrgUserId, claimRole, bootKey]);

  // The jobs loader the screens use (JobsLoaderCtx): it asks the CURRENT sync manager, so a
  // remount (a new session or claim) never leaves a screen holding a stopped one. Its identity
  // moves with the epoch, so an effect keyed on it asks again after the baseline reloads.
  const jobsLoader = useMemo(() => {
    // Local mode holds every job and has no sync manager: a server-shaped answer (the demo's stubs)
    // is applied straight to the store, as the sync manager would apply the server's.
    if (!authed) {
      return {
        ...LOCAL_JOBS_LOADER,
        adoptServerJobs: (rows) => {
          const upserts = (Array.isArray(rows) ? rows : []).filter((j) => j && typeof j.id === 'string' && j.id);
          if (upserts.length) dispatch({ type: ACTIONS.PATCH_JOBS, upserts, deletes: [] });
          return Promise.resolve();
        },
      };
    }
    const notLoaded = () => Promise.reject(new Error('jobs not loaded'));
    return {
      ensureRange: (from, to) => (syncRef.current ? syncRef.current.ensureJobsRange(from, to) : notLoaded()),
      ensureSeries: (id) => (syncRef.current ? syncRef.current.ensureSeries(id) : notLoaded()),
      ensureClient: (id) => (syncRef.current ? syncRef.current.ensureClientJobs(id) : notLoaded()),
      ensureIds: (ids) => (syncRef.current ? syncRef.current.ensureJobsByIds(ids) : notLoaded()),
      adoptServerJobs: (rows, opts) => (syncRef.current ? syncRef.current.adoptServerJobs(rows, opts) : notLoaded()),
      isRangeLoaded: (from, to) => !!syncRef.current?.isRangeLoaded(from, to),
      isSeriesLoaded: (id) => !!syncRef.current?.isSeriesLoaded(id),
      isClientLoaded: (id) => !!syncRef.current?.isClientLoaded(id),
      epoch: jobsEpoch,
    };
  }, [authed, jobsEpoch]);

  // The boot screen's Retry (CS-672): a first read waiting on its back-off is tried at once; a
  // boot whose start() failed outright is started again (a new manager, from the top).
  const retryBoot = useCallback(() => {
    if (boot.failed || !syncRef.current) {
      setBoot({ phase: 'loading' });
      setBootKey((k) => k + 1);
      return;
    }
    syncRef.current.retryBoot();
  }, [boot.failed]);

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

  if (!ready) return <BootScreen boot={boot} onRetry={retryBoot} onSignOut={signOut} />;

  return (
    <StoreCtx.Provider value={store}>
      <DispatchCtx.Provider value={dispatchLocal}>
        <SyncStatusCtx.Provider value={syncStatus}>
          <SyncProblemCtx.Provider value={syncProblemValue}>
            <SyncDiagnosticsCtx.Provider value={getSyncDiagnostics}>
              <JobsHydratedCtx.Provider value={jobsHydrated}>
                <JobsLoaderCtx.Provider value={jobsLoader}>
                  {children}
                </JobsLoaderCtx.Provider>
              </JobsHydratedCtx.Provider>
            </SyncDiagnosticsCtx.Provider>
          </SyncProblemCtx.Provider>
        </SyncStatusCtx.Provider>
      </DispatchCtx.Provider>
    </StoreCtx.Provider>
  );
}

// Live sync status of the shared store: 'synced' | 'saving' | 'offline' (no answer: the edits
// wait on the device) | 'error' (the server answered and did not accept the save — CS-009).
// Always 'synced' in local-only mode.
export function useSyncStatus() {
  return useContext(SyncStatusCtx);
}

// The save problem waiting to be read ({ problem, dismiss }): see SyncProblemCtx.
export function useSyncProblem() {
  return useContext(SyncProblemCtx);
}

// Point-in-time sync internals (org_state CAS version, dirty flag, pending write
// count) for the support diagnostic packet. Returns a STABLE getter — call it at
// submit time; it does not subscribe, so it never re-renders the caller.
export function useSyncDiagnostics() {
  return useContext(SyncDiagnosticsCtx);
}

// True once the jobs window is loaded and job saves can land (see JobsHydratedCtx). It is NOT
// "every job is loaded" — nothing ever is; a screen that needs cleans beyond the window loads
// them (useJobsRange / useSeriesJobs / useClientJobs, or useJobsLoader for a handler).
export function useJobsHydrated() {
  return useContext(JobsHydratedCtx);
}

// The jobs loader (see JobsLoaderCtx) — for an event handler that must load a series or a
// range before it acts (await loader.ensureSeries(id), then dispatch).
export function useJobsLoader() {
  return useContext(JobsLoaderCtx);
}

// Shared by the three hooks below: ask once per (what, epoch), report { ready, loading, error,
// retry }. `isLoaded()` answers synchronously, so a screen already covered never flashes a
// loading state. `key` must be stable across renders for the same ask (a range built from
// Date.now() in render would ask on every render — pass day boundaries or memoize).
function useJobsAsk(key, isLoaded, ask) {
  const loader = useJobsLoader();
  const [tried, setTried] = useState({ key: null, status: 'idle', error: null });
  const [attempt, setAttempt] = useState(0);
  const loadedNow = key == null || isLoaded(loader);
  useEffect(() => {
    if (key == null || isLoaded(loader)) return undefined;
    let alive = true;
    setTried({ key, status: 'loading', error: null });
    ask(loader).then(
      () => { if (alive) setTried({ key, status: 'ready', error: null }); },
      (e) => { if (alive) setTried({ key, status: 'error', error: e }); },
    );
    return () => { alive = false; };
    // isLoaded / ask are closures over `key`; the ask re-runs when key, the loader (its epoch)
    // or a retry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, key, attempt]);
  const ready = loadedNow || (tried.key === key && tried.status === 'ready');
  const error = !ready && tried.key === key ? tried.error : null;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ready, loading: !ready && !error, error, retry };
}

// Every clean that starts in [fromMs, toMs) is in state (CS-676): a past week on the Schedule,
// a report's day, the days a time-off booking covers. Null bounds ask for nothing (ready).
export function useJobsRange(fromMs, toMs) {
  const from = Number.isFinite(fromMs) ? Math.floor(fromMs) : null;
  const to = Number.isFinite(toMs) ? Math.ceil(toMs) : null;
  const key = from != null && to != null && to > from ? `range:${from}:${to}` : null;
  return useJobsAsk(key, (l) => l.isRangeLoaded(from, to), (l) => l.ensureRange(from, to));
}

// The same for org-zone calendar days (YYYY-MM-DD, `toKey` inclusive) — a time-off booking's
// days, a report's day, the day a punch is entered for — padded a day each side, so a clean
// starting just past midnight in another zone is in. A key that isn't a day asks for nothing.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function useJobsDays(fromKey, toKey = fromKey) {
  const ok = DAY_KEY_RE.test(fromKey || '') && DAY_KEY_RE.test(toKey || '') && toKey >= fromKey;
  return useJobsRange(
    ok ? startOfDayKey(addDaysKey(fromKey, -1)).getTime() : null,
    ok ? startOfDayKey(addDaysKey(toKey, 2)).getTime() : null,
  );
}

// Every occurrence of one series is in state — what a whole-series edit or delete needs.
export function useSeriesJobs(seriesId) {
  const key = seriesId ? `series:${seriesId}` : null;
  return useJobsAsk(key, (l) => l.isSeriesLoaded(seriesId), (l) => l.ensureSeries(seriesId));
}

// Every clean of one customer is in state — the customer page's history.
export function useClientJobs(clientId) {
  const key = clientId ? `client:${clientId}` : null;
  return useJobsAsk(key, (l) => l.isClientLoaded(clientId), (l) => l.ensureClient(clientId));
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
