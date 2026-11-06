// CS-003 — an OFFICE login without the key the screen gates on cannot change money or archive a
// customer through the save route; a holder of the key still can. (Until CS-663 the customer half
// was a DELETE; customers are archived, never deleted, and a removal is refused for everyone.)
//
// WHAT WAS STILL OPEN (re-verified at 6e61596c). CS-002 closed the crew half (a crew save is a
// merge through an allowlist). For the office roles the guard was still deny-by-exception:
//   · INVOICES had no check at all and were not in the protected fingerprint, so a save that
//     changed only an invoice skipped the guard entirely — an Admin (who by Q24 holds no
//     invoices.* key) or a manager pared off invoices.edit / invoices.recordPayment could edit a
//     bill, record or delete a payment, void or un-void, or delete an invoice;
//   · the money rules that did exist let ADMIN pass by role — payroll lines, another member's
//     pay rate, their own pay rate, reimbursements — although the screens gate an Admin on the
//     same keys as everyone else (payroll.edit, payroll.rates.edit, hr.edit), which an Admin does
//     not hold by default;
//   · a customer delete passed an Admin by role whatever clients.delete said.
// THE FIX. Each is keyed to the permission the screen gates it on, read from the COMMITTED
// matrix + overrides by the app's own can(); only the Super Admin passes by role (the
// recoverable top tier). Invoices joined the protected fingerprint, so an invoice-only save is
// judged, not waved through. An archive keeps the customer's invoices (only the cleans it takes off
// the schedule leave their `jobIds`, which is not money).
//
// HOW. The REAL route (api/state/org-state.js) and guard, through scripts/fake-supabase.mjs.
//
//   node app/scripts/test-org-state-office-money.mjs
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { canonicalJson } from '../src/lib/canonicalJson.js';

const ORG = '00000000-0000-0000-0000-000000000001';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
const consoleError = console.error;
console.error = (...args) => { if (args[0] !== '[ALERT]' || process.env.VERBOSE) consoleError(...args); };
installFakeSupabase();
const { default: handler } = await import('../api/state/org-state.js');
const { protectedFingerprint } = await import('../api/_lib/orgStateGuard.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const login = (id, email, role, orgUserId) => ({ id, email, app_metadata: { role, org_user_id: orgUserId, org_id: ORG } });
const LOGINS = {
  'tok-owner': login('a-owner', 'owner@cs.co', 'owner', 'u_owner'),
  'tok-admin': login('a-admin', 'admin@cs.co', 'admin', 'u_admin'),
  // An Admin GIVEN the money keys per user: the matrix, not the role, decides.
  'tok-admin2': login('a-admin2', 'admin2@cs.co', 'admin', 'u_admin2'),
  'tok-mgr': login('a-mgr', 'mgr@cs.co', 'manager', 'u_mgr'),
  // A manager PARED OFF every money key and clients.delete (Settings → Team → Access).
  'tok-mgr2': login('a-mgr2', 'mgr2@cs.co', 'manager', 'u_mgr2'),
};
const MONEY_KEYS = ['invoices.edit', 'invoices.recordPayment', 'payroll.edit', 'payroll.rates.edit', 'hr.edit', 'clients.delete'];

const seedState = () => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York', invoicePrefix: 'INV' },
  permissions: seedPermissions(),
  userPermissionOverrides: [
    { userId: 'u_admin2', grants: MONEY_KEYS, revokes: [] },
    { userId: 'u_mgr2', grants: [], revokes: MONEY_KEYS },
  ],
  timeOff: [],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
    { id: 'u_admin', role: 'admin', status: 'active', name: 'Adam', email: 'admin@cs.co', pay: { type: 'hourly', hourlyRate: 25 }, hr: { employeeId: 'EMP-0002' } },
    { id: 'u_admin2', role: 'admin', status: 'active', name: 'Ada', email: 'admin2@cs.co', pay: { type: 'hourly', hourlyRate: 25 }, hr: { employeeId: 'EMP-0003' } },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona', email: 'mgr@cs.co', pay: { type: 'salary', salaryPerPeriod: 2800 }, hr: { employeeId: 'EMP-0004' } },
    { id: 'u_mgr2', role: 'manager', status: 'active', name: 'Milo', email: 'mgr2@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0005' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl', email: 'crew@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0006' } },
  ],
  clients: [
    { id: 'c1', name: 'Acme Towers', type: 'customer', standingCrewIds: [] },
    { id: 'c2', name: 'Bayside Plaza', type: 'customer', standingCrewIds: [] },
  ],
  sites: [
    { id: 's1', clientId: 'c1', name: 'Acme Towers', standingCrewIds: [] },
    { id: 's2', clientId: 'c2', name: 'Bayside Plaza', standingCrewIds: [] },
  ],
  contacts: [],
  invoices: [
    { id: 'INV-1001', clientId: 'c1', status: 'pending', issueDate: '2026-10-01', dueDate: '2026-10-31', taxRate: 0,
      lineItems: [{ id: 'li1', description: 'Nightly clean', qty: 20, unitPrice: 100 }], payments: [], notes: '', poNumber: '' },
    { id: 'INV-1002', clientId: 'c2', status: 'void', issueDate: '2026-09-01', dueDate: '2026-09-30', taxRate: 0,
      lineItems: [{ id: 'li2', description: 'Floor care', qty: 1, unitPrice: 400 }], payments: [], notes: '' },
  ],
  payrollLines: [],
  reimbursements: [
    { id: 'rmb_crew', userId: 'u_crew', amount: 40, status: 'pending', periodKey: '2026-09-28', description: 'gas' },
  ],
  opsSettings: { otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0 },
  notes: [],
});

