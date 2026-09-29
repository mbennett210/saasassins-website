// QC API (Swept replacement — inspections, checklists, problem reports). Records
// are relational + photo-bearing (photos via /api/account-media, scope 'inspection'
// |'problem_report'). Every action re-checks authority server-side. PROBLEM REPORTS
// land first; inspections + checklists follow. See CLEANSPACE_SWEPT.md §5.6 / §2.4.
//
//   POST /api/qc/problems/create  { clientId, siteId, jobId?, title, description?, type?, origin?, priority?, assigneeUserId? }
//   GET  /api/qc/problems/list    [?status&priority&type&clientId&siteIds=a,b]
//   POST /api/qc/problems/update  { id, status?, priority?, type?, assigneeUserId?, escalated?, title?, description? }
//   GET  /api/qc/inspections/list    [?clientId&siteIds&inspectorIds&results&fromIso&toIso]  (newest 200 matching + truncated)
//   GET  /api/qc/inspections/figures [same filters]  -> the hub's stat cards over EVERY match (qc.view)
//   GET  /api/qc/inspections/export  [same filters]&offset&limit -> one page of EVERY match, the CSV's columns (qc.view + qc.share)
//   GET  /api/qc/checklists/list  [?siteId&jobId]          (newest 200)
//                                 [&fromIso&toIso → every record in the window; not crew]
//   GET  /api/qc/inspections/latest-by-client  -> newest submitted inspection per active customer (qc.view)
//   GET  /api/qc/reports/inspections-by-site ?fromIso&toIso[&result&clientId]  (reports.view + qc.view)
//   GET  /api/qc/reports/checklists-by-site  ?fromIso&toIso[&clientId]          (reports.view + qc.view)
import { requirePermission, holdsPermission, crewAssignedScope } from '../_lib/authz.js';
import { assignmentsInitialized, getAssignedScope } from '../_lib/crewAssignments.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { getCrewJobs } from '../_lib/jobsTable.js';
import { readOrgState } from '../_lib/orgState.js';
import {
  createProblem, notifyManagersOfProblem, listProblems, updateProblem, getProblem,
  listWorkOrderMessages, addWorkOrderMessage,
  createTemplate, listTemplates, getTemplate, saveTemplate, publishTemplate, deleteTemplate,
  createInspection, submitInspection, listInspections, getInspection, getInspectionReport,
  submitChecklist, listChecklists,
  listInspectionsInWindow, listChecklistsInWindow, INSPECTION_WINDOW_COLUMNS, CHECKLIST_WINDOW_COLUMNS,
  inspectionFiguresMatching, countInspectionsMatching, pageInspectionsForExport,
  latestInspectionPerClient,
} from '../_lib/qc/store.js';
import { renderInspectionReportPdf, inspectionPdfFilename } from '../_lib/qc/reportPdf.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { isoParam, idParam, idListParam, enumListParam, intParam } from '../_lib/queryParams.js';
import { INSPECTION_RESULTS as RESULT_LIST } from '../../src/lib/inspections.js';
import { aggregateInspectionsPerSite, aggregateChecklistsPerSite } from '../../src/lib/reports/qcReports.js';
// How far back the per-customer latest inspection is looked for, and which customers the
// reminder watches — shared with the walker so the read and the detector agree.
import { INSPECTION_LOOKBACK_DAYS, isReminderClient } from '../../src/lib/opsAlerts.js';

// maxDuration: the inspections/pdf action launches headless chromium and inlines
// photos — cold-start + render can exceed the default limit. Mirrors the quote route.
// (The per-site report tallies also lean on it: a year-long window pages ~200k rows.)
export const config = { maxDuration: 60 };

