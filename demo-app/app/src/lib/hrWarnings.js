// HR WARNINGS — the one place the warning's QUESTIONS and RULES live (Matt's HR-1..HR-5,
// answered in the Review section 2026-10-05).
//
// Matt: "The supervisor completes a set of questions about the employee and the reason for
// the warning, then assigns it to the employee. The employee receives, reviews and
// acknowledges it in the system. Once acknowledged it stays saved under the employee's
// profile: date, reason, supervisor, employee acknowledgment."
//
// 🔴 HR-1 (b): MATT'S OWN FORM (sent 2026-10-05, "Warning Form", an English page and his
// team's Spanish page). The questions are his, in his order and his words: employee's name,
// date, manager/supervisor's name, the previous discipline meeting's date (if there was one),
// the reasons — TEN, several may be ticked, "Other" with words — the details of the actions
// that warranted it, and the corrective action. Our draft's building, incident date and
// "consequence if repeated" are gone: his form has none of them. The level (HR-2) stays.
// The words are catalog lines (WARNING_FORM_KEYS, WARNING_REASON_KEYS), and the Spanish
// catalog carries his team's Spanish for exactly these lines; scripts/test-hr-warnings.mjs
// holds both to the form itself (scripts/fixtures/hr-warning-form.json).
//
// The level list, the reason list, the required fields and their limits are declared HERE and
// nowhere else: the form, the server's validation, the list's filters and the printed
// document all read this module.
//
// PURE + node-safe (explicit .js imports): the browser, the API route and the offline suite
// run the identical rule. It never reads a clock or a zone — `today` / `now` come in.
import { addMonthsKey } from './dates.js';

// ── HR-2: three levels, in this order ───────────────────────────────────────
export const WARNING_LEVEL = Object.freeze({ first: 'first', last: 'last', termination: 'termination' });
export const WARNING_LEVELS = Object.freeze([WARNING_LEVEL.first, WARNING_LEVEL.last, WARNING_LEVEL.termination]);
// Literal catalog keys (a key built at run time cannot be found or checked — i18n card).
export const WARNING_LEVEL_KEYS = Object.freeze({
  first: 'hrWarn.level.first',
  last: 'hrWarn.level.last',
  termination: 'hrWarn.level.termination',
});
export const WARNING_LEVEL_VARIANTS = Object.freeze({ first: 'amber', last: 'red', termination: 'red' });

// ── HR-1 (b): his ten reasons, in the order his form lists them ─────────────
// Stored as codes (`hr_warnings.reasons text[]`); the words are catalog lines. The ORDER is
// his: the form, the list and the printed page all read WARNING_REASONS, and a warning's
// reasons are kept in this order whatever order they were ticked in (normalizeReasons).
export const WARNING_REASON = Object.freeze({
  absenteeism: 'absenteeism',
  procedure: 'procedure',       // failure to follow procedure
  rudeness: 'rudeness',
  tardiness: 'tardiness',
  performance: 'performance',   // failure to meet performance
  overtime: 'overtime',         // refusal to work overtime
  policy: 'policy',             // policy violation
  fighting: 'fighting',
  language: 'language',
  other: 'other',               // needs words (warningDraftRefusal)
});
export const WARNING_REASONS = Object.freeze(Object.values(WARNING_REASON));
export const WARNING_REASON_KEYS = Object.freeze({
  absenteeism: 'hrWarn.reason.absenteeism',
  procedure: 'hrWarn.reason.procedure',
  rudeness: 'hrWarn.reason.rudeness',
  tardiness: 'hrWarn.reason.tardiness',
  performance: 'hrWarn.reason.performance',
  overtime: 'hrWarn.reason.overtime',
  policy: 'hrWarn.reason.policy',
  fighting: 'hrWarn.reason.fighting',
  language: 'hrWarn.reason.language',
  other: 'hrWarn.reason.other',
});

// ── HR-1 (b): every other line of his form, as catalog keys ─────────────────
// The questions' words are his, verbatim (without the paper form's blanks and colons); the
// Spanish catalog carries his team's Spanish for each of them.
export const WARNING_FORM_KEYS = Object.freeze({
  title: 'hrWarn.form.title',                       // "Warning Form"
  employeeName: 'hrWarn.form.employeeName',         // "Employee’s Name"
  date: 'hrWarn.form.date',                         // "Date"
  supervisorName: 'hrWarn.form.supervisorName',     // "Manager/Supervisor’s Name"
  previousMeeting: 'hrWarn.form.previousMeeting',   // "If previous discipline meeting occurred, enter date"
  reasonsHeading: 'hrWarn.form.reasonsHeading',     // "Reasons for Warning"
  details: 'hrWarn.form.details',                   // "Details of actions that warranted this warning"
  corrective: 'hrWarn.form.corrective',             // "The following immediate and sustained corrective action …"
  note: 'hrWarn.form.note',                         // "Note: Your signature on this form means …"
});

