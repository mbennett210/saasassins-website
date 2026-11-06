// Work Orders — shared vocabulary + SLA math for the client-raised ticketing queue
// that lives in the Quality hub (the evolved "Problems" surface). ONE source of
// truth for type / priority / status / origin, the SLA clock, and the status flow,
// used by the UI (Inspections Work Orders tab, WorkOrderModal) and mirrored by the
// demo stub (lib/qcApi.js) + backend (api/_lib/qc/store.js). Pure — no imports, so
// the same helpers are safe on the server and in tests.
//
// Model: a Work Order is a problem_reports row grown with `type`
// (complaint | request | issue | failed_inspection, WO-19), `origin` (portal | internal | visitor), `priority`
// (urgent | medium | low — REPLACES the old low/med/high `severity`), `assignee_user_id`,
// `due_at` (the SLA clock), and `escalated_at`. Queue = the account's supervisor
// (client.supervisorId); scoping mirrors Reports.jsx. Increments: 1 the queue, 2 the
// message thread, 3 the Complaints fold-in (customer complaints ARE Work Orders of
// type:complaint — the standalone blob `complaints` slice was retired).

// ── Type: what kind of work order this is ────────────────────────────────────
export const WO_TYPES = ['complaint', 'request', 'issue', 'failed_inspection'];
export const WO_TYPE_META = {
  complaint: { label: 'Complaint', badge: 'red', hint: 'Something went wrong — a service miss or recurring gripe.' },
  request:   { label: 'Request',   badge: 'blue', hint: 'The client wants something added or changed.' },
  issue:     { label: 'Issue',     badge: 'slate', hint: 'A field/maintenance issue the crew or office flagged.' },
  failed_inspection: { label: 'Failed inspection', badge: 'amber', hint: 'Opened by the app when an inspection is submitted as a fail.' },
};
export const DEFAULT_WO_TYPE = 'issue';
export const woTypeLabel = (t) => WO_TYPE_META[t]?.label || WO_TYPE_META[DEFAULT_WO_TYPE].label;

// ── WO-19: the failed-inspection ticket's type (Builder B's block) ───────────
// Matt, Review WO-19 (a), 2026-10-09: "A failed inspection should create a ticket and
// automatically assign it to the account manager and cleaners of that site." The app opens it
// (api/_lib/qc/store.submitInspection through lib/failedInspectionTicket), so it is a type
// nobody RAISES: the office's New work order and the customer hub's form offer only
// RAISABLE_WO_TYPES, and both create routes file a hand-sent `failed_inspection` as an issue.
// Every reader (badges, Client Requests' type filter, the server's validation) still knows it.
export const FAILED_INSPECTION_TYPE = 'failed_inspection';
export const RAISABLE_WO_TYPES = WO_TYPES.filter((t) => t !== FAILED_INSPECTION_TYPE);

// ── Origin: who raised it ────────────────────────────────────────────────────
// `visitor` (QR-22..QR-26, Matt 2026-10-16): anyone who scanned an area's QR code WITHOUT signing in
// and reported a problem from the public page (lib/visitorReports, EP-414). It is a ticket like any
// other at that building — the same create path, routing, deadlines and bells (QR-25) — but it is
// the OFFICE's alone (QR-26: "They didn't make the report, and it would count toward their ticket
// volume"): never in the customer's hub (its readers allow origin `portal` only) and never in the
// customer's ticket volume (ticketCountsByClient below).
export const VISITOR_ORIGIN = 'visitor';
export const WO_ORIGINS = ['portal', 'internal', VISITOR_ORIGIN];
export const WO_ORIGIN_META = {
  portal:   { label: 'Client portal', hint: 'Raised by the client in the portal.' },
  internal: { label: 'Internal',      hint: 'Logged internally by staff.' },
  visitor:  { label: 'Reported by a visitor', hint: 'Reported by someone who scanned the area’s QR code without signing in.' },
};
export const DEFAULT_WO_ORIGIN = 'internal';
export const woOriginLabel = (o) => WO_ORIGIN_META[o]?.label || WO_ORIGIN_META[DEFAULT_WO_ORIGIN].label;
// QR-26's ONE question, asked by every reader that must leave a visitor's report out.
export const isVisitorReport = (row) => !!row && typeof row === 'object' && row.origin === VISITOR_ORIGIN;

