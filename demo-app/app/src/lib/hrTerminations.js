// HR TERMINATIONS — the one place the termination form's QUESTIONS and RULES live (Super Clippy's
// idea #513 from Clean Corner's queue, 2026-11-05: a termination form in HR, set up like warnings
// and incident reports, that ends the person's Clean Corner access).
//
// Matt, "Clean Corner - Termination" (2026-11-05, 12:09 PM PT): "Under the HR section, I forgot
// to mention that we also need to add a termination form. It should be similar to the forms for
// incidents and warnings, but simpler—it just needs to include the employee's name. Additionally,
// is it possible to set it up so that when a termination is processed, the employee automatically
// loses access to Clean Corner? See below for reasons, we would need the employee name, day of
// termination and direct manager which can link back to account manager existing in clean
// corner." His picture (1.png) holds the form's two headings, "Reason for Termination" and "Direct
// Account Manager", and his sixteen reasons in two columns. The app asks HIS questions in HIS
// words: every line is a catalog key (TERMINATION_FORM_KEYS and TERMINATION_REASON_KEYS below),
// and scripts/test-hr-terminations.mjs holds them to his picture
// (scripts/fixtures/hr-termination-form.json, its words read off it).
//
// Daniel's picks (2026-11-05): the login turns off ON the termination date, and at once when that
// date is today or earlier; filing needs BOTH "Edit HR records" (hr.edit) and the Team page's
// "Invite / edit team" (settings.team.edit), within the Team page's limits (no Super Admin, never
// yourself, an Admin only by an Admin or Super Admin); LOCKED once filed, the Super Admin voids a
// mistake with a reason, and a void undoes it (before the date the login never turns off; after
// it, the login comes back on only if this termination turned it off); access only, with the
// customers and cleans the person is still on listed for the office to reassign; the Direct
// Account Manager picker lists Account Managers only, and the field is required.
//
// PURE + node-safe (explicit .js imports): the browser, the API route, the cron and the offline
// suite run the identical rule. It never reads a clock or a zone — `today` comes in.
import { isAccountManager, hasTeamAccess } from './teamScope.js';

// ── his form, line by line, as catalog keys ─────────────────────────────────
// "Employee's Name" is his Warning Form's line for the same person; "Day of Termination" and
// "Direct Account Manager" are his email's and his picture's words.
export const TERMINATION_FORM_KEYS = Object.freeze({
  title: 'hrTerm.form.title',          // "Termination"
  employee: 'hrTerm.form.employee',    // "Employee's Name"
  date: 'hrTerm.form.date',            // "Day of Termination"
  reasons: 'hrTerm.form.reasons',      // "Reason for Termination"
  manager: 'hrTerm.form.manager',      // "Direct Account Manager"
});

// His sixteen reasons, in HIS order: his picture's two columns read across, row by row, so a
// two-column grid draws them exactly where he put them (left column = the even places).
export const TERMINATION_REASON = Object.freeze({
  resignation: 'resignation',
  insubordination: 'insubordination',
  jobAbandonment: 'job_abandonment',
  maternityLeave: 'maternity_leave',
  absenteeism: 'absenteeism',
  performance: 'performance',
  policyViolation: 'policy_violation',
  temporaryEnded: 'temporary_ended',
  requestedChange: 'requested_change',
  anotherJob: 'another_job',
  movedOutOfState: 'moved_out_of_state',
  health: 'health',
  personal: 'personal',
  accountClosure: 'account_closure',
  notEligibleForRehire: 'not_eligible_for_rehire',
  other: 'other',
});
export const TERMINATION_REASONS = Object.freeze(Object.values(TERMINATION_REASON));
export const TERMINATION_REASON_KEYS = Object.freeze({
  resignation: 'hrTerm.reason.resignation',                   // "Resignation"
  insubordination: 'hrTerm.reason.insubordination',           // "Insubordination"
  job_abandonment: 'hrTerm.reason.jobAbandonment',            // "Job Abandonment"
  maternity_leave: 'hrTerm.reason.maternityLeave',            // "Maternity Leave"
  absenteeism: 'hrTerm.reason.absenteeism',                   // "Absenteeism / Tardiness"
  performance: 'hrTerm.reason.performance',                   // "Unsatisfactory Job Performance"
  policy_violation: 'hrTerm.reason.policyViolation',          // "Violation of Company Policy"
  temporary_ended: 'hrTerm.reason.temporaryEnded',            // "Temporary Assignment Ended"
  requested_change: 'hrTerm.reason.requestedChange',          // "Manager / Client Requested Change"
  another_job: 'hrTerm.reason.anotherJob',                    // "Accepted Another Job"
  moved_out_of_state: 'hrTerm.reason.movedOutOfState',        // "Moved Out of State"
  health: 'hrTerm.reason.health',                             // "Health Reasons"
  personal: 'hrTerm.reason.personal',                         // "Personal Reasons"
  account_closure: 'hrTerm.reason.accountClosure',            // "Account Closure"
  not_eligible_for_rehire: 'hrTerm.reason.notEligibleForRehire', // "Not Eligible for Rehire"
  other: 'hrTerm.reason.other',                               // "Other:"
});

