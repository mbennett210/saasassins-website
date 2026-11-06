// Client adapter for QC — inspections, checklists, problem reports. Real backend
// (/api/qc/*) when Supabase is configured; an auto-engaged localStorage stub in
// local/demo mode so the surfaces are exercisable. QC lists are component-local
// projections (useState), never the synced blob. PROBLEM REPORTS land first.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';
import {
  scoreInspection, INSPECTION_LIST_LIMIT, CHECKLIST_LIST_LIMIT, publishRefusal, countSchemaItems,
  inspectionMatchesFilters, newestInspectionFirst, inspectionFigures as figuresOf, toInspectionExportRow,
  templateKind, templateMatchesFilters, templateFilterRefusal, templateKindRefusal,
  createTemplateRefusal, copyTemplateRefusal,
  planTemplateCopy, toTemplateSummaryRow, newestTemplateFirst,
  templateDraftSave, pendingTemplateOf, withPendingTemplate, withoutPendingTemplate, hasUnpublishedChanges,
} from './inspections';
import { countChecklistSubmission, checklistSubmitRefusal, sanitizeChecklistItems } from './checklistCount';
import { areaCompletionTimes, siteAreaStatus } from './checklistAreas';
import { checklistMadeAt, checklistCountsForClean, madeInCleanWindow } from './checklistWindow';
import { _stubEntries as timeStubEntries } from './timeApi';
import { fetchAllPages } from './pagedFetch';
import { buildInspectionReportHtml } from './inspectionReportTemplate';
import { listMedia as listSiteMedia } from './accountMediaApi';
import { addChecklist, allChecklists, removeChecklist, updateChecklist, newChecklistId } from './checklistQueue';
import { isOfflineError } from './netError';
import { QC_CHECKLISTS_STUB_KEY, QC_TEMPLATES_STUB_KEY, QC_INSPECTIONS_STUB_KEY, QC_PROBLEMS_STUB_KEY } from '../data/stubKeys';
import { drainQueue } from './offlineRetry';
import { forgetGateMemo } from './checklistGateMemo';
import { aggregateInspectionsPerSite, aggregateChecklistsPerSite } from './reports/qcReports';
import { resolveReport } from './resolveTime';
import { TEAM, teamClientIds } from './teamScope';
import { INSPECTION_LOOKBACK_DAYS } from './opsAlerts';
import {
  normalizePriority, normalizeStatus, computeDueAt, severityToPriority,
  WO_TYPES, WO_ORIGINS, DEFAULT_WO_TYPE, DEFAULT_WO_ORIGIN, RAISABLE_WO_TYPES,
  normalizeCategory, resolvePhotoRefusal, RESOLVE_PHOTO_MESSAGE, RESOLVE_PHOTO_CODE,
  locationRefusal, LOCATION_CODES, LOCATION_MESSAGES,
  ticketCountsByClient, TICKET_FLAG_DAYS,
  openWorkOrderRows, resolvedWorkOrderPage, workOrderRowsSince, WO_RESOLVED_PAGE,
  ticketAreaInput, AREA_MESSAGES, VISITOR_ORIGIN, withoutVisitorReporter,
} from './workOrders';
import { stubMediaCount, stubMediaAreaIds, stubRemoveMediaForRef } from './accountMediaApi';
import {
  DRAFT_STATUS, DRAFT_CODES, DRAFT_LIST_MAX, DRAFT_RETENTION_SWEEP_MAX,
  sanitizeDraftItems, draftProgress, isStaleDraft, submittedPerformedAt,
} from './inspectionDrafts';
import {
  owesFailedInspectionTicket, failedInspectionTicketInput, failedInspectionCrew,
  siteCrewWindow, siteCleansInWindow,
} from './failedInspectionTicket';
import { sanitizeSchemaTranslations } from './checklistI18n';
import { crewRequestViews, checkCrewRouting, ticketCrewIds, CREW_ROUTING_CODES, CREW_ROUTING_MESSAGES } from './crewRequests';

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
    // The route's own refusal code (e.g. an inspection draft's not-a-draft / not-your-draft), so a
    // screen tells refusals apart by code, never by the API's English words.
    if (typeof json?.code === 'string') err.code = json.code;
    throw err;
  }
  return json;
}

