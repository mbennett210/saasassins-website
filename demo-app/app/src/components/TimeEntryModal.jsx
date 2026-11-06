import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import SearchSelect from './SearchSelect';
import { useStore, useJobsDays } from '../store';
import { useToast } from './Toast';
import { useTimeScope } from '../hooks/useTimeScope';
import { roleLabel } from '../lib/roles';
import {
  selectActiveUsers, selectJobs, selectSiteById, selectClientById, selectClockContextForJob,
} from '../store/selectors';
import * as timeApi from '../lib/timeApi';
import { validatePunchTimes, reasonRefusal, TIME_REFUSAL_KEYS } from '../lib/timeRules';
import { cleansForCleanerDay } from '../lib/filters/timeApprovals';
import { formTimeOf, openCorrectionForm, buildCorrectionPatch, resolveFormTime, foldChoices } from '../lib/timeEntryForm';
import { fmtTimeWithZone } from '../lib/wallClock';
import { fmtDateLong, fmtTime, todayKey, addDaysKey, dayKey, startOfDayKey } from '../lib/dates';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

// Manager time-entry editor — two modes:
//   'manual'  → add a missed clean's time (forgotten clock-in). Drives /api/time/manual.
//   'correct' → fix an existing entry's clock-in/out + note, with a reason for the
//               append-only edit_history, carrying the row version (CAS). Drives /api/time/correct.
// A REASON IS REQUIRED IN BOTH MODES (PAY-11, Matt 2026-09-29: "when a manager edits someone's
// time, must they give a reason? — Yes"), as Delete always has. No default text stands in: Add
// time used to send 'manual entry' for a blank field, so the audit trail said nothing. The
// server and the demo stub refuse a blank one through the same shared rule (lib/timeRules
// reasonRefusal), and this gate mirrors it — it is not the boundary.
// All timestamps go to the server as ISO; the server re-stamps nothing here (manual + correct are
// explicitly manager-asserted times, flagged in the audit trail). The <datetime-local> input
// shows and captures the SITE's wall clock (org tz), so a manager correcting a clean's times sees
// them wherever they sit and saves back the same instant.
//
// Add mode (spec §8.2, fixes CS-050): cleaner → DAY (a prefill, else yesterday in the org zone,
// with a day stepper) → that cleaner's cleans that day ±1 (past included), scoped to the
// manager's customers — NOT the old "200 latest-dated jobs" list, which in a live book was all
// future work. A `prefill` ({ userId, jobId, dayKey, clockInAt, clockOutAt }) seeds it from a
// Missing-time row. Picking a clean prefills the scheduled start/end for the manager to adjust.
//
// 🔴 Correct mode SENDS ONLY WHAT THE MANAGER CHANGED (CS-694; lib/timeEntryForm). A time field
// left alone keeps its ORIGINAL instant — to the millisecond — and is not sent, so adding a note
// to an approved punch no longer rewrites its times or sends it back for approval.
// 🔴 And it knows WHICH 1 AM (CS-668): the night the clocks go back, a time in the repeated hour
// carries its fold (first / second, lib/wallClock), the form offers the choice only there, and a
// new time typed into that hour waits for the manager to pick one.

// The "which 1 AM?" choice under a time field — rendered only when the typed wall time happened
// twice in the org's zone (lib/timeEntryForm foldChoices). Each option names its zone ("EDT" /
// "EST") so the two read as an hour apart.
function FoldChoice({ input, fold, onPick }) {
  const t = useT();
  const choices = foldChoices(input);
  if (!choices) return null;
  return (
    <div className="te-fold">
      <p className="text-muted text-xs te-fold-prompt">{t('timeEntry.fold.prompt', { time: fmtTime(choices.first) })}</p>
      <div className="segmented" role="group" aria-label={t('timeEntry.fold.label')}>
        <button type="button" className={`segmented-btn ${fold === 'first' ? 'active' : ''}`} aria-pressed={fold === 'first'} onClick={() => onPick('first')}>
          {t('timeEntry.fold.first', { time: fmtTimeWithZone(choices.first) })}
        </button>
        <button type="button" className={`segmented-btn ${fold === 'second' ? 'active' : ''}`} aria-pressed={fold === 'second'} onClick={() => onPick('second')}>
          {t('timeEntry.fold.second', { time: fmtTimeWithZone(choices.second) })}
        </button>
      </div>
    </div>
  );
}
// Map a server/stub refusal to its plain sentence (spec §4.1), in the reader's language
// (CS-193): the stub sets err.code, the real route returns { error, code } (api() carries it on
// err.payload). A known code is its catalog line; anything else is the screen's own sentence
// for what failed (i18n/errors errorText — an English reader keeps the server's words).
export const refusalText = (t, e, fallbackKey) => {
  const code = e?.code || e?.payload?.code;
  if (code && TIME_REFUSAL_KEYS[code]) return t(TIME_REFUSAL_KEYS[code]);
  return errorText(t, e, fallbackKey);
};
// A refusal CODE the server answered for one item of a batch (approve), in the reader's language.
export const refusalCodeText = (t, code, fallbackKey) => (TIME_REFUSAL_KEYS[code] ? t(TIME_REFUSAL_KEYS[code]) : t(fallbackKey));

