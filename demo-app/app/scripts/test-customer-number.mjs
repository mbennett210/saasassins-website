// GO-2 / CS-068 — customer numbers: "0001 Ball Harbor Village" (offline).
//
// Matt, 2026-09-29 (GO-2): "Customer IDs: confirm the format. (a) Four digits plus the name, like
// '0001 Ball Harbor Village'. Match what we have in QuickBooks now. That's the name and IDs we use
// across all platforms." The kickoff (2026-09-10, E): "auto-assign the next customer code by
// scanning existing customers… Never delete customers — reactivating a former customer keeps the
// same ID." The rule lives in ONE pure module (src/lib/customerNumber.js) because the 750-building
// import sets numbers too. This pins:
//   1. the shape: four digits; the office's "42" is 0042; anything else is refused;
//   2. QuickBooks' own number is the four digits its customer NAME starts with — and a name
//      without them has none: a number is never invented;
//   3. the label everywhere the office names a customer: "0001 Ball Harbor Village";
//   4. auto-next = the highest number in use + 1, inactive customers counted;
//   5. unique across the book: a duplicate is refused, with the holder named;
//   6. the REAL reducer: ADD_CLIENT / UPDATE_CLIENT store only a valid, free number; a race on
//      the auto-offered number moves on, a typed or QuickBooks number never does; deactivating
//      and reactivating keeps the number, and while away nobody else can take it;
//   7. linking a QuickBooks customer brings its number (or says why not);
//   8. the screens use the rule (source contracts — no component-render harness here), and the
//      app's old friendly "Contact #" (#1042) is gone (the swap the kickoff asked for, II.5).
//
//   node scripts/test-customer-number.mjs
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';

let pass = 0;
const fails = [];
// ok(label, cond) — the CONDITION is second.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let cn = {};
try { cn = await import('../src/lib/customerNumber.js'); } catch { /* the pre-change tree has no module */ }
ok('the rule lives in one pure module, src/lib/customerNumber.js', typeof cn.resolveCustomerNumber === 'function');
const fn = (name) => (typeof cn[name] === 'function' ? cn[name] : () => '(missing)');

// ── 1. the shape ────────────────────────────────────────────────────────────
{
  const norm = fn('normalizeCustomerNumber');
  ok('🔴 "0001" stays 0001', norm('0001') === '0001');
  ok('🔴 the office\'s "42" is 0042 (four digits, zero-padded)', norm('42') === '0042' && norm(' 7 ') === '0007');
  ok('an empty field is no number (null)', norm('') === null && norm(null) === null && norm(undefined) === null);
  ok('letters, five digits and 0000 are not numbers (undefined: refused)', norm('abc') === undefined && norm('12345') === undefined && norm('0000') === undefined && norm('1a') === undefined);
  ok('isCustomerNumber accepts only the stored form', fn('isCustomerNumber')('0001') === true && fn('isCustomerNumber')('1') === false && fn('isCustomerNumber')(1) === false);
}

// ── 2. QuickBooks' own number — never invented ─────────────────────────────
{
  const qn = fn('quickBooksNumber');
  const split = fn('splitNumberedName');
  ok('🔴 "0001 Ball Harbor Village" → 0001', qn('0001 Ball Harbor Village') === '0001');
  ok('… and the name after it', split('0001 Ball Harbor Village')?.name === 'Ball Harbor Village');
  ok('🔴 a QuickBooks name with no four-digit prefix has NO number (never invented)', qn('Ball Harbor Village') === null && qn('Graystar') === null);
  ok('not four digits, not a number: "12 Main St", "00012 Tower", "0001" alone', qn('12 Main St') === null && qn('00012 Tower') === null && qn('0001') === null);
  ok('the convention reads any leading four digits (Intuit\'s sample "0969 Ocean View Road" → 0969)', qn('0969 Ocean View Road') === '0969');
}

