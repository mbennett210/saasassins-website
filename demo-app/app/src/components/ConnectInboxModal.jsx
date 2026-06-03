// Connect a per-user mailbox so the user can send email through Messaging
// from their own address. Three connection modes:
//   - OAuth: Google (Gmail / Workspace)        → connectGoogle()
//   - OAuth: Microsoft (Outlook / 365)         → connectMicrosoft()
//   - SMTP/IMAP: any other provider            → connectSmtp()
//
// Layout:
//   Step 1 — pick a provider tile. Each tile expands a help panel with
//   step-by-step instructions tailored to that ESP. The "Continue" button
//   triggers the right flow.
//
//   Step 2a (OAuth) — popup opens; on success we dispatch ADD_CONNECTED_INBOX
//   and close.
//
//   Step 2b (SMTP) — full form with SMTP + IMAP fields + a Verify button.
//   On success we dispatch ADD_CONNECTED_INBOX and close.
//
// On any failure, we surface the error inline AND show provider-specific
// troubleshooting tips so the user can self-resolve.

import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { selectCurrentUser } from '../store/selectors';
import {
  connectGoogle,
  connectMicrosoft,
  connectSmtp,
  INBOX_BACKEND_URL,
} from '../lib/connectedInboxes';

const PROVIDERS = [
  {
    key: 'google',
    label: 'Gmail / Google Workspace',
    badge: 'OAuth · recommended',
    description: 'One click — sign in to Google, approve, done. Works for personal Gmail and paid Workspace accounts.',
  },
  {
    key: 'microsoft',
    label: 'Microsoft 365 / Outlook.com',
    badge: 'OAuth · recommended',
    description: 'One click — sign in to Microsoft, approve, done. Works for personal Outlook.com and work / school accounts.',
  },
  {
    key: 'smtp',
    label: 'Other (SMTP / IMAP)',
    badge: 'App password',
    description: 'Yahoo, iCloud, Fastmail, Zoho, custom domains — anything with SMTP + IMAP support and an app password.',
  },
];

// SMTP preset profiles — selecting one of these in step 2b auto-fills the
// hosts/ports/security so the user only enters their email + app password.
const SMTP_PRESETS = [
  { key: 'custom',  label: 'Custom domain — I\'ll enter the host details', helpKey: 'custom' },
  { key: 'yahoo',   label: 'Yahoo Mail',
    smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecurity: 'ssl',
    imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecurity: 'ssl',
    helpKey: 'yahoo' },
  { key: 'icloud',  label: 'iCloud Mail',
    smtpHost: 'smtp.mail.me.com',    smtpPort: 587, smtpSecurity: 'starttls',
    imapHost: 'imap.mail.me.com',    imapPort: 993, imapSecurity: 'ssl',
    helpKey: 'icloud' },
  { key: 'fastmail', label: 'Fastmail',
    smtpHost: 'smtp.fastmail.com',   smtpPort: 465, smtpSecurity: 'ssl',
    imapHost: 'imap.fastmail.com',   imapPort: 993, imapSecurity: 'ssl',
    helpKey: 'fastmail' },
  { key: 'zoho',    label: 'Zoho Mail',
    smtpHost: 'smtp.zoho.com',       smtpPort: 465, smtpSecurity: 'ssl',
    imapHost: 'imap.zoho.com',       imapPort: 993, imapSecurity: 'ssl',
    helpKey: 'zoho' },
];

