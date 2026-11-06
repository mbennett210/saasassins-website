// Importing customers, at the REAL save handler — the server agrees with the screen (offline).
//
// The Customers import is gated on "Create / edit customers" (clients.edit) and its contacts on
// "Create / edit contacts" (contacts.edit), both from the role matrix (owner / admin / manager by
// default). The screen is a courtesy; the save route is the boundary (BUILD_INTEGRITY §1.4). At
// d4a65ec6 the org-state guard was deny-by-exception for both: ADDING a customer or a contact,
// or changing a contact's details, was ordinary data any office login could POST — and a contact
// change did not even move the protected digest, so it never reached the guard (CS-622's contacts
// half). This suite drives api/state/org-state.js through scripts/fake-supabase.mjs:
//   · a holder's import is ACCEPTED, the very action the importer builds (one IMPORT_CUSTOMERS);
//   · a non-holder's is REFUSED, nothing written, the refused change NAMED;
//   · the existing rules still hold beside it (the supervisor is a Super Admin's / Admin's);
//   · ordinary saves stay off the deep read (a contact's do-not-contact flag, its tags), and a
//     customer delete's contact cascade is the delete's, never a contact change.
//
//   node app/scripts/test-customer-import-guard.mjs
//
// ok(label, cond) — the CONDITION is second in this file.
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { loadStore } from './deletion-core.mjs';

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
const { reducer, ACTIONS } = await loadStore();
let ci = {}; let csv = {};
try { ci = await import('../src/lib/customerImport.js'); } catch { /* the pre-change tree has no engine */ }
try { csv = await import('../src/lib/csv.js'); } catch { /* reported by the checks */ }

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const login = (id, email, role, orgUserId) => ({ id, email, app_metadata: { role, org_user_id: orgUserId, org_id: ORG } });
const LOGINS = {
  'tok-owner': login('a-owner', 'owner@cs.co', 'owner', 'u_owner'),
  'tok-admin': login('a-admin', 'admin@cs.co', 'admin', 'u_admin'),
  'tok-mgr': login('a-mgr', 'mgr@cs.co', 'manager', 'u_mgr'),
  // A manager PARED OFF "Create / edit customers" (Settings → Team → Access).
  'tok-mgr-nocust': login('a-mgr2', 'mgr2@cs.co', 'manager', 'u_mgr2'),
  // A manager PARED OFF "Create / edit contacts".
  'tok-mgr-nocont': login('a-mgr3', 'mgr3@cs.co', 'manager', 'u_mgr3'),
};

const seedState = () => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York', invoicePrefix: 'INV' },
  permissions: seedPermissions(),
  userPermissionOverrides: [
    { userId: 'u_mgr2', grants: [], revokes: ['clients.edit'] },
    { userId: 'u_mgr3', grants: [], revokes: ['contacts.edit'] },
  ],
  timeOff: [],
  services: [{ id: 'svc_1', name: 'Nightly clean', defaultDurationMins: 90 }],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
    { id: 'u_admin', role: 'admin', status: 'active', name: 'Adam', email: 'admin@cs.co', pay: { type: 'hourly', hourlyRate: 25 }, hr: { employeeId: 'EMP-0002' } },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona Vance', email: 'mgr@cs.co', pay: { type: 'salary', salaryPerPeriod: 2800 }, hr: { employeeId: 'EMP-0003' } },
    { id: 'u_mgr2', role: 'manager', status: 'active', name: 'Milo', email: 'mgr2@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0004' } },
    { id: 'u_mgr3', role: 'manager', status: 'active', name: 'Mae', email: 'mgr3@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0005' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl', email: 'crew@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0006' } },
  ],
  clients: [
    { id: 'c1', name: 'Acme Towers', type: 'customer', customerNumber: '0001', standingCrewIds: [], tagIds: [], primaryContactId: 'p1' },
  ],
  sites: [
    { id: 'st_loc_c1', clientId: 'c1', name: 'Main Location', address: '1 Main St, Miami FL 33130', street: '1 Main St', city: 'Miami', state: 'FL', zip: '33130', standingCrewIds: [] },
  ],
  contacts: [
    { id: 'p1', email: 'pat@acme.example', firstName: 'Pat', lastName: 'Lee', phone: '', title: '', companyId: 'c1', tagIds: [] },
  ],
  clientActivities: [],
  invoices: [],
  payrollLines: [],
  reimbursements: [],
  opsSettings: { otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0 },
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
// A fresh org whose digest a first (owner) save stored, so later saves take the fast path
// unless their digest moves — the steady state the gap hid in.
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
async function attempt(token, edit) {
  await freshOrg();
  const before = row().version;
  const next = JSON.parse(JSON.stringify(row().state));
  const edited = edit(next) || next;
  const r = await save(token, edited, before);
  return { ...r, wrote: row().version !== before };
}
const refused = (r, words) => r.status === 403 && !r.wrote && (!words || (r.body?.violations || []).includes(words));
const accepted = (r) => r.status === 200 && r.wrote;
const show = (r) => `${r.status} ${JSON.stringify(r.body)}`;

