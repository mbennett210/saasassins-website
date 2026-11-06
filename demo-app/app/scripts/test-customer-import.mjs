// The Customers "Import customers" engine — one row is one building (offline).
//
// WHY. Matt's team enters its own buildings (kickoff 2026-09-10 §H: "Matt's team adds the clients,
// cleaners, and schedules… Only the financial analyst adds/removes customers"), about 750 of them,
// and the Customers page's import is the one bulk tool it has. It was built as a PERSON importer
// the day before a customer became one building with one location (store v53), and three weeks of
// fixes later it still was (S33's diagnosis, re-verified on d4a65ec6's code):
//   · a row needed a person: a plain building could not be imported at all;
//   · only name, type and an address reached the customer: no customer number (GO-2), no
//     supervisor (HUB-12 / QB-8), no notes;
//   · it was titled "Import Contacts (CSV)" behind a Customers button, with a contacts sample file;
//   · real spreadsheet exports broke it: a semicolon file (non-US Excel) read as one column, a
//     Windows-1252 "José" (Excel's plain CSV save) as "Jos�", and blank trailing columns as fields.
// This suite holds the replacement: src/lib/customerImport.js (the plan: create / update /
// unchanged / error per row, fill blanks only), src/lib/csv.js (reading the file) and the store's
// one atomic IMPORT_CUSTOMERS action, through the REAL reducer.
//
//   node app/scripts/test-customer-import.mjs
//
// ok(label, cond) — the CONDITION is second in this file.
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
// Every module is imported defensively, so the pre-change tree reports each missing piece as a
// failed check instead of dying on the first import.
let ci = {}; let csv = {}; let budget = {}; let blob = {}; let tables = {}; let core = {}; let leads = {}; let geo = {};
try { ci = await import('../src/lib/customerImport.js'); } catch (e) { fails.push(`src/lib/customerImport.js loads (${e.message.split('\n')[0]})`); }
try { csv = await import('../src/lib/csv.js'); } catch (e) { fails.push(`src/lib/csv.js loads (${e.message.split('\n')[0]})`); }
try { budget = await import('../src/lib/stateBudget.js'); } catch (e) { fails.push(`src/lib/stateBudget.js loads (${e.message.split('\n')[0]})`); }
try { blob = await import('../api/_lib/blobBudget.js'); } catch { /* reported below */ }
try { tables = await import('../src/store/tableSlices.js'); } catch { /* reported below */ }
try { core = await import('../src/i18n/core.js'); } catch { /* reported below */ }
try { leads = await import('../api/_lib/leads/upsert.js'); } catch { /* reported below */ }
try { geo = await import('../src/lib/geocodeLocation.js'); } catch { /* reported below */ }
let us = {};
try { us = await import('../src/lib/usStates.js'); } catch { /* reported below */ }
// The store's own status and stale-lead rules (the shim loadStore installed resolves them).
let sel = {};
try { sel = await import('../src/store/selectors.js'); } catch (e) { fails.push(`src/store/selectors.js loads (${e.message.split('\n')[0]})`); }
const statusOf = (state) => (c) => (typeof sel.selectClientStatus === 'function' ? sel.selectClientStatus(state, c) : null);
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => { throw new Error(`${name} is missing`); });
const tryRun = (f) => { try { return f(); } catch (e) { return { __threw: e.message }; } };
const english = (m) => (core.english && m ? core.english(m.$t, m.p) : '');
const keysOf = (list) => (Array.isArray(list) ? list.map((m) => m && m.$t) : []);

const clone = (x) => JSON.parse(JSON.stringify(x));
let idn = 0;
const newIdT = (p = 'id') => `${p}_t${(idn += 1)}`;
const OWNER = { canImport: true, canContacts: true, canAssignSupervisor: true };
const MANAGER = { canImport: true, canContacts: true, canAssignSupervisor: false };
const NO_CONTACTS = { canImport: true, canContacts: false, canAssignSupervisor: true };
const NOBODY = { canImport: false, canContacts: false, canAssignSupervisor: false };

const IMPORT = ACTIONS.IMPORT_CUSTOMERS;
ok('the store has ONE atomic import action, IMPORT_CUSTOMERS', typeof IMPORT === 'string');
const applyOps = (state, ops) => reducer(state, { type: IMPORT, ops });

// A file from text, through the real reader and the real guess.
function load(text) {
  const parsed = fn(csv, 'parseCsv')(text);
  const mapping = fn(ci, 'guessImportMapping')(parsed.headers);
  return { ...parsed, mapping };
}
// The screen passes the store's own status rule (selectClientStatus); so does every plan here.
function plan(text, state, perms = OWNER, extra = {}) {
  const f = load(text);
  return fn(ci, 'planCustomerImport')({ headers: f.headers, rows: f.rows, mapping: f.mapping, state, perms, statusOf: statusOf(state), ...extra });
}
function run(text, state, perms = OWNER, extra = {}) {
  const p = plan(text, state, perms, extra);
  const ops = fn(ci, 'buildImportOps')(p, { newId: newIdT });
  return { plan: p, ops, after: applyOps(state, ops) };
}
const findClient = (s, name) => (s.clients || []).find((c) => c.name === name);
const siteOf = (s, c) => (s.sites || []).find((x) => x.clientId === c?.id);

// A lean book: two existing customers, one with a number and an address, one with neither.
function book() {
  const s = clone(INITIAL_STATE);
  s.clients = [
    { id: 'cl_a', name: 'Harbor View Towers', type: 'customer', customerNumber: '0001', street: '500 SE 3rd Ave', city: 'Fort Lauderdale', state: 'FL', zip: '33301', tagIds: [], primaryContactId: null, supervisorId: null, notes: '' },
    { id: 'cl_b', name: 'Coral Ridge Plaza', type: 'customer', customerNumber: null, street: '', city: '', state: '', zip: '', tagIds: [], primaryContactId: null, supervisorId: 'u_seed_heather', notes: '' },
  ];
  s.sites = [
    { id: 'st_loc_cl_a', clientId: 'cl_a', name: 'Main Location', address: '500 SE 3rd Ave, Fort Lauderdale FL 33301', street: '500 SE 3rd Ave', city: 'Fort Lauderdale', state: 'FL', zip: '33301', lat: null, lng: null, geocodeStatus: null, geofenceEnabled: true },
    { id: 'st_loc_cl_b', clientId: 'cl_b', name: 'Main Location', address: '', street: '', city: '', state: '', zip: '', lat: null, lng: null, geocodeStatus: null, geofenceEnabled: true },
  ];
  s.contacts = [
    { id: 'ct_pat', email: 'pat@harborview.example', firstName: 'Pat', lastName: 'Lee', phone: '', title: '', companyId: 'cl_a', tagIds: [] },
    { id: 'ct_kim', email: 'kim@elsewhere.example', firstName: 'Kim', lastName: 'Ortiz', phone: '', title: '', companyId: 'cl_b', tagIds: [] },
  ];
  s.clients[0].primaryContactId = 'ct_pat';
  s.clientActivities = [];
  return s;
}

