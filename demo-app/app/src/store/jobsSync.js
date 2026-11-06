// Per-row jobs persistence for the B1 migration. Instead of rewriting the whole
// ~52.9 MB jobs array (18,748 rows) inside the org_state blob on every change, we
// write ONLY the jobs that changed to the dedicated public.jobs table, through the
// server route (/api/state/jobs-delta) and nothing else. The org_state save never
// waits on it; a failed delta leaves lastSyncedJobs where it was, so the next flush
// re-diffs and re-sends it.
import { supabase, supabaseRead } from '../lib/supabaseClient';
import { diffJobs, splitDelta } from './jobsMerge'; // used by persistJobsDelta below
import { writeStamp } from '../lib/appBuild';
import { postJobsDelta } from '../lib/stateApi';

// Re-export the pure diff/merge core so existing importers keep a single entry point.
export { diffJobs, mergeFullJobs, splitDelta, advanceBaseline } from './jobsMerge';

const ORG_ID =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLEANSPACE_ORG_ID) ||
  '00000000-0000-0000-0000-000000000001';

// `_rv` is the sync layer's copy of the row's server-assigned row_version. It rides ON
// the job object so the reducer's order guard can compare it, and it is never domain
// data: the server strips it before anything reaches the `data` JSONB
// (api/_lib/jobsTable.js stripRv — the only write path since CS-009).

// Attach the row's server version to the job payload as it comes off the wire.
// NULL means "not written since row_version was added" — treated as 0, the
// oldest possible version, so any real write supersedes it.
const withRv = (row) => ({ ...row.data, _rv: row.row_version ?? 0 });

// Highest row_version in a set — the cursor. CURSOR-OWNED-BY-FETCH: this may
// only ever be advanced from an authoritative fetch/poll, NEVER from an
// unordered realtime patch, or a reordered message would push the cursor past
// rows we never actually received and they would be missed forever.
export const maxRv = (jobs) => (jobs || []).reduce((m, j) => (j?._rv > m ? j._rv : m), 0);

// Rows per server request. A series operation can touch hundreds of occurrences,
// and Vercel rejects bodies over ~4.5 MB at the PLATFORM layer — before the
// handler runs — so an unchunked series edit would 413 with no useful error (the
// exact trap that silently broke base64 uploads, HANDOFF 2026-07-19). Must stay
// <= MAX_ROWS in app/api/state/jobs-delta.js.
const MAX_ROWS_PER_REQUEST = 200;

// splitDelta lives in the dependency-free jobsMerge core so it is unit-testable
// from a plain node script (this module imports Vite-resolved things).

// Persist the delta between two jobs arrays to public.jobs. THROWS on any failure (the error
// carries `kind` 'unreachable' | 'failed' and `status`), so the caller leaves lastSyncedJobs
// unadvanced and the next flush re-sends the delta.
//
// Through the server endpoint ONLY (Increment 1d), which stamps authorship from the caller's
// JWT claim. There is no direct-write fallback any more (CS-009): since Increment 1e revoked
// the browser's write policy, a direct upsert was refused and a direct DELETE matched nothing
// and reported success — so a removal "landed", the baseline advanced, and the deleted clean
// came back on the next load. A terminal answer (the login was disabled; the sign-out is
// under way) ends the delta: nothing this login sends can land.
export async function persistJobsDelta(prevJobs, currJobs) {
  if (!supabase) return { changed: 0, removed: 0 };
  const { changed, removed } = diffJobs(prevJobs, currJobs);
  if (!changed.length && !removed.length) return { changed: 0, removed: 0 };

  const stamp = writeStamp();
  const payload = { build: stamp.updated_by_build, tab: stamp.updated_by_tab };

  for (const chunk of splitDelta(changed, removed, MAX_ROWS_PER_REQUEST)) {
    const r = await postJobsDelta({ changed: chunk.changed, removed: chunk.removed, ...payload });
    if (!r.ok && r.terminal) break;
  }
  return { changed: changed.length, removed: removed.length };
}

