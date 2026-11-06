// CS-288 — an invoice going overdue is detected WITHOUT anyone opening a page.
//
// Before this, MARK_INVOICES_OVERDUE fired only on mount of /invoices and the admin
// Dashboard. Owner and manager homes render AccountDashboard, which never dispatched it,
// so an owner who lives on the home dashboard could never be told — and an ADMIN, who by
// Q24 holds no `invoices.view` at all, was the one writing the invoice stamps and invoice
// bells by opening the operational Dashboard.
//
// The STATUS stays derived (money.js deriveInvoiceStatus) — nothing here stores it. Only
// the one-shot EVENT marker is written, and it is written by the existing 5-minute
// /api/cron/ops-alerts cron, which already reads org_state, CAS-writes it and flushes
// push. `run(dryRun, deps)` is dependency-injected, so this drives the real orchestration
// with no Supabase and no VAPID.
//
// A backend suite (it imports ../api/…): run-tests.mjs runs it when app/api is present and
// skips it on a backend-stripped checkout. It reaches no live service, so it needs no
// LIVE_EFFECT entry.
//
//   node app/scripts/test-invoice-overdue-sweep.mjs
import assert from 'node:assert/strict';
import { run } from '../api/cron/ops-alerts.js';
import { newlyOverdueInvoices, markInvoicesOverdue } from '../src/lib/invoiceSweep.js';
import { deriveInvoiceStatus } from '../src/lib/money.js';
import { seedPermissions } from '../src/lib/roles.js';