// ── A. reading real spreadsheet exports ─────────────────────────────────────────────────────
{
  const parse = fn(csv, 'parseCsv');
  const bom = tryRun(() => parse('﻿Customer #,Customer name\r\n0001,Harbor View Towers\r\n'));
  ok('A1 a UTF-8 BOM is not part of the first header', bom.headers?.[0] === 'Customer #', JSON.stringify(bom.headers));
  ok('A2 CRLF line endings', bom.rows?.length === 1 && bom.rows[0][1] === 'Harbor View Towers', JSON.stringify(bom.rows));
  const quoted = tryRun(() => parse('Customer name,Notes\n"Smith, Jones & Co","Two lines:\r\nlobby, then gym"\n'));
  ok('A3 a quoted field keeps its commas and its line break', quoted.rows?.[0]?.[0] === 'Smith, Jones & Co' && quoted.rows?.[0]?.[1] === 'Two lines:\nlobby, then gym', JSON.stringify(quoted.rows));
  const semi = tryRun(() => parse('Customer #;Customer name;City\n0001;Harbor View Towers;Fort Lauderdale\n0002;"Bay; North";Miami\n'));
  ok('A4 a semicolon-separated file (non-US Excel) reads as columns', semi.delimiter === ';' && semi.headers?.length === 3 && semi.rows?.[1]?.[1] === 'Bay; North', JSON.stringify(semi));
  const sep = tryRun(() => parse('sep=;\nCustomer #;Customer name\n0001;Harbor View Towers\n'));
  ok('A5 Excel’s "sep=;" first line sets the separator and is not a header', sep.headers?.[0] === 'Customer #' && sep.rows?.length === 1, JSON.stringify(sep));
  const tab = tryRun(() => parse('Customer #\tCustomer name\n0001\tHarbor View Towers\n'));
  ok('A6 a tab-separated export (Excel "Unicode text")', tab.delimiter === '\t' && tab.rows?.[0]?.[1] === 'Harbor View Towers', JSON.stringify(tab));
  const blanks = tryRun(() => parse('Customer #,Customer name,,\n0001,Harbor View Towers,,\n,,,\n0002,Bay North,,\n,,,\n\n'));
  ok('A7 blank trailing columns are dropped', blanks.headers?.length === 2, JSON.stringify(blanks.headers));
  ok('A8 blank rows (middle and end) are skipped', blanks.rows?.length === 2 && blanks.rows[1][0] === '0002', JSON.stringify(blanks.rows));
  const dup = tryRun(() => parse('Customer name,Phone,Phone\nHarbor View Towers,555-0100,555-0199\n'));
  ok('A9 a duplicate header is told apart ("Phone (2)") and reported', dup.headers?.[2] === 'Phone (2)' && dup.renamed?.length === 1, JSON.stringify(dup));

  const decode = fn(csv, 'decodeCsvBytes');
  const cp1252 = Uint8Array.from([...Buffer.from('Customer name,Contact first name\nCasa Bonita,Jos', 'latin1'), 0xE9, 0x0A]);
  const d1 = tryRun(() => decode(cp1252));
  ok('A10 Windows-1252 (Excel’s plain "CSV" save): "José" decodes and the encoding is reported', d1.text?.includes('José') && d1.encoding === 'windows-1252', JSON.stringify(d1));
  const d2 = tryRun(() => decode(Uint8Array.from(Buffer.from('﻿Customer name\nJosé Martí Center\n', 'utf8'))));
  ok('A11 UTF-8 (with its BOM) decodes as UTF-8', d2.encoding === 'utf-8' && d2.text?.includes('José Martí Center') && !d2.text?.startsWith('﻿'), JSON.stringify(d2));
  const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Customer name\tCity\nJosé Center\tMiami\n', 'utf16le')]);
  const d3 = tryRun(() => decode(Uint8Array.from(u16)));
  ok('A12 UTF-16 (Excel "Unicode text", with its BOM) decodes', d3.encoding === 'utf-16le' && d3.text?.includes('José Center'), JSON.stringify(d3));

  const write = fn(csv, 'toCsvText');
  const out = tryRun(() => write([['Row', 'Problem'], ['3', 'Has "quotes", commas\nand lines'], ['4', '=HYPERLINK("x")']]));
  ok('A13 the problems file quotes what needs quoting and ends lines with CRLF', typeof out === 'string' && out.includes('"Has ""quotes"", commas\nand lines"') && out.includes('\r\n'), JSON.stringify(out));
  ok('A14 a cell that starts like a formula is written as text (CSV injection)', typeof out === 'string' && out.includes("'=HYPERLINK"), JSON.stringify(out));
  // The DDE payloads start with a sign and a DIGIT: "+1+cmd|…" and "-2+3+cmd|…" run in Excel too.
  // Every text cell starting = + - @ TAB CR LF is neutralized, the repo's one rule (payroll csvCell).
  const dde = tryRun(() => write([['Phone'], ["+1+cmd|' /C calc'!A0"], ["-2+3+cmd|' /C calc'!A0"], ['@SUM(A1)']]));
  ok('A14b sign-and-digit formulas (the DDE payloads) are written as text too', typeof dde === 'string'
    && dde.includes("'+1+cmd") && dde.includes("'-2+3+cmd") && dde.includes("'@SUM"), JSON.stringify(dde));
  // …and the problems file comes back clean when it is fixed and imported again: the apostrophe
  // the guard wrote is not part of the value.
  const back = tryRun(() => parse(write([['Contact phone', 'Customer name'], ['+1 (954) 555-0101', '=Not A Formula Co']])));
  ok('A14c the guard’s apostrophe is read back off on import (the problems file round-trips)', back.rows?.[0]?.[0] === '+1 (954) 555-0101'
    && back.rows?.[0]?.[1] === '=Not A Formula Co', JSON.stringify(back.rows));
  ok('A14d the problems file uses the repo’s one CSV cell escaper (CS-079), not a second one', /import \{ csvCell \} from '\.\/payroll\.js'/.test(read('../src/lib/csv.js')) && !/FORMULA_START/.test(read('../src/lib/csv.js')));
}

// ── B. columns: the template and a spreadsheet's own headers ────────────────────────────────
{
  const template = tryRun(() => fn(ci, 'customerTemplateCsv')());
  const t = typeof template === 'string' ? tryRun(() => load(template)) : {};
  const mapped = new Set(Object.values(t.mapping || {}));
  ok('B1 the template is a CUSTOMERS template (customer number, name, location, supervisor, contact)',
    ['number', 'name', 'street', 'city', 'state', 'zip', 'supervisor', 'contactEmail'].every((k) => mapped.has(k)), JSON.stringify(t.headers));
  ok('B2 every template column maps back to a field on import', (t.headers || []).length > 0 && Object.keys(t.mapping || {}).length === t.headers.length, JSON.stringify(t.mapping));
  ok('B3 no billing column in the template (billing stays in QuickBooks, QB-11)', !(t.headers || []).some((h) => /bill|terms|tax/i.test(h)), JSON.stringify(t.headers));
  const guess = fn(ci, 'guessImportMapping');
  const g = tryRun(() => guess(['Customer #', 'Account', 'Address 1', 'Address 2', 'City', 'ST', 'Zip Code', 'Account Manager', 'Contact', 'E-mail', 'Phone Number', 'Title', 'Comments']));
  ok('B4 forgiving headers: Customer # / Account / Address 1 / Zip Code / Account Manager / Contact / E-mail',
    g[0] === 'number' && g[1] === 'name' && g[2] === 'street' && g[3] === 'street2' && g[4] === 'city' && g[5] === 'state'
      && g[6] === 'zip' && g[7] === 'supervisor' && g[8] === 'contactName' && g[9] === 'contactEmail' && g[10] === 'contactPhone'
      && g[11] === 'contactRole' && g[12] === 'notes', JSON.stringify(g));
  const g2 = tryRun(() => guess(['Client ID', 'Customer Name', 'Billing Address', 'Bill To City', 'Terms', 'Service Address']));
  ok('B5 "Client ID" is the number; billing columns are never guessed; "Service Address" is the street',
    g2[0] === 'number' && g2[1] === 'name' && g2[2] === undefined && g2[3] === undefined && g2[4] === undefined && g2[5] === 'street', JSON.stringify(g2));
  ok('B6 a billing header is recognised as one', tryRun(() => fn(ci, 'isBillingHeader')('Billing Address') === true && fn(ci, 'isBillingHeader')('Street') === false) === true);
  const g3 = tryRun(() => guess(['Name', 'Name']));
  ok('B7 a field is guessed for one column only', Object.values(g3).filter((v) => v === 'name').length === 1, JSON.stringify(g3));
}

