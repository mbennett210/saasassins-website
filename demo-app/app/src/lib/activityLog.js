// The activity log's VOCABULARY and its pure rules — shared by the server writer
// (api/_lib/activityLog.js), the read route, the Reports screen and the customer tab, so
// the label a screen shows, the action a writer stores and the visibility a route enforces
// can never drift. CS-379; Matt's answers LOG-1..8 (meetings/2026-09-29-matt-answers.md).
//
// Zero imports but the two dependency-free money/JSON helpers, so it unit-tests headless
// and loads on the server as happily as in the browser.
//
// WHAT IS LOGGED (LOG-2 a, "a set list of important actions"): the ACTIONS registry below
// IS that list. Nothing writes an action that is not in it (the server writer refuses one),
// so "what is logged" is one readable table rather than a habit spread over 40 routes.
// Sign-ins are deliberately absent (LOG-8 a, "not now").
//
// BEFORE / AFTER (LOG-3 a): money, roles, schedules and inspections carry `before`/`after`
// and a summary that spells the change out — "pay rate $15.00 → $16.00".
//
// WHO SEES WHAT (LOG-4 a): logVisibilityFor(role) — the owner everything; an admin
// everything except pay and money; a manager only the customers they supervise; crew
// nothing. Enforced on the SERVER read (api/activity), because the blob is on-device and a
// client-side filter is not a boundary.
//
// RETENTION (LOG-5 a): RETENTION_YEARS = 3, applied at the WRITE point's own horizon by the
// daily purge (THE LAW II.8). Rows are never editable: the table grants no UPDATE to anyone.
// Explicit .js — the serverless routes import this file through node's ESM resolver, which
// (unlike Vite) does not add extensions.
//
// Two more pure, dependency-light imports since the client hub's Round 2 (2026-10-04), both for
// the customer-facing service events below and nothing else: `hubPersonName` (the ONE "first
// name + last initial" rule, src/lib/clientHub.js) and `resultLabel` (an inspection result in
// words, src/lib/inspections.js). Neither reaches a backend.
import { canonicalJson } from './canonicalJson.js';
import { invoiceTotal } from './money.js';
import { hubPersonName } from './clientHub.js';
import { resultLabel } from './inspections.js';
import { cleanedCountsOf } from './checklistCount.js';

// ── Retention (LOG-5) ───────────────────────────────────────────────────────
export const RETENTION_YEARS = 3;

// Everything strictly older than this is purged by the daily cron. Computed from the
// constant, never a restated literal, so the test and the purge agree by construction.
export function retentionCutoffIso(now = Date.now()) {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - RETENTION_YEARS);
  return d.toISOString();
}