// ── A visitor's own name and phone or email (QR-23 f): the office's alone ──────────────────────
// Stored on the ticket (problem_reports.reporter_name / reporter_contact, a visitor's ticket only —
// a CHECK in migration 20261017110000), shown in the office's list and drawer, and NEVER served to
// the customer's hub (its reads declare their columns and name neither) or to a cleaner (the
// office's ticket reads hand a crew caller the row without them).
export const VISITOR_REPORTER_FIELDS = Object.freeze(['reporter_name', 'reporter_contact']);
export function withoutVisitorReporter(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const k of VISITOR_REPORTER_FIELDS) delete out[k];
  return out;
}

// ── The building area a ticket is about (QR-16, QR-23) ─────────────────────────────────────────
// `site_area_id` names one of its location's cleaning areas (`sites[].cleaningAreas[].id`): a
// visitor's report carries its code's area; the customer's "Make a request about this area" and the
// office may name one. ONE rule for every write (the office's and the hub's create routes, and the
// demo): none is fine; anything that is not one of THIS location's areas is refused, never stored.
export const AREA_CODES = Object.freeze({ unknown: 'area-unknown' });
export const AREA_MESSAGES = Object.freeze({
  [AREA_CODES.unknown]: 'That area is not on this location’s list any more. Refresh and try again.',
});
const areaIdOf = (a) => (a && typeof a.id === 'string' && a.id.trim() ? a.id.trim() : null);
// → { value: areaId | null } | { refused: AREA_CODES.unknown }
export function ticketAreaInput(siteAreaId, site) {
  if (siteAreaId === undefined || siteAreaId === null || siteAreaId === '') return { value: null };
  if (typeof siteAreaId !== 'string' || !siteAreaId.trim()) return { refused: AREA_CODES.unknown };
  const id = siteAreaId.trim();
  const areas = Array.isArray(site?.cleaningAreas) ? site.cleaningAreas : [];
  return areas.some((a) => areaIdOf(a) === id) ? { value: id } : { refused: AREA_CODES.unknown };
}
// The area's name for a ticket row, from its location's own list (the live record), or null — an
// area since removed from the location names nothing.
export function ticketAreaLabel(row, site) {
  const id = typeof row?.site_area_id === 'string' ? row.site_area_id.trim() : '';
  if (!id) return null;
  const area = (Array.isArray(site?.cleaningAreas) ? site.cleaningAreas : []).find((a) => areaIdOf(a) === id);
  return area && typeof area.label === 'string' && area.label.trim() ? area.label.trim() : null;
}

// ── Priority: THREE of them (WO-18) ──────────────────────────────────────────
// 🔴 Matt, 2026-09-30 (WO-18 follow-up): "lets make a change put low, medium, urgent."
// Four levels (urgent/high/medium/low) became three; "high" is RETIRED. Daniel's call on
// what happens to the tickets that carry it: they become URGENT, so none of them gets
// quieter — which is why `RETIRED_PRIORITY` normalizes UP rather than to the default, and
// why the data migration (supabase/migrations/20261003100000_work_order_priority_three.sql)
// moves the stored column the same way.
export const WO_PRIORITIES = ['urgent', 'medium', 'low'];
export const WO_PRIORITY_META = {
  // The three have to stay tellable apart at a glance, so each owns its own colour:
  // red for the one that wakes people, amber for the ordinary one, slate for the rest.
  urgent: { label: 'Urgent', rank: 0, badge: 'red' },
  medium: { label: 'Medium', rank: 1, badge: 'amber' },
  low:    { label: 'Low',    rank: 2, badge: 'slate' },
};
export const DEFAULT_WO_PRIORITY = 'medium';
// The retired level and where it lands. Named rather than inlined so the normalizer, the
// severity seam and anything reading a legacy row give the one answer.
export const RETIRED_PRIORITY = 'high';
export const RETIRED_PRIORITY_BECOMES = 'urgent';
export const woPriorityLabel = (p) => WO_PRIORITY_META[normalizePriority(p)].label;
export const woPriorityRank = (p) => WO_PRIORITY_META[normalizePriority(p)].rank;
export const normalizePriority = (p) => {
  if (p === RETIRED_PRIORITY) return RETIRED_PRIORITY_BECOMES;   // WO-18: nothing gets quieter
  return WO_PRIORITIES.includes(p) ? p : DEFAULT_WO_PRIORITY;
};
// Migration seam: the old severity (low/med/high) maps into priority. `med` becomes
// `medium`; `low` carries over; `high` follows WO-18 up to urgent. Used by the seed/stub
// and the SQL backfill mirror.
export const severityToPriority = (sev) => normalizePriority({ low: 'low', med: 'medium', high: RETIRED_PRIORITY }[sev]);

