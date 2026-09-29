// Per-row jobs persistence for the B1 migration. Instead of rewriting the whole
// ~52.9 MB jobs array (18,748 rows) inside the org_state blob on every change, we
// write ONLY the jobs that changed to the dedicated public.jobs table.
//
// STAGE 1 (write-through mirror): the org_state blob is still the read source and
// still carries jobs (so tabs on old code keep working); this module just keeps the
// jobs table current from every write, so Stage 2 can safely flip reads to the table
// and prune the blob. It is BEST-EFFORT — a failure here never blocks the org_state
// save; the next change re-diffs and retries (lastSyncedJobs only advances on success).
import { supabase, supabaseRead } from '../lib/supabaseClient';
import { diffJobs, splitDelta } from './jobsMerge'; // used by persistJobsDelta below
import { writeStamp } from '../lib/appBuild';
import { postJobsDelta } from '../lib/stateApi';

// Re-export the pure diff/merge core so existing importers keep a single entry point.
export { diffJobs, mergeFullJobs, splitDelta, advanceBaseline } from './jobsMerge';

const ORG_ID =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLEANSPACE_ORG_ID) ||
  '00000000-0000-0000-0000-000000000001';

// Only accept a parseable ISO-ish date for the indexed start_at column; anything
// else (blank/malformed) stays null. The full value always survives in `data`.
const isoOrNull = (v) => {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(s) ? s : null;
};

// `_rv` is the sync layer's copy of the row's server-assigned row_version. It
// rides ON the job object so the reducer's order guard can compare it, but it is
// NOT domain data and must never be persisted into the `data` JSONB — otherwise
// a stale version would be baked into the payload and re-served on every read.
// Stripped here AND server-side in _lib/jobsTable.js (defence in depth: either
// write path must produce clean data).
export const stripRv = (job) => {
  if (!job || job._rv === undefined) return job;
  const { _rv, ...rest } = job;
  return rest;
};

// Attach the row's server version to the job payload as it comes off the wire.
// NULL means "not written since row_version was added" — treated as 0, the
// oldest possible version, so any real write supersedes it.
const withRv = (row) => ({ ...row.data, _rv: row.row_version ?? 0 });

// Highest row_version in a set — the cursor. CURSOR-OWNED-BY-FETCH: this may
// only ever be advanced from an authoritative fetch/poll, NEVER from an
// unordered realtime patch, or a reordered message would push the cursor past
// rows we never actually received and they would be missed forever.
export const maxRv = (jobs) => (jobs || []).reduce((m, j) => (j?._rv > m ? j._rv : m), 0);

function toRow(job, userId, now) {
  return {
    id: job.id,
    organization_id: ORG_ID,
    data: stripRv(job),
    start_at: isoOrNull(job.startAt),
    status: job.status ?? null,
    client_id: job.clientId ?? null,
    site_id: job.siteId ?? null,
    series_id: job.seriesId ?? null,
    updated_at: now,
    updated_by: userId ?? null,
    // Build/tab provenance (Increment 0.3). updated_by_build feeds the prune-gate
    // telemetry; updated_by_tab is what realtime echo suppression must key on, since
    // keying on userId makes a user's OWN second tab drop the write and go stale.
    ...writeStamp(),
  };
}

// Rows per server request. A series operation can touch hundreds of occurrences,
// and Vercel rejects bodies over ~4.5 MB at the PLATFORM layer — before the
// handler runs — so an unchunked series edit would 413 with no useful error (the
// exact trap that silently broke base64 uploads, HANDOFF 2026-07-19). Must stay
// <= MAX_ROWS in app/api/state/jobs-delta.js.
const MAX_ROWS_PER_REQUEST = 200;

// splitDelta lives in the dependency-free jobsMerge core so it is unit-testable
// from a plain node script (this module imports Vite-resolved things).

