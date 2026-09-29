// Service-role data layer for QC (Swept replacement — inspections, checklists,
// problem reports). Service-role only; org pinned; display names denormalized at
// write so reports render without rehydrating the blob. Photos live in the shared
// 'ops-media' bucket via account_media (scope 'inspection'|'problem_report'), not a
// per-domain table. This file grows by sub-module; PROBLEM REPORTS land first.
// See CLEANSPACE_SWEPT.md §4.1 / §5.6.
import { getSupabase } from '../supabase.js';
import { randomToken } from '../tokens.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { readOrgState, writeOrgState } from '../orgState.js';
import { listMedia } from '../accountMedia/store.js';
import { selectAll, exactCount, rangeFill, withRetry } from '../pagedSelect.js';
import { ID_RE } from '../queryParams.js';
import {
  scoreInspection, INSPECTION_LIST_LIMIT, inspectionFigures, publishRefusal,
} from '../../../src/lib/inspections.js';
import { fanOutManagerAlert } from '../../../src/lib/notifications.js';
import {
  computeDueAt, normalizePriority, normalizeStatus, severityToPriority,
  WO_TYPES, WO_ORIGINS, WO_PRIORITIES, WO_STATUSES,
} from '../../../src/lib/workOrders.js';

const nowIso = () => new Date().toISOString();

// Resolve denormalized client/site names from the blob at write time.
async function resolveNames({ clientId, siteId }) {
  try {
    const { state } = await readOrgState();
    const client = clientId ? (state?.clients || []).find((c) => c.id === clientId) : null;
    const site = siteId ? (state?.sites || []).find((s) => s.id === siteId) : null;
    return {
      clientName: client?.name || null,
      siteName: site?.name || null,
      clientId: clientId || site?.clientId || null,
    };
  } catch {
    return { clientName: null, siteName: null, clientId: clientId || null };
  }
}

// ── Problem reports ──────────────────────────────────────────────────────────
export async function createProblem({ clientId, siteId, jobId, title, description, priority, severity, type, origin, assigneeUserId, reportedByUserId }) {
  const names = await resolveNames({ clientId, siteId });
  const prio = normalizePriority(priority || severityToPriority(severity));
  const createdAt = nowIso();
  const db = getSupabase();
  const { data, error } = await db.from('problem_reports').insert({
    organization_id: CLEANSPACE_ORG_ID,
    client_id: names.clientId,
    site_id: siteId || null,
    job_id: jobId || null,
    reported_by_user_id: reportedByUserId || null,
    assignee_user_id: assigneeUserId || null,
    client_name: names.clientName,
    site_name: names.siteName,
    title,
    description: description || null,
    type: WO_TYPES.includes(type) ? type : 'issue',
    origin: WO_ORIGINS.includes(origin) ? origin : 'internal',
    priority: prio,
    status: 'open',
    created_at: createdAt,
    due_at: computeDueAt(createdAt, prio),
  }).select('*').single();
  if (error) throw error;
  return data;
}

// Fan out a manager bell row after a problem report lands — server-side so the
// office hears even with no tab open (the push-dispatch cron delivers the row to
// their devices). CAS-guarded against a concurrent org_state write, and fully
// best-effort: a failure here must never fail the already-persisted report.
export async function notifyManagersOfProblem(problem, tries = 4) {
  if (!problem) return;
  try {
    const label = problem.client_name || problem.site_name || 'an account';
    const prio = problem.priority === 'urgent' ? 'Urgent ' : problem.priority === 'high' ? 'High-priority ' : '';
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const notifications = fanOutManagerAlert({ ...state, notifications: state.notifications || [] }, {
        eventKey: 'problemReported',
        title: `${prio}work order — ${label}`.trim(),
        body: problem.title || '',
        url: '/inspections',
        actorUserId: problem.reported_by_user_id || null,
      });
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return;
    }
  } catch { /* best-effort — the report is already saved */ }
}

