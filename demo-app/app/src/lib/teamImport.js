// THE TEAM IMPORT — one row is one TEAM MEMBER. The one engine behind Settings → Team → Import
// team (task #466 from Clean Corner's queue, the 2026-11-03 call: "we do need their first last
// name, also their employee ID … it would be great if we can put their pay rate"). Pure and
// node-safe (the screen, the store and the tests read it).
//
// WHO USES IT. Matt's team enters its own people (kickoff 2026-09-10 §H), hundreds of them at go
// live. This is their bulk tool, beside Invite Member (AddUserModal), which adds one at a time.
//
// WHAT A ROW IS. A person: their name (one column, or first + last), employee ID, email (their
// sign-in), phone, role (blank = Crew), hourly pay rate and the customer they work at (by number
// or name; several split by ";"). Daniel's picks (2026-11-03):
//   · the Account column LINKS a cleaner to that customer (`users[].worksAt`, lib/worksAt.js);
//     what they can see still comes only from the cleans that name them ("schedule decides");
//   · every row needs an email, and the import creates each person's login and emails them the
//     set-password link as it runs ("Email on every row, invite at import").
//
// THE RULES (the plan Daniel approved, 2026-11-03):
//   · a dry run first: planTeamImport writes nothing and says per row create / update / unchanged /
//     error, with every warning; the problems go out as a CSV (teamProblemsCsv);
//   · upsert, never duplicate: a member on file is matched by employee ID, then by email; only their
//     BLANK fields are filled (phone, pay, employee ID, the customer link), re-checked when the save
//     lands. Role, email, name and pay on file are never changed;
//   · employee IDs stay unique (lib/employeeId, the server's worsenedEmployeeIds agrees), emails
//     stay unique (the server's emailTaken), a role is only one the importer could pick on Invite
//     Member (lib/teamLimits roleChoices), never Super Admin; pay needs payroll.rates.edit — the
//     server's rules, mirrored so nothing is offered that the save would refuse (UI_RULES §118);
//   · the whole import is measured against the shared record's save ceiling BEFORE any login is
//     made (prepareTeamImport) — refused in words, never a partial import by size;
//   · then runs of 25: their logins (3 at a time, lib/teamApi createTeamLogin, the server's id wins
//     — bindRosterId), then ONE store action (IMPORT_TEAM) for those 25 (runTeamImport).
import { normalizeCompanyName, toCsvText } from './csv.js';
import { normalizeCustomerNumber, splitNumberedName, customerNumberHolder, customerLabel } from './customerNumber.js';
import { isActiveBuilding } from './customerStatus.js';
import { employeeIdOf, employeeIdKey, employeeIdOwner, nextEmployeeId } from './employeeId.js';
import { ROLE_CHOICES, roleChoices, choiceOf } from './teamLimits.js';
import { can, isOfficeRole } from './roles.js';
import { worksAtOf } from './worksAt.js';
import { normalizeHeader } from './customerImport.js';
import {
  MAX_STATE_BYTES, IMPORT_ALLOWED_BYTES, SAVE_ENVELOPE_BYTES, utf8Length, formatStateBytes,
} from './stateBudget.js';
import { msg } from '../i18n/core.js';

// ── the fields a column can hold ────────────────────────────────────────────────────────────
// Aliases as normalizeHeader() leaves a header (lower case, "#" read as "number", punctuation as
// a space), so a payroll export's own headers ("Emp #", "Employee Number", "Hourly Rate",
// "Rate ($/hr)", "Position", "Building") map without the office renaming anything.
export const TEAM_FIELDS = Object.freeze([
  { key: 'firstName', labelKey: 'teamImport.field.firstName',
    aliases: ['first name', 'first', 'firstname', 'given name', 'fname', 'employee first name', 'legal first name'] },
  { key: 'lastName', labelKey: 'teamImport.field.lastName',
    aliases: ['last name', 'last', 'lastname', 'surname', 'family name', 'lname', 'employee last name', 'legal last name'] },
  { key: 'name', labelKey: 'teamImport.field.name',
    aliases: ['name', 'full name', 'employee name', 'employee', 'staff name', 'cleaner', 'cleaner name', 'team member', 'member', 'member name', 'worker', 'worker name', 'display name'] },
  { key: 'employeeId', labelKey: 'teamImport.field.employeeId',
    aliases: ['employee id', 'employee number', 'employee no', 'employee code', 'emp id', 'emp number', 'emp no', 'emp', 'staff id', 'staff number', 'badge', 'badge number', 'badge id', 'payroll id', 'payroll number', 'file number', 'worker id', 'associate id', 'clock number', 'id', 'number', 'no'] },
  { key: 'email', labelKey: 'teamImport.field.email',
    aliases: ['email', 'e mail', 'email address', 'e mail address', 'work email', 'personal email', 'employee email', 'login', 'login email', 'sign in email'] },
  { key: 'phone', labelKey: 'teamImport.field.phone',
    aliases: ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'cell number', 'telephone', 'tel', 'contact number'] },
  { key: 'role', labelKey: 'teamImport.field.role',
    aliases: ['role', 'position', 'job title', 'title', 'job', 'access level', 'access', 'level', 'employee role'] },
  { key: 'pay', labelKey: 'teamImport.field.pay',
    aliases: ['pay rate', 'rate', 'hourly rate', 'hourly', 'pay', 'wage', 'hourly wage', 'rate of pay', 'base rate', 'hourly pay', 'pay per hour', 'rate hr', 'pay rate hr', 'hourly rate hr', 'rate per hour'] },
  { key: 'account', labelKey: 'teamImport.field.account',
    aliases: ['account', 'account name', 'customer', 'customer name', 'building', 'building name', 'site', 'site name', 'location', 'location name', 'property', 'property name', 'client', 'client name', 'account number', 'customer number', 'customer no', 'assigned account', 'assigned building', 'assigned site', 'job site', 'work site', 'works at'] },
]);
const FIELD = new Map(TEAM_FIELDS.map((f) => [f.key, f]));

