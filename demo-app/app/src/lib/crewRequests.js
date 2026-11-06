// Client Requests on the cleaner's phone (Matt's Cleaner Hub, "Client Requests" / "Request
// Details"; plan docs/plans/2026-10-13-cleaner-hub.md §3 D3, brief C §1–§2). The office routes a
// ticket to cleaners (`problem_reports.crew_user_ids`, WO-19's column); each cleaner sees the open
// ones naming them, completes one with a photo and an optional note, and the account manager is
// told. PURE and node-safe: the server (api/qc problems/mine + problems/update), the demo stub
// (lib/qcApi) and the screens read these rules, so none of them can drift.
//
// WHO IS ROUTED (the office's "Cleaners on this ticket", components/WorkOrderDrawer):
//   · OFFICE ONLY — a role floor, not a key: crew hold `problems.manage` (they resolve tickets at
//     their own buildings), so the key cannot tell the office apart; a crew caller → 403.
//   · each id an ACTIVE crew member on the roster (role crew, status active or invited), the list
//     de-duplicated and at most MAX_REQUEST_CREW — a longer list may only shrink (a WO-19 ticket
//     the app filled with up to failedInspectionTicket's MAX_TICKET_CREW can still lose people).
//   · the newly ADDED alone are told (newlyRoutedCrew): re-saving a list, or removing someone,
//     rings nobody.
// WHAT A CLEANER READS (crewRequestViews + toCrewRequest): their OPEN tickets, and the ones they
// were on that were resolved in the last CREW_REQUEST_DONE_DAYS, each built field by field — the
// request, its building, when it came in, its deadline (lib/workOrders computeDueAt, the one rule)
// and who it is from: the ticket's assignee when they are office, else the building's account
// manager (its active supervisor). Never an internal note, a phone number or another cleaner.
import { computeDueAt, deriveSla, normalizeStatus, isOpenStatus } from './workOrders.js';
import { SUPERVISOR_ROLES } from './roles.js';
import { resolveJobCrewIds } from './crewResolve.js';
import { JOB_STATUS } from './jobStatus.js';
import { msg } from '../i18n/core.js';

export const CREW_REQUEST_DONE_DAYS = 7;
export const MAX_REQUEST_CREW = 20;
// The building's cleaners the office's picker offers first: anyone on its cleans from a week back
// to two weeks ahead (one turn of a weekly schedule, and the next two).
export const BUILDING_CREW_BACK_DAYS = 7;
export const BUILDING_CREW_AHEAD_DAYS = 14;
// A person the office may put on a ticket: a cleaner whose access has not ended.
const ROUTABLE_STATUSES = new Set(['active', 'invited']);
const DAY_MS = 24 * 3600 * 1000;

export const CREW_ROUTING_CODES = Object.freeze({
  officeOnly: 'crew-office-only',
  malformed: 'crew-malformed',
  notCrew: 'crew-not-crew',
  tooMany: 'crew-too-many',
});
// The server's words for each (a screen shows its catalog line by the code: CREW_ROUTING_ERROR_KEYS).
export const CREW_ROUTING_MESSAGES = Object.freeze({
  [CREW_ROUTING_CODES.officeOnly]: 'Only the office can choose the cleaners on a ticket.',
  [CREW_ROUTING_CODES.malformed]: 'crewUserIds must be a list of team member ids.',
  [CREW_ROUTING_CODES.notCrew]: 'Only active cleaners can be put on a ticket.',
  [CREW_ROUTING_CODES.tooMany]: `At most ${MAX_REQUEST_CREW} cleaners can be on a ticket.`,
});
// What a screen says for each (i18n/errors errorText's `known` map: a key, or a message).
export const CREW_ROUTING_ERROR_KEYS = Object.freeze({
  [CREW_ROUTING_CODES.officeOnly]: 'crewRequests.routing.officeOnly',
  [CREW_ROUTING_CODES.malformed]: 'crewRequests.routing.failed',
  [CREW_ROUTING_CODES.notCrew]: 'crewRequests.routing.notCrew',
  [CREW_ROUTING_CODES.tooMany]: () => msg('crewRequests.routing.tooMany', { max: MAX_REQUEST_CREW }),
});
const ID_RE = /^[A-Za-z0-9_\-:.]{1,64}$/;

