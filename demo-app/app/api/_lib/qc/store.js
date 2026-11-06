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
import { listMedia, listMediaRawByRefs, signMediaRow, removeMediaForRefs } from '../accountMedia/store.js';
import { selectAll, exactCount, rangeFill, withRetry } from '../pagedSelect.js';
import { ID_RE } from '../queryParams.js';
import {
  scoreInspection, INSPECTION_LIST_LIMIT, CHECKLIST_LIST_LIMIT, inspectionFigures, publishRefusal,
  copyTemplateRefusal, planTemplateCopy, toTemplateSummaryRow, countSchemaItems,
  redoAreasFor, templateDraftSave, pendingTemplateOf, withPendingTemplate, withoutPendingTemplate,
} from '../../../src/lib/inspections.js';
import {
  DRAFT_STATUS, DRAFT_LIST_MAX, DRAFT_RETENTION_SWEEP_MAX,
  mayWorkDraft, sanitizeDraftItems, draftProgress, draftStaleBeforeIso, submittedPerformedAt,
} from '../../../src/lib/inspectionDrafts.js';
import { openPunchUserIdsAt } from '../time/store.js';
import { getJobById, getJobsAtSite } from '../jobsTable.js';
import {
  owesFailedInspectionTicket, failedInspectionTicketInput, failedInspectionCrew,
  siteCrewWindow, siteCleansInWindow,
} from '../../../src/lib/failedInspectionTicket.js';
import { countChecklistSubmission, checklistSubmitRefusal, checklistPhotoRequiredKeys, sanitizeChecklistItems } from '../../../src/lib/checklistCount.js';
import { areaCompletionTimes, siteAreaStatus, siteAreaCompletions, areasPastThePage } from '../../../src/lib/checklistAreas.js';
import { checklistMadeAt, madeInCleanWindow, checklistCountsForClean } from '../../../src/lib/checklistWindow.js';
import { CLOCK_IN_LEAD_MS } from '../../../src/lib/clockInWindow.js';
import {
  fanOutManagerAlert, fanOutToUserIds, fanOutAccountAlert, REDO_EVENT_KEY,
  isNotificationVisibleForUser, ticketFanOut,
  CREW_REQUEST_ASSIGNED_EVENT, CREW_REQUEST_COMPLETED_EVENT,
} from '../../../src/lib/notifications.js';

// A CUSTOMER's ticket (origin 'portal') routes by HUB-21 (Matt, (a)): the building's manager, else
// the Admins, as a customer's message does; every other ticket by WO-6 (the manager, else the
// office bench). lib/notifications ticketFanOut is the one chooser, shared with every repeat
// (lib/opsAlertApply), so a request rings the same people from its first alert to its last.
const ticketRoute = (problem) => ticketFanOut(problem?.origin);
import {
  computeDueAt, normalizePriority, normalizeStatus, severityToPriority,
  WO_TYPES, WO_ORIGINS, WO_PRIORITIES, WO_STATUSES, normalizeCategory,
  WO_RESOLVED_PAGE, WO_RESOLVED_PAGE_MAX, WO_RESOLVED_RECENT_HOURS, VISITOR_ORIGIN,
} from '../../../src/lib/workOrders.js';
import { ticketAreaColumnReady } from './ticketColumns.js';
import { ticketRaisedEventKey } from '../../../src/lib/ticketAlerts.js';
import { msg } from '../../../src/i18n/core.js';
import { sanitizeSchemaTranslations, fillSchemaTranslations } from '../../../src/lib/checklistI18n.js';
import { translateAll } from '../translateStore.js';
import { orgProperNouns } from '../../../src/i18n/terms.js';
import { crewPaths } from '../../../src/lib/crewPaths.js';
import { CREW_REQUEST_DONE_DAYS } from '../../../src/lib/crewRequests.js';

// Every ticket alert deep-links to the Work Orders queue in the Quality hub. One literal, shared
// with the repeat copy (src/lib/opsAlertCopy) so the creation row and the nudges land together.
const TICKETS_URL = '/inspections?tab=workorders';
// …and an alert about ONE ticket's conversation opens that ticket's drawer (`wo`, read by
// components/WorkOrdersPanel), so the person rung lands on the message, not on the queue.
export const ticketDeepLink = (id) => `${TICKETS_URL}&wo=${encodeURIComponent(id)}`;
// 🔴 A CLEANER's row about a ticket opens it in THEIR app — the Cleaner Hub's request page
// (lib/crewPaths), never the office's Quality hub (the Cleaner Hub, 2026-10-13, brief C §1). The
// office's rows keep the drawer. Handed to a fan-out as a per-recipient link (lib/notifications).
export const ticketLinkFor = (id) => (user) => (user?.role === 'crew' ? crewPaths.request(id) : ticketDeepLink(id));

const nowIso = () => new Date().toISOString();
// 22P02 is Postgres saying an id is not a uuid at all (inspection_records.id and
// problem_reports.id are uuids): it names no row, so a read by such an id reads as none — as it
// did when these reads ignored their errors — while any other failed read throws (CS-649, CS-652).
const notAnId = (error) => error?.code === '22P02';

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
// `id` (optional) is a CALLER-MINTED uuid (THE LAW II.7), so a retried create can be
// recognised as the same ticket: the client hub mints one per ticket and reads it back before
// inserting, and the primary key turns a concurrent second insert into a 23505 the hub route
// answers with the winner (api/hub ticket-create). The office's own create still lets the
// database mint it. `raisedByClientUserId` / `raisedByClientName` record WHICH client user
// raised a hub ticket (HUB-13) — the hub stamps them from the verified claim, never the body —
// and every one of the three is written only when set, so an office create sends exactly the
// columns it always did. WO-19's two (`inspectionId`, `crewUserIds`: the failed inspection a
// ticket was opened for, and that building's cleaners) follow the same rule — only the
// failed-inspection ticket (openFailedInspectionTicket below) sends them.
//
// QR-16 / QR-23 (2026-10-17): `siteAreaId` — the building area the ticket is about, ALREADY checked
// against the location by the caller (lib/workOrders ticketAreaInput, or the scanned code's own
// area) — is written only once the column exists (./ticketColumns.js: migration 20261017110000 is
// written, not applied; until then the area is left off and the ticket still goes through). The
// visitor's `reporterName` / `reporterContact` are written only on a VISITOR's ticket (the
// migration's CHECK holds the same), and only by the public route.
export async function createProblem({ id = null, clientId, siteId, jobId, title, description, priority, severity, type, origin, category, assigneeUserId, reportedByUserId, raisedByClientUserId = null, raisedByClientName = null, inspectionId = null, crewUserIds = null, siteAreaId = null, reporterName = null, reporterContact = null }) {
  const names = await resolveNames({ clientId, siteId });
  const prio = normalizePriority(priority || severityToPriority(severity));
  const storedType = WO_TYPES.includes(type) ? type : 'issue';
  const storedOrigin = WO_ORIGINS.includes(origin) ? origin : 'internal';
  const createdAt = nowIso();
  const db = getSupabase();
  const area = typeof siteAreaId === 'string' && siteAreaId ? siteAreaId : null;
  const writeArea = area ? await ticketAreaColumnReady(db) : false;
  if (area && !writeArea) console.warn('[qc/store] createProblem: the ticket area column is not there yet; the area was left off');
  const visitor = storedOrigin === VISITOR_ORIGIN;
  const { data, error } = await db.from('problem_reports').insert({
    ...(id ? { id } : {}),
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
    type: storedType,
    origin: storedOrigin,
    // WO-12: nullable, and NOT defaulted to 'other' — a ticket nobody categorized reads as
    // uncategorized, which is honest; the vocabulary is the one shared list.
    category: normalizeCategory(category),
    priority: prio,
    status: 'open',
    created_at: createdAt,
    // WO-20 / WO-21: the deadline by lib/workOrders' one rule — the TYPE for a client request, the
    // urgency for an issue. (Every read derives it the same way; this is the cache.)
    due_at: computeDueAt(createdAt, { type: storedType, priority: prio }),
    ...(raisedByClientUserId ? { raised_by_client_user_id: raisedByClientUserId, raised_by_client_name: raisedByClientName || null } : {}),
    ...(inspectionId ? { inspection_id: inspectionId } : {}),
    ...(Array.isArray(crewUserIds) ? { crew_user_ids: crewUserIds.filter((u) => typeof u === 'string' && u) } : {}),
    ...(writeArea ? { site_area_id: area } : {}),
    ...(visitor && reporterName ? { reporter_name: reporterName } : {}),
    ...(visitor && reporterContact ? { reporter_contact: reporterContact } : {}),
  }).select('*').single();
  if (error) throw error;
  return data;
}

// 🔴 WO-19 (Matt, Review WO-19 (a), 2026-10-09): "A failed inspection should create a ticket and
// automatically assign it to the account manager and cleaners of that site." Opened from
// submitInspection when the result is a FAIL; the rules (when, who, what it says) are
// src/lib/failedInspectionTicket's, shared with the demo stub so the two open the same ticket.
//
// ONE PER INSPECTION: the ticket already linked to this inspection is returned as it is — a
// replayed submit, or an edit of a submitted inspection, never opens a second one — and two
// submits racing past that read meet the unique index on problem_reports.inspection_id
// (migration 20261009120000), whose 23505 is answered with the winner.
//
// BEST-EFFORT, like the alerts below: the inspection is already saved, and a ticket that could
// not be opened (a read that failed; the migration not yet applied) is logged by its code and
// leaves the submit, the office's bell and the cleaners' redo notice exactly as they were.
export async function openFailedInspectionTicket(rec, items) {
  if (!owesFailedInspectionTicket(rec)) return null;
  try {
    const existing = await ticketForInspection(rec.id);
    if (existing) return existing;
    const { state } = await readOrgState();
    const crewUserIds = await failedInspectionCrewFor(rec, state?.users || []);
    try {
      return await createProblem(failedInspectionTicketInput({ rec, items, state, crewUserIds }));
    } catch (e) {
      if (e?.code === '23505') return await ticketForInspection(rec.id);
      throw e;
    }
  } catch (e) {
    console.error('[qc/inspections/submit] the failed-inspection ticket was not opened:', e?.code || 'error');
    return null;
  }
}

// The ticket a failed inspection opened, or null.
async function ticketForInspection(inspectionId) {
  const { data, error } = await getSupabase().from('problem_reports').select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('inspection_id', inspectionId)
    .order('created_at', { ascending: true }).limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

// The building's cleaners for the ticket: the inspected visit's crew, else every clean at the
// site in the week up to the inspection (read only when the visit names nobody). A jobs read
// that fails costs the ticket its cleaners, never the ticket: the account manager still gets
// it, and the failure is logged by its code.
async function failedInspectionCrewFor(rec, users) {
  try {
    return await readFailedInspectionCrew(rec, users);
  } catch (e) {
    console.error('[qc/inspections/submit] the cleaners for a failed inspection were not read:', e?.code || 'error');
    return [];
  }
}
async function readFailedInspectionCrew(rec, users) {
  const inspectorUserId = rec.inspector_user_id || null;
  const visit = rec.job_id ? await getJobById(rec.job_id) : null;
  const fromVisit = failedInspectionCrew({ visit, users, inspectorUserId });
  if (fromVisit.length || !rec.site_id) return fromVisit;
  const span = siteCrewWindow(rec.performed_at);
  if (!span) return fromVisit;
  const siteJobs = siteCleansInWindow(await getJobsAtSite(rec.site_id, span), { siteId: rec.site_id, ...span });
  return failedInspectionCrew({ visit: null, siteJobs, users, inspectorUserId });
}

// Fan out the bell row for a NEW ticket — server-side so the office hears even with no tab
// open (the push-dispatch cron delivers the row to their devices). CAS-guarded against a
// concurrent org_state write, and fully best-effort: a failure here must never fail the
// already-persisted report.
//
// 🔴 WO-6 (Matt, 2026-09-29): "Who should a new ticket go to first? — (a) The account's
// supervisor; the office if there's no supervisor or no reply." ★ It used to blanket the whole
// office bench for every ticket (`fanOutManagerAlert`), which is what made ticket alerts
// everybody's and therefore nobody's. A customer's request with no manager rings the Admins
// instead of the office (HUB-21, Matt, 2026-10-08). `ticketRoute` (lib/notifications ticketFanOut)
// is the ONE reader of both rules, shared with every later repeat (lib/opsAlertApply), so the
// first alert and the tenth route the same way (CS-639). Replaces `notifyManagersOfProblem` (II.5 — renamed because it no longer
// notifies managers).
//
// 🔴 WO-7: the ROW is written whatever the hour — it is what the office finds waiting, and the
// ticket must never go unrecorded. Whether it also buzzes a phone tonight is the push
// dispatcher's call (src/lib/alertDelivery: an urgent ticket at any hour, the rest at 8 a.m.).
export async function notifyTicketRaised(problem, tries = 4) {
  if (!problem) return;
  try {
    const place = problem.client_name || problem.site_name || null;
    // WO-18: three priorities, and only URGENT earns a word in the subject line — the
    // other two are the ordinary case and a prefix on every row says nothing. A message, so
    // the supervisor reads it in their own language (CS-193).
    const urgent = normalizePriority(problem.priority) === 'urgent';
    const title = place
      ? msg(urgent ? 'alerts.ticketRaised.titleUrgent' : 'alerts.ticketRaised.title', { place })
      : msg(urgent ? 'alerts.ticketRaised.titleUrgentNoPlace' : 'alerts.ticketRaised.titleNoPlace');
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const notifications = ticketRoute(problem)({ ...state, notifications: state.notifications || [] }, {
        clientId: problem.client_id || null,
        eventKey: ticketRaisedEventKey(problem.priority),
        title,
        body: problem.title || '',
        url: TICKETS_URL,
        actorUserId: problem.reported_by_user_id || null,
      });
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return;
    }
  } catch { /* best-effort — the report is already saved */ }
}