// ── C. one row = one building, through the real reducer ─────────────────────────────────────
const HEAD = 'Customer #,Customer name,Street,City,State,ZIP';
{
  // C1: a plain building — no person at all.
  const s = book();
  const r = tryRun(() => run(`${HEAD}\n0003,Bayshore Commons,1200 N Ocean Blvd,Pompano Beach,FL,33062\n`, s));
  ok('C1 a building with no person imports (status create)', r.plan?.rows?.[0]?.status === 'create', JSON.stringify(r.plan?.rows?.[0]));
  const c = findClient(r.after || {}, 'Bayshore Commons');
  const site = siteOf(r.after || {}, c);
  ok('C2 it creates the customer with its number', c?.customerNumber === '0003' && c?.type === 'customer', JSON.stringify(c));
  ok('C3 …and its ONE location, carrying the structured address', site && site.street === '1200 N Ocean Blvd' && site.city === 'Pompano Beach'
    && site.state === 'FL' && site.zip === '33062' && /1200 N Ocean Blvd/.test(site.address || '') && (r.after.sites || []).filter((x) => x.clientId === c?.id).length === 1, JSON.stringify(site));
  ok('C4 the location is "not located yet" until the geocoder answers (no coordinates invented)', site && site.lat === null && site.lng === null && site.geocodeStatus == null, JSON.stringify(site));
  ok('C5 no contact was created for a building row with no contact columns', (r.after?.contacts || []).length === s.contacts.length);

  // C6: the number inside the name (QuickBooks' own "0001 Name"), and Excel's dropped zeros.
  const r2 = tryRun(() => run('Customer name,City\n0007 Gulfstream Logistics,Miami\n', s));
  const g = findClient(r2.after || {}, 'Gulfstream Logistics');
  ok('C6 "0007 Gulfstream Logistics" splits into number 0007 and the name (lib/customerNumber)', g?.customerNumber === '0007', JSON.stringify(r2.plan?.rows?.[0]));
  const r3 = tryRun(() => run(`${HEAD}\n9,Pine Island Center,,,,\n`, s));
  ok('C7 a number Excel saved without its zeros ("9") is 0009', findClient(r3.after || {}, 'Pine Island Center')?.customerNumber === '0009', JSON.stringify(r3.plan?.rows?.[0]));

  // C8: no number at all → created without one, never invented, and the row says so.
  const r4 = tryRun(() => run('Customer name\nSawgrass Corporate Park\n', s));
  const sp = findClient(r4.after || {}, 'Sawgrass Corporate Park');
  ok('C8 a row with no number is created WITHOUT one (never invented) and says so', sp && !sp.customerNumber
    && keysOf(r4.plan?.rows?.[0]?.warnings).includes('custImport.warn.noNumber'), JSON.stringify(r4.plan?.rows?.[0]));
  ok('C9 a row with no address says it cannot be located yet', keysOf(r4.plan?.rows?.[0]?.warnings).includes('custImport.warn.noAddress'));
}

// ── C10–C18. upsert, never duplicate ────────────────────────────────────────────────────────
{
  const s = book();
  // Matched by NUMBER: fills the blank, keeps the address on file, never blanks anything.
  const r = tryRun(() => run(`${HEAD},Notes\n0001,Harbor View Towers,1 Other St,Miami,FL,33130,Gate code at the desk\n`, s));
  const row = r.plan?.rows?.[0] || {};
  ok('C10 matched by number → update, not a second customer', row.status === 'update' && (r.after?.clients || []).filter((c) => c.customerNumber === '0001').length === 1, JSON.stringify(row));
  const a = findClient(r.after || {}, 'Harbor View Towers');
  ok('C11 the address on file is kept (fill blanks only) and the row says so', siteOf(r.after || {}, a)?.street === '500 SE 3rd Ave'
    && keysOf(row.warnings).includes('custImport.warn.addressKept'), JSON.stringify(row));
  ok('C12 notes land on the customer’s Notes tab', (r.after?.clientActivities || []).some((x) => x.clientId === 'cl_a' && x.kind === 'note' && x.body === 'Gate code at the desk'));
  const again = tryRun(() => run(`${HEAD},Notes\n0001,Harbor View Towers,1 Other St,Miami,FL,33130,Gate code at the desk\n`, r.after));
  ok('C13 importing the same file again changes nothing (unchanged, no second note)', again.plan?.rows?.[0]?.status === 'unchanged'
    && (again.after?.clientActivities || []).filter((x) => x.clientId === 'cl_a').length === 1, JSON.stringify(again.plan?.rows?.[0]));
  // An empty cell never blanks a field that has a value.
  const blank = tryRun(() => run(`${HEAD}\n0001,Harbor View Towers,,,,\n`, s));
  const after = findClient(blank.after || {}, 'Harbor View Towers');
  ok('C14 an empty cell never blanks a field (the number, the address)', after?.customerNumber === '0001' && siteOf(blank.after || {}, after)?.street === '500 SE 3rd Ave' && blank.plan?.rows?.[0]?.status === 'unchanged', JSON.stringify(blank.plan?.rows?.[0]));
  // Matched by NAME: the customer with no number takes the file's, and its blank address is filled.
  const byName = tryRun(() => run(`${HEAD}\n0004,Coral Ridge Plaza,3300 N Federal Hwy,Fort Lauderdale,FL,33306\n`, s));
  const b = findClient(byName.after || {}, 'Coral Ridge Plaza');
  ok('C15 matched by name → the blank number and the blank address are filled', byName.plan?.rows?.[0]?.status === 'update'
    && b?.customerNumber === '0004' && siteOf(byName.after || {}, b)?.street === '3300 N Federal Hwy'
    && /3300 N Federal Hwy/.test(siteOf(byName.after || {}, b)?.address || ''), JSON.stringify(byName.plan?.rows?.[0]));
  ok('C16 …and no second Coral Ridge Plaza', (byName.after?.clients || []).filter((c) => c.name === 'Coral Ridge Plaza').length === 1);
  // A whole re-import of a 3-row file is idempotent.
  const file = `${HEAD}\n0001,Harbor View Towers,,,,\n0005,Tamarac Commons,7000 W Commercial Blvd,Tamarac,FL,33319\n0006,Weston Town Center,,,,\n`;
  const first = tryRun(() => run(file, s));
  const second = tryRun(() => run(file, first.after));
  ok('C17 a second import of the same file: every row unchanged, no new record anywhere',
    (second.plan?.rows || []).every((x) => x.status === 'unchanged')
      && second.after?.clients?.length === first.after?.clients?.length && second.after?.sites?.length === first.after?.sites?.length,
    JSON.stringify((second.plan?.rows || []).map((x) => x.status)));
  // Replay: the same ACTION applied twice (a save that committed but whose answer was lost).
  const once = applyOps(s, first.ops || []);
  const twice = applyOps(once, first.ops || []);
  const slim = (st) => JSON.stringify(['clients', 'sites', 'contacts', 'clientActivities'].map((k) => (st[k] || []).map((x) => x.id)));
  ok('C18 replaying the same import action creates nothing twice (caller-minted ids + dedupe)', slim(once) === slim(twice));
}

// ── C19–C25. a taken or malformed number is a row error, never invented ─────────────────────
{
  const s = book();
  const p = tryRun(() => plan(`${HEAD}\n0001,Lakeview Apartments,,,,\n12345,Too Long Inc,,,,\nA12,Letters Co,,,,\n,0009 Name Number,,,,\n`, s));
  const [taken, five, letters] = p.rows || [];
  ok('C19 a number another customer holds (the row names a different building) is an error naming the holder',
    taken?.status === 'error' && keysOf(taken.errors).includes('custNumber.taken') && /Harbor View Towers/.test(english(taken.errors?.[0])), JSON.stringify(taken));
  ok('C20 five digits is an error', five?.status === 'error' && keysOf(five.errors).includes('custImport.err.numberInvalid'), JSON.stringify(five));
  ok('C21 letters are an error', letters?.status === 'error' && keysOf(letters.errors).includes('custImport.err.numberInvalid'), JSON.stringify(letters));
  // A row that is not imported still shows where the building is (the preview, the problems file).
  const placed = tryRun(() => plan(`${HEAD}\n12345,Too Long Inc,2 Main St,Miami,FL,33130\n`, s));
  ok('C21b a malformed-number row still shows its address', placed.rows?.[0]?.status === 'error' && placed.rows?.[0]?.address === '2 Main St, Miami FL 33130', JSON.stringify(placed.rows?.[0]));
  const conflict = tryRun(() => plan(`${HEAD}\n0010,0011 Split Names,,,,\n`, s));
  ok('C22 a number column that disagrees with the number in the name is an error', conflict.rows?.[0]?.status === 'error'
    && keysOf(conflict.rows[0].errors).includes('custImport.err.numberConflict'), JSON.stringify(conflict.rows?.[0]));
  const mismatch = tryRun(() => plan(`${HEAD}\n0008,Harbor View Towers,,,,\n`, s));
  ok('C23 a name whose customer already has another number is an error (a number is never silently changed)',
    mismatch.rows?.[0]?.status === 'error' && keysOf(mismatch.rows[0].errors).includes('custImport.err.numberMismatch'), JSON.stringify(mismatch.rows?.[0]));
  const twin = tryRun(() => plan(`${HEAD}\n0012,North Tower,,,,\n0012,South Tower,,,,\n`, s));
  ok('C24 two rows giving one number to two buildings: the second is an error', twin.rows?.[0]?.status === 'create'
    && twin.rows?.[1]?.status === 'error' && keysOf(twin.rows[1].errors).includes('custImport.err.duplicateNumber'), JSON.stringify(twin.rows));
  const noName = tryRun(() => plan(`${HEAD}\n0013,,1 Main St,Miami,FL,33130\n`, s));
  ok('C25 a row with no customer name is an error', noName.rows?.[0]?.status === 'error' && keysOf(noName.rows[0].errors).includes('custImport.err.noName'), JSON.stringify(noName.rows?.[0]));
  const nothing = tryRun(() => fn(ci, 'buildImportOps')(p, { newId: newIdT }));
  ok('C26 error rows write nothing', Array.isArray(nothing) && nothing.every((op) => !JSON.stringify(op).includes('Lakeview') && !JSON.stringify(op).includes('Too Long')), JSON.stringify(nothing));
}