// ── READS: never the whole table (CS-676) ─────────────────────────────────────
// public.jobs keeps every clean ever done (~16,000 a month at Matt's book, nothing pruned).
// The app used to read ALL of it on every launch — a count, then OFFSET pages of 250 by id —
// and OFFSET makes each page re-read every row before it, so the database work grew with the
// SQUARE of the table. Now nothing reads it whole:
//   · a launch reads the cleans that START inside the window (src/lib/jobsWindow.js) plus each
//     series' master (store/sync.js loadJobsBaseline);
//   · a screen that needs more asks for exactly that: a date range (fetchJobsInRange), one
//     series (fetchSeriesJobs), one customer (fetchClientJobs), some ids (fetchJobsByIds);
//   · every page is KEYSET — "after the last row I read", never OFFSET — so a page costs the
//     rows it returns, wherever it sits.
// Routed to supabaseRead (a nearer read replica when VITE_SUPABASE_LB_URL is set; the primary
// client until then): every one of these is lag-tolerant, reconciled by the cursor poll.
//
// The resilience the old reader earned on slow links (Lauren / ZA, 2026-08-12) is kept for
// every request: a 20 s abort (a supabase-js read has NO timeout of its own, so a stalled body
// hung the whole load for ever), five retries with a capped backoff per request, and bounded
// concurrency so wall-clock is about requests / 4 round trips.
//
// PAGE: PostgREST answers at most db-max-rows rows (Supabase's default 1,000 — the cap the app
// assumes everywhere, api/_lib/pagedSelect.js), so a page of 1,000 is the most one request can
// carry and a full page is the only sign that more may follow. A row is ~400 B of `data`
// (production, 2026-10-12), so a page is ~½ MB: the body size the old 250-row pages of fatter
// rows were tuned to.
const PAGE = 1000;
const CONCURRENCY = 4;
const PAGE_RETRIES = 5;
const PAGE_TIMEOUT_MS = 20000;
const COLS = 'id, start_at, data, row_version';
// A full page all at ONE start time can't move the cursor forward, so the next request drains
// that instant by id; this is how far ahead it looks while it does.
const MIN_SPAN_MS = 60000;
// Ids per `in.(…)` request: keeps the URL short.
const ID_CHUNK = 100;