// The importer's OWN output: the file → the plan → the one IMPORT_CUSTOMERS action → the reducer.
let idn = 0;
const newIdT = (p = 'id') => `${p}_g${(idn += 1)}`;
const FILE = 'Customer #,Customer name,Street,City,State,ZIP,Supervisor,Contact first name,Contact last name,Contact email\n'
  + '0002,Bayside Plaza,2 Ocean Dr,Miami,FL,33139,mgr@cs.co,Rosa,Diaz,rosa@bayside.example\n'
  + '0001,Acme Towers,,,,,,Pat,Lee,pat@acme.example\n';
const PERMS = {
  owner: { canImport: true, canContacts: true, canAssignSupervisor: true },
  manager: { canImport: true, canContacts: true, canAssignSupervisor: false },
};
function importedState(state, perms, file = FILE) {
  const parsed = csv.parseCsv(file);
  const mapping = ci.guessImportMapping(parsed.headers);
  const p = ci.planCustomerImport({ headers: parsed.headers, rows: parsed.rows, mapping, state, perms });
  const ops = ci.buildImportOps(p, { newId: newIdT });
  return reducer(state, { type: ACTIONS.IMPORT_CUSTOMERS, ops });
}
const engineLoaded = typeof ci.planCustomerImport === 'function' && typeof csv.parseCsv === 'function' && !!ACTIONS.IMPORT_CUSTOMERS;
ok('the importer’s engine and its one store action exist', engineLoaded);

// ── 1. the importer's own save ──────────────────────────────────────────────────────────────
if (engineLoaded) {
  const o = await attempt('tok-owner', (s) => importedState(s, PERMS.owner));
  ok('1.1 the Super Admin’s import (a customer, its location, its supervisor, its contact) is accepted', accepted(o), show(o));
  const saved = row().state;
  const bay = (saved.clients || []).find((c) => c.name === 'Bayside Plaza');
  ok('1.2 …and it landed: the customer with its number and supervisor, its one location, its contact', bay?.customerNumber === '0002' && bay?.supervisorId === 'u_mgr'
    && (saved.sites || []).filter((x) => x.clientId === bay?.id).length === 1 && (saved.contacts || []).some((c) => c.email === 'rosa@bayside.example' && c.companyId === bay?.id), JSON.stringify(bay));
  const a = await attempt('tok-admin', (s) => importedState(s, PERMS.owner));
  ok('1.3 an Admin’s import (the default matrix: both keys, may assign supervisors) is accepted', accepted(a), show(a));
  const m = await attempt('tok-mgr', (s) => importedState(s, PERMS.manager));
  ok('1.4 a manager’s import — the importer left the supervisor out — is accepted', accepted(m), show(m));
  const m2 = await attempt('tok-mgr-nocust', (s) => importedState(s, PERMS.manager));
  ok('1.5 a manager pared off "Create / edit customers" is REFUSED, nothing written, the change named', refused(m2, 'add a customer'), show(m2));
  const m3 = await attempt('tok-mgr-nocont', (s) => importedState(s, PERMS.manager));
  ok('1.6 a manager pared off "Create / edit contacts" whose import carries a contact is REFUSED, named', refused(m3, 'add a contact'), show(m3));
  const m4 = await attempt('tok-mgr-nocont', (s) => importedState(s, { ...PERMS.manager, canContacts: false }));
  ok('1.7 …the same manager’s import with the contact left out (as the importer does for them) is accepted', accepted(m4), show(m4));
  const m5 = await attempt('tok-mgr', (s) => importedState(s, PERMS.owner));
  ok('1.8 a manager’s save that DID carry a supervisor is refused (a location’s manager is a Super Admin’s / Admin’s)', refused(m5, "assign a location's manager"), show(m5));
}

