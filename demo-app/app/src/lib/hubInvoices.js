// THE CLIENT HUB'S INVOICES — the rules, PURE and node-safe (client hub redesign, plan 2026-10-08
// §3.5). Shared by the server (api/_lib/qbo/invoices.js, behind /api/hub/invoices), the demo's
// twin (lib/hubDemo.js) and scripts/test-hub-invoices.mjs, so the three can never disagree about
// what an invoice's status is or which ones a building is shown.
//
// READ-ONLY. QuickBooks is the record and the customer pays there (Matt's note s2: "no pay button
// here by design"). Nothing here writes anything anywhere.
//
// 🔴 MONEY IS INTEGER CENTS (THE LAW II.8). The server parses Intuit's amounts with the strict
// decimal parser (api/_lib/qbo/report.js centsFromDecimalString); everything here adds and
// compares integers. A status is judged on the ORG's calendar day, passed in by the caller
// (lib/dates dayKey with company.timezone), never the process zone.
import { addDaysKey, addMonthsKey } from './dates.js';

// How far back a customer sees invoices (Matt's M4 ★a, HUB-23): the last twelve months.
export const HUB_INVOICE_WINDOW_MONTHS = 12;
// One building's answer is cached this long (its own table, qbo_invoice_cache).
export const HUB_INVOICE_CACHE_MS = 30 * 60 * 1000;

// What the page can be told. `ready` carries rows; the rest carry the sentence below.
export const HUB_INVOICE_STATE = Object.freeze({
  ready: 'ready',
  notConnected: 'not-connected',
  notLinked: 'not-linked',
  unsupportedDimension: 'unsupported-dimension',
  unavailable: 'unavailable',
});
// The hub stays English (LANG-8). One sentence per state, read by the server's log context, the
// demo and the hub's Invoices page, so they cannot drift. A company that links its buildings by
// class or location is told the same thing as an unlinked building: nothing the customer can do
// differs, and the office is told the real reason in the server log.
export const HUB_INVOICE_STATE_SENTENCES = Object.freeze({
  'not-connected': 'Invoices will show here once billing is connected.',
  'not-linked': "Invoices for this building aren't connected yet. Contact your account manager.",
  'unsupported-dimension': "Invoices for this building aren't connected yet. Contact your account manager.",
  unavailable: "Invoices couldn't be loaded from QuickBooks just now. Try again in a moment.",
});

export const INVOICE_STATUS = Object.freeze({ paid: 'paid', open: 'open', overdue: 'overdue' });

// 🔴 THE ALLOWLISTS. A row is built field by field from these, never by deleting from an Intuit
// object (which carries line items, memos, the customer's name and addresses).
export const HUB_INVOICE_ROW_FIELDS = Object.freeze([
  'id', 'number', 'totalCents', 'balanceCents', 'issuedDay', 'dueDay', 'paidDay', 'status', 'partlyPaid',
]);
export const HUB_INVOICE_SUMMARY_FIELDS = Object.freeze(['openCount', 'openCents', 'overdueCount', 'paidCount']);
export const HUB_INVOICE_RESPONSE_FIELDS = Object.freeze(['state', 'rows', 'total', 'offset', 'limit', 'summary', 'asOf']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v) => typeof v === 'string' && DAY_RE.test(v);

// The first day of the window: twelve calendar months back from today, the day after (so the
// window is exactly a year, the same rule as the P&L's m12 and the demo's activity window).
export function invoiceWindowStart(today) {
  return addDaysKey(addMonthsKey(today, -HUB_INVOICE_WINDOW_MONTHS), 1);
}

// THE STATUS RULE. `inv` is { totalCents, balanceCents, dueDay }; `today` an org-zone day key.
//   paid    — nothing owed on a real invoice (a balance at or below zero: an overpayment is paid)
//   overdue — owed, and the due day is BEFORE today
//   open    — owed, due today or later
//   null    — a voided invoice: QuickBooks zeroes a void's total. Dropped from every list.
export function invoiceStatus(inv, today) {
  const total = Number.isInteger(inv?.totalCents) ? inv.totalCents : 0;
  if (!(total > 0)) return null;
  const balance = Number.isInteger(inv?.balanceCents) ? inv.balanceCents : 0;
  if (balance <= 0) return INVOICE_STATUS.paid;
  if (isDay(inv?.dueDay) && isDay(today) && inv.dueDay < today) return INVOICE_STATUS.overdue;
  return INVOICE_STATUS.open;
}

