// Shared-state sync manager. The whole app store is one JSONB document in
// Supabase (`org_state`), shared by every authenticated user. This manager:
//   • loads the document on start (seeding it from INITIAL_STATE on first run),
//   • saves local changes back, debounced, using an optimistic version check
//     (compare-and-swap) so we never silently clobber another user's write,
//   • listens on the tiny `org_state_signal` table via Realtime and pulls the
//     latest document when someone else changes it,
//   • on a CAS conflict (or an incoming remote change while we have unsaved
//     edits) it adopts the remote document and *replays* our pending actions on
//     top — because the app is a reducer, near-simultaneous edits to different
//     records both survive. Same-field edits are last-write-wins.
import { supabase } from '../lib/supabaseClient';
import { ACTIONS, reducer } from './reducer';
import { productionInitialState } from '../data/seed';
import {
  persistJobsDelta, fetchJobsInRange, fetchSeriesMasters, fetchSeriesJobs, fetchClientJobs, fetchJobsByIds, fetchJobsHighWater,
  fetchJobsSince, fetchJobDeletesSince, fetchJobDeletesByIds, nextJobsCursor, REAP_MARKER_ID, mergeFullJobs, maxRv, jobsInWindow,
  advanceBaseline, diffJobs,
} from './jobsSync';
import jobTombstones from './jobTombstones';
import { cacheDoc, cacheJobs, cacheQueue, cachePendingJobs, readCache } from './offlineCache';
import { toSharedBlob, serializeSharedBlob, tableOwnedSliceKeys } from './tableSlices';
import { canonicalJson } from '../lib/canonicalJson';
import { resolveCurrentUserId } from './identity';
import { isOfficeRole } from '../lib/roles';
import { APP_BUILD, TAB_ID, writeStamp } from '../lib/appBuild';
import { postOrgState, postSeedState, getStateView, getOwnJobsWindow } from '../lib/stateApi';
import { jobsWindowBounds } from '../lib/jobsWindow';

const ORG_ID =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLEANSPACE_ORG_ID) ||
  '00000000-0000-0000-0000-000000000001';
const SAVE_DEBOUNCE_MS = 600;

// ── CS-672: THE FIRST LOAD FAILS CLOSED ─────────────────────────────────────────────────────
// A signed-in store starts on INITIAL_STATE, which is the DEMO's book (fictional customers,
// schedule and pay, with the seed's Super Admin as "you"). With no offline cache on the device
// (every first sign-in, and every sign-in after a sign-out wiped it) the only thing worth showing
// is the server's copy, so until a read ANSWERS the store shows the boot screen and nothing else:
//   · the first read gets BOOT_SLOW_MS before the loader says it is taking longer than usual;
//   · a read that FAILS, or has no answer by BOOT_ATTEMPT_MS, shows "can't reach" and is tried
//     again after a growing back-off (BOOT_RETRY_BASE_MS doubling to BOOT_RETRY_MAX_MS) — at once
//     on the screen's Retry, the browser coming back online, or the app coming back into view;
//   · an attempt that ran out of time keeps running: if its answer lands later it still boots the
//     app, because a slow link (a ~3 MB record on a phone) must be able to finish;
//   · start() settles only once a read answered, and never rejects over a failed one.
// It used to wait 8 s, reject, and the store "failed open onto the seed".
export const BOOT_SLOW_MS = 8000;
export const BOOT_ATTEMPT_MS = 20000;
export const BOOT_RETRY_BASE_MS = 2000;
export const BOOT_RETRY_MAX_MS = 30000;
const BOOT_STOPPED = Symbol('boot stopped');

// ── sign-out flush hook ───────────────────────────────────────────────────────
// AuthProvider.signOut() wipes the offline cache — which is also the last copy
// of any not-yet-synced edit. Before it does, it calls this to push whatever is
// still local (dirty blob, pending queue, unmirrored jobs) through a final
// flush. Returns true when everything reached the server, false when something
// is still unsynced (the caller warns the user before destroying it). The
// active manager registers its flusher on start() and deregisters on stop();
// with no manager running there is nothing local to lose.
let activeFinalFlush = null;
let activeMarkCacheWipe = null;
export function flushSyncBeforeSignOut(timeoutMs = 15000) {
  if (!activeFinalFlush) return Promise.resolve(true);
  return Promise.race([
    activeFinalFlush(),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]).catch(() => false);
}
// Called by AuthProvider immediately BEFORE clearCache(). The 15s race above
// abandons finalFlush but cannot stop it — an in-flight flush pinned on a slow
// write settles AFTER the wipe and its persistCache would silently REPOPULATE
// IndexedDB (doc + queue + pending jobs) on a signed-out, possibly shared
// device. This flips a manager flag that no-ops every later persistCache (and
// any remaining finalFlush attempt) for the life of the instance.
export function markSyncCacheWipeForSignOut() {
  try { activeMarkCacheWipe?.(true); } catch { /* ignore */ }
}
// The undo, for the one path that needs it: auth.signOut itself FAILS (network
// down) after the wipe was marked — the user is still signed in on a running
// manager, and leaving persistence latched off would silently strip this
// session's offline resilience. The cache was already cleared; normal persists
// simply rebuild it.
export function unmarkSyncCacheWipeForSignOut() {
  try { activeMarkCacheWipe?.(false); } catch { /* ignore */ }
}

