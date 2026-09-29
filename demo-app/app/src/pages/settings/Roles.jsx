import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectPermissions, selectCurrentUser, selectUserPermissionOverrides } from '../../store/selectors';
import { ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, PERMISSIONS, ALWAYS_GRANTED, OWNER_ONLY, OWNER_CORE, PERM_GROUPS, canGrantPermission, canEndAccess, canReduceRole } from '../../lib/roles';
import { useFromHere } from '../../hooks/useFromHere';
import { MARKETING_ENABLED } from '../../lib/features';
import Badge from '../../components/Badge';

// PERM_GROUPS (the canonical section grouping) lives in lib/roles.js next to PERMISSIONS
// so the taxonomy and the vocabulary stay in sync in one place, and a test can assert
// every editable key has a home. Universal surfaces (ALWAYS_GRANTED) are excluded there
// and filtered again below. Order = display order.

// Permissions where flipping ON for a non-owner role is high-impact / hard to undo.
// Surfaces a "Sensitive" pill in the matrix.
const DANGER_KEYS = new Set([
  'clients.delete',
  'contacts.delete',
  'invoices.edit',
  'invoices.recordPayment',
  'payroll.rates.edit',
  'hr.edit',
  'integrations.manage',
  'settings.roles.edit',
  'staff.assignRoles',
  'staff.editOverrides',
  'staff.resetPassword',
  'settings.company.timezone',
]);

