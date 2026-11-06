// Time-off rules — the machine-readable availability model the Sept 1 incident
// exposed as missing entirely: "Latisha had the night off in the system" had
// nowhere to live except a chat message, so cover was arranged by hand while the
// recurring series kept re-minting her onto that night's cleans and no surface
// could flag it. This module is deliberately dependency-light (dates only) so
// the reducer, the selectors, and the offline test suite all share ONE rule.
//
// Model: state.timeOff = [{ id, userId, startDate, endDate, reason, kind?,
// scheduledJobIds?, createdBy, createdAt }] — dates are ORG-timezone day keys
// ('YYYY-MM-DD'), inclusive on both ends. A clean "falls on" an off-day when the
// org-day of its START matches the schedule's own day bucketing (dayKey), so an
// evening clean that runs past midnight belongs to the night it started, exactly as
// the calendar displays it.
//   kind            'callout' (an unplanned absence — "can't make tonight") or
//                   'planned' (vacation, an appointment booked ahead). Additive and
//                   default-safe: an entry from before the type existed has none and
//                   counts as a call-out, exactly as it always did.
//   scheduledJobIds every live clean the person was on across the booked days WHEN it
//                   was booked (both booking screens record it; minted with the entry
//                   at dispatch, so a replayed booking carries it too) — what they
//                   called out of. Reports › Called out used to find those cleans only
//                   through the crew list, which the booking itself ("Also remove", on by
//                   default on both screens since CS-054) or a hand-swapped cover then emptied.
import { dayKey, addDaysKey } from '../lib/dates.js';
import { resolveJobCrewIds, isUserJobCrew } from '../lib/crewResolve.js';

export const TIME_OFF_KINDS = ['callout', 'planned'];
export const TIME_OFF_KIND_LABEL = { callout: 'Call-out', planned: 'Planned' };

// Does this entry count as a call-out? Anything not explicitly planned does.
export function isCallOut(entry) {
  return !!entry && entry.kind !== 'planned';
}

// The kind a new booking starts on: time off starting today or tomorrow is a call-out
// (the evening call about tomorrow morning's clean is one too); anything booked further
// ahead is planned. The booker can change it.
export function defaultTimeOffKind(startDate, today) {
  if (!startDate || !today) return 'callout';
  return startDate > addDaysKey(today, 1) ? 'planned' : 'callout';
}

