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
