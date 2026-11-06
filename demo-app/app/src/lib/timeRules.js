// Shared, pure manager-time-approval rules (spec §4.1). The SAME module the server
// route (api/time/[...path].js) and the demo stubs (lib/timeApi.js) run, so a client
// refusal and a server refusal can never disagree. No React / store / browser globals;
// `.js` on every import; node-safe.
//
// ROW SHAPES. The predicates that read a punch (isWorkedEntry, isApprovedEntry,
// needsApproval, isPaidLocked) accept BOTH the snake_case DB row (clock_out_at,
// duration_minutes, approval_status, user_id) AND the neutral camelCase shape the client
// carries (clockOutAt, durationMinutes, approvalStatus, userId) — each field is read
// snake-first, then camel. So the same call works on a raw time_entries row and on a
// buildVarianceReport / rollup entry.

import { english } from '../i18n/core.js';
import { isOpsManagerIn, teamClientIds } from './teamScope.js';

export const UNSCOPED_ROLES = ['owner', 'admin'];

// ── field readers (accept snake_case OR camelCase) ───────────────────────────
const clockIn = (e) => e?.clock_in_at ?? e?.clockInAt ?? null;
const clockOut = (e) => e?.clock_out_at ?? e?.clockOutAt ?? null;
const durationOf = (e) => (e?.duration_minutes ?? e?.durationMinutes ?? null);
const approvalOf = (e) => e?.approval_status ?? e?.approvalStatus ?? null;
const userIdOf = (e) => e?.user_id ?? e?.userId ?? null;
const approvedAtOf = (e) => e?.approved_at ?? e?.approvedAt ?? null;
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

// ── scope ────────────────────────────────────────────────────────────────────
// null = everything (owner/admin); otherwise the Set of customer ids the manager
// supervises (client.supervisorId === user.id). May be empty.
// An OPERATIONS MANAGER (S131, lib/teamScope.js) supervises their TEAM: their own buildings plus
// every building of their active account managers — so an OM approves, edits and adds time across
// the team, on the screens AND on the server (api/time passes the committed roster as `users`).
// The ROLE is the caller's (`user.role`: the claim, on the server); only the LEVEL is read off
// `users`, so a claim that is not `manager` never gets a team. Without `users` (an old caller) the
// rule is the own-buildings one — narrower, never wider.
export function timeScopeFor(user, clients, users = null) {
  if (user && UNSCOPED_ROLES.includes(user.role)) return null;
  const id = user?.id;
  if (!id) return new Set();
  if (Array.isArray(users) && isOpsManagerIn(users, user)) return teamClientIds(users, clients, id);
  const set = new Set();
  for (const c of Array.isArray(clients) ? clients : []) {
    if (c && c.supervisorId === id) set.add(c.id);
  }
  return set;
}

// A punch / OT unit is in scope when scope is null, or its customer id is in the set.
// A punch with no customer (null clientId) is in scope only for the unscoped (scope null).
export function inTimeScope(scope, clientId) {
  if (scope === null) return true;
  if (clientId == null || clientId === '') return false;
  return scope.has(clientId);
}

