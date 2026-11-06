// Pure invoice / revenue math — zero imports so it is unit-testable headlessly
// (node can load this file directly). `selectors.js` re-exports everything here
// for back-compat, so existing `import { invoiceTotal } from '../store/selectors'`
// call sites keep working. Dollars, rounded to cents.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function invoiceTotal(invoice) {
  const sub = (invoice.lineItems || []).reduce((a, li) => a + (Number(li.qty) || 0) * (Number(li.unitPrice) || 0), 0);
  const tax = sub * ((Number(invoice.taxRate) || 0) / 100);
  return round2(sub + tax);
}

export function invoicePaid(invoice) {
  return (invoice.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
}

export function invoiceBalance(invoice) {
  return round2(invoiceTotal(invoice) - invoicePaid(invoice));
}

export function deriveInvoiceStatus(invoice, now = new Date()) {
  // Manual 'void' is authoritative; everything else is derived from balance + due date.
  // ('draft' was removed when Invoices was rescoped to manual tracking.)
  if (invoice.status === 'void') return 'void';
  const balance = invoiceBalance(invoice);
  if (balance <= 0 && invoiceTotal(invoice) > 0) return 'paid';
  if (invoice.dueDate && new Date(invoice.dueDate) < now && balance > 0) return 'overdue';
  return 'pending';
}

// ── Customer billing settings → invoice defaults (CS-044) ────────────────────
// The customer's billing settings (ClientDetail → Billing information, written by
// components/BillingCard.jsx) used to be WRITE-ONLY: nothing but the location
// defaults read them back, so every invoice took +30 days and the COMPANY tax rate
// whatever the customer's terms said. With production `company.taxRate` = 0 an
// override-rate customer's invoice defaulted to 0% tax, and once a company rate is
// set a tax-EXEMPT customer would have been taxed. That is wrong money on an
// invoice, so the terms live here, as one pure table both the settings card and
// invoice creation read.
export const PAYMENT_TERMS = [
  { value: 'due-on-receipt', label: 'Due on receipt', days: 0 },
  { value: 'net15', label: 'Net 15', days: 15 },
  { value: 'net30', label: 'Net 30', days: 30 },
  { value: 'net45', label: 'Net 45', days: 45 },
  { value: 'net60', label: 'Net 60', days: 60 },
];
export const DEFAULT_PAYMENT_TERMS = 'net30';
const paymentTerm = (value) => PAYMENT_TERMS.find((t) => t.value === value)
  || PAYMENT_TERMS.find((t) => t.value === DEFAULT_PAYMENT_TERMS);
export const paymentTermDays = (value) => paymentTerm(value).days;
export const paymentTermLabel = (value) => paymentTerm(value).label;

// Everything a new invoice inherits from the customer it bills. Pure, so the
// regression test can pin a tax-exempt Net-15 customer with no React in the way.
//   • dueDays     — from the customer's payment terms, NOT a hardcoded 30
//   • taxRate     — 0 when tax exempt, else the customer's override, else the company rate
//   • billingContactId — the DESIGNATED billing contact, falling back to the primary
//   • poRequired / poNumber — carried onto the invoice so the PO reaches the customer
export function invoiceDefaultsFor(client, company) {
  const paymentTerms = client?.paymentTerms || DEFAULT_PAYMENT_TERMS;
  const taxExempt = !!client?.taxExempt;
  const override = client?.taxRateOverride;
  const hasOverride = override != null && override !== '' && Number.isFinite(Number(override));
  return {
    paymentTerms,
    dueDays: paymentTermDays(paymentTerms),
    taxExempt,
    taxRate: taxExempt ? 0 : (hasOverride ? Number(override) : (Number(company?.taxRate) || 0)),
    billingContactId: client?.billingContactId || client?.primaryContactId || null,
    poRequired: !!client?.poRequired,
    poNumber: client?.poNumber || '',
  };
}

// ── Invoice numbering (CS-098) ───────────────────────────────────────────────
// Invoice numbers are `<prefix>-<n>` and live inside the shared org_state blob, so
// there is no sequence to draw from: the number is max+1 over the invoices the
// device can see. Two devices (or a double-click, or a replay of a save whose
// response was lost) therefore computed the SAME number and appended it twice.
//
// The serialization point is the CAS write: every committed blob is the previous
// committed blob plus the actions replayed onto it (store/sync.js adoptRemote), so
// a number decided HERE — at reduce time, against the state being appended to —
// is as ordered as a server sequence would be, and still works offline and in demo.
// A server counter would be strictly worse: it burns numbers on a save that then
// loses its CAS race.
//
// BOTH halves are required (playbook II.7), and they answer different questions:
//   • dedupeKey — "is this the SAME invoice replayed?" → drop it, idempotent.
//   • the number — "is this a DIFFERENT invoice that computed a taken number?"
//     → renumber it. Keying both on the number cannot tell the two apart, which is
//     why a create carries its own key alongside its number.
export const INVOICE_NUMBER_START = 1000;

export function invoiceNumberIn(id, prefix) {
  const m = String(id ?? '').match(new RegExp(`^${prefix}-(\\d+)$`));
  return m ? Number(m[1]) : 0;
}

export function nextInvoiceNumber(invoices, prefix = 'INV') {
  const numbers = (invoices || []).map((inv) => invoiceNumberIn(inv?.id, prefix)).filter(Boolean);
  return `${prefix}-${(numbers.length ? Math.max(...numbers) : INVOICE_NUMBER_START) + 1}`;
}

// The id a new invoice must take: the number the caller computed while it is still
// free, else the next free one.
export function resolveInvoiceNumber(invoices, requested, prefix = 'INV') {
  const taken = new Set((invoices || []).map((inv) => String(inv?.id)));
  if (requested && !taken.has(String(requested))) return String(requested);
  return nextInvoiceNumber(invoices, prefix);
}

// (The replay half — "has this exact create already landed?" — is an INLINE membership
// test in the reducer's ADD_INVOICE, deliberately, in the same shape as
// ADD_INVOICE_PAYMENT beside it: `queue-idempotency-lint` recognises a dedupe guard by its
// STRUCTURE, so a guard hidden behind a helper name here would read as no guard at all.)

// (The account's friendly sequential "Contact #" and its rule were retired on 2026-10-04:
// customers carry Clean Space's own four-digit customer number instead — GO-2, CS-068 — whose
// one rule is lib/customerNumber.js.)

// ── Services catalog (WS-C) ──────────────────────────────────────────────────
// billingUnit ∈ 'per-visit' | 'monthly' | 'sq-ft'. Additive/default-safe: a
// service with no billingUnit reads as 'per-visit' and no defaultPrice reads 0.
export const BILLING_UNITS = [
  { value: 'per-visit', label: 'Per visit', short: 'per visit' },
  { value: 'monthly',   label: 'Monthly',   short: 'per month' },
  { value: 'sq-ft',     label: 'Per sq ft', short: 'per sq ft' },
];
export const billingUnitShort = (unit) =>
  (BILLING_UNITS.find((u) => u.value === unit) || BILLING_UNITS[0]).short;

// Build an invoice/quote line item pre-filled from a services-catalog entry.
// qty defaults to 1 (the office adjusts sq-ft area / monthly multiples inline).
export function lineItemFromService(service, overrides = {}) {
  return {
    description: service?.name || '',
    qty: 1,
    unitPrice: round2(service?.defaultPrice),
    ...overrides,
  };
}

// ── Account revenue / balance (WS-C) ─────────────────────────────────────────
// Account lifetime revenue = every dollar actually collected (summed payments)
// across the client's invoices. Replaces the static seeded `client.revenue`.
// ⚠️ Cents are settled PER INVOICE across this whole section: every aggregate
// (revenue, balance, credit, sources) sums round2(per-invoice) values, so no
// two surfaces rendered side by side can disagree by a rounding path.
export function clientLifetimeRevenue(invoices, clientId) {
  return round2(
    (invoices || [])
      .filter((inv) => inv.clientId === clientId)
      .reduce((sum, inv) => sum + round2(invoicePaid(inv)), 0)
  );
}

// Per-account open balance = unpaid, non-void invoice balances for the client,
// NET of credits (owner decision 2026-07-21, HANDOFF.md):
//   • an OVERPAID invoice's negative balance rides the sum unchanged — the
//     excess nets against the client's other open invoices (kept behavior,
//     now surfaced via clientCredit below instead of moving silently);
//   • payments retained on a VOIDED invoice subtract here, so cash counts
//     exactly once across a void-and-reissue: lifetimeRevenue keeps the real
//     payment, and the reissued invoice's ask shrinks by what was already paid.
export function clientBalance(invoices, clientId) {
  return round2(
    (invoices || [])
      .filter((inv) => inv.clientId === clientId)
      .reduce((sum, inv) => (
        inv.status === 'void' ? sum - round2(invoicePaid(inv)) : sum + invoiceBalance(inv)
      ), 0)
  );
}

// The client's credit: money received that no open invoice currently claims.
// Two sources (owner decision 2026-07-21): payments kept on voided invoices
// (the work returns to the billable pool; the cash stays counted once) and
// overpayments on any non-void invoice. Pure derivation — no stored ledger,
// so it can never drift from the invoices it is computed from.
export function clientCredit(invoices, clientId) {
  return round2(clientCreditSources(invoices, clientId).reduce((s, c) => s + c.amount, 0));
}

// Per-source breakdown for the UI ("$400 from voided CS-1009, $12.50
// overpayment on CS-1011"). kind ∈ 'void' | 'overpayment'.
export function clientCreditSources(invoices, clientId) {
  const out = [];
  (invoices || []).forEach((inv) => {
    if (inv.clientId !== clientId) return;
    if (inv.status === 'void') {
      const paid = invoicePaid(inv);
      if (paid > 0) out.push({ invoiceId: inv.id, kind: 'void', amount: round2(paid) });
      return;
    }
    const bal = invoiceBalance(inv);
    if (bal < 0) out.push({ invoiceId: inv.id, kind: 'overpayment', amount: round2(-bal) });
  });
  return out;
}

// ── AR aging (WS-C) ──────────────────────────────────────────────────────────
// Bucket every outstanding (non-void, balance > 0) invoice by how far past its
// due date it is. Buckets: current (not yet due), 1–30, 31–60, 61+. Independent
// of the seeded `status` — computed from balance + dueDate so it can't drift.
export function agingBuckets(invoices, now = new Date()) {
  const b = {
    current: { amount: 0, count: 0 },
    d1_30:   { amount: 0, count: 0 },
    d31_60:  { amount: 0, count: 0 },
    d61plus: { amount: 0, count: 0 },
    total: 0,
    count: 0,
  };
  (invoices || []).forEach((inv) => {
    if (inv.status === 'void') return;
    const bal = invoiceBalance(inv);
    if (bal <= 0) return;
    const due = inv.dueDate ? new Date(inv.dueDate) : null;
    // 'current' means NOT YET DUE — the same `due < now` predicate that turns
    // the status badge 'overdue' (deriveInvoiceStatus). Flooring days-past and
    // filing <=0 as current made an invoice hours past due render an Overdue
    // badge while the aging strip on the same page filed it under Current for
    // up to 24h. Past-due at any hour files in d1_30 and up from there.
    let key;
    if (!due || due >= now) key = 'current';
    else {
      const daysPast = Math.floor((now - due) / 86400000); // 0 = past due < 24h
      if (daysPast <= 30) key = 'd1_30';
      else if (daysPast <= 60) key = 'd31_60';
      else key = 'd61plus';
    }
    b[key].amount += bal;
    b[key].count += 1;
    b.total += bal;
    b.count += 1;
  });
  ['current', 'd1_30', 'd31_60', 'd61plus'].forEach((k) => { b[k].amount = round2(b[k].amount); });
  b.total = round2(b.total);
  return b;
}

// ── The Invoices list's view (CS-047) ────────────────────────────────────────
// The list defaulted to a 30-day ISSUE-DATE window, so the Dashboard's "Past Due
// 30+" card — which by definition counts invoices issued more than 30 days ago —
// opened a list that could not contain a single one of them. Collections work then
// missed exactly the invoices the KPI was pointing at.
//
// The default is now ALL TIME: an unpaid invoice is outstanding however old it is,
// and hiding one behind a date default is never the safe direction for money.
export const DEFAULT_INVOICE_RANGE = 'all';
export const INVOICE_RANGES = [
  { value: 'all', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
// `open` is the union the money surfaces actually mean by "receivable": unpaid and
// not void, whether or not it has passed its due date. The Dashboard's Accounts
// Receivable card drills into it, so the card's figure and the list agree.
export const INVOICE_STATUS_FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open (unpaid)' },
  { value: 'pending', label: 'Pending' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];
export function invoiceMatchesStatusFilter(derivedStatus, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'open') return derivedStatus === 'pending' || derivedStatus === 'overdue';
  return derivedStatus === filter;
}
// The status + date-range half of the Invoices list filter, pure so the "a 45-day-old
// overdue invoice is visible under ?status=overdue" case is a unit test rather than a
// page drive. Each row carries its own derived status (the page computes it once).
export function invoiceListFilter(rows, { status = 'all', range = DEFAULT_INVOICE_RANGE, now = new Date() } = {}) {
  const days = Number(range);
  const cutoff = range !== 'all' && Number.isFinite(days)
    ? new Date(new Date(now).getTime() - days * 86400000)
    : null;
  return (rows || []).filter((inv) => {
    const st = inv?.derivedStatus || deriveInvoiceStatus(inv || {}, new Date(now));
    if (!invoiceMatchesStatusFilter(st, status)) return false;
    if (cutoff && new Date(inv.issueDate) < cutoff) return false;
    return true;
  });
}

// ── Receivables (CS-146) ─────────────────────────────────────────────────────
// Accounts Receivable = every dollar owed on a live invoice. The Dashboard used to
// fall back to the PENDING-only figure, so an invoice that slipped past its due date
// LEFT the AR number — the one place a reader looks to size what is owed, shrinking
// precisely as collection got harder. Both figures come off agingBuckets, the same
// helper the /invoices aging strip uses, so the two surfaces cannot disagree.
export function receivablesTotal(invoices, now = new Date()) {
  return agingBuckets(invoices, now).total;
}
// The "Past Due 30+" slice: 31–60 plus 61+. Cents settle per invoice inside
// agingBuckets, so this sums two already-rounded values.
export function pastDue30Total(invoices, now = new Date()) {
  const b = agingBuckets(invoices, now);
  return round2(b.d31_60.amount + b.d61plus.amount);
}

// ── Cents → compact whole-dollar display (dashboard stat cards only) ──────────
// The account-book dashboards (AccountDashboard / dashboardLayouts) carry money as INTEGER
// CENTS end to end (QuickBooks P&L is cents; THE LAW II.8) and show a COMPACT whole-dollar
// figure — "$12,600" — on tiles, bars and the gross-profit breakdown. This is the one place
// a compact whole-dollar form is sanctioned (see lib/dates.js money() header): it is a KPI
// glance, never a total, a balance, or any string that reaches a customer, so it never seeds
// a ledger error the way whole-dollar money() did. It reproduces the dashboard's prior
// fmtUsd() output exactly (`$` + rounded dollars, en-US grouping), so the preview picker's
// pixels are unchanged when it swaps onto this shared formatter.
export function moneyCentsCompact(cents) {
  return '$' + Math.round((Number(cents) || 0) / 100).toLocaleString('en-US');
}

// ── Cents → EXACT money, cents shown ─────────────────────────────────────────
// The formatter for anything carried as integer cents that is a PRICE, a total or a
// contract's value — the CON-1..CON-14 contract rail (lib/contracts.js) and anything that
// follows it. Cents are never dropped (lib/dates.js money() header: whole-dollar display
// seeded a real overpayment), and the dollars come from integer division, never
// `cents / 100`, so no float ever touches a figure the office reads.
//
// It takes CENTS, where money()/moneyPrecise() take DOLLARS. A null or non-finite value is
// '—', NOT '$0.00': a null price means "not entered" or "not served to this viewer"
// (contract money is stripped from anyone without invoices.view, CS-019), and printing
// $0.00 would read as free.
export function moneyCents(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return '—';
  const n = Math.round(Number(cents));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

// Completed ('done') jobs not yet attached to any LIVE invoice (invoice.jobIds).
// Most-recent first. Feeds the "uninvoiced work" surface + one-click invoicing.
// VOID invoices do not claim their jobs (owner decision 2026-07-21): voiding
// releases the completed work back to this pool so it can be re-billed — the
// old behavior stranded it permanently ("never re-billed", LOOP_REVIEW #4).
// Derived, so existing voids release their work retroactively with no data-op.
export function uninvoicedCompletedJobs(jobs, invoices) {
  const invoiced = new Set();
  (invoices || []).forEach((inv) => {
    if (inv.status === 'void') return;
    (inv.jobIds || []).forEach((jid) => invoiced.add(jid));
  });
  return (jobs || [])
    .filter((j) => j.status === 'done' && !invoiced.has(j.id))
    .sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
}
