// WO-19 — a FAILED inspection opens a ticket.
//
// Matt, Review WO-19 (a), 2026-10-09: "A failed inspection should create a ticket and
// automatically assign it to the account manager and cleaners of that site." His email adds
// "48 hours for a failed-inspection fix" — the deadline table's rule (lib/workOrders), read by
// createProblem like every other ticket's, never restated here.
//
// ONE set of rules for the server (api/_lib/qc/store.submitInspection) and the demo stub
// (lib/qcApi stubSubmitInspection), so the two open the same ticket:
//   WHEN   the inspection is submitted with the result `fail` — never a pass (HUB-7 still sends
//          the cleaners back for a failed ITEM on a passing inspection, and files nothing) and
//          never `needs_follow_up` (nothing was rated, so nothing failed). One ticket per
//          inspection: the caller looks for the ticket already linked to it first (and the
//          database's unique index on problem_reports.inspection_id settles a race), so a
//          replayed or edited submit never opens a second.
//   WHO    assigned to the building's ACCOUNT MANAGER — the customer's supervisor while still
//          one (lib/notifications resolveAccountSupervisor, the app's one supervisor rule);
//          with none, the ticket is opened unassigned and the office's failed-inspection bell
//          (the whole bench) is how it is heard, which is the routing a ticket with no
//          supervisor already gets (WO-6). The CLEANERS: the crew of the inspected visit (its
//          `crewIds`, lib/crewResolve — crew is exactly what the schedule names), else the
//          building's cleaners that week (every clean at the site in the
//          SITE_CREW_LOOKBACK_DAYS up to the inspection). Only active people on the roster;
//          never the inspector.
//   WHAT   internal (origin `internal`: the customer sees the failed inspection itself, as
//          HUB-7 already shows it, never a portal ticket), on the inspected building and visit,
//          titled with the date and the failed areas, its details the score and each failed
//          item under its area — the same areas (lib/inspections redoAreasFor) the cleaners'
//          redo notice names. Stored in English like every ticket's words (the office's record);
//          the date in the org's zone.
//
// PURE and node-safe (explicit .js imports).
import { FAILED_INSPECTION_TYPE } from './workOrders.js';
import { redoAreasFor } from './inspections.js';
import { resolveAccountSupervisor } from './notifications.js';
import { resolveJobCrewIds } from './crewResolve.js';
import { JOB_STATUS } from './jobStatus.js';
import { translate } from '../i18n/core.js';
import { SOURCE_LANGUAGE } from '../i18n/languages.js';

const DAY_MS = 24 * 3600 * 1000;
// The building's cleaners, when the inspection names no visit: everyone on a clean at the site
// in the week up to the inspection — one turn of any weekly schedule.
export const SITE_CREW_LOOKBACK_DAYS = 7;
// A guard, not a rule: a building with this many cleaners in a week is a data problem, and the
// ticket stays readable.
export const MAX_TICKET_CREW = 25;
export const FAILED_INSPECTION_PRIORITY = 'medium';
export const FAILED_INSPECTION_TITLE_MAX = 140;

export function owesFailedInspectionTicket(rec) {
  return !!rec && !!rec.id && rec.result === 'fail';
}

// The window the building's cleans are read in: { startFrom, startTo } as ISO, or null when the
// inspection has no usable time.
export function siteCrewWindow(performedAt) {
  const end = Date.parse(performedAt ?? '');
  if (!Number.isFinite(end)) return null;
  return { startFrom: new Date(end - SITE_CREW_LOOKBACK_DAYS * DAY_MS).toISOString(), startTo: new Date(end).toISOString() };
}

