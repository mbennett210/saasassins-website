// Client Requests — the office's queue of what customers have REQUESTED (the manager view redesign,
// 2026-10-09; Matt's "Account Manager Hub" board and his email of the same day): every open work
// order (the Quality hub's Work Orders list, qcApi.listOpenProblems — every open ticket, CS-640),
// each with a live countdown, overdue first.
//
// REQUESTS ONLY (HUB-24 (c), Matt 2026-10-12): "Messages and requests should be treated
// separately … especially since we want to track requests and how long it takes us to close them."
// A customer's message waiting for the office's reply is NOT in this queue, its counts or its
// clocks; it has its own place and count (lib/hubMessages: Messaging → Customers, the manager
// Home's Customer messages tile). The 2026-10-09 ONE queue's message half was deleted with it (II.5).
//
// 🔴 THE STANDARDS ARE MATT'S, FROM HIS EMAIL (2026-10-09): "30 min to first reply, 2 hours for a
// complaint, 24 hours for a standard request, 48 hours for a failed-inspection fix". Two clocks:
//   • FIRST REPLY — until the office first answers the client (the same first staff reply WO-2's
//     reminders stop on, lib/ticketAlerts ticketAnsweredAt), due the org's no-reply window after
//     the request came in (WO-5: lib/ticketAlerts ticketEscalateMins — the 30 is the setting, not a
//     literal here).
//   • THE FIX — then the ticket's own deadline, by lib/workOrders' one rule (WO-20: the TYPE for a
//     client request; WO-21: urgency for an issue, which has no client to answer and so no
//     first-reply clock).
// Urgency no longer sets a request's deadline: it sorts the queue (WO-20) and keeps its
// after-hours alert role (WO-7). This module reads every number from where it lives.
//
// PURE and node-safe (explicit .js imports), so the page, Home's tile, the nav pill and the tests
// share it.
import {
  toWorkOrder, deriveSla, normalizeStatus, normalizePriority, woPriorityRank,
  WO_PRIORITIES, TYPE_DEADLINE_HOURS, isClientRequestType, slaTargetParts, deadlineHours,
} from './workOrders.js';
import { ticketEscalateMins, ticketDueAtMs, ticketAnsweredAt } from './ticketAlerts.js';
import { managerIdsMatch } from './teamScope.js';

const MIN = 60 * 1000;

// The client request types the standards line states, in the table's order (Matt's: complaint,
// request, failed inspection) — a type the vocabulary does not list yet is still stated.
export const STANDARD_TYPES = Object.freeze(Object.keys(TYPE_DEADLINE_HOURS));

const msOf = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : NaN; };
const overdue = (dueMs, now) => ({ state: 'breached', minutes: Math.max(1, Math.round((now - dueMs) / MIN)), dueMs });

// The first-reply clock: due `windowMins` after `sinceMs`. Inside it the state is 'soon' — a
// half-hour clock is always close — and past it 'breached'.
function replyClock(sinceMs, windowMins, now) {
  const dueMs = sinceMs + windowMins * MIN;
  if (!Number.isFinite(dueMs)) return { phase: 'none', state: 'none', minutes: null, dueMs: NaN };
  if (now > dueMs) return { phase: 'reply', ...overdue(dueMs, now) };
  return { phase: 'reply', state: 'soon', minutes: Math.round((dueMs - now) / MIN), dueMs };
}

// A ticket's live clock: { phase: 'reply' | 'fix' | 'paused' | 'none', state: 'breached' | 'soon'
// | 'ok' | 'paused' | 'none', minutes (left, or past due when breached), dueMs }.
//   resolved → none · waiting on the client → paused (the fix clock stops, lib/workOrders deriveSla)
//   a CLIENT request nobody has answered yet → the first-reply clock
//   otherwise → the fix clock, the ticket's derived deadline (soon = deriveSla's warning window)
// `first_reply_at` on the row is the first staff reply (the open read carries it).
export function requestClock(wo, { now = Date.now(), settings = {} } = {}) {
  const status = normalizeStatus(wo?.status);
  if (status === 'resolved') return { phase: 'none', state: 'none', minutes: null, dueMs: NaN };
  const fixDueMs = ticketDueAtMs(wo || {});
  if (status === 'awaiting_client') return { phase: 'paused', state: 'paused', minutes: null, dueMs: fixDueMs };
  if (isClientRequestType(wo?.type) && ticketAnsweredAt(wo, wo?.first_reply_at) == null) {
    return replyClock(msOf(wo?.created_at ?? wo?.createdAt), ticketEscalateMins(settings), now);
  }
  if (!Number.isFinite(fixDueMs)) return { phase: 'none', state: 'none', minutes: null, dueMs: NaN };
  if (now > fixDueMs) return { phase: 'fix', ...overdue(fixDueMs, now) };
  const soon = deriveSla({ dueAt: new Date(fixDueMs).toISOString(), status, now }).state === 'soon';
  return { phase: 'fix', state: soon ? 'soon' : 'ok', minutes: Math.round((fixDueMs - now) / MIN), dueMs: fixDueMs };
}

