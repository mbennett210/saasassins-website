// The invoicing rail, wired end to end. One suite per register entry, each pinned on a
// PURE function so the rule is a unit test and not a page drive, plus a source check
// where the defect was that a screen did not USE the rule.
//
//   CS-044  a customer's billing settings (terms, tax exempt / override, PO, billing
//           contact) become the defaults of every invoice raised for them.
//   CS-047  the Invoices list shows every open and overdue invoice by default — the
//           30-day issue-date default hid the "Past Due 30+" drill-down entirely.
//   CS-098  two devices cannot mint the same invoice number, and a replayed create is
//           dropped rather than duplicated.
//   CS-146  Accounts Receivable includes overdue balances; the quotes tile says what it
//           measures.
//   CS-145  a standalone payment no longer fabricates an invoice, and a payment date
//           reads the same on every screen.
//
// Offline: pure functions + source reads. Run: node scripts/test-invoice-wiring.mjs
import { readFileSync } from 'node:fs';
import {
  PAYMENT_TERMS, DEFAULT_PAYMENT_TERMS, paymentTermDays, paymentTermLabel, invoiceDefaultsFor,
  nextInvoiceNumber, resolveInvoiceNumber,
  INVOICE_NUMBER_START,
  DEFAULT_INVOICE_RANGE, invoiceListFilter, invoiceMatchesStatusFilter,
  receivablesTotal, pastDue30Total, agingBuckets, invoiceBalance,
} from '../src/lib/money.js';
import { fmtDate } from '../src/lib/dates.js';

let pass = 0;
const fails = [];
// ⚠️ ok(label, cond) — this repo's test files disagree on the argument order, so it is
// stated here: the CONDITION is second. A swapped call would "pass" on a truthy label.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// Comments in these files DESCRIBE the shapes some assertions look for ("Payment
// received", "+30 days"), so a "the old code is gone" check has to read the CODE.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const li = (qty, unit) => ({ description: 'svc', qty, unitPrice: unit });
const DAY = 86400000;
const NOW = new Date('2026-09-29T17:00:00.000Z');
const daysFromNow = (n) => new Date(NOW.getTime() + n * DAY).toISOString();