// ── 2. the rules on their own ───────────────────────────────────────────────────────────────
{
  const addCustomer = (s) => { s.clients.push({ id: 'c9', name: 'New Co', type: 'customer', standingCrewIds: [] }); };
  ok('2.1 a manager holding clients.edit may add a customer', accepted(await attempt('tok-mgr', addCustomer)));
  ok('2.2 a manager pared off clients.edit may not', refused(await attempt('tok-mgr-nocust', addCustomer), 'add a customer'));
  const addContact = (s) => { s.contacts.push({ id: 'p9', email: 'new@acme.example', firstName: 'New', lastName: 'Person', phone: '', title: '', companyId: 'c1', tagIds: [] }); };
  ok('2.3 a manager holding contacts.edit may add a contact', accepted(await attempt('tok-mgr', addContact)));
  ok('2.4 a manager pared off contacts.edit may not', refused(await attempt('tok-mgr-nocont', addContact), 'add a contact'));
  const changePhone = (s) => { s.contacts[0].phone = '(305) 555-0100'; };
  const cp = await attempt('tok-mgr-nocont', changePhone);
  ok("2.5 a contact's details (phone) changed without contacts.edit is refused", refused(cp, "change a contact's details"), show(cp));
  ok('2.6 …and with it, accepted', accepted(await attempt('tok-mgr', changePhone)));
  // Not a "detail": the do-not-contact flag (contacts.edit's own toggle, judged nowhere new) and tags.
  const dnc = (s) => { s.contacts[0].doNotContact = true; s.contacts[0].tagIds = ['tg_1']; };
  ok('2.7 a contact’s do-not-contact flag or tags are not a details change (unchanged rule)', accepted(await attempt('tok-mgr-nocont', dnc)));
  // Removing a customer (its contacts with it) is refused for everyone — customers are archived,
  // never deleted (CS-663) — and it is refused as the removal, never as a contact change.
  const delCustomer = (s) => { s.clients = []; s.sites = []; s.contacts = []; };
  const removal = await attempt('tok-mgr-nocont', delCustomer);
  ok('2.8 a customer removal is refused as a removal (customers are archived, never deleted), not as a contact change',
    refused(removal, 'remove a customer') && !(removal.body?.violations || []).includes("change a contact's details"));
  // The Super Admin passes by role whatever the matrix says.
  ok('2.9 the Super Admin may add both', accepted(await attempt('tok-owner', (s) => { addCustomer(s); addContact(s); })));
  // A contact with no id is still judged (the by-id view can't see it).
  const idless = (s) => { s.contacts.push({ email: 'ghost@acme.example', firstName: 'Ghost', companyId: 'c1' }); };
  ok('2.10 an id-less contact is still a contact change', refused(await attempt('tok-mgr-nocont', idless), "change a contact's details"));
}

// ── 3. the digest: a contact-only change is JUDGED, an ordinary one stays on the fast path ──
{
  const base = seedState();
  const phone = JSON.parse(JSON.stringify(base)); phone.contacts[0].phone = '1';
  ok('3.1 a contact’s phone moves the protected digest (so the guard runs)', protectedFingerprint(base) !== protectedFingerprint(phone));
  const added = JSON.parse(JSON.stringify(base)); added.contacts.push({ id: 'p2', firstName: 'X', companyId: 'c1' });
  ok('3.2 a new contact moves it', protectedFingerprint(base) !== protectedFingerprint(added));
  const flags = JSON.parse(JSON.stringify(base)); flags.contacts[0].doNotContact = true; flags.contacts[0].tagIds = ['t']; flags.contacts[0].notes = 'x'; flags.contacts[0].updatedAt = '2026-10-03T00:00:00.000Z';
  ok('3.3 a flag, tag, note or timestamp does not (stays off the deep read)', protectedFingerprint(base) === protectedFingerprint(flags));
}

console.log(`\ntest-customer-import-guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
