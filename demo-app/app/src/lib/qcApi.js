// Client adapter for QC — inspections, checklists, problem reports. Real backend
// (/api/qc/*) when Supabase is configured; an auto-engaged localStorage stub in
// local/demo mode so the surfaces are exercisable. QC lists are component-local
// projections (useState), never the synced blob. PROBLEM REPORTS land first.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';
import {
  scoreInspection, INSPECTION_LIST_LIMIT, publishRefusal,
  inspectionMatchesFilters, newestInspectionFirst, inspectionFigures as figuresOf, toInspectionExportRow,
} from './inspections';
import { fetchAllPages } from './pagedFetch';
import { buildInspectionReportHtml } from './inspectionReportTemplate';
import { listMedia as listSiteMedia } from './accountMediaApi';
import { addChecklist, allChecklists, removeChecklist, updateChecklist, newChecklistId } from './checklistQueue';
import { isOfflineError } from './netError';
import { QC_CHECKLISTS_STUB_KEY } from '../data/stubKeys';
import { drainQueue } from './offlineRetry';
import { forgetGateMemo } from './checklistGateMemo';
import { aggregateInspectionsPerSite, aggregateChecklistsPerSite } from './reports/qcReports';
import { INSPECTION_LOOKBACK_DAYS } from './opsAlerts';
import {
  normalizePriority, normalizeStatus, computeDueAt, severityToPriority,
  WO_TYPES, WO_ORIGINS, DEFAULT_WO_TYPE, DEFAULT_WO_ORIGIN,
} from './workOrders';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js (Sept 1 incident)
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isQcStub() { return !BACKEND; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── Problem reports ──────────────────────────────────────────────────────────
// clientName/siteName are used only by the stub (the real backend denormalizes
// names server-side and ignores them).
export async function createProblem(p) {
  if (BACKEND) return (await api('/qc/problems/create', { method: 'POST', body: p })).problem;
  return stubCreateProblem(p);
}
export async function listProblems(filters = {}) {
  if (BACKEND) {
    const qs = new URLSearchParams();
    if (filters.status) qs.set('status', filters.status);
    if (filters.priority) qs.set('priority', filters.priority);
    if (filters.type) qs.set('type', filters.type);
    if (filters.clientId) qs.set('clientId', filters.clientId);
    if (filters.siteIds?.length) qs.set('siteIds', filters.siteIds.join(','));
    const q = qs.toString();
    return (await api(`/qc/problems/list${q ? `?${q}` : ''}`)).problems;
  }
  return stubListProblems(filters);
}
export async function updateProblem(p) {
  if (BACKEND) return (await api('/qc/problems/update', { method: 'POST', body: p })).problem;
  return stubUpdateProblem(p);
}

// ── Work order message thread (Increment 2) ──────────────────────────────────
export async function listWorkOrderMessages(problemId) {
  if (BACKEND) return (await api(`/qc/problems/messages?problemId=${encodeURIComponent(problemId)}`)).messages;
  return stubListMessages(problemId);
}
export async function addWorkOrderMessage(p) {
  if (BACKEND) return (await api('/qc/problems/message', { method: 'POST', body: p })).message;
  return stubAddMessage(p);
}

// ── Inspection / checklist templates ─────────────────────────────────────────
export async function listTemplates({ kind } = {}) {
  if (BACKEND) return (await api(`/qc/templates/list${kind ? `?kind=${kind}` : ''}`)).templates;
  return stubT().templates;
}
export async function createTemplate(p) {
  if (BACKEND) return api('/qc/templates/create', { method: 'POST', body: p });
  return stubCreateTemplate(p);
}
export async function getTemplate(id) {
  if (BACKEND) return api(`/qc/templates/get?id=${encodeURIComponent(id)}`);
  return stubGetTemplate(id);
}
export async function saveTemplate(id, patch) {
  if (BACKEND) return (await api('/qc/templates/save', { method: 'POST', body: { id, ...patch } })).version;
  return stubSaveTemplate(id, patch);
}
export async function publishTemplate(id) {
  if (BACKEND) return api('/qc/templates/publish', { method: 'POST', body: { id } });
  return stubPublishTemplate(id);
}
// Hard delete (no archive). Versions cascade (FK ON DELETE CASCADE); completed records
// keep their denormalized template_snapshot, so history survives. The caller scrubs
// client bindings (SCRUB_CHECKLIST_TEMPLATE) so no default/per-cleaner entry dangles.
export async function deleteTemplate(id) {
  if (BACKEND) return api('/qc/templates/delete', { method: 'POST', body: { id } });
  return stubDeleteTemplate(id);
}

// ── Inspection records ───────────────────────────────────────────────────────
// clientName/siteName/inspectorName are used only by the stub.
export async function createInspection(p) {
  if (BACKEND) return (await api('/qc/inspections/create', { method: 'POST', body: p })).inspection;
  return stubCreateInspection(p);
}
export async function submitInspection({ id, items }) {
  if (BACKEND) return (await api('/qc/inspections/submit', { method: 'POST', body: { id, items } })).inspection;
  return stubSubmitInspection({ id, items });
}
// The inspection filters every inspection read below takes (the Quality hub's facets, via
// lib/filters/inspectionFilters inspectionListQuery, or a customer's own tab):
//   { clientId, siteIds, inspectorIds, results, fromIso, toIso }
// A missing or EMPTY list is no constraint (an empty facet filters nothing). They run
// server-side: never read an unfiltered list and narrow it here, or the records that
// match fall out of the org's newest 200.
const listOrNull = (a) => (Array.isArray(a) && a.length ? a : null);
function inspectionFilters({ clientId, siteIds, inspectorIds, results, fromIso, toIso } = {}) {
  return {
    clientId: clientId || null, siteIds: listOrNull(siteIds), inspectorIds: listOrNull(inspectorIds),
    results: listOrNull(results), fromIso: fromIso || null, toIso: toIso || null,
  };
}
function inspectionParams(f) {
  const qs = new URLSearchParams();
  if (f.clientId) qs.set('clientId', f.clientId);
  if (f.siteIds) qs.set('siteIds', f.siteIds.join(','));
  if (f.inspectorIds) qs.set('inspectorIds', f.inspectorIds.join(','));
  if (f.results) qs.set('results', f.results.join(','));
  if (f.fromIso) qs.set('fromIso', f.fromIso);
  if (f.toIso) qs.set('toIso', f.toIso);
  return qs;
}
function inspectionQuery(f) {
  const q = inspectionParams(f).toString();
  return q ? `?${q}` : '';
}

// An inspection HISTORY list → { inspections, truncated }: the newest
// INSPECTION_LIST_LIMIT that match the filters. `truncated` = there are more, and the view
// says "showing the newest N" (UI_RULES §117). Anything that COUNTS reads a complete read:
// inspectionFigures / exportInspections here, inspectionsBySite /
// latestInspectionPerClient below.
export async function listInspections(filters = {}) {
  const f = inspectionFilters(filters);
  if (BACKEND) {
    const r = await api(`/qc/inspections/list${inspectionQuery(f)}`);
    return { inspections: r.inspections || [], truncated: !!r.truncated };
  }
  return stubListInspections(f);
}

// The Quality hub's stat cards over EVERY inspection the filters match (not the list's
// newest 200): { total, count, avgScore, delta, failCount, … } (lib/inspections
// inspectionFigures). Tallied server-side; the demo runs the same function locally.
export async function inspectionFigures(filters = {}) {
  const f = inspectionFilters(filters);
  if (BACKEND) return (await api(`/qc/inspections/figures${inspectionQuery(f)}`)).figures;
  return figuresOf(stubMatchingInspections(f));
}

// Export CSV: EVERY inspection the filters match, newest first, as export rows (lib/
// inspections toInspectionExportRow). Read in pages (lib/pagedFetch.js: count-first,
// overlapping, retried), because no single response can carry an unbounded export; it
// throws rather than return a partial set.
export async function exportInspections(filters = {}) {
  const f = inspectionFilters(filters);
  if (BACKEND) {
    const rows = await fetchAllPages({
      fetchPage: async (offset, limit) => {
        const qs = inspectionParams(f);
        qs.set('offset', String(offset));
        qs.set('limit', String(limit));
        const r = await api(`/qc/inspections/export?${qs.toString()}`);
        return { rows: r.inspections || [], total: r.total, limit: r.limit };
      },
    });
    return rows.sort(newestInspectionFirst);
  }
  return stubMatchingInspections(f).map(toInspectionExportRow);
}

// Reports › Inspections / site and Checklists / site. Tallied over EVERY record in the
// window — server-side on the real backend (one row per site comes back, never the
// records), by the SAME pure aggregator here in the demo. The caller applies the
// Manager / Customer scope and the live names (lib/reports/qcReports.scopeSiteRows).
export async function inspectionsBySite({ fromIso, toIso, result = null, clientId = null } = {}) {
  if (BACKEND) {
    const qs = new URLSearchParams({ fromIso, toIso });
    if (result) qs.set('result', result);
    if (clientId) qs.set('clientId', clientId);
    return (await api(`/qc/reports/inspections-by-site?${qs.toString()}`)).rows || [];
  }
  return aggregateInspectionsPerSite({
    inspections: stubI().inspections, fromMs: Date.parse(fromIso), toMs: Date.parse(toIso), result, clientId,
  });
}
export async function checklistsBySite({ fromIso, toIso, clientId = null } = {}) {
  if (BACKEND) {
    const qs = new URLSearchParams({ fromIso, toIso });
    if (clientId) qs.set('clientId', clientId);
    return (await api(`/qc/reports/checklists-by-site?${qs.toString()}`)).rows || [];
  }
  return aggregateChecklistsPerSite({
    checklists: loadC().checklists, fromMs: Date.parse(fromIso), toMs: Date.parse(toIso), clientId,
  });
}

// The newest SUBMITTED inspection per active customer — the inspection-reminder walker's
// input. Real mode: the server reads newest-first and stops once every account is seen
// (crew get only the customers wholly in their scope); the demo reduces the local records
// the same way. Rows: { client_id, performed_at }.
export async function latestInspectionPerClient() {
  if (BACKEND) return (await api('/qc/inspections/latest-by-client')).inspections || [];
  const now = Date.now();
  const since = now - INSPECTION_LOOKBACK_DAYS * 24 * 3600 * 1000;
  const latest = new Map();
  for (const r of stubI().inspections) {
    if (!r || !r.client_id || r.status === 'draft') continue;
    const t = Date.parse(r.performed_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    const prev = latest.get(r.client_id);
    if (!prev || t > Date.parse(prev.performed_at)) latest.set(r.client_id, { client_id: r.client_id, performed_at: r.performed_at });
  }
  return [...latest.values()];
}

function inWindow(iso, fromIso, toIso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return (!fromIso || t >= Date.parse(fromIso)) && (!toIso || t <= Date.parse(toIso));
}
export async function getInspection(id) {
  if (BACKEND) return api(`/qc/inspections/get?id=${encodeURIComponent(id)}`);
  return stubGetInspection(id);
}

// Full normalized report for the in-app report modal: template schema + answers +
// per-section photos, plus id/status/publicToken for the modal's actions. Same shape
// as getPublicInspection (which the public /inspect page uses).
export async function getInspectionReport(id) {
  if (BACKEND) return api(`/qc/inspections/report?id=${encodeURIComponent(id)}`);
  return stubInspectionReport(id);
}

// Download the server-rendered report PDF. The endpoint needs the Authorization
// header, so a plain <a href> can't reach it — fetch the bytes, then trigger a save.
// In local/demo mode (no backend) fall back to a client-side print-to-PDF of the
// exact same report HTML.
export async function downloadInspectionPdf(id) {
  if (!BACKEND) return stubPrintInspection(id);
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}/qc/inspections/pdf?id=${encodeURIComponent(id)}`, { headers: auth });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); msg = j?.error || msg; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  saveBlob(blob, filenameFromDisposition(res.headers.get('Content-Disposition')) || `inspection-${id}.pdf`);
}

function filenameFromDisposition(cd) {
  const m = /filename="?([^"]+)"?/.exec(cd || '');
  return m ? m[1] : null;
}
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Render the report HTML into a new window and hand it to the browser's print dialog
// (which offers "Save as PDF"). The demo fallback for both the in-app and public
// download buttons; prod uses the chromium-rendered server PDF instead.
function printReportHtml(report) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups to print or save the report as a PDF.');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Inspection report</title></head><body>${buildInspectionReportHtml(report)}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
async function stubPrintInspection(id) {
  const report = await stubInspectionReport(id);
  if (!report) throw new Error('Inspection not found');
  printReportHtml(report);
}

// Public "Download PDF" on the shared /inspect/:token page. With a backend, click a
// tokened link to the public PDF endpoint (server sets the attachment filename). In
// demo mode, print the same HTML client-side.
export async function downloadPublicInspectionPdf(token) {
  if (BACKEND) {
    const a = document.createElement('a');
    a.href = `${BACKEND}/public/qc/inspection-pdf?token=${encodeURIComponent(token)}`;
    a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  const report = await stubPublicInspection(token);
  if (!report) throw new Error('Report not found');
  printReportHtml(report);
}

// ── Checklists (reuse kind='checklist' templates; one submit, items inline) ──
// p: { templateId, siteId, clientId, jobId?, items, completedByUserId? }. jobId binds
// the completed checklist to a specific clean (checklist_results.job_id) so the job
// can show its completion state. `completedByUserId` is read only by the STUB: the real
// backend stamps `completed_by_user_id` from the JWT claim and ignores the body field
// (app/api/qc/[...path].js), which is why a result can only ever be matched to a cleaner
// by that id and never by a name (CS-403).
// Complete a checklist. Offline-resilient (crew audit C1): the device stamps a
// clientSubmitId, and if the submit can't reach the server it is buffered in IndexedDB
// (checklistQueue) and replayed on reconnect by OfflineChecklistSync. The server dedupes
// on clientSubmitId, so a replay never duplicates. Returns { pending_sync:true } when it
// was buffered, so ChecklistFill can tell the crew it's saved and will sync.
export async function submitChecklist(p) {
  if (!BACKEND) return stubSubmitChecklist(p);
  const clientSubmitId = p.clientSubmitId || newChecklistId();
  const body = { ...p, clientSubmitId };
  try {
    return (await api('/qc/checklists/submit', { method: 'POST', body })).checklist;
  } catch (e) {
    if (!isOfflineError(e)) throw e; // a real rejection (403/404/400) — surface it
    await addChecklist({ id: clientSubmitId, payload: body, createdAt: new Date().toISOString() });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('rfs:checklist-queued'));
    return { pending_sync: true, id: clientSubmitId };
  }
}

// Replay every buffered checklist on reconnect. Idempotent server-side (client_submit_id).
// CS-007: the loop is now the SHARED drain (lib/offlineRetry) — a 5xx / 429 / 408 / 401 /
// 403 KEEPS the item and backs off, only a definitive validation 4xx stops the retries,
// and even then the submission stays on the device marked `failed` for Retry / Discard
// (components/OfflineQueueFailures). It used to delete the item on ANY non-transport
// error, so one transient server hiccup destroyed a cleaner's completed checklist.
// Emits rfs:checklist-flushed when anything synced or newly failed, so the gate,
// CleanChecklist and the failure card all refresh.
export async function flushChecklistQueue() {
  if (!BACKEND) return { flushed: 0 };
  const items = await allChecklists();
  const byId = new Map(items.map((it) => [it.id, it]));
  const out = await drainQueue(items, {
    send: (it) => api('/qc/checklists/submit', { method: 'POST', body: it.payload }),
    remove: removeChecklist,
    mark: async (id, patch) => {
      // A checklist that will now NEVER reach the server must not leave this phone
      // remembering the clean as done — that remembered DONE is what keeps the clock-out
      // unlocked offline (lib/checklistGateMemo; writeGateMemo refuses every downgrade, so
      // a terminal failure is the one case that has to withdraw it by hand).
      if (patch?.failed) {
        const p = byId.get(id)?.payload;
        if (p) forgetGateMemo({ jobId: p.jobId, userId: p.completedByUserId, templateId: p.templateId });
      }
      return updateChecklist(id, patch);
    },
  });
  if ((out.flushed || out.stopped) && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('rfs:checklist-flushed'));
  }
  return out;
}

// Buffered checklists still to sync. Terminally `failed` ones are on the device too and
// count by default — they ARE still un-synced work the crew can see and act on.
export async function pendingChecklistCount({ includeFailed = true } = {}) {
  const items = await allChecklists();
  return includeFailed ? items.length : items.filter((it) => !it.failed).length;
}
// Newest-200 list, or — with { fromIso, toIso } — the COMPLETE window read (the
// checklist-reminder walker). Unlike listInspections above, where a date range is only a
// filter on the newest-200 list.
export async function listChecklists({ siteId, jobId, fromIso, toIso } = {}) {
  if (BACKEND) {
    const qs = new URLSearchParams();
    if (siteId) qs.set('siteId', siteId);
    if (jobId) qs.set('jobId', jobId);
    if (fromIso) qs.set('fromIso', fromIso);
    if (toIso) qs.set('toIso', toIso);
    const q = qs.toString();
    return (await api(`/qc/checklists/list${q ? `?${q}` : ''}`)).checklists;
  }
  let rows = loadC().checklists.slice();
  if (siteId) rows = rows.filter((c) => c.site_id === siteId);
  if (jobId) rows = rows.filter((c) => c.job_id === jobId);
  if (fromIso || toIso) rows = rows.filter((c) => inWindow(c.performed_at, fromIso, toIso));
  return rows.sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at));
}

// Public shareable inspection report (no auth — token is the capability).
export async function getPublicInspection(token) {
  if (BACKEND) return api(`/public/qc/inspection?token=${encodeURIComponent(token)}`);
  return stubPublicInspection(token);
}

// ── stub store (demo / local-only) ───────────────────────────────────────────
const KEY = 'cleanspace_qc_problems_stub_v1';
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { problems: [] }; } catch { return { problems: [] }; } };
const save = (db) => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* quota */ } };

function stubCreateProblem({ clientId, siteId, jobId, title, description, priority, severity, type, origin, assigneeUserId, reportedByUserId, clientName, siteName }) {
  const db = load();
  const prio = normalizePriority(priority || severityToPriority(severity));
  const created_at = nowIso();
  const row = {
    id: rid('pr'), client_id: clientId || null, site_id: siteId || null, job_id: jobId || null,
    client_name: clientName || null, site_name: siteName || null,
    reported_by_user_id: reportedByUserId || null, assignee_user_id: assigneeUserId || null,
    title, description: description || null,
    type: WO_TYPES.includes(type) ? type : DEFAULT_WO_TYPE,
    origin: WO_ORIGINS.includes(origin) ? origin : DEFAULT_WO_ORIGIN,
    priority: prio,
    status: 'open', photo_paths: [],
    due_at: computeDueAt(created_at, prio), escalated_at: null,
    created_at, resolved_at: null,
  };
  db.problems.push(row); save(db); return row;
}
function stubListProblems({ status, priority, type, clientId, siteIds } = {}) {
  let rows = load().problems;
  if (status) rows = rows.filter((r) => normalizeStatus(r.status) === status);
  if (priority) rows = rows.filter((r) => normalizePriority(r.priority || severityToPriority(r.severity)) === priority);
  if (type) rows = rows.filter((r) => r.type === type);
  if (clientId) rows = rows.filter((r) => r.client_id === clientId);
  if (siteIds?.length) rows = rows.filter((r) => siteIds.includes(r.site_id));
  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}
function stubUpdateProblem({ id, status, priority, type, title, description, assigneeUserId, escalated }) {
  const db = load();
  const r = db.problems.find((x) => x.id === id);
  if (!r) return null;
  if (status) { const s = normalizeStatus(status); r.status = s; r.resolved_at = s === 'resolved' ? nowIso() : null; }
  if (priority) { r.priority = normalizePriority(priority); r.due_at = computeDueAt(r.created_at, r.priority); }
  if (type && WO_TYPES.includes(type)) r.type = type;
  if (assigneeUserId !== undefined) r.assignee_user_id = assigneeUserId || null;
  if (escalated !== undefined) r.escalated_at = escalated ? (r.escalated_at || nowIso()) : null;
  if (title !== undefined) r.title = title;
  if (description !== undefined) r.description = description;
  save(db); return r;
}
// Message thread rides inline on the stub problem row (the real backend uses the
// work_order_messages table; qcApi hides the difference).
function stubListMessages(problemId) {
  const r = load().problems.find((x) => x.id === problemId);
  return (r?.messages || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}
function stubAddMessage({ problemId, body, authorUserId, authorRole, authorName, translatedBody, fromLang }) {
  const db = load();
  const r = db.problems.find((x) => x.id === problemId);
  if (!r) return null;
  const role = ['client', 'office', 'crew'].includes(authorRole) ? authorRole : 'office';
  const msg = {
    id: rid('wom'), problem_id: problemId, author_user_id: authorUserId || null,
    author_role: role, author_name: authorName || null, body,
    translated_body: translatedBody || null, from_lang: fromLang || null, created_at: nowIso(),
  };
  r.messages = [...(r.messages || []), msg];
  if (role !== 'client' && r.status === 'open') r.status = 'in_progress';
  save(db); return msg;
}

// ── stub: templates + inspections ────────────────────────────────────────────
const KEY_T = 'cleanspace_qc_templates_stub_v1';
const KEY_I = 'cleanspace_qc_inspections_stub_v1';
const loadT = () => { try { return JSON.parse(localStorage.getItem(KEY_T)) || { templates: [] }; } catch { return { templates: [] }; } };
const saveT = (db) => { try { localStorage.setItem(KEY_T, JSON.stringify(db)); } catch { /* quota */ } };
const loadI = () => { try { return JSON.parse(localStorage.getItem(KEY_I)) || { inspections: [] }; } catch { return { inspections: [] }; } };
const saveI = (db) => { try { localStorage.setItem(KEY_I, JSON.stringify(db)); } catch { /* quota */ } };
const stubT = () => loadT();
const stubI = () => loadI();
const latestV = (t) => t.versions[t.versions.length - 1];

function stubCreateTemplate({ name, kind, ratingScale }) {
  const db = loadT();
  const v = { id: rid('iv'), version_number: 1, schema: { areas: [] }, status: 'draft', published_at: null };
  const t = {
    id: rid('it'), name: (name || '').trim() || 'Untitled inspection',
    kind: kind === 'checklist' ? 'checklist' : 'inspection',
    rating_scale: ratingScale || { type: 'passfail', passThreshold: 80 },
    slug: rid('s'), is_published: false, published_version_id: null,
    created_at: nowIso(), updated_at: nowIso(), versions: [v],
  };
  db.templates.unshift(t); saveT(db); return { template: t, version: v };
}
function stubGetTemplate(id) {
  const t = loadT().templates.find((x) => x.id === id);
  if (!t) return null;
  const published = t.versions.find((v) => v.id === t.published_version_id) || null;
  return { template: t, latest: latestV(t), published };
}
function stubSaveTemplate(id, { name, ratingScale, schema }) {
  const db = loadT();
  const t = db.templates.find((x) => x.id === id);
  if (!t) return null;
  let v = latestV(t);
  if (!v || v.status === 'published') {
    v = { id: rid('iv'), version_number: (v?.version_number || 0) + 1, schema: schema || { areas: [] }, status: 'draft', published_at: null };
    t.versions.push(v);
  } else if (schema !== undefined) { v.schema = schema; }
  if (name !== undefined) t.name = name;
  if (ratingScale !== undefined) t.rating_scale = ratingScale;
  t.updated_at = nowIso(); saveT(db); return v;
}
function stubPublishTemplate(id) {
  const db = loadT();
  const t = db.templates.find((x) => x.id === id);
  if (!t) return null;
  const v = latestV(t);
  if (!v) return { nothing: true };
  // The SAME rule the server applies to an item-less checklist. The route answers 400 and
  // `api()` turns that into a throw, so the editor behaves identically in demo mode.
  const refused = publishRefusal({ kind: t.kind, schema: v.schema });
  if (refused) throw new Error(refused);
  v.status = 'published'; v.published_at = nowIso();
  t.is_published = true; t.published_version_id = v.id; t.updated_at = nowIso();
  saveT(db); return { template: t, version: v };
}
function stubDeleteTemplate(id) {
  const db = loadT();
  db.templates = db.templates.filter((x) => x.id !== id);
  saveT(db); return { ok: true };
}
function stubCreateInspection({ templateId, clientId, siteId, jobId, clientName, siteName, inspectorName }) {
  const t = loadT().templates.find((x) => x.id === templateId);
  if (!t) return null;
  const pv = t.versions.find((v) => v.id === t.published_version_id);
  if (!pv) throw new Error('Publish the template before inspecting with it');
  const db = loadI();
  const rec = {
    id: rid('ir'), public_token: rid('tok'), template_id: templateId, template_version_id: pv.id,
    template_snapshot: { name: t.name, kind: t.kind, rating_scale: t.rating_scale, schema: pv.schema },
    client_id: clientId || null, site_id: siteId || null, job_id: jobId || null,
    client_name: clientName || null, site_name: siteName || null, inspector_name: inspectorName || null,
    overall_score: null, result: null, status: 'draft', performed_at: nowIso(), _items: [],
  };
  db.inspections.unshift(rec); saveI(db); return rec;
}
function stubSubmitInspection({ id, items }) {
  const db = loadI();
  const rec = db.inspections.find((x) => x.id === id);
  if (!rec) return null;
  rec._items = (items || []).map((it) => ({ item_key: it.item_key, label: it.label, rating: it.rating != null ? String(it.rating) : null, comment: it.comment || null, photo_count: it.photo_count || 0 }));
  const scale = rec.template_snapshot?.rating_scale || { type: 'passfail', passThreshold: 80 };
  const { overallScore, result } = scoreInspection(items || [], scale);
  rec.overall_score = overallScore; rec.result = result; rec.status = 'submitted';
  saveI(db); return rec;
}
// The server reads' contract over the local records (the demo has no crew boundary): the
// same filters (lib/inspections inspectionMatchesFilters), newest first with ties by id
// as the query orders; the list capped with `truncated` exact.
function stubMatchingInspections(filters) {
  return stubI().inspections.filter((r) => inspectionMatchesFilters(r, filters)).sort(newestInspectionFirst);
}
function stubListInspections(filters) {
  // Mirror the server's list shape: template_name read out of the snapshot (the server
  // selects `template_snapshot->>name` now, not `*`). The demo has no share-token boundary
  // (as it has no crew boundary — one local user), so public_token stays on the row.
  const rows = stubMatchingInspections(filters).map((r) => ({ ...r, template_name: r.template_snapshot?.name ?? null }));
  return { inspections: rows.slice(0, INSPECTION_LIST_LIMIT), truncated: rows.length > INSPECTION_LIST_LIMIT };
}
function stubGetInspection(id) {
  const rec = loadI().inspections.find((x) => x.id === id);
  return rec ? { inspection: rec, items: rec._items || [] } : null;
}
// Shared demo projection: normalize a stub record + its photos into the report shape.
// `extra` carries the internal id/status/publicToken the in-app modal wants (the
// public projection omits them). Mirrors the server projectReport.
async function stubReportFromRec(rec, extra = {}) {
  let photos = [];
  try {
    if (rec.site_id) photos = (await listSiteMedia({ siteId: rec.site_id, refId: rec.id, scope: 'inspection' }))
      .map((p) => ({ id: p.id, kind: p.kind, url: p.url, caption: p.caption, areaId: p.areaId ?? p.area_id ?? null }));
  } catch { /* photos best-effort */ }
  return {
    inspection: {
      ...extra,
      templateName: rec.template_snapshot?.name || 'Inspection',
      schema: rec.template_snapshot?.schema || { areas: [] },
      ratingScale: rec.template_snapshot?.rating_scale || null,
      siteName: rec.site_name, clientName: rec.client_name, inspectorName: rec.inspector_name,
      overallScore: rec.overall_score, result: rec.result, performedAt: rec.performed_at,
    },
    items: (rec._items || []).map((it) => ({ itemKey: it.item_key, label: it.label, rating: it.rating, comment: it.comment })),
    photos,
  };
}
async function stubPublicInspection(token) {
  const rec = loadI().inspections.find((x) => x.public_token === token);
  if (!rec || rec.status === 'draft') return null;
  return stubReportFromRec(rec);
}
async function stubInspectionReport(id) {
  const rec = loadI().inspections.find((x) => x.id === id);
  if (!rec) return null;
  return stubReportFromRec(rec, { id: rec.id, status: rec.status, publicToken: rec.public_token });
}

const KEY_C = QC_CHECKLISTS_STUB_KEY;   // ONE declaration, in data/stubKeys.js
const loadC = () => { try { return JSON.parse(localStorage.getItem(KEY_C)) || { checklists: [] }; } catch { return { checklists: [] }; } };
const saveC = (db) => { try { localStorage.setItem(KEY_C, JSON.stringify(db)); } catch { /* quota */ } };

// The stub stores exactly what the backend row carries — an ACTOR ID, no name (CS-403).
// Storing a name here is what hid the defect from demo mode.
function stubSubmitChecklist({ templateId, clientId, siteId, jobId, items, completedByUserId }) {
  const t = loadT().templates.find((x) => x.id === templateId);
  if (!t) return null;
  const pv = t.versions.find((v) => v.id === t.published_version_id);
  if (!pv) throw new Error('Publish the checklist template first');
  const db = loadC();
  const list = Array.isArray(items) ? items : [];
  const row = {
    id: rid('cr'), template_id: templateId, template_version_id: pv.id,
    template_snapshot: { name: t.name, kind: t.kind, schema: pv.schema },
    client_id: clientId || null, site_id: siteId || null, job_id: jobId || null,
    completed_by_user_id: completedByUserId || null,
    items: list, completed_count: list.filter((i) => i.checked).length, total_count: list.length,
    performed_at: nowIso(),
  };
  db.checklists.unshift(row); saveC(db); return row;
}
