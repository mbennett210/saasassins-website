// Field-level authorization for the shared org_state blob.
//
// WHY THIS EXISTS — and why Increment 1e is incomplete without it:
//
// The proven-live self-escalation (AUTHORIZATION_AUDIT.md) is that any
// authenticated user can write the whole blob and set their own
// `users[].role = 'owner'`. The remediation plan closes that by revoking the
// browser's write policy in Increment 1e — but revoking only forces writes
// through `/api/state/org-state`, and that endpoint writes whatever the client
// sends. Without a field-level check, 1e relocates the hole behind a
// service-role proxy instead of closing it: a crew user POSTs a blob with their
// role flipped and the server commits it.
//
// So this guard is a HARD PREREQUISITE for 1e, not a nicety.
//
// Every write the app makes is routed here (Increment 1d). 1e itself is the
// migration 20260803150000_increment_1e_revoke_browser_writes.sql (it drops the
// browser's org_state write policies); on a database where it is applied this is
// the real boundary. The app no longer has any other way to write (store/sync.js's
// direct-write fallback was deleted, CS-009); where 1e were not applied, a browser
// could still write around this check by hand. Whether it is applied is a fact of
// the live database, not of this repo.
//
// DESIGN: deny by exception, not by allowlist. The blob has ~47 slices and most
// are ordinary business data any authenticated user legitimately edits (jobs,
// clients, notes...). Enumerating those would be a maintenance trap that fails
// OPEN on every new slice. Instead we name the small set of fields that confer
// AUTHORITY — and, since CS-003, every slice that is MONEY or a DELETE of a customer —
// and check only those: a new slice is unprotected by default, which is the correct
// default for data but must never be true for authority or money. If you add an
// authority- or money-bearing field, add it here AND to protectedFingerprint.
// (A crew login never reaches this as a policy: its save is a merge through an
// allowlist, api/_lib/crewMerge.js, CS-002; the guard re-runs there only as a backstop.)
//
// 🔴 MONEY AND CUSTOMER ARCHIVES FOLLOW THE MATRIX FOR EVERYONE BUT THE SUPER ADMIN (CS-003,
// 2026-10-03; the archive replaced the customer delete on 2026-10-13, CS-663). The checks below
// that predate the 4th tier let OWNER AND ADMIN pass by role
// ("never tightened"), and invoices had no check at all. But the screens gate an Admin on
// the same keys as everyone (Invoices on invoices.edit / invoices.recordPayment, Payroll on
// payroll.edit, a pay rate on payroll.rates.edit, Reimbursements on hr.edit, a customer
// archive on clients.delete) and by Q24 an Admin holds none of the money keys by default — so
// the role pass was a server path the app never used, open to a crafted save. Now:
//   invoices (create, the bill, delete) <- invoices.edit    payments <- invoices.recordPayment
//   void <- invoices.edit · un-void <- owner only (InvoiceDetail canUnvoid) · a stored
//   status move otherwise (bulk "Mark paid") <- invoices.edit or invoices.recordPayment
//   payroll lines <- payroll.edit (or hr.edit for special / reimbursement lines)
//   any member's pay rate, an Admin's own included <- payroll.rates.edit
//   reimbursements <- hr.edit · archiving or restoring a customer <- clients.delete
// the Super Admin by role (the recoverable top tier), everyone else by the COMMITTED matrix +
// overrides. REMOVING a customer is refused for everyone (customers are archived, never
// deleted — CS-663 / CS-027). The Team checks below keep their owner+admin role lists.
// And since 2026-10-03 (the Customers import; CS-622's contacts half), the same way:
//   adding a customer <- clients.edit · adding a contact, or changing a contact's details
//   (name, email, phone, title, the customer it belongs to) <- contacts.edit
// A contact's other fields (do-not-contact, reminder opt-out, tags, notes) and its removal stay
// as they were (CS-622).

// WHO MAY CHANGE WHAT — the server agrees with the app. Each check passes for the
// roles that always could (owner, or owner+admin; never tightened), OR for whoever
// holds the permission the UI gates that action on, read from the COMMITTED matrix +
// per-user overrides through lib/roles can(), the same function the app runs. The
// role lists alone predated the 4th-tier `manager` (full access by default, pared
// back per client in Settings → Roles), so the app let a manager make Team edits the
// server then refused on save (S74 found it on time off; the rest moved 2026-09-23).
//   add a member            <- settings.team.edit  (what the invite form sets: a role you may give, an
//                                                   email not already on the team; pay needs
//                                                   payroll.rates.edit, HR beyond the employee id hr.edit)
//   users[].role            <- staff.assignRoles   (never your own; never to or from Super Admin; a role
//                                                   you may give; changing an ADMIN's is admin+ by role, CS-355)
//   users[].status          <- settings.team.edit  (never a Super Admin's)
//   another member's fields <- settings.team.edit  (pay: payroll.rates.edit · hr: hr.edit ·
//                                                   email: role list only · clockRules: below)
//   ANY row's clockRules    <- an OFFICE role AND time.clockRules  (a new row, your own row or
//                                                   another member's. The field EXEMPTS a person
//                                                   from the clock-out checklist block and the
//                                                   clock-in geofence, and R5 says the cleaner has NO
//                                                   way around the block, so the grant of that key to
//                                                   a cleaner does nothing for this field at all: a
//                                                   key-only rule let two granted cleaners exempt each
//                                                   other, one turn an office member's geofence off,
//                                                   and any of them hire someone pre-exempted. The
//                                                   floor can't BE a key: can() puts none out of a
//                                                   grant's reach, as canEndAccess's does not. A
//                                                   manager pared off the key is still refused)
//   remove a member         <- settings.team.edit  (never yourself; never a Super Admin)
//   permissions             <- settings.roles.edit (rows in the shape the Roles page writes)
//   userPermissionOverrides <- staff.editOverrides (other members only; never a Super Admin's; well-formed rows)
//   company.timezone        <- owner only          (owner's call, 2026-09-23)
//   users[].managerLevel, users[].opsManagerId <- owner+admin holding ops.edit (S131: who is an
//                                                   Operations Manager, and whose team an account
//                                                   manager is on — a valid pointer for everyone);
//                                                   a level change ALSO takes holding everything
//                                                   the target column carries, and never your own
//                                                   (CS-858: the level picks a permission column)
//   clients[].supervisorId  <- owner+admin; an Operations Manager holding ops.edit only between
//                              members of their own (committed) team (S131)
//   standingCrewIds, sites[].clientId <- owner+admin (nothing in the app writes them since 2026-09-09)
//   timeOff                 <- settings.team.edit or hr.edit
//   the roster's shape      <- owner only          (no new row without an id, second row for an id or
//                                                   email, and no EDIT to a duplicated-id row; owner's
//                                                   call 2026-09-23 — see "the roster's shape")
//   an ADMIN's status/role  <- owner+admin by role (a no-access status ends server access and a role
//                                                   change reduces it, so ending/reducing an Admin's access
//                                                   is not a settings.team.edit / staff.assignRoles grant, CS-355)
// And for EVERY caller, the Super Admin included: a member who may still be owed pay is not
// removed (the app's own rule), and the roster keeps a Super Admin.
// "A role you may give" is lib/roles canGiveRole: a Super Admin gives any role; anyone else,
// the admin role list included, only a role whose every permission they hold (owner's
// rule, 2026-09-23: with the default matrix an Admin may give Admin or Crew, not Manager).
// The limits in brackets are the owner's (2026-09-23) or follow the controls that
// write the field, and they are what keeps a grant from reaching the top tier: can()
// puts no key out of a grant's reach, so creating, re-roling, disabling or removing a
// Super Admin, editing a Super Admin's overrides, and changing your own role or
// overrides are held back by ROLE and identity, not by key. A login with no role claim
// is matched to its row BY EMAIL, so the roster's shape and every member's email are
// identity too: both are checked, and email is in protectedFingerprint. The roster's
// shape is now checked for admins too (S93, 2026-09-23): planting a duplicate owner row
// for a claim-less manager to resolve as was a live path. ⚠️ One gap remains (documented,
// not a lockout risk): an admin can still change another member's EMAIL (the field check
// exempts owner/admin), so an admin could re-point a claim-less login's email at a Super
// Admin's — but a duplicate-owner row is now refused. Since claims.js knows every role
// (S80, 2026-09-23) every login the app creates carries a role claim, so the claim-less
// population is only logins stamped before then; the live audit found none (HANDOFF S80).
// The login half of Team administration (/api/settings/users) runs the same rules:
// _lib/teamAuthority.js.
import { createHash } from 'node:crypto';
import { jsonEq } from './jsonEq.js';
import {
  canEndAccess, canReduceRole, can as roleCan, columnMember, PERMISSION_COLUMNS, OPS_MANAGER_COLUMN, PERMISSIONS, OFFICE_ROLES,
} from '../../src/lib/roles.js';
import { matrixForCan, overridesForCan } from './permissionSlices.js';
import { matrixAuthority, owedPayFor } from './teamAuthority.js';
import { worsenedEmployeeIds } from '../../src/lib/employeeId.js';
import { supplyBudgetFor } from '../../src/lib/supplies.js';
import { archiveTuple, carriesArchiveState } from '../../src/lib/customerStatus.js';
import {
  isOpsManager, isAccountManager, isActiveOpsManager, opsManagerIdOf, validOpsPointer, isOpsManagerIn, teamMemberIds,
} from '../../src/lib/teamScope.js';

const OWNER = ['owner'];
const MANAGER = ['owner', 'admin'];
// The OFFICE tiers — every role but crew (lib/roles OFFICE_ROLES, the server's and the browser's
// one list; the supply manager joined it in S131 and is office here as everywhere). Distinct from
// MANAGER above, whose name predates the 4th tier and still means owner+admin only. Used where a
// rule needs a ROLE floor no grant can cross: can() puts no key out of a grant's reach, so "a
// cleaner must not be able to do X" cannot be expressed as a key (the same reasoning as
// canEndAccess's admin+ floor).
const OFFICE = OFFICE_ROLES;
// Another member's row, field by field, gated like the control that edits it
// (TeamDetail › Pay, EmployeeHrFieldsCard, TeamDetail › Time). Any other field is profile,
// which is settings.team.edit (TeamDetail › Profile). Maps, so a crafted key can't reach
// the prototype.
// NOTE `clockRules` is deliberately NOT here: it needs a ROLE as well as a key (see
// mayWriteClockRules), which a key map cannot express, so its branch decides it and this
// map would only mislead the next reader into thinking the key alone suffices. Its WORDS
// still live below, where the refusal message is built.
const FIELD_KEYS = new Map([['pay', 'payroll.rates.edit'], ['hr', 'hr.edit']]);
const FIELD_WORDS = new Map([
  ['pay', "change another member's pay"],
  ['hr', "edit another member's HR record"],
  ['clockRules', "change another member's clock rules"],
]);