// The queue's order (WO-20: urgency SORTS the list): anything past its time first, the most
// overdue first; then by urgency; then the nearest deadline; a paused clock (waiting on the client)
// after every running one; no clock last; ties the older, then the id — a stable order that never
// reshuffles on a tick.
const GROUP = { breached: 0, soon: 1, ok: 1, paused: 2, none: 3 };
export function compareRequests(a, b) {
  const ga = GROUP[a?.left?.state] ?? 3;
  const gb = GROUP[b?.left?.state] ?? 3;
  if (ga !== gb) return ga - gb;
  if (ga === 0 && a.left.dueMs !== b.left.dueMs) return a.left.dueMs - b.left.dueMs;
  if (ga === 1) {
    const pr = woPriorityRank(a.priority) - woPriorityRank(b.priority);
    if (pr) return pr;
    if (a.left.dueMs !== b.left.dueMs) return a.left.dueMs - b.left.dueMs;
  }
  const ca = String(a.created_at || '');
  const cb = String(b.created_at || '');
  if (ca !== cb) return ca.localeCompare(cb);
  return String(a.id).localeCompare(String(b.id));
}

const openedMinutes = (iso, now) => {
  const t = msOf(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / MIN)) : null;
};

// The open work orders from a listOpenProblems read (anything resolved is dropped too), scoped by
// the building's manager (`supervisorOf`, the Work Orders tab's queue rule) and the type, in the
// queue's order. Each row is the work order (toWorkOrder) + `kind: 'ticket'`, `left`
// (requestClock) and `openedMinutes`. An ARCHIVED customer's request (`clientArchived(clientId)`,
// CS-663) is no longer the queue's: it stays open and readable on the customer page and in
// Quality → Work Orders, but leaves this queue, its counts and its clocks. `managerId` is one
// manager's id, a list of them (an Operations Manager's team, S131, lib/teamScope), or '' for all.
export function clientRequestRows(rows = [], { now = Date.now(), settings = {}, supervisorOf = () => null, managerId = '', type = '', clientArchived = () => false } = {}) {
  const out = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw) continue;
    const wo = { ...toWorkOrder(raw), first_reply_at: raw.first_reply_at ?? null };
    if (normalizeStatus(wo.status) === 'resolved') continue;
    if (wo.client_id && clientArchived(wo.client_id)) continue;
    if (managerId && !managerIdsMatch(managerId, supervisorOf(wo.client_id))) continue;
    if (type && wo.type !== type) continue;
    out.push({ ...wo, kind: 'ticket', left: requestClock(wo, { now, settings }), openedMinutes: openedMinutes(wo.created_at, now) });
  }
  return out.sort(compareRequests);
}

// "N open · M urgent · K overdue": every request in the list, the urgent ones (WO-18's loudest
// urgency), and everything past its clock — a first reply or a fix.
export function clientRequestCounts(list = []) {
  const rows = Array.isArray(list) ? list : [];
  return {
    open: rows.length,
    urgent: rows.filter((w) => normalizePriority(w?.priority) === 'urgent').length,
    overdue: rows.filter((w) => w?.left?.state === 'breached').length,
  };
}

// What the banner states, every figure from its rule: the first-reply window in minutes (WO-5's
// setting), each client request type's deadline (WO-20) — in HOURS, as Matt wrote his standards
// ("24 hours for a standard request") — and an issue's urgency clock (WO-21, as WO-18 put it).
export function responseStandards(settings = {}) {
  return {
    replyMins: ticketEscalateMins(settings || {}),
    types: STANDARD_TYPES.map((type) => ({ type, unit: 'hours', count: deadlineHours({ type }) })),
    issues: WO_PRIORITIES.map((priority) => ({ priority, ...slaTargetParts(priority) })),
  };
}