// PRIVATE DETAILS stay out of the app: a Social Security, bank, tax, birth-date or licence column
// is never guessed onto anything, never written to the problems file, and the column step names
// the ones it skipped. (A payroll export often carries them; this import never reads them.)
const PRIVATE_RE = /\b(ssn|ss number|social|security number|sin|bank|banking|routing|aba|iban|deposit|birth|birthday|birthdate|dob|tax|tin|itin|ein|passport|licence|license|driver|i9|i 9|w4|w 4|salary|garnishment)\b/;
export const isPrivateHeader = (h) => PRIVATE_RE.test(normalizeHeader(h));

// Header → field, each field for ONE column (the first that fits): an exact alias first, then a
// header that CONTAINS a multi-word alias ("Employee ID (payroll)"). Never a private column.
export function guessTeamMapping(headers) {
  const norm = (headers || []).map(normalizeHeader);
  const out = {};
  const taken = new Set();
  const take = (i, f) => { out[i] = f.key; taken.add(f.key); };
  norm.forEach((h, i) => {
    if (!h || PRIVATE_RE.test(h)) return;
    const f = TEAM_FIELDS.find((x) => !taken.has(x.key) && x.aliases.includes(h));
    if (f) take(i, f);
  });
  norm.forEach((h, i) => {
    if (out[i] || !h || PRIVATE_RE.test(h)) return;
    const f = TEAM_FIELDS.find((x) => !taken.has(x.key) && x.aliases.some((a) => a.includes(' ') && ` ${h} `.includes(` ${a} `)));
    if (f) take(i, f);
  });
  return out;
}

// The columns a file must map: a name (one column, or a first or last name) and the email.
export function teamMappingReady(mapping) {
  const keys = new Set(Object.values(mapping || {}));
  return { name: keys.has('name') || keys.has('firstName') || keys.has('lastName'), email: keys.has('email') };
}

// ── who may import what (the server's rules, mirrored — UI_RULES §118) ─────────────────────
// orgStateGuard teamViolations: a new member is owner / admin by role, or settings.team.edit,
// at a role the caller may give (canGiveRole; an Operations Manager's level is mayGiveLevel's),
// never a Super Admin; a new member's pay is payroll.rates.edit's (an Admin's too, CS-003); their
// HR record beyond the employee ID is hr.edit's. On a member already on file: their pay needs
// payroll.rates.edit, their HR record hr.edit (owner / admin keep the whole row), the rest
// settings.team.edit; your OWN row's pay and HR record are owner / admin's. A cleaner's save is a
// crew merge that drops a new member whatever key it holds, so a cleaner never imports.
export function teamImportPermissions({ actor, permissions, overrides } = {}) {
  const role = actor?.role;
  const holds = (k) => can(actor, k, permissions, overrides);
  const owner = role === 'owner';
  const admin = role === 'admin';
  const office = isOfficeRole(role);
  const canImport = office && (owner || admin || holds('settings.team.edit'));
  return {
    canImport,
    canPay: canImport && (owner || holds('payroll.rates.edit')),
    canHr: canImport && (owner || admin || holds('hr.edit')),
    // Your own row (the importer may be in their own file).
    ownPay: owner || (admin && holds('payroll.rates.edit')),
    ownHr: owner || admin,
    selfId: actor?.id || null,
    // The levels Invite Member would offer them, never Super Admin from a file.
    choices: canImport ? roleChoices(actor, permissions, overrides).map((c) => c.value).filter((v) => v !== 'owner') : [],
  };
}