const norm = (v) => JSON.stringify(v ?? null);
const byId = (arr) => {
  const m = new Map();
  for (const x of Array.isArray(arr) ? arr : []) if (x && x.id) m.set(x.id, x);
  return m;
};
const own = (x, k) => (x && Object.prototype.hasOwnProperty.call(x, k) ? x[k] ?? null : null);
// How a claim-less login finds its row (users.js getOrgUserByEmail lowercases; trimmed
// here too, which only ever matches MORE rows).
const emailKey = (u) => (typeof u?.email === 'string' ? u.email.trim().toLowerCase() : '');
// JSON with every object's keys sorted: the same value, whatever order jsonb returned.
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x)) ?? 'undefined';
// The MONEY / PII fields of a user row, canonical (key-order-stable) for the fingerprint
// tuple: pay + the HR record + the disable date. Before 2026-09-23 they were outside the
// fingerprint, so a save changing only another member's pay — or your OWN pay/hr — moved
// nothing and committed unchecked (HANDOFF S79 FOUND 2). Name / phone / notification +
// signature prefs are deliberately NOT here: they carry no money or authority, and adding
// them would put an Account-page profile save (and any load-time prefs normalization) on
// the 314 KB read; the guard leaves another member's cosmetic fields as a documented gap.

// The roster's identity defects, as keys: rows that are not objects or carry no string
// id (keyed by content), and ids or emails carried by more than one row (keyed with the
// count, so a third copy is a new defect). See "the roster's shape" below.
function rosterDefects(users) {
  const out = new Set();
  const loose = new Map();
  const ids = new Map();
  const emails = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const u of Array.isArray(users) ? users : []) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || !u.id) { bump(loose, canonical(u)); continue; }
    bump(ids, u.id);
    if (emailKey(u)) bump(emails, emailKey(u));
  }
  for (const [c, n] of loose) out.add(`no-id:${n}:${c}`);
  for (const [id, n] of ids) if (n > 1) out.add(`id:${n}:${id}`);
  for (const [e, n] of emails) if (n > 1) out.add(`email:${n}:${e}`);
  return out;
}

// 🔴 AN EMPLOYEE ID IDENTIFIES ONE PERSON (CS-229 / PAY-9, Matt 2026-09-29). It is what the
// payroll company matches a row in the export on, so two members sharing one is worse than
// neither having one: the import pays one of them twice and the other nothing. This is a
// DATA-INTEGRITY check, not an authority one — like the closed-pay-period freeze, it holds for
// the owner too, and like `rosterDefects` it only answers for a duplicate the save CREATES or
// WORSENS (a roster that already holds one is not this caller's to fix, and refusing it would
// wedge every save until someone repaired the data through a path the guard also refused). The
// rule is the app's own — `worsenedEmployeeIds` in `src/lib/employeeId`, which the HR card runs
// too, so the two halves cannot drift — and it counts HOLDERS rather than keys, so adding a
// third person to an already-duplicated id is refused as well.