// A warning's reasons, kept: known codes only, each once, in HIS order. Not a validator —
// warningDraftRefusal refuses what this would silently drop.
export function normalizeReasons(reasons) {
  const picked = new Set(Array.isArray(reasons) ? reasons : []);
  return WARNING_REASONS.filter((r) => picked.has(r));
}

// ── statuses (locked once issued; a mistake is VOIDED, never edited or deleted) ──
export const WARNING_STATUS = Object.freeze({
  awaiting: 'awaiting',           // issued, waiting for the employee's signature
  acknowledged: 'acknowledged',   // the employee signed (on their phone or in person)
  refused: 'refused',             // HR-3: refused to sign; the HR manager signed instead
  voided: 'voided',               // a mistake, voided by the owner — stays on file, never counts
});
export const WARNING_STATUSES = Object.freeze(Object.values(WARNING_STATUS));
export const WARNING_STATUS_KEYS = Object.freeze({
  awaiting: 'hrWarn.status.awaiting',
  acknowledged: 'hrWarn.status.acknowledged',
  refused: 'hrWarn.status.refused',
  voided: 'hrWarn.status.voided',
});
export const WARNING_STATUS_VARIANTS = Object.freeze({
  awaiting: 'amber', acknowledged: 'green', refused: 'red', voided: 'slate',
});

// ── limits ──────────────────────────────────────────────────────────────────
export const WARNING_TEXT_MAX = Object.freeze({
  reasonOther: 200,
  whatHappened: 4000,     // "Details of actions that warranted this warning"
  whatMustChange: 4000,   // "The following immediate and sustained corrective action …"
  comment: 2000,
  voidReason: 1000,
});
// A signature is a small PNG drawn on a ~380×130 pad (components/SignatureCapture): tens of
// kilobytes at a phone's pixel ratio. The bound keeps a row from ever carrying a megabyte,
// whatever a caller sends.
export const MAX_SIGNATURE_CHARS = 200000;

// HR-4: "During a 12-month period, if the employee receives one warning, two warnings, the
// third one is termination. Every 12 months it resets."
export const WARNING_PERIOD_MONTHS = 12;
// HR-5: "if the employee hasn't signed after 1 day, the supervisor gets a reminder".
export const WARNING_REMINDER_HOURS = 24;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDayKey = (v) => typeof v === 'string' && DAY_RE.test(v);
const blank = (v) => typeof v !== 'string' || !v.trim();

// ── validation (the form AND the server: one list of what a warning must say) ──
// The refusal codes, each with its sentence in the catalog. The server answers with the
// English (api error bodies stay English, LANG-8); the form shows the reader's language.
export const WARNING_REFUSAL_KEYS = Object.freeze({
  'employee-missing': 'hrWarn.refusal.employeeMissing',
  'supervisor-missing': 'hrWarn.refusal.supervisorMissing',
  'same-person': 'hrWarn.refusal.samePerson',
  'level-bad': 'hrWarn.refusal.levelBad',
  'reasons-missing': 'hrWarn.refusal.reasonsMissing',
  'reason-bad': 'hrWarn.refusal.reasonBad',
  'reason-other-missing': 'hrWarn.refusal.reasonOtherMissing',
  'previous-date-bad': 'hrWarn.refusal.previousDateBad',
  'previous-date-in-future': 'hrWarn.refusal.previousDateInFuture',
  'what-happened-missing': 'hrWarn.refusal.whatHappenedMissing',
  'what-must-change-missing': 'hrWarn.refusal.whatMustChangeMissing',
  'signature-missing': 'hrWarn.refusal.signatureMissing',
  'signature-bad': 'hrWarn.refusal.signatureBad',
  'signature-too-large': 'hrWarn.refusal.signatureTooLarge',
  'hr-manager-missing': 'hrWarn.refusal.hrManagerMissing',
  'void-reason-missing': 'hrWarn.refusal.voidReasonMissing',
  'too-long': 'hrWarn.refusal.tooLong',
});