// Per-ESP help blocks. Rendered inline in the connect flow so a non-
// technical operator can follow them without leaving the modal.
function HelpPanel({ providerKey, smtpPresetKey }) {
  if (providerKey === 'google') {
    return (
      <div className="help-panel">
        <ul>
          <li>Click <strong>Connect Gmail</strong> below and approve the permissions in the Google window. We request only what we need: send mail, plus label/thread management for inbound replies.</li>
          <li><strong>Workspace admins:</strong> if you see "Access blocked: this app's request is invalid," your admin needs to allow the app in the Google Admin Console under <em>Security → API Controls → App access control → Configure new app</em>, then mark it Trusted.</li>
          <li><strong>2-step verification</strong> works as long as you complete sign-in inside the popup window. Don't navigate away before approving.</li>
          <li>Free Gmail accounts and paid Workspace accounts both work the same way.</li>
        </ul>
      </div>
    );
  }
  if (providerKey === 'microsoft') {
    return (
      <div className="help-panel">
        <ul>
          <li>Click <strong>Connect Microsoft</strong> below and sign in. Personal Outlook.com and work / school accounts both work.</li>
          <li><strong>Tenant admins:</strong> if your tenant requires admin consent, click <em>Request admin approval</em> from within the modal — we'll generate an approval link for your IT team.</li>
          <li><strong>MFA / Conditional Access</strong> is honored — complete sign-in normally. Stay inside the popup until it confirms success.</li>
        </ul>
      </div>
    );
  }
  if (providerKey === 'smtp') {
    return (
      <div className="help-panel">
        {smtpPresetKey === 'yahoo' && (
          <>
            <p><strong>Yahoo Mail — generate an app password</strong></p>
            <ul>
              <li>Yahoo no longer accepts your normal password for third-party apps. Generate one at <strong>Account Info → Account Security → Generate app password</strong>. Name it "PolishPoint App" so you know what it's for.</li>
              <li>Hosts auto-filled: SMTP <code>smtp.mail.yahoo.com:465 (SSL)</code> · IMAP <code>imap.mail.yahoo.com:993 (SSL)</code>.</li>
              <li>Paste the 16-character app password (no spaces) — not your regular Yahoo password.</li>
            </ul>
          </>
        )}
        {smtpPresetKey === 'icloud' && (
          <>
            <p><strong>iCloud Mail — generate an app-specific password</strong></p>
            <ul>
              <li>Sign in to <strong>appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate</strong>. Label it "PolishPoint App."</li>
              <li>Hosts auto-filled: SMTP <code>smtp.mail.me.com:587 (STARTTLS)</code> · IMAP <code>imap.mail.me.com:993 (SSL)</code>.</li>
              <li>Username is your full Apple ID. Both <code>@icloud.com</code> and <code>@me.com</code> / <code>@mac.com</code> aliases work.</li>
            </ul>
          </>
        )}
        {smtpPresetKey === 'fastmail' && (
          <>
            <p><strong>Fastmail — create an app password</strong></p>
            <ul>
              <li><strong>Settings → Privacy &amp; Security → App Passwords → New App Password</strong>. Label "PolishPoint App," scope <em>Mail</em>.</li>
              <li>Hosts auto-filled: SMTP <code>smtp.fastmail.com:465 (SSL)</code> · IMAP <code>imap.fastmail.com:993 (SSL)</code>.</li>
            </ul>
          </>
        )}
        {smtpPresetKey === 'zoho' && (
          <>
            <p><strong>Zoho Mail — create an application-specific password</strong></p>
            <ul>
              <li><strong>Mail Settings → Mail Accounts → Application-Specific Passwords → Generate</strong>.</li>
              <li>Hosts auto-filled: SMTP <code>smtp.zoho.com:465 (SSL)</code> · IMAP <code>imap.zoho.com:993 (SSL)</code>.</li>
            </ul>
          </>
        )}
        {(smtpPresetKey === 'custom' || !smtpPresetKey) && (
          <>
            <p><strong>Custom domain / generic SMTP</strong></p>
            <ul>
              <li>Find your provider's SMTP/IMAP settings in their support docs (search <code>"&lt;your provider&gt; SMTP settings"</code>).</li>
              <li>Most providers use port <code>587</code> with <code>STARTTLS</code> for SMTP and port <code>993</code> with <code>SSL/TLS</code> for IMAP.</li>
              <li>Where supported, generate an <strong>app password</strong> rather than using your account password — it's revocable and limits blast radius if leaked.</li>
              <li>Some hosts (GoDaddy, Bluehost) require enabling SMTP separately in cPanel — check "Email Accounts" for a "Connect Devices" link.</li>
            </ul>
          </>
        )}
      </div>
    );
  }
  return null;
}