// Crew scope: only records at their assigned clients/sites, or ones they made
// themselves (`actorCol`). Enforced server-side (open RLS). ONE helper for every QC
// read (problems, inspections, checklists), so a new read can't forget the scope.
//
// 🔴 The ids are interpolated into a PostgREST or() FILTER STRING, so each one must be a
// plain id. Site ids reach the scope through the shared blob (getAssignedScope expands an
// assigned client into `sites[]`), and a crew user can add a site there: an id like
// `x),client_id.in.(B` would add its own OR branch and widen the read to another
// account's inspections, checklists and problem reports (found 2026-09-22 by the
// adversarial review). Anything outside the id alphabet is DROPPED — that only ever
// narrows the scope, never widens it.
const scopeIds = (ids) => (Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && ID_RE.test(id)) : []);
// A filter no row passes. The primary key is never null. (It was `eq('id', '__none__')`,
// which on these uuid-keyed tables is not "no rows" but a Postgres type error, 22P02, so a
// crew member with no scope got a failed read instead of an empty one.)
const noRows = (q) => q.is('id', null);
export function applyCrewScope(q, crewScope, actorCol) {
  if (!crewScope) return q;
  const clientIds = scopeIds(crewScope.clientIds);
  const siteIds = scopeIds(crewScope.siteIds);
  const userId = typeof crewScope.userId === 'string' && ID_RE.test(crewScope.userId) ? crewScope.userId : null;
  const ors = [];
  if (clientIds.length) ors.push(`client_id.in.(${clientIds.join(',')})`);
  if (siteIds.length) ors.push(`site_id.in.(${siteIds.join(',')})`);
  if (userId) ors.push(`${actorCol}.eq.${userId}`);
  return ors.length ? q.or(ors.join(',')) : noRows(q); // no scope → no rows
}

