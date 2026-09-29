// WS-C revenue-wiring math verification. Pure functions from src/lib/money.js,
// exercised against a seed-faithful invoice/job fixture with hand-computed
// expectations. Usage: node scripts/test-money.mjs
import assert from 'node:assert/strict';
import {
  invoiceTotal, invoicePaid, invoiceBalance, deriveInvoiceStatus,
  billingUnitShort, lineItemFromService,
  clientLifetimeRevenue, clientBalance, agingBuckets, uninvoicedCompletedJobs,
} from '../src/lib/money.js';

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

// Relative dates matching seed helpers (atTime future = +days, daysAgo = past).
const DAY = 86400000;
const days = (n) => new Date(Date.now() + n * DAY).toISOString();

// Mirror of the seed invoices (line items / payments / due offsets that matter).
const li = (desc, qty, unit) => ({ id: `li_${desc}`, description: desc, qty, unitPrice: unit });
const invoices = [
  { id: 'CS-1001', clientId: 'evergreen', jobIds: ['j-evg-a'], dueDate: days(27),  lineItems: [li('Janitorial', 4, 350)], taxRate: 0, status: 'paid',    payments: [{ amount: 1400, date: days(-1) }] },
  { id: 'CS-1002', clientId: 'lakeside',  jobIds: [],          dueDate: days(26),  lineItems: [li('Floor care', 1, 650)],  taxRate: 0, status: 'paid',    payments: [{ amount: 650,  date: days(-2) }] },
  { id: 'CS-1003', clientId: 'pacridge',  jobIds: [],          dueDate: days(24),  lineItems: [li('Janitorial', 2, 475)],  taxRate: 0, status: 'pending', payments: [] },
  { id: 'CS-1004', clientId: 'olympic',   jobIds: [],          dueDate: days(22),  lineItems: [li('Restroom', 4, 195)],    taxRate: 0, status: 'pending', payments: [] },
  { id: 'CS-1005', clientId: 'mtbaker',   jobIds: [],          dueDate: days(20),  lineItems: [li('Windows', 1, 285)],     taxRate: 0, status: 'paid',    payments: [{ amount: 285,  date: days(-5) }] },
  { id: 'CS-1006', clientId: 'cascade',   jobIds: [],          dueDate: days(-5),  lineItems: [li('Pressure', 1, 1500)],   taxRate: 0, status: 'overdue', payments: [] },
  { id: 'CS-1007', clientId: 'salishan',  jobIds: [],          dueDate: days(-15), lineItems: [li('Post-con', 1, 950)],     taxRate: 0, status: 'overdue', payments: [] },
  { id: 'CS-1008', clientId: 'evergreen', jobIds: [],          dueDate: days(16),  lineItems: [li('Janitorial', 4, 320)],  taxRate: 0, status: 'paid',    payments: [{ amount: 1280, date: days(-7) }] },
];

ok('invoiceTotal sums qty*unit + tax', () => {
  assert.equal(invoiceTotal(invoices[0]), 1400);
  assert.equal(invoiceTotal({ lineItems: [li('x', 2, 100)], taxRate: 10 }), 220);
});
ok('invoicePaid / invoiceBalance', () => {
  assert.equal(invoicePaid(invoices[0]), 1400);
  assert.equal(invoiceBalance(invoices[0]), 0);
  assert.equal(invoiceBalance(invoices[2]), 950);
});
ok('deriveInvoiceStatus: paid / overdue / pending / void', () => {
  assert.equal(deriveInvoiceStatus(invoices[0]), 'paid');
  assert.equal(deriveInvoiceStatus(invoices[5]), 'overdue');
  assert.equal(deriveInvoiceStatus(invoices[2]), 'pending');
  assert.equal(deriveInvoiceStatus({ ...invoices[2], status: 'void' }), 'void');
});

ok('agingBuckets match hand-trace', () => {
  const b = agingBuckets(invoices);
  // current = 1003 (950) + 1004 (780) ; 1-30 = 1006 (1500) + 1007 (950)
  assert.equal(b.current.amount, 1730);
  assert.equal(b.current.count, 2);
  assert.equal(b.d1_30.amount, 2450);
  assert.equal(b.d1_30.count, 2);
  assert.equal(b.d31_60.amount, 0);
  assert.equal(b.d61plus.amount, 0);
  assert.equal(b.total, 4180);
  assert.equal(b.count, 4);
});
ok('agingBuckets: void + fully-paid excluded, 31-60 and 61+ classify', () => {
  const b = agingBuckets([
    { id: 'v', dueDate: days(-90), lineItems: [li('x', 1, 500)], status: 'void', payments: [] },
    { id: 'p', dueDate: days(-90), lineItems: [li('x', 1, 500)], status: 'paid', payments: [{ amount: 500 }] },
    { id: 'a', dueDate: days(-45), lineItems: [li('x', 1, 300)], payments: [] },
    { id: 'b', dueDate: days(-75), lineItems: [li('x', 1, 200)], payments: [] },
  ]);
  assert.equal(b.d31_60.amount, 300);
  assert.equal(b.d61plus.amount, 200);
  assert.equal(b.total, 500);
  assert.equal(b.current.amount, 0);
});

ok('clientLifetimeRevenue = summed payments per client', () => {
  assert.equal(clientLifetimeRevenue(invoices, 'evergreen'), 2680); // 1400 + 1280
  assert.equal(clientLifetimeRevenue(invoices, 'lakeside'), 650);
  assert.equal(clientLifetimeRevenue(invoices, 'mtbaker'), 285);
  assert.equal(clientLifetimeRevenue(invoices, 'cascade'), 0);      // overdue, unpaid
  assert.equal(clientLifetimeRevenue(invoices, 'pacridge'), 0);
});
ok('clientBalance = unpaid non-void balances per client', () => {
  assert.equal(clientBalance(invoices, 'pacridge'), 950);
  assert.equal(clientBalance(invoices, 'cascade'), 1500);
  assert.equal(clientBalance(invoices, 'evergreen'), 0);
});

ok('uninvoicedCompletedJobs excludes invoiced + non-done', () => {
  const jobs = [
    { id: 'j-evg-a', status: 'done', startAt: days(-3) },   // invoiced by CS-1001
    { id: 'j-open',  status: 'done', startAt: days(-1) },   // uninvoiced -> included
    { id: 'j-old',   status: 'done', startAt: days(-9) },   // uninvoiced -> included
    { id: 'j-up',    status: 'upcoming', startAt: days(1) },
    { id: 'j-miss',  status: 'missed', startAt: days(-2) },
  ];
  const out = uninvoicedCompletedJobs(jobs, invoices);
  assert.deepEqual(out.map((j) => j.id), ['j-open', 'j-old']); // most-recent first
});

ok('lineItemFromService pre-fills description + price, qty 1', () => {
  const svc = { name: 'Commercial Janitorial', defaultPrice: 350, billingUnit: 'per-visit' };
  assert.deepEqual(lineItemFromService(svc), { description: 'Commercial Janitorial', qty: 1, unitPrice: 350 });
  assert.equal(lineItemFromService({ name: 'X' }).unitPrice, 0); // default-safe
});
ok('billingUnitShort labels + default', () => {
  assert.equal(billingUnitShort('monthly'), 'per month');
  assert.equal(billingUnitShort('sq-ft'), 'per sq ft');
  assert.equal(billingUnitShort(undefined), 'per visit'); // default-safe
});

console.log(`\n${pass} checks passed.`);