// Is this roster row someone the office may route a ticket to?
export function isRoutableCrew(user) {
  return !!user && user.role === 'crew' && ROUTABLE_STATUSES.has(String(user.status || '').trim().toLowerCase());
}

// The ticket's cleaners as stored: a list of distinct ids (an absent or odd value reads as none).
export function ticketCrewIds(problem) {
  const raw = problem?.crew_user_ids;
  return Array.isArray(raw) ? [...new Set(raw.filter((id) => typeof id === 'string' && id))] : [];
}

// The office's request to set a ticket's cleaners → { ok: true, ids } (de-duplicated, in the order
// given) or { ok: false, code } (CREW_ROUTING_CODES). `current` is the ticket's list before it.
export function checkCrewRouting({ actorRole, crewUserIds, users = [], current = [] } = {}) {
  if (!actorRole || actorRole === 'crew' || !SUPERVISOR_ROLES.includes(actorRole)) return { ok: false, code: CREW_ROUTING_CODES.officeOnly };
  if (!Array.isArray(crewUserIds)) return { ok: false, code: CREW_ROUTING_CODES.malformed };
  if (crewUserIds.some((id) => typeof id !== 'string' || !ID_RE.test(id))) return { ok: false, code: CREW_ROUTING_CODES.malformed };
  const ids = [...new Set(crewUserIds)];
  const roster = new Map((Array.isArray(users) ? users : []).filter((u) => u && u.id).map((u) => [u.id, u]));
  const before = new Set(Array.isArray(current) ? current : []);
  // Someone already on the ticket may stay even if they have since left (removing them is the
  // office's choice); everyone ADDED must be an active cleaner.
  if (ids.some((id) => !before.has(id) && !isRoutableCrew(roster.get(id)))) return { ok: false, code: CREW_ROUTING_CODES.notCrew };
  if (ids.length > MAX_REQUEST_CREW && ids.some((id) => !before.has(id))) return { ok: false, code: CREW_ROUTING_CODES.tooMany };
  return { ok: true, ids };
}

// 🔴 D3's ONE EXCEPTION TO A CLEANER'S BUILDINGS (Daniel, "Cleaner closes it"; 2026-10-14). A
// cleaner the office NAMED on a ticket (its STORED `crew_user_ids` holds their claim id) may
// complete THAT ticket even at a building they do not clean: resolve it, and leave the account
// manager an office-only note on it. Nothing else: no other field, no other status, no reply to the
// customer, no other ticket. The route asks this only when the cleaner's buildings refused them
// (api/qc problems/update, problems/message); the completion photo's twin is
// api/_lib/accountMedia/refs.js namedTicketGrant.
const OTHER_TICKET_FIELDS = ['priority', 'type', 'category', 'assigneeUserId', 'escalated', 'title', 'description', 'siteId', 'crewUserIds'];
export function namedCompletionAllowed({ ticket, userId, update = null, message = null } = {}) {
  if (!userId || !ticketCrewIds(ticket).includes(userId)) return false;
  if (update) return update.status != null && normalizeStatus(update.status) === 'resolved' && OTHER_TICKET_FIELDS.every((k) => update[k] === undefined);
  if (message) return message.internal === true;
  return false;
}

// The cleaners the change ADDED (the only ones told).
export function newlyRoutedCrew(before, after) {
  const had = new Set(Array.isArray(before) ? before : []);
  return (Array.isArray(after) ? after : []).filter((id) => !had.has(id));
}

// ── what a cleaner reads ──────────────────────────────────────────────────────────────
const msOf = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };
const names = (problem, userId) => ticketCrewIds(problem).includes(userId);

// The start of the "recently done" window: tickets resolved at or after it are still shown.
export function crewDoneSinceIso(now = Date.now()) {
  return new Date((typeof now === 'number' ? now : Date.parse(now)) - CREW_REQUEST_DONE_DAYS * DAY_MS).toISOString();
}

// The account manager a request is "From": the ticket's assignee while they are an active office
// member, else the building's supervisor (the customer's `supervisorId`, active and still office).
export function requestManagerOf(problem, { users = [], clients = [] } = {}) {
  const byId = new Map((Array.isArray(users) ? users : []).filter((u) => u && u.id).map((u) => [u.id, u]));
  const office = (u) => !!u && SUPERVISOR_ROLES.includes(u.role) && u.status === 'active';
  const assignee = byId.get(problem?.assignee_user_id);
  if (office(assignee)) return assignee;
  const client = (Array.isArray(clients) ? clients : []).find((c) => c && c.id === problem?.client_id);
  const sup = client?.supervisorId ? byId.get(client.supervisorId) : null;
  return office(sup) ? sup : null;
}

