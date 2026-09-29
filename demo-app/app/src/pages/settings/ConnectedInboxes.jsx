// Settings → Connected Inboxes (per-user)
//
// Each user wires their own mailbox(es) here so messages they send through
// the Messaging email channel come from their real address — not a generic
// system sender. Gmail / Google Workspace only for now (Microsoft 365 and
// SMTP/IMAP are planned — see ConnectInboxModal for status).
//
// What this page is NOT:
//   - The system Resend provider (that's at Settings → Integrations).
//   - A marketing / drip / broadcast tool — marketing email accounts are
//     connected in the Marketing tab.
//
// Permissions: gated on `messaging.use` — if a user can't access Messaging
// at all, there's no point setting up their mailbox.

import { useMemo, useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectCurrentUser,
  selectConnectedInboxesForUser,
  selectOAuthWorkspaces,
} from '../../store/selectors';
import { useToast } from '../../components/Toast';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import ConfirmDialog from '../../components/ConfirmDialog';
import ConnectInboxModal from '../../components/ConnectInboxModal';
import { disconnectInbox } from '../../lib/connectedInboxes';
import { IDENTITY } from '../../brand/identity.generated.js';

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
  const wsLabelById = new Map(selectOAuthWorkspaces(state).map((w) => [w.id, w.label]));

  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(null); // inbox id or null

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

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Connected Inboxes</h1>
      </div>

      <div className="info-banner" role="note">
        <div>
          <strong>Connected mailboxes vs. your account email.</strong>{' '}
          The mailboxes here are the addresses you send and receive <em>as</em>{' '}
          inside Messaging. Distinct from your{' '}
          <strong>account email</strong> at{' '}
          <strong>Settings → Your Account</strong>, which is used to sign you
          in and to send you app notifications, password resets, etc. The two
          can be the same person, but they're stored separately and {IDENTITY.name}{' '}
          never assumes one matches the other.
        </div>
      </div>

      {sortedInboxes.length === 0 ? (
        <div className="card detail-card" style={{ marginBottom: 16, textAlign: 'center', padding: '28px 16px' }}>
          <Icon name="mail" size={32} />
          <h3 className="dash-card-title" style={{ marginTop: 8 }}>No mailboxes connected yet</h3>
          <p className="text-sm text-muted" style={{ maxWidth: 480, margin: '6px auto 14px' }}>
            Connect a Gmail or Google Workspace mailbox so emails sent through Messaging come from <strong>your</strong> real address. Not a generic system sender.
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
                        {wsLabelById.get(inbox.workspaceId) && <> · Workspace <strong>{wsLabelById.get(inbox.workspaceId)}</strong></>}
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
                        {inbox.inboundCapability
                          ? <Badge variant="green">replies threaded</Badge>
                          : <Badge variant="slate">outbound only</Badge>}
                      </div>
                      {inbox.lastError && (
                        <div className="form-error" style={{ marginTop: 6 }}>
                          Last error: {inbox.lastError}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {!inbox.isDefault && (
                        <button className="btn btn-outline" onClick={() => handleSetDefault(inbox.id)}>
                          Set default
                        </button>
                      )}
                      <button
                        className="btn btn-outline"
                        onClick={() => setConfirmDisconnect(inbox.id)}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
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
