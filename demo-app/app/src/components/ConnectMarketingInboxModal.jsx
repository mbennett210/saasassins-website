// Slim Gmail-only connect modal for marketing rotation inboxes.
// Reuses the connectGoogle() adapter from lib/connectedInboxes.js but persists
// to the marketingInboxes state slot via ADD_MARKETING_INBOX — distinct from
// the per-user Messaging ConnectInboxModal (which has Gmail/Microsoft/SMTP
// tabs). Marketing Phase 1 is Gmail-only by spec.
//
// Multi-Workspace (v47): a marketing address is a dedicated shared mailbox, so
// it can't be auto-inferred from the logged-in user's domain the way a personal
// mailbox can — when 2+ Workspaces are registered, the picker lets the operator
// choose which one this address lives in. Routes + attributes through that
// Workspace's OAuth app.

import { useEffect, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { connectGoogle } from '../lib/connectedInboxes';
import { selectOAuthWorkspaces } from '../store/selectors';
import { useToast } from './Toast';
import Modal from './Modal';
import Icon from './Icon';
import GmailConnectInstructions from './GmailConnectInstructions';
import WorkspacePicker from './WorkspacePicker';
import ConnectFailureHelp from './ConnectFailureHelp';

export default function ConnectMarketingInboxModal({ open, onClose }) {
  const dispatch = useDispatch();
  const state = useStore();
  const toast = useToast();
  const workspaces = selectOAuthWorkspaces(state);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [workspaceId, setWorkspaceId] = useState(null);

  // Default the Workspace on open: the only one if there's a single entry;
  // else the registered primary; else the first. No user-domain inference here
  // (marketing addresses are shared, not the operator's own mailbox).
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    if (workspaces.length === 0) setWorkspaceId(null);
    else if (workspaces.length === 1) setWorkspaceId(workspaces[0].id);
    else setWorkspaceId((workspaces.find((w) => w.isPrimary) || workspaces[0]).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleConnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await connectGoogle(workspaceId);
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
        workspaceId: workspaceId || null,
      });
      // A successful connect proves the Workspace works → reflect active in the UI store.
      if (workspaceId) dispatch({ type: ACTIONS.UPDATE_OAUTH_WORKSPACE, id: workspaceId, patch: { status: 'active', lastError: null } });
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
        rotation pool. Use a dedicated marketing address. Not a personal
        inbox. Since the whole team shares it and it stays separate from the
        inbox you use for 1:1 Messaging. Sends are distributed across every
        connected inbox in round-robin order.
      </p>
      <div className="marketing-connect-provider">
        <Icon name="mail" size={20} />
        <span>Gmail / Google Workspace</span>
      </div>

      <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} id="marketing-connect-workspace" />

      <GmailConnectInstructions />

      <ConnectFailureHelp error={error} />
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleConnect} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect with Google'}
        </button>
      </div>
    </Modal>
  );
}