// ── Problem reports ──────────────────────────────────────────────────────────
// clientName/siteName are used only by the stub (the real backend denormalizes
// names server-side and ignores them).
// A person raises a complaint, a request or an issue (WO-19): the stub files a hand-sent
// `failed_inspection` as the default issue, as the server's route does.
export async function createProblem(p) {
  if (BACKEND) return (await api('/qc/problems/create', { method: 'POST', body: p })).problem;
  // CS-697, as the route: a work order is filed at one of the company's locations, its customer
  // the location's — and (QR-16 / QR-23) about one of THAT location's areas, or none.
  const site = stubLocation(p?.siteId);
  const area = ticketAreaInput(p?.siteAreaId, site);
  if (area.refused) {
    const err = new Error(AREA_MESSAGES[area.refused]);
    err.status = 400; err.code = area.refused;
    throw err;
  }
  // A visitor's origin is the public route's alone (QR-26), here as on the server.
  const origin = p?.origin === VISITOR_ORIGIN ? undefined : p?.origin;
  return stubCreateProblem({ ...p, origin, clientId: site.clientId || p?.clientId, type: RAISABLE_WO_TYPES.includes(p?.type) ? p.type : undefined, siteAreaId: area.value });
}
// The public scan page's DEMO (lib/scanCodesApi, behind its static demo gate) files a VISITOR's
// report into the same stub rows the office's lists read — the location, the customer and the area
// already the scanned code's (the demo's twin of api/_lib/scanCodes/visitor fileVisitorReport).
// The page boots no store, so the office's location check (stubLocation, over the running app's
// store) is the caller's: it resolved the code against the demo's saved record first.
export function demoFileVisitorProblem(p) {
  if (BACKEND) throw new Error('The visitor report stub runs in the demo only.');
  return stubCreateProblem({ ...p, origin: VISITOR_ORIGIN });
}
// QR-26, as the route answers a cleaner: a visitor's name and contact are the office's, so the
// demo's lists drop them while the demo is drawn as a cleaner.
function stubForCaller(rows) {
  const book = demoBook();
  const me = (book.users || []).find((u) => u && u.id === book.currentUserId) || null;
  return me && me.role === 'crew' ? rows.map(withoutVisitorReporter) : rows;
}
// The demo's store (its customers and locations), as the route reads the org's book.
function demoBook() {
  try { return (typeof window !== 'undefined' && typeof window.__ppGetState === 'function' && window.__ppGetState()) || {}; } catch { return {}; }
}
// CS-697: the location a demo write may file at, or the route's refusal thrown with its status and code.
function stubLocation(siteId, { clientId = null } = {}) {
  const sites = demoBook().sites || [];
  const refusal = locationRefusal({ siteId, sites, clientId });
  if (refusal) {
    const err = new Error(LOCATION_MESSAGES[refusal]);
    err.status = 400; err.code = refusal;
    throw err;
  }
  return sites.find((s) => s && s.id === siteId);
}
// 🔴 CS-640: the work-order reads are three VIEWS, never the newest N (which dropped the oldest
// open tickets off every list and count past 500 tickets). Each takes the same filters —
// { priority, type, category, clientId, siteIds, supervisorId (a queue: that supervisor's
// buildings) } — and the server's crew scope.
const problemQuery = (filters = {}, extra = {}) => {
  const qs = new URLSearchParams();
  if (filters.priority) qs.set('priority', filters.priority);
  if (filters.type) qs.set('type', filters.type);
  if (filters.category) qs.set('category', filters.category);
  if (filters.clientId) qs.set('clientId', filters.clientId);
  if (filters.siteIds?.length) qs.set('siteIds', filters.siteIds.join(','));
  if (filters.supervisorId) qs.set('supervisorId', filters.supervisorId);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  return `/qc/problems/list${q ? `?${q}` : ''}`;
};
// EVERY open ticket (status ≠ resolved) — a complete read. The queue, Client Requests and every
// open count (Home's tile, the nav pill, "N open · M urgent", the Dashboard) come from this.
export async function listOpenProblems(filters = {}) {
  if (BACKEND) return (await api(problemQuery(filters))).problems || [];
  // Each with its first staff reply, as the route's open view carries it (the first-reply clock).
  return stubForCaller(openWorkOrderRows(stubProblems(filters)).map((r) => ({ ...r, first_reply_at: stubFirstReplyAt(r) })));
}
// ONE page of the resolved history, newest resolved first: { problems, total, last24h, offset,
// limit } — the exact total, so a screen can say how much more there is.
export async function listResolvedProblems({ offset = 0, limit = WO_RESOLVED_PAGE, ...filters } = {}) {
  if (BACKEND) {
    const r = await api(problemQuery(filters, { resolved: 1, offset, limit }));
    return { problems: r.problems || [], total: Number(r.total) || 0, last24h: Number(r.last24h) || 0, offset: r.offset ?? offset, limit: r.limit ?? limit };
  }
  const page = resolvedWorkOrderPage(stubProblems(filters), { offset, limit });
  return { ...page, problems: stubForCaller(page.problems) };
}
// EVERY ticket created at or after `sinceIso`, whatever its status — a complete read.
export async function listProblemsSince({ sinceIso, ...filters } = {}) {
  if (BACKEND) return (await api(problemQuery(filters, { since: sinceIso }))).problems || [];
  return stubForCaller(workOrderRowsSince(stubProblems(filters), sinceIso));
}
export async function updateProblem(p) {
  if (BACKEND) return (await api('/qc/problems/update', { method: 'POST', body: p })).problem;
  return stubUpdateProblem(p);
}

// ── The Cleaner Hub's Client Requests (2026-10-13, brief C §2) ───────────────────────────
// The caller's own requests: { open, recentDone }, each built field by field by lib/crewRequests
// (the route's answer, EP-380, and the demo's are the same rule). A cleaner sends nothing — the
// server reads the login's claim. The owner's View-as (hooks/useCrewPreview) names the person on
// screen (`previewUserId`), which the server honours only for an office login holding
// problems.manage. In the demo the user is switched for real, so the stub reads `userId`.
export async function listMyRequests({ userId = null, previewUserId = null } = {}) {
  if (BACKEND) {
    const q = previewUserId ? `?userId=${encodeURIComponent(previewUserId)}` : '';
    const r = await api(`/qc/problems/mine${q}`);
    return { open: Array.isArray(r?.open) ? r.open : [], recentDone: Array.isArray(r?.recentDone) ? r.recentDone : [] };
  }
  const book = demoBook();
  return crewRequestViews(load().problems, { userId: previewUserId || userId, users: book.users || [], clients: book.clients || [], now: Date.now() });
}