// ── Category: what KIND of thing this ticket is about (WO-12) ────────────────
// Matt, 2026-09-29: "Beyond complaint, request and problem, do you want categories for
// reporting? — (a) Yes: restock, spill, missed area, extra service, other." It is a second
// axis, NOT a replacement for `type`: type says who is complaining (a complaint / a request /
// an issue we found), category says what it is about, which is what a report can group by.
//
// Nullable on the row and normalized only when a value is SENT (a legacy ticket, and every
// row in production today, carries none — "Uncategorized" is an honest state, not 'other').
//
// `damage` (2026-10-17): QR-23 (c), a visitor's "Something broken or damaged", files under its own
// category so the office can find and count broken things; additive (no DB check), and every
// reader of the list — the office's new work order, the drawer, the Work Orders filter and the
// customer hub's form — offers it with the rest. 'other' stays last.
export const WO_CATEGORIES = ['restock', 'spill', 'missed_area', 'extra_service', 'damage', 'other'];
export const WO_CATEGORY_META = {
  restock:       { label: 'Restock',       hint: 'Supplies to top up.' },
  spill:         { label: 'Spill',         hint: 'A spill or mess needing attention.' },
  missed_area:   { label: 'Missed area',   hint: 'Somewhere that was not cleaned.' },
  extra_service: { label: 'Extra service', hint: 'Work beyond the contract.' },
  damage:        { label: 'Damage',        hint: 'Something broken or damaged.' },
  other:         { label: 'Other',         hint: "Anything the others don't cover." },
};
export const UNCATEGORIZED_LABEL = 'Uncategorized';
// A SENT value is kept only when it is one of the five; anything else — including '' — reads
// as none, so a stray value can never become a category nobody can filter by.
export const normalizeCategory = (c) => (WO_CATEGORIES.includes(c) ? c : null);
export const woCategoryLabel = (c) => WO_CATEGORY_META[c]?.label || UNCATEGORIZED_LABEL;

// ── A completion photo is required to RESOLVE (WO-10) ────────────────────────
// Matt, 2026-09-29: "Is a completion photo required to close a ticket? — (b) Always
// required." The photo is an `account_media` row at scope `problem_report` with the ticket's
// id as its `refId` — the same gallery the drawer already shows. ONE rule for the server
// (api/qc problems/update), the demo stub and the drawer's Resolve control.
//
// It gates ONLY the move to `resolved`: every other status change, and a REOPEN, is
// untouched — a ticket must always be able to come back out of resolved.
export const RESOLVE_PHOTO_CODE = 'photo-required';
export const RESOLVE_PHOTO_MESSAGE = 'Add a completion photo before resolving this ticket.';
export function resolvePhotoRefusal({ status, photoCount } = {}) {
  if (normalizeStatus(status) !== 'resolved') return null;
  return (Number(photoCount) || 0) > 0 ? null : RESOLVE_PHOTO_CODE;
}