// ── 3. the label ────────────────────────────────────────────────────────────
{
  const label = fn('customerLabel');
  ok('🔴 the office names a customer "0001 Ball Harbor Village"', label({ name: 'Ball Harbor Village', customerNumber: '0001' }) === '0001 Ball Harbor Village');
  ok('no number → the name alone', label({ name: 'Ball Harbor Village' }) === 'Ball Harbor Village' && label({ name: 'X', customerNumber: null }) === 'X');
  ok('a name that already starts with its number is not doubled', label({ name: '0001 Ball Harbor Village', customerNumber: '0001' }) === '0001 Ball Harbor Village');
}

// ── 4/5. auto-next and uniqueness ───────────────────────────────────────────
const BOOK = [
  { id: 'a', name: 'Ball Harbor Village', customerNumber: '0001' },
  { id: 'b', name: 'Brickell Bay Offices', customerNumber: '0003', statusOverride: 'inactive' },
  { id: 'c', name: 'Las Olas Medical' },
  { id: 'v', name: 'Sunshine Supply', type: 'vendor' },
];
{
  const next = fn('nextCustomerNumber');
  ok('🔴 auto-next is the highest in use + 1 — an INACTIVE customer\'s number counts (0004, not 0002)', next(BOOK) === '0004');
  ok('an empty book starts at 0001', next([]) === '0001');
  ok('past 9999 there is no four-digit number to offer', next([{ id: 'z', customerNumber: '9999' }]) === null);
  const problem = fn('customerNumberProblem');
  const taken = problem(BOOK, '3', 'c');
  ok('🔴 a number another customer holds is refused — even an inactive one\'s, while they are away', taken?.code === 'taken' && taken?.holder?.id === 'b', JSON.stringify(taken));
  ok('a customer keeping its own number is fine', problem(BOOK, '0001', 'a') === null);
  ok('a free number is fine', problem(BOOK, '0002', 'c') === null);
  ok('letters are "invalid"', problem(BOOK, 'x1', 'c')?.code === 'invalid');
  ok('no number at all is allowed', problem(BOOK, '', 'c') === null);
}