// ── the record's two states, and what happened to the login ──────────────────
// `status` is the paper: filed, or voided by the Super Admin (it stays on file).
export const TERMINATION_STATUS = Object.freeze({ filed: 'filed', voided: 'voided' });
export const TERMINATION_STATUSES = Object.freeze(Object.values(TERMINATION_STATUS));
// `accessState` is the login, moved only forward (the table's trigger holds the moves):
//   scheduled   → the date is ahead (or the turn-off is still to run)
//   ending      → the turn-off has begun: the login ban and the roster's Disabled follow
//   ended       → this termination turned the login off
//   already_off → the person had no access when the date came (Disabled on Team, or removed)
//   restored    → voided after it turned the login off, and the login came back on
//   kept        → voided after it turned the login off, but the login was changed on Team since,
//                 so the void left it as it is
export const ACCESS_STATE = Object.freeze({
  scheduled: 'scheduled', ending: 'ending', ended: 'ended', alreadyOff: 'already_off', restored: 'restored', kept: 'kept',
});
export const ACCESS_STATES = Object.freeze(Object.values(ACCESS_STATE));

// What one termination reads as on a list row, a card and its read view: ONE answer, so the
// filter, the badge and the sentence can never disagree.
//   voided    the Super Admin voided it
//   scheduled the login turns off on the date (still ahead)
//   due       the date has come and the turn-off is still to run (the 5-minute run does it)
//   ended     the login is off (this termination turned it off, or it was already off)
export const TERMINATION_STANDING = Object.freeze({ scheduled: 'scheduled', due: 'due', ended: 'ended', voided: 'voided' });
export const TERMINATION_STANDINGS = Object.freeze(Object.values(TERMINATION_STANDING));
export const TERMINATION_STANDING_KEYS = Object.freeze({
  scheduled: 'hrTerm.status.scheduled',
  due: 'hrTerm.status.due',
  ended: 'hrTerm.status.ended',
  voided: 'hrTerm.status.voided',
});
export const TERMINATION_STANDING_VARIANTS = Object.freeze({ scheduled: 'amber', due: 'amber', ended: 'red', voided: 'slate' });

export function terminationStanding(row, today) {
  if (!row) return null;
  if (row.status === TERMINATION_STATUS.voided) return TERMINATION_STANDING.voided;
  if (row.accessState === ACCESS_STATE.ended || row.accessState === ACCESS_STATE.alreadyOff) return TERMINATION_STANDING.ended;
  return isDayKey(today) && isDayKey(row.terminationDate) && row.terminationDate <= today
    ? TERMINATION_STANDING.due
    : TERMINATION_STANDING.scheduled;
}