// One POST as store/sync.js sends it.
async function save(token, state, baseVersion) {
  const text = `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":0,"tab":"t1"}`;
  const req = { method: 'POST', query: {}, headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() {}, end() { return res; } };
  await handler(req, res);
  return out;
}
const row = () => world.tables.org_state[0];
// A fresh org whose digest a first (owner) save has stored, so later saves take the fast path
// unless their digest moves — the realistic steady state, and the one the old gap hid in.
async function freshOrg() {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state: seedState(), version: 1, protected_fingerprint: null, min_client_build: null, updated_at: new Date().toISOString() }],
      jobs: [], crew_assignments: [], payroll_runs: [], job_deletes: [],
    },
    logins: LOGINS,
  });
  const boot = await save('tok-owner', JSON.parse(JSON.stringify(row().state)), 1);
  if (boot.status !== 200) throw new Error(`bootstrap save failed: ${boot.status} ${JSON.stringify(boot.body)}`);
}
// Apply `edit` to the committed state and save it as `token`.
async function attempt(token, edit) {
  await freshOrg();
  const before = row().version;
  const next = JSON.parse(JSON.stringify(row().state));
  edit(next);
  const r = await save(token, next, before);
  return { ...r, wrote: row().version !== before };
}
const refused = (r, words) => r.status === 403 && !r.wrote && (!words || (r.body?.violations || []).includes(words));
const accepted = (r) => r.status === 200 && r.wrote;
const show = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const inv = (s, id) => s.invoices.find((i) => i.id === id);
const user = (s, id) => s.users.find((u) => u.id === id);