// ── C27–C33. the supervisor: a team member by email or exact name, never guessed ─────────────
{
  const s = book();
  const SUP = 'Customer #,Customer name,Supervisor';
  const r = tryRun(() => run(`${SUP}\n0020,Email Match,renata@cleanspaceonline.com\n0021,Name Match,  yolanda   reyes \n0022,Nobody Match,Pat Nobody\n0023,Crew Match,andre@cleanspaceonline.com\n`, s));
  const sup = (name) => findClient(r.after || {}, name)?.supervisorId ?? null;
  ok('C27 matched by email (case-insensitive)', sup('Email Match') === 'u_seed_mgr1', JSON.stringify(r.plan?.rows?.[0]));
  ok('C28 matched by exact name (spaces and case forgiven, nothing else)', sup('Name Match') === 'u_seed_heather', JSON.stringify(r.plan?.rows?.[1]));
  ok('C29 no match → left blank with a warning, never guessed', sup('Nobody Match') === null
    && keysOf(r.plan?.rows?.[2]?.warnings).includes('custImport.warn.supervisorNotFound'), JSON.stringify(r.plan?.rows?.[2]));
  ok('C30 a cleaner is not eligible → left blank with a warning', sup('Crew Match') === null
    && keysOf(r.plan?.rows?.[3]?.warnings).includes('custImport.warn.supervisorNotEligible'), JSON.stringify(r.plan?.rows?.[3]));
  // The server refuses a supervisor set from anyone but a Super Admin or Admin (MTA W1-G), so the
  // import never sends one for a manager: the column is left out, in words (UI_RULES §118).
  const m = tryRun(() => run(`${SUP}\n0024,Manager Import,renata@cleanspaceonline.com\n`, s, MANAGER));
  ok('C31 a manager’s import leaves the supervisor out and says why', findClient(m.after || {}, 'Manager Import') && !findClient(m.after || {}, 'Manager Import').supervisorId
    && keysOf(m.plan?.rows?.[0]?.warnings).includes('custImport.warn.supervisorNotAllowed'), JSON.stringify(m.plan?.rows?.[0]));
  ok('C32 …and no op carries a supervisorId', !(m.ops || []).some((op) => JSON.stringify(op).includes('supervisorId')), JSON.stringify(m.ops));
  // An existing supervisor is kept (fill blanks only).
  const kept = tryRun(() => run(`${SUP}\n,Coral Ridge Plaza,renata@cleanspaceonline.com\n`, s));
  ok('C33 the supervisor on file is kept, with a note', findClient(kept.after || {}, 'Coral Ridge Plaza')?.supervisorId === 'u_seed_heather'
    && keysOf(kept.plan?.rows?.[0]?.warnings).includes('custImport.warn.supervisorKept'), JSON.stringify(kept.plan?.rows?.[0]));
}

// ── C34–C41. the optional primary contact ───────────────────────────────────────────────────
{
  const s = book();
  const CON = 'Customer #,Customer name,Contact first name,Contact last name,Contact email,Contact phone,Contact role';
  const r = tryRun(() => run(`${CON}\n0030,Oakland Park Lofts,Ana,Silva,ANA@oaklandlofts.example,(954) 555-0101,Property manager\n`, s));
  const c = findClient(r.after || {}, 'Oakland Park Lofts');
  const ana = (r.after?.contacts || []).find((x) => x.email === 'ana@oaklandlofts.example');
  ok('C34 the contact is created with its details', ana && ana.firstName === 'Ana' && ana.lastName === 'Silva' && ana.phone === '(954) 555-0101' && ana.title === 'Property manager', JSON.stringify(ana));
  ok('C35 …linked to the customer as its primary contact', ana && ana.companyId === c?.id && c?.primaryContactId === ana.id, JSON.stringify(c));
  // The same person again (the email is the key): filled, never duplicated.
  const again = tryRun(() => run(`${CON}\n0030,Oakland Park Lofts,,,ana@oaklandlofts.example,,Regional manager\n`, r.after));
  ok('C36 an existing contact is matched by email: no second Ana, her title is not overwritten', (again.after?.contacts || []).filter((x) => x.email === 'ana@oaklandlofts.example').length === 1
    && (again.after?.contacts || []).find((x) => x.email === 'ana@oaklandlofts.example')?.title === 'Property manager', JSON.stringify(again.plan?.rows?.[0]));
  // An email that belongs to another customer's person is not moved or duplicated.
  const elsewhere = tryRun(() => run(`${CON}\n0001,Harbor View Towers,Kim,Ortiz,kim@elsewhere.example,,\n`, s));
  ok('C37 a contact who belongs to another customer is left there, with a note', keysOf(elsewhere.plan?.rows?.[0]?.warnings).includes('custImport.warn.contactElsewhere')
    && (elsewhere.after?.contacts || []).find((x) => x.id === 'ct_kim')?.companyId === 'cl_b', JSON.stringify(elsewhere.plan?.rows?.[0]));
  const bad = tryRun(() => run(`${CON}\n0031,Bad Email Place,Jo,Doe,not-an-email,,\n`, s));
  ok('C38 an invalid email leaves the contact out (the customer still imports), with a note', findClient(bad.after || {}, 'Bad Email Place')
    && !(bad.after?.contacts || []).some((x) => x.firstName === 'Jo' && x.lastName === 'Doe')
    && keysOf(bad.plan?.rows?.[0]?.warnings).includes('custImport.warn.contactEmailInvalid'), JSON.stringify(bad.plan?.rows?.[0]));
  // Without contacts.edit the contact columns are left out, in words (the server would refuse them).
  const nc = tryRun(() => run(`${CON}\n0032,No Contacts Co,Lu,Chen,lu@nocontacts.example,,\n`, s, NO_CONTACTS));
  ok('C39 without "Create / edit contacts" the customer imports and the contact is left out, with a note', findClient(nc.after || {}, 'No Contacts Co')
    && !(nc.after?.contacts || []).some((x) => x.email === 'lu@nocontacts.example') && keysOf(nc.plan?.rows?.[0]?.warnings).includes('custImport.warn.contactNotAllowed'), JSON.stringify(nc.plan?.rows?.[0]));
  ok('C40 …and no op adds or changes a contact', !(nc.ops || []).some((op) => /Contact/.test(op.op || '')), JSON.stringify(nc.ops));
  // A full name in one column is split; a second row for the same building adds a second contact.
  const two = tryRun(() => run('Customer #,Customer name,Contact,Contact email\n0033,Twin Contacts Tower,Rosa Maria Diaz,rosa@twin.example\n0033,Twin Contacts Tower,Luis Gomez,luis@twin.example\n', s));
  const tw = findClient(two.after || {}, 'Twin Contacts Tower');
  const people = (two.after?.contacts || []).filter((x) => x.companyId === tw?.id);
  ok('C41 a building on two rows is ONE customer with two contacts; a full name is split', (two.after?.clients || []).filter((x) => x.name === 'Twin Contacts Tower').length === 1
    && people.length === 2 && people.some((x) => x.firstName === 'Rosa' && x.lastName === 'Maria Diaz') && tw?.primaryContactId === people.find((x) => x.firstName === 'Rosa')?.id, JSON.stringify(people));
  // The second row is not a second "update": it is the same customer, and the plan counts
  // CUSTOMERS (what the Import button and the totals say) apart from rows.
  ok('C41b …its second row is "same customer", and the plan counts one new customer, not two rows',
    two.plan?.rows?.[0]?.status === 'create' && two.plan?.rows?.[1]?.status === 'same'
      && two.plan?.customers?.create === 1 && two.plan?.customers?.update === 0, JSON.stringify({ statuses: (two.plan?.rows || []).map((x) => x.status), customers: two.plan?.customers }));
  // A customer on file named twice: nothing new on its first row, a new contact on its second.
  // It is ONE customer updated, not one unchanged and one updated.
  const both = tryRun(() => run('Customer #,Customer name,Contact,Contact email\n0001,Harbor View Towers,,\n0001,Harbor View Towers,Nia Brooks,nia@harborview.example\n', s));
  ok('C41c a customer on file named on two rows counts once, as updated when any of its rows adds something',
    both.plan?.rows?.[0]?.status === 'unchanged' && both.plan?.rows?.[1]?.status === 'same'
      && both.plan?.customers?.update === 1 && both.plan?.customers?.unchanged === 0
      && (both.after?.contacts || []).some((x) => x.email === 'nia@harborview.example' && x.companyId === 'cl_a'), JSON.stringify({ statuses: (both.plan?.rows || []).map((x) => x.status), customers: both.plan?.customers }));
}