// ── limits ──────────────────────────────────────────────────────────────────
export const TERMINATION_TEXT_MAX = Object.freeze({ reasonOther: 300, voidReason: 1000 });
// How far the date may sit from the day it is filed: a year ahead (a typo like 2062 is refused),
// five years back (paperwork for someone who left long ago).
export const TERMINATION_DAYS_AHEAD = 365;
export const TERMINATION_DAYS_BACK = 5 * 366;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDayKey = (v) => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTerminationId = (v) => typeof v === 'string' && UUID_RE.test(v);
const blank = (v) => typeof v !== 'string' || !v.trim();
// Whole days from `a` to `b` (day keys), by the calendar, never a clock.
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

// His reasons, de-duplicated and in HIS order; anything not on his list is dropped.
export const normalizeReasons = (v) => { const s = new Set(Array.isArray(v) ? v : []); return TERMINATION_REASONS.filter((x) => s.has(x)); };

// ── who the pickers offer ──────────────────────────────────────────────────
// The Direct Account Manager: an ACTIVE team member at the Account Manager level (Daniel's pick:
// "Account Managers only"), never the employee themselves.
export function isDirectManagerChoice(user, employeeUserId = null) {
  return !!user && !!user.id && user.id !== employeeUserId && isAccountManager(user) && hasTeamAccess(user);
}
export function directManagerChoices(users, employeeUserId = null) {
  return (Array.isArray(users) ? users : []).filter((u) => isDirectManagerChoice(u, employeeUserId));
}

// Whether `caller` ({ id, role }) may file a termination for `employee` (a roster row), by the
// Team page's own limits on turning a login off (api/_lib/teamAuthority loginRefusal 'status',
// lib/roles canEndAccess) and Daniel's pick: never a Super Admin, never yourself, and an Admin
// only by an Admin or a Super Admin. The permissions themselves (hr.edit + settings.team.edit)
// are the caller's to check. Returns null when allowed, else a refusal code.
export function terminationTargetRefusal(caller, employee) {
  if (!employee || !employee.id) return 'employee-missing';
  if (employee.role === 'owner') return 'employee-owner';
  if (caller && caller.id && caller.id === employee.id) return 'employee-self';
  if (employee.role === 'admin' && !(caller && (caller.role === 'admin' || caller.role === 'owner'))) return 'employee-admin';
  return null;
}

// ── the form's refusals (the form, the server and the demo stub run this) ────
export const TERMINATION_REFUSAL_KEYS = Object.freeze({
  'employee-missing': 'hrTerm.refusal.employeeMissing',
  'employee-not-on-team': 'hrTerm.refusal.employeeNotOnTeam',
  'employee-owner': 'hrTerm.refusal.employeeOwner',
  'employee-self': 'hrTerm.refusal.employeeSelf',
  'employee-admin': 'hrTerm.refusal.employeeAdmin',
  'already-terminated': 'hrTerm.refusal.alreadyTerminated',
  'date-missing': 'hrTerm.refusal.dateMissing',
  'date-too-far': 'hrTerm.refusal.dateTooFar',
  'date-too-old': 'hrTerm.refusal.dateTooOld',
  'manager-missing': 'hrTerm.refusal.managerMissing',
  'manager-not-account-manager': 'hrTerm.refusal.managerNotAccountManager',
  'reasons-missing': 'hrTerm.refusal.reasonsMissing',
  'reason-bad': 'hrTerm.refusal.reasonBad',
  'reason-other-missing': 'hrTerm.refusal.reasonOtherMissing',
  'too-long': 'hrTerm.refusal.tooLong',
  'not-allowed': 'hrTerm.refusal.notAllowed',
  'void-reason-missing': 'hrTerm.refusal.voidReasonMissing',
  'already-voided': 'hrTerm.refusal.alreadyVoided',
});