// The cleans at `siteId` that start inside the window and are not cancelled. The server reads
// them from the jobs table already bounded and re-checks each payload here; the stub filters the
// demo's jobs with the same rule.
export function siteCleansInWindow(jobs, { siteId, startFrom, startTo } = {}) {
  if (!siteId || !startFrom || !startTo) return [];
  const from = Date.parse(startFrom);
  const to = Date.parse(startTo);
  return (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || j.siteId !== siteId || j.status === JOB_STATUS.CANCELLED) return false;
    const at = Date.parse(j.startAt ?? '');
    return Number.isFinite(at) && at >= from && at <= to;
  });
}

// The cleaners attached to the ticket: the inspected visit's crew, else the building's cleaners
// (`siteJobs`, already windowed). Active roster users only, never the inspector, sorted.
export function failedInspectionCrew({ visit = null, siteJobs = [], users = [], inspectorUserId = null } = {}) {
  const active = new Set((Array.isArray(users) ? users : []).filter((u) => u && u.id && u.status === 'active').map((u) => u.id));
  const crewOf = (jobs) => {
    const ids = new Set();
    for (const j of jobs) {
      if (!j || j.status === JOB_STATUS.CANCELLED) continue;
      for (const id of resolveJobCrewIds(j)) if (active.has(id) && id !== inspectorUserId) ids.add(id);
    }
    return [...ids].sort();
  };
  const fromVisit = visit ? crewOf([visit]) : [];
  const ids = fromVisit.length ? fromVisit : crewOf(Array.isArray(siteJobs) ? siteJobs : []);
  return ids.slice(0, MAX_TICKET_CREW);
}

// The account manager the ticket is assigned to, or null.
export function failedInspectionAssigneeId(state, clientId) {
  return resolveAccountSupervisor(state || {}, clientId)?.id || null;
}

// The ticket's title and details, in English (the stored record's language), the date in `tz`.
export function failedInspectionTicketText(rec, items, { tz } = {}) {
  const en = (key, params) => translate(SOURCE_LANGUAGE, key, params, tz || undefined);
  const areas = redoAreasFor(rec?.template_snapshot, items);
  const names = areas.map((a) => a.label).filter(Boolean);
  const date = rec?.performed_at || null;
  let title = names.length
    ? en('workOrders.failedInspection.title', { date, areas: names })
    : en('workOrders.failedInspection.titleNoAreas', { date });
  if (title.length > FAILED_INSPECTION_TITLE_MAX) title = `${title.slice(0, FAILED_INSPECTION_TITLE_MAX - 1).trimEnd()}…`;
  const threshold = Number.isFinite(rec?.template_snapshot?.rating_scale?.passThreshold) ? rec.template_snapshot.rating_scale.passThreshold : 80;
  const lines = [];
  if (rec?.overall_score != null) lines.push(en('workOrders.failedInspection.scored', { score: rec.overall_score, threshold }));
  if (areas.length) {
    lines.push(en('workOrders.failedInspection.failedItems'));
    for (const a of areas) lines.push(en('workOrders.failedInspection.areaLine', { area: a.label, items: a.items }));
  }
  if (rec?.inspector_name) lines.push(en('workOrders.failedInspection.inspectedBy', { name: rec.inspector_name }));
  return { title, description: lines.join('\n') };
}

// What createProblem is given for the ticket (both the server's and the stub's take this shape).
export function failedInspectionTicketInput({ rec, items, state, crewUserIds = [] } = {}) {
  const { title, description } = failedInspectionTicketText(rec, items, { tz: state?.company?.timezone || null });
  return {
    inspectionId: rec.id,
    clientId: rec.client_id || null,
    siteId: rec.site_id || null,
    jobId: rec.job_id || null,
    clientName: rec.client_name || null,
    siteName: rec.site_name || null,
    title,
    description,
    type: FAILED_INSPECTION_TYPE,
    origin: 'internal',
    priority: FAILED_INSPECTION_PRIORITY,
    assigneeUserId: failedInspectionAssigneeId(state, rec.client_id || null),
    crewUserIds: Array.isArray(crewUserIds) ? crewUserIds : [],
    reportedByUserId: rec.inspector_user_id || null,
  };
}
