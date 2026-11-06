// Attendance report — PURE, node-safe (no browser globals). Powers Reports › "Not
// clocked in / out" (Matt's questionnaire, Reports #10: "a list of cleaners that did not
// clock in and clock out today"). Cross-references the cleans scheduled in a day against
// EVERY punch for them and returns, per scheduled (cleaner, clean), where that cleaner
// stands at `now`:
//   complete          clocked in AND out (by the cleaner, or a manager's manual entry)
//   missing_clock_out clocked in, never clocked out: a session still open past the
//                     clean's end + grace, OR one closed by the hourly auto-close cron
//                     (status auto_closed — the SYSTEM wrote that clock-out, the cleaner
//                     never did) that no manager has corrected since. It used to read
//                     "Complete" once the cron ran, so "Yesterday" hid every forgotten
//                     clock-out. A manager-corrected clock-out reads complete.
//   on_clock          clocked in, the clean isn't over yet — not a problem yet
//   no_punch          never clocked in, and the clean started more than the missed-shift
//                     mark ago (opsSettings.missedAfterStartMins — the SAME number the
//                     missed-shift alert fires on, so the report and the alert agree)
//   upcoming          not clocked in because the clean hasn't started (or is still inside
//                     that mark). It used to read "No punch", so running Today before
//                     a night shift listed every cleaner on it as a no-show.
//   off               never clocked in, but booked off that day (a call-out or planned
//                     time off) — a known absence, listed on Reports › Called out.
// Only no_punch + missing_clock_out are "incomplete" (the report's default view).
// Voided / no-show punches are not punches. A punch is matched to its clean by job id
// (unique per occurrence), not by clock-in time, so an overnight clean clocked in after
// midnight still counts.
import { timeOffEntryFor, isCallOut } from '../store/timeOffRules.js';
// ALR-11: ONE number decides when a clean with no clock-in is a problem. It is defined
// beside the alert that fires on it, never restated here — a second copy is how the
// office's report and the supervisor's phone end up disagreeing.
import { OPS_ALERT_DEFAULTS } from './opsAlerts.js';
import { clockOutCorrected } from './autoClose.js';

export const ATT_COMPLETE = 'complete';
export const ATT_MISSING_OUT = 'missing_clock_out';
export const ATT_NO_PUNCH = 'no_punch';
export const ATT_ON_CLOCK = 'on_clock';
export const ATT_UPCOMING = 'upcoming';
export const ATT_OFF = 'off';

// The statuses that are a problem (the default "Incomplete" view + the headline count).
export const ATT_INCOMPLETE = new Set([ATT_NO_PUNCH, ATT_MISSING_OUT]);

const TERMINAL_JOB = new Set(['cancelled', 'canceled']);
// A punch the office deleted or marked a no-show is not a clock-in. Exported for the QR area page's
// "On site now" (lib/areaPage onSiteNow, QR Wave 2), so the two never disagree about who arrived.
export const NOT_A_PUNCH = new Set(['voided', 'no_show']);
const MIN = 60 * 1000;
const FALLBACK_SHIFT_MINS = 120; // a clean with no end time is assumed this long (as the alerts do)
const DEFAULT_GRACE_MINS = OPS_ALERT_DEFAULTS.missedAfterStartMins;   // opsSettings.missedAfterStartMins
const ms = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : NaN; };
const inWindow = (t, from, to) => Number.isFinite(t) && t >= from && t <= to;

// An auto-closed punch whose clock-out no manager has corrected since the cron closed it
// (lib/autoClose `clockOutCorrected`, the auto-close module's own rule — the cleaner's card
// asks the same question, so it lives beside the cron's rule rather than here).
const autoClosedUnfixed = (e) => e.status === 'auto_closed' && !clockOutCorrected(e);

// THE "nobody has clocked in yet" rule (ALR-11), for a clean that starts at `startMs`:
// no_punch once `now` is STRICTLY past the start plus the missed-shift mark, else upcoming
// (not started, or still inside the mark). Exported so the manager's today view
// (lib/managerToday) asks this question through the same function the report does, rather
// than holding a second copy of the mark (2026-10-09). `graceMins` is
// opsAlerts.missedAfterStartMins(opsSettings); omitted, the shipped default applies.
export function noPunchStatus(startMs, now, graceMins = DEFAULT_GRACE_MINS) {
  const grace = (Number.isFinite(graceMins) ? graceMins : DEFAULT_GRACE_MINS) * MIN;
  return now > startMs + grace ? ATT_NO_PUNCH : ATT_UPCOMING;
}

