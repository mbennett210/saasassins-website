import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectUserById, selectJobsForUser, selectPermissions, selectUserPermissionOverrides,
} from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import DetailHeader from '../../components/DetailHeader';
import FormField from '../../components/FormField';
import Avatar from '../../components/Avatar';
import Badge from '../../components/Badge';
import ConfirmDialog from '../../components/ConfirmDialog';
import { ROLES, ROLE_LABELS, PERMISSIONS } from '../../lib/roles';

export default function SettingsTeamDetail() {
  const { userId } = useParams();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const canEdit = usePermission('settings.team.edit');
  const canAssignRoles = usePermission('staff.assignRoles');
  const canEditOverrides = usePermission('staff.editOverrides');

  const user = selectUserById(state, userId);
  const permissions = selectPermissions(state);
  const overrides = selectUserPermissionOverrides(state);
  const jobs = useMemo(() => user ? selectJobsForUser(state, user.id) : [], [state, user]);
  const [form, setForm] = useState(user);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const override = useMemo(() => overrides.find((o) => o.userId === userId) || { userId, grants: [], revokes: [] }, [overrides, userId]);

  if (!user) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo="/settings/team" title="Team member not found" />
      </div>
    );
  }
  const current = form && form.id === user.id ? form : user;

  const save = () => {
    dispatch({
      type: ACTIONS.UPDATE_USER,
      id: user.id,
      patch: {
        name: current.name,
        email: current.email,
        phone: current.phone,
        role: current.role,
        status: current.status,
        initials: (current.initials || '').toUpperCase().slice(0, 3),
      },
    });
    toast.success('Member saved');
  };

  const del = () => {
    dispatch({ type: ACTIONS.DELETE_USER, id: user.id });
    navigate('/settings/team');
  };

  const togglePermOverride = (permKey) => {
    if (!canEditOverrides) return;
    const perm = permissions.find((p) => p.id === permKey);
    const roleHas = perm?.roles.includes(user.role);
    let grants = [...(override.grants || [])];
    let revokes = [...(override.revokes || [])];
    if (roleHas) {
      // Currently allowed by role — toggle means "revoke"
      if (revokes.includes(permKey)) {
        revokes = revokes.filter((k) => k !== permKey);
      } else {
        revokes.push(permKey);
        grants = grants.filter((k) => k !== permKey);
      }
    } else {
      // Not in role defaults — toggle means "grant"
      if (grants.includes(permKey)) {
        grants = grants.filter((k) => k !== permKey);
      } else {
        grants.push(permKey);
        revokes = revokes.filter((k) => k !== permKey);
      }
    }
    dispatch({ type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: user.id, grants, revokes });
  };

  const clearOverrides = () => {
    dispatch({ type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: user.id, grants: [], revokes: [] });
  };

  const hasOverrides = (override.grants?.length || 0) + (override.revokes?.length || 0) > 0;

  return (
    <div>
      <DetailHeader
        backTo="/settings/team"
        backLabel="Team"
        title={user.name}
        subtitle={user.email || ''}
        badge={<Badge variant={user.status === 'active' ? 'green' : user.status === 'invited' ? 'amber' : 'slate'}>
          {user.status.charAt(0).toUpperCase() + user.status.slice(1)}
        </Badge>}
      />

      <div className="card detail-card">
        <div className="flex-row" style={{ gap: 16, alignItems: 'center', marginBottom: 20 }}>
          <Avatar initials={user.initials} variant={user.avatar} size="lg" />
          <div>
            <div className="text-sm font-semi">
              {ROLE_LABELS[user.role]}
              {hasOverrides && <span className="tier-badge" style={{ marginLeft: 8 }}>Custom access</span>}
            </div>
            <div className="text-xs text-muted">{jobs.length} job{jobs.length === 1 ? '' : 's'} assigned</div>
          </div>
        </div>
        <div className="form-row">
          <FormField label="Name" required value={current.name || ''} onChange={(e) => setForm({ ...current, name: e.target.value })} disabled={!canEdit} />
          <FormField label="Initials" value={current.initials || ''} onChange={(e) => setForm({ ...current, initials: e.target.value })} disabled={!canEdit} />
        </div>
        <div className="form-row">
          <FormField label="Email" type="email" value={current.email || ''} onChange={(e) => setForm({ ...current, email: e.target.value })} disabled={!canEdit} />
          <FormField label="Phone" value={current.phone || ''} onChange={(e) => setForm({ ...current, phone: e.target.value })} disabled={!canEdit} />
        </div>
        <div className="form-row">
          <FormField
            label="Role"
            as="select"
            value={current.role}
            onChange={(e) => setForm({ ...current, role: e.target.value })}
            disabled={!canAssignRoles}
            help={!canAssignRoles ? 'Only Super Admin can change roles.' : undefined}
            options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
          <FormField label="Status" as="select" value={current.status} onChange={(e) => setForm({ ...current, status: e.target.value })} disabled={!canEdit}
            options={[{ value: 'active', label: 'Active' }, { value: 'invited', label: 'Invited' }, { value: 'disabled', label: 'Disabled' }]} />
        </div>
        {canEdit && (
          <div className="modal-actions">
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Remove</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save</button>
          </div>
        )}
      </div>

      {canEditOverrides && (
        <div className="card detail-card">
          <div className="section-head">
            <div>
              <h3>Permission overrides</h3>
              <p className="text-muted text-sm">
                Grant or revoke specific permissions just for {user.name.split(' ')[0]}. Overrides take precedence over role defaults.
              </p>
            </div>
            {hasOverrides && <button className="btn btn-outline btn-sm" onClick={clearOverrides}>Reset to role defaults</button>}
          </div>
          <div className="table-wrap">
            <table className="overrides-table">
              <thead>
                <tr>
                  <th>Permission</th>
                  <th style={{ textAlign: 'center', width: 120 }}>Role default</th>
                  <th style={{ textAlign: 'center', width: 120 }}>Override</th>
                  <th style={{ textAlign: 'center', width: 120 }}>Effective</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(PERMISSIONS).map((key) => {
                  const perm = permissions.find((p) => p.id === key);
                  const roleHas = perm?.roles.includes(user.role);
                  const granted = override.grants?.includes(key);
                  const revoked = override.revokes?.includes(key);
                  const effective = (roleHas && !revoked) || granted;
                  const overrideLabel = granted ? 'Granted' : revoked ? 'Revoked' : '—';
                  const overrideClass = granted ? 'badge green' : revoked ? 'badge red' : 'badge slate';
                  return (
                    <tr key={key}>
                      <td>
                        <div className="text-sm font-semi">{PERMISSIONS[key].label}</div>
                        <div className="text-xs text-muted">{key}</div>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {roleHas ? <Badge variant="green">Yes</Badge> : <Badge variant="slate">No</Badge>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          className={overrideClass}
                          style={{ minWidth: 90, cursor: 'pointer', border: 'none' }}
                          onClick={() => togglePermOverride(key)}
                          title={`Click to ${granted ? 'clear grant' : revoked ? 'clear revoke' : roleHas ? 'revoke for this user' : 'grant to this user'}`}
                        >
                          {overrideLabel}
                        </button>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {effective ? <Badge variant="green">Allowed</Badge> : <Badge variant="slate">Blocked</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Remove ${user.name}?`}
        message="They will lose access and be removed from any assigned jobs."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={del}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
