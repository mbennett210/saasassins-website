// QC API (Swept replacement — inspections, checklists, problem reports). Records
// are relational + photo-bearing (photos via /api/account-media, scope 'inspection'
// |'problem_report'). Every action re-checks authority server-side. PROBLEM REPORTS
// land first; inspections + checklists follow. See CLEANSPACE_SWEPT.md §5.6 / §2.4.
//
//   POST /api/qc/inspections/submit { id, items, internalNote? }  (internalNote = HUB-16, office only;
//                                 a DRAFT only by its inspector or the office — lib/inspectionDrafts)
//   An inspection LEFT OPEN AND FINISHED LATER (Matt, 2026-10-06; EP-355..EP-358), all qc.inspect,
//   all only the inspector who started it or the office (owner/admin), read from the login:
//   POST /api/qc/inspections/save-draft { id, items, internalNote? } -> 409 on anything not a draft;
//                                 writes items + note + updated_at and NOTHING else (no score, no
//                                 bell, no ticket, no email, no activity row — all of that is Submit's)
//   GET  /api/qc/inspections/draft ?id     -> { inspection, items } for Continue (409 not a draft)
//   POST /api/qc/inspections/discard { id } -> deletes the draft, its items and its photos (409 not a draft)
//   GET  /api/qc/inspections/drafts [?siteId] -> the CALLER's own open drafts, newest saved first
//   (POST inspections/create needs a siteId of the company's — CS-697, 400 location-required —
//    and also deletes drafts untouched for 30 days, bounded per call — D9)
//   POST /api/qc/problems/create  { siteId, clientId?, jobId?, title, description?, type?, origin?, priority?, category?, assigneeUserId?, siteAreaId? }
//                                 siteId REQUIRED, one of the company's (CS-697) -> 400 location-required / location-unknown
//   GET  /api/qc/problems/list    [?priority&type&category&clientId&siteIds=a,b&supervisorId]
//                                 -> { problems, total }: EVERY open ticket, a complete read (CS-640),
//                                    each with its first staff reply `first_reply_at` (Matt's 30 minutes)
//                                 [&resolved=1&offset&limit] -> { problems, total, last24h, offset, limit }:
//                                 one page (≤100) of the resolved history, newest resolved first
//                                 [&since=<iso>] -> { problems, total }: every ticket created since, complete
//   GET  /api/qc/problems/mine    [?userId] -> { open, recentDone }: the CALLER's client requests (the
//                                 Cleaner Hub, EP-380): every open ticket whose crew_user_ids names
//                                 them + the ones resolved in the last 7 days, built field by field
//                                 (lib/crewRequests). userId only for an office login holding
//                                 problems.manage (View-as); a crew login is always itself
//   POST /api/qc/problems/update  { id, status?, priority?, type?, category?, assigneeUserId?, escalated?, title?, description?, siteId?, crewUserIds? }
//                                 crewUserIds: the cleaners on the ticket — OFFICE only (crew 403
//                                 crew-office-only), active cleaners, ≤ 20 (400); the newly added
//                                 are rung (crewRequestAssigned)
//                                 a CREW caller's resolve rings the account manager (crewRequestCompleted)
//                                 status:'resolved' needs a completion photo (WO-10) -> 409
//                                 siteId: the OFFICE gives a ticket with no location its location, once
//                                 (CS-697) -> 403 location-office-only (crew) · 400 location-unknown /
//                                 location-other-customer · 409 location-set
//                                 a client ticket's stage change emails the client who raised it (HUB-11)
//   POST /api/qc/problems/message { problemId, body, internal? }  internal:true = an office note the
//                                 client never sees (WO-9); a reply on a client ticket emails them
//   GET  /api/qc/problems/counts  [?days=30]  -> tickets per customer in the window (WO-14)
//   GET  /api/qc/templates/list   [?kind&clientId | ?kind&starters=1]  (a customer's checklists, or the starters)
//   POST /api/qc/templates/create { name, kind, ratingScale?, clientId }  (a checklist REQUIRES clientId; an inspection refuses one)
//   POST /api/qc/templates/copy   { id, clientId, name? }  -> "Start from…" (qc.templates.edit)
//   GET  /api/qc/templates/summary                         -> every checklist, narrow + complete (office: qc.templates.edit OR ops.edit)
//   GET  /api/qc/inspections/list    [?clientId&siteIds&inspectorIds&results&fromIso&toIso]  (newest 200 matching + truncated)
//   GET  /api/qc/inspections/figures [same filters]  -> the hub's stat cards over EVERY match (qc.view)
//   GET  /api/qc/inspections/export  [same filters]&offset&limit -> one page of EVERY match, the CSV's columns (qc.view + qc.share)
//   GET  /api/qc/checklists/list  [?siteId&jobId]          (newest 200)
//                                 [&fromIso&toIso → every record in the window; not crew]
//   GET  /api/qc/inspections/latest-by-client  -> newest submitted inspection per active customer (qc.view)
//   GET  /api/qc/areas/status    ?siteId  -> each cleaning area's last clean + newest photo (qc.view; QR-1)
//   GET  /api/qc/reports/inspections-by-site ?fromIso&toIso[&result&clientId]  (reports.view + qc.view)
//   GET  /api/qc/reports/checklists-by-site  ?fromIso&toIso[&clientId]          (reports.view + qc.view)
//   GET  /api/qc/reports/resolve-time        ?fromIso&toIso[&clientId&supervisorId] (reports.view + qc.view)
//                                 -> { fromIso, toIso, overall, byType[], byClient[] }: time to resolve (EP-360)
//   GET  /api/qc/reports/visitor-ratings     [?days=7|30|90] (reports.view + qc.view + an office role; never crew)
//                                 -> { days, fromDay, toDay, buildings[], totals }: the visitors' thumbs (EP-416, QR-30)
//   GET  /api/qc/surveys?clientId=           (qc.view + an office role; never crew)
//                                 -> { surveys: [{ id, sentAt, expiresAt, rating, comment, answeredAt }] } (EP-426)
//   (problems/create also takes `siteAreaId` — one of the location's areas, else 400 area-unknown;
//    problems/list and problems/update hand a CREW caller a ticket without a visitor's name and contact)
import { requirePermission, requireAuthority, holdsPermission, crewAssignedScope } from '../_lib/authz.js';
import { assignmentsInitialized, getAssignedScope } from '../_lib/crewAssignments.js';
import { withRequestCache, cached } from '../_lib/requestCache.js';
import { crewScopeFromJobs } from '../../src/lib/crewScope.js';
import { getCrewJobs } from '../_lib/jobsTable.js';
import { readOrgState } from '../_lib/orgState.js';
import {
  createProblem, notifyTicketRaised, listOpenProblems, listResolvedProblems, listProblemsSince, withFirstReplies,
  RESOLVED_PAGE_DEFAULT, RESOLVED_PAGE_MAX, updateProblem, getProblem, setProblemLocation,
  listCrewRequests, notifyCrewRequestAssigned, notifyCrewRequestCompleted,
  countProblemPhotos, ticketRowsSince,
  listWorkOrderMessages, addWorkOrderMessage,
  createTemplate, listTemplates, getTemplate, saveTemplate, publishTemplate, deleteTemplate, templatesWithDrafts,
  copyTemplate, templatesSummary,
  createInspection, submitInspection, listInspections, getInspection, getInspectionReport,
  saveInspectionDraft, getInspectionDraft, discardInspectionDraft, listMyInspectionDrafts, pruneStaleInspectionDrafts,
  submitChecklist, listChecklists, countChecklists, areaStatusForSite,
  listInspectionsInWindow, listChecklistsInWindow, INSPECTION_WINDOW_COLUMNS, CHECKLIST_WINDOW_COLUMNS,
  inspectionFiguresMatching, countInspectionsMatching, pageInspectionsForExport,
  latestInspectionPerClient, resolvedProblemsInWindow,
} from '../_lib/qc/store.js';
import { resolveReport } from '../../src/lib/resolveTime.js';
import { renderInspectionReportPdf, inspectionPdfFilename } from '../_lib/qc/reportPdf.js';
import { logActivityAs } from '../_lib/activityLog.js';
import { emailTicketStageChanged, emailTicketReplied, emailInspectionPosted } from '../_lib/clientHub/notify.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { isoParam, idParam, idListParam, enumListParam, intParam } from '../_lib/queryParams.js';
import {
  INSPECTION_RESULTS as RESULT_LIST,
  createTemplateRefusal, templateFilterRefusal, templateKindRefusal, CHECKLIST_NEEDS_CUSTOMER,
  CHECKLIST_LIST_LIMIT,
} from '../../src/lib/inspections.js';
import { NOT_A_CHECKLIST_CODE } from '../../src/lib/checklistCount.js';
import { DRAFT_CODES, MAX_DRAFT_ITEMS } from '../../src/lib/inspectionDrafts.js';
import {
  resolvePhotoRefusal, RESOLVE_PHOTO_MESSAGE, normalizeStatus,
  ticketCountsByClient, TICKET_FLAG_DAYS, RAISABLE_WO_TYPES,
  locationRefusal, LOCATION_CODES, LOCATION_MESSAGES,
  ticketAreaInput, AREA_MESSAGES, VISITOR_ORIGIN, withoutVisitorReporter,
} from '../../src/lib/workOrders.js';
// QR-30: the office's read of the visitors' votes (EP-416).
import { listRatingsInPeriod } from '../_lib/scanCodes/visitor.js';
import { ratingPeriodDays, ratingPeriodWindow, visitorRatingsReport, RATING_PERIODS } from '../../src/lib/areaRatings.js';
import { isOfficeRole } from '../../src/lib/roles.js';
import { surveysForClient } from '../_lib/customerMessages/surveys.js';
// WO-19: a person files a complaint, a request or an issue; a `failed_inspection` ticket is the
// app's own (store.openFailedInspectionTicket), so a hand-sent one is filed as the default issue
// and a hand edit cannot turn a ticket into one.
const raisableType = (t) => (RAISABLE_WO_TYPES.includes(t) ? t : undefined);
import { aggregateInspectionsPerSite, aggregateChecklistsPerSite } from '../../src/lib/reports/qcReports.js';
// The Cleaner Hub's Client Requests (2026-10-13, brief C): who may be routed and what a cleaner reads.
import { checkCrewRouting, newlyRoutedCrew, ticketCrewIds, crewRequestViews, namedCompletionAllowed, CREW_ROUTING_CODES, CREW_ROUTING_MESSAGES } from '../../src/lib/crewRequests.js';
import { crewReadSubject } from '../_lib/crewPreview.js';
// How far back the per-customer latest inspection is looked for, and which customers the
// reminder watches (lib/customerStatus isActiveBuilding, CS-683: Inactive and Archived out) —
// shared with the walker so the read and the detector agree.
import { INSPECTION_LOOKBACK_DAYS } from '../../src/lib/opsAlerts.js';
import { isActiveBuilding } from '../../src/lib/customerStatus.js';
import { TEAM, teamClientIds } from '../../src/lib/teamScope.js';

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