// ── …so a ticket needs its LOCATION (CS-697; CS-128's "require a site") ────────
// A completion photo is filed under the ticket's building (`/api/account-media` refuses an upload
// with no site), so a ticket with no location could never be resolved: a failed inspection
// started with "no specific location", or a work order logged with that default, sat overdue in
// Client Requests forever. So a work order and an inspection are not started without a location,
// and the office gives a ticket that has none (an older one; one a location-less draft opened)
// its location, once: it never moves after that (its photos are filed under it). ONE rule, read
// by the route (problems/create, inspections/create, problems/update `siteId`), the demo stub
// and the screens.
export const LOCATION_CODES = Object.freeze({
  required: 'location-required',             // none picked
  unknown: 'location-unknown',               // not one of the company's locations
  otherCustomer: 'location-other-customer',  // a ticket of one customer takes only that customer's
  set: 'location-set',                       // the ticket already has its location
  officeOnly: 'location-office-only',        // only the office sets a ticket's location
});
// What a screen says for each, in the reader's language (i18n/errors errorText's `known` map).
export const LOCATION_ERROR_KEYS = Object.freeze({
  [LOCATION_CODES.required]: 'workOrders.location.required',
  [LOCATION_CODES.unknown]: 'workOrders.location.unknown',
  [LOCATION_CODES.otherCustomer]: 'workOrders.location.otherCustomer',
  [LOCATION_CODES.set]: 'workOrders.location.set',
  [LOCATION_CODES.officeOnly]: 'workOrders.location.officeOnly',
});
// The server's words for each (a screen shows its catalog line by the code).
export const LOCATION_MESSAGES = Object.freeze({
  [LOCATION_CODES.required]: 'Pick a location first.',
  [LOCATION_CODES.unknown]: 'That location is not one of this company’s.',
  [LOCATION_CODES.otherCustomer]: 'Pick one of this ticket’s customer’s locations.',
  [LOCATION_CODES.set]: 'This ticket already has a location.',
  [LOCATION_CODES.officeOnly]: 'Only the office can set a ticket’s location.',
});
// The location a write may file at, or its refusal code. `sites` is the company's book; a ticket
// that already belongs to a customer (`clientId`) takes only one of that customer's locations.
export function locationRefusal({ siteId, sites = [], clientId = null } = {}) {
  if (!siteId) return LOCATION_CODES.required;
  const site = (Array.isArray(sites) ? sites : []).find((s) => s && s.id === siteId);
  if (!site) return LOCATION_CODES.unknown;
  if (clientId && site.clientId && site.clientId !== clientId) return LOCATION_CODES.otherCustomer;
  return null;
}

// ── "Complaining too much": an account flagged on ticket volume (WO-14) ──────
// Matt, 2026-09-29: "How should 'complaining too much' show up? — (a) A flag on the account
// when it passes a set number of tickets in 30 days", answer note: 10. The window is fixed at
// 30 days (his question said so); the COUNT is an org setting so the office can retune it.
export const TICKET_FLAG_DAYS = 30;
export const DEFAULT_TICKET_FLAG_COUNT = 10;
// Clamped at 1 — a threshold of 0 would flag every account including the ones with no tickets,
// which is not a flag, it is noise.
export const MAX_TICKET_FLAG_COUNT = 1000;
export function ticketFlagThreshold(settings = {}) {
  const v = settings?.ticketFlagCount30d;
  if (!Number.isFinite(v) || v < 1) return DEFAULT_TICKET_FLAG_COUNT;
  return Math.min(MAX_TICKET_FLAG_COUNT, Math.floor(v));
}
// "Passes a set number" reads as AT or above it: the flag is meant to fire ON the tenth
// ticket, not the eleventh.
export function isTicketFlagged(count, settings = {}) {
  return (Number(count) || 0) >= ticketFlagThreshold(settings);
}
export function ticketFlagLabel(count) {
  return `${Number(count) || 0} tickets in ${TICKET_FLAG_DAYS} days`;
}

// Per-account ticket counts over the window, from rows carrying `client_id` + `created_at` (and
// `origin`). Pure so the customer page, the customers list and the tests share one tally.
// 🔴 QR-26: a VISITOR's report is not the customer's ticket volume — they did not make it — so it
// is never counted here (the server's read carries `origin` for this: store.TICKET_COUNT_COLUMNS).
export function ticketCountsByClient(rows = [], { now = Date.now(), days = TICKET_FLAG_DAYS } = {}) {
  const cutoff = now - days * 24 * 3600 * 1000;
  const counts = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (isVisitorReport(r)) continue;
    const clientId = r?.client_id ?? r?.clientId ?? null;
    if (!clientId) continue;
    const t = Date.parse(r.created_at ?? r.createdAt ?? '');
    if (!Number.isFinite(t) || t < cutoff) continue;
    counts.set(clientId, (counts.get(clientId) || 0) + 1);
  }
  return counts;
}