// "Dana Kim" → "Dana K." (the board's "From Dana K."); one word stays as it is.
export function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// One ticket as a cleaner reads it — built field by field (nothing else from the row travels).
export function toCrewRequest(problem, { users = [], clients = [] } = {}) {
  const manager = requestManagerOf(problem, { users, clients });
  const client = (Array.isArray(clients) ? clients : []).find((c) => c && c.id === problem?.client_id);
  const createdAt = problem?.created_at || null;
  const status = normalizeStatus(problem?.status);
  return {
    id: problem.id,
    title: problem.title || '',
    description: problem.description || '',
    type: problem.type || null,
    status,
    clientId: problem.client_id || null,
    clientName: problem.client_name || client?.name || '',
    siteId: problem.site_id || null,
    siteName: problem.site_name || '',
    createdAt,
    // WO-20 / WO-21: derived from the type and urgency by the one rule, never the stored cache.
    dueAt: computeDueAt(createdAt, { type: problem.type, priority: problem.priority }),
    resolvedAt: problem.resolved_at || null,
    managerId: manager?.id || null,
    managerName: manager ? shortName(manager.name) : '',
  };
}

const byDeadline = (a, b) => ((msOf(a.dueAt) ?? Infinity) - (msOf(b.dueAt) ?? Infinity))
  || ((msOf(b.createdAt) ?? 0) - (msOf(a.createdAt) ?? 0)) || String(a.id).localeCompare(String(b.id));
const byResolved = (a, b) => ((msOf(b.resolvedAt) ?? 0) - (msOf(a.resolvedAt) ?? 0)) || String(a.id).localeCompare(String(b.id));

// The cleaner's two lists from raw ticket rows: `open` (every open ticket naming them, nearest
// deadline first) and `recentDone` (resolved in the last CREW_REQUEST_DONE_DAYS, newest first).
export function crewRequestViews(rows, { userId, users = [], clients = [], now = Date.now() } = {}) {
  if (!userId) return { open: [], recentDone: [] };
  const since = msOf(crewDoneSinceIso(now));
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && names(r, userId));
  const open = mine.filter((r) => isOpenStatus(r.status)).map((r) => toCrewRequest(r, { users, clients })).sort(byDeadline);
  const recentDone = mine
    .filter((r) => normalizeStatus(r.status) === 'resolved' && (msOf(r.resolved_at) ?? -Infinity) >= since)
    .map((r) => toCrewRequest(r, { users, clients }))
    .sort(byResolved);
  return { open, recentDone };
}

// Past its deadline (never while the office waits on the customer — the clock is paused then).
export function crewRequestOverdue(req, now = Date.now()) {
  if (!req || !isOpenStatus(req.status)) return false;
  return deriveSla({ dueAt: req.dueAt, status: req.status, now }).state === 'breached';
}

// ── the office's picker: the building's cleaners first ────────────────────────────────
// Everyone on a clean at this location (or, for a ticket with no location, at this customer) from
// BUILDING_CREW_BACK_DAYS back to BUILDING_CREW_AHEAD_DAYS ahead, not cancelled, routable — by
// name. `jobs` is the office tab's window (−45 / +100 days, src/lib/jobsWindow).
export function buildingCleaners({ jobs = [], siteId = null, clientId = null, users = [], now = Date.now() } = {}) {
  if (!siteId && !clientId) return [];
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const from = nowMs - BUILDING_CREW_BACK_DAYS * DAY_MS;
  const to = nowMs + BUILDING_CREW_AHEAD_DAYS * DAY_MS;
  const roster = new Map((Array.isArray(users) ? users : []).filter((u) => u && u.id).map((u) => [u.id, u]));
  const ids = new Set();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || j.status === JOB_STATUS.CANCELLED) continue;
    if (siteId ? j.siteId !== siteId : j.clientId !== clientId) continue;
    const at = msOf(j.startAt);
    if (at == null || at < from || at > to) continue;
    for (const id of resolveJobCrewIds(j)) if (isRoutableCrew(roster.get(id))) ids.add(id);
  }
  return [...ids].map((id) => roster.get(id)).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}
