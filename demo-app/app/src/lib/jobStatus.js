// The clean (job) status vocabulary — ONE definition, pure and dependency-free.
//
// WHY THIS FILE EXISTS. The vocabulary used to live only as string literals plus the
// label list in `lib/filters/scheduleFilters.js` (STATUS_OPTIONS), which imports
// selectors + applyFilters and so cannot be loaded by a node test or by an api/ route.
// Everything outside the browser therefore restated the literals by hand, and one of
// those restatements was WRONG: `reminderScheduler.shouldFire` gated post_service on
// `status === 'completed'`, a status no clean in this app ever reaches, so the
// post-service customer reminder could never fire (CS-056). Its test suite restated the
// same wrong literal in its fixtures, so 36/36 passed while the feature was dead.
//
// So the vocabulary is declared HERE, with no imports, and every consumer derives from
// it: scheduleFilters builds STATUS_OPTIONS from JOB_STATUS + JOB_STATUS_LABELS, the
// reminder scheduler asks isCompletedJobStatus, and tests assert against the constant
// rather than a literal they typed themselves (THE LAW II.3).

export const JOB_STATUS = Object.freeze({
  UPCOMING: 'upcoming',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  MISSED: 'missed',
  CANCELLED: 'cancelled',
});

// Display labels, keyed by status value. Kept beside the values so the two can never
// drift apart; scheduleFilters' STATUS_OPTIONS is generated from this pair.
export const JOB_STATUS_LABELS = Object.freeze({
  [JOB_STATUS.UPCOMING]: 'Upcoming',
  [JOB_STATUS.IN_PROGRESS]: 'In Progress',
  [JOB_STATUS.DONE]: 'Done',
  [JOB_STATUS.MISSED]: 'Missed',
  [JOB_STATUS.CANCELLED]: 'Cancelled',
});

export const JOB_STATUS_VALUES = Object.freeze(Object.values(JOB_STATUS));

// 'completed' is NOT a status this app writes — `SET_JOB_STATUS` and every UI path use
// JOB_STATUS.DONE. It is tolerated as a read-side alias only, exactly as
// `lib/opsAlerts.js` TERMINAL_JOB tolerates it, so a hand-patched or imported row that
// carries the older word is still treated as a finished clean instead of silently
// falling through. Writers must always use JOB_STATUS.DONE.
export const LEGACY_DONE_ALIAS = 'completed';

/** True when a clean has finished — the real status, or the tolerated legacy alias. */
export function isCompletedJobStatus(status) {
  return status === JOB_STATUS.DONE || status === LEGACY_DONE_ALIAS;
}

// ── WHEN a clean is done (CS-051) ─────────────────────────────────────────────────────────
// A clean is DONE when a punch on it has closed and NOBODY is still on the clock there. The
// screen used to mark the clean done on EVERY clock-out, so on a two-cleaner clean the first
// to leave finished it while the other was still working. Only the server sees every punch on
// a clean, so it asks this after each clock-out (api/time: the live clock-out, a replayed one,
// the office closing or deleting an open punch, the auto-close cron) and writes the status
// itself; the demo stub asks the same. `punches` are the clean's time entries, any shape
// carrying `clock_out_at` and `status` (the PUNCH status, not this file's job vocabulary). A
// deleted ('voided') or no-show punch counts for neither side: it holds nobody on the clock,
// and it is not anyone having finished.
const NOT_A_PUNCH = new Set(['voided', 'no_show']);
export function jobDoneAfterPunches(punches) {
  const live = (Array.isArray(punches) ? punches : []).filter((p) => p && !NOT_A_PUNCH.has(p.status));
  if (live.some((p) => !p.clock_out_at)) return false;
  return live.some((p) => !!p.clock_out_at);
}