// Persist the delta between two jobs arrays to public.jobs. Throws on failure so the
// caller can leave lastSyncedJobs unadvanced (→ retried on the next change).
//
// Increment 1d: routes through the server endpoint, which stamps authorship from
// the caller's JWT claim. Falls back to the direct client write only when the
// server is unreachable — see lib/stateApi.js for why that fallback is loud and
// temporary. Increment 1e revokes the browser policy and deletes the fallback.
export async function persistJobsDelta(prevJobs, currJobs, userId) {
  if (!supabase) return { changed: 0, removed: 0 };
  const { changed, removed } = diffJobs(prevJobs, currJobs);
  if (!changed.length && !removed.length) return { changed: 0, removed: 0 };

  const stamp = writeStamp();
  const payload = { build: stamp.updated_by_build, tab: stamp.updated_by_tab };

  let usedDirect = false;
  for (const chunk of splitDelta(changed, removed, MAX_ROWS_PER_REQUEST)) {
    const r = await postJobsDelta({ changed: chunk.changed, removed: chunk.removed, ...payload });
    if (!r.ok && r.unavailable) {
      usedDirect = true;
      await directJobsDelta(chunk.changed, chunk.removed, userId);
    }
  }
  if (usedDirect) console.warn('[sync] jobs delta persisted via the direct client write (server path unavailable)');
  return { changed: changed.length, removed: removed.length };
}

// Pre-1d direct write — the fallback path, and the one Increment 1e removes
// along with the browser's insert/update/delete policy on public.jobs.
async function directJobsDelta(changed, removed, userId) {
  const now = new Date().toISOString();
  const rows = changed.map((j) => toRow(j, userId, now));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('jobs').upsert(rows.slice(i, i + 500), { onConflict: 'id' });
    if (error) throw error;
  }
  for (let i = 0; i < removed.length; i += 500) {
    const { error } = await supabase.from('jobs').delete().in('id', removed.slice(i, i + 500));
    if (error) throw error;
  }
}

// Load all jobs from the table (Stage 2 read path; also used to warm the cache).
// Routed to supabaseRead: this is the single largest read in the app and it is
// lag-tolerant — a detached backfill that reconciles through mergeFullJobs — so it
// is the ideal candidate for a nearer read replica. Identical to the primary
// client until VITE_SUPABASE_LB_URL is set.
//
// HARDENED (the hydration-gate fix): this fetch is what un-gates whole-series
// edits (useJobsHydrated), and it used to be ~19 SEQUENTIAL unordered pages where
// ANY page failure threw the whole hydrate away — completeJobsHydration then
// restarted all ~19 pages from scratch. On a slow/flaky connection (the field
// crew) hydration chronically never completed, "This & all future" stayed
// silently disabled, and managers read that as "editing a job doesn't update the
// future jobs". Three changes:
//   · pages fetch CONCURRENTLY (bounded) — wall-clock ≈ pages/4 × RTT, not
//     pages × RTT;
//   · a failed page retries ITSELF (2×, short backoff) instead of surfacing and
//     restarting the world;
//   · `.order('id')` (the pkey — index-ordered, no sort cost) makes the page
//     boundaries deterministic. The old unordered .range() left page membership
//     to the planner while rows churned underneath, which could skip or
//     duplicate rows across pages; with concurrent pages that hazard compounds.
// Rows written after the count lands are picked up by the cursor poll — the same
// freshness contract the serial version had (a paginated read was never atomic).
// `applyFilter` narrows the count and every page query IDENTICALLY (e.g. the
// boot window's start_at range); pass identity for the full-table read. Shared
// so the boot window inherits the same three properties the backfill earned:
// bounded concurrency, per-page retry, deterministic .order('id') boundaries.
//
// HARDENED AGAIN (Lauren / ZA slow-link, 2026-08-12): a manager on a slow, flaky
// international link still never completed the backfill — so jobsReady never
// flipped, her schedule edits no-op'd in the mirror (mirrorJobs returns early
// while !jobsReady), and refresh lost them. Three failure modes were tightened:
//   · PAGE 1000 → 250. Each page carries the FULL job JSONB, so a 1000-row page
//     is a multi-MB response; on a weak mobile/intl link a single large body is
//     what gets interrupted. 250 rows (~½ MB) completes far more reliably. More
//     round-trips, but each is cheap and independently retried, and the bounded
//     concurrency keeps wall-clock ≈ pages/4 × RTT.
//   · per-page retry 2 → 5 with a longer capped backoff. A transient drop on one
//     page previously exhausted its 2 tries and threw the WHOLE fetch away; the
//     outer completeJobsHydration retry then restarted every page from scratch.
//     Five tries absorbs the intermittent drops a slow link produces.
//   · a 20s per-request abort timeout (the decisive one). A supabase-js read has NO
//     built-in timeout, so a STALLED request (link drops mid-body: no response, no
//     error) hangs the whole hydrate FOREVER — and the retry above only fires on a
//     throw, so a stall never retried. Aborting turns a stall into a prompt retry
//     AND cancels the dead request, freeing the one scarce thing on a starved link:
//     bandwidth. The boot document read is already bounded this way (BOOT_FETCH_TIMEOUT_MS).
// The outer completeJobsHydration also no longer gives up after 5 rounds — see
// sync.js — so between the abort timeout, per-page retries, and an unbounded
// (single-timer) outer retry, hydration now converges on links that used to wedge.
async function fetchJobsPaged(applyFilter) {
  const PAGE = 250;
  const CONCURRENCY = 4;
  const PAGE_RETRIES = 5;
  const PAGE_TIMEOUT_MS = 20000;

  // Timeout + retry wrapper shared by the count probe and every page. build(signal) returns
  // a supabase query carrying the abort signal; a stall or error aborts + backs off + retries
  // up to PAGE_RETRIES, then surfaces to the outer (now-unbounded) completeJobsHydration retry.
  // The AbortController both makes a hung request throw (so the retry can fire) and cancels it.
  const runWithTimeout = async (build, attempt = 0) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await build(controller.signal);
      if (res.error) throw res.error;
      return res;
    } catch (e) {
      if (attempt >= PAGE_RETRIES) throw e; // genuinely unreachable — the outer retry chain owns it
      await new Promise((r) => setTimeout(r, Math.min(800 * (attempt + 1), 4000)));
      return runWithTimeout(build, attempt + 1);
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchPage = async (from) => {
    const { data } = await runWithTimeout((signal) => applyFilter(
      supabaseRead
        .from('jobs')
        .select('data, row_version')
        .eq('organization_id', ORG_ID)
    )
      .order('id')
      .range(from, from + PAGE - 1)
      .abortSignal(signal));
    return data || [];
  };

  // Count first so the full page set is known up front and can run concurrently.
  const { count } = await runWithTimeout((signal) => applyFilter(
    supabaseRead
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ORG_ID)
  ).abortSignal(signal));
  const pages = Math.max(1, Math.ceil((count || 0) / PAGE));
  const results = new Array(pages);
  let nextPage = 0;
  const worker = async () => {
    for (;;) {
      const i = nextPage;
      if (i >= pages) return;
      nextPage += 1;
      results[i] = await fetchPage(i * PAGE);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages) }, worker));

  const all = [];
  for (const page of results) for (const r of page) all.push(withRv(r));
  return all;
}