// ── The action vocabulary (LOG-2's "set list") ──────────────────────────────
// group  → the Reports filter's "Action type" options (ACTION_GROUPS below)
// entity → what the row is ABOUT, stored as entity_type
// money  → a PAY or MONEY change, which an admin must not see (LOG-4)
// auto   → raised by a cron, never by a person (LOG-7)
export const ACTIONS = Object.freeze({
  // Inspections (LOG-3: before/after)
  'inspection.submitted': { label: 'Inspection submitted', group: 'inspections', entity: 'inspection' },
  'inspection.edited': { label: 'Inspection edited', group: 'inspections', entity: 'inspection' },

  // Schedule (LOG-3: before/after)
  'job.created': { label: 'Clean scheduled', group: 'schedule', entity: 'job' },
  'job.moved': { label: 'Clean moved', group: 'schedule', entity: 'job' },
  'job.crew_changed': { label: 'Crew changed', group: 'schedule', entity: 'job' },
  'job.cancelled': { label: 'Clean cancelled', group: 'schedule', entity: 'job' },
  'job.deleted': { label: 'Clean deleted', group: 'schedule', entity: 'job' },
  // QR Wave 2 (QR-14): a cleaner scanned the building's code and filled in for someone on today's
  // clean — the crew swap and who covers whom, written by the server on their behalf (EP-419).
  'job.filled_in': { label: 'Cleaner filled in from a scan', group: 'schedule', entity: 'job' },
  // Crew on the way (lib/crewOnTheWay.js): a cleaner tapped On my way. ONE row per clean, its id
  // the clean's (api/_lib/customerMessages/onTheWay.js); the customer hub's bell reads it too.
  'job.on_the_way': { label: 'Crew on the way', group: 'schedule', entity: 'job' },

  // Time clock — the five manager edits plus the two approvals
  'time.corrected': { label: 'Time corrected', group: 'time', entity: 'time_entry' },
  'time.added': { label: 'Time added by hand', group: 'time', entity: 'time_entry' },
  'time.deleted': { label: 'Time deleted', group: 'time', entity: 'time_entry' },
  'time.restored': { label: 'Time restored', group: 'time', entity: 'time_entry' },
  'time.approved': { label: 'Hours approved', group: 'time', entity: 'time_entry' },
  'time.overtime_approved': { label: 'Overtime approved', group: 'time', entity: 'overtime' },

  // People — pay is MONEY, the role is authority (LOG-3: before/after for both)
  'pay.rate_changed': { label: 'Pay rate changed', group: 'people', entity: 'user', money: true },
  'user.role_changed': { label: 'Access level changed', group: 'people', entity: 'user' },

  // Customers
  'customer.added': { label: 'Customer added', group: 'customers', entity: 'client' },
  'customer.archived': { label: 'Customer archived', group: 'customers', entity: 'client' },
  'customer.reactivated': { label: 'Customer reactivated', group: 'customers', entity: 'client' },
  'customer.removed': { label: 'Customer removed', group: 'customers', entity: 'client' },
  // A staff member opened the customer hub as a building's customers see it (the client hub
  // redesign's read-only preview, plan §3.7): who looked, and at which building.
  'hub.previewed': { label: 'Customer hub previewed', group: 'customers', entity: 'client' },

  // Money on an invoice (LOG-3 names invoice amounts explicitly)
  'invoice.amount_changed': { label: 'Invoice amount changed', group: 'money', entity: 'invoice', money: true },

  // Contracts (CON-1..CON-14, CS-194). A signed agreement IS the money: its annual value is
  // what the account is worth, so all three are `money: true` and an admin's "everything
  // except pay and money" read (LOG-4) leaves them out, exactly as it does an invoice amount.
  // before/after carry the monthly price in CENTS and the term dates, which is the pair a
  // dispute actually turns on.
  'contract.created': { label: 'Contract added', group: 'contracts', entity: 'contract', money: true },
  'contract.edited': { label: 'Contract edited', group: 'contracts', entity: 'contract', money: true },
  'contract.deleted': { label: 'Contract deleted', group: 'contracts', entity: 'contract', money: true },

  // Tickets (work orders)
  'ticket.status_changed': { label: 'Ticket status changed', group: 'tickets', entity: 'work_order' },
  'ticket.replied': { label: 'Ticket reply', group: 'tickets', entity: 'work_order' },

  // Customer messages (the client hub redesign, plan §3.4): a customer's line in their building's
  // thread (actor role `client`, never a staff id) and the office's reply. Never money.
  'customer_message.received': { label: 'Customer message', group: 'messages', entity: 'client_message' },
  'customer_message.replied': { label: 'Reply to a customer message', group: 'messages', entity: 'client_message' },

  // Supplies — ANY status change, so a status the supplies build adds later is covered
  'supply_request.status_changed': { label: 'Supply request status changed', group: 'supplies', entity: 'supply_request' },
  // A request cancelled before it went out (CS-670): the row is DELETED, so this entry — who, which
  // building, and what it asked for (`before`) — is all the record keeps of it.
  'supply_request.cancelled': { label: 'Supply request cancelled', group: 'supplies', entity: 'supply_request' },
  // The supply orders (S131): an order's lines delivered, backordered or cancelled (one row per act
  // call, naming each line), and the supplier's invoice kept with it or removed (a removed file is
  // gone from Storage, so this row is all the record keeps of it).
  'supply_order.lines_changed': { label: 'Supply order items delivered, backordered or cancelled', group: 'supplies', entity: 'supply_request' },
  'supply_order.invoice_added': { label: 'Supply order invoice added', group: 'supplies', entity: 'supply_request' },
  'supply_order.invoice_removed': { label: 'Supply order invoice removed', group: 'supplies', entity: 'supply_request' },
  // The master supply list (the Oct 6 call, plan 2026-10-11 §2): the office's catalog, and which
  // items a building has switched on (that row carries the building, so its manager sees it).
  'supply_catalog.created': { label: 'Supply catalog item added', group: 'supplies', entity: 'supply_catalog_item' },
  'supply_catalog.edited': { label: 'Supply catalog item edited', group: 'supplies', entity: 'supply_catalog_item' },
  'supply_catalog.deleted': { label: 'Supply catalog item deleted', group: 'supplies', entity: 'supply_catalog_item' },
  // Supplies → Catalog → Import items (task 257): one row per import call, naming what it added
  // and updated.
  'supply_catalog.imported': { label: 'Supply catalog items imported', group: 'supplies', entity: 'supply_catalog_item' },
  'supply_list.changed': { label: 'Building supply list changed', group: 'supplies', entity: 'client' },

  // Security — the door / alarm code reveal (CS-081: it only reached the console)
  'code.revealed': { label: 'Door / alarm code revealed', group: 'security', entity: 'site' },

  // Automatic (LOG-7 a) — what the crons did with nobody watching
  'alert.sent': { label: 'Alert sent', group: 'automatic', entity: 'alert', auto: true },
  'alert.escalated': { label: 'Escalation raised', group: 'automatic', entity: 'alert', auto: true },
});