// Troubleshooting table — surfaced inline AFTER a failed connection so the
// user can self-resolve without bouncing to support.
function TroubleshootingTable() {
  return (
    <div className="card" style={{ padding: '8px 12px', marginTop: 10, background: 'var(--surface-muted, #f4f4f5)' }}>
      <div className="text-xs text-muted" style={{ marginBottom: 6 }}>If the connection failed, here's what the most common errors usually mean:</div>
      <table className="text-xs" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th style={{ padding: '4px 6px' }}>Error</th>
            <th style={{ padding: '4px 6px' }}>Likely cause</th>
            <th style={{ padding: '4px 6px' }}>Fix</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style={{ padding: '4px 6px' }}>Authentication failed</td><td style={{ padding: '4px 6px' }}>Wrong password / app-password mismatch</td><td style={{ padding: '4px 6px' }}>Regenerate the app password and paste again</td></tr>
          <tr><td style={{ padding: '4px 6px' }}>Connection refused</td><td style={{ padding: '4px 6px' }}>Wrong port or security mode</td><td style={{ padding: '4px 6px' }}>Try 587 STARTTLS first, then 465 SSL</td></tr>
          <tr><td style={{ padding: '4px 6px' }}>Timeout</td><td style={{ padding: '4px 6px' }}>ISP blocking outbound 25/465/587</td><td style={{ padding: '4px 6px' }}>Use 587 STARTTLS; some residential ISPs block 465</td></tr>
          <tr><td style={{ padding: '4px 6px' }}>TLS required</td><td style={{ padding: '4px 6px' }}>Provider requires modern TLS</td><td style={{ padding: '4px 6px' }}>Pick STARTTLS or SSL/TLS, not "None"</td></tr>
          <tr><td style={{ padding: '4px 6px' }}>"Less secure apps" disabled</td><td style={{ padding: '4px 6px' }}>Google / Yahoo deprecated this</td><td style={{ padding: '4px 6px' }}>Switch to OAuth (Google) or app passwords (Yahoo)</td></tr>
        </tbody>
      </table>
    </div>
  );
}

const SMTP_EMPTY = {
  email: '',
  displayName: '',
  smtpPresetKey: 'custom',
  smtpHost: '',
  smtpPort: 587,
  smtpSecurity: 'starttls',
  smtpUsername: '',
  smtpPassword: '',
  imapHost: '',
  imapPort: 993,
  imapSecurity: 'ssl',
  separateImapAuth: false,
  imapUsername: '',
  imapPassword: '',
};

