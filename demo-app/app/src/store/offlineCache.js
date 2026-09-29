// Offline-first cache of the shared workspace. Mirrors the last-known-good
// org_state document + jobs into IndexedDB so that, if Supabase is unreachable
// at boot (an outage like the one that caused the login failures), a signed-in
// user still loads their REAL workspace and can keep working — instead of the
// app failing open onto a blank seed. Changes made offline are kept in the
// pending queue and flushed when the backend returns.
//
// Why IndexedDB and not localStorage: the jobs array alone is ~52.9 MB (18,748
// rows) — an order of magnitude over the ~5 MB localStorage quota. Same wrapper as
// lib/attachments.js. Everything here is BEST-EFFORT: any failure (private
// mode, quota, no IndexedDB) degrades to "no cache", never throws to the caller.

const DB_NAME = 'rfs-offline';
const DB_VERSION = 1;
const STORE = 'kv';

// Single-tenant, but key the cache by org so a future multi-org build can't
// cross-contaminate. Matches the ORG_ID resolution used by sync.js/jobsSync.js.
const ORG_ID =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLEANSPACE_ORG_ID) ||
  '00000000-0000-0000-0000-000000000001';
const DOC_KEY = `doc:${ORG_ID}`;     // { state (without jobs), version, at }
const JOBS_KEY = `jobs:${ORG_ID}`;   // { jobs: [...], at }
const QUEUE_KEY = `queue:${ORG_ID}`; // { actions: [...], at }
// Jobs that exist locally but have NOT been confirmed written to public.jobs
// (the sync manager's diff vs its mirror baseline at cache time). Usually empty.
// This is the reload-survival record for schedule edits made during an outage or
// a CAS-conflict storm: the plain jobs cache can't distinguish "mirrored" from
// "still only local", and the boot merge discards anything the table doesn't
// have — so the unmirrored rows are kept HERE and re-applied after hydration.
const PENDING_JOBS_KEY = `pendingjobs:${ORG_ID}`; // { rows: [...], at }

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key, value) {
  let db;
  try { db = await openDb(); } catch { return false; }
  try {
    await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch {
    return false; // quota / transaction abort — degrade to no-cache
  } finally {
    db.close();
  }
}

async function get(key) {
  let db;
  try { db = await openDb(); } catch { return null; }
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// ── public API ────────────────────────────────────────────────────────────────

// Persist the non-jobs document. `at` is passed in (callers stamp their own
// timestamp) so this module needs no clock. Jobs are stored separately because
// they're the big, rarely-changing slice — see cacheJobs.
export async function cacheDoc(state, version, at) {
  if (!state || typeof state !== 'object') return false;
  // Strip the big jobs array (cached separately) and the per-session identity
  // (currentUserId + the transient __auth claim — both re-derived by withSession
  // on the next boot from the live session, so caching them would be stale).
  const { jobs: _jobs, currentUserId: _cu, __auth: _a, viewAsUserId: _va, ...doc } = state;
  return put(DOC_KEY, { state: doc, version: version ?? 0, at: at ?? null });
}

// Persist the jobs array. Call only when jobs actually changed (the sync manager
// knows this from its per-row diff) to avoid rewriting on every keystroke-level save.
//
// This is a MAIN-THREAD STRUCTURED CLONE, so its cost is the row count. Caching the
// full ~19k-row set was ~52.9 MB resident (SCALE-C14) — enough to risk the browser
// evicting the whole origin's storage under quota pressure, which silently destroys
// the offline cache the crew depend on. So callers pass a bounded recent window and
// stamp `windowed`.
//
// ⚠️ `windowed` IS LOAD-BEARING, NOT METADATA. bootFromCache uses this record as the
// save baseline and as the TOP_UP readiness signal. Against a partial set, a save
// diffs to "delete every out-of-window job" and TOP_UP appends duplicate tail
// occurrences. A record without the flag is treated as a full set, which is the
// correct reading for anything written before this shipped.
export async function cacheJobs(jobs, at, meta = null) {
  return put(JOBS_KEY, {
    jobs: Array.isArray(jobs) ? jobs : [],
    at: at ?? null,
    windowed: meta?.windowed === true,
    from: meta?.from ?? null,
    to: meta?.to ?? null,
  });
}

// Persist the pending (unsaved) action queue so offline edits survive a reload
// and can be replayed on top of a remote document after reconnect.
export async function cacheQueue(actions, at) {
  return put(QUEUE_KEY, { actions: Array.isArray(actions) ? actions : [], at: at ?? null });
}

// Persist the not-yet-mirrored jobs (see PENDING_JOBS_KEY). The caller (sync.js
// persistCache) computes the diff against its mirror baseline; this just stores
// it. Small in practice — a handful of rows, empty after every clean mirror.
export async function cachePendingJobs(rows, at) {
  return put(PENDING_JOBS_KEY, { rows: Array.isArray(rows) ? rows : [], at: at ?? null });
}

// Read the full cached snapshot: the document with its jobs merged back in,
// plus version, the pending queue, and the freshest timestamp. Returns null if
// there's no usable cached document (jobs/queue alone are not enough to boot).
export async function readCache() {
  const [doc, jobsRec, queueRec, pendingJobsRec] = await Promise.all([
    get(DOC_KEY), get(JOBS_KEY), get(QUEUE_KEY), get(PENDING_JOBS_KEY),
  ]);
  if (!doc || !doc.state) return null;
  const jobs = Array.isArray(jobsRec?.jobs) ? jobsRec.jobs : [];
  const actions = Array.isArray(queueRec?.actions) ? queueRec.actions : [];
  return {
    state: { ...doc.state, jobs },
    // 🔴 THREE CASES, NOT TWO — and conflating the third is how absence became a claim
    // of completeness:
    //   record present, windowed === true   → windowed
    //   record present, windowed !== true   → COMPLETE. Records written before windowing
    //                                         shipped carry no flag and genuinely hold
    //                                         the full set, so this default is right.
    //   record ABSENT                       → UNKNOWN, and must NOT read as complete.
    //
    // The old `jobsRec?.windowed === true` collapsed the third case into the second: with
    // no jobs record at all, `jobs` above is [] and this returned false, i.e. "this empty
    // array is the complete table". bootFromCache then takes the else branch — jobsReady
    // = true with the cache as the mirror baseline — so the next save diffs the real ~19k
    // rows against [] and re-upserts the entire table into a realtime publication. That is
    // the same empty-baseline failure fixed on the online path in 3f22431, reached through
    // the offline door. A partial-record cache (doc written, jobs write failed or evicted
    // — IndexedDB evicts per-record under quota pressure) is exactly how it happens.
    //
    // Unknown now takes the windowed path, which is the safe one: no mirroring until the
    // authoritative set lands, and completeJobsHydration fills it in.
    jobsWindowed: !jobsRec || jobsRec.windowed === true,
    version: doc.version ?? 0,
    queue: actions,
    // Rows that were never confirmed mirrored to public.jobs (may not exist for
    // records written before this shipped — callers treat absence as empty).
    pendingJobsRows: Array.isArray(pendingJobsRec?.rows) ? pendingJobsRec.rows : [],
    at: doc.at ?? null,
  };
}

// Wipe the cache (used on sign-out so the next user on this device can't read
// the previous user's workspace from the cache).
export async function clearCache() {
  let db;
  try { db = await openDb(); } catch { return; }
  try {
    await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* ignore */ } finally { db.close(); }
}