// WO-14: tickets per customer over the flag's window, as a Map(clientId → count). One read for
// the customers list and the customer page, so the flag means the same thing on both.
export async function ticketCounts({ days = TICKET_FLAG_DAYS } = {}) {
  if (BACKEND) {
    const { counts } = await api(`/qc/problems/counts?days=${encodeURIComponent(days)}`);
    return new Map((counts || []).map((c) => [c.clientId, c.count]));
  }
  return ticketCountsByClient(load().problems, { days });
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
// A CHECKLIST belongs to ONE customer (R2, plan step 5); an INSPECTION template stays
// company-wide. Every rule below lives in lib/inspections.js and is applied by BOTH halves
// — this stub and the server (api/qc/[...path].js + _lib/qc/store.js) — so the demo cannot
// behave differently from production.
//   listTemplates({ clientId })        that customer's rows only (never the starters)
//   listTemplates({ starters: true })  only the rows filed under nobody ("Start from…")
//   listTemplates({})                  every row, as before
export async function listTemplates({ kind, clientId, starters } = {}) {
  const badKind = templateKindRefusal(kind);
  if (badKind) throw new Error(badKind);
  const conflict = templateFilterRefusal({ clientId, starters });
  if (conflict) throw new Error(conflict);
  if (BACKEND) {
    const qs = new URLSearchParams();
    if (kind) qs.set('kind', kind);
    if (clientId) qs.set('clientId', clientId);
    if (starters) qs.set('starters', '1');
    const q = qs.toString();
    return (await api(`/qc/templates/list${q ? `?${q}` : ''}`)).templates;
  }
  // CS-669: `has_draft`, as the route answers it — a published template with a draft waiting.
  return stubT().templates.filter((t) => templateMatchesFilters(t, { kind, clientId, starters }))
    .map((t) => ({ ...t, has_draft: hasUnpublishedChanges(t, t.versions[t.versions.length - 1]) }));
}
export async function createTemplate({ name, kind, ratingScale, clientId } = {}) {
  // The same refusal the route answers 400 with — thrown here so the editor shows the same
  // sentence in demo mode as it does against the backend.
  const refused = createTemplateRefusal({ kind, clientId });
  if (refused) throw new Error(refused);
  if (BACKEND) return api('/qc/templates/create', { method: 'POST', body: { name, kind, ratingScale, clientId } });
  return stubCreateTemplate({ name, kind, ratingScale, clientId });
}
// "Start from…": copy a starter, or another customer's checklist, into this customer. The
// source is untouched; version 1 is its PUBLISHED schema (else its latest draft), published
// at once when the source was published and an item-less checklist could never be.
export async function copyTemplate({ id, clientId, name } = {}) {
  if (BACKEND) return api('/qc/templates/copy', { method: 'POST', body: { id, clientId, name } });
  return stubCopyTemplate({ id, clientId, name });
}
// Every CHECKLIST in the org, NARROW — step 6's problems summary across ~750 customers:
// [{ id, name, client_id, is_published, published_version_id, updated_at, item_count }],
// newest edited first. `item_count` is the published version's, null when unpublished.
export async function templatesSummary() {
  if (BACKEND) return (await api('/qc/templates/summary')).templates;
  return stubTemplatesSummary();
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
  stubLocation(p?.siteId);   // CS-697, as the route: an inspection is started at a location
  return stubCreateInspection(p);
}
// `internalNote` (HUB-16) is the inspector's note for the office only. It is stored apart
// from the per-item comments and NEVER enters the report projection, so it reaches no
// client-facing surface; `undefined` leaves an existing note untouched.
export async function submitInspection({ id, items, internalNote }) {
  if (BACKEND) return (await api('/qc/inspections/submit', { method: 'POST', body: { id, items, internalNote } })).inspection;
  return stubSubmitInspection({ id, items, internalNote });
}

// ── An inspection LEFT OPEN AND FINISHED LATER (Matt, 2026-10-06; lib/inspectionDrafts) ──
// `items` are what a draft stores (inspectionDrafts draftItemsFromAnswers: the touched items,
// unticked = no rating yet). A refusal throws with `status` and the server's `code`
// (DRAFT_CODES: 409 not-a-draft, 403 not-your-draft), so the form can say which.
//   saveInspectionDraft  → { id, status, updated_at }
//   getInspectionDraft   → { inspection, items }           (Continue)
//   discardInspectionDraft → { ok, photos }
//   listMyInspectionDrafts({ siteId }) → the caller's own open drafts, newest saved first
// `inspectorUserId` is read by the STUB only (the server takes the caller from the login).
export async function saveInspectionDraft({ id, items, internalNote }) {
  if (BACKEND) return (await api('/qc/inspections/save-draft', { method: 'POST', body: { id, items, internalNote } })).inspection;
  return stubSaveDraft({ id, items, internalNote });
}
export async function getInspectionDraft(id) {
  if (BACKEND) return api(`/qc/inspections/draft?id=${encodeURIComponent(id)}`);
  return stubGetDraft(id);
}
export async function discardInspectionDraft(id) {
  if (BACKEND) return api('/qc/inspections/discard', { method: 'POST', body: { id } });
  return stubDiscardDraft(id);
}
export async function listMyInspectionDrafts({ siteId = null, inspectorUserId = null } = {}) {
  if (BACKEND) return (await api(`/qc/inspections/drafts${siteId ? `?siteId=${encodeURIComponent(siteId)}` : ''}`)).drafts || [];
  return stubMyDrafts({ siteId, inspectorUserId });
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
// Reports › Time to resolve (Matt's KPI, the Oct 6 call; plan 2026-10-11 §4): every ticket
// resolved in the period, tallied by the ONE rule (lib/resolveTime resolveReport) — on the server
// over a complete read, by the same function over the stub here. Manager (`supervisorId`) and
// Customer (`clientId`) narrow the tickets themselves, so the median and the deadline tally are
// over exactly those: { fromIso, toIso, overall, byType[], byClient[] }.
export async function resolveTimes({ fromIso, toIso, clientId = null, supervisorId = null } = {}) {
  if (BACKEND) {
    const qs = new URLSearchParams({ fromIso, toIso });
    if (clientId) qs.set('clientId', clientId);
    if (supervisorId) qs.set('supervisorId', supervisorId);
    return api(`/qc/reports/resolve-time?${qs.toString()}`);
  }
  return { fromIso, toIso, ...resolveReport(stubProblems({ clientId, supervisorId }), { from: fromIso, to: toIso }) };
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
// CS-690: a buffered checklist carries `filledAt`, when Submit was pressed, because the server
// decides which clean a fill counts for by WHEN it was filled (lib/checklistWindow) and a
// replay arrives later; the server never lets that time land later than the replay itself.
export async function submitChecklist(p) {
  if (!BACKEND) return stubSubmitChecklist(p);
  const pressedAt = new Date().toISOString();
  const clientSubmitId = p.clientSubmitId || newChecklistId();
  const body = { ...p, clientSubmitId };
  try {
    return (await api('/qc/checklists/submit', { method: 'POST', body })).checklist;
  } catch (e) {
    if (!isOfflineError(e)) throw e; // a real rejection (403/404/400) — surface it
    await addChecklist({ id: clientSubmitId, payload: { ...body, filledAt: pressedAt }, createdAt: new Date().toISOString() });
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
// Newest-CHECKLIST_LIST_LIMIT list, or — with { fromIso, toIso } — the COMPLETE window read
// (the checklist-reminder walker). Unlike listInspections above, where a date range is only a
// filter on the newest-200 list. The demo stub caps where the server does.
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
  if (fromIso || toIso) return rows.filter((c) => inWindow(c.performed_at, fromIso, toIso)).sort(newestChecklistFirst);
  return rows.sort(newestChecklistFirst).slice(0, CHECKLIST_LIST_LIMIT);
}

// The Quality hub's Checklists tab (CS-335): the newest CHECKLIST_LIST_LIMIT submissions with
// how many there are in all — { checklists, total, truncated } — so the tab says "Showing the
// newest N of M", as the Inspections tab does (CS-322). The demo stub caps and counts at the
// same row as the server.
export async function listChecklistsNewest() {
  if (BACKEND) {
    const r = await api('/qc/checklists/list');
    const checklists = r.checklists || [];
    return { checklists, total: Number.isFinite(r.total) ? r.total : checklists.length, truncated: !!r.truncated };
  }
  const rows = loadC().checklists.slice().sort(newestChecklistFirst);
  return { checklists: rows.slice(0, CHECKLIST_LIST_LIMIT), total: rows.length, truncated: rows.length > CHECKLIST_LIST_LIMIT };
}
// The server's order: (performed_at, id) newest first.
function newestChecklistFirst(a, b) {
  const ai = String(a.id || '');
  const bi = String(b.id || '');
  return (new Date(b.performed_at) - new Date(a.performed_at)) || (bi > ai ? 1 : bi < ai ? -1 : 0);
}

// QR-1 / HUB-15 — a building's AREAS, each with its last clean, what was done in it and
// its newest photo. Real mode reads EP-200 (`GET /api/qc/areas/status`), which runs the
// shared `siteAreaStatus` rule server-side over that site's recent checklists; the demo
// runs the SAME function over the local stub rows. `cleaningAreas` is the caller's own
// copy of `site.cleaningAreas` and is used by the DEMO only — the server reads the blob
// itself, because a caller-supplied area list would be a caller-supplied answer.
//
// → { siteId, siteName, clientId, areas: [...] } (src/lib/checklistAreas for the row shape).
export async function areaStatus({ siteId, cleaningAreas = [] } = {}) {
  if (!siteId) return { siteId: null, siteName: null, clientId: null, areas: [] };
  if (BACKEND) return api(`/qc/areas/status?siteId=${encodeURIComponent(siteId)}`);
  const results = loadC().checklists.filter((c) => c && c.site_id === siteId);
  const media = [];
  for (const r of results) {
    if (!r.client_submit_id) continue;
    try {
      const rows = await listSiteMedia({ siteId, refId: r.client_submit_id, scope: 'checklist' });
      for (const m of rows) media.push({ ...m, ref_id: r.client_submit_id, area_id: m.areaId ?? m.area_id ?? null });
    } catch { /* photos best-effort, exactly as the server treats them */ }
  }
  return {
    siteId,
    siteName: null,
    clientId: results[0]?.client_id ?? null,
    areas: siteAreaStatus({ cleaningAreas, results, media }),
  };
}

// Public shareable inspection report (no auth — token is the capability).
export async function getPublicInspection(token) {
  if (BACKEND) return api(`/public/qc/inspection?token=${encodeURIComponent(token)}`);
  return stubPublicInspection(token);
}

// ── stub store (demo / local-only) ───────────────────────────────────────────
const KEY = QC_PROBLEMS_STUB_KEY;      // ONE declaration, in data/stubKeys.js
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { problems: [] }; } catch { return { problems: [] }; } };
const save = (db) => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* quota */ } };

