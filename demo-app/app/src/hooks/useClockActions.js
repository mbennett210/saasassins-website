import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from '../store';
import { timeOffEntryFor } from '../store/timeOffRules';
import { ACTIONS } from '../store/reducer';
import { clockInRefusal, clockInWindow } from '../lib/clockInWindow';
import { useToast } from '../components/Toast';
import { useAuth } from './useAuth';
import { useOnlineStatus } from './useOnlineStatus';
import { useClockOutGate } from './useCleanChecklist';
import { useCrewPreview } from './useCrewPreview';
import * as timeApi from '../lib/timeApi';
import { metersToFeet, isOffSiteVerdict, OFF_SITE_SENTENCE_KEYS } from '../lib/geo';
import {
  clockOutButtonState,
  CHECKLIST_INCOMPLETE_CODE, CHECKLIST_CHECK_FAILED_CODE,
} from '../lib/clockOutBlock';
import { GATE } from '../lib/crewChecklist';
import { readChecklistDraft, submitChecklistDraft } from '../lib/checklistDraft';
import { clockOutPlan, CLOCK_OUT_PLAN } from '../lib/crewHome';
import * as qcApi from '../lib/qcApi';
import { DOUBLE_PUNCH_CODE, doublePunchKey } from '../lib/openPunchRule';
import { fmtTime } from '../lib/dates';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { msg } from '../i18n/core';

// ── THE ONE CLOCK (the Cleaner Hub, brief A §4) ───────────────────────────────────────────────
// Everything a clock-in or a clock-out DOES lives here; the controls only draw it. Two renderers:
// components/ClockControl (a clean's visit, JobDetail's step 5) and pages/crew/CrewClock (the
// cleaner's Clock In / Clock Out screen). Before this hook the logic lived inside ClockControl, and
// a second screen would have been a second copy of the window, the booked-off ask, the checklist
// lock, the double-punch answer and the server's 409 / 503 — the drift this build cannot afford.
//
// What it handles (each rule's history is in the note beside it):
//   • outside the geofence  -> 🔴 PAY-17 (Matt, 2026-09-30): NOTHING IS BLOCKED. The punch is
//     taken, recorded with the server's honest verdict, HELD for the supervisor's approval like
//     every punch, and the supervisor is alerted the moment it lands. The cleaner just gets a
//     plain warning (`clock.offSite`) — no "clock in anyway", no reason they must type to be
//     allowed to work.
//   • already clocked in (409) -> reconcile by refetching.
//   • no connectivity -> the punch is BUFFERED on this phone (lib/timeApi + lib/timeQueue) and
//     replayed when the signal returns, and the cleaner is told it will sync. It fails closed only
//     when the phone cannot store it (no IndexedDB, over quota) — and says so (CS-284).
//   • an unfinished checklist on clock-OUT -> the button LOCKS with the progress and a way to the
//     checklist (R4-R6; hooks/useCleanChecklist + lib/clockOutBlock, UI_RULES §131). The server
//     refuses the same case with 409 checklist_incomplete, and that answer overrides the local one.
//   • a checklist kept ON THE PHONE and not saved yet (the Cleaner Hub's checklist page saves to
//     the server once, at the end — lib/checklistDraft): a FINISHED draft makes the action "Save
//     checklist & clock out" — B's submitChecklistDraft first, then the clock-out, in that order;
//     a failed save clocks nothing out and says why. With the lock OFF for this cleaner a PARTIAL
//     draft is saved first too, so the office sees what was done. The pure plan is lib/crewHome
//     clockOutPlan. Offline the save queues (lib/qcApi) and the clock-out buffers, and the
//     reconnect drains the checklist queue BEFORE the punches (lib/offlineFlush).
//   • 🔴 the owner's View-as a cleaner (useCrewPreview, plan D8): the server still sees the OWNER,
//     so a punch would be the owner's. While previewing nothing is sent; the renderers disable the
//     buttons and the shell's one line says why.
//
// Every word it shows is a catalog line in the cleaner's language (CS-193). `entry` is this
// clean's open/last time entry (or null). `onChange` asks the parent to refetch its projections;
// `onClockedIn(entry)` / `onClockedOut(entry)` let a screen move on after a punch.

