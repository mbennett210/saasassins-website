// Settings → Integrations → Google Workspaces (super-admin registry).
//
// Multi-Workspace OAuth (Path 2): each row is one Google Workspace org wired to
// its own Internal OAuth app. End users connect their own mailboxes under
// Settings → Connected Inboxes; THIS admin view is where a Super Admin registers
// each Workspace and sees every connected mailbox org-wide, grouped by
// Workspace. The client_secret never reaches the browser — the backend holds it
// encrypted; here we show display metadata + setup status only. Connection
// metadata (address, owner, status) is visible to the admin; message contents
// are never exposed here, preserving the per-user privacy promise.

import { useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectOAuthWorkspacesWithCounts,
  selectInboxesGroupedByWorkspace,
} from '../store/selectors';
import Badge from './Badge';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import AddWorkspaceModal from './AddWorkspaceModal';
import { useToast } from './Toast';
import { testWorkspace, removeWorkspace, WORKSPACES_STUB_ACTIVE, WORKSPACES_CONFIGURED } from '../lib/oauthWorkspaces';

const STATUS_BADGE = {
  active:  { variant: 'green', label: 'Active' },
  pending: { variant: 'amber', label: 'Pending admin approval' },
  setup:   { variant: 'slate', label: 'Setup needed' },
  error:   { variant: 'red',   label: 'Error' },
};

const INBOX_BADGE = {
  active:  { variant: 'green', label: 'Connected' },
  expired: { variant: 'amber', label: 'Reconnect' },
  pending: { variant: 'amber', label: 'Verifying…' },
  error:   { variant: 'red',   label: 'Error' },
};

export default function GoogleWorkspacesSection({ canManage }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();

  const workspaces = selectOAuthWorkspacesWithCounts(state);
  const grouped = selectInboxesGroupedByWorkspace(state);
  const inboxesByWs = new Map(grouped.map((g) => [g.workspace.id, g.inboxes]));

  const [addOpen, setAddOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null); // workspace or null
  const [testingId, setTestingId] = useState(null);

  const handleTest = async (ws) => {
    setTestingId(ws.id);
    try {
      const r = await testWorkspace(ws.id);
      if (!r.ok) throw new Error(r.error || 'Test failed.');
      dispatch({ type: ACTIONS.UPDATE_OAUTH_WORKSPACE, id: ws.id, patch: { status: r.status || 'active', lastError: null } });
      toast.success(`${ws.label} is reachable.`);
    } catch (err) {
      dispatch({ type: ACTIONS.UPDATE_OAUTH_WORKSPACE, id: ws.id, patch: { status: 'error', lastError: err.message } });
      toast.error(err.message || 'Workspace test failed.');
    } finally {
      setTestingId(null);
    }
  };

  const handleRemove = async (ws) => {
    setConfirmRemove(null);
    try {
      await removeWorkspace(ws.id);
      dispatch({ type: ACTIONS.REMOVE_OAUTH_WORKSPACE, id: ws.id });
      toast.success(`${ws.label} removed.`);
    } catch (err) {
      toast.error(err.message || 'Could not remove workspace.');
    }
  };

  return (
    <div className="card detail-card" style={{ marginBottom: 16 }}>
      <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 className="dash-card-title"><Icon name="mail" size={16} /> Google Workspaces</h3>
          <div className="text-sm text-muted" style={{ maxWidth: 580 }}>
            Each Workspace is one Google org wired to its own Internal OAuth app. No Google
            verification, no annual fees. Team members connect their own mailboxes under{' '}
            <strong>Settings → Connected Inboxes</strong>; this is the org-wide registry of
            every Workspace and the mailboxes connected under each.
            {WORKSPACES_STUB_ACTIVE && (
              <> <strong>Dev mode:</strong> setup is simulated locally and not sent to Google.</>
            )}
            {!WORKSPACES_CONFIGURED && (
              // CS-038: a production build with no email backend must NOT fake a register.
              <> Google Workspaces are not configured for this deployment.</>
            )}
          </div>
        </div>
        {canManage && WORKSPACES_CONFIGURED && (
          <button className="btn btn-primary" onClick={() => setAddOpen(true)} style={{ whiteSpace: 'nowrap' }}>
            Add a Workspace
          </button>
        )}
      </div>

      {workspaces.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 12px' }}>
          <Icon name="mail" size={28} />
          <p className="text-sm text-muted" style={{ maxWidth: 460, margin: '8px auto 0' }}>
            No Google Workspaces registered yet. Add one so your team can connect mailboxes
            from that Workspace org.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {workspaces.map((ws) => {
            const badge = STATUS_BADGE[ws.status] || { variant: 'slate', label: ws.status };
            const expanded = expandedId === ws.id;
            const mailboxes = inboxesByWs.get(ws.id) || [];
            return (
              <div key={ws.id} className="card" style={{ padding: 14 }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      {ws.label}
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {ws.isPrimary && <Badge variant="blue">Primary</Badge>}
                    </div>
                    <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                      {(ws.domains && ws.domains.length) ? ws.domains.join(', ') : 'No domains set'}
                      {' · '}
                      {ws.mailboxCount} mailbox{ws.mailboxCount === 1 ? '' : 'es'} connected
                      {ws.mailboxCount > 0 && <> · {ws.healthy ? 'all healthy' : 'attention needed'}</>}
                    </div>
                    {ws.clientId && (
                      <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                        Client ID <code>{ws.clientId}</code>
                        {ws.clientSecretLast4 && <> · secret •••• {ws.clientSecretLast4}</>}
                      </div>
                    )}
                    {ws.isVirtual && (
                      <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                        These mailboxes were connected before multi-Workspace was set up. Add a Workspace with its OAuth Client ID to register and manage it.
                      </div>
                    )}
                    {ws.lastError && <div className="form-error" style={{ marginTop: 6 }}>Last error: {ws.lastError}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {ws.mailboxCount > 0 && (
                      <button className="btn btn-outline" onClick={() => setExpandedId(expanded ? null : ws.id)}>
                        {expanded ? 'Hide mailboxes' : `View ${ws.mailboxCount} mailbox${ws.mailboxCount === 1 ? '' : 'es'}`}
                      </button>
                    )}
                    {canManage && !ws.isVirtual && (
                      <button className="btn btn-outline" disabled={testingId === ws.id} onClick={() => handleTest(ws)}>
                        {testingId === ws.id ? 'Testing…' : 'Test'}
                      </button>
                    )}
                    {canManage && !ws.isPrimary && !ws.isVirtual && (
                      <button
                        className="btn btn-outline"
                        disabled={ws.mailboxCount > 0}
                        title={ws.mailboxCount > 0 ? 'Disconnect its mailboxes first' : ''}
                        onClick={() => setConfirmRemove(ws)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                {expanded && mailboxes.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--card-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {mailboxes.map((mb) => {
                      const ib = INBOX_BADGE[mb.status] || { variant: 'slate', label: mb.status };
                      return (
                        <div key={mb.id} className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                          <span><Icon name="mail" size={13} /> {mb.email} <span className="text-muted">· {mb.ownerName}</span></span>
                          <Badge variant={ib.variant}>{ib.label}</Badge>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddWorkspaceModal open={addOpen} onClose={() => setAddOpen(false)} />
      <ConfirmDialog
        open={Boolean(confirmRemove)}
        title="Remove this Workspace?"
        message={`Removing "${confirmRemove?.label || ''}" deletes its OAuth registration from the app. Team members in that Workspace won't be able to connect new mailboxes until it's re-added. Existing connections are unaffected.`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => handleRemove(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
      />
    </div>
  );
}