// Window-read bounds. The checklist list window feeds the reminder walker (the shift
// look-back — capped at a week, lib/opsAlerts — plus 18h); a report window is the Reports
// period picker (at most a year).
const WINDOW_LIST_MAX_DAYS = 31;
const WINDOW_LIST_MAX_ROWS = 10000;   // narrow rows ~340 B → ~3.4 MB, inside a function response
const REPORT_MAX_DAYS = 367;
// A year of nightly checklists at ~750 sites is ~275k rows (tallied server-side, never sent).
const REPORT_MAX_ROWS = 400000;
const INSPECTION_RESULTS = new Set(RESULT_LIST);
// The hub's figures read every matching inspection, all time when no range is picked. The
// answer is one small object; this bounds the read itself (narrow rows, 1000 a page on
// OFFSET paging, which costs more the deeper it goes), which has to finish well inside the
// function's 60 s. Past it the cards say to narrow the date range (413). Inspections are
// supervisor visits; 50k is years of them.
const FIGURES_MAX_ROWS = 50000;
// One page of the hub's export: the browser's page size (lib/pagedFetch.js PAGE_SIZE).
// Export rows measure ~355-500 bytes, so a page stays near 1 MB, inside the 4.5 MB
// function response.
const EXPORT_PAGE_MAX = 2000;
const EXPORT_OFFSET_MAX = 1000000;
// A hub filter lists at most this many ids (the time routes' bound): a GET query string,
// then a PostgREST in() list, has to stay well inside URL limits.
const ID_FILTER_MAX = 200;

// The Quality hub's filters, from the query string. Every value is checked: malformed is a
// 400, never a filter quietly dropped (that would WIDEN the read org-wide) and never raw
// text handed to PostgREST. → the store's filter object, or false when a 400 was written.
//   ?clientId      one customer (a customer's own Inspections tab)
//   ?siteIds       Locations, comma-separated    ?inspectorIds  Inspector
//   ?results       Result (pass,fail,needs_follow_up)
//   ?fromIso&toIso performed_at bounds; either may come alone (a range with no end)
function inspectionFilterParams(req, res) {
  const bad = (error) => { res.status(400).json({ error }); return false; };
  // The single-site ?siteId was folded into ?siteIds. Refused, not ignored: a caller still
  // sending it would otherwise get a wider list than it asked for.
  if (req.query.siteId != null) return bad('siteId was replaced by siteIds');
  const clientId = idParam(req.query.clientId);
  if (clientId === undefined) return bad('clientId is malformed');
  const siteIds = idListParam(req.query.siteIds, ID_FILTER_MAX);
  if (siteIds === undefined) return bad(`siteIds must be at most ${ID_FILTER_MAX} well-formed ids`);
  const inspectorIds = idListParam(req.query.inspectorIds, ID_FILTER_MAX);
  if (inspectorIds === undefined) return bad(`inspectorIds must be at most ${ID_FILTER_MAX} well-formed ids`);
  const results = enumListParam(req.query.results, INSPECTION_RESULTS);
  if (results === undefined) return bad(`results must be drawn from ${RESULT_LIST.join(', ')}`);
  const fromIso = isoParam(req.query.fromIso);
  const toIso = isoParam(req.query.toIso);
  if (fromIso === undefined || toIso === undefined) return bad('fromIso / toIso must be ISO-8601 timestamps');
  if (fromIso && toIso && Date.parse(fromIso) > Date.parse(toIso)) return bad('The date range must run forward');
  return { clientId, siteIds, inspectorIds, results, fromIso, toIso };
}

// A record's public_token / publicToken is a bearer capability on the client-facing report
// (/inspect/:token + the public PDF). A qc.view reader who cannot SHARE (crew hold qc.view,
// not qc.share) must never receive it: the UI already hides every "Copy link" behind
// qc.share, and the authed reads must not hand out the token behind that gate. Checked with
// holdsPermission (the non-writing sibling of requirePermission, which fails closed), not by
// re-reading the matrix here. Mutates each record in place and returns it.
function stripShareToken(rec) {
  if (rec) { delete rec.public_token; delete rec.publicToken; }
  return rec;
}

// ?fromIso&toIso → { fromIso, toIso } | null (no window) | false (a 400 was written).
function windowParams(req, res, maxDays) {
  const fromIso = isoParam(req.query.fromIso);
  const toIso = isoParam(req.query.toIso);
  if (fromIso === undefined || toIso === undefined) {
    res.status(400).json({ error: 'fromIso / toIso must be ISO-8601 timestamps' });
    return false;
  }
  if (!fromIso && !toIso) return null;
  if (!fromIso || !toIso) {
    res.status(400).json({ error: 'fromIso and toIso go together' });
    return false;
  }
  const span = Date.parse(toIso) - Date.parse(fromIso);
  if (span < 0 || span > maxDays * 86400000) {
    res.status(400).json({ error: `The window must run forward and span at most ${maxDays} days` });
    return false;
  }
  return { fromIso, toIso };
}