// The customer-id filter a manager TIME READ (TimeClockHistory: /time, a customer page, a person
// or job page) should send, and whether to read at all (spec §8.4; W4-F finding 3). Inputs:
//   unscoped          owner/admin (scope null: everything).
//   scopeClientIds    the manager's supervised customer ids as an array (may be []).
//   explicitClientIds the customer ids the mount is already scoped to (a customer page, or the
//                     /time customer facet), or null/undefined when the mount scopes by something
//                     else (a person or job page, or /time with no facet chosen).
// Returns { fetch, clientIds, reason }:
//   · unscoped → always fetch; clientIds = the explicit filter, or null (company-wide) — unchanged.
//   · scoped with NO locations at all → { fetch:false, reason:'no-scope' } (the no-locations state).
//   · scoped with an explicit filter that does NOT overlap the scope → { fetch:false,
//     reason:'out-of-scope' } (a customer that isn't theirs).
//   · scoped otherwise → fetch with clientIds = explicit∩scope, or the whole scope when no explicit.
// It NEVER returns fetch:true with an empty clientIds array: the server and the demo stub DROP an
// empty clientIds and answer company-wide, so an empty scope must NOT be sent — it must not fetch.
export function effectiveTimeFilter({ unscoped = false, scopeClientIds = null, explicitClientIds = null } = {}) {
  if (unscoped) {
    const arr = Array.isArray(explicitClientIds) ? explicitClientIds.filter(Boolean) : null;
    return { fetch: true, clientIds: arr && arr.length ? arr : null, reason: null };
  }
  const scope = Array.isArray(scopeClientIds) ? scopeClientIds : [];
  if (scope.length === 0) return { fetch: false, clientIds: null, reason: 'no-scope' };
  const explicit = Array.isArray(explicitClientIds) ? explicitClientIds.filter(Boolean) : null;
  if (explicit && explicit.length) {
    const eff = explicit.filter((id) => scope.includes(id));
    if (eff.length === 0) return { fetch: false, clientIds: null, reason: 'out-of-scope' };
    return { fetch: true, clientIds: eff, reason: null };
  }
  return { fetch: true, clientIds: scope, reason: null };
}

// ── own ──────────────────────────────────────────────────────────────────────
export function isOwn(user, userId) {
  return !!user && !!userId && user.id === userId;
}
// Only a Super Admin (owner) may act on their OWN time / pay (spec §2).
export function refusesOwn(user, userId) {
  return isOwn(user, userId) && user.role !== 'owner';
}

// ── gating ────────────────────────────────────────────────────────────────────
// A gated person's pay.type is NOT salary and NOT none. Only gated people's punches
// need approval or count as pending; a missing pay type is treated as gated (a punch
// with no declared salary must not auto-pay unapproved). A null user gates nothing.
export function isGatedUser(user) {
  if (!user) return false;
  const t = user?.pay?.type;
  return t !== 'salary' && t !== 'none';
}

// ── worked / approved ─────────────────────────────────────────────────────────
// worked: a closed punch with a real duration whose status isn't voided/no_show and
// whose approval isn't rejected.
export function isWorkedEntry(e) {
  if (!e) return false;
  const dur = durationOf(e);
  return !!clockOut(e)
    && Number.isFinite(dur) && dur > 0
    && e.status !== 'voided' && e.status !== 'no_show'
    && approvalOf(e) !== 'rejected';
}
// approved: worked AND approval_status === 'approved'.
export function isApprovedEntry(e) {
  return isWorkedEntry(e) && approvalOf(e) === 'approved';
}

// A punch that needs a manager's approval: worked, still pending, and owned by a gated
// person (salaried people's punches never block payroll). `usersById` maps userId → user.
export function needsApproval(e, usersById) {
  if (!isWorkedEntry(e) || approvalOf(e) !== 'pending') return false;
  const user = usersById?.get ? usersById.get(userIdOf(e)) : (usersById || {})[userIdOf(e)];
  return isGatedUser(user);
}

// ── the ledger lock ────────────────────────────────────────────────────────────
// A paid (locked) punch (spec §1): approved, approved_at ≤ the latest run's closed_at,
// and clock_in ≤ the latest run's window end (to_iso). A pre-ledger punch (clock-in
// before the FIRST run's window) is NEVER locked — it was paid under the old rule and
// the ledger never recomputes or locks it (spec §1 "pre-ledger"). firstRun is the second
// arg per the checklist's "latest/first run … for the lock"; without it, no pre-ledger
// exclusion is applied (a caller with only one run passes it as both).
export function isPaidLocked(e, latestRun, firstRun = null) {
  if (!latestRun || !isApprovedEntry(e)) return false;
  const inMs = ms(clockIn(e));
  if (firstRun?.from_iso && Number.isFinite(inMs) && inMs < ms(firstRun.from_iso)) return false; // pre-ledger
  const apprMs = ms(approvedAtOf(e));
  const closedMs = ms(latestRun.closed_at);
  const toMs = ms(latestRun.to_iso);
  return Number.isFinite(apprMs) && Number.isFinite(closedMs) && apprMs <= closedMs
    && Number.isFinite(inMs) && Number.isFinite(toMs) && inMs <= toMs;
}

