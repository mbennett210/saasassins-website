import { Link } from 'react-router-dom';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectPermissions } from '../../store/selectors';
import { ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, PERMISSIONS } from '../../lib/roles';

// Permissions grouped by surface area for scannability. Order = display order.
// Headings track the demo's actual permission catalog (lib/roles.js) — every key
// here exists, so nothing falls into the "Other" bucket. (Quotes/Keys/Forms/Time
// groups from Rainier are intentionally omitted: those modules + keys aren't in
// the demo.)
const PERM_GROUPS = [
  { id: 'dashboard',    label: 'Dashboard',             keys: ['dashboard.view'] },
  { id: 'schedule',     label: 'Schedule & Jobs',       keys: ['schedule.view', 'schedule.edit', 'schedule.statusTransition'] },
  { id: 'clients',      label: 'Clients & Sites',       keys: ['clients.view', 'clients.edit', 'clients.delete', 'sites.edit', 'sites.attachments'] },
  { id: 'contacts',     label: 'Contacts & Pipeline',   keys: ['contacts.view', 'contacts.edit', 'contacts.delete', 'tags.manage', 'pipeline.view', 'pipeline.edit'] },
  { id: 'invoices',     label: 'Invoices & Reminders',  keys: ['invoices.view', 'invoices.edit', 'invoices.recordPayment', 'reminders.view', 'reminders.edit'] },
  { id: 'messaging',    label: 'Messaging',             keys: ['messaging.use', 'messaging.startConversation', 'messaging.startInternalThread', 'messaging.internalComment', 'messaging.manageSnippets', 'messaging.bulkActions'] },
  { id: 'marketing',    label: 'Marketing',             keys: ['marketing.view', 'marketing.manage', 'marketing.connectInbox'] },
  { id: 'complaints',   label: 'Complaints',            keys: ['complaints.view', 'complaints.manage'] },
  { id: 'reviews',      label: 'Reviews',               keys: ['reviews.view'] },
  { id: 'qc',           label: 'Quality (Inspections)', keys: ['qc.view', 'qc.inspect', 'qc.templates.edit', 'qc.share', 'problems.manage'] },
  { id: 'variance',     label: 'Variance Report',       keys: ['variance.view', 'variance.actions', 'variance.export'] },
  { id: 'ops',          label: 'Operations',            keys: ['ops.view', 'ops.edit'] },
  { id: 'settings',     label: 'Settings',              keys: ['settings.company', 'settings.services', 'settings.team.view', 'settings.team.edit', 'settings.roles.edit', 'settings.account'] },
  { id: 'integrations', label: 'Integrations',          keys: ['integrations.view', 'integrations.manage'] },
  { id: 'super',        label: 'Super Admin Only',      keys: ['staff.assignRoles', 'staff.editOverrides'] },
];

// Permissions where flipping ON for a non-owner role is high-impact / hard to undo.
// Surfaces a "Sensitive" pill in the matrix and a warning-toned toast on grant.
const DANGER_KEYS = new Set([
  'clients.delete',
  'contacts.delete',
  'invoices.edit',
  'invoices.recordPayment',
  'integrations.manage',
  'settings.roles.edit',
  'staff.assignRoles',
  'staff.editOverrides',
]);

export default function SettingsRoles() {
  const permissions = selectPermissions(useStore());
  const dispatch = useDispatch();

  const togglePerm = (perm, role) => {
    const next = perm.roles.includes(role)
      ? perm.roles.filter((r) => r !== role)
      : [...perm.roles, role];
    dispatch({ type: ACTIONS.UPDATE_PERMISSION, id: perm.id, patch: { roles: next } });
  };

  const resetDefaults = () => {
    permissions.forEach((p) => {
      const def = PERMISSIONS[p.id]?.defaultRoles;
      if (!def) return;
      const sortedCur = [...p.roles].sort().join(',');
      const sortedDef = [...def].sort().join(',');
      if (sortedCur !== sortedDef) {
        dispatch({ type: ACTIONS.UPDATE_PERMISSION, id: p.id, patch: { roles: [...def] } });
      }
    });
  };

  // Lookup: find a permission record by key
  const byKey = (key) => permissions.find((p) => p.id === key);

  // Catch any keys defined in PERMISSIONS but not in PERM_GROUPS — shows them in an "Other" section.
  const groupedKeys = new Set(PERM_GROUPS.flatMap((g) => g.keys));
  const ungrouped = permissions.filter((p) => !groupedKeys.has(p.id));

  const renderRow = (p) => (
    <tr key={p.id}>
      <td>
        <div className="text-sm font-semi" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{p.label}</span>
          {DANGER_KEYS.has(p.id) && <span className="perm-sensitive-pill">Sensitive</span>}
        </div>
      </td>
      {ROLES.map((r) => (
        <td key={r} style={{ textAlign: 'center' }}>
          <input
            type="checkbox"
            className="role-checkbox"
            checked={p.roles.includes(r)}
            onChange={() => togglePerm(p, r)}
          />
        </td>
      ))}
    </tr>
  );

  const renderGroup = (label, rows) => (
    <div style={{ marginBottom: 16 }}>
      <h3 className="perm-group-head">{label}</h3>
      <div className="table-wrap">
        <table className="roles-table">
          <thead>
            <tr>
              <th>Permission</th>
              {ROLES.map((r) => <th key={r} style={{ textAlign: 'center', width: 100 }}>{ROLE_LABELS[r]}</th>)}
            </tr>
          </thead>
          <tbody>{rows.map(renderRow)}</tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <div className="section-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Roles & Permissions</h1>
          <p className="page-head-subtitle">
            Set what each role can do. Changes apply immediately to everyone in that role unless they have a per-user override.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={resetDefaults}>Reset all to defaults</button>
      </div>

      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <div className="role-legend">
          {ROLES.map((r) => (
            <div key={r} className="role-legend-item">
              <strong>{ROLE_LABELS[r]}</strong>
              <span className="text-muted text-sm">{ROLE_DESCRIPTIONS[r]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <strong>How permissions resolve</strong>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          For each user we check, in order: <strong>per-user revoke</strong> → <strong>per-user grant</strong> → <strong>role default below</strong>.
          Edit defaults here; edit per-user overrides from a member's page in <Link to="/settings/team">Team</Link>.
        </p>
      </div>

      {PERM_GROUPS.map((group) => {
        const rows = group.keys.map(byKey).filter(Boolean);
        if (rows.length === 0) return null;
        return <div key={group.id}>{renderGroup(group.label, rows)}</div>;
      })}

      {ungrouped.length > 0 && renderGroup('Other', ungrouped)}
    </div>
  );
}