// The first thing wrong with a draft, as a code, or null when it can be issued. `today` is
// the org's day key: a previous discipline meeting cannot be in the future.
export function warningDraftRefusal(d, today) {
  const x = d || {};
  if (blank(x.employeeUserId)) return 'employee-missing';
  if (blank(x.supervisorUserId)) return 'supervisor-missing';
  if (x.supervisorUserId === x.employeeUserId) return 'same-person';
  if (!WARNING_LEVELS.includes(x.level)) return 'level-bad';
  if (!Array.isArray(x.reasons) || x.reasons.length === 0) return 'reasons-missing';
  if (x.reasons.some((r) => !WARNING_REASONS.includes(r)) || new Set(x.reasons).size !== x.reasons.length) return 'reason-bad';
  if (x.reasons.includes(WARNING_REASON.other) && blank(x.reasonOther)) return 'reason-other-missing';
  // Optional: "If previous discipline meeting occurred, enter date".
  const prev = x.previousMeetingDate;
  if (prev !== null && prev !== undefined && prev !== '') {
    if (!isDayKey(prev)) return 'previous-date-bad';
    if (isDayKey(today) && prev > today) return 'previous-date-in-future';
  }
  if (blank(x.whatHappened)) return 'what-happened-missing';
  if (blank(x.whatMustChange)) return 'what-must-change-missing';
  const tooLong = [
    ['reasonOther', x.reasonOther], ['whatHappened', x.whatHappened], ['whatMustChange', x.whatMustChange],
  ].some(([k, v]) => typeof v === 'string' && v.trim().length > WARNING_TEXT_MAX[k]);
  if (tooLong) return 'too-long';
  return null;
}

// A signature the row may carry: a PNG data URL, base64 only, bounded. Returns a code or null.
const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export function signatureRefusal(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return 'signature-missing';
  if (dataUrl.length > MAX_SIGNATURE_CHARS) return 'signature-too-large';
  if (!SIG_RE.test(dataUrl)) return 'signature-bad';
  return null;
}

// ── 🔴 HR-4: where the employee stands ─────────────────────────────────────
// The owner's reading (a), decided 2026-10-05: the period STARTS at the employee's first
// counted warning, and every warning within twelve months of that start counts. Once twelve
// months have passed from the start, the count resets, and the NEXT warning starts a new
// period — the old ones do not come back. A voided warning never counts.
//
// The date of a warning is the day it was ISSUED (`issuedOn`, the org's day key, stamped by
// the server) — the day the employee received it, which is what Matt's rule counts.
export const countsTowardStanding = (w) => !!w && w.status !== WARNING_STATUS.voided;

// The level the next warning should be (the form PRESELECTS it; the supervisor may change it).
export const nextLevelFor = (count) => WARNING_LEVELS[Math.min(Math.max(0, count | 0), WARNING_LEVELS.length - 1)];

// → { count, since, resets, nextLevel } for one employee on `today`.
//   count   warnings in the current period (0 when there is none, or it has reset)
//   since   the current period's first warning (null when count is 0)
//   resets  the day the period resets (null when count is 0)
export function warningStanding(warnings, employeeUserId, today) {
  const mine = (Array.isArray(warnings) ? warnings : [])
    .filter((w) => w && w.employeeUserId === employeeUserId && countsTowardStanding(w) && isDayKey(w.issuedOn))
    .filter((w) => !isDayKey(today) || w.issuedOn <= today)
    .map((w) => w.issuedOn)
    .sort();
  let start = null;
  let count = 0;
  for (const day of mine) {
    if (start === null || day >= addMonthsKey(start, WARNING_PERIOD_MONTHS)) { start = day; count = 1; }
    else count += 1;
  }
  const resets = start ? addMonthsKey(start, WARNING_PERIOD_MONTHS) : null;
  if (!start || (isDayKey(today) && today >= resets)) {
    return { count: 0, since: null, resets: null, nextLevel: nextLevelFor(0) };
  }
  return { count, since: start, resets, nextLevel: nextLevelFor(count) };
}

// The previous discipline meeting's PREFILL on the form: the day of the employee's most
// recent COUNTED warning (a voided one was no meeting), on or before `today` — older than
// the 12-month period too, since it is a fact about the past, not the count. null when there
// is none. The supervisor may change or clear it; what is left in the box is what is stored.
export function previousMeetingDefault(warnings, employeeUserId, today) {
  let latest = null;
  for (const w of Array.isArray(warnings) ? warnings : []) {
    if (!w || w.employeeUserId !== employeeUserId || !countsTowardStanding(w) || !isDayKey(w.issuedOn)) continue;
    if (isDayKey(today) && w.issuedOn > today) continue;
    if (!latest || w.issuedOn > latest) latest = w.issuedOn;
  }
  return latest;
}

// ── HR-5: the unsigned-warning reminder ─────────────────────────────────────
// Due once a day has passed since it was issued, still unsigned, and never reminded before.
// `remindedAt` is the durable once-only stamp (set after the bell rows are written).
export function unsignedReminderDue(w, now) {
  if (!w || w.status !== WARNING_STATUS.awaiting || w.remindedAt) return false;
  const at = Date.parse(w.issuedAt);
  if (!Number.isFinite(at)) return false;
  return now - at >= WARNING_REMINDER_HOURS * 3600 * 1000;
}