// Is the ONLY opsSettings change a DELETE_USER cascade clearing a field that NAMES the member
// being removed — ALR-4's operations manager, or SUP-9's named supply approver? True when every
// OTHER key of the slice is byte-equal and each field that moved went from a member who is GONE
// from `next.users` to null. Authority-neutral for the same reason the supervisorId clear is:
// the save that removes the member is the one that has to clear it, and the person doing the
// removal may not hold `time.config` — without this, a member removal by a settings.team.edit
// holder pared off that key would 403 and DROP THE WHOLE pending batch.
const OPS_MEMBER_FIELDS = ['operationsManagerUserId', 'supplyApproverUserId'];
const namedMemberId = (settings, key) => {
  const v = settings?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
function opsManagerCascadeClearOnly(prev, next) {
  const gone = byId(next?.users);
  let anyCleared = false;
  for (const key of OPS_MEMBER_FIELDS) {
    const was = namedMemberId(prev?.opsSettings, key);
    const now = namedMemberId(next?.opsSettings, key);
    if (was === now) continue;                 // this field did not move
    if (now !== null) return false;            // re-pointed, not cleared — that stays time.config's
    if (gone.has(was)) return false;           // the holder is still on the roster
    anyCleared = true;
  }
  if (!anyCleared) return false;
  // nothing ELSE in the slice may move
  const strip = (o) => { const c = { ...(o || {}) }; for (const k of OPS_MEMBER_FIELDS) delete c[k]; return c; };
  return jsonEq(canonical(strip(prev?.opsSettings)), canonical(strip(next?.opsSettings)));
}

// Did any row whose id is DUPLICATED in the committed roster change? byId() keeps only
// the LAST copy for an id, so a change to any earlier one is invisible to every check
// above, while a claim-less login resolves by the FIRST row with its email — so setting a
// pre-existing duplicate's first copy to owner committed with a 200 and escalated on the
// next request (adversarial review 2026-09-23, R6). The whole ordered run of rows carrying
// a committed-duplicate id must be byte-identical in next. IDs only: rows that merely share
// an EMAIL each have their own byId entry, so their changes are already seen above, and a
// member whose email collides with another's must still be able to edit their own row.
function duplicateIdRowsChanged(prevUsers, nextUsers) {
  const count = new Map();
  for (const u of Array.isArray(prevUsers) ? prevUsers : []) {
    if (u && typeof u.id === 'string' && u.id) count.set(u.id, (count.get(u.id) || 0) + 1);
  }
  const dupIds = new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
  if (!dupIds.size) return false;
  const run = (arr) => (Array.isArray(arr) ? arr : []).filter((u) => u && typeof u.id === 'string' && dupIds.has(u.id));
  return canonical(run(prevUsers)) !== canonical(run(nextUsers));
}

// ── supplies: the monthly budget (SUP-7), and the two slices that LEFT the record (SUP-13) ──
// Since SUP-13 (Matt, 2026-10-05) the request queue and the approved lists live in their own
// tables behind /api/supplies, which holds the approval state machine and SUP-11's per-building
// approver; this guard no longer judges requests at all. What stays here is a customer's SUPPLY
// SETTINGS (below) — they are fields on `clients`, which is still the shared record.
//
// 🔴 THE RETIRED SLICES ARE THE SERVER'S, NOT THE BROWSER'S. `supplyItems` / `supplyRequests`
// stay in the committed blob until scripts/supplies-move.mjs has copied them into the tables and
// `--strip` removes them — and an INSTALLED iOS PWA runs a stale bundle for weeks, whose reducer
// still writes them. So no browser save may change them in either direction: a save that differs
// from the committed value (an old bundle submitting a request, a new one that never had the keys)
// is put back to exactly what is committed — kept while the blob still holds them, dropped once
// --strip has removed them (restoreRetiredSlices). Not a refusal: a 403 would make store/sync drop
// every OTHER edit in the same batch, for a slice nobody can see any more. The fingerprint carries
// them (retiredSlicesInput), so a save that leaves them alone stays on the fast path and one that
// moves them pays the deep read, where the committed values are in hand.
export const RETIRED_SLICES = Object.freeze(['supplyItems', 'supplyRequests']);
const retiredSlicesInput = (state) => RETIRED_SLICES.map((k) => canonical(state?.[k] ?? null));
// Put the retired keys of `next` back to the committed `prev` (mutates and returns next). A key
// prev does not carry is DELETED from next. Returns { next, changed } so the caller knows to
// recompute the digest it stores.
export function restoreRetiredSlices(prev, next) {
  let changed = false;
  for (const k of RETIRED_SLICES) {
    const has = prev && Object.prototype.hasOwnProperty.call(prev, k) && prev[k] != null;
    const want = has ? prev[k] : undefined;
    const now = next ? next[k] : undefined;
    if (jsonEq(canonical(want ?? null), canonical(now ?? null)) && (has === (now !== undefined))) continue;
    changed = true;
    if (has) next[k] = want; else delete next[k];
  }
  return { next, changed };
}

// A customer's SUPPLY SETTINGS: the monthly budget (money the office commits to) and the order
// day the reminder is timed off. Normalized through the app's own reader, so a blank and a
// missing field are the same value and an ordinary customer save stays off the deep read.
const supplySettings = (c) => [c?.id ?? null, supplyBudgetFor(c), Number(c?.supplyOrderDayOfMonth) || null];
// The fingerprint input, sorted by id so jsonb's order is irrelevant. A customer with NO supply
// settings contributes nothing, so creating or renaming one never moves this (the clientIds set
// already covers a create/delete).
const supplyClientSettings = (arr) => (Array.isArray(arr) ? arr : [])
  .map(supplySettings)
  .filter(([, budget, day]) => budget !== null || day !== null)
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

// Assignment ids for one entity, order-insensitive (the UI reorders freely).
const crewSet = (x) => JSON.stringify([...new Set(Array.isArray(x?.standingCrewIds) ? x.standingCrewIds : [])].sort());
// A location's assigned manager (client.supervisorId), normalized so '' and a missing field
// both read as "no manager". Assigning / changing / clearing it is authority (it sets
// scope() for time approval, MTA §2) — owner/admin only, checked below; its fingerprint
// input is the `supervisors` projection in protectedFingerprint.
const supervisorId = (c) => (c && typeof c.supervisorId === 'string' && c.supervisorId ? c.supervisorId : null);

// ── money slices (payroll lines · reimbursements · pay-run config) ─────────────
// Projections that carry ONLY what makes a record cost money on the pay run
// (src/lib/payroll grossForUser prices amount by category), so a change to a display or
// provenance field is not a money change. In particular DELETE_USER stamps `userName`
// on the kept lines and reimbursements of a removed member (src/lib/deleteCascade
// sweepUserOrphans); that stamp must NOT read as a money edit, or removing a member
// (settings.team.edit) would be refused for want of payroll.edit. One projection feeds
// BOTH protectedFingerprint (so a money change moves the digest and pays the read) and
// protectedFieldViolations (so it is judged) — a single source of truth, or the digest
// could miss a change the check would have caught, silently skipping the guard.
const payLineMoney = (l) => (l && typeof l === 'object'
  ? [l.userId ?? null, l.periodKey ?? null, l.kind ?? null, l.category ?? null, l.amount ?? null, l.taxable ?? null]
  : null);
const reimbMoney = (r) => (r && typeof r === 'object'
  ? [r.userId ?? null, r.amount ?? null, r.status ?? null, r.periodKey ?? null]
  : null);
// INVOICES (CS-003). An invoice's MONEY: who it bills (clientId), what (the line items, whole —
// only the invoice editor writes them), the tax rate, the issue and due dates (the due date
// decides "overdue"), its stored status (`void` is authoritative in deriveInvoiceStatus) and its
// payments. Notes, the PO number, the attachment, the billing contact, the linked cleans
// (`jobIds`, which a job delete prunes) and the overdue stamp (`overdueNotifiedAt`, written by
// the cron) are display or provenance: a change to them moves nothing and stays off the
// protected read. ONE projection feeds protectedFingerprint and the check below.
const invoiceBill = (inv) => [inv?.clientId ?? null, canonical(inv?.lineItems ?? []), inv?.taxRate ?? null,
  inv?.issueDate ?? null, inv?.dueDate ?? null];
const invoiceMoney = (inv) => (inv && typeof inv === 'object'
  ? [...invoiceBill(inv), inv.status ?? null, canonical(inv.payments ?? [])]
  : null);
// The refusals an invoice change can draw, judged per invoice against the COMMITTED one. (A
// customer delete's invoice cascade used to be judged neutral here; customers are archived, never
// deleted, since CS-663 — a save removing one is refused outright below.) Robust to rows the by-id
// view can't see (no id, a duplicated id): if the multiset of money projections moved and no
// per-invoice rule named it, the change still needs invoices.edit.
function invoiceViolations(prev, next, { isOwner, holds }) {
  if (isOwner) return [];
  const freq = new Map();
  const bump = (inv, d) => { const k = canonical([inv && typeof inv === 'object' ? (inv.id ?? null) : null, invoiceMoney(inv)]); freq.set(k, (freq.get(k) || 0) + d); };
  for (const inv of Array.isArray(prev?.invoices) ? prev.invoices : []) bump(inv, -1);
  for (const inv of Array.isArray(next?.invoices) ? next.invoices : []) bump(inv, +1);
  if (![...freq.values()].some((n) => n !== 0)) return [];
  const holdsEdit = holds('invoices.edit');
  const holdsPay = holds('invoices.recordPayment');
  const words = new Set();
  let attributed = false; // a per-invoice rule saw the change (allowed or not)
  const before = byId(prev?.invoices);
  const after = byId(next?.invoices);
  for (const [id, inv] of after) {
    const was = before.get(id);
    if (!was) { attributed = true; if (!holdsEdit) words.add('create an invoice'); continue; }
    if (canonical(invoiceBill(was)) !== canonical(invoiceBill(inv))) { attributed = true; if (!holdsEdit) words.add('change an invoice'); }
    if (canonical(was.payments ?? []) !== canonical(inv.payments ?? [])) { attributed = true; if (!holdsPay) words.add('record a payment on an invoice'); }
    const from = was.status ?? null;
    const to = inv.status ?? null;
    if (from !== to) {
      attributed = true;
      // Un-voiding is the Super Admin's (InvoiceDetail offers it to the owner alone): a void is
      // the ledger's correction mechanism, and undoing one resurrects a debt.
      if (from === 'void') words.add('un-void an invoice');
      else if (to === 'void') { if (!holdsEdit) words.add('void an invoice'); }
      // The bulk "Mark paid" (Invoices, invoices.recordPayment) stores 'paid' with the payment.
      else if (!holdsEdit && !holdsPay) words.add('change an invoice');
    }
  }
  for (const id of before.keys()) {
    if (after.has(id)) continue;
    attributed = true;
    if (!holdsEdit) words.add('delete an invoice');
  }
  // The money moved somewhere the by-id view can't see (a row with no id, a duplicated id).
  if (!attributed && !holdsEdit) words.add('change an invoice');
  return [...words];
}

// A CONTACT's details — who the person is and which customer they belong to: what the Add
// contact form, the conversation panel's contact card and the Customers import write, and what
// "Create / edit contacts" (contacts.edit) gates (2026-10-03). Normalized so a blank and a
// missing field are the same value. Deliberately NOT here: the do-not-contact and reminder
// flags, tags, notes and timestamps — a marketing reply tags a person, a cron stamps one, and
// those saves must stay off the deep read. ONE projection feeds protectedFingerprint and the
// check below.
const text = (v) => (v == null ? '' : String(v).trim());
const contactPerson = (c) => (c && typeof c === 'object'
  ? [c.id ?? null, text(c.firstName), text(c.lastName), text(c.email).toLowerCase(), text(c.phone), text(c.title), c.companyId ?? null]
  : null);
// Which contacts a save ADDS and whether it CHANGES one's details, judged against the committed
// ones. A contact removed (on its own, or with its customer) is neither: removals stay as they
// were. Robust to rows the by-id view can't see (no id, an id two rows share): if THEIR details
// moved, that is a change nobody can attribute to a known contact, so it needs the key too.
function contactPeopleDelta(prev, next) {
  const before = byId(prev?.contacts);
  let added = false;
  let changed = false;
  for (const [id, after] of byId(next?.contacts)) {
    const was = before.get(id);
    if (!was) added = true;
    else if (canonical(contactPerson(was)) !== canonical(contactPerson(after))) changed = true;
  }
  const loose = (arr) => {
    const list = Array.isArray(arr) ? arr : [];
    const n = new Map();
    for (const c of list) if (c && typeof c.id === 'string' && c.id) n.set(c.id, (n.get(c.id) || 0) + 1);
    return list.filter((c) => !c || typeof c.id !== 'string' || !c.id || n.get(c.id) > 1)
      .map((c) => canonical(contactPerson(c))).sort();
  };
  if (canonical(loose(prev?.contacts)) !== canonical(loose(next?.contacts))) changed = true;
  return { added, changed };
}

// A sorted digest input for a list of records under a money projection: id kept first
// so a projection two rows happen to share still counts twice, then the money fields.
const moneyList = (arr, project) => (Array.isArray(arr) ? arr : [])
  .map((x) => [x && typeof x === 'object' ? (x.id ?? null) : null, project(x)])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
// The categories of the payroll lines whose MONEY projection was added or removed
// between two states — a net multiset diff keyed by the projection, so a userName-only
// stamp nets to zero. Robust to a line with no id: byId() would drop it, but such a line
// still pays out (grossForUser filters by userId, not id), so it must still be caught.
function changedPayrollCategories(prev, next) {
  const freq = new Map();
  const bump = (l, d) => {
    const key = canonical(payLineMoney(l));
    const e = freq.get(key) || { n: 0, category: (l && typeof l === 'object') ? (l.category ?? null) : null };
    e.n += d; freq.set(key, e);
  };
  for (const l of Array.isArray(prev?.payrollLines) ? prev.payrollLines : []) bump(l, -1);
  for (const l of Array.isArray(next?.payrollLines) ? next.payrollLines : []) bump(l, +1);
  const cats = [];
  for (const e of freq.values()) if (e.n !== 0) cats.push(e.category);
  return cats;
}
// True when any reimbursement's MONEY projection was added, removed or changed (a
// userName stamp nets to zero, like the payroll one above).
function reimbursementsMoneyChanged(prev, next) {
  const freq = new Map();
  const bump = (r, d) => { const k = canonical(reimbMoney(r)); freq.set(k, (freq.get(k) || 0) + d); };
  for (const r of Array.isArray(prev?.reimbursements) ? prev.reimbursements : []) bump(r, -1);
  for (const r of Array.isArray(next?.reimbursements) ? next.reimbursements : []) bump(r, +1);
  for (const n of freq.values()) if (n !== 0) return true;
  return false;
}
// True when any payroll line whose userId is `selfId` was added, changed or removed — MTA
// W1-G: your OWN pay line is owner-only, every category. MONEY projection, so a DELETE_USER
// userName stamp nets to zero (and a member can't remove themselves, so their own kept lines
// are never userName-stamped either); an id-less own line still pays out (grossForUser filters
// by userId), so it counts.
function ownPayrollLineChanged(prev, next, selfId) {
  if (!selfId) return false;
  const freq = new Map();
  const bump = (l, d) => {
    if (!l || typeof l !== 'object' || l.userId !== selfId) return;
    const k = canonical(payLineMoney(l));
    freq.set(k, (freq.get(k) || 0) + d);
  };
  for (const l of Array.isArray(prev?.payrollLines) ? prev.payrollLines : []) bump(l, -1);
  for (const l of Array.isArray(next?.payrollLines) ? next.payrollLines : []) bump(l, +1);
  for (const n of freq.values()) if (n !== 0) return true;
  return false;
}
// The periodKeys of payroll lines whose MONEY projection was added, changed or removed (net
// multiset diff; a userName-only stamp nets to zero, like changedPayrollCategories). Feeds
// the W2-L closed-period rule and payrollLedgerFactNeeded.
function changedPayrollLinePeriodKeys(prev, next) {
  const freq = new Map();
  const bump = (l, d) => {
    if (!l || typeof l !== 'object') return;
    const e = freq.get(canonical(payLineMoney(l))) || { n: 0, periodKey: l.periodKey ?? null };
    e.n += d; freq.set(canonical(payLineMoney(l)), e);
  };
  for (const l of Array.isArray(prev?.payrollLines) ? prev.payrollLines : []) bump(l, -1);
  for (const l of Array.isArray(next?.payrollLines) ? next.payrollLines : []) bump(l, +1);
  const keys = new Set();
  for (const e of freq.values()) if (e.n !== 0 && e.periodKey != null) keys.add(e.periodKey);
  return keys;
}
// The pay-SCHEDULE fields frozen once a run exists (W2-L §2): the cadence and the pay-week
// start day. otMultiplier / geofence / the rest of opsSettings are NOT frozen.
const PAY_SCHEDULE_FIELDS = ['payPeriodCadence', 'payWeekStartDay'];
function payScheduleChanged(prev, next) {
  const p = prev?.opsSettings || {}; const n = next?.opsSettings || {};
  return PAY_SCHEDULE_FIELDS.some((k) => !jsonEq(p[k] ?? null, n[k] ?? null));
}
// Whether the org-state route must read payroll_runs for this save (W2-L §5.2): only when a
// payroll line's money moved or the pay schedule changed. The route passes the result as
// facts.payrollRuns, which protectedFieldViolations then enforces (closed periods / schedule).
export function payrollLedgerFactNeeded(prev, next) {
  return changedPayrollLinePeriodKeys(prev, next).size > 0 || payScheduleChanged(prev, next);
}

// The fields that differ between two versions of a member's row, other than role and
// status (checked on their own) and the two team fields (teamViolations, below). Key order is
// ignored: jsonb hands a nested object's keys back in its own order, so a tab's copy can differ
// from the committed row in order alone. A missing field and a null one are the same, as in norm().
const OWN_RULE_FIELDS = new Set(['role', 'status', 'managerLevel', 'opsManagerId']);
function changedFields(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (OWN_RULE_FIELDS.has(k)) continue;
    if (!jsonEq(own(before, k), own(after, k))) out.push(k);
  }
  return out;
}

// ── the Operations Manager's TEAM (S131, plan 2026-10-14 §0) ────────────────────────────────
// `users[].managerLevel` ('operations' makes a manager an Operations Manager) and
// `users[].opsManagerId` (the OM an account manager reports to) decide whose buildings an OM
// approves, edits and adds time for and moves between account managers (lib/teamScope.js). That
// is AUTHORITY of the same kind as `client.supervisorId`, so changing either takes owner / admin
// holding ops.edit (`mayAssign`; lib/teamLimits mayAssignTeams is the app's twin) — a manager,
// an OM included, is refused. Judged on the NORMALIZED values (lib/teamScope: a missing level
// reads 'account', '' and a missing pointer are no pointer), so writing a default is no change.
// Two carve-outs keep a legitimate save from being refused for the cascade it carries (the
// reducer writes them: lib/teamScope teamCascade, lib/deleteCascade clearOpsManagerPointers):
//   · a pointer CLEARED because its OM stopped being an active OM in the same save (removed,
//     demoted by the level or the role, disabled), or because the row stopped being an account
//     manager — the change that caused it is judged on its own (the removal, the role, the level);
//   · OM-ness lost through a ROLE change is the role branch's (staff.assignRoles), not this one's.
// And for EVERY caller, the owner included — data integrity, like the employee ID: a pointer this
// save sets must be valid in the saved roster (on an account manager, at an ACTIVE OM, never the
// row itself).
// 🔴 THE LEVEL PICKS A PERMISSION COLUMN (CS-858): an Operations Manager's permissions come from
// their own column in Settings → Roles, so a level change can give access the way a role change can,
// and it is guarded like one — giving the operations level (or moving an OM back to account) also
// takes holding every permission the TARGET column carries (lib/roles canGiveColumn, canGiveRole's
// rule; the Super Admin holds everything), and NOBODY changes their own level, the Super Admin
// included (the role's rule: the login route refuses a self role change for everyone).
function teamViolations(prev, next, { mayAssign, mayGiveColumn, selfId }) {
  const out = [];
  const before = byId(prev?.users);
  const after = byId(next?.users);
  for (const [id, a] of after) {
    const b = before.get(id) || null;
    const was = isOpsManager(b);
    const now = isOpsManager(a);
    if (was !== now && id === selfId) out.push('change your own manager level');
    else if (!was && now && !(mayAssign && mayGiveColumn(OPS_MANAGER_COLUMN))) out.push('make a member an Operations Manager');
    else if (was && !now && a.role === 'manager' && !(mayAssign && mayGiveColumn('manager'))) out.push("change an Operations Manager's level");
    const p0 = opsManagerIdOf(b);
    const p1 = opsManagerIdOf(a);
    if (p0 === p1) continue;
    const cascade = p1 === null && (!isActiveOpsManager(after.get(p0)) || !isAccountManager(a));
    if (!cascade && !mayAssign) out.push('change who an account manager reports to');
    if (p1 !== null && !validOpsPointer(next?.users, a, p1)) {
      out.push('point an account manager at someone who is not an active Operations Manager');
    }
  }
  return out;
}