export default function TimeEntryModal({ open, onClose, mode = 'manual', entry = null, prefill = null, onSaved }) {
  const t = useT();
  const state = useStore();
  const toast = useToast();
  const { scope } = useTimeScope();
  const users = useMemo(() => selectActiveUsers(state), [state]);
  const jobs = useMemo(() => selectJobs(state), [state]);
  const [form, setForm] = useState({ userId: '', day: '', jobId: '', inAt: '', inFold: null, outAt: '', outFold: null, note: '', reason: '' });
  // Correct mode: the punch as the form opened it — what each save is measured against.
  const [initial, setInitial] = useState(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (mode === 'correct' && entry) {
      const opened = openCorrectionForm(entry);
      setForm({ userId: entry.userId || '', day: '', jobId: entry.jobId || '', ...opened.form, reason: '' });
      setInitial(opened.initial);
      return;
    }
    setInitial(null);
    if (prefill) {
      const day = prefill.dayKey || (prefill.clockInAt ? dayKey(prefill.clockInAt) : addDaysKey(todayKey(), -1));
      const inF = formTimeOf(prefill.clockInAt);
      const outF = formTimeOf(prefill.clockOutAt);
      setForm({
        userId: prefill.userId || '', day, jobId: prefill.jobId || '',
        inAt: inF.input, inFold: inF.fold, outAt: outF.input, outFold: outF.fold,
        note: '', reason: '',
      });
    } else {
      setForm({ userId: '', day: addDaysKey(todayKey(), -1), jobId: '', inAt: '', inFold: null, outAt: '', outFold: null, note: '', reason: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, entry, prefill]);

  // The chosen day's cleans are loaded (±1 day) when it lies outside the jobs window the app
  // holds (−45/+100 days, CS-676) — a punch entered for a clean two months back still finds it.
  useJobsDays(open && form.day ? form.day : null);
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  // The cleans the chosen cleaner could have a missed punch for on the chosen day (±1 org day,
  // past included, scoped) — the pure helper (unit-tested; the CS-050 fix).
  const cleanOptions = useMemo(() => {
    if (!form.userId || !form.day) return [];
    return cleansForCleanerDay({ jobs, cleanerId: form.userId, dayKey: form.day, scope })
      .map((j) => {
        const site = j.siteId ? selectSiteById(state, j.siteId) : null;
        const client = j.clientId ? selectClientById(state, j.clientId) : null;
        const label = `${client?.name || site?.name || t('timeEntry.aClean')} · ${fmtTime(j.startAt)}${j.endAt ? `–${fmtTime(j.endAt)}` : ''}`;
        return { value: j.id, label };
      });
  }, [jobs, form.userId, form.day, scope, state, t]);

  const cleanerOptions = users.map((u) => ({ value: u.id, label: u.name, sublabel: roleLabel(t, u.role) }));

  const stepDay = (n) => setForm((f) => ({ ...f, day: addDaysKey(f.day || todayKey(), n), jobId: '' }));
  const pickCleaner = (id) => setForm((f) => ({ ...f, userId: id || '', jobId: '' }));
  // Picking a clean anchors the entry: prefill the scheduled window for the manager to adjust.
  const pickClean = (id) => setForm((f) => {
    const job = id ? jobById.get(id) : null;
    const inF = job?.startAt ? formTimeOf(job.startAt) : { input: f.inAt, fold: f.inFold };
    const outF = job?.endAt ? formTimeOf(job.endAt) : { input: f.outAt, fold: f.outFold };
    return { ...f, jobId: id || '', inAt: inF.input, inFold: inF.fold, outAt: outF.input, outFold: outF.fold };
  });

  const save = async () => {
    if (guard.current) return;
    const correcting = mode === 'correct' && !!entry;
    // Correct mode: ONLY what the manager changed (CS-694). An untouched time keeps its original
    // instant — and validation reads that original, never a minute-rounded copy of it. (Only the
    // note is sent when only the note changed, so a read bug upstream can't blank a field nobody
    // touched — the note-erasure hazard; see git history.)
    const built = correcting ? buildCorrectionPatch({ entry, form, initial }) : null;
    const inNew = correcting ? null : resolveFormTime({ input: form.inAt, fold: form.inFold });
    const outNew = correcting ? null : resolveFormTime({ input: form.outAt, fold: form.outFold });
    // CS-668: a time typed into the repeated hour waits for the manager to say which one.
    const foldField = correcting ? built.needsFold : (inNew.needsFold ? 'in' : (outNew.needsFold ? 'out' : null));
    if (foldField) {
      const choices = foldChoices(foldField === 'in' ? form.inAt : form.outAt);
      toast.error(t('timeEntry.fold.required', { time: choices ? fmtTime(choices.first) : '' }));
      return;
    }
    const inIso = correcting ? built.inIso : inNew.iso;
    const outIso = correcting ? built.outIso : outNew.iso;
    if (correcting) {
      // Client validation mirrors validatePunchTimes: a closed punch keeps its clock-out
      // (requireOut), clock-out after clock-in, no future clock-in, ≤ 24 h. Blocks the bad save
      // before it leaves, and the server re-checks.
      const vcode = validatePunchTimes({ clockInAt: inIso, clockOutAt: outIso, now: Date.now(), requireOut: !!entry.clockOutAt });
      if (vcode) { toast.error(refusalCodeText(t, vcode, 'timeEntry.badTimes')); return; }
      if (!Object.keys(built.patch).length) { toast.info(t('timeEntry.noChanges')); return; }
    } else {
      if (!form.userId || !form.jobId || !form.inAt) { toast.error(t('timeEntry.required')); return; }
      const vcode = validatePunchTimes({ clockInAt: inIso, clockOutAt: outIso, now: Date.now(), requireOut: false });
      if (vcode) { toast.error(refusalCodeText(t, vcode, 'timeEntry.badTimes')); return; }
    }
    // PAY-11 — both modes. The button is already disabled without one; this is the backstop
    // for a keyboard submit, and it shows the same sentence the server would.
    if (reasonRefusal(form.reason)) { toast.error(t(TIME_REFUSAL_KEYS['reason-required'])); return; }
    guard.current = true; setBusy(true);
    try {
      if (correcting) {
        await timeApi.correctEntry({ entryId: entry.id, version: entry.rowVersion ?? entry.row_version, patch: built.patch, reason: form.reason });
        // Editing a clock time on an APPROVED punch sends it back to pending (server + stub) — say so.
        toast.success(entry.approvalStatus === 'approved' && built.timeChanged ? t('timeEntry.savedNeedsApproval') : t('timeEntry.updated'));
      } else {
        const job = jobById.get(form.jobId);
        const ctx = selectClockContextForJob(state, job, form.userId);
        await timeApi.manualEntry({
          jobId: form.jobId, userId: form.userId,
          clockInAt: inIso, clockOutAt: outIso,
          note: form.note, reason: form.reason, ctx,
        });
        toast.success(t('timeEntry.added'));
      }
      onSaved?.();
      onClose();
    } catch (e) {
      // Typed values survive: the modal stays open (no reset) and shows the refusal's plain copy.
      toast.error(refusalText(t, e, 'timeEntry.saveFailed'));
    } finally { setBusy(false); guard.current = false; }
  };

  return (
    <Modal open={open} onClose={onClose} title={mode === 'correct' ? t('timeEntry.correctTitle') : t('timeEntry.addTitle')}>
      <div>
        {mode === 'correct' && entry ? (
          <p className="text-muted text-sm" style={{ marginTop: 0 }}>{entry.userName}{entry.clientName ? ` · ${entry.clientName}` : ''}</p>
        ) : (
          <>
            <div className="form-group">
              <label className="form-label">{t('timeEntry.cleaner')}</label>
              <SearchSelect
                value={form.userId}
                onChange={pickCleaner}
                options={cleanerOptions}
                placeholder={t('timeEntry.cleanerPlaceholder')}
                searchPlaceholder={t('timeEntry.cleanerSearch')}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('timeEntry.day')}</label>
              <div className="te-day-step">
                <button type="button" className="btn btn-outline" aria-label={t('timeEntry.prevDay')} onClick={() => stepDay(-1)} disabled={!form.day}>‹</button>
                <span className="te-day-label">{form.day ? fmtDateLong(startOfDayKey(form.day).toISOString()) : '—'}</span>
                <button type="button" className="btn btn-outline" aria-label={t('timeEntry.nextDay')} onClick={() => stepDay(1)} disabled={!form.day}>›</button>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{t('timeEntry.clean')}</label>
              <SearchSelect
                value={form.jobId}
                onChange={pickClean}
                options={cleanOptions}
                disabled={!form.userId}
                disabledText={t('timeEntry.cleanFirst')}
                placeholder={t('timeEntry.cleanPlaceholder')}
                searchPlaceholder={t('timeEntry.cleanSearch')}
                emptyText={t('timeEntry.noCleans')}
              />
            </div>
          </>
        )}
        <div className="form-group">
          <label className="form-label">{t('timeEntry.clockIn')}</label>
          <input type="datetime-local" className="input" value={form.inAt} onChange={(e) => setForm({ ...form, inAt: e.target.value })} />
          <FoldChoice input={form.inAt} fold={form.inFold} onPick={(f) => setForm({ ...form, inFold: f })} />
        </div>
        <div className="form-group">
          <label className="form-label">{t('timeEntry.clockOut')} {mode === 'manual' && <span className="text-muted text-xs">{t('timeEntry.blankOut')}</span>}</label>
          <input type="datetime-local" className="input" value={form.outAt} onChange={(e) => setForm({ ...form, outAt: e.target.value })} />
          <FoldChoice input={form.outAt} fold={form.outFold} onPick={(f) => setForm({ ...form, outFold: f })} />
        </div>
        <FormField label={t('timeEntry.note')} as="textarea" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('timeEntry.notePlaceholder')} />
        <FormField label={t('timeEntry.reason')} required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={mode === 'correct' ? t('timeEntry.reasonCorrect') : t('timeEntry.reasonAdd')} />
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !!reasonRefusal(form.reason)} onClick={save}>{busy ? t('common.saving') : (mode === 'correct' ? t('timeEntry.saveChanges') : t('timeEntry.addEntry'))}</button>
        </div>
      </div>
    </Modal>
  );
}