// Build the attendance rows for a day-window.
//   jobs         : state.jobs (need id/startAt/endAt/status/clientId/siteId/crewIds)
//   timeEntries  : EVERY punch around the window (job_id, user_id, clock_in_at,
//                  clock_out_at, status, edit_history) — timeApi.entriesAll, a complete read
//   usersById, clientsById, sitesById : names + supervisorId scoping
//   fromMs,toMs  : the day-window (org zone) — a clean belongs to the day it STARTS
//   managerId    : optional — only cleans at accounts this manager supervises
//   now          : the clock the statuses are judged against
//   graceMins    : minutes past start with no clock-in before "No punch", and past the
//                  end before an open punch is "Missing clock-out"
//                  (opsAlerts.missedAfterStartMins(opsSettings) — the missed-shift mark)
//   timeOff      : state.timeOff — a no-punch cleaner booked off that day reads "off"
// Returns one row per scheduled (cleaner, clean):
//   { userId, userName, clientId, clientName, siteId, siteName, jobId, scheduledStart,
//     scheduledEnd, clockInAt, clockOutAt, autoClosed, entryId, entryVersion, offKind, status }
// entryId / entryVersion name the open or auto-closed punch behind a missing_clock_out row
// (null otherwise) so the Approvals screen's "Fix clock-out" can Edit it under the CAS.
export function computeAttendanceReport({
  jobs = [], timeEntries = [], usersById = new Map(), clientsById = new Map(),
  sitesById = new Map(), fromMs = -Infinity, toMs = Infinity, managerId = null,
  now = Date.now(), graceMins = DEFAULT_GRACE_MINS, timeOff = [],
} = {}) {
  const graceIn = Number.isFinite(graceMins) ? graceMins : DEFAULT_GRACE_MINS;
  const grace = graceIn * MIN;

  // Group punches by `${jobId}|${userId}` — the clean a cleaner was scheduled on. A
  // cleaner can clock in and out more than once on one clean (a break); EVERY session
  // counts, so a finished first session can't hide a forgotten second clock-out.
  const punchesByJobUser = new Map();
  for (const e of timeEntries) {
    if (!e || !e.job_id || !e.user_id || !e.clock_in_at) continue;
    if (NOT_A_PUNCH.has(e.status)) continue;
    const key = `${e.job_id}|${e.user_id}`;
    if (!punchesByJobUser.has(key)) punchesByJobUser.set(key, []);
    punchesByJobUser.get(key).push(e);
  }

  const rows = [];
  for (const job of jobs) {
    if (!job || !job.id || TERMINAL_JOB.has(job.status)) continue;
    const startMs = ms(job.startAt);
    if (!inWindow(startMs, fromMs, toMs)) continue;
    const client = job.clientId ? clientsById.get(job.clientId) : null;
    if (managerId && (!client || client.supervisorId !== managerId)) continue; // scope to this manager's accounts
    const endMs = Number.isFinite(ms(job.endAt)) ? ms(job.endAt) : startMs + FALLBACK_SHIFT_MINS * MIN;
    const crew = Array.isArray(job.crewIds) ? job.crewIds : [];
    for (const uid of crew) {
      const user = usersById.get(uid);
      const punches = punchesByJobUser.get(`${job.id}|${uid}`) || [];
      const off = punches.length ? null : timeOffEntryFor(timeOff, uid, job.startAt);
      let status;
      let clockInAt = null;
      let clockOutAt = null;
      let autoClosed = false;
      // The punch behind a missing_clock_out row, so the Approvals screen can offer
      // "Fix clock-out" (Edit, which needs the CAS row_version): the still-open punch, or the
      // auto-closed one no manager has corrected. Null for every other status.
      let entryId = null;
      let entryVersion = null;
      if (punches.length) {
        const ins = punches.map((p) => p.clock_in_at).sort();
        clockInAt = ins[0];
        const open = punches.some((p) => !p.clock_out_at);
        if (open) {
          status = now > endMs + grace ? ATT_MISSING_OUT : ATT_ON_CLOCK;
          if (status === ATT_MISSING_OUT) {
            const openPunch = punches.find((p) => !p.clock_out_at);
            if (openPunch) { entryId = openPunch.id ?? null; entryVersion = openPunch.row_version ?? null; }
          }
        } else {
          clockOutAt = punches.map((p) => p.clock_out_at).sort().pop();
          autoClosed = punches.some(autoClosedUnfixed);
          status = autoClosed ? ATT_MISSING_OUT : ATT_COMPLETE;
          if (autoClosed) {
            const autoPunch = punches.find(autoClosedUnfixed);
            if (autoPunch) { entryId = autoPunch.id ?? null; entryVersion = autoPunch.row_version ?? null; }
          }
        }
      } else if (off) {
        status = ATT_OFF;
      } else {
        status = noPunchStatus(startMs, now, graceIn);
      }
      rows.push({
        userId: uid,
        userName: user?.name || '—',
        clientId: job.clientId || null,
        clientName: client?.name || null,
        siteId: job.siteId || null,
        siteName: (job.siteId ? sitesById.get(job.siteId)?.name : null) || null,
        jobId: job.id,
        scheduledStart: job.startAt || null,
        scheduledEnd: job.endAt || null,
        clockInAt,
        clockOutAt,
        autoClosed,
        entryId,
        entryVersion,
        offKind: off ? (isCallOut(off) ? 'callout' : 'planned') : null,
        status,
      });
    }
  }
  // Problems first (no punch, then missing clock-out), then who's still due, then the
  // rest; then by name.
  const order = {
    [ATT_NO_PUNCH]: 0, [ATT_MISSING_OUT]: 1, [ATT_ON_CLOCK]: 2, [ATT_UPCOMING]: 3, [ATT_OFF]: 4, [ATT_COMPLETE]: 5,
  };
  return rows.sort((a, b) => (order[a.status] - order[b.status]) || a.userName.localeCompare(b.userName));
}

// The count of scheduled cleans whose attendance is a problem (the report's headline).
export function incompleteCount(rows) {
  return (rows || []).filter((r) => ATT_INCOMPLETE.has(r.status)).length;
}