// The members whose override rows differ between two lists. Rows are grouped by
// userId: can() reads a member's FIRST row, so an added or reordered duplicate is a
// change like any other. A missing list reads as empty. null when either list is
// present but not an array, or when a changed row names no member: it can't be
// attributed, so the matrix never lets it through.
function overrideTargets(before, after) {
  const group = (list) => {
    if (list == null) return new Map();
    if (!Array.isArray(list)) return null;
    const m = new Map();
    for (const o of list) {
      const uid = typeof o?.userId === 'string' ? o.userId : '';
      if (!m.has(uid)) m.set(uid, []);
      m.get(uid).push(o);
    }
    return m;
  };
  const b = group(before);
  const a = group(after);
  if (!b || !a) return null;
  const changed = [];
  for (const uid of new Set([...b.keys(), ...a.keys()])) {
    if (jsonEq(b.get(uid) || [], a.get(uid) || [])) continue;
    if (!uid) return null;
    changed.push(uid);
  }
  return changed;
}

/**
 * Compare the authority-bearing fields of two blob states and report anything
 * the caller is not permitted to have changed.
 *
 * @param prev    the committed state (only the protected subtree is needed)
 * @param next    the state the client is asking to commit
 * @param role    the caller's role, resolved from the JWT claim
 * @param selfId  the caller's `u_*` id, from the claim — used so a user may
 *                still edit their OWN non-authority profile fields
 * @param facts   { removal, payrollRuns }: async facts the route reads and passes in.
 *                `removal` (memberRemoval.removalPayFacts: the committed pay slices + the time
 *                ledger) is REQUIRED when removedMemberIds(prev, next) is non-empty, else every
 *                removal is refused. `payrollRuns` ({ ok, periodKeys, anyRun }) is read only
 *                when payrollLedgerFactNeeded(prev, next) is true (a pay line's money or the pay
 *                schedule moved); a failed read ({ ok:false }/null) fails the closed-period /
 *                schedule rules closed; an absent fact leaves them silent (no run to protect).
 * @returns string[] of human-readable violations; empty means allowed
 */
