import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../../hooks/useFromHere';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import {
  selectUserById, selectPermissions, selectUserPermissionOverrides, selectCurrentUser,
} from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useSession } from '../../auth/AuthProvider';
import { useToast } from '../../components/Toast';
import DetailHeader from '../../components/DetailHeader';
import SectionTabs, { sectionElementId } from '../../components/SectionTabs';
import FormField from '../../components/FormField';
import Avatar from '../../components/Avatar';
import Badge from '../../components/Badge';
import ConfirmDialog from '../../components/ConfirmDialog';
import TimeOffCard from '../../components/TimeOffCard';
import Toggle from '../../components/Toggle';
import { ROLES, ROLE_LABELS, PERMISSIONS, ALWAYS_GRANTED, OWNER_ONLY, SUPERVISOR_ROLES, liveOverrideKeys, canGrantPermission, canEndAccess } from '../../lib/roles';
import { CLOCK_RULE_KEYS, CLOCK_RULE_LABELS, isClockRuleOff, nextClockRules } from '../../lib/clockRules';
import { memberDeleteBlock, payCutoffIso } from '../../lib/deleteCascade';
import { assignableRoles, teamLimit, teamLimitReason } from '../../lib/teamLimits';
import { deleteTeamLogin, sendTeamPasswordReset, applyLoginChanges } from '../../lib/teamApi';
import * as timeApi from '../../lib/timeApi';
import TimeClockHistory from '../../components/TimeClockHistory';
import EmployeeHrFieldsCard from '../../components/EmployeeHrFieldsCard';
import EmployeeDocumentsCard from '../../components/EmployeeDocumentsCard';
import SupervisedCustomersCard from '../../components/SupervisedCustomersCard';

