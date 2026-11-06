import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import { useClockActions } from '../hooks/useClockActions';
import { useFromHere } from '../hooks/useFromHere';
import { CLOCK_IN_LEAD_MS } from '../lib/clockInWindow';
import { crewAutoCloseNoteKey } from '../lib/autoClose';
import { crewPaths } from '../lib/crewPaths';
import { fmtTime, fmtDuration } from '../lib/dates';
import { useT } from '../i18n/react';

// The clock-in / clock-out control for ONE clean, inside a clean's visit (components/CrewJobVisit,
// JobDetail's step 5). It only DRAWS the clock: what a punch does — the window (CS-052), the
// booked-off ask (CS-693), PAY-17's held off-site punch, the checklist lock (R4-R6, UI_RULES §131),
// the double-punch and 409 / 503 answers, the toasts, the schedule status — is
// hooks/useClockActions, the one clock the Cleaner Hub's Clock In / Clock Out screen
// (pages/crew/CrewClock) draws too. Every word is a catalog line in the cleaner's language
// (CS-193). `entry` is this clean's open/last time entry (or null); `onChange` asks the parent to
// refetch. The control owns no synced state.
//
// Locked by the checklist, the button carries the reason and the progress, and "Open checklist"
// goes to the cleaner's checklist page for this clean (lib/crewPaths checklist) — the full-page
// checklist of the Cleaner Hub. (The office's standalone ChecklistFill stays where the office uses
// it; the clock no longer opens a pop-up of its own.)
export default function ClockControl({ job, ctx, entry, onChange, compact = false, size = 'md' }) {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const {
    isOpen, isDone, busy, previewing, windowRefusal, opensAtText,
    askOff, setAskOff, startClockIn, doClockIn, finishClockOut, saveError, outState, clockOutLocked, pending,
  } = useClockActions({ job, ctx, entry, onChange });

  // size="lg" makes the primary clock button a full-width, thumb-sized bar (the visit's step).
  const wrapCls = size === 'lg' ? 'clock-control clock-control-lg' : 'clock-control';
  // Offline punches not yet replayed to the server — show a subtle "will sync" note.
  const pendingNote = pending
    ? <span className="text-muted text-xs" title={t('clock.willSyncTitle')}>{t('clock.willSync')}</span>
    : null;

  if (isDone) {
    // CS-667: when the APP closed this punch (the hourly auto-close, never corrected since), the
    // cleaner reads that it did, and — for a late start — why, so "Clocked out" is never a
    // surprise and they know their manager checks the time (lib/autoClose).
    const autoNoteKey = crewAutoCloseNoteKey(entry);
    return (
      <div className={`${wrapCls} clock-control-done${autoNoteKey ? ' has-autoclose-note' : ''}`}>
        <Icon name="check" size={16} />
        <span>{t.rich('clock.doneSummary', { duration: fmtDuration(entry.duration_minutes) })}</span>
        <span className="text-muted text-xs">{fmtTime(entry.clock_in_at)}–{fmtTime(entry.clock_out_at)}</span>
        {pendingNote}
        {autoNoteKey && <span className="clock-autoclose-note text-xs" role="note">{t(autoNoteKey, { time: fmtTime(entry.clock_out_at) })}</span>}
      </div>
    );
  }

  if (isOpen) {
    // Locked by the checklist block: the button itself carries the reason and the progress
    // (UI_RULES §118 / §131 — never an inert control with no explanation), and "Open checklist"
    // takes the cleaner straight to the one they were assigned on this clean.
    return (
      <div className={`${wrapCls}${clockOutLocked ? ' clock-control-locked' : ''}`}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || clockOutLocked || previewing}
          aria-describedby={outState.hint ? `clock-locked-hint-${entry.id}` : undefined}
          onClick={finishClockOut}
        >
          <Icon name="check" size={16} /> {t(outState.label)}
        </button>
        {outState.showOpenChecklist && job?.id && (
          <button type="button" className="btn btn-gold" onClick={() => navigate(crewPaths.checklist(job.id), { state: nav })}>
            {t('clock.openChecklist')}
          </button>
        )}
        {outState.hint && (
          <span id={`clock-locked-hint-${entry.id}`} className="clock-locked-hint text-xs" role="status">
            {t(outState.hint)}
          </span>
        )}
        {saveError && <span className="clock-locked-hint text-xs" role="alert">{saveError}</span>}
        {!compact && !clockOutLocked && <span className="text-muted text-xs">{t('clock.inSince', { time: fmtTime(entry.clock_in_at) })}</span>}
        {pendingNote}
      </div>
    );
  }

  return (
    <div className={wrapCls}>
      {windowRefusal ? (
        <div className="clock-wrongday">
          <button
            type="button"
            className="btn btn-primary"
            disabled
            title={windowRefusal === 'early' ? t('clock.window.earlyTitle', { hours: CLOCK_IN_LEAD_MS / 3600000 }) : undefined}
          >
            <Icon name="schedule" size={16} /> {t('clock.in')}
          </button>
          <span className="text-muted text-xs">
            {windowRefusal === 'early' ? t('clock.window.opensAt', { time: opensAtText }) : t('clock.window.closed')}
          </span>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" disabled={busy || previewing} onClick={startClockIn}>
          <Icon name="schedule" size={16} /> {busy ? t('clock.locating') : t('clock.in')}
        </button>
      )}
      <ClockTimeOffDialog askOff={askOff} setAskOff={setAskOff} doClockIn={doClockIn} />
    </div>
  );
}

// The booked-off ask (CS-693), shared by both clocks: a confirm whose yes clocks in — never a block.
export function ClockTimeOffDialog({ askOff, setAskOff, doClockIn }) {
  const t = useT();
  return (
    <ConfirmDialog
      open={askOff}
      title={t('clock.timeOff.title')}
      message={t('clock.timeOff.body')}
      confirmLabel={t('clock.timeOff.confirm')}
      onConfirm={() => doClockIn()}
      onClose={() => setAskOff(false)}
    />
  );
}
