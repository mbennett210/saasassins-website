// A NEW CLEANER SET UP IN ONE STEP: what Add Team Member's crew fields save (task #470 from Clean
// Corner's queue, the 2026-11-03 call; Daniel's picks 2026-11-03: the pay is a pay type and its rate,
// only a Crew member gets them, and the Access is "B · Crew's switches up front").
// Three things a cleaner's own page already holds, now set as they are added:
//   · Works at   → `users[].worksAt`, the link the Profile tab and the Team import keep (lib/worksAt;
//                  it grants nothing, the schedule still decides what they see);
//   · pay        → `users[].pay`, a type from lib/payTypes and its rate, as the Pay tab writes it;
//   · Access     → the member's permission override row, written key by key by the ONE rule the
//                  Access and Time tabs use (lib/roles overrideForEffective): every permission the
//                  crew column holds is a switch, and any other the caller holds can be given.
// The screen offers pay only with payroll.rates.edit and Access only with staff.editOverrides; the
// server (api/_lib/orgStateGuard) holds a new member's pay, worksAt and override rows to the same keys,
// and refuses a key given by a caller who doesn't hold it (CS-331). Pure and node-safe:
// components/AddUserModal and scripts/test-add-member-setup.mjs read it.
import { worksAtOf } from './worksAt.js';
import { ALWAYS_GRANTED, OWNER_ONLY, PERMISSIONS, PERM_GROUPS, columnHolds, overrideForEffective } from './roles.js';
import { payTypeOf } from './payTypes.js';

// The permissions a new member's Access can change, in the Roles page's order (PERM_GROUPS): every
// key but the four everyone always has (ALWAYS_GRANTED) and the Super Admin's own (OWNER_ONLY).
export const ACCESS_KEYS = Object.freeze(PERM_GROUPS.flatMap((g) => g.keys)
  .filter((k) => PERMISSIONS[k] && !ALWAYS_GRANTED.has(k) && !OWNER_ONLY.has(k)));
const CREW = { role: 'crew' };
const crewHas = (key, permissions) => columnHolds(CREW, key, permissions);

// The switches a new cleaner's Access starts with, all on: what the crew column of the saved matrix
// holds (with the schema default for a key the matrix doesn't carry yet), as can() reads it.
export const crewAccessKeys = (permissions) => ACCESS_KEYS.filter((k) => crewHas(k, permissions));

// What "Give another permission" offers: the keys the crew column lacks that the caller may give
// (`mayGrant(key)`, lib/roles canGrantPermission: they hold it themselves, CS-331). Offer only what
// the save accepts (UI_RULES §118).
export const giveChoices = ({ permissions, mayGrant = () => false } = {}) => ACCESS_KEYS
  .filter((k) => !crewHas(k, permissions) && mayGrant(k));

// A rate as typed: '' is none typed (null), a number of dollars ≥ 0 is kept to the cent, anything
// else is NaN, refused.
export function readRate(raw) {
  const s = String(raw ?? '').trim().replace(/^\$\s*/, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100) / 100;
}

export const RATE_ERROR = 'Enter the rate as a number of dollars, like 17.50.';

// The fields the new member's ADD_USER carries: { fields, error }. Only a Crew member gets any.
// Pay only for a caller who may set it (`canSetPay`), and only when there is something to save:
// "Not on payroll", or a type with its rate typed (a blank rate saves no pay, so nothing is claimed).
export function newMemberFields({ role, worksAt, payType, payRate, canSetPay = false } = {}) {
  const fields = {};
  if (role !== 'crew') return { fields, error: null };
  const ids = worksAtOf({ worksAt });
  if (ids.length) fields.worksAt = ids;
  const type = canSetPay ? payTypeOf(payType) : null;
  if (type && !type.field) fields.pay = { type: type.value };
  else if (type) {
    const rate = readRate(payRate);
    if (Number.isNaN(rate)) return { fields: {}, error: RATE_ERROR };
    if (rate !== null) fields.pay = { type: type.value, [type.field]: rate };
  }
  return { fields, error: null };
}

const sameList = (a, b) => a.length === b.length && a.every((k) => b.includes(k));

// The override row to save for the Access, or null when there's nothing to save. `access` is
// { [key]: on } for the switches the office set (a key left out is as the crew column gives it);
// `existing` is the row already on file for the member's id (an adopted login can have one). The
// Access is the caller's only with `canSetAccess`; a key turned ON where the crew column lacks it
// needs `mayGrant(key)` (the caller holds it, CS-331), else that key alone is left out. Keys outside
// ACCESS_KEYS are never written.
export function newMemberOverride({ role, access, permissions, existing = null, canSetAccess = false, mayGrant = () => false } = {}) {
  if (role !== 'crew' || !canSetAccess || !access || typeof access !== 'object') return null;
  const start = {
    grants: Array.isArray(existing?.grants) ? existing.grants : [],
    revokes: Array.isArray(existing?.revokes) ? existing.revokes : [],
  };
  let next = start;
  for (const key of ACCESS_KEYS) {
    const on = access[key];
    if (typeof on !== 'boolean') continue;
    const roleHas = crewHas(key, permissions);
    if (on && !roleHas && !mayGrant(key)) continue;
    next = overrideForEffective({ grants: next.grants, revokes: next.revokes, key, roleHas, on });
  }
  return sameList(next.grants, start.grants) && sameList(next.revokes, start.revokes) ? null : next;
}
