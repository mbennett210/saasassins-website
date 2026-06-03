// Slim Gmail-only connect modal for marketing rotation inboxes.
// Reuses the connectGoogle() adapter from lib/connectedInboxes.js but persists
// to the marketingInboxes state slot via ADD_MARKETING_INBOX — distinct from
// the per-user Messaging ConnectInboxModal (which has Gmail/Microsoft/SMTP
// tabs). Marketing Phase 1 is Gmail-only by spec.

import { useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { connectGoogle } from '../lib/connectedInboxes';
import { useToast } from './Toast';
import Modal from './Modal';
import Icon from './Icon';
import GmailConnectInstructions from './GmailConnectInstructions';

export default function ConnectMarketingInboxModal({ open, onClose }) {
  const dispatch = useDispatch();
  const state = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleConnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await connectGoogle();
      if (!res?.ok || !res.inbox) {
        throw new Error('Connect flow returned no inbox.');
      }
      const inbox = res.inbox;
      // Guard against connecting the same address twice.
      const dup = (state.marketingInboxes || []).some(
        (i) => (i.email || '').toLowerCase() === (inbox.email || '').toLowerCase()
      );
      if (dup) {
        throw new Error(`${inbox.email} is already connected.`);
      }
      dispatch({
        type: ACTIONS.ADD_MARKETING_INBOX,
        id: inbox.id,
        provider: 'google',
        email: inbox.email,
        displayName: inbox.displayName,
        status: inbox.status || 'active',
        inboundCapability: inbox.inboundCapability || 'gmail_poll',
        connectedByUserId: state.currentUserId || null,
      });
      toast.success(`Connected ${inbox.email}`);
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Could not connect inbox.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Connect a Gmail inbox" size="md">
      <p className="marketing-connect-copy">
        Connect a Gmail or Google Workspace mailbox to the shared marketing
        rotation pool. Use a dedicated marketing address — not a personal
        inbox — since the whole team shares it and it stays separate from the
        inbox you use for 1:1 Messaging. Sends are distributed across every
        connected inbox in round-robin order.
      </p>
      <div className="marketing-connect-provider">
        <Icon name="mail" size={20} />
        <span>Gmail / Google Workspace</span>
      </div>

      <GmailConnectInstructions />

      {error && <div className="form-error marketing-connect-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleConnect} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect with Google'}
        </button>
      </div>
    </Modal>
  );
}