// ── 6. the real reducer ─────────────────────────────────────────────────────
const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
const base = { ...INITIAL_STATE, clients: [], sites: [], contacts: [], keys: [] };
const add = (s, client, extra = {}) => reducer(s, { type: ACTIONS.ADD_CLIENT, client, ...extra });
const byId = (s, id) => s.clients.find((c) => c.id === id);
{
  let s = add(base, { id: 'cl_a', name: 'Ball Harbor Village', customerNumber: '0001' });
  ok('🔴 ADD_CLIENT stores a valid, free number', byId(s, 'cl_a')?.customerNumber === '0001', JSON.stringify(byId(s, 'cl_a')?.customerNumber));
  s = add(s, { id: 'cl_b', name: 'Brickell Bay Offices', customerNumber: '7' });
  ok('ADD_CLIENT stores the four-digit form of a typed "7"', byId(s, 'cl_b')?.customerNumber === '0007');
  s = add(s, { id: 'cl_c', name: 'Dup Typed', customerNumber: '0001' });
  ok('🔴 a TYPED number another customer holds is never stored (and never silently changed)', byId(s, 'cl_c') && byId(s, 'cl_c').customerNumber == null, JSON.stringify(byId(s, 'cl_c')?.customerNumber));
  s = add(s, { id: 'cl_d', name: 'Raced', customerNumber: '0007' }, { customerNumberAuto: true });
  ok('🔴 the AUTO-offered number, taken meanwhile (two offices at once — CS-098\'s race), moves on to the next free one', byId(s, 'cl_d')?.customerNumber === '0008', JSON.stringify(byId(s, 'cl_d')?.customerNumber));
  s = add(s, { id: 'cl_e', name: 'Junk', customerNumber: 'ABCD' });
  ok('an invalid number is never stored', byId(s, 'cl_e') && byId(s, 'cl_e').customerNumber == null);
  s = add(s, { id: 'cl_v', name: 'Sunshine Supply', type: 'vendor', customerNumber: '0050' });
  ok('a vendor gets no customer number', byId(s, 'cl_v') && byId(s, 'cl_v').customerNumber == null);
  s = add(s, { id: 'cl_f', name: 'No Number' });
  ok('a customer may have no number yet (absent = none)', byId(s, 'cl_f') && byId(s, 'cl_f').customerNumber == null);
  ok('🔴 the old friendly Contact # is no longer minted (the swap, II.5)', !('contactNumber' in byId(s, 'cl_f')) || byId(s, 'cl_f').contactNumber == null, JSON.stringify(byId(s, 'cl_f')));

  const upd = (st, id, patch) => reducer(st, { type: ACTIONS.UPDATE_CLIENT, id, patch });
  s = upd(s, 'cl_f', { customerNumber: '12' });
  ok('UPDATE_CLIENT sets a free number', byId(s, 'cl_f')?.customerNumber === '0012');
  s = upd(s, 'cl_f', { customerNumber: '0001', name: 'Renamed' });
  ok('🔴 UPDATE_CLIENT refuses a taken number and keeps the old one', byId(s, 'cl_f')?.customerNumber === '0012', JSON.stringify(byId(s, 'cl_f')?.customerNumber));
  ok('… while the rest of the edit still lands', byId(s, 'cl_f')?.name === 'Renamed');
  s = upd(s, 'cl_f', { customerNumber: '' });
  ok('the office may clear a wrong number (empty → none)', byId(s, 'cl_f') && byId(s, 'cl_f').customerNumber == null);

  // deactivate → reactivate (ClientStatusMenu → UPDATE_CLIENT { type, statusOverride }). cl_d
  // holds the book's HIGHEST number (0008), so auto-next would re-issue it if an inactive
  // customer's number were ever freed.
  s = upd(s, 'cl_d', { type: 'customer', statusOverride: 'inactive' });
  ok('🔴 CS-068: deactivating keeps the number', byId(s, 'cl_d')?.customerNumber === '0008');
  s = add(s, { id: 'cl_g', name: 'Newcomer', customerNumber: '0008' });
  ok('🔴 … nobody else can take it while the customer is away', byId(s, 'cl_g') && byId(s, 'cl_g').customerNumber == null);
  ok('… and auto-next never re-issues it (0009, not 0008)', fn('nextCustomerNumber')(s.clients) === '0009');
  s = upd(s, 'cl_d', { type: 'customer', statusOverride: 'active' });
  ok('🔴 CS-068: reactivating brings the same number back', byId(s, 'cl_d')?.customerNumber === '0008');
}

// ── 7. linking a QuickBooks customer brings its number ──────────────────────
{
  const fromQbo = fn('numberFromQuickBooks');
  const book = [{ id: 'x', name: 'Ball Harbor Village' }, { id: 'y', name: 'Other', customerNumber: '0005' }];
  const r1 = fromQbo(book, 'x', '0001 Ball Harbor Village');
  ok('🔴 a linked QuickBooks customer\'s number is the one to store', r1?.number === '0001' && !r1?.conflict, JSON.stringify(r1));
  ok('… none when QuickBooks has none (never invented)', fromQbo(book, 'x', 'Ball Harbor Village')?.number === null);
  const r2 = fromQbo(book, 'x', '0005 Ball Harbor Village');
  ok('🔴 … refused, naming the holder, when another customer has it', r2?.conflict?.id === 'y', JSON.stringify(r2));
  const plan = fn('quickBooksNumberPlan');
  const steps = plan(
    [{ id: 'p', name: 'Las Marinas' }, { id: 'q', name: 'Lime Tree', customerNumber: '0002' }, { id: 'r', name: 'Huizenga Park', customerNumber: '0900' }, { id: 's', name: 'City' }],
    [{ clientId: 'p', entityType: 'customer', entityName: '0101 Las Marinas', counted: true },
      { clientId: 'q', entityType: 'customer', entityName: '0002 Lime Tree', counted: true },
      { clientId: 'r', entityType: 'customer', entityName: '0103 Huizenga Park', counted: true },
      { clientId: 's', entityType: 'customer', entityName: 'City of Hallandale', counted: true }],
  );
  ok('the bulk plan fills a missing number and corrects a different one from QuickBooks (QuickBooks is the record)',
    Array.isArray(steps?.apply) && steps.apply.map((x) => `${x.clientId}:${x.number}`).sort().join(',') === 'p:0101,r:0103', JSON.stringify(steps));
  ok('… and leaves alone one that already matches, and one QuickBooks has no number for', !steps?.apply?.some((x) => x.clientId === 'q' || x.clientId === 's'));
}

