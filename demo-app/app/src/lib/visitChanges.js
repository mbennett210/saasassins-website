// WHEN A CUSTOMER'S CLEAN CHANGED — the stamps the reschedule and cancellation notices fire on
// (Matt's approved messages, 2026-10-19). Pure and import-free.
//
// A job row says what a clean IS, not what happened to it: nothing on it told "the office moved
// this from Tuesday 6 PM to Thursday" or "this was cancelled an hour ago". So the write that makes
// such a change stamps it on the row itself (the reducer, store/reducer.js `reducer`, for
// UPDATE_JOB, UPDATE_JOB_SERIES and SET_JOB_STATUS — the paths every schedule edit takes):
//   rescheduledAt / rescheduledFrom   its date or time moved (startAt or endAt) while upcoming:
//                                     when, and the start it moved FROM
//   cancelledAt                       it went from upcoming to cancelled
// Crew swaps, covers, notes and every other field change nothing here. The stamps ride the row
// through the normal jobs write (api/state/jobs-delta), additive and default-safe: a reader that
// does not know them ignores them. The walkers (lib/reminderScheduler walkChanges) fire on a stamp
// younger than EVENT_MAX_AGE_HOURS on a clean still in the future, and on a reschedule only while
// the start still differs from `rescheduledFrom` (a change the server put back is no change).
const UPCOMING = 'upcoming';
const CANCELLED = 'cancelled';

/** `next` with the stamps its change from `prior` earns (the same object when it earns none). */
export function stampVisitChange(prior, next, nowIso) {
  if (!prior || !next || prior === next) return next;
  if (prior.status === UPCOMING && next.status === CANCELLED && !next.cancelledAt) {
    return { ...next, cancelledAt: nowIso };
  }
  if (prior.status === UPCOMING && next.status === UPCOMING
    && (prior.startAt !== next.startAt || (prior.endAt ?? null) !== (next.endAt ?? null))
    && next.rescheduledAt === prior.rescheduledAt) {
    return { ...next, rescheduledAt: nowIso, rescheduledFrom: prior.startAt };
  }
  return next;
}

// Every job of `nextJobs` that changed from `priorJobs`, stamped. The SAME array when nothing was.
export function stampVisitChanges(priorJobs, nextJobs, nowIso) {
  if (!Array.isArray(priorJobs) || !Array.isArray(nextJobs) || priorJobs === nextJobs) return nextJobs;
  const before = new Map(priorJobs.map((j) => [j?.id, j]));
  let out = null;
  for (let i = 0; i < nextJobs.length; i += 1) {
    const j = nextJobs[i];
    const p = before.get(j?.id);
    if (!p || p === j) continue;
    const s = stampVisitChange(p, j, nowIso);
    if (s !== j) { out = out || nextJobs.slice(); out[i] = s; }
  }
  return out || nextJobs;
}
