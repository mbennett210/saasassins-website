// Site access by being ON a clean. ONE rule, imported by the server (the job path of
// api/_lib/authz.js requireSiteAssignment) and by the app (JobDetail's Codes row), so the
// Reveal button shows exactly where the server allows it — the two used to disagree, and
// every cleaner's tap answered "Not assigned to this site" (2026-09-23).
//
// Crew is the job's named `crewIds` (standing crew was removed 2026-09-09); a cancelled
// clean never counts. The window is three optional bounds (null = unbounded):
//   leadMs    — how long before the clean STARTS access opens;
//   afterMs   — how long after it ENDS (or starts, when it has no end) access lasts;
//   maxSpanMs — the longest a single clean can hold the window open: a clean that runs
//               longer is read as ending maxSpanMs after it starts, so one long or bad
//               row can't keep a site's codes open for weeks.
// With any bound set, a start or end that is present but unreadable DENIES (fail closed).
// Door / alarm codes use CODE_REVEAL_WINDOW: from a day before the clean to a day after,
// i.e. "on a job there today", with room for an early start, an overnight clean or a late
// note, and never a site's codes for a clean weeks away. The server takes that path for
// CREW only (a pared-back office role gets codes through ops.revealCodes or not at all).
//
// What keeps the rule honest is that crew can't write its inputs: the jobs guard
// (api/_lib/jobsGuard.js) puts back crewIds / siteId / startAt / endAt, and the two status
// changes statusChangeKept below refuses, for everyone it sanitizes. That holds only while
// the browser can't write public.jobs directly (Increment 1e).
//
// Node-ESM safe (explicit extensions, no browser APIs): the server imports it.

const HOUR = 60 * 60 * 1000;

export const CODE_REVEAL_WINDOW = Object.freeze({
  leadMs: 24 * HOUR,
  afterMs: 24 * HOUR,
  maxSpanMs: 36 * HOUR,
});

const CANCELLED = new Set(['cancelled', 'canceled']);

export function jobGrantsSiteAccess(job, userId, { leadMs = null, afterMs = null, maxSpanMs = null, now = Date.now() } = {}) {
  if (!job || !userId || CANCELLED.has(job.status)) return false;
  if (!Array.isArray(job.crewIds) || !job.crewIds.includes(userId)) return false;
  if (leadMs == null && afterMs == null) return true;
  const start = Date.parse(job.startAt);
  if (!Number.isFinite(start)) return false;
  let end = job.endAt == null || job.endAt === '' ? start : Date.parse(job.endAt);
  if (!Number.isFinite(end)) return false;
  if (end < start) end = start;
  if (maxSpanMs != null && end - start > maxSpanMs) end = start + maxSpanMs;
  if (leadMs != null && start - leadMs > now) return false;
  if (afterMs != null && end + afterMs < now) return false;
  return true;
}

// The status changes the jobs guard KEEPS from a caller it sanitizes (crew whatever they
// are granted, a manager without schedule.edit, no role): api/_lib/jobsGuard.js puts any
// other change back, and Job Detail offers only these. Two limits, both because status is
// an input to the grant above:
//   out of 'cancelled'   never: cancelling a clean is how the office takes back the access
//                        it gave, and un-cancelling would hand it back;
//   a visit far off      not until it is within leadMs of starting: the office's series
//                        edits and deletes touch only upcoming visits, so a visit flipped
//                        early would keep its crew (and their access that day) through them.
//                        A job with no readable start opens nothing through the window, so
//                        only the first limit applies to it.
// Clock-in's own change (upcoming / missed → in_progress) and clock-out's (→ done) pass:
// the app makes them only on the day of the clean, and never from 'cancelled'.
export function statusChangeKept(job, nextStatus, now = Date.now()) {
  if (!job) return false;
  const from = job.status ?? null;
  if ((nextStatus ?? null) === from) return true;
  if (CANCELLED.has(from)) return false;
  const start = Date.parse(job.startAt);
  return !Number.isFinite(start) || start - CODE_REVEAL_WINDOW.leadMs <= now;
}