export function createSyncManager({ dispatch, getState, getPending, clearPending, setPending, userId, sessionEmail, claimOrgUserId = null, claimRole = null, onStatus, onJobsReady, onProblem, onBoot }) {
  // CS-002 crew READ SPLIT. A non-office login (crew, or a roleless orphan) holds only a
  // SERVER-BUILT PROJECTION of the blob and can no longer read org_state directly once the
  // read-split RLS lands. It reads through GET /api/state/view, polls the open
  // org_state_signal for the version, keeps the org_state_signal realtime subscription, and
  // its writes go to /api/state/org-state where the server MERGES only allowlisted changes
  // (never the posted projection, which would blank what it can't see). Office roles keep the
  // direct read path unchanged. It IS the server's split: lib/roles isOfficeRole reads the same
  // OFFICE_ROLES list api/_lib/authz.js serves the full blob to, so a new office tier (the supply
  // manager, S131) can never read as crew here while the server serves it the full blob — this
  // was a hand-kept owner/admin/manager list until then.
  const restrictedRead = !isOfficeRole(claimRole);
  let baseVersion = 0;
  let lastWrittenVersion = -1; // suppress our own realtime echo
  // Content-guard for the blob write. Holds the JSON of the org_state blob (jobs
  // emptied, currentUserId stripped) as this tab last knew it in the DB — set at every
  // point local state becomes equal to the stored doc (boot hydrate, adopt, successful
  // write). flush() compares against it and SKIPS the version-bumping UPDATE + its
  // Realtime signal fan-out when the blob is byte-identical. This is the primary cut for
  // the Realtime-message overage: no-op dispatches (the 60s financial-snapshot poll, a
  // due-less TOP_UP) and jobs-only changes (jobs live in public.jobs, never the blob)
  // stop signalling every connected client. null = write unconditionally (establishes it).
  let lastSavedStateJson = null;
  // Canonical serialization of the shared blob: strip the per-session currentUserId and
  // empty every STRIPPED slice. Both this and flush()'s transform now delegate to the
  // SAME helper in store/tableSlices.js — they are a contract, and any drift between
  // them silently disables the content guard (every flush becomes a version-bumping
  // write plus a Realtime fan-out to every client). Sharing one implementation is what
  // makes that drift impossible. A mismatched baseline can only ever cost one redundant
  // write, never a skipped real write.
  const serializeShared = (s) => serializeSharedBlob(s, freezeStrip);
  // B1 Stage 1: the last jobs array we mirrored to the public.jobs table. We diff
  // against it so only changed jobs are written per-row (not the whole 5k array).
  // Seeded from the table at boot, so the first save only writes real edits.
  // Best-effort; only advances on a successful mirror.
  let lastSyncedJobs = [];
  // Keyset cursor for the jobs backstop poll: the highest row_version this tab
  // has authoritatively fetched. CURSOR-OWNED-BY-FETCH — advanced only from a
  // fetch/poll, never from an unordered realtime patch (see jobsCursorPoll).
  let jobsCursor = 0;
  // ── THE JOBS BASELINE: A WINDOW, THEN WHAT A SCREEN ASKS FOR (CS-676) ─────────────────
  // jobsReady: the window of cleans (src/lib/jobsWindow.js, −45/+100 days) and every series
  // master have loaded from the table and are the mirror baseline. Until then the per-row
  // mirror waits (a save that raced the load would diff the live jobs against an empty
  // baseline and rewrite the table — the migration-era churn) and the cursor poll waits.
  // The app never loads the whole table: what a screen needs beyond the window it asks for
  // (ensureJobsRange / ensureSeries / ensureClientJobs / ensureJobsByIds below), and those rows
  // join state AND the baseline, so the diff stays exact. A whole-series edit needs every
  // occurrence of ITS series (UPDATE_JOB_SERIES / DELETE_JOB_SERIES build their target sets
  // from state.jobs), so its screen loads that series first — never the table.
  // windowSnapshot: on a boot from the device's cache, the cached cleans painted before the
  // server's answer; loadJobsBaseline merges the window onto them, keeping any edit, create
  // or delete made in the gap (mergeFullJobs). jobsBaselineLoading guards re-entrancy (a boot
  // and a refocus retry must not both run the merge).
  let jobsReady = false;
  let jobsBaselineLoading = false;
  // ONE pending retry for a failed baseline load: retried indefinitely with a capped backoff
  // (a slow link that can't finish the read in N tries would otherwise strand the schedule
  // un-savable — Lauren, ZA, 2026-08-12), through this one handle so the backoff chain and
  // resync()'s refocus/reconnect re-fire can never stack timers. Cleared on stop().
  let baselineRetryTimer = null;
  // What is loaded beyond single rows. `coverage`: half-open start_at stretches [from, to) in
  // ms whose every clean is in state. `loadedSeries` / `loadedClients`: every clean of that
  // series / customer is in state. Realtime and the cursor poll keep loaded rows current and
  // bring new ones (a top-up another tab minted), so a loaded set stays whole. `askedIds`:
  // ids asked for by id — after the ask, absent from state means gone, not "not loaded".
  let coverage = [];
  const loadedSeries = new Set();
  const loadedClients = new Set();
  const askedIds = new Set();
  // Requests in flight, by what they ask for, so two screens asking for the same thing share one.
  const jobsInflight = new Map();
  // Callers of ensure* waiting for the baseline: nothing joins state before it exists.
  let baselineWaiters = [];
  // Unmirrored jobs carried over from the PREVIOUS session's cache (see
  // cachePendingJobs). Stashed by bootFromCache, consumed once by
  // recoverCachedPendingJobs after the authoritative set lands.
  let cachedPendingJobsRows = null;
  let lastCachedPendingCount = 0;
  // True while recoverCachedPendingJobs is between consuming the stash and
  // settling (its tombstone lookup is an await) — the persist gate must treat
  // this exactly like a live stash, or a debounced flush / visibility persist
  // landing inside that window rewrites the pendingjobs record from the live
  // diff (which cannot contain the not-yet-dispatched rows) and destroys the
  // stash's only durable copy right before a deferral tries to keep it.
  let pendingRecoveryInFlight = false;
  // Sign-out wipe marker (see markSyncCacheWipeForSignOut): once true, every
  // persistCache is a no-op so an in-flight flush can't repopulate the cache
  // clearCache() just destroyed on a signed-out device.
  let persistAbandoned = false;
  let windowSnapshot = null;
  // The baseline landed: wake the ensure* callers waiting on it and tell the store (the UI's
  // useJobsHydrated: the schedule can be edited; and its epoch, which makes a screen ask again
  // for what it had loaded when a reload of the baseline dropped it).
  const signalJobsReady = () => {
    const waiters = baselineWaiters;
    baselineWaiters = [];
    for (const w of waiters) { try { w(); } catch { /* a waiter must never break the load */ } }
    try { onJobsReady?.(); } catch { /* ignore */ }
  };
  let started = false;
  // CS-672: true once the first load landed (from the device's cache or the server). Before it the
  // store renders the boot screen only, so nothing can have been edited — and nothing is saved.
  let loaded = false;
  // While a first read waits on its back-off: `bootRetryNow` tries it again at once (the boot
  // screen's Retry), `bootStop` ends the wait (stop()). Null otherwise.
  let bootRetryNow = null;
  let bootStop = null;
  // The boot's phase, for the boot screen (store/index.jsx → components/BootScreen):
  //   { phase: 'loading' } · { phase: 'slow' } · { phase: 'unreachable', retryAt, retrying }
  const reportBoot = (b) => { if (!started) return; try { onBoot?.(b); } catch { /* a report must never break the boot */ } };
  let saving = false;
  let dirty = false;
  // A peer-save signal that arrived while a flush was in flight. The handler
  // must not adopt mid-flush (double-apply — see subscribeSignal); it parks the
  // request here and the flush's finally resyncs once the save settles.
  let deferredSignalAdopt = false;
  let saveTimer = null;
  let backstopTimer = null; // periodic read-only version poll (see backstopPoll)
  // Reload at most ONCE per page-load when the fleet gate trips. Without this, a
  // misconfigured min_client_build (set above every deployed build) would put every
  // client into an infinite reload loop — a self-inflicted outage worse than the stale
  // tab the gate exists to prevent. After the first attempt we simply stop writing.
  let reloadedForBuildGate = false;
  let channel = null;      // org_state_signal realtime (non-jobs document)
  let jobsChannel = null;  // B1 Stage 2: public.jobs realtime (per-row job changes)
  let currentStatus = 'synced';
  const setStatus = (s) => { currentStatus = s; try { onStatus?.(s); } catch { /* ignore */ } };
  // Something the person must be TOLD about a save, not merely shown as a status: changes the
  // server refused (CS-008). The store turns it into a blocking message (SyncProblemDialog).
  const reportProblem = (p) => { try { onProblem?.(p); } catch { /* a report must never break a save */ } };

  // ── offline cache (Phase 2) ─────────────────────────────────────────────────
  // Mirror the last-known-good workspace into IndexedDB so a boot during a
  // Supabase outage loads real data instead of the blank seed, and offline edits
  // survive a reload. Throttled: the small doc + pending queue at most every 2 s;
  // the big jobs array only when it actually changed and at most every 10 s.
  // All best-effort — a cache failure never affects the online path.
  let lastDocCacheAt = 0;
  let lastJobsCacheAt = 0;
  let lastCachedJobsRef = null;
  let offlineSince = 0;      // >0 while saves are failing — used to back off retries
  // ── CS-009: A FAILED SAVE IS RETRIED, LATER, AND SAID ─────────────────────────────────
  // How many saves in a row have failed: the retry waits 5 s, then 10, 20, 40, and at most
  // 60 s (SAVE_RETRY_*), reset by a save that lands or the browser coming back online.
  // Before, a failed save "fell back" to a direct write the database has refused since
  // Increment 1e, read the empty answer as a conflict, and saved again in 600 ms — for ever,
  // under "Saving…". The edits stay pending (and in the offline cache) the whole time.
  let failStreak = 0;
  let tooLargeReported = false; // the 413 message is shown once per run of failures
  const SAVE_RETRY_BASE_MS = 5000;
  const SAVE_RETRY_MAX_MS = 60000;
  const retryDelay = () => Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_BASE_MS * 2 ** Math.max(0, failStreak - 1));
  // The status a failure shows: 'offline' when the server could not be reached at all (the
  // edits are safe on the device and go when the signal does), 'error' when the server
  // answered and did not accept the save (not signed in, a server error, over the size limit)
  // — something a person may need to act on, so it must not read as a dead signal.
  function saveFailed(r) {
    dirty = true;
    failStreak += 1;
    if (!offlineSince) offlineSince = Date.now();
    setStatus(r && r.unreachable ? 'offline' : 'error');
    if (r && r.error) console.warn(`[sync] save not accepted (${r.status || 'no answer'}): ${r.error}`);
    if (r && r.tooLarge && !tooLargeReported) {
      tooLargeReported = true;
      reportProblem({ kind: 'tooLarge', error: r.error || null, field: r.field || null, at: Date.now() });
    }
    persistCache({ force: true });
  }
  function saveSucceeded() {
    offlineSince = 0;
    failStreak = 0;
    tooLargeReported = false;
  }
  // What the last failed jobs delta was (persistJobsDelta's error `kind`), so a mirror failure
  // shows the same 'offline' / 'error' split as a blob save.
  let lastMirrorFailure = null;
  function persistCache({ force = false } = {}) {
    if (persistAbandoned) return; // sign-out wipe begun — never repopulate it
    const now = Date.now();
    const at = new Date(now).toISOString();
    const st = getState();
    if (force || now - lastDocCacheAt > 2000) {
      lastDocCacheAt = now;
      cacheDoc(st, baseVersion, at);
      cacheQueue(getPending(), at);
      // Reload-survival for schedule edits (Lauren, 2026-08-13): persist the rows
      // that exist locally but have NOT been confirmed mirrored to public.jobs.
      // The plain jobs cache can't tell "mirrored" from "still only local" — on
      // the next boot the hydration merge discards whatever the table doesn't
      // have — so the unmirrored diff is stored separately and re-applied after
      // hydration (recoverCachedPendingJobs).
      // Cost gate: refs alone are NOT a cheap steady-state test — in a
      // view-only tab advanceBaseline allocates a fresh baseline array on every
      // realtime patch, so refs differ forever and the ~19k-row double Map
      // build would run on every persist. Local divergence, though, always
      // travels with dirty / a pending action (a failed mirror re-marks dirty),
      // so gate on those; lastCachedPendingCount keeps the clearing write
      // reachable after the queue empties.
      // 🔴 Never touch the record while a DEFERRED stash exists
      // (cachedPendingJobsRows non-null = recovery couldn't run yet, e.g. the
      // tombstone lookup failed). The record on disk is that stash's only
      // durable copy and the design depends on a next-boot retry; a diff
      // computed from live state — which cannot contain the never-dispatched
      // stash — would overwrite it with [] within seconds of the deferral.
      if (jobsReady && !cachedPendingJobsRows && !pendingRecoveryInFlight
        && (dirty || getPending().length || lastCachedPendingCount)) {
        const rows = st.jobs === lastSyncedJobs ? [] : diffJobs(lastSyncedJobs, st.jobs).changed;
        if (rows.length || lastCachedPendingCount) {
          lastCachedPendingCount = rows.length;
          cachePendingJobs(rows, at);
        }
      }
    }
    // Jobs ref only changes when jobs actually changed (reducer preserves the array
    // ref otherwise), so this re-caches only when needed — and what gets WRITTEN is
    // the window's cleans, never the rows a screen fetched beyond it (see cacheJobsWindowed).
    // jobsReady gate: before the baseline lands, state.jobs is the previous session's cache
    // (or nothing) — re-caching it would stamp stale rows as fresh.
    if (jobsReady && st.jobs !== lastCachedJobsRef && (force || now - lastJobsCacheAt > 10000)) {
      lastJobsCacheAt = now;
      lastCachedJobsRef = st.jobs;
      cacheJobsWindowed(st.jobs, at);
    }
  }

  // "Who am I" is per-session, not shared: stamp the local currentUserId every
  // time we adopt a remote document, so one user logging in never changes
  // another user's identity.
  //
  // CLAIMS-FIRST (2026-08-03). Precedence mirrors the server (authz.js
  // resolveAuthority): (a) the roster row whose id === the tamper-proof claim
  // org_user_id wins — it beats an email match so a renamed roster email can't
  // strand a login; (b) else the roster row whose email matches the session;
  // (c) else the claim id ITSELF, so identity is non-null even when the roster
  // row is missing entirely (the orphan-login lockout). `__auth` carries the
  // claim into selectCurrentUser (role override + claim-only synthesis) and is a
  // TRANSIENT, per-session field — toSharedBlob + offlineCache strip it so it
  // never enters the shared blob or the content-guard baseline. In demo/local
  // mode both claim fields are null → `__auth` stays unset and currentUserId
  // falls through to SET_CURRENT_USER (the user-switcher), unchanged.
  function withSession(stateObj) {
    if (!stateObj || typeof stateObj !== 'object') return stateObj;
    const resolvedId = resolveCurrentUserId({
      users: stateObj.users,
      sessionEmail,
      claimOrgUserId,
      fallback: stateObj.currentUserId ?? null,
    });
    const next = { ...stateObj, currentUserId: resolvedId };
    if (claimRole || claimOrgUserId) {
      next.__auth = { claimOrgUserId, claimRole, sessionEmail: sessionEmail || null };
    }
    return next;
  }

  async function fetchLatest() {
    // CS-002: a crew (non-office) login reads the server-built projection from
    // /api/state/view — it can no longer read org_state directly. Map the response to the
    // same shape adoptRemote / loadInitial expect, and apply the fleet controls it carries.
    if (restrictedRead) {
      const v = await getStateView();
      const row = {
        state: v.state,
        version: v.version,
        min_client_build: v.minClientBuild ?? null,
        freeze_strip: v.freezeStrip ?? [],
      };
      applyFleetControls(row);
      return row;
    }
    const { data, error } = await supabase
      .from('org_state')
      // min_client_build + freeze_strip are the server-controlled fleet controls
      // (Increment 0.3). Read them on every doc fetch so a control change reaches
      // every tab within one signal/backstop cycle — no deploy required.
      .select('state, version, min_client_build, freeze_strip')
      .eq('organization_id', ORG_ID)
      .maybeSingle();
    if (error) throw error;
    if (data) applyFleetControls(data);
    return data; // { state, version, min_client_build, freeze_strip } | null
  }

  // Latest server-controlled fleet directives. Defaults are the no-op values, so the
  // gate is inert until an operator sets them.
  let minClientBuild = 0;
  let freezeStrip = [];
  function applyFleetControls(row) {
    minClientBuild = Number(row?.min_client_build) || 0;
    freezeStrip = Array.isArray(row?.freeze_strip) ? row.freeze_strip : [];
  }

  // True when this tab is running a build the server has declared too old to write.
  // FAILS OPEN by design: an unknown build id (APP_BUILD === 0, e.g. a misconfigured
  // define) never trips the gate — locking users out of writing is a far worse failure
  // than one stale tab, and the prune gate's real evidence is the telemetry query.
  function isBuildTooOld() {
    return APP_BUILD > 0 && minClientBuild > 0 && APP_BUILD < minClientBuild;
  }

  // Cheap liveness read: just the version int (a few bytes), NOT the ~800 KB blob.
  // Used by the periodic backstop so an idle-but-visible tab that silently missed a
  // Realtime signal still catches up — without the old approach's cost. (The 60 s
  // financial-snapshot poll used to bump the version every tick, which is what forced
  // every OTHER tab to resync; killing that write removed the accidental backstop, so
  // this restores it as a pure READ: zero Realtime messages, only pulls the full doc
  // when the version actually advanced.)
  async function fetchVersion() {
    // CS-002: crew can't read org_state; poll the version from the open org_state_signal
    // table instead (it mirrors the blob version and stays readable by every login). Office
    // roles read org_state directly, exactly as before.
    const table = restrictedRead ? 'org_state_signal' : 'org_state';
    const { data, error } = await supabase
      .from(table)
      .select('version')
      .eq('organization_id', ORG_ID)
      .maybeSingle();
    if (error) throw error;
    return typeof data?.version === 'number' ? data.version : null;
  }

  // B1 Stage 2: jobs live in their own public.jobs table, not the org_state blob. After the
  // (non-jobs) document, the jobs BASELINE loads from the table: the cleans in the window and
  // every series master — never the whole table (CS-676; see the note at jobsReady above).
  //
  // 🔴 A FAILED READ MUST NOT ARM THE MIRROR. jobsReady is set on the success path only, and a
  // failure retries (indefinitely, capped backoff, one timer) with the mirror gated. Arming on
  // anything but the table's answer was a live incident (3f22431): `jobs` is a STRIPPED slice of
  // the blob (store/tableSlices.js), so the blob's copy is always EMPTY, and an empty baseline
  //   · un-gates jobsCursorPoll from cursor 0 — the whole table back into state, never into
  //     the baseline;
  //   · makes the next save's diff count every live row as changed, re-upserting the table
  //     into the realtime publication (a per-row event to every connected client);
  //   · un-gates TOP_UP, which against a partial set mints duplicate occurrences.
  // Failing closed costs nothing the failure had not already cost: mirrorJobs no-ops and the
  // cursor poll waits while jobsReady is false.
  //
  // THE WINDOW is src/lib/jobsWindow.js (−45/+100 days, past the 90-day materialised horizon).
  // An office tab reads it straight from the table (keyset pages, jobsSync fetchJobsInRange)
  // plus every series MASTER (fetchSeriesMasters): TOP_UP mints from the master, which for a
  // year-old series is a year back. A crew tab (restrictedRead) asks the server for its own
  // window of cleans instead (GET /api/state/view?part=jobs, CS-677): the server reads them by
  // the GIN index on the crew list as the service role, where the same read through the
  // browser runs under RLS, whose role-or-crew policy no index can serve — it filtered every
  // clean in the window to find one cleaner's ~100. Crew never top up, so no masters.
  //
  // THE CURSOR FLOOR is the table's high-water row_version read BEFORE the window (office), or
  // the server's (crew, read before its own read): a row written while the window's pages are
  // in flight is then above the floor and the first poll fetches it. A floor taken from the rows
  // read could pass a row written between its page and a later one.
  async function loadJobsBaseline(attempt = 0) {
    if (!started || jobsReady || jobsBaselineLoading) return;
    jobsBaselineLoading = true;
    try {
      const { fromMs, toMs } = jobsWindowBounds();
      let all;
      let floor;
      let span = { from: fromMs, to: toMs };
      if (restrictedRead) {
        const own = await getOwnJobsWindow();
        all = own.jobs;
        floor = own.highWater;
        span = { from: own.fromMs, to: own.toMs };
      } else {
        floor = await fetchJobsHighWater();
        const [windowJobs, masters] = await Promise.all([fetchJobsInRange(fromMs, toMs), fetchSeriesMasters()]);
        const seen = new Set();
        all = [];
        for (const j of [...windowJobs, ...masters]) if (j && j.id && !seen.has(j.id)) { seen.add(j.id); all.push(j); }
      }
      // stop() landed (sign-out / remount), or a peer load won, while this was reading: abandon.
      if (!started || jobsReady) return;
      // 🔴 DROP ORPHANS BEFORE MERGING. DELETE_CLIENT cascades to jobs with
      // `state.jobs.filter(j => j.clientId !== id)` — only the LOADED cleans — so a deleted
      // account's other cleans stay in the table, and a later read would bring them back onto
      // the schedule. Filtering on "the client no longer exists" makes that an INVARIANT for
      // every orphaning path. Two guards: an EMPTY client list classifies nothing (absence of
      // evidence is not proof every account was deleted — the empty-baseline lesson of
      // 3f22431), and the baseline is the FILTERED set, so the mirror never sees the orphans
      // as removed and bulk-deletes them on a client-side inference (they linger in the table,
      // invisible; reclaiming them is a data-op).
      const liveClientIds = new Set((getState().clients || []).map((c) => c.id));
      const authoritative = liveClientIds.size === 0
        ? all
        : all.filter((j) => !j.clientId || liveClientIds.has(j.clientId));
      if (authoritative.length !== all.length) {
        console.warn(`[sync] hiding ${all.length - authoritative.length} job(s) whose account no longer exists locally`);
      }
      // Merge with what was painted before the answer (a boot from the device's cache): edits,
      // creates and deletes made in the gap win over the table's copy (pure, unit-tested —
      // mergeFullJobs). With nothing painted, the merge is the table's answer.
      const { merged, changed, removed } = mergeFullJobs(windowSnapshot, getState().jobs, authoritative);
      dispatch({ type: ACTIONS.SET_JOBS, jobs: merged });
      // The baseline is the PRISTINE table answer, so the next save mirrors exactly the gap's
      // edits (changed → upserts, removed → deletes) and nothing else.
      lastSyncedJobs = authoritative;
      jobsCursor = floor;
      coverage = [{ from: span.from, to: span.to }];
      jobsReady = true; // ONLY here, on the table's answer
      windowSnapshot = null;
      cacheJobsWindowed(merged, new Date().toISOString());
      lastCachedJobsRef = merged;
      lastJobsCacheAt = Date.now();
      signalJobsReady();
      if (changed.length || removed.length) scheduleSave(); // flush the gap's edits to the table
      await recoverCachedPendingJobs(authoritative); // previous session's unmirrored rows (schedules its own save)
    } catch (e) {
      console.warn(`[sync] jobs window read failed (attempt ${attempt + 1}):`, e?.message || e);
      if (!baselineRetryTimer && started && !jobsReady) {
        const delay = Math.min(2000 * (attempt + 1), 30000);
        baselineRetryTimer = setTimeout(() => {
          baselineRetryTimer = null;
          loadJobsBaseline(attempt + 1);
        }, delay);
      }
    } finally {
      jobsBaselineLoading = false;
    }
  }

  // Load the baseline again, mid-session: the cursor poll met the delete feed's REAP MARKER
  // (this tab slept past the 30-day tombstone reap, so deletes may be missing and nothing
  // incremental can recover them). The rows as this tab last confirmed them become the
  // snapshot, so any local change not saved yet survives the merge, and everything fetched
  // beyond the window is let go: the screens that need it ask again (the store's jobs epoch).
  function reloadJobsBaseline() {
    if (!started || !jobsReady || jobsBaselineLoading) return Promise.resolve();
    jobsReady = false;
    windowSnapshot = lastSyncedJobs;
    coverage = [];
    loadedSeries.clear();
    loadedClients.clear();
    askedIds.clear();
    return loadJobsBaseline();
  }

  // ── ON DEMAND: what a screen needs beyond the window (CS-676) ───────────────────────────
  // Each ensure* resolves once what it asks for is in state, and throws when it could not be
  // read — or when this manager stopped or reloaded its baseline meanwhile (the rows would
  // land in a store that no longer matches); the screen asks again on the store's next jobs
  // epoch.
  const NOT_LOADED = 'jobs not loaded';
  const whenJobsReady = async () => {
    if (!jobsReady) await new Promise((resolve) => { baselineWaiters.push(resolve); });
    if (!started || !jobsReady) throw new Error(NOT_LOADED);
  };
  const stillCurrent = () => { if (!started || !jobsReady) throw new Error(NOT_LOADED); };
  // One request per distinct ask: two screens wanting the same range or series share it.
  function once(key, run) {
    const cur = jobsInflight.get(key);
    if (cur) return cur;
    const p = (async () => { try { return await run(); } finally { jobsInflight.delete(key); } })();
    jobsInflight.set(key, p);
    return p;
  }
  // [from, to) minus what is loaded: the gaps a range request still has to read.
  function uncovered(from, to) {
    let gaps = [{ from, to }];
    for (const c of coverage) {
      const next = [];
      for (const g of gaps) {
        if (c.to <= g.from || c.from >= g.to) { next.push(g); continue; }
        if (c.from > g.from) next.push({ from: g.from, to: c.from });
        if (c.to < g.to) next.push({ from: c.to, to: g.to });
      }
      gaps = next;
    }
    return gaps.filter((g) => g.to > g.from);
  }
  function addCoverage(from, to) {
    const all = [...coverage, { from, to }].sort((a, b) => a.from - b.from);
    const out = [];
    for (const c of all) {
      const last = out[out.length - 1];
      if (last && c.from <= last.to) last.to = Math.max(last.to, c.to);
      else out.push({ ...c });
    }
    coverage = out;
  }
  // Rows a request brought that this tab does not hold join state AND the baseline: they are
  // the table's own copy, so the next save must not send them back (the ping-pong loop). It
  // never overwrites: a row the tab holds may carry an edit not saved yet, and a row in the
  // baseline but not in state is a delete not saved yet — both skipped; realtime and the
  // cursor poll keep held rows current. Orphans (their customer is gone) are dropped as at
  // the baseline load.
  function adoptFetchedJobs(rows) {
    const st = getState();
    const held = new Set((st.jobs || []).map((j) => j && j.id));
    const base = new Set(lastSyncedJobs.map((j) => j && j.id));
    const liveClientIds = new Set((st.clients || []).map((c) => c.id));
    const fresh = (rows || []).filter((j) => j && j.id && !held.has(j.id) && !base.has(j.id)
      && (!j.clientId || liveClientIds.size === 0 || liveClientIds.has(j.clientId)));
    if (!fresh.length) return 0;
    dispatch({ type: ACTIONS.PATCH_JOBS, upserts: fresh, deletes: [] });
    advanceJobsBaseline(fresh, []);
    return fresh.length;
  }
  // Every clean that starts in [fromMs, toMs): a past week on the Schedule, a report's day,
  // the days a time-off booking covers. Resolves once they are in state; throws when the read
  // fails (the screen says so and can ask again).
  async function ensureJobsRange(fromMs, toMs) {
    const from = Number(fromMs);
    const to = Number(toMs);
    if (!(to > from)) return;
    await whenJobsReady();
    const gaps = uncovered(from, to);
    await Promise.all(gaps.map((g) => once(`range:${g.from}:${g.to}`, async () => {
      const rows = await fetchJobsInRange(g.from, g.to);
      stillCurrent();
      adoptFetchedJobs(rows);
      addCoverage(g.from, g.to);
    })));
  }
  // Every occurrence of one series, wherever it falls — what a whole-series edit or delete needs.
  async function ensureSeries(seriesId) {
    if (!seriesId) return;
    await whenJobsReady();
    if (loadedSeries.has(seriesId)) return;
    await once(`series:${seriesId}`, async () => {
      const rows = await fetchSeriesJobs(seriesId);
      stillCurrent();
      adoptFetchedJobs(rows);
      loadedSeries.add(seriesId);
    });
  }
  // Every clean of one customer — the customer page's history.
  async function ensureClientJobs(clientId) {
    if (!clientId) return;
    await whenJobsReady();
    if (loadedClients.has(clientId)) return;
    await once(`client:${clientId}`, async () => {
      const rows = await fetchClientJobs(clientId);
      stillCurrent();
      adoptFetchedJobs(rows);
      loadedClients.add(clientId);
    });
  }
  // These cleans by id (a deep link, a notification's clean). Afterwards an id still absent
  // from state is GONE (deleted), not merely outside the window.
  async function ensureJobsByIds(ids) {
    await whenJobsReady();
    const held = new Set((getState().jobs || []).map((j) => j && j.id));
    const want = [...new Set((ids || []).filter((id) => typeof id === 'string' && id && !held.has(id) && !askedIds.has(id)))].sort();
    if (!want.length) return;
    await once(`ids:${want.join(',')}`, async () => {
      const rows = await fetchJobsByIds(want);
      stillCurrent();
      adoptFetchedJobs(rows);
      for (const id of want) askedIds.add(id);
    });
  }
  const isRangeLoaded = (fromMs, toMs) => jobsReady && uncovered(Number(fromMs), Number(toMs)).length === 0;
  const isSeriesLoaded = (seriesId) => jobsReady && (!seriesId || loadedSeries.has(seriesId));
  const isClientLoaded = (clientId) => jobsReady && (!clientId || loadedClients.has(clientId));

  // Re-apply unmirrored jobs carried over from the previous session's cache, once
  // the jobs baseline has landed (loadJobsBaseline's success path). CONSERVATIVE by
  // construction — this recovers CREATES only:
  //   · only rows the table does NOT have. An id the table knows means the
  //     mirror won or a peer wrote newer — never clobber that. (Deliberate
  //     limitation: an unmirrored EDIT of an existing row, and an unmirrored
  //     DELETE, are NOT recovered — distinguishing "my edit is newer" from "a
  //     peer's write is newer" isn't decidable from a cached copy, so we take
  //     the table's answer. The lost-series class — creates — is what this
  //     exists for.) The baseline holds only the window, so a candidate it lacks is
  //     looked up by id: a row outside the window that the table has is the table's.
  //   · 🔴 rows whose id is TOMBSTONED in public.job_deletes are dropped. The
  //     in-memory jobTombstones module is EMPTY on a fresh page load, so the
  //     reducer's guard alone cannot veto a row a peer deleted while this tab
  //     was away — re-creating it would be the resurrection churn this same
  //     deploy's diagnostic is hunting. The durable table is the authority; if
  //     the lookup FAILS the answer is unknown, so recovery is retried next
  //     boot rather than risked now (the stash is restored, the record kept).
  //   · same orphan rule as the hydration merge (client must still exist).
  // The recovered rows enter state.jobs but NOT the (authoritative) baseline, so
  // the next flush mirrors them as creates — completing the write the previous
  // session never got to finish. The cache record is CLEARED after consumption
  // (and the latch synced) — a stale non-empty record would otherwise re-run
  // this dance on every boot, forever widening the resurrection window.
  async function recoverCachedPendingJobs(authoritative) {
    // Sign-out wipe begun: never write recovery data (rows OR clears) into the
    // just-wiped cache of a signed-out device — same law as persistCache.
    if (persistAbandoned) return;
    const rows = cachedPendingJobsRows;
    cachedPendingJobsRows = null;
    if (!rows || !rows.length) return;
    pendingRecoveryInFlight = true; // persist gate treats this like a live stash
    try {
    const clearRecord = () => {
      lastCachedPendingCount = 0;
      cachePendingJobs([], new Date().toISOString());
    };
    const have = new Set((authoritative || []).map((j) => j && j.id).filter(Boolean));
    const liveClients = new Set((getState().clients || []).map((c) => c.id));
    const candidates = rows.filter((j) => j && j.id && !have.has(j.id)
      && (!j.clientId || liveClients.size === 0 || liveClients.has(j.clientId)));
    if (!candidates.length) { clearRecord(); return; }
    // Two lookups, both by id: which candidates the table HAS (outside the window), and
    // which it deleted. Either failing leaves the answer unknown — see below.
    let inTable = null;
    try { inTable = new Set((await fetchJobsByIds(candidates.map((j) => j.id))).map((j) => j.id)); } catch { inTable = null; }
    const tombs = inTable ? await fetchJobDeletesByIds(candidates.map((j) => j.id)) : null;
    if (!started || persistAbandoned || jobsReady !== true) { cachedPendingJobsRows = rows; return; }
    if (tombs === null) {
      // Unknown — do NOT recover blind. Keep the stash + record for a retry.
      console.warn('[sync] pending-jobs recovery deferred: the table could not be asked');
      cachedPendingJobsRows = rows;
      return;
    }
    const recovered = candidates.filter((j) => !tombs.has(j.id) && !inTable.has(j.id));
    for (const [id, rv] of tombs) jobTombstones.record(id, rv); // seed the in-memory guard too
    if (!recovered.length) { clearRecord(); return; }
    // Keep the recovered rows DURABLE until their mirror confirms: re-write the
    // record to exactly the surviving set (not clear it) before dispatching.
    // The dispatch below is the raw store dispatch (no pending-queue entry) and
    // the L12 persist gate would skip the diff with latch=0 — so clearing here
    // would leave a kill-the-tab-in-the-debounce window where the rescued rows
    // have NO durable copy anywhere. The normal successful-mirror persist
    // writes the clearing [] once they truly land (latch keeps it reachable).
    lastCachedPendingCount = recovered.length;
    cachePendingJobs(recovered, new Date().toISOString());
    console.warn(`[sync] recovering ${recovered.length} unsynced job(s) cached by the previous session`);
    dispatch({ type: ACTIONS.PATCH_JOBS, upserts: recovered, deletes: [] });
    scheduleSave();
    } finally {
      pendingRecoveryInFlight = false;
    }
  }

  // Prime the offline cache directly from freshly-loaded values. We can't use
  // persistCache() on the load path: getState() reads stateRef, which lags a
  // just-dispatched HYDRATE/SET_JOBS by a render, so it would cache a stale
  // (empty) jobs array. These are the authoritative values we just fetched.
  function primeCache(state, version) {
    // A first load that lands after a sign-out began (its boot screen offers Sign out) must not
    // write the cache that sign-out just wiped — the same law as persistCache.
    if (persistAbandoned) return;
    const at = new Date().toISOString();
    cacheDoc(state, version, at);     // cacheDoc strips jobs + currentUserId itself
    cacheQueue([], at);
    lastDocCacheAt = Date.now();
    // The jobs are cached by loadJobsBaseline when the window lands (cacheJobsWindowed).
  }

  // Write only the window's cleans to IndexedDB (SCALE-C14 / §8 G4). cacheJobs is a
  // main-thread structured clone, so its cost is the row count, and a big record risks the
  // browser evicting the whole origin's storage under quota pressure — which silently
  // destroys the offline cache crew rely on in the field. Rows a screen fetched beyond the
  // window (a past week, a series) are never cached.
  //
  // Stamped `windowed: true` although this build never reads the flag back (a cache is a
  // snapshot to paint, never the baseline — bootFromCache): an OLDER bundle still installed
  // on the same device reads it, and a record without it would read there as the complete
  // table — the empty-baseline hazard of ba57f40.
  function cacheJobsWindowed(jobs, at) {
    // Gate here (not only in persistCache): loadJobsBaseline writes the jobs cache directly,
    // and a load settling between sign-out's clearCache() and the SIGNED_OUT-driven stop()
    // must not repopulate the wiped cache on a signed-out device.
    if (persistAbandoned) return false;
    const { fromIso, toIso } = jobsWindowBounds();
    const from = fromIso.slice(0, 10);
    const to = toIso.slice(0, 10);
    return cacheJobs(jobsInWindow(jobs, from, to), at, { windowed: true, from, to });
  }

  // markOffline: the OFFLINE boot stamps 'offline' so the banner shows until
  // reconnect. The ONLINE cache-first boot must NOT — it would flash the
  // offline banner on every visit; start() stamps 'synced' and the detached
  // resync/flush corrects to 'offline' if the network turns out to be dead.
  async function bootFromCache({ markOffline = true } = {}) {
    const cached = await readCache();
    if (!cached) return false;
    baseVersion = cached.version || 0;
    lastSavedStateJson = serializeShared(cached.state); // blob baseline = the cached doc
    dispatch({ type: ACTIONS.HYDRATE, payload: withSession(cached.state) });
    const jobs = Array.isArray(cached.state.jobs) ? cached.state.jobs : [];
    lastSyncedJobs = jobs;
    jobsCursor = maxRv(jobs); // replaced by the table's high-water when the baseline lands
    lastCachedJobsRef = jobs;

    // ⚠️ THE CACHE IS NEVER THE BASELINE — it is what to paint while the server answers. It
    // holds only the window as it stood when it was written (and IndexedDB may have evicted
    // its jobs record outright, ba57f40), so arming the mirror on it would be destructive
    // twice over: the reconnect flush would read every clean the cache lacks as a local
    // delete, and TOP_UP would mint duplicates of the tail it can't see. So the mirror stays
    // gated and loadJobsBaseline reads the window and merges it onto these painted rows,
    // keeping any edit made in the gap (offline it fails, and retries until the link is back).
    // Unmirrored rows from the previous session (empty for pre-feature caches).
    // Consumed by recoverCachedPendingJobs once the baseline lands — the merge would
    // otherwise silently discard them (they're in the cached live array but not in the table).
    cachedPendingJobsRows = Array.isArray(cached.pendingJobsRows) && cached.pendingJobsRows.length
      ? cached.pendingJobsRows
      : null;
    // Seed the latch from the record just read: it starts 0 every session, and
    // without this the record's eventual CLEARING write (persistCache writes
    // only when rows.length || latch) could never fire after a clean recovery —
    // leaving a stale non-empty record to re-run recovery on every future boot.
    lastCachedPendingCount = cachedPendingJobsRows ? cachedPendingJobsRows.length : 0;
    windowSnapshot = jobs; // what loadJobsBaseline merges the window onto
    jobsReady = false;     // no mirroring until the table answers
    loadJobsBaseline();    // detached
    if (cached.queue && cached.queue.length && setPending) setPending(cached.queue);
    if (markOffline) setStatus('offline');
    return true;
  }

  // CS-672: the first read of a device with no cache — patient, retried, and never a failure for the
  // caller to fail open on (see BOOT_* at the top). Resolves with the first answer any attempt gets
  // (fetchLatest's row, or null for no row), or BOOT_STOPPED when stop() ended the wait. While it
  // waits, the boot screen is told the phase (reportBoot) and Retry calls bootRetryNow.
  function bootRead() {
    return new Promise((resolve) => {
      let attempt = 0;        // attempts started
      let lastFailed = 0;     // the newest attempt already counted as failed (an attempt fails once)
      let failures = 0;       // failures in a row — the back-off
      let inFlight = false;   // the newest attempt is running and still inside its time
      let settled = false;
      let retryTimer = null;
      let slowTimer = null;
      let deadline = null;
      const clearTimers = () => {
        clearTimeout(retryTimer); clearTimeout(slowTimer); clearTimeout(deadline);
        retryTimer = null; slowTimer = null; deadline = null;
      };
      const wake = () => { if (!settled && !inFlight) run(); };
      const wakeIfVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') wake(); };
      const listen = (on) => {
        if (typeof window === 'undefined') return;
        const fn = on ? 'addEventListener' : 'removeEventListener';
        window[fn]('online', wake);
        if (typeof document !== 'undefined') document[fn]('visibilitychange', wakeIfVisible);
      };
      const finish = (row) => {
        if (settled) return;
        settled = true;
        clearTimers();
        listen(false);
        bootRetryNow = null;
        bootStop = null;
        resolve(row);
      };
      // Only the NEWEST attempt's failure counts, and only once: an older attempt that fails late
      // has been superseded (its answer would still count — a success boots, whichever attempt).
      const failed = (n, e) => {
        if (settled || n !== attempt || n <= lastFailed) return;
        if (!started) { finish(BOOT_STOPPED); return; }
        lastFailed = n;
        inFlight = false;
        clearTimeout(slowTimer); slowTimer = null;
        clearTimeout(deadline); deadline = null;
        failures += 1;
        const delay = Math.min(BOOT_RETRY_MAX_MS, BOOT_RETRY_BASE_MS * 2 ** (failures - 1));
        console.warn(`[sync] first load: attempt ${n} got no answer (${e?.message || e}); trying again in ${Math.round(delay / 1000)} s`);
        reportBoot({ phase: 'unreachable', retryAt: Date.now() + delay, retrying: false });
        clearTimeout(retryTimer);
        retryTimer = setTimeout(run, delay);
      };
      function run() {
        if (settled) return;
        if (!started) { finish(BOOT_STOPPED); return; }
        if (inFlight) return; // the newest attempt is still inside its time: let it answer
        clearTimeout(retryTimer); retryTimer = null;
        attempt += 1;
        const n = attempt;
        inFlight = true;
        if (n === 1) {
          reportBoot({ phase: 'loading' });
          slowTimer = setTimeout(() => { if (!settled && n === attempt && inFlight) reportBoot({ phase: 'slow' }); }, BOOT_SLOW_MS);
        } else {
          reportBoot({ phase: 'unreachable', retryAt: null, retrying: true });
        }
        deadline = setTimeout(() => failed(n, new Error('no answer in time')), BOOT_ATTEMPT_MS);
        Promise.resolve().then(fetchLatest).then(
          (row) => { if (!settled) finish(row); },
          (e) => failed(n, e),
        );
      }
      bootRetryNow = wake;
      bootStop = () => finish(BOOT_STOPPED);
      listen(true);
      run();
    });
  }

  async function loadInitial() {
    // CACHE-FIRST PAINT. The cache used to be an outage-only fallback: every
    // ONLINE boot blocked first paint on the ~800 KB blob fetch plus the
    // windowed jobs pages — seconds of loader for data already sitting in
    // IndexedDB from the last visit. Paint from the cache immediately and
    // freshen through resync(), which is the SAME battle-tested path an
    // offline tab takes when connectivity returns: fetchLatest → adoptRemote
    // (keeps table-owned jobs, replays pending), and the jobs window read
    // fresh from the table (bootFromCache gated jobsReady/TOP_UP until it lands).
    // `started` is set before loadInitial runs, so the detached resync passes
    // its own guard; saving/reentrancy rules are resync's, unchanged. A stale
    // cache paints briefly and converges — stale-while-revalidate, strictly
    // better than the same wall-clock spent on a blank loader. When offline,
    // the detached resync simply fails and the offline status stands — the
    // exact pre-change offline boot.
    const knownOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (await bootFromCache({ markOffline: knownOffline })) {
      if (!knownOffline) setTimeout(() => { resync(); }, 0);
      return;
    }
    // No cache (first visit on this device, or the first since a sign-out wiped it) — the
    // network-first path. There is nothing on the device worth showing, so the read FAILS CLOSED
    // (CS-672): bootRead waits, retries and tells the boot screen, and returns only an answer —
    // or BOOT_STOPPED when this manager was stopped while it waited (a sign-out, a remount).
    const existing = await bootRead();
    if (existing === BOOT_STOPPED) return;
    if (existing && existing.state && Object.keys(existing.state).length > 0) {
      baseVersion = existing.version;
      lastSavedStateJson = serializeShared(existing.state); // blob baseline = the loaded doc
      dispatch({ type: ACTIONS.HYDRATE, payload: withSession(existing.state) });
      // The window of cleans is waited for, as before: the app opens with its schedule. A read
      // that fails retries in the background (the mirror stays gated until it lands).
      await loadJobsBaseline();
      primeCache(existing.state, existing.version); // refresh the offline cache
      return;
    }
    // First run for this org — seed a BLANK production state (team + config, no
    // sample customer data). ignoreDuplicates makes this safe if two users sign
    // in for the very first time at once.
    const seed = productionInitialState();
    // Routed through the server like every other write (Increment 1d): a fresh clone seeds
    // itself through /api/state/seed and nothing else. A failed seed is not worked around
    // (the direct upsert it used to fall back to is refused since 1e, CS-009): the read
    // below finds no row, the tab runs on the blank seed, and every save answers "row not
    // found" and backs off with an error showing until the server can seed.
    const seeded = await postSeedState(seed);
    if (!seeded.ok) console.warn('[sync] first-run seed was not accepted:', seeded.error || seeded.status);
    // The read after the seed is as patient as the first: a boot never runs on anything but the
    // server's answer (no row at all is an answer — the blank production seed above stands).
    const after = await bootRead();
    if (after === BOOT_STOPPED) return;
    baseVersion = after?.version ?? 1;
    const booted = after?.state ?? seed;
    lastSavedStateJson = serializeShared(booted); // blob baseline = the freshly-seeded doc
    dispatch({ type: ACTIONS.HYDRATE, payload: withSession(booted) });
    await loadJobsBaseline();
    primeCache(booted, baseVersion); // prime the offline cache for this org's first run
  }

  // Replace local state with the remote document, then re-apply any of our own
  // edits that hadn't been saved yet (so they aren't lost to the remote write).
  function adoptRemote(remote) {
    const pending = getPending();
    // B1 Stage 2: jobs are owned by the public.jobs table now. Adopt the remote
    // (non-jobs) document but KEEP our table-sourced jobs — don't let the blob's copy
    // overwrite them. Job changes from other tabs arrive via the jobs realtime channel.
    // Keep every table-owned slice. The adopted blob's copy is either EMPTY (a
    // 'stripped' slice) or a stale dual-write copy (a 'mirror' slice) — in both cases
    // the live array is the table-sourced truth and must survive the adopt. Registry-
    // driven so a newly-extracted slice can never be forgotten here.
    const keep = {};
    for (const key of tableOwnedSliceKeys()) keep[key] = getState()[key];
    dispatch({ type: ACTIONS.HYDRATE, payload: { ...withSession(remote.state), ...keep } });
    baseVersion = remote.version;
    lastSavedStateJson = serializeShared(remote.state); // blob baseline = the adopted doc
    if (pending.length > 0) {
      pending.forEach((a) => dispatch(a));
      scheduleSave(); // persist the replayed edits on top of the adopted base
    } else {
      clearPending();
    }
  }

  // Mirror the changed jobs to the per-row public.jobs table (B1 Stage 1). Best-effort —
  // the org_state save already committed (or was skipped as a no-op); a mirror failure
  // must not undo it and is retried on the next change (lastSyncedJobs stays put so the
  // next diff still includes this delta). Shared by the write path and the no-op skip
  // path — a jobs-only change (e.g. TOP_UP) leaves the blob identical but still needs
  // its new rows mirrored.
  // ── THE PER-SLICE MIRROR DISPATCHER (G2) ─────────────────────────────────
  //
  // Increment 0.3 generalized the blob TRANSFORM across the slice registry but not the
  // WRITE PATH: flush() captured every registered slice into `sliceNow` and then
  // immediately narrowed to `sliceNow.jobs`, calling the jobs-only mirror. So
  // registering a second slice at phase 'mirror' would make the content-guard treat a
  // slice-only edit as "blob unchanged, skip the write" while NOTHING mirrored it —
  // the edit simply vanishes. That is precisely the failure tableSlices.js's own header
  // warns about ("MISSING ONE IS SILENT"), and it is a hard prerequisite for
  // Increment 3, which registers `notifications`.
  //
  // The registry says WHICH slices are table-owned; this map says HOW each is
  // persisted. A registered slice with no entry here is a LOUD failure — see
  // mirrorSlices — never a silent skip. app/scripts/test-slice-mirrors.mjs asserts the
  // two stay in step, so adding a slice without its mirror fails the build.
  //
  // Each mirror owns its own baseline (jobs uses lastSyncedJobs) and returns true on
  // success. Returning false leaves the baseline unadvanced so the next flush retries.
  const SLICE_MIRRORS = {
    jobs: (next) => mirrorJobs(next),
  };

  // Mirror every table-owned slice. Returns true only if ALL succeeded — the caller
  // treats false as "still dirty, retry", which is correct for a partial failure too.
  // Call-time capture of every table-owned slice for the per-row mirrors. Always
  // taken AT THE MIRROR SITE (never a flush-start snapshot) — see the note at
  // the flush's blob capture for why staleness here overwrites peer data.
  function liveSlices() {
    const cur = getState();
    const out = {};
    for (const key of tableOwnedSliceKeys()) out[key] = Array.isArray(cur[key]) ? cur[key] : [];
    return out;
  }

  async function mirrorSlices(sliceNow) {
    let allOk = true;
    for (const key of tableOwnedSliceKeys()) {
      const mirror = SLICE_MIRRORS[key];
      if (!mirror) {
        // Loud, and it does NOT pretend to have persisted. Silently returning true
        // here would reproduce exactly the data loss this dispatcher exists to stop.
        console.error(`[sync] slice '${key}' is registered in TABLE_SLICES but has no mirror. Its edits are NOT being persisted. Add it to SLICE_MIRRORS.`);
        allOk = false;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- slices are few and order is
      // irrelevant; parallelism here would only add contention on the same connection.
      const ok = await mirror(sliceNow[key] || []);
      if (!ok) allOk = false;
    }
    return allOk;
  }

  async function mirrorJobs(jobsNow) {
    if (!jobsReady) return true; // baseline not established yet — nothing to mirror, not a failure
    try {
      await persistJobsDelta(lastSyncedJobs, jobsNow);
      lastSyncedJobs = jobsNow;
      lastMirrorFailure = null;
      return true;
    } catch (e) {
      // The baseline stays put, so the next flush re-sends the same delta (CS-009: there is
      // no direct write to "succeed" through any more — a DELETE the database filtered out
      // used to advance the baseline and the deleted clean came back on the next load).
      lastMirrorFailure = { unreachable: e?.kind === 'unreachable', status: e?.status || 0, error: e?.message || String(e) };
      console.warn('[sync] jobs mirror failed:', lastMirrorFailure.error);
      return false;
    }
  }

  // ── THE PING-PONG FIX ────────────────────────────────────────────────────────
  // Rows that just arrived FROM the server (realtime patch / cursor poll) must
  // advance the mirror baseline, or the reference diff re-POSTs them on the next
  // flush as if they were local edits — the self-amplifying churn loop (~165
  // UPDATEs/row measured live; see advanceBaseline in jobsMerge.js for the full
  // mechanics + edge cases, and writeJobsDelta's data-equality guard for the
  // server-side backstop covering a patch that lands mid-flush).
  // Gated on jobsReady: before the authoritative baseline exists there is
  // nothing to advance (mirrorJobs no-ops in that state anyway).
  function advanceJobsBaseline(upserts = [], deletes = []) {
    if (!jobsReady) return;
    lastSyncedJobs = advanceBaseline(lastSyncedJobs, getState().jobs, upserts, deletes);
  }

  // ── REALTIME PATCH COALESCING ────────────────────────────────────────────────
  // public.jobs is still on per-row postgres_changes, so a bulk write (a
  // whole-series edit is ~100+ rows; the churn-era bursts were 8,000/hour) arrives
  // as one event PER ROW. Dispatching each individually meant: one reducer pass
  // rebuilding a Map over the whole in-memory jobs array + one render of every
  // store subscriber PER EVENT — ~19k Map insertions × 8,000 events in a burst
  // hour, the measured "app freezes during shift start". Buffer inbound rows and
  // flush ONE PATCH_JOBS per window: applyJobPatch already takes arrays, and the
  // per-row _rv order guard makes ordering WITHIN the batch a non-issue (a
  // delete/upsert pair for the same id resolves by version either way, exactly as
  // it would across two dispatches). 250 ms adds imperceptible cross-tab latency
  // and caps the reducer/render cost of any burst at 4 passes/second.
  const RT_COALESCE_MS = 250;
  let rtJobsBuf = { upserts: [], deletes: [] };
  let rtJobsTimer = null;
  function flushRealtimeJobsBuf() {
    rtJobsTimer = null;
    if (!started) { rtJobsBuf = { upserts: [], deletes: [] }; return; } // stopped mid-window
    const { upserts, deletes } = rtJobsBuf;
    if (!upserts.length && !deletes.length) return;
    rtJobsBuf = { upserts: [], deletes: [] };
    dispatch({ type: ACTIONS.PATCH_JOBS, upserts, deletes });
    advanceJobsBaseline(upserts, deletes);
  }
  function queueRealtimeJobsPatch(upsert, deleteId) {
    if (upsert) rtJobsBuf.upserts.push(upsert);
    if (deleteId) rtJobsBuf.deletes.push(deleteId);
    if (!rtJobsTimer) rtJobsTimer = setTimeout(flushRealtimeJobsBuf, RT_COALESCE_MS);
  }

  // ── CS-008: A REFUSED SAVE DROPS ONLY WHAT WAS REFUSED ──────────────────────────────────
  //
  // The guard answers for a whole save, and a save carries every action dispatched in the
  // last ~600 ms. Which of them it refused, it cannot say: its violations name RULES ("change
  // another member's pay"), not actions. So the batch is replayed from the server's committed
  // state ONE ACTION AT A TIME, each saved on its own: an action the guard refuses is dropped
  // and reported, every other one lands. Actions that change nothing the guard can see (a
  // jobs-only edit, a no-op) are applied without a request at all.
  //
  // The JOBS half of a refused action is undone too. Jobs live in their own table and are
  // mirrored separately, so a refused customer delete used to keep its cascade: the customer
  // stayed, its cleans were deleted on the next save. The walk runs the jobs from the mirror
  // baseline (the table as this tab last confirmed it), so each refused action's effect on
  // them is measurable — and the rows it touched are put back as they were before it.
  //
  // Writes per refusal = the actions in the batch that change the shared record (usually one
  // to three). Never a silent drop: if the committed state can't be read, or a save in the
  // walk fails for any reason but a refusal, everything not yet decided STAYS pending.
  const ISOLATE_CONFLICT_TRIES = 3;
  async function isolateRefusedBatch(pendingCovered, stamp) {
    const batch = getPending().slice(0, pendingCovered);
    let remote = null;
    try { remote = await fetchLatest(); } catch { remote = null; }
    // Nothing is attributable without the committed state, so nothing is dropped: everything
    // stays pending and the save is retried after the backoff, with an error showing.
    if (!remote || !remote.state) { saveFailed({ failed: true, error: 'The saved copy could not be read to check the refused changes' }); return; }

    // Jobs from the mirror baseline once it exists; before it lands, from the cleans painted
    // first (the same base loadJobsBaseline measures gap edits against).
    let iso = { ...withSession(remote.state), jobs: jobsReady ? lastSyncedJobs : (windowSnapshot || getState().jobs || []) };
    let isoJson = serializeShared(iso);
    let isoVersion = remote.version;
    baseVersion = remote.version;
    lastSavedStateJson = isoJson;
    const refused = [];
    // job id -> the row as it was before the first refused action that touched it (null = it
    // did not exist then, so the refused action created it).
    const restoreJobs = new Map();
    let processed = 0;
    let committedAny = false;
    let stop = null; // the answer that ended the walk early: anything but ok / refused / conflict
    const save = (json, base) => {
      lastWrittenVersion = base + 1;
      return postOrgState({ stateJson: json, baseVersion: base, build: stamp.updated_by_build, tab: stamp.updated_by_tab });
    };
    for (; processed < batch.length; processed += 1) {
      const action = batch[processed];
      let next = reducer(iso, action);
      let nextJson = serializeShared(next);
      if (nextJson === isoJson) { iso = next; continue; } // nothing the guard can see
      let decided = false;
      for (let attempt = 1; !decided; attempt += 1) {
        const r = await save(nextJson, isoVersion);
        if (r.ok) {
          iso = next; isoJson = nextJson; isoVersion = r.version;
          baseVersion = r.version; lastSavedStateJson = nextJson;
          committedAny = true;
          decided = true;
        } else if (r.rejected) {
          refused.push({ action, violations: Array.isArray(r.violations) ? r.violations : [] });
          const before = new Map((iso.jobs || []).map((j) => [j.id, j]));
          const d = diffJobs(iso.jobs || [], next.jobs || []);
          for (const j of d.changed) if (!restoreJobs.has(j.id)) restoreJobs.set(j.id, before.get(j.id) || null);
          for (const id of d.removed) if (!restoreJobs.has(id)) restoreJobs.set(id, before.get(id) || null);
          decided = true;
        } else if (r.conflict && attempt < ISOLATE_CONFLICT_TRIES) {
          // Someone else saved mid-walk: rebase this action on their commit and try again.
          let fresh = null;
          try { fresh = await fetchLatest(); } catch { fresh = null; }
          if (!fresh || !fresh.state) { stop = r; decided = true; break; }
          iso = { ...withSession(fresh.state), jobs: iso.jobs };
          isoJson = serializeShared(iso); isoVersion = fresh.version;
          baseVersion = fresh.version; lastSavedStateJson = isoJson;
          next = reducer(iso, action);
          nextJson = serializeShared(next);
          if (nextJson === isoJson) { iso = next; decided = true; }
        } else {
          stop = r; decided = true;
        }
      }
      if (stop) break;
    }

    if (stop && stop.gated) {
      persistCache({ force: true });
      if (!reloadedForBuildGate) {
        reloadedForBuildGate = true;
        try { if (typeof window !== 'undefined') window.location.reload(); } catch { /* ignore */ }
      }
      return;
    }
    if (stop && stop.terminal) {
      // This login can no longer write (the sign-out is already under way): nothing left to keep.
      setPending(getPending().slice(pendingCovered));
      dirty = false;
      return;
    }

    // The jobs a refused action touched go back as they were before it. SET_JOBS, not
    // PATCH_JOBS: the reducer's order guard drops an upsert that isn't newer, and a row a local
    // action changed carries the same row version as the one it replaced.
    if (restoreJobs.size) {
      const live = getState().jobs || [];
      const out = [];
      const seen = new Set();
      for (const j of live) {
        if (!j) continue;
        seen.add(j.id);
        if (!restoreJobs.has(j.id)) { out.push(j); continue; }
        const back = restoreJobs.get(j.id);
        if (back) out.push(back);
      }
      for (const [id, back] of restoreJobs) if (back && !seen.has(id)) out.push(back);
      dispatch({ type: ACTIONS.SET_JOBS, jobs: out });
    }

    // What was not decided (a failure stopped the walk) stays pending, ahead of anything
    // dispatched while the walk ran; the decided actions are on the server or refused.
    setPending([...batch.slice(processed), ...getPending().slice(pendingCovered)]);
    let latest = null;
    try { latest = await fetchLatest(); } catch { latest = null; }
    adoptRemote(latest && latest.state && latest.version >= isoVersion ? latest : { state: iso, version: isoVersion });

    if (refused.length) {
      console.warn('[sync] changes refused by the server:', refused.map((r) => `${r.action?.type}: ${r.violations.join('; ')}`).join(' | '));
      reportProblem({ kind: 'refused', refused, at: Date.now() });
    }
    if (stop) {
      // A failure (not a refusal) stopped the walk: what it had not decided is pending again
      // above, and is retried after the backoff with the failure showing.
      saveFailed(stop);
      return;
    }
    // The accepted actions' JOBS changes are mirrored by the next pass (content-guard path).
    if (committedAny) saveSucceeded();
    dirty = true;
  }

  async function flush() {
    if (!started) return;
    // Nothing to save before the first load unless edits are waiting (CS-672). On a first boot the
    // store shows only the boot screen, so it holds the seed placeholder — the DEMO's book — and no
    // edit: posting it would only ever put the demo's data on the wire. (Edits CAN be waiting when
    // the session's claim changed mid-use and a new manager is booting under a live screen; those
    // still save, as before.)
    if (!loaded && !getPending().length) {
      // A save armed while the last one was in flight, with nothing left to send: the status the
      // last one held back (CS-952) is said here.
      if (currentStatus === 'saving' && !saving && !dirty && !saveTimer) setStatus('synced');
      return;
    }
    if (saving) { dirty = true; return; }
    saving = true;
    try {
      // currentUserId is per-session, never shared — strip it from the document.
      // B1 Stage 3: jobs live in public.jobs now — stop carrying them in the org_state
      // blob so each write is ~600 KB instead of ~9 MB. Keep the REAL array (jobsNow)
      // for the per-row mirror; never diff against the emptied copy or it would delete
      // every job row. Every tab reads jobs from the table, so an empty jobs array in
      // the blob affects no one.
      // FLEET GATE (GATE-ON-EVERY-WRITE-PATH). This check lives HERE, before the
      // UPDATE — not only on the signal/adopt path — because flush() is driven by its
      // own 600ms save timer: a tab that has been backgrounded for hours can wake and
      // land a full-blob write without ever taking the adopt path, resurrecting a slice
      // mid-prune. Reload instead of writing, AFTER force-persisting the cache so the
      // user's unsaved edits survive the reload and replay via setPending on reboot.
      if (isBuildTooOld()) {
        persistCache({ force: true });
        if (!reloadedForBuildGate) {
          reloadedForBuildGate = true;
          console.warn(`[sync] client build ${APP_BUILD} is below the required ${minClientBuild}. Reloading.`);
          try { if (typeof window !== 'undefined') window.location.reload(); } catch { /* ignore */ }
        }
        // Reload is async (and may be blocked). Either way this tab must NOT write.
        return;
      }

      const live = getState();
      // ⚠️ HOW MANY PENDING ACTIONS THIS WRITE ACTUALLY COVERS.
      //
      // Read in the same synchronous turn as getState(), which is what makes it exact:
      // dispatchLocal pushes to the pending queue and applies the action in one turn
      // (store/index.jsx), the queue is append-only, and flush() runs from a timer
      // rather than inside a dispatch. So the first N entries are precisely the actions
      // reflected in `live` — no more, no less.
      //
      // 🔴 WHY THIS MATTERS. clearPending() used to wipe the WHOLE queue on commit. But
      // the network write below is awaited, and the user keeps working during it: any
      // action dispatched in that window lands in the queue and in local state, yet is
      // NOT in the `shared` snapshot being written. Clearing it anyway made the queue
      // claim those edits were saved when they were not. Locally nothing looked wrong —
      // the `dirty` flag schedules a follow-up flush that would persist them — but if a
      // CAS conflict landed first, adoptRemote() replaced local state with the remote
      // document and replayed a queue that no longer contained them. The edits were
      // gone, silently.
      //
      // Clearing the PREFIX is the whole fix, and the precision is load-bearing in both
      // directions: clearing too much loses edits (the bug above), and clearing too
      // little replays already-committed actions on the next conflict — which for
      // ADD_INVOICE_PAYMENT means recording the same payment twice.
      const pendingCovered = getPending().length;
      // The per-row mirrors read the LIVE arrays at mirror time (liveSlices()),
      // not a flush-start snapshot. A peer's row applied by the realtime
      // coalescer DURING the awaited POST advances lastSyncedJobs to the peer's
      // object; diffing a stale flush-start snapshot against that baseline
      // emitted this tab's OLD copy of a row the user never touched and
      // OVERWROTE the peer's newer data (worst on the conflict branch, which
      // fires exactly during multi-writer storms). At call time the advanced
      // rows are reference-equal to the baseline and drop out of the diff,
      // while genuine local edits — including ones made mid-flight — are
      // legitimately included. (The blob snapshot below is unrelated: taken
      // once for the CAS write + content-guard, as ever.)
      // Same shared helper AND the same freeze list as serializeShared() — see the
      // contract note above; passing a different freeze value here would silently
      // drift the content-guard baseline.
      const shared = toSharedBlob(live, freezeStrip);
      // canonicalJson, NOT JSON.stringify: the baseline (serializeSharedBlob) and this
      // snapshot must serialize equal content identically regardless of object key
      // ORDER — org_state is jsonb (keys re-sorted on read), so a plain stringify of
      // the live state never matched an adopted copy and every flush became a no-op
      // write that re-armed the other tab (2026-09-02: one blob write every ~32 s all
      // night, each re-running the jobs delete-diff). See lib/canonicalJson.js.
      const sharedJson = canonicalJson(shared);

      // Content-guard: if the blob is byte-identical to what we last saw in the DB there
      // is nothing to persist in org_state — SKIP the version-bumping UPDATE and its
      // Realtime signal fan-out entirely. Still mirror any per-row jobs delta (a jobs-only
      // change leaves the blob identical) and settle status. This is the dominant cut for
      // the Realtime-message overage: no-op dispatches and jobs-only edits stop signalling
      // every connected client.
      if (sharedJson === lastSavedStateJson) {
        // Prefix only — see pendingCovered. The blob part is a genuine no-op for the
        // actions in the snapshot, but anything dispatched since must stay queued.
        setPending(getPending().slice(pendingCovered));
        const mirrored = await mirrorSlices(liveSlices());
        if (mirrored) {
          saveSucceeded();
          // force: the queue just SHRANK, and the throttled path may skip this
          // snapshot — a cache still holding committed creates replays them on
          // the next cache-first boot (duplicate series, 2026-07-30).
          persistCache({ force: true });
          // Synced only with nothing waiting: not marked for a follow-up, and no save armed (an
          // edit made while this one was in flight, CS-952).
          if (!dirty && !saveTimer) setStatus('synced');
        } else {
          // The per-row jobs mirror was the only network op here and it failed. Keep the
          // delta (lastSyncedJobs is unadvanced, so the next flush re-diffs it) and retry
          // after the backoff, showing offline or error as the failure was. (A pure no-op
          // with no jobs delta never reaches here: an empty delta makes no network call.)
          saveFailed(lastMirrorFailure || { unreachable: true });
        }
        return;
      }

      const target = baseVersion + 1;
      lastWrittenVersion = target;
      // Increment 1d: the write goes through a service-role endpoint that stamps authorship
      // from the caller's JWT claim — the ONLY path a save has (CS-009, lib/stateApi.js).
      const stamp = writeStamp();
      const viaServer = await postOrgState({
        stateJson: sharedJson, // already serialized for the content guard — don't re-stringify ~800 KB
        baseVersion,
        build: stamp.updated_by_build,
        tab: stamp.updated_by_tab,
      });

      if (!viaServer.ok && viaServer.gated) {
        // The server refused because this tab is below min_client_build. Same
        // response as the local gate: persist, then reload onto a newer build.
        persistCache({ force: true });
        if (!reloadedForBuildGate) {
          reloadedForBuildGate = true;
          console.warn(`[sync] server rejected the write: build ${APP_BUILD} < min_client_build ${viaServer.minClientBuild}. Reloading.`);
          try { if (typeof window !== 'undefined') window.location.reload(); } catch { /* ignore */ }
        }
        return;
      }
      if (!viaServer.ok && viaServer.rejected) {
        // The org-state field guard refused this save (a change the caller's access level
        // doesn't cover). A REAL answer: never retried through another path (that bypassed
        // the guard once — 2026-07-30 roles incident). But the save carried EVERY action of
        // the last ~600 ms, and dropping them all lost the unrelated edits beside the refused
        // one while the status said "synced" (CS-008). So the batch is ISOLATED: saved again
        // one action at a time, and only what the guard refuses is dropped — and reported.
        // (The guard judges a save against its OWN base version: a stale base is answered 409
        // and replayed below, never refused here — api/state/org-state.js.)
        await isolateRefusedBatch(pendingCovered, stamp);
        return;
      }
      if (!viaServer.ok && viaServer.terminal) {
        // TERMINAL auth (account-disabled / not-on-team): this login can no longer
        // write. Retrying would spin against the same 403 forever ("offline" that never
        // clears). stateApi already handed the account off to AuthProvider to sign out;
        // drop the actions we can never persist and return WITHOUT marking dirty, so no
        // retry is scheduled. Guarded against a sign-out loop by the handler itself.
        setPending(getPending().slice(pendingCovered));
        dirty = false;
        return;
      }
      if (!viaServer.ok && !viaServer.conflict) {
        // 🔴 CS-009: THE SAVE DID NOT LAND, AND NOTHING ELSE IS TRIED. Unreachable (offline,
        // the 12 s abort), not signed in, a server error, a missing route, over the size limit
        // (413 — the person is TOLD, once): the pending actions stay queued (and in the
        // offline cache), the status says offline or error, and the save is retried after the
        // backoff — never sooner. This branch used to write org_state DIRECTLY, a write the
        // database has refused since Increment 1e (it matched no row and said nothing), which
        // read as a conflict and re-saved in 600 ms for ever. Crew (CS-002) and office alike.
        saveFailed(viaServer);
        return;
      }

      if (viaServer.ok) {
        saveSucceeded();
        baseVersion = target;
        lastSavedStateJson = sharedJson; // the blob now committed to the DB
        // Prefix only — this write persisted exactly the first `pendingCovered` actions.
        // Anything dispatched while the write was in flight stays queued so the next
        // conflict can still replay it. See the note at pendingCovered.
        setPending(getPending().slice(pendingCovered));
        // 🔴 HONOR THE MIRROR RESULT. This used to discard it — the blob commit
        // 200'd, the jobs POST failed on a slow link, and the tab reported
        // 'synced' with no retry: the un-POSTed rows lived only in RAM + cache
        // and died on reload (Lauren, 2026-08-13 — series creates vanishing).
        // The content-guard path below has always handled the same call
        // correctly; this branch was the outlier. lastSyncedJobs only advances
        // inside mirrorJobs ON SUCCESS, so on failure the diff survives intact
        // and dirty→scheduleSave retries it until it lands.
        const mirrored = await mirrorSlices(liveSlices());
        // force (not throttled) EITHER WAY: the saved prefix just dropped from
        // the queue, and a throttled skip here leaves committed creates in the
        // cached queue to replay as duplicates on the next cache-first boot.
        if (mirrored) {
          persistCache({ force: true });
          if (!dirty && !saveTimer) setStatus('synced');   // nothing waiting (CS-952), as above
        } else {
          saveFailed(lastMirrorFailure || { unreachable: true }); // force-persists the cache too
        }
        // CS-002: the server merged this crew save and DROPPED changes it doesn't allow.
        // Refetch + adopt so local state converges to the server's merged truth (the dropped
        // edits, already cleared from the committed pending prefix, revert in the UI).
        if (viaServer.dropped && viaServer.dropped.count) {
          try {
            const remote = await fetchLatest();
            if (remote) adoptRemote(remote);
          } catch { /* next signal / backstop reconciles */ }
        }
      } else {
        // Version moved under us — someone else saved first.
        // 🔴 MIRROR THE JOBS DELTA FIRST. public.jobs is an independent table;
        // its per-row writes have nothing to do with the blob's CAS, but this
        // branch used to return without ever calling mirrorSlices — so under a
        // multi-writer conflict storm (US peak) a slow-link tab's schedule
        // edits were NEVER persisted while every retry conflicted again
        // (Lauren, 2026-08-13: zero jobs-delta POSTs across whole sessions).
        // Safe here: adoptRemote keeps every table-owned slice, so the rows
        // just mirrored survive the adopt; mirrorJobs advances lastSyncedJobs
        // only on success; and the server's data-equality guard no-ops any
        // row a realtime echo already advanced past. On failure, mark dirty so
        // the finally-block reschedules even if the pending queue is empty.
        const mirroredOnConflict = await mirrorSlices(liveSlices());
        if (!mirroredOnConflict) saveFailed(lastMirrorFailure || { unreachable: true });
        const remote = await fetchLatest();
        if (remote) adoptRemote(remote);
      }
    } catch (e) {
      // A read on the way (the conflict branch's fetchLatest) never got an answer. Leave
      // state dirty; the retry after the backoff re-attempts, and the cache keeps the edits.
      saveFailed({ unreachable: true, error: e?.message || String(e) });
    } finally {
      saving = false;
      if (dirty) { dirty = false; scheduleSave(); }
      // A peer-save signal arrived mid-flush and was deferred (see
      // subscribeSignal). Reconcile now that the save has settled — resync()
      // fetches the latest version and adopts if we're behind, and it bails
      // by itself if another flush has already started.
      if (deferredSignalAdopt) {
        deferredSignalAdopt = false;
        resync().catch(() => { /* next signal/backstop reconciles */ });
      }
    }
  }

  // The save's one timer. It forgets itself as it fires, so `saveTimer` says exactly whether a save
  // is still waiting to go: a save that lands while the next one waits must not say 'synced'
  // (CS-952: an area saved while an earlier save was in flight read as synced before it was sent,
  // and its QR code was never asked for).
  function armSave(ms) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, ms);
  }

  function scheduleSave() {
    if (offlineSince) {
      // Backing off after a failed save: keep the 'offline' / 'error' status and retry
      // gently — 5 s, doubling to at most 60 s (retryDelay, CS-009) — rather than spinning
      // failed calls every 600 ms; this matters on the crew's phones. A save that lands, or
      // the browser coming back online, resets the backoff.
      armSave(retryDelay());
      return;
    }
    setStatus('saving');
    armSave(SAVE_DEBOUNCE_MS);
  }

  function subscribeRealtime() {
    // supabase-js reuses a channel by topic, and calling .on() on an already-
    // subscribed channel throws "cannot add postgres_changes callbacks ... after
    // subscribe()". A prior mount (or StrictMode's double-invoke) can leave a
    // live channel behind, so remove any stale one for this topic first — this
    // is the recurring "[store] initial sync failed" error.
    const topic = `org_state_signal:${ORG_ID}`;
    supabase.getChannels()
      .filter((ch) => ch.topic === topic || ch.topic === `realtime:${topic}`)
      .forEach((ch) => { try { supabase.removeChannel(ch); } catch { /* ignore */ } });
    channel = supabase
      .channel(topic)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'org_state_signal', filter: `organization_id=eq.${ORG_ID}` },
        async (payload) => {
          const v = payload.new?.version;
          const by = payload.new?.updated_by;
          if (typeof v !== 'number' || v <= baseVersion) return;
          if (by === userId && v === lastWrittenVersion) return; // our own echo
          // 🔴 NEVER adopt mid-flush. resync() and backstopPoll() both bail on
          // `saving`; this handler didn't — so a peer's save landing while our
          // POST was in flight adopted + replayed the pending queue, and the
          // 409 branch then replayed it AGAIN: the double-apply that left a
          // client duplicated in the blob's clients array (2026-08-13, live).
          // Defer to the flush's finally, which resyncs once the save settles.
          if (saving) { deferredSignalAdopt = true; return; }
          try {
            const remote = await fetchLatest();
            if (remote && remote.version > baseVersion) adoptRemote(remote);
          } catch { /* transient — next signal or save will reconcile */ }
        },
      )
      .subscribe();
  }

  // B1 Stage 2: subscribe to per-row public.jobs changes and patch the in-memory jobs
  // array. Skip our own upsert echoes (already applied locally); deletes are idempotent
  // so always applied. Same stale-channel cleanup as the signal channel.
  function subscribeJobsRealtime() {
    const topic = `jobs:${ORG_ID}`;
    supabase.getChannels()
      .filter((ch) => ch.topic === topic || ch.topic === `realtime:${topic}`)
      .forEach((ch) => { try { supabase.removeChannel(ch); } catch { /* ignore */ } });
    jobsChannel = supabase
      .channel(topic)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'jobs', filter: `organization_id=eq.${ORG_ID}` },
        (payload) => {
          try {
            if (payload.eventType === 'DELETE') {
              const id = payload.old?.id;
              if (id) queueRealtimeJobsPatch(null, id); // coalesced; baseline advances at flush
              return;
            }
            const row = payload.new;
            if (!row || !row.id || !row.data) return;
            // Echo suppression keys on the TAB, not the user. Keying on userId
            // made a user's own second tab (or phone) discard the write and sit
            // stale — the trap already called out in jobsSync.js's writeStamp
            // comment. updated_by_tab is per-page-load, so only the originating
            // tab suppresses. Falls back to the old userId compare for rows
            // written before the stamp existed.
            const sameTab = row.updated_by_tab
              ? row.updated_by_tab === TAB_ID
              : row.updated_by === userId;
            if (sameTab) return; // our own echo — already applied locally
            // Carry the server version so the reducer's order guard can tell a
            // reordered delivery from a genuinely newer one. Coalesced: one
            // PATCH_JOBS per window, baseline advanced at flush — never re-POSTed.
            queueRealtimeJobsPatch({ ...row.data, _rv: row.row_version ?? 0 }, null);
          } catch { /* ignore malformed payload */ }
        },
      )
      .subscribe();
  }

  // Re-establish a realtime channel if its socket dropped. supabase-js doesn't always
  // auto-rejoin after a long background/offline stretch, which would silently strand a
  // tab on stale state until its next local save. Covers both channels.
  function ensureSubscribed() {
    const revive = (ch, resub) => {
      if (!ch) { jitteredResubscribe(resub); return; }
      const st = ch.state;
      if (st === 'closed' || st === 'errored' || st === 'leaving') {
        try { supabase.removeChannel(ch); } catch { /* ignore */ }
        jitteredResubscribe(resub);
      }
    };
    revive(channel, subscribeRealtime);
    // Do NOT revive the jobs channel while it is deliberately detached for a
    // hidden tab — `jobsChannel = null` is exactly what revive() treats as "died,
    // rejoin me", so without this guard the reviver would silently undo every
    // detach and the billing win would never materialise. Re-attach is owned by
    // reattachAfterHidden(), which pairs it with the catch-up poll.
    if (!detachedForHidden) revive(jobsChannel, subscribeJobsRealtime);
  }

  // Channel JOINS are rate-limited separately from message volume, and this workforce
  // starts shifts together — crew opening the app at the top of the hour, and the
  // Manila staff logging on in a block. Every one of those tabs revives its channels at
  // the same instant (same visibility/online event, same wall clock), so the joins
  // arrive as a spike rather than a flow, and a spike is what trips the ceiling.
  // Spreading them over a short random window costs the user nothing — realtime is an
  // optimisation layered over the fetch-on-focus path, which has already run.
  const JOIN_JITTER_MS = 1500;
  function jitteredResubscribe(resub) {
    const delay = Math.floor(Math.random() * JOIN_JITTER_MS);
    setTimeout(() => {
      if (!started) return; // stopped (sign-out / remount) while waiting — don't revive
      try { resub(); } catch { /* best-effort; the next visibility/online event retries */ }
    }, delay);
  }

  // On tab refocus / network recovery, re-subscribe and pull the latest document
  // so a long-idle tab catches anything it missed while the socket was down
  // (incl. notifications fanned out by a peer tab or a server cron). adoptRemote
  // replays unsaved local edits, so this is safe even mid-edit.
  async function resync() {
    if (!started) return;
    ensureSubscribed();
    // If the jobs window never loaded at boot (offline / a transient read error), load it
    // now that the tab is active again — until it does, the per-row mirror stays gated and
    // TOP_UP is held, so job edits wouldn't persist.
    if (!jobsReady) loadJobsBaseline();
    // Don't adopt+replay while a save is mid-flight — the flush's own CAS-conflict
    // path will reconcile, and replaying still-pending actions here could
    // double-apply non-idempotent reducers.
    if (saving) return;
    try {
      const remote = await fetchLatest();
      // A successful read means the backend is reachable again — clear the outage
      // backoff. If we adopt, the replayed edits (if any) flush and settle status;
      // otherwise flip a formerly-offline viewing tab back to 'synced' itself.
      offlineSince = 0;
      if (remote && remote.version > baseVersion) adoptRemote(remote);
      else if (currentStatus === 'offline' && !dirty && getPending().length === 0) setStatus('synced');
    } catch { /* still unreachable — leave the offline state as-is */ }
  }

  // Read-only resync backstop: every BACKSTOP_POLL_MS, cheaply poll just the version.
  // If it advanced past ours we missed a Realtime signal (socket blip with no
  // focus/visibility/online event to trigger resync) — pull the full doc and adopt.
  // When Realtime is healthy this is a no-op (v === baseVersion), so it costs one tiny
  // SELECT per tab per interval and NEVER writes or fans a signal out. Replaces the
  // accidental backstop that the (now-removed) 60 s snapshot write used to provide.
  const BACKSTOP_POLL_MS = 60000;
  async function backstopPoll() {
    if (!started || saving) return;
    try {
      const v = await fetchVersion();
      if (typeof v === 'number' && v > baseVersion) {
        const remote = await fetchLatest();
        if (remote && remote.version > baseVersion) adoptRemote(remote);
      }
    } catch { /* transient — the next tick retries */ }
    await jobsCursorPoll();
  }

  // KEYSET CURSOR POLL for jobs (Increment 2) — the AUTHORITATIVE delivery
  // guarantee for per-row changes, of which realtime is only an optimisation.
  //
  // The version poll above cannot see jobs at all: jobs live per-row in
  // public.jobs and never bump the blob's version, so a dropped jobs message
  // leaves a tab silently stale until its next full boot. The order guard cannot
  // help either — a DROPPED message has no row to compare against. This closes
  // that hole: ask for everything written past our cursor, which is one indexed
  // keyset scan rather than a refetch of ~19k rows, and is a genuine no-op
  // (zero rows) whenever realtime is healthy.
  //
  // CURSOR-OWNED-BY-FETCH: jobsCursor advances ONLY here and at boot, never from
  // a realtime patch. Advancing it from an unordered message could push it past
  // rows that were never delivered, and they would then be missed forever.
  const JOBS_PAGE = 1000;
  // Drains a 4,935-row account delete in ONE poll instead of five minutes at a page
  // per 60s. Bounded so a pathological backlog cannot monopolise a tick.
  const MAX_PAGES_PER_POLL = 8;

  async function jobsCursorPoll() {
    if (!started || !jobsReady) return; // pre-baseline, boot owns the truth
    try {
      for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
        // Both streams share one scalar cursor because job_deletes.row_version draws
        // from the same sequence as jobs.row_version. Issued together so the delete
        // feed adds no latency; `tombs` is null while the migration is unapplied.
        const [rows, tombs] = await Promise.all([
          fetchJobsSince(jobsCursor, JOBS_PAGE),
          fetchJobDeletesSince(jobsCursor, JOBS_PAGE),
        ]);
        const tombRows = tombs || [];

        // The reaper leaves a watermark ABOVE everything it removed, so a cursor old
        // enough to have missed those tombstones is necessarily below it. Seeing the
        // marker means the delete feed has a hole nothing incremental can close: load the
        // window again from the table (unsaved local changes survive the merge).
        if (tombRows.some((t) => t.job_id === REAP_MARKER_ID)) {
          await reloadJobsBaseline();
          return;
        }
        if (!rows.length && !tombRows.length) return;

        const deletes = [];
        for (const t of tombRows) {
          // Memory BEFORE the dispatch, so the order guard has a floor for the id the
          // moment it leaves state.jobs.
          jobTombstones.record(t.job_id, t.row_version);
          deletes.push(t.job_id);
        }
        dispatch({ type: ACTIONS.PATCH_JOBS, upserts: rows, deletes });
        // Server-originated rows (incl. this tab's own poll-recovered echoes) must
        // advance the mirror baseline, or the next flush re-POSTs them — the
        // ping-pong loop. See advanceJobsBaseline.
        advanceJobsBaseline(rows, deletes);

        const upsertFull = rows.length === JOBS_PAGE;
        const tombFull = tombs !== null && tombRows.length === JOBS_PAGE;
        const next = nextJobsCursor({
          cursor: jobsCursor,
          upsertMax: maxRv(rows),
          tombMax: tombRows.length ? tombRows[tombRows.length - 1].row_version : 0,
          upsertFull,
          tombFull,
        });
        if (next <= jobsCursor) return;  // no forward progress — never spin
        jobsCursor = next;
        if (!upsertFull && !tombFull) return; // both streams drained
      }
    } catch (e) {
      // Was a bare `catch {}`. This poll is the ONLY delivery guarantee the jobs
      // slice has, and a permanently dead one was undetectable from the client.
      console.warn('[sync] jobs cursor poll failed:', e?.message || e);
    }
  }

  // ── DETACH-ON-HIDDEN (Increment 0.5b) ──────────────────────────────────────
  // Realtime is billed per message PER SUBSCRIBER, so a tab that has been hidden
  // for hours still costs a full copy of every change in the org. On this
  // workforce that is the common case: crew leave the CRM open on a phone all
  // shift while working in other apps.
  //
  // This was deliberately HELD until the keyset cursor poll existed. Detaching a
  // channel means missing every message sent while away, so without a recovery
  // mechanism it would have traded a billing win for silent staleness — the
  // worst possible trade on a scheduling app. jobsCursorPoll is that mechanism:
  // on re-attach we fetch everything past the cursor, so a detached stretch is
  // recoverable by construction rather than by luck.
  //
  // Not immediate: people flip tabs constantly, and detach/rejoin churn would
  // just move the cost to channel JOINS (which are rate-limited separately and
  // already spike at shift start). Only a SUSTAINED hidden stretch detaches.
  const HIDDEN_DETACH_MS = 5 * 60 * 1000;
  let hiddenDetachTimer = null;
  let detachedForHidden = false;

  function detachHeavyChannels() {
    if (detachedForHidden || !started) return;
    detachedForHidden = true;
    // Only the per-row jobs channel — by far the highest-volume subscription.
    // The org_state signal channel is one tiny message per blob change and is
    // what tells a returning tab it has anything to catch up on at all.
    if (jobsChannel) {
      try { supabase.removeChannel(jobsChannel); } catch { /* ignore */ }
      jobsChannel = null;
    }
  }

  async function reattachAfterHidden() {
    if (!detachedForHidden) return;
    detachedForHidden = false;
    try { subscribeJobsRealtime(); } catch (e) { console.warn('[sync] jobs re-subscribe failed:', e?.message || e); }
    // Catch up on everything missed while detached. This is the half that makes
    // detaching safe — without it the tab would silently serve stale jobs.
    await jobsCursorPoll();
  }

  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') {
      if (hiddenDetachTimer) { clearTimeout(hiddenDetachTimer); hiddenDetachTimer = null; }
      resync();
      reattachAfterHidden();
    } else {
      persistCache({ force: true }); // snapshot latest state before the tab is backgrounded/closed
      if (hiddenDetachTimer) clearTimeout(hiddenDetachTimer);
      hiddenDetachTimer = setTimeout(detachHeavyChannels, HIDDEN_DETACH_MS);
    }
  };
  // Network came back: drop the outage backoff, push any unsaved edits immediately,
  // and pull anything we missed.
  const onOnline = () => { offlineSince = 0; failStreak = 0; if (dirty) scheduleSave(); resync(); };

  // The sign-out flush (see flushSyncBeforeSignOut). Cancels the debounce and
  // drives flush() directly, then verifies NOTHING is left local: blob clean
  // (not dirty, empty pending queue) AND the jobs mirror caught up (baseline
  // matches state — after a clean mirror they are the same array reference, so
  // the diff only runs when they genuinely diverged). A flush that lands while
  // another is in flight just marks dirty and returns, and a CAS conflict costs
  // a round-trip — so give it three beats before declaring failure.
  async function finalFlush() {
    // A sign-out from the boot screen (CS-672): the first load never landed and no edit is waiting,
    // so nothing local exists to lose — and the seed placeholder must not be "saved" on the way out.
    if (!loaded && !getPending().length) return true;
    for (let i = 0; i < 3; i++) {
      if (!started) return true;
      if (persistAbandoned) return false; // wipe already begun — nothing more to save
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      try { await flush(); } catch { /* judged by the clean check below */ }
      const jobsNow = getState().jobs;
      const diffEmpty = (base, cur) => {
        if (cur === base) return true;
        const d = diffJobs(base, cur);
        return d.changed.length === 0 && d.removed.length === 0;
      };
      // 🔴 Three ways jobs can be un-clean at sign-out, and ALL must hold clean:
      //   · a live DEFERRED stash (cachedPendingJobsRows) — carried-over rows
      //     whose recovery couldn't run (tombstone lookup down). They exist only
      //     in the cache the wipe is about to destroy — never clean, in EITHER
      //     jobsReady state (hydration completes with jobsReady=true while a
      //     deferred stash is still in hand).
      //   · jobsReady: the mirror baseline diff (includes unmirrored deletes).
      //   · !jobsReady: "baseline matches" is vacuous (mirror gated) — instead
      //     diff against the painted snapshot, which is exactly how
      //     loadJobsBaseline detects gap edits made before the window landed
      //     (a jobs-only edit there rides the content-guard path, drops
      //     its queue prefix, and reports 'synced' while living only in RAM).
      const stashClean = !(cachedPendingJobsRows && cachedPendingJobsRows.length)
        && !pendingRecoveryInFlight;
      // The !jobsReady window diff must ignore PEER rows: the realtime channel
      // is live during the windowed phase, and a peer's PATCH_JOBS builds new
      // arrays/objects that a pure reference diff counts as "local changes" —
      // firing the loss warning with nothing local at stake, on exactly the
      // slow-hydrating boots this targets. A peer row always carries a FRESHER
      // _rv than the window copy (or a server _rv where the window had none);
      // a local mutation preserves _rv and a local create has none. Removed
      // rows stay unclean (a peer delete is rare; warning is the safe side).
      const windowClean = () => {
        if (!windowSnapshot || jobsNow === windowSnapshot) return true;
        const d = diffJobs(windowSnapshot, jobsNow);
        if (d.removed.length) return false;
        const prevById = new Map(windowSnapshot.map((j) => [j.id, j]));
        return !d.changed.some((j) => {
          const prev = prevById.get(j.id);
          return prev ? (j._rv ?? 0) <= (prev._rv ?? 0) : !(j._rv > 0);
        });
      };
      const jobsClean = stashClean && (jobsReady
        ? diffEmpty(lastSyncedJobs, jobsNow)
        : windowClean());
      if (!dirty && getPending().length === 0 && jobsClean) return true;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return false;
  }

  return {
    async start() {
      if (started) return;
      started = true;
      activeFinalFlush = finalFlush;
      activeMarkCacheWipe = (on = true) => { persistAbandoned = on; };
      // Settles only once the company's data has loaded (from the cache, or a read that answered —
      // CS-672), or when stop() ends the wait.
      await loadInitial();
      // A stop() may have landed during the awaited load (StrictMode remount /
      // re-auth). Bail before wiring listeners + channel so we don't leak them on
      // an already-stopped instance that nothing will clean up.
      if (!started) return;
      loaded = true;
      // Realtime is best-effort — a subscription hiccup must NOT reject start()
      // (loadInitial already hydrated the shared doc), otherwise the store would
      // hold the boot screen over a non-critical realtime error.
      try { subscribeRealtime(); } catch (e) { console.warn('[sync] realtime subscribe failed:', e?.message || e); }
      try { subscribeJobsRealtime(); } catch (e) { console.warn('[sync] jobs realtime subscribe failed:', e?.message || e); }
      if (typeof window !== 'undefined') {
        window.addEventListener('online', onOnline);
        document.addEventListener('visibilitychange', onVisibility);
      }
      backstopTimer = setInterval(backstopPoll, BACKSTOP_POLL_MS);
      // Don't stomp an offline boot (bootFromCache set 'offline'); the reconnect
      // flush flips it back to 'synced' when the backend returns.
      if (currentStatus !== 'offline') setStatus('synced');
    },
    // Called by the store after each local (user-initiated) action.
    notifyChange() {
      if (started) scheduleSave();
    },
    // Point-in-time sync snapshot for the support "Report an issue" packet.
    // baseVersion is the CAS version of the shared blob this client last
    // hydrated/wrote; dirty means local edits are still awaiting a save.
    getDiagnostics() {
      return { version: baseVersion, dirty };
    },
    // The boot screen's Retry (CS-672): a first read waiting on its back-off is tried again at
    // once. A no-op while an attempt is running, and once the first load has landed.
    retryBoot() {
      if (bootRetryNow) bootRetryNow();
    },
    // Jobs beyond the window, on demand (CS-676) — the store's useJobsLoader hands these to the
    // screens. Each resolves once the cleans are in state and throws when they could not be read.
    ensureJobsRange,
    ensureSeries,
    ensureClientJobs,
    ensureJobsByIds,
    // Rows a SERVER route wrote and handed back in its answer (QR Wave 2: the fill-in, EP-419, and
    // the cleaner's own clean at a scanned building, EP-420), applied NOW rather than on the next
    // realtime message or poll: as server-originated rows — PATCH_JOBS (the order guard keeps the
    // newer of two versions) and the mirror baseline, so they are never POSTed back (the ping-pong
    // law, II.8). `rescope`: a crew login's projection is scoped by its own cleans (CS-002), so a
    // clean it just joined brings that customer and its locations into it although the shared
    // record's version did not move — the projection is read again and adopted first (never
    // mid-save: adoptRemote replays unsaved edits, so it waits for a save in flight).
    async adoptServerJobs(rows, { rescope = false } = {}) {
      const list = (Array.isArray(rows) ? rows : []).filter((j) => j && typeof j.id === 'string' && j.id);
      if (rescope && restrictedRead && started) {
        for (let i = 0; saving && i < 25; i += 1) await new Promise((r) => setTimeout(r, 200));
        if (started && !saving) {
          try {
            const remote = await fetchLatest();
            if (started && !saving && remote && remote.version >= baseVersion) adoptRemote(remote);
          } catch { /* the next signal, focus or poll reconciles */ }
        }
      }
      if (!started || !list.length) return;
      dispatch({ type: ACTIONS.PATCH_JOBS, upserts: list, deletes: [] });
      advanceJobsBaseline(list, []);
    },
    isRangeLoaded,
    isSeriesLoaded,
    isClientLoaded,
    stop() {
      started = false;
      // A first read still waiting ends here, its timers with it (start() then settles unloaded).
      if (bootStop) bootStop();
      if (activeFinalFlush === finalFlush) { activeFinalFlush = null; activeMarkCacheWipe = null; }
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (backstopTimer) { clearInterval(backstopTimer); backstopTimer = null; }
      // Drop any coalescing window in flight — its flush also bails on !started,
      // but the timer itself must not outlive the manager (StrictMode remount).
      if (rtJobsTimer) { clearTimeout(rtJobsTimer); rtJobsTimer = null; rtJobsBuf = { upserts: [], deletes: [] }; }
      // Abandon a pending jobs-window retry — its loadJobsBaseline also bails on !started,
      // but the timer must not outlive the manager.
      if (baselineRetryTimer) { clearTimeout(baselineRetryTimer); baselineRetryTimer = null; }
      // Release anyone waiting on the baseline (the screens' ensure* calls): this manager will
      // never load it; the next one starts its own.
      { const waiters = baselineWaiters; baselineWaiters = []; for (const w of waiters) { try { w(); } catch { /* ignore */ } } }
      // A pending detach must not fire against a stopped manager (sign-out /
      // StrictMode remount), and the flag must reset or a fresh instance would
      // start believing it is detached and never subscribe.
      if (hiddenDetachTimer) { clearTimeout(hiddenDetachTimer); hiddenDetachTimer = null; }
      detachedForHidden = false;
      if (channel) { supabase.removeChannel(channel); channel = null; }
      if (jobsChannel) { supabase.removeChannel(jobsChannel); jobsChannel = null; }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
}