// ── Status: the lifecycle (escalation is a separate flag, not a status) ───────
export const WO_STATUSES = ['open', 'in_progress', 'awaiting_client', 'resolved'];
export const WO_STATUS_META = {
  open:            { label: 'Open',           badge: 'red' },
  in_progress:     { label: 'In progress',    badge: 'amber' },
  awaiting_client: { label: 'Awaiting client', badge: 'purple' },
  resolved:        { label: 'Resolved',       badge: 'green' },
};
export const DEFAULT_WO_STATUS = 'open';
export const woStatusLabel = (s) => WO_STATUS_META[s]?.label || s;
// Legacy problem_reports used open/ack/resolved; `ack` folds into `in_progress`.
export const normalizeStatus = (s) => (s === 'ack' ? 'in_progress' : (WO_STATUSES.includes(s) ? s : DEFAULT_WO_STATUS));
// "Advance" walks the happy path; resolved is terminal (Reopen sends it back to open).
export const WO_STATUS_FLOW = ['open', 'in_progress', 'awaiting_client', 'resolved'];
export function nextStatus(s) {
  const i = WO_STATUS_FLOW.indexOf(normalizeStatus(s));
  return i >= 0 && i < WO_STATUS_FLOW.length - 1 ? WO_STATUS_FLOW[i + 1] : null;
}
export const isOpenStatus = (s) => normalizeStatus(s) !== 'resolved';

// ── What the CLIENT is told: four stages (WO-8) ──────────────────────────────
// Matt, 2026-09-29: "Which stages should the client be told about? — (a) We received it;
// (b) Someone is working on it; (c) We need more information from you; (d) Completed, with
// the photo." ★ They are the four office statuses read in the client's words, one to one — so
// there is ONE table and every client-facing surface (the hub, its history, its emails) reads
// it, while the office keeps its own queue labels above. A legacy status normalizes first
// (`ack` → working on it), and anything unknown reads as RECEIVED, never as completed: a
// customer told "completed" about a ticket nobody finished is the one wrong answer here.
export const WO_CLIENT_STAGES = Object.freeze([
  Object.freeze({ key: 'received', status: 'open', label: 'We received it' }),
  Object.freeze({ key: 'working', status: 'in_progress', label: 'We’re working on it' }),
  Object.freeze({ key: 'needs_info', status: 'awaiting_client', label: 'We need more information from you' }),
  Object.freeze({ key: 'completed', status: 'resolved', label: 'Completed' }),
]);
export function woClientStage(status) {
  const s = normalizeStatus(status);
  return WO_CLIENT_STAGES.find((x) => x.status === s) || WO_CLIENT_STAGES[0];
}

// ── The client may REOPEN a completed ticket, for seven days (WO-11) ──────────
// Matt, 2026-09-29: "After a ticket is marked complete, can the client reopen it? — (a) Yes,
// within 7 days." ★ Measured from `resolved_at`, inclusive of the seventh day's last minute;
// a completed ticket with no completion time fails CLOSED (there is no window to be inside).
// ONE rule for the hub's button, the server's refusal and the demo. Reopening is never gated
// on photos (WO-10 covers only the move TO resolved).
export const TICKET_REOPEN_DAYS = 7;
const REOPEN_MS = TICKET_REOPEN_DAYS * 24 * 3600 * 1000;
export const REOPEN_NOT_COMPLETED = 'not-completed';
export const REOPEN_WINDOW_CLOSED = 'reopen-window-closed';
export function ticketReopenDeadline(resolvedAt) {
  const t = Date.parse(resolvedAt);
  return Number.isFinite(t) ? new Date(t + REOPEN_MS).toISOString() : null;
}
export function ticketReopenRefusal({ status, resolvedAt, now = Date.now() } = {}) {
  if (normalizeStatus(status) !== 'resolved') return REOPEN_NOT_COMPLETED;
  const t = Date.parse(resolvedAt);
  if (!Number.isFinite(t)) return REOPEN_WINDOW_CLOSED;
  return now - t <= REOPEN_MS ? null : REOPEN_WINDOW_CLOSED;
}