// Delete a punch (Void) with a REQUIRED reason (spec §8.3). The shared Modal + reason field, the
// same pattern the drive-adjust modal uses; a danger confirm, an in-flight guard, and the refusal
// copy. Reused by the Approvals rows, the Time Clock detail and the Variance drill. `entry` needs
// at least { id, rowVersion|row_version }; `label` names it in the prompt.
export function TimeDeleteDialog({ open, onClose, entry, label, onDeleted }) {
  const t = useT();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  useEffect(() => { if (open) setReason(''); }, [open]);
  const del = async () => {
    if (!reason.trim() || guard.current || !entry) return;
    guard.current = true; setBusy(true);
    try {
      await timeApi.voidEntry({ entryId: entry.id, version: entry.rowVersion ?? entry.row_version, reason: reason.trim() });
      toast.success(t('timeEntry.deleted'));
      onDeleted?.();
      onClose();
    } catch (e) {
      toast.error(refusalText(t, e, 'timeEntry.deleteFailed'));
    } finally { setBusy(false); guard.current = false; }
  };
  return (
    <Modal open={open} onClose={onClose} title={t('timeEntry.deleteTitle')} size="sm">
      <p className="confirm-message">{label ? t('timeEntry.deleteMessageFor', { name: label }) : t('timeEntry.deleteMessage')}</p>
      <FormField label={t('timeEntry.reason')} as="textarea" rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('timeEntry.deleteReason')} />
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()} onClick={del}>{busy ? t('timeEntry.deleting') : t('timeEntry.deleteTitle')}</button>
      </div>
    </Modal>
  );
}

// Restore a deleted (voided) punch (spec §8.3). A plain confirm — the reason is optional on
// restore — then timeApi.restoreEntry. Kept beside the delete dialog so the two live together.
export function TimeRestoreDialog({ open, onClose, entry, label, onRestored }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const restore = async () => {
    if (guard.current || !entry) return;
    guard.current = true; setBusy(true);
    try {
      await timeApi.restoreEntry({ entryId: entry.id, version: entry.rowVersion ?? entry.row_version });
      toast.success(t('timeEntry.restored'));
      onRestored?.();
      onClose();
    } catch (e) {
      toast.error(refusalText(t, e, 'timeEntry.restoreFailed'));
    } finally { setBusy(false); guard.current = false; }
  };
  return (
    <Modal open={open} onClose={onClose} title={t('timeEntry.restoreTitle')} size="sm">
      <p className="confirm-message">{label ? t('timeEntry.restoreMessageFor', { name: label }) : t('timeEntry.restoreMessage')}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={restore}>{busy ? t('timeEntry.restoring') : t('timeEntry.restore')}</button>
      </div>
    </Modal>
  );
}