// Write-point sanitizers (ADD_TIME_OFF): an unknown kind is dropped (reads as a
// call-out); scheduledJobIds keeps distinct string ids only, bounded.
export function normalizeTimeOffKind(kind) {
  return TIME_OFF_KINDS.includes(kind) ? kind : undefined;
}
export function normalizeJobIds(ids) {
  if (!Array.isArray(ids)) return undefined;
  const out = [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(0, 500);
  return out.length ? out : undefined;
}

export function isUserOffOn(timeOff, userId, startAtIso) {
  if (!userId || !startAtIso) return false;
  const d = dayKey(startAtIso);
  if (!d) return false;
  for (const t of timeOff || []) {
    if (t && t.userId === userId && t.startDate <= d && d <= t.endDate) return true;
  }
  return false;
}

// The live cleans a person is on whose org-day falls in [startDate, endDate] — what a
// time-off booking covers (both booking screens record it as scheduledJobIds). Done and
// cancelled cleans don't count; a clean already underway does (they may still be off it).
// `isOnCrew(job)` answers crew membership (the store's isJobAssignedToUser).
export function jobsCoveredByTimeOff(jobs, { startDate, endDate, isOnCrew }) {
  if (!startDate) return [];
  const last = endDate || startDate;
  return (jobs || []).filter((j) => {
    if (!j || !j.startAt || j.status === 'done' || j.status === 'cancelled' || j.status === 'canceled') return false;
    const d = dayKey(j.startAt);
    return !!d && d >= startDate && d <= last && isOnCrew(j);
  });
}

// ── WHICH cleans a booking takes the person off (CS-054) ─────────────────────────────────
// Of the cleans the booking covers, the ones still AHEAD of now (a clean already underway or
// over is left as it is: they may be on the clock there), and never a series' TEMPLATE row
// (touching its crew would rewrite every future visit — see applyTimeOffToOccurrence). The
// reducer's ADD_TIME_OFF { removeFromCleans } takes the person off exactly these, and both
// booking screens count them with this same call for their "Also remove …" line, so the number
// shown is the number changed.
export function jobsRemovedByTimeOff(jobs, { userId, startDate, endDate, now = Date.now() } = {}) {
  if (!userId) return [];
  return jobsCoveredByTimeOff(jobs, { startDate, endDate, isOnCrew: (j) => isUserJobCrew(j, userId) })
    .filter((j) => !j.recurrence && new Date(j.startAt).getTime() > now);
}

// ── ONE booking, both screens (CS-054) ────────────────────────────────────────────────────
// Team › a member's Time off card and HR › PTO used to book time off differently: Team took
// the person off the cleans already on the calendar (a second action), HR only wrote the
// record — so time off entered by HR left the person on those cleans and nobody arranged
// cover. Both screens now build the booking HERE and dispatch the one action it describes:
//   ADD_TIME_OFF with { entry, removeFromCleans } (the reducer does both halves)
// `entry` records every live clean the person is on across the days (scheduledJobIds, minted
// here so a replay carries it; Reports › Called out names them after cover is swapped in);
// `removeFromCleans` is set only when the caller asked for it AND there is something to remove
// — the caller decides whether it may (the schedule fully loaded, and schedule.edit: the server
// puts a crew change back for anyone without it). `removed` is what it takes them off, for the
// toast. The id is the caller's (newId), so the action replays as a no-op.
export function timeOffBooking({
  jobs, id, userId, startDate, endDate, reason = '', kind, calloutReason, removeFromCleans = false, now = Date.now(),
} = {}) {
  const last = endDate || startDate;
  const covered = jobsCoveredByTimeOff(jobs, { startDate, endDate: last, isOnCrew: (j) => isUserJobCrew(j, userId) });
  const removed = removeFromCleans ? jobsRemovedByTimeOff(jobs, { userId, startDate, endDate: last, now }) : [];
  const entry = {
    id, userId, startDate, endDate: last, reason: String(reason || '').trim(), kind,
    ...(kind === 'callout' && calloutReason ? { calloutReason } : {}),
    ...(covered.length ? { scheduledJobIds: covered.map((j) => j.id) } : {}),
  };
  return { entry, removeFromCleans: removed.length > 0, removed };
}

// The booked message, by type, as catalog keys (a map of literal keys, never built at run
// time — UI_RULES §140): `saved` alone, or `removed` when the booking also took the person
// off {count} cleans. Both booking screens say the same thing.
export const TIME_OFF_SAVED_KEYS = {
  callout: { saved: 'timeOffBook.savedCallOut', removed: 'timeOffBook.savedCallOutRemoved' },
  planned: { saved: 'timeOffBook.savedPlanned', removed: 'timeOffBook.savedPlannedRemoved' },
};

export function timeOffEntryFor(timeOff, userId, startAtIso) {
  if (!userId || !startAtIso) return null;
  const d = dayKey(startAtIso);
  if (!d) return null;
  return (timeOff || []).find((t) => t && t.userId === userId && t.startDate <= d && d <= t.endDate) || null;
}

// Effective crew for a job DRAFT (no job row yet) = the named crew, via the SAME
// shared resolver as saved rows (crewResolve.js) so creation-time double-book /
// time-off warnings match the row that gets written.
export function draftEffectiveCrewIds(state, { crewIds = [] } = {}) {
  return [...resolveJobCrewIds({ crewIds })];
}

// For a job being MINTED (series create / TOP_UP): drop from the occurrence's crew
// anyone who is off that day. An occurrence left with no one becomes "unassigned"
// for that day (it surfaces in the Schedule's Unassigned filter for the office to
// reassign) rather than silently keeping a cleaner who can't work it.
// Pure and idempotent, so a replayed recorded action resolves identically.
export function applyTimeOffToOccurrence(state, occ) {
  // 🔴 NEVER adjust a recurrence-bearing row. The master doubles as the SERIES
  // TEMPLATE: ADD_JOB_SERIES and TOP_UP mint every future occurrence from its
  // crewIds, so "adjusting" it for its own day would silently remove the person
  // from the ENTIRE never-ending series — the exact silent-unassignment class this
  // model exists to prevent. The master's own day is covered by the conflict
  // warnings instead.
  const timeOff = state.timeOff || [];
  if (occ?.recurrence) return occ;
  if (!timeOff.length) return occ;
  const crewIds = occ.crewIds || [];
  const keptCrew = crewIds.filter((id) => !isUserOffOn(timeOff, id, occ.startAt));
  if (keptCrew.length === crewIds.length) return occ;
  return { ...occ, crewIds: keptCrew };
}

// ── CALL-OUT REASONS FROM A LIST (ALR-7, Matt 2026-09-29) ────────────────────────────
// "Call-out reasons: pick from a list, or type freely? — (a) A short list: sick, family,
// transportation, other." Typed reasons could not be counted: "car trouble", "car broke
// down", "transportation" and "bus" were four different answers to one question, so nobody
// could see that transport is why a third of the call-outs happen.
//
// The CODE lives beside the free-text `reason`, which it does not replace: the text is the
// NOTE, and it is REQUIRED for `other` (which otherwise records nothing at all) and optional
// for the rest. PLANNED time off carries no code — its reason stays free text (a vacation, an
// appointment), because this list is about why someone could not make a shift.
//
// Additive and default-safe: an entry booked before this existed has no code and reads by its
// text alone, exactly as it always did. No store-version bump.
export const CALLOUT_REASONS = ['sick', 'family', 'transportation', 'other'];
export const CALLOUT_REASON_LABEL = {
  sick: 'Sick',
  family: 'Family',
  transportation: 'Transportation',
  other: 'Other',
};

// Write-point sanitizer (ADD_TIME_OFF): an unknown code is dropped rather than stored, and a
// code on PLANNED time off is dropped too — the list is the call-out question.
export function normalizeCalloutReason(code, kind) {
  if (kind === 'planned') return undefined;
  return CALLOUT_REASONS.includes(code) ? code : undefined;
}

// Why a booking cannot be saved yet, or null. ONE rule for both booking screens, so Team ›
// Time off and HR › PTO ask for the same thing:
//   'pick-reason'   a call-out with no reason picked
//   'note-required' 'Other' with no note — the one code that records nothing on its own
export function calloutReasonRefusal({ kind, calloutReason, reason } = {}) {
  if (kind === 'planned') return null;
  if (!CALLOUT_REASONS.includes(calloutReason)) return 'pick-reason';
  if (calloutReason === 'other' && !String(reason || '').trim()) return 'note-required';
  return null;
}
export const CALLOUT_REASON_REFUSALS = {
  'pick-reason': 'Pick a reason for the call-out.',
  'note-required': 'Say what happened — a note is required for "Other".',
};

// How a time-off entry's reason READS, wherever it is shown (Team › Time off, HR › PTO,
// Reports › Called out). The coded label, with the note after it when there is one; an entry
// with no code falls back to its text, and one with neither reads 'time off'.
export function timeOffReasonText(entry) {
  const note = String(entry?.reason || '').trim();
  const label = CALLOUT_REASON_LABEL[entry?.calloutReason];
  if (!label) return note || 'time off';
  return note ? `${label} — ${note}` : label;
}