export function protectedFieldViolations(prev, next, role, selfId, facts = {}) {
  const violations = [];
  const can = (roles) => roles.includes(role);
  // Whether the caller holds the permission the UI gates an action on (holds), and may
  // give a role (mayGive: lib/roles canGiveRole). From the COMMITTED state (prev), never
  // the proposed one: a save must not be able to grant itself the key it needs. role +
  // selfId are the JWT claim's, exactly as for the role lists. A null role holds none of
  // the keys asked for here (can() fails closed on anything outside ALWAYS_GRANTED, and
  // none of these are in it). A malformed committed row reads as a MISSING one, so it
  // can't throw inside can() and 500 every save (permissionSlices.js through teamAuthority, the reading jobsGuard shares).
  // Each read at the caller's permission COLUMN: a manager's level comes off the committed roster
  // (prev.users), so an Operations Manager is judged on the OM column (CS-858).
  const { holds, mayGive, mayGiveColumn } = matrixAuthority(prev, role, selfId);
  // ONE rule for `users[].clockRules`, wherever it appears — a new row, your own row or
  // another member's (checklists step 4b; the coordinator's ruling after the L3 review,
  // 2026-09-27). The field turns the clock-out checklist block and the clock-in geofence OFF
  // for a person, and R5 says the cleaner has NO way around the block, so it takes an OFFICE
  // role AND the key. The floor cannot BE a key: `can()` puts none out of a per-user grant's
  // reach, so with a key alone two granted cleaners could exempt each other, one could turn
  // an office member's geofence off, and any of them could hire someone pre-exempted — the
  // same reasoning that makes canEndAccess a role floor. Owner + admin never reach this:
  // every branch below is already inside `!can(MANAGER)`.
  const mayWriteClockRules = () => can(OFFICE) && holds('time.clockRules');

  // ── users[]: role + status are authority; everything else is profile ──────
  const prevUsers = byId(prev?.users);
  const nextUsers = byId(next?.users);
  const isOwnerRow = (id) => prevUsers.get(id)?.role === 'owner' || nextUsers.get(id)?.role === 'owner';
  const whose = (id) => (id === selfId ? 'your own' : "another member's");
  // An email already on the team: the committed roster, or another proposed row. A login
  // with no role claim is matched to the FIRST row carrying its email (users.js
  // getOrgUserByEmail), so a new row with a taken email could stand in for that member.
  // The committed roster counts even for a member removed in the same save: otherwise a
  // claim-less manager could move their own email and re-add it on a new, higher row.
  const emailTaken = (member) => {
    const e = emailKey(member);
    const roster = [...(Array.isArray(prev?.users) ? prev.users : []), ...(Array.isArray(next?.users) ? next.users : [])];
    return !!e && roster.some((u) => u !== member && emailKey(u) === e);
  };

  for (const [id, after] of nextUsers) {
    const before = prevUsers.get(id);
    if (!before) {
      // A new team member: owner+admin by role, or settings.team.edit within what the
      // invite form sets (an email nobody on the team has, an employee id); pay, the rest
      // of the HR record and the CLOCK RULES need the keys that edit them. Only an owner
      // may mint an owner, and anyone else, admin included, only a role they may give
      // (canGiveRole: an unknown role like "Owner" is refused too).
      // ⚠️ A FIELD CHECKED ON A CHANGED ROW MUST BE CHECKED HERE TOO. `clockRules` was not,
      // so a `settings.team.edit` holder could ADD a row already exempt from the clock-out
      // block and the geofence — every new hire pre-exempted, and re-adding a removed id
      // with the block off was the way around the changed-row rule (L3 review, Medium).
      if (!can(MANAGER) && !holds('settings.team.edit')) violations.push('add a team member');
      else if (after.role === 'owner' && !can(OWNER)) violations.push('create a Super Admin');
      else if (!can(OWNER) && !mayGive(after.role)) violations.push('give a new member that access level');
      else if (!can(MANAGER)) {
        if (emailTaken(after)) violations.push('add a member whose email is already on the team');
        if (own(after, 'clockRules') !== null && !mayWriteClockRules()) violations.push("set a new member's clock rules");
        if (own(after, 'pay') !== null && !holds('payroll.rates.edit')) violations.push("set a new member's pay");
        if (Object.keys(own(after, 'hr') ?? {}).some((k) => k !== 'employeeId') && !holds('hr.edit')) {
          violations.push("set a new member's HR record");
        }
      } else if (!can(OWNER) && own(after, 'pay') !== null && !holds('payroll.rates.edit')) {
        // CS-003: a pay rate is payroll.rates.edit's for an Admin too (money follows the matrix
        // for everyone but the Super Admin; the invite form sets no pay at all).
        violations.push("set a new member's pay");
      }
      continue;
    }
    if (norm(before.role) !== norm(after.role) && !can(OWNER)) {
      // staff.assignRoles (TeamDetail's Role field), but never your own role, never to or from
      // Super Admin (those stay the owner's), only a role you may give, and — since changing an
      // ADMIN's access level reduces their access (a demoted Admin could then be disabled or
      // removed) — never an Admin's unless the caller is admin+ by ROLE (lib/roles canEndAccess,
      // CS-355, owner's call 2026-09-25; the same floor as disabling / removing one). Judged on
      // the target's CURRENT role (before.role); promoting TO Admin is not gated.
      const viaMatrix = holds('staff.assignRoles') && id !== selfId
        && before.role !== 'owner' && mayGive(after.role)
        && canEndAccess(role, before.role === 'admin');
      if (!viaMatrix) {
        violations.push(id === selfId ? 'change your own access level'
          : before.role === 'owner' ? "change a Super Admin's access level"
            : after.role === 'owner' ? 'make a member a Super Admin'
              : (before.role === 'admin' && !canEndAccess(role, true)) ? "change an Admin's access level"
                : holds('staff.assignRoles') ? 'give a member that access level'
                  : "change another member's access level");
      }
    }
    if (norm(before.status) !== norm(after.status) && !can(OWNER)) {
      // settings.team.edit (TeamDetail's Status field, revoking an invite), never a Super
      // Admin's. And since a no-access status now ENDS server access (authz.js ROSTER
      // STATUS), disabling an ADMIN takes admin+ by ROLE, not a settings.team.edit grant:
      // a manager (or crew granted the key) can end a manager's or a crew member's access,
      // never an Admin's (owner's call, 2026-09-23). Demoting the Admin first no longer
      // escapes this: changing an Admin's role is admin+ by ROLE too (CS-355, owner's call
      // 2026-09-25, the role branch above), so neither step is open to a manager.
      const targetIsAdmin = before.role === 'admin' || after.role === 'admin';
      if (isOwnerRow(id) || !canEndAccess(role, targetIsAdmin) || !holds('settings.team.edit')) {
        violations.push(`change ${whose(id)} account status`);
      }
    }
    // Your OWN row: pay and the HR record are a Super Admin's (owner/admin by role, never
    // tightened — owner's call 2026-09-23), even holding payroll.rates.edit / hr.edit;
    // your disable date needs settings.team.edit (the pay run reads it); your clockRules go
    // through mayWriteClockRules (an OFFICE role AND the key, the same rule as every other
    // row — see its note above); name / phone / notification + signature prefs stay free. Before 2026-09-23 your own
    // pay/hr were never checked at all (HANDOFF S79 FOUND 2). The rest of ANOTHER member's
    // row is judged just below.
    if (id === selfId && !can(MANAGER)) {
      for (const field of changedFields(before, after)) {
        if (field === 'pay') violations.push('change your own pay');
        else if (field === 'hr') violations.push('edit your own HR record');
        else if (field === 'clockRules' && !mayWriteClockRules()) violations.push('change your own clock rules');
        else if (field === 'disabledAt' && !holds('settings.team.edit')) violations.push('change your own disable date');
      }
    }
    // Another member's fields: your own row is handled above; owner+admin keep the whole
    // row, as before; otherwise each changed field needs the key of the control that
    // edits it. A login email is never editable through the matrix: the app doesn't edit
    // it once logins exist, and a claim-less login is matched to its row BY email.
    // ⚠️ The fingerprint carries only a row's AUTHORITY / MONEY fields — id, role, status,
    // email, pay, hr, disabledAt and (2026-09-27) clockRules — NOT every field, so this loop
    // fires for those, or when something else in the same save moved the digest. A newly
    // gated field must join protectedFingerprint's tuple in the same change or the check
    // silently never runs. (This comment claimed "every user-row field" from 2026-09-23 to
    // 2026-09-27; it was never true — name / phone / prefs are deliberately out, as
    // protectedFingerprint's own note says.) So this
    // fires on a change to any of them — a save changing only another member's pay is no
    // longer skipped (the S77/S79 gap, closed).
    if (id !== selfId && !can(MANAGER)) {
      for (const field of changedFields(before, after)) {
        if (field === 'email') violations.push("change another member's login email");
        // clockRules is decided by mayWriteClockRules, NOT by FIELD_KEYS: it needs a ROLE
        // as well as a key, which a key map cannot say. Held here so a crew member granted
        // `time.clockRules` can't exempt a teammate or an office member either.
        else if (field === 'clockRules') { if (!mayWriteClockRules()) violations.push(FIELD_WORDS.get('clockRules')); }
        else if (!holds(FIELD_KEYS.get(field) || 'settings.team.edit')) violations.push(FIELD_WORDS.get(field) || "edit another member's profile");
      }
    }
    // 🔴 CS-003: an ADMIN's pay-rate edits follow payroll.rates.edit — another member's AND their
    // own. The two blocks above skip owner+admin by role (never tightened for the Team fields),
    // but a pay rate is money, the Pay card asks an Admin for the key like everyone else
    // (TeamDetail canEditThisPay), and an Admin holds none of the money keys by default (Q24).
    if (can(MANAGER) && !can(OWNER) && changedFields(before, after).includes('pay') && !holds('payroll.rates.edit')) {
      violations.push(id === selfId ? 'change your own pay' : FIELD_WORDS.get('pay'));
    }
  }
  for (const [id, before] of prevUsers) {
    if (nextUsers.has(id)) continue;
    // Pay that may still be owed blocks a removal for EVERY caller, a Super Admin included:
    // the app's own rule (DELETE_USER + the Team page), held here too since 2026-09-23
    // (owner's call; the login-delete route checks it first). A removed member can't be
    // paid: their pay rate goes with them. The facts (the committed pay slices + the time
    // ledger) come from the route; a check that can't run refuses.
    const owed = owedPayFor(prev, facts?.removal, id);
    if (owed === 'unchecked') violations.push("remove a team member whose pay couldn't be checked");
    else if (owed) violations.push('remove a team member who may still be owed pay');
    if (can(OWNER)) continue;
    // settings.team.edit (TeamDetail's Remove), never yourself (the Team page refuses it),
    // never a Super Admin (so no non-owner can take the last one), and — since removing ENDS
    // access — never an ADMIN unless the caller is admin+ by ROLE (lib/roles canEndAccess,
    // CS-329, owner's call 2026-09-24; the same floor as disabling one, above).
    if (!(holds('settings.team.edit') && id !== selfId && before.role !== 'owner' && canEndAccess(role, before.role === 'admin'))) {
      violations.push(id === selfId ? 'remove your own account'
        : before.role === 'owner' ? 'remove a Super Admin'
          : (before.role === 'admin' && !canEndAccess(role, true)) ? 'remove an Admin'
            : 'remove a team member');
    }
  }
  // The roster keeps a Super Admin, whoever saves (DEL-05: lib/roles isLastOwner is the
  // app's rule, and DELETE_USER's). Removing or demoting the last one strands everyone off
  // role and matrix editing. A committed roster with none already is left as it is.
  const anyOwner = (list) => Array.isArray(list) && list.some((u) => u && u.role === 'owner');
  if (anyOwner(prev?.users) && !anyOwner(next?.users)) violations.push('leave the team without a Super Admin');

  // ── the Operations Manager's team: a manager's level and who an AM reports to (S131) ────────
  // owner / admin holding ops.edit, as for a building's manager; a level change also takes the
  // target column, and never your own (CS-858) — teamViolations, above.
  violations.push(...teamViolations(prev, next, { mayAssign: can(MANAGER) && holds('ops.edit'), mayGiveColumn, selfId }));

  // ── the roster's shape ─────────────────────────────────────────────────────
  // A login with no role claim (every manager's until the 2026-09-23 claims fix and its
  // data-op) is matched to the FIRST row carrying its email (users.js getOrgUserByEmail), but byId()
  // above sees only the LAST row for an id and none without one. So a second row for an
  // id, a row with no id, or a second row with an email is an identity the checks above
  // never compare: prepend a copy of your own row as a Super Admin and the next request
  // resolves as one. The app never writes such a row (ADD_USER upserts by id, the invite
  // form refuses a taken email). Everyone but a Super Admin is checked now (was owner+admin
  // — but an admin planting a duplicate owner row for a claim-less manager to resolve as
  // was a live path too: adversarial review 2026-09-23, owner's call). A defect already in
  // the committed roster is not the caller's to answer for, UNLESS they touch it: editing a
  // row whose id is duplicated is refused (R6 above).
  if (!can(OWNER)) {
    const committed = rosterDefects(prev?.users);
    if ([...rosterDefects(next?.users)].some((d) => !committed.has(d))) {
      violations.push("add a second row for a team member's identity");
    } else if (duplicateIdRowsChanged(prev?.users, next?.users)) {
      violations.push('edit a duplicated team-member row');
    }
  }

  // ── the employee ID is unique per person (CS-229 / PAY-9) ─────────────────
  // For EVERYONE, the owner included: it is data integrity, not authority (see the note above
  // `duplicateIdRowsChanged`). Only a duplicate this save CREATES or WORSENS is refused.
  {
    const dupes = worsenedEmployeeIds(prev?.users, next?.users);
    if (dupes.length) violations.push('give two people the same employee ID');
  }

  // ── the live permission matrix + per-user overrides ───────────────────────
  // Compared whole with key order ignored: jsonb hands keys back in its own order.
  // Every client's can() reads these rows on every render, so through the matrix they
  // must stay in the shape the app writes: a row with `roles: null` or `grants: 'x'`
  // would crash the app for everyone, the owner included. A malformed row already
  // committed is tolerated as it stands.
  if (!jsonEq(prev?.permissions ?? null, next?.permissions ?? null) && !can(OWNER)) {
    // settings.roles.edit (the Roles page, which only ever patches a row's roles).
    const kept = Array.isArray(prev?.permissions) ? prev.permissions : [];
    const wellFormed = Array.isArray(next?.permissions) && next.permissions.every((p) =>
      (p && typeof p.id === 'string' && Array.isArray(p.roles)) || kept.some((q) => jsonEq(q, p)));
    if (!holds('settings.roles.edit') || !wellFormed) {
      violations.push('change the permission matrix');
    } else {
      // CS-331 (owner's option (b), 2026-09-24): a grant is valid only when the caller holds
      // that key — canGiveRole's rule, extended from roles to individual permission keys. Judge
      // only DELTAS: every (key, role) pair the save NEWLY grants (a new row, or a role added to
      // a row's roles) needs the caller's own COMMITTED effective permission (holds); removing a
      // role is always allowed. Read the way canGiveRole reads a role's keys — can({role}, key)
      // — over the SANITIZED prev/next matrices, so a malformed row can't throw. A Super Admin
      // never reaches here (can(OWNER) above), and OWNER_ONLY keys are held by no one else, so
      // a non-owner can never grant them.
      const prevMatrix = matrixForCan(prev?.permissions);
      const nextMatrix = matrixForCan(next?.permissions);
      const keys = new Set();
      for (const p of kept) if (p && typeof p.id === 'string') keys.add(p.id);
      for (const p of next.permissions) if (p && typeof p.id === 'string') keys.add(p.id);
      for (const key of keys) {
        // CS-370 (owner's call 2026-09-25): a matrix save that makes a key NO LONGER effective for
        // the ADMIN ROLE reduces every Admin's access at once, so it is admin+ by ROLE — the matrix
        // twin of CS-369, sharing the reduce-a-role floor (lib/roles canReduceRole, = canEndAccess for
        // an Admin target). Granting the admin column a key stays CS-331 (a holder may grant); the
        // other role columns are unaffected.
        if (roleCan({ id: null, role: 'admin' }, key, prevMatrix, null)
          && !roleCan({ id: null, role: 'admin' }, key, nextMatrix, null)
          && !canReduceRole(role, 'admin')) {
          violations.push("reduce the Admin role's permissions");
        }
        // CS-371 (owner's call 2026-09-25): a matrix save that makes a key NO LONGER effective for the
        // SUPER ADMIN (owner) ROLE reduces every part of the app the owner reaches, and authz reads the
        // same can(), so only a Super Admin may (canReduceRole). The OWNER_CORE keys (dashboard.view,
        // settings.roles.edit) resolve true for an owner whatever the matrix says, so roleCan never sees
        // them "no longer effective" and they are never refused — that keeps the owner recoverable.
        // Granting the owner column stays CS-331 (the grant loop below).
        if (roleCan({ id: null, role: 'owner' }, key, prevMatrix, null)
          && !roleCan({ id: null, role: 'owner' }, key, nextMatrix, null)
          && !canReduceRole(role, 'owner')) {
          violations.push("reduce the Super Admin role's permissions");
        }
        // Every permission COLUMN, the Operations Manager's included (CS-858): a row naming
        // `operations_manager` is a column like any other, so switching it on for a key takes
        // holding that key — before CS-858 this loop read ROLES and never saw the OM column.
        for (const col of PERMISSION_COLUMNS) {
          const member = columnMember(col);
          if (roleCan(member, key, nextMatrix, null)
            && !roleCan(member, key, prevMatrix, null)
            && !holds(key)) {
            violations.push(`give a permission you don't have (${key})`);
          }
        }
      }
    }
  }
  if (!jsonEq(prev?.userPermissionOverrides ?? null, next?.userPermissionOverrides ?? null) && !can(OWNER)) {
    // staff.editOverrides (TeamDetail › Access), for other members only: never your own
    // row (no self-grants) and never a Super Admin's (a revoke there outranks their role),
    // in the reducer's shape ({ userId, grants: [], revokes: [] }). A removed member's
    // rows leaving with them ride on the removal, checked above.
    const targets = overrideTargets(prev?.userPermissionOverrides, next?.userPermissionOverrides);
    const nextRows = Array.isArray(next?.userPermissionOverrides) ? next.userPermissionOverrides : [];
    const leftWithMember = (uid) => prevUsers.has(uid) && !nextUsers.has(uid) && !nextRows.some((o) => o?.userId === uid);
    const mayEdit = (uid) => holds('staff.editOverrides') && uid !== selfId && !isOwnerRow(uid)
      && (prevUsers.has(uid) || nextUsers.has(uid))
      && nextRows.filter((o) => o?.userId === uid).every((o) => Array.isArray(o.grants) && Array.isArray(o.revokes));
    if (!targets || !targets.every((uid) => leftWithMember(uid) || mayEdit(uid))) {
      violations.push('change per-user permission overrides');
    } else {
      // CS-331: an override may make a key EFFECTIVE for the target — a key added to grants, or a
      // revoke removed for a key the target's role default carries. Any key that BECOMES
      // effective for the target and wasn't before needs the caller to hold it (holds); taking
      // access away (a grant cleared, a revoke added, or a revoke removed for a key the role
      // doesn't carry) is never refused. Judged on the COMMITTED matrix (prev), so the matrix
      // delta is judged on its own and a same-save self-grant can't bootstrap. Sanitized slices,
      // so a malformed row can't throw. Owner short-circuits above (can(OWNER)).
      const prevMatrix = matrixForCan(prev?.permissions);
      const prevOv = overridesForCan(prev?.userPermissionOverrides);
      const nextOv = overridesForCan(next?.userPermissionOverrides);
      for (const uid of targets) {
        if (leftWithMember(uid)) continue; // a removed member's override rows ride the removal check
        const target = prevUsers.get(uid) || nextUsers.get(uid);
        if (!target) continue;
        // CS-369 (owner's call 2026-09-25): REDUCING an Admin's per-user permissions is admin+ by
        // ROLE — the same canEndAccess floor as ending (CS-329) or re-roling (CS-355) one. CS-331
        // below judges GRANTS only, so a manager / crew holding staff.editOverrides could add a
        // revoke or drop a grant and take an Admin's access away unchecked. Judged on the target's
        // COMMITTED role (prevUsers) and the same effective delta CS-331 uses (prev matrix, prev vs
        // next overrides). Granting an Admin a key stays CS-331 (a holder may still grant); a role
        // change is CS-355's branch and a removal CS-329's, each judged on its own.
        const reduceAdminBlocked = prevUsers.get(uid)?.role === 'admin' && !canEndAccess(role, true);
        let reducedAdmin = false;
        for (const key of Object.keys(PERMISSIONS)) {
          const before = roleCan(target, key, prevMatrix, prevOv);
          const after = roleCan(target, key, prevMatrix, nextOv);
          if (after && !before && !holds(key)) {
            violations.push(`give a permission you don't have (${key})`);   // CS-331
          } else if (before && !after && reduceAdminBlocked && !reducedAdmin) {
            violations.push("reduce an Admin's permissions");                // CS-369
            reducedAdmin = true;
          }
        }
      }
    }
  }

  // ── the org-wide display timezone (owner-only) ────────────────────────────
  // company.timezone re-reads every job time, invoice date and reminder for the
  // WHOLE company (src/lib/dates.js ORG_TZ), so it is authority-bearing, not
  // profile. Before 2026-08-03 the field was unprotected here, so any authenticated
  // client could POST a blob flipping the entire org's calendar to another zone.
  // It stays OWNER-ONLY by the owner's call (2026-09-23), and the app agrees since S79:
  // settings.company.timezone is in OWNER_ONLY (src/lib/roles.js), so can() never gives
  // it to another role (its default still lists manager, which holds nothing).
  if (norm(prev?.company?.timezone) !== norm(next?.company?.timezone) && !can(OWNER)) {
    violations.push('change the company timezone');
  }

  // ── standing crew assignments ─────────────────────────────────────────────
  // These decide who can reveal a site's door/alarm codes and whose QC records
  // are visible (authz.js requireSiteAssignment / crewAssignedScope), so a crew
  // user self-assigning is a privilege escalation, not a data edit. Nothing in the
  // app writes standingCrewIds or re-parents a site since crew came to be only the
  // schedule's (2026-09-09, 008f5f2), so there is no UI permission to mirror: they
  // stay on the owner+admin role list, and widening them would only open a path to
  // door codes.
  if (!can(MANAGER)) {
    for (const key of ['sites', 'clients']) {
      const before = byId(prev?.[key]);
      const after = byId(next?.[key]);
      for (const [id, a] of after) {
        const b = before.get(id);
        if (b && crewSet(b) !== crewSet(a)) { violations.push(`change crew assignments on a ${key === 'sites' ? 'site' : 'account'}`); break; }
        if (!b && crewSet(a) !== '[]') { violations.push(`create a ${key === 'sites' ? 'site' : 'account'} with crew assigned`); break; }
      }
    }

    // 🔴 A SITE'S PARENT ACCOUNT IS ALSO AUTHORITY, not topology.
    //
    // crew_assignments (Increment 6) is the tamper-proof source for WHO is assigned to
    // WHAT — but getAssignedScope expands an assigned CLIENT into all of its sites by
    // reading `sites[].clientId` out of this blob, which is browser-writable until 1e.
    // Its comment calls that "safe to read for topology"; it is not. A crew user
    // assigned to account X could re-parent any other account's site to X and pull it
    // into their own scope, which gates decrypted door/alarm code reveal
    // (authz.js requireSiteAssignment) and QC visibility. The assignment moved to the
    // tamper-proof table; the EXPANSION still ran through a field the attacker controls.
    //
    // Protecting the parent link closes that without a schema change: crew have no
    // legitimate reason to re-parent a site, and managers keep the ability, so this
    // costs no real workflow. (The durable fix is a sites table or materialising the
    // expansion into crew_assignments at sync time — logged in LOOP_REVIEW.)
    const beforeSites = byId(prev?.sites);
    for (const [id, a] of byId(next?.sites)) {
      const b = beforeSites.get(id);
      if (b && norm(b.clientId) !== norm(a.clientId)) {
        violations.push('move a site to a different account');
        break;
      }
    }

    // 🔴 A LOCATION'S MANAGER (client.supervisorId) IS AUTHORITY, not data (MTA W1-G).
    //
    // supervisorId assigns which manager oversees a customer — it decides scope() for time
    // approval (who may approve / correct / void that customer's punches and approve its
    // overtime, spec §2), so setting, changing or clearing it is authority. Owner/admin ONLY
    // by the role list (never a key): a manager holding clients.edit / ops.edit / time.config
    // — all theirs by default — must not assign themselves a location. ServiceSetupCard and
    // SupervisedCustomersCard disable it for everyone else with the reason; the fingerprint's
    // `supervisors` projection makes a supervisor-only save move the digest so this fires.
    // ⚠️ ONE OTHER WAY THROUGH (S131, Daniel 2026-10-14: "an OM moves buildings between their
    // AMs"): an OPERATIONS MANAGER holding ops.edit may change a building's supervisor from one
    // member of their team to another — themselves included — and nowhere else: never from or to
    // someone off the team, never to nobody. The team is the COMMITTED one (prev), so a save cannot
    // pull an account manager onto the team and move a building to them at once; the OM-ness is the
    // claim role (`role`) plus the committed roster's level (lib/teamScope isOpsManagerIn). The
    // building was already in the OM's scope through the AM, so the move widens nobody.
    const omTeam = holds('ops.edit') && isOpsManagerIn(prev?.users, { id: selfId, role })
      ? new Set(teamMemberIds(prev?.users, selfId)) : null;
    const beforeClientsSup = byId(prev?.clients);
    for (const [id, a] of byId(next?.clients)) {
      const prevSup = supervisorId(beforeClientsSup.get(id));
      const nextSup = supervisorId(a);
      if (prevSup === nextSup) continue;
      if (omTeam && prevSup !== null && nextSup !== null && omTeam.has(prevSup) && omTeam.has(nextSup)) continue;
      // A CASCADE CLEAR is authority-neutral: DELETE_USER's sweepUserOrphans
      // (src/lib/deleteCascade) sets supervisorId -> null on every customer a REMOVED member
      // supervised, and a manager holding settings.team.edit may remove another manager
      // (teamLimits: only Admin/Super Admin targets carry the role floor). The removal itself
      // is guarded by the member-removal rules above, so clearing a supervisor whose row is
      // GONE from next.users must not be refused here as an assignment — or a legitimate
      // manager-removes-manager save would 403 and store/sync would drop the whole batch.
      // Setting / pointing at a real id, or clearing one whose supervisor is still on the
      // roster, stay owner/admin only. (Same spirit as the DELETE_USER userName-stamp being
      // authority-neutral in the money projections above.)
      const cascadeClear = nextSup === null && prevSup !== null && !nextUsers.has(prevSup);
      if (!cascadeClear) { violations.push("assign a location's manager"); break; }
    }
  }

  // ── time off (Sept 1) ────────────────────────────────────────────────────
  // timeOff decides who is auto-excluded from minted cleans and what the
  // scheduling warnings fire on — a crew user forging a teammate's "day off"
  // (or deleting their own recorded absence) rewrites who works, which is
  // scheduling authority, not a data edit. The UI books it on Team › Time off
  // (settings.team.edit) and HR › PTO (hr.edit); the server agrees with THE SAME
  // committed matrix + per-user overrides. The owner+admin role list alone predated
  // the 4th-tier `manager` role — which holds both keys by default — so every
  // manager's call-out was rejected on save and never reached Reports › Called out
  // (2026-09-22). Owner+admin still pass as before; nothing is tightened.
  // Compared with key order ignored (jsonb reorders keys; S77 review).
  const mayBookTimeOff = can(MANAGER) || holds('settings.team.edit') || holds('hr.edit');
  if (!mayBookTimeOff && !jsonEq(prev?.timeOff ?? [], next?.timeOff ?? [])) {
    violations.push('change time off');
  }

  // ── customers are ARCHIVED, never deleted (CS-663 / CS-027) ───────────────────────────────
  // Matt, kickoff 2026-09-10: "Never delete customers — reactivating a former customer keeps the
  // same ID." The app no longer has a customer delete (ARCHIVE_CLIENT replaced it), so a save that
  // REMOVES a customer row is refused for EVERYONE, the Super Admin included: it can only be a
  // crafted save or a bug, and what it would orphan — the contract still in the book, the open
  // requests still escalating, the documents, messages, hub logins and inspections keyed to a
  // customer that no longer exists — is exactly what CS-663 found. (Until 2026-10-13 a holder of
  // clients.delete could remove one here; the guard's first data-integrity check, 2026-09-23.)
  {
    const nextClientIds = new Set(byId(next?.clients).keys());
    for (const id of byId(prev?.clients).keys()) {
      if (!nextClientIds.has(id)) { violations.push('remove a customer'); break; }
    }
  }
  // ── ARCHIVING or RESTORING one is `clients.delete`'s ("Archive customers") ──
  // The archive takes a customer out of every working surface and cuts its customer logins off,
  // so it stays the capability the delete was: the Super Admin by role, everyone else by the
  // COMMITTED matrix + overrides — as the customer page and the Customers bulk bar gate it. The
  // archive state is one tuple (lib/customerStatus archiveTuple: archived?, archivedAt, archivedBy,
  // statusBeforeArchive), so its stamps cannot be rewritten as ordinary data either; a NEW customer
  // created already archived counts too. Editing an archived customer's other fields stays data.
  if (!can(OWNER) && !holds('clients.delete')) {
    const before = byId(prev?.clients);
    for (const [id, after] of byId(next?.clients)) {
      if (!jsonEq(archiveTuple(before.get(id) || null), archiveTuple(after))) {
        violations.push('archive or restore a customer');
        break;
      }
    }
  }

  // ── adding customers and contacts, and a contact's details (2026-10-03) ──────────────────
  // Customers → Import customers brings in Matt's ~750 buildings, gated on "Create / edit
  // customers" and, for its contacts, "Create / edit contacts" — as Add customer and Add contact
  // are. Until now both were ordinary data any office login could POST, so the Roles page did not
  // bind them (CS-622 named the contacts half). The Super Admin passes by role; everyone else by
  // the COMMITTED matrix + overrides, as the money rules above. Editing a customer's other fields
  // stays ordinary data (each card has its own key: Service setup, supplies, billing…).
  if (!can(OWNER)) {
    const prevClients = byId(prev?.clients);
    if ([...byId(next?.clients).keys()].some((id) => !prevClients.has(id)) && !holds('clients.edit')) {
      violations.push('add a customer');
    }
    const { added, changed } = contactPeopleDelta(prev, next);
    if (added && !holds('contacts.edit')) violations.push('add a contact');
    if (changed && !holds('contacts.edit')) violations.push("change a contact's details");
  }

  // ── supplies: a building's budget and order day (SUP-7 / SUP-8) ──
  // (The request state machine and who may decide or cancel moved to /api/supplies with SUP-13.)
  {
    // The BUDGET is money the office commits to per building, and the order day decides when
    // its supervisor is chased — both are the supply module's, so they take its fulfil key
    // (owner/admin by role, as everywhere here). Only the Supplies card writes them, so an
    // ordinary customer save re-sends them unchanged and is never refused.
    if (!can(OWNER) && !holds('supplies.manage')) {
      const prevClients = byId(prev?.clients);
      for (const [id, after] of byId(next?.clients)) {
        const before = prevClients.get(id);
        if (!before) continue; // a NEW customer carries no supply history; creating one is ordinary data
        if (!jsonEq(canonical(supplySettings(before)), canonical(supplySettings(after)))) {
          violations.push("change a building's supply budget");
          break;
        }
      }
    }
  }

  // ── your OWN pay line is a Super Admin's (MTA W1-G, 2026-09-27) ──────────────
  // Adding, changing or removing a payroll line for YOURSELF is owner-only, every category
  // (bonus, tip, special, reimbursement, deduction) — a reimbursement / bonus typed straight
  // onto your own row was the way around HR's own-approval rule (spec §8.6). This SUPERSEDES
  // the 2026-09-23 "no self-line carve-out" call for a non-owner: admin is refused too, so
  // this check sits ABOVE the owner+admin payroll block below (only role owner passes). The
  // money projection keeps a DELETE_USER userName stamp authority-neutral.
  if (!can(OWNER) && ownPayrollLineChanged(prev, next, selfId)) {
    violations.push('add or change your own pay line');
  }

  // ── payroll lines (money) ───────────────────────────────────────────────────
  // A payroll line pays out on the pay run (src/lib/payroll grossForUser prices amount
  // by category), so adding / editing / removing one is money, not data. The app gates
  // line entry on payroll.edit (the Payroll drawer, every category) EXCEPT the two HR
  // categories — 'special' (HR › Special services) and 'reimbursement' (approving a
  // reimbursement) — which gate on hr.edit. The server agrees: owner/admin by role,
  // else payroll.edit for any line, or hr.edit when every line whose money changed is a
  // special / reimbursement one (so an hr.edit-only approver isn't refused the pay line
  // its approval mints). The owner's call (2026-09-23): a payroll.edit holder may add
  // their OWN line too — no self-line carve-out; that is what the permission is for, and
  // revoking payroll.edit is how you stop it. A userName-only stamp nets to no change.
  // CS-003 (2026-10-03): an ADMIN needs the key too (the Payroll screen gates them on it, and
  // by Q24 they hold no payroll key by default); only the Super Admin passes by role.
  if (!can(OWNER)) {
    const cats = changedPayrollCategories(prev, next);
    if (cats.length && !(holds('payroll.edit')
      || (cats.every((c) => c === 'special' || c === 'reimbursement') && holds('hr.edit')))) {
      violations.push('add or change a payroll line');
    }
  }

  // ── reimbursements (money) ──────────────────────────────────────────────────
  // Reimbursements are an HR feature (HR › Reimbursements, hr.edit): submit / edit /
  // reject / delete. Approving one ADDS a reimbursement payroll line (money out), so
  // approving your OWN is OWNER-ONLY (MTA W1-G, 2026-09-27; was owner/admin) — a manager or
  // admin may submit their own but not approve it. Because the own-approval floor is now
  // owner-only while others' approvals stay owner/admin+hr.edit, the own check sits ABOVE the
  // owner+admin block. Others' approvals and every other reimbursement edit need hr.edit. A
  // userName stamp (DELETE_USER) nets to no change; the money itself is the payroll line
  // above, judged in its own right, so an id-less forged reimbursement pays nothing.
  let ownReimbApproval = false;
  if (!can(OWNER)) {
    const rprev = byId(prev?.reimbursements);
    for (const [, a] of byId(next?.reimbursements)) {
      const b = rprev.get(a.id);
      if (a?.status === 'approved' && b?.status !== 'approved' && a?.userId === selfId) { ownReimbApproval = true; break; }
    }
    if (ownReimbApproval) violations.push('approve your own reimbursement');
  }
  // CS-003: hr.edit for an ADMIN too (the Reimbursements tab gates every role on it).
  if (!can(OWNER) && !ownReimbApproval && reimbursementsMoneyChanged(prev, next) && !holds('hr.edit')) {
    violations.push('change a reimbursement');
  }

  // ── invoices + their payments (money) — CS-003, 2026-10-03 ────────────────────────
  // Unguarded until now, and outside the fingerprint, so an invoice-only save never even
  // reached this function. The rules are invoiceViolations' (above), keyed to what the
  // Invoices screens gate on; the Super Admin passes by role.
  violations.push(...invoiceViolations(prev, next, { isOwner: can(OWNER), holds }));

  // ── operations settings: the pay-run config AND the geofence / variance / alert knobs ──
  // The whole Operations page is gated on time.config (owner + admin + manager). The
  // pay-run config (otMultiplier scales OT, payPeriodCadence / payWeekStartDay set the
  // pay periods, payDriveTime toggles paid drive time) is money (II.8); the geofence
  // radius and variance thresholds decide every clock-in verdict and who is flagged late,
  // so a crafted crew save loosening them games attendance. One UI gate, so the server
  // agrees for the whole slice: owner/admin by role, else time.config (2026-09-23 — was
  // the pay-run projection only in S90). Two screens write opsSettings, both through
  // UPDATE_OPS_SETTINGS and both behind time.config: the Operations page, and the QR codes
  // panel on a location's Cleaning instructions card, whose label-sheet picker remembers
  // `scanLabelFormat` for the whole office (UI_RULES §139). Any other save re-sends the slice
  // unchanged and is never refused here; compared key-order-insensitively (jsonb reorders keys).
  // ⚠️ ONE EXCEPTION — the DELETE_USER cascade clear (ALR-4, 2026-09-29), the same shape
  // `clients[].supervisorId` already has: `sweepUserOrphans` nulls
  // `opsSettings.operationsManagerUserId` when that member is the one being REMOVED, and a
  // manager may remove another member (`teamLimits`), so a clear whose previous holder is GONE
  // from `next.users` is authority-neutral — else a member removal by a `settings.team.edit`
  // holder pared off `time.config` would 403 and DROP THE WHOLE pending batch. Only that field,
  // only to null, and only for a departing member: setting or re-pointing it, or clearing one
  // who is still on the roster, stays `time.config`'s.
  if (!can(MANAGER) && !holds('time.config')
    && !jsonEq(prev?.opsSettings ?? null, next?.opsSettings ?? null)
    && !opsManagerCascadeClearOnly(prev, next)) {
    violations.push('change operations settings');
  }

  // ── closed payroll periods + the pay schedule are frozen for EVERYONE (MTA W2-L §2/§5.2) ──
  // A pay line whose periodKey is a CLOSED run's period_key (add / change / remove), and the
  // pay cadence / pay-week start once ANY run exists, are refused for every caller, the owner
  // included: that run already priced those weeks (a later change is paid as arrears on the
  // NEXT run, never by rewriting a closed one). The route reads payroll_runs only when
  // payrollLedgerFactNeeded is true and passes it as facts.payrollRuns; a read that FAILED
  // (null / { ok:false }) fails closed. An ABSENT fact (undefined — a save in a no-run world,
  // or a unit test) leaves the rule silent: there is nothing closed to protect. The money
  // projection keeps a DELETE_USER userName stamp neutral (changedPayrollLinePeriodKeys).
  const closedLineKeys = changedPayrollLinePeriodKeys(prev, next);
  const scheduleMoved = payScheduleChanged(prev, next);
  if (closedLineKeys.size || scheduleMoved) {
    const rf = facts?.payrollRuns;
    if (rf === null || rf?.ok === false) {
      violations.push('change pay while the payroll records are unavailable');
    } else if (rf && rf.ok) {
      const closed = new Set(Array.isArray(rf.periodKeys) ? rf.periodKeys : []);
      for (const pk of closedLineKeys) { if (closed.has(pk)) { violations.push('change pay in a closed payroll period'); break; } }
      if (scheduleMoved && (rf.anyRun || closed.size > 0)) violations.push('change the pay schedule after a payroll is closed');
    }
  }

  return [...new Set(violations)];
}