// `id` / `raisedByClientUserId` / `raisedByClientName` are the client hub's (its demo creates
// a ticket through this same stub, as the server's hub route goes through createProblem): a
// caller-minted id, and WHICH customer contact raised it (HUB-13). `inspectionId` /
// `crewUserIds` are a failed inspection's ticket's (WO-19, stubFailedInspectionTicket below).
// `siteAreaId` (QR-16 / QR-23) is the area the ticket is about, already checked by the caller; a
// VISITOR's `reporterName` / `reporterContact` ride on a visitor's ticket only (the migration's CHECK).
function stubCreateProblem({ id, clientId, siteId, jobId, title, description, priority, severity, type, origin, category, assigneeUserId, reportedByUserId, clientName, siteName, raisedByClientUserId = null, raisedByClientName = null, inspectionId = null, crewUserIds = null, siteAreaId = null, reporterName = null, reporterContact = null }) {
  const db = load();
  const prio = normalizePriority(priority || severityToPriority(severity));
  const created_at = nowIso();
  const row = {
    id: id || rid('pr'), client_id: clientId || null, site_id: siteId || null, job_id: jobId || null,
    raised_by_client_user_id: raisedByClientUserId || null, raised_by_client_name: raisedByClientName || null,
    inspection_id: inspectionId || null, crew_user_ids: Array.isArray(crewUserIds) ? crewUserIds.filter(Boolean) : [],
    client_name: clientName || null, site_name: siteName || null,
    reported_by_user_id: reportedByUserId || null, assignee_user_id: assigneeUserId || null,
    title, description: description || null,
    type: WO_TYPES.includes(type) ? type : DEFAULT_WO_TYPE,
    origin: WO_ORIGINS.includes(origin) ? origin : DEFAULT_WO_ORIGIN,
    site_area_id: siteAreaId || null,
    ...(origin === VISITOR_ORIGIN ? { reporter_name: reporterName || null, reporter_contact: reporterContact || null } : {}),
    category: normalizeCategory(category),   // WO-12; null = uncategorized
    priority: prio,
    status: 'open', photo_paths: [],
    due_at: computeDueAt(created_at, { type: WO_TYPES.includes(type) ? type : DEFAULT_WO_TYPE, priority: prio }), escalated_at: null,
    created_at, resolved_at: null,
  };
  db.problems.push(row); save(db); return row;
}
// The demo's tickets under the route's filters; the view (open / resolved page / since) is then
// lib/workOrders' own rule, as the server's three reads are. A queue (`supervisorId`) is that
// supervisor's buildings, read from the demo store, as the route reads the customers; `team`
// (S131) is the CALLER's team, as the route resolves it from the claim — the demo's signed-in
// teammate stands in for the claim (a manager's team; nobody else's).
function stubProblems({ priority, type, category, clientId, siteIds, supervisorId } = {}) {
  let rows = load().problems;
  if (priority) rows = rows.filter((r) => normalizePriority(r.priority || severityToPriority(r.severity)) === priority);
  if (type) rows = rows.filter((r) => r.type === type);
  if (category) rows = rows.filter((r) => r.category === category);   // WO-12
  if (clientId) rows = rows.filter((r) => r.client_id === clientId);
  if (siteIds?.length) rows = rows.filter((r) => siteIds.includes(r.site_id));
  if (supervisorId) {
    let st = null;
    try { st = (typeof window !== 'undefined' && typeof window.__ppGetState === 'function' && window.__ppGetState()) || null; } catch { st = null; }
    const clients = st?.clients || [];
    let mine;
    if (supervisorId === TEAM) {
      const users = st?.users || [];
      const me = users.find((u) => u && u.id === st?.currentUserId) || null;
      mine = teamClientIds(users, clients, me && me.role === 'manager' ? me.id : null);
    } else {
      mine = new Set(clients.filter((c) => c && c.supervisorId === supervisorId).map((c) => c.id));
    }
    rows = rows.filter((r) => mine.has(r.client_id));
  }
  return rows;
}
function stubUpdateProblem({ id, status, priority, type, category, title, description, assigneeUserId, escalated, siteId, crewUserIds }) {
  const db = load();
  const r = db.problems.find((x) => x.id === id);
  if (!r) return null;
  // The Cleaner Hub (brief C §1), the route's rule: the office alone chooses a ticket's cleaners,
  // active ones, de-duplicated and bounded (lib/crewRequests). The demo's actor is the user it is
  // drawn as; the demo rings nobody (it has no bell fan-out for tickets).
  let routedIds = null;
  if (crewUserIds !== undefined) {
    const book = demoBook();
    const actor = (book.users || []).find((u) => u && u.id === book.currentUserId) || null;
    const check = checkCrewRouting({ actorRole: actor?.role || 'owner', crewUserIds, users: book.users || [], current: ticketCrewIds(r) });
    if (!check.ok) {
      const err = new Error(CREW_ROUTING_MESSAGES[check.code]);
      err.status = check.code === CREW_ROUTING_CODES.officeOnly ? 403 : 400; err.code = check.code;
      throw err;
    }
    routedIds = check.ids;
  }
  // CS-697, the route's rule (the demo has one local user, so no office-only check): a ticket with
  // no location takes one, of its own customer's when it has one, once — it never moves after.
  if (siteId !== undefined) {
    if (r.site_id && r.site_id !== siteId) {
      const err = new Error(LOCATION_MESSAGES[LOCATION_CODES.set]);
      err.status = 409; err.code = LOCATION_CODES.set;
      throw err;
    }
    const site = stubLocation(siteId, { clientId: r.client_id || null });
    const client = (demoBook().clients || []).find((c) => c && c.id === site.clientId) || null;
    Object.assign(r, { site_id: site.id, client_id: site.clientId || null, site_name: site.name || null, client_name: client?.name || null });
  }
  // WO-10, the demo twin: resolving needs a completion photo on THIS ticket (an account_media
  // row at scope `problem_report` with its id), and nothing else is ever refused for it.
  const photoRefusal = resolvePhotoRefusal({ status, photoCount: stubMediaCount({ scope: 'problem_report', refId: id }) });
  if (photoRefusal) {
    const err = new Error(RESOLVE_PHOTO_MESSAGE);
    err.status = 409; err.code = RESOLVE_PHOTO_CODE;
    throw err;
  }
  // Resolved ONCE, as the server's updateProblem: a resolve for a ticket already resolved keeps its
  // first resolved_at (its time to resolve and its reopen window); any other status clears it.
  if (status) {
    const s = normalizeStatus(status);
    if (s !== 'resolved') r.resolved_at = null;
    else if (normalizeStatus(r.status) !== 'resolved') r.resolved_at = nowIso();
    r.status = s;
  }
  if (priority) r.priority = normalizePriority(priority);
  if (type && RAISABLE_WO_TYPES.includes(type)) r.type = type;   // WO-19: never retyped INTO a failed inspection
  // WO-20 / WO-21: a new type or urgency moves the deadline, by lib/workOrders' one rule.
  if (priority || type) r.due_at = computeDueAt(r.created_at, { type: r.type, priority: r.priority });
  if (category !== undefined) r.category = normalizeCategory(category);   // WO-12
  if (assigneeUserId !== undefined) r.assignee_user_id = assigneeUserId || null;
  if (escalated !== undefined) r.escalated_at = escalated ? (r.escalated_at || nowIso()) : null;
  if (title !== undefined) r.title = title;
  if (description !== undefined) r.description = description;
  if (routedIds) r.crew_user_ids = routedIds;
  save(db); return r;
}
// Message thread rides inline on the stub problem row (the real backend uses the
// work_order_messages table; qcApi hides the difference).
// The ticket's first staff reply in the demo's inline thread: the first line not the client's and
// not an internal note (the route's firstStaffReplyByProblem rule, WO-2 / WO-9).
function stubFirstReplyAt(r) {
  const replies = (r?.messages || []).filter((m) => m && m.author_role !== 'client' && m.internal !== true)
    .map((m) => m.created_at).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return replies[0] || null;
}
function stubListMessages(problemId) {
  const r = load().problems.find((x) => x.id === problemId);
  return (r?.messages || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}
// The server's rules (api/_lib/qc/store.addWorkOrderMessage), so the demo cannot differ: an
// INTERNAL note (WO-9) is staff-only and moves nothing; a staff reply moves an open ticket to
// in progress; a CLIENT's message on a ticket waiting on them puts it back to in progress.
function stubAddMessage({ id, problemId, body, authorUserId, authorRole, authorName, translatedBody, fromLang, internal = false, authorClientUserId = null }) {
  const db = load();
  const r = db.problems.find((x) => x.id === problemId);
  if (!r) return null;
  const role = ['client', 'office', 'crew'].includes(authorRole) ? authorRole : 'office';
  const isInternal = internal === true && role !== 'client';
  const msg = {
    id: id || rid('wom'), problem_id: problemId, author_user_id: role === 'client' ? null : (authorUserId || null),
    author_role: role, author_name: authorName || null, body,
    translated_body: translatedBody || null, from_lang: fromLang || null, created_at: nowIso(),
    internal: isInternal,
    author_client_user_id: role === 'client' ? (authorClientUserId || null) : null,
  };
  r.messages = [...(r.messages || []), msg];
  if (role === 'client') { if (r.status === 'awaiting_client') r.status = 'in_progress'; }
  else if (!isInternal && r.status === 'open') r.status = 'in_progress';
  save(db); return msg;
}

// ── stub: templates + inspections ────────────────────────────────────────────
const KEY_T = QC_TEMPLATES_STUB_KEY;    // ONE declaration, in data/stubKeys.js
const KEY_I = QC_INSPECTIONS_STUB_KEY;  // ONE declaration, in data/stubKeys.js
const loadT = () => { try { return JSON.parse(localStorage.getItem(KEY_T)) || { templates: [] }; } catch { return { templates: [] }; } };
const saveT = (db) => { try { localStorage.setItem(KEY_T, JSON.stringify(db)); } catch { /* quota */ } };
const loadI = () => { try { return JSON.parse(localStorage.getItem(KEY_I)) || { inspections: [] }; } catch { return { inspections: [] }; } };
const saveI = (db) => { try { localStorage.setItem(KEY_I, JSON.stringify(db)); } catch { /* quota */ } };
const stubT = () => loadT();
const stubI = () => loadI();
const latestV = (t) => t.versions[t.versions.length - 1];

// The stub stores exactly what the backend row carries, `client_id` included — the customer
// a CHECKLIST is filed under, null for a starter (R2). Storing a shape the backend does not
// have is what hid CS-403 from demo mode, and the same trap applies here.
//
// ONE DIFFERENCE FROM THE SERVER, deliberately: the route also checks that `clientId` NAMES
// a customer in `org_state.clients` (a mistyped id would file a checklist under a customer
// that does not exist). The stub has no blob to check against — the demo's customers live in
// the app store, which this adapter does not hold — so it enforces the rule that a checklist
// must HAVE a customer and leaves existence to the caller. The pickers only ever pass a real
// customer's id.
function stubCreateTemplate({ name, kind, ratingScale, clientId }) {
  const db = loadT();
  const k = templateKind(kind);
  const v = { id: rid('iv'), version_number: 1, schema: { areas: [] }, status: 'draft', published_at: null };
  const t = {
    id: rid('it'), name: (name || '').trim() || 'Untitled inspection',
    kind: k,
    client_id: k === 'checklist' ? (clientId || null) : null,
    rating_scale: ratingScale || { type: 'passfail', passThreshold: 80 },
    slug: rid('s'), is_published: false, published_version_id: null, item_count: null,
    created_at: nowIso(), updated_at: nowIso(), versions: [v],
  };
  db.templates.unshift(t); saveT(db); return { template: t, version: v };
}
// The stub twin of store.copyTemplate: the same refusals, the same choice of version 1, and
// the same auto-publish rule — all from lib/inspections, so neither side can drift.
function stubCopyTemplate({ id, clientId, name }) {
  const db = loadT();
  const src = db.templates.find((x) => x.id === id);
  if (!src) throw new Error('Template not found');
  const refused = copyTemplateRefusal({ kind: src.kind, clientId });
  if (refused) throw new Error(refused);
  const publishedV = src.versions.find((x) => x.id === src.published_version_id) || null;
  const { schema, publish } = planTemplateCopy({
    kind: 'checklist',
    publishedSchema: publishedV?.schema ?? null,
    latestSchema: publishedV ? null : (latestV(src)?.schema ? withoutPendingTemplate(latestV(src).schema) : null),
    sourcePublished: !!(src.is_published && publishedV),
  });
  const v = {
    id: rid('iv'), version_number: 1, schema,
    status: publish ? 'published' : 'draft', published_at: publish ? nowIso() : null,
  };
  const t = {
    id: rid('it'), name: (name || '').trim() || src.name, kind: 'checklist', client_id: clientId,
    rating_scale: src.rating_scale || { type: 'passfail', passThreshold: 80 },
    slug: rid('s'), is_published: publish, published_version_id: publish ? v.id : null,
    item_count: publish ? countSchemaItems(schema) : null,
    name_i18n: schema?.nameI18n ?? null,   // the copied version's name lines, as the server does (CS-850)
    created_at: nowIso(), updated_at: nowIso(), versions: [v],
  };
  db.templates.unshift(t); saveT(db); return { template: t, version: v };
}
// The same narrow read the server does: `item_count` comes off the row, never from a
// version's schema (F4 — that was ~39 MB of jsonb on the real backend).
function stubTemplatesSummary() {
  return loadT().templates
    .filter((t) => t.kind === 'checklist')
    .slice()
    .sort(newestTemplateFirst)
    .map((t) => toTemplateSummaryRow(t, t.item_count));
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
  // CS-669, the server's rule: on a PUBLISHED template the name and pass mark wait in the draft.
  const plan = templateDraftSave({ isPublished: !!t.is_published, name, ratingScale, previous: pendingTemplateOf(v) });
  // CS-850: the same cleaning the server's save applies (src/lib/checklistI18n), the name's lines
  // included. The demo has no server and so no translation: lines the office has not typed stay
  // English here.
  if (schema) schema = sanitizeSchemaTranslations(v?.schema, schema, { name: (plan.pending?.name ?? plan.rowPatch.name ?? t.name ?? '').trim() });
  if (!v || v.status === 'published') {
    v = { id: rid('iv'), version_number: (v?.version_number || 0) + 1, schema: withPendingTemplate(schema || withoutPendingTemplate(v?.schema), plan.pending), status: 'draft', published_at: null };
    t.versions.push(v);
  } else { v.schema = withPendingTemplate(schema !== undefined ? schema : v.schema, plan.pending); }
  if (plan.rowPatch.name !== undefined) t.name = plan.rowPatch.name;
  if (plan.rowPatch.rating_scale !== undefined) t.rating_scale = plan.rowPatch.rating_scale;
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
  // CS-669: the draft's own name and pass mark go live now; the frozen version keeps the schema only.
  const pending = pendingTemplateOf(v);
  if (pending && pending.name !== undefined) t.name = pending.name;
  if (pending && pending.ratingScale !== undefined) t.rating_scale = pending.ratingScale;
  v.schema = withoutPendingTemplate(v.schema);
  v.status = 'published'; v.published_at = nowIso();
  t.is_published = true; t.published_version_id = v.id; t.updated_at = nowIso();
  // Denormalized where the published schema is decided, exactly as the server does, so the
  // summary never reads a schema to count items — and the lists name it in the reader's language.
  t.item_count = countSchemaItems(v.schema);
  t.name_i18n = v.schema?.nameI18n ?? null;
  saveT(db); return { template: t, version: v };
}
function stubDeleteTemplate(id) {
  const db = loadT();
  db.templates = db.templates.filter((x) => x.id !== id);
  saveT(db); return { ok: true };
}
function stubCreateInspection({ templateId, clientId, siteId, jobId, clientName, siteName, inspectorName, inspectorUserId = null }) {
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
    inspector_user_id: inspectorUserId || null,
    // performed_at is the start until the first Submit dates it (CS-699); created_at keeps the start.
    overall_score: null, result: null, status: DRAFT_STATUS, performed_at: nowIso(), created_at: nowIso(), updated_at: nowIso(), _items: [],
  };
  db.inspections.unshift(rec); saveI(db);
  stubPruneStaleDrafts();   // D9, at the same write point as the server's
  return rec;
}

