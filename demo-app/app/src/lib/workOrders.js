// Work Orders — shared vocabulary + SLA math for the client-raised ticketing queue
// that lives in the Quality hub (the evolved "Problems" surface). ONE source of
// truth for type / priority / status / origin, the SLA clock, and the status flow,
// used by the UI (Inspections Work Orders tab, WorkOrderModal) and mirrored by the
// demo stub (lib/qcApi.js) + backend (api/_lib/qc/store.js). Pure — no imports, so
// the same helpers are safe on the server and in tests.
//
// Model: a Work Order is a problem_reports row grown with `type`
// (complaint | request | issue), `origin` (portal | internal), `priority`
// (urgent…low — REPLACES the old low/med/high `severity`), `assignee_user_id`,
// `due_at` (the SLA clock), and `escalated_at`. Queue = the account's supervisor
// (client.supervisorId); scoping mirrors Reports.jsx. Increments: 1 the queue, 2 the
// message thread, 3 the Complaints fold-in (customer complaints ARE Work Orders of
// type:complaint — the standalone blob `complaints` slice was retired).

// ── Type: what kind of work order this is ────────────────────────────────────
export const WO_TYPES = ['complaint', 'request', 'issue'];
export const WO_TYPE_META = {
  complaint: { label: 'Complaint', badge: 'red', hint: 'Something went wrong — a service miss or recurring gripe.' },
  request:   { label: 'Request',   badge: 'blue', hint: 'The client wants something added or changed.' },
  issue:     { label: 'Issue',     badge: 'slate', hint: 'A field/maintenance issue the crew or office flagged.' },
};
export const DEFAULT_WO_TYPE = 'issue';
export const woTypeLabel = (t) => WO_TYPE_META[t]?.label || WO_TYPE_META[DEFAULT_WO_TYPE].label;

// ── Origin: who raised it ────────────────────────────────────────────────────
export const WO_ORIGINS = ['portal', 'internal'];
export const WO_ORIGIN_META = {
  portal:   { label: 'Client portal', hint: 'Raised by the client in the portal.' },
  internal: { label: 'Internal',      hint: 'Logged internally by staff.' },
};
export const DEFAULT_WO_ORIGIN = 'internal';
export const woOriginLabel = (o) => WO_ORIGIN_META[o]?.label || WO_ORIGIN_META[DEFAULT_WO_ORIGIN].label;

// ── Priority: replaces severity (adds "urgent" above the old high) ───────────
export const WO_PRIORITIES = ['urgent', 'high', 'medium', 'low'];
export const WO_PRIORITY_META = {
  urgent: { label: 'Urgent', rank: 0, badge: 'red' },
  high:   { label: 'High',   rank: 1, badge: 'amber' },
  medium: { label: 'Medium', rank: 2, badge: 'slate' },
  low:    { label: 'Low',    rank: 3, badge: 'slate' },
};
export const DEFAULT_WO_PRIORITY = 'medium';
export const woPriorityLabel = (p) => WO_PRIORITY_META[p]?.label || WO_PRIORITY_META[DEFAULT_WO_PRIORITY].label;
export const woPriorityRank = (p) => WO_PRIORITY_META[p]?.rank ?? WO_PRIORITY_META[DEFAULT_WO_PRIORITY].rank;
export const normalizePriority = (p) => (WO_PRIORITIES.includes(p) ? p : DEFAULT_WO_PRIORITY);
// Migration seam: the old severity (low/med/high) maps into priority. `med` becomes
// `medium`; `high`/`low` carry over. Used by the seed/stub and the SQL backfill mirror.
export const severityToPriority = (sev) => ({ low: 'low', med: 'medium', high: 'high' }[sev] || DEFAULT_WO_PRIORITY);

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

// ── SLA clock ────────────────────────────────────────────────────────────────
// Hours-to-due per priority. A default that works from day one; org-configurable
// SLA (opsSettings) is a later increment — readers already tolerate a null due_at.
export const SLA_HOURS = { urgent: 2, high: 8, medium: 24, low: 72 };
const HOUR = 3600 * 1000;
const SOON_MS = 2 * HOUR; // within this window of the deadline = "breaching soon"

export function computeDueAt(createdAtIso, priority) {
  const base = createdAtIso ? new Date(createdAtIso).getTime() : Date.now();
  if (!Number.isFinite(base)) return null;
  const hrs = SLA_HOURS[normalizePriority(priority)] ?? SLA_HOURS[DEFAULT_WO_PRIORITY];
  return new Date(base + hrs * HOUR).toISOString();
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
    due_at: computeDueAt(createdAt, priority),
    escalated_at: null,
  };
}

// Normalize a raw problem_reports/stub row into a consistent Work Order view-model.
// Tolerates legacy rows (severity-only, ack status, no type/origin/priority/due).
export function toWorkOrder(row = {}) {
  const priority = row.priority ? normalizePriority(row.priority) : severityToPriority(row.severity);
  const status = normalizeStatus(row.status);
  const createdAt = row.created_at || row.createdAt || null;
  const dueAt = row.due_at || computeDueAt(createdAt, priority);
  return {
    ...row,
    type: WO_TYPES.includes(row.type) ? row.type : DEFAULT_WO_TYPE,
    origin: WO_ORIGINS.includes(row.origin) ? row.origin : DEFAULT_WO_ORIGIN,
    priority,
    status,
    due_at: dueAt,
    assignee_user_id: row.assignee_user_id || null,
    escalated_at: row.escalated_at || null,
    escalated: !!row.escalated_at,
  };
}