// The ids of committed members a proposed state drops (compared by id, as the removal
// check above compares them). The route reads the pay facts only when this is non-empty:
// removals are rare, and the pay slices are not on the protected read.
export function removedMemberIds(prev, next) {
  const after = byId(next?.users);
  return [...byId(prev?.users).keys()].filter((id) => !after.has(id));
}

// The slices this guard needs from the committed state, projected out of the
// 843 KB blob. Measured at ~314 KB / ~410 ms — sites+clients are the bulk, and
// that is far too expensive to pay on a 600 ms-debounced save path.
export const PROTECTED_SELECT =
  'version,users:state->users,permissions:state->permissions,'
  + 'userPermissionOverrides:state->userPermissionOverrides,'
  + 'sites:state->sites,clients:state->clients,company:state->company,'
  + 'timeOff:state->timeOff,payrollLines:state->payrollLines,'
  + 'reimbursements:state->reimbursements,opsSettings:state->opsSettings,'
  // The two RETIRED supply slices (SUP-13): read only so a save that moved them can be put back
  // to the committed value (restoreRetiredSlices). Tiny until --strip, absent after it.
  + 'supplyItems:state->supplyItems,supplyRequests:state->supplyRequests,'
  // `invoices` (CS-003): the money check judges a change against the COMMITTED invoice. Paid
  // only when an invoice's money projection moved (an invoice saved, a payment recorded), which
  // is human-paced; a note or the cron's overdue stamp stays off this read.
  + 'invoices:state->invoices,'
  // `contacts` (2026-10-03): adding one, or changing a contact's details, is judged against the
  // committed contacts. Paid only when a contact's details or the customer list moved (a person
  // added or edited, a customer created or removed) — never for a flag, a tag or a note.
  + 'contacts:state->contacts';