// ── An inspection left open and finished later — the demo twins of the server's draft writes,
// over the same pure rules (lib/inspectionDrafts). The demo has one local user and no
// permission boundary (as everywhere in this stub), so WHO is the screen's to show; every other
// refusal is the server's, thrown with its status and code.
function stubDraftRefusal(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code;
  return e;
}
function stubOpenDraft(db, id) {
  const rec = db.inspections.find((x) => x.id === id);
  if (!rec) throw stubDraftRefusal(404, 'not-found', 'Inspection not found');
  if (rec.status !== DRAFT_STATUS) throw stubDraftRefusal(409, DRAFT_CODES.notADraft, 'This inspection is no longer open: it was submitted or discarded.');
  return rec;
}
function stubSaveDraft({ id, items, internalNote }) {
  const db = loadI();
  const rec = stubOpenDraft(db, id);
  rec._items = sanitizeDraftItems(rec.template_snapshot, items).map((it) => ({
    item_key: it.item_key, label: it.label, rating: it.rating != null ? String(it.rating) : null, comment: it.comment || null, photo_count: 0,
  }));
  if (internalNote !== undefined) {
    const s = typeof internalNote === 'string' ? internalNote.trim() : '';
    rec.internal_note = s || null;
  }
  rec.updated_at = nowIso();
  saveI(db);
  return { id: rec.id, status: rec.status, updated_at: rec.updated_at };
}
function stubGetDraft(id) {
  const rec = stubOpenDraft(loadI(), id);
  return { inspection: rec, items: rec._items || [] };
}
function stubDiscardDraft(id) {
  const db = loadI();
  stubOpenDraft(db, id);
  db.inspections = db.inspections.filter((x) => x.id !== id);
  saveI(db);
  return { ok: true, photos: stubRemoveMediaForRef({ scope: 'inspection', refId: id }) };
}
const savedMs = (r) => { const t = Date.parse(r.updated_at || r.performed_at || ''); return Number.isFinite(t) ? t : -Infinity; };
function stubMyDrafts({ siteId, inspectorUserId }) {
  if (!inspectorUserId) return [];
  return loadI().inspections
    .filter((r) => r && r.status === DRAFT_STATUS && r.inspector_user_id === inspectorUserId && (!siteId || r.site_id === siteId))
    .sort((a, b) => savedMs(b) - savedMs(a))
    .slice(0, DRAFT_LIST_MAX)
    .map((r) => ({
      id: r.id, client_id: r.client_id ?? null, site_id: r.site_id ?? null, client_name: r.client_name ?? null, site_name: r.site_name ?? null,
      template_id: r.template_id ?? null, template_name: r.template_snapshot?.name ?? null, status: r.status,
      inspector_user_id: r.inspector_user_id ?? null, performed_at: r.performed_at ?? null, updated_at: r.updated_at ?? r.performed_at ?? null,
    }));
}
function stubPruneStaleDrafts(now = Date.now()) {
  const db = loadI();
  const stale = db.inspections.filter((r) => isStaleDraft(r, now)).sort((a, b) => savedMs(a) - savedMs(b)).slice(0, DRAFT_RETENTION_SWEEP_MAX);
  if (!stale.length) return 0;
  const ids = new Set(stale.map((r) => r.id));
  db.inspections = db.inspections.filter((r) => !ids.has(r.id));
  saveI(db);
  for (const id of ids) stubRemoveMediaForRef({ scope: 'inspection', refId: id });
  return ids.size;
}
function stubSubmitInspection({ id, items, internalNote }) {
  const db = loadI();
  const rec = db.inspections.find((x) => x.id === id);
  if (!rec) return null;
  rec._items = (items || []).map((it) => ({ item_key: it.item_key, label: it.label, rating: it.rating != null ? String(it.rating) : null, comment: it.comment || null, photo_count: it.photo_count || 0 }));
  const scale = rec.template_snapshot?.rating_scale || { type: 'passfail', passThreshold: 80 };
  const { overallScore, result } = scoreInspection(items || [], scale);
  // CS-699, as the server: dated when first submitted, an edit keeps its date.
  rec.performed_at = submittedPerformedAt(rec, nowIso());
  rec.overall_score = overallScore; rec.result = result; rec.status = 'submitted'; rec.updated_at = nowIso();
  // HUB-16, stored exactly as the backend column is — on the RECORD, never in `_items`
  // and never in the report projection below, so the demo cannot show a client something
  // production keeps internal.
  if (internalNote !== undefined) {
    const s = typeof internalNote === 'string' ? internalNote.trim() : '';
    rec.internal_note = s || null;
  }
  saveI(db);
  stubFailedInspectionTicket(rec, items || []);   // WO-19, after the record is saved, as the server
  return rec;
}
// WO-19, the demo twin of api/_lib/qc/store.openFailedInspectionTicket: the same rules
// (lib/failedInspectionTicket) over the demo's own store — the customer's supervisor, the
// inspected visit's crew else the building's cleans that week — and one ticket per inspection.
// The demo has no bell fan-out for it, as it has none for the inspection itself.
function stubFailedInspectionTicket(rec, items) {
  if (!owesFailedInspectionTicket(rec)) return null;
  const existing = load().problems.find((p) => p.inspection_id === rec.id);
  if (existing) return existing;
  let state = null;
  try { state = (typeof window !== 'undefined' && typeof window.__ppGetState === 'function') ? window.__ppGetState() : null; } catch { state = null; }
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const visit = rec.job_id ? jobs.find((j) => j && j.id === rec.job_id) || null : null;
  const span = siteCrewWindow(rec.performed_at);
  const siteJobs = span ? siteCleansInWindow(jobs, { siteId: rec.site_id || null, ...span }) : [];
  const crewUserIds = failedInspectionCrew({ visit, siteJobs, users: state?.users || [], inspectorUserId: rec.inspector_user_id || null });
  return stubCreateProblem(failedInspectionTicketInput({ rec, items, state: state || {}, crewUserIds }));
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
  // A DRAFT row carries how far it got, as the server's list does (lib/inspectionDrafts draftProgress).
  const rows = stubMatchingInspections(filters).map((r) => {
    const row = { ...r, template_name: r.template_snapshot?.name ?? null };
    if (r.status !== DRAFT_STATUS) return row;
    const p = draftProgress(r.template_snapshot, r._items || []);
    return { ...row, draft_answered: p.answered, draft_total: p.total };
  });
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
  const report = await stubReportFromRec(rec, { id: rec.id, status: rec.status, publicToken: rec.public_token });
  // HUB-16 — BESIDE the report, exactly as the authed route returns it, and absent from
  // `stubPublicInspection` above (the demo's /inspect page), which is the demo twin of the
  // real boundary. The demo has one local user and no permission boundary, as everywhere
  // else in this stub.
  return { ...report, internalNote: rec.internal_note || null };
}

