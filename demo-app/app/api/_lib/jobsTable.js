// Server-side read access to public.jobs.
//
// Post-B1 Stage 3 (commit aa4d055, 2026-07-14) jobs live PER-ROW in public.jobs and
// every client save writes the org_state blob's `jobs` array EMPTY. So any server
// code that needs job data MUST read the table through these helpers — reading
// `state.jobs` off readOrgState() returns [] forever (the C01 regression: clock-in
// 404s, job-based authz silently degraded, reminders cron dead). The job payload is
// the JSONB `data` column; id / site_id / status / start_at are indexed columns.
import { getSupabase } from './supabase.js';
import { jsonEq } from './jsonEq.js';
import { JOB_STATUS, isCompletedJobStatus } from '../../src/lib/jobStatus.js';
import { jobsWindowBounds } from '../../src/lib/jobsWindow.js';

const ORG_ID = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';

// ── WRITE half (Increment 1d: server-mediated writes) ──────────────────────
// The browser used to upsert public.jobs directly under an open RLS policy. It
// now POSTs the delta here instead, so the row shape is owned server-side and
// `organization_id`/`updated_by` are taken from the caller's verified claim
// rather than anything the client asserts.

// Only a parseable ISO-ish date reaches the indexed start_at column; anything
// else stays null. The full value always survives in `data`. (The browser's twin
// went with its direct-write fallback, CS-009: this is the only row builder.)
const isoOrNull = (v) => {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(s) ? s : null;
};

// `_rv` is the client sync layer's copy of row_version (see src/store/jobsSync.js).
// It rides on the job object for the reducer's order guard and must NEVER be
// persisted into the `data` JSONB — a stale version baked into the payload would
// be re-served on every read. Stripped here, on the only write path (CS-009).
const stripRv = (job) => {
  if (!job || job._rv === undefined) return job;
  const { _rv, ...rest } = job;
  return rest;
};

function toRow(job, { userId, build, tab, now }) {
  return {
    id: job.id,
    organization_id: ORG_ID, // server-pinned, never from the request body
    data: stripRv(job),
    start_at: isoOrNull(job.startAt),
    status: job.status ?? null,
    client_id: job.clientId ?? null,
    site_id: job.siteId ?? null,
    series_id: job.seriesId ?? null,
    updated_at: now,
    updated_by: userId ?? null, // Auth UUID from the caller's session — uuid column
    updated_by_build: build,
    updated_by_tab: tab,
    updated_via: 'server', // the 1e revoke gate — see the write_path_marker migration
  };
}