export const ACTION_KEYS = Object.freeze(Object.keys(ACTIONS));

// The "Action type" filter. `actions` is what the route filters on, so the screen and the
// server share one definition of what a group MEANS.
export const ACTION_GROUPS = Object.freeze([
  { id: 'inspections', label: 'Inspections' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'time', label: 'Time clock' },
  { id: 'people', label: 'People (pay & access)' },
  { id: 'customers', label: 'Customers' },
  { id: 'money', label: 'Invoices' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'messages', label: 'Customer messages' },
  { id: 'supplies', label: 'Supplies' },
  { id: 'security', label: 'Access codes' },
  { id: 'automatic', label: 'Automatic alerts' },
].map((g) => Object.freeze({ ...g, actions: ACTION_KEYS.filter((a) => ACTIONS[a].group === g.id) })));

export const isKnownAction = (action) => Object.prototype.hasOwnProperty.call(ACTIONS, action);
export const actionLabel = (action) => (isKnownAction(action) ? ACTIONS[action].label : String(action || '—'));
export const actionEntity = (action) => (isKnownAction(action) ? ACTIONS[action].entity : 'unknown');
export const isMoneyAction = (action) => !!(isKnownAction(action) && ACTIONS[action].money);
export const isAutoAction = (action) => !!(isKnownAction(action) && ACTIONS[action].auto);
// Every MONEY action, derived from the registry — never a restated list, so a new money
// action is hidden from admins the moment it is registered.
export const MONEY_ACTIONS = Object.freeze(ACTION_KEYS.filter(isMoneyAction));
export const actionsForGroup = (groupId) => (ACTION_GROUPS.find((g) => g.id === groupId)?.actions || []);

// ── Who sees what (LOG-4 a) ─────────────────────────────────────────────────
export const LOG_VISIBILITY = Object.freeze({
  ALL: 'all',                 // the owner: everything
  NO_MONEY: 'no-money',       // an admin: everything except pay and money changes
  SUPERVISED: 'supervised',   // a manager: only the customers they supervise
  NONE: 'none',               // crew: nothing
});

// The role's visibility. A ROLE FLOOR, not a permission: `can()` puts no key out of a
// per-user grant's reach, so if crew's "nothing" were a key a granted cleaner would read
// the whole company's log (the same reasoning as canEndAccess / time.clockRules). The
// `activity.view` key decides WHETHER the surface opens at all; this decides WHAT it serves.
export function logVisibilityFor(role) {
  if (role === 'owner') return LOG_VISIBILITY.ALL;
  if (role === 'admin') return LOG_VISIBILITY.NO_MONEY;
  if (role === 'manager') return LOG_VISIBILITY.SUPERVISED;
  return LOG_VISIBILITY.NONE; // crew, and any unresolved role — fail closed
}