// ── C42–C47. vendors, states, ZIPs, tags, and who may import at all ────────────────────────
{
  const s = book();
  const v = tryRun(() => run('Customer #,Customer name,Type,Street,City,State,ZIP\n0040,Sunshine Supply Co,Vendor,4000 NW 36th St,Miami,FL,33142\n', s));
  const vc = findClient(v.after || {}, 'Sunshine Supply Co');
  ok('C42 a vendor gets no location and no customer number, and the row says why', vc?.type === 'vendor' && !vc.customerNumber && !siteOf(v.after || {}, vc)
    && keysOf(v.plan?.rows?.[0]?.warnings).includes('custImport.warn.vendorAddress'), JSON.stringify(v.plan?.rows?.[0]));
  const st = tryRun(() => run(`${HEAD}\n0041,State Name Place,1 Main St,Tampa,Florida,336\n0042,Bad State Place,2 Main St,Tampa,Atlantis,33602\n`, s));
  const sn = siteOf(st.after || {}, findClient(st.after || {}, 'State Name Place'));
  ok('C43 "Florida" is FL; a 3-digit ZIP Excel stripped is padded, with a note', sn?.state === 'FL' && sn?.zip === '00336'
    && keysOf(st.plan?.rows?.[0]?.warnings).includes('custImport.warn.zipPadded'), JSON.stringify(sn));
  const forms = ['FL', 'fl', 'Fl.', 'Fla.', 'Florida', ' new  york ', 'Ga.', 'D.C.'].map((v) => tryRun(() => fn(us, 'normalizeUsState')(v)));
  ok('C43b a state however it was typed: a code with or without dots, a name, a short form', forms.join(' ') === 'FL FL FL FL FL NY GA DC', forms.join(' '));
  ok('C44 an unknown state is left blank, with a note', siteOf(st.after || {}, findClient(st.after || {}, 'Bad State Place'))?.state === ''
    && keysOf(st.plan?.rows?.[1]?.warnings).includes('custImport.warn.stateUnknown'), JSON.stringify(st.plan?.rows?.[1]));
  const tagged = tryRun(() => run(`${HEAD}\n0001,Harbor View Towers,,,,\n0043,Tagged New,,,,\n`, s, OWNER, { tagIds: ['tg_seed_vip'] }));
  ok('C45 chosen tags reach every customer in the file (new and matched)', (findClient(tagged.after || {}, 'Harbor View Towers')?.tagIds || []).includes('tg_seed_vip')
    && (findClient(tagged.after || {}, 'Tagged New')?.tagIds || []).includes('tg_seed_vip'));
  const none = tryRun(() => plan(`${HEAD}\n0044,Should Not Import,,,,\n`, s, NOBODY));
  ok('C46 without "Create / edit customers" nothing is planned', (none.rows || []).every((x) => x.status === 'error') && (none.rows || []).length === 1, JSON.stringify(none.rows));
  const perms = fn(ci, 'importPermissions');
  const holds = (keys) => (k) => keys.includes(k);
  const own = tryRun(() => perms({ role: 'owner', holds: holds([]) }));
  const adm = tryRun(() => perms({ role: 'admin', holds: holds(['clients.edit', 'contacts.edit']) }));
  const mgr = tryRun(() => perms({ role: 'manager', holds: holds(['clients.edit']) }));
  const crew = tryRun(() => perms({ role: 'crew', holds: holds(['clients.edit', 'contacts.edit']) }));
  ok('C47 who may: the Super Admin always; others by "Create / edit customers" and "contacts"; supervisors by Super Admin / Admin; a cleaner never',
    own.canImport && own.canContacts && own.canAssignSupervisor && adm.canImport && adm.canContacts && adm.canAssignSupervisor
      && mgr.canImport && !mgr.canContacts && !mgr.canAssignSupervisor && !crew.canImport && !crew.canContacts, JSON.stringify({ own, adm, mgr, crew }));
  // The problems file is meant to be fixed and imported again: its own columns (row, result,
  // problem) map to nothing, the file's columns map as before, the guard's apostrophe is gone.
  const head = 'Customer #,Customer name,Street,City,State,ZIP,Contact phone';
  const first = tryRun(() => plan(`${head}\n12345,Too Long Inc,2 Main St,Miami,FL,33130,+1 (954) 555-0101\n`, s));
  const problemsFile = tryRun(() => fn(ci, 'importProblemsCsv')({ plan: first, headers: head.split(','), render: (m) => english(m) }));
  const again = typeof problemsFile === 'string' ? tryRun(() => load(problemsFile)) : {};
  const mappedAgain = Object.entries(again.mapping || {}).map(([i, k]) => `${again.headers[i]}=${k}`).join(' ');
  ok('C48 the problems file imports again: only the original columns map, and the values come back clean',
    mappedAgain === 'Customer #=number Customer name=name Street=street City=city State=state ZIP=zip Contact phone=contactPhone'
      && again.rows?.[0]?.[again.headers.indexOf('Contact phone')] === '+1 (954) 555-0101', `${mappedAgain} · ${JSON.stringify(again.rows)}`);
}