// A crew read-gate for a single inspection record: managers (null scope) always pass;
// crew only within their assigned clients/sites or on records they performed. Mirrors
// the inline check in inspections/get — shared by the report + pdf reads below.
function inspectionInScope(crewScope, rec) {
  if (!crewScope) return true;
  return (rec.client_id && crewScope.clientIds.includes(rec.client_id))
    || (rec.site_id && crewScope.siteIds.includes(rec.site_id))
    || (rec.inspector_user_id && rec.inspector_user_id === crewScope.userId);
}

// Crew read-scope for QC records: their assigned clients/sites (+ own records via
// userId). null for managers → unscoped. Mirrors problems/list; enforced server-
// side because the open org_state RLS means the UI filter is not a boundary.
async function crewScopeFor(role, orgUserId) {
  if (role !== 'crew') return null;
  const { state } = await readOrgState();
  // Assignments come from public.crew_assignments (service-role write only).
  // Sourcing them from the blob's standingCrewIds let a crew user append their
  // own id and read every account's problem reports and inspection scores. Job
  // membership is deliberately NOT folded in: public.jobs is world-writable, so
  // a self-inserted job would restore the same hole. Until the table has been
  // populated the legacy path stands in — an empty table must not read as
  // "assigned to nothing", which would blank every crew member's QC view.
  if (await assignmentsInitialized()) {
    const sc = await getAssignedScope(orgUserId, state);
    return { clientIds: sc.clientIds, siteIds: sc.siteIds, userId: orgUserId || null };
  }
  const sc = crewAssignedScope(state, orgUserId, await getCrewJobs(orgUserId));
  return { clientIds: sc.clientIds, siteIds: sc.siteIds, userId: orgUserId || null };
}

// Wrapped in a per-request cache (§8 G2). This route is the worst offender for
// redundant blob reads: crewScopeFor is reached from six places in a single request
// and each one pulled the full ~900 KB org_state. The cache is request-scoped
// (AsyncLocalStorage), never module-level — a warm Vercel instance would otherwise
// serve one user a snapshot fetched during another's request, and this blob is the
// authorization source.
export default function handler(req, res) {
  return withRequestCache(() => qcHandler(req, res));
}

