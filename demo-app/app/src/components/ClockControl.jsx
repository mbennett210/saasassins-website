import { useEffect, useState } from 'react';
import Icon from './Icon';
import ChecklistFill from './ChecklistFill';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { useAuth } from '../hooks/useAuth';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useClockOutGate } from '../hooks/useCleanChecklist';
import * as timeApi from '../lib/timeApi';
import { metersToFeet } from '../lib/geo';
import {
  clockOutButtonState, CLOCK_OUT_LABEL,
  CHECKLIST_INCOMPLETE_CODE, CHECKLIST_CHECK_FAILED_CODE,
} from '../lib/clockOutBlock';
import { GATE } from '../lib/crewChecklist';
import { fmtTime, fmtDuration, sameDay } from '../lib/dates';

// A crew-friendly "how far off" label for the off-site prompt. Deliberately fuzzy
// ("about"), and it SUPPRESSES an implausible reading (> ~10 mi ⇒ GPS is off, or the
// device was never spoofed to the site in demo) rather than printing a nonsense
// distance like "14,435,079 ft". Feet up close, miles once it's a real trip.
function formatAway(distanceM) {
  if (!Number.isFinite(distanceM) || distanceM <= 0 || distanceM > 16093) return null;
  const ft = metersToFeet(distanceM);
  if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
  return `${(distanceM / 1609.344).toFixed(1)} mi`;
}