// Timeout + retry, shared by every request. build(signal) returns a query carrying the abort
// signal; a stall or an error aborts, backs off and retries up to PAGE_RETRIES, then throws to
// the caller (the sync manager's own retry owns it from there).
async function runWithTimeout(build, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await build(controller.signal);
    if (res.error) throw res.error;
    return res;
  } catch (e) {
    if (attempt >= PAGE_RETRIES) throw e;
    await new Promise((r) => setTimeout(r, Math.min(800 * (attempt + 1), 4000)));
    return runWithTimeout(build, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

const jobsQuery = () => supabaseRead.from('jobs').select(COLS).eq('organization_id', ORG_ID);

// Every row of one stretch of the time axis, [fromMs, toMs), in (start_at, id) order, keyset.
// The first request asks for the whole stretch (a small table is one request). A full page
// means the stretch holds more: the next request starts AT the last row read — the rest of
// that start time by id, then everything after — and looks about two pages ahead, so whatever
// plan the database picks, no request reads more than a bounded stretch (an index range on
// (organization_id, start_at); proved by EXPLAIN in the migration 20261013120000). A short
// page means the stretch is done; a sparse one widens the next.
async function readStartRange(fromMs, toMs) {
  const out = [];
  let cursorMs = fromMs;
  let cursorIso = new Date(fromMs).toISOString();
  let afterId = null; // set while continuing inside a start time: rows AT cursorIso with a greater id
  let span = toMs - fromMs;
  while (cursorMs < toMs) {
    const endMs = Math.min(toMs, cursorMs + span);
    const fromIso = cursorIso;
    const after = afterId;
    // eslint-disable-next-line no-await-in-loop -- keyset: each page starts where the last ended
    const { data } = await runWithTimeout((signal) => {
      let q = jobsQuery().gte('start_at', fromIso).lt('start_at', new Date(endMs).toISOString());
      if (after !== null) q = q.or(`start_at.gt."${fromIso}",id.gt."${after}"`);
      return q.order('start_at', { ascending: true }).order('id', { ascending: true }).limit(PAGE).abortSignal(signal);
    });
    const rows = data || [];
    for (const r of rows) out.push(r);
    if (rows.length < PAGE) {
      cursorMs = endMs;
      cursorIso = new Date(endMs).toISOString();
      afterId = null;
      if (rows.length < PAGE / 4) span *= 2;
      continue;
    }
    const last = rows[rows.length - 1];
    const lastMs = Date.parse(last.start_at);
    span = Math.max(MIN_SPAN_MS, (lastMs - cursorMs) * 2);
    cursorMs = lastMs;
    cursorIso = last.start_at; // the stored value as PostgREST wrote it — exact, never re-rounded
    afterId = last.id;
  }
  return out;
}

// Every row a filter selects, in id order, keyset (`id > the last id read`). For sets that are
// bounded by what they ask for — one series, one customer, a list of ids, the series masters.
async function readById(scope) {
  const out = [];
  let afterId = null;
  for (;;) {
    const after = afterId;
    // eslint-disable-next-line no-await-in-loop -- keyset: each page starts where the last ended
    const { data } = await runWithTimeout((signal) => {
      let q = scope(jobsQuery());
      if (after !== null) q = q.gt('id', after);
      return q.order('id', { ascending: true }).limit(PAGE).abortSignal(signal);
    });
    const rows = data || [];
    for (const r of rows) out.push(r);
    if (rows.length < PAGE) return out;
    afterId = rows[rows.length - 1].id;
  }
}

const toJobs = (rows) => {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || !r.data || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(withRv(r));
  }
  return out;
};

// The cleans that start in [fromMs, toMs): the launch window and every on-demand range (a past
// week on the Schedule, a report's day). Split into CONCURRENCY stretches read side by side.
// Rows with no start_at are in no range — every occurrence carries one.
export async function fetchJobsInRange(fromMs, toMs) {
  if (!supabaseRead || !(toMs > fromMs)) return [];
  const parts = CONCURRENCY;
  const step = (toMs - fromMs) / parts;
  const stretches = Array.from({ length: parts }, (_, i) => [
    fromMs + Math.round(i * step),
    i === parts - 1 ? toMs : fromMs + Math.round((i + 1) * step),
  ]).filter(([a, b]) => b > a);
  const results = await Promise.all(stretches.map(([a, b]) => readStartRange(a, b)));
  return toJobs(results.flat());
}

// Every occurrence of one series — what a whole-series edit or delete needs (UPDATE_JOB_SERIES /
// DELETE_JOB_SERIES build their target sets from the loaded rows). Indexed: (organization_id,
// series_id).
export async function fetchSeriesJobs(seriesId) {
  if (!supabaseRead || !seriesId) return [];
  return toJobs(await readById((q) => q.eq('series_id', seriesId)));
}

// Every series' MASTER — the row carrying `recurrence`, the template TOP_UP mints from — however
// old. A series running for a year has its master a year back, far outside the window. Served by
// the partial index jobs_org_series_master_idx (migration 20261013120000).
export async function fetchSeriesMasters() {
  if (!supabaseRead) return [];
  return toJobs(await readById((q) => q.not('data->>recurrence', 'is', null)));
}

// Every clean of one customer — the customer page's history. Indexed: (organization_id, client_id).
export async function fetchClientJobs(clientId) {
  if (!supabaseRead || !clientId) return [];
  return toJobs(await readById((q) => q.eq('client_id', clientId)));
}

// The cleans with these ids (a deep link, a notification's clean). Primary-key lookups.
export async function fetchJobsByIds(ids) {
  const list = [...new Set((ids || []).filter((id) => typeof id === 'string' && id))];
  if (!supabaseRead || !list.length) return [];
  const rows = [];
  for (let i = 0; i < list.length; i += ID_CHUNK) {
    const chunk = list.slice(i, i + ID_CHUNK);
    // eslint-disable-next-line no-await-in-loop -- a handful of chunks at most
    rows.push(...await readById((q) => q.in('id', chunk)));
  }
  return toJobs(rows);
}

// The highest row_version in the table — the cursor floor a launch starts the poll from. Read
// BEFORE the window, so a row written while the window's pages are read is still above the
// floor and the first poll fetches it. (A floor taken from the rows read instead — the old way
// — skips a row whose page was read before its write when a later page saw an even newer one.)
// NULL row_versions (rows not written since the column was added) are excluded: DESC puts them
// first. Backward scan of jobs_org_row_version_idx: one row.
export async function fetchJobsHighWater() {
  if (!supabaseRead) return 0;
  const { data } = await runWithTimeout((signal) => supabaseRead
    .from('jobs').select('row_version')
    .eq('organization_id', ORG_ID)
    .not('row_version', 'is', null)
    .order('row_version', { ascending: false })
    .limit(1)
    .abortSignal(signal));
  const v = Number(data?.[0]?.row_version);
  return Number.isFinite(v) && v > 0 ? v : 0;
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