/**
 * A stable CRYPTOGRAPHIC (SHA-256) digest of every authority-bearing field,
 * computed from a state the server already holds in memory — so it costs one
 * pass over the object and no database read.
 *
 * THIS IS WHAT MAKES THE GUARD AFFORDABLE. Authority fields change rarely (a
 * role assignment, a crew re-assignment) while saves happen constantly, so the
 * endpoint compares this digest against the one stored on the last commit:
 *   same  -> nothing authority-bearing moved, allow with NO extra read
 *   differ -> something did, pay the 314 KB read once and check who may
 *
 * Deliberately covers only what protectedFieldViolations inspects. If you add a
 * check there, add its input here or the guard silently stops firing — the
 * failure mode is an authority change sliding through as "unchanged".
 *
 * A member's `email` IS covered (2026-09-23): a login with no role claim (every
 * manager's, before claims.js knew the role) is matched to its row by email, so
 * re-pointing one is an authority change.
 * Before, a save that changed only another member's email skipped the guard, and a
 * manager could set the owner row's email to their own and run as a Super Admin.
 * The MONEY slices are covered too (HANDOFF S87; invoices and their payments since CS-003):
 * the money projection of every payroll line, reimbursement and invoice, plus the pay-run
 * knobs in opsSettings — a projection, so a
 * userName stamp on a removed member's kept row is authority-neutral and does not force
 * the read. Before, a crafted save adding a $5,000 bonus line, approving one's own
 * reimbursement, or setting the OT multiplier to 5 committed with NO guard run.
 * The row tuple covers exactly the AUTHORITY / MONEY fields protectedFieldViolations judges:
 * id, role, status, email, pay, hr, disabledAt and clockRules (2026-09-27 — the per-cleaner
 * checklist-block / geofence exemption), and on a row carrying them managerLevel / opsManagerId
 * (S131 — an Operations Manager's team).
 * ⚠️ STILL NOT COVERED: a member's COSMETIC fields (name, phone, notification + signature
 * prefs) are left out so an Account-page save stays off the 314 KB read, which means the
 * "another member's profile" check fires for them only when something else in the same save
 * moved the digest. Known, deliberate gap, HANDOFF S77. (Until 2026-09-27 this note also
 * said pay and hr were out and your own were unchecked — both stale since 2026-09-23, when
 * the tuple gained them; the check for them is live.)
 */