// ── The deadline clock: by TYPE for a client's request, by urgency for an issue ────────────
// 🔴 Matt's email (2026-10-09), his response standards: "30 min to first reply, 2 hours for a
// complaint, 24 hours for a standard request, 48 hours for a failed-inspection fix". WO-20 ★a: the
// TYPE sets a client request's deadline; urgency (urgent / medium / low) only sorts the list and
// keeps its after-hours alert role (WO-7). WO-21 ★a: an ISSUE (logged by the office or a crew, not
// by a client) keeps the urgency clock below. ONE rule — `deadlineHours` — read by the server at
// every create and every type or urgency change, the demo stub, every screen (toWorkOrder derives
// the deadline) and lib/ticketAlerts' escalation when the time runs out. The first reply (30
// minutes) is the org's no-reply window (WO-5, lib/ticketAlerts ticketEscalateMins), a separate
// clock that runs until the office first answers the client (lib/clientRequests requestClock).
//
// 🔴 EXISTING TICKETS: the deadline is DERIVED AT READ from `created_at` + this rule, never taken
// from the stored `due_at` — so every open ticket follows the new standards the moment this ships,
// with no migration, and there is never a second rule hiding in old rows. The stored `due_at` is
// still written (by this same rule) on every create and type / urgency change, as a cache.
export const TYPE_DEADLINE_HOURS = Object.freeze({ complaint: 2, request: 24, failed_inspection: 48 });
// A CLIENT request — a type with its own deadline — as opposed to an issue the team logged (which
// has no client to answer, so no first-reply clock: lib/clientRequests requestClock).
export const isClientRequestType = (type) => Object.prototype.hasOwnProperty.call(TYPE_DEADLINE_HOURS, type);
// The urgency clock (WO-18: urgent 2 hours, medium 1 day, low 3 days) — an issue's deadline.
export const SLA_HOURS = { urgent: 2, medium: 24, low: 72 };
const HOUR = 3600 * 1000;

// Hours from creation to the deadline for a ticket { type, priority } (a raw row is fine: the
// TYPE is read as stored, so a type this build's vocabulary does not list yet — a failed
// inspection before Builder B's merge — still gets its own deadline). A bare string is read as a
// priority (an issue's clock), the shape older callers pass.
export function deadlineHours(ticket) {
  const t = typeof ticket === 'string' ? { priority: ticket } : (ticket || {});
  if (Object.prototype.hasOwnProperty.call(TYPE_DEADLINE_HOURS, t.type)) return TYPE_DEADLINE_HOURS[t.type];
  const priority = t.priority ? normalizePriority(t.priority) : severityToPriority(t.severity);
  return SLA_HOURS[priority];
}

// A span of hours as a number and its unit — { unit: 'days', count: 1 } for 24, { unit: 'hours',
// count: 2 } for 2 (whole days read as days). A translated screen words it from these (the Client
// Requests banner); the English phrasing below reads the same parts.
export function hoursParts(hours) {
  const h = Number(hours) || 0;
  return h % 24 === 0 && h > 0 ? { unit: 'days', count: h / 24 } : { unit: 'hours', count: h };
}
const hoursLabel = (hours) => {
  const { unit, count } = hoursParts(hours);
  return unit === 'days' ? `${count} ${count === 1 ? 'day' : 'days'}` : `${count} ${count === 1 ? 'hour' : 'hours'}`;
};
// An issue's urgency target as parts / in English words ("2 hours", "1 day", "3 days").
export function slaTargetParts(priority) { return hoursParts(SLA_HOURS[normalizePriority(priority)]); }
export function slaTargetLabel(priority) { return hoursLabel(SLA_HOURS[normalizePriority(priority)]); }
// A client request type's target in English words, in HOURS as Matt wrote his standards ("24
// hours for a standard request") — the settings page's help text.
export function typeTargetLabel(type) {
  const h = Number(TYPE_DEADLINE_HOURS[type]) || 0;
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}
const SOON_MS = 2 * HOUR; // within this window of the deadline = "breaching soon"

// The deadline instant for a ticket created at `createdAtIso` (the rule above).
export function computeDueAt(createdAtIso, ticket) {
  const base = createdAtIso ? new Date(createdAtIso).getTime() : Date.now();
  if (!Number.isFinite(base)) return null;
  return new Date(base + deadlineHours(ticket) * HOUR).toISOString();
}

