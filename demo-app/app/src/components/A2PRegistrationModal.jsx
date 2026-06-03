// A2P 10DLC brand + campaign registration form.
// Per the email, A2P is "handled for you" — Kronelius shepherds the actual carrier
// review. This form captures the data needed to file. After submit, status flips to
// 'pending'. Super admin manually moves it to 'approved' once carriers approve.

import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectA2P } from '../store/selectors';
import { useToast } from './Toast';
import { submitA2P } from '../lib/twilio';

const EMPTY = {
  brandName: '',
  ein: '',
  businessAddress: '',
  useCase: 'customer_care',
  sampleMessages: ['', '', ''],
  notes: '',
};

const USE_CASES = [
  { value: 'customer_care',     label: 'Customer Care' },
  { value: 'marketing',         label: 'Marketing' },
  { value: 'mixed',             label: 'Mixed (Care + Marketing)' },
  { value: 'account_notification', label: 'Account Notifications' },
  { value: 'delivery_notification', label: 'Delivery Notifications' },
];

export default function A2PRegistrationModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const a2p = selectA2P(state);

  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    // Pre-fill from existing A2P record if user is editing a rejected/in-progress submission.
    setForm({
      brandName: a2p?.brandName || state.company?.name || '',
      ein: a2p?.ein || '',
      businessAddress: a2p?.businessAddress || state.company?.address || '',
      useCase: a2p?.useCase || 'customer_care',
      sampleMessages: a2p?.sampleMessages?.length
        ? [...a2p.sampleMessages, '', '', ''].slice(0, 5)
        : ['', '', ''],
      notes: a2p?.notes || '',
    });
    setBusy(false);
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSample = (idx, value) => {
    setForm((f) => {
      const next = [...f.sampleMessages];
      next[idx] = value;
      return { ...f, sampleMessages: next };
    });
  };

  const addSample = () => {
    if (form.sampleMessages.length >= 5) return;
    setForm((f) => ({ ...f, sampleMessages: [...f.sampleMessages, ''] }));
  };

  const removeSample = (idx) => {
    setForm((f) => ({ ...f, sampleMessages: f.sampleMessages.filter((_, i) => i !== idx) }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const samples = form.sampleMessages.map((s) => s.trim()).filter(Boolean);
    if (!form.brandName.trim()) { setError('Brand / business name is required.'); return; }
    if (!form.ein.trim()) { setError('EIN is required.'); return; }
    if (!form.businessAddress.trim()) { setError('Business address is required.'); return; }
    if (samples.length < 1) { setError('At least one sample message is required.'); return; }

    setBusy(true);
    try {
      const payload = {
        brandName: form.brandName.trim(),
        ein: form.ein.trim(),
        businessAddress: form.businessAddress.trim(),
        useCase: form.useCase,
        sampleMessages: samples,
      };
      await submitA2P(payload);
      dispatch({
        type: ACTIONS.SUBMIT_A2P,
        patch: { ...payload, notes: form.notes.trim() },
      });
      toast.success('A2P registration submitted. Status: pending carrier review.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not submit A2P registration.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="A2P 10DLC Registration">
      <form onSubmit={submit}>
        <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 14 }}>
          Required by US carriers for application-to-person SMS. We submit on your behalf;
          carrier review typically takes 2–7 business days.
        </p>

        <div className="form-row">
          <FormField
            label="Brand / Business name"
            required
            value={form.brandName}
            onChange={(e) => setForm({ ...form, brandName: e.target.value })}
            placeholder="Acme Cleaning Co."
          />
          <FormField
            label="EIN"
            required
            value={form.ein}
            onChange={(e) => setForm({ ...form, ein: e.target.value })}
            placeholder="12-3456789"
            help="Federal Employer Identification Number."
          />
        </div>

        <FormField
          label="Business address"
          required
          value={form.businessAddress}
          onChange={(e) => setForm({ ...form, businessAddress: e.target.value })}
          placeholder="1200 Industrial Way, Seattle WA 98101"
        />

        <FormField
          label="Use case"
          as="select"
          required
          value={form.useCase}
          onChange={(e) => setForm({ ...form, useCase: e.target.value })}
          options={USE_CASES}
          help="Match how you actually use SMS — wrong picks get rejected."
        />

        <div className="form-group">
          <label className="form-label">
            Sample messages <span className="form-required">*</span>
          </label>
          <div className="text-xs text-muted" style={{ marginBottom: 6 }}>
            At least one. Carriers use these to evaluate the campaign — paste real templates you'll send.
          </div>
          {form.sampleMessages.map((msg, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
              <textarea
                className="input"
                rows={2}
                value={msg}
                onChange={(e) => setSample(idx, e.target.value)}
                placeholder={`Sample ${idx + 1} — e.g. "Hi {name}, your cleaning is scheduled for tomorrow at 9 AM."`}
                style={{ flex: 1 }}
              />
              {form.sampleMessages.length > 1 && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => removeSample(idx)}
                  aria-label={`Remove sample ${idx + 1}`}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {form.sampleMessages.length < 5 && (
            <button type="button" className="btn btn-outline btn-sm" onClick={addSample}>
              Add sample
            </button>
          )}
        </div>

        <FormField
          label="Notes (internal)"
          as="textarea"
          rows={2}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          help="Optional — context for your team or for re-submission if rejected."
        />

        {error && <div className="form-error" style={{ marginTop: 4 }}>{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit Registration'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
