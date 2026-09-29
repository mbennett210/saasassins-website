import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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
import { ROLE_LABELS, compareUsersByName, liveOverrideKeys } from '../../lib/roles';
import { CLOCK_RULE_OFF_BADGES, clockRulesOff } from '../../lib/clockRules';
import { teamLimit, teamLimitReason } from '../../lib/teamLimits';
import { sendEmail, buildInviteEmail } from '../../lib/email';
import { listOrphanLogins } from '../../lib/teamApi';
import { getTeamPushStatus } from '../../lib/push';
import { usePagedRows } from '../../hooks/usePagedRows';
import ListPager from '../../components/ListPager';
import AppVersionsCard from '../../components/AppVersionsCard';

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
  const holdsClockRules = usePermission('time.clockRules');
  const users = selectUsers(state);
  // Alphabetical, always (UI_RULES §51) — the slice itself is in insertion order,
  // so the newest member would otherwise sit at the bottom of 40+ rows.
  const sortedUsers = useMemo(() => users.slice().sort(compareUsersByName), [users]);
  const overrides = selectUserPermissionOverrides(state);
  const company = selectCompany(state);
  const currentUser = selectCurrentUser(state);
  const canSeePush = ['owner', 'admin', 'manager'].includes(currentUser?.role);
  // The Clock rules column is for whoever can change them (step 4b) — the same rule the
  // Push column follows: a column nobody can act on is noise on an already-wide table. That
  // is an OFFICE role AND the key, as on the member page: a per-user grant of the key to a
  // cleaner does nothing for this field, so it shows them nothing to act on either.
  const canSeeClockRules = holdsClockRules && ['owner', 'admin', 'manager'].includes(currentUser?.role);
  const userPager = usePagedRows(sortedUsers, { param: 'page' });
  // Custom = an override that can change what they may do (an OWNER_ONLY entry on a
  // non-owner does nothing, lib/roles.js liveOverrideKeys).
  const hasOverride = (u) => overrides.some((o) => o.userId === u.id
    && liveOverrideKeys(o.grants, u.role).length + liveOverrideKeys(o.revokes, u.role).length > 0);

  const [inviteOpen, setInviteOpen] = useState(false);
  // Global search "Invite team member" deep-link: ?new=1 opens the invite modal once, then
  // strips it. Gated on canEdit. The strip REPLACES the history entry, so it re-passes the
  // location state — SettingsLayout's back arrow reads state.from, and dropping it would
  // send Back to the Settings hub instead of wherever the user searched from.
  const location = useLocation();
  const [teamSearchParams, setTeamSearchParams] = useSearchParams();
  useEffect(() => {
    if (teamSearchParams.get('new') && canEdit) {
      setInviteOpen(true);
      const next = new URLSearchParams(teamSearchParams);
      next.delete('new');
      setTeamSearchParams(next, { replace: true, state: location.state });
    }
  }, [teamSearchParams, canEdit, setTeamSearchParams, location.state]);
  const [invitePrefill, setInvitePrefill] = useState(null); // { email, role } from the orphan banner
  const [revoking, setRevoking] = useState(null); // { invitationId, userId, userName }
  const [resendingId, setResendingId] = useState(null);

  // Logins with no team record — a member whose invite only half-landed (the
  // login write is server-side and durable, the roster write goes into the
  // contended org_state blob and can be lost). Without this they are invisible
  // HERE, which is the one place anyone would look: that is how a real member
  // went unnoticed for two days. Re-inviting them adopts the existing login.
  // Non-blocking: a failed or unconfigured lookup just renders no banner.
  const [orphans, setOrphans] = useState([]);
  const [pushStatus, setPushStatus] = useState({}); // userId -> { deviceCount, lastSeenAt }; admin-only
  const rosterCount = users.length;
  useEffect(() => {
    if (!canEdit) { setOrphans([]); return undefined; }
    let alive = true;
    listOrphanLogins()
      .then((r) => { if (alive) setOrphans(Array.isArray(r?.orphans) ? r.orphans : []); })
      .catch(() => { if (alive) setOrphans([]); });
    return () => { alive = false; };
    // Re-check when the roster changes so adopting one clears it from the banner.
  }, [canEdit, rosterCount]);

  // Per-user mobile-push status (owner/admin/manager only, matching the server
  // role gate). Non-blocking: a 403 or unconfigured backend just leaves the column
  // blank. Reflects ACTUAL device subscriptions (push_subscriptions), not the
  // mobilePushEnabled intent pref, so it catches "pref on but no device" gaps.
  useEffect(() => {
    if (!canSeePush) { setPushStatus({}); return undefined; }
    let alive = true;
    getTeamPushStatus()
      .then((m) => { if (alive) setPushStatus(m || {}); })
      .catch(() => { if (alive) setPushStatus({}); });
    return () => { alive = false; };
  }, [canSeePush, rosterCount]);

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

  const handleRevoke = ({ invitationId, userId }) => {
    // Backstop for the hidden button: revoking sets the member's status, which only a
    // Super Admin may change on a Super Admin (lib/teamLimits.js; the server agrees).
    const limit = teamLimit(currentUser, users.find((x) => x.id === userId), 'revoke');
    if (limit) { toast.error(teamLimitReason('revoke', limit)); setRevoking(null); return; }
    dispatch({ type: ACTIONS.REVOKE_INVITATION, id: invitationId });
    toast.success('Invitation revoked');
    setRevoking(null);
  };

  return (
    <div>
      <div className="section-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Team</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {canEditRoles && (
            <Link to="/settings/roles" state={nav} className="text-sm text-muted">Edit role defaults →</Link>
          )}
          {canEdit && (
            <button className="btn btn-primary" onClick={() => { setInvitePrefill(null); setInviteOpen(true); }}>
              Invite Member
            </button>
          )}
        </div>
      </div>

      {/* Fleet build telemetry (Sept 1 hardening) — GET is owner/admin server-side,
          so gate the mount on the same roles to avoid a guaranteed 403. Manager is a
          full-access tier (S35), so it mounts too; the server GET twin must allow
          manager at go-live (API is stripped in this demo build). */}
      {['owner', 'admin', 'manager'].includes(currentUser?.role) && (
        <AppVersionsCard users={sortedUsers} />
      )}

      {orphans.length > 0 && (
        <div className="callout callout-warning" style={{ marginBottom: 16 }}>
          <div className="text-sm" style={{ marginBottom: 8 }}>
            <strong>{orphans.length} login{orphans.length === 1 ? '' : 's'} with no team record.</strong>{' '}
            Someone was invited and can sign in, but they were never finished being added. So they
            don’t appear below and can’t be given an access level. Add them to fix it; their existing
            login is kept and they’ll get a fresh set-password email.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {orphans.map((o) => (
              <div key={o.email} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="text-sm truncate" title={o.email} style={{ minWidth: 0 }}>{o.email}</span>
                {o.role && <Badge variant="slate">{ROLE_LABELS[o.role] || o.role}</Badge>}
                <span className="text-xs text-muted">
                  invited {relativeTime(o.createdAt) || '—'}
                  {o.lastSignInAt ? '' : ' · never signed in'}
                </span>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => { setInvitePrefill({ email: o.email, role: o.role || 'crew' }); setInviteOpen(true); }}
                >
                  Add to team
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {users.length === 0 ? (
        <EmptyState icon={<Icon name="clients" size={28} />} title="No team members yet" />
      ) : (
        <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th>{canSeeClockRules && <th>Clock rules</th>}{canSeePush && <th>Push</th>}<th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {userPager.pageRows.map((u) => {
                  const invitation = u.status === 'invited' ? selectInvitationForUser(state, u.id) : null;
                  const sentLabel = invitation
                    ? (invitation.lastResentAt ? `resent ${relativeTime(invitation.lastResentAt)}` : `sent ${relativeTime(invitation.sentAt)}`)
                    : '';
                  // Revoking sets the member's status, and only a Super Admin may change a
                  // Super Admin's (lib/teamLimits.js; the server refuses it from anyone else).
                  const revokeLimit = invitation ? teamLimit(currentUser, u, 'revoke') : null;
                  return (
                    <tr
                      key={u.id}
                      className="clickable"
                      onClick={() => navigate(`/settings/team/${u.id}`, { state: nav })}
                    >
                      <td className="cell-primary">
                        {/* Keep the inner Link for keyboard nav + right-click "Open in new tab".
                            The row-level onClick handles the broader hit area. */}
                        <Link to={`/settings/team/${u.id}`} state={nav} className="flex-row table-name-link" style={{ gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                          <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                          <span className="name truncate" title={u.name}>{u.name}</span>
                        </Link>
                      </td>
                      <td data-label="Email"><span className="truncate" title={u.email || ''}>{u.email || '—'}</span></td>
                      <td data-label="Role">{ROLE_LABELS[u.role]}</td>
                      <td data-label="Access">
                        <Badge variant={hasOverride(u) ? 'amber' : 'slate'}>
                          {hasOverride(u) ? 'Custom' : 'Default'}
                        </Badge>
                      </td>
                      {canSeeClockRules && (
                        <td data-label="Clock rules">
                          {/* Normal is the quiet state — a dash, never a "Default" badge:
                              every member reads normal, so a badge on all of them would be
                              noise, and the point of the column is to spot the exceptions.
                              One amber chip per rule that is OFF. */}
                          {(() => {
                            const off = clockRulesOff(u);
                            if (!off.length) return <span className="text-xs text-muted">—</span>;
                            return (
                              <div className="cell-chip-stack">
                                {off.map((key) => <div key={key}><Badge variant="amber">{CLOCK_RULE_OFF_BADGES[key]}</Badge></div>)}
                              </div>
                            );
                          })()}
                        </td>
                      )}
                      {canSeePush && (
                        <td data-label="Push">
                          {(() => {
                            if (u.status !== 'active') return <span className="text-xs text-muted">—</span>;
                            const st = pushStatus[u.id];
                            const on = !!(st && st.deviceCount > 0);
                            return (
                              <Badge
                                variant={on ? 'green' : 'slate'}
                                title={on
                                  ? `${st.deviceCount} device${st.deviceCount === 1 ? '' : 's'}${st.lastSeenAt ? `, last seen ${relativeTime(st.lastSeenAt)}` : ''}`
                                  : 'No subscribed device; this person will not get mobile push'}
                              >
                                {on ? 'On' : 'Off'}
                              </Badge>
                            );
                          })()}
                        </td>
                      )}
                      <td data-label="Status">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <Badge variant={u.status === 'active' ? 'green' : u.status === 'invited' ? 'amber' : 'slate'}>
                            {u.status.charAt(0).toUpperCase() + u.status.slice(1)}
                          </Badge>
                          {invitation && sentLabel && (
                            <span className="text-xs text-muted">{sentLabel}</span>
                          )}
                        </div>
                      </td>
                      <td className="text-right cell-actions">
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
                            {revokeLimit ? (
                              <span className="text-xs text-muted">{teamLimitReason('revoke', revokeLimit)}</span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-outline btn-sm"
                                onClick={() => setRevoking({ invitationId: invitation.id, userId: u.id, userName: u.name })}
                                title="Revoke invitation"
                              >
                                <Icon name="x" size={14} />
                                Revoke
                              </button>
                            )}
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
          <ListPager pager={userPager} noun="members" />
        </div>
      )}

      <AddUserModal
        open={inviteOpen}
        initial={invitePrefill}
        onClose={() => { setInviteOpen(false); setInvitePrefill(null); }}
      />
      <ConfirmDialog
        open={!!revoking}
        title="Revoke invitation?"
        message={revoking ? `${revoking.userName} won't be able to use this invite. You can re-invite them later.` : ''}
        confirmLabel="Revoke"
        variant="danger"
        onConfirm={() => revoking && handleRevoke(revoking)}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