// ── CS-044 · customer billing settings become invoice defaults ────────────────
console.log('CS-044 — invoice defaults read the customer\'s billing settings:');
{
  // The register's named case: a TAX-EXEMPT, NET-15 customer, at a company that has a
  // real tax rate set. Every value below used to be ignored at creation.
  const company = { taxRate: 7.5 };
  const exemptNet15 = {
    id: 'cl_x', primaryContactId: 'ct_primary', billingContactId: 'ct_ap',
    paymentTerms: 'net15', taxExempt: true, taxRateOverride: null,
    poRequired: true, poNumber: 'PO-8891',
  };
  const d = invoiceDefaultsFor(exemptNet15, company);
  // Assert against the source-of-truth table, never a restated literal (THE LAW II.3).
  const net15Days = PAYMENT_TERMS.find((t) => t.value === 'net15').days;
  ok(`Net 15 → dueDays = the terms table's ${net15Days}, not a hardcoded 30`, d.dueDays === net15Days);
  ok('🔴 tax exempt → taxRate 0 even though the company rate is 7.5', d.taxRate === 0);
  ok('the DESIGNATED billing contact wins over the primary contact', d.billingContactId === 'ct_ap');
  ok('poRequired + poNumber ride onto the invoice', d.poRequired === true && d.poNumber === 'PO-8891');
  ok('paymentTerms is recorded on the invoice', d.paymentTerms === 'net15');

  const override = invoiceDefaultsFor({ taxRateOverride: 4.25, paymentTerms: 'net60' }, company);
  ok('a per-customer tax override beats the company rate', override.taxRate === 4.25);
  ok('Net 60 → 60 days', override.dueDays === PAYMENT_TERMS.find((t) => t.value === 'net60').days);
  ok('🔴 an override of 0 is honoured, not read as "absent"', invoiceDefaultsFor({ taxRateOverride: 0 }, company).taxRate === 0);

  const bare = invoiceDefaultsFor({ primaryContactId: 'ct_primary' }, company);
  ok(`a customer with no settings falls back to ${DEFAULT_PAYMENT_TERMS} + the company rate`,
    bare.dueDays === paymentTermDays(DEFAULT_PAYMENT_TERMS) && bare.taxRate === 7.5);
  ok('… and to the primary contact', bare.billingContactId === 'ct_primary');
  ok('a company with NO tax rate yields 0, never NaN', invoiceDefaultsFor({}, {}).taxRate === 0);
  ok('an unknown terms value falls back to the default label', paymentTermLabel('net-99') === paymentTermLabel(DEFAULT_PAYMENT_TERMS));

  // The rule existing is not the fix: the creation path has to USE it.
  const modal = read('../src/components/LogInvoiceModal.jsx');
  ok('🔴 LogInvoiceModal derives its defaults from invoiceDefaultsFor', /invoiceDefaultsFor\s*\(/.test(modal));
  ok('… and no longer hardcodes +30 days', !/addDaysKey\(\s*todayKey\(\)\s*,\s*30\s*\)/.test(modal));
  ok('… and blocks submit when the customer requires a PO', /poRequired/.test(modal));
  const detail = read('../src/pages/InvoiceDetail.jsx');
  ok('🔴 InvoiceDetail SHOWS the terms + PO on the invoice', /paymentTermLabel/.test(detail) && /poNumber/.test(detail));
  ok('… and threads poNumber through the save whitelist', /poNumber:\s*/.test(detail.slice(detail.indexOf('ACTIONS.UPDATE_INVOICE'))));
  const card = read('../src/components/BillingCard.jsx');
  ok('BillingCard reads the one terms table (no second copy)',
    /from '\.\.\/lib\/money'/.test(card) && !/'due-on-receipt'/.test(card.replace(/\/\/[^\n]*/g, '')));
}

// ── CS-047 · the list's default view ─────────────────────────────────────────
console.log('\nCS-047 — the Invoices list shows every open and overdue invoice:');
{
  const rows = [
    { id: 'I-1', issueDate: daysFromNow(-45), dueDate: daysFromNow(-15), lineItems: [li(1, 900)], payments: [], status: 'pending' },
    { id: 'I-2', issueDate: daysFromNow(-3), dueDate: daysFromNow(27), lineItems: [li(1, 100)], payments: [], status: 'pending' },
    { id: 'I-3', issueDate: daysFromNow(-60), dueDate: daysFromNow(-30), lineItems: [li(1, 500)], payments: [{ amount: 500 }], status: 'paid' },
  ];
  const ids = (list) => list.map((r) => r.id).join(',');
  // The register's case, verbatim: a 45-day-old overdue invoice under ?status=overdue.
  ok('🔴 a 45-day-old overdue invoice appears under ?status=overdue with the default range',
    ids(invoiceListFilter(rows, { status: 'overdue', range: DEFAULT_INVOICE_RANGE, now: NOW })) === 'I-1');
  ok('🔴 the default range is all time, so nothing outstanding is hidden by a date default',
    DEFAULT_INVOICE_RANGE === 'all');
  ok('the default view (no status) shows every invoice, oldest included',
    invoiceListFilter(rows, { now: NOW }).length === 3);
  ok('status=open is the unpaid union — pending AND overdue, never paid or void',
    ids(invoiceListFilter(rows, { status: 'open', now: NOW })) === 'I-1,I-2');
  ok('an explicit 30-day range still filters by issue date',
    ids(invoiceListFilter(rows, { status: 'all', range: '30', now: NOW })) === 'I-2');
  ok('status=paid still narrows to paid', ids(invoiceListFilter(rows, { status: 'paid', now: NOW })) === 'I-3');
  ok('a void invoice is not "open"', invoiceMatchesStatusFilter('void', 'open') === false);

  const page = read('../src/pages/Invoices.jsx');
  ok('🔴 Invoices.jsx takes its default range from DEFAULT_INVOICE_RANGE, not a literal 30',
    /DEFAULT_INVOICE_RANGE/.test(page) && !/searchParams\.get\('range'\)\s*\|\|\s*'30'/.test(page));
  ok('… and filters through the shared invoiceListFilter', /invoiceListFilter\s*\(/.test(page));
  const dash = read('../src/pages/Dashboard.jsx');
  ok('the Past Due 30+ card still drills into the overdue list', /\/invoices\?status=overdue/.test(dash));
}

// ── CS-098 · invoice + contact numbers cannot collide ────────────────────────
console.log('\nCS-098 — two devices cannot mint the same number:');
{
  const P = 'CS';
  const reducerSrc = read('../src/store/reducer.js');
  ok(`a fresh book starts at ${INVOICE_NUMBER_START + 1}`, nextInvoiceNumber([], P) === `${P}-${INVOICE_NUMBER_START + 1}`);
  const book = [{ id: 'CS-1001' }, { id: 'CS-1002' }, { id: 'legacy-7' }];
  ok('the next number is max+1 over the prefixed ids, ignoring foreign ids', nextInvoiceNumber(book, P) === 'CS-1003');
  ok('a free requested number is honoured', resolveInvoiceNumber(book, 'CS-1003', P) === 'CS-1003');
  // THE case: device A committed CS-1003; device B replays its own create, which still
  // carries the number it computed against the OLDER state.
  const afterA = [...book, { id: 'CS-1003', dedupeKey: 'k_A' }];
  ok('🔴 a taken number is RENUMBERED, never appended twice', resolveInvoiceNumber(afterA, 'CS-1003', P) === 'CS-1004');
  ok('… and the renumber keeps counting from the real max', resolveInvoiceNumber([...afterA, { id: 'CS-1004' }], 'CS-1003', P) === 'CS-1005');
  ok('a create with no number at all still gets one', resolveInvoiceNumber(afterA, null, P) === 'CS-1004');
  // The OTHER half: the same create replayed must be dropped, not renumbered. The guard is
  // an INLINE membership test in the reducer (queue-idempotency-lint recognises a dedupe
  // guard by STRUCTURE, so one hidden behind a helper name reads as no guard), so this
  // pins the shape and the field it keys on.
  const guard = reducerSrc.slice(reducerSrc.indexOf('case ACTIONS.ADD_INVOICE:'), reducerSrc.indexOf('case ACTIONS.UPDATE_INVOICE:'));
  ok('🔴 the dedupe guard keys on incoming.dedupeKey and returns state unchanged',
    /incoming\.dedupeKey && \(state\.invoices \|\| \[\]\)\.some\(\(inv\) => inv && inv\.dedupeKey === incoming\.dedupeKey\)\) return state;/.test(guard));
  ok('… and it is guarded on the key being PRESENT (a keyless legacy row can never swallow a create)',
    /if \(incoming\.dedupeKey &&/.test(guard));

  // (The account "Contact #" these lines covered was retired 2026-10-04 for the four-digit
  // customer number — GO-2, CS-068 — whose race rule test-customer-number.mjs pins.)
  ok('🔴 ADD_INVOICE resolves its number through the shared helper', /resolveInvoiceNumber\s*\(/.test(reducerSrc));
  ok('the reducer keeps no second copy of the numbering rule',
    !/function nextInvoiceId\(state\)/.test(reducerSrc));
  const modal = read('../src/components/LogInvoiceModal.jsx');
  ok('🔴 LogInvoiceModal mints a dedupeKey at the caller', /dedupeKey:\s*newId\(/.test(modal));
  ok('🔴 … and holds a busy state so a double-click cannot submit twice', /submitting/.test(modal));
}

// ── CS-146 · receivables + the quotes tile ──────────────────────────────────
console.log('\nCS-146 — Accounts Receivable includes overdue balances:');
{
  const invoices = [
    { id: 'A', clientId: 'c1', status: 'pending', lineItems: [li(1, 400)], payments: [], dueDate: daysFromNow(10) },   // current
    { id: 'B', clientId: 'c1', status: 'pending', lineItems: [li(1, 250)], payments: [], dueDate: daysFromNow(-5) },   // 1-30 past due
    { id: 'C', clientId: 'c1', status: 'pending', lineItems: [li(1, 300)], payments: [], dueDate: daysFromNow(-40) },  // 31-60
    { id: 'D', clientId: 'c1', status: 'pending', lineItems: [li(1, 125)], payments: [], dueDate: daysFromNow(-90) },  // 61+
    { id: 'E', clientId: 'c1', status: 'paid', lineItems: [li(1, 999)], payments: [{ amount: 999 }], dueDate: daysFromNow(-3) },
    { id: 'F', clientId: 'c1', status: 'void', lineItems: [li(1, 777)], payments: [], dueDate: daysFromNow(-70) },
  ];
  const ar = receivablesTotal(invoices, NOW);
  const b = agingBuckets(invoices, NOW);
  ok('🔴 an overdue invoice is INSIDE Accounts Receivable', ar > b.current.amount);
  ok('AR is the aging strip\'s own total, so the two surfaces cannot disagree', ar === b.total);
  ok('AR sums current + every past-due bucket',
    ar === Math.round((b.current.amount + b.d1_30.amount + b.d31_60.amount + b.d61plus.amount) * 100) / 100);
  ok('a paid invoice is not receivable and a void one is excluded',
    ar === Math.round((invoiceBalance(invoices[0]) + invoiceBalance(invoices[1]) + invoiceBalance(invoices[2]) + invoiceBalance(invoices[3])) * 100) / 100);
  ok('Past Due 30+ is the 31-60 and 61+ buckets only', pastDue30Total(invoices, NOW) === Math.round((b.d31_60.amount + b.d61plus.amount) * 100) / 100);
  ok('… and is strictly smaller than AR (an invoice 5 days late is not "30+")', pastDue30Total(invoices, NOW) < ar);

  const dashCode = code('../src/pages/Dashboard.jsx');
  ok('🔴 the Dashboard AR fallback is the receivables selector, not the pending-only figure',
    /selectReceivables\s*\(/.test(dashCode) && !/ar:\s*pick\(snap\?\.ar_cents,\s*stats\.outstanding\)/.test(dashCode));
  ok('… and Past Due 30+ reads the 30+ selector', /selectPastDue30\s*\(/.test(dashCode));
  ok('🔴 the quotes tile no longer claims to measure quotes it does not read',
    !/label="Open Quotes \(\$\)"/.test(dashCode));
  ok('… and Accounts Receivable drills into the unpaid union', /\/invoices\?status=open/.test(dashCode));
  const selectors = read('../src/store/selectors.js');
  ok('selectOutstandingQuotes still reads the pipeline stages it actually measures',
    /OUTSTANDING_QUOTE_STAGES = new Set\(\['proposal', 'negotiation'\]\)/.test(selectors));
}

// ── CS-145 · no synthetic invoice; one payment-date format ───────────────────
console.log('\nCS-145 — a standalone payment no longer fabricates an invoice:');
{
  const modal = read('../src/components/LogPaymentModal.jsx');
  const modalCode = code('../src/components/LogPaymentModal.jsx');
  ok('🔴 LogPaymentModal no longer dispatches ADD_INVOICE', !/ACTIONS\.ADD_INVOICE\b/.test(modalCode));
  ok('🔴 … and the "Payment received" stub line is gone', !/Payment received/.test(modalCode));
  ok('… and it no longer promises a stub invoice in the UI', !/stub invoice/.test(modalCode));
  ok('🔴 an invoice is now required to record a payment (submit is disabled without one)',
    /submitDisabled\s*=[^;]*form\.invoiceId/.test(modal));
  ok('open invoices are SUGGESTED first (oldest due first)', /sort\(/.test(modal));

  // Dates: a bare day key parses as UTC midnight, so formatting it in a negative-offset
  // org zone renders the day BEFORE. That is why the two write points had to agree AND
  // why display has to stay right for rows already stored the old way.
  const detail = read('../src/pages/InvoiceDetail.jsx');
  const recordBody = detail.slice(detail.indexOf('const recordPayment'), detail.indexOf('const removePayment'));
  ok('🔴 InvoiceDetail stores a payment date as org-zone ISO (composeIso), not a bare day key',
    /composeIso\(/.test(recordBody));
  const editBody = detail.slice(detail.indexOf('const saveEditPayment'), detail.indexOf('const voidInvoice'));
  ok('🔴 editing a payment stores the same format', /composeIso\(/.test(editBody));
  // Eastern is the org default; noon-anchored 2026-03-04 must read as Mar 4 both ways.
  const asKey = fmtDate('2026-03-04');
  const asIso = fmtDate('2026-03-04T17:00:00.000Z');
  ok(`🔴 a legacy day-key payment date renders as the same day as a stored ISO one (${asKey} vs ${asIso})`, asKey === asIso);
  ok('… and that day is the 4th, not the 3rd (the UTC-midnight shift)', asKey.replace(/\D+/g, '') === '4');
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ninvoice wiring: ${pass}/${pass} passed`);
}
