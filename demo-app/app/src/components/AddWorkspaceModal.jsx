// Add a Google Workspace to the multi-Workspace OAuth registry (super admin).
//
// Collects the Workspace label, its sending domains, and the OAuth Client ID +
// secret created in THAT Workspace's own Google Cloud project (Internal consent
// screen — no Google verification, no CASA, no annual fees). The secret is sent
// to the backend, which stores it encrypted; only its last 4 chars are kept in
// client state for display. After adding, a Super Admin of that Google org
// marks the Client ID "Trusted" in their admin console to finish — surfaced as
// the "Pending admin approval" status until confirmed.

import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { registerWorkspace, WORKSPACES_STUB_ACTIVE, WORKSPACES_CONFIGURED } from '../lib/oauthWorkspaces';
import GmailConnectInstructions from './GmailConnectInstructions';

export default function AddWorkspaceModal({ open, onClose }) {
  const dispatch = useDispatch();
  const toast = useToast();

  const [label, setLabel] = useState('');
  const [domains, setDomains] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setLabel(''); setDomains(''); setClientId(''); setClientSecret('');
    setShowSetup(false); setBusy(false); setError('');
  }, [open]);

  const submit = async () => {
    setError('');
    if (!label.trim()) { setError('Give the Workspace a name.'); return; }
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Client ID and Client secret are required.');
      return;
    }
    setBusy(true);
    try {
      const domainList = domains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
      const result = await registerWorkspace({
        label: label.trim(),
        domains: domainList,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      if (!result.ok || !result.workspace) throw new Error('Registration failed.');
      const w = result.workspace;
      dispatch({
        type: ACTIONS.ADD_OAUTH_WORKSPACE,
        id: w.id,
        label: w.label,
        domains: w.domains,
        clientId: w.clientId,
        clientSecretLast4: w.clientSecretLast4,
        status: w.status || 'pending',
      });
      toast.success(`${w.label} added. Approve it in that Workspace's Google admin console to finish.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not add the Workspace.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a Google Workspace" size="md">
      <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 12 }}>
        Register a Google Workspace org so its team members can connect their own mailboxes.
        Paste the OAuth Client ID + secret from that Workspace&apos;s Google Cloud project
        (Internal consent screen. No Google verification or annual fees).
        {WORKSPACES_STUB_ACTIVE && (
          <> <strong>Dev mode:</strong> nothing is sent to Google; this simulates the registration.</>
        )}
        {/* CS-038: a production build with no email backend must NOT fake a Workspace register. */}
        {!WORKSPACES_CONFIGURED && (
          <> <strong>Not configured:</strong> Google Workspaces are not set up for this deployment; adding a Workspace is disabled until the email backend is provisioned.</>
        )}
      </p>

      <FormField
        label="Workspace name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. Cascade Janitorial"
      />
      <FormField
        label="Sending domains"
        value={domains}
        onChange={(e) => setDomains(e.target.value)}
        placeholder="cascadejanitorial.com, cascade.net"
        help="Comma-separated. Used to auto-match a mailbox to this Workspace at connect time."
      />
      <FormField
        label="OAuth Client ID"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        placeholder="…apps.googleusercontent.com"
        autoComplete="off"
      />
      <FormField
        label="OAuth Client secret"
        type="password"
        value={clientSecret}
        onChange={(e) => setClientSecret(e.target.value)}
        placeholder="GOCSPX-…"
        autoComplete="off"
        help="Stored encrypted on the backend. Never shown again."
      />

      <button
        type="button"
        className="btn btn-link"
        onClick={() => setShowSetup((v) => !v)}
      >
        {showSetup ? 'Hide' : 'Show'} Google-side setup steps
      </button>
      {showSetup && (
        <div style={{ marginTop: 8 }}>
          <GmailConnectInstructions />
        </div>
      )}

      {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !WORKSPACES_CONFIGURED}>
          {busy ? 'Adding…' : 'Add Workspace'}
        </button>
      </div>
    </Modal>
  );
}