// ── 8. the screens use the rule; the old #1042 is gone ─────────────────────
{
  const clientsPage = read('../src/pages/Clients.jsx');
  ok('🔴 the Customers list names each customer with its number', /customerLabel\(/.test(clientsPage));
  ok('… and its search finds a customer by number', /customerNumber/.test(clientsPage));
  const detail = read('../src/pages/ClientDetail.jsx');
  ok('🔴 the customer page\'s header is "0001 Name"', /title=\{customerLabel\(client\)\}/.test(detail));
  ok('… and its Edit checks the number through the rule', /customerNumberProblem\(/.test(detail));
  const addModal = read('../src/components/AddCompanyModal.jsx');
  ok('🔴 a new customer is OFFERED the next number', /nextCustomerNumber\(/.test(addModal) && /customerNumberAuto/.test(addModal));
  ok('… and a duplicate is refused in words before it is saved', /customerNumberProblem\(/.test(addModal));
  const search = read('../src/lib/masterSearch/sources.js');
  ok('🔴 global search finds and names a customer by number', /customerLabel\(/.test(search) && /customerNumber/.test(search));
  const picker = read('../src/components/ClientPicker.jsx');
  ok('the scheduling picker names customers with their number', /customerLabel\(/.test(picker));
  for (const [file, what] of [
    ['../src/pages/reports/reportKit.jsx', 'the reports\' Customer filter'],
    ['../src/components/LogInvoiceModal.jsx', 'the invoice form\'s customer picker'],
    ['../src/components/LogPaymentModal.jsx', 'the payment form\'s customer picker'],
    ['../src/pages/settings/ClientLogins.jsx', 'Customer Logins\' building picker'],
    ['../src/components/InspectionTemplateEditor.jsx', 'the checklist editor\'s customer picker'],
    ['../src/lib/filters/templateFilters.js', 'the checklists\' customer filter'],
  ]) ok(`${what} names customers with their number`, /customerLabel\(/.test(read(file)));
  const reducerSrc = read('../src/store/reducer.js');
  ok('🔴 the reducer stores numbers through the one rule', /resolveCustomerNumber\(/.test(reducerSrc));
  const appSrc = ['../src/pages/Clients.jsx', '../src/pages/ClientDetail.jsx', '../src/lib/masterSearch/sources.js', '../src/components/AddContactsToStageModal.jsx', '../src/store/reducer.js', '../src/lib/money.js', '../src/data/seed.js'].map(read).join('\n');
  ok('🔴 the old "Contact #" (contactNumber / resolveContactNumber) is gone from the app', !/contactNumber|resolveContactNumber|CONTACT_NUMBER_START/.test(appSrc));
  const seed = read('../src/data/seed.js');
  ok('the demo\'s customers carry numbers', /customerNumber/.test(seed));
  const hub = read('../src/lib/clientHub.js');
  ok('the client hub serves the number (its projection already carried the field)', /customerNumber: c\.customerNumber \?\? null/.test(hub));
}

console.log(`\ncustomer-number: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
