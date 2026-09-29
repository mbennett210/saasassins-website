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
//                   through the crew list, which the booking itself (Team › Time off's
//                   "Also remove", on by default) or a hand-swapped cover then emptied.
import { dayKey, addDaysKey } from '../lib/dates.js';
import { resolveJobCrewIds } from '../lib/crewResolve.js';

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