// Is a punch (by its clock-in time) inside closed territory — the days from the first
// run's window start through the latest run's window end? Used by the drive-override
// closed-territory refusal (spec §2 / §6.1). No runs → false.
export function isInClosedTerritory(clockInAt, firstRun, latestRun) {
  if (!firstRun || !latestRun) return false;
  const inMs = ms(clockInAt);
  const fromMs = ms(firstRun.from_iso);
  const toMs = ms(latestRun.to_iso);
  return Number.isFinite(inMs) && Number.isFinite(fromMs) && Number.isFinite(toMs)
    && inMs >= fromMs && inMs <= toMs;
}

// ── punch-time validation ──────────────────────────────────────────────────────
// Returns null when the times are acceptable, else one code. `requireOut` is set when the
// punch is (or must stay) closed — a closed punch's clock-out can't be cleared. Clock-in
// more than 5 minutes past `now` is 'in-future'; a span over 24 h is 'too-long'.
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
export function validatePunchTimes({ clockInAt, clockOutAt, now = Date.now(), requireOut = false } = {}) {
  const inMs = ms(clockInAt);
  if (!clockInAt || !Number.isFinite(inMs)) return 'missing-in';
  if (inMs > now + FUTURE_SKEW_MS) return 'in-future';
  if (clockOutAt) {
    const outMs = ms(clockOutAt);
    if (!Number.isFinite(outMs)) return 'invalid-times';
    if (outMs <= inMs) return 'out-before-in';
    if (outMs - inMs > MAX_SPAN_MS) return 'too-long';
  } else if (requireOut) {
    return 'missing-out';
  }
  return null;
}

// ── instants are compared by VALUE, never by spelling (CS-694) ─────────────────
// Production's PostgREST answers a `timestamptz` as `2026-10-08T13:02:50.123+00:00`; a browser's
// toISOString() writes `2026-10-08T13:02:00.000Z`. One instant has many spellings, so comparing
// the strings called EVERY save of EVERY production punch a time change — the approved punch
// went back to pending and gained history lines for times nobody touched. Absent (null,
// undefined, '') equals absent and nothing else; an unparseable value falls back to its text.
export function sameInstant(a, b) {
  const blank = (v) => v == null || v === '';
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  return String(a) === String(b);
}

// What a manager's correction patch ACTUALLY changes on a punch row — the clock times by value
// (sameInstant), the note as text (no note and an empty one are the same) — ONE rule for the
// route's store (`correctEntryRow`) and the demo stub (`stubCorrect`). Returns
// { changes: { field: newValue } for the fields that differ, in history order, timeChanged,
//   newIn, newOut } — the clock-in / clock-out the punch has once the changes land.
const CORRECTED_TIMES = ['clock_in_at', 'clock_out_at'];
export function correctionChanges(row, patch = {}) {
  const changes = {};
  for (const f of CORRECTED_TIMES) {
    if (patch?.[f] !== undefined && !sameInstant(patch[f], row?.[f])) changes[f] = patch[f];
  }
  if (patch?.note !== undefined && (patch.note ?? '') !== (row?.note ?? '')) changes.note = patch.note;
  const timeChanged = CORRECTED_TIMES.some((f) => f in changes);
  return {
    changes,
    timeChanged,
    newIn: 'clock_in_at' in changes ? changes.clock_in_at : (row?.clock_in_at ?? null),
    newOut: 'clock_out_at' in changes ? changes.clock_out_at : (row?.clock_out_at ?? null),
  };
}