export default function SettingsTeamDetail() {
  const { userId } = useParams();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const canEdit = usePermission('settings.team.edit');
  const canAssignRoles = usePermission('staff.assignRoles');
  const canEditOverrides = usePermission('staff.editOverrides');
  const canResetPassword = usePermission('staff.resetPassword');
  const canViewPay = usePermission('payroll.view');
  const canEditRates = usePermission('payroll.rates.edit');
  const canViewHr = usePermission('hr.view');
  const canEditOps = usePermission('ops.edit');
  // The two per-cleaner clock exemptions (step 4b, R6/R7). Their own key, because a client
  // may want the geofence and variance config (`time.config`) in more hands than the power
  // to exempt a named person from the clock-out block. The server keeps the field behind the
  // same key (api/_lib/orgStateGuard.js), so a viewer without it never sees the switches
  // rather than seeing a save the server drops.
  const canEditClockRules = usePermission('time.clockRules');
  const { configured: authConfigured } = useSession();

  const currentUser = selectCurrentUser(state);
  const nav = useFromHere();
  const user = selectUserById(state, userId);
  // Your OWN pay is a Super Admin's (owner/admin by role) — the server refuses it for
  // anyone else even with payroll.rates.edit (2026-09-23, owner's call), and a refused
  // save drops the whole pending batch (store/sync.js), so the card must not offer it.
  const ownRow = !!currentUser && user?.id === currentUser.id;
  const canEditThisPay = canEditRates && (!ownRow || currentUser?.role === 'owner' || currentUser?.role === 'admin');
  // Clock rules take an OFFICE role as well as the key, on EVERY row — the office sets them
  // "at Super Admin and Manager level" (the call, 2026-09-27) and R5 leaves the cleaner no
  // way around the block, so a per-user GRANT of `time.clockRules` to a cleaner does nothing
  // for this field: with a key alone, two granted cleaners could exempt each other. Same
  // shape as the pay rule above, and the same reason for mirroring the server: it refuses
  // the save (orgStateGuard mayWriteClockRules) and a refusal drops the whole pending batch.
  const canEditThisClockRules = canEditClockRules
    && (currentUser?.role === 'owner' || currentUser?.role === 'admin' || currentUser?.role === 'manager');
  const permissions = selectPermissions(state);
  const overrides = selectUserPermissionOverrides(state);
  // CS-331: on Access, the viewer may GRANT a member a permission (a grant, or removing a revoke
  // that would restore a role-default key) only for a key the viewer holds themselves
  // (canGrantPermission, the same rule orgStateGuard enforces on save). A Super Admin holds
  // everything. Turning a permission OFF for the member stays free.
  const canGrant = (key) => canGrantPermission(currentUser, key, permissions, overrides);
  // CS-369: reducing an Admin's effective permissions is admin+ by ROLE (canEndAccess — the same
  // floor as ending or re-roling an Admin, which orgStateGuard enforces on save). For a non-admin+
  // viewer of an Admin, any override toggle that would turn an EFFECTIVE permission OFF (add a
  // revoke, or clear a grant) is locked; granting stays CS-331's canGrant. A non-Admin target or an
  // admin+ viewer is unaffected (canEndAccess returns true unless the target is an Admin).
  const reduceAdminLocked = !canEndAccess(currentUser?.role, user?.role === 'admin');
  // The fields this viewer has edited, and only those: everything else reads the member as
  // stored NOW. A form that copied the whole member at mount went stale when someone else
  // changed them (a Super Admin promoted, demoted or disabled them), and Save then sent the
  // old values back: silently undoing that change or, for anyone but a Super Admin,
  // offering "Super Admin" and a save the server refuses, which drops every pending edit
  // (store/sync.js). The route remounts per member (KeyedByParam), so no other member's
  // edits carry over.
  const [edits, setEdits] = useState({});
  const edit = (fields) => setEdits((e) => ({ ...e, ...fields }));
  // The clock-rule switches are TWO controls writing ONE object, so the next value has to be
  // derived INSIDE the updater: computed from `current` outside it, two flips that land in
  // the same React batch both read the pre-flip value and the second silently undoes the
  // first (caught driving it — both switches off saved only the geofence one).
  const setClockRule = (key, off) => setEdits((e) => ({
    ...e,
    clockRules: nextClockRules('clockRules' in e ? e.clockRules : (user?.clockRules ?? null), key, off),
  }));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const override = useMemo(() => overrides.find((o) => o.userId === userId) || { userId, grants: [], revokes: [] }, [overrides, userId]);

  // Section tabs: the per-member record grew many sections (identity, pay, HR,
  // documents, time off, punches, permissions), so it is organized into tabs the
  // same way the Customers detail page is (SectionTabs + .detail-tabs). Tabs appear
  // only where the viewer can see that section; Profile is always present and is the
  // landing tab. Deep-linkable via ?tab=<key>, clamped to a visible tab so a stale
  // link never lands on a blank body.
  // Entries that can change what this member may do (an OWNER_ONLY entry on a non-owner
  // does nothing, so it doesn't count as custom access).
  const overrideCount = liveOverrideKeys(override.grants, user?.role).length + liveOverrideKeys(override.revokes, user?.role).length;
  const tabs = useMemo(() => {
    const t = [{ key: 'profile', label: 'Profile' }];
    if (canViewPay) t.push({ key: 'pay', label: 'Pay' });
    if (canViewHr) t.push({ key: 'hr', label: 'HR' });
    t.push({ key: 'time', label: 'Time' });
    if (canEditOverrides) t.push({ key: 'access', label: 'Access', count: overrideCount || undefined });
    return t;
  }, [canViewPay, canViewHr, canEditOverrides, overrideCount]);
  const tabKeys = tabs.map((t) => t.key);
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [activeKey, setActiveKey] = useState(tabKeys.includes(requestedTab) ? requestedTab : 'profile');
  const activeSection = tabKeys.includes(activeKey) ? activeKey : 'profile';

  // Clocked hours live in the time ledger, not the store, so DELETE_USER can't see them.
  // A punch since the previous pay period began may not be paid out yet, and a removed
  // member can't be paid (their pay rate goes with them), so the page asks before it
  // offers Remove. null = still checking · true/false = the answer · 'error'.
  const cadence = state.opsSettings?.payPeriodCadence;
  const checkRecentHours = useCallback(async () => {
    const fromIso = payCutoffIso({ opsSettings: { payPeriodCadence: cadence } });
    const { entries } = await timeApi.entries({ fromIso, userIds: [userId], limit: 1 });
    return entries.length > 0;
  }, [userId, cadence]);
  const [recentHours, setRecentHours] = useState(null);
  useEffect(() => {
    let alive = true;
    setRecentHours(null);
    checkRecentHours()
      .then((has) => { if (alive) setRecentHours(has); })
      .catch(() => { if (alive) setRecentHours('error'); });
    return () => { alive = false; };
  }, [checkRecentHours]);

  if (!user) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo="/settings/team" title="Team member not found" />
      </div>
    );
  }
  const current = { ...user, ...edits };
  // The owner's limits, which the server holds on every save (lib/teamLimits.js): only a
  // Super Admin acts on a Super Admin; nobody changes their own role (a Super Admin
  // neither), and only a Super Admin edits their own overrides; a role is offered only if
  // the viewer may give it (lib/roles canGiveRole, on the matrix + their overrides). A
  // refused save drops every pending edit with it, so a control the limits block is
  // disabled here with its reason in visible text (no tooltips on touch).
  const roleLimit = teamLimit(currentUser, user, 'role');
  const statusLimit = teamLimit(currentUser, user, 'status');
  const overrideLimit = teamLimit(currentUser, user, 'overrides');
  const assignable = assignableRoles(currentUser, permissions, overrides);
  // A locked field shows the member as stored, never an edit made before the lock applied.
  const roleValue = roleLimit ? user.role : current.role;
  const statusValue = statusLimit ? user.status : current.status;
  // Reset scope: a Super Admin can reset anyone; an Admin (with staff.resetPassword)
  // can reset anyone EXCEPT a Super Admin. Crew never reach this page.
  const canResetThisUser = canResetPassword && (currentUser?.role === 'owner' || user.role !== 'owner');
  // Why this member can't be removed right now: the last owner (DEL-05), yourself, or pay
  // that may not be paid out yet — salary, a pay line or pending reimbursement, or
  // clocked hours (deletion audit DR-18/19 + the pay-run follow-up; DELETE_USER refuses
  // all but hours itself, so this must stop the flow before the login is deleted). One
  // shared decision. The way out for a leaver is Disabled: it ends their access now and
  // keeps them on the pay run for what they earned.
  const first = user.name.split(' ')[0];
  const nextStep = user.status === 'disabled'
    ? 'They stay on the pay run while disabled; remove them after their last pay goes out.'
    : 'Set them to Disabled to end their access now (they stay on the pay run), and remove them after their last pay goes out.';
  const blockReason = (code) => {
    if (code === 'super-admin') return teamLimitReason('remove', code);
    if (code === 'admin-remove') return teamLimitReason('remove', code); // CS-329: only admin+ ends an Admin's access
    if (code === 'last-owner') return "The last Super Admin can't be removed. Make another member a Super Admin first.";
    if (code === 'self') return "You can't remove your own account. Ask another admin to do it.";
    if (code === 'unpaid-salary') return `${first} is on salary, so they may still be owed pay for this or the last pay period. ${nextStep}`;
    if (code === 'unsettled-pay') return `${first} may still be owed pay: a pay line in this or the last pay period, or a reimbursement waiting for a decision in HR. ${nextStep}`;
    if (code === 'unpaid-hours') return `${first} has clocked hours in this or the last pay period that may not be paid yet. ${nextStep}`;
    return null;
  };
  // The owner's limit comes first: for anyone but a Super Admin, "only a Super Admin can
  // remove a Super Admin" is the whole answer, and the last-owner advice isn't theirs to take.
  const deleteBlock = teamLimit(currentUser, user, 'remove')
    || memberDeleteBlock(state, user.id, currentUser?.id, undefined, { recentHours: recentHours === true });
  const deleteBlockedReason = blockReason(deleteBlock);

  const save = async () => {
    // In authed mode the email is the Supabase login identity (app maps
    // session→member by email), so it can't be edited here without locking the
    // member out. Role/status stay store-side (status note: see audit — disabling
    // here does not yet revoke the Supabase login; that's the team↔auth wiring).
    // Only what this viewer edited (see `edits`). Role and status also only where the
    // limits allow this viewer (read from the member as stored now): an edit made before a
    // Super Admin changed this member doesn't go out.
    const patch = {};
    if ('name' in edits) patch.name = current.name;
    if ('phone' in edits) patch.phone = current.phone;
    if ('initials' in edits) patch.initials = (current.initials || '').toUpperCase().slice(0, 3);
    if ('role' in edits && !roleLimit) patch.role = current.role;
    if ('status' in edits && !statusLimit) patch.status = current.status;
    if (!authConfigured && 'email' in edits) patch.email = current.email;
    // Pay rates are owner-only compensation data — thread them through the SAME
    // save (whitelist landmine: a new field silently never persists otherwise).
    if (canEditThisPay && 'pay' in edits) patch.pay = current.pay;
    // The per-cleaner clock exemptions (step 4b). Same whitelist landmine; `null` when
    // nothing is off, so the field stays sparse (lib/clockRules nextClockRules).
    if (canEditThisClockRules && 'clockRules' in edits) patch.clockRules = current.clockRules;
    // A status or role change in authed mode must hit the real login FIRST: disabling
    // bans the Supabase account (no new sign-in / token refresh), enabling unbans, and a
    // role change re-stamps the JWT claim the server trusts. Both land before the store
    // dispatch, and a failure changes nothing: applyLoginChanges (lib/teamApi) does the
    // status, then the role, and undoes the status if the role is refused (the order whose
    // undo is always allowed; see its comment). Only what the patch changes goes out.
    if (authConfigured) {
      const failed = await applyLoginChanges({
        email: user.email,
        orgUserId: user.id,
        role: { from: user.role, to: 'role' in patch ? patch.role : user.role },
        status: { from: user.status, to: 'status' in patch ? patch.status : user.status },
      });
      if (failed) {
        const msg = failed.error?.message || 'failed.';
        toast.error(failed.step === 'role' ? `Couldn't update access level: ${msg}` : `Couldn't update login access: ${msg}`);
        return;
      }
    }
    dispatch({ type: ACTIONS.UPDATE_USER, id: user.id, patch });
    setEdits({});
    toast.success('Member saved');
  };

  const del = async () => {
    // Backstop for the disabled control: the owner's limit, then the same decision with a
    // FRESH read of the time ledger (a punch may have landed since the page loaded). If the
    // ledger can't be read, don't remove — unpaid hours would be lost with the member.
    const limit = teamLimit(currentUser, user, 'remove');
    if (limit) { toast.error(blockReason(limit)); setConfirmDelete(false); return; }
    let hours;
    try {
      hours = await checkRecentHours();
    } catch {
      toast.error(`Couldn't check ${first}'s recent hours, so they weren't removed. Try again.`);
      setConfirmDelete(false);
      return;
    }
    const block = memberDeleteBlock(state, user.id, currentUser?.id, undefined, { recentHours: hours });
    if (block) { setRecentHours(hours); toast.error(blockReason(block)); setConfirmDelete(false); return; }
    // Offboarding must revoke the actual login, not just the store record.
    if (authConfigured) {
      try {
        await deleteTeamLogin(user.email);
      } catch (err) {
        toast.error(`Couldn't remove login: ${err.message || 'failed.'}`);
        return;
      }
    }
    dispatch({ type: ACTIONS.DELETE_USER, id: user.id });
    toast.success(`${user.name} removed`);
    navigate('/settings/team', { state: nav });
  };

  const sendReset = async () => {
    setResetBusy(true);
    try {
      const res = await sendTeamPasswordReset(user.email);
      if (res?.missing) {
        toast.error(`${user.name.split(' ')[0]} doesn't have a login yet. Create one before sending a reset.`);
      } else {
        toast.success(`Reset link sent to ${user.email}.`);
      }
    } catch (err) {
      toast.error(err.message || 'Could not send the reset link.');
    } finally {
      setResetBusy(false);
    }
  };

  const togglePermOverride = (permKey) => {
    if (!canEditOverrides || overrideLimit) return;
    if (ALWAYS_GRANTED.has(permKey)) return; // universal surfaces aren't revocable
    if (OWNER_ONLY.has(permKey) && user.role !== 'owner') {
      // Super Admin only, whatever a grant says: nothing can be granted or revoked here,
      // but an entry left from before S79 (it has no effect) can still be cleared, without
      // resetting the member's other overrides.
      const keep = (list) => (list || []).filter((k) => k !== permKey);
      if (keep(override.grants).length === (override.grants || []).length
        && keep(override.revokes).length === (override.revokes || []).length) return;
      dispatch({ type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: user.id, grants: keep(override.grants), revokes: keep(override.revokes) });
      return;
    }
    const perm = permissions.find((p) => p.id === permKey);
    // Same fallback can() uses: a key the schema knows but the saved matrix doesn't
    // yet (added in code, no data-op run) resolves to its schema default. Without
    // this the card read "Blocked" for a surface the admin was actively using and
    // could only ever Grant, never Revoke.
    const roleHas = perm ? perm.roles.includes(user.role) : (PERMISSIONS[permKey]?.defaultRoles || []).includes(user.role);
    let grants = [...(override.grants || [])];
    let revokes = [...(override.revokes || [])];
    if (roleHas) {
      // Currently allowed by role — toggle means "revoke"
      if (revokes.includes(permKey)) {
        // Clearing the revoke RESTORES the role default — a grant, so only if the viewer holds
        // the key (CS-331).
        if (!canGrant(permKey)) return;
        revokes = revokes.filter((k) => k !== permKey);
      } else {
        // Adding a revoke turns an effective permission OFF — a reduction. Free on most members,
        // but reducing an Admin's access is admin+ by role (CS-369).
        if (reduceAdminLocked) return;
        revokes.push(permKey);
        grants = grants.filter((k) => k !== permKey);
      }
    } else {
      // Not in role defaults — toggle means "grant"
      if (grants.includes(permKey)) {
        // Clearing a grant turns an effective permission OFF — a reduction (CS-369, as above).
        if (reduceAdminLocked) return;
        grants = grants.filter((k) => k !== permKey);
      } else {
        // A grant — only if the viewer holds the key (CS-331).
        if (!canGrant(permKey)) return;
        grants.push(permKey);
        revokes = revokes.filter((k) => k !== permKey);
      }
    }
    dispatch({ type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: user.id, grants, revokes });
  };

  const clearOverrides = () => {
    if (!canEditOverrides || overrideLimit) return;
    dispatch({ type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: user.id, grants: [], revokes: [] });
  };

  const hasOverrides = overrideCount > 0;

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

      <div className="detail-tabs">
        <SectionTabs sections={tabs} activeKey={activeSection} onSelect={setActiveKey} />
        <div className="detail-tabs-body">

        <section id={sectionElementId('profile')} className="detail-section" hidden={activeSection !== 'profile'}>
          <div className="card detail-card">
            <div className="flex-row" style={{ gap: 16, alignItems: 'center', marginBottom: 20 }}>
              <Avatar initials={user.initials} variant={user.avatar} size="lg" />
              <div>
                <div className="text-sm font-semi">
                  {ROLE_LABELS[user.role]}
                  {hasOverrides && <span className="tier-badge" style={{ marginLeft: 8 }}>Custom access</span>}
                </div>
              </div>
            </div>
            <div className="form-row">
              <FormField label="Name" required value={current.name || ''} onChange={(e) => edit({ name: e.target.value })} disabled={!canEdit} />
              <FormField label="Initials" value={current.initials || ''} onChange={(e) => edit({ initials: e.target.value })} disabled={!canEdit} />
            </div>
            <div className="form-row">
              <FormField label="Email" type="email" value={current.email || ''} onChange={(e) => edit({ email: e.target.value })} disabled={!canEdit || authConfigured} help={authConfigured ? 'Login email. Set in the auth system; cannot be changed here.' : undefined} />
              <FormField label="Phone" value={current.phone || ''} onChange={(e) => edit({ phone: e.target.value })} disabled={!canEdit} />
            </div>
            <div className="form-row">
              {/* Offers only the roles you may give (never Super Admin unless you are one).
                  The member's current role stays listed so a locked field still reads it. */}
              <FormField
                label="Role"
                as="select"
                value={roleValue}
                onChange={(e) => edit({ role: e.target.value })}
                disabled={!canAssignRoles || !!roleLimit}
                help={!canAssignRoles ? "You don't have permission to assign roles." : teamLimitReason('role', roleLimit) || undefined}
                options={ROLES.filter((r) => r === roleValue || assignable.includes(r)).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
              />
              <FormField label="Status" as="select" value={statusValue} onChange={(e) => edit({ status: e.target.value })} disabled={!canEdit || !!statusLimit}
                help={canEdit ? teamLimitReason('status', statusLimit) || undefined : undefined}
                options={[{ value: 'active', label: 'Active' }, { value: 'invited', label: 'Invited' }, { value: 'disabled', label: 'Disabled' }]} />
            </div>
            {authConfigured && canResetThisUser && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-light)' }}>
                <div className="text-xs text-muted" style={{ flex: 1, minWidth: 220 }}>
                  Email {user.name.split(' ')[0]} a secure link to set a new password. It goes to <strong>{user.email}</strong>, and you never see or set it.
                </div>
                <button type="button" className="btn btn-outline" onClick={sendReset} disabled={resetBusy} style={{ flexShrink: 0 }}>
                  {resetBusy ? 'Sending…' : 'Email password-reset link'}
                </button>
              </div>
            )}
            {/* Touch devices (the installed iOS app) never show a disabled button's
                tooltip, so a blocked Remove explains itself in text. Not for "yourself":
                that reason is self-evident and would sit on your own profile forever. */}
            {canEdit && deleteBlockedReason && deleteBlock !== 'self' && (
              <p className="text-xs text-muted member-remove-note">{deleteBlockedReason}</p>
            )}
            {canEdit && (
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!!deleteBlockedReason}
                  title={deleteBlockedReason || undefined}
                  onClick={() => setConfirmDelete(true)}
                >
                  Remove
                </button>
                <button type="button" className="btn btn-primary" onClick={save}>Save</button>
              </div>
            )}
          </div>

          {/* Account supervisor coverage — only supervisor-eligible members (owner/admin/
              manager) can hold accounts; crew never can (SUPERVISOR_ROLES). Editing is
              `ops.edit`; the same client.supervisorId write ServiceSetupCard uses. */}
          {SUPERVISOR_ROLES.includes(user.role) && (
            <SupervisedCustomersCard user={user} canEdit={canEditOps} currentUser={currentUser} />
          )}
        </section>

        {canViewPay && (
        <section id={sectionElementId('pay')} className="detail-section" hidden={activeSection !== 'pay'}>
          {(() => {
            const pay = current.pay || { type: '' };
            const setPay = (next) => edit({ pay: { ...(current.pay || {}), ...next } });
            return (
              <div className="card detail-card">
                <h3 className="dash-card-title">Employment &amp; pay</h3>
                <p className="text-xs text-muted" style={{ marginTop: -4, marginBottom: 12 }}>
                  How {user.name.split(' ')[0]} is paid. Feeds the Payroll run (hours × rate → gross). {!canEditThisPay && (canEditRates ? 'Only a Super Admin can change your own pay.' : 'Only a Super Admin can change pay rates.')}
                </p>
                <div className="form-row">
                  <FormField
                    label="Pay type" as="select" value={pay.type || ''} disabled={!canEditThisPay}
                    onChange={(e) => setPay({ type: e.target.value })}
                    options={[
                      { value: '', label: '— Select pay type —' },
                      { value: 'hourly', label: 'Hourly' },
                      { value: 'salary', label: 'Salary (per pay period)' },
                      { value: 'per_visit', label: 'Per-visit (flat rate per clean)' },
                      { value: 'none', label: 'Not on payroll' },
                    ]}
                  />
                  {pay.type === 'hourly' && <FormField label="Hourly rate ($/hr)" type="number" min="0" step="0.01" value={pay.hourlyRate ?? ''} disabled={!canEditThisPay} onChange={(e) => setPay({ hourlyRate: Number(e.target.value) || 0 })} />}
                  {pay.type === 'salary' && <FormField label="Salary ($/pay period)" type="number" min="0" step="0.01" value={pay.salaryPerPeriod ?? ''} disabled={!canEditThisPay} onChange={(e) => setPay({ salaryPerPeriod: Number(e.target.value) || 0 })} />}
                  {pay.type === 'per_visit' && <FormField label="Rate per clean ($)" type="number" min="0" step="0.01" value={pay.perVisitRate ?? ''} disabled={!canEditThisPay} onChange={(e) => setPay({ perVisitRate: Number(e.target.value) || 0 })} />}
                </div>
                {pay.type === 'salary' && (
                  <label className="pay-check" style={{ marginTop: 4 }}>
                    <input type="checkbox" checked={!!pay.otExempt} disabled={!canEditThisPay} onChange={(e) => setPay({ otExempt: e.target.checked })} /> Overtime exempt (salaried — accrues no OT premium)
                  </label>
                )}
                {canEditThisPay && (
                  <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={save}>Save pay</button></div>
                )}
              </div>
            );
          })()}
        </section>
        )}

        {canViewHr && (
        <section id={sectionElementId('hr')} className="detail-section" hidden={activeSection !== 'hr'}>
          <EmployeeHrFieldsCard user={user} />
          <EmployeeDocumentsCard user={user} currentUserId={currentUser && currentUser.id} />
        </section>
        )}

        <section id={sectionElementId('time')} className="detail-section" hidden={activeSection !== 'time'}>
          <TimeOffCard userId={user.id} userName={user.name} />
          {/* Per-cleaner clock rules (step 4b, R6/R7). Both switches read ON = the normal
              rule applies, so the label states the RULE, not the exception, and turning one
              off is the deliberate act. Shown only to a `time.clockRules` holder — the
              server refuses the field from anyone else, and a refused save drops the whole
              pending batch (store/sync.js), so a control nobody can save must not exist.
              The office is the only way out of the block for a stuck cleaner, so the card
              says what each switch costs. */}
          {canEditThisClockRules && (
            <div className="card detail-card">
              <h3 className="dash-card-title">Clock rules</h3>
              <p className="text-xs text-muted" style={{ marginBottom: 'var(--space-3)' }}>
                Exceptions for {user.name.split(' ')[0]} only. Leave both on unless they can’t use the app yet.
              </p>
              {[CLOCK_RULE_KEYS.checklist, CLOCK_RULE_KEYS.geofence].map((key) => {
                const off = isClockRuleOff(current, key);
                return (
                  <div key={key} className="pref-row">
                    <div className="pref-row-text">
                      <div className="pref-row-label">{CLOCK_RULE_LABELS[key]}</div>
                      <div className="pref-row-desc">
                        {key === CLOCK_RULE_KEYS.checklist
                          ? (off
                            ? 'Off. They can clock out with the checklist unfinished. It’s still offered.'
                            : 'On. They can’t clock out of a clean until every checklist item is ticked.')
                          : (off
                            ? 'Off. They can clock in from anywhere. The punch still records the distance.'
                            : 'On. Clocking in away from the location asks them to confirm, and flags it.')}
                      </div>
                    </div>
                    <Toggle on={!off} onChange={(on) => setClockRule(key, !on)} />
                  </div>
                );
              })}
              <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={save}>Save clock rules</button></div>
            </div>
          )}
          {/* This person's clock-ins/outs — where the office looks first when "did
              they clock in last night?" comes up. Manager-only (self-gated). */}
          <TimeClockHistory userIds={[user.id]} title={`Time clock · ${user.name}`} hide={['cleaner']} defaultPeriod="30d" />
        </section>

        {canEditOverrides && (
        <section id={sectionElementId('access')} className="detail-section" hidden={activeSection !== 'access'}>
          <div className="section-head">
            <div>
              <h3>Permission overrides</h3>
              {/* Your own row, or a Super Admin's when you aren't one: read-only, and it says why. */}
              <p className="text-muted text-sm">
                {overrideLimit
                  ? teamLimitReason('overrides', overrideLimit)
                  : <>Grant or revoke specific permissions just for {user.name.split(' ')[0]}. Overrides take precedence over role defaults.{currentUser?.role !== 'owner' && ' You can only grant permissions you have yourself.'}{reduceAdminLocked && " Only an Admin or Super Admin can reduce an Admin's access."}</>}
              </p>
            </div>
            {hasOverrides && !overrideLimit && <button className="btn btn-outline" onClick={clearOverrides}>Reset to role defaults</button>}
          </div>
          <div className="table-wrap matrix-cards">
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
                  if (ALWAYS_GRANTED.has(key)) return null; // universal — not overridable
                  const perm = permissions.find((p) => p.id === key);
                  // Schema-default fallback — see togglePermOverride.
                  const roleHas = perm ? perm.roles.includes(user.role) : (PERMISSIONS[key]?.defaultRoles || []).includes(user.role);
                  const granted = override.grants?.includes(key);
                  const revoked = override.revokes?.includes(key);
                  // A Super-Admin-only key (OWNER_ONLY) can't apply to anyone else: no
                  // role default, no override, never effective, as can() resolves it.
                  const ownerOnly = OWNER_ONLY.has(key) && user.role !== 'owner';
                  const effective = !ownerOnly && ((roleHas && !revoked) || granted);
                  const overrideLabel = granted ? 'Granted' : revoked ? 'Revoked' : '—';
                  const overrideClass = granted ? 'badge green' : revoked ? 'badge red' : 'badge slate';
                  // CS-331: this row's toggle would GRANT (make the key newly effective) when it
                  // clears a revoke that restores a role-default key, or grants a key the role
                  // lacks. If the viewer can't grant that key, the row is locked; a revoke
                  // (turning access OFF) is never locked. OWNER_ONLY rows keep their own lock.
                  const grantLocked = !ownerOnly && (revoked || (!roleHas && !granted)) && !canGrant(key);
                  // CS-369: this row is currently EFFECTIVE, so its toggle would turn a permission
                  // OFF (add a revoke, or clear a grant) — a reduction. Reducing an Admin's access is
                  // admin+ by role, so it is locked for a non-admin+ viewer of an Admin.
                  const reduceLocked = !ownerOnly && effective && reduceAdminLocked;
                  // Read-only: the whole tab when the limits apply, a Super-Admin-only row with
                  // nothing to clear (an old entry there stays clickable), a grant-locked row (CS-331),
                  // or a reduction of an Admin's access (CS-369).
                  const overrideLocked = !!overrideLimit || (ownerOnly && !granted && !revoked) || grantLocked || reduceLocked;
                  return (
                    <tr key={key}>
                      <td>
                        <div className="text-sm font-semi">{PERMISSIONS[key].label}</div>
                        <div className="text-xs text-muted">{key}</div>
                      </td>
                      <td data-label="Role default" style={{ textAlign: 'center' }}>
                        {ownerOnly ? <Badge variant="slate">Super Admin only</Badge>
                          : roleHas ? <Badge variant="green">Yes</Badge> : <Badge variant="slate">No</Badge>}
                      </td>
                      <td data-label="Override" style={{ textAlign: 'center' }}>
                        {overrideLocked ? (
                          <Badge variant={granted ? 'green' : revoked ? 'red' : 'slate'}>{overrideLabel}</Badge>
                        ) : (
                          <button
                            type="button"
                            className={overrideClass}
                            style={{ minWidth: 90, cursor: 'pointer', border: 'none' }}
                            onClick={() => togglePermOverride(key)}
                            title={`Click to ${granted ? 'clear grant' : revoked ? 'clear revoke' : roleHas ? 'revoke for this user' : 'grant to this user'}`}
                          >
                            {overrideLabel}
                          </button>
                        )}
                      </td>
                      <td data-label="Effective" style={{ textAlign: 'center' }}>
                        {effective ? <Badge variant="green">Allowed</Badge> : <Badge variant="slate">Blocked</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        )}

        </div>
      </div>

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
