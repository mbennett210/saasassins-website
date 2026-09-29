// Connect a per-user Gmail mailbox so the user can send and receive email
// through Messaging from their own address.
//
// Gmail-only for now — Microsoft 365 and SMTP/IMAP are planned but not yet
// shipped (the backend handlers don't exist). When those land we'll re-add
// provider tiles and the SMTP form here. Until then this modal is a single
// click: Connect with Google.
//
// Multi-Workspace (v47): the shared WorkspacePicker shows a "which workspace?"
// selector when 2+ Workspaces are registered (invisible with one), and warns if
// the chosen Workspace isn't ready. Here we seed the default to the Workspace
// whose domain matches the current user's account email, so the common case is
// zero-friction. ConnectFailureHelp turns any OAuth failure into an actionable
// readout instead of a dead end.
//
// Instructions live in the shared GmailConnectInstructions component so
// the marketing-side connect modal shows the exact same setup advice.

import { useEffect, useState } from 'react';
import Modal from './Modal';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import {
  selectCurrentUser,
  selectOAuthWorkspaces,
  selectWorkspaceForEmail,
} from '../store/selectors';
import { connectGoogle, INBOX_STUB_ACTIVE, INBOX_CONFIGURED } from '../lib/connectedInboxes';
import GmailConnectInstructions from './GmailConnectInstructions';
import WorkspacePicker from './WorkspacePicker';
import ConnectFailureHelp from './ConnectFailureHelp';

export default function ConnectInboxModal({ open, onClose }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const state = useStore();
  const currentUser = selectCurrentUser(state);
  const workspaces = selectOAuthWorkspaces(state);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [workspaceId, setWorkspaceId] = useState(null);

  // On open, pick a sensible default Workspace: the only one if there's a
  // single registry entry; otherwise the one matching the user's email domain,
  // falling back to the first. Re-runs when the modal opens.
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError('');
    if (workspaces.length === 0) {
      setWorkspaceId(null);
    } else if (workspaces.length === 1) {
      setWorkspaceId(workspaces[0].id);
    } else {
      const matched = selectWorkspaceForEmail(state, currentUser?.email);
      setWorkspaceId(matched?.id || workspaces[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dispatchInbox = (inbox) => {
    if (!currentUser) return;
    dispatch({
      type: ACTIONS.ADD_CONNECTED_INBOX,
      id: inbox.id,
      userId: currentUser.id,
      provider: 'google',
      email: inbox.email,
      displayName: inbox.displayName,
      status: inbox.status || 'active',
      inboundCapability: inbox.inboundCapability,
      workspaceId: workspaceId || null,
    });
  };

  const submitGoogle = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await connectGoogle(workspaceId);
      if (!result.ok || !result.inbox) throw new Error('Google connection failed.');
      dispatchInbox(result.inbox);
      // A successful connect proves the Workspace works → reflect active in the UI store.
      if (workspaceId) dispatch({ type: ACTIONS.UPDATE_OAUTH_WORKSPACE, id: workspaceId, patch: { status: 'active', lastError: null } });
      toast.success(`Connected ${result.inbox.email}.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not connect Google.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect a Gmail mailbox" size="md">
      <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 12 }}>
        Connect your Gmail or Google Workspace account so emails sent through
        Messaging come from your real address. Not a generic system sender.
        This connection is yours alone; your teammates don&apos;t see it.
        {INBOX_STUB_ACTIVE && (
          <> <strong>Dev mode:</strong> the connect flow is simulated locally and not sent to Google.</>
        )}
        {/* CS-038: a production build with no email backend must NOT fake a mailbox connect. */}
        {!INBOX_CONFIGURED && (
          <> <strong>Not configured:</strong> connected inboxes are not set up for this deployment; connecting a mailbox is disabled until the email backend is provisioned.</>
        )}
      </p>

      <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} />

      <GmailConnectInstructions />

      <ConnectFailureHelp error={error} />

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submitGoogle} disabled={busy || !INBOX_CONFIGURED}>
          {busy ? 'Connecting…' : 'Connect with Google'}
        </button>
      </div>
    </Modal>
  );
}