let pass = 0, fail = 0;
const ok = async (label, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${label}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${label}\n      ${e && e.message ? e.message : e}`); }
};

const NOW = new Date('2026-09-29T20:00:00.000Z').getTime();
const DAY = 86400000;
const at = (n) => new Date(NOW + n * DAY).toISOString();
const li = (qty, unit) => ({ description: 'svc', qty, unitPrice: unit });

// One invoice past due and never announced, one past due and ALREADY announced, one not
// yet due, one paid, one void. Only the first is an event.
const invoices = () => [
  { id: 'CS-1', clientId: 'cl_1', status: 'pending', lineItems: [li(1, 400)], payments: [], dueDate: at(-2) },
  { id: 'CS-2', clientId: 'cl_1', status: 'pending', lineItems: [li(1, 100)], payments: [], dueDate: at(-9), overdueNotifiedAt: at(-8) },
  { id: 'CS-3', clientId: 'cl_1', status: 'pending', lineItems: [li(1, 100)], payments: [], dueDate: at(5) },
  { id: 'CS-4', clientId: 'cl_1', status: 'paid', lineItems: [li(1, 100)], payments: [{ amount: 100 }], dueDate: at(-4) },
  { id: 'CS-5', clientId: 'cl_1', status: 'void', lineItems: [li(1, 100)], payments: [], dueDate: at(-4) },
];

// A roster holding invoices.view by role default (owner + manager, Q24) so the fan-out's
// visibility gate lets the bell row through; an ADMIN must get nothing.
const baseState = (over = {}) => ({
  users: [
    { id: 'u_owner', name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
    { id: 'u_admin', name: 'Dana', role: 'admin', status: 'active', notificationPrefs: {} },
  ],
  clients: [{ id: 'cl_1', name: 'Real Co' }],
  // The real seeded matrix, so `invoices.view` resolves by its own defaults (owner +
  // manager, NOT admin) rather than by a fixture that could drift from roles.js.
  permissions: seedPermissions(), userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: {},
  invoices: invoices(),
  ...over,
});

console.log('the pure sweep:');

await ok('only an UNANNOUNCED past-due invoice is due', async () => {
  const due = newlyOverdueInvoices(invoices(), NOW);
  assert.deepEqual(due.map((i) => i.id), ['CS-1']);
});

await ok('the status it keys on is the SHARED derivation, not a stored flag', async () => {
  const inv = invoices()[0];
  assert.equal(deriveInvoiceStatus(inv, new Date(NOW)), 'overdue');
  assert.equal(Object.prototype.hasOwnProperty.call(inv, 'derivedStatus'), false, 'nothing stores the status');
});

await ok('a paid or void invoice past its due date is never an event', async () => {
  const only = ['CS-4', 'CS-5'].map((id) => invoices().find((i) => i.id === id));
  assert.deepEqual(newlyOverdueInvoices(only, NOW), []);
});

await ok('applying it stamps the marker and raises ONE bell row per holder', async () => {
  const out = markInvoicesOverdue(baseState(), { now: NOW });
  assert.equal(out.marked, 1, 'one invoice marked');
  assert.equal(out.invoices.find((i) => i.id === 'CS-1').overdueNotifiedAt, new Date(NOW).toISOString());
  const rows = out.notifications.filter((n) => n.eventKey === 'invoiceOverdue');
  assert.equal(rows.length, 1, `one row, got ${rows.length}`);
  assert.equal(rows[0].userId, 'u_owner', 'the owner, never the admin (Q24 hides financials from admin)');
});

await ok('🔴 re-applying it is a no-op — the marker makes it idempotent', async () => {
  const first = markInvoicesOverdue(baseState(), { now: NOW });
  const second = markInvoicesOverdue({ ...baseState(), invoices: first.invoices, notifications: first.notifications }, { now: NOW });
  assert.equal(second, null, 'a second pass returns null: no write, no second bell');
});

await ok('nothing overdue → null, so the shared blob is never touched', async () => {
  assert.equal(markInvoicesOverdue(baseState({ invoices: [invoices()[2]] }), { now: NOW }), null);
});

console.log('\nthe cron (no tab open):');

function makeDeps(over = {}) {
  const calls = { read: 0, write: 0, dispatch: 0, written: [] };
  const snapshot = over.state || baseState();
  const deps = {
    now: NOW,
    readState: async () => { calls.read += 1; return { state: JSON.parse(JSON.stringify(snapshot)), version: 7 }; },
    writeState: async (next) => { calls.write += 1; calls.written.push(next); return over.writeOk !== undefined ? over.writeOk : true; },
    compute: async () => (over.due !== undefined ? over.due : []),   // no OPS alerts due
    dispatch: async () => { calls.dispatch += 1; return { claimed: 1, sent: 1 }; },
    pushReady: () => true,
    report: () => {},
  };
  return { calls, deps };
}

await ok('🔴 an invoice past due with NOBODY visiting produces one invoiceOverdue row', async () => {
  const { calls, deps } = makeDeps();
  const out = await run(false, deps);
  assert.equal(out.overdue, 1, `one invoice swept, got ${out.overdue}`);
  assert.equal(calls.write, 1, 'org_state written once');
  const rows = calls.written[0].notifications.filter((n) => n.eventKey === 'invoiceOverdue');
  assert.equal(rows.length, 1, 'exactly one bell row');
  assert.equal(calls.written[0].invoices.find((i) => i.id === 'CS-1').overdueNotifiedAt, new Date(NOW).toISOString());
});

await ok('🔴 a SECOND run raises none (the stamp it wrote is the dedupe)', async () => {
  const { calls: c1, deps: d1 } = makeDeps();
  await run(false, d1);
  const { calls: c2, deps: d2 } = makeDeps({ state: { ...baseState(), invoices: c1.written[0].invoices, notifications: c1.written[0].notifications } });
  const out = await run(false, d2);
  assert.equal(out.overdue, 0, 'nothing newly overdue');
  assert.equal(c2.write, 0, 'no write at all — the blob is untouched');
});

await ok('it flushes push immediately, so the bell reaches a phone with no tab open', async () => {
  const { calls, deps } = makeDeps();
  const out = await run(false, deps);
  assert.equal(calls.dispatch, 1, 'the shared push core ran once');
  assert.deepEqual(out.push, { claimed: 1, sent: 1 });
});

await ok('dryRun reports what WOULD sweep and writes nothing', async () => {
  const { calls, deps } = makeDeps();
  const out = await run(true, deps);
  assert.equal(calls.write, 0, 'no write');
  assert.equal(calls.dispatch, 0, 'no push');
  assert.equal(out.wouldOverdue, 1, 'it says one invoice would be swept');
});

await ok('a run with neither an ops alert nor an overdue invoice writes nothing', async () => {
  const { calls, deps } = makeDeps({ state: baseState({ invoices: [invoices()[2]] }) });
  const out = await run(false, deps);
  assert.equal(out.raised, 0);
  assert.equal(out.overdue, 0);
  assert.equal(calls.write, 0);
});

await ok('🔴 no page writes invoice stamps on mount any more', async () => {
  const { readFileSync } = await import('node:fs');
  // Comments here EXPLAIN the removal by name, so read the CODE, not the prose.
  const codeOf = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/MARK_INVOICES_OVERDUE/.test(codeOf('../src/pages/Dashboard.jsx')), 'Dashboard.jsx must not dispatch it');
  assert.ok(!/MARK_INVOICES_OVERDUE/.test(codeOf('../src/pages/Invoices.jsx')), 'Invoices.jsx must not dispatch it either');
});

if (fail) {
  console.error(`\nFAIL — ${pass} passed, ${fail} failed`);
  process.exitCode = 1;
} else {
  console.log(`\noverdue sweep: ${pass}/${pass} passed`);
}
