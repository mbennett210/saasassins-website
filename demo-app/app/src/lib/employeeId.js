// THE EMPLOYEE ID — the number the payroll company matches a person on (PAY-9, Matt
// 2026-09-29: "Put each person's payroll-system employee ID in the file? — Yes"), and the
// rule that keeps it UNIQUE per person (CS-229).
//
// It lives on `user.hr.employeeId`, is minted `EMP-####` when a member is added, and HR may
// overwrite it to match the payroll system. Two things depended on it and neither existed:
//   · CS-382 — neither payroll file carried it, so the payroll company matched people BY
//     NAME and one collision or spelling difference mis-pays someone;
//   · CS-229 — nothing stopped two people sharing an ID, which is worse than no ID at all:
//     the import silently pays one person twice and the other nothing.
//
// Pure / node-safe (no React, no store, no browser globals, no imports): the app, the demo
// and the org_state guard all read these, so the app's refusal and the server's cannot drift.

// The id as stored, trimmed. '' for a member who has none — which is a NORMAL state (a
// member added before the mint, or one the office has not filed yet), never a warning.
export function employeeIdOf(user) {
  const v = user?.hr?.employeeId;
  return typeof v === 'string' ? v.trim() : '';
}

// The comparison key. Case- and space-insensitive, because "emp-0007" and "EMP-0007" are the
// same number to a human and to a payroll clerk retyping it, and a duplicate that differs
// only in case is exactly the collision this rule exists to stop. An EMPTY id is not a
// collision — several members may legitimately have none.
export function employeeIdKey(value) {
  return (typeof value === 'string' ? value : '').trim().toLowerCase();
}

// Who else already holds this id? Returns that user, or null. `selfId` is the member being
// edited (or null for a brand-new one), so re-saving a member's own unchanged id is never a
// duplicate.
export function employeeIdOwner(users, value, selfId = null) {
  const key = employeeIdKey(value);
  if (!key) return null;
  for (const u of Array.isArray(users) ? users : []) {
    if (!u || u.id === selfId) continue;
    if (employeeIdKey(employeeIdOf(u)) === key) return u;
  }
  return null;
}

// The refusal sentence for a duplicate, naming who holds it — a bare "already in use" leaves
// the office hunting the roster. null when the id is free (or empty).
export function employeeIdRefusal(users, value, selfId = null) {
  const owner = employeeIdOwner(users, value, selfId);
  if (!owner) return null;
  return `Employee ID ${employeeIdOf(owner) || value} already belongs to ${owner.name || 'another member'}.`;
}

// The next auto id: max existing EMP-#### + 1, zero-padded to 4. Lives here, next to the
// uniqueness rule, so the MINT and the CHECK can never disagree about the format (it used to
// be a private function inside AddUserModal).
export function nextEmployeeId(users) {
  let max = 0;
  for (const u of Array.isArray(users) ? users : []) {
    const m = /^EMP-(\d+)$/.exec(employeeIdOf(u));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `EMP-${String(max + 1).padStart(4, '0')}`;
}

// How many members hold each id, keyed by comparison key. Members with NO id are not counted
// (they are not duplicates of each other).
export function employeeIdCounts(users) {
  const seen = new Map();
  for (const u of Array.isArray(users) ? users : []) {
    const key = employeeIdKey(employeeIdOf(u));
    if (!key) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return seen;
}

// Every id a roster uses more than once, as comparison keys — the office-facing read for a
// roster that already holds duplicates (nothing prevented them before CS-229), so they can be
// found and fixed rather than discovered by a mis-payment.
export function duplicateEmployeeIds(users) {
  return [...employeeIdCounts(users).entries()].filter(([, n]) => n > 1).map(([key]) => key);
}

// The ids a save makes WORSE: any id now held by two or more people, by MORE people than the
// committed roster had. Counts, not just keys — a roster that already holds a duplicate is not
// this caller's to repair (refusing it would wedge every save), but they must not add a third
// person to it either, which a key-only comparison would have waved through.
export function worsenedEmployeeIds(prevUsers, nextUsers) {
  const before = employeeIdCounts(prevUsers);
  const out = [];
  for (const [key, n] of employeeIdCounts(nextUsers)) {
    if (n > 1 && n > (before.get(key) || 0)) out.push(key);
  }
  return out;
}
