// Settings → Connected Inboxes (per-user)
//
// Each user wires their own mailbox(es) here so messages they send through
// the Messaging email channel come from their real address — not a generic
// system sender. Three connection modes: Google OAuth, Microsoft OAuth,
// and SMTP/IMAP for everything else.
//
// What this page is NOT:
//   - The system Resend provider (that's at Settings → Integrations).
//   - A marketing / drip / broadcast tool (those are higher-tier add-ons).
//
// Permissions: gated on `messaging.use` — if a user can't access Messaging
// at all, there's no point setting up their mailbox.

import { useMemo, useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectCurrentUser,
  selectConnectedInboxesForUser,
} from '../../store/selectors';
import { useToast } from '../../components/Toast';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import ConnectInboxModal from '../../components/ConnectInboxModal';
import {
  disconnectInbox,
  testInboxSend,
  INBOX_BACKEND_URL,
} from '../../lib/connectedInboxes';

const PROVIDER_LABEL = {
  google: 'Gmail',
  microsoft: 'Microsoft 365',
  smtp: 'SMTP',
};

const STATUS_BADGE = {
  active:  { variant: 'green', label: 'Connected' },
  pending: { variant: 'amber', label: 'Verifying…' },
  expired: { variant: 'amber', label: 'Reconnect required' },
  error:   { variant: 'red',   label: 'Error' },
};