export async function fetchAllJobs() {
  if (!supabaseRead) return [];
  return fetchJobsPaged((q) => q);
}

// KEYSET CURSOR POLL (Increment 2) — the authoritative delivery guarantee.
//
// Realtime is at-most-once: a DROPPED message has no row for the order guard to
// compare against, so it goes silently missing until something fetches. This is
// that something. `row_version` is globally monotonic (sequence-backed), so
// "everything written since my cursor" is a single indexed keyset scan rather
// than a full refetch of ~19k rows.
//
// Ordered by row_version so a truncated page still yields a usable cursor: the
// caller advances to the max it actually received and the next poll resumes
// exactly there, with no gap.
export async function fetchJobsSince(cursor, limit = 1000) {
  if (!supabaseRead) return [];
  const { data, error } = await supabaseRead
    .from('jobs')
    .select('data, row_version')
    .eq('organization_id', ORG_ID)
    .gt('row_version', cursor)
    .order('row_version', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(withRv);
}

// ── D6: the delete feed ──────────────────────────────────────────────────────
//
// A hard-deleted row has no tuple, so fetchJobsSince above can NEVER return it, and
// the postgres_changes DELETE event is dropped server-side before reaching any socket
// (public.jobs has REPLICA IDENTITY DEFAULT, so the WAL identity payload carries only
// `id` and realtime's organization_id filter cannot match). Deletes therefore reach
// no tab until a full page reload — a crew phone detached for 5 minutes keeps a
// cancelled job on the board and someone drives to it.
//
// public.job_deletes carries one tombstone per delete, stamped from the SAME sequence
// as jobs.row_version, so this rides the existing scalar cursor with no second cursor
// and no change to the jobs query.
export const REAP_MARKER_ID = '__reaped_below__';

// INERT UNTIL THE MIGRATION LANDS. A missing relation is detected once, latched, and
// warned about once; thereafter this returns null, which is byte-for-byte today's
// behaviour (upserts recovered, deletes not). It must NEVER throw a missing-relation
// error into jobsCursorPoll's catch, because that would take out the upsert recovery
// too — the only delivery guarantee this slice has.
let deletesFeed = 'unknown'; // 'unknown' | 'live' | 'absent'
let deletesProbedAt = 0;
const DELETES_REPROBE_MS = 30 * 60 * 1000;

export const jobDeletesInitialized = () => deletesFeed === 'live';

const isMissingRelation = (e) => e?.code === '42P01' || e?.code === 'PGRST205' || e?.code === 'PGRST106'
  || /schema cache|does not exist|not find the table/i.test(e?.message || '');

// null  = feed unavailable (migration not applied) — caller must take the today path
// []    = feed live, nothing new
// The caller MUST distinguish those two: treating null as [] would cap the cursor.
export async function fetchJobDeletesSince(cursor, limit = 1000) {
  if (!supabaseRead) return null;
  // Re-probe occasionally so a tab open across the migration converges without a
  // reload. Two failed requests an hour is free.
  if (deletesFeed === 'absent' && Date.now() - deletesProbedAt < DELETES_REPROBE_MS) return null;
  const { data, error } = await supabaseRead
    .from('job_deletes')
    .select('job_id, row_version')
    .eq('organization_id', ORG_ID)
    .gt('row_version', cursor)
    .order('row_version', { ascending: true })
    .limit(limit);
  if (error) {
    if (isMissingRelation(error)) {
      if (deletesFeed !== 'absent') {
        console.warn('[sync] job_deletes absent. DELETE RECOVERY IS INERT (upsert recovery unaffected). Apply 20260720140000_job_deletes_tombstones.sql.');
      }
      deletesFeed = 'absent';
      deletesProbedAt = Date.now();
      return null;
    }
    throw error; // transient — let the poll's retry handle it
  }
  deletesFeed = 'live';
  deletesProbedAt = Date.now();
  return data || [];
}

// Tombstone lookup for SPECIFIC ids — the boot-recovery safety check
// (recoverCachedPendingJobs in sync.js). The in-memory jobTombstones module is
// EMPTY on a fresh page load, so a cached-but-unmirrored row whose job was
// legitimately deleted server-side while this tab was away has no local trace;
// only the durable job_deletes table can veto its re-creation. Returns a
// Map(job_id -> row_version) of the ids that ARE tombstoned, or null when the
// answer is UNKNOWN (query failed / feed absent) — callers must treat null as
// "do not recover", never as "no tombstones".
export async function fetchJobDeletesByIds(ids) {
  if (!supabaseRead) return null;
  const list = (ids || []).filter(Boolean);
  if (!list.length) return new Map();
  try {
    const { data, error } = await supabaseRead
      .from('job_deletes')
      .select('job_id, row_version')
      .eq('organization_id', ORG_ID)
      .in('job_id', list);
    if (error) {
      if (isMissingRelation(error)) return new Map(); // no tombstone table → nothing was ever tombstoned
      return null;
    }
    return new Map((data || []).map((r) => [r.job_id, r.row_version]));
  } catch {
    return null;
  }
}

// nextJobsCursor lives in the dependency-free jobsMerge core (this module imports the
// Supabase client, so nothing here can be unit-tested under plain node) and is
// re-exported for existing callers, like the other merge helpers.
export { nextJobsCursor, jobsInWindow } from './jobsMerge';

// Load only the jobs whose start_at falls in [fromDate, toDate] (inclusive, ISO
// date or datetime strings). This is the FAST first-paint window: the whole table
// is a rolling year of recurrence occurrences (tens of thousands of rows / ~50 MB),
// far more than boot needs to render today's Schedule + Dashboard. The sync manager
// paints this window, flips the app interactive, then streams the full set in behind
// it. Filtered on the indexed start_at column; rows with a null start_at are not in
// any window and arrive only with the full set (there are none in practice — every
// occurrence carries a date). See createSyncManager in sync.js.
// The boot window blocks FIRST PAINT, so its pages must not run one RTT at a
// time (the old serial loop was ~1 RTT per 1000 rows and, being unordered,
// left page boundaries to the planner — the same skip/dup hazard the backfill
// fixed). Same paged engine as fetchAllJobs, narrowed to the window.
export async function fetchJobsWindow(fromDate, toDate) {
  if (!supabaseRead) return [];
  return fetchJobsPaged((q) => q.gte('start_at', fromDate).lte('start_at', toDate));
}