// The template list's filters (R2, plan step 5). `?clientId` = that customer's checklists
// only, `?starters=1` = only the ones filed under nobody ("Start from…"), neither = every
// row of the kind, as before. The id is held to the id alphabet like every other read here
// — a malformed one is a 400, never raw text handed to PostgREST — and the contradictory
// pair is refused rather than answered with an empty list, which would read as "this
// customer has no checklists". → the store's filter object, or false when a 400 was written.
function templateFilterParams(req, res) {
  const clientId = idParam(req.query.clientId);
  if (clientId === undefined) { res.status(400).json({ error: 'clientId is malformed' }); return false; }
  const kind = req.query.kind || null;
  const badKind = templateKindRefusal(kind);
  if (badKind) { res.status(400).json({ error: badKind }); return false; }
  // A FLAG, not free text: `?starters=yes` used to be falsy and quietly returned every row
  // — the same silent widening a dropped filter causes. Present means '1' or 'true'.
  const rawStarters = req.query.starters;
  if (rawStarters != null && rawStarters !== '1' && rawStarters !== 'true') {
    res.status(400).json({ error: 'starters must be 1 or true' });
    return false;
  }
  const starters = rawStarters != null;
  const conflict = templateFilterRefusal({ clientId, starters });
  if (conflict) { res.status(400).json({ error: conflict }); return false; }
  return { kind, clientId, starters };
}

// THE CREW BOUNDARY for the template reads (F1). `qc.view` is an all-roles key, so without
// this a crew login could page every customer's checklists WITH their client_id — a map of
// the customer book, which is precisely what CS-002's crew read split exists to keep out of
// a crew session. Crew get the checklists of the customers they have cleans at and nothing
// else; a customer outside that scope is a 403, as problems/update answers; and the
// starters are an office tool (a checklist filed under nobody, offered under "Start
// from…"), so asking for them is a 403 too. → filters | false (a response was written).
async function scopeTemplateFiltersToCrew(filters, crewScope, res) {
  if (!crewScope) return filters;
  if (filters.starters) { res.status(403).json({ error: 'Starters are for the office' }); return false; }
  const mine = crewScope.clientIds || [];
  if (filters.clientId && !mine.includes(filters.clientId)) {
    res.status(403).json({ error: 'Not your account' });
    return false;
  }
  // An empty scope reads NO rows (applyTemplateFilters), never every row.
  return { ...filters, clientIds: filters.clientId ? [filters.clientId] : mine };
}

// EVERY template id, on every branch (F3). They were passed through raw: a malformed one
// reached PostgREST and came back as a 500 wrapping the provider's own complaint, and a
// well-formed one from another org was read and written before the store learned to scope
// (`it_x),kind.eq.inspection` is the shape that matters here). → the id, or false when a
// 400 was written.
function templateIdParam(raw, res) {
  if (!raw) { res.status(400).json({ error: 'id is required' }); return false; }
  const id = idParam(raw);
  if (id === undefined) { res.status(400).json({ error: 'id is malformed' }); return false; }
  return id;
}