// The Clock out button's words when a finished checklist is saved as it clocks out (a catalog message,
// rendered like lib/clockOutBlock's labels).
const SAVE_AND_CLOCK_OUT = msg('crewClock.saveAndClockOut');

// The office's auto-close grace (Settings → Operations), which also closes the clock-in window.
const selectAutoCloseGraceMins = (s) => s.opsSettings?.autoCloseGraceMins;

// A crew-friendly "how far off" label for the off-site warning. Deliberately fuzzy ("about"), and
// it SUPPRESSES an implausible reading (> ~10 mi ⇒ GPS is off, or the device was never spoofed to
// the site in demo) rather than printing a nonsense distance like "14,435,079 ft". Feet up close,
// miles once it's a real trip.
export function formatAway(t, distanceM) {
  if (!Number.isFinite(distanceM) || distanceM <= 0 || distanceM > 16093) return null;
  const ft = metersToFeet(distanceM);
  if (ft < 1000) return t('clock.distanceFeet', { feet: Math.round(ft / 10) * 10 });
  return t('clock.distanceMiles', { miles: (distanceM / 1609.344).toFixed(1) });
}

// 🔴 PAY-17: what the cleaner is told when a punch lands off the ring — one plain catalog sentence,
// in their language, chosen by the SERVER's verdict (lib/geo OFF_SITE_SENTENCE_KEYS, CS-689):
// measurably away is `clock.offSite`, with the distance said first only when it is plausible; no
// location at all is `clock.noLocation`, which asks for Location instead of claiming they are
// elsewhere.
function offSiteWarning(t, verdict, distanceM) {
  const sentence = t(OFF_SITE_SENTENCE_KEYS[verdict] || OFF_SITE_SENTENCE_KEYS.outside);
  if (verdict !== 'outside') return sentence;
  const away = formatAway(t, distanceM);
  return away ? `${t('clock.offSiteDistance', { distance: away })} ${sentence}` : sentence;
}

// Errors the clock words itself, by code (src/i18n/errors.js); anything else keeps the server's
// words for an English reader and gets the translated "couldn't clock in/out" with them.
const CLOCK_ERRORS = {
  'offline-unbufferable-in': 'clock.error.unbufferableIn',
  'offline-unbufferable-out': 'clock.error.unbufferableOut',
};

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

