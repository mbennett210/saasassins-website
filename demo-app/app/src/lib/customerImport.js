// THE CUSTOMERS IMPORT — one row is one BUILDING. The one engine behind Customers → Import
// customers. Pure and node-safe (the screen, the store and the tests read it).
//
// WHO USES IT. Matt's team enters its own buildings (kickoff 2026-09-10 §H: "Matt's team adds the
// clients, cleaners, and schedules… Only the financial analyst adds/removes customers") — about
// 750 of them. This is their bulk tool. It replaced a PERSON importer built the day before a
// customer became one building with one location (store v53), which could not import a building
// with no person and never set a number, a supervisor or notes (S33's diagnosis, 2026-09-13).
//
// WHAT A ROW IS. One building: a customer (its number and name — "0001 Ball Harbor Village"
// splits through lib/customerNumber, GO-2 / CS-068), its ONE location's structured address (the
// path manual Add customer takes: ADD_CLIENT builds the location from street / city / state /
// zip), its account supervisor (a team member by email or exact name, HUB-12 / QB-8), an
// optional contact (created or matched, linked to the customer) and notes. No billing columns:
// billing stays in QuickBooks (QB-11). A building may take several rows; the first decides the
// customer, and each later row can add another contact.
//
// THE RULES (Daniel / the brief, 2026-10-03):
//   · upsert, never duplicate: an existing customer is matched by its NUMBER first, then by its
//     name (normalized as Add customer does); a matched customer only has its BLANK fields filled
//     — an empty cell never blanks anything, and a value on file is never overwritten;
//   · a number someone else holds, or a malformed one, is a ROW ERROR — never invented, never
//     silently changed; a row with no number creates the customer without one, and says so;
//   · a dry run first: planCustomerImport writes nothing, and says per row create / update /
//     unchanged / same (a later row for a building already named) / error, with every warning,
//     and counts CUSTOMERS apart from rows; the problems go out as a CSV (importProblemsCsv);
//   · ONE store action (IMPORT_CUSTOMERS) for the whole file, measured against the shared
//     record's save ceiling BEFORE it is dispatched (commitImport) — refused in words, never a
//     partial import;
//   · the server's rules, mirrored so nothing is offered that the save would refuse (UI_RULES
//     §118): customers need "Create / edit customers", contacts "Create / edit contacts", and a
//     supervisor is a Super Admin's or an Admin's to assign (orgStateGuard).
import {
  normalizeCustomerNumber, splitNumberedName, customerNumberHolder, customerLabel, isCustomerNumber,
} from './customerNumber.js';
import { normalizeCompanyName, normalizePhone, toCsvText } from './csv.js';
import { composeAddress } from './address.js';
import { clientLocationId } from './location.js';
import { normalizeUsState } from './usStates.js';
import { SUPERVISOR_ROLES } from './roles.js';
import { GEOCODE_STATUS, coordsMatchAddress } from './geocodeLocation.js';
import {
  MAX_STATE_BYTES, IMPORT_ALLOWED_BYTES, SAVE_ENVELOPE_BYTES, utf8Length, formatStateBytes,
} from './stateBudget.js';
import { msg } from '../i18n/core.js';

// ── the fields a column can hold ────────────────────────────────────────────────────────────
// Aliases are written as normalizeHeader() leaves a header: lower case, "#" read as "number",
// punctuation as a space. A spreadsheet's own headers ("Customer #", "Client ID", "Address 1",
// "Zip Code", "Account Manager", "E-mail") map without the office renaming anything.
export const IMPORT_FIELDS = Object.freeze([
  { key: 'number', group: 'customer', labelKey: 'custImport.field.number',
    aliases: ['customer number', 'customer no', 'cust number', 'cust no', 'customer id', 'customer code', 'client id', 'client number', 'client no', 'account number', 'account no', 'acct number', 'acct no', 'number', 'no', 'id', 'qb number', 'quickbooks number'] },
  { key: 'name', group: 'customer', labelKey: 'custImport.field.name',
    aliases: ['customer name', 'customer', 'name', 'building', 'building name', 'property', 'property name', 'account', 'account name', 'company', 'company name', 'client', 'client name', 'site name', 'location name', 'display name', 'customer display name', 'customer full name'] },
  { key: 'type', group: 'customer', labelKey: 'custImport.field.type',
    aliases: ['type', 'customer type', 'kind', 'customer or vendor', 'account type'] },
  { key: 'status', group: 'customer', labelKey: 'custImport.field.status',
    aliases: ['status', 'customer status', 'account status'] },
  { key: 'street', group: 'location', labelKey: 'custImport.field.street',
    aliases: ['street', 'street address', 'address', 'address 1', 'address1', 'address line 1', 'addr', 'service address', 'site address', 'building address', 'location address', 'property address', 'street 1', 'street1', 'line 1'] },
  { key: 'street2', group: 'location', labelKey: 'custImport.field.street2',
    aliases: ['address 2', 'address2', 'address line 2', 'street 2', 'street2', 'suite', 'unit', 'suite unit', 'apt', 'line 2'] },
  { key: 'city', group: 'location', labelKey: 'custImport.field.city', aliases: ['city', 'town', 'city town'] },
  { key: 'state', group: 'location', labelKey: 'custImport.field.state', aliases: ['state', 'st', 'province', 'region', 'state province'] },
  { key: 'zip', group: 'location', labelKey: 'custImport.field.zip',
    aliases: ['zip', 'zip code', 'zipcode', 'postal code', 'postal', 'postcode', 'post code', 'zip postal code'] },
  { key: 'supervisor', group: 'supervisor', labelKey: 'custImport.field.supervisor',
    aliases: ['supervisor', 'account supervisor', 'account manager', 'manager', 'supervisor email', 'manager email', 'ae', 'account executive', 'assigned manager', 'location manager'] },
  { key: 'contactName', group: 'contact', labelKey: 'custImport.field.contactName',
    aliases: ['contact', 'contact name', 'primary contact', 'contact person', 'main contact'] },
  { key: 'contactFirstName', group: 'contact', labelKey: 'custImport.field.contactFirstName',
    aliases: ['contact first name', 'first name', 'first', 'firstname', 'given name'] },
  { key: 'contactLastName', group: 'contact', labelKey: 'custImport.field.contactLastName',
    aliases: ['contact last name', 'last name', 'last', 'lastname', 'surname', 'family name'] },
  { key: 'contactEmail', group: 'contact', labelKey: 'custImport.field.contactEmail',
    aliases: ['contact email', 'email', 'e mail', 'email address', 'contact e mail'] },
  { key: 'contactPhone', group: 'contact', labelKey: 'custImport.field.contactPhone',
    aliases: ['contact phone', 'phone', 'phone number', 'telephone', 'tel', 'mobile', 'cell', 'contact mobile'] },
  { key: 'contactRole', group: 'contact', labelKey: 'custImport.field.contactRole',
    aliases: ['contact role', 'contact title', 'title', 'role', 'job title', 'position'] },
  { key: 'notes', group: 'notes', labelKey: 'custImport.field.notes', aliases: ['notes', 'note', 'comments', 'comment', 'description', 'memo'] },
]);
const FIELD = new Map(IMPORT_FIELDS.map((f) => [f.key, f]));
export const CONTACT_FIELD_KEYS = Object.freeze(IMPORT_FIELDS.filter((f) => f.group === 'contact').map((f) => f.key));

