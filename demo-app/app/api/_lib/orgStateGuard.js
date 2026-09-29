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
// the real boundary, and the direct-write fallback in store/sync.js fails RLS and
// retries through here. Where it is not applied, the browser can still write
// around this check. Whether it is applied is a fact of the live database, not of
// this repo.
//
// DESIGN: deny by exception, not by allowlist. The blob has ~47 slices and most
// are ordinary business data any authenticated user legitimately edits (jobs,
// clients, notes...). Enumerating those would be a maintenance trap that fails
// OPEN on every new slice. Instead we name the small set of fields that confer
// AUTHORITY and check only those — a new slice is unprotected by default, which
// is the correct default for data but must never be true for authority. If you
// add an authority-bearing field, add it here.

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
import { canEndAccess, canReduceRole, can as roleCan, ROLES, PERMISSIONS } from '../../src/lib/roles.js';
import { matrixForCan, overridesForCan } from './permissionSlices.js';
import { matrixAuthority, owedPayFor } from './teamAuthority.js';

const OWNER = ['owner'];
const MANAGER = ['owner', 'admin'];
// The OFFICE tiers, manager included. Distinct from MANAGER above, whose name predates the
// 4th tier and still means owner+admin only. Used where a rule needs a ROLE floor no grant
// can cross: can() puts no key out of a grant's reach, so "a cleaner must not be able to do
// X" cannot be expressed as a key (the same reasoning as canEndAccess's admin+ floor).
const OFFICE = ['owner', 'admin', 'manager'];
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

// Assignment ids for one entity, order-insensitive (the UI reorders freely).
const crewSet = (x) => JSON.stringify([...new Set(Array.isArray(x?.standingCrewIds) ? x.standingCrewIds : [])].sort());

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