// Toggle switch — brand-black when on, light gray when off, a medium-gray centered
// knob when a section master is partially on ("mixed"). Purely presentational; the
// button carries the switch role + aria state.
function Toggle({ state, disabled, onClick, label }) {
  return (
    <button
      type="button"
      className={`rp-toggle rp-toggle--${state}`}
      role="switch"
      aria-checked={state === 'on'}
      aria-label={state === 'mixed' ? `${label} (partially on)` : label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="rp-toggle-knob" aria-hidden />
    </button>
  );
}

export default function SettingsRoles() {
  const state = useStore();
  const permissions = selectPermissions(state);
  const currentUser = selectCurrentUser(state);
  const overrides = selectUserPermissionOverrides(state);
  const dispatch = useDispatch();
  const nav = useFromHere();
  const [open, setOpen] = useState({});

  // Lookup: find a permission record by key. A key the schema knows but the SAVED
  // matrix doesn't yet (added in code, no data-op run) still renders, at its schema
  // default and read-only, so the matrix never silently omits a permission that is
  // live via can()'s defaultRoles fallback. UPDATE_PERMISSION replaces an existing
  // row and cannot create one, hence read-only.
  const byKey = (key) => permissions.find((p) => p.id === key)
    || (PERMISSIONS[key]
      ? { id: key, label: PERMISSIONS[key].label, roles: [...(PERMISSIONS[key].defaultRoles || [])], schemaDefault: true }
      : undefined);

  // A Super-Admin-only key (OWNER_ONLY) can't be given to another role: can() ignores it
  // for them, as the server does. Those cells show a "Super Admin only" status badge, not a
  // switch that would do nothing (UI_RULES §41), and the section master leaves them alone.
  const locked = (perm, role) => OWNER_ONLY.has(perm.id) && role !== 'owner';

  // CS-331: a non-owner may switch a permission ON only for a key they hold themselves
  // (canGrantPermission, the same rule orgStateGuard enforces on save). A Super Admin holds
  // everything, so this never limits an owner. Turning a permission OFF stays free.
  const canGrant = (key) => canGrantPermission(currentUser, key, permissions, overrides);
  // A cell that is OFF for a role whose key the caller can't grant: switching it ON would be a
  // grant the server refuses, so it is shown locked rather than offered.
  const grantLocked = (perm, role) => !perm.roles.includes(role) && !canGrant(perm.id);
  // CS-370: turning an ADMIN-column key from ON to OFF reduces the Admin role's access for every
  // Admin at once, so it is admin+ by ROLE (canEndAccess — the matrix twin of CS-369, the same rule
  // orgStateGuard enforces on save). A Super Admin and an Admin may; a manager / crew may not, so
  // an ON admin cell is shown locked for them. Granting the admin column stays canGrant (CS-331),
  // and the other role columns are unaffected.
  const canReduceAdminRole = canEndAccess(currentUser?.role, true);
  // CS-371: turning an OWNER-column key from ON to OFF reduces the Super Admin role's access for every
  // part of the app the owner reaches through can(), and orgStateGuard refuses it on save, so only a
  // Super Admin may (canReduceRole). The OWNER_CORE keys (dashboard.view, settings.roles.edit) resolve
  // true for an owner whatever the matrix says, so turning their owner cell off is a no-op the guard
  // does not refuse — they are NOT reduce-locked, which keeps the page in exact agreement with the
  // server. Granting the owner column stays canGrant (CS-331).
  const canReduceOwnerRole = canReduceRole(currentUser?.role, 'owner');
  // An ON cell whose OFF would reduce a role's access for a viewer who may not: the admin column
  // (admin+ by role, CS-370) or the owner column excluding the always-granted OWNER_CORE keys (Super
  // Admin only, CS-371). The same reductions orgStateGuard refuses on save.
  const reduceLocked = (perm, role) => perm.roles.includes(role) && (
    (role === 'admin' && !canReduceAdminRole)
    || (role === 'owner' && !OWNER_CORE.has(perm.id) && !canReduceOwnerRole)
  );

  // Write one (permission, role) to the target on/off state. No-ops on schema-default
  // (unsaved) rows, on locked cells, on a grant of a key the caller doesn't hold (CS-331),
  // and when already in the desired state, so a master sweep only dispatches real changes.
  const setPerm = (perm, role, on) => {
    if (perm.schemaDefault || locked(perm, role)) return;
    if (on && !canGrant(perm.id)) return; // can't grant a key you don't hold (CS-331)
    if (!on && reduceLocked(perm, role)) return; // can't turn off a reduce-locked cell (admin CS-370 / owner CS-371)
    const has = perm.roles.includes(role);
    if (on === has) return;
    const next = on ? [...perm.roles, role] : perm.roles.filter((r) => r !== role);
    dispatch({ type: ACTIONS.UPDATE_PERMISSION, id: perm.id, patch: { roles: next } });
  };
  const togglePerm = (perm, role) => setPerm(perm, role, !perm.roles.includes(role));

  // Master state for a section + role, computed over the EDITABLE rows: 'on' (all),
  // 'off' (none), or 'mixed' (some). Schema-default rows and locked cells are excluded —
  // the master can't drive them.
  // The rows a section master can actually drive for a role: not schema-default, not
  // OWNER_ONLY-locked, not grant-locked (CS-331 — a key the caller can't grant, currently OFF, is
  // left alone), and not reduce-locked (an ON admin-column key a non-admin+ viewer can't turn off,
  // CS-370; or an ON non-core owner-column key a non-owner can't turn off, CS-371). The master
  // reflects and flips only what it may change; the rest stay visibly locked, so it can never grant
  // an unheld key nor reduce the Admin or Super Admin role's access.
  const drivable = (rows, role) => rows.filter((r) => !r.schemaDefault && !locked(r, role) && !grantLocked(r, role) && !reduceLocked(r, role));

  const masterState = (rows, role) => {
    const editable = drivable(rows, role);
    if (editable.length === 0) return 'off';
    const on = editable.filter((r) => r.roles.includes(role)).length;
    if (on === 0) return 'off';
    if (on === editable.length) return 'on';
    return 'mixed';
  };
  // Master toggle: if the drivable rows aren't all ON for this role, turn them ON; otherwise
  // turn them all OFF. It never grants a key the caller doesn't hold — those rows aren't
  // drivable — so it grants only the held keys and leaves the rest visibly locked.
  const toggleMaster = (rows, role) => {
    const turnOn = masterState(rows, role) !== 'on';
    drivable(rows, role).forEach((r) => setPerm(r, role, turnOn));
  };

  const resetDefaults = () => {
    permissions.forEach((p) => {
      const def = PERMISSIONS[p.id]?.defaultRoles;
      if (!def) return;
      // CS-331: a reset must never GRANT a key the caller doesn't hold. When they hold it,
      // reset to the default outright; otherwise keep only roles the default also carries — a
      // revoke-only reset that removes but never re-adds. (An owner holds everything: no-op.)
      let target = canGrant(p.id) ? [...def] : p.roles.filter((r) => def.includes(r));
      // CS-370: nor may a non-admin+ viewer's reset REDUCE the Admin role — keep 'admin' on any key
      // the admin column carries now (turning it off is admin+ by role, canEndAccess).
      if (!canReduceAdminRole && p.roles.includes('admin') && !target.includes('admin')) target = [...target, 'admin'];
      // CS-371: nor may a non-owner's reset REDUCE the Super Admin role — keep 'owner' on any non-core
      // key the owner column carries now (turning it off is Super-Admin-only, canReduceRole).
      if (!canReduceOwnerRole && p.roles.includes('owner') && !OWNER_CORE.has(p.id) && !target.includes('owner')) target = [...target, 'owner'];
      const sortedCur = [...p.roles].sort().join(',');
      const sortedTarget = [...target].sort().join(',');
      if (sortedCur !== sortedTarget) {
        dispatch({ type: ACTIONS.UPDATE_PERMISSION, id: p.id, patch: { roles: target } });
      }
    });
  };

  // Sections = grouped perm rows (ALWAYS_GRANTED filtered), plus any ungrouped keys.
  const groupedKeys = new Set(PERM_GROUPS.flatMap((g) => g.keys));
  const ungrouped = permissions.filter((p) => !groupedKeys.has(p.id) && !ALWAYS_GRANTED.has(p.id));
  const sections = PERM_GROUPS
    // Marketing is dormant (MARKETING_ENABLED, lib/features.js) — hide its permission
    // section from the editor while off. The marketing.* keys stay defined in roles.js.
    .filter((g) => MARKETING_ENABLED || g.id !== 'marketing')
    .map((g) => ({ id: g.id, label: g.label, rows: g.keys.map(byKey).filter(Boolean).filter((p) => !ALWAYS_GRANTED.has(p.id)) }))
    .filter((s) => s.rows.length > 0);
  if (ungrouped.length > 0) sections.push({ id: '__other', label: 'Other', rows: ungrouped });

  const setAll = (val) => {
    const next = {};
    sections.forEach((s) => { next[s.id] = val; });
    setOpen(next);
  };

  return (
    <div className="roles-page">
      <div className="section-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Roles &amp; Permissions</h1>
        </div>
        <button className="btn btn-secondary" onClick={resetDefaults}>Reset all to defaults</button>
      </div>

      {/* Legend — one black band, each role a name-above-description block (no overlap). */}
      <div className="rp-legend">
        {ROLES.map((r) => (
          <div key={r} className={`rp-legend-item${r === 'manager' ? ' is-new' : ''}`}>
            <div className="rp-legend-name">
              {ROLE_LABELS[r]}
              {r === 'manager' && <span className="rp-legend-tag">New</span>}
            </div>
            <div className="rp-legend-desc">{ROLE_DESCRIPTIONS[r]}</div>
          </div>
        ))}
      </div>

      <div className="rp-explainer">
        <div className="rp-explainer-text">
          <strong>How permissions resolve</strong>
          <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
            For each user we check, in order: <strong>per-user revoke</strong> → <strong>per-user grant</strong> → <strong>role default below</strong>.
            Flip a whole section per role with the master switch in its header, then open the section to fine-tune individual
            permissions. Edit per-user overrides from a member&rsquo;s page in <Link to="/settings/team" state={nav}>Team</Link>.
          </p>
          <p className="text-xs text-muted" style={{ margin: '8px 0 0' }}>
            My Day, Schedule, Messaging, and Settings → Account are always available to every role and aren&rsquo;t listed here.
          </p>
          {/* CS-331: you can only grant a permission you hold yourself. Owners hold everything. */}
          {currentUser?.role !== 'owner' && (
            <p className="text-xs text-muted" style={{ margin: '8px 0 0' }}>
              You can switch on only the permissions you have yourself; the rest are shown locked.
            </p>
          )}
          {/* CS-370: reducing the Admin role's access is admin+ by role; a manager/crew can't turn off admin-column keys. */}
          {!canReduceAdminRole && (
            <p className="text-xs text-muted" style={{ margin: '8px 0 0' }}>
              Only an Admin or Super Admin can reduce the Admin role&rsquo;s permissions.
            </p>
          )}
          {/* CS-371: reducing the Super Admin role's access is Super-Admin-only; a non-owner can't turn off owner-column keys. */}
          {!canReduceOwnerRole && (
            <p className="text-xs text-muted" style={{ margin: '8px 0 0' }}>
              Only a Super Admin can reduce the Super Admin role&rsquo;s permissions.
            </p>
          )}
        </div>
        <div className="rp-expand-controls">
          <button type="button" className="btn btn-outline" onClick={() => setAll(true)}>Expand all</button>
          <button type="button" className="btn btn-outline" onClick={() => setAll(false)}>Collapse all</button>
        </div>
      </div>

      {sections.map((sec) => {
        const isOpen = !!open[sec.id];
        return (
          <div key={sec.id} className={`rp-card${isOpen ? ' is-open' : ''}`}>
            <div className="rp-scroll">
              <div className="rp-grid">
                <div className="rp-row rp-row--head">
                  <button
                    type="button"
                    className="rp-title"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((o) => ({ ...o, [sec.id]: !o[sec.id] }))}
                  >
                    <span className="rp-caret" aria-hidden>▸</span>
                    <span className="rp-title-text">{sec.label}</span>
                  </button>
                  {ROLES.map((r) => (
                    <div key={r} className={`rp-cell rp-cell--master${r === 'manager' ? ' is-mgr' : ''}`}>
                      <span className="rp-master-label">{ROLE_LABELS[r]}</span>
                      <Toggle
                        state={masterState(sec.rows, r)}
                        onClick={() => toggleMaster(sec.rows, r)}
                        label={`All of ${sec.label} for ${ROLE_LABELS[r]}`}
                      />
                    </div>
                  ))}
                </div>

                {isOpen && sec.rows.map((p) => (
                  <div key={p.id} className="rp-row">
                    <div className="rp-perm-label">
                      <span>{p.label}</span>
                      {DANGER_KEYS.has(p.id) && <span className="perm-sensitive-pill">Sensitive</span>}
                      {p.schemaDefault && (
                        <span className="rp-perm-hint" title="This permission is new in the app and not yet saved in the matrix — the defaults shown apply. Per-user overrides on a member's page still work.">
                          Default (not yet saved)
                        </span>
                      )}
                    </div>
                    {ROLES.map((r) => (
                      <div key={r} className="rp-cell">
                        {locked(p, r) ? (
                          <span className="rp-locked"><Badge variant="slate">Super Admin only</Badge></span>
                        ) : (
                          <Toggle
                            state={p.roles.includes(r) ? 'on' : 'off'}
                            disabled={!!p.schemaDefault || grantLocked(p, r) || reduceLocked(p, r)}
                            onClick={() => togglePerm(p, r)}
                            label={`${p.label} for ${ROLE_LABELS[r]}`}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