// A header as the aliases are written: "Customer #" → "customer number", "E-mail" → "e mail".
export function normalizeHeader(h) {
  return String(h ?? '').toLowerCase().replace(/#/g, ' number ').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Billing stays in QuickBooks (QB-11): a billing, mailing or tax column is never guessed onto
// the building's address or anything else, and the column step names the ones it skipped.
const BILLING_RE = /\b(bill|billing|billed|invoice|invoicing|terms|tax|taxable|balance|remit|remittance|mailing|ship|shipping|payment|credit)\b/;
export const isBillingHeader = (h) => BILLING_RE.test(normalizeHeader(h));

// Header → field, each field for ONE column (the first that fits). An exact alias first; then a
// header that CONTAINS a multi-word alias ("Customer Name (Building)"). Never a billing column.
export function guessImportMapping(headers) {
  const norm = (headers || []).map(normalizeHeader);
  const out = {};
  const taken = new Set();
  const take = (i, f) => { out[i] = f.key; taken.add(f.key); };
  norm.forEach((h, i) => {
    if (!h || BILLING_RE.test(h)) return;
    const f = IMPORT_FIELDS.find((x) => !taken.has(x.key) && x.aliases.includes(h));
    if (f) take(i, f);
  });
  norm.forEach((h, i) => {
    if (out[i] || !h || BILLING_RE.test(h)) return;
    const f = IMPORT_FIELDS.find((x) => !taken.has(x.key) && x.aliases.some((a) => a.includes(' ') && ` ${h} `.includes(` ${a} `)));
    if (f) take(i, f);
  });
  return out;
}

// ── who may import what (the server's rules, mirrored — UI_RULES §118) ─────────────────────
// orgStateGuard: adding a customer needs clients.edit, adding or changing a contact's details
// needs contacts.edit (the Super Admin by role), a customer's supervisor is the Super Admin's
// or an Admin's alone, and a cleaner's save is a crew merge that drops a new customer whatever
// key it holds — so a cleaner never imports.
const OFFICE = ['owner', 'admin', 'manager'];
export function importPermissions({ role, holds } = {}) {
  const has = (k) => typeof holds === 'function' && !!holds(k);
  const owner = role === 'owner';
  const office = OFFICE.includes(role);
  return {
    canImport: owner || (office && has('clients.edit')),
    canContacts: owner || (office && has('contacts.edit')),
    canAssignSupervisor: role === 'owner' || role === 'admin',
  };
}

// ── small rules ─────────────────────────────────────────────────────────────────────────────
const blankValue = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
// The fields of `patch` that `current` has blank, and only those: a value on file is never
// overwritten. The plan predicts with this; importStepAction re-checks with it when the import
// lands, so a value set between the preview and the save is still never overwritten.
export function blankFill(current, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (blankValue(v)) continue;
    if (blankValue(current?.[k])) out[k] = v;
  }
  return out;
}

// A building's STATUS, as a spreadsheet may write it (case, spaces and dashes forgiven). It
// becomes the customer's `statusOverride`: the manual status the customer page's status menu
// writes, which selectClientStatus shows ahead of the derived one (Active on the first job).
// An imported book is EXISTING business, so a customer comes in Active unless the file says
// otherwise; left to the derived status, all of it read "Lead" until a job existed. A word this
// list does not know reads as Active, with a note on the row.
const STATUS_WORDS = new Map([
  ['active', 'active'], ['current', 'active'], ['customer', 'active'], ['client', 'active'],
  ['lead', 'lead'], ['prospect', 'lead'],
  ['inactive', 'inactive'], ['former', 'inactive'], ['cancelled', 'inactive'], ['canceled', 'inactive'],
  ['lost', 'inactive'], ['closed', 'inactive'],
]);
export const IMPORT_STATUSES = Object.freeze(['active', 'lead', 'inactive']);
// readImportStatus(cell) → { status: 'active' | 'lead' | 'inactive' | null, unknown }
// (null = an empty cell: the file says nothing).
export function readImportStatus(raw) {
  const word = String(raw ?? '').toLowerCase().replace(/[^a-z]+/g, '');
  if (!word) return { status: null, unknown: false };
  const status = STATUS_WORDS.get(word);
  return status ? { status, unknown: false } : { status: 'active', unknown: true };
}
// The status's name on screen (literal keys, so the catalog checks can find them).
const STATUS_NAME = { active: 'custImport.statusName.active', lead: 'custImport.statusName.lead', inactive: 'custImport.statusName.inactive' };
const statusName = (status) => (STATUS_NAME[status] ? msg(STATUS_NAME[status]) : status);
// A NEW contact's lifecycle follows its customer (a matched contact's is never touched): a
// client of an Active or Inactive customer, a lead of a Lead one, a vendor's person a vendor.
// Every new person used to be a 'lead' (ADD_CONTACT's default), so a week after an import of
// the book its ~1,500 property managers filled the Dashboard's stale-leads list.
const lifecycleFor = (status) => (status === 'vendor' ? 'vendor' : status === 'lead' ? 'lead' : 'client');
// What the store shows for a customer when the caller did not pass its rule (the screen passes
// selectClientStatus): the manual status, else Lead.
const fallbackStatusOf = (c) => (IMPORT_STATUSES.includes(c?.statusOverride) ? c.statusOverride : 'lead');
const lower = (s) => String(s ?? '').trim().toLowerCase();
const squash = (s) => lower(s).replace(/\s+/g, ' ');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fullName = (c) => [c?.firstName, c?.lastName].filter((x) => x && String(x).trim()).join(' ').trim();
const nameKeyOf = (name) => normalizeCompanyName(splitNumberedName(name).name);
const addressKey = (a) => lower(a).replace(/[^a-z0-9]+/g, ' ').trim();

// A spreadsheet's ZIP. Excel stores 02139 as the NUMBER 2139, so a 3- or 4-digit ZIP had its
// leading zeros dropped: it is padded back, and the row says so.
function readZip(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { zip: '' };
  if (/^\d{5}(-\d{4})?$/.test(s)) return { zip: s };
  if (/^\d{9}$/.test(s)) return { zip: `${s.slice(0, 5)}-${s.slice(5)}` };
  const short = /^(\d{3,4})(-\d{4})?$/.exec(s);
  if (short) return { zip: `${short[1].padStart(5, '0')}${short[2] || ''}`, padded: true };
  return { zip: s, odd: true };
}

// The supervisor column → a team member, by email or EXACT name (case and spacing forgiven,
// nothing else): never a guess. Eligible = an active Super Admin, Admin or Manager — the same
// trio Service setup offers (SUPERVISOR_ROLES).
function matchSupervisor(raw, users) {
  const v = String(raw ?? '').trim();
  const list = (users || []).filter((u) => u && u.id);
  const hits = v.includes('@')
    ? list.filter((u) => lower(u.email) === lower(v))
    : list.filter((u) => squash(u.name) === squash(v));
  if (!hits.length) return { problem: 'notFound' };
  if (hits.length > 1) return { problem: 'ambiguous' };
  const u = hits[0];
  if (!SUPERVISOR_ROLES.includes(u.role) || (u.status && u.status !== 'active')) return { problem: 'notEligible', user: u };
  return { user: u };
}

// ── the plan: a dry run, per row ────────────────────────────────────────────────────────────
// planCustomerImport({ rows, mapping, state, perms, tagIds }) → {
//   rows:   [{ line, status, number, name, label, address, changes, warnings, errors, values, ops }]
//           line = the spreadsheet's row number (the header is row 1); status = 'create' |
//           'update' | 'unchanged' | 'same' (a later row for a building an earlier row named:
//           it can only add a contact or a note) | 'error'; changes / warnings / errors are
//           messages (msg());
//   counts:    ROWS by status: { create, update, unchanged, same, error, warning } (warning = rows
//              carrying one) — the row filters;
//   customers: CUSTOMERS: { create, update, unchanged } — what the file does to the book (a
//              customer on file counts as updated when any of its rows adds something); the
//              totals and the Import button say these, so 1,500 rows for 750 buildings import
//              750 customers;
//   contacts:  { create, update }
// }
// `mapping` is { columnIndex: fieldKey } (guessImportMapping, then the person's own choices).
// `statusOf(client)` is the store's status rule for a customer on file (the screen passes
// selectClientStatus): a new person's lifecycle follows the status its customer will show.
// It writes NOTHING. The ops on each row are what buildImportOps turns into the store action.
export function planCustomerImport({ rows = [], mapping = {}, state = {}, perms = {}, tagIds = [], statusOf = fallbackStatusOf } = {}) {
  const clients = Array.isArray(state.clients) ? state.clients : [];
  const siteByClient = new Map();
  for (const s of Array.isArray(state.sites) ? state.sites : []) if (s && s.clientId && !siteByClient.has(s.clientId)) siteByClient.set(s.clientId, s);
  const contacts = Array.isArray(state.contacts) ? state.contacts : [];
  const users = Array.isArray(state.users) ? state.users : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const byName = new Map();
  for (const c of clients) {
    const k = nameKeyOf(c.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  const contactByEmail = new Map();
  for (const c of contacts) { const e = lower(c?.email); if (e && !contactByEmail.has(e)) contactByEmail.set(e, c); }
  const notesOn = new Set((Array.isArray(state.clientActivities) ? state.clientActivities : [])
    .filter((a) => a && a.kind === 'note').map((a) => `${a.clientId}\u0000${String(a.body ?? '').trim()}`));
  const tags = [...new Set((tagIds || []).filter(Boolean))];

  const col = {};
  for (const [idx, key] of Object.entries(mapping || {})) if (key && FIELD.has(key) && col[key] === undefined) col[key] = Number(idx);
  const contactCols = CONTACT_FIELD_KEYS.some((k) => col[k] !== undefined);

  // This file's customers so far, by number and by name: a later row for the same building
  // joins the earlier one, and two rows can never make two customers of one building.
  const plannedByNumber = new Map();
  const plannedByName = new Map();
  // Contacts this file adds, by email: two rows never make two people of one email.
  const plannedEmails = new Map();
  const counts = { create: 0, update: 0, unchanged: 0, same: 0, error: 0, warning: 0 };
  const contactCounts = { create: 0, update: 0 };
  // Every customer the file names, once (new or on file): the customer counts.
  const customerPlans = [];
  const out = [];

  rows.forEach((values, i) => {
    const val = (key) => (col[key] === undefined ? '' : String(values?.[col[key]] ?? '').trim());
    const r = { line: i + 2, status: null, number: null, name: '', label: '', address: '', changes: [], warnings: [], errors: [], values: values || [], ops: [] };
    const finish = () => {
      if (r.errors.length) { r.status = 'error'; r.ops = []; }
      counts[r.status] += 1;
      if (r.warnings.length) counts.warning += 1;
      out.push(r);
    };
    if (!perms.canImport) { r.errors.push(msg('custImport.err.notPermitted')); finish(); return; }

    // ── the number and the name ──────────────────────────────────────────────────────────
    const rawNumber = val('number');
    const rawName = val('name');
    const split = splitNumberedName(rawName);
    let number = null;
    if (rawNumber) {
      const n = normalizeCustomerNumber(rawNumber);
      if (n === undefined) r.errors.push(msg('custImport.err.numberInvalid', { value: rawNumber }));
      else number = n;
    }
    if (split.number) {
      if (number && split.number !== number) r.errors.push(msg('custImport.err.numberConflict', { number, other: split.number }));
      else number = number || split.number;
    }
    const name = String(split.name ?? '').trim();
    r.name = name;
    r.number = number;
    r.label = customerLabel({ name, customerNumber: number });
    if (!name) r.errors.push(msg('custImport.err.noName'));

    // ── the address (read even on a row that is not imported: the preview and the problems
    //    file show where the building is, and everything to fix in the row at once) ──────────
    const street2 = val('street2');
    const street = [val('street'), street2].filter(Boolean).join(', ');
    const city = val('city');
    const stateRaw = val('state');
    let st = '';
    if (stateRaw) {
      st = normalizeUsState(stateRaw) || '';
      if (!st) r.warnings.push(msg('custImport.warn.stateUnknown', { value: stateRaw }));
    }
    const zipRead = readZip(val('zip'));
    if (zipRead.padded) r.warnings.push(msg('custImport.warn.zipPadded', { value: val('zip'), zip: zipRead.zip }));
    if (zipRead.odd) r.warnings.push(msg('custImport.warn.zipOdd', { value: val('zip') }));
    const addr = { street, city, state: st, zip: zipRead.zip };
    const hasAddress = !!(street || city || zipRead.zip);
    r.address = composeAddress(addr);
    if (r.errors.length) { finish(); return; }
    const nameKey = nameKeyOf(name);
    const typeRaw = lower(val('type'));
    const isVendor = typeRaw === 'vendor' || typeRaw === 'supplier';
    const statusRaw = val('status');
    const statusRead = readImportStatus(statusRaw);

    // ── which customer: this file's earlier rows, then the book ──────────────────────────
    let target = null; // { kind: 'planned', p } | { kind: 'existing', c }
    if (number && plannedByNumber.has(number)) {
      const p = plannedByNumber.get(number);
      if (p.nameKey !== nameKey) r.errors.push(msg('custImport.err.duplicateNumber', { row: p.line, number, customer: p.name }));
      else target = { kind: 'planned', p };
    } else if (plannedByName.has(nameKey)) {
      const p = plannedByName.get(nameKey);
      if (number && p.number && p.number !== number) r.errors.push(msg('custImport.err.numberMismatch', { customer: p.label, current: p.number, number }));
      else target = { kind: 'planned', p };
    }
    if (!target && !r.errors.length) {
      const holder = number ? customerNumberHolder(clients, number) : null;
      if (holder) {
        // The same words (and the holder's name) Add customer uses for a taken number.
        if (nameKeyOf(holder.name) !== nameKey) r.errors.push(msg('custNumber.taken', { number, customer: holder.name || number }));
        else target = { kind: 'existing', c: holder };
      } else {
        const named = byName.get(nameKey) || [];
        if (named.length > 1) r.errors.push(msg('custImport.err.ambiguousName', { customer: name }));
        else if (named.length === 1) {
          const c = named[0];
          if (number && isCustomerNumber(c.customerNumber) && c.customerNumber !== number) {
            r.errors.push(msg('custImport.err.numberMismatch', { customer: customerLabel(c), current: c.customerNumber, number }));
          } else target = { kind: 'existing', c };
        }
      }
    }
    if (r.errors.length) { finish(); return; }

    // ── the supervisor (decided once per customer) ───────────────────────────────────────
    const supRaw = val('supervisor');
    let supervisor = null;
    if (supRaw) {
      if (!perms.canAssignSupervisor) r.warnings.push(msg('custImport.warn.supervisorNotAllowed'));
      else {
        const m = matchSupervisor(supRaw, users);
        if (m.problem === 'notFound') r.warnings.push(msg('custImport.warn.supervisorNotFound', { value: supRaw }));
        else if (m.problem === 'ambiguous') r.warnings.push(msg('custImport.warn.supervisorAmbiguous', { value: supRaw }));
        else if (m.problem === 'notEligible') r.warnings.push(msg('custImport.warn.supervisorNotEligible', { name: m.user.name || supRaw }));
        else supervisor = m.user;
      }
    }

    // The customer this row lands on: { clientId } for one on file, { clientRef } for one this
    // file creates (buildImportOps mints its id).
    let on;
    let p;
    if (!target) {
      // ── a NEW customer (and, unless a vendor, its one location) ──────────────────────────
      // Its status: what the file says, else Active (an imported book is existing business). A
      // vendor takes none: its Vendor badge is what the customer page shows.
      const status = isVendor ? 'vendor' : (statusRead.status || 'active');
      p = { ref: `new:${r.line}`, line: r.line, name, label: r.label, nameKey, number: isVendor ? null : number, isNew: true, isVendor, supervisorId: supervisor ? supervisor.id : null, address: hasAddress && !isVendor ? r.address : '', notes: new Set(), status, fileStatus: statusRead.status };
      on = { clientRef: p.ref };
      const client = { name, type: isVendor ? 'vendor' : 'customer' };
      if (!isVendor) {
        if (number) client.customerNumber = number;
        Object.assign(client, addr);
        if (supervisor) client.supervisorId = supervisor.id;
        client.statusOverride = status;
      }
      if (tags.length) client.tagIds = tags;
      customerPlans.push(p);
      r.ops.push({ op: 'addClient', ref: p.ref, client });
      r.changes.push(msg(isVendor ? 'custImport.chg.newVendor' : 'custImport.chg.newCustomer'));
      if (!isVendor) {
        r.changes.push(msg('custImport.chg.status', { status: statusName(status) }));
        if (statusRead.unknown) r.warnings.push(msg('custImport.warn.statusUnknown', { value: statusRaw }));
      }
      if (isVendor && number) r.warnings.push(msg('custImport.warn.vendorNumber'));
      if (isVendor && hasAddress) r.warnings.push(msg('custImport.warn.vendorAddress'));
      if (!isVendor && !number) r.warnings.push(msg('custImport.warn.noNumber'));
      if (!isVendor && !hasAddress) r.warnings.push(msg('custImport.warn.noAddress'));
      if (supervisor && !isVendor) r.changes.push(msg('custImport.chg.supervisor', { name: supervisor.name }));
      r.status = 'create';
    } else if (target.kind === 'existing') {
      // ── a customer on file: fill its blanks, never overwrite ─────────────────────────────
      const c = target.c;
      const cVendor = c.type === 'vendor';
      p = { ref: null, clientId: c.id, line: r.line, name: c.name, label: customerLabel(c), nameKey: nameKeyOf(c.name), number: isCustomerNumber(c.customerNumber) ? c.customerNumber : number, isNew: false, isVendor: cVendor, supervisorId: c.supervisorId || (supervisor ? supervisor.id : null), address: '', notes: new Set(), wrote: false, status: null, fileStatus: statusRead.status };
      customerPlans.push(p);
      on = { clientId: c.id };
      r.changes.push(msg(isCustomerNumber(c.customerNumber) && number ? 'custImport.chg.matchedNumber' : 'custImport.chg.matchedName'));
      if (typeRaw && isVendor !== cVendor) r.warnings.push(msg('custImport.warn.typeKept'));
      const fill = {};
      if (!cVendor && number && !isCustomerNumber(c.customerNumber)) {
        fill.customerNumber = number;
        r.changes.push(msg('custImport.chg.fillNumber', { number }));
      }
      if (supervisor && !cVendor) {
        if (!c.supervisorId) { fill.supervisorId = supervisor.id; r.changes.push(msg('custImport.chg.supervisor', { name: supervisor.name })); }
        else if (c.supervisorId !== supervisor.id) {
          const held = users.find((u) => u && u.id === c.supervisorId);
          r.warnings.push(msg('custImport.warn.supervisorKept', { name: held?.name || supRaw }));
        }
      }
      // Its status: the file's fills a customer that has none set; one on file is never
      // overwritten (the customer page's status menu owns it). No Status cell: nothing changes.
      p.status = cVendor ? 'vendor' : null;
      if (!cVendor && statusRead.status) {
        if (statusRead.unknown) r.warnings.push(msg('custImport.warn.statusUnknown', { value: statusRaw }));
        if (blankValue(c.statusOverride)) {
          fill.statusOverride = statusRead.status;
          r.changes.push(msg('custImport.chg.status', { status: statusName(statusRead.status) }));
          p.status = statusRead.status;
        } else if (c.statusOverride !== statusRead.status) {
          r.warnings.push(msg('custImport.warn.statusKept', { status: statusName(c.statusOverride) }));
        }
      }
      // What the customer page will show for it (a new person's lifecycle follows that).
      if (!p.status) p.status = statusOf(c) || fallbackStatusOf(c);
      if (Object.keys(fill).length) r.ops.push({ op: 'fillClient', id: c.id, patch: fill });
      const site = siteByClient.get(c.id);
      if (hasAddress) {
        if (cVendor) r.warnings.push(msg('custImport.warn.vendorAddress'));
        else if (!site) r.warnings.push(msg('custImport.warn.noLocation'));
        else if (!String(site.street ?? '').trim() && !String(site.address ?? '').trim()) {
          r.ops.push({ op: 'fillSite', id: site.id, clientId: c.id, patch: addr });
          r.changes.push(msg('custImport.chg.fillAddress', { address: r.address }));
          p.address = r.address;
        } else if (addressKey(site.address || composeAddress(site)) !== addressKey(r.address)) {
          r.warnings.push(msg('custImport.warn.addressKept', { address: site.address || composeAddress(site) }));
        }
      }
      for (const t of tags) if (!(c.tagIds || []).includes(t)) r.ops.push({ op: 'tagClient', id: c.id, tagId: t });
      if (tags.some((t) => !(c.tagIds || []).includes(t))) r.changes.push(msg('custImport.chg.tags'));
    } else {
      // ── a building this file already named: one customer, this row adds its contact ──────
      p = target.p;
      on = p.isNew ? { clientRef: p.ref } : { clientId: p.clientId };
      r.status = 'same';
      r.changes.push(msg('custImport.chg.sameAs', { row: p.line }));
      const differs = (supervisor && p.supervisorId !== supervisor.id) || (hasAddress && p.address && addressKey(p.address) !== addressKey(r.address))
        || (!p.isVendor && statusRead.status && statusRead.status !== p.fileStatus);
      if (differs) r.warnings.push(msg('custImport.warn.repeatKept', { row: p.line }));
    }

    // ── notes → the customer's Notes tab (once per text, per customer) ────────────────────
    const note = val('notes');
    if (note) {
      const known = p.clientId && notesOn.has(`${p.clientId}\u0000${note}`);
      if (!known && !p.notes.has(note)) {
        p.notes.add(note);
        r.ops.push({ op: 'addNote', ...on, body: note });
        r.changes.push(msg('custImport.chg.note'));
      }
    }

    // ── the contact ──────────────────────────────────────────────────────────────────────
    if (contactCols) {
      let first = val('contactFirstName');
      let last = val('contactLastName');
      const full = val('contactName');
      const emailRaw = val('contactEmail');
      const email = lower(emailRaw);
      const phone = val('contactPhone');
      const role = val('contactRole');
      if (!first && !last && full) {
        const parts = full.split(/\s+/);
        first = parts.shift() || '';
        last = parts.join(' ');
      }
      const any = first || last || email || phone || role;
      if (any) {
        const who = [first, last].filter(Boolean).join(' ') || email || phone;
        if (!perms.canContacts) r.warnings.push(msg('custImport.warn.contactNotAllowed'));
        else {
          if (email && !EMAIL_RE.test(email)) r.warnings.push(msg('custImport.warn.contactEmailInvalid', { value: emailRaw }));
          else if (!first && !last && !email && !phone) r.warnings.push(msg('custImport.warn.contactEmpty'));
          else {
            const customerKey = p.isNew ? p.ref : p.clientId;
            let match = null;
            let blocked = false;
            if (email) {
              const earlier = plannedEmails.get(email);
              const onFile = contactByEmail.get(email);
              if (earlier) {
                if (earlier.customerKey !== customerKey) {
                  r.warnings.push(msg('custImport.warn.contactElsewhere', { email, name: earlier.name, customer: earlier.customer }));
                }
                blocked = true; // the same person twice in one file: the first row added them
              } else if (onFile) {
                if (onFile.companyId && onFile.companyId !== p.clientId) {
                  const holder = clientById.get(onFile.companyId);
                  r.warnings.push(msg('custImport.warn.contactElsewhere', { email, name: fullName(onFile) || email, customer: holder ? customerLabel(holder) : '' }));
                  blocked = true;
                } else match = onFile;
              }
            }
            if (!match && !blocked && p.clientId) {
              // No email to go by: the same person on this customer by name, else by phone.
              const mine = contacts.filter((x) => x && x.companyId === p.clientId);
              const nm = squash([first, last].filter(Boolean).join(' '));
              const byPerson = nm ? mine.filter((x) => squash(fullName(x)) === nm) : [];
              const ph = normalizePhone(phone);
              const byPhone = !byPerson.length && ph ? mine.filter((x) => normalizePhone(x.phone) === ph) : [];
              const hit = byPerson.length === 1 ? byPerson[0] : (byPhone.length === 1 ? byPhone[0] : null);
              if (hit) match = hit;
            }
            if (!blocked && match) {
              const want = { firstName: first, lastName: last, phone, title: role };
              if (email && !contactByEmail.has(email)) want.email = email;
              // A person on file with no company joins this customer. A NEW customer's id is
              // minted with the store action, so the op carries the link (buildImportOps).
              const link = !match.companyId;
              if (link && p.clientId) want.companyId = p.clientId;
              const patch = blankFill(match, want);
              if (Object.keys(patch).length || link) {
                r.ops.push({ op: 'fillContact', id: match.id, ...on, ...(link ? { link: true } : {}), patch });
                r.changes.push(msg('custImport.chg.contactFill', { name: fullName(match) || who }));
                contactCounts.update += 1;
              }
            } else if (!blocked) {
              // A NEW person's lifecycle follows the status the customer will show.
              const contact = { firstName: first, lastName: last, email, phone, title: role, lifecycle: lifecycleFor(p.isVendor ? 'vendor' : p.status) };
              r.ops.push({ op: 'addContact', ...(p.isNew ? { clientRef: p.ref } : { clientId: p.clientId }), contact });
              r.changes.push(msg('custImport.chg.contactNew', { name: who }));
              contactCounts.create += 1;
              if (email) plannedEmails.set(email, { customerKey, name: who, customer: p.label });
            }
          }
        }
      }
    }

    if (!r.status) r.status = r.ops.length ? 'update' : 'unchanged';
    if (r.ops.length) p.wrote = true;
    if (!target) {
      if (number) plannedByNumber.set(number, p);
      plannedByName.set(nameKey, p);
    } else if (target.kind === 'existing') {
      if (p.number) plannedByNumber.set(p.number, p);
      if (number && number !== p.number) plannedByNumber.set(number, p);
      plannedByName.set(p.nameKey, p);
      if (p.nameKey !== nameKey) plannedByName.set(nameKey, p);
    }
    finish();
  });

  const customers = { create: 0, update: 0, unchanged: 0 };
  for (const p of customerPlans) customers[p.isNew ? 'create' : (p.wrote ? 'update' : 'unchanged')] += 1;
  return { rows: out, counts, customers, contacts: contactCounts };
}

// ── the store action ────────────────────────────────────────────────────────────────────────
// The plan's ops with ids minted by the CALLER (II.7: caller-minted ids + the store's dedupe, so
// a replayed save adds nothing twice). Rows in error carry no ops.
export function buildImportOps(plan, { newId }) {
  const minted = new Map();
  const clientIdFor = (ref) => {
    if (!minted.has(ref)) minted.set(ref, newId('cl'));
    return minted.get(ref);
  };
  const ops = [];
  for (const r of plan?.rows || []) {
    if (r.status === 'error') continue;
    for (const op of r.ops || []) {
      if (op.op === 'addClient') ops.push({ op: 'addClient', client: { ...op.client, id: clientIdFor(op.ref) } });
      else if (op.op === 'addContact') {
        const companyId = op.clientId || clientIdFor(op.clientRef);
        ops.push({ op: 'addContact', contact: { ...op.contact, id: newId('ct'), companyId } });
      } else if (op.op === 'addNote') {
        const clientId = op.clientId || clientIdFor(op.clientRef);
        ops.push({ op: 'addNote', activity: { id: newId('clact'), clientId, kind: 'note', body: op.body } });
      } else if (op.op === 'fillContact') {
        const clientId = op.clientId || (op.clientRef ? clientIdFor(op.clientRef) : null);
        const patch = op.link && clientId ? { ...op.patch, companyId: clientId } : { ...op.patch };
        ops.push({ op: 'fillContact', id: op.id, clientId, patch });
      } else ops.push({ ...op });
    }
  }
  return ops;
}

// One op → the per-record store action that applies it, or null when it must not apply. The
// store's IMPORT_CUSTOMERS case runs each through its own switch, so the per-record cases stay
// the ONE rule for each record: ADD_CLIENT resolves the customer number and builds the location,
// ADD_CONTACT keeps an email to one person and makes the first person the primary contact. An add
// is skipped when its (caller-minted) id is already there, and a fill re-checks that the field is
// STILL blank (blankFill, the rule the preview predicted with) — so a replayed save adds nothing
// twice, and a value someone set after the preview is never overwritten. It lives beside
// buildImportOps, which writes the ops; `A` is the store's ACTIONS, passed in because the reducer
// imports this module.
export function importStepAction(s, op, A) {
  const has = (list, id) => !!id && (list || []).some((x) => x && x.id === id);
  const find = (list, id) => (list || []).find((x) => x && x.id === id) || null;
  switch (op?.op) {
    case 'addClient':
      return op.client?.id && !has(s.clients, op.client.id) ? { type: A.ADD_CLIENT, client: op.client } : null;
    case 'fillClient': {
      const cur = find(s.clients, op.id);
      const patch = cur ? blankFill(cur, op.patch) : {};
      return Object.keys(patch).length ? { type: A.UPDATE_CLIENT, id: op.id, patch } : null;
    }
    case 'fillSite': {
      const cur = find(s.sites, op.id);
      // A location that has gained an address since the preview keeps it.
      if (!cur || String(cur.address || '').trim()) return null;
      const patch = blankFill(cur, op.patch);
      if (!Object.keys(patch).length) return null;
      return { type: A.UPDATE_SITE, id: op.id, patch: { ...patch, address: composeAddress({ ...cur, ...patch }) } };
    }
    case 'addContact':
      return op.contact?.id && !has(s.contacts, op.contact.id) && has(s.clients, op.contact.companyId)
        ? { type: A.ADD_CONTACT, contact: op.contact } : null;
    case 'fillContact': {
      const cur = find(s.contacts, op.id);
      const patch = cur ? blankFill(cur, op.patch) : {};
      return Object.keys(patch).length ? { type: A.UPDATE_CONTACT, id: op.id, patch } : null;
    }
    case 'addNote':
      return op.activity?.id && !has(s.clientActivities, op.activity.id) && has(s.clients, op.activity.clientId)
        ? { type: A.ADD_CLIENT_ACTIVITY, activity: op.activity } : null;
    case 'tagClient':
      return op.tagId && has(s.clients, op.id) ? { type: A.TAG_CLIENT, id: op.id, tagId: op.tagId } : null;
    default:
      return null;
  }
}

// The customers an import touches (for the "not saved" message, CS-008).
export function importCustomerCount(ops) {
  const ids = new Set();
  for (const op of ops || []) {
    const id = op?.client?.id || op?.contact?.companyId || op?.activity?.clientId || op?.clientId || (op?.op === 'fillClient' || op?.op === 'tagClient' ? op.id : null);
    if (id) ids.add(id);
  }
  return ids.size;
}

// ── locating the buildings ──────────────────────────────────────────────────────────────────
// The locations an import gave an address to, as they stand after it landed (`state`), for the
// bounded geocoder (lib/geocodeLocation resolveGeocodeMany). Vendors have none.
export function importedLocations(ops, state) {
  const sites = new Map((state?.sites || []).map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  for (const op of ops || []) {
    let id = null;
    if (op?.op === 'addClient' && op.client?.type !== 'vendor') id = clientLocationId(op.client.id);
    else if (op?.op === 'fillSite') id = op.id;
    if (!id || seen.has(id)) continue;
    const site = sites.get(id);
    const address = String(site?.address || '').trim();
    if (!site || !address || coordsMatchAddress(site, address)) continue;
    seen.add(id);
    out.push({ id, address, previous: site });
  }
  return out;
}

// Every building still waiting to be located — an address, no coordinates for it, and not one
// the geocoder already could not find (that needs the address fixed by hand first: the Access
// tab's "Locate address"). Feeds "Locate the next 100".
export function locatableLocations(state) {
  const clients = new Map((state?.clients || []).map((c) => [c.id, c]));
  const out = [];
  for (const s of state?.sites || []) {
    const c = clients.get(s?.clientId);
    if (!c || c.type === 'vendor') continue;
    const address = String(s.address || composeAddress(s) || '').trim();
    if (!address || coordsMatchAddress(s, address) || s.geocodeStatus === GEOCODE_STATUS.NOT_LOCATED) continue;
    out.push({ id: s.id, address, previous: s });
  }
  return out;
}

// A locate run's answers, each with the address it was looked up for: the payload of the ONE
// store action a run dispatches (LOCATE_BUILDINGS). One action, not one per building: a save the
// server refuses is replayed one action at a time to find the refused change (CS-008), and each
// replayed action that changes the shared record is a save of all of it — a run of 100 dispatched
// building by building became 100 saves of about 1.45 MB at 750 buildings.
// `items` are what was looked up ([{ id, address }]); `patches` what resolveGeocodeMany answered.
export function locateResults(items, patches) {
  const asked = new Map((items || []).map((it) => [it?.id, String(it?.address || '').trim()]));
  return (patches || []).filter((p) => p && asked.has(p.id)).map((p) => ({ id: p.id, address: asked.get(p.id), patch: p.patch }));
}
// One answer → the per-record store action that applies it, or null. An answer is for the
// address it was looked up for: if the building's address changed while the run was out (or
// the building is gone), the answer is dropped — coordinates for the old address must never
// land on the new one (CS-041). `A` is the store's ACTIONS, passed in because the reducer
// imports this module.
export function locateStepAction(s, result, A) {
  const site = (s?.sites || []).find((x) => x && x.id === result?.id);
  if (!site || !result?.patch) return null;
  const now = String(site.address || composeAddress(site) || '').trim();
  if (!now || now !== String(result.address || '').trim()) return null;
  return { type: A.UPDATE_SITE, id: site.id, patch: result.patch };
}

// ── the shared record's size, measured BEFORE anything is written ──────────────────────────
// The bytes the geocoder will add to one location once it answers (worst case: every field set).
function geocodeGrowthBytes(address) {
  const set = { lat: -180.123456, lng: -180.123456, geocodedAddress: address, geocodeStatus: GEOCODE_STATUS.NOT_LOCATED, geocodeCheckedAt: '2026-10-03T00:00:00.000Z' };
  const unset = { lat: null, lng: null, geocodedAddress: null, geocodeStatus: null, geocodeCheckedAt: null };
  return utf8Length(JSON.stringify(set)) - utf8Length(JSON.stringify(unset));
}

// The save the import would make, measured the way the server measures it: the whole shared
// record after the import (`applyOps` = the store's reducer; `serialize` = the sync engine's
// serializeSharedBlob), plus the save's envelope, plus what locating its buildings will add.
export function importSizeVerdict({ state, ops, applyOps, serialize }) {
  const after = applyOps(state, ops);
  const before = utf8Length(serialize(state)) + SAVE_ENVELOPE_BYTES;
  const located = importedLocations(ops, after).reduce((n, l) => n + geocodeGrowthBytes(l.address), 0);
  const total = utf8Length(serialize(after)) + SAVE_ENVELOPE_BYTES + located;
  const buildings = (ops || []).filter((o) => o?.op === 'addClient').length;
  return {
    before,
    after: total,
    limit: MAX_STATE_BYTES,
    allowed: IMPORT_ALLOWED_BYTES,
    fits: total <= IMPORT_ALLOWED_BYTES,
    buildings,
    perBuilding: buildings ? Math.round((total - before) / buildings) : null,
    // The record as the import leaves it — what the screen then hands the geocoder.
    stateAfter: after,
  };
}

// The import, ready to send: its ops and the size verdict, or the words that refuse it.
export function prepareImport({ state, plan, newId, applyOps, serialize }) {
  const ops = buildImportOps(plan, { newId });
  if (!ops.length) return { ops, verdict: null, refusal: msg('custImport.nothingToDo') };
  const verdict = importSizeVerdict({ state, ops, applyOps, serialize });
  const refusal = verdict.fits ? null : msg('custImport.tooLarge', {
    after: formatStateBytes(verdict.after), allowed: formatStateBytes(verdict.allowed), limit: formatStateBytes(verdict.limit),
  });
  return { ops, verdict, refusal };
}

// The ONLY way the import writes: measured first, then ONE action — or refused, with nothing
// dispatched at all. Never a partial import.
export function commitImport({ state, plan, newId, applyOps, serialize, dispatch, actionType }) {
  const prepared = prepareImport({ state, plan, newId, applyOps, serialize });
  if (prepared.refusal) return prepared;
  dispatch({ type: actionType, ops: prepared.ops });
  return prepared;
}

// ── files ───────────────────────────────────────────────────────────────────────────────────
// The template: the columns this import reads, with example rows to replace (".example"
// addresses, fictional buildings). Its headers are the field aliases, so it maps back exactly.
export const TEMPLATE_HEADERS = Object.freeze([
  'Customer #', 'Customer name', 'Type', 'Status', 'Street', 'City', 'State', 'ZIP', 'Supervisor',
  'Contact first name', 'Contact last name', 'Contact email', 'Contact phone', 'Contact role', 'Notes',
]);
const TEMPLATE_ROWS = [
  ['0101', 'Harbor View Towers', 'Customer', 'Active', '1200 N Ocean Blvd', 'Pompano Beach', 'FL', '33062', '', 'Pat', 'Ramirez', 'pat@harborview.example', '(305) 555-0142', 'Property manager', 'Lobby, gym and pool deck nightly'],
  ['0102', 'Seagrape Office Park', 'Customer', 'Active', '8000 W Commercial Blvd', 'Tamarac', 'FL', '33351', '', 'Morgan', 'Choi', 'morgan@seagrapeoffice.example', '', 'Facilities director', ''],
  ['', 'Coastal Paper & Supply', 'Vendor', '', '', '', '', '', '', 'Alex', 'Rivera', 'alex@coastalpaper.example', '(305) 555-0199', 'Account rep', 'Cleaning-supplies vendor'],
];
export function customerTemplateCsv() {
  return toCsvText([[...TEMPLATE_HEADERS], ...TEMPLATE_ROWS]);
}

// The problems file: every row that was not imported, or was imported with something left out,
// with its own columns as the file had them — fix it and import this file again — plus the row
// number, the result and the reason. `render` turns a message into the reader's words.
export function importProblemsCsv({ plan, headers, render }) {
  const say = (m) => (typeof render === 'function' ? render(m) : '');
  const out = [[say(msg('custImport.csv.row')), ...(headers || []), say(msg('custImport.csv.result')), say(msg('custImport.csv.problem'))]];
  for (const r of plan?.rows || []) {
    if (!r.errors.length && !r.warnings.length) continue;
    const result = r.errors.length ? msg('custImport.csv.notImported') : msg('custImport.csv.withNote');
    out.push([String(r.line), ...(headers || []).map((_, i) => r.values?.[i] ?? ''), say(result), [...r.errors, ...r.warnings].map(say).join(' ')]);
  }
  return toCsvText(out);
}
