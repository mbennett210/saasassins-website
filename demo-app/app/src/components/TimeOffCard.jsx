import { useMemo, useState } from 'react';
import { useDispatch, useStore, useJobsDays } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectTimeOffForUser } from '../store/selectors';
import {
  TIME_OFF_KINDS, TIME_OFF_KIND_LABEL, isCallOut, defaultTimeOffKind, jobsRemovedByTimeOff, timeOffBooking,
  CALLOUT_REASONS, CALLOUT_REASON_LABEL, calloutReasonRefusal, CALLOUT_REASON_REFUSALS, timeOffReasonText,
  TIME_OFF_SAVED_KEYS,
} from '../store/timeOffRules';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useToast } from './Toast';
import FormField from './FormField';
import Badge from './Badge';
import ConfirmDialog from './ConfirmDialog';
import { todayKey, fmtDate, composeIso } from '../lib/dates';
import { newId } from '../lib/ids';
import { useT } from '../i18n/react';

// Time off, for real (Sept 1). Before this card existed, "she has the night
// off" had nowhere to live but a chat message — so cover got arranged by hand
// while the recurring series kept re-minting her onto that night's cleans and
// no surface could warn anyone. Booking here does BOTH halves in one motion:
// the durable record every scheduling surface now checks (warnings on assign /
// drag / detail, exclusion at series mint + top-up), and — on by default, for
// someone who may edit the schedule — the bulk removal from cleans that are
// ALREADY on the calendar in the range. HR › PTO books through the SAME
// timeOffRules.timeOffBooking and the same one action (CS-054).
export default function TimeOffCard({ userId, userName }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const t = useT();
  const canEdit = usePermission('settings.team.edit');
  // Bulk exclusion is a JOB edit over the booked days: it waits until every clean on those
  // days is loaded (the app holds the jobs window, not the table — CS-676; days outside it
  // are fetched when picked), or it would clear the record's clean-up half against a partial
  // set and the missed cleans would never be revisited. Booking the time-off RECORD itself
  // is blob-only and always safe.
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const daysLoaded = useJobsDays(start || null, end && end >= start ? end : start || null).ready;
  // ...and on being allowed to edit jobs at all (useCanEditJobs: schedule.edit, never
  // crew): the server puts a crew change back for crew and for a manager without the key
  // (jobsGuard), so the removal would look done and quietly revert. Without it the
  // booking is the record alone.
  const canEditJobs = useCanEditJobs();
  const entries = selectTimeOffForUser(state, userId)
    .slice()
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));

  const [reason, setReason] = useState('');
  // ALR-7: the call-out reason is one of a fixed list; the free text beside it is the NOTE,
  // required only for 'Other'. Planned time off keeps free text alone.
  const [calloutReason, setCalloutReason] = useState('');
  const [alsoRemove, setAlsoRemove] = useState(true);
  // Call-out vs planned. Follows the start date (today → call-out, later → planned)
  // until the booker picks one themselves.
  const [kindPicked, setKindPicked] = useState(null);
  const kind = kindPicked || defaultTimeOffKind(start, todayKey());
  const [confirmRemove, setConfirmRemove] = useState(null); // time-off entry pending un-book confirm

  // What "Also remove" can take them off — the SAME rule the booking's action applies
  // (timeOffRules.jobsRemovedByTimeOff: still ahead of now, never a series' template row),
  // so the number on the checkbox is the number changed. Asked again at the moment of booking.
  const affected = useMemo(() => {
    if (!start || !daysLoaded || !canEditJobs) return [];
    return jobsRemovedByTimeOff(state.jobs, { userId, startDate: start, endDate: end || start, now: Date.now() });
  }, [state.jobs, userId, start, end, daysLoaded, canEditJobs]);

  const add = () => {
    if (!start) { toast.error('Pick a start date.'); return; }
    const endDate = end || start;
    if (endDate < start) { toast.error('End date is before the start date.'); return; }
    // ALR-7: a call-out names one of the four reasons, and 'Other' names what happened.
    const reasonCode = calloutReasonRefusal({ kind, calloutReason, reason });
    if (reasonCode) { toast.error(CALLOUT_REASON_REFUSALS[reasonCode]); return; }
    // ONE booking, ONE action (CS-054): built NOW (not at the last render) by the same
    // timeOffBooking HR › PTO uses — the entry records every clean the person is on across
    // the booked days (Reports › Called out names them even after cover is swapped in), and
    // removeFromCleans takes them off the ones still ahead, in the same dispatch.
    const booking = timeOffBooking({
      jobs: state.jobs, id: newId('to'), userId, startDate: start, endDate, reason, kind, calloutReason,
      removeFromCleans: alsoRemove && daysLoaded && canEditJobs,
    });
    dispatch({ type: ACTIONS.ADD_TIME_OFF, entry: booking.entry, removeFromCleans: booking.removeFromCleans });
    const name = (userName || '').split(' ')[0] || userName || '';
    const keys = TIME_OFF_SAVED_KEYS[kind === 'callout' ? 'callout' : 'planned'];
    toast.success(booking.removed.length
      ? t(keys.removed, { name, count: booking.removed.length })
      : t(keys.saved));
    setStart(''); setEnd(''); setReason(''); setCalloutReason(''); setAlsoRemove(true); setKindPicked(null);
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
              <span className="text-muted">{timeOffReasonText(t)}</span>
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
          {kind === 'callout' && (
            <FormField label="Reason" required>
              <div className="tab-container-line" role="group" aria-label="Reason for the call-out">
                {CALLOUT_REASONS.map((r) => (
                  <button key={r} type="button" className={`tab-btn ${calloutReason === r ? 'active' : ''}`} aria-pressed={calloutReason === r} onClick={() => setCalloutReason(r)}>
                    {CALLOUT_REASON_LABEL[r]}
                  </button>
                ))}
              </div>
            </FormField>
          )}
          <FormField
            label={kind === 'callout' ? 'Note' : 'Reason'}
            required={kind === 'callout' && calloutReason === 'other'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={kind === 'callout'
              ? (calloutReason === 'other' ? 'Required — what happened?' : 'Optional — anything the office should know')
              : 'Optional — e.g. vacation, appointment'}
          />
          {affected.length > 0 && (
            <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={alsoRemove} onChange={(e) => setAlsoRemove(e.target.checked)} />
              {t('timeOffBook.alsoRemove', { name: (userName || '').split(' ')[0] || userName || '', count: affected.length })}
            </label>
          )}
          {!daysLoaded && start && canEditJobs && (
            <div className="text-xs text-muted">
              {t('timeOffBook.loading')}
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