// ── H. status: an imported book comes in ACTIVE, its people as clients (fix round, S113) ─────
// Matt's team imports its EXISTING ~750 active buildings. ADD_CLIENT stores no status (it is
// derived: Active on the first job), so every imported customer read "Lead" until a job existed,
// and ADD_CONTACT defaults lifecycle 'lead', so a week later ~1,500 property managers filled the
// Dashboard's stale-leads list. The import now sets the manual override the customer page's
// status menu writes (statusOverride), Active unless the file says otherwise, and gives each new
// person the lifecycle that follows from their customer.
{
  const s = book();
  const status = (st, name) => findClient(st || {}, name)?.statusOverride ?? null;
  const shown = (st, name) => (typeof sel.selectClientStatus === 'function' ? sel.selectClientStatus(st || {}, findClient(st || {}, name)) : null);
  // H1: no Status column → Active, and the customer page says Active with no job on file.
  const plain = tryRun(() => run(`${HEAD}\n0050,Default Status Tower,1 Main St,Miami,FL,33130\n`, s));
  ok('H1 a new customer comes in Active by default (no Status column), and shows Active with no job',
    status(plain.after, 'Default Status Tower') === 'active' && shown(plain.after, 'Default Status Tower') === 'active',
    JSON.stringify({ override: status(plain.after, 'Default Status Tower'), shown: shown(plain.after, 'Default Status Tower') }));
  ok('H1b …and the preview names the status', (plain.plan?.rows?.[0]?.changes || []).map(english).includes('Status: Active.'),
    JSON.stringify((plain.plan?.rows?.[0]?.changes || []).map(english)));
  // H2: every word the column may hold, in any case; an unknown one warns and imports Active.
  const words = [['Active', 'active'], ['current', 'active'], ['CUSTOMER', 'active'], ['Client', 'active'], ['Lead', 'lead'], ['prospect', 'lead'],
    ['Inactive', 'inactive'], ['former', 'inactive'], ['Cancelled', 'inactive'], ['canceled', 'inactive'], ['lost', 'inactive'], ['Closed', 'inactive'], ['In-active', 'inactive']];
  const rows = words.map(([w], i) => `${String(60 + i).padStart(4, '0')},Status Word ${i},${w}`).join('\n');
  const mapped = tryRun(() => run(`Customer #,Customer name,Status\n${rows}\n0099,Status Unknown Place,Pending\n`, s));
  const got = words.map((_, i) => status(mapped.after, `Status Word ${i}`));
  ok('H2 each Status value maps: active / current / customer / client → Active, lead / prospect → Lead, inactive / former / cancelled / canceled / lost / closed → Inactive',
    words.every(([, want], i) => got[i] === want), JSON.stringify(words.map(([w], i) => `${w}=${got[i]}`)));
  const unknownRow = (mapped.plan?.rows || []).find((r) => r.name === 'Status Unknown Place');
  ok('H2b an unknown status warns, and the row imports as Active', status(mapped.after, 'Status Unknown Place') === 'active'
    && keysOf(unknownRow?.warnings).includes('custImport.warn.statusUnknown'), JSON.stringify(unknownRow));
  ok('H2c the Status column is guessed from "Status", "Customer status" and "Account status"', ['Status', 'Customer status', 'Account Status']
    .every((h) => Object.values(tryRun(() => fn(ci, 'guessImportMapping')(['Customer name', h])) || {}).includes('status')));
  // H3: a customer on file keeps the status it has; no Status column changes nothing; a blank one is filled.
  const onFile = book();
  onFile.clients[0].statusOverride = 'inactive';
  const kept = tryRun(() => run('Customer #,Customer name,Status\n0001,Harbor View Towers,Active\n', onFile));
  ok('H3 a matched customer’s status on file is never overwritten (with a note)', status(kept.after, 'Harbor View Towers') === 'inactive'
    && keysOf(kept.plan?.rows?.[0]?.warnings).includes('custImport.warn.statusKept'), JSON.stringify(kept.plan?.rows?.[0]));
  const noColumn = tryRun(() => run(`${HEAD}\n,Coral Ridge Plaza,9 Coral Way,Coral Springs,FL,33065\n`, s));
  ok('H3b with no Status column a matched customer’s status is untouched', status(noColumn.after, 'Coral Ridge Plaza') === null
    && !(noColumn.ops || []).some((op) => op.patch && 'statusOverride' in op.patch), JSON.stringify(noColumn.ops));
  const filled = tryRun(() => run('Customer #,Customer name,Status\n,Coral Ridge Plaza,Lead\n', s));
  ok('H3c a matched customer with no status set takes the file’s', status(filled.after, 'Coral Ridge Plaza') === 'lead', JSON.stringify(filled.plan?.rows?.[0]));
  // …and the fill is re-checked when it lands: a status set after the preview is kept.
  const raced = clone(s);
  const racePlan = tryRun(() => plan('Customer #,Customer name,Status\n,Coral Ridge Plaza,Lead\n', s));
  raced.clients.find((c) => c.name === 'Coral Ridge Plaza').statusOverride = 'inactive';
  const raceAfter = tryRun(() => applyOps(raced, fn(ci, 'buildImportOps')(racePlan, { newId: newIdT })));
  ok('H3d a status set between the preview and the save is never overwritten', status(raceAfter, 'Coral Ridge Plaza') === 'inactive', String(status(raceAfter, 'Coral Ridge Plaza')));
  // H4: a NEW person's lifecycle follows their customer; a matched person's is never touched.
  const CON = 'Customer #,Customer name,Type,Status,Contact first name,Contact last name,Contact email';
  const people = tryRun(() => run(`${CON}\n0070,Active Lifecycle Co,Customer,Active,Ana,One,ana@active.example\n0071,Lead Lifecycle Co,Customer,Lead,Ben,Two,ben@lead.example\n0072,Inactive Lifecycle Co,Customer,Inactive,Cy,Three,cy@inactive.example\n,Vendor Lifecycle Co,Vendor,,Dee,Four,dee@vendor.example\n`, s));
  const life = (email) => (people.after?.contacts || []).find((x) => x.email === email)?.lifecycle;
  ok('H4 a new contact is a client under an Active or Inactive customer, a lead under a Lead one, a vendor under a vendor',
    life('ana@active.example') === 'client' && life('ben@lead.example') === 'lead' && life('cy@inactive.example') === 'client' && life('dee@vendor.example') === 'vendor',
    JSON.stringify(['ana@active.example', 'ben@lead.example', 'cy@inactive.example', 'dee@vendor.example'].map(life)));
  ok('H4b a vendor gets no status of its own (its Vendor badge wins)', status(people.after, 'Vendor Lifecycle Co') === null
    && (typeof sel.selectClientBadgeStatus === 'function' ? sel.selectClientBadgeStatus(people.after, findClient(people.after, 'Vendor Lifecycle Co')) : null) === 'vendor');
  const withLead = book();
  withLead.contacts[0].lifecycle = 'prospect';
  const touched = tryRun(() => run('Customer #,Customer name,Status,Contact email,Contact phone\n0001,Harbor View Towers,Active,pat@harborview.example,(954) 555-0199\n', withLead));
  const pat = (touched.after?.contacts || []).find((x) => x.id === 'ct_pat');
  ok('H4c a matched contact’s lifecycle is never touched (its blank phone still fills)', pat?.lifecycle === 'prospect' && pat?.phone === '(954) 555-0199', JSON.stringify(pat));
  const derived = tryRun(() => run('Customer #,Customer name,Contact first name,Contact email\n,Coral Ridge Plaza,Eve,eve@coral.example\n', s));
  ok('H4d with no Status column a new contact follows the matched customer’s own status (Lead here: no work on file)',
    (derived.after?.contacts || []).find((x) => x.email === 'eve@coral.example')?.lifecycle === shown(s, 'Coral Ridge Plaza'),
    `${(derived.after?.contacts || []).find((x) => x.email === 'eve@coral.example')?.lifecycle} vs ${shown(s, 'Coral Ridge Plaza')}`);
  // H5: the template carries the column, Active on the two customers, blank on the vendor.
  const template = tryRun(() => fn(ci, 'customerTemplateCsv')());
  const t = typeof template === 'string' ? tryRun(() => load(template)) : {};
  const at = Object.entries(t.mapping || {}).find(([, k]) => k === 'status')?.[0];
  ok('H5 the template has a Status column: Active on the two customers, blank on the vendor', at !== undefined
    && (t.rows || []).map((r) => r[at]).join('|') === 'Active|Active|', JSON.stringify({ headers: t.headers, at }));
}

