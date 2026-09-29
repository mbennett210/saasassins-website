import { useMemo, useState } from 'react';
import { useDispatch, useStore, useJobsHydrated } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectTimeOffForUser, isJobAssignedToUser } from '../store/selectors';
import { TIME_OFF_KINDS, TIME_OFF_KIND_LABEL, isCallOut, defaultTimeOffKind, jobsCoveredByTimeOff } from '../store/timeOffRules';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useToast } from './Toast';
import FormField from './FormField';
import Badge from './Badge';
import ConfirmDialog from './ConfirmDialog';
import { todayKey, fmtDate, composeIso } from '../lib/dates';
import { newId } from '../lib/ids';

// Time off, for real (Sept 1). Before this card existed, "she has the night
// off" had nowhere to live but a chat message — so cover got arranged by hand
// while the recurring series kept re-minting her onto that night's cleans and
// no surface could warn anyone. Booking here does BOTH halves in one motion:
// the durable record every scheduling surface now checks (warnings on assign /
// drag / detail, exclusion at series mint + top-up), and — on by default, for
// someone who may edit the schedule — the bulk removal from cleans that are
// ALREADY on the calendar in the range.
export default function TimeOffCard({ userId, userName }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('settings.team.edit');
  // Bulk exclusion is a JOB edit: gated on full hydration like every other
  // job-editing surface (a pre-hydration APPLY would only see the boot window,
  // clear the record's clean-up half against a partial set, and the missed
  // occurrences would never be revisited). Booking the time-off RECORD itself
  // is blob-only and always safe.
  const jobsHydrated = useJobsHydrated();
  // ...and on being allowed to edit jobs at all (useCanEditJobs: schedule.edit, never
  // crew): the server puts a crew change back for crew and for a manager without the key
  // (jobsGuard), so the removal would look done and quietly revert. Without it the
  // booking is the record alone.
  const canEditJobs = useCanEditJobs();
  const entries = selectTimeOffForUser(state, userId)
    .slice()
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [alsoRemove, setAlsoRemove] = useState(true);
  // Call-out vs planned. Follows the start date (today → call-out, later → planned)
  // until the booker picks one themselves.
  const [kindPicked, setKindPicked] = useState(null);
  const kind = kindPicked || defaultTimeOffKind(start, todayKey());
  const [confirmRemove, setConfirmRemove] = useState(null); // time-off entry pending un-book confirm

  // What "Also remove" can take them off: cleans in the picked range still AHEAD of now,
  // excluding a series' template row (APPLY_TIME_OFF_EXCLUSIONS never touches that — it
  // would rewrite every future mint). Recomputed at the moment of booking, below.
  const removableFrom = (nowMs) => jobsCoveredByTimeOff(state.jobs, {
    startDate: start, endDate: end || start, isOnCrew: (j) => isJobAssignedToUser(state, j, userId),
  }).filter((j) => new Date(j.startAt).getTime() > nowMs && !j.recurrence);
  const affected = useMemo(() => {
    if (!start || !jobsHydrated || !canEditJobs) return [];
    return removableFrom(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, userId, start, end, jobsHydrated, canEditJobs]);

  const add = () => {
    if (!start) { toast.error('Pick a start date.'); return; }
    const endDate = end || start;
    if (endDate < start) { toast.error('End date is before the start date.'); return; }
    // Computed NOW (not at the last render): every clean the person is on across the
    // booked days — recorded on the entry (minted here, replay-safe) so Reports › Called
    // out names them even after cover is swapped in — and, of those, the ones this
    // booking actually removes them from.
    const covered = jobsCoveredByTimeOff(state.jobs, { startDate: start, endDate, isOnCrew: (j) => isJobAssignedToUser(state, j, userId) });
    const removable = jobsHydrated && canEditJobs ? removableFrom(Date.now()) : [];
    const removeNow = !!(alsoRemove && removable.length);
    dispatch({
      type: ACTIONS.ADD_TIME_OFF,
      entry: {
        id: newId('to'), userId, startDate: start, endDate, reason: reason.trim(), kind,
        ...(covered.length ? { scheduledJobIds: covered.map((j) => j.id) } : {}),
      },
    });
    if (removeNow) {
      dispatch({ type: ACTIONS.APPLY_TIME_OFF_EXCLUSIONS, userId, startDate: start, endDate });
    }
    const first = (userName || '').split(' ')[0] || 'They';
    const what = kind === 'callout' ? 'Call-out saved' : 'Time off saved';
    toast.success(removeNow
      ? `${what} — ${first} was removed from ${removable.length} scheduled clean${removable.length === 1 ? '' : 's'}.`
      : `${what}.`);
    setStart(''); setEnd(''); setReason(''); setAlsoRemove(true); setKindPicked(null);
  };

  return (
    <div className="card detail-card">
      <h3>Time off</h3>
      {entries.length === 0 && (
        <p className="text-sm text-muted" style={{ margin: '4px 0 10px' }}>
          No time off booked. Booking it here warns every scheduling screen and keeps
          recurring cleans from re-adding {(userName || '').split(' ')[0] || 'them'} on those days.
        </p>
      )}
      {entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 12px' }}>
          {entries.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <Badge variant="blue">
                {/* composeIso: format the day KEY in the org zone — a bare
                    `${date}T12:00` parses in DEVICE time and renders a day early
                    for viewers far east of the org (Manila VA). */}
                {fmtDate(composeIso(t.startDate, '12:00'))}{t.endDate !== t.startDate ? ` – ${fmtDate(composeIso(t.endDate, '12:00'))}` : ''}
              </Badge>
              <Badge variant={isCallOut(t) ? 'amber' : 'slate'}>{TIME_OFF_KIND_LABEL[isCallOut(t) ? 'callout' : 'planned']}</Badge>
              <span className="text-muted">{t.reason || 'time off'}</span>
              {canEdit && (
                <button className="btn btn-outline" onClick={() => setConfirmRemove(t)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="form-row">
            <FormField label="First day off" type="date" value={start} min={todayKey()} onChange={(e) => setStart(e.target.value)} />
            <FormField label="Last day off" type="date" value={end} min={start || todayKey()} onChange={(e) => setEnd(e.target.value)} help="Leave blank for a single day." />
          </div>
          <FormField label="Type">
            <div className="tab-container-line" role="group" aria-label="Type of time off">
              {TIME_OFF_KINDS.map((k) => (
                <button key={k} type="button" className={`tab-btn ${kind === k ? 'active' : ''}`} aria-pressed={kind === k} onClick={() => setKindPicked(k)}>
                  {TIME_OFF_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </FormField>
          <FormField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'callout' ? 'Optional — e.g. sick, car trouble' : 'Optional — e.g. vacation, appointment'} />
          {affected.length > 0 && (
            <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={alsoRemove} onChange={(e) => setAlsoRemove(e.target.checked)} />
              Also remove {(userName || '').split(' ')[0]} from the {affected.length} clean{affected.length === 1 ? '' : 's'} already scheduled in this range
            </label>
          )}
          {!jobsHydrated && start && canEditJobs && (
            <div className="text-xs text-muted">
              Still loading the full schedule — cleans already on the calendar can be cleared once it finishes.
            </div>
          )}
          <div>
            <button className="btn btn-primary" onClick={add} disabled={!start}>Book time off</button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove this time off?"
        message={confirmRemove ? `Warnings for these days stop, and future recurring cleans will include ${(userName || '').split(' ')[0]} again. Cleans they were already removed from are NOT re-assigned automatically — re-add them by hand where needed.` : ''}
        confirmLabel="Remove time off"
        onConfirm={() => { if (confirmRemove) dispatch({ type: ACTIONS.DELETE_TIME_OFF, id: confirmRemove.id }); setConfirmRemove(null); }}
        onClose={() => setConfirmRemove(null)}
      />
    </div>
  );
}