export default function SettingsConnectedInboxes() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const currentUser = selectCurrentUser(state);
  const inboxes = selectConnectedInboxesForUser(state, currentUser?.id);

  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(null); // inbox id or null
  const [testTargetId, setTestTargetId] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null); // { id, status, failureReason? }

  const sortedInboxes = useMemo(
    () => [...inboxes].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return (a.connectedAt || '') < (b.connectedAt || '') ? 1 : -1;
    }),
    [inboxes]
  );

  const handleSetDefault = (id) => {
    dispatch({ type: ACTIONS.SET_DEFAULT_CONNECTED_INBOX, id });
    toast.success('Default updated.');
  };

  const handleDisconnect = async (id) => {
    setConfirmDisconnect(null);
    try {
      await disconnectInbox(id);
      dispatch({ type: ACTIONS.REMOVE_CONNECTED_INBOX, id });
      toast.success('Mailbox disconnected.');
    } catch (err) {
      toast.error(err.message || 'Disconnect failed.');
    }
  };

  const handleTestSend = async (e) => {
    e.preventDefault();
    if (!testTargetId) return;
    setTestBusy(true);
    setTestResult({ status: 'sending' });
    try {
      const inbox = inboxes.find((i) => i.id === testTargetId);
      const result = await testInboxSend(testTargetId, {
        to: testTo.trim() || (inbox?.email || ''),
        subject: 'Test from Messaging',
        body: 'This is a test email from your Messaging mailbox. Replying confirms the From + Reply-To routing works.',
      });
      setTestResult({ id: result.id, status: result.status });
      // Reflect lastSyncAt for visual feedback that something happened.
      dispatch({
        type: ACTIONS.UPDATE_CONNECTED_INBOX,
        id: testTargetId,
        patch: { lastSyncAt: new Date().toISOString(), lastError: null },
      });
    } catch (err) {
      setTestResult({ status: 'failed', failureReason: err.message || 'Unknown error' });
      dispatch({
        type: ACTIONS.UPDATE_CONNECTED_INBOX,
        id: testTargetId,
        patch: { lastError: err.message || 'Test send failed' },
      });
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Connected Inboxes</h1>
        <p className="page-head-subtitle">
          These mailboxes can send and receive emails on your behalf inside Messaging.
          Each connection is yours alone — your teammates don't see them.
          {' '}<strong>Email blasts, marketing campaigns, and drip sequences</strong> are not handled here — those live in higher-tier add-ons.
          {!INBOX_BACKEND_URL && (
            <> <strong>Dev mode:</strong> connection flows are simulated locally.</>
          )}
        </p>
      </div>

      {sortedInboxes.length === 0 ? (
        <div className="card detail-card" style={{ marginBottom: 16, textAlign: 'center', padding: '28px 16px' }}>
          <Icon name="mail" size={32} />
          <h3 className="dash-card-title" style={{ marginTop: 8 }}>No mailboxes connected yet</h3>
          <p className="text-sm text-muted" style={{ maxWidth: 480, margin: '6px auto 14px' }}>
            Connect Gmail, Microsoft 365, or any provider with SMTP support so emails sent through Messaging come from <strong>your</strong> real address — not a generic system sender.
          </p>
          <button className="btn btn-primary" onClick={() => setConnectOpen(true)}>
            Connect a mailbox
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-primary" onClick={() => setConnectOpen(true)}>
              Connect another mailbox
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sortedInboxes.map((inbox) => {
              const badge = STATUS_BADGE[inbox.status] || { variant: 'slate', label: inbox.status };
              return (
                <div key={inbox.id} className="card detail-card">
                  <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <h3 className="dash-card-title">
                        <Icon name="mail" size={16} /> {inbox.email}
                        <Badge variant={badge.variant} style={{ marginLeft: 8 }}>{badge.label}</Badge>
                        {inbox.isDefault && <Badge variant="blue" style={{ marginLeft: 6 }}>Default</Badge>}
                      </h3>
                      <div className="text-sm text-muted">
                        {PROVIDER_LABEL[inbox.provider] || inbox.provider}
                        {inbox.displayName && <> · Display name <strong>{inbox.displayName}</strong></>}
                        {inbox.connectedAt && <> · Connected {new Date(inbox.connectedAt).toLocaleDateString()}</>}
                      </div>
                      {inbox.provider === 'smtp' && inbox.smtpHost && (
                        <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                          SMTP <code>{inbox.smtpHost}:{inbox.smtpPort}</code> ({inbox.smtpSecurity})
                          {inbox.imapHost && (
                            <> · IMAP <code>{inbox.imapHost}:{inbox.imapPort}</code> ({inbox.imapSecurity})</>
                          )}
                        </div>
                      )}
                      <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                        Inbound capture:{' '}
                        {inbox.inboundCapability && inbox.inboundEnabled
                          ? <Badge variant="green">enabled ({inbox.inboundCapability})</Badge>
                          : inbox.inboundCapability
                            ? <Badge variant="amber">available ({inbox.inboundCapability}) — wire in Phase 4c</Badge>
                            : <Badge variant="slate">not yet wired</Badge>}
                      </div>
                      {inbox.lastError && (
                        <div className="form-error" style={{ marginTop: 6 }}>
                          Last error: {inbox.lastError}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {!inbox.isDefault && (
                        <button className="btn btn-outline btn-sm" onClick={() => handleSetDefault(inbox.id)}>
                          Set default
                        </button>
                      )}
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => {
                          setTestTargetId(inbox.id);
                          setTestTo(inbox.email);
                          setTestResult(null);
                        }}
                      >
                        Test send
                      </button>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => setConfirmDisconnect(inbox.id)}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>

                  {testTargetId === inbox.id && (
                    <form onSubmit={handleTestSend} style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-color, #e5e7eb)' }}>
                      <div className="form-row">
                        <FormField
                          label="Send test to"
                          type="email"
                          required
                          placeholder={inbox.email}
                          value={testTo}
                          onChange={(e) => setTestTo(e.target.value)}
                        />
                        <FormField
                          label="From (this mailbox)"
                          value={inbox.email}
                          disabled
                        />
                      </div>
                      <div className="modal-actions" style={{ marginTop: 4 }}>
                        <div style={{ flex: 1 }}>
                          {testResult && (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <Badge variant={testResult.status === 'sent' ? 'green' : testResult.status === 'failed' ? 'red' : 'slate'}>
                                {testResult.status}
                              </Badge>
                              {testResult.id && <code className="text-xs text-muted">{testResult.id}</code>}
                              {testResult.failureReason && (
                                <span className="text-xs" style={{ color: 'var(--color-text-error, #b91c1c)' }}>
                                  {testResult.failureReason}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-outline"
                          onClick={() => { setTestTargetId(null); setTestResult(null); }}
                          disabled={testBusy}
                        >
                          Close
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={testBusy}>
                          {testBusy ? 'Sending…' : 'Send test'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <ConnectInboxModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      <ConfirmDialog
        open={Boolean(confirmDisconnect)}
        title="Disconnect mailbox?"
        message="Sending email through Messaging from this address will stop until you reconnect. Existing message history is preserved. Tokens are revoked at the provider where applicable."
        confirmLabel="Disconnect"
        variant="danger"
        onConfirm={() => handleDisconnect(confirmDisconnect)}
        onClose={() => setConfirmDisconnect(null)}
      />
    </div>
  );
}