// ── D. the shared record's size: refused BEFORE anything is written ─────────────────────────
{
  ok('D1 the save ceiling is ONE constant the server and the importer share', budget.MAX_STATE_BYTES === 3_500_000 && blob.MAX_STATE_BYTES === budget.MAX_STATE_BYTES,
    `stateBudget ${budget.MAX_STATE_BYTES} · blobBudget ${blob.MAX_STATE_BYTES}`);
  const serialize = (st) => tables.serializeSharedBlob(st);
  const s = book();
  const small = tryRun(() => fn(ci, 'prepareImport')({ state: s, plan: plan(`${HEAD}\n0050,Small One,1 Main St,Miami,FL,33130\n`, s), newId: newIdT, applyOps, serialize }));
  ok('D2 a small import fits, and the verdict carries the measured bytes', small.verdict?.fits === true && small.verdict.after > small.verdict.before && !small.refusal, JSON.stringify(small.verdict));
  // A book already near its ceiling: the import is refused and NOTHING is dispatched.
  const big = book();
  big.company = { ...big.company, filler: 'x'.repeat(budget.MAX_STATE_BYTES || 3_500_000) };
  const dispatched = [];
  const refused = tryRun(() => fn(ci, 'commitImport')({ state: big, plan: plan(`${HEAD}\n0051,Too Big,1 Main St,Miami,FL,33130\n`, big), newId: newIdT,
    applyOps, serialize, dispatch: (a) => dispatched.push(a), actionType: IMPORT }));
  ok('D3 an import past the ceiling is refused in words and nothing is dispatched', refused && refused.refusal && dispatched.length === 0
    && /shared record/i.test(english(refused.refusal)), JSON.stringify({ refusal: refused?.refusal, dispatched: dispatched.length }));
  const okRun = tryRun(() => fn(ci, 'commitImport')({ state: s, plan: plan(`${HEAD}\n0052,Fits Fine,1 Main St,Miami,FL,33130\n`, s), newId: newIdT,
    applyOps, serialize, dispatch: (a) => dispatched.push(a), actionType: IMPORT }));
  ok('D4 an import that fits is dispatched as ONE action', !okRun?.refusal && dispatched.length === 1 && dispatched[0].type === IMPORT && Array.isArray(dispatched[0].ops), JSON.stringify(okRun));
  ok('D5 the import may not fill the record to its limit: it keeps room for everyday work', budget.IMPORT_ALLOWED_BYTES < budget.MAX_STATE_BYTES && budget.IMPORT_ALLOWED_BYTES > budget.MAX_STATE_BYTES * 0.8);
}

// ── E. locating the buildings: the geocoder decides, an unlocated building is safe ───────────
{
  const s = book();
  const r = tryRun(() => run(`${HEAD}\n0060,Located Place,1 Las Olas Blvd,Fort Lauderdale,FL,33301\n0061,No Key Place,2 Las Olas Blvd,Fort Lauderdale,FL,33301\n`, s));
  const locs = tryRun(() => fn(ci, 'importedLocations')(r.ops || [], r.after || {}));
  ok('E1 the import lists the locations it gave an address to (for the bounded geocoder)', Array.isArray(locs) && locs.length === 2 && locs.every((l) => l.id && l.address), JSON.stringify(locs));
  if (Array.isArray(locs) && geo.resolveGeocodeMany) {
    const answer = async (address) => {
      if (/^1 /.test(address)) return { lat: 26.119, lng: -80.137 };
      const e = new Error('Geocoding is not configured'); e.status = 503; throw e;
    };
    const { patches } = await geo.resolveGeocodeMany(locs.map((l) => ({ id: l.id, address: l.address, previous: {} })), { geocode: answer });
    let st = r.after;
    for (const { id, patch } of patches) st = reducer(st, { type: ACTIONS.UPDATE_SITE, id, patch });
    const located = siteOf(st, findClient(st, 'Located Place'));
    const nokey = siteOf(st, findClient(st, 'No Key Place'));
    ok('E2 an answered address is located (coordinates and status)', located?.geocodeStatus === 'located' && Number.isFinite(located?.lat), JSON.stringify(located));
    ok('E3 with no Maps key the building keeps its address and says "unavailable" — no coordinates invented', nokey?.geocodeStatus === 'unavailable'
      && nokey.lat === null && nokey.address.includes('2 Las Olas Blvd'), JSON.stringify(nokey));
  } else ok('E2/E3 the geocoder module loads', false);
  const lib = await import('../src/lib/geo.js');
  const v = lib.geofenceVerdict({ siteLat: null, siteLng: null, deviceLat: 26.1, deviceLng: -80.1, accuracyM: 10 });
  ok('E4 (today’s rule, unchanged) an unlocated building lets a clock-in through, flagged for review, not alarmed as off-site',
    v.allowed === true && v.result === 'no_site_coords' && lib.isFlaggedVerdict(v.result) && !lib.isOffSiteVerdict(v.result), JSON.stringify(v));
  // The rest of the book, a hundred at a time: addressed + unlocated + not already refused by the geocoder.
  const book2 = clone(r.after || s);
  book2.sites = [...(book2.sites || []),
    { id: 'st_x1', clientId: 'cl_x1', address: '9 Gone Rd, Nowhere FL 00000', geocodeStatus: 'not_located', lat: null, lng: null },
    { id: 'st_x2', clientId: 'cl_x2', address: '', geocodeStatus: null, lat: null, lng: null },
    { id: 'st_x3', clientId: 'cl_x3', address: '3 Las Olas Blvd, Fort Lauderdale FL 33301', geocodeStatus: 'located', geocodedAddress: '3 Las Olas Blvd, Fort Lauderdale FL 33301', lat: 26.1, lng: -80.1 }];
  book2.clients = [...(book2.clients || []), { id: 'cl_x1', name: 'X1', type: 'customer' }, { id: 'cl_x2', name: 'X2', type: 'customer' }, { id: 'cl_x3', name: 'X3', type: 'customer' }];
  const next = tryRun(() => fn(ci, 'locatableLocations')(book2));
  ok('E5 "locate the next" picks addressed, unlocated locations, and skips ones the geocoder could not find (fix the address first)',
    Array.isArray(next) && !next.some((l) => ['st_x1', 'st_x2', 'st_x3'].includes(l.id)) && next.some((l) => /Las Olas/.test(l.address)), JSON.stringify(next));
}

// ── F. the lead intake (api/_lib/leads/upsert.js) keeps its own person engine ──────────────
{
  ok('F1 the lead intake still loads', typeof leads.ingestLead === 'function');
  if (typeof leads.ingestLead === 'function') {
    const st = { pipelines: [{ id: 'pl_master', isMaster: true, label: 'Master Pipeline', stages: [] }], clients: [{ id: 'cl_e', name: 'Evergreen Medical Group', email: 'pat@evergreenmed.com' }],
      contacts: [{ id: 'ct_p', email: 'pat@evergreenmed.com', firstName: 'Pat', lastName: '', phone: '', companyId: 'cl_e', tagIds: [] }], tags: [] };
    const made = leads.ingestLead(st, { email: 'new@lead.example', firstName: 'New', company: 'Evergreen Medical Group, LLC' }, { pipelineId: 'pl_master' });
    ok('F2 a new lead is created and tied to the existing company by name (unchanged behaviour)', made.status === 'created'
      && made.state.contacts.find((c) => c.id === made.contactId)?.companyId === 'cl_e' && made.state.clients.length === 1);
    const filled = leads.ingestLead(st, { email: 'pat@evergreenmed.com', phone: '555-0201', firstName: 'NotPat' }, { pipelineId: 'pl_master' });
    ok('F3 a known lead fills blanks and never overwrites (unchanged behaviour)', filled.status === 'updated'
      && filled.state.contacts.find((c) => c.id === 'ct_p')?.phone === '555-0201' && filled.state.contacts.find((c) => c.id === 'ct_p')?.firstName === 'Pat');
  }
  // Replace means delete: the person importer's location columns and sample file left with it.
  ok('F4 the person engine no longer carries the old modal’s location columns or sample (II.5)',
    !('locationFromMapped' in csv) && !('LOCATION_FIELD_KEYS' in csv) && !('buildSampleContactCsv' in csv) && !('CONTACT_FIELDS' in csv) && typeof csv.buildImportPlan === 'function');
}