export function protectedFingerprint(state) {
  // clockRules (2026-09-27, checklists step 4b) turns the clock-out checklist block and the
  // clock-in geofence off for one person, so protectedFieldViolations gates it — and a check
  // without its fingerprint input SILENTLY STOPS FIRING, which is the failure mode this whole
  // function exists to prevent. canonical, because jsonb hands its two keys back in its own
  // order and a reorder is not a change.
  // managerLevel / opsManagerId (S131, the Operations Manager's team) join the tuple ONLY for a
  // row carrying either, so a roster that carries neither digests exactly as before — no
  // org_state.baseline_mismatch on the deploy (test-ops-manager-guard.mjs pins the golden digest).
  const users = (Array.isArray(state?.users) ? state.users : [])
    .map((u) => {
      const tuple = [u?.id, u?.role, u?.status, u?.email ?? null, canonical(u?.pay ?? null), canonical(u?.hr ?? null),
        u?.disabledAt ?? null, canonical(u?.clockRules ?? null)];
      return (u?.managerLevel != null || u?.opsManagerId != null)
        ? [...tuple, u?.managerLevel ?? null, u?.opsManagerId ?? null] : tuple;
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  // Only entities that actually CARRY an assignment. A site or account with no
  // standing crew grants no authority, so creating or deleting one is
  // authority-neutral and must not force the expensive read — and creating
  // records is a common operation. An entity gaining its first assignment, or
  // losing its last, still changes this set, which is what the guard needs.
  const assign = (arr) => (Array.isArray(arr) ? arr : [])
    .map((x) => [x?.id, crewSet(x)])
    .filter(([, ids]) => ids !== '[]')
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // Site -> account parentage. Required because protectedFieldViolations now checks it:
  // getAssignedScope expands an assigned CLIENT into all of its sites via this link, so
  // re-parenting a site is an authority change. Per the note above, a check without its
  // fingerprint input means the guard SILENTLY STOPS FIRING — the failure mode being
  // that an authority change slides through as "nothing moved".
  const parentage = (Array.isArray(state?.sites) ? state.sites : [])
    .map((s) => [s?.id, s?.clientId ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // Customer (account) EXISTENCE. protectedFieldViolations refuses a customer REMOVAL from
  // everyone (CS-663: archived, never deleted), so a removal must move the digest or
  // the guard silently stops firing — the failure mode this whole function exists to
  // prevent. assign(clients) above only lists crew-BEARING accounts, so it does not
  // move when a crew-less customer is removed; this id set does. A snapshot digest
  // can't tell a removal from an addition, so a customer CREATE moves it too and pays
  // one deep read — accepted: customers are created far less often than the job / note
  // / status saves the fast path protects, and a CSV import is a single save.
  // CS-663: a customer carrying archive state is [id, archiveTuple] instead of its bare id, so an
  // archive or a restore moves the digest (the guard's archive rule then runs) while a book with
  // nothing archived digests exactly as before — no stored digest changes with this deploy.
  const clientIds = (Array.isArray(state?.clients) ? state.clients : [])
    .map((c) => (carriesArchiveState(c) ? [c?.id ?? null, archiveTuple(c)] : (c?.id ?? null)))
    .sort((a, b) => String(Array.isArray(a) ? a[0] : a).localeCompare(String(Array.isArray(b) ? b[0] : b)));

  // Customer -> assigned manager (client.supervisorId). protectedFieldViolations now refuses a
  // supervisor set / change / clear from anyone but owner/admin, so a save that changes ONLY a
  // supervisor must move the digest or the guard SILENTLY STOPS FIRING (this function's whole
  // reason to exist). '' and a missing field normalize to null (supervisorId()), so an ordinary
  // save that never touches a supervisor stays off the deep read.
  const supervisors = (Array.isArray(state?.clients) ? state.clients : [])
    .map((c) => [c?.id ?? null, supervisorId(c)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // Keys sorted (canonical), because the same content arrives in two key orders: a
  // browser sends canonicalJson (keys sorted) and jsonb hands a read back shortest key
  // first. With a plain stringify, the digest of the committed state never equalled
  // the one stored from the browser's body once userPermissionOverrides or timeOff had
  // rows, so the org-state route's baseline alarm fired on legitimate saves, and a digest
  // a server writer computes from a read (writeOrgState) could never match a browser's. canonical
  // sorts keys the same way as canonicalJson (and, like it, keeps an own "__proto__" key),
  // so a digest stored from a browser's body is the same string as before (2026-09-23).
  const payload = canonical([
    users,
    state?.permissions ?? null,
    state?.userPermissionOverrides ?? null,
    assign(state?.sites),
    assign(state?.clients),
    clientIds,
    parentage,
    // company.timezone is now authority-bearing (protectedFieldViolations checks
    // it). A check without its fingerprint input SILENTLY STOPS FIRING — the
    // failure mode being a zone flip sliding through as "nothing moved".
    state?.company?.timezone ?? null,
    // timeOff (Sept 1): decides mint-time exclusions + scheduling warnings —
    // same contract: check added above, so its input must be here.
    state?.timeOff ?? null,
    // Money slices (HANDOFF S87): a payroll line pays out, a reimbursement approval mints
    // one. protectedFieldViolations now judges each, so its input belongs here or the
    // guard silently stops firing. MONEY projections only, keyed the same as the checks:
    // a userName stamp on a removed member's kept line/reimbursement nets to nothing, so a
    // removal (which already moves the digest via users[]) does not pay a second read, and
    // an ordinary save that touches none of these stays off the deep read.
    moneyList(state?.payrollLines, payLineMoney),
    moneyList(state?.reimbursements, reimbMoney),
    // opsSettings WHOLE (2026-09-23): the pay-run config + geofence / variance / alert
    // knobs are one time.config-gated slice, so the guard covers all of it; canonical so
    // jsonb key order never false-alarms. Only Operations writes it (rare), so the deep
    // read it can force is not on the hot path.
    canonical(state?.opsSettings ?? null),
    // A location's manager (MTA W1-G): protectedFieldViolations refuses a non-owner/admin
    // supervisor change, so its input must be here or the guard silently stops firing. A
    // customer create/rename with no supervisor keeps every entry null, so it stays off the
    // deep read (the clientIds set above already moves the digest on a create/delete).
    supervisors,
    // (Here sat the `reviews` slice, the Reviews page's Indeed count (MISC-4); it left with
    // Google reviews on 2026-10-20. Dropping a position changes every digest: the first save per
    // org after that deploy takes the full check and raises ONE org_state.baseline_mismatch
    // alert, then the commit heals the stored digest, as the additions below did.)
    // SUP-13 (2026-10-05): the RETIRED supply slices, WHOLE — a save that changes them in either
    // direction must reach the deep read, where restoreRetiredSlices puts them back. A save that
    // leaves them as committed stays on the fast path. (Until SUP-13 this position held the
    // request projection the state-machine check judged; that check moved to /api/supplies.)
    retiredSlicesInput(state),
    // SUP-7 (Matt, 2026-09-29): the monthly budget and order day are judged by
    // protectedFieldViolations, so their input belongs here or the guard SILENTLY STOPS FIRING.
    // A PROJECTION: a customer's name / address / tags are not in it.
    supplyClientSettings(state?.clients),
    // INVOICES + their payments (CS-003): protectedFieldViolations judges both now, so their input
    // belongs here or the guard SILENTLY STOPS FIRING — and it did: with no invoice input, a save
    // changing only an invoice matched the stored digest and committed with no guard run at all.
    // The MONEY projection (invoiceMoney), so a note, a PO number, a job delete pruning `jobIds` or
    // the cron's `overdueNotifiedAt` stamp stays off the deep read. Appended LAST (positional).
    // ⚠️ Adding it changes every digest: the first save per org after the deploy takes the full
    // check and raises one org_state.baseline_mismatch alert, then the commit heals the stored
    // digest — the same one-time cost the MISC-4 and SUP-1 additions paid.
    moneyList(state?.invoices, invoiceMoney),
    // A CONTACT's details (2026-10-03): protectedFieldViolations judges adding one and changing
    // one now, so the input belongs here or the guard SILENTLY STOPS FIRING. The contactPerson
    // projection, so a do-not-contact flag, a tag, a note or a timestamp stays off the deep read.
    // Appended LAST (positional); like the invoices addition, the first save after the deploy
    // raises ONE org_state.baseline_mismatch alert, then the commit heals the stored digest.
    (Array.isArray(state?.contacts) ? state.contacts : []).map(contactPerson)
      .sort((a, b) => String(a && a[0]).localeCompare(String(b && b[0]))),
  ]);
  // CRYPTOGRAPHIC (SHA-256), and it has to be. This digest is NOT a mere change
  // detector: the write endpoint SKIPS the field-authorization guard entirely when a
  // save's digest equals the one stored on the last commit (api/state/org-state.js
  // `authorityChanged`), so its collision-resistance is a security boundary. `payload`
  // is a pure function of blob fields any authenticated login can read (org_state
  // SELECT is open) and carries free-form strings (emails, permission ids), so a weak
  // digest is forgeable: the previous FNV-1a + 32-bit multiplicative pair (64 bits of
  // state + a length tag, both halves invertible) let a crew or claim-less-manager save
  // carrying a forged matrix, role, status or email collide with the stored digest in
  // an estimated ~2^32 work (meet-in-the-middle) and slide through with NO guard run
  // (HANDOFF S84). SHA-256 makes a second preimage infeasible. The authorization
  // DECISION is still always made from the real values in protectedFieldViolations,
  // never from this digest. NOTE the format changed (64-char hex, was base36:len), and
  // the two formats are disjoint so they can never compare equal: until the first
  // post-deploy save rewrites the stored column, each pre-heal save fails closed to the
  // full check and raises one org_state.baseline_mismatch alert (a brief burst if tabs
  // save concurrently at deploy), then the first commit heals it (as S77's format did).
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