// ── 1. Invoices: the bill (line items, tax, due date) needs invoices.edit ────────────────
const editBill = (s) => { inv(s, 'INV-1001').lineItems[0].unitPrice = 1; };
{
  const a = await attempt('tok-admin', editBill);
  ok('1.1 an Admin (no invoices.edit by default) cannot change an invoice\'s bill', refused(a, 'change an invoice'), show(a));
  const m2 = await attempt('tok-mgr2', editBill);
  ok('1.2 a manager pared off invoices.edit cannot either', refused(m2, 'change an invoice'), show(m2));
  ok('1.3 a manager holding invoices.edit can', accepted(await attempt('tok-mgr', editBill)));
  ok('1.4 an Admin GIVEN invoices.edit can (the matrix decides, not the role)', accepted(await attempt('tok-admin2', editBill)));
  ok('1.5 the Super Admin can', accepted(await attempt('tok-owner', editBill)));
}
// ── 2. Create and delete ──────────────────────────────────────────────────────────────────
{
  const add = (s) => { s.invoices.push({ id: 'INV-1003', clientId: 'c1', status: 'pending', taxRate: 0, lineItems: [{ id: 'li3', qty: 1, unitPrice: 50 }], payments: [] }); };
  ok('2.1 an Admin cannot create an invoice', refused(await attempt('tok-admin', add), 'create an invoice'));
  ok('2.2 a manager holding invoices.edit can', accepted(await attempt('tok-mgr', add)));
  const del = (s) => { s.invoices = s.invoices.filter((i) => i.id !== 'INV-1001'); };
  ok('2.3 an Admin cannot delete an invoice', refused(await attempt('tok-admin', del), 'delete an invoice'));
  ok('2.4 a manager pared off invoices.edit cannot', refused(await attempt('tok-mgr2', del), 'delete an invoice'));
  ok('2.5 a manager holding invoices.edit can', accepted(await attempt('tok-mgr', del)));
}
// ── 3. Payments need invoices.recordPayment ───────────────────────────────────────────────
{
  const pay = (s) => { inv(s, 'INV-1001').payments.push({ id: 'pay1', amount: 2000, date: '2026-10-02', method: 'Check' }); };
  ok('3.1 an Admin cannot record a payment', refused(await attempt('tok-admin', pay), 'record a payment on an invoice'));
  ok('3.2 a manager pared off invoices.recordPayment cannot', refused(await attempt('tok-mgr2', pay), 'record a payment on an invoice'));
  ok('3.3 a manager holding it can', accepted(await attempt('tok-mgr', pay)));
  // Bulk "Mark paid" (Invoices page, gated invoices.recordPayment): the payment AND the stored status.
  const markPaid = (s) => { pay(s); inv(s, 'INV-1001').status = 'paid'; };
  ok('3.4 a recordPayment holder\'s bulk "Mark paid" (payment + status) is accepted', accepted(await attempt('tok-mgr', markPaid)));
}
// ── 4. Void is invoices.edit; un-void is the Super Admin's (InvoiceDetail canUnvoid) ─────
{
  const voidIt = (s) => { inv(s, 'INV-1001').status = 'void'; };
  ok('4.1 an Admin cannot void an invoice', refused(await attempt('tok-admin', voidIt), 'void an invoice'));
  ok('4.2 a manager holding invoices.edit can', accepted(await attempt('tok-mgr', voidIt)));
  const unvoid = (s) => { inv(s, 'INV-1002').status = 'pending'; };
  ok('4.3 a manager cannot un-void (Super Admin only, as the screen offers it)', refused(await attempt('tok-mgr', unvoid), 'un-void an invoice'));
  ok('4.4 the Super Admin can un-void', accepted(await attempt('tok-owner', unvoid)));
}
// ── 5. The display fields of an invoice stay free (no money moves) ───────────────────────
{
  const note = (s) => { inv(s, 'INV-1001').notes = 'Gate code changed'; inv(s, 'INV-1001').poNumber = 'PO-77'; };
  ok('5.1 a note / PO number edit is not a money change (accepted for an Admin)', accepted(await attempt('tok-admin', note)));
}
// ── 6. Payroll lines: an Admin needs payroll.edit too ────────────────────────────────────
{
  const line = (s) => { s.payrollLines.push({ id: 'pl1', userId: 'u_crew', periodKey: '2026-09-28', kind: 'earning', category: 'bonus', label: 'Bonus', amount: 5000, taxable: true }); };
  const a = await attempt('tok-admin', line);
  ok('6.1 an Admin (no payroll.edit by default) cannot add a pay line', refused(a, 'add or change a payroll line'), show(a));
  ok('6.2 an Admin GIVEN payroll.edit can', accepted(await attempt('tok-admin2', line)));
  ok('6.3 a manager holding payroll.edit can', accepted(await attempt('tok-mgr', line)));
}
// ── 7. Pay rates: payroll.rates.edit, an Admin included ──────────────────────────────────
{
  const rate = (s) => { user(s, 'u_crew').pay = { type: 'hourly', hourlyRate: 45 }; };
  const a = await attempt('tok-admin', rate);
  ok("7.1 an Admin (no payroll.rates.edit by default) cannot change another member's pay rate", refused(a, "change another member's pay"), show(a));
  ok('7.2 an Admin GIVEN payroll.rates.edit can', accepted(await attempt('tok-admin2', rate)));
  ok('7.3 the Super Admin can', accepted(await attempt('tok-owner', rate)));
  const own = (s) => { user(s, 'u_admin').pay = { type: 'hourly', hourlyRate: 90 }; };
  const o = await attempt('tok-admin', own);
  ok('7.4 an Admin cannot raise their OWN pay rate without payroll.rates.edit', refused(o, 'change your own pay'), show(o));
  ok('7.5 …an Admin holding it still can (the Team page offers it to owner/admin with the key)',
    accepted(await attempt('tok-admin2', (s) => { user(s, 'u_admin2').pay = { type: 'hourly', hourlyRate: 30 }; })));
}
// ── 8. Reimbursements: hr.edit, an Admin included ────────────────────────────────────────
{
  const approve = (s) => { const r = s.reimbursements[0]; r.status = 'approved'; r.payrollLineId = 'pl_r'; s.payrollLines.push({ id: 'pl_r', userId: 'u_crew', periodKey: '2026-09-28', kind: 'earning', category: 'reimbursement', label: 'gas', amount: 40, taxable: false }); };
  const a = await attempt('tok-admin', approve);
  ok('8.1 an Admin (no hr.edit by default) cannot approve a reimbursement', refused(a, 'change a reimbursement'), show(a));
  ok('8.2 a manager holding hr.edit can', accepted(await attempt('tok-mgr', approve)));
}
// ── 9. Archiving a customer: clients.delete, an Admin included; removing one: nobody ────────
{
  const archiveCustomer = (s) => {
    Object.assign(s.clients.find((c) => c.id === 'c1'), { statusOverride: 'archived', archivedAt: '2026-10-13T12:00:00.000Z', archivedBy: 'u_admin', statusBeforeArchive: null });
  };
  const delCustomer = (s) => { s.clients = s.clients.filter((c) => c.id !== 'c1'); s.sites = s.sites.filter((x) => x.clientId !== 'c1'); s.invoices = s.invoices.filter((i) => i.clientId !== 'c1'); };
  // An Admin pared off clients.delete per user.
  const pared = async () => {
    await freshOrg();
    const s = JSON.parse(JSON.stringify(row().state));
    s.userPermissionOverrides.push({ userId: 'u_admin', grants: [], revokes: ['clients.delete'] });
    const r0 = await save('tok-owner', s, row().version);
    if (r0.status !== 200) throw new Error(`override save failed: ${show(r0)}`);
    const v = row().version;
    const next = JSON.parse(JSON.stringify(row().state));
    archiveCustomer(next);
    const r = await save('tok-admin', next, v);
    return { ...r, wrote: row().version !== v };
  };
  const p = await pared();
  ok('9.1 an Admin pared off clients.delete cannot archive a customer', refused(p, 'archive or restore a customer'), show(p));
  ok('9.2 an Admin holding clients.delete (the default) can', accepted(await attempt('tok-admin', archiveCustomer)));
  ok('9.3 a manager pared off clients.delete cannot', refused(await attempt('tok-mgr2', archiveCustomer), 'archive or restore a customer'));
  // 🔴 Removing a customer (and its invoices with it) is refused for everyone, the Super Admin included.
  const o = await attempt('tok-owner', delCustomer);
  ok('9.4 🔴 nobody removes a customer through a save, not even the Super Admin', refused(o, 'remove a customer'), show(o));
  // The archive keeps the invoices; dropping a removed clean from an invoice's jobIds is not money.
  const mgrNoInvoices = async () => {
    await freshOrg();
    const s = JSON.parse(JSON.stringify(row().state));
    s.userPermissionOverrides.push({ userId: 'u_mgr', grants: [], revokes: ['invoices.edit', 'invoices.recordPayment'] });
    const r0 = await save('tok-owner', s, row().version);
    if (r0.status !== 200) throw new Error(`override save failed: ${show(r0)}`);
    const v = row().version;
    const next = JSON.parse(JSON.stringify(row().state));
    archiveCustomer(next);
    for (const inv of next.invoices) if (inv.clientId === 'c1') inv.jobIds = [];
    const r = await save('tok-mgr', next, v);
    return { ...r, wrote: row().version !== v };
  };
  const c = await mgrNoInvoices();
  ok('9.5 an archive is not an invoice edit (a clients.delete holder without invoices.edit)', accepted(c), show(c));
}
// ── 10. An invoice-only save is JUDGED, not waved through the fast path ──────────────────
{
  const base = seedState();
  const moved = JSON.parse(JSON.stringify(base));
  moved.invoices[0].lineItems[0].unitPrice = 1;
  ok('10.1 an invoice money change moves the protected digest', protectedFingerprint(base) !== protectedFingerprint(moved));
  const display = JSON.parse(JSON.stringify(base));
  display.invoices[0].notes = 'x'; display.invoices[0].overdueNotifiedAt = '2026-10-01T00:00:00.000Z'; display.invoices[0].jobIds = ['j1'];
  ok('10.2 a display-only invoice change (notes, the overdue stamp, linked cleans) does not', protectedFingerprint(base) === protectedFingerprint(display));
}
// ── 11. Ordinary office saves are untouched ──────────────────────────────────────────────
{
  ok('11.1 an Admin renaming a customer is accepted', accepted(await attempt('tok-admin', (s) => { s.clients[0].name = 'Acme North'; })));
  ok('11.2 a manager adding a customer is accepted', accepted(await attempt('tok-mgr', (s) => { s.clients.push({ id: 'c9', name: 'New Co', type: 'customer', standingCrewIds: [] }); })));
  ok('11.3 an Admin editing company settings is accepted', accepted(await attempt('tok-admin', (s) => { s.company.name = 'Clean Space LLC'; })));
}

console.log(`\ntest-org-state-office-money: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