// One invoice as the customer reads it, or null when it is not shown (voided). `inv` is the
// server's parsed row ({ id, number, totalCents, balanceCents, issuedDay, dueDay, paidDay }) —
// the cached shape, which carries no status: a status is judged on each read's own day.
export function projectHubInvoice(inv, today) {
  const status = invoiceStatus(inv, today);
  if (!status) return null;
  return {
    id: String(inv.id),
    number: inv.number ? String(inv.number) : String(inv.id),
    totalCents: inv.totalCents,
    balanceCents: Math.max(0, inv.balanceCents),
    issuedDay: isDay(inv.issuedDay) ? inv.issuedDay : null,
    dueDay: isDay(inv.dueDay) ? inv.dueDay : null,
    // Only a paid invoice has a paid day; a partly paid one is still open.
    paidDay: status === INVOICE_STATUS.paid && isDay(inv.paidDay) ? inv.paidDay : null,
    status,
    // "Partly paid" (plan §3.5): open or overdue, with something already paid against it.
    partlyPaid: status !== INVOICE_STATUS.paid && inv.balanceCents < inv.totalCents,
  };
}

const byNewest = (a, b) => (String(b.issuedDay || '').localeCompare(String(a.issuedDay || ''))
  || String(b.number).localeCompare(String(a.number), 'en', { numeric: true })
  || String(b.id).localeCompare(String(a.id), 'en', { numeric: true }));

// The building's page: every shown invoice newest first, one page of it, the exact total, and
// the summary the Home tile reads ("1 open ($1,160.00) · 2 paid"). `openCount` / `openCents` are
// everything still OWED (open and overdue alike); `overdueCount` is the part of it past due.
export function hubInvoiceList(invoices, { today, offset = 0, limit = 20 } = {}) {
  const shown = (Array.isArray(invoices) ? invoices : [])
    .map((x) => projectHubInvoice(x, today))
    .filter(Boolean)
    .sort(byNewest);
  const summary = { openCount: 0, openCents: 0, overdueCount: 0, paidCount: 0 };
  for (const r of shown) {
    if (r.status === INVOICE_STATUS.paid) summary.paidCount += 1;
    else {
      summary.openCount += 1;
      summary.openCents += r.balanceCents;
      if (r.status === INVOICE_STATUS.overdue) summary.overdueCount += 1;
    }
  }
  return { rows: shown.slice(offset, offset + limit), total: shown.length, summary };
}

// WHICH QUICKBOOKS CUSTOMERS ARE THIS BUILDING'S (M4 ★a): the customer it is linked to and every
// sub-customer below it — except a sub-customer linked to ANOTHER building, and everything below
// that one, which are that building's (the same nearest-linked rule the P&L's attributeToLinked
// uses, so an invoice is never shown on two buildings). `entities` is the customer list
// ({ id, parentId }); `otherLinkedIds` the customer ids the company's OTHER buildings are linked
// to. Sorted numerically, so the query and the cache key are stable. Cycle-safe.
export function invoiceCustomerIds(rootId, entities, otherLinkedIds = []) {
  if (rootId == null) return [];
  const root = String(rootId);
  const others = new Set((otherLinkedIds || []).map(String));
  others.delete(root);
  const children = new Map();
  for (const e of Array.isArray(entities) ? entities : []) {
    if (!e || e.id == null || e.parentId == null) continue;
    const p = String(e.parentId);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(String(e.id));
  }
  const out = new Set([root]);
  const stack = [root];
  while (stack.length) {
    for (const kid of children.get(stack.pop()) || []) {
      if (out.has(kid) || others.has(kid)) continue;
      out.add(kid);
      stack.push(kid);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
