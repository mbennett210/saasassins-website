import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useFromHere } from '../../hooks/useFromHere';
import { useStore, useDispatch } from '../../store';
import {
  selectUsers,
  selectUserPermissionOverrides,
  selectInvitationForUser,
  selectCompany,
  selectCurrentUser,
} from '../../store/selectors';
import { ACTIONS } from '../../store/reducer';
import { usePermission } from '../../hooks/usePermission';
import AddUserModal from '../../components/AddUserModal';
import ConfirmDialog from '../../components/ConfirmDialog';
import Badge from '../../components/Badge';
import Avatar from '../../components/Avatar';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ROLE_LABELS } from '../../lib/roles';
import { sendEmail, buildInviteEmail } from '../../lib/email';

function relativeTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export default function SettingsTeam() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const nav = useFromHere();
  const navigate = useNavigate();
  const canEdit = usePermission('settings.team.edit');
  const canEditRoles = usePermission('settings.roles.edit');
  const users = selectUsers(state);
  const overrides = selectUserPermissionOverrides(state);
  const company = selectCompany(state);
  const currentUser = selectCurrentUser(state);
  const hasOverride = (userId) => overrides.some((o) => o.userId === userId && ((o.grants?.length || 0) + (o.revokes?.length || 0) > 0));

  const [inviteOpen, setInviteOpen] = useState(false);
  const [revoking, setRevoking] = useState(null); // { invitationId, userName }
  const [resendingId, setResendingId] = useState(null);

  const handleResend = async (user, invitation) => {
    if (!invitation || resendingId) return;
    setResendingId(invitation.id);
    try {
      const { subject, body } = buildInviteEmail({
        inviteeName: user.name,
        inviterName: currentUser?.name || 'Your team',
        companyName: company.name,
        roleLabel: ROLE_LABELS[user.role],
        token: invitation.token,
        expiresAt: invitation.expiresAt,
      });
      await sendEmail({
        to: user.email,
        from: company.email || 'no-reply@example.com',
        subject,
        body,
        replyTo: currentUser?.email || company.email,
      });
      dispatch({ type: ACTIONS.RESEND_INVITATION, id: invitation.id });
      toast.success(`Invitation resent to ${user.email}`);
    } catch (err) {
      toast.error(`Couldn't resend: ${err.message || 'Email send failed.'}`);
    } finally {
      setResendingId(null);
    }
  };

  const handleRevoke = (invitationId) => {
    dispatch({ type: ACTIONS.REVOKE_INVITATION, id: invitationId });
    toast.success('Invitation revoked');
    setRevoking(null);
  };

  return (
    <div>
      <div className="section-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Team</h1>
          <p className="page-head-subtitle">Everyone who can log in. Click a name to edit.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {canEditRoles && (
            <Link to="/settings/roles" className="text-sm text-muted">Edit role defaults →</Link>
          )}
          {canEdit && (
            <button className="btn btn-primary btn-sm" onClick={() => setInviteOpen(true)}>
              Invite Member
            </button>
          )}
        </div>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={<Icon name="clients" size={28} />} title="No team members yet" />
      ) : (
        <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const invitation = u.status === 'invited' ? selectInvitationForUser(state, u.id) : null;
                  const sentLabel = invitation
                    ? (invitation.lastResentAt ? `resent ${relativeTime(invitation.lastResentAt)}` : `sent ${relativeTime(invitation.sentAt)}`)
                    : '';
                  return (
                    <tr
                      key={u.id}
                      className="clickable"
                      onClick={() => navigate(`/settings/team/${u.id}`, { state: nav })}
                    >
                      <td>
                        {/* Keep the inner Link for keyboard nav + right-click "Open in new tab".
                            The row-level onClick handles the broader hit area. */}
                        <Link to={`/settings/team/${u.id}`} state={nav} className="flex-row table-name-link" style={{ gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                          <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                          <span className="name">{u.name}</span>
                        </Link>
                      </td>
                      <td>{u.email || '—'}</td>
                      <td>{ROLE_LABELS[u.role]}</td>
                      <td>
                        <Badge variant={hasOverride(u.id) ? 'amber' : 'slate'}>
                          {hasOverride(u.id) ? 'Custom' : 'Default'}
                        </Badge>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <Badge variant={u.status === 'active' ? 'green' : u.status === 'invited' ? 'amber' : 'slate'}>
                            {u.status.charAt(0).toUpperCase() + u.status.slice(1)}
                          </Badge>
                          {invitation && sentLabel && (
                            <span className="text-xs text-muted">{sentLabel}</span>
                          )}
                        </div>
                      </td>
                      <td className="text-right">
                        {invitation && canEdit ? (
                          <div
                            style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              onClick={() => handleResend(u, invitation)}
                              disabled={resendingId === invitation.id}
                              title="Resend invitation email"
                            >
                              <Icon name="mail" size={14} />
                              {resendingId === invitation.id ? 'Sending…' : 'Resend'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              onClick={() => setRevoking({ invitationId: invitation.id, userName: u.name })}
                              title="Revoke invitation"
                            >
                              <Icon name="x" size={14} />
                              Revoke
                            </button>
                          </div>
                        ) : (
                          <Icon name="chevronRight" size={14} />
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      <AddUserModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <ConfirmDialog
        open={!!revoking}
        title="Revoke invitation?"
        message={revoking ? `${revoking.userName} won't be able to use this invite. You can re-invite them later.` : ''}
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={() => revoking && handleRevoke(revoking.invitationId)}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
