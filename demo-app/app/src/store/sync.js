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
import { ACTIONS } from './reducer';
import { productionInitialState } from '../data/seed';
import { persistJobsDelta, fetchAllJobs, fetchJobsWindow, fetchJobsSince, fetchJobDeletesSince, fetchJobDeletesByIds, nextJobsCursor, REAP_MARKER_ID, mergeFullJobs, maxRv, jobsInWindow, advanceBaseline, diffJobs } from './jobsSync';
import jobTombstones from './jobTombstones';
import { cacheDoc, cacheJobs, cacheQueue, cachePendingJobs, readCache } from './offlineCache';
import { toSharedBlob, serializeSharedBlob, tableOwnedSliceKeys } from './tableSlices';
import { canonicalJson } from '../lib/canonicalJson';
import { resolveCurrentUserId } from './identity';
import { APP_BUILD, TAB_ID, writeStamp } from '../lib/appBuild';
import { postOrgState, postSeedState, getStateView } from '../lib/stateApi';

const ORG_ID =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLEANSPACE_ORG_ID) ||
  '00000000-0000-0000-0000-000000000001';
const SAVE_DEBOUNCE_MS = 600;

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

export function createSyncManager({ dispatch, getState, getPending, clearPending, setPending, userId, sessionEmail, claimOrgUserId = null, claimRole = null, onStatus, onJobsReady }) {
  // CS-002 crew READ SPLIT. A non-office login (crew, or a roleless orphan) holds only a
  // SERVER-BUILT PROJECTION of the blob and can no longer read org_state directly once the
  // read-split RLS lands. It reads through GET /api/state/view, polls the open
  // org_state_signal for the version, keeps the org_state_signal realtime subscription, and
  // its writes go to /api/state/org-state where the server MERGES only allowlisted changes
  // (never the posted projection, which would blank what it can't see). Office roles
  // (owner/admin/manager) keep the direct read path unchanged. Mirrors the server's
  // OFFICE_ROLES split (api/_lib/authz.js) so the read projection and the write merge agree.
  const restrictedRead = claimRole !== 'owner' && claimRole !== 'admin' && claimRole !== 'manager';
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
  // Gate the per-row mirror until hydrateJobsFromTable() has established the baseline.
  // Without this, a save that races boot would diff the real jobs against an empty
  // lastSyncedJobs and rewrite all ~5k rows (the migration-era churn we saw). The
  // mirror simply waits one hydrate; the edit is picked up by the next diff.
  let jobsReady = false;
  // Windowed boot: the app paints on a small recent window of jobs (fast first paint),
  // then the COMPLETE set streams in behind it. jobsFullyHydrated flips true once the
  // full set is merged in — it drives the Schedule TOP_UP gate (topping up a series
  // against a partial set would duplicate the unseen tail) via onJobsReady. windowSnapshot
  // holds the exact objects painted first, so the full-load merge can preserve any job
  // edit/create/delete made during the window-only gap. jobsHydrating guards re-entrancy
  // (a boot + a refocus retry must not both run the merge and mass-rewrite the table).
  let jobsFullyHydrated = false;
  let jobsHydrating = false;
  // A single pending backfill-retry timer. completeJobsHydration used to give up
  // after 5 rounds (~30s); on a chronically slow link (Lauren, ZA) that meant it
  // never completed, jobsReady stayed false, and every schedule edit no-op'd in
  // the mirror and was lost on refresh. We now retry indefinitely with capped
  // backoff, but funnel every retry through THIS one handle so concurrent
  // triggers (the backoff chain + resync()'s refocus/reconnect re-fire) can never
  // stack multiple timers. Cleared on stop() so a replaced manager doesn't wake.
  let hydrationRetryTimer = null;
  // The sibling retry for hydrateJobsFromTable (the non-windowed fallback load) gets
  // its OWN handle, not hydrationRetryTimer's: a resync can fire completeJobsHydration
  // while this fallback's retry is still pending, and the two must not share a slot.
  let tableHydrateRetryTimer = null;
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
  const signalJobsReady = () => { jobsFullyHydrated = true; try { onJobsReady?.(); } catch { /* ignore */ } };
  let started = false;
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
    // now the boot window, not the full ~19k-row set (see cacheJobsWindowed).
    // jobsFullyHydrated gate: during a windowed boot the in-memory array is PARTIAL,
    // and caching it would poison the next offline boot (bootFromCache treats the
    // cache as the complete set and un-gates TOP_UP → duplicate occurrences). The
    // cache invariant is: the jobs cache only ever holds a COMPLETE set.
    if (jobsFullyHydrated && st.jobs !== lastCachedJobsRef && (force || now - lastJobsCacheAt > 10000)) {
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

  // B1 Stage 2: jobs live in their own public.jobs table, not the org_state blob.
  // After hydrating the (non-jobs) document, replace the jobs array with the table's
  // authoritative copy, and set the mirror baseline (lastSyncedJobs) from it.
  //
  // 🔴 A FAILED READ MUST NOT ARM THE MIRROR. This used to set `jobsReady = true` and
  // call signalJobsReady() UNCONDITIONALLY, outside the try/catch, on the theory that the
  // blob's jobs were a usable fallback. That stopped being true when `jobs` became a
  // STRIPPED slice (store/tableSlices.js): toSharedBlob writes `shared.jobs = []`, so
  // `blobJobs` is ALWAYS empty and the "fallback" was a baseline of zero rows.
  //
  // The consequences of arming on an empty baseline compound:
  //   · jobsReady=true un-gates jobsCursorPoll, which drains `row_version > 0` from
  //     cursor 0 — the whole table — back into state.jobs via PATCH_JOBS, which never
  //     advances lastSyncedJobs.
  //   · the next save's diffJobs compares ~19k live rows against [] BY REFERENCE, so
  //     every row counts as changed and the entire table is re-upserted. public.jobs is
  //     in the supabase_realtime publication, so that is ~19k per-row events fanned to
  //     every connected client — on a meter already recorded at 191% of plan. This is
  //     precisely the fan-out the whole SCALE remediation exists to remove.
  //   · signalJobsReady() also un-gates the Schedule TOP_UP sweep, whose stated purpose
  //     is that topping up a series against a PARTIAL set duplicates the unseen tail.
  //     An empty set is maximally partial.
  //   · and because signalJobsReady() sets jobsFullyHydrated, resync()'s
  //     `if (!jobsFullyHydrated) completeJobsHydration()` recovery could never fire, so
  //     nothing retried for the life of the page.
  //
  // The SIBLING catch for the identical hazard — completeJobsHydration below — already
  // does the right thing: "Keep the mirror gated (a partial baseline would corrupt the
  // table) and retry with backoff." This one was the outlier. Now it matches.
  //
  // Failing closed costs nothing the failure had not already cost: mirrorJobs no-ops and
  // jobsCursorPoll returns early while jobsReady is false, which is exactly the state a
  // normal windowed boot occupies until its backfill lands. The crew see the same empty
  // schedule either way — the only difference is whether the tab rewrites the table.
  async function hydrateJobsFromTable(blobJobs, attempt = 0) {
    // Reentrancy + mutual exclusion with completeJobsHydration. Both establish the
    // authoritative baseline, and a resync() (refocus/reconnect) can fire completeJobsHydration
    // while THIS fallback loop is mid-flight — so without a shared flag the indefinite retries
    // become TWO concurrent unbounded full-table-read loops on the exact slow link this targets,
    // and a late round can clobber the peer's (orphan-filtered) result and resurrect deleted
    // accounts' jobs. Participate in jobsHydrating and honor the same entry guard so the two
    // chains strictly serialize; whichever is running holds the flag and the other bails (the
    // bailing one drops its retry, handing hydration to the live chain — see the catch below).
    if (!started || jobsFullyHydrated || jobsHydrating) return getState().jobs;
    jobsHydrating = true;
    try {
      const tableJobs = await fetchAllJobs();
      // Re-check after the await: a peer hydrate may have completed (jobsFullyHydrated), or
      // stop() landed, while this read was in flight. Do NOT clobber the baseline or dispatch
      // the UNFILTERED table set into a settled/replaced manager — that is the orphan-
      // resurrection path (completeJobsHydration filters orphans; this read does not).
      if (!started || jobsFullyHydrated) return getState().jobs;
      dispatch({ type: ACTIONS.SET_JOBS, jobs: tableJobs });
      lastSyncedJobs = tableJobs;
      jobsCursor = maxRv(tableJobs); // cursor floor: everything we just fetched
      jobsReady = true;  // baseline established — ONLY on the authoritative read
      signalJobsReady(); // full set present — TOP_UP may run
      await recoverCachedPendingJobs(tableJobs); // previous session's unmirrored rows
      return tableJobs;
    } catch (e) {
      console.warn(`[sync] jobs table read failed (attempt ${attempt + 1}):`, e?.message || e);
      // DISPLAY-ONLY fallback. A pre-strip blob row can still carry a jobs array, and
      // showing it beats showing nothing — but it is NEVER made the mirror baseline.
      // That distinction is the whole fix: the old code conflated "something to paint"
      // with "a baseline safe to diff against", and a stale or empty array is fine for
      // the former and catastrophic for the latter.
      const fallback = Array.isArray(blobJobs) && blobJobs.length ? blobJobs : null;
      if (fallback && attempt === 0) dispatch({ type: ACTIONS.SET_JOBS, jobs: fallback });
      // No baseline, so no mirroring, no cursor poll, no TOP_UP — and jobsFullyHydrated
      // stays false so resync() on refocus/reconnect retries this too. Retry INDEFINITELY
      // with capped backoff (was 5-and-out): a slow link that can't finish the read leaves
      // the mirror gated forever, so giving up strands the schedule un-savable — the same
      // wedge completeJobsHydration fixes. One timer only (see tableHydrateRetryTimer).
      if (!tableHydrateRetryTimer && started && !jobsFullyHydrated) {
        const delay = Math.min(2000 * (attempt + 1), 30000);
        tableHydrateRetryTimer = setTimeout(() => {
          tableHydrateRetryTimer = null;
          hydrateJobsFromTable(blobJobs, attempt + 1);
        }, delay);
      }
      const live = getState().jobs;
      return Array.isArray(live) ? live : [];
    } finally {
      jobsHydrating = false;
    }
  }

  // The rolling-year jobs table is tens of thousands of occurrences (~50 MB) — far more
  // than boot needs to paint. Load a small recent WINDOW first so the app goes interactive
  // in a fraction of the time (this is what un-freezes admins on mobile), then stream the
  // complete set in behind it. Returns the window jobs; the full backfill runs detached.
  function bootWindowRange() {
    const day = 86400000;
    const now = Date.now();
    const isoDate = (t) => new Date(t).toISOString().slice(0, 10);
    // Loose ± bounds — only what to paint FIRST; the full set backfills exact membership
    // seconds later. Wide enough for today's Schedule, My Day, the Dashboard's 30-day
    // tiles, and near-term calendar navigation with no visible gap.
    return { from: isoDate(now - 45 * day), to: isoDate(now + 100 * day) };
  }

  async function hydrateJobsWindowed(blobJobs) {
    let windowJobs;
    try {
      const { from, to } = bootWindowRange();
      windowJobs = await fetchJobsWindow(from, to);
    } catch (e) {
      // Window read failed → fall back to the original full, blocking load so the app
      // still boots with data and the mirror baseline is correct.
      console.warn('[sync] job window read failed. Full load:', e?.message || e);
      return hydrateJobsFromTable(blobJobs);
    }
    dispatch({ type: ACTIONS.SET_JOBS, jobs: windowJobs });
    windowSnapshot = windowJobs;
    // jobsReady stays FALSE: windowJobs is partial and must never become the mirror
    // baseline (the next save would delete every out-of-window row). completeJobsHydration()
    // flips it once the full set is merged in. Detached — the app is already interactive.
    completeJobsHydration();
    return windowJobs;
  }

  // Re-apply unmirrored jobs carried over from the previous session's cache, once
  // the authoritative table set has landed (called from both hydration success
  // paths). CONSERVATIVE by construction — this recovers CREATES only:
  //   · only rows the table does NOT have. An id the table knows means the
  //     mirror won or a peer wrote newer — never clobber that. (Deliberate
  //     limitation: an unmirrored EDIT of an existing row, and an unmirrored
  //     DELETE, are NOT recovered — distinguishing "my edit is newer" from "a
  //     peer's write is newer" isn't decidable from a cached copy, so we take
  //     the table's answer. The lost-series class — creates — is what this
  //     exists for.)
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
    const tombs = await fetchJobDeletesByIds(candidates.map((j) => j.id));
    if (!started || persistAbandoned || jobsFullyHydrated !== true) { cachedPendingJobsRows = rows; return; }
    if (tombs === null) {
      // Unknown — do NOT recover blind. Keep the stash + record for a retry.
      console.warn('[sync] pending-jobs recovery deferred: tombstone lookup unavailable');
      cachedPendingJobsRows = rows;
      return;
    }
    const recovered = candidates.filter((j) => !tombs.has(j.id));
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

  async function completeJobsHydration(attempt = 0) {
    // started guard: a stop() (sign-out / manager remount) must abandon a detached
    // backfill — a late completion would dispatch into and signal a manager that has
    // been replaced. The replacement manager runs its own windowed boot + backfill.
    if (!started || jobsFullyHydrated || jobsHydrating) return;
    jobsHydrating = true;
    try {
      const all = await fetchAllJobs();
      if (!started) return; // stopped while fetching — abandon, don't dispatch
      // Merge the authoritative table set with any job edit/create/delete the user made
      // during the window-only gap (pure, unit-tested — see mergeFullJobs in jobsSync.js).
      // 🔴 DROP ORPHANS BEFORE MERGING. DELETE_CLIENT cascades to jobs with
      // `state.jobs.filter(j => j.clientId !== id)` — but since E6 that array is only the
      // WINDOW, so deleting an account during the windowed phase removes its in-window
      // jobs and leaves the rest. Those out-of-window rows were never in windowSnapshot,
      // so mergeFullJobs cannot classify them as locally-removed: they are merely absent,
      // the authoritative set still has them, and the merge RESURRECTS them. The account
      // is gone from the UI while its jobs come back onto the schedule.
      //
      // Filtering on "the client no longer exists" fixes it as an INVARIANT rather than a
      // special case, so any orphaning path is covered, not just DELETE_CLIENT. Safe
      // because clients live in the blob (never windowed) and the blob is fully hydrated
      // before this runs — and jobs with no clientId are left alone.
      // ⚠️ AND THIS FILTER ITSELF MUST NOT DISENGAGE-OR-OVERREACH. Two guards:
      //
      //   1. Skip entirely when `clients` is empty. An empty client list would classify
      //      EVERY job as an orphan. Clients should always be hydrated by now, but "should
      //      be" is exactly the assumption behind the empty-baseline bug fixed in
      //      3f22431 — so absence of evidence is treated as no evidence, not as proof
      //      that every account was deleted.
      //   2. The baseline below is set to the FILTERED set, deliberately. Setting it to
      //      `all` would make the next mirror pass see the orphans as removed and DELETE
      //      those rows from public.jobs. That is arguably the correct end state, but it
      //      is an irreversible bulk delete triggered by a client-side inference, which
      //      is not a call this path should make on its own. The rows linger in the table,
      //      invisible locally; reclaiming them is logged in LOOP_REVIEW as a data-op.
      const liveClientIds = new Set((getState().clients || []).map((c) => c.id));
      const authoritative = liveClientIds.size === 0
        ? all
        : all.filter((j) => !j.clientId || liveClientIds.has(j.clientId));
      if (authoritative.length !== all.length) {
        console.warn(`[sync] hiding ${all.length - authoritative.length} job(s) whose account no longer exists locally`);
      }
      const { merged, changed, removed } = mergeFullJobs(windowSnapshot, getState().jobs, authoritative);
      dispatch({ type: ACTIONS.SET_JOBS, jobs: merged });
      // Baseline is the PRISTINE table snapshot, so the next save mirrors exactly the gap
      // divergence (changed → upserts, removed → deletes) and rewrites nothing else.
      lastSyncedJobs = authoritative; // see guard 2 above — never `all`, or orphans get bulk-deleted
      jobsCursor = maxRv(all); // cursor floor from the REAL read, so nothing is re-fetched
      jobsReady = true;
      windowSnapshot = null;
      cacheJobsWindowed(merged, new Date().toISOString());
      lastCachedJobsRef = merged;
      lastJobsCacheAt = Date.now();
      signalJobsReady();
      if (changed.length || removed.length) scheduleSave(); // flush any gap edits to the table
      await recoverCachedPendingJobs(authoritative); // previous session's unmirrored rows (schedules its own save)
    } catch (e) {
      console.warn(`[sync] full jobs backfill failed (attempt ${attempt + 1}):`, e?.message || e);
      // Keep the mirror gated (a partial baseline would corrupt the table) and retry with
      // capped backoff — INDEFINITELY, not 5-and-out. A manager whose backfill can't finish
      // has a schedule that silently won't save (mirrorJobs no-ops while !jobsReady), so
      // giving up strands them there; better to keep trying every ≤30s until the link
      // recovers or the tab closes. The entry guard (jobsFullyHydrated) stops the chain the
      // instant a round succeeds. One timer only (see hydrationRetryTimer): resync() may also
      // re-fire completeJobsHydration on refocus/reconnect, and we must not stack chains.
      if (!hydrationRetryTimer && started && !jobsFullyHydrated) {
        const delay = Math.min(2000 * (attempt + 1), 30000);
        hydrationRetryTimer = setTimeout(() => {
          hydrationRetryTimer = null;
          completeJobsHydration(attempt + 1);
        }, delay);
      }
    } finally {
      jobsHydrating = false;
    }
  }

  // Prime the offline cache directly from freshly-loaded values. We can't use
  // persistCache() on the load path: getState() reads stateRef, which lags a
  // just-dispatched HYDRATE/SET_JOBS by a render, so it would cache a stale
  // (empty) jobs array. These are the authoritative values we just fetched.
  function primeCache(state, version, jobs) {
    const at = new Date().toISOString();
    cacheDoc(state, version, at);     // cacheDoc strips jobs + currentUserId itself
    cacheQueue([], at);
    lastDocCacheAt = Date.now();
    // Same complete-set cache invariant as persistCache: after a windowed boot `jobs`
    // is only the painted window — never cache it (a prior session's full cache, if
    // any, stays valid; completeJobsHydration writes the fresh full set when it lands).
    if (jobsFullyHydrated) {
      cacheJobsWindowed(jobs, at);
      lastCachedJobsRef = jobs;
      lastJobsCacheAt = Date.now();
    }
  }

  // Phase 2: boot from the IndexedDB cache when the backend is unreachable, so a
  // signed-in user gets their REAL workspace during an outage instead of a blank
  // seed. Any pending (unsaved) edits are restored so they flush on reconnect.
  // Write only the boot window to IndexedDB (SCALE-C14 / §8 G4). cacheJobs is a
  // main-thread structured clone, so its cost is the row count: the full ~19k set was
  // ~52.9 MB resident, enough to risk the browser evicting the whole origin's storage
  // under quota pressure — which silently destroys the offline cache crew rely on in
  // the field. The IN-MEMORY set stays complete; only the persisted copy is bounded,
  // and every caller is already gated on jobsFullyHydrated.
  //
  // Stamped `windowed` because bootFromCache treats this record as the save baseline
  // and the TOP_UP readiness signal — see there.
  function cacheJobsWindowed(jobs, at) {
    // Gate here (not only in persistCache): completeJobsHydration writes the
    // jobs cache directly, and a backfill settling between sign-out's
    // clearCache() and the SIGNED_OUT-driven stop() must not repopulate the
    // wiped cache on a signed-out device.
    if (persistAbandoned) return false;
    const { from, to } = bootWindowRange();
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
    // Offline boot: the cache carries whatever _rv each job had when cached, so
    // the cursor resumes from there and the first poll on reconnect pulls exactly
    // what changed while this tab was away.
    jobsCursor = maxRv(jobs);
    lastCachedJobsRef = jobs;

    // ⚠️ A WINDOWED CACHE IS NOT AN AUTHORITATIVE BASELINE, and treating it as one is
    // destructive in two separate ways:
    //   • the reconnect flush diffs against it, so every out-of-window job reads as a
    //     local deletion and the save emits a delete for each one;
    //   • TOP_UP derives its tail from the in-memory set, so against a partial set it
    //     appends duplicate occurrences for the not-yet-loaded tail.
    // Both are exactly what hydrateJobsWindowed already guards for the ONLINE windowed
    // boot; this is the offline twin of that guard. Records written before windowing
    // shipped carry no flag and genuinely hold the full set, so they keep the old path.
    // Unmirrored rows from the previous session (empty for pre-feature caches).
    // Consumed by recoverCachedPendingJobs once the authoritative set lands —
    // the hydration merge below would otherwise silently discard them (they're
    // in the cached live array but not in the table). Note the legacy
    // non-windowed path can't recover them (its baseline IS the cached array,
    // so the diff never sees them) — that path only serves pre-windowing cache
    // records, which predate this feature and carry no pending rows anyway.
    cachedPendingJobsRows = Array.isArray(cached.pendingJobsRows) && cached.pendingJobsRows.length
      ? cached.pendingJobsRows
      : null;
    // Seed the latch from the record just read: it starts 0 every session, and
    // without this the record's eventual CLEARING write (persistCache writes
    // only when rows.length || latch) could never fire after a clean recovery —
    // leaving a stale non-empty record to re-run recovery on every future boot.
    lastCachedPendingCount = cachedPendingJobsRows ? cachedPendingJobsRows.length : 0;
    if (cached.jobsWindowed) {
      windowSnapshot = jobs;   // what completeJobsHydration merges the full set onto
      jobsReady = false;       // no mirroring until the authoritative set lands
      jobsFullyHydrated = false;
      // Detached: offline this fails and retries; on reconnect it fills in the tail.
      completeJobsHydration();
    } else {
      jobsReady = true; // baseline is the cache; the reconnect flush diffs against it
      signalJobsReady(); // the cache holds the FULL set — TOP_UP may run
    }
    if (cached.queue && cached.queue.length && setPending) setPending(cached.queue);
    if (markOffline) setStatus('offline');
    return true;
  }

  // Bound the initial read so a hung request during an outage (crew with no
  // signal) doesn't strand the user on the loading screen — after this we fall
  // back to the cache.
  const BOOT_FETCH_TIMEOUT_MS = 8000;
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('boot fetch timeout')), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  async function loadInitial() {
    // CACHE-FIRST PAINT. The cache used to be an outage-only fallback: every
    // ONLINE boot blocked first paint on the ~800 KB blob fetch plus the
    // windowed jobs pages — seconds of loader for data already sitting in
    // IndexedDB from the last visit. Paint from the cache immediately and
    // freshen through resync(), which is the SAME battle-tested path an
    // offline tab takes when connectivity returns: fetchLatest → adoptRemote
    // (keeps table-owned jobs, replays pending), completeJobsHydration if the
    // cache was windowed (bootFromCache already gated jobsReady/TOP_UP for
    // that), and the cursor poll resuming from the cached _rv high-water mark.
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
    // No cache (first visit on this device) — the network-first path. A failed
    // or timed-out fetch propagates: there is no cache to fall back on (the
    // boot above proved that), so the caller fails open onto the seed.
    const existing = await withTimeout(fetchLatest(), BOOT_FETCH_TIMEOUT_MS);
    if (existing && existing.state && Object.keys(existing.state).length > 0) {
      baseVersion = existing.version;
      lastSavedStateJson = serializeShared(existing.state); // blob baseline = the loaded doc
      dispatch({ type: ACTIONS.HYDRATE, payload: withSession(existing.state) });
      const jobs = await hydrateJobsWindowed(existing.state.jobs);
      primeCache(existing.state, existing.version, jobs); // refresh the offline cache (window now; full set re-caches when it lands)
      return;
    }
    // First run for this org — seed a BLANK production state (team + config, no
    // sample customer data). ignoreDuplicates makes this safe if two users sign
    // in for the very first time at once.
    const seed = productionInitialState();
    // Routed through the server like every other write (Increment 1d) so a fresh
    // clone can still seed itself once 1e revokes the browser's write policy.
    // Direct upsert remains only as the pre-1e fallback.
    const seeded = await postSeedState(seed);
    if (!seeded.ok && seeded.unavailable) {
      await supabase.from('org_state').upsert(
        {
          organization_id: ORG_ID,
          state: seed,
          version: 1,
          updated_by: userId,
          updated_at: new Date().toISOString(),
          updated_via: 'browser',
        },
        { onConflict: 'organization_id', ignoreDuplicates: true },
      );
    }
    const after = await fetchLatest();
    baseVersion = after?.version ?? 1;
    const booted = after?.state ?? seed;
    lastSavedStateJson = serializeShared(booted); // blob baseline = the freshly-seeded doc
    dispatch({ type: ACTIONS.HYDRATE, payload: withSession(booted) });
    const jobs = await hydrateJobsWindowed(booted.jobs);
    primeCache(booted, baseVersion, jobs); // prime the offline cache for this org's first run
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
      await persistJobsDelta(lastSyncedJobs, jobsNow, userId);
      lastSyncedJobs = jobsNow;
      return true;
    } catch (e) { console.warn('[sync] jobs mirror failed:', e?.message || e); return false; }
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

  async function flush() {
    if (!started) return;
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
          offlineSince = 0;
          // force: the queue just SHRANK, and the throttled path may skip this
          // snapshot — a cache still holding committed creates replays them on
          // the next cache-first boot (duplicate series, 2026-07-30).
          persistCache({ force: true });
          if (!dirty) setStatus('synced');
        } else {
          // The per-row jobs mirror was the only network op here and it failed (offline).
          // Keep the offline signal and requeue so the delta retries — the edit is already
          // in the offline cache below, and lastSyncedJobs is unadvanced so the next flush
          // re-diffs it. (A pure no-op with no jobs delta never reaches here as a failure:
          // an empty delta makes no network call.)
          dirty = true;
          if (!offlineSince) offlineSince = Date.now();
          setStatus('offline');
          persistCache();
        }
        return;
      }

      const target = baseVersion + 1;
      lastWrittenVersion = target;
      // Increment 1d: the write goes through a service-role endpoint that stamps
      // authorship from the caller's JWT claim. The direct UPDATE below is the
      // fallback for an unreachable server only — Increment 1e revokes the
      // browser's org_state write policy and deletes it. See lib/stateApi.js.
      const stamp = writeStamp();
      const viaServer = await postOrgState({
        stateJson: sharedJson, // already serialized for the content guard — don't re-stringify ~800 KB
        baseVersion,
        build: stamp.updated_by_build,
        tab: stamp.updated_by_tab,
      });

      let committed = viaServer.ok;
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
        // The org-state field guard refused a protected-field change (roles /
        // permissions / standing crew / site parentage). This is a REAL answer:
        // do NOT fall back to the direct write (that bypassed the guard and
        // made the refusal invisible — 2026-07-30 roles incident). Drop the
        // refused actions from the queue (replaying them would refuse forever),
        // adopt the server's state so the UI visibly reverts, and log loudly.
        // The guard only judges a save against its OWN base version: a stale base
        // is answered 409 and replayed below, never refused here (api/state/org-state.js).
        console.error('[sync] protected-field change refused by the server:', viaServer.violations);
        setPending(getPending().slice(pendingCovered));
        try {
          const remote = await fetchLatest();
          if (remote) adoptRemote(remote);
        } catch { /* next signal/backstop resyncs */ }
        dirty = false;
        setStatus('synced');
        return;
      }
      if (!viaServer.ok && viaServer.terminal) {
        // TERMINAL auth (account-disabled / not-on-team): this login can no longer
        // write. NOT transport — the direct-write fallback below and the 5s retry in
        // scheduleSave() would spin against the same 403 forever ("offline" that never
        // clears). stateApi already handed the account off to AuthProvider to sign out;
        // drop the actions we can never persist and return WITHOUT marking dirty, so no
        // retry is scheduled. Guarded against a sign-out loop by the handler itself.
        setPending(getPending().slice(pendingCovered));
        dirty = false;
        return;
      }
      if (!viaServer.ok && viaServer.unavailable) {
        // CS-002: a crew (restricted) client must NEVER fall back to a direct org_state
        // write. Its local state is a PROJECTION, so a direct full-blob write would blank
        // every slice it can't see — and the read-split RLS denies the write anyway. Keep the
        // edit queued (dirty) and retry the server merge path; nothing is lost.
        if (restrictedRead) {
          dirty = true;
          if (!offlineSince) offlineSince = Date.now();
          setStatus('offline');
          persistCache();
          return;
        }
        // Transport failure (cold start, offline). Pre-1e the browser can still
        // write directly, and a save must not be lost to a flaky function.
        const { data, error } = await supabase
          .from('org_state')
          .update({
            state: shared,
            version: target,
            updated_by: userId,
            updated_at: new Date().toISOString(),
            // Build/tab provenance — this is what makes the prune gate checkable:
            // "zero writes with updated_by_build < min_client_build over a soak window".
            ...stamp,
          })
          .eq('organization_id', ORG_ID)
          .eq('version', baseVersion)
          .select('version');
        if (error) throw error;
        committed = !!(data && data.length === 1);
      }

      if (committed) {
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
          offlineSince = 0;
          persistCache({ force: true });
          if (!dirty) setStatus('synced');
        } else {
          dirty = true;
          if (!offlineSince) offlineSince = Date.now();
          setStatus('offline');
          persistCache({ force: true });
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
        if (!mirroredOnConflict) dirty = true;
        const remote = await fetchLatest();
        if (remote) adoptRemote(remote);
      }
    } catch (e) {
      // Leave state dirty; the next change (or a retry below) will re-attempt.
      console.warn('[sync] save failed:', e?.message || e);
      dirty = true;
      if (!offlineSince) offlineSince = Date.now();
      setStatus('offline');
      persistCache(); // preserve the unsaved edits + queue so a reload survives an outage
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

  function scheduleSave() {
    if (offlineSince) {
      // Backing off during an outage: keep the 'offline' status and retry gently
      // (every 5 s) rather than spinning failed network calls every 600 ms — this
      // matters on the crew's phones. A reconnect (online event) resets the backoff.
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 5000);
      return;
    }
    setStatus('saving');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
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
    // If the full jobs backfill never completed at boot (offline / a transient read
    // error), finish it now that the tab is active again — until it does, the per-row
    // mirror stays gated and TOP_UP is held, so job edits wouldn't persist.
    if (!jobsFullyHydrated) completeJobsHydration();
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
        // marker means the delete feed has a hole nothing incremental can close.
        if (tombRows.some((t) => t.job_id === REAP_MARKER_ID)) {
          await completeJobsHydration();
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
  const onOnline = () => { offlineSince = 0; if (dirty) scheduleSave(); resync(); };

  // The sign-out flush (see flushSyncBeforeSignOut). Cancels the debounce and
  // drives flush() directly, then verifies NOTHING is left local: blob clean
  // (not dirty, empty pending queue) AND the jobs mirror caught up (baseline
  // matches state — after a clean mirror they are the same array reference, so
  // the diff only runs when they genuinely diverged). A flush that lands while
  // another is in flight just marks dirty and returns, and a CAS conflict costs
  // a round-trip — so give it three beats before declaring failure.
  async function finalFlush() {
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
      //     diff against the hydration WINDOW snapshot, which is exactly how
      //     completeJobsHydration detects gap edits made during the windowed
      //     phase (a jobs-only edit there rides the content-guard path, drops
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
      await loadInitial();
      // A stop() may have landed during the awaited load (StrictMode remount /
      // re-auth). Bail before wiring listeners + channel so we don't leak them on
      // an already-stopped instance that nothing will clean up.
      if (!started) return;
      // Realtime is best-effort — a subscription hiccup must NOT reject start()
      // (loadInitial already hydrated the shared doc), otherwise the app
      // needlessly "fails open onto the seed" over a non-critical realtime error.
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
    stop() {
      started = false;
      if (activeFinalFlush === finalFlush) { activeFinalFlush = null; activeMarkCacheWipe = null; }
      if (saveTimer) clearTimeout(saveTimer);
      if (backstopTimer) { clearInterval(backstopTimer); backstopTimer = null; }
      // Drop any coalescing window in flight — its flush also bails on !started,
      // but the timer itself must not outlive the manager (StrictMode remount).
      if (rtJobsTimer) { clearTimeout(rtJobsTimer); rtJobsTimer = null; rtJobsBuf = { upserts: [], deletes: [] }; }
      // Abandon a pending jobs-backfill retry — its completeJobsHydration also bails
      // on !started, but the timer must not outlive the manager.
      if (hydrationRetryTimer) { clearTimeout(hydrationRetryTimer); hydrationRetryTimer = null; }
      if (tableHydrateRetryTimer) { clearTimeout(tableHydrateRetryTimer); tableHydrateRetryTimer = null; }
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