// The clock-in / clock-out control for ONE clean. Used by the My Day hub for each
// of today's cleans, so the geofence handling lives in one place. Captures device coords
// (best-effort), calls timeApi, and surfaces the three outcomes the crew can hit:
//   • outside the geofence  -> a block with distance + an explicit, FLAGGED
//     "clock in anyway" override (the crew is the one physically on site; a
//     mis-calibrated ring shouldn't strand them — the override is recorded as
//     geofence_result='override' and shows in the variance drill-down).
//   • already clocked in (409) -> reconcile by refetching.
//   • no connectivity -> FAIL-CLOSED: a clear "no signal" message, never a
//     blind buffer that would backdate a server timestamp (CLEANSPACE_SWEPT.md §5.4).
//   • an unfinished checklist on clock-OUT -> the button LOCKS with the progress and an
//     "Open checklist" action (R4-R6; hooks/useCleanChecklist + lib/clockOutBlock,
//     UI_RULES §131). The server refuses the same case with 409 checklist_incomplete, and
//     that answer overrides the local one.
//
// `entry` is this clean's open/last time entry (or null). `onChange` asks the
// parent to refetch its projections. The control owns no synced state.
function getCoords() {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      () => resolve(null), // permission denied / unavailable -> proceed; server flags 'unavailable'
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

export default function ClockControl({ job, ctx, entry, onChange, compact = false, size = 'md' }) {
  const toast = useToast();
  const dispatch = useDispatch();
  const { currentUser } = useAuth();
  const online = useOnlineStatus();
  const [busy, setBusy] = useState(false);
  const [block, setBlock] = useState(null); // { distanceM, allowedM } when outside the ring
  // The server's 409 checklist_incomplete, when one arrives: an old bundle, a stale local
  // read, or a submission that never synced. The server is the authority, so this wins.
  const [serverBlock, setServerBlock] = useState(null);
  // The server's 503 checklist_check_failed: it could NOT judge (the blob, the job row or
  // checklist_results was unreadable) and recorded nothing. Deliberately NOT serverBlock —
  // that locks the button and tells the cleaner to finish a checklist they may well have
  // finished. This keeps the button live so the next tap is the retry.
  const [checkFailed, setCheckFailed] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);

  const isOpen = !!entry && !entry.clock_out_at;
  const isDone = !!entry && !!entry.clock_out_at;
  // size="lg" makes the primary clock button a full-width, thumb-sized bar (My Day
  // timeline). Only the top-level clock-in/out button grows — the geofence-override
  // buttons live inside .clock-geofence-block and keep their own size.
  const wrapCls = size === 'lg' ? 'clock-control clock-control-lg' : 'clock-control';
  // Same-day gate: a crew can only clock into a clean on the day it's scheduled. Blocks
  // punching into a future/past job from its detail page; My Day only lists today's cleans
  // so it's a no-op there. Clock-OUT is never gated (overnight/forgotten punches).
  const wrongDay = !!job?.startAt && !sameDay(job.startAt, new Date());

  // 🔴 THE CLOCK-OUT BLOCK (R4-R6, UI_RULES §131). A cleaner with a checklist on this clean
  // cannot clock THEMSELVES out until every item is ticked. The rule is the shared
  // clockOutGate; the server refuses the same thing (api/_lib/time/checklistGate), so this
  // is the courtesy, not the boundary. It applies ONLY to the entry's own owner: a manager
  // closing someone else's punch is the documented escape hatch (R5) and is never gated.
  const ownEntry = !!entry && (!entry.user_id || entry.user_id === currentUser?.id);
  const { gate, checklistId, loading: gateLoading, reload: reloadChecklist } = useClockOutGate({
    job: ownEntry && isOpen ? job : null,
    entry: ownEntry && isOpen ? entry : null,
    online,
  });
  // Someone else's punch is never gated, so it gets the normal button outright rather than
  // a null gate (which clockOutButtonState would correctly read as "still checking").
  // Drop a stale 409 once there is nothing left to finish. clockOutButtonState already
  // renders it as superseded, but the STATE has to go too, or a later refusal for a
  // different reason would be read against it. The cleaner usually finishes through the
  // sibling checklist card, which never touches this component's state.
  useEffect(() => {
    const settled = gate.state === GATE.DONE || gate.state === GATE.OFF || gate.state === GATE.NONE;
    if (serverBlock && settled) setServerBlock(null);
    // A failed check is also superseded by any local answer: once the client CAN judge,
    // the stale "couldn't check" note is noise.
    if (checkFailed && (settled || gate.state === GATE.BLOCKED)) setCheckFailed(false);
  }, [serverBlock, checkFailed, gate.state]);

  const outState = ownEntry
    ? clockOutButtonState({ gate, loading: gateLoading, online, serverBlock, checkFailed })
    : { locked: false, checking: false, label: CLOCK_OUT_LABEL, hint: null, showOpenChecklist: false };
  const clockOutLocked = outState.locked || outState.checking;

  async function doClockIn(override = false) {
    if (wrongDay) { toast.error('You can only clock in on the day of the clean.'); return; }
    setBusy(true); setBlock(null);
    try {
      const coords = await getCoords();
      const entry = await timeApi.clockIn({ jobId: job.id, lat: coords?.lat, lng: coords?.lng, accuracyM: coords?.accuracyM, override, overrideReason: override ? 'crew_override_offsite' : undefined, ctx });
      if (entry?.pending_sync) toast.success('Clocked in. Offline. It’ll sync when you’re back online.');
      else toast.success(override ? 'Clocked in (flagged. Outside geofence)' : 'Clocked in');
      // Couple the clock to the schedule status (Sept 3): clocking in IS starting the
      // clean, so a job someone punched into must not read as 'Missed' on the Schedule.
      // status is crew-writable by design (jobsGuard). Only advance from not-yet-started
      // states; never override a done/cancelled job. Buffers + syncs with the punch offline.
      if (job && (job.status === 'upcoming' || job.status === 'missed')) {
        dispatch({ type: ACTIONS.SET_JOB_STATUS, id: job.id, status: 'in_progress' });
      }
      onChange?.();
    } catch (e) {
      if (e.status === 403 && e.payload?.geofence) {
        setBlock(e.payload.geofence);
      } else if (e.status === 409) {
        // Already clocked in. A 409 PROVES the crew is on the clock, so heal the
        // schedule status too — the first clock-in's response may have been lost in
        // the field before it transitioned, leaving the clean reading 'Missed' on a
        // re-tap (and it heals any clean punched into before this fix shipped).
        if (job && (job.status === 'upcoming' || job.status === 'missed')) {
          dispatch({ type: ACTIONS.SET_JOB_STATUS, id: job.id, status: 'in_progress' });
        }
        toast.error(e.message); onChange?.();
      } else {
        toast.error(e.message || 'Couldn’t clock in. Please try again.');
      }
    } finally { setBusy(false); }
  }

  async function doClockOut() {
    setBusy(true);
    try {
      const coords = await getCoords();
      const result = await timeApi.clockOut({ entryId: entry.id, lat: coords?.lat, lng: coords?.lng, userId: entry.user_id });
      setServerBlock(null);
      setCheckFailed(false);
      if (result?.pending_sync) toast.success('Clocked out. Offline. It’ll sync when you’re back online.');
      else toast.success('Clocked out');
      // Clocking out completes the clean → mark the job done (unless already done or
      // cancelled). NOTE: on a multi-cleaner job the first clock-out marks it done;
      // marking done only on the LAST crew's clock-out needs the server (it alone sees
      // every open punch) — tracked as a follow-up.
      if (job && job.status !== 'done' && job.status !== 'cancelled') {
        dispatch({ type: ACTIONS.SET_JOB_STATUS, id: job.id, status: 'done' });
      }
      onChange?.();
    } catch (e) {
      // The server refused because the checklist isn't finished (R4). Re-read the clean's
      // submissions — the local answer was stale or never synced — and show the locked
      // state with the SERVER's progress until the cleaner finishes it.
      if (e.status === 409 && e.payload?.code === CHECKLIST_INCOMPLETE_CODE) {
        setServerBlock({ done: e.payload.done ?? 0, total: e.payload.total ?? 0 });
        setCheckFailed(false);
        reloadChecklist();
        toast.error(e.message || 'Finish your checklist before you clock out');
      } else if (e.status === 503 && e.payload?.code === CHECKLIST_CHECK_FAILED_CODE) {
        // The server couldn't check, so nothing was recorded. Say so and leave the button
        // live: the next tap retries, and the re-read may answer locally in the meantime.
        setCheckFailed(true);
        setServerBlock(null);
        reloadChecklist();
        toast.error(e.message || 'Couldn’t check your checklist. Try again.');
      } else {
        toast.error(e.message || 'Could not clock out');
      }
    } finally { setBusy(false); }
  }

  // Offline punches not yet replayed to the server — show a subtle "will sync" note.
  const pending = !!entry?.pending_sync;
  const pendingNote = pending
    ? <span className="text-muted text-xs" title="Saved on this device. Will sync when you’re back online.">· will sync</span>
    : null;

  if (isDone) {
    return (
      <div className={`${wrapCls} clock-control-done`}>
        <Icon name="check" size={16} />
        <span>Clocked out · <strong>{fmtDuration(entry.duration_minutes)}</strong></span>
        <span className="text-muted text-xs">{fmtTime(entry.clock_in_at)}–{fmtTime(entry.clock_out_at)}</span>
        {pendingNote}
      </div>
    );
  }

  if (isOpen) {
    // Locked by the checklist block: the button itself carries the reason and the progress
    // (UI_RULES §118 / §131 — never an inert control with no explanation), and "Open
    // checklist" takes the cleaner straight to the one they were assigned on this clean.
    return (
      <div className={`${wrapCls}${clockOutLocked ? ' clock-control-locked' : ''}`}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || clockOutLocked}
          aria-describedby={outState.hint ? `clock-locked-hint-${entry.id}` : undefined}
          onClick={doClockOut}
        >
          <Icon name="check" size={16} /> {outState.label}
        </button>
        {outState.showOpenChecklist && (
          <button type="button" className="btn btn-gold" onClick={() => setFillOpen(true)}>
            Open checklist
          </button>
        )}
        {outState.hint && (
          <span id={`clock-locked-hint-${entry.id}`} className="clock-locked-hint text-xs" role="status">
            {outState.hint}
          </span>
        )}
        {!compact && !clockOutLocked && <span className="text-muted text-xs">In since {fmtTime(entry.clock_in_at)}</span>}
        {pendingNote}
        <ChecklistFill
          open={fillOpen}
          onClose={() => setFillOpen(false)}
          onSubmitted={() => { setFillOpen(false); setServerBlock(null); setCheckFailed(false); reloadChecklist(); }}
          presetSiteId={job?.siteId || ''}
          presetTemplateId={checklistId || ''}
          jobId={job?.id || null}
        />
      </div>
    );
  }

  const away = block ? formatAway(block.distanceM) : null;
  return (
    <div className={wrapCls}>
      {block ? (
        // Off-site: NO map/ring — a clean confirm prompt. The crew is physically on
        // site; a mis-calibrated fence shouldn't strand them, so we explain briefly and
        // offer the flagged override. distanceM can be wild (bad GPS / un-spoofed demo),
        // so formatAway() shows it only when it's plausible.
        <div className="clock-offsite" role="group" aria-label="Off-site clock-in confirmation">
          <div className="clock-offsite-row">
            <span className="clock-offsite-icon" aria-hidden="true"><Icon name="warning" size={16} /></span>
            <span className="clock-offsite-title">
              {away ? `You’re about ${away} from this location.` : 'You don’t appear to be at this location.'}
            </span>
          </div>
          <div className="clock-offsite-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => doClockIn(true)}>
              Clock in anyway
            </button>
            <button type="button" className="btn btn-link btn-sm" onClick={() => setBlock(null)}>Cancel</button>
          </div>
          <p className="clock-offsite-note text-muted text-xs">Off-site clock-ins are flagged for your manager to review.</p>
        </div>
      ) : wrongDay ? (
        <div className="clock-wrongday">
          <button type="button" className="btn btn-primary" disabled title="You can clock in on the day of the clean">
            <Icon name="schedule" size={16} /> Clock in
          </button>
          <span className="text-muted text-xs">Available on the day of the clean.</span>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => doClockIn(false)}>
          <Icon name="schedule" size={16} /> {busy ? 'Locating…' : 'Clock in'}
        </button>
      )}
    </div>
  );
}