// Apply a jobs delta. `changed` is whole job payloads, `removed` is ids.
// Deletes are org-scoped so a client can never remove another org's rows.
//
// ── DATA-EQUALITY GUARD (the ping-pong backstop) ────────────────────────────
// Clients re-POST rows they never touched: diffJobs compares by object
// reference, and any baseline drift (a realtime patch landing mid-flush, an old
// build, a future regression) makes a server-originated row read as a local
// edit. Before this guard, each such no-op re-POST was a REAL UPDATE — a
// row_version bump, 8 index rewrites, a TOAST rewrite, and a per-row realtime
// event to every connected tab, which drifted THEIR baselines in turn. Measured
// live at ~165 UPDATEs per row (4.2M on 19k rows), whole-table rewrites hourly.
// Dropping rows whose payload already matches the stored `data` makes an echo
// cost one primary-key read instead of a fan-out, and severs the feedback loop
// server-side no matter what any past or future client does.
// Skipped rows are SUCCESS, not an error (sanitize-over-reject — a 4xx here
// would wedge tabs, see api/state/jobs-delta.js).
export async function writeJobsDelta({ changed = [], removed = [], userId, orgUserId = null, build = 0, tab = null }) {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const candidates = changed.filter((j) => j && typeof j.id === 'string' && j.id);
  let unchanged = 0;
  let toUpsert = candidates;
  // The stored payloads this write replaces, returned so the caller can log WHAT changed
  // (CS-379 activity log) without paying a second read. The DELETED ids ride the SAME read —
  // one primary-key lookup, not two, so a mixed delta still pays exactly one (which
  // test-jobs-delta-authz asserts) and a delete's log row can still name its customer and
  // when the clean was. Empty when the pre-read failed.
  const removedIds = removed.filter((id) => typeof id === 'string' && id);
  let storedPrev = new Map();
  if (candidates.length || removedIds.length) {
    try {
      const stored = await getJobsByIds([...candidates.map((j) => j.id), ...removedIds]);
      storedPrev = stored;
      toUpsert = candidates.filter((j) => {
        const prev = stored.get(j.id);
        if (prev && jsonEq(stripRv(j), prev)) { unchanged += 1; return false; }
        return true;
      });
    } catch (e) {
      // The guard is an optimization, never a gate: if the read fails, write
      // everything rather than dropping a genuine edit.
      console.warn(`[jobsTable] equality pre-read failed — writing full delta: ${e.message}`);
      toUpsert = candidates;
      unchanged = 0;
    }
  }
  const rows = toUpsert.map((j) => toRow(j, { userId, build, tab, now }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from('jobs').upsert(chunk, { onConflict: 'id' });
    if (!error) continue;
    // 23505 on the NATURAL key (jobs_org_series_start_uidx): a different row id
    // already occupies this (org, series_id, start_at) slot — two tabs minting
    // the same occurrence, or TOP_UP re-minting a re-created tail slot. A
    // whole-chunk throw here wedged the client's 5s delta retry loop forever
    // behind an "offline" badge, blocking up to 199 sibling writes. Sanitize-
    // over-reject: retry row-by-row and treat the colliding rows as already
    // materialized (skipped = success; the peer's row is the survivor).
    if (error.code !== '23505') throw new Error(`jobs upsert failed: ${error.message}`);
    for (const row of chunk) {
      const { error: rowErr } = await sb.from('jobs').upsert([row], { onConflict: 'id' });
      if (rowErr && rowErr.code === '23505') {
        console.warn(`[jobsTable] natural-key slot occupied, skipping ${row.id} (series ${row.series_id} @ ${row.start_at})`);
        continue;
      }
      if (rowErr) throw new Error(`jobs upsert failed: ${rowErr.message}`);
    }
  }
  const ids = removedIds;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    // Attribute the tombstone (job_deletes.deleted_by) via a SECURITY DEFINER RPC
    // that sets a txn-local actor GUC the trg_jobs_tombstone trigger reads. Falls
    // back to a plain delete when the RPC isn't deployed yet, so this is safe to
    // ship before OR after 20260903120000_job_deletes_actor.sql (migration order).
    const { error: rpcErr } = await sb.rpc('delete_jobs', { p_org: ORG_ID, p_ids: chunk, p_actor: orgUserId || null, p_tab: tab || null });
    if (!rpcErr) continue;
    if (rpcErr.code === 'PGRST202' || rpcErr.code === '42883') {
      const { error } = await sb.from('jobs').delete().eq('organization_id', ORG_ID).in('id', chunk);
      if (error) throw new Error(`jobs delete failed: ${error.message}`);
      continue;
    }
    throw new Error(`jobs delete failed: ${rpcErr.message}`);
  }
  return { changed: rows.length, unchanged, removed: ids.length, prev: storedPrev, written: toUpsert };
}

