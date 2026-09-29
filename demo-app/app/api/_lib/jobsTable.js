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

const ORG_ID = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';

// ── WRITE half (Increment 1d: server-mediated writes) ──────────────────────
// The browser used to upsert public.jobs directly under an open RLS policy. It
// now POSTs the delta here instead, so the row shape is owned server-side and
// `organization_id`/`updated_by` are taken from the caller's verified claim
// rather than anything the client asserts.

// Only a parseable ISO-ish date reaches the indexed start_at column; anything
// else stays null. The full value always survives in `data`. MUST stay in step
// with the client's isoOrNull in src/store/jobsSync.js.
const isoOrNull = (v) => {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(s) ? s : null;
};

// `_rv` is the client sync layer's copy of row_version (see src/store/jobsSync.js).
// It rides on the job object for the reducer's order guard and must NEVER be
// persisted into the `data` JSONB — a stale version baked into the payload would
// be re-served on every read. Stripped on both write paths.
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
  if (candidates.length) {
    try {
      const stored = await getJobsByIds(candidates.map((j) => j.id));
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
  const ids = removed.filter((id) => typeof id === 'string' && id);
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
  return { changed: rows.length, unchanged, removed: ids.length };
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
export async function getJobsAtSite(siteId, { crewId = null, startFrom = null, startTo = null } = {}) {
  if (!siteId) return [];
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = getSupabase()
      .from('jobs').select('data')
      .eq('organization_id', ORG_ID).eq('site_id', siteId).neq('status', 'cancelled');
    if (crewId) q = q.contains('data', { crewIds: [crewId] });
    if (startFrom) q = q.gte('start_at', startFrom);
    if (startTo) q = q.lte('start_at', startTo);
    const { data, error } = await q
      .order('id', { ascending: true }) // deterministic pages (lint:paging)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const r of data || []) if (r.data) out.push(r.data);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Every job a crew user is on (crewIds contains userId). crewIds lives in `data`, so
// this uses a JSONB containment filter (`data @> {"crewIds":[userId]}`) — returns only
// the crew's jobs. Paginated so a heavy standing-crew member (>1000 occurrences) isn't
// silently truncated at the PostgREST default cap. NOTE: `data` is unindexed, so this
// is a sequential scan; fine at today's volume + these low-frequency QC routes, but a
// crew_ids column or GIN index is the scale follow-up (SCALE-C17/index work).
export async function getCrewJobs(userId) {
  if (!userId) return [];
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabase()
      .from('jobs').select('data')
      .eq('organization_id', ORG_ID)
      .contains('data', { crewIds: [userId] })
      .order('id', { ascending: true }) // deterministic pages (lint:paging)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const r of data) if (r.data) out.push(r.data);
    if (data.length < PAGE) break;
  }
  return out;
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