// ── a manager's edit always names a reason (PAY-11) ────────────────────────────
// Matt, 2026-09-29: "When a manager edits someone's time, must they give a reason? — Yes."
// So every manager write that ASSERTS or REWRITES a punch's times takes one: Correct, Add
// time (manual) and Delete (which always did). ONE rule for the route, the demo stub and
// the modal, so the three cannot drift — and no default text stands in for the manager
// (the Add-time modal used to send 'manual entry' when the field was blank, which made the
// audit trail say nothing).
//
// Restore is deliberately NOT covered: it puts a punch back to what its own history already
// records, asserting no times, so its reason stays optional (as before).
export const trimmedReason = (reason) => (typeof reason === 'string' ? reason.trim() : '');
export function reasonRefusal(reason) {
  return trimmedReason(reason) ? null : 'reason-required';
}

// ── the punch-record vocabulary ────────────────────────────────────────────────
// 🔴 A CLOCK-OUT NEVER UN-DELETES A PUNCH (W5-M F3). A manager can Delete (void) a punch
// while it is still OPEN — clocked in at the wrong clean, a duplicate. The cleaner's
// clock-out then arrives, live or replayed, and both used to write `status: 'completed'`
// unconditionally, so the deleted punch quietly came back and re-entered approval and pay.
// The clock-out IS recorded (the work happened and the punch is its only record, THE LAW
// II.8); the DELETION stands until a manager restores it, and this line in `edit_history`
// says exactly that. Defined HERE, with the other shared time copy, so the server store,
// the demo stub and any reader of the history share one sentence.
export const VOIDED_CLOCK_OUT_REASON = 'clocked out after the punch was deleted — it stays deleted until a manager restores it';

// The status a clock-out may set on a punch: a DELETED one keeps its own, anything else
// closes to 'completed'. ONE rule for the live clock-out, the replay, a manager's
// clock-out correction, the cancelled-clean path and the demo stub, so none of them can be
// the one that forgets.
export function closedPunchStatus(row) {
  return row?.status === 'voided' ? row.status : 'completed';
}

// ── the refusal vocabulary (code → one plain sentence for the UI) ──────────────
// 400 (invalid input): invalid-times, reason-required, reject-removed, and the specific
// validatePunchTimes codes. 403: out-of-scope, own-entry. 409: stale, paid-locked,
// not-closed, voided. Copy for the specific validation codes is added beside the generic
// invalid-times so a UI can show the precise reason (spec §4.1 left them unspecified).
//
// LANGUAGES (CS-193): each sentence is a catalog line (TIME_REFUSAL_KEYS); a screen shows
// t(TIME_REFUSAL_KEYS[code]) in its reader's language, and TIME_REFUSALS is the same lines in
// English — what an API error body and a log carry.
export const TIME_REFUSAL_KEYS = {
  stale: 'punch.refusal.stale',
  'paid-locked': 'punch.refusal.paidLocked',
  'out-of-scope': 'punch.refusal.outOfScope',
  'own-entry': 'punch.refusal.ownEntry',
  'invalid-times': 'punch.refusal.invalidTimes',
  'reason-required': 'punch.refusal.reasonRequired',
  'not-closed': 'punch.refusal.notClosed',
  voided: 'punch.refusal.voided',
  'reject-removed': 'punch.refusal.rejectRemoved',
  // specific validatePunchTimes codes (all surface as 400)
  'missing-in': 'punch.refusal.missingIn',
  'in-future': 'punch.refusal.inFuture',
  'out-before-in': 'punch.refusal.outBeforeIn',
  'too-long': 'punch.refusal.tooLong',
  'missing-out': 'punch.refusal.missingOut',
};
export const TIME_REFUSALS = Object.fromEntries(
  Object.entries(TIME_REFUSAL_KEYS).map(([code, key]) => [code, english(key)]),
);
