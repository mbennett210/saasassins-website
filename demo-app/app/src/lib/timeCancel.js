// Pure: what happens to a clean's labor when the clean is CANCELLED.
//
// Cancelling a job used to touch nothing but the job's status, so a crew member who
// had already clocked in kept an OPEN punch. The forgotten-clock-out cron then closed
// it at the SCHEDULED END (store.js autoCloseStale) and payroll paid the full window, 
// silently, with nothing marking it as labor on a cancelled clean.
//
// Policy (owner decision): pay for time ACTUALLY on the clock, stop the meter at the
// cancel moment, and FLAG the labor so payroll + the clock history show it. We never
// void worked time. This transform is shared by the demo stub (lib/timeApi) and the
// server twin (api/_lib/time/store) so both behave identically.
import { durationMins } from './timeMerge';

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);

// Close one open punch at the cancel moment: capped at the scheduled end (same law as
// the auto-close cron, so a forgotten punch cancelled the next day can't inflate the
// window) and never before clock-in (clock skew → a real, non-negative duration).
function stopAt(entry, nowIso) {
  let stop = nowIso;
  if (entry.scheduled_end && ms(entry.scheduled_end) < ms(stop)) stop = entry.scheduled_end;
  if (entry.clock_in_at && ms(stop) < ms(entry.clock_in_at)) stop = entry.clock_in_at;
  return stop;
}

// Apply a job cancellation to a ledger. Returns a NEW array plus counts. Every punch
// on the clean is tagged `job_cancelled_at`; an OPEN punch is additionally clocked out
// (status → completed, so it still pays, it is NOT voided) at stopAt(). Rows for other
// jobs are returned untouched (same reference).
export function applyJobCancellation(entries, jobId, nowIso) {
  let closed = 0;
  let flagged = 0;
  const next = (entries || []).map((e) => {
    if (!e || e.job_id !== jobId || e.job_cancelled_at) return e; // idempotent: never re-flag
    flagged += 1;
    const history = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
    if (!e.clock_out_at) {
      const out = stopAt(e, nowIso);
      closed += 1;
      history.push({ at: nowIso, field: 'job_cancelled', from: 'in_progress', to: 'completed', reason: 'clean cancelled, clocked out at cancel' });
      return {
        ...e,
        clock_out_at: out,
        duration_minutes: durationMins(e.clock_in_at, out),
        status: 'completed',
        job_cancelled_at: nowIso,
        edited: true,
        edit_history: history,
      };
    }
    history.push({ at: nowIso, field: 'job_cancelled', reason: 'clean cancelled after this punch' });
    return { ...e, job_cancelled_at: nowIso, edited: true, edit_history: history };
  });
  return { entries: next, closed, flagged };
}

// Does this clean have any labor that a cancel would touch? Drives the manager warning
// (open punches are the "someone is on the clock right NOW" case) vs a silent flag of
// already-closed punches.
export function laborOnJob(entries, jobId) {
  const rows = (entries || []).filter((e) => e && e.job_id === jobId);
  const open = rows.filter((e) => !e.clock_out_at);
  return { total: rows.length, open, openNames: open.map((e) => e.user_name).filter(Boolean) };
}