export async function listProblems({ status, priority, type, siteIds, clientId, crewScope = null, limit = 500 } = {}) {
  const db = getSupabase();
  let q = db.from('problem_reports').select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .order('created_at', { ascending: false }).limit(limit);
  if (status) q = q.eq('status', status);
  if (priority) q = q.eq('priority', priority);
  if (type) q = q.eq('type', type);
  if (clientId) q = q.eq('client_id', clientId);
  if (Array.isArray(siteIds) && siteIds.length) q = q.in('site_id', siteIds);
  // Crew scope: only problems for their assigned clients/sites, or ones they filed.
  q = applyCrewScope(q, crewScope, 'reported_by_user_id');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Single problem by id (for server-side authorization before an update).
export async function getProblem(id) {
  const db = getSupabase();
  const { data } = await db.from('problem_reports').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// Status transition (open → in_progress → awaiting_client → resolved), escalation,
// (re)assignment, priority + field edits. Priority re-arms the SLA clock from the
// original created_at; escalated:true keeps the first-escalated timestamp.
export async function updateProblem({ id, status, priority, type, title, description, assigneeUserId, escalated }) {
  const patch = { };
  if (status) {
    const s = normalizeStatus(status);
    if (WO_STATUSES.includes(s)) { patch.status = s; patch.resolved_at = s === 'resolved' ? nowIso() : null; }
  }
  if (priority) { const p = normalizePriority(priority); if (WO_PRIORITIES.includes(p)) patch.priority = p; }
  if (type && WO_TYPES.includes(type)) patch.type = type;
  if (assigneeUserId !== undefined) patch.assignee_user_id = assigneeUserId || null;
  if (escalated !== undefined) patch.escalated_at = escalated ? nowIso() : null;
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (Object.keys(patch).length === 0) return { noop: true };
  const db = getSupabase();
  if (patch.priority || escalated === true) {
    const { data: cur } = await db.from('problem_reports').select('created_at, escalated_at').eq('id', id).maybeSingle();
    if (cur) {
      if (patch.priority) patch.due_at = computeDueAt(cur.created_at, patch.priority);
      if (escalated === true && cur.escalated_at) patch.escalated_at = cur.escalated_at; // keep first-escalated time
    }
  }
  const { data, error } = await db.from('problem_reports').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  if (!data) return { notFound: true };
  return { problem: data };
}

// ── Work order message thread (Increment 2) ──────────────────────────────────
export async function listWorkOrderMessages(problemId) {
  const db = getSupabase();
  const { data, error } = await db.from('work_order_messages').select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('problem_id', problemId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Staff reply. Author name is denormalized from the blob when not supplied so the
// thread renders without it. The first office/crew reply advances an OPEN work order
// to in_progress (CAS via the status predicate on the update).
export async function addWorkOrderMessage({ problemId, body, authorUserId, authorRole, authorName }) {
  const db = getSupabase();
  let name = authorName || null;
  if (!name && authorUserId) {
    try { const { state } = await readOrgState(); name = (state?.users || []).find((u) => u.id === authorUserId)?.name || null; } catch { /* best-effort name */ }
  }
  const role = ['client', 'office', 'crew'].includes(authorRole) ? authorRole : 'office';
  const { data, error } = await db.from('work_order_messages').insert({
    organization_id: CLEANSPACE_ORG_ID, problem_id: problemId,
    author_user_id: authorUserId || null, author_role: role, author_name: name, body,
  }).select('*').single();
  if (error) throw error;
  if (role !== 'client') {
    try { await db.from('problem_reports').update({ status: 'in_progress' }).eq('id', problemId).eq('status', 'open'); } catch { /* best-effort auto-advance */ }
  }
  return data;
}

// ── Inspection / checklist TEMPLATES (versioned; publish freezes a version so
//    historical records never drift — the forms/form_versions port). ──────────
const EMPTY_SCHEMA = { areas: [] };
// Also mints inspection public_token — a bearer capability on a client-facing
// report. CSPRNG source, identical shape (see _lib/tokens.js).
const randId = (n = 14) => randomToken(n);

async function latestTemplateVersion(templateId, db = getSupabase()) {
  const { data, error } = await db.from('inspection_template_versions').select('*')
    .eq('template_id', templateId).order('version_number', { ascending: false }).limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

export async function createTemplate({ name, kind = 'inspection', ratingScale, createdBy }) {
  const db = getSupabase();
  const { data: tpl, error } = await db.from('inspection_templates').insert({
    organization_id: CLEANSPACE_ORG_ID,
    slug: randId(10),
    name: (name || '').trim() || 'Untitled inspection',
    kind: kind === 'checklist' ? 'checklist' : 'inspection',
    rating_scale: ratingScale || { type: 'passfail', passThreshold: 80 },
    created_by: createdBy || null,
  }).select('*').single();
  if (error) throw error;
  const { data: ver, error: vErr } = await db.from('inspection_template_versions')
    .insert({ template_id: tpl.id, version_number: 1, schema: EMPTY_SCHEMA, status: 'draft' }).select('*').single();
  if (vErr) throw vErr;
  return { template: tpl, version: ver };
}

// Every template of a kind, newest-edited first. A COMPLETE read (api/_lib/pagedSelect):
// PostgREST caps EVERY response at db-max-rows (1000 on Supabase) whatever `.limit()` or
// `.range()` asked for, and this list is no longer only a picker. The checklist-reminder
// walker skips a cleaner whose checklist is not among the live ids (CS-353), so a
// truncated read is not a short list — every cleaner bound to an older checklist reads as
// "deleted" and is never reminded again. Checklists become per-location in step 5
// (~3,750 rows), so the cap is reachable. `id` breaks an `updated_at` tie, or page
// membership is left to the planner and rows skip or repeat across boundaries.
function applyTemplateFilters(q, { kind } = {}) {
  const out = q.eq('organization_id', CLEANSPACE_ORG_ID);
  return kind ? out.eq('kind', kind) : out;
}
export async function listTemplates(filters = {}, { columns = '*', maxRows } = {}, db = getSupabase()) {
  return selectAll({
    count: async () => {
      const { count, error } = await applyTemplateFilters(db.from('inspection_templates').select('id', { count: 'exact', head: true }), filters);
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await applyTemplateFilters(db.from('inspection_templates').select(columns), filters)
        .order('updated_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
    maxRows,
  });
}

// Just the ids — all the checklist-reminder walker needs (it asks "does this checklist
// still exist?"). The same complete read over one narrow column, so the cron never pulls
// every template's name and scale to answer a set-membership question.
export async function listTemplateIds(filters = {}, db = getSupabase()) {
  return (await listTemplates(filters, { columns: 'id' }, db)).map((t) => t?.id).filter(Boolean);
}

export async function getTemplate(templateId) {
  const db = getSupabase();
  const { data: tpl, error } = await db.from('inspection_templates').select('*').eq('id', templateId).maybeSingle();
  if (error) throw error;
  if (!tpl) return null;
  const latest = await latestTemplateVersion(templateId);
  let published = null;
  if (tpl.published_version_id) {
    const { data } = await db.from('inspection_template_versions').select('*').eq('id', tpl.published_version_id).maybeSingle();
    published = data || null;
  }
  return { template: tpl, latest, published };
}

// Persist working schema into the latest draft; fork a new draft if the latest is
// published (so submitted records keep their frozen schema). Also updates name/scale.
export async function saveTemplate(templateId, { name, ratingScale, schema }) {
  const db = getSupabase();
  const latest = await latestTemplateVersion(templateId);
  let version;
  if (!latest || latest.status === 'published') {
    const { data, error } = await db.from('inspection_template_versions')
      .insert({ template_id: templateId, version_number: (latest?.version_number || 0) + 1, schema: schema || EMPTY_SCHEMA, status: 'draft' })
      .select('*').single();
    if (error) throw error;
    version = data;
  } else {
    const { data, error } = await db.from('inspection_template_versions')
      .update({ schema: schema || latest.schema }).eq('id', latest.id).select('*').single();
    if (error) throw error;
    version = data;
  }
  const patch = { updated_at: nowIso() };
  if (name !== undefined) patch.name = name;
  if (ratingScale !== undefined) patch.rating_scale = ratingScale;
  await db.from('inspection_templates').update(patch).eq('id', templateId);
  return version;
}

// Freeze the latest draft so submitted records never drift. REFUSES an item-less
// CHECKLIST ({ refused: <message> } → the route answers 400): with 0 items it can never
// be complete, so its holders would be reminded and escalated on every clean and step 4's
// clock-out block would lock them out with nothing to tick. The rule is the shared
// `publishRefusal` (src/lib/inspections.js), so the demo stub and the editor agree.
export async function publishTemplate(templateId, db = getSupabase()) {
  const latest = await latestTemplateVersion(templateId, db);
  if (!latest) return { nothing: true };
  const { data: tpl0, error: rErr } = await db.from('inspection_templates').select('*')
    .eq('id', templateId).eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
  if (rErr) throw rErr;
  if (!tpl0) return { nothing: true };
  const refused = publishRefusal({ kind: tpl0.kind, schema: latest.schema });
  if (refused) return { refused };
  const { data: ver, error } = await db.from('inspection_template_versions')
    .update({ status: 'published', published_at: nowIso() }).eq('id', latest.id).select('*').single();
  if (error) throw error;
  const { data: tpl, error: tErr } = await db.from('inspection_templates')
    .update({ is_published: true, published_version_id: ver.id, updated_at: nowIso() }).eq('id', templateId).select('*').single();
  if (tErr) throw tErr;
  return { template: tpl, version: ver };
}

// Hard delete a template (no archive). Its versions cascade (FK ON DELETE CASCADE,
// migration 20260614120000). Completed inspection_records / checklist_results carry a
// denormalized template_snapshot and have NO FK to the template, so history survives
// intact — only the reusable template + its draft/published versions are removed.
// Org-scoped so a stray id can't reach another org's template.
export async function deleteTemplate(templateId) {
  const db = getSupabase();
  const { error } = await db.from('inspection_templates').delete()
    .eq('id', templateId).eq('organization_id', CLEANSPACE_ORG_ID);
  if (error) throw error;
  return { ok: true };
}

// ── Inspection RECORDS (template frozen at fill time; scoring via lib/inspections) ──
export async function createInspection({ templateId, clientId, siteId, jobId, timeEntryId, inspectorUserId }) {
  const db = getSupabase();
  const { data: tpl } = await db.from('inspection_templates').select('*').eq('id', templateId).maybeSingle();
  if (!tpl) return { notFound: true };
  if (!tpl.published_version_id) return { notPublished: true };
  const { data: version } = await db.from('inspection_template_versions').select('*').eq('id', tpl.published_version_id).maybeSingle();
  if (!version) return { notPublished: true };

  const { state } = await readOrgState();
  const client = clientId ? (state?.clients || []).find((c) => c.id === clientId) : null;
  const site = siteId ? (state?.sites || []).find((s) => s.id === siteId) : null;
  const inspector = inspectorUserId ? (state?.users || []).find((u) => u.id === inspectorUserId) : null;

  const { data, error } = await db.from('inspection_records').insert({
    organization_id: CLEANSPACE_ORG_ID,
    public_token: randId(14),
    template_id: templateId,
    template_version_id: version.id,
    template_snapshot: { name: tpl.name, kind: tpl.kind, rating_scale: tpl.rating_scale, schema: version.schema },
    client_id: clientId || site?.clientId || null,
    site_id: siteId || null,
    job_id: jobId || null,
    time_entry_id: timeEntryId || null,
    inspector_user_id: inspectorUserId || null,
    client_name: client?.name || null,
    site_name: site?.name || null,
    inspector_name: inspector?.name || null,
    status: 'draft',
    performed_at: nowIso(),
  }).select('*').single();
  if (error) throw error;
  return { inspection: data };
}

// Replace items + compute the rollup. items: [{item_key,label,rating,comment,photo_count}].
export async function submitInspection({ id, items }) {
  const db = getSupabase();
  const { data: rec } = await db.from('inspection_records').select('*').eq('id', id).maybeSingle();
  if (!rec) return { notFound: true };
  await db.from('inspection_items').delete().eq('inspection_id', id);
  if (Array.isArray(items) && items.length) {
    const rows = items.map((it) => ({
      inspection_id: id, item_key: it.item_key || null, label: it.label || null,
      rating: it.rating != null ? String(it.rating) : null, comment: it.comment || null,
      photo_count: Number.isFinite(it.photo_count) ? it.photo_count : 0,
    }));
    const { error } = await db.from('inspection_items').insert(rows);
    if (error) throw error;
  }
  const scale = rec.template_snapshot?.rating_scale || { type: 'passfail', passThreshold: 80 };
  const { overallScore, result } = scoreInspection(items, scale);
  const { data, error } = await db.from('inspection_records')
    .update({ status: 'submitted', overall_score: overallScore, result, performed_at: rec.performed_at || nowIso(), updated_at: nowIso() })
    .eq('id', id).select('*').single();
  if (error) throw error;
  // A failing / needs-follow-up inspection is a churn signal the office shouldn't
  // have to discover by opening the report — fan out a manager bell row (best-effort,
  // server-side so it lands with no tab open). Mirrors notifyManagersOfProblem.
  if (result === 'fail' || result === 'needs_follow_up') {
    await notifyManagersOfFailedInspection(data);
  }
  return { inspection: data };
}

// Fan out a manager bell row when a submitted inspection fails / needs follow-up.
// CAS-guarded against a concurrent org_state write, fully best-effort: a failure
// here must never fail the already-persisted inspection. Mirrors notifyManagersOfProblem.
export async function notifyManagersOfFailedInspection(rec, tries = 4) {
  if (!rec) return;
  try {
    const label = rec.site_name || rec.client_name || 'an account';
    const scoreTxt = rec.overall_score != null ? ` (${rec.overall_score}%)` : '';
    const verb = rec.result === 'needs_follow_up' ? 'needs follow-up' : 'failed';
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const notifications = fanOutManagerAlert({ ...state, notifications: state.notifications || [] }, {
        eventKey: 'inspectionFailed',
        title: `Inspection ${verb} — ${label}${scoreTxt}`,
        body: rec.template_snapshot?.name || rec.template_name || '',
        url: '/inspections',
        actorUserId: rec.inspector_user_id || null,
      });
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return;
    }
  } catch { /* best-effort — the inspection is already saved */ }
}

// ONE definition of what an inspection filter means, for every inspection read that takes
// one: the Quality hub's list, its figures and its export, a customer's own tab, and the
// Reports tally. Absent (null/undefined) = no constraint. An id list keeps rows whose
// column is one of its ids, so an EMPTY list keeps nothing (IN ()), never "no filter",
// which would widen the read org-wide. An id outside the alphabet is dropped, as in
// applyCrewScope (the routes answer 400 first). The demo stub's twin is lib/inspections
// inspectionMatchesFilters; test-hub-inspections holds the two to one answer.
//   fromIso / toIso : performed_at bounds, inclusive; either may be absent
//   clientId        : one customer
//   siteIds         : any of these locations   (the hub's Locations facet)
//   inspectorIds    : done by any of these     (Inspector)
//   results         : any of these results      (Result)
//   submittedOnly   : drop drafts               (the Reports tally)
//   crewScope       : applyCrewScope. A filter narrows inside it, never past it.
function inList(q, col, values) {
  if (values == null) return q;
  const ok = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && ID_RE.test(v));
  return ok.length ? q.in(col, ok) : noRows(q);
}
function applyInspectionFilters(q, { fromIso, toIso, clientId, siteIds, inspectorIds, results, submittedOnly = false, crewScope = null } = {}) {
  let out = q.eq('organization_id', CLEANSPACE_ORG_ID);
  if (fromIso) out = out.gte('performed_at', fromIso);
  if (toIso) out = out.lte('performed_at', toIso);
  if (clientId) out = out.eq('client_id', clientId);
  out = inList(out, 'site_id', siteIds);
  out = inList(out, 'inspector_user_id', inspectorIds);
  out = inList(out, 'result', results);
  if (submittedOnly) out = out.neq('status', 'draft');
  return applyCrewScope(out, crewScope, 'inspector_user_id');
}

// The columns the hub list + a customer's Inspections tab actually render — NOT `select
// *`. The frozen `template_snapshot` runs to kilobytes and only its name is shown (read
// through `template_snapshot->>name`), and `*` shipped `public_token` — a bearer
// capability — to every qc.view reader; the route now hands the token only to a caller who
// may share (see the list action). template_name matches INSPECTION_EXPORT_COLUMNS.
export const INSPECTION_LIST_COLUMNS = 'id,client_id,site_id,client_name,site_name,template_name:template_snapshot->>name,overall_score,result,status,inspector_name,performed_at,public_token';

// An inspection HISTORY list, newest first: the Quality hub's (filtered by its Locations,
// Result, Inspector and Date range) or, with `clientId`, one customer's own Inspections
// tab. Every filter runs IN THE QUERY. Both used to take the org's newest 200 and filter
// that in the browser, so once the org passed 200 a customer's, a location's, an
// inspector's or an older range's inspections (or all of them) fell off the list. A list,
// not a complete read (UI_RULES §117): the newest `limit` matching rows, plus `truncated`
// when there are more. One row past the cap is read so `truncated` is exact, through
// rangeFill so a cap above db-max-rows still means what it says. Anything that COUNTS
// reads the complete reads below instead.
export async function listInspections({ limit = INSPECTION_LIST_LIMIT, ...filters } = {}, db = getSupabase()) {
  const page = async (from, to) => {
    const { data, error } = await applyInspectionFilters(db.from('inspection_records').select(INSPECTION_LIST_COLUMNS), filters)
      .order('performed_at', { ascending: false }).order('id', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data || [];
  };
  const rows = await rangeFill(page, 0, limit);
  return { inspections: rows.slice(0, limit), truncated: rows.length > limit };
}

// ── Complete window reads (reports, the alert walkers, the hub's figures + export) ──
// Every record the filters match, never a newest-N slice (api/_lib/pagedSelect.js:
// ordered pages, filled past db-max-rows, loud on a short read). Narrow columns: a
// record's template_snapshot / items can run to kilobytes, and a count needs none of it.
export const INSPECTION_WINDOW_COLUMNS = 'id,client_id,site_id,client_name,site_name,inspector_user_id,overall_score,result,status,performed_at';
export const CHECKLIST_WINDOW_COLUMNS = 'id,client_id,site_id,job_id,completed_by_user_id,completed_count,total_count,performed_at';

// How many inspections the filters match: a head count, no rows. The count half of every
// complete read below, and the `total` the hub's paged export reports on its first page.
export async function countInspectionsMatching(filters = {}, db = getSupabase()) {
  const { count, error } = await applyInspectionFilters(db.from('inspection_records').select('id', { count: 'exact', head: true }), filters);
  if (error) throw error;
  return exactCount(count);
}

export async function listInspectionsInWindow(filters = {}, { columns = INSPECTION_WINDOW_COLUMNS, maxRows } = {}, db = getSupabase()) {
  return selectAll({
    count: () => countInspectionsMatching(filters, db),
    page: async (from, to) => {
      const { data, error } = await applyInspectionFilters(db.from('inspection_records').select(columns), filters)
        .order('performed_at', { ascending: true }).order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
    maxRows,
  });
}

// The Quality hub's figures (its stat cards) over EVERY inspection its filters match, not
// the newest 200 its list holds: they were tallied from that list in the browser, so past
// 200 they were figures over a partial set (UI_RULES §117). Tallied here with the shared
// lib/inspections inspectionFigures, so the browser gets one small object. No date range
// = all time, bounded by maxRows (413, "narrow the date range"), never cut short.
export const INSPECTION_FIGURE_COLUMNS = 'id,overall_score,result,status,performed_at';
export async function inspectionFiguresMatching(filters = {}, { maxRows } = {}, db = getSupabase()) {
  return inspectionFigures(await listInspectionsInWindow(filters, { columns: INSPECTION_FIGURE_COLUMNS, maxRows }, db));
}

// One page of the hub's Export CSV: rows [offset, offset + limit) of EVERY inspection the
// filters match, newest first (ties by id), in the CSV's columns. The browser reads every
// page (lib/pagedFetch.js: the first page's `total` from countInspectionsMatching,
// overlapping pages, per-page retry, an error rather than a partial file); it used to
// write only the newest 200 the list held, silently. Paged because one function response
// can't carry an unbounded export (Vercel caps it at 4.5 MB). The template's name is read
// out of the frozen snapshot (template_snapshot->>name), not the snapshot itself. The
// fields match lib/inspections toInspectionExportRow (the demo stub's projection).
export const INSPECTION_EXPORT_COLUMNS = 'id,performed_at,client_id,site_id,client_name,site_name,template_name:template_snapshot->>name,overall_score,result,inspector_name';
export async function pageInspectionsForExport(filters = {}, { offset = 0, limit = 1000 } = {}, db = getSupabase()) {
  const page = async (from, to) => {
    const { data, error } = await applyInspectionFilters(db.from('inspection_records').select(INSPECTION_EXPORT_COLUMNS), filters)
      .order('performed_at', { ascending: false }).order('id', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data || [];
  };
  return rangeFill(page, offset, offset + limit - 1);
}

// The NEWEST submitted inspection per client — all the inspection-reminder walker decides
// on (is each account's latest inspection older than the reminder interval?). Read
// newest-first in ordered pages (the organization_id + performed_at desc index), stopping
// as soon as every wanted client has been seen (usually page one or two), bounded below by
// `sinceIso` (required — an account with nothing since reads as never inspected). A fixed
// window of recent records is not enough: an account last inspected before the window
// read as "never inspected" and was never reminded (review finding, 2026-09-22).
// Drafts don't count: an inspection started and abandoned is not one done (the Reports
// tally skips them too). Pages overlap so a record deleted mid-read can't shift an
// account's newest row past a page seam; the first sighting per account wins.
//   clientIds : the accounts that matter — rows for any other client are dropped, and
//               the read stops once all of these are seen. null = every client (the
//               read then runs to sinceIso).
export async function latestInspectionPerClient({ clientIds = null, sinceIso, untilIso } = {}, db = getSupabase()) {
  if (!sinceIso) throw new Error('latestInspectionPerClient needs sinceIso');
  const want = Array.isArray(clientIds) ? new Set(clientIds) : null;
  const latest = new Map();
  if (want && !want.size) return [];
  const page = async (from, to) => {
    let q = db.from('inspection_records').select('id,client_id,performed_at')
      .eq('organization_id', CLEANSPACE_ORG_ID).neq('status', 'draft').not('client_id', 'is', null)
      .gte('performed_at', sinceIso);
    if (untilIso) q = q.lte('performed_at', untilIso);
    const { data, error } = await q
      .order('performed_at', { ascending: false }).order('id', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data || [];
  };
  const PAGE = 1000;
  const LAP = 50;
  for (let from = 0; ; from += PAGE - LAP) {
    const rows = await withRetry(() => rangeFill(page, from, from + PAGE - 1));
    for (const r of rows) {
      if (!r.client_id || (want && !want.has(r.client_id))) continue;
      if (!latest.has(r.client_id)) latest.set(r.client_id, { client_id: r.client_id, performed_at: r.performed_at });
    }
    if (rows.length < PAGE) break;
    if (want && latest.size >= want.size) break;
  }
  return [...latest.values()];
}

function applyChecklistWindow(q, { fromIso, toIso, siteId, clientId, crewScope = null } = {}) {
  let out = q.eq('organization_id', CLEANSPACE_ORG_ID);
  if (fromIso) out = out.gte('performed_at', fromIso);
  if (toIso) out = out.lte('performed_at', toIso);
  if (siteId) out = out.eq('site_id', siteId);
  if (clientId) out = out.eq('client_id', clientId);
  return applyCrewScope(out, crewScope, 'completed_by_user_id');
}

export async function listChecklistsInWindow(filters = {}, { columns = CHECKLIST_WINDOW_COLUMNS, maxRows } = {}, db = getSupabase()) {
  return selectAll({
    count: async () => {
      const { count, error } = await applyChecklistWindow(db.from('checklist_results').select('id', { count: 'exact', head: true }), filters);
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await applyChecklistWindow(db.from('checklist_results').select(columns), filters)
        .order('performed_at', { ascending: true }).order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
    maxRows,
  });
}

export async function getInspection(id) {
  const db = getSupabase();
  const { data: rec } = await db.from('inspection_records').select('*').eq('id', id).maybeSingle();
  if (!rec) return null;
  const { data: items } = await db.from('inspection_items').select('*').eq('inspection_id', id);
  return { inspection: rec, items: items || [] };
}

// ── Checklists (checklist_results — items inline, no scoring; one submit) ──────
// Uses the SAME templates (kind='checklist'); the published version is snapshotted
// at submit. items: [{ key, label, checked, note }].
export async function submitChecklist({ templateId, clientId, siteId, jobId, items, completedByUserId, clientSubmitId = null }) {
  const db = getSupabase();
  // Idempotent replay (crew audit C1): an offline-buffered checklist re-sends the same
  // client_submit_id on reconnect (and a double-tap sends it twice). Return the already-
  // stored row instead of inserting a duplicate. Backed by the partial unique index
  // (organization_id, client_submit_id) from 20260803140000.
  if (clientSubmitId) {
    const { data: existing } = await db.from('checklist_results').select('*')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_submit_id', clientSubmitId).maybeSingle();
    if (existing) return { checklist: existing };
  }
  const { data: tpl } = await db.from('inspection_templates').select('*').eq('id', templateId).maybeSingle();
  if (!tpl) return { notFound: true };
  if (!tpl.published_version_id) return { notPublished: true };
  const { data: version } = await db.from('inspection_template_versions').select('*').eq('id', tpl.published_version_id).maybeSingle();
  if (!version) return { notPublished: true };
  const { state } = await readOrgState();
  const site = siteId ? (state?.sites || []).find((s) => s.id === siteId) : null;
  const list = Array.isArray(items) ? items : [];
  const { data, error } = await db.from('checklist_results').insert({
    organization_id: CLEANSPACE_ORG_ID,
    template_id: templateId,
    template_version_id: version.id,
    template_snapshot: { name: tpl.name, kind: tpl.kind, schema: version.schema },
    client_id: clientId || site?.clientId || null,
    site_id: siteId || null,
    job_id: jobId || null,
    completed_by_user_id: completedByUserId || null,
    items: list,
    completed_count: list.filter((i) => i.checked).length,
    total_count: list.length,
    client_submit_id: clientSubmitId || null,
    performed_at: nowIso(),
  }).select('*').single();
  if (error) {
    // A concurrent replay won the insert race (unique violation): return the winner's
    // row rather than 500ing the client into an infinite retry.
    if (error.code === '23505' && clientSubmitId) {
      const { data: winner } = await db.from('checklist_results').select('*')
        .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_submit_id', clientSubmitId).maybeSingle();
      if (winner) return { checklist: winner };
    }
    throw error;
  }
  return { checklist: data };
}

export async function listChecklists({ siteId, jobId, crewScope = null, limit = 200 } = {}) {
  const db = getSupabase();
  let q = db.from('checklist_results').select('*').eq('organization_id', CLEANSPACE_ORG_ID)
    .order('performed_at', { ascending: false }).limit(limit);
  if (siteId) q = q.eq('site_id', siteId);
  if (jobId) q = q.eq('job_id', jobId);
  q = applyCrewScope(q, crewScope, 'completed_by_user_id');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Normalize a record + its items + its photos into the shared REPORT shape consumed
// by the public page, the in-app modal, and the PDF renderer (buildInspectionReportHtml
// in src/lib). Photos arrive already resolved to a browser/PDF-usable `url` (a signed
// URL from listMedia, or an inlined data: URI from the PDF renderer) and carry areaId
// so the report can group them under their section. Pure — no DB access.
export function projectReport(rec, items, photos) {
  return {
    inspection: {
      templateName: rec.template_snapshot?.name || 'Inspection',
      schema: rec.template_snapshot?.schema || { areas: [] },
      ratingScale: rec.template_snapshot?.rating_scale || null,
      siteName: rec.site_name, clientName: rec.client_name, inspectorName: rec.inspector_name,
      overallScore: rec.overall_score, result: rec.result, performedAt: rec.performed_at,
    },
    items: (items || []).map((it) => ({ itemKey: it.item_key, label: it.label, rating: it.rating, comment: it.comment })),
    photos: (photos || []).map((p) => ({ id: p.id, kind: p.kind, url: p.url, caption: p.caption, areaId: p.areaId ?? p.area_id ?? null })),
  };
}

// Public, token-scoped read of a SUBMITTED inspection (the shareable report). The
// unguessable public_token is the capability — no auth, no org check beyond the
// token match. Returns a SAFE projection (no internal ids). Draft records 404.
export async function getInspectionByToken(token) {
  const db = getSupabase();
  const { data: rec } = await db.from('inspection_records').select('*').eq('public_token', token).maybeSingle();
  if (!rec || rec.status === 'draft') return null;
  const { data: items } = await db.from('inspection_items').select('*').eq('inspection_id', rec.id);
  let photos = [];
  try { photos = await listMedia({ refId: rec.id, scope: 'inspection' }); } catch { /* photos best-effort */ }
  return projectReport(rec, items, photos);
}

// Raw record + items for a SUBMITTED inspection by public_token — the public PDF
// route needs the row + items to feed the chromium renderer (which inlines photos
// itself). Draft/missing → null, so the public PDF 404s exactly like the HTML report.
export async function getInspectionRawByToken(token) {
  const db = getSupabase();
  const { data: rec } = await db.from('inspection_records').select('*').eq('public_token', token).maybeSingle();
  if (!rec || rec.status === 'draft') return null;
  const { data: items } = await db.from('inspection_items').select('*').eq('inspection_id', rec.id);
  return { rec, items: items || [] };
}

// Authed in-app report: the SAME normalized shape as the public projection, PLUS the
// internal id/status/public_token the report modal needs for its actions (Download
// PDF, Copy link). Returns { rec, report } so the route can crew-scope on the raw row
// (mirrors getInspection) before handing back `report`. null when no such record.
export async function getInspectionReport(id) {
  const db = getSupabase();
  const { data: rec } = await db.from('inspection_records').select('*').eq('id', id).maybeSingle();
  if (!rec) return null;
  const { data: items } = await db.from('inspection_items').select('*').eq('inspection_id', id);
  let photos = [];
  try { photos = await listMedia({ refId: id, scope: 'inspection' }); } catch { /* photos best-effort */ }
  const report = projectReport(rec, items, photos);
  report.inspection.id = rec.id;
  report.inspection.status = rec.status;
  report.inspection.publicToken = rec.public_token;
  return { rec, report };
}