// A checklist's customer must NAME one. Customers live in the `org_state` blob, not in a
// table, so there is no FK to reject a stray id and a mistyped one would file a checklist
// under a customer that does not exist — invisible in every per-customer menu, for ever.
// Read through the request cache (the blob is read at most once per request).
async function knownClient(clientId) {
  const { state } = await readOrgState();
  return (state?.clients || []).some((c) => c && c.id === clientId);
}
const UNKNOWN_CUSTOMER = 'That customer no longer exists.';

// 🔴 HUB-16 — the inspector's INTERNAL note is for the office, and `qc.view` is an
// all-roles key, so every authed read that hands back a RAW inspection row has to strip it
// for a caller who is not one of the people inspections are written by and for. The gate is
// `qc.inspect` (owner / admin / manager — the tiers that perform inspections), checked with
// `holdsPermission`, the non-writing, fail-closed sibling the share-token gate uses. The
// CLIENT-facing surfaces need no stripping at all: `projectReport` never reads the column.
function stripInternalNote(rec) {
  if (rec) { delete rec.internal_note; delete rec.internalNote; }
  return rec;
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

// An inspection left open to finish later (lib/inspectionDrafts): the store's refusals, each
// with the code the form tells them apart by. The words are the API's (English, LANG-8); the
// screen says its own from the catalog.
const draftActor = (g) => ({ role: g?.role || null, userId: g?.orgUserId || null });
function draftRefusal(res, r) {
  if (r.notFound) { res.status(404).json({ error: 'Inspection not found', code: 'not-found' }); return true; }
  if (r.notADraft) {
    res.status(409).json({ error: 'This inspection is no longer open: it was submitted or discarded.', code: DRAFT_CODES.notADraft });
    return true;
  }
  if (r.forbidden) {
    res.status(403).json({ error: 'Only the person who started this inspection, or the office, can work on it.', code: DRAFT_CODES.notYours });
    return true;
  }
  return false;
}
// A draft's id, from a body or the query: required and held to the id alphabet. → id | false (400 written).
function draftIdParam(raw, res) {
  const id = idParam(raw);
  if (id === undefined) { res.status(400).json({ error: 'id is malformed' }); return false; }
  if (!id) { res.status(400).json({ error: 'id is required' }); return false; }
  return id;
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

// Crew read-scope for QC records: the customers / locations they WORK AT (+ own records via
// userId). null for managers → unscoped. Mirrors problems/list; enforced server-side because
// the open org_state RLS means the UI filter is not a boundary.
//
// 🔴 CS-005 (2026-10-03): THE CLEANS THEY ARE ON, not only the standing table. Once
// public.crew_assignments had ever been synced this read the table ALONE — and the table is
// derived from the retired standingCrewIds (crew became exactly the schedule's on 2026-09-09),
// so in production it held only its marker and every cleaner's scope was EMPTY: their
// checklist submit answered 403 "Not your account", their buildings' work orders never listed,
// and the area status refused them. The scope is now the union of the standing table and the
// shared job rule (src/lib/crewScope.js crewScopeFromJobs — the one the screens read). It was
// "deliberately NOT folded in" before because public.jobs was world-writable; since Increment 1e
// a browser cannot write it and jobsGuard puts back a cleaner's change to a clean's crew, site or
// time, which is the footing the door-code reveal's job path has stood on since S81. The
// assignmentsInitialized() contract is kept: before the table is ever synced the legacy path
// (blob standing crew + the same jobs) stands in, so an empty table never reads as "assigned to
// nothing" — and now neither does an initialized one.
async function crewScopeFor(role, orgUserId) {
  if (role !== 'crew') return null;
  const { state } = await readOrgState();
  const jobs = await crewJobsFor(orgUserId);
  if (await assignmentsInitialized()) {
    const standing = await getAssignedScope(orgUserId, state);
    const scheduled = crewScopeFromJobs({ jobs, sites: state?.sites, userId: orgUserId });
    return {
      clientIds: [...new Set([...standing.clientIds, ...scheduled.clientIds])],
      siteIds: [...new Set([...standing.siteIds, ...scheduled.siteIds])],
      userId: orgUserId || null,
    };
  }
  const sc = crewAssignedScope(state, orgUserId, jobs);
  return { clientIds: sc.clientIds, siteIds: sc.siteIds, userId: orgUserId || null };
}
// The cleaner's cleans, read once per request (crewScopeFor is reached from several places).
const crewJobsFor = (orgUserId) => cached(`crewJobs:${orgUserId || ''}`, () => getCrewJobs(orgUserId));

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
    // ── EP-426 — a customer's satisfaction surveys (Matt's approved messages, 2026-10-19) ──
    // AUTH STANCE: requirePermission('qc.view') + the office-role floor (lib/roles isOfficeRole on
    // the claim's role): a cleaner holds qc.view for checklists, never a customer's ratings and
    // comments (403 office-only). Read only; never the token or its hash.
    if (group === 'surveys' && !action && req.method === 'GET') {
      const g = await requirePermission(req, res, 'qc.view');
      if (!g) return;
      if (!isOfficeRole(g.role)) return res.status(403).json({ error: 'Only the office sees survey answers.', code: 'office-only' });
      const clientId = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) return res.status(400).json({ error: 'clientId is required', code: 'bad-request' });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ surveys: await surveysForClient(clientId) });
    }

    // ── Problem reports (problems.manage is all-roles → any authenticated staff) ──
    if (group === 'problems') {
      if (action === 'create' && req.method === 'POST') {
        const a = await requirePermission(req, res, 'problems.manage');
        if (!a) return;
        if (!body.title || !body.title.trim()) return res.status(400).json({ error: 'A title is required' });
        // 🔴 CS-697: a work order is filed at a location — its completion photo (WO-10) is filed
        // under the building and its queue is the building's manager — so none, or one that is not
        // the company's, is refused; its customer is the location's.
        const { state: book } = await readOrgState();
        const where = locationRefusal({ siteId: body.siteId, sites: book?.sites || [] });
        if (where) return res.status(400).json({ error: LOCATION_MESSAGES[where], code: where });
        const site = (book?.sites || []).find((s) => s && s.id === body.siteId);
        // QR-16 / QR-23: the area the ticket is about, one of THIS location's (lib/workOrders) or none.
        const area = ticketAreaInput(body.siteAreaId, site);
        if (area.refused) return res.status(400).json({ error: AREA_MESSAGES[area.refused], code: area.refused });
        const problem = await createProblem({
          clientId: site.clientId || body.clientId, siteId: site.id, jobId: body.jobId,
          title: body.title.trim(), description: body.description,
          // A visitor's origin is the public route's alone (QR-26): sent here, it is the office's own.
          type: raisableType(body.type), origin: body.origin === VISITOR_ORIGIN ? undefined : body.origin, priority: body.priority, category: body.category,
          assigneeUserId: body.assigneeUserId,
          reportedByUserId: a.orgUserId,
          siteAreaId: area.value,
        });
        // Notify the office (best-effort; never fails the saved report).
        await notifyTicketRaised(problem);
        return res.status(200).json({ problem });
      }
      // ── EP-380 — the CLEANER's Client Requests (the Cleaner Hub, 2026-10-13, brief C §2) ──
      // AUTH STANCE: requireAuthority, then SELF from the login's claim — the rows are exactly the
      // tickets whose `crew_user_ids` names the subject, so no role or key widens what is read
      // (this is not the queue: crewScopeFor is not consulted, and a role-less caller reads only
      // the tickets naming its own id). An office login may name another person (`userId`, the
      // owner's View-as) only while holding problems.manage (_lib/crewPreview; else 403); a crew
      // login is always itself. Org-pinned, complete, and built field by field (lib/crewRequests):
      // no internal note, no customer contact, no other cleaner's id.
      if (action === 'mine' && req.method === 'GET') {
        const a = await requireAuthority(req, res);
        if (!a) return;
        const who = await crewReadSubject(a, req.query.userId, 'problems.manage');
        if (who.status) return res.status(who.status).json({ error: who.error, code: who.code });
        if (!who.userId) return res.status(200).json({ open: [], recentDone: [] });
        const now = Date.now();
        const [rows, { state }] = await Promise.all([listCrewRequests({ userId: who.userId, now }), readOrgState()]);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).json(crewRequestViews(rows, { userId: who.userId, users: state?.users || [], clients: state?.clients || [], now }));
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
        // 🔴 CS-640: three views, none of them the newest N. The default is EVERY open ticket (a
        // complete read — the queue, Client Requests and every open count come from it); the
        // resolved history is a bounded PAGE with its exact total; `since` is every ticket of
        // any status created since an instant (complete). A queue (`supervisorId`) is that
        // supervisor's buildings, resolved here from the customers, so a page of resolved
        // history and its total describe the same queue. Crew keep their server scope and
        // none of the office's narrowing filters.
        const since = isoParam(req.query.since);
        if (since === undefined) return res.status(400).json({ error: 'since must be an ISO instant' });
        const resolved = req.query.resolved === '1' || req.query.resolved === 'true';
        if (resolved && since) return res.status(400).json({ error: 'Ask for the resolved history or a since window, not both' });
        const supervisorId = idParam(req.query.supervisorId);
        if (supervisorId === undefined) return res.status(400).json({ error: 'supervisorId must be one id' });
        let clientIds;
        if (supervisorId && !isCrew) {
          const { state } = await readOrgState();
          // `team` (S131) is the CALLER's team, resolved from their claim and the committed roster
          // (lib/teamScope): an Operations Manager's buildings and their account managers'; for
          // anyone else, their own. Never a team named by the request.
          clientIds = supervisorId === TEAM
            ? [...teamClientIds(state?.users || [], state?.clients || [], a.role === 'manager' ? a.orgUserId : null)]
            : (state?.clients || []).filter((c) => c && c.supervisorId === supervisorId).map((c) => c.id);
        }
        const filters = {
          priority: req.query.priority || null, type: req.query.type || null,
          category: req.query.category || null,
          clientId: isCrew ? null : (req.query.clientId || null),
          siteIds: isCrew ? null : siteIds,
          clientIds,
          crewScope,
        };
        // QR-26: a visitor's name and phone or email are the OFFICE's — a cleaner reads the ticket
        // at their building without them (lib/workOrders withoutVisitorReporter).
        const forCaller = (rows) => (isCrew ? rows.map(withoutVisitorReporter) : rows);
        if (resolved) {
          const page = await listResolvedProblems({
            ...filters,
            offset: intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
            limit: intParam(req.query.limit, RESOLVED_PAGE_DEFAULT, 1, RESOLVED_PAGE_MAX),
          });
          return res.status(200).json({ problems: forCaller(page.rows), total: page.total, last24h: page.last24h, offset: page.offset, limit: page.limit });
        }
        // The open view carries each ticket's first staff reply (`first_reply_at`): the first-reply
        // clock — Matt's 30 minutes, the WO-5 window — runs until it (lib/clientRequests requestClock).
        const problems = since ? await listProblemsSince({ ...filters, sinceIso: since }) : await withFirstReplies(await listOpenProblems(filters));
        return res.status(200).json({ problems: forCaller(problems), total: problems.length });
      }
      // 🔴 WO-14: tickets per customer over a rolling window, for the "complaining too much"
      // flag on the customer page and the customers list. A COMPLETE narrow read (two columns)
      // tallied by the SHARED pure rule, so the two screens and the tests count the same way;
      // a capped read would under-count exactly the busiest accounts the flag exists to find.
      // Crew-scoped like every problems read. `?days` is bounded — the flag's own window is 30.
      if (action === 'counts' && req.method === 'GET') {
        const a = await requirePermission(req, res, 'qc.view');
        if (!a) return;
        // intParam clamps and falls back, so a malformed or absurd ?days is the flag's own
        // 30-day window rather than a 400 or a year-long scan.
        const days = intParam(req.query.days, TICKET_FLAG_DAYS, 1, 366);
        const crewScope = await crewScopeFor(a.role, a.orgUserId);
        const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
        const rows = await ticketRowsSince({ sinceIso, crewScope });
        const counts = ticketCountsByClient(rows, { days });
        return res.status(200).json({ days, counts: [...counts.entries()].map(([clientId, count]) => ({ clientId, count })) });
      }
      if (action === 'update' && req.method === 'POST') {
        const a = await requirePermission(req, res, 'problems.manage');
        if (!a) return;
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        // 🔴 CS-652: the ticket must be THIS organization's before anything is checked or
        // written — not only for crew: the photo gate below would otherwise answer another
        // org's ticket a 409. (getProblem pins the org; so does every write in updateProblem.)
        const target = await getProblem(body.id);
        if (!target) return res.status(404).json({ error: 'Problem not found' });
        // Crew may only triage a problem for an account they're assigned to (or one
        // they filed) — else 403. Managers unrestricted. Server-checked (open RLS).
        if (a.role === 'crew') {
          const scope = await crewScopeFor(a.role, a.orgUserId);
          const mine = (target.reported_by_user_id && target.reported_by_user_id === a.orgUserId)
            || (target.site_id && scope.siteIds.includes(target.site_id))
            || (target.client_id && scope.clientIds.includes(target.client_id));
          // D3 (the Cleaner Hub): a cleaner the office NAMED on THIS ticket may resolve it — and
          // only that — at a building that is not theirs (lib/crewRequests namedCompletionAllowed,
          // keyed on the stored crew_user_ids). The photo gate below still applies.
          if (!mine && !namedCompletionAllowed({ ticket: target, userId: a.orgUserId, update: body })) {
            return res.status(403).json({ error: 'Not your account' });
          }
        }
        // 🔴 CS-697: the office gives a ticket with NO location its location, so it can carry its
        // completion photo and be resolved (a ticket a location-less draft opened, or an older one,
        // sat overdue forever). Office only; one of the company's locations, and of the ticket's own
        // customer when it has one; only a ticket with none — the predicate rides on the update, so
        // a location never moves once set (a retry of the same location is the same answer).
        let located = null;
        if (body.siteId !== undefined) {
          if (a.role === 'crew') return res.status(403).json({ error: LOCATION_MESSAGES[LOCATION_CODES.officeOnly], code: LOCATION_CODES.officeOnly });
          if (target.site_id && target.site_id !== body.siteId) return res.status(409).json({ error: LOCATION_MESSAGES[LOCATION_CODES.set], code: LOCATION_CODES.set });
          const { state: book } = await readOrgState();
          const where = locationRefusal({ siteId: body.siteId, sites: book?.sites || [], clientId: target.client_id || null });
          if (where) return res.status(400).json({ error: LOCATION_MESSAGES[where], code: where });
          const site = (book?.sites || []).find((s) => s && s.id === body.siteId);
          const customer = (book?.clients || []).find((c) => c && c.id === site.clientId) || null;
          const loc = await setProblemLocation({ id: body.id, site, clientName: customer?.name || null });
          if (loc.notFound) return res.status(404).json({ error: 'Problem not found' });
          if (loc.hasLocation && loc.problem?.site_id !== site.id) return res.status(409).json({ error: LOCATION_MESSAGES[LOCATION_CODES.set], code: LOCATION_CODES.set });
          located = loc.problem;
        }
        // 🔴 THE CLEANERS ON THE TICKET (the Cleaner Hub, brief C §1; D3's other half): the office
        // routes a client request to the cleaners who will do it. OFFICE ONLY, by role — crew hold
        // problems.manage, so the key cannot tell the office apart (a role floor, like
        // canEndAccess) — and every one ADDED an active cleaner on the committed roster, the list
        // de-duplicated and bounded (lib/crewRequests checkCrewRouting; the demo stub runs it too).
        // Checked before anything is written; the newly added alone are rung, after the save.
        let routed = null;
        if (body.crewUserIds !== undefined) {
          const { state: book } = await readOrgState();
          const check = checkCrewRouting({ actorRole: a.role, crewUserIds: body.crewUserIds, users: book?.users || [], current: ticketCrewIds(target) });
          if (!check.ok) return res.status(check.code === CREW_ROUTING_CODES.officeOnly ? 403 : 400).json({ error: CREW_ROUTING_MESSAGES[check.code], code: check.code });
          routed = { before: ticketCrewIds(target), ids: check.ids };
        }
        // 🔴 WO-10 (Matt, 2026-09-29): "Is a completion photo required to close a ticket? —
        // (b) Always required." The photo is an account_media row at scope `problem_report`
        // with this ticket's id, which is the gallery the work-order drawer already shows.
        // Asked ONLY on the move to resolved (one indexed head count), so no other status
        // change — and no REOPEN — pays for it or is ever refused by it. The count read is the
        // boundary: the drawer's disabled button is UX. A read that FAILS refuses rather than
        // resolving blind, and says so in its own code.
        if (resolvePhotoRefusal({ status: body.status, photoCount: 1 }) === null
          && normalizeStatus(body.status) === 'resolved') {
          let photos = null;
          try { photos = await countProblemPhotos(body.id); } catch (e) {
            console.error('[qc/problems/update] photo count failed:', e?.code || 'read_failed');
            return res.status(503).json({ error: "Couldn't check this ticket's photos. Try again.", code: 'photo-check-failed' });
          }
          const refusal = resolvePhotoRefusal({ status: body.status, photoCount: photos });
          if (refusal) return res.status(409).json({ error: RESOLVE_PHOTO_MESSAGE, code: refusal });
        }
        const r = await updateProblem({ id: body.id, status: body.status, priority: body.priority, type: raisableType(body.type), category: body.category, assigneeUserId: body.assigneeUserId, escalated: body.escalated, title: body.title, description: body.description, crewUserIds: routed?.ids });
        if (r.notFound) return res.status(404).json({ error: 'Problem not found' });
        // The cleaners the office just ADDED hear it (best-effort; never fails the saved list).
        if (routed && r.problem) {
          const added = newlyRoutedCrew(routed.before, ticketCrewIds(r.problem));
          if (added.length) await notifyCrewRequestAssigned(r.problem, added, { actorUserId: a.orgUserId || null });
        }
        // D3 (Daniel, 2026-10-13: "Cleaner closes it"): a CLEANER's Mark Complete resolves the
        // request, and the account manager hears it — only when THIS change moved it to resolved
        // (a retried complete, or one racing another, rings nobody: updateProblem's resolve-once).
        if (a.role === 'crew' && r.problem && r.prev && r.prev.status !== 'resolved' && r.problem.status === 'resolved') {
          await notifyCrewRequestCompleted(r.problem, { cleanerUserId: a.orgUserId || null });
        }
        // CS-379 — a STATUS change only (LOG-2's "ticket status changes"). A priority or text
        // edit is not on the set list, so it is not logged; `prev` is only read when the status
        // moved, so nothing else pays for this.
        if (r.problem && r.prev && body.status && r.prev.status !== r.problem.status) {
          await logActivityAs(a, {
            action: 'ticket.status_changed',
            entityId: r.problem.id,
            clientId: r.problem.client_id || null,
            clientName: r.problem.client_name || null,
            summary: `Ticket "${String(r.problem.title || '').slice(0, 80)}": ${r.prev.status} → ${r.problem.status}`,
            before: { status: r.prev.status ?? null },
            after: { status: r.problem.status ?? null },
          });
          // HUB-11: the client who raised it hears about the new stage. Best-effort and
          // fail-closed (no sender connected = skipped, logged); never fails this change.
          await emailTicketStageChanged(r.problem, r.prev.status);
        }
        // A location alone (CS-697) changes nothing else: the ticket as it now is — without a
        // visitor's name and contact for a cleaner (QR-26).
        const after = r.problem ?? located ?? undefined;
        return res.status(200).json({ problem: a.role === 'crew' ? withoutVisitorReporter(after) : after });
      }
      // ── Message thread (Increment 2): read = qc.view, post = problems.manage.
      // Crew are scoped to work orders on their accounts (or ones they filed), like update. ──
      if (action === 'messages' && req.method === 'GET') {
        const a = await requirePermission(req, res, 'qc.view');
        if (!a) return;
        if (!req.query.problemId) return res.status(400).json({ error: 'problemId is required' });
        // CS-652: a thread is read only for a ticket of THIS organization — for the office too
        // (it used to answer another org's ticket with an empty thread rather than a 404).
        const target = await getProblem(req.query.problemId);
        if (!target) return res.status(404).json({ error: 'Work order not found' });
        if (a.role === 'crew') {
          const scope = await crewScopeFor(a.role, a.orgUserId);
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
          // D3: a NAMED cleaner's office-only note on THIS ticket (part of Mark Complete) — never a
          // reply to the customer (lib/crewRequests namedCompletionAllowed).
          if (!mine && !namedCompletionAllowed({ ticket: target, userId: a.orgUserId, message: body })) {
            return res.status(403).json({ error: 'Not your account' });
          }
        }
        // 🔴 WO-9: `internal: true` (the literal) is an office note the client never sees — the
        // hub excludes it in its query, it advances nothing and it emails nobody. Anything
        // else is an ordinary reply.
        const internal = body.internal === true;
        const message = await addWorkOrderMessage({ problemId: body.problemId, body: body.body.trim(), authorUserId: a.orgUserId, authorRole: a.role === 'crew' ? 'crew' : 'office', internal });
        // CS-379 — "ticket status changes AND replies". The reply TEXT is not copied into the
        // log (the thread is the record, and a copy would drift); the log says who replied and
        // when, which is what "who did what" needs.
        await logActivityAs(a, {
          action: 'ticket.replied',
          entityId: body.problemId,
          clientId: target.client_id || null,
          clientName: target.client_name || null,
          summary: internal
            ? `Internal note on ticket "${String(target.title || '').slice(0, 80)}"`
            : `Replied on ticket "${String(target.title || '').slice(0, 80)}"`,
        });
        // HUB-11: a reply on a ticket a client raised emails them (never an internal note).
        if (!internal) await emailTicketReplied(target, message);
        return res.status(200).json({ message });
      }
    }

    // ── Inspection / checklist templates (edit = manager; view = all roles) ──
    if (group === 'templates') {
      if (action === 'create' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        const clientId = idParam(body.clientId);
        if (clientId === undefined) return res.status(400).json({ error: 'clientId is malformed' });
        // ONE rule, shared with the demo stub: a CHECKLIST says whose it is, an INSPECTION
        // template never does (it stays company-wide).
        const refused = createTemplateRefusal({ kind: body.kind, clientId });
        if (refused) return res.status(400).json({ error: refused });
        if (clientId && !(await knownClient(clientId))) return res.status(400).json({ error: UNKNOWN_CUSTOMER });
        return res.status(200).json(await createTemplate({
          name: body.name, kind: body.kind, ratingScale: body.ratingScale, createdBy: g.orgUserId, clientId,
        }));
      }
      if (action === 'list' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        const filters = templateFilterParams(req, res); if (!filters) return;
        const scoped = await scopeTemplateFiltersToCrew(filters, await crewScopeFor(g.role, g.orgUserId), res);
        if (!scoped) return;
        // CS-669: each published row says whether a draft is waiting to be published
        // (`has_draft`), so the list can say "Published · unpublished changes" and offer Publish.
        const rows = await listTemplates(scoped);
        const drafts = await templatesWithDrafts(rows.filter((t) => t.is_published).map((t) => t.id));
        return res.status(200).json({ templates: rows.map((t) => ({ ...t, has_draft: !!t.is_published && drafts.has(t.id) })) });
      }
      // "Start from…" — a starter, or another customer's checklist, copied into this
      // customer ready to edit. Each building's checklist is its own row (R2), so this is a
      // new template and never a shared one; the source is untouched.
      if (action === 'copy' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        const id = idParam(body.id);
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        if (id === undefined) return res.status(400).json({ error: 'id is malformed' });
        const clientId = idParam(body.clientId);
        if (clientId === undefined) return res.status(400).json({ error: 'clientId is malformed' });
        if (!clientId) return res.status(400).json({ error: CHECKLIST_NEEDS_CUSTOMER });
        if (!(await knownClient(clientId))) return res.status(400).json({ error: UNKNOWN_CUSTOMER });
        const r = await copyTemplate({ id, clientId, name: body.name, createdBy: g.orgUserId });
        if (r.notFound) return res.status(404).json({ error: 'Template not found' });
        if (r.refused) return res.status(400).json({ error: r.refused });
        return res.status(200).json(r);
      }
      // Step 6's problems summary: every CHECKLIST in the org, narrow and complete — who
      // holds it, whether it is published, how many items. Read at ~750 customers, so it is
      // paged, never a newest-N slice (UI_RULES §117: anything that COUNTS reads completely).
      //
      // OFFICE ONLY, never `qc.view` (F1). This response IS the map of the customer book —
      // every customer that holds a checklist, in one read — so it cannot sit behind an
      // all-roles key.
      //
      // EITHER office key opens it (step 6, L3 S2): `qc.templates.edit` manages checklists,
      // `ops.edit` ASSIGNS them, and step 6's Assignments screen is gated on the second.
      // Every name, item count and problem tile there comes from this read, so behind
      // `qc.templates.edit` alone a viewer who may assign but not manage templates saw
      // "Assigned checklist" and four zeroes — a silent wrong answer instead of a refusal.
      // Both are governed by the Roles matrix, not a hard-coded role list, so the 4th-tier
      // manager and any per-user grant are included; crew hold NEITHER, so F1's boundary is
      // unmoved. Two checks rather than an any-of helper, because authz.js has none and
      // this is the only caller that needs one.
      if (action === 'summary' && req.method === 'GET') {
        const a = await requireAuthority(req, res); if (!a) return;       // writes the 401
        const mayRead = (await holdsPermission(a, 'qc.templates.edit'))
          || (await holdsPermission(a, 'ops.edit'));
        // holdsPermission fails closed, so an unreadable matrix refuses rather than opens.
        if (!mayRead) return res.status(403).json({ error: 'Insufficient permissions' });
        return res.status(200).json({ templates: await templatesSummary() });
      }
      if (action === 'get' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
        const id = templateIdParam(req.query.id, res); if (!id) return;
        const r = await getTemplate(id);
        if (!r) return res.status(404).json({ error: 'Template not found' });
        return res.status(200).json(r);
      }
      if (action === 'save' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        const id = templateIdParam(body.id, res); if (!id) return;
        // The store translates every section and item into Spanish and Creole before it saves
        // (CS-850; src/lib/checklistI18n fillSchemaTranslations) — nobody checks a line.
        const r = await saveTemplate(id, { name: body.name, ratingScale: body.ratingScale, schema: body.schema });
        if (r?.notFound) return res.status(404).json({ error: 'Template not found' });
        return res.status(200).json({ version: r });
      }
      if (action === 'publish' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        const id = templateIdParam(body.id, res); if (!id) return;
        const r = await publishTemplate(id);
        if (r.nothing) return res.status(400).json({ error: 'Nothing to publish' });
        // An item-less CHECKLIST can never be completed, so publishing one is refused
        // (src/lib/inspections.publishRefusal — the same rule the demo stub applies).
        if (r.refused) return res.status(400).json({ error: r.refused });
        return res.status(200).json(r);
      }
      if (action === 'delete' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.templates.edit'); if (!g) return;
        const id = templateIdParam(body.id, res); if (!id) return;
        return res.status(200).json(await deleteTemplate(id));
      }
    }

    // ── Inspection records (perform = manager via qc.inspect; view = all roles) ──
    if (group === 'inspections') {
      if (action === 'create' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        // 🔴 CS-697 (CS-128's "require a site"): an inspection is started at a location — its
        // photos, its report and any ticket a failure opens are filed there; one started with no
        // location opened a ticket nobody could ever close.
        const { state: book } = await readOrgState();
        const where = locationRefusal({ siteId: body.siteId, sites: book?.sites || [] });
        if (where) return res.status(400).json({ error: LOCATION_MESSAGES[where], code: where });
        const r = await createInspection({ templateId: body.templateId, clientId: body.clientId, siteId: body.siteId, jobId: body.jobId, timeEntryId: body.timeEntryId, inspectorUserId: g.orgUserId });
        if (r.notFound) return res.status(404).json({ error: 'Template not found' });
        if (r.notPublished) return res.status(400).json({ error: 'Publish the template before inspecting with it' });
        // D9 — RETENTION AT THE WRITE POINT: the write that makes drafts also clears the ones
        // nobody has touched for 30 days (with their items and photos), a bounded few per call.
        // Best-effort: the new inspection is already made, and a failed sweep runs again next time.
        try { await pruneStaleInspectionDrafts(); } catch (e) {
          console.error('[qc/inspections/create] the stale drafts were not cleared:', e?.code || 'error');
        }
        return res.status(200).json({ inspection: r.inspection });
      }
      // ── Finish it later (Matt, 2026-10-06; lib/inspectionDrafts D7–D9; EP-355..EP-358) ──
      // AUTH STANCE: requirePermission('qc.inspect') — the people who perform inspections — and
      // then WHO, from the login's claim (never the body): the inspector who started the draft, or
      // the office (owner / admin). A manager cannot continue another manager's draft (403).
      // Anything that is not a draft is a 409 and nothing is written.
      //
      // save-draft writes the draft's items, its office-only note and `updated_at`, and NOTHING
      // else: no score, no result, no bell, no ticket, no client email, no activity row (D8 —
      // every one of those is Submit's, below, and fires once).
      if (action === 'save-draft' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        const id = draftIdParam(body.id, res); if (!id) return;
        if (body.items != null && !Array.isArray(body.items)) return res.status(400).json({ error: 'items must be a list' });
        if (Array.isArray(body.items) && body.items.length > MAX_DRAFT_ITEMS) return res.status(400).json({ error: `At most ${MAX_DRAFT_ITEMS} items` });
        if (body.internalNote != null && typeof body.internalNote !== 'string') return res.status(400).json({ error: 'internalNote must be text' });
        const r = await saveInspectionDraft({ id, items: body.items || [], internalNote: body.internalNote, actor: draftActor(g) });
        if (draftRefusal(res, r)) return;
        return res.status(200).json({ inspection: r.inspection, items: r.items });
      }
      // Continue: the draft with its saved items. The share token goes only to a caller who may
      // share (the list's gate); the office-only note is theirs — qc.inspect is the gate above.
      if (action === 'draft' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        const id = draftIdParam(req.query.id, res); if (!id) return;
        const r = await getInspectionDraft({ id, actor: draftActor(g) });
        if (draftRefusal(res, r)) return;
        if (!(await holdsPermission(g, 'qc.share'))) stripShareToken(r.inspection);
        return res.status(200).json({ inspection: r.inspection, items: r.items });
      }
      // Discard: the draft, its items and its photos (rows and Storage objects). The status
      // predicate rides on the delete, so a draft submitted meanwhile is never touched.
      if (action === 'discard' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        const id = draftIdParam(body.id, res); if (!id) return;
        const r = await discardInspectionDraft({ id, actor: draftActor(g) });
        if (draftRefusal(res, r)) return;
        return res.status(200).json({ ok: true, photos: r.photos });
      }
      // The CALLER's own open drafts (inspector = the login), newest saved first, optionally at
      // one building: what the form asks before starting a new inspection there.
      if (action === 'drafts' && req.method === 'GET') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        const siteId = idParam(req.query.siteId);
        if (siteId === undefined) return res.status(400).json({ error: 'siteId is malformed' });
        return res.status(200).json({ drafts: await listMyInspectionDrafts({ inspectorUserId: g.orgUserId || null, siteId }) });
      }
      if (action === 'submit' && req.method === 'POST') {
        const g = await requirePermission(req, res, 'qc.inspect'); if (!g) return;
        if (!body.id) return res.status(400).json({ error: 'id is required' });
        // HUB-16: the office-only note rides with the submit. `qc.inspect` is the gate
        // already passed above — the people who write inspections are the people the note
        // is for — and `undefined` means "said nothing", which leaves an existing note
        // alone (the store's rule). A DRAFT is finished only by its inspector or the office
        // (the same WHO the draft routes apply), so the actor comes from the login.
        const r = await submitInspection({ id: body.id, items: body.items, internalNote: body.internalNote, actor: draftActor(g) });
        if (r.notFound) return res.status(404).json({ error: 'Inspection not found' });
        if (draftRefusal(res, r)) return;
        // CS-379 — a first submit and a re-submit of an already-submitted inspection are
        // different events (LOG-2 lists both), and the score before and after is the
        // before/after LOG-3 asks for. Best-effort; the inspection is already saved.
        {
          const rec = r.inspection;
          const wasSubmitted = r.prev?.status === 'submitted';
          const score = (x) => (x?.overall_score != null ? `${x.overall_score}%` : 'no score');
          await logActivityAs(g, {
            action: wasSubmitted ? 'inspection.edited' : 'inspection.submitted',
            entityId: rec.id,
            clientId: rec.client_id || null,
            clientName: rec.client_name || null,
            summary: wasSubmitted
              ? `Inspection edited at ${rec.site_name || rec.client_name || 'an account'}: ${score(r.prev)} → ${score(rec)}`
              : `Inspection submitted at ${rec.site_name || rec.client_name || 'an account'}: ${rec.result || 'scored'} ${score(rec)}`,
            before: wasSubmitted ? { status: r.prev?.status ?? null, score: r.prev?.overall_score ?? null, result: r.prev?.result ?? null } : { status: r.prev?.status ?? null },
            after: { status: rec.status ?? null, score: rec.overall_score ?? null, result: rec.result ?? null },
          });
          // HUB-11: a NEW inspection is posted to the building's client users (an edit of one
          // already submitted is not news). Best-effort; never the internal note.
          if (!wasSubmitted) await emailInspectionPosted(rec);
        }
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
        let clientIds = (state?.clients || []).filter(isActiveBuilding).map((c) => c.id);
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
        // …and the office-only note goes only to a caller who performs inspections.
        if (!(await holdsPermission(g, 'qc.inspect'))) stripInternalNote(r.inspection);
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
        // HUB-16: the office-only note travels BESIDE the report document, never inside
        // it, and only to a caller who performs inspections. `r.report` is what
        // `buildInspectionReportHtml` is handed, so the note can never reach the page,
        // the PDF or a share from here.
        const mayReadNote = await holdsPermission(g, 'qc.inspect');
        return res.status(200).json(mayReadNote ? { ...r.report, internalNote: r.internalNote } : r.report);
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
        // CS-690: a fill counts for the clean it names only inside that clean's window (or while
        // on the clock there); `filledAt` is the phone's time for a fill it kept offline, which
        // the store never lets land later than now. Not on the clean → kept, but not for it.
        const r = await submitChecklist({
          templateId: body.templateId, clientId: body.clientId, siteId: body.siteId, jobId: body.jobId, items: body.items,
          completedByUserId: g.orgUserId, clientSubmitId: typeof body.clientSubmitId === 'string' ? body.clientSubmitId.slice(0, 64) : null,
          filledAt: body.filledAt, crew: !!crewScope,
        });
        if (r.notFound) return res.status(404).json({ error: 'Template not found' });
        // A scored INSPECTION template named as a checklist: its own code so the client can
        // tell it apart from "publish it first", and nothing was stored (CS-494 review F-B).
        if (r.notChecklist) return res.status(400).json({ error: r.notChecklist, code: NOT_A_CHECKLIST_CODE });
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
        // The newest CHECKLIST_LIST_LIMIT, and how many match in all (CS-335): the Quality
        // hub's tab says "Showing the newest N of M" from `total` / `truncated`. Counted only
        // when the list came back full — a shorter list IS the total.
        const listFilters = { siteId: req.query.siteId || null, jobId: req.query.jobId || null, crewScope };
        const checklists = await listChecklists(listFilters);
        const total = checklists.length < CHECKLIST_LIST_LIMIT
          ? checklists.length
          : Math.max(checklists.length, await countChecklists(listFilters));
        return res.status(200).json({ checklists, total, truncated: total > checklists.length });
      }
    }

    // ── QR-1 / HUB-15: a building's AREAS, each with its last clean ───────────
    // EP-200. `GET /api/qc/areas/status?siteId=` — one row per `site.cleaningAreas` entry:
    // when that area was last finished, the items done in it, and its newest photo
    // (api/_lib/qc/store.areaStatusForSite, the ONE function Round 2's public QR page and
    // the client hub will also read through).
    //
    // AUTH STANCE: requirePermission('qc.view') — it is a QC record read like every other
    // one here — and crew are held to the building, not merely scoped inside it: a crew
    // member outside this site gets 403 rather than an empty-looking answer, which is how
    // `problems/update` and `inspections/get` already answer. There is NO public branch
    // here; the scan page is Round 2's and will carry its own token gate.
    if (group === 'areas' && action === 'status' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'qc.view'); if (!g) return;
      const siteId = idParam(req.query.siteId);
      if (siteId === undefined) return res.status(400).json({ error: 'siteId is malformed' });
      if (!siteId) return res.status(400).json({ error: 'siteId is required' });
      const crewScope = await crewScopeFor(g.role, g.orgUserId);
      if (crewScope && !crewScope.siteIds.includes(siteId)) return res.status(403).json({ error: 'Not your account' });
      const r = await areaStatusForSite({ siteId, crewScope });
      if (r.notFound) return res.status(404).json({ error: 'Location not found' });
      return res.status(200).json(r);
    }

    // ── Reports › Inspections / site · Checklists / site ──────────────────────
    // Tallied SERVER-side over EVERY record in the window (a complete, paged read)
    // with the same pure aggregators the demo stub runs, so the browser receives one
    // row per site instead of every record: a year of nightly checklists at ~750
    // sites is ~200k rows, far past any single response. Gated like the Reports page
    // (reports.view); crew-scoped as defense in depth should a crew user ever hold it.
    // The Manager/Customer scoping + live names are applied by the client.
    // ── EP-416 — Reports → Visitor ratings (QR-30, Matt 2026-10-16: "only the office sees the
    // results, by building"). AUTH STANCE: the Reports page's own key (reports.view) AND qc.view — the
    // votes are about how clean an area is, read like the other quality reports, so a supply manager's
    // Reports stays Supply usage alone (S131) — AND an office role by the login's claim: never crew,
    // whatever a per-user grant says; a customer login never reaches this route at all. A period of 7, 30 or 90 ORG days (today included); every vote
    // in it read completely (api/_lib/scanCodes/visitor listRatingsInPeriod) and tallied by the one
    // rule (lib/areaRatings visitorRatingsReport): by building, worst first, with its areas. Nothing
    // about a phone is read or answered.
    if (group === 'reports' && action === 'visitor-ratings' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reports.view'); if (!g) return;
      const q = await requirePermission(req, res, 'qc.view'); if (!q) return;
      if (!isOfficeRole(g.role)) return res.status(403).json({ error: 'Visitor ratings are for the office.', code: 'office-only' });
      const days = ratingPeriodDays(req.query.days);
      if (days === null) return res.status(400).json({ error: `days must be one of ${RATING_PERIODS.join(', ')}`, code: 'days' });
      const { state } = await readOrgState();
      const win = ratingPeriodWindow({ days, nowMs: Date.now(), timeZone: state?.company?.timezone || null });
      const rows = await listRatingsInPeriod(win);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ days, ...win, ...visitorRatingsReport(rows, { sites: state?.sites || [], clients: state?.clients || [] }) });
    }

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
      // EP-360 — Reports → Time to resolve (Matt's KPI, the Oct 6 call; plan 2026-10-11 §4, D10/D12):
      // every ticket RESOLVED in the period, of every origin (the office's own count, unlike the
      // hub's), read completely and tallied here by the ONE rule (src/lib/resolveTime.js) — company-
      // wide, by type and by customer, with the median and "within the deadline". Manager narrows ON
      // THE SERVER to that supervisor's buildings (the work-order queue's rule, problems/list): a
      // median and a deadline tally cannot be added up from per-customer rows in the browser, so the
      // figures must be computed over exactly the tickets asked for. A supervisor with no buildings
      // reads nothing (an empty id set matches no row), never the whole company.
      if (action === 'resolve-time') {
        const supervisorId = idParam(req.query.supervisorId);
        if (supervisorId === undefined) return res.status(400).json({ error: 'supervisorId must be one id' });
        let clientIds;
        if (supervisorId) {
          const { state } = await readOrgState();
          // `team` (S131): the caller's team, from the claim and the committed roster — the queue's rule.
          clientIds = supervisorId === TEAM
            ? [...teamClientIds(state?.users || [], state?.clients || [], g.role === 'manager' ? g.orgUserId : null)]
            : (state?.clients || []).filter((c) => c && c.supervisorId === supervisorId).map((c) => c.id);
        }
        const rows = await resolvedProblemsInWindow({ ...win, clientId, clientIds, crewScope, maxRows: REPORT_MAX_ROWS });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).json({ fromIso: win.fromIso, toIso: win.toIso, ...resolveReport(rows, { from: win.fromIso, to: win.toIso }) });
      }
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    // CS-077 class: an error BODY never carries provider text. It used to return
    // `e.message`, so a Postgres complaint — table names, column names, a fragment of the
    // statement — went to the browser from any branch that threw. The detail is logged
    // server-side instead, and the caller gets a stable `code` to branch on.
    //
    // The two READ errors this route raises itself are the exception, and deliberately so:
    // their text is ours and is the instruction ("This read spans N rows … narrow the date
    // range", "Read N of M rows … try again"), which is the whole reason they exist.
    // Deliberate 4xx refusals return above and never reach here.
    const status = readErrorStatus(e);
    console.error('[api/qc]', `${group || '?'}/${action || '?'}`, e?.code || e?.name || 'error', e?.message || '');
    if (status === 413 || status === 503) return res.status(status).json({ error: e.message, code: e.name });
    return res.status(500).json({ error: 'Something went wrong. Try again.', code: 'qc_server_error' });
  }
}