// HUB-13, the other direction: a CUSTOMER's message on their own ticket (the client hub,
// api/hub ticket-message) rings the office, or the conversation is a dead end — a customer
// answering "we need more information from you" would reach nobody, because only the stage
// moves. (Phase 2 Wave 2 Round 2 follow-up.)
//
// WHO — the route a new ticket takes, with the person already on it first:
//   · the ticket's ASSIGNEE, when it has one who can take a ticket alert (on the roster,
//     active, an office tier the event is visible to — a cleaner assigned to the ticket cannot,
//     the ticket events being office-only);
//   · otherwise the route notifyTicketRaised uses (ticketRoute: the building's manager, else the
//     Admins for a customer's request (HUB-21) or the office bench for any other — never nowhere).
//   A recipient who muted the event is respected, exactly as for a new ticket.
// WHEN — the creation ping's own event key (ticketRaisedEventKey), so the push dispatcher
// treats it as it treats a new ticket (WO-7): an urgent ticket's reply rings at any hour, the
// rest wait for office hours (lib/alertDelivery). The bell row itself is written at once.
// NOT A REPLY — a customer's message is never the staff reply that stops the repeat alerts
// (firstStaffReplyByProblem filters author_role 'client'), and only a CLIENT's, non-internal
// message comes here: the office writing on its own thread rings nobody.
// Best-effort and CAS-guarded like notifyTicketRaised: it never fails the customer's message.
export async function notifyClientReplied(problem, message, tries = 4) {
  if (!problem?.id || !message || message.author_role !== 'client' || message.internal === true) {
    return { sent: false, reason: 'not-a-client-message' };
  }
  try {
    const place = problem.client_name || problem.site_name || null;
    const eventKey = ticketRaisedEventKey(problem.priority);
    const urgent = normalizePriority(problem.priority) === 'urgent';
    const text = String(message.body || '').replace(/\s+/g, ' ').trim();
    const said = text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
    // WO-18: only URGENT earns a word in the title, as on the new-ticket row. A message, so
    // each reader gets it in their own language (CS-193, LANG-4), like notifyTicketRaised.
    const title = place
      ? msg(urgent ? 'alerts.ticketReplied.titleUrgent' : 'alerts.ticketReplied.title', { place })
      : msg(urgent ? 'alerts.ticketReplied.titleUrgentNoPlace' : 'alerts.ticketReplied.titleNoPlace');
    // The ticket's title and the customer's words are THEIRS, quoted as written (LANG-7:
    // messages stay as written); only a ticket with no title gets words of ours.
    const body = problem.title ? `${problem.title}: “${said}”` : msg('alerts.ticketReplied.bodyNoTitle', { said });
    const url = ticketDeepLink(problem.id);
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const base = { ...state, notifications: state.notifications || [] };
      const assignee = alertableAssignee(base, problem.assignee_user_id, eventKey);
      const notifications = assignee
        ? fanOutToUserIds(base, { userIds: [assignee.id], eventKey, title, body, url, actorUserId: null })
        : ticketRoute(problem)(base, { clientId: problem.client_id || null, eventKey, title, body, url, actorUserId: null });
      if (notifications === base.notifications) return { sent: false, reason: 'nobody-to-ring' };
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return { sent: true };
    }
    return { sent: false, reason: 'cas-exhausted' };
  } catch {
    return { sent: false, reason: 'error' };   // the customer's message is already saved
  }
}

// The ticket's assignee, when they can take an alert under this event key; else null.
function alertableAssignee(state, assigneeUserId, eventKey) {
  if (!assigneeUserId) return null;
  const user = (state.users || []).find((u) => u && u.id === assigneeUserId);
  if (!user || user.status !== 'active') return null;
  return isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides) ? user : null;
}

// ── Ticket alerting reads (WO-2..7, WO-16) ───────────────────────────────────
// The two reads the repeat/escalation walker needs (src/lib/ticketAlerts). Both are COMPLETE
// over their window, for the same reason every other alert read is: a capped read would drop
// exactly the oldest unanswered tickets — the ones the repeat exists to find — and an alert
// engine that silently stops at the page boundary is worse than one that is off.

