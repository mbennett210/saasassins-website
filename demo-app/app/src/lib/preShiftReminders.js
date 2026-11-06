// Pre-shift reminders — PURE, node-safe walker. ALR-5 (Matt, 2026-09-29): "Should cleaners
// get a reminder before each shift? — (a) Yes, 30 minutes before." ★
//
// 🔴 IT IS A PUSH, NOT A BELL ROW. One notification row per cleaner per shift would put
// 1,500 rows a day into the shared record (`org_state.notifications`), and the bell is a
// recency surface, not a shift diary — the cleaner's own My Day screen already IS the record
// of their shifts. So the alert carries `pushOnly: true`: lib/opsAlertApply records the dedup
// MARKER and creates no row, and the cron sends the push directly (push/store.sendToUser),
// the same shape PAY-15's morning digest uses on the watchdog cron.
//
// The marker is the only thing that lands in the shared record, and it is retained on a
// horizon derived from the lead time (lib/opsAlertApply), so the steady state is "the cleaners
// whose shift starts in the next lead window", not a row per shift for ever.
import { resolveJobCrewIds } from './crewResolve.js';
import { isSeedJobId, OPS_ALERT_DEFAULTS } from './opsAlerts.js';

const MIN = 60 * 1000;
const num = (v, d) => (Number.isFinite(v) ? v : d);
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : NaN; };

// Jobs in these statuses are finished/void — nothing to remind anyone about.
const TERMINAL_JOB = new Set(['done', 'completed', 'cancelled', 'canceled']);

// A lead of 0 turns the reminder OFF (no window can contain `now`), which is how the office
// switches it off without a second toggle. Clamped at a day so a typo cannot make every
// scheduled clean's reminder due the moment it is booked.
export const MAX_PRESHIFT_LEAD_MINS = 24 * 60;
export const preShiftReminderMins = (settings = {}) => Math.min(MAX_PRESHIFT_LEAD_MINS,
  Math.max(0, num(settings?.preShiftReminderMins, OPS_ALERT_DEFAULTS.preShiftReminderMins)));

// Deterministic per-(job, cleaner) id — "once per shift" per ALR-5, so a cleaner on two
// cleans gets two reminders and a cleaner on one clean gets exactly one.
export const preShiftReminderId = (jobId, userId) => `oa_shiftReminder_${jobId}_${userId}`;

// ── The walker ────────────────────────────────────────────────────────────────
//   jobs          : the near-term window (state.jobs / api/_lib/jobsTable.getJobsInWindow) —
//                   needs id/startAt/status/clientId/siteId/crewIds.
//   firedIds      : Set of preShiftReminderId()s already sent (dedup).
//   activeUserIds : OPTIONAL Set/array of roster ids still ACTIVE. ABSENT means "not known"
//                   and everyone on the clean is reminded — the same stance the checklist
//                   walker takes, because a failed roster read must not silence reminders.
//   coveredJobIds : OPTIONAL Set of job ids that already have a clock-in. Someone who has
//                   already started does not need telling their shift is about to.
//   now, settings.
// Returns [{ id, kind:'shiftReminder', pushOnly, jobId, clientId, siteId, userId, crewIds,
//            scheduledStart }].
export function getDuePreShiftReminders({
  jobs = [], firedIds = new Set(), activeUserIds = null, coveredJobIds = null, now = Date.now(), settings = {},
} = {}) {
  const leadMins = preShiftReminderMins(settings);
  if (leadMins <= 0) return [];                       // switched off
  const leadMs = leadMins * MIN;
  const asSet = (v) => (v == null ? null : (v instanceof Set ? v : new Set(v)));
  const active = asSet(activeUserIds);
  const covered = asSet(coveredJobIds);

  const due = [];
  for (const job of jobs) {
    if (!job || !job.id || TERMINAL_JOB.has(job.status)) continue;
    if (job.status === 'in_progress') continue;       // already underway
    // CS-030 seed skip — the same line the checklist nudge carries: production's book is
    // fictional until the cutover, and a reminder per seed cleaner per seed shift would put
    // markers in the shared record for cleans nobody works.
    // TODO(remove-by: CS-030 seed cutover): drop with the rest of the seed skip
    // (grep: SEED_JOB_ID_RE, isSeedJobId).
    if (isSeedJobId(job.id)) continue;
    const startMs = ms(job.startAt);
    if (!Number.isFinite(startMs)) continue;
    // The window is [start − lead, start): before it there is nothing to say yet, and once the
    // clean has STARTED the late/missed alerts own the problem (ALR-1/ALR-3 — untouched here).
    if (now >= startMs || now < startMs - leadMs) continue;
    if (covered && covered.has(job.id)) continue;     // somebody already clocked in

    for (const userId of resolveJobCrewIds(job)) {
      if (active && !active.has(userId)) continue;    // off the roster / disabled
      const id = preShiftReminderId(job.id, userId);
      if (firedIds.has(id)) continue;
      due.push({
        id,
        kind: 'shiftReminder',
        pushOnly: true,
        recipientScope: 'crew',
        jobId: job.id,
        clientId: job.clientId || null,
        siteId: job.siteId || null,
        userId,
        crewIds: [userId],
        scheduledStart: job.startAt,
      });
    }
  }
  return due;
}
