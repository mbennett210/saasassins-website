import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import SearchSelect from './SearchSelect';
import { useStore } from '../store';
import { useToast } from './Toast';
import { ROLE_LABELS } from '../lib/roles';
import {
  selectActiveUsers, selectJobs, selectSiteById, selectClientById, selectClockContextForJob,
} from '../store/selectors';
import * as timeApi from '../lib/timeApi';
import { fmtDate, fmtTime, splitIso, composeIso } from '../lib/dates';

// Manager time-entry editor — two modes:
//   'manual'  → add a missed clean's time (forgotten clock-in). Drives /api/time/manual.
//   'correct' → fix an existing entry's clock-in/out + note, with a reason for the
//               append-only edit_history. Drives /api/time/correct.
// All timestamps go to the server as ISO; the server re-stamps nothing here (manual
// + correct are explicitly manager-asserted times, flagged in the audit trail).
// The <datetime-local> input shows and captures the SITE's wall clock (org tz), so a
// manager correcting a Seattle clean's times sees Seattle times wherever they sit,
// and saves back the same instant. Bridges the single datetime-local string to the
// org-aware split/compose pair.
const toLocalInput = (iso) => {
  if (!iso) return '';
  const { date, time } = splitIso(iso);
  return date ? `${date}T${time}` : '';
};
const fromLocalInput = (v) => {
  if (!v) return null;
  const [date, time] = v.split('T');
  return composeIso(date, time);
};

export default function TimeEntryModal({ open, onClose, mode = 'manual', entry = null, onSaved }) {
  const state = useStore();
  const toast = useToast();
  const users = useMemo(() => selectActiveUsers(state), [state]);
  const jobs = useMemo(
    () => selectJobs(state).slice().sort((a, b) => (b.startAt || '').localeCompare(a.startAt || '')).slice(0, 200),
    [state],
  );
  const [form, setForm] = useState({ userId: '', jobId: '', inAt: '', outAt: '', note: '', reason: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === 'correct' && entry) {
      setForm({ userId: entry.userId || '', jobId: entry.jobId || '', inAt: toLocalInput(entry.clockInAt), outAt: toLocalInput(entry.clockOutAt), note: entry.note || '', reason: '' });
    } else {
      setForm({ userId: '', jobId: '', inAt: '', outAt: '', note: '', reason: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, entry]);

  const jobLabel = (j) => {
    const site = j.siteId ? selectSiteById(state, j.siteId) : null;
    const client = j.clientId ? selectClientById(state, j.clientId) : null;
    return `${client?.name || site?.name || 'Clean'}. ${fmtDate(j.startAt)} ${fmtTime(j.startAt)}`;
  };

  const save = async () => {
    setBusy(true);
    try {
      if (mode === 'correct' && entry) {
        // ⚠️ ONLY SEND `note` WHEN IT ACTUALLY CHANGED.
        //
        // This used to be `{ note: form.note }` unconditionally, which turned any read
        // bug upstream into DATA LOSS: the variance mappers dropped `note`, so the
        // textarea prefilled empty, and a manager fixing only a clock-out time sent
        // note:'' — blanking the offline-replay/geofence explanation that flagged the
        // row for review in the first place. correctEntry's guard is
        // `patch.note !== undefined && patch.note !== existing.note`, so '' sails
        // straight through it.
        //
        // The mappers are fixed, but a form must not be able to erase a field the user
        // never touched just because it failed to load it. That coupling is the general
        // hazard — a read path and a write path sharing one object — and this is where
        // it gets broken.
        const patch = {};
        if (form.note !== (entry.note || '')) patch.note = form.note;
        if (form.inAt) patch.clock_in_at = fromLocalInput(form.inAt);
        patch.clock_out_at = form.outAt ? fromLocalInput(form.outAt) : null;
        await timeApi.correctEntry({ entryId: entry.id, patch, reason: form.reason });
        toast.success('Time entry updated');
      } else {
        if (!form.userId || !form.jobId || !form.inAt) { toast.error('Cleaner, clean, and clock-in are required'); setBusy(false); return; }
        const job = jobs.find((j) => j.id === form.jobId);
        const ctx = selectClockContextForJob(state, job, form.userId);
        await timeApi.manualEntry({
          jobId: form.jobId, userId: form.userId,
          clockInAt: fromLocalInput(form.inAt), clockOutAt: form.outAt ? fromLocalInput(form.outAt) : null,
          note: form.note, reason: form.reason || 'manual entry', ctx,
        });
        toast.success('Manual entry added');
      }
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(e.message || 'Could not save the time entry');
    } finally { setBusy(false); }
  };

  // Cleaner = any active user; Clean list is gated on the cleaner and shows only
  // the cleans that cleaner is assigned to (job.crewIds), for simplicity.
  const cleanerOptions = users.map((u) => ({ value: u.id, label: u.name, sublabel: ROLE_LABELS[u.role] || u.role }));
  const cleanOptions = form.userId
    ? jobs.filter((j) => Array.isArray(j.crewIds) && j.crewIds.includes(form.userId)).map((j) => ({ value: j.id, label: jobLabel(j) }))
    : [];

  return (
    <Modal open={open} onClose={onClose} title={mode === 'correct' ? 'Correct time entry' : 'Add manual time entry'}>
      <div>
        {mode === 'correct' && entry ? (
          <p className="text-muted text-sm" style={{ marginTop: 0 }}>{entry.userName}{entry.clientName ? ` · ${entry.clientName}` : ''}</p>
        ) : (
          <>
            <div className="form-group">
              <label className="form-label">Cleaner</label>
              <SearchSelect
                value={form.userId}
                onChange={(id) => setForm({ ...form, userId: id || '', jobId: '' })}
                options={cleanerOptions}
                placeholder="Select a cleaner…"
                searchPlaceholder="Search cleaners…"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Clean</label>
              <SearchSelect
                value={form.jobId}
                onChange={(id) => setForm({ ...form, jobId: id || '' })}
                options={cleanOptions}
                disabled={!form.userId}
                disabledText="Select a cleaner first"
                placeholder="Select the clean…"
                searchPlaceholder="Search this cleaner's cleans…"
                emptyText="No cleans assigned to this cleaner"
              />
            </div>
          </>
        )}
        <div className="form-group">
          <label className="form-label">Clock-in</label>
          <input type="datetime-local" className="input" value={form.inAt} onChange={(e) => setForm({ ...form, inAt: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">Clock-out {mode === 'manual' && <span className="text-muted text-xs">(blank = still on the clock)</span>}</label>
          <input type="datetime-local" className="input" value={form.outAt} onChange={(e) => setForm({ ...form, outAt: e.target.value })} />
        </div>
        <FormField label="Note" as="textarea" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional. Shown with the entry" />
        <FormField label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={mode === 'correct' ? 'Why is this being corrected? (audit trail)' : 'e.g. forgot to clock in'} />
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : (mode === 'correct' ? 'Save changes' : 'Add entry')}</button>
        </div>
      </div>
    </Modal>
  );
}