// The fields that differ between two versions of a member's row, other than role and
// status (checked on their own). Key order is ignored: jsonb hands a nested object's
// keys back in its own order, so a tab's copy can differ from the committed row in
// order alone. A missing field and a null one are the same, as in norm().
function changedFields(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (k === 'role' || k === 'status') continue;
    if (!jsonEq(own(before, k), own(after, k))) out.push(k);
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
 * @param facts   { removal }: what the pay rule needs about the members this save
 *                removes (memberRemoval.removalPayFacts: the committed pay slices + the
 *                time ledger). Required when removedMemberIds(prev, next) is non-empty;
 *                without it every removal is refused, since the pay check can't run.
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
  const { holds, mayGive } = matrixAuthority(prev, role, selfId);
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
        for (const r of ROLES) {
          if (roleCan({ id: null, role: r }, key, nextMatrix, null)
            && !roleCan({ id: null, role: r }, key, prevMatrix, null)
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

  // ── customer (account) removal (2026-09-23, owner's call) ──────────────────
  // Deleting a customer CASCADES in the reducer (DELETE_CLIENT) to its sites,
  // contacts, invoices, activities and jobs. The blob half of that — the client
  // row plus its sites / contacts / invoices — commits HERE; the jobs half rides
  // /api/state/jobs-delta (jobsGuard, which for anyone without schedule.edit puts
  // the job deletes back, orphaning them). EDITING a customer is ordinary business
  // data any authenticated user may do, but DELETION is a restricted capability the
  // product gates on `clients.delete` (owner/admin/manager by default): both the
  // single-record delete (ClientDetail) and the Customers bulk delete gate on it,
  // and the server now agrees — owner+admin by role (never tightened), else whoever
  // holds clients.delete in the COMMITTED matrix + overrides, by the same can() the
  // app runs. Without this a crew user with clients.view (crew hold it by default)
  // could POST a blob with a customer removed and wipe the book past the UI gate —
  // the UI is not the boundary (BUILD_INTEGRITY §1.4). Only the client ROW is
  // checked: a customer removal always drops it, and its cascade siblings ride the
  // same refused save; standalone contact / site deletion is a separate capability,
  // not gated here. This is the guard's first DATA-integrity (not authority) check —
  // deliberate, because a mass customer wipe is destructive enough to warrant a
  // server floor even though clients are otherwise ordinary data.
  if (!can(MANAGER) && !holds('clients.delete')) {
    const nextClientIds = new Set(byId(next?.clients).keys());
    for (const id of byId(prev?.clients).keys()) {
      if (!nextClientIds.has(id)) { violations.push('delete a customer'); break; }
    }
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
  if (!can(MANAGER)) {
    const cats = changedPayrollCategories(prev, next);
    if (cats.length && !(holds('payroll.edit')
      || (cats.every((c) => c === 'special' || c === 'reimbursement') && holds('hr.edit')))) {
      violations.push('add or change a payroll line');
    }
  }

  // ── reimbursements (money) ──────────────────────────────────────────────────
  // Reimbursements are an HR feature (HR › Reimbursements, hr.edit): submit / edit /
  // reject / delete. Approving one ADDS a reimbursement payroll line (money out), so
  // approving your OWN is owner/admin only (owner's call 2026-09-23) — a manager may
  // submit their own but not approve it. Others' approvals and every other reimbursement
  // edit need hr.edit. A userName stamp (DELETE_USER) nets to no change. The money itself
  // is the payroll line above, judged in its own right, so an id-less forged
  // reimbursement pays nothing on its own.
  if (!can(MANAGER)) {
    const rprev = byId(prev?.reimbursements);
    let ownApproval = false;
    for (const [, a] of byId(next?.reimbursements)) {
      const b = rprev.get(a.id);
      if (a?.status === 'approved' && b?.status !== 'approved' && a?.userId === selfId) ownApproval = true;
    }
    if (ownApproval) violations.push('approve your own reimbursement');
    else if (reimbursementsMoneyChanged(prev, next) && !holds('hr.edit')) violations.push('change a reimbursement');
  }

  // ── operations settings: the pay-run config AND the geofence / variance / alert knobs ──
  // The whole Operations page is gated on time.config (owner + admin + manager). The
  // pay-run config (otMultiplier scales OT, payPeriodCadence / payWeekStartDay set the
  // pay periods, payDriveTime toggles paid drive time) is money (II.8); the geofence
  // radius and variance thresholds decide every clock-in verdict and who is flagged late,
  // so a crafted crew save loosening them games attendance. One UI gate, so the server
  // agrees for the whole slice: owner/admin by role, else time.config (2026-09-23 — was
  // the pay-run projection only in S90). Only the Operations page writes opsSettings
  // (UPDATE_OPS_SETTINGS), so an ordinary save re-sends it unchanged and is never refused
  // here; compared key-order-insensitively (jsonb reorders keys).
  if (!can(MANAGER) && !holds('time.config') && !jsonEq(prev?.opsSettings ?? null, next?.opsSettings ?? null)) {
    violations.push('change operations settings');
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
  + 'reimbursements:state->reimbursements,opsSettings:state->opsSettings';

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
 * The MONEY slices are covered too (HANDOFF S87): the money projection of every payroll
 * line and reimbursement, plus the pay-run knobs in opsSettings — a projection, so a
 * userName stamp on a removed member's kept row is authority-neutral and does not force
 * the read. Before, a crafted save adding a $5,000 bonus line, approving one's own
 * reimbursement, or setting the OT multiplier to 5 committed with NO guard run.
 * The row tuple covers exactly the AUTHORITY / MONEY fields protectedFieldViolations judges:
 * id, role, status, email, pay, hr, disabledAt and clockRules (2026-09-27 — the per-cleaner
 * checklist-block / geofence exemption).
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
  const users = (Array.isArray(state?.users) ? state.users : [])
    .map((u) => [u?.id, u?.role, u?.status, u?.email ?? null, canonical(u?.pay ?? null), canonical(u?.hr ?? null),
      u?.disabledAt ?? null, canonical(u?.clockRules ?? null)])
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

  // Customer (account) EXISTENCE. protectedFieldViolations now refuses a customer
  // REMOVAL from anyone without clients.delete, so a delete must move the digest or
  // the guard silently stops firing — the failure mode this whole function exists to
  // prevent. assign(clients) above only lists crew-BEARING accounts, so it does not
  // move when a crew-less customer is deleted; this id set does. A snapshot digest
  // can't tell a removal from an addition, so a customer CREATE moves it too and pays
  // one deep read — accepted: customers are created far less often than the job / note
  // / status saves the fast path protects, and a CSV import is a single save.
  const clientIds = (Array.isArray(state?.clients) ? state.clients : [])
    .map((c) => c?.id ?? null)
    .sort((a, b) => String(a).localeCompare(String(b)));

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