// The customers a manager supervises (client.supervisorId). One definition for the read
// route's filter and for the screens' copy.
export function supervisedClientIds(clients, userId) {
  if (!userId) return [];
  return (Array.isArray(clients) ? clients : [])
    .filter((c) => c && c.supervisorId === userId)
    .map((c) => c.id)
    .filter(Boolean);
}

// PURE re-check of one row against a viewer's visibility — the read route filters in SQL,
// and this is the belt that proves a row can never reach the wrong reader (and what the
// tests assert per role).
export function maySeeEntry(entry, { visibility, supervisedIds = [] }) {
  if (!entry) return false;
  if (visibility === LOG_VISIBILITY.NONE) return false;
  if (visibility === LOG_VISIBILITY.ALL) return true;
  if (visibility === LOG_VISIBILITY.NO_MONEY) return !isMoneyAction(entry.action);
  if (visibility === LOG_VISIBILITY.SUPERVISED) {
    // "their own accounts": an entry with no customer belongs to nobody's accounts, so it
    // is not a manager's to read (a pay rate or an access level change has no customer).
    return !!entry.clientId && supervisedIds.includes(entry.clientId);
  }
  return false;
}

// ── One row shape for every reader ──────────────────────────────────────────
// The table is snake_case; the screens, the CSV and the PDF all read THIS. Mapping in one
// place is what keeps the report, the customer tab and the two exports showing the same
// thing. `before`/`after` come back as jsonb and are passed through untouched.
export function mapActivityRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    occurredAt: r.occurred_at ?? r.occurredAt ?? null,
    actorUserId: r.actor_user_id ?? r.actorUserId ?? null,
    actorName: r.actor_name ?? r.actorName ?? null,
    actorRole: r.actor_role ?? r.actorRole ?? null,
    auto: !!(r.auto ?? false),
    action: r.action,
    label: actionLabel(r.action),
    entityType: r.entity_type ?? r.entityType ?? null,
    entityId: r.entity_id ?? r.entityId ?? null,
    clientId: r.client_id ?? r.clientId ?? null,
    clientName: r.client_name ?? r.clientName ?? null,
    summary: r.summary || '',
    before: r.before ?? null,
    after: r.after ?? null,
    isMoney: !!(r.is_money ?? r.isMoney ?? false),
  };
}

// Who did it, in one phrase — "Automatic" for a cron, the person otherwise.
//
// Most write points denormalize `actorName` (so a three-year-old row still reads correctly
// after a rename), but the jobs path deliberately does NOT: it is the app's hottest write
// path and a name lookup there would cost an org_state read per schedule change. So a row
// with only an id resolves against the roster the reader already holds — `usersById` is
// optional and any Map or plain object of id → { name } works.
export function actorLabel(entry, usersById = null) {
  if (!entry) return '—';
  if (entry.auto) return 'Automatic';
  if (entry.actorName) return entry.actorName;
  const id = entry.actorUserId;
  if (!id) return 'Unknown';
  const row = usersById instanceof Map ? usersById.get(id) : (usersById ? usersById[id] : null);
  return row?.name || id;
}

// ── Reading a stamp / a before-after pair, in the ORG's zone ─────────────────
// Every instant in the log is stored as ISO, because a write point has no timezone in hand (a
// Vercel function runs in UTC) and a formatted string can never be re-zoned later. So the
// READERS format — the screen, the CSV and the PDF all call these, with the org's zone
// (THE LAW II.8). Dependency-free, so the screens pay nothing for the export modules.
export function fmtStampIn(iso, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch { return d.toISOString(); }
}