// ── CS-051: the server's OWN job-status write ─────────────────────────────────
// A clean's last cleaner clocked out (api/time → time/store settleJobAfterPunchClosed), so
// the clean is done. Every other job write comes from a tab through writeJobsDelta above;
// this one is the server's, and it stamps the row the way a server write must:
//   · a COMPARE-AND-SWAP on row_version (the trigger restamps it on every write, see
//     20260720010000_jobs_row_version.sql): a tab's write landing between this read and
//     this update makes it miss, and the row is re-read and decided again, so a concurrent
//     edit (a crew change, a cancel) is never overwritten with a stale payload;
//   · `updated_by_tab` = SERVER_WRITE_TAB, never a tab's id. An UPDATE that leaves the
//     column out keeps the LAST writer's tab, and that tab's realtime handler would drop
//     this change as its own echo (store/sync.js subscribeJobsRealtime) — the phone that
//     clocked in included;
//   · `updated_via: 'server'` (the 1e marker) and `updated_by: null` (no human author: a
//     punch closing caused it), `updated_by_build: null` (no client build made it).
// A done or cancelled clean is never rewritten.
// → { jobDone: true } wrote · { jobDone: true, already: true } it was done · { jobDone: false }
//   cancelled · { jobDone: false, notFound } · { jobDone: false, contended } past the retries.
export const SERVER_WRITE_TAB = 'server:time';
const MARK_DONE_TRIES = 4;
export async function markJobDone(id) {
  if (!id) return { jobDone: false, notFound: true };
  const sb = getSupabase();
  for (let i = 0; i < MARK_DONE_TRIES; i += 1) {
    const { data: row, error } = await sb.from('jobs').select('data, row_version')
      .eq('organization_id', ORG_ID).eq('id', id).maybeSingle();
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    if (!row?.data) return { jobDone: false, notFound: true };
    const status = row.data.status;
    if (isCompletedJobStatus(status)) return { jobDone: true, already: true };
    if (status === JOB_STATUS.CANCELLED) return { jobDone: false };
    let q = sb.from('jobs').update({
      data: { ...row.data, status: JOB_STATUS.DONE },
      status: JOB_STATUS.DONE,
      updated_at: new Date().toISOString(),
      updated_by: null,
      updated_by_build: null,
      updated_by_tab: SERVER_WRITE_TAB,
      updated_via: 'server',
    }).eq('organization_id', ORG_ID).eq('id', id);
    // A row not written since the column was added carries NULL (the sync layer reads it
    // as 0); `eq.null` matches nothing, so swap on IS NULL instead.
    q = row.row_version == null ? q.is('row_version', null) : q.eq('row_version', row.row_version);
    const { data: hit, error: writeErr } = await q.select('id');
    if (writeErr) throw new Error(`jobs status write failed: ${writeErr.message}`);
    if (Array.isArray(hit) && hit.length) return { jobDone: true };
  }
  return { jobDone: false, contended: true };
}

// The committed payloads for a set of ids, as a Map id -> job. Used by the
// field-level write guard to diff what a caller is asking to change against what is
// actually stored, only for a caller who may not edit the schedule (jobsGuard
// guardJobsDelta: owner / admin and a manager holding schedule.edit skip it), and by
// writeJobsDelta's equality guard above for every write. Primary-key lookup, chunked.
export async function getJobsByIds(ids = []) {
  const out = new Map();
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id);
  if (!list.length) return out;
  for (let i = 0; i < list.length; i += 500) {
    const { data, error } = await getSupabase()
      .from('jobs').select('id, data')
      .eq('organization_id', ORG_ID).in('id', list.slice(i, i + 500));
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const r of data || []) if (r?.data) out.set(r.id, r.data);
  }
  return out;
}

// One job by id (clock-in context) — primary-key lookup. Returns the job payload or null.
export async function getJobById(id) {
  if (!id) return null;
  const { data, error } = await getSupabase()
    .from('jobs').select('data').eq('organization_id', ORG_ID).eq('id', id).maybeSingle();
  if (error) throw new Error(`jobs read failed: ${error.message}`);
  return data?.data || null;
}