// Humanize a positive millisecond span: "45m", "1h 10m", "2d 3h".
function fmtDur(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) { const m = mins % 60; return m ? `${hrs}h ${m}m` : `${hrs}h`; }
  const days = Math.floor(hrs / 24); const h = hrs % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
}

// Derive the SLA badge for a work order. Returns { state, label } where state is one
// of: 'breached' | 'soon' | 'ok' | 'paused' | 'met' | 'missed' | 'none'.
// - resolved: met/missed by resolved_at vs due_at (no due → just "Resolved").
// - awaiting_client: the clock is PAUSED (we're waiting on them, not us).
// - open/in_progress with a due: breached / soon / ok by time remaining.
export function deriveSla({ dueAt, status, resolvedAt, now = Date.now() } = {}) {
  const st = normalizeStatus(status);
  const due = dueAt ? new Date(dueAt).getTime() : null;
  if (st === 'resolved') {
    if (!due) return { state: 'met', label: 'Resolved' };
    const done = resolvedAt ? new Date(resolvedAt).getTime() : now;
    return done <= due
      ? { state: 'met', label: 'Resolved · SLA met' }
      : { state: 'missed', label: 'Resolved · SLA missed' };
  }
  if (st === 'awaiting_client') return { state: 'paused', label: 'Client · paused' };
  if (!due || !Number.isFinite(due)) return { state: 'none', label: '—' };
  const left = due - now;
  if (left < 0) return { state: 'breached', label: `Breached ${fmtDur(-left)}` };
  if (left <= SOON_MS) return { state: 'soon', label: `Due in ${fmtDur(left)}` };
  return { state: 'ok', label: `Due in ${fmtDur(left)}` };
}
// A work order is "breaching" (needs attention now) when its SLA is due-soon or blown.
export const isBreaching = (slaState) => slaState === 'soon' || slaState === 'breached';

// ── Complaints fold-in (Increment 3) ─────────────────────────────────────────
// The standalone blob `complaints` slice was retired; a customer complaint is now a
// Work Order of type:complaint. Maps a legacy blob complaint —
// { id, status, clientId, clientName, detail, createdAt, updatedAt, resolvedAt, createdBy }
// — into a problem_reports insert payload. Pure + org-parametrized so the connected
// backfill (scripts/backfill-complaints-to-workorders.mjs) and its unit test share it.
// Old complaints carried no severity → medium; they were staff-logged → origin internal;
// their status was open|resolved (anything else normalizes to open). `organization_id` is
// supplied by the caller (null in tests).
// Legacy complaint lifecycle was Open → Ongoing → Resolved; `ongoing` is the WO
// `in_progress`. Anything unexpected normalizes to `open` (never silently resolved).
const COMPLAINT_STATUS_MAP = { open: 'open', ongoing: 'in_progress', resolved: 'resolved' };
export function complaintToWorkOrderRow(complaint = {}, { orgId = null, now = Date.now() } = {}) {
  const createdAt = complaint.createdAt || new Date(now).toISOString();
  const status = normalizeStatus(COMPLAINT_STATUS_MAP[complaint.status] || complaint.status);
  const priority = DEFAULT_WO_PRIORITY;
  const detail = (complaint.detail || '').trim();
  const title = (detail.split('\n')[0] || '').slice(0, 120) || 'Complaint';
  return {
    organization_id: orgId,
    client_id: complaint.clientId || null,
    site_id: null,
    job_id: null,
    reported_by_user_id: complaint.createdBy || null,
    assignee_user_id: null,
    client_name: complaint.clientName || null,
    site_name: null,
    title,
    description: detail || null,
    type: 'complaint',
    origin: 'internal',
    priority,
    status,
    created_at: createdAt,
    resolved_at: status === 'resolved' ? (complaint.resolvedAt || complaint.updatedAt || createdAt) : null,
    due_at: computeDueAt(createdAt, { type: 'complaint', priority }),
    escalated_at: null,
  };
}