export default function ConnectInboxModal({ open, onClose }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const state = useStore();
  const currentUser = selectCurrentUser(state);

  const [step, setStep] = useState(1);
  const [providerKey, setProviderKey] = useState(null);
  const [smtpForm, setSmtpForm] = useState(SMTP_EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setProviderKey(null);
    setSmtpForm(SMTP_EMPTY);
    setBusy(false);
    setError('');
  }, [open]);

  const dispatchInbox = (inbox, providerOverride) => {
    if (!currentUser) return;
    dispatch({
      type: ACTIONS.ADD_CONNECTED_INBOX,
      id: inbox.id,
      userId: currentUser.id,
      provider: providerOverride || inbox.provider,
      email: inbox.email,
      displayName: inbox.displayName,
      status: inbox.status || 'active',
      smtpHost: inbox.smtpHost,
      smtpPort: inbox.smtpPort,
      smtpSecurity: inbox.smtpSecurity,
      imapHost: inbox.imapHost,
      imapPort: inbox.imapPort,
      imapSecurity: inbox.imapSecurity,
      inboundCapability: inbox.inboundCapability,
    });
  };

  const submitGoogle = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await connectGoogle();
      if (!result.ok || !result.inbox) throw new Error('Google connection failed.');
      dispatchInbox(result.inbox, 'google');
      toast.success(`Connected ${result.inbox.email}.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not connect Google.');
    } finally {
      setBusy(false);
    }
  };

  const submitMicrosoft = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await connectMicrosoft();
      if (!result.ok || !result.inbox) throw new Error('Microsoft connection failed.');
      dispatchInbox(result.inbox, 'microsoft');
      toast.success(`Connected ${result.inbox.email}.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not connect Microsoft.');
    } finally {
      setBusy(false);
    }
  };

  const submitSmtp = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const f = smtpForm;
      const payload = {
        email: f.email.trim(),
        displayName: f.displayName.trim() || currentUser?.name || '',
        smtpHost: f.smtpHost.trim(),
        smtpPort: Number(f.smtpPort),
        smtpSecurity: f.smtpSecurity,
        smtpUsername: f.smtpUsername.trim() || f.email.trim(),
        smtpPassword: f.smtpPassword,
        imapHost: f.imapHost.trim() || null,
        imapPort: f.imapHost.trim() ? Number(f.imapPort) : null,
        imapSecurity: f.imapHost.trim() ? f.imapSecurity : null,
        imapUsername: f.separateImapAuth ? f.imapUsername.trim() : null,
        imapPassword: f.separateImapAuth ? f.imapPassword : null,
      };
      const result = await connectSmtp(payload);
      if (!result.ok || !result.inbox) throw new Error('SMTP connection failed.');
      dispatchInbox(result.inbox, 'smtp');
      toast.success(`Connected ${result.inbox.email}.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not connect via SMTP.');
    } finally {
      setBusy(false);
    }
  };

  const onPickPreset = (key) => {
    const preset = SMTP_PRESETS.find((p) => p.key === key) || SMTP_PRESETS[0];
    setSmtpForm((prev) => ({
      ...prev,
      smtpPresetKey: key,
      smtpHost: preset.smtpHost || '',
      smtpPort: preset.smtpPort || 587,
      smtpSecurity: preset.smtpSecurity || 'starttls',
      imapHost: preset.imapHost || '',
      imapPort: preset.imapPort || 993,
      imapSecurity: preset.imapSecurity || 'ssl',
    }));
  };

  return (
    <Modal open={open} onClose={onClose} title={step === 1 ? 'Connect a Mailbox' : `Connect ${PROVIDERS.find((p) => p.key === providerKey)?.label || ''}`}>
      {step === 1 && (
        <div>
          <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 14 }}>
            Pick where your email lives. We'll send and receive client email through this mailbox so messages come from your real address — not a generic system sender.
            {!INBOX_BACKEND_URL && (
              <> <strong> Dev mode:</strong> connection flows are simulated locally and not sent to the provider.</>
            )}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {PROVIDERS.map((p) => (
              <button
                type="button"
                key={p.key}
                className={`card detail-card ${providerKey === p.key ? 'btn-primary-soft' : ''}`}
                style={{ textAlign: 'left', padding: '12px 14px', cursor: 'pointer', border: providerKey === p.key ? '2px solid var(--color-primary-500, #3b82f6)' : undefined }}
                onClick={() => setProviderKey(p.key)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <strong>{p.label}</strong>
                  <span className="text-xs text-muted">{p.badge}</span>
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>{p.description}</div>
              </button>
            ))}
          </div>

          {providerKey && (
            <div style={{ marginTop: 14 }}>
              <HelpPanel providerKey={providerKey} smtpPresetKey={smtpForm.smtpPresetKey} />
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (!providerKey) return;
                if (providerKey === 'google') submitGoogle();
                else if (providerKey === 'microsoft') submitMicrosoft();
                else setStep(2);
              }}
              disabled={!providerKey || busy}
            >
              {providerKey === 'smtp'
                ? 'Continue'
                : providerKey === 'google'
                  ? (busy ? 'Connecting…' : 'Connect Gmail')
                  : providerKey === 'microsoft'
                    ? (busy ? 'Connecting…' : 'Connect Microsoft')
                    : 'Continue'}
            </button>
          </div>
          {error && (
            <>
              <div className="form-error" style={{ marginTop: 10 }}>{error}</div>
              <TroubleshootingTable />
            </>
          )}
        </div>
      )}

      {step === 2 && providerKey === 'smtp' && (
        <form onSubmit={submitSmtp}>
          <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 12 }}>
            Pick your provider for auto-filled host details, or choose <em>Custom</em> to enter them yourself. Then paste an app password — never your regular account password.
          </p>
          <FormField
            label="Provider preset"
            as="select"
            value={smtpForm.smtpPresetKey}
            onChange={(e) => onPickPreset(e.target.value)}
            options={SMTP_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
          />
          <HelpPanel providerKey="smtp" smtpPresetKey={smtpForm.smtpPresetKey} />

          <div className="form-row" style={{ marginTop: 12 }}>
            <FormField
              label="Email address"
              type="email"
              required
              placeholder="you@example.com"
              value={smtpForm.email}
              onChange={(e) => setSmtpForm({ ...smtpForm, email: e.target.value, smtpUsername: smtpForm.smtpUsername || e.target.value })}
            />
            <FormField
              label="Display name"
              placeholder="Your Name"
              value={smtpForm.displayName}
              onChange={(e) => setSmtpForm({ ...smtpForm, displayName: e.target.value })}
              help="Shown to recipients before your email address."
            />
          </div>

          <h4 style={{ marginTop: 14, marginBottom: 6 }}>SMTP (outbound)</h4>
          <div className="form-row">
            <FormField
              label="SMTP host"
              required
              placeholder="smtp.example.com"
              value={smtpForm.smtpHost}
              onChange={(e) => setSmtpForm({ ...smtpForm, smtpHost: e.target.value })}
            />
            <FormField
              label="Port"
              type="number"
              required
              value={smtpForm.smtpPort}
              onChange={(e) => setSmtpForm({ ...smtpForm, smtpPort: e.target.value })}
              help="Common: 587 (STARTTLS), 465 (SSL)."
            />
            <FormField
              label="Security"
              as="select"
              value={smtpForm.smtpSecurity}
              onChange={(e) => setSmtpForm({ ...smtpForm, smtpSecurity: e.target.value })}
              options={[
                { value: 'starttls', label: 'STARTTLS' },
                { value: 'ssl', label: 'SSL/TLS' },
                { value: 'none', label: 'None (not recommended)' },
              ]}
            />
          </div>
          <div className="form-row">
            <FormField
              label="SMTP username"
              placeholder="Usually your full email"
              value={smtpForm.smtpUsername}
              onChange={(e) => setSmtpForm({ ...smtpForm, smtpUsername: e.target.value })}
            />
            <FormField
              label="App password"
              type="password"
              required
              placeholder="••••••••••••••••"
              value={smtpForm.smtpPassword}
              onChange={(e) => setSmtpForm({ ...smtpForm, smtpPassword: e.target.value })}
              help="App password preferred over your real account password."
            />
          </div>

          <h4 style={{ marginTop: 14, marginBottom: 6 }}>IMAP (inbound — optional)</h4>
          <div className="text-sm text-muted" style={{ marginBottom: 6 }}>
            IMAP lets replies thread back into Messaging once Phase 4c (inbound capture) is wired. Leave blank to send only — replies will land in your normal inbox until inbound is enabled.
          </div>
          <div className="form-row">
            <FormField
              label="IMAP host"
              placeholder="imap.example.com"
              value={smtpForm.imapHost}
              onChange={(e) => setSmtpForm({ ...smtpForm, imapHost: e.target.value })}
            />
            <FormField
              label="Port"
              type="number"
              value={smtpForm.imapPort}
              onChange={(e) => setSmtpForm({ ...smtpForm, imapPort: e.target.value })}
              help="Common: 993 (SSL)."
            />
            <FormField
              label="Security"
              as="select"
              value={smtpForm.imapSecurity}
              onChange={(e) => setSmtpForm({ ...smtpForm, imapSecurity: e.target.value })}
              options={[
                { value: 'ssl', label: 'SSL/TLS' },
                { value: 'starttls', label: 'STARTTLS' },
                { value: 'none', label: 'None' },
              ]}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 }}>
            <input
              type="checkbox"
              checked={smtpForm.separateImapAuth}
              onChange={(e) => setSmtpForm({ ...smtpForm, separateImapAuth: e.target.checked })}
            />
            Use a different username/password for IMAP
          </label>
          {smtpForm.separateImapAuth && (
            <div className="form-row">
              <FormField
                label="IMAP username"
                value={smtpForm.imapUsername}
                onChange={(e) => setSmtpForm({ ...smtpForm, imapUsername: e.target.value })}
              />
              <FormField
                label="IMAP app password"
                type="password"
                value={smtpForm.imapPassword}
                onChange={(e) => setSmtpForm({ ...smtpForm, imapPassword: e.target.value })}
              />
            </div>
          )}

          {error && (
            <>
              <div className="form-error" style={{ marginTop: 10 }}>{error}</div>
              <TroubleshootingTable />
            </>
          )}

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(1)} disabled={busy}>Back</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify & Connect'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