export function fmtDayIn(iso, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric' }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

// Field names a reader recognizes. Anything not listed prints its own key, which is honest
// and needs no maintenance.
const FIELD_LABELS = Object.freeze({
  startAt: 'start', endAt: 'end', crewIds: 'crew', pay: 'pay', role: 'access level',
  status: 'status', total: 'total', name: 'name', score: 'score', result: 'result',
  minutes: 'minutes', kind: 'alert', to: 'sent to',
});

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// before/after as one readable cell — the raw pair a dispute may need to quote, next to the
// summary that already spells the change out in words.
export function beforeAfterText(entry, tz = 'UTC') {
  const scalar = (val) => {
    if (val == null) return '—';
    if (typeof val === 'string' && ISO_INSTANT.test(val)) return fmtStampIn(val, tz);
    if (Array.isArray(val)) return val.length ? `${val.length} people` : 'nobody';
    if (typeof val === 'object') return payRateLabel(val);
    return String(val);
  };
  const one = (v) => {
    if (v == null) return '';
    if (typeof v !== 'object') return scalar(v);
    return Object.entries(v).map(([k, val]) => `${FIELD_LABELS[k] || k}: ${scalar(val)}`).join('; ');
  };
  const b = one(entry?.before);
  const a = one(entry?.after);
  if (!b && !a) return '';
  return `${b || '—'} → ${a || '—'}`;
}

// ── Money / value formatting for the summaries (LOG-3) ──────────────────────
const usd = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// A pay record in one phrase: "hourly $22.00", "salary $2,400.00 per period", "per visit
// $45.00", "no pay set". Unknown shapes degrade to the type name rather than throwing, so a
// pay shape added later (per-building rates) still logs a readable line.
export function payRateLabel(pay) {
  if (!pay || typeof pay !== 'object') return 'no pay set';
  const t = pay.type;
  if (t === 'hourly') return `hourly ${usd(pay.hourlyRate)}`;
  if (t === 'salary') return `salary ${usd(pay.salaryPerPeriod)} per period`;
  if (t === 'per_visit') return `per visit ${usd(pay.perVisitRate)}`;
  if (t === 'none' || t == null) return 'no pay set';
  return String(t).replace(/_/g, ' ');
}

// "$15.00 → $16.00" / "hourly $22.00 → salary $2,400.00 per period"
const arrow = (a, b) => `${a} → ${b}`;

// ── The org-state (shared-record) diff ──────────────────────────────────────
// The blob carries four loggable things: a member's PAY and ROLE, a CUSTOMER's existence
// and archive state, an INVOICE's amount, and a SUPPLY REQUEST's status. The server's
// write path diffs exactly those slices and nothing else (LOG-2's list), which is why this
// is a projection rather than a general blob diff: a general one would log every note.
//
// PURE and exported so the offline suite drives the real rule, and so the cost of running
// it on every save can be MEASURED (scripts/test-activity-log.mjs).
const asArray = (v) => (Array.isArray(v) ? v : []);
const byId = (rows) => new Map(asArray(rows).filter((r) => r && r.id).map((r) => [r.id, r]));
// A customer with status 'inactive' is Matt's "archived" (this build has no separate
// archive flag — selectors.js: it deletes customers it no longer wants). Anything else,
// including a missing status, is active.
const isArchivedClient = (c) => c?.status === 'inactive';

export function orgStateActivityEvents(prev, next) {
  const events = [];
  const pUsers = byId(prev?.users);
  const nUsers = byId(next?.users);
  const pClients = byId(prev?.clients);
  const nClients = byId(next?.clients);

  // A name for the summary, preferring the NEXT state (a rename reads as the new name).
  const userName = (id) => nUsers.get(id)?.name || pUsers.get(id)?.name || id || 'someone';
  const clientName = (id) => nClients.get(id)?.name || pClients.get(id)?.name || null;

  // ── pay + role ────────────────────────────────────────────────────────────
  for (const [id, after] of nUsers) {
    const before = pUsers.get(id);
    if (!before) continue; // a NEW member is an invite, not a pay or role CHANGE
    if (canonicalJson(before.pay ?? null) !== canonicalJson(after.pay ?? null)) {
      events.push({
        action: 'pay.rate_changed',
        entityId: id,
        summary: `${userName(id)}: pay rate ${arrow(payRateLabel(before.pay), payRateLabel(after.pay))}`,
        before: { pay: before.pay ?? null },
        after: { pay: after.pay ?? null },
      });
    }
    if ((before.role ?? null) !== (after.role ?? null)) {
      events.push({
        action: 'user.role_changed',
        entityId: id,
        summary: `${userName(id)}: access level ${arrow(before.role || 'none', after.role || 'none')}`,
        before: { role: before.role ?? null },
        after: { role: after.role ?? null },
      });
    }
  }

  // ── customers: added / archived / reactivated / removed ───────────────────
  for (const [id, after] of nClients) {
    const before = pClients.get(id);
    if (!before) {
      events.push({
        action: 'customer.added',
        entityId: id,
        clientId: id,
        summary: `Customer added: ${after.name || id}`,
        after: { name: after.name ?? null },
      });
      continue;
    }
    if (!isArchivedClient(before) && isArchivedClient(after)) {
      events.push({
        action: 'customer.archived', entityId: id, clientId: id,
        summary: `Customer archived: ${after.name || id}`,
        before: { status: before.status ?? null }, after: { status: after.status ?? null },
      });
    } else if (isArchivedClient(before) && !isArchivedClient(after)) {
      events.push({
        action: 'customer.reactivated', entityId: id, clientId: id,
        summary: `Customer reactivated: ${after.name || id}`,
        before: { status: before.status ?? null }, after: { status: after.status ?? null },
      });
    }
  }
  for (const [id, before] of pClients) {
    if (nClients.has(id)) continue;
    events.push({
      action: 'customer.removed', entityId: id, clientId: id,
      summary: `Customer removed: ${before.name || id}`,
      before: { name: before.name ?? null },
    });
  }

  // ── invoice amounts (money) ───────────────────────────────────────────────
  const pInv = byId(prev?.invoices);
  for (const [id, after] of byId(next?.invoices)) {
    const before = pInv.get(id);
    if (!before) continue; // a new invoice is not an amount CHANGE
    const wasTotal = invoiceTotal(before);
    const nowTotal = invoiceTotal(after);
    if (wasTotal === nowTotal) continue;
    events.push({
      action: 'invoice.amount_changed',
      entityId: id,
      clientId: after.clientId || before.clientId || null,
      summary: `Invoice ${id}${clientName(after.clientId || before.clientId) ? ` (${clientName(after.clientId || before.clientId)})` : ''}: amount ${arrow(usd(wasTotal), usd(nowTotal))}`,
      before: { total: wasTotal },
      after: { total: nowTotal },
    });
  }

  // (A supply request's status change is logged by the supplies route itself since SUP-13,
  // 2026-10-05 — requests left the shared record, so this diff no longer sees them.)

  return events.map((e) => ({ entityType: actionEntity(e.action), clientId: null, ...e }));
}

// The CHANGE DETECTOR for the write path: a canonical string over EXACTLY the fields
// orgStateActivityEvents reads. The server hashes it and compares with the hash stored at
// the last commit — equal means nothing loggable moved and the save pays no read at all
// (the same shape as orgStateGuard's protected fingerprint). A field added to the diff
// above MUST be added here, or the diff silently stops firing.
export function activityDigestInput(state) {
  const users = asArray(state?.users)
    .map((u) => [u?.id ?? null, u?.role ?? null, canonicalJson(u?.pay ?? null)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const clients = asArray(state?.clients)
    .map((c) => [c?.id ?? null, c?.status ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const invoices = asArray(state?.invoices)
    .map((i) => [i?.id ?? null, invoiceTotal(i || {})])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return canonicalJson({ users, clients, invoices });
}

// The slices the diff needs, as an org_state JSON projection (api/_lib/orgState.js
// readProtectedSlices). Kept beside the diff so the two can't drift.
export const ACTIVITY_SELECT = 'version,users:state->users,clients:state->clients,'
  + 'invoices:state->invoices';

// ── The jobs (schedule) diff ────────────────────────────────────────────────
// Pure over the job payloads the jobs-delta write path already holds (its equality
// pre-read), so a schedule change costs no extra read. `prev` is a Map id -> stored job.
//
// 🔴 NO TIMESTAMP IS FORMATTED INTO A SUMMARY. A write point has no org timezone in hand
// (a Vercel function runs in UTC), and a stored string can never be re-zoned later — so
// instants stay ISO in before/after and every READER formats them in the org's zone (THE
// LAW II.8; src/lib/activityLogExport.js `beforeAfterText`, and the screens' change cell).
// The customer is carried as `clientId` for the same reason: the reader shows the name it
// knows today rather than freezing one into the sentence.
const sameIds = (a, b) => canonicalJson([...asArray(a)].sort()) === canonicalJson([...asArray(b)].sort());

export function jobActivityEvents({ changed = [], removed = [], prev = new Map() } = {}) {
  const events = [];
  const at = (iso) => (iso ? String(iso) : null);
  const priorOf = (id) => (prev instanceof Map ? prev.get(id) : (prev || {})[id]);
  for (const job of asArray(changed)) {
    if (!job || !job.id) continue;
    const before = priorOf(job.id);
    if (!before) {
      events.push({
        action: 'job.created', entityId: job.id, clientId: job.clientId || null,
        summary: 'Clean scheduled',
        after: { startAt: at(job.startAt), endAt: at(job.endAt), crewIds: asArray(job.crewIds), status: job.status ?? null },
      });
      continue;
    }
    const clientId = job.clientId || before.clientId || null;
    if (before.status !== 'cancelled' && job.status === 'cancelled') {
      events.push({
        action: 'job.cancelled', entityId: job.id, clientId,
        summary: 'Clean cancelled',
        before: { status: before.status ?? null, startAt: at(before.startAt) },
        after: { status: job.status ?? null },
      });
    }
    if (at(before.startAt) !== at(job.startAt) || at(before.endAt) !== at(job.endAt)) {
      events.push({
        action: 'job.moved', entityId: job.id, clientId,
        summary: 'Clean moved to a new time',
        before: { startAt: at(before.startAt), endAt: at(before.endAt) },
        after: { startAt: at(job.startAt), endAt: at(job.endAt) },
      });
    }
    if (!sameIds(before.crewIds, job.crewIds)) {
      events.push({
        action: 'job.crew_changed', entityId: job.id, clientId,
        summary: `Crew changed (${asArray(before.crewIds).length} → ${asArray(job.crewIds).length} on the clean)`,
        before: { crewIds: asArray(before.crewIds) }, after: { crewIds: asArray(job.crewIds) },
      });
    }
  }
  for (const id of asArray(removed)) {
    if (!id) continue;
    const before = priorOf(id);
    events.push({
      action: 'job.deleted', entityId: id, clientId: before?.clientId || null,
      summary: 'Clean deleted',
      before: before ? { startAt: at(before.startAt), crewIds: asArray(before.crewIds), status: before.status ?? null } : null,
    });
  }
  return events.map((e) => ({ entityType: actionEntity(e.action), ...e }));
}

// ── The client hub's service-event subset (LOG-1 / LOG-9) ───────────────────
// A PURE selection: the customer-facing proof of service, drawn from the log plus the
// time and QC tables. LOG-9 ★a (Matt, 2026-09-30: "Yes"): the log itself stays STAFF-ONLY and
// this is the only thing a client ever sees: arrivals and departures, checklists done,
// inspection results, the tickets they raised and their progress. NOTHING about pay, people,
// access levels, access codes, supplies, invoices or automatic alerts, and no internal
// summaries — every field below is named explicitly rather than spread, so a column added to a
// source table can never leak through. Its one caller is the client hub
// (api/_lib/activityLog.js serviceEventsForClient → GET /api/hub/history), whose own allowlist
// (src/lib/clientHubView.js projectHubEvent) is the second fence.
//
// 🔴 A PERSON IS FIRST NAME + LAST INITIAL HERE, AT THE SELECTION (HUB-5's rule, hubPersonName):
// `time_entries.user_name` is the cleaner's FULL name, and this function is the only door the
// time table has to a customer, so no caller can forget to shorten it.
//
// 🔴 A TICKET'S PROGRESS IS SHOWN ONLY FOR THE TICKETS THE VIEWER MAY SEE. The office raises
// internal tickets too (origin 'internal'), and their status changes are logged against the same
// customer; `ticketIds` is the caller's list of client-visible tickets, and an activity row for
// any other ticket is dropped. Omitted (null) = no ticket filter, the pure function's old
// behaviour, for a caller that has already filtered.
export const SERVICE_EVENT_ACTIONS = Object.freeze(['ticket.status_changed']);

// A checklist's line in the service history: "8/9 items" — the tasks a customer reads as done (a
// task the cleaner marked "not completed" is not, D2: `cleanedCountsOf`, which reads the row's own
// items when it carries them), never the reason. Null without counts.
export function checklistEventDetail(c) {
  if (!c || !Number.isFinite(c.completed_count) || !Number.isFinite(c.total_count)) return null;
  const counts = cleanedCountsOf(c);
  return `${counts.done}/${counts.total} items`;
}

export function selectServiceEvents({
  activity = [], timeEntries = [], checklists = [], inspections = [], tickets = [], ticketIds = null,
} = {}) {
  const out = [];
  const visibleTicket = ticketIds == null ? null : new Set(asArray(ticketIds));
  for (const e of asArray(timeEntries)) {
    // A deleted punch never happened, and a no-show is not an arrival (time_entries.status,
    // the same two values every complete read excludes).
    if (!e || e.status === 'voided' || e.status === 'no_show') continue;
    const who = hubPersonName(e.user_name) || null;
    if (e.clock_in_at) {
      out.push({
        kind: 'arrival', at: e.clock_in_at, clientId: e.client_id || null, siteId: e.site_id || null,
        label: 'Cleaner arrived', detail: who,
      });
    }
    if (e.clock_out_at) {
      out.push({
        kind: 'departure', at: e.clock_out_at, clientId: e.client_id || null, siteId: e.site_id || null,
        label: 'Cleaner left', detail: who,
      });
    }
  }
  for (const c of asArray(checklists)) {
    // checklist_results columns (qc/store.js CHECKLIST_WINDOW_COLUMNS) — no items over a year's
    // window, so the hub's history route reads them for the page it serves (`checklistId` names
    // the row; it is not a served field) and re-words the line with `checklistEventDetail`.
    if (!c || !c.performed_at) continue;
    out.push({
      kind: 'checklist', at: c.performed_at, clientId: c.client_id || null, siteId: c.site_id || null,
      label: 'Checklist completed',
      detail: checklistEventDetail(c),
      checklistId: c.id ?? null,
    });
  }
  for (const i of asArray(inspections)) {
    if (!i || i.status !== 'submitted' || !i.performed_at) continue;
    // The result in words ("Needs follow-up", never `needs_follow_up`), with the score.
    const result = i.result ? resultLabel(i.result) : null;
    out.push({
      kind: 'inspection', at: i.performed_at, clientId: i.client_id || null, siteId: i.site_id || null,
      label: 'Inspection', detail: i.overall_score != null ? `${result || 'Scored'} · ${i.overall_score}%` : result,
    });
  }
  for (const t of asArray(tickets)) {
    // A ticket the CLIENT raised (the caller passes only client-visible tickets) — its own
    // words as the detail, since the title is the first line of what they wrote.
    if (!t || !t.created_at) continue;
    if (visibleTicket && !visibleTicket.has(t.id)) continue;
    out.push({
      kind: 'ticket_raised', at: t.created_at, clientId: t.client_id || null, siteId: null,
      label: 'Ticket raised', detail: (typeof t.title === 'string' && t.title.trim()) ? t.title.trim() : null,
    });
  }
  for (const a of asArray(activity)) {
    if (!a || !SERVICE_EVENT_ACTIONS.includes(a.action)) continue;
    if (visibleTicket && !visibleTicket.has(a.entityId ?? a.entity_id)) continue;
    out.push({
      kind: 'ticket', at: a.occurredAt || a.occurred_at || null, clientId: a.clientId || a.client_id || null,
      siteId: null, label: 'Ticket update',
      // The STATUS the ticket moved to; the hub tells it as the client's stage
      // (clientHubView.projectHubEvent → workOrders.woClientStage).
      detail: (a.after && typeof a.after === 'object' && a.after.status) ? String(a.after.status) : null,
    });
  }
  return out
    .filter((e) => e.at)
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
}
