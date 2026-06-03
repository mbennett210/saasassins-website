// Connect a system email provider (Resend) for system-originated transactional
// email — invitations, reminders, billing. Single-step flow:
//   1. User pastes API key + the sending subdomain they verified in Resend
//      + a default From + optional Reply-To
//   2. Backend validates the API key and looks up the domain's DKIM records.
//      Frontend stores the result on company.integrations.email and surfaces
//      the records in Settings → Integrations → Domain Verification card so
//      the user can copy them into DNS.
//
// In stub mode (VITE_EMAIL_BACKEND_URL unset) the call returns a dummy DKIM
// record set + status='pending' so the rest of the UI can be exercised
// without a live Resend account. The "Dev mode" copy in the modal makes
// that explicit.

import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { getEmailHealth, EMAIL_BACKEND_URL } from '../lib/email';

const EMPTY = {
  apiKey: '',
  verifiedDomain: '',
  defaultFromName: '',
  defaultFromLocalPart: 'hello',
  defaultReplyTo: '',
};

export default function ConnectEmailProviderModal({ open, onClose }) {
  const dispatch = useDispatch();
  const toast = useToast();

  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setBusy(false);
    setError('');
  }, [open]);

  const computedFrom = useMemo(() => {
    const local = form.defaultFromLocalPart.trim() || 'hello';
    const domain = form.verifiedDomain.trim();
    if (!domain) return '';
    const display = form.defaultFromName.trim();
    const address = `${local}@${domain}`;
    return display ? `${display} <${address}>` : address;
  }, [form.defaultFromName, form.defaultFromLocalPart, form.verifiedDomain]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const apiKey = form.apiKey.trim();
    const verifiedDomain = form.verifiedDomain.trim().toLowerCase();
    if (!apiKey) { setError('API key is required.'); return; }
    if (!verifiedDomain) { setError('Verified sending domain is required.'); return; }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(verifiedDomain)) {
      setError('Sending domain looks malformed. Use the bare domain you verified in Resend (e.g. mail.example.com).');
      return;
    }
    if (!computedFrom) { setError('Default From is required.'); return; }

    setBusy(true);
    try {
      // The /email/health route validates the API key and returns the live
      // domain status + DKIM records so we can persist them to state. In stub
      // mode (no backend) we synthesize a pending response so the rest of the
      // flow exercises end-to-end.
      const health = await getEmailHealth();
      const apiKeyLast4 = apiKey.slice(-4);

      dispatch({
        type: ACTIONS.CONNECT_EMAIL_PROVIDER,
        provider: 'resend',
        apiKeyLast4,
        verifiedDomain,
        defaultFrom: computedFrom,
        defaultReplyTo: form.defaultReplyTo.trim() || null,
        // Health-route hints feed into the domain card immediately so the
        // user sees DKIM records to add to DNS.
        domainStatus: health.status === 'verified' ? 'verified' : 'pending',
        dkimRecords: health.dkimRecords || [],
        spfStatus: health.spfStatus || null,
        dmarcStatus: health.dmarcStatus || null,
      });
      toast.success('Email provider connected.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not connect to the email provider.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect Email Provider">
      <form onSubmit={submit}>
        <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 14 }}>
          Enter your Resend API key and the subdomain you verified in Resend.
          This provider sends invitations, reminders, and (later) billing email.
          {!EMAIL_BACKEND_URL && (
            <> <strong>Dev mode:</strong> credentials are simulated locally and not sent to Resend.</>
          )}
        </p>
        <FormField
          label="API key"
          type="password"
          required
          placeholder="re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          value={form.apiKey}
          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          help="Generate at resend.com → API Keys. Stored encrypted at rest on the backend; we keep only the last 4 in app state."
        />
        <FormField
          label="Verified sending domain"
          required
          placeholder="mail.example.com"
          value={form.verifiedDomain}
          onChange={(e) => setForm({ ...form, verifiedDomain: e.target.value })}
          help="The subdomain you added + verified in Resend. Use a dedicated subdomain (e.g. mail.yourcompany.com) so app email reputation stays isolated from marketing sends."
        />
        <div className="form-row">
          <FormField
            label="From — display name"
            placeholder="Your Company"
            value={form.defaultFromName}
            onChange={(e) => setForm({ ...form, defaultFromName: e.target.value })}
            help="Shown to recipients before the email address."
          />
          <FormField
            label="From — local part"
            placeholder="hello"
            value={form.defaultFromLocalPart}
            onChange={(e) => setForm({ ...form, defaultFromLocalPart: e.target.value })}
            help="The bit before @. Common: hello, notifications, no-reply."
          />
        </div>
        {computedFrom && (
          <div className="text-xs text-muted" style={{ marginTop: -8, marginBottom: 10 }}>
            Resolves to: <code>{computedFrom}</code>
          </div>
        )}
        <FormField
          label="Reply-To (optional)"
          type="email"
          placeholder="hello@yourcompany.com"
          value={form.defaultReplyTo}
          onChange={(e) => setForm({ ...form, defaultReplyTo: e.target.value })}
          help="Where replies route by default. Leave blank to use whatever Reply-To the caller passes (typically the inviter's address)."
        />
        {error && <div className="form-error" style={{ marginTop: 4 }}>{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