async function qcHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [group, action] = path;
  const body = req.body || {};

  try {
    // ── Problem reports (problems.manage is all-roles → any authenticated staff) ──
    if (group === 'problems') {
      if (action === 'create' && req.method === 'POST') {
        const a = await requirePermission(req, res, 'problems.manage');
        if (!a) return;
        if (!body.title || !body.title.trim()) return res.status(400).json({ error: 'A title is required' });
        const problem = await createProblem({
          clientId: body.clientId, siteId: body.siteId, jobId: body.jobId,
          title: body.title.trim(), description: body.description,
          type: body.type, origin: body.origin, priority: body.priority, assigneeUserId: body.assigneeUserId,
          reportedByUserId: a.orgUserId,
        });
        // Notify the office (best-effort; never fails the saved report).
        await notifyManagersOfProblem(problem);
        return res.status(200).json({ problem });
      }
      if (action === 'list' && req.method === 'GET') {
        // requireRole (not requireAuthority): a caller whose role can't be
        // resolved must NOT fall through to the manager branch — crewScopeFor
        // returns null (= unscoped) for any non-'crew' role, including null.
        const a = await requirePermission(req, res, 'qc.view');
        if (!a) return;
        // Crew only see problems for accounts they're assigned to (+ ones they filed).
        // Enforced here, NOT client-side: open RLS means the UI filter isn't a boundary.
        const isCrew = a.role === 'crew';
        const crewScope = await crewScopeFor(a.role, a.orgUserId);
        const siteIds = req.query.siteIds ? String(req.query.siteIds).split(',').filter(Boolean) : null;
        const problems = await listProblems({
          status: req.query.status || null, priority: req.query.priority || null, type: req.query.type || null,
          clientId: isCrew ? null : (req.query.clientId || null),
          siteIds: isCrew ? null : siteIds,
          crewScope,
        });
        return res.status(200).json({ problems });
      }
      if (action === 'update' && req.method === 'POST') {
        const a = await requirePermission(req, res, 'problems.manage');
        if (!a) return;
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        // Crew may only triage a problem for an account they're assigned to (or one
        // they filed) — else 403. Managers unrestricted. Server-checked (open RLS).
        if (a.role === 'crew') {
          const scope = await crewScopeFor(a.role, a.orgUserId);
          const target = await getProblem(body.id);
          if (!target) return res.status(404).json({ error: 'Problem not found' });
          const mine = (target.reported_by_user_id && target.reported_by_user_id === a.orgUserId)
            || (target.site_id && scope.siteIds.includes(target.site_id))
            || (target.client_id && scope.clientIds.includes(target.client_id));
          if (!mine) return res.status(403).json({ error: 'Not your account' });
        }
        const r = await updateProblem({ id: body.id, status: body.status, priority: body.priority, type: body.type, assigneeUserId: body.assigneeUserId, escalated: body.escalated, title: body.title, description: body.description });
        if (r.notFound) return res.status(404).json({ error: 'Problem not found' });
        return res.status(200).json({ problem: r.problem });
      }
      // ── Message thread (Increment 2): read = qc.view, post = problems.manage.
      // Crew are scoped to work orders on their accounts (or ones they filed), like update. ──
      if (action === 'messages' && req.method === 'GET') {
        const a = await requirePermission(req, res, 'qc.view');
        if (!a) return;
        if (!req.query.problemId) return res.status(400).json({ error: 'problemId is required' });
        if (a.role === 'crew') {
          const scope = await crewScopeFor(a.role, a.orgUserId);
          const target = await getProblem(req.query.problemId);
          if (!target) return res.status(404).json({ error: 'Work order not found' });
          const mine = (target.reported_by_user_id && target.reported_by_user_id === a.orgUserId)
            || (target.site_id && scope.siteIds.includes(target.site_id))
            || (target.client_id && scope.clientIds.includes(target.client_id));
          if (!mine) return res.status(403).json({ error: 'Not your account' });
        }
        return res.status(200).json({ messages: await listWorkOrderMessages(req.query.problemId) });
      }
      if (action === 'message' && req.method === 'POST') {
        const a = await requirePermission(req, res, 'problems.manage');
        if (!a) return;
        if (!body.problemId || !body.body || !body.body.trim()) return res.status(400).json({ error: 'problemId and body are required' });
        const target = await getProblem(body.problemId);
        if (!target) return res.status(404).json({ error: 'Work order not found' });
        if (a.role === 'crew') {
          const scope = await crewScopeFor(a.role, a.orgUserId);
          const mine = (target.reported_by_user_id && target.reported_by_user_id === a.orgUserId)
            || (target.site_id && scope.siteIds.includes(target.site_id))
            || (target.client_id && scope.clientIds.includes(target.client_id));
          if (!mine) return res.status(403).json({ error: 'Not your account' });
        }
        const message = await addWorkOrderMessage({ problemId: body.problemId, body: body.body.trim(), authorUserId: a.orgUserId, authorRole: a.role === 'crew' ? 'crew' : 'office' });
        return res.status(200).json({ message });
      }
    }

    // ── Inspection / checklist templates (edit = manager; view = all roles) ──
    if (group === 'templates') {
      if (action === 'create' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        return res.status(200).json(await createTemplate({ name: body.name, kind: body.kind, ratingScale: body.ratingScale, createdBy: g.orgUserId }));
      }
      if (action === 'list' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        return res.status(200).json({ templates: await listTemplates({ kind: req.query.kind || null }) });
      }
      if (action === 'get' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        if (!req.query.id) return res.status(400).json({ error: 'id is required' });
        const r = await getTemplate(req.query.id);
        if (!r) return res.status(404).json({ error: 'Template not found' });
        return res.status(200).json(r);
      }
      if (action === 'save' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        return res.status(200).json({ version: await saveTemplate(body.id, { name: body.name, ratingScale: body.ratingScale, schema: body.schema }) });
      }
      if (action === 'publish' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        const r = await publishTemplate(body.id);
        if (r.nothing) return res.status(400).json({ error: 'Nothing to publish' });
        // An item-less CHECKLIST can never be completed, so publishing one is refused
        // (src/lib/inspections.publishRefusal — the same rule the demo stub applies).
        if (r.refused) return res.status(400).json({ error: r.refused });
        return res.status(200).json(r);
      }
      if (action === 'delete' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        return res.status(200).json(await deleteTemplate(body.id));
      }
    }

    // ── Inspection records (perform = manager via qc.inspect; view = all roles) ──
    if (group === 'inspections') {
      if (action === 'create' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        const r = await createInspection({ templateId: body.templateId, clientId: body.clientId, siteId: body.siteId, jobId: body.jobId, timeEntryId: body.timeEntryId, inspectorUserId: g.orgUserId });
        if (r.notFound) return res.status(404).json({ error: 'Template not found' });
        if (r.notPublished) return res.status(400).json({ error: 'Publish the template before inspecting with it' });
        return res.status(200).json({ inspection: r.inspection });
      }
      if (action === 'submit' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        const r = await submitInspection({ id: body.id, items: body.items });
        if (r.notFound) return res.status(404).json({ error: 'Inspection not found' });
        return res.status(200).json({ inspection: r.inspection });
      }
      // The Quality hub's three reads over ONE filter set (inspectionFilterParams): the
      // list (newest 200), its figures and its export. Every filter runs in the query, so
      // a location's, an inspector's or an older range's records can't fall out of an
      // org-wide slice. Crew only see inspections at accounts they're assigned to (+ ones
      // they performed), the same server-side boundary as problems/list; a filter narrows
      // inside that scope, never past it.
      if (action === 'list' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        const filters = inspectionFilterParams(req, res); if (!filters) return;
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        const { inspections, truncated } = await listInspections({ ...filters, crewScope });
        // The list carries public_token so a sharer can copy a report link; strip it for a
        // reader who can't share, so crew paging their in-scope history never harvest links.
        if (!(await holdsPermission(g, 'qc.share'))) inspections.forEach(stripShareToken);
        return res.status(200).json({ inspections, truncated });
      }
      // The stat cards: tallied over EVERY match, so they never describe only the list's
      // newest 200. The same records the viewer can list, so the same gate.
      if (action === 'figures' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        const filters = inspectionFilterParams(req, res); if (!filters) return;
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        const figures = await inspectionFiguresMatching({ ...filters, crewScope }, { maxRows: FIGURES_MAX_ROWS });
        return res.status(200).json({ figures });
      }
      // Export CSV: every match, never just the rows on screen. The browser reads it in
      // pages (?offset&limit, newest first; the first page carries `total`) through
      // lib/pagedFetch.js, which fails loudly rather than write a partial file. BOTH gates:
      // the records (qc.view) and exporting them (qc.share, the permission the hub's
      // Export button is behind).
      if (action === 'export' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        const s = await requirePermission(req, res, 'qc.share'); if (!s) return;
        const filters = inspectionFilterParams(req, res); if (!filters) return;
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        const scoped = { ...filters, crewScope };
        const offset = intParam(req.query.offset, 0, 0, EXPORT_OFFSET_MAX);
        const limit = intParam(req.query.limit, EXPORT_PAGE_MAX, 1, EXPORT_PAGE_MAX);
        const [total, inspections] = await Promise.all([
          offset === 0 ? countInspectionsMatching(scoped) : Promise.resolve(null),
          pageInspectionsForExport(scoped, { offset, limit }),
        ]);
        return res.status(200).json({ inspections, total, offset, limit });
      }
      // The newest submitted inspection per ACTIVE customer — the inspection-reminder
      // walker's input (client tick; the cron calls the store fn directly). Newest-first
      // pages that stop once every account is seen; accounts not inspected within
      // INSPECTION_LOOKBACK_DAYS read as never inspected, as the walker always treated
      // them. Crew get only the customers wholly in their scope: one they reach through a
      // single site or their own inspections would read a partial history — an older
      // "latest" and a false reminder. One row per account, so the response stays small.
      if (action === 'latest-by-client' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        const { state } = await readOrgState();
        let clientIds = (state?.clients || []).filter(isReminderClient).map((c) => c.id);
        if (crewScope) {
          const mine = new Set(crewScope.clientIds || []);
          clientIds = clientIds.filter((id) => mine.has(id));
        }
        if (!clientIds.length) return res.status(200).json({ inspections: [] });
        const now = Date.now();
        const inspections = await latestInspectionPerClient({
          clientIds,
          sinceIso: new Date(now - INSPECTION_LOOKBACK_DAYS * 86400000).toISOString(),
          untilIso: new Date(now).toISOString(),
        });
        return res.status(200).json({ inspections });
      }
      if (action === 'get' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        if (!req.query.id) return res.status(400).json({ error: 'id is required' });
        const r = await getInspection(req.query.id);
        if (!r) return res.status(404).json({ error: 'Inspection not found' });
        // Crew may only open an inspection within their scope — mirrors problems/update.
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        if (crewScope) {
          const rec = r.inspection;
          const mine = (rec.client_id && crewScope.clientIds.includes(rec.client_id))
            || (rec.site_id && crewScope.siteIds.includes(rec.site_id))
            || (rec.inspector_user_id && rec.inspector_user_id === crewScope.userId);
          if (!mine) return res.status(403).json({ error: 'Not your account' });
        }
        // Same token gate as the list: only a caller who may share receives public_token.
        if (!(await holdsPermission(g, 'qc.share'))) stripShareToken(r.inspection);
        return res.status(200).json(r);
      }
      // Normalized report projection for the in-app report modal (schema + answers +
      // per-section photos). Same shape the public /inspect page + the PDF use.
      if (action === 'report' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        if (!req.query.id) return res.status(400).json({ error: 'id is required' });
        const r = await getInspectionReport(req.query.id);
        if (!r) return res.status(404).json({ error: 'Inspection not found' });
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        if (!inspectionInScope(crewScope, r.rec)) return res.status(403).json({ error: 'Not your account' });
        // The projection carries publicToken for the modal's Copy-link; strip it for a
        // reader who can't share (the modal already hides Copy-link without qc.share).
        if (!(await holdsPermission(g, 'qc.share'))) stripShareToken(r.report.inspection);
        return res.status(200).json(r.report);
      }
      // Server-rendered PDF of the report (headless chromium, photos inlined). Returns
      // application/pdf bytes as an attachment. Crew-scoped exactly like get/report.
      if (action === 'pdf' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        if (!req.query.id) return res.status(400).json({ error: 'id is required' });
        const r = await getInspection(req.query.id);
        if (!r) return res.status(404).json({ error: 'Inspection not found' });
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        if (!inspectionInScope(crewScope, r.inspection)) return res.status(403).json({ error: 'Not your account' });
        const pdf = await renderInspectionReportPdf(r.inspection, r.items);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${inspectionPdfFilename(r.inspection)}"`);
        return res.status(200).send(Buffer.from(pdf));
      }
    }

    // ── Checklists (perform = all roles — completing per-account checklists is a
    // core crew task (SWEPT §5.6); crew are scoped to their assigned accounts.
    // View = all roles.) ──
    if (group === 'checklists') {
      if (action === 'submit' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.checklist.perform'); if (!g) return;
        // Crew may only complete a checklist against a site/account they're
        // assigned to — server-checked (open RLS; the UI picker is not a boundary).
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        if (crewScope) {
          const ok = (body.siteId && crewScope.siteIds.includes(body.siteId))
            || (body.clientId && crewScope.clientIds.includes(body.clientId));
          if (!ok) return res.status(403).json({ error: 'Not your account' });
        }
        const r = await submitChecklist({ templateId: body.templateId, clientId: body.clientId, siteId: body.siteId, jobId: body.jobId, items: body.items, completedByUserId: g.orgUserId, clientSubmitId: typeof body.clientSubmitId === 'string' ? body.clientSubmitId.slice(0, 64) : null });
        if (r.notFound) return res.status(404).json({ error: 'Template not found' });
        if (r.notPublished) return res.status(400).json({ error: 'Publish the checklist template first' });
        return res.status(200).json({ checklist: r.checklist });
      }
      if (action === 'list' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        // Crew only see checklists at accounts they're assigned to (+ ones they
        // completed) — same server-side boundary as problems/list.
        const crewScope = await crewScopeFor(g.role, g.orgUserId);
        // ?fromIso&toIso — the COMPLETE window read (the checklist-reminder walker). The
        // walker judges every clean in the org, so a crew-scoped slice would read other
        // accounts' logged checklists as missing and false-fire; crew are refused (their
        // tab skips checklist reminders — the server cron raises them from full data).
        const win = windowParams(req, res, WINDOW_LIST_MAX_DAYS); if (win === false) return;
        if (win) {
          if (crewScope) return res.status(403).json({ error: 'The complete checklist window is for managers' });
          const checklists = await listChecklistsInWindow(
            { ...win, siteId: req.query.siteId || null },
            { columns: CHECKLIST_WINDOW_COLUMNS, maxRows: WINDOW_LIST_MAX_ROWS },
          );
          return res.status(200).json({ checklists, complete: true });
        }
        return res.status(200).json({ checklists: await listChecklists({ siteId: req.query.siteId || null, jobId: req.query.jobId || null, crewScope }) });
      }
    }

    // ── Reports › Inspections / site · Checklists / site ──────────────────────
    // Tallied SERVER-side over EVERY record in the window (a complete, paged read)
    // with the same pure aggregators the demo stub runs, so the browser receives one
    // row per site instead of every record: a year of nightly checklists at ~750
    // sites is ~200k rows, far past any single response. Gated like the Reports page
    // (reports.view); crew-scoped as defense in depth should a crew user ever hold it.
    // The Manager/Customer scoping + live names are applied by the client.
    if (group === 'reports' && req.method === 'GET') {
      // BOTH gates: the Reports page (reports.view) AND the records themselves (qc.view) —
      // a role with inspections turned off must not read scores through a report.
      const g = await requirePermission(req, res, 'reports.view'); if (!g) return;
      const q = await requirePermission(req, res, 'qc.view'); if (!q) return;
      const win = windowParams(req, res, REPORT_MAX_DAYS); if (win === false) return;
      if (!win) return res.status(400).json({ error: 'fromIso and toIso are required' });
      const clientId = idParam(req.query.clientId);
      if (clientId === undefined) return res.status(400).json({ error: 'clientId is malformed' });
      const crewScope = await crewScopeFor(g.role, g.orgUserId);
      const fromMs = Date.parse(win.fromIso);
      const toMs = Date.parse(win.toIso);
      if (action === 'inspections-by-site') {
        // A result outside the vocabulary is a 400: read as "all results" it widened the tally.
        const result = req.query.result == null || req.query.result === '' ? null : req.query.result;
        if (result != null && !INSPECTION_RESULTS.has(result)) return res.status(400).json({ error: `result must be one of ${RESULT_LIST.join(', ')}` });
        const records = await listInspectionsInWindow(
          { ...win, clientId, results: result ? [result] : null, submittedOnly: true, crewScope },
          { columns: INSPECTION_WINDOW_COLUMNS, maxRows: REPORT_MAX_ROWS },
        );
        return res.status(200).json({
          rows: aggregateInspectionsPerSite({ inspections: records, fromMs, toMs, result, clientId }),
          recordCount: records.length,
        });
      }
      if (action === 'checklists-by-site') {
        const records = await listChecklistsInWindow({ ...win, clientId, crewScope }, { columns: CHECKLIST_WINDOW_COLUMNS, maxRows: REPORT_MAX_ROWS });
        return res.status(200).json({
          rows: aggregateChecklistsPerSite({ checklists: records, fromMs, toMs, clientId }),
          recordCount: records.length,
        });
      }
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/qc]', e);
    return res.status(readErrorStatus(e)).json({ error: e?.message || 'Server error' });
  }
}