// ── small rules ─────────────────────────────────────────────────────────────────────────────
const lower = (s) => String(s ?? '').trim().toLowerCase();
const blankValue = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const nameKeyOf = (name) => normalizeCompanyName(splitNumberedName(name).name);
// Initials the way Invite Member makes them.
export const initialsOf = (name) => String(name || '').split(' ').filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
// Whether a member already has pay on file: a salary or per-clean pay, or a real hourly rate ($0
// is a rate). No pay field, or the pay type "none", is no pay. Pay on file is never overwritten.
const hasPay = (u) => {
  const p = u?.pay;
  if (!p || !p.type || p.type === 'none') return false;
  if (p.type !== 'hourly') return true;
  return p.hourlyRate !== null && p.hourlyRate !== undefined && p.hourlyRate !== '' && Number.isFinite(Number(p.hourlyRate));
};
const roleChoice = (value) => ROLE_CHOICES.find((c) => c.value === value) || null;
const roleName = (value) => { const c = roleChoice(value); return c ? msg(c.labelKey) : value; };

// A ROLE, as a spreadsheet may write it (case and punctuation forgiven). Only words this list
// knows: an unknown word is never guessed onto a level.
const ROLE_WORDS = new Map([
  ...['crew', 'crew member', 'cleaner', 'cleaning', 'cleaning staff', 'janitor', 'janitorial', 'custodian', 'porter', 'day porter', 'night porter', 'housekeeper', 'housekeeping', 'cleaning technician', 'floor technician', 'floor tech', 'staff']
    .map((w) => [w, 'crew']),
  ['account manager', 'manager'], ['manager', 'manager'], ['am', 'manager'],
  ['operations manager', 'manager:operations'], ['ops manager', 'manager:operations'], ['om', 'manager:operations'],
  ['supply manager', 'supply_manager'], ['supplies manager', 'supply_manager'],
  ['admin', 'admin'], ['administrator', 'admin'],
  ['super admin', 'owner'], ['superadmin', 'owner'], ['owner', 'owner'],
]);
// readTeamRole(cell, allowed) → { value } (a ROLE_CHOICES value) or { problem: 'superAdmin' |
// 'unknown' | 'notAllowed', value? }. A blank cell is Crew.
export function readTeamRole(raw, allowed = []) {
  const word = String(raw ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const value = word ? ROLE_WORDS.get(word) : 'crew';
  if (!value) return { problem: 'unknown' };
  if (value === 'owner') return { problem: 'superAdmin' };
  if (!allowed.includes(value)) return { problem: 'notAllowed', value };
  return { value };
}

// An hourly PAY RATE, as a spreadsheet may write it: "15.50", "$15.50", "$15.50/hr", "15.5 per
// hour", "1,050.00". Stored in dollars, rounded to the cent (lib/payRates rateCentsOf converts
// where money is computed). $0 is a rate; a negative or unreadable one is not.
export const HIGH_HOURLY_RATE = 100;
export function readPayRate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { rate: null };
  const core = s.toLowerCase()
    .replace(/(\/|\bper\b)\s*(hr|hour|h)\b\.?/g, ' ')
    .replace(/\b(an hour|hourly|hrs?|hours?|usd)\b/g, ' ')
    .replace(/\$/g, ' ')
    .replace(/\s+/g, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(core) && !/^\.\d+$/.test(core)) return { rate: null, invalid: true };
  const n = Number(core.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return { rate: null, invalid: true };
  const rate = Math.round(n * 100) / 100;
  return { rate, high: rate > HIGH_HOURLY_RATE };
}

// The ACCOUNT cell → customers on file: one or several (split by ";" or "|"), each by customer
// number ("42", "0042", "#0042") or by name ("Harbor View Towers", or "0042 Harbor View Towers",
// whose number and name must be the same customer). Only a building cleaned now is linked
// (lib/customerStatus isActiveBuilding: not a vendor, inactive or archived). Every part that
// isn't linked says why; the person is still added.
function readAccounts(raw, clients, byName) {
  const parts = String(raw ?? '').split(/\s*[;|]\s*/).map((p) => p.trim()).filter(Boolean);
  const ids = [];
  const warnings = [];
  for (const part of parts) {
    let hit = null;
    const digits = /^#?\s*(\d{1,4})$/.exec(part);
    if (digits) {
      const number = normalizeCustomerNumber(digits[1]);
      hit = number ? customerNumberHolder(clients, number) : null;
      if (!hit) { warnings.push(msg('teamImport.warn.accountNotFound', { value: part })); continue; }
    } else {
      const split = splitNumberedName(part);
      const key = nameKeyOf(split.name);
      if (split.number) {
        const holder = customerNumberHolder(clients, split.number);
        if (holder && nameKeyOf(holder.name) === key) hit = holder;
        else if (holder) { warnings.push(msg('teamImport.warn.accountMismatch', { value: part })); continue; }
      }
      if (!hit) {
        const named = byName.get(key) || [];
        if (named.length > 1) { warnings.push(msg('teamImport.warn.accountAmbiguous', { value: part })); continue; }
        if (!named.length) { warnings.push(msg('teamImport.warn.accountNotFound', { value: part })); continue; }
        hit = named[0];
      }
    }
    if (!isActiveBuilding(hit)) { warnings.push(msg('teamImport.warn.accountInactive', { customer: customerLabel(hit) })); continue; }
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, warnings };
}

// ── the plan: a dry run, per row ────────────────────────────────────────────────────────────
// planTeamImport({ rows, mapping, state, perms, live }) → {
//   rows:    [{ line, status, name, email, employeeId, role, pay, payOnFile, worksAt, changes, warnings,
//              errors, values, ops }]
//            line = the spreadsheet's row number (the header is row 1); status = 'create' |
//            'update' | 'unchanged' | 'error'; changes / warnings / errors are messages (msg());
//            role = the role they'll have (a message; null on a row in error); pay = the hourly rate
//            this import sets (null when it sets none); payOnFile = a member on file already has pay;
//            worksAt = the linked customers' labels;
//   counts:  rows by status: { create, update, unchanged, error, warning } (warning = rows carrying
//            one) — the row filters and the totals (one row is one person);
// }
// `mapping` is { columnIndex: fieldKey } (guessTeamMapping, then the person's own choices).
// `live` = a real sign-in backend: each new person gets a login and the set-password email.
// It writes NOTHING. The ops on each row are what buildTeamImportOps turns into the store action.
export function planTeamImport({ rows = [], mapping = {}, state = {}, perms = {}, live = false } = {}) {
  const users = (Array.isArray(state.users) ? state.users : []).filter((u) => u && u.id);
  const clients = Array.isArray(state.clients) ? state.clients : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const byName = new Map();
  for (const c of clients) {
    const k = nameKeyOf(c?.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  const userByEmail = new Map();
  for (const u of users) { const e = lower(u.email); if (e && !userByEmail.has(e)) userByEmail.set(e, u); }
  const allowedRoles = Array.isArray(perms.choices) ? perms.choices : [];

  const col = {};
  for (const [idx, key] of Object.entries(mapping || {})) if (key && FIELD.has(key) && col[key] === undefined) col[key] = Number(idx);
  const cell = (values, key) => (col[key] === undefined ? '' : String(values?.[col[key]] ?? '').trim());

  // A blank employee ID on a new person gets the next EMP-#### — past every one on the roster AND
  // in the file, numbered on through the file, so the mint never meets an ID the file gives later.
  let empMax = 0;
  const empSeen = (v) => { const m = /^emp-(\d+)$/i.exec(String(v || '').trim()); if (m) empMax = Math.max(empMax, parseInt(m[1], 10)); };
  for (const u of users) empSeen(employeeIdOf(u));
  for (const values of rows) empSeen(cell(values, 'employeeId'));
  const takenIds = new Set([...users.map((u) => employeeIdKey(employeeIdOf(u))), ...rows.map((v) => employeeIdKey(cell(v, 'employeeId')))].filter(Boolean));
  const mint = () => {
    let id;
    do { empMax += 1; id = `EMP-${String(empMax).padStart(4, '0')}`; } while (takenIds.has(employeeIdKey(id)));
    takenIds.add(employeeIdKey(id));
    return id;
  };

  // This file's people so far: two rows never make two people of one email or one employee ID.
  const fileEmails = new Map();
  const fileIds = new Map();
  const counts = { create: 0, update: 0, unchanged: 0, error: 0, warning: 0 };
  const out = [];

  rows.forEach((values, i) => {
    const val = (key) => cell(values, key);
    const r = { line: i + 2, status: null, name: '', email: '', employeeId: '', role: null, pay: null, payOnFile: false, worksAt: [], changes: [], warnings: [], errors: [], values: values || [], ops: [] };
    const finish = () => {
      if (r.errors.length) { r.status = 'error'; r.ops = []; }
      counts[r.status] += 1;
      if (r.warnings.length) counts.warning += 1;
      out.push(r);
    };
    if (!perms.canImport) { r.errors.push(msg('teamImport.err.notPermitted')); finish(); return; }

    // ── who: the name, the email, the employee ID (read in full even on a row in error, so the
    //    preview and the problems file show everything to fix at once) ──────────────────────
    const name = [val('firstName'), val('lastName')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || val('name').replace(/\s+/g, ' ');
    r.name = name;
    const emailRaw = val('email');
    const email = lower(emailRaw);
    r.email = email;
    const fileId = val('employeeId');
    if (!name) r.errors.push(msg('teamImport.err.noName'));
    if (!email) r.errors.push(msg('teamImport.err.noEmail'));
    else if (!EMAIL_RE.test(email)) r.errors.push(msg('teamImport.err.emailInvalid', { value: emailRaw }));
    else if (fileEmails.has(email)) r.errors.push(msg('teamImport.err.duplicateEmail', { row: fileEmails.get(email) }));
    const idKey = employeeIdKey(fileId);
    if (idKey && fileIds.has(idKey)) r.errors.push(msg('teamImport.err.duplicateEmployeeId', { row: fileIds.get(idKey), id: fileId }));
    if (email && EMAIL_RE.test(email) && !fileEmails.has(email)) fileEmails.set(email, r.line);
    if (idKey && !fileIds.has(idKey)) fileIds.set(idKey, r.line);

    // ── which member: on file by employee ID, then by email ──────────────────────────────
    let member = null;
    let matchedBy = null;
    if (!r.errors.length) {
      const byId = idKey ? employeeIdOwner(users, fileId) : null;
      if (byId) {
        if (lower(byId.email) !== email) r.errors.push(msg('teamImport.err.idOtherMember', { id: employeeIdOf(byId) || fileId, name: byId.name || byId.email, email: byId.email || '' }));
        else { member = byId; matchedBy = 'id'; }
      } else if (userByEmail.has(email)) {
        const u = userByEmail.get(email);
        if (idKey && employeeIdOf(u)) r.errors.push(msg('teamImport.err.idMismatch', { name: u.name || email, current: employeeIdOf(u), id: fileId }));
        else { member = u; matchedBy = 'email'; }
      }
    }

    // ── the role, the pay, the account ───────────────────────────────────────────────────
    const roleRaw = val('role');
    let roleValue = null;
    if (!member) {
      const read = readTeamRole(roleRaw, allowedRoles);
      if (read.problem === 'superAdmin') r.errors.push(msg('teamImport.err.roleSuperAdmin'));
      else if (read.problem === 'unknown') r.errors.push(msg('teamImport.err.roleUnknown', { value: roleRaw }));
      else if (read.problem === 'notAllowed') r.errors.push(msg('teamImport.err.roleNotAllowed', { role: roleName(read.value) }));
      else roleValue = read.value;
    } else if (roleRaw) {
      const read = readTeamRole(roleRaw, ROLE_CHOICES.map((c) => c.value));
      if (read.value !== choiceOf(member)) r.warnings.push(msg('teamImport.warn.roleKept', { role: roleName(choiceOf(member)) }));
    }
    const payRaw = val('pay');
    const pay = readPayRate(payRaw);
    if (pay.invalid) r.errors.push(msg('teamImport.err.payInvalid', { value: payRaw }));
    const accountRaw = val('account');
    const accounts = accountRaw ? readAccounts(accountRaw, clients, byName) : { ids: [], warnings: [] };
    if (r.errors.length) { finish(); return; }

    const self = !!member && member.id === perms.selfId;
    const mayPay = self ? perms.ownPay : perms.canPay;
    const crew = member ? member.role === 'crew' : roleValue === 'crew';
    let rate = pay.rate;
    if (rate !== null && !mayPay) {
      r.warnings.push(msg(self ? 'teamImport.warn.ownPay' : 'teamImport.warn.payNotAllowed'));
      rate = null;
    }
    if (rate !== null && pay.high) r.warnings.push(msg('teamImport.warn.payHigh', { rate }));
    let worksAt = accounts.ids;
    r.warnings.push(...accounts.warnings);
    if (worksAt.length && !crew) { r.warnings.push(msg('teamImport.warn.accountNotCrew')); worksAt = []; }
    const labels = (ids) => ids.map((id) => customerLabel(clientById.get(id)));

    if (!member) {
      // ── a NEW member: a login (live), and their roster row ────────────────────────────
      const minted = !fileId;
      const employeeId = fileId || mint();
      if (minted) r.warnings.push(msg('teamImport.warn.idMinted', { id: employeeId }));
      const { role, managerLevel } = (() => { const c = roleChoice(roleValue); return { role: c.role, managerLevel: c.role === 'manager' ? c.level : null }; })();
      const user = { name, email, role, initials: initialsOf(name), hr: { employeeId } };
      if (role === 'manager' && managerLevel === 'operations') user.managerLevel = 'operations';
      const phone = val('phone');
      if (phone) user.phone = phone;
      if (rate !== null) user.pay = { type: 'hourly', hourlyRate: rate };
      if (worksAt.length) user.worksAt = worksAt;
      r.employeeId = employeeId;
      r.role = roleName(roleValue);
      r.pay = rate;
      r.worksAt = labels(worksAt);
      r.ops.push({ op: 'addUser', line: r.line, user, mintedEmployeeId: minted });
      r.changes.push(msg('teamImport.chg.new', { role: roleName(roleValue) }));
      r.changes.push(msg('teamImport.chg.employeeId', { id: employeeId }));
      if (rate !== null) r.changes.push(msg('teamImport.chg.pay', { rate }));
      if (worksAt.length) r.changes.push(msg('teamImport.chg.worksAt', { customers: r.worksAt }));
      if (live) r.changes.push(msg('teamImport.chg.invite', { email }));
      r.status = 'create';
      finish();
      return;
    }

    // ── a member on file: fill their blanks, never overwrite ─────────────────────────────
    r.name = member.name || name;
    r.employeeId = employeeIdOf(member) || fileId;
    r.role = roleName(choiceOf(member));
    r.payOnFile = hasPay(member);
    r.changes.push(msg(matchedBy === 'id' ? 'teamImport.chg.matchedId' : 'teamImport.chg.matchedEmail'));
    const patch = {};
    const phone = val('phone');
    if (phone && blankValue(member.phone)) { patch.phone = phone; r.changes.push(msg('teamImport.chg.fillPhone')); }
    if (fileId && !employeeIdOf(member)) {
      if (self ? perms.ownHr : perms.canHr) { patch.employeeId = fileId; r.changes.push(msg('teamImport.chg.employeeId', { id: fileId })); r.employeeId = fileId; }
      else r.warnings.push(msg(self ? 'teamImport.warn.ownHr' : 'teamImport.warn.hrNotAllowed'));
    }
    if (rate !== null) {
      if (!hasPay(member)) { patch.pay = { type: 'hourly', hourlyRate: rate }; r.pay = rate; r.changes.push(msg('teamImport.chg.pay', { rate })); }
      else if (!(member.pay.type === 'hourly' && Number(member.pay.hourlyRate) === rate)) r.warnings.push(msg('teamImport.warn.payKept'));
    }
    const onFile = worksAtOf(member).filter((id) => clientById.has(id));
    if (worksAt.length) {
      if (!onFile.length) { patch.worksAt = worksAt; r.changes.push(msg('teamImport.chg.worksAt', { customers: labels(worksAt) })); }
      else if (worksAt.some((id) => !onFile.includes(id))) r.warnings.push(msg('teamImport.warn.accountKept', { customers: labels(onFile) }));
    }
    r.worksAt = labels(patch.worksAt || onFile);
    if (Object.keys(patch).length) r.ops.push({ op: 'fillUser', line: r.line, id: member.id, patch });
    r.status = r.ops.length ? 'update' : 'unchanged';
    finish();
  });

  return { rows: out, counts };
}

// ── the store action ────────────────────────────────────────────────────────────────────────
// The plan's ops with ids minted by the CALLER (II.7: caller-minted ids + the store's dedupe, so a
// replayed save adds nobody twice). Rows in error carry no ops. A new member is Active, as Invite
// Member saves them: their login exists (live) and Team shows "Hasn't signed in" until they do.
export function buildTeamImportOps(plan, { newId }) {
  const ops = [];
  for (const r of plan?.rows || []) {
    if (r.status === 'error') continue;
    for (const op of r.ops || []) {
      if (op.op === 'addUser') ops.push({ ...op, user: { ...op.user, id: newId('u'), status: 'active' } });
      else ops.push({ ...op, patch: { ...op.patch } });
    }
  }
  return ops;
}

// One op → the per-record store action that applies it, or null when it must not apply. The
// store's IMPORT_TEAM case runs each through its own switch, so ADD_USER / UPDATE_USER stay the
// ONE rule for a member (the default notification settings, the customer link kept to customers on
// file). An add is skipped when its id is already there or its email is now on the team (someone
// added them since the preview); an employee ID someone took since the preview is minted again if
// the import minted it, else left off — the save is never refused for a duplicate. A fill re-checks
// that each field is STILL blank. `A` is the store's ACTIONS, passed in because the reducer imports
// this module.
export function teamImportStepAction(s, op, A) {
  const users = Array.isArray(s?.users) ? s.users : [];
  switch (op?.op) {
    case 'addUser': {
      const u = op.user;
      if (!u?.id || users.some((x) => x && x.id === u.id)) return null;
      const email = lower(u.email);
      if (!email || users.some((x) => x && lower(x.email) === email)) return null;
      let user = u;
      const id = employeeIdOf(u);
      if (id && employeeIdOwner(users, id, u.id)) {
        const { employeeId: _taken, ...hr } = u.hr || {};
        user = { ...u, hr: op.mintedEmployeeId ? { ...hr, employeeId: nextEmployeeId(users) } : hr };
      }
      return { type: A.ADD_USER, user };
    }
    case 'fillUser': {
      const cur = users.find((x) => x && x.id === op.id);
      if (!cur) return null;
      const want = op.patch || {};
      const patch = {};
      if (!blankValue(want.phone) && blankValue(cur.phone)) patch.phone = want.phone;
      if (want.pay && !hasPay(cur)) patch.pay = { ...(cur.pay || {}), ...want.pay };
      if (Array.isArray(want.worksAt) && want.worksAt.length && !worksAtOf(cur).some((id) => (s.clients || []).some((c) => c && c.id === id))) patch.worksAt = want.worksAt;
      if (!blankValue(want.employeeId) && !employeeIdOf(cur) && !employeeIdOwner(users, want.employeeId, cur.id)) {
        patch.hr = { ...(cur.hr || {}), employeeId: want.employeeId };
      }
      return Object.keys(patch).length ? { type: A.UPDATE_USER, id: op.id, patch } : null;
    }
    default:
      return null;
  }
}

// ── the shared record's size, measured BEFORE anything is written ──────────────────────────
// The save the import would make, measured the way the server measures it: the whole shared
// record after the import (`applyOps` = the store's reducer; `serialize` = the sync engine's
// serializeSharedBlob), plus the save's envelope. The last run's save is the biggest one.
export function teamImportSize({ state, ops, applyOps, serialize }) {
  const after = applyOps(state, ops);
  const before = utf8Length(serialize(state)) + SAVE_ENVELOPE_BYTES;
  const total = utf8Length(serialize(after)) + SAVE_ENVELOPE_BYTES;
  const members = (ops || []).filter((o) => o?.op === 'addUser').length;
  return {
    before,
    after: total,
    limit: MAX_STATE_BYTES,
    allowed: IMPORT_ALLOWED_BYTES,
    fits: total <= IMPORT_ALLOWED_BYTES,
    members,
    perMember: members ? Math.round((total - before) / members) : null,
  };
}

// The import, ready to run: its ops and the size verdict, or the words that refuse it.
export function prepareTeamImport({ state, plan, newId, applyOps, serialize }) {
  const ops = buildTeamImportOps(plan, { newId });
  if (!ops.length) return { ops, verdict: null, refusal: msg('teamImport.nothingToDo') };
  const verdict = teamImportSize({ state, ops, applyOps, serialize });
  const refusal = verdict.fits ? null : msg('teamImport.tooLarge', {
    after: formatStateBytes(verdict.after), allowed: formatStateBytes(verdict.allowed), limit: formatStateBytes(verdict.limit),
  });
  return { ops, verdict, refusal };
}

// ── the run: logins, then the roster, 25 people at a time ──────────────────────────────────
export const TEAM_RUN_SIZE = 25;
export const TEAM_LOGINS_AT_ONCE = 3;

// `fn` over `items`, at most `limit` at a time, answers in the items' order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// runTeamImport — the ONLY way the import writes. The size was checked over the whole import first
// (prepareTeamImport). Then, run by run: each new person's login (live: `createLogin(email, role,
// mintedId)`, lib/teamApi createTeamLogin, 3 at a time; the id the server answers wins —
// `bindId`, lib/teamApi bindRosterId, so an orphan login is adopted), then ONE store action for the
// run (`dispatch({ type: actionType, ops })`): one pending entry and one save per 25 people, and a
// refused save names one change (CS-008). The fills ride with the first run. A person whose login
// was refused is left out of the roster, with the server's own words. `shouldStop()` is read after
// each run ("Stop after this run"): everything already done stays done, and running the same file
// again picks up the rest (those rows read unchanged). With no sign-in backend (the login-free
// demo), the whole import is one action and nobody gets a login.
// `getState()` is the store as it stands; `applyOps(s, ops)` is the store's reducer, used to say
// what each run will do before it is dispatched (an email someone added meanwhile is skipped).
// Returns { added: [{ line, name, email, invited, adopted, why, linkWithheld, employeeId, idChanged }],
// refused: [{ line, name, email, why }], skipped: [{ line, name, email }], filled, stopped, left }.
export async function runTeamImport({
  ops, live, createLogin, bindId, dispatch, actionType, getState, applyOps,
  onProgress, shouldStop, runSize = TEAM_RUN_SIZE, atOnce = TEAM_LOGINS_AT_ONCE,
}) {
  const adds = (ops || []).filter((o) => o?.op === 'addUser');
  let fills = (ops || []).filter((o) => o?.op === 'fillUser');
  const result = { added: [], refused: [], skipped: [], filled: 0, stopped: false, left: 0 };
  const size = live ? runSize : Math.max(adds.length, 1);
  let done = 0;
  for (let i = 0; i === 0 || i < adds.length; i += size) {
    const run = adds.slice(i, i + size);
    const answers = live
      ? await mapLimit(run, atOnce, async (op) => {
        try { return { op, login: await createLogin(op.user.email, op.user.role, op.user.id) }; } catch (error) { return { op, error }; }
      })
      : run.map((op) => ({ op, login: null }));
    const ready = [];
    for (const a of answers) {
      const who = { line: a.op.line, name: a.op.user.name, email: a.op.user.email };
      if (a.error) { result.refused.push({ ...who, why: String(a.error?.message || a.error || '') }); continue; }
      const id = live ? bindId(a.login, a.op.user.id) : a.op.user.id;
      ready.push({ op: { ...a.op, user: { ...a.op.user, id } }, login: a.login, who });
    }
    const batch = [...fills, ...ready.map((x) => x.op)];
    fills = [];
    if (batch.length) {
      // What this run does to the store as it stands now (the reducer is pure).
      const before = getState();
      const after = applyOps(before, batch);
      const beforeIds = new Set((before?.users || []).map((u) => u?.id));
      const afterById = new Map((after?.users || []).map((u) => [u?.id, u]));
      for (const x of ready) {
        const row = afterById.get(x.op.user.id);
        if (!row || beforeIds.has(x.op.user.id)) { result.skipped.push(x.who); continue; }
        result.added.push({
          ...x.who,
          invited: live ? x.login?.invited !== false : false,
          adopted: live && x.login?.adopted === true,
          why: (live && x.login?.why) || null,
          linkWithheld: live && x.login?.linkWithheld === true,
          employeeId: employeeIdOf(row),
          idChanged: employeeIdOf(row) !== employeeIdOf(x.op.user),
        });
      }
      for (const op of batch) {
        if (op.op !== 'fillUser') continue;
        const was = (before?.users || []).find((u) => u?.id === op.id);
        if (was && afterById.get(op.id) !== was) result.filled += 1;
      }
      dispatch({ type: actionType, ops: batch });
    }
    done += run.length;
    if (typeof onProgress === 'function') onProgress({ done, total: adds.length, added: result.added.length, refused: result.refused.length });
    if (done < adds.length && typeof shouldStop === 'function' && shouldStop()) {
      result.stopped = true;
      result.left = adds.length - done;
      break;
    }
  }
  return result;
}

// ── files ───────────────────────────────────────────────────────────────────────────────────
// The template: the columns this import reads, with example rows to replace (".example" emails,
// fictional people; customers named by number). Its headers are the field aliases, so it maps back.
export const TEAM_TEMPLATE_HEADERS = Object.freeze([
  'First name', 'Last name', 'Employee ID', 'Email', 'Phone', 'Role', 'Pay rate', 'Account',
]);
const TEMPLATE_ROWS = [
  ['Rosa', 'Delgado', '10234', 'rosa.delgado@example.com', '(954) 555-0142', 'Crew', '15.50', '0101'],
  ['Andre', 'Baptiste', '10235', 'andre.baptiste@example.com', '', 'Crew', '$16.00/hr', 'Harbor View Towers'],
  ['Kim', 'Nguyen', '10236', 'kim.nguyen@example.com', '(305) 555-0199', 'Account Manager', '', ''],
];
export function teamTemplateCsv() {
  return toCsvText([[...TEAM_TEMPLATE_HEADERS], ...TEMPLATE_ROWS]);
}

// The problems file: every row that was not imported, or was imported with something left out,
// with its own columns as the file had them — fix it and import this file again — plus the row
// number, the result and the reason. A private column (isPrivateHeader) is never written to it.
// `render` turns a message into the reader's words.
export function teamProblemsCsv({ plan, headers, render }) {
  const say = (m) => (typeof render === 'function' ? render(m) : '');
  const keep = (headers || []).map((h, i) => [h, i]).filter(([h]) => !isPrivateHeader(h));
  const out = [[say(msg('teamImport.csv.row')), ...keep.map(([h]) => h), say(msg('teamImport.csv.result')), say(msg('teamImport.csv.problem'))]];
  for (const r of plan?.rows || []) {
    if (!r.errors.length && !r.warnings.length) continue;
    const result = r.errors.length ? msg('teamImport.csv.notImported') : msg('teamImport.csv.withNote');
    out.push([String(r.line), ...keep.map(([, i]) => r.values?.[i] ?? ''), say(result), [...r.errors, ...r.warnings].map(say).join(' ')]);
  }
  return toCsvText(out);
}