// The first problem with a draft, or null. `d` = { employeeUserId, terminationDate,
// managerUserId, reasons, reasonOther }; `today` = the org's day key.
export function terminationDraftRefusal(d, today) {
  const x = d || {};
  if (blank(x.employeeUserId)) return 'employee-missing';
  if (!isDayKey(x.terminationDate)) return 'date-missing';
  if (isDayKey(today)) {
    const ahead = daysBetween(today, x.terminationDate);
    if (ahead > TERMINATION_DAYS_AHEAD) return 'date-too-far';
    if (-ahead > TERMINATION_DAYS_BACK) return 'date-too-old';
  }
  if (blank(x.managerUserId)) return 'manager-missing';
  if (x.managerUserId === x.employeeUserId) return 'manager-not-account-manager';
  if (!Array.isArray(x.reasons) || x.reasons.length === 0) return 'reasons-missing';
  if (x.reasons.some((r) => !TERMINATION_REASONS.includes(r))) return 'reason-bad';
  if (x.reasons.includes(TERMINATION_REASON.other)) {
    if (blank(x.reasonOther)) return 'reason-other-missing';
    if (x.reasonOther.trim().length > TERMINATION_TEXT_MAX.reasonOther) return 'too-long';
  }
  return null;
}

// What a filed termination keeps of a draft: the reasons in HIS order, "Other"'s words only when
// Other is ticked (trimmed, bounded).
export function terminationAnswers(d) {
  const x = d || {};
  const reasons = normalizeReasons(x.reasons);
  const other = reasons.includes(TERMINATION_REASON.other) && typeof x.reasonOther === 'string' && x.reasonOther.trim()
    ? x.reasonOther.trim().slice(0, TERMINATION_TEXT_MAX.reasonOther)
    : null;
  return { terminationDate: x.terminationDate, reasons, reasonOther: other };
}

// The words a list row and a card show for the reasons ticked, in his order, "Other:" with its words.
export function reasonsText(t, row) {
  return normalizeReasons(row && row.reasons)
    .map((x) => (x === TERMINATION_REASON.other
      ? `${t(TERMINATION_REASON_KEYS.other)}${row.reasonOther ? ` ${row.reasonOther}` : ''}`
      : t(TERMINATION_REASON_KEYS[x])))
    .join(', ');
}

// Whether the turn-off is due: filed, not yet off, and the date has come (the org's day).
export function terminationAccessDue(row, today) {
  return !!row && row.status === TERMINATION_STATUS.filed
    && (row.accessState === ACCESS_STATE.scheduled || row.accessState === ACCESS_STATE.ending)
    && isDayKey(today) && isDayKey(row.terminationDate) && row.terminationDate <= today;
}
// Whether a void still has the login to give back: voided after this termination began turning
// it off, and the give-back hasn't run.
export function terminationRestoreDue(row) {
  return !!row && row.status === TERMINATION_STATUS.voided
    && (row.accessState === ACCESS_STATE.ended || row.accessState === ACCESS_STATE.ending);
}

// The roster after a termination turns a member's access off: `status: 'disabled'` with the
// moment as `disabledAt`, as the reducer's UPDATE_USER stamps it (store/reducer.js). Only that
// member's own rows change; nothing else on them, and nothing else in the record. A member
// already without access is left as they are (`changed: false`).
export function rosterWithAccessEnded(users, userId, atIso) {
  let changed = false;
  const next = (Array.isArray(users) ? users : []).map((u) => {
    if (!u || u.id !== userId || !hasTeamAccess(u)) return u;
    changed = true;
    return { ...u, status: 'disabled', disabledAt: atIso };
  });
  return { users: next, changed };
}
// The roster after a void gives the login back: only a row this termination disabled (status
// 'disabled' with the very `disabledAt` it stamped) goes back to the status it had before.
// A row changed on Team since (re-enabled, or disabled again by hand) is left as it is.
export function rosterWithAccessRestored(users, userId, { disabledAt, statusBefore }) {
  let changed = false;
  let mine = false;
  const back = statusBefore === 'invited' ? 'invited' : 'active';
  const next = (Array.isArray(users) ? users : []).map((u) => {
    if (!u || u.id !== userId) return u;
    if (u.status !== 'disabled' || !disabledAt || u.disabledAt !== disabledAt) return u;
    mine = true;
    changed = true;
    return { ...u, status: back, disabledAt: null };
  });
  return { users: next, changed, mine };
}