// Non-cancelled jobs at a site (indexed by site_id), optionally only those naming `crewId`
// in their crewIds (JSONB containment, as getCrewJobs) and / or starting between
// `startFrom` and `startTo` (ISO, inclusive; the indexed start_at column, so a job whose
// startAt isn't ISO never matches a bounded read). Paged in id order: a site cleaned for
// years passes the PostgREST row cap, and the old unpaged read could silently drop the
// very clean that grants access. The caller still re-checks each row's own payload.
// getJobRowsAtSite is the same read with each row's row_version beside its payload (a crew
// phone adopts a row it is handed by that version — the reducer's order guard, QR Wave 2).
export async function getJobRowsAtSite(siteId, { crewId = null, startFrom = null, startTo = null } = {}) {
  if (!siteId) return [];
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = getSupabase()
      .from('jobs').select('data, row_version')
      .eq('organization_id', ORG_ID).eq('site_id', siteId).neq('status', 'cancelled');
    if (crewId) q = q.contains('data', { crewIds: [crewId] });
    if (startFrom) q = q.gte('start_at', startFrom);
    if (startTo) q = q.lte('start_at', startTo);
    const { data, error } = await q
      .order('id', { ascending: true }) // deterministic pages (lint:paging)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const r of data || []) if (r.data) out.push({ data: r.data, row_version: r.row_version ?? null });
    if (!data || data.length < PAGE) break;
  }
  return out;
}
export async function getJobsAtSite(siteId, opts = {}) {
  return (await getJobRowsAtSite(siteId, opts)).map((r) => r.data);
}

// ── QR Wave 2: the server's write for a cleaner who fills in from a scan (EP-419) ─────────────
// The row is written by the SERVER on the cleaner's behalf, the way markJobDone writes its own:
//   · a COMPARE-AND-SWAP on row_version: `decide(row)` is asked again on every fresh read, so a
//     tab's write (the office re-crewing the clean, a cancel) landing between the read and the
//     update is never overwritten with a stale payload — the decision is re-made on what is there;
//   · `updated_by_tab` = SERVER_SCAN_TAB, never a tab's id (a realtime handler drops its own
//     tab's echo, so the phone that asked would never hear the row over realtime otherwise);
//   · `updated_via: 'server'` (the 1e marker), `updated_by` = the caller's Auth id (a person
//     caused it), `updated_by_build: null` (no client build wrote the payload).
// `decide(row)` gets `{ data, row_version }` (null when the row is gone) and answers
// `{ write: <job payload> }` to write, or anything else to stop without writing (handed back as
// `result`). → { written: { data, row_version }, prev } · { result, prev } · { contended: true }.
export const SERVER_SCAN_TAB = 'server:scan';
const SERVER_WRITE_TRIES = 4;
export async function getJobRowById(id) {
  if (!id) return null;
  const { data, error } = await getSupabase()
    .from('jobs').select('data, row_version').eq('organization_id', ORG_ID).eq('id', id).maybeSingle();
  if (error) throw new Error(`jobs read failed: ${error.message}`);
  return data?.data ? { data: data.data, row_version: data.row_version ?? null } : null;
}
export async function updateJobByServer(id, decide, { updatedBy = null, tab = SERVER_SCAN_TAB } = {}) {
  const sb = getSupabase();
  for (let i = 0; i < SERVER_WRITE_TRIES; i += 1) {
    const row = await getJobRowById(id);
    const d = await decide(row);
    if (!d || !d.write) return { result: d, prev: row };
    const next = stripRv(d.write);
    let q = sb.from('jobs').update({
      data: next,
      status: next.status ?? null,
      start_at: isoOrNull(next.startAt),
      client_id: next.clientId ?? null,
      site_id: next.siteId ?? null,
      series_id: next.seriesId ?? null,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
      updated_by_build: null,
      updated_by_tab: tab,
      updated_via: 'server',
    }).eq('organization_id', ORG_ID).eq('id', id);
    // A row not written since the column was added carries NULL (markJobDone's note).
    q = row.row_version == null ? q.is('row_version', null) : q.eq('row_version', row.row_version);
    const { data: hit, error } = await q.select('id, data, row_version');
    if (error) throw new Error(`jobs write failed: ${error.message}`);
    if (Array.isArray(hit) && hit.length) return { written: { data: hit[0].data, row_version: hit[0].row_version ?? null }, prev: row };
  }
  return { contended: true };
}

