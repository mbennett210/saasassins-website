// Step editor — add or edit a single sequence step.
// Fields: delay (amount + unit → delayMinutes), sendHourStart/End, subject,
// body, attachments. Step 0 may be 0 (fires on enrollment). Follow-ups wait at
// least 1 minute — TEMPORARY: the Minutes unit + 1-min floor are smoke-test
// scaffolding; restore the 1-hour floor and drop Minutes afterward.
// Dispatches ADD_MARKETING_STEP (when `step` is null) or UPDATE_MARKETING_STEP.
//
// The variable picker inserts a {placeholder} at the caret of whichever
// field (subject or body) was last focused — defaults to the body. The caret
// is captured on the picker's mousedown — which fires while the field still
// holds focus, before the click shifts focus away — so the caret is live and
// accurate. Captured into a ref so it survives the picker opening + closing.
//
// Attachments: picked files are held in component state until Save, which
// writes their blobs to IndexedDB (lib/attachments) and stores only metadata
// on the step. Cancelling never touches IndexedDB — no orphaned blobs.

import { useState, useEffect, useRef } from 'react';
import { useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { MARKETING_VARIABLES, stepDelayMinutes } from '../../lib/marketingScheduler';
import { newId } from '../../lib/ids';
import {
  saveMarketingAttachment,
  deleteMarketingAttachment,
  formatBytes,
  ATTACHMENT_MAX_BYTES,
  MARKETING_ATTACHMENT_ALLOWED_MIME,
} from '../../lib/attachments';
import Modal from '../../components/Modal';
import FormField from '../../components/FormField';
import Select from '../../components/Select';
import Icon from '../../components/Icon';

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${((h % 12) || 12)}:00 ${h < 12 ? 'AM' : 'PM'}`,
}));

// Delay unit options. The canonical store value is minutes; the editor lets the
// operator pick a friendly unit — Hours for a same-day cadence, Days for a
// slower drip.
// ⚠️ 'minutes' is TEMPORARY smoke-test scaffolding (added 2026-06-02) so a
// 2-minute cadence can be set; remove it (and restore the 1-hour floor in
// handleSubmit) once live testing is done.
const DELAY_UNITS = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
];

// Split a minutes value into the friendliest {value, unit} for the editor:
// whole-day multiples show as days, everything else as hours. 0 → "0 days".
function splitDelay(mins) {
  const m = Math.max(0, Number(mins) || 0);
  if (m > 0 && m % 1440 === 0) return { value: String(m / 1440), unit: 'days' };
  if (m > 0 && m % 60 === 0) return { value: String(m / 60), unit: 'hours' };
  if (m > 0) return { value: String(m), unit: 'minutes' };
  return { value: '0', unit: 'days' };
}

// Dropdown options for the variable picker — friendly name + the literal token.
const VARIABLE_OPTIONS = MARKETING_VARIABLES.map((v) => ({
  value: v.key,
  label: `${v.label}. {${v.key}}`,
}));

const VARIABLE_HINT = 'Pick a variable from the dropdown, or type one in. Add a fallback for blanks: {firstName|there} renders "there" when a contact has no first name.';

const ATTACH_MAX_MB = Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024));

const FIELD_IDS = { subject: 'ff-step-subject', body: 'ff-step-body' };

export default function StepEditorModal({ open, onClose, sequenceId, step, stepIndex, defaultWindow }) {
  const dispatch = useDispatch();
  const isNew = !step;
  const sw = defaultWindow || { start: 9, end: 17 };

  const [form, setForm] = useState({
    delayValue: '0',
    delayUnit: 'days',
    sendHourStart: String(sw.start),
    sendHourEnd: String(sw.end),
    subject: '',
    body: '',
  });
  const [error, setError] = useState(null);
  // Attachments staged in the modal — a mix of already-saved metadata (from
  // step.attachments) and freshly picked files (carry `file` + `isNew`).
  // Blobs are written to IndexedDB only on Save.
  const [attachments, setAttachments] = useState([]);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);
  // Which field the variable picker inserts into — the last-focused of
  // subject / body. `cursorRef` holds the caret captured on the picker's
  // mousedown (null = field wasn't focused → token appends at the end).
  const [activeField, setActiveField] = useState('body');
  const cursorRef = useRef({ subject: null, body: null });

  // Re-seed the form whenever the modal opens for a different step.
  useEffect(() => {
    if (!open) return;
    if (step) {
      const d = splitDelay(stepDelayMinutes(step));
      setForm({
        delayValue: d.value,
        delayUnit: d.unit,
        sendHourStart: String(step.sendHourStart ?? sw.start),
        sendHourEnd: String(step.sendHourEnd ?? sw.end),
        subject: step.subject || '',
        body: step.body || '',
      });
      setAttachments(Array.isArray(step.attachments) ? step.attachments : []);
    } else {
      setForm({
        // Step 0 sends on enrollment (0); a new follow-up defaults to 3 days.
        delayValue: stepIndex === 0 ? '0' : '3',
        delayUnit: 'days',
        sendHourStart: String(sw.start),
        sendHourEnd: String(sw.end),
        subject: '',
        body: '',
      });
      setAttachments([]);
    }
    setError(null);
    setSaving(false);
    setActiveField('body');
    cursorRef.current = { subject: null, body: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Snapshot the active field's caret. Fires on the picker's mousedown — the
  // field still holds focus at that point, so selectionStart is the live
  // caret. If the field isn't focused, null → insertVariable appends to end.
  function captureActiveCursor() {
    const el = document.getElementById(FIELD_IDS[activeField]);
    if (el && document.activeElement === el && typeof el.selectionStart === 'number') {
      cursorRef.current[activeField] = { start: el.selectionStart, end: el.selectionEnd };
    } else {
      cursorRef.current[activeField] = null;
    }
  }

  // Insert {key} into the active field at the captured caret (replacing any
  // selection), then restore focus + place the caret just past the token.
  function insertVariable(key) {
    if (!key) return;
    const token = `{${key}}`;
    const field = activeField;
    const elId = FIELD_IDS[field];
    const current = form[field] || '';
    const cur = cursorRef.current[field];
    let start = cur ? cur.start : current.length;
    let end = cur ? cur.end : current.length;
    start = Math.min(Math.max(0, start), current.length);
    end = Math.min(Math.max(start, end), current.length);
    const next = current.slice(0, start) + token + current.slice(end);
    set(field, next);
    const caret = start + token.length;
    cursorRef.current[field] = { start: caret, end: caret };
    requestAnimationFrame(() => {
      const e2 = document.getElementById(elId);
      if (e2) {
        e2.focus();
        try { e2.setSelectionRange(caret, caret); } catch { /* ignore */ }
      }
    });
  }

  // ----- Attachments -----
  function pickFiles() {
    fileInputRef.current?.click();
  }

  function onFilesPicked(e) {
    const files = [...(e.target.files || [])];
    e.target.value = ''; // let the same file be re-picked later
    if (!files.length) return;
    const accepted = [];
    const rejected = [];
    for (const file of files) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        rejected.push(`${file.name} (over ${ATTACH_MAX_MB} MB)`);
      } else if (file.type && !MARKETING_ATTACHMENT_ALLOWED_MIME.includes(file.type)) {
        rejected.push(`${file.name} (unsupported type)`);
      } else {
        accepted.push({
          id: newId('matt'),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          file,
          isNew: true,
        });
      }
    }
    if (accepted.length) setAttachments((list) => [...list, ...accepted]);
    setError(rejected.length
      ? `Skipped ${rejected.join(', ')}. Use PDF or images up to ${ATTACH_MAX_MB} MB.`
      : null);
  }

  function removeAttachment(id) {
    setAttachments((list) => list.filter((a) => a.id !== id));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    const amount = Number(form.delayValue);
    const start = Number(form.sendHourStart);
    const end = Number(form.sendHourEnd);
    if (Number.isNaN(amount) || amount < 0) {
      setError('Wait time must be 0 or more.');
      return;
    }
    const unitMult = form.delayUnit === 'days' ? 1440 : form.delayUnit === 'hours' ? 60 : 1;
    const delayMinutes = Math.round(amount * unitMult);
    // ⚠️ TEMPORARY: follow-up minimum lowered to 1 minute so a 2-minute test
    // cadence can be set via the Minutes unit. Restore to 60 (1 hour) when the
    // Minutes unit is removed after live testing.
    if (stepIndex > 0 && delayMinutes < 1) {
      setError('A follow-up step must wait at least 1 minute after the previous one.');
      return;
    }
    if (end <= start) {
      setError('Send window end must be after the start hour.');
      return;
    }
    if (!form.subject.trim()) {
      setError('Subject is required.');
      return;
    }
    if (!form.body.trim()) {
      setError('Body is required.');
      return;
    }

    setSaving(true);
    try {
      // Write freshly picked blobs to IndexedDB; keep already-saved ones as-is.
      const finalAttachments = [];
      for (const att of attachments) {
        if (att.isNew && att.file) {
          finalAttachments.push(await saveMarketingAttachment(att.id, att.file));
        } else {
          finalAttachments.push(att);
        }
      }
      // Drop blobs for attachments removed from an existing step.
      const keptIds = new Set(finalAttachments.map((a) => a.id));
      for (const prev of step?.attachments || []) {
        if (!keptIds.has(prev.id)) await deleteMarketingAttachment(prev.id);
      }
      const payload = {
        delayMinutes,
        // Coarse day mirror for any client still on the pre-hourly build (see
        // reducer ADD_MARKETING_STEP). New code reads delayMinutes; old code
        // reads this and waits the rounded-up day count instead of firing now.
        daysAfterPrevious: Math.ceil(delayMinutes / 1440),
        sendHourStart: start,
        sendHourEnd: end,
        subject: form.subject.trim(),
        body: form.body,
        attachments: finalAttachments,
      };
      if (isNew) {
        dispatch({ type: ACTIONS.ADD_MARKETING_STEP, sequenceId, step: payload });
      } else {
        dispatch({ type: ACTIONS.UPDATE_MARKETING_STEP, sequenceId, stepId: step.id, patch: payload });
      }
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Could not save attachments.');
      setSaving(false);
    }
  }

  const title = isNew ? `Add step ${(stepIndex ?? 0) + 1}` : `Edit step ${(stepIndex ?? 0) + 1}`;

  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <FormField
            label={stepIndex === 0 ? 'Wait after enrollment' : 'Wait after previous step'}
            name="step-delay-value"
            type="number"
            value={form.delayValue}
            onChange={(e) => set('delayValue', e.target.value)}
            min={stepIndex === 0 ? 0 : 1}
            help={stepIndex === 0
              ? 'How long to hold the first email after a contact is enrolled. 0 sends immediately.'
              : 'Use minutes for quick testing, hours or days for a real drip.'}
          />
          <FormField
            label="Unit"
            name="step-delay-unit"
            as="select"
            value={form.delayUnit}
            onChange={(e) => set('delayUnit', e.target.value)}
            options={DELAY_UNITS}
          />
        </div>
        <div className="form-row">
          <FormField
            label="Send window (from)"
            name="step-start"
            as="select"
            value={form.sendHourStart}
            onChange={(e) => set('sendHourStart', e.target.value)}
            options={HOURS}
          />
          <FormField
            label="Send window (to)"
            name="step-end"
            as="select"
            value={form.sendHourEnd}
            onChange={(e) => set('sendHourEnd', e.target.value)}
            options={HOURS}
          />
        </div>
        <FormField
          label="Subject line"
          name="step-subject"
          value={form.subject}
          onChange={(e) => set('subject', e.target.value)}
          onFocus={() => setActiveField('subject')}
          placeholder="Quick question about {company}"
          required
        />
        <div className="marketing-var-picker" onMouseDown={captureActiveCursor}>
          <Select
            value=""
            placeholder="Insert a variable…"
            options={VARIABLE_OPTIONS}
            onChange={insertVariable}
            ariaLabel="Insert a variable"
          />
          <span className="marketing-var-picker-target">
            Inserts into {activeField === 'subject' ? 'Subject' : 'Body'}
          </span>
        </div>
        <FormField
          label="Body"
          name="step-body"
          as="textarea"
          rows={9}
          value={form.body}
          onChange={(e) => set('body', e.target.value)}
          onFocus={() => setActiveField('body')}
          placeholder={'Hi {firstName},\n\n…'}
          help={VARIABLE_HINT}
          required
        />
        <div className="marketing-step-attach">
          <div className="marketing-step-attach-head">
            <span className="marketing-step-attach-label">Attachments</span>
            <button
              type="button"
              className="btn btn-outline marketing-step-attach-add"
              onClick={pickFiles}
            >
              Add files
            </button>
          </div>
          {attachments.length > 0 && (
            <ul className="marketing-step-attach-list">
              {attachments.map((att) => (
                <li key={att.id} className="marketing-step-attach-item">
                  <span className="marketing-step-attach-name" title={att.name}>{att.name}</span>
                  <span className="marketing-step-attach-size">{formatBytes(att.sizeBytes)}</span>
                  <button
                    type="button"
                    className="btn-icon btn-icon-danger"
                    aria-label={`Remove ${att.name}`}
                    onClick={() => removeAttachment(att.id)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="marketing-step-attach-hint">
            PDF or images (PNG, JPG, WebP, GIF), up to {ATTACH_MAX_MB} MB each.
            Sent with every email at this step.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
            className="marketing-step-attach-input"
            onChange={onFilesPicked}
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : (isNew ? 'Add step' : 'Save step')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
