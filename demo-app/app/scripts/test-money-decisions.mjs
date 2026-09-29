// The four owner money decisions (2026-07-21, HANDOFF.md), pinned. These were
// LOOP_REVIEW items 3–6: each asked what a number should MEAN, so the semantics
// below are DECIDED, not inferred — do not "fix" a failing assertion here
// without re-opening the decision with the owner.
//
//   #3 count cash once  — a voided invoice's payments stay in lifetime revenue
//                         (cash is real) and net the account balance so a
//                         void-and-reissue can never collect twice.
//   #4 release the work — voiding an invoice returns its completed jobs to the
//                         uninvoiced pool (derived → retroactive for old voids).
//   #5 freeze at send   — server-side law lives in api/_lib/quotes/store.js
//                         (requireDraft); not exercised here (needs live db).
//   #6 visible credit   — overpayment + void payments surface via clientCredit
//                         / clientCreditSources instead of moving silently.
//
// Offline: pure functions only. Run: node scripts/test-money-decisions.mjs
import assert from 'node:assert/strict';
import {
  clientLifetimeRevenue, clientBalance, clientCredit, clientCreditSources,
  uninvoicedCompletedJobs, agingBuckets,
} from '../src/lib/money.js';

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

const li = (qty, unit) => ({ description: 'svc', qty, unitPrice: unit });
const DAY = 86400000;
const days = (n) => new Date(Date.now() + n * DAY).toISOString();

// One client, the void-and-reissue story: CS-1 was invoiced $500, paid $500,
// then voided (bad terms); CS-2 reissues the same $500 of work. Plus CS-3,
// an unrelated open $200 invoice, and CS-4 overpaid by $25.
const invoices = [
  { id: 'CS-1', clientId: 'acme', jobIds: ['j1'], status: 'void',    lineItems: [li(1, 500)], taxRate: 0, payments: [{ amount: 500 }] },
  { id: 'CS-2', clientId: 'acme', jobIds: ['j1'], status: 'pending', lineItems: [li(1, 500)], taxRate: 0, payments: [] },
  { id: 'CS-3', clientId: 'acme', jobIds: [],     status: 'pending', lineItems: [li(1, 200)], taxRate: 0, payments: [], dueDate: days(10) },
  { id: 'CS-4', clientId: 'acme', jobIds: [],     status: 'paid',    lineItems: [li(1, 100)], taxRate: 0, payments: [{ amount: 125 }] },
  // Another client's void with NO payments — must produce no credit entry.
  { id: 'CS-9', clientId: 'zeta', jobIds: ['j9'], status: 'void',    lineItems: [li(1, 300)], taxRate: 0, payments: [] },
];
const jobs = [
  { id: 'j1', status: 'done', startAt: days(-3) },
  { id: 'j9', status: 'done', startAt: days(-2) },
  { id: 'j5', status: 'done', startAt: days(-1) }, // never invoiced
  { id: 'j6', status: 'upcoming', startAt: days(2) }, // not completed — never in the pool
];

// ── #4 voiding releases the work ─────────────────────────────────────────────
ok('a job on ONLY a voided invoice returns to the uninvoiced pool', () => {
  const pool = uninvoicedCompletedJobs(jobs, [invoices[0]]).map((j) => j.id);
  assert.ok(pool.includes('j1'));
});
ok('a job re-invoiced on a live invoice is claimed again (void does not unclaim the reissue)', () => {
  const pool = uninvoicedCompletedJobs(jobs, invoices).map((j) => j.id);
  assert.ok(!pool.includes('j1')); // CS-2 (pending) claims it
  assert.ok(pool.includes('j9'));  // zeta's void released it, nothing re-claimed
  assert.ok(pool.includes('j5'));
  assert.ok(!pool.includes('j6'));
});

// ── #3 cash counts exactly once ──────────────────────────────────────────────
ok('lifetime revenue keeps the voided invoice\'s real payment', () => {
  assert.equal(clientLifetimeRevenue(invoices, 'acme'), 500 + 125);
});
ok('account balance nets the void payment against the reissue (no double collection)', () => {
  // open: CS-2 (500) + CS-3 (200) + CS-4 (-25 overpaid) − void credit 500 = 175
  assert.equal(clientBalance(invoices, 'acme'), 175);
});
ok('a fully-credited account can go negative — shown as "in credit", never re-billed', () => {
  const balNoReissue = clientBalance(
    invoices.filter((i) => i.id !== 'CS-2' && i.id !== 'CS-3'), 'acme');
  assert.equal(balNoReissue, -525); // void 500 + overpay 25, nothing open
});

// ── #6 the credit is visible, with sources ───────────────────────────────────
ok('clientCredit totals void payments + overpayments', () => {
  assert.equal(clientCredit(invoices, 'acme'), 525);
});
ok('sources name each invoice and kind', () => {
  const src = clientCreditSources(invoices, 'acme');
  assert.deepEqual(
    src.map((c) => `${c.kind}:${c.invoiceId}:${c.amount}`).sort(),
    ['overpayment:CS-4:25', 'void:CS-1:500'],
  );
});
ok('a void with no payments contributes no credit', () => {
  assert.equal(clientCredit(invoices, 'zeta'), 0);
  assert.deepEqual(clientCreditSources(invoices, 'zeta'), []);
});

// ── unchanged neighbors ──────────────────────────────────────────────────────
ok('AR aging still ignores void invoices and overpaid invoices entirely', () => {
  const b = agingBuckets(invoices);
  assert.equal(b.total, 700); // CS-2 (500, no due date → current) + CS-3 (200)
  assert.equal(b.count, 2);
});

// ── review-driven pins (2026-07-21 adversarial pass) ─────────────────────────
ok('an invoice HOURS past due ages as past-due, matching its Overdue badge', () => {
  // Pre-fix, floor(daysPast) <= 0 filed a due-11h-ago invoice under 'current'
  // while deriveInvoiceStatus rendered 'overdue' on the same page.
  const inv = [{ id: 'X', clientId: 'c', jobIds: [], status: 'pending', lineItems: [li(1, 300)], taxRate: 0, payments: [], dueDate: new Date(Date.now() - 11 * 3600000).toISOString() }];
  const b = agingBuckets(inv);
  assert.equal(b.d1_30.amount, 300);
  assert.equal(b.current.amount, 0);
});
ok('credit and balance agree at sub-cent payment edges (cents settle per invoice)', () => {
  // Two 0.125 payments on voids: per-invoice rounding makes every surface see
  // the same cents — balance + credit reconstruct the open total exactly.
  const inv = [
    { id: 'V1', clientId: 'c', jobIds: [], status: 'void',    lineItems: [li(1, 10)],  taxRate: 0, payments: [{ amount: 0.125 }] },
    { id: 'V2', clientId: 'c', jobIds: [], status: 'void',    lineItems: [li(1, 10)],  taxRate: 0, payments: [{ amount: 0.125 }] },
    { id: 'O1', clientId: 'c', jobIds: [], status: 'pending', lineItems: [li(1, 100)], taxRate: 0, payments: [] },
  ];
  const credit = clientCredit(inv, 'c');
  const bal = clientBalance(inv, 'c');
  assert.equal(bal, 100 - credit);
  assert.equal(clientLifetimeRevenue(inv, 'c'), credit); // all cash sits in credit
});

console.log(`\nmoney decisions: ${pass} passed`);