const KEY_C = QC_CHECKLISTS_STUB_KEY;   // ONE declaration, in data/stubKeys.js
const loadC = () => { try { return JSON.parse(localStorage.getItem(KEY_C)) || { checklists: [] }; } catch { return { checklists: [] }; } };
const saveC = (db) => { try { localStorage.setItem(KEY_C, JSON.stringify(db)); } catch { /* quota */ } };

// CS-690, the demo twin of the server's placeChecklist (api/_lib/qc/store.js): which clean a
// fill counts for, if any, and whether it may stamp areas — the SAME rule
// (lib/checklistWindow) over the demo's own store and its time stub. With no store to read (a
// built bundle has no dev hook) it places the fill as asked, as the demo always did.
function stubPlaceChecklist({ jobId, siteId, userId, madeAt }) {
  let s = null;
  try { s = (typeof window !== 'undefined' && typeof window.__ppGetState === 'function') ? window.__ppGetState() : null; } catch { s = null; }
  if (!s) return { jobId: jobId || null, stampAreas: true };
  const graceMins = s.opsSettings?.autoCloseGraceMins;
  const onClock = (match) => (timeStubEntries() || []).some((e) => e.user_id === userId && !e.clock_out_at && match(e));
  if (jobId) {
    const job = (s.jobs || []).find((j) => j.id === jobId) || null;
    if (!job) return { jobId, stampAreas: false };
    return checklistCountsForClean({ job, madeAt, graceMins, onClock: onClock((e) => e.job_id === jobId) })
      ? { jobId, stampAreas: true } : { jobId: null, stampAreas: false };
  }
  const me = (s.users || []).find((u) => u.id === userId);
  if (!me || me.role !== 'crew' || !siteId) return { jobId: null, stampAreas: true };
  if (onClock((e) => e.site_id === siteId)) return { jobId: null, stampAreas: true };
  return { jobId: null, stampAreas: (s.jobs || []).some((j) => j.siteId === siteId && (j.crewIds || []).includes(userId) && madeInCleanWindow(j, madeAt, { graceMins })) };
}