// Every ticket that could still be chased: not resolved, raised inside the walker's look-back.
// Narrow projection (the walker needs no description and no names), and `id` is in it because
// selectAll dedupes overlapping pages BY it.
export const TICKET_ALERT_COLUMNS = 'id, client_id, type, priority, status, created_at, due_at, title, origin';
export async function openTicketsForAlerts({ sinceIso } = {}) {
  const db = getSupabase();
  const base = () => db.from('problem_reports').select(TICKET_ALERT_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .neq('status', 'resolved')
    .gte('created_at', sinceIso);
  return selectAll({
    count: async () => {
      const { count, error } = await db.from('problem_reports').select('id', { count: 'exact', head: true })
        .eq('organization_id', CLEANSPACE_ORG_ID)
        .neq('status', 'resolved')
        .gte('created_at', sinceIso);
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await base()
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
}

// The FIRST office/crew reply per ticket — Matt's stop condition (WO-2: "someone replies to the
// client"). A client's own message is not a reply, so `author_role` is filtered server-side —
// and neither is an INTERNAL note (WO-9): the office writing to itself has not answered the
// client, so `internal = false` is filtered in the same query (migration 20261004100000).
// Chunked because the id list rides in a PostgREST `in(...)` filter string: open tickets are a
// working set, not a table scan, but a 750-building org can still hold a few hundred.
// 🔴 Each chunk is read COMPLETELY (count-first through selectAll): a hundred tickets' staff
// replies can pass one response's 1,000-row cap, and a ticket whose first reply fell past the cap
// read as UNANSWERED — the reminder repeating at a client who had their answer, and the first-reply
// clock (Client Requests, Matt's 30 minutes) counting down on a request the office had answered.
const REPLY_CHUNK = 100;
export async function firstStaffReplyByProblem(problemIds = []) {
  const ids = (Array.isArray(problemIds) ? problemIds : []).filter((id) => typeof id === 'string' && id);
  const out = new Map();
  if (!ids.length) return out;
  const db = getSupabase();
  for (let i = 0; i < ids.length; i += REPLY_CHUNK) {
    const chunk = ids.slice(i, i + REPLY_CHUNK);
    const base = (cols, opts) => db.from('work_order_messages').select(cols, opts)
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .in('problem_id', chunk)
      .neq('author_role', 'client')
      .eq('internal', false);
    const rows = await selectAll({
      count: async () => {
        const { count, error } = await base('id', { count: 'exact', head: true });
        if (error) throw error;
        return exactCount(count);
      },
      page: async (from, to) => {
        const { data, error } = await base('id, problem_id, created_at, author_role')
          .order('created_at', { ascending: true }).order('id', { ascending: true })
          .range(from, to);
        if (error) throw error;
        return data || [];
      },
    });
    for (const row of rows) {
      // The earliest per ticket IS its first staff reply (pages may arrive out of order).
      if (!row?.problem_id) continue;
      const seen = out.get(row.problem_id);
      if (!seen || Date.parse(row.created_at) < Date.parse(seen)) out.set(row.problem_id, row.created_at);
    }
  }
  return out;
}

// The open view carries each ticket's FIRST staff reply (`first_reply_at`, null while nobody has
// answered the client): the first-reply clock (Matt's 30 minutes, lib/clientRequests requestClock)
// runs until then, as the WO-2 reminders do. The same complete read the cron uses.
export async function withFirstReplies(problems = []) {
  const list = Array.isArray(problems) ? problems : [];
  const first = await firstStaffReplyByProblem(list.map((p) => p && p.id));
  return list.map((p) => ({ ...p, first_reply_at: first.get(p.id) || null }));
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

// ── The work-order reads (CS-640) ────────────────────────────────────────────
// 🔴 They read EVERY open ticket, never the newest N. The one read here used to be the newest
// 500 work orders of every status (`.order(created_at desc).limit(500)`), and PostgREST caps any
// single response at 1,000 rows besides, so past 500 tickets in total — resolved ones included —
// the oldest OPEN requests fell off the Work Orders tab, Client Requests, Home's tile, the nav
// pill and the Dashboard's open-complaints count, with nothing to say so. Nothing deletes a
// ticket, so the table only grows. Three reads replace it, each honest about what it holds:
//   listOpenProblems    every ticket that is not resolved — COMPLETE (count-first, paged through
//                       selectAll, which fails loudly rather than return a short set);
//   listResolvedProblems the resolved history — ONE bounded page, newest resolved first, with the
//                       exact total and how many were resolved in the last 24 hours;
//   listProblemsSince   every ticket of any status created since an instant — COMPLETE (the
//                       Dashboard's 30-day complaint figures, the hub demo's year).
// Every one takes the same filters and the same crew scope (applyCrewScope), applied to the count
// and to every page alike, so a count can never describe a different set than its rows. The model
// is openTicketsForAlerts above (the reminder cron's complete read).
export const RESOLVED_PAGE_DEFAULT = WO_RESOLVED_PAGE;
export const RESOLVED_PAGE_MAX = WO_RESOLVED_PAGE_MAX;
const RESOLVED_RECENT_MS = WO_RESOLVED_RECENT_HOURS * 3600 * 1000;

// The shared filters: priority / type / category (WO-12) / one customer / some locations / a set
// of customers (a queue: the buildings of one supervisor, resolved by the route — an empty set
// matches nothing), then the crew scope.
function applyProblemFilters(q, { priority, type, category, clientId, siteIds, clientIds, crewScope = null } = {}) {
  let out = q;
  if (priority) out = out.eq('priority', priority);
  if (type) out = out.eq('type', type);
  if (category) out = out.eq('category', category);
  if (clientId) out = out.eq('client_id', clientId);
  if (Array.isArray(siteIds) && siteIds.length) out = out.in('site_id', siteIds);
  if (Array.isArray(clientIds)) {
    const ids = scopeIds(clientIds);
    out = ids.length ? out.in('client_id', ids) : noRows(out);
  }
  // Crew scope: only problems for their assigned clients/sites, or ones they filed.
  return applyCrewScope(out, crewScope, 'reported_by_user_id');
}

// A complete read of problem_reports under `narrow` (the view's own condition) and the filters:
// newest first, then id, so page membership is deterministic (lint:paging).
async function allProblems(narrow, filters) {
  const db = getSupabase();
  const base = (cols, opts) => applyProblemFilters(
    narrow(db.from('problem_reports').select(cols, opts).eq('organization_id', CLEANSPACE_ORG_ID)),
    filters,
  );
  return selectAll({
    count: async () => {
      const { count, error } = await base('id', { count: 'exact', head: true });
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await base('*')
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
}

// EVERY open ticket (status ≠ resolved; legacy 'ack' counts as open, as normalizeStatus reads it).
export async function listOpenProblems(filters = {}) {
  return allProblems((q) => q.neq('status', 'resolved'), filters);
}

// EVERY ticket of any status created at or after `sinceIso`.
export async function listProblemsSince({ sinceIso, ...filters } = {}) {
  return allProblems((q) => q.gte('created_at', sinceIso), filters);
}

// ONE page of the resolved history, newest RESOLVED first (a legacy row with no resolved_at goes
// last, by its own creation), with the exact `total` and `last24h` — how many were resolved in the
// last 24 hours (the Work Orders tab's "Resolved (24h)"). Bounded: never more than
// RESOLVED_PAGE_MAX rows a call; the caller pages with `offset`.
export async function listResolvedProblems({ offset = 0, limit = RESOLVED_PAGE_DEFAULT, now = Date.now(), ...filters } = {}) {
  const db = getSupabase();
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.max(1, Math.min(RESOLVED_PAGE_MAX, Math.floor(Number(limit) || RESOLVED_PAGE_DEFAULT)));
  const base = (cols, opts) => applyProblemFilters(
    db.from('problem_reports').select(cols, opts).eq('organization_id', CLEANSPACE_ORG_ID).eq('status', 'resolved'),
    filters,
  );
  const sinceIso = new Date(now - RESOLVED_RECENT_MS).toISOString();
  const [rows, total, last24h] = await Promise.all([
    rangeFill((a, b) => withRetry(async () => {
      const { data, error } = await base('*')
        .order('resolved_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(a, b);
      if (error) throw error;
      return data || [];
    }), from, from + size - 1),
    withRetry(async () => {
      const { count, error } = await base('id', { count: 'exact', head: true });
      if (error) throw error;
      return exactCount(count);
    }),
    withRetry(async () => {
      const { count, error } = await base('id', { count: 'exact', head: true }).gte('resolved_at', sinceIso);
      if (error) throw error;
      return exactCount(count);
    }),
  ]);
  return { rows: rows.slice(0, size), total, last24h, offset: from, limit: size };
}

// ── Reports → Time to resolve (Matt's KPI, the Oct 6 call; plan 2026-10-11 §4, D10/D12) ──────
// EVERY ticket RESOLVED inside [fromIso, toIso], whatever its origin (the office's figure counts
// its own tickets too, unlike the hub's — D11), under the shared filters (one customer, a
// supervisor's buildings) and the crew scope. COMPLETE, count-first through selectAll — never the
// newest N (the CS-640 lesson): a capped read would quietly drop the oldest resolutions of the
// period and move the average. Narrow columns: the rule's inputs (lib/resolveTime: the deadline is
// derived from type and urgency, so `due_at` is not read) plus the customer's stored name, so a
// customer since removed from the book still has a row. Tallied by the route, never sent whole.
// Index: problem_reports_org_status_idx (organization_id, status, created_at desc) narrows to the
// org's resolved tickets; the resolved_at bound is a filter over those (no new index — plan §4).
export const RESOLVE_TIME_COLUMNS = 'id,client_id,client_name,type,priority,status,created_at,resolved_at';
export async function resolvedProblemsInWindow({ fromIso, toIso, maxRows, ...filters } = {}) {
  const db = getSupabase();
  const base = (cols, opts) => applyProblemFilters(
    db.from('problem_reports').select(cols, opts).eq('organization_id', CLEANSPACE_ORG_ID)
      .eq('status', 'resolved').gte('resolved_at', fromIso).lte('resolved_at', toIso),
    filters,
  );
  return selectAll({
    count: async () => {
      const { count, error } = await base('id', { count: 'exact', head: true });
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await base(RESOLVE_TIME_COLUMNS)
        .order('resolved_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
    ...(Number.isFinite(maxRows) ? { maxRows } : {}),
  });
}

// 🔴 WO-10: how many COMPLETION PHOTOS a ticket carries. The photo is an `account_media` row
// at scope `problem_report` with the ticket's id as its `ref_id` — the very gallery the work
// order drawer already shows, so nothing new has to be uploaded anywhere else. A head count,
// so resolving a ticket costs one indexed count and never reads the rows or mints a signed URL.
export async function countProblemPhotos(problemId) {
  if (!problemId) return 0;
  const db = getSupabase();
  const { count, error } = await db.from('account_media')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('scope', 'problem_report')
    .eq('ref_id', problemId);
  if (error) throw error;
  return exactCount(count);
}

// 🔴 WO-14: tickets per customer over a rolling window, for the "complaining too much" flag.
// A COMPLETE narrow read (two columns) through selectAll, because the flag is shown on the
// customers LIST: a capped read would silently under-count the busiest accounts, which are
// exactly the ones the flag exists to find. Crew-scoped like every other problems read.
// `id` is in the projection because `selectAll` dedupes overlapping pages BY IT (keyOf);
// without it every row keys as undefined and a multi-page read collapses to one row. `origin` is in
// it for QR-26: the tally (lib/workOrders ticketCountsByClient) leaves a visitor's report out.
export const TICKET_COUNT_COLUMNS = 'id, client_id, created_at, origin';
export async function ticketRowsSince({ sinceIso, crewScope = null } = {}) {
  const db = getSupabase();
  const base = () => {
    let q = db.from('problem_reports').select(TICKET_COUNT_COLUMNS)
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .gte('created_at', sinceIso);
    q = applyCrewScope(q, crewScope, 'reported_by_user_id');
    return q;
  };
  return selectAll({
    count: async () => {
      let q = db.from('problem_reports').select('id', { count: 'exact', head: true })
        .eq('organization_id', CLEANSPACE_ORG_ID)
        .gte('created_at', sinceIso);
      q = applyCrewScope(q, crewScope, 'reported_by_user_id');
      const { count, error } = await q;
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await base()
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
}

// Single problem by id AND organization (for server-side authorization before an update, a
// message or a thread read). 🔴 CS-652: every work-order read and write by id is pinned to the
// org — a ticket of another organization sharing the database is "not found" on every route —
// as the hub's ticket reads, reopenProblem and the thread reads already were. 22P02 is Postgres
// saying the id is not a uuid at all (problem_reports.id is one): it names no ticket, so it reads
// as none, as it did when this read ignored errors; any other failed read throws.
export async function getProblem(id) {
  const db = getSupabase();
  const { data, error } = await db.from('problem_reports').select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  if (error && !notAnId(error)) throw error;
  return data || null;
}

// Status transition (open → in_progress → awaiting_client → resolved), escalation,
// (re)assignment, priority + field edits. Priority re-arms the SLA clock from the
// original created_at; escalated:true keeps the first-escalated timestamp.
export async function updateProblem({ id, status, priority, type, category, title, description, assigneeUserId, escalated, crewUserIds }) {
  const patch = { };
  // The ticket's cleaners (the Cleaner Hub, brief C §1) — already checked by the route
  // (lib/crewRequests checkCrewRouting: office only, active cleaners, de-duplicated, bounded).
  if (Array.isArray(crewUserIds)) patch.crew_user_ids = crewUserIds;
  if (status) {
    const s = normalizeStatus(status);
    if (WO_STATUSES.includes(s)) { patch.status = s; patch.resolved_at = s === 'resolved' ? nowIso() : null; }
  }
  if (priority) { const p = normalizePriority(priority); if (WO_PRIORITIES.includes(p)) patch.priority = p; }
  if (type && WO_TYPES.includes(type)) patch.type = type;
  // WO-12: '' or null CLEARS it back to uncategorized; an unknown value is dropped.
  if (category !== undefined) patch.category = normalizeCategory(category);
  if (assigneeUserId !== undefined) patch.assignee_user_id = assigneeUserId || null;
  if (escalated !== undefined) patch.escalated_at = escalated ? nowIso() : null;
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (Object.keys(patch).length === 0) return { noop: true };
  const db = getSupabase();
  // The pre-read the SLA clock already needed, widened by two columns and by the STATUS case
  // so a status change can be logged with its before (CS-379). A status change is exactly the
  // event the activity log records, so it is the one case that pays for this read.
  let prev = null;
  if (patch.priority || patch.type || escalated === true || patch.status) {
    const { data: cur } = await db.from('problem_reports')
      .select('created_at, escalated_at, status, priority, type')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();   // CS-652
    prev = cur || null;
    if (cur) {
      // WO-20 / WO-21: a new type or urgency moves the deadline, by the one rule.
      if (patch.priority || patch.type) {
        patch.due_at = computeDueAt(cur.created_at, { type: patch.type || cur.type, priority: patch.priority || cur.priority });
      }
      if (escalated === true && cur.escalated_at) patch.escalated_at = cur.escalated_at; // keep first-escalated time
    }
  }
  // 🔴 A TICKET IS RESOLVED ONCE (the Oct 6 call's time to resolve, 2026-10-11). The move TO
  // resolved stamps resolved_at, and the "not resolved yet" predicate rides ON that write — never a
  // check-then-write — so a resolve that lands on a ticket ALREADY resolved (a retried request, a
  // double-tap, two people closing it at once) never moves its completion time: that time is the
  // ticket's time to resolve (lib/resolveTime, the hub's figure and Reports' Time to resolve) and
  // the start of its 7-day reopen window (WO-11). Only a real reopen clears resolved_at (above for
  // the office, reopenProblem for the client), so the next resolve stamps it anew.
  if (patch.status === 'resolved') {
    // CS-652: the org pin rides beside CS-647's "not resolved yet" predicate, on the same UPDATE.
    const { data: moved, error: moveError } = await db.from('problem_reports')
      .update(patch).eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).neq('status', 'resolved').select('*');
    if (moveError) throw moveError;
    if (moved && moved.length) return { problem: moved[0], prev };
    // Already resolved when the write landed: its first resolved_at stands, the status did not
    // change (so the caller logs no status change and emails nobody, whatever the pre-read saw),
    // and the rest of the edit — a priority, a title — still applies.
    if (prev) prev = { ...prev, status: 'resolved' };
    delete patch.status;
    delete patch.resolved_at;
    if (Object.keys(patch).length === 0) {
      const { data: same, error: readError } = await db.from('problem_reports').select('*')
        .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
      if (readError) throw readError;
      return same ? { problem: same, prev } : { notFound: true };
    }
  }
  // maybeSingle, not single: a ticket that is not this org's (or not at all) matches no row and
  // is "not found" (404), where single() made the miss a provider error (a 500).
  const { data, error } = await db.from('problem_reports').update(patch)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).select('*').maybeSingle();
  if (error && !notAnId(error)) throw error;
  if (!data) return { notFound: true };
  return { problem: data, prev };
}

// 🔴 CS-697: the office gives a ticket with NO location its location (the route checks who and
// which: lib/workOrders locationRefusal), so it can carry its completion photo and be resolved.
// The building, its customer and both names are filed with it. Only a ticket with none: the
// predicate rides ON the update (`site_id is null`), so two people setting it at once never
// overwrite each other, and a location never moves once set (the ticket's photos are filed under
// it). → { problem } | { hasLocation, problem } | { notFound }
export async function setProblemLocation({ id, site, clientName = null }) {
  const db = getSupabase();
  const { data, error } = await db.from('problem_reports')
    .update({ site_id: site.id, client_id: site.clientId || null, site_name: site.name || null, client_name: clientName })
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).is('site_id', null)
    .select('*');
  if (error && !notAnId(error)) throw error;
  if (data && data.length) return { problem: data[0] };
  const cur = await getProblem(id);
  return cur ? { hasLocation: true, problem: cur } : { notFound: true };
}

// WO-11: the CLIENT reopens a completed ticket (the hub decides whether they may —
// workOrders.ticketReopenRefusal, seven days from resolved_at). Back to OPEN with its
// completion time cleared, CAS'd on the ticket still being resolved: an office change that
// landed in between wins, and the caller answers "this ticket is not completed".
// Returns the updated row, or null when it was no longer resolved.
export async function reopenProblem(id) {
  const db = getSupabase();
  const { data, error } = await db.from('problem_reports')
    .update({ status: 'open', resolved_at: null })
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).eq('status', 'resolved')
    .select('*');
  if (error) throw error;
  return (data || [])[0] || null;
}

// ── The Cleaner Hub: tickets ROUTED to cleaners (brief C §1–§2; lib/crewRequests) ─────────
// A cleaner's own requests: every OPEN ticket whose `crew_user_ids` names them, and the ones that
// named them and were resolved in the last CREW_REQUEST_DONE_DAYS. Both COMPLETE (count-first
// through selectAll — never the newest N, the CS-640 lesson), org-pinned (CS-652), narrow (the
// projection's inputs only: no internal note, no customer contact, no reporter). The route builds
// the answer field by field from these (lib/crewRequests crewRequestViews). `userId` is the
// login's own id (or an office preview's, checked by the route); it is held to the id alphabet
// before it reaches the array filter.
export const CREW_REQUEST_COLUMNS = 'id,client_id,site_id,client_name,site_name,title,description,type,priority,status,created_at,resolved_at,assignee_user_id,crew_user_ids';
export async function listCrewRequests({ userId, now = Date.now() } = {}) {
  if (typeof userId !== 'string' || !ID_RE.test(userId)) return [];
  const db = getSupabase();
  const sinceIso = new Date(now - CREW_REQUEST_DONE_DAYS * 24 * 3600 * 1000).toISOString();
  const read = (narrow) => {
    const base = (cols, opts) => narrow(db.from('problem_reports').select(cols, opts)
      .eq('organization_id', CLEANSPACE_ORG_ID).contains('crew_user_ids', [userId]));
    return selectAll({
      count: async () => {
        const { count, error } = await base('id', { count: 'exact', head: true });
        if (error) throw error;
        return exactCount(count);
      },
      page: async (from, to) => {
        const { data, error } = await base(CREW_REQUEST_COLUMNS)
          .order('created_at', { ascending: false }).order('id', { ascending: false })
          .range(from, to);
        if (error) throw error;
        return data || [];
      },
    });
  };
  const [open, done] = await Promise.all([
    read((q) => q.neq('status', 'resolved')),
    read((q) => q.eq('status', 'resolved').gte('resolved_at', sinceIso)),
  ]);
  return [...open, ...done];
}

// The cleaners the office ADDED to a ticket are told (`crewRequestAssigned`): "New request at
// {customer}: {title}", in each one's language, opening the request in their phone app. The
// newly added only — the route passes them (lib/crewRequests newlyRoutedCrew). Best-effort and
// CAS-guarded like every fan-out here: it never fails the saved list.
export async function notifyCrewRequestAssigned(problem, userIds, { actorUserId = null, tries = 4 } = {}) {
  const ids = (Array.isArray(userIds) ? userIds : []).filter(Boolean);
  if (!problem?.id || !ids.length) return { sent: false, reason: 'nobody' };
  try {
    const place = problem.client_name || problem.site_name || null;
    const title = place
      ? msg('alerts.crewRequest.assigned', { customer: place, title: problem.title || '' })
      : msg('alerts.crewRequest.assignedNoPlace', { title: problem.title || '' });
    // The request's own words, as written (LANG-7), cut for a lock screen.
    const text = String(problem.description || '').replace(/\s+/g, ' ').trim();
    const body = text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const base = { ...state, notifications: state.notifications || [] };
      const notifications = fanOutToUserIds(base, {
        userIds: ids, eventKey: CREW_REQUEST_ASSIGNED_EVENT, title, body,
        url: crewPaths.request(problem.id), actorUserId,
      });
      if (notifications === base.notifications) return { sent: false, reason: 'nobody-to-ring' };
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return { sent: true };
    }
    return { sent: false, reason: 'cas-exhausted' };
  } catch {
    return { sent: false, reason: 'error' };   // the list is already saved
  }
}

// A CLEANER marked a request complete (D3: their Mark Complete resolves the ticket): the account
// manager hears it (`crewRequestCompleted`) — the ticket's assignee while they can take an office
// alert, else the ticket's own route (ticketRoute: the building's manager, else the Admins for a
// customer's request (HUB-21) or the office bench for any other, never nowhere). "{cleaner} completed {title} at {customer}", opening the ticket's drawer, where
// the photo and the cleaner's note are. The route calls it only when THIS change moved a ticket to
// resolved and the caller is crew. Best-effort and CAS-guarded: the ticket is already resolved.
export async function notifyCrewRequestCompleted(problem, { cleanerUserId = null, tries = 4 } = {}) {
  if (!problem?.id) return { sent: false, reason: 'no-ticket' };
  try {
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const base = { ...state, notifications: state.notifications || [] };
      const cleaner = (base.users || []).find((u) => u && u.id === cleanerUserId);
      const place = problem.client_name || problem.site_name || null;
      const who = cleaner?.name || msg('alerts.crewRequest.aCleaner');
      const title = place
        ? msg('alerts.crewRequest.completed', { cleaner: who, title: problem.title || '', customer: place })
        : msg('alerts.crewRequest.completedNoPlace', { cleaner: who, title: problem.title || '' });
      const args = { eventKey: CREW_REQUEST_COMPLETED_EVENT, title, body: '', url: ticketDeepLink(problem.id), actorUserId: cleanerUserId };
      const assignee = alertableAssignee(base, problem.assignee_user_id, CREW_REQUEST_COMPLETED_EVENT);
      const notifications = assignee
        ? fanOutToUserIds(base, { userIds: [assignee.id], ...args })
        : ticketRoute(problem)(base, { clientId: problem.client_id || null, ...args });
      if (notifications === base.notifications) return { sent: false, reason: 'nobody-to-ring' };
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return { sent: true };
    }
    return { sent: false, reason: 'cas-exhausted' };
  } catch {
    return { sent: false, reason: 'error' };   // the ticket is already resolved
  }
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

// One message on a ticket's thread. Author name is denormalized from the blob when not
// supplied so the thread renders without it.
//
// WHO WROTE IT. A staff message carries `author_user_id` (the roster id); a CLIENT's, from the
// hub, carries `author_client_user_id` instead (HUB-13 — a client user is not on the roster),
// stamped by the hub route from the verified claim. A client message never carries a staff id.
//
// 🔴 WO-9, INTERNAL NOTES. `internal: true` is an office note the client never sees: the hub
// reads threads with `internal = false` IN THE QUERY (api/_lib/clientHub/reads.js). Only staff
// can write one — a client's message is never internal, whatever the caller passes.
//
// WHAT A MESSAGE MOVES (both CAS'd on the status predicate, both best-effort):
//   · the first staff REPLY advances an OPEN ticket to in_progress — the existing rule. An
//     internal note is not a reply (nobody answered the client), so it advances nothing;
//   · a CLIENT's message on a ticket waiting on them (awaiting_client, "we need more
//     information from you") puts it back to in_progress — they answered (WO-8).
//
// `id` (optional) is caller-minted, so the hub's retried send is one message (the route reads
// it back first). An office REPLY sends exactly the columns it always did — the column default
// makes it `internal = false` — so the office's thread keeps working even on a database the
// migration has not reached yet; the new columns are written by the paths that need them (an
// internal note, and a client's message, which states `internal: false` outright).
export async function addWorkOrderMessage({ id = null, problemId, body, authorUserId, authorRole, authorName, internal = false, authorClientUserId = null }) {
  const db = getSupabase();
  const role = ['client', 'office', 'crew'].includes(authorRole) ? authorRole : 'office';
  const isInternal = internal === true && role !== 'client';
  const staffId = role === 'client' ? null : (authorUserId || null);
  let name = authorName || null;
  if (!name && staffId) {
    try { const { state } = await readOrgState(); name = (state?.users || []).find((u) => u.id === staffId)?.name || null; } catch { /* best-effort name */ }
  }
  const { data, error } = await db.from('work_order_messages').insert({
    ...(id ? { id } : {}),
    organization_id: CLEANSPACE_ORG_ID, problem_id: problemId,
    author_user_id: staffId, author_role: role, author_name: name, body,
    ...(isInternal || role === 'client' ? { internal: isInternal } : {}),
    ...(role === 'client' && authorClientUserId ? { author_client_user_id: authorClientUserId } : {}),
  }).select('*').single();
  if (error) throw error;
  const advance = role === 'client' ? ['awaiting_client', 'in_progress'] : (isInternal ? null : ['open', 'in_progress']);
  if (advance) {
    try {
      await db.from('problem_reports').update({ status: advance[1] })
        .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', problemId).eq('status', advance[0]);   // CS-652
    } catch { /* best-effort auto-advance */ }
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

// `clientId` files a CHECKLIST under one customer (R2); null is a STARTER. An INSPECTION
// template never carries one — the route refuses that combination before it reaches here
// (src/lib/inspections.createTemplateRefusal), and this insert normalizes the kind exactly
// as that rule does, so the refusal and the row can never disagree.
export async function createTemplate({ name, kind = 'inspection', ratingScale, createdBy, clientId = null }) {
  const db = getSupabase();
  const templateKind = kind === 'checklist' ? 'checklist' : 'inspection';
  const { data: tpl, error } = await db.from('inspection_templates').insert({
    organization_id: CLEANSPACE_ORG_ID,
    slug: randId(10),
    name: (name || '').trim() || 'Untitled inspection',
    kind: templateKind,
    item_count: null,                 // nothing is published yet (F4)
    client_id: templateKind === 'checklist' ? (clientId || null) : null,
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
// R2 (plan step 5): a checklist is filed under ONE customer, so the pickers read one
// location at a time and nobody scrolls a company-wide list. `clientId` keeps that
// customer's rows and NOT the starters; `starters` keeps only the rows with no customer
// (what "Start from…" offers). Neither is today's behaviour — every row of that kind. The
// route refuses the two together (templateFilterRefusal), because an empty answer there
// would read as "this customer has none". Served by
// `inspection_templates_org_client_kind_idx` (migration 20260928120100).
// `clientIds` is the CREW BOUNDARY (F1): a crew login holds qc.view, and without it they
// could page every customer's checklists with their client_id — a map of the customer book,
// which is exactly what CS-002's crew read split keeps out of a crew session. An empty
// scope reads NO rows, never all of them. Rows with no customer (the starters, and every
// company-wide inspection template) are outside it by construction.
function applyTemplateFilters(q, { kind, clientId, clientIds, starters } = {}) {
  let out = q.eq('organization_id', CLEANSPACE_ORG_ID);
  if (kind) out = out.eq('kind', kind);
  if (clientId) out = out.eq('client_id', clientId);
  if (starters) out = out.is('client_id', null);
  if (Array.isArray(clientIds)) out = clientIds.length ? out.in('client_id', clientIds) : noRows(out);
  return out;
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

// "Start from…" — copy a STARTER, or another customer's checklist, into this customer, ready
// to edit (R2: each building's checklist is its own, and editing one never changes another's,
// so a copy is a new row and never a shared one). The source must be a checklist and must be
// in this org; the customer is checked by the route against `org_state.clients`.
//
// Version 1 is the source's PUBLISHED schema — the frozen one cleaners actually fill —
// falling back to its latest draft, and it is published at once only when the source was AND
// `publishRefusal` allows it. Both decisions are the shared `planTemplateCopy`
// (src/lib/inspections.js), so the demo stub copies identically.
export async function copyTemplate({ id, clientId, name, createdBy } = {}, db = getSupabase()) {
  const { data: src, error } = await db.from('inspection_templates').select('*')
    .eq('id', id).eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
  if (error) throw error;
  if (!src) return { notFound: true };
  const refused = copyTemplateRefusal({ kind: src.kind, clientId });
  if (refused) return { refused };

  let publishedSchema = null;
  if (src.published_version_id) {
    const { data } = await db.from('inspection_template_versions').select('schema')
      .eq('id', src.published_version_id).maybeSingle();
    publishedSchema = data?.schema ?? null;
  }
  const latest = publishedSchema ? null : await latestTemplateVersion(id, db);
  const { schema, publish } = planTemplateCopy({
    kind: 'checklist',
    publishedSchema,
    // (a draft's pending name / pass mark are the source's, never the copy's — CS-669)
    latestSchema: latest?.schema ? withoutPendingTemplate(latest.schema) : null,
    // Published only when the frozen version was actually read: a dangling
    // published_version_id must not publish a draft nobody froze.
    sourcePublished: !!(src.is_published && publishedSchema),
  });

  const { data: tpl, error: tErr } = await db.from('inspection_templates').insert({
    organization_id: CLEANSPACE_ORG_ID,
    slug: randId(10),
    name: (name || '').trim() || src.name,
    kind: 'checklist',
    client_id: clientId,
    rating_scale: src.rating_scale || { type: 'passfail', passThreshold: 80 },
    created_by: createdBy || null,
    // Stated, not left to the column default: a copy's published state is a DECISION here
    // (publish below only when the source was published and publishRefusal allows it), and
    // a caller reading the returned row must not have to know what the default was.
    is_published: false,
    published_version_id: null,
    item_count: null,
    // The copied version's name lines (CS-850); a copy given a new name reads English until its
    // next save or the fill translates that name (their `en` no longer matches).
    name_i18n: schema?.nameI18n ?? null,
  }).select('*').single();
  if (tErr) throw tErr;
  const { data: ver, error: vErr } = await db.from('inspection_template_versions').insert({
    template_id: tpl.id, version_number: 1, schema: schema || EMPTY_SCHEMA,
    status: publish ? 'published' : 'draft', published_at: publish ? nowIso() : null,
  }).select('*').single();
  if (vErr) throw vErr;
  if (!publish) return { template: tpl, version: ver };
  const { data: out, error: uErr } = await db.from('inspection_templates')
    .update({ is_published: true, published_version_id: ver.id, item_count: countSchemaItems(schema), updated_at: nowIso() })
    .eq('id', tpl.id).eq('organization_id', CLEANSPACE_ORG_ID).select('*').single();
  if (uErr) throw uErr;
  return { template: out, version: ver };
}

// Step 6's problems summary over EVERY checklist in the org — which customer holds it,
// whether it is published, and how many items its published version carries. NARROW (no
// schema, no scale, no slug: a schema runs to kilobytes and ~3,750 of them is megabytes over
// the wire) and COMPLETE (selectAll: count-first, ordered pages, loud on a short read).
// A summary that silently stopped at PostgREST's db-max-rows would report "no problems" for
// every customer past the cap, which is the one wrong answer this screen must never give.
// `item_count` is a DENORMALIZED column, maintained at publish and at copy (and backfilled
// by migration 20260928120000). The first build read every published version's full schema
// to count items — about 39 MB at 3,750 checklists, for a handful of integers. The summary
// now reads one narrow row per template and touches the versions table not at all.
export const TEMPLATE_SUMMARY_COLUMNS = 'id,name,client_id,is_published,published_version_id,item_count,updated_at';

export async function templatesSummary(db = getSupabase()) {
  const rows = await listTemplates({ kind: 'checklist' }, { columns: TEMPLATE_SUMMARY_COLUMNS }, db);
  return rows.map((t) => toTemplateSummaryRow(t, t.item_count));
}

// Org-scoped like every other template read (F3): without it an id from another org read
// back that org's template — name, scale and all — to any qc.view holder here.
export async function getTemplate(templateId) {
  const db = getSupabase();
  const { data: tpl, error } = await db.from('inspection_templates').select('*')
    .eq('id', templateId).eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
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
// published (so submitted records keep their frozen schema). 🔴 CS-669: on a PUBLISHED template
// the name and the pass mark wait in that draft (schema.pendingTemplate, lib/inspections
// templateDraftSave) until Publish — the row keeps the live ones a new inspection snapshots. A
// template never published takes them on its row at once, as before (nothing is live).
export async function saveTemplate(templateId, { name, ratingScale, schema }, { translate = translateAll } = {}) {
  const db = getSupabase();
  // The org check comes FIRST (F3). `inspection_template_versions` has no organization_id,
  // so a version read by template_id is only safe once the template is known to be ours —
  // without this, an id from another org renamed that org's template and forked a draft on
  // it. Everything below then operates on a row we have proved we own.
  const { data: owned, error: oErr } = await db.from('inspection_templates').select('id, is_published, name')
    .eq('id', templateId).eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
  if (oErr) throw oErr;
  if (!owned) return { notFound: true };
  const latest = await latestTemplateVersion(templateId);
  const plan = templateDraftSave({ isPublished: !!owned.is_published, name, ratingScale, previous: pendingTemplateOf(latest) });
  // CS-850: the SYSTEM translates the wording. The lines beside each label — and the NAME's, for
  // the name this version goes live with (a live template's renamed draft: the pending name) — are
  // cleaned (a line the browser changed is the office's own; nothing is "checked"), then every one
  // with no line for today's English is translated into Spanish and Creole (translateAll: the
  // store, then Google; a line it cannot get stays English and is filled later by the cron). The
  // office's own line stays while its English does. src/lib/checklistI18n.
  if (schema) {
    const versionName = (plan.pending?.name ?? plan.rowPatch.name ?? owned.name ?? '').trim();
    // The org's customer and building names go through as written (CS-856, src/i18n/terms).
    let properNouns = [];
    try { properNouns = orgProperNouns((await readOrgState()).state); } catch { /* none: nothing to protect */ }
    schema = sanitizeSchemaTranslations(latest?.schema, schema, { name: versionName });
    schema = (await fillSchemaTranslations(schema, (lang, list) => translate(lang, list, { properNouns }), { name: versionName })).schema;
  }
  let version;
  if (!latest || latest.status === 'published') {
    const { data, error } = await db.from('inspection_template_versions')
      .insert({ template_id: templateId, version_number: (latest?.version_number || 0) + 1, schema: withPendingTemplate(schema || withoutPendingTemplate(latest?.schema) || EMPTY_SCHEMA, plan.pending), status: 'draft' })
      .select('*').single();
    if (error) throw error;
    version = data;
  } else {
    const { data, error } = await db.from('inspection_template_versions')
      .update({ schema: withPendingTemplate(schema || latest.schema, plan.pending) }).eq('id', latest.id).select('*').single();
    if (error) throw error;
    version = data;
  }
  await db.from('inspection_templates').update({ ...plan.rowPatch, updated_at: nowIso() })
    .eq('id', templateId).eq('organization_id', CLEANSPACE_ORG_ID);
  return version;
}

// Which of these templates have a DRAFT waiting to be published (CS-669: the list says
// "Published · unpublished changes" and offers Publish). One narrow read per 100 ids — a
// version table row per template at most is a draft, so no page reaches the row cap.
export async function templatesWithDrafts(templateIds, db = getSupabase()) {
  const ids = [...new Set((Array.isArray(templateIds) ? templateIds : []).filter(Boolean))];
  const out = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('inspection_template_versions').select('template_id')
      .in('template_id', ids.slice(i, i + 100)).eq('status', 'draft');
    if (error) throw error;
    for (const r of data || []) if (r?.template_id) out.add(r.template_id);
  }
  return out;
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
  // CS-669: the draft's own name and pass mark go live NOW, onto the row a new inspection reads,
  // and the frozen version keeps only the schema (no pending keys in what inspections snapshot).
  const pending = pendingTemplateOf(latest);
  const { data: ver, error } = await db.from('inspection_template_versions')
    .update({ status: 'published', published_at: nowIso(), schema: withoutPendingTemplate(latest.schema) }).eq('id', latest.id).select('*').single();
  if (error) throw error;
  // `item_count` is denormalized HERE, where the published schema is decided (F4): the
  // summary reads ~3,750 rows and must not pull a schema to count items (about 39 MB).
  const { data: tpl, error: tErr } = await db.from('inspection_templates')
    .update({
      is_published: true, published_version_id: ver.id, item_count: countSchemaItems(latest.schema), updated_at: nowIso(),
      // CS-850: the published version's name lines, denormalized like item_count, so a list names
      // the template in its reader's language without reading a schema (lib/checklistI18n).
      name_i18n: ver.schema?.nameI18n ?? null,
      ...(pending && pending.name !== undefined ? { name: pending.name } : {}),
      ...(pending && pending.ratingScale !== undefined ? { rating_scale: pending.ratingScale } : {}),
    })
    .eq('id', templateId).eq('organization_id', CLEANSPACE_ORG_ID).select('*').single();
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
// 🔴 CS-649 — an inspection is found by its id AND the organization, on every read and write: a
// record of another org in the same database is "not found" everywhere. inspection_items carries
// no organization_id, so it is read only through a record found this way, and written only by
// inspection_write (below), which pins the record itself. A non-uuid id reads as none (notAnId).
async function readInspectionRecord(db, id, columns = '*') {
  const { data, error } = await db.from('inspection_records').select(columns)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  if (error && !notAnId(error)) throw error;
  return data || null;
}
async function readInspectionItems(db, inspectionId, columns = '*') {
  const { data, error } = await db.from('inspection_items').select(columns).eq('inspection_id', inspectionId);
  if (error) throw error;
  return data || [];
}

// 🔴 CS-650 — THE ONE WRITE of an inspection's answers, for save-draft AND Submit (the first
// submit and an edit's re-submit): public.inspection_write
// (supabase/migrations/20261011110000_inspection_write.sql) locks the record (id + org) FOR
// UPDATE, replaces its items and updates it from an allowlisted patch (status, overall_score,
// result, performed_at, internal_note — a missing key leaves its column; updated_at always) in ONE
// transaction. The two writers serialize behind that lock and the second sees what the first left:
// a draft-only save finds the record submitted and writes nothing, and a second Submit's `before`
// is the first's result. Each was two or three statements before, so either could land inside the
// other and leave a submitted inspection holding a draft's items.
// → { record (the row after), before ({ status, overall_score, result }) } | { notFound } | { notADraft }
async function writeInspection(db, { id, items, patch, draftOnly }) {
  const { data, error } = await db.rpc('inspection_write', {
    p_org: CLEANSPACE_ORG_ID, p_id: id, p_items: items, p_patch: patch, p_draft_only: draftOnly === true,
  });
  if (error) {
    if (notAnId(error)) return { notFound: true };
    throw error;
  }
  if (data?.outcome === 'not_found') return { notFound: true };
  if (data?.outcome === 'not_a_draft') return { notADraft: true };
  if (data?.outcome !== 'written' || !data.record) throw new Error('inspection_write answered no record');
  return { record: data.record, before: data.before || null };
}
// One stored item, as both writers send it to inspection_write.
const inspectionItemRow = (it) => ({
  item_key: it?.item_key || null, label: it?.label || null,
  rating: it?.rating != null ? String(it.rating) : null, comment: it?.comment || null,
  photo_count: Number.isFinite(it?.photo_count) ? it.photo_count : 0,
});

export async function createInspection({ templateId, clientId, siteId, jobId, timeEntryId, inspectorUserId }) {
  const db = getSupabase();
  // CS-649: the template is this org's (getTemplate and every other template read already pin
  // it); its published version is read through it.
  const { data: tpl } = await db.from('inspection_templates').select('*')
    .eq('id', templateId).eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
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
    status: DRAFT_STATUS,
    performed_at: nowIso(),
    // When the draft was last saved: the 30-day retention clock (D9) and the "newer of server
    // and device" comparison on Continue (D7) both read it. The column defaults to now() too.
    updated_at: nowIso(),
  }).select('*').single();
  if (error) throw error;
  return { inspection: data };
}

// Replace items + compute the rollup. items: [{item_key,label,rating,comment,photo_count}].
// Returns `prev` (the record's status / score / result as the write's lock found it) so the
// caller can log a SUBMIT apart from an EDIT of an already-submitted inspection, with the score
// before and after (CS-379 / LOG-3) — and a second Submit racing the first is told the truth
// (CS-650): it is the edit, and no second client email goes out.
// 🔴 HUB-16 — the inspector's INTERNAL note, for the office only (Matt, 2026-10-02: "Yes
// — add an internal note for your team only"). It is stored in its own column, apart from
// the per-item comments, because the client sees the full report INCLUDING those comments
// (HUB-6). `projectReport` — the one function the public page, the in-app document and
// the PDF are all built from — does not read this column and must never be taught to:
// that is what keeps the note off every client-facing surface by construction rather than
// by three separate strippings. A note is trimmed and capped; an empty one CLEARS it.
export const MAX_INTERNAL_NOTE_LEN = 4000;
export function normalizeInternalNote(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, MAX_INTERNAL_NOTE_LEN) : null;
}

// `actor` ({ role, userId }, from the login's claim — the route passes it): a DRAFT is finished
// only by the inspector who started it or the office (lib/inspectionDrafts mayWorkDraft — the
// rule save-draft, Continue and Discard apply), so a manager cannot submit another manager's
// open inspection under their own answers. Editing an already-submitted one is unchanged.
// The pre-read: the frozen rating scale (fixed when the inspection was started, so it cannot
// change under the write) and WHO. The write re-reads the record under its lock.
const SUBMIT_READ_COLUMNS = 'id,status,inspector_user_id,template_snapshot,performed_at';
export async function submitInspection({ id, items, internalNote, actor = null }) {
  const db = getSupabase();
  const rec = await readInspectionRecord(db, id, SUBMIT_READ_COLUMNS);
  if (!rec) return { notFound: true };
  if (actor && rec.status === DRAFT_STATUS && !mayWorkDraft(actor, rec)) return { forbidden: true };
  const list = Array.isArray(items) ? items : [];
  const scale = rec.template_snapshot?.rating_scale || { type: 'passfail', passThreshold: 80 };
  const { overallScore, result } = scoreInspection(list, scale);
  // CS-699: a first Submit dates the inspection now (it was finished now, whenever it was started —
  // the start stays in created_at); an edit of one already submitted keeps its date.
  const patch = { status: 'submitted', overall_score: overallScore, result, performed_at: submittedPerformedAt(rec, nowIso()) };
  // HUB-16: only touched when the caller SAYS something about it, so a re-submit that
  // carries no note leaves the one already written alone (an edit screen that forgot to
  // resend it must not silently delete the office's own record).
  if (internalNote !== undefined) patch.internal_note = normalizeInternalNote(internalNote);
  // 🔴 CS-650: the items and the record in ONE write behind the record's row lock.
  const w = await writeInspection(db, { id, items: list.map(inspectionItemRow), patch, draftOnly: false });
  if (w.notFound) return { notFound: true };
  const data = w.record;
  // 🔴 WO-19 — a FAILED inspection opens its ticket (one per inspection), assigned to the
  // building's account manager with the building's cleaners on it. Opened BEFORE the two alerts
  // below so both can point at it: the people on it hear about the failure ONCE, through the
  // alert they already get (the office's bell, the cleaners' redo notice), never through a
  // second new-ticket ping as well — which is why notifyTicketRaised is not called for it.
  const ticket = await openFailedInspectionTicket(data, list);
  // A failing / needs-follow-up inspection is a churn signal the office shouldn't
  // have to discover by opening the report — fan out a manager bell row (best-effort,
  // server-side so it lands with no tab open). Mirrors notifyTicketRaised.
  if (result === 'fail' || result === 'needs_follow_up') {
    await notifyManagersOfFailedInspection(data, { ticket });
  }
  // 🔴 HUB-7 — and this one fires on FAILING ITEMS, not on the overall result: an
  // inspection can pass at 88% with the restrooms marked fail, and the cleaners are still
  // in the building. Separate question, separate condition, separate recipients.
  await notifyCleanersToRedo(data, list, { ticket });
  return { inspection: data, prev: w.before };
}

// ── An inspection LEFT OPEN AND FINISHED LATER (Matt, 2026-10-06; plan 2026-10-11 §3) ─────────
// The rules are src/lib/inspectionDrafts' (shared with the demo stub and the form). What lives
// here is the writes:
//   saveInspectionDraft          replaces an open draft's items and its office-only note and stamps
//                                `updated_at` — NOTHING else: no score, no result, no bell, no
//                                ticket, no email, no activity row (D8; all of that is Submit's);
//   getInspectionDraft           the draft with its saved items, for Continue;
//   discardInspectionDraft       deletes it with its items and its photos (rows AND objects);
//   listMyInspectionDrafts       the caller's own open drafts, for "Continue the one you started";
//   pruneStaleInspectionDrafts   D9's retention, run on `inspections/create` (bounded per call).
// Every one is org-pinned, and refuses a record that is not a draft. WHO may touch a draft is
// `mayWorkDraft` (the inspector who started it, or the office), with the actor from the login.
const DRAFT_TARGET_COLUMNS = 'id,status,inspector_user_id,template_snapshot';
const readDraftTarget = (db, id) => readInspectionRecord(db, id, DRAFT_TARGET_COLUMNS);

// → { inspection: { id, status, updated_at }, items: n } | { notFound } | { notADraft } | { forbidden }
export async function saveInspectionDraft({ id, items, internalNote, actor }) {
  const db = getSupabase();
  const rec = await readDraftTarget(db, id);
  if (!rec) return { notFound: true };
  if (rec.status !== DRAFT_STATUS) return { notADraft: true };
  if (!mayWorkDraft(actor, rec)) return { forbidden: true };
  // Rebuilt against the record's OWN frozen schema: its labels, a rating held to its scale, an
  // unknown key dropped, unticked = no rating yet (lib/inspectionDrafts sanitizeDraftItems).
  const rows = sanitizeDraftItems(rec.template_snapshot, items);
  const patch = {};
  if (internalNote !== undefined) patch.internal_note = normalizeInternalNote(internalNote);
  // 🔴 CS-650: ONE write, DRAFT-ONLY, behind the record's row lock (writeInspection above). The
  // read above is not the guard: the status is checked again under the lock, so a save that a slow
  // phone sends after the Submit landed — or that races one — is refused with NOTHING written, and
  // can never rewrite a submitted inspection's items or note.
  const w = await writeInspection(db, { id, items: rows.map(inspectionItemRow), patch, draftOnly: true });
  if (w.notFound) return { notFound: true };
  if (w.notADraft) return { notADraft: true };
  const { record } = w;
  return { inspection: { id: record.id, status: record.status, updated_at: record.updated_at }, items: rows.length };
}

// → { inspection, items } | { notFound } | { notADraft } | { forbidden }. The record whole (the
// form needs its frozen snapshot); the route strips the share token for a caller who may not share.
export async function getInspectionDraft({ id, actor }) {
  const db = getSupabase();
  const rec = await readInspectionRecord(db, id);
  if (!rec) return { notFound: true };
  if (rec.status !== DRAFT_STATUS) return { notADraft: true };
  if (!mayWorkDraft(actor, rec)) return { forbidden: true };
  return { inspection: rec, items: await readInspectionItems(db, id, 'item_key,label,rating,comment') };
}

// A deleted draft's dependents: its items (the foreign key cascades them in Postgres; deleted
// here as well, so the rule does not rest on the constraint alone) and its photos, rows and
// Storage objects. The photos are best-effort once the record is gone: a failure is logged, and
// the answer says how many went.
async function removeDraftDependents(db, ids) {
  const { error } = await db.from('inspection_items').delete().in('inspection_id', ids);
  if (error) throw error;
  try {
    const { removed } = await removeMediaForRefs({ refIds: ids, scope: 'inspection' });
    return { photos: removed };
  } catch (e) {
    console.error('[qc/inspections] a discarded draft\'s photos were not removed:', e?.code || 'error');
    return { photos: null };
  }
}

// → { ok, photos } | { notFound } | { notADraft } | { forbidden }. The status predicate rides on
// the DELETE: a draft submitted since the read above is never deleted.
export async function discardInspectionDraft({ id, actor }) {
  const db = getSupabase();
  const rec = await readDraftTarget(db, id);
  if (!rec) return { notFound: true };
  if (rec.status !== DRAFT_STATUS) return { notADraft: true };
  if (!mayWorkDraft(actor, rec)) return { forbidden: true };
  const { data: gone, error } = await db.from('inspection_records').delete()
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).eq('status', DRAFT_STATUS)
    .select('id');
  if (error) throw error;
  if (!gone?.length) return { notADraft: true };
  return { ok: true, ...(await removeDraftDependents(db, [id])) };
}

// The caller's OWN open drafts (`inspector_user_id` = the login), newest saved first, at one
// building when `siteId` is given — what the form asks before starting a new inspection there.
export const DRAFT_LIST_COLUMNS = 'id,client_id,site_id,client_name,site_name,template_id,template_name:template_snapshot->>name,status,inspector_user_id,performed_at,updated_at';
export async function listMyInspectionDrafts({ inspectorUserId, siteId = null } = {}) {
  if (!inspectorUserId) return [];
  const db = getSupabase();
  let q = db.from('inspection_records').select(DRAFT_LIST_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('status', DRAFT_STATUS).eq('inspector_user_id', inspectorUserId);
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q
    .order('updated_at', { ascending: false }).order('id', { ascending: false })
    .limit(DRAFT_LIST_MAX);
  if (error) throw error;
  return data || [];
}

// D9 — RETENTION AT THE WRITE POINT (THE LAW II.8): drafts whose last save is older than
// DRAFT_RETENTION_DAYS are deleted with their items and photos, at most `max` per call, oldest
// first. The predicates ride on the DELETE as well, so a draft saved (or submitted) since the
// read is spared. Run by `inspections/create` — the write that makes drafts.
export async function pruneStaleInspectionDrafts({ now = Date.now(), max = DRAFT_RETENTION_SWEEP_MAX } = {}) {
  const db = getSupabase();
  const cutoff = draftStaleBeforeIso(now);
  const { data: stale, error } = await db.from('inspection_records').select('id')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('status', DRAFT_STATUS).lt('updated_at', cutoff)
    .order('updated_at', { ascending: true }).order('id', { ascending: true })
    .limit(max);
  if (error) throw error;
  const ids = (stale || []).map((r) => r.id);
  if (!ids.length) return { removed: 0, photos: 0 };
  const { data: gone, error: dErr } = await db.from('inspection_records').delete()
    .eq('organization_id', CLEANSPACE_ORG_ID).in('id', ids).eq('status', DRAFT_STATUS).lt('updated_at', cutoff)
    .select('id');
  if (dErr) throw dErr;
  const goneIds = (gone || []).map((r) => r.id);
  if (!goneIds.length) return { removed: 0, photos: 0 };
  const { photos } = await removeDraftDependents(db, goneIds);
  return { removed: goneIds.length, photos };
}

// The Inspections list's draft rows say how far each got ("6 of 13 answered"): the drafts on
// the page only, two narrow reads (their frozen schemas, their saved items — the items COMPLETE
// through selectAll, since a page of drafts can hold more than one response's rows). A display
// extra: a failed read leaves the rows without the count rather than failing the list.
async function withDraftProgress(rows, db) {
  const ids = rows.filter((r) => r.status === DRAFT_STATUS).map((r) => r.id);
  if (!ids.length) return rows;
  try {
    const [snaps, items] = await Promise.all([
      (async () => {
        const { data, error } = await db.from('inspection_records').select('id,schema:template_snapshot->schema')
          .eq('organization_id', CLEANSPACE_ORG_ID).in('id', ids);
        if (error) throw error;
        return data || [];
      })(),
      selectAll({
        count: async () => {
          const { count, error } = await db.from('inspection_items').select('id', { count: 'exact', head: true }).in('inspection_id', ids);
          if (error) throw error;
          return exactCount(count);
        },
        page: async (from, to) => {
          const { data, error } = await db.from('inspection_items').select('id,inspection_id,item_key,rating')
            .in('inspection_id', ids).order('id', { ascending: true }).range(from, to);
          if (error) throw error;
          return data || [];
        },
      }),
    ]);
    const schemaOf = new Map(snaps.map((s) => [s.id, s.schema || null]));
    const itemsOf = new Map();
    for (const it of items) {
      if (!itemsOf.has(it.inspection_id)) itemsOf.set(it.inspection_id, []);
      itemsOf.get(it.inspection_id).push(it);
    }
    return rows.map((r) => {
      if (r.status !== DRAFT_STATUS) return r;
      const p = draftProgress({ schema: schemaOf.get(r.id) }, itemsOf.get(r.id) || []);
      return { ...r, draft_answered: p.answered, draft_total: p.total };
    });
  } catch (e) {
    console.error('[qc/inspections/list] the drafts\' progress was not read:', e?.code || 'error');
    return rows;
  }
}

// 🔴 HUB-7 (Matt, 2026-10-02): "Once the inspection failed, there should be some sort of a
// tool where the cleaners ON SITE receive a notification that an area needs to be done."
// It files nothing of its own — "Does not have to create a work order" — and is a bell row
// plus the push the dispatcher sends from it. (A FAILED inspection now opens a ticket all the
// same — WO-19, openFailedInspectionTicket — and this notice is how its cleaners hear of it.)
//
// WHO: the cleaners with an OPEN PUNCH at this building right now
// (`time/store.openPunchUserIdsAt` — a punch, not the roster, because the point is who can
// still act on it), and, when the failure opened a ticket (WO-19), the cleaners on that ticket
// too — each person once. If nobody is on either list, the account's SUPERVISOR instead, so a
// failed inspection at 2 a.m. in an empty building still reaches a person — the
// supervisor-first shape WO-6 already uses, read the other way round.
//
// WHAT: the AREAS, named. "Restrooms and Break room need redoing" is a sentence a cleaner
// can act on from a lock screen; "inspection failed" is not. The areas come from the
// frozen snapshot through the shared `redoAreasFor` (src/lib/inspections), so the crew's
// message and the report they are being measured against describe the same thing. It opens
// the ticket when there is one (its drawer links the report), else the Quality hub.
//
// Best-effort and CAS-guarded like every other fan-out here: a failure must never fail the
// already-persisted inspection.
export async function notifyCleanersToRedo(rec, items, { ticket = null, tries = 4 } = {}) {
  if (!rec) return { sent: false, reason: 'no-record' };
  try {
    const areas = redoAreasFor(rec.template_snapshot, items);
    if (!areas.length) return { sent: false, reason: 'nothing-failed' };
    const onSite = await openPunchUserIdsAt({ siteId: rec.site_id || null, clientId: rec.client_id || null });
    const recipients = [...new Set([...onSite, ...(Array.isArray(ticket?.crew_user_ids) ? ticket.crew_user_ids : [])])];
    // A cleaner's row opens the ticket in their phone app, the office's (the supervisor, below)
    // its drawer (ticketLinkFor); with no ticket, the Quality hub as before.
    const officeUrl = ticket?.id ? ticketDeepLink(ticket.id) : '/inspections';
    const url = ticket?.id ? ticketLinkFor(ticket.id) : officeUrl;
    // MESSAGES (CS-193): each cleaner on site reads it in their own language; the area names
    // are the office's and travel as written, joined in the reader's language.
    const where = rec.site_name || rec.client_name || msg('alerts.redo.theBuilding');
    const names = areas.map((a) => a.label).filter(Boolean);
    const title = msg('alerts.redo.title', { areas: names });
    const body = msg('alerts.redo.body', { place: where, count: areas.reduce((n, a) => n + a.items.length, 0) });
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const base = { ...state, notifications: state.notifications || [] };
      const notifications = recipients.length
        ? fanOutToUserIds(base, {
          userIds: recipients, eventKey: REDO_EVENT_KEY, title, body,
          url, actorUserId: rec.inspector_user_id || null,
        })
        // Nobody on the clock: the account's supervisor hears it instead. NOT the whole
        // office bench — an empty building is the supervisor's call to make, and this is
        // the one alert in the app aimed at people with mops in their hands.
        : fanOutAccountAlert(base, {
          clientId: rec.client_id || null, eventKey: REDO_EVENT_KEY,
          title: msg('alerts.redo.titleNobody', { areas: names }), body,
          url: officeUrl, actorUserId: rec.inspector_user_id || null,
        });
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return { sent: true, onSite: onSite.length, recipients: recipients.length, areas: areas.length };
    }
    return { sent: false, reason: 'cas-exhausted' };
  } catch {
    return { sent: false, reason: 'error' };   // the inspection is already saved
  }
}

// Fan out a manager bell row when a submitted inspection fails / needs follow-up.
// CAS-guarded against a concurrent org_state write, fully best-effort: a failure
// here must never fail the already-persisted inspection. Mirrors notifyTicketRaised.
// WO-19: when the failure opened a ticket, the row opens that ticket — it is the office's one
// ping for it (the account manager it is assigned to is on this bench; no new-ticket ping is
// sent on top).
export async function notifyManagersOfFailedInspection(rec, { ticket = null, tries = 4 } = {}) {
  if (!rec) return;
  try {
    const place = rec.site_name || rec.client_name || msg('alerts.anAccount');
    const score = rec.overall_score != null ? rec.overall_score : null;
    const followUp = rec.result === 'needs_follow_up';
    const title = followUp
      ? msg(score != null ? 'alerts.inspection.followUpScore' : 'alerts.inspection.followUp', { place, score })
      : msg(score != null ? 'alerts.inspection.failedScore' : 'alerts.inspection.failed', { place, score });
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const notifications = fanOutManagerAlert({ ...state, notifications: state.notifications || [] }, {
        eventKey: 'inspectionFailed',
        title,
        body: rec.template_snapshot?.name || rec.template_name || '',
        url: ticket?.id ? ticketDeepLink(ticket.id) : '/inspections',
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
// `inspector_user_id` + `updated_at` (2026-10-11): a DRAFT row offers Continue / Discard only to
// the person who may work it (lib/inspectionDrafts mayWorkDraft), and says when it was last saved.
export const INSPECTION_LIST_COLUMNS = 'id,client_id,site_id,client_name,site_name,template_name:template_snapshot->>name,overall_score,result,status,inspector_user_id,inspector_name,performed_at,updated_at,public_token';

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
  return { inspections: await withDraftProgress(rows.slice(0, limit), db), truncated: rows.length > limit };
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

// CS-649: the record by id AND org (readInspectionRecord), its items through it.
export async function getInspection(id) {
  const db = getSupabase();
  const rec = await readInspectionRecord(db, id);
  if (!rec) return null;
  return { inspection: rec, items: await readInspectionItems(db, id) };
}

// ── Checklists (checklist_results — items inline, no scoring; one submit) ──────
// Uses the SAME templates (kind='checklist'); the published version is snapshotted
// at submit. items: [{ key, label, checked, na?, note?, completedAt?, notCompleted?,
// notCompletedReason? }] — stored through `sanitizeChecklistItems` (src/lib/checklistCount):
// a task marked "not completed" keeps its flag as a boolean and its reason as one trimmed,
// capped line, and a comment is capped, repaired rather than refused (THE LAW II.8).

// WHICH published schema a submission is counted against (CS-494): the template's CURRENT
// published version, always. The submission does NOT get to name one.
//
// The first fix let it, as an offline kindness — a fill buffered on the phone
// (lib/checklistQueue) and replayed after a republish would be counted against what the
// cleaner saw. Review found that crew-reachable and it is now gone: `publishTemplate`
// never demotes older versions, and `checklists/list` (qc.view, a crew default) hands a
// cleaner their own past rows complete with `template_version_id` and `template_snapshot`.
// A checklist republished from one item to five therefore left version one both PUBLISHED
// and discoverable, so naming it stored 1/1 = complete and cleared the clock-out block
// with the current checklist untouched.
//
// THE TRADEOFF, accepted deliberately: a fill buffered across a republish is counted
// against the version current AT SUBMIT, so it can land partial. That is recoverable and
// visible — the cleaner's card reads "n/m done" and they tick the new items while online —
// and it never costs anyone their punch: an offline clock-out is still ACCEPTED and
// flagged for the approver, never refused (THE LAW II.8, api/_lib/time/checklistGate.js).
// A bypassable block is not recoverable, so the block wins.

// 🔴 CS-547: WHICH items of this submission actually carry a photo. The photos are
// `account_media` rows at scope `checklist` whose `ref_id` is the submission's own
// caller-minted id and whose `area_id` is the checklist ITEM key — so this is a read of
// what EXISTS, never of what the payload claimed, exactly as `countProblemPhotos` is the
// boundary for WO-10. One narrow indexed read (`account_media_ref_idx`), and only when the
// published schema actually marks an item, so a checklist with no marked item costs
// nothing.
//
// A failed read THROWS rather than returning an empty set, and `submitChecklist` lets it:
// an empty set would count every photo-required item as not done and quietly store a
// cleaner's finished checklist as short, which is worse than the 500 they can retry (the
// device buffers and replays it — lib/checklistQueue + the CS-007 drain keep a 5xx).
export async function checklistPhotoKeys(submissionId) {
  if (!submissionId) return new Set();
  const db = getSupabase();
  const { data, error } = await db.from('account_media')
    .select('area_id')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('ref_id', submissionId)
    .eq('scope', 'checklist');
  if (error) throw error;
  return new Set((data || []).map((r) => r?.area_id).filter((k) => typeof k === 'string' && k));
}

// 🔴 WHERE A FILL BELONGS (CS-690, src/lib/checklistWindow). A checklist counts for the clean it
// names only when it was filled in inside that clean's window (its clock-in window: 2 h before
// the start to the end + the auto-close grace) or past it while the cleaner is still clocked in
// there. Anything else is KEPT — never refused, II.8 — but stored WITHOUT the clean, so it can
// never unlock that clean's clock-out (time/checklistGate matches job + cleaner), and with no
// area stamp, so the QR code and the customer's hub never show a "last cleaned" nobody worked.
// A night-before fill from home used to do both. A clean nobody can find keeps the id it was
// given (it matches no real clean) and stamps nothing. A CREW fill naming no clean stamps the
// building's areas only when made on the clock there or inside one of THEIR cleans there; the
// office's own walk-through is unchanged.
const CLEAN_LOOKBACK_MS = 36 * 3600e3;   // a clean's window is judged precisely below; this only bounds the read

async function clockedInNow(db, { userId, jobId = null, siteId = null }) {
  if (!userId || (!jobId && !siteId)) return false;
  let q = db.from('time_entries').select('id')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('user_id', userId).is('clock_out_at', null);
  q = jobId ? q.eq('job_id', jobId) : q.eq('site_id', siteId);
  const { data, error } = await q.limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

async function placeChecklist(db, { jobId, siteId, userId, crew, madeAt, graceMins }) {
  if (jobId) {
    const job = await getJobById(jobId);
    if (!job) return { jobId, stampAreas: false };
    if (madeInCleanWindow(job, madeAt, { graceMins })) return { jobId, stampAreas: true };
    const onClock = await clockedInNow(db, { userId, jobId });
    return checklistCountsForClean({ job, madeAt, graceMins, onClock })
      ? { jobId, stampAreas: true }
      : { jobId: null, stampAreas: false };
  }
  if (!crew || !siteId) return { jobId: null, stampAreas: true };
  if (await clockedInNow(db, { userId, siteId })) return { jobId: null, stampAreas: true };
  const theirs = userId ? await getJobsAtSite(siteId, {
    crewId: userId,
    startFrom: new Date(madeAt - CLEAN_LOOKBACK_MS).toISOString(),
    startTo: new Date(madeAt + CLOCK_IN_LEAD_MS).toISOString(),
  }) : [];
  return { jobId: null, stampAreas: theirs.some((job) => madeInCleanWindow(job, madeAt, { graceMins })) };
}

// `filledAt` = when the phone says Submit was pressed (a fill it kept offline); `crew` = the
// caller is crew-scoped. Both feed placeChecklist above.
export async function submitChecklist({ templateId, clientId, siteId, jobId, items, completedByUserId, clientSubmitId = null, filledAt = null, crew = false }) {
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
  // A scored INSPECTION template is not a checklist and must never become a
  // `checklist_results` row (it would then count as a checklist in the Quality hub and in
  // Reports). Checked before anything is written; the rule is shared with the demo stub.
  const refused = checklistSubmitRefusal(tpl.kind);
  if (refused) return { notChecklist: refused };
  if (!tpl.published_version_id) return { notPublished: true };
  const { data: version } = await db.from('inspection_template_versions').select('*').eq('id', tpl.published_version_id).maybeSingle();
  if (!version) return { notPublished: true };
  const { state } = await readOrgState();
  const site = siteId ? (state?.sites || []).find((s) => s.id === siteId) : null;
  // Sanitized ONCE, and the stored list is the counted list: the count, the area times and
  // the row all read the same items (a "not completed" reason is counted as it is stored).
  const list = sanitizeChecklistItems(items);
  // CS-547: only look photos up when the PUBLISHED schema asks for any, and only when the
  // submission carries the id its photos were filed under. A fill from a client that never
  // minted one has no photos to find, so every marked item counts as not done — fail
  // closed, visible to the cleaner as "n of m", never a silent pass.
  const photoKeys = checklistPhotoRequiredKeys(version.schema).length && clientSubmitId
    ? await checklistPhotoKeys(clientSubmitId)
    : null;
  const performedAt = nowIso();
  // CS-690: which clean this fill counts for, if any, and whether it may stamp areas.
  const placed = await placeChecklist(db, {
    jobId: jobId || null, siteId: siteId || null, userId: completedByUserId || null, crew: !!crew,
    madeAt: checklistMadeAt(filledAt, Date.parse(performedAt)), graceMins: state?.opsSettings?.autoCloseGraceMins,
  });
  const { data, error } = await db.from('checklist_results').insert({
    organization_id: CLEANSPACE_ORG_ID,
    template_id: templateId,
    template_version_id: version.id,
    template_snapshot: { name: tpl.name, kind: tpl.kind, schema: version.schema },
    client_id: clientId || site?.clientId || null,
    site_id: siteId || null,
    job_id: placed.jobId,
    completed_by_user_id: completedByUserId || null,
    items: list,
    // Counted against the PUBLISHED SCHEMA above, never against the caller's own list
    // (CS-494 — `qc.checklist.perform` is a crew default, so one invented ticked item used
    // to store 1/1 and clear the clock-out block). Unknown keys are ignored and missing
    // ones count as not done; nothing here refuses a submission (THE LAW II.8).
    ...countChecklistSubmission(version.schema, list, { photoKeys }),
    // QR-1: when each FULLY completed area of this clean finished, from the device's own
    // per-item stamps clamped to this instant (src/lib/checklistAreas). Derived HERE from
    // the published schema for the same reason the counts are — the payload does not get
    // to say when an area was done any more than it gets to say that it was. Only a fill that
    // counts for a clean (or the office's own) stamps an area (CS-690, placeChecklist above).
    area_completions: placed.stampAreas ? areaCompletionTimes(version.schema, list, { performedAt, photoKeys }) : {},
    client_submit_id: clientSubmitId || null,
    performed_at: performedAt,
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

// The newest `limit` checklists that match — (performed_at, id) DESC, the
// checklist_results_org_performed_idx order read backwards (migration 20261013120000).
function applyChecklistListFilters(q, { siteId, jobId, crewScope = null } = {}) {
  let out = q.eq('organization_id', CLEANSPACE_ORG_ID);
  if (siteId) out = out.eq('site_id', siteId);
  if (jobId) out = out.eq('job_id', jobId);
  return applyCrewScope(out, crewScope, 'completed_by_user_id');
}
export async function listChecklists({ siteId, jobId, crewScope = null, limit = CHECKLIST_LIST_LIMIT } = {}) {
  const db = getSupabase();
  const { data, error } = await applyChecklistListFilters(db.from('checklist_results').select('*'), { siteId, jobId, crewScope })
    .order('performed_at', { ascending: false }).order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// How many checklists match the list's filters in all (CS-335): the Quality hub's
// Checklists tab showed the newest 200 and called that the list. Exact, over the same
// filters and crew scope as listChecklists; the route asks only when the list came back
// full, so a clean's or a building's short list costs no second read.
export async function countChecklists({ siteId, jobId, crewScope = null } = {}) {
  const db = getSupabase();
  const { count, error } = await applyChecklistListFilters(db.from('checklist_results').select('id', { count: 'exact', head: true }), { siteId, jobId, crewScope });
  if (error) throw error;
  return exactCount(count);
}

// ── QR-1 / HUB-15: a BUILDING's areas, each with its last clean ──────────────
//
// 🔴 THE ONE REUSABLE FUNCTION. Round 2 builds the public QR scan page and the client hub
// on top of this: both ask the same question of the same building and must get the same
// answer, so there is exactly one implementation and it takes no caller-supplied opinion.
// The office read `GET /api/qc/areas/status?siteId=` is its first caller; the public scan
// page is the second (api/_lib/scanCodes/store.scanAreaStatus, behind its own token gate and
// its own, narrower allowlist projection, src/lib/areaScan — nothing here is public by itself).
//
//   siteId     the building, as the blob knows it (`sites[].id`)
//   scan       how many of that building's newest checklist submissions to read FIRST (the
//              page). The answer is "when was each area LAST cleaned", so the page answers
//              most areas; an area it cannot settle is searched for further back (below).
//   crewScope  applyCrewScope, like every other QC read — the first page and every deeper
//              read alike. A crew member reads the building they clean; everyone else is
//              unscoped.
//   site       the location, when the caller has ALREADY read it: the public scan page
//              reads ONE location through `area_scan_site` and passes only the area it needs,
//              so an anonymous hit never pulls the whole shared record. Absent, it is read
//              from the blob here, as EP-200 always has.
//   sign       mint signed playback URLs for the winning photos (default). The public scan
//              page passes false: its answer carries no URL at all.
//
// Returns { siteId, siteName, clientId, areas: [...] } with one row per
// `site.cleaningAreas` entry, in the office's own order, whether or not anything has ever
// been recorded for it — see `src/lib/checklistAreas.siteAreaStatus` for the row shape.
// `{ notFound: true }` when the blob has no such site.
//
// 🔴 AN AREA'S LAST CLEAN, HOWEVER OLD (CS-701). The page used to be the whole answer: an
// area only a weekly or monthly checklist covers fell out of a busy building's newest 25
// within days, and the wall said "never cleaned". Now the page answers what it can SETTLE
// (src/lib/checklistAreas areasPastThePage) and every other area is searched for further
// back on its own: only the submissions whose frozen schema has a section linked to THAT area
// (jsonb containment on `template_snapshot->schema->areas`, `siteAreaId`, the one spelling
// the template editor writes), at or before the page's oldest, newest first, in pages of
// AREA_STATUS_DEEP_PAGE, judged by the same rule as the page (siteAreaCompletions), until a
// finish is found that nothing older can beat, the area's submissions run out, or
// AREA_STATUS_DEEP_PAGES pages have been read (the bound: past that many covering submissions
// with no finish the area reads "not recorded"). The building's site index serves the order.
//
// The reads, bounded: the blob (request-cached; none when `site` is passed), the page, at most
// AREA_STATUS_DEEP_PAGES deeper pages per area the page could not settle (a few areas in
// parallel), and ONE media query — the page's submissions plus each area's deeper winner,
// never every deeper row. Signed URLs are minted ONLY for the photos that win their area, and
// only when `sign` is on.
export const AREA_STATUS_RESULT_SCAN = 25;
export const AREA_STATUS_DEEP_PAGE = 10;
export const AREA_STATUS_DEEP_PAGES = 10;
const AREA_STATUS_DEEP_CONCURRENCY = 3;
export const AREA_STATUS_COLUMNS = 'id,client_id,site_id,job_id,completed_by_user_id,completed_count,total_count,items,template_snapshot,area_completions,client_submit_id,performed_at';

// One area's newest finish past the page: its covering submissions at or before `before`,
// newest first, page by page. → the winning row, or null (none, or none within the bound).
// `bestAt` is the page's own finish of the area, when it had one that could still be beaten.
async function deeperAreaWinner(db, { siteId, crewScope, areaId, before, bestAt, seen }) {
  const covers = JSON.stringify([{ siteAreaId: areaId }]);
  let best = bestAt == null ? null : { at: bestAt, row: null };
  for (let page = 0; page < AREA_STATUS_DEEP_PAGES; page += 1) {
    const from = page * AREA_STATUS_DEEP_PAGE;
    let q = db.from('checklist_results').select(AREA_STATUS_COLUMNS)
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .eq('site_id', siteId)
      .contains('template_snapshot->schema->areas', covers)
      .lte('performed_at', before)
      .order('performed_at', { ascending: false }).order('id', { ascending: false });
    q = applyCrewScope(q, crewScope, 'completed_by_user_id');
    const { data, error } = await q.range(from, from + AREA_STATUS_DEEP_PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    for (const r of rows) {
      if (!r || seen.has(r.id)) continue;   // the page's own rows at its oldest instant
      const done = siteAreaCompletions(r).get(areaId);
      if (done && (!best || done.at > best.at)) best = { at: done.at, row: r };
    }
    if (rows.length < AREA_STATUS_DEEP_PAGE) break;                         // ran out
    const last = Date.parse(rows[rows.length - 1]?.performed_at);
    if (best && Number.isFinite(last) && last <= best.at) break;            // nothing older can beat it
  }
  return best?.row || null;
}

export async function areaStatusForSite({ siteId, scan = AREA_STATUS_RESULT_SCAN, crewScope = null, site: given = null, sign = true } = {}, db = getSupabase()) {
  if (!siteId) return { notFound: true };
  const site = given || ((await readOrgState()).state?.sites || []).find((s) => s && s.id === siteId) || null;
  if (!site) return { notFound: true };

  let q = db.from('checklist_results').select(AREA_STATUS_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('site_id', siteId)
    .order('performed_at', { ascending: false }).order('id', { ascending: false })
    .limit(scan);
  q = applyCrewScope(q, crewScope, 'completed_by_user_id');
  const { data, error } = await q;
  if (error) throw error;
  const results = data || [];

  // CS-701: each area the page cannot settle, searched for on its own (above).
  const pending = areasPastThePage({
    areaIds: (Array.isArray(site.cleaningAreas) ? site.cleaningAreas : []).map((a) => a?.id),
    results,
    full: results.length >= scan,
  });
  const seen = new Set(results.map((r) => r?.id).filter(Boolean));
  const winners = [];
  for (let i = 0; i < pending.length; i += AREA_STATUS_DEEP_CONCURRENCY) {
    const found = await Promise.all(pending.slice(i, i + AREA_STATUS_DEEP_CONCURRENCY)
      .map((p) => deeperAreaWinner(db, { siteId, crewScope, ...p, seen })));
    for (const r of found) if (r && !winners.some((w) => w.id === r.id)) winners.push(r);
  }
  const rows = [...results, ...winners];

  const refs = [...new Set(rows.map((r) => r?.client_submit_id).filter(Boolean))];
  let media = [];
  // Photos are EVIDENCE, never the answer: a failed media read leaves every `photo` null
  // and the last-cleaned times stand. (It does cost the CS-547 per-item honesty for this
  // view — a photo-required item then reads as not done, which is the fail-closed default
  // everywhere else in this feature.)
  try { media = await listMediaRawByRefs({ refIds: refs, scope: 'checklist' }); } catch { media = []; }

  const areas = siteAreaStatus({ cleaningAreas: site.cleaningAreas, results: rows, media });
  // Sign only the winners — and nothing at all for a caller that hands out no URL.
  if (sign) for (const a of areas) {
    if (!a.photo?.id) continue;
    const row = media.find((m) => m.id === a.photo.id);
    const signed = row ? await signMediaRow(row) : null;
    a.photo = signed
      ? { ...a.photo, url: signed.url, thumbUrl: signed.thumbUrl, caption: signed.caption, kind: signed.kind }
      : a.photo;
  }
  return { siteId, siteName: site.name || null, clientId: site.clientId || null, areas };
}

// Normalize a record + its items + its photos into the shared REPORT shape consumed
// by the public page, the in-app modal, and the PDF renderer (buildInspectionReportHtml
// in src/lib). Photos arrive already resolved to a browser/PDF-usable `url` (a signed
// URL from listMedia, or an inlined data: URI from the PDF renderer) and carry areaId
// so the report can group them under their section. Pure — no DB access.
//
// 🔴 HUB-16: THIS IS THE CLIENT-FACING PROJECTION, and `internal_note` is not in it. The
// client sees the full report, item comments and all (HUB-6), so the office's own note
// lives in a column this function never reads. Do not add it. Everything downstream —
// /inspect/:token, the PDF, every share and email — is built from what this returns, so
// leaving it out HERE is the whole boundary; `app/scripts/test-inspection-internal-note.mjs`
// enumerates that mechanically, and the authed route hands the note back separately.
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

// A SUBMITTED inspection by its public token (the shareable report's capability — no auth),
// pinned to this deployment's org (CS-649: a token of another org's report sharing the database
// opens nothing here), with its items; null when missing, a draft, or another org's. A FAILED read
// throws rather than reading as "not found": the public route answers it with its fixed sentence
// and code (PUBLIC_REPORT_UNAVAILABLE, CS-648), so a database hiccup never tells a customer their
// report does not exist.
async function readSharedInspection(db, token) {
  const { data: rec, error } = await db.from('inspection_records').select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('public_token', token).maybeSingle();
  if (error) throw error;
  if (!rec || rec.status === DRAFT_STATUS) return null;
  return { rec, items: await readInspectionItems(db, rec.id) };
}

// Public, token-scoped read of a SUBMITTED inspection (the shareable report). Returns a SAFE
// projection (no internal ids). Draft records 404.
export async function getInspectionByToken(token) {
  const db = getSupabase();
  const found = await readSharedInspection(db, token);
  if (!found) return null;
  let photos = [];
  try { photos = await listMedia({ refId: found.rec.id, scope: 'inspection' }); } catch { /* photos best-effort */ }
  return projectReport(found.rec, found.items, photos);
}

// Raw record + items for a SUBMITTED inspection by public_token — the public PDF
// route needs the row + items to feed the chromium renderer (which inlines photos
// itself). Draft/missing/another org's → null, so the public PDF 404s exactly like
// the HTML report.
export async function getInspectionRawByToken(token) {
  return readSharedInspection(getSupabase(), token);
}

// Authed in-app report: the SAME normalized shape as the public projection, PLUS the
// internal id/status/public_token the report modal needs for its actions (Download
// PDF, Copy link). Returns { rec, report } so the route can crew-scope on the raw row
// (mirrors getInspection) before handing back `report`. null when no such record.
export async function getInspectionReport(id) {
  const db = getSupabase();
  const rec = await readInspectionRecord(db, id); // CS-649: id AND org
  if (!rec) return null;
  const items = await readInspectionItems(db, id);
  let photos = [];
  try { photos = await listMedia({ refId: id, scope: 'inspection' }); } catch { /* photos best-effort */ }
  const report = projectReport(rec, items, photos);
  report.inspection.id = rec.id;
  report.inspection.status = rec.status;
  report.inspection.publicToken = rec.public_token;
  // HUB-16: BESIDE the report, never inside it. `buildInspectionReportHtml` is handed
  // `report` and reads `report.inspection` / `.items` / `.photos`, so a sibling key cannot
  // reach the document the client is shown — and the route strips it for a caller without
  // qc.inspect before any of this leaves the server.
  return { rec, report, internalNote: rec.internal_note || null };
}