export function useClockActions({ job, ctx, entry, onChange = null, onClockedIn = null, onClockedOut = null }) {
  const t = useT();
  const toast = useToast();
  const dispatch = useDispatch();
  const { currentUser } = useAuth();
  const online = useOnlineStatus();
  const { previewing } = useCrewPreview();
  const [busy, setBusy] = useState(false);
  // The server's 409 checklist_incomplete, when one arrives: an old bundle, a stale local read, or
  // a submission that never synced. The server is the authority, so this wins.
  const [serverBlock, setServerBlock] = useState(null);
  // The server's 503 checklist_check_failed: it could NOT judge (the blob, the job row or
  // checklist_results was unreadable) and recorded nothing. Deliberately NOT serverBlock — that
  // locks the button and tells the cleaner to finish a checklist they may well have finished. This
  // keeps the button live so the next tap is the retry.
  const [checkFailed, setCheckFailed] = useState(false);

  const isOpen = !!entry && !entry.clock_out_at;
  const isDone = !!entry && !!entry.clock_out_at;

  // 🔴 THE CLOCK-IN WINDOW (CS-052): from 2 h before the clean starts until its end plus the
  // auto-close grace (lib/clockInWindow). It replaced a CALENDAR-DAY gate (`dates.sameDay`) that
  // refused the cleaner who reached an 11 PM clean at 00:30 — the night's hours went unrecorded.
  // Clock-OUT is never gated (overnight / forgotten punches). The clock ticks while the button
  // waits, so it opens at the minute the window does without a reload.
  const graceMins = useSelector(selectAutoCloseGraceMins);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const waitingToOpen = !entry && !!job?.startAt;
  useEffect(() => {
    if (!waitingToOpen) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, [waitingToOpen]);
  const windowRefusal = waitingToOpen ? clockInRefusal(job, nowMs, { graceMins }) : null;
  const opensAt = windowRefusal === 'early' ? clockInWindow(job, { graceMins })?.opensAt : null;
  const opensAtText = opensAt ? fmtTime(new Date(opensAt).toISOString()) : '';

  // 🔴 BOOKED OFF THAT DAY (CS-693): the cleaner called out or has time off on the org-day this
  // clean starts (store/timeOffRules, the office's own conflict rule). They are ASKED before a
  // clock-in — never blocked: a manager may have asked them to come in after all, and a punch is a
  // fact. Crew hold their own time off only.
  const bookedOff = useSelector(useCallback(
    (s) => (job?.startAt && currentUser?.id ? timeOffEntryFor(s.timeOff, currentUser.id, job.startAt) : null),
    [job?.startAt, currentUser?.id],
  ));
  const [askOff, setAskOff] = useState(false);

  // 🔴 THE CLOCK-OUT BLOCK (R4-R6, UI_RULES §131). A cleaner with a checklist on this clean cannot
  // clock THEMSELVES out until it is finished. The rule is the shared clockOutGate; the server
  // refuses the same thing (api/_lib/time/checklistGate), so this is the courtesy, not the
  // boundary. It applies ONLY to the entry's own owner: a manager closing someone else's punch is
  // the documented escape hatch (R5) and is never gated.
  const ownEntry = !!entry && (!entry.user_id || entry.user_id === currentUser?.id);
  const { gate, checklistId, loading: gateLoading, reload: reloadChecklist } = useClockOutGate({
    job: ownEntry && isOpen ? job : null,
    entry: ownEntry && isOpen ? entry : null,
    online,
  });
  // Drop a stale 409 once there is nothing left to finish. clockOutButtonState already renders it
  // as superseded, but the STATE has to go too, or a later refusal for a different reason would be
  // read against it. The cleaner usually finishes on the checklist page, which never touches this
  // hook's state.
  useEffect(() => {
    const settled = gate.state === GATE.DONE || gate.state === GATE.OFF || gate.state === GATE.NONE;
    if (serverBlock && settled) setServerBlock(null);
    // A failed check is also superseded by any local answer: once the client CAN judge, the stale
    // "couldn't check" note is noise.
    if (checkFailed && (settled || gate.state === GATE.BLOCKED)) setCheckFailed(false);
  }, [serverBlock, checkFailed, gate.state]);

  // Someone else's punch is never gated, so it gets the normal button outright rather than a null
  // gate (which clockOutButtonState would correctly read as "still checking").
  // The draft on the phone for this clean, this checklist and this cleaner (lib/checklistDraft),
  // read again whenever the screen comes back into view: the checklist page writes it.
  const draftUserId = entry?.user_id || currentUser?.id || null;
  const [draftTick, setDraftTick] = useState(0);
  useEffect(() => {
    const again = () => setDraftTick((n) => n + 1);
    const onVisible = () => { if (document.visibilityState === 'visible') again(); };
    window.addEventListener('focus', again);
    window.addEventListener('storage', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener('storage', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const draft = useMemo(
    () => (ownEntry && isOpen && job?.id && checklistId ? readChecklistDraft({ jobId: job.id, templateId: checklistId, userId: draftUserId }) : null),
    [ownEntry, isOpen, job?.id, checklistId, draftUserId, draftTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const plan = ownEntry && isOpen ? clockOutPlan({ gate, draft }) : CLOCK_OUT_PLAN.OUT;
  // Why the last "Save checklist & clock out" stopped (the save failed), until the next try.
  const [saveError, setSaveError] = useState(null);

  const baseOut = ownEntry
    ? clockOutButtonState({ gate, loading: gateLoading, online, serverBlock, checkFailed })
    : clockOutButtonState({ gate: { state: GATE.NONE } });
  // A finished draft unlocks the button as "Save checklist & clock out": the save is what the
  // gate is waiting for, and the server judges the clock-out after it.
  const outState = plan === CLOCK_OUT_PLAN.SAVE_THEN_OUT
    ? { ...baseOut, locked: false, checking: false, label: SAVE_AND_CLOCK_OUT, hint: null, showOpenChecklist: false }
    : baseOut;
  const clockOutLocked = outState.locked || outState.checking;

  function startClockIn() {
    if (bookedOff) { setAskOff(true); return; }
    doClockIn();
  }

  async function doClockIn() {
    if (previewing) return;
    // Asked again at the tap, on the clock as it is now (the render's may be up to 30 s old).
    const refusal = clockInRefusal(job, Date.now(), { graceMins });
    if (refusal === 'early') {
      const at = clockInWindow(job, { graceMins })?.opensAt;
      toast.error(t('clock.window.earlyError', { time: at ? fmtTime(new Date(at).toISOString()) : '' }));
      return;
    }
    if (refusal === 'late') { toast.error(t('clock.window.closed')); return; }
    setBusy(true);
    try {
      const coords = await getCoords();
      const entry = await timeApi.clockIn({ jobId: job.id, lat: coords?.lat, lng: coords?.lng, accuracyM: coords?.accuracyM, ctx });
      if (entry?.pending_sync) toast.success(t('clock.inOffline'));
      // 🔴 PAY-17: the punch was TAKEN. The warning is about what happens next, not a refusal —
      // and the verdict is the SERVER'S, read off the entry it just wrote, so a spoofed or stale
      // client opinion can never decide whether the cleaner is warned.
      else if (isOffSiteVerdict(entry?.geofence_result)) toast.info(offSiteWarning(t, entry.geofence_result, entry.clock_in_distance_m));
      else toast.success(t('clock.inDone'));
      // Couple the clock to the schedule status (Sept 3): clocking in IS starting the clean, so a
      // job someone punched into must not read as 'Missed' on the Schedule. status is
      // crew-writable by design (jobsGuard). Only advance from not-yet-started states; never
      // override a done/cancelled job. Buffers + syncs with the punch offline.
      if (job && (job.status === 'upcoming' || job.status === 'missed')) {
        dispatch({ type: ACTIONS.SET_JOB_STATUS, id: job.id, status: 'in_progress' });
      }
      onChange?.();
      onClockedIn?.(entry);
    } catch (e) {
      if (e.status === 409 && (e.code || e.payload?.code) === DOUBLE_PUNCH_CODE) {
        // 🔴 PAY-13 / CS-318: still on the clock at ANOTHER clean. The message names it, and THIS
        // clean's status must NOT advance — nobody clocked in here, so healing it to in_progress
        // would mark a clean as started that nobody is at (the sibling branch below heals
        // deliberately, because there a 409 proves they ARE on the clock here).
        const place = e.payload?.openCleanName || null;
        toast.error(t(doublePunchKey(place), { place }));
      } else if (e.status === 409) {
        // Already clocked in TO THIS CLEAN. A 409 PROVES the crew is on the clock, so heal the
        // schedule status too — the first clock-in's response may have been lost in the field
        // before it transitioned, leaving the clean reading 'Missed' on a re-tap.
        if (job && (job.status === 'upcoming' || job.status === 'missed')) {
          dispatch({ type: ACTIONS.SET_JOB_STATUS, id: job.id, status: 'in_progress' });
        }
        toast.error(t('clock.error.alreadyIn')); onChange?.();
      } else {
        toast.error(errorText(t, e, 'clock.error.clockInFailed', CLOCK_ERRORS));
      }
    } finally { setBusy(false); }
  }

  async function doClockOut() {
    if (previewing) return;
    setBusy(true);
    try {
      const coords = await getCoords();
      // PAY-12 (Matt, 2026-09-29: "all clock-ins and clock-outs need to be recorded at the actual
      // site"): the clock-OUT carries the accuracy and the clean's context too, so the server
      // measures this end against the site the way it measures the clock-in — and the demo stub
      // reaches the same verdict. Nothing here decides it: an off-site clock-out is recorded and
      // flagged for the approver, never blocked.
      // `jobId` + `clockInAt` ride a buffered clock-out (CS-666), so the card still reads
      // "clocked out · will sync" offline even when the phone holds no row for this punch.
      const { entry: closed, jobDone } = await timeApi.clockOut({
        entryId: entry.id, lat: coords?.lat, lng: coords?.lng, accuracyM: coords?.accuracyM,
        userId: entry.user_id, ctx, jobId: entry.job_id || job?.id || null, clockInAt: entry.clock_in_at || null,
      });
      setServerBlock(null);
      setCheckFailed(false);
      if (closed?.pending_sync) toast.success(t('clock.outOffline'));
      // PAY-17, the other end: same warning, same server-side verdict, same held punch.
      else if (isOffSiteVerdict(closed?.geofence_result_out)) toast.info(offSiteWarning(t, closed.geofence_result_out, closed.clock_out_distance_m));
      else toast.success(t('clock.outDone'));
      // 🔴 CS-051: the clean is done only when its LAST cleaner clocks out, and only the server sees
      // every punch on it — so the server decides, writes the status, and answers jobDone; this
      // mirrors it at once (the realtime row follows). An offline clock-out decides nothing here:
      // its replay settles the clean when it lands.
      if (jobDone && job && job.status !== 'done' && job.status !== 'cancelled') {
        dispatch({ type: ACTIONS.SET_JOB_STATUS, id: job.id, status: 'done' });
      }
      onChange?.();
      onClockedOut?.(closed);
    } catch (e) {
      // The server refused because the checklist isn't finished (R4). Re-read the clean's
      // submissions — the local answer was stale or never synced — and show the locked state with
      // the SERVER's progress until the cleaner finishes it.
      if (e.status === 409 && e.payload?.code === CHECKLIST_INCOMPLETE_CODE) {
        setServerBlock({ done: e.payload.done ?? 0, total: e.payload.total ?? 0 });
        setCheckFailed(false);
        reloadChecklist();
        toast.error(t('clock.error.checklistIncomplete'));
      } else if (e.status === 503 && e.payload?.code === CHECKLIST_CHECK_FAILED_CODE) {
        // The server couldn't check, so nothing was recorded. Say so and leave the button live: the
        // next tap retries, and the re-read may answer locally in the meantime.
        setCheckFailed(true);
        setServerBlock(null);
        reloadChecklist();
        toast.error(t('clock.error.checkFailed'));
      } else {
        toast.error(errorText(t, e, 'clock.error.clockOutFailed', CLOCK_ERRORS));
      }
    } finally { setBusy(false); }
  }

  // The Clock out action both clocks call: the draft's save first when the plan says so, then the
  // clock-out. A failed save under the lock stops here (nothing clocked out, the reason said); with
  // the lock off the clock-out goes ahead and the draft stays on the phone.
  async function finishClockOut() {
    if (previewing) return;
    if (plan === CLOCK_OUT_PLAN.OUT) { await doClockOut(); return; }
    setBusy(true);
    setSaveError(null);
    try {
      await submitChecklistDraft({
        job: { id: job.id, siteId: job.siteId || ctx?.siteId || null, clientId: job.clientId || ctx?.clientId || null },
        templateId: checklistId,
        userId: draftUserId,
        draft,
        submit: qcApi.submitChecklist,
      });
      setDraftTick((n) => n + 1);
      reloadChecklist();
    } catch (e) {
      if (plan === CLOCK_OUT_PLAN.SAVE_THEN_OUT) {
        setBusy(false);
        const why = errorText(t, e, 'crewClock.saveFailed');
        setSaveError(why);
        toast.error(why);
        return;
      }
      toast.info(t('crewClock.partialNotSaved'));
    }
    await doClockOut();
  }

  return {
    finishClockOut, plan, saveError, draft,
    isOpen, isDone, busy, previewing,
    windowRefusal, opensAtText,
    bookedOff, askOff, setAskOff, startClockIn, doClockIn,
    doClockOut, gate, checklistId, gateLoading, outState, clockOutLocked, reloadChecklist,
    pending: !!entry?.pending_sync,
  };
}