// ── A CLEANER'S CLEANS (CS-677) ───────────────────────────────────────────────
// Every job a crew member is on (`data.crewIds` names them) that STARTS inside the jobs window
// (src/lib/jobsWindow.js: 45 days back, 100 ahead — the same window the app loads at launch).
// A cleaner needs their recent and upcoming cleans, never their whole history: this read runs
// on every crew state refresh (/api/state/view at boot, on each org_state signal, refocus and
// reconnect), on every crew save (the merge's scope) and in the QC and supplies routes.
//
// The filter is on the EXPRESSION `data->'crewIds'` (`@>` a one-element array), so the GIN
// index jobs_crew_ids_gin (migration 20261013120000) serves it — a bitmap of this cleaner's
// rows, then the window. It used to be `data @> {"crewIds":[id]}`, which no index served: a
// sequential scan of every clean ever, per request. The same index serves the jobs RLS policy's
// `(data->'crewIds') ? <id>` only where no role check is OR'd beside it; the policy's isn't, so
// a crew phone takes its window from here (GET /api/state/view?part=jobs) rather than reading
// the table under RLS.
//
// Keyset pages by id (`id > the last id`), never OFFSET. → [{ data, row_version }].
export async function getCrewJobRows(userId, { fromIso, toIso } = jobsWindowBounds()) {
  if (!userId) return [];
  const out = [];
  const PAGE = 1000;
  for (let after = null; ;) {
    let q = getSupabase()
      .from('jobs').select('id, data, row_version')
      .eq('organization_id', ORG_ID)
      .contains('data->crewIds', JSON.stringify([userId]))
      .gte('start_at', fromIso)
      .lt('start_at', toIso);
    if (after !== null) q = q.gt('id', after);
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGE);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const r of data || []) if (r.data) out.push({ data: r.data, row_version: r.row_version ?? null });
    if (!data || data.length < PAGE) break;
    after = data[data.length - 1].id;
  }
  return out;
}

// The cleaner's window of cleans, as job payloads (the scope readers: crewAssignedScope,
// crewScopeFromJobs, the supplies line).
export async function getCrewJobs(userId, window = jobsWindowBounds()) {
  return (await getCrewJobRows(userId, window)).map((r) => r.data);
}

// The table's highest row_version: the cursor floor a crew phone starts its poll from, read
// BEFORE its cleans so a row written in between is still above it. NULLs (rows never written
// since the column was added) are excluded — a DESC order puts them first.
export async function getJobsHighWater() {
  const { data, error } = await getSupabase()
    .from('jobs').select('row_version')
    .eq('organization_id', ORG_ID)
    .not('row_version', 'is', null)
    .order('row_version', { ascending: false })
    .limit(1);
  if (error) throw new Error(`jobs read failed: ${error.message}`);
  const v = Number(data?.[0]?.row_version);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Jobs whose start_at falls in a window around now (indexed by start_at) — for the
// reminders cron and the ops-alert cron, which only ever need near-term occurrences.
// Ordered by id so the pages are deterministic: an unordered walk could skip a job
// under concurrent writes, and a skipped job is an alert that never fires.
export async function getJobsInWindow({ backDays = 7, forwardDays = 45 } = {}) {
  const day = 86400000;
  const now = Date.now();
  const fromIso = new Date(now - backDays * day).toISOString();
  const toIso = new Date(now + forwardDays * day).toISOString();
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabase()
      .from('jobs').select('data')
      .eq('organization_id', ORG_ID)
      .gte('start_at', fromIso).lte('start_at', toIso)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const r of data) if (r.data) out.push(r.data);
    if (data.length < PAGE) break;
  }
  return out;
}