// The stub stores exactly what the backend row carries — an ACTOR ID, no name (CS-403).
// Storing a name here is what hid the defect from demo mode.
function stubSubmitChecklist({ templateId, clientId, siteId, jobId, items, completedByUserId, clientSubmitId = null, filledAt = null }) {
  const t = loadT().templates.find((x) => x.id === templateId);
  if (!t) return null;
  // The SAME rule the server applies to a template that is not a checklist. The route
  // answers 400 and `api()` turns that into a throw, so the demo behaves identically and
  // can never accept a submission the backend would refuse (CS-494 review F-B).
  const notChecklist = checklistSubmitRefusal(t.kind);
  if (notChecklist) throw new Error(notChecklist);
  const pv = t.versions.find((v) => v.id === t.published_version_id);
  if (!pv) throw new Error('Publish the checklist template first');
  const db = loadC();
  // The demo twin of the server's idempotent replay: the same caller-minted id answers the
  // row already stored, never a second one (a double tap on Save, a replayed queue item).
  if (clientSubmitId) {
    const existing = db.checklists.find((c) => c && c.client_submit_id === clientSubmitId);
    if (existing) return existing;
  }
  // Stored and counted through the server's sanitizer (a "not completed" task's flag and
  // reason, the comment's cap), so the demo can never keep what the server would repair.
  const list = sanitizeChecklistItems(items);
  // CS-547: the demo twin of `store.checklistPhotoKeys` — which items actually carry a
  // photo, read from the stub media store by the submission id, never from the payload.
  // Storing a shape the backend does not have is what hid CS-403 from demo mode.
  const photoKeys = stubMediaAreaIds({ scope: 'checklist', refId: clientSubmitId });
  const performedAt = nowIso();
  const placed = stubPlaceChecklist({ jobId, siteId, userId: completedByUserId || null, madeAt: checklistMadeAt(filledAt, Date.parse(performedAt)) });
  const row = {
    id: rid('cr'), template_id: templateId, template_version_id: pv.id,
    template_snapshot: { name: t.name, kind: t.kind, schema: pv.schema },
    client_id: clientId || null, site_id: siteId || null, job_id: placed.jobId,
    completed_by_user_id: completedByUserId || null,
    // Counted against the CURRENT PUBLISHED SCHEMA, exactly as the server does (CS-494,
    // lib/checklistCount) — never against the caller's own list.
    items: list, ...countChecklistSubmission(pv.schema, list, { photoKeys }),
    // QR-1, exactly as the server derives it — and only for a fill that counts (CS-690).
    area_completions: placed.stampAreas ? areaCompletionTimes(pv.schema, list, { performedAt, photoKeys }) : {},
    client_submit_id: clientSubmitId || null,
    performed_at: performedAt,
  };
  db.checklists.unshift(row); saveC(db); return row;
}