// ── S. Clean Space's scale: 750 buildings, 1,500 contacts, against the save ceiling ─────────
// THE LAW II.2: measured, and kept as a regression test with a generous ceiling. The demo book
// (INITIAL_STATE) stands in for production (S113 measured production at 184,865 bytes with the
// same 13 customers). The import must plan, apply and measure in well under a few seconds, land
// every building with its one location, and fit inside what an import may use.
{
  let sample = {};
  try { sample = await import('./customer-import-sample.mjs'); } catch { /* reported below */ }
  if (typeof sample.sampleBuildingsCsv === 'function' && typeof ci.prepareImport === 'function' && tables.serializeSharedBlob) {
    const state = clone(INITIAL_STATE);
    const text = sample.sampleBuildingsCsv({ buildings: 750, contactsPerBuilding: 2 });
    const t0 = performance.now();
    const f = load(text);
    const p = ci.planCustomerImport({ rows: f.rows, mapping: f.mapping, state, perms: OWNER, statusOf: statusOf(state) });
    const t1 = performance.now();
    const prepared = ci.prepareImport({ state, plan: p, newId: newIdT, applyOps, serialize: (st) => tables.serializeSharedBlob(st) });
    const t2 = performance.now();
    const after = prepared.verdict?.stateAfter || {};
    const added = (after.clients || []).length - state.clients.length;
    const addedSites = (after.sites || []).length - state.sites.length;
    const addedContacts = (after.contacts || []).length - state.contacts.length;
    const v = prepared.verdict || {};
    console.log(`  scale: 1,500 rows planned in ${Math.round(t1 - t0)} ms; applied + measured in ${Math.round(t2 - t1)} ms`);
    console.log(`  scale: shared record ${v.before} → ${v.after} bytes (+${v.after - v.before}); ${v.perBuilding} bytes per building with two contacts; allowed ${v.allowed}, limit ${v.limit}`);
    ok('S1 750 buildings plan as 750 new customers and 750 more rows adding their second contact', p.counts.create === 750 && p.counts.same === 750 && p.counts.update === 0 && p.counts.error === 0
      && p.customers?.create === 750 && p.customers?.update === 0, JSON.stringify({ counts: p.counts, customers: p.customers }));
    ok('S2 …and land: 750 customers, 750 locations (one each), 1,500 contacts', added === 750 && addedSites === 750 && addedContacts === 1500, `${added} / ${addedSites} / ${addedContacts}`);
    ok('S3 every new customer has its number, its supervisor and its primary contact', (after.clients || []).filter((c) => /^0[1-9]\d\d$/.test(c.customerNumber || '') && Number(c.customerNumber) >= 101)
      .every((c) => c.supervisorId && c.primaryContactId));
    ok('S4 the import fits inside what an import may use (90% of the save ceiling)', v.fits === true && v.after <= budget.IMPORT_ALLOWED_BYTES, JSON.stringify({ after: v.after, allowed: v.allowed }));
    ok('S5 planning 1,500 rows stays well under 3 s', t1 - t0 < 3000, `${Math.round(t1 - t0)} ms`);
    ok('S6 applying and measuring the import stays well under 6 s', t2 - t1 < 6000, `${Math.round(t2 - t1)} ms`);
    // The book comes in ACTIVE (fix round): no imported customer reads "Lead" for want of a job,
    // and a week on none of its 1,500 people fill the Dashboard's stale-leads list.
    const known = new Set(state.clients.map((c) => c.id));
    const imported = (after.clients || []).filter((c) => !known.has(c.id));
    const shownAs = imported.map((c) => (typeof sel.selectClientStatus === 'function' ? sel.selectClientStatus(after, c) : null));
    const withJobs = imported.filter((c) => (after.jobs || []).some((j) => j.clientId === c.id)).length;
    ok('S7 every imported customer shows Active with no job on file', imported.length === 750 && withJobs === 0 && shownAs.every((x) => x === 'active'),
      JSON.stringify({ imported: imported.length, withJobs, notActive: shownAs.filter((x) => x !== 'active').length }));
    const knownPeople = new Set(state.contacts.map((c) => c.id));
    const importedPeople = new Set((after.contacts || []).filter((c) => !knownPeople.has(c.id)).map((c) => c.id));
    const staleAfter = (st) => {
      const realNow = Date.now;
      try { Date.now = () => realNow() + 8 * 86400000; return typeof sel.selectStaleLeads === 'function' ? sel.selectStaleLeads(st) : []; } finally { Date.now = realNow; }
    };
    const stale = staleAfter(after).filter((c) => importedPeople.has(c.id));
    ok('S8 eight days after the import, none of the 1,500 imported contacts is a stale lead', importedPeople.size === 1500 && stale.length === 0,
      `${stale.length} of ${importedPeople.size} listed`);
    // The check can see one: a person imported under a LEAD customer is listed a week on.
    const control = tryRun(() => run('Customer #,Customer name,Status,Contact first name,Contact email\n0090,Lead Control Co,Lead,Lou,lou@control.example\n', clone(INITIAL_STATE)));
    ok('S8b …while a person imported under a Lead customer is (the check can see one)',
      staleAfter(control.after || {}).some((c) => c.email === 'lou@control.example'), JSON.stringify((control.after?.contacts || []).find((c) => c.email === 'lou@control.example')));
  } else ok('S0 the sample generator and the engine load', false);
}

// ── G. the screen: its words, its gates, one rule (source contracts) ────────────────────────
{
  const modal = read('../src/components/CsvImportModal.jsx');
  const en = read('../src/i18n/catalog/en.js');
  ok('G1 the modal is "Import customers" (from the catalog), not "Import Contacts (CSV)"', /t\('custImport\.title'\)/.test(modal) && /'custImport\.title': 'Import customers'/.test(en) && !/Import Contacts/.test(modal));
  ok('G2 its file is a customers template, not a contacts sample', /customers-template\.csv/.test(modal) && !/contacts-sample/.test(modal));
  ok('G3 the modal reads the one engine and dispatches through commitImport (one action, size-checked first)', /from '\.\.\/lib\/customerImport'/.test(modal) && /commitImport\(/.test(modal) && !/ACTIONS\.ADD_CLIENT/.test(modal) && !/ACTIONS\.ADD_CONTACT/.test(modal));
  ok('G4 no raw colour in the modal (S33 #5)', !/#[0-9a-fA-F]{3,6}\b/.test(modal));
  ok('G4b the Import button and the totals count customers, not rows (a 750-building file on 1,500 rows is "Import 750 customers")',
    /const toWrite = customers\.create \+ customers\.update/.test(modal) && /plan\?\.customers/.test(modal) && /'custImport\.status\.same'/.test(modal));
  const clients = read('../src/pages/Clients.jsx');
  ok('G5 Customers: the import and Add Customer need "Create / edit customers" (the server’s rule), not contacts.edit alone',
    /canAddCustomers\s*=\s*canEditClients/.test(clients) && /canAddCustomers\s*&&/.test(clients) && !/canCreate\s*=\s*canEditClients\s*\|\|\s*canEditContacts/.test(clients));
  const contactModal = read('../src/components/AddContactModal.jsx');
  ok('G6 Add contact offers a NEW company only to a "Create / edit customers" holder', /usePermission\('clients\.edit'\)/.test(contactModal) && /allowCreate/.test(contactModal));
  const registry = read('../src/lib/masterSearch/registry.js');
  ok('G7 global search’s "Add customer" asks for clients.edit', /slug: 'add-customer'[^\n]*perm: 'clients\.edit'/.test(registry));
  const company = read('../src/components/AddCompanyModal.jsx');
  ok('G8 Add customer is titled for a customer, and its contact half needs contacts.edit', /custAdd\.title|title="Add customer"/.test(company) && /usePermission\('contacts\.edit'\)/.test(company));
  const quick = read('../src/pages/settings/QuickStart.jsx');
  ok('G9 Quick Start describes the customer import (one row per building), not the person upsert', /one row per building/i.test(quick) && !/matches existing people by email/.test(quick));
  const problems = read('../src/store/syncProblems.js');
  ok('G10 a refused import is named in the "not saved" message', /ACTIONS\.IMPORT_CUSTOMERS/.test(problems) && /syncProblem\.change\.import/.test(problems));
  const cov = read('./test-i18n-coverage.mjs');
  ok('G11 the rebuilt modal is a converted screen (UI_RULES §140)', /'src\/components\/CsvImportModal\.jsx'/.test(cov));
  ok('G12 Quick Start says to add the supervisors on Team first, so the Supervisor column finds them', /supervisors?[^'"]{0,80}Team first/i.test(quick), 'no such line in QuickStart.jsx');
  ok('G13 the modal plans with the store’s own status rule (selectClientStatus)', /statusOf:\s*\(c\)\s*=>\s*selectClientStatus\(state, c\)/.test(modal));
  ok('G14 a locate run is ONE store action (one pending entry, one save), never a dispatch per building',
    /type:\s*ACTIONS\.LOCATE_BUILDINGS/.test(modal) && !/ACTIONS\.UPDATE_SITE/.test(modal));
}

console.log(`\ntest-customer-import: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