// Normalize a raw problem_reports/stub row into a consistent Work Order view-model.
// Tolerates legacy rows (severity-only, ack status, no type/origin/priority/due).
export function toWorkOrder(row = {}) {
  const priority = row.priority ? normalizePriority(row.priority) : severityToPriority(row.severity);
  const status = normalizeStatus(row.status);
  const createdAt = row.created_at || row.createdAt || null;
  // WO-20 / WO-21: DERIVED at read from the stored type (raw, so a type not yet in WO_TYPES keeps
  // its own deadline) and the urgency — never the stored due_at, which may predate the rule.
  const dueAt = computeDueAt(createdAt, { type: row.type, priority });
  return {
    ...row,
    type: WO_TYPES.includes(row.type) ? row.type : DEFAULT_WO_TYPE,
    origin: WO_ORIGINS.includes(row.origin) ? row.origin : DEFAULT_WO_ORIGIN,
    priority,
    status,
    due_at: dueAt,
    category: normalizeCategory(row.category),
    assignee_user_id: row.assignee_user_id || null,
    escalated_at: row.escalated_at || null,
    escalated: !!row.escalated_at,
  };
}

// ── The work-order reads: every OPEN ticket, a page of the resolved history (CS-640) ─────────
// The queue was read as the newest 500 work orders of every status, so past 500 tickets in total
// the oldest OPEN ones silently fell off every list and count. The route now answers three views
// (api/qc problems/list): every open ticket (complete), ONE page of the resolved history with its
// exact total, and every ticket created since an instant (complete). These are the same views as
// pure rules over a set of rows — what the demo stub (lib/qcApi) runs, so the demo answers as the
// server does — and the sizes both sides use.
export const WO_RESOLVED_PAGE = 50;        // a page of the resolved history
export const WO_RESOLVED_PAGE_MAX = 100;   // the most one call may ask for
export const WO_RESOLVED_RECENT_HOURS = 24; // the Work Orders tab's "Resolved (24h)"
const msOf = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };
// Newest first, then id (the server's order: created_at desc, id desc).
const newestCreatedFirst = (a, b) => ((msOf(b.created_at) ?? 0) - (msOf(a.created_at) ?? 0)) || String(b.id).localeCompare(String(a.id));
// Newest RESOLVED first; a legacy row with no resolved_at last; then as above.
const newestResolvedFirst = (a, b) => {
  const ra = msOf(a.resolved_at);
  const rb = msOf(b.resolved_at);
  if (ra !== rb) {
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  }
  return newestCreatedFirst(a, b);
};
const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter(Boolean) : []);

// Every open ticket (anything not resolved; a legacy `ack` is open).
export function openWorkOrderRows(rows) {
  return rowsOf(rows).filter((r) => isOpenStatus(r.status)).sort(newestCreatedFirst);
}
// Every ticket created at or after `sinceIso`, whatever its status.
export function workOrderRowsSince(rows, sinceIso) {
  const since = msOf(sinceIso);
  return rowsOf(rows).filter((r) => since == null || (msOf(r.created_at) ?? -Infinity) >= since).sort(newestCreatedFirst);
}
// ONE page of the resolved history: { problems, total, last24h, offset, limit }. `total` counts
// every resolved ticket (the page is not the history); `last24h` those resolved in the last day.
export function resolvedWorkOrderPage(rows, { offset = 0, limit = WO_RESOLVED_PAGE, now = Date.now() } = {}) {
  const resolved = rowsOf(rows).filter((r) => normalizeStatus(r.status) === 'resolved').sort(newestResolvedFirst);
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.max(1, Math.min(WO_RESOLVED_PAGE_MAX, Math.floor(Number(limit) || WO_RESOLVED_PAGE)));
  const recentFrom = now - WO_RESOLVED_RECENT_HOURS * 3600 * 1000;
  return {
    problems: resolved.slice(from, from + size),
    total: resolved.length,
    last24h: resolved.filter((r) => (msOf(r.resolved_at) ?? -Infinity) >= recentFrom).length,
    offset: from,
    limit: size,
  };
}
// Several reads joined, each ticket once (the first copy wins): the Dashboard joins every open
// complaint with every complaint of its window, so both its "open" and its windowed figures are
// complete.
export function mergeWorkOrderRows(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const r of rowsOf(list)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}
