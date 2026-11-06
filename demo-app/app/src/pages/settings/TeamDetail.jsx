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
import AvatarPhotoControl from '../../components/AvatarPhotoControl';
import Badge from '../../components/Badge';
import ConfirmDialog from '../../components/ConfirmDialog';
import TimeOffCard from '../../components/TimeOffCard';
import Toggle from '../../components/Toggle';
import { PERMISSIONS, ALWAYS_GRANTED, OWNER_ONLY, SUPERVISOR_ROLES, liveOverrideKeys, canGrantPermission, canEndAccess, can, columnHolds, overrideForEffective, isOfficeRole, memberRoleLabel } from '../../lib/roles';
import { CLOCK_RULE_KEYS, CLOCK_RULE_LABELS, isClockRuleOff, nextClockRules } from '../../lib/clockRules';
import { memberDeleteBlock, payCutoffIso } from '../../lib/deleteCascade';
import { roleChoices, choiceOf, choiceRole, mayAssignTeams, teamLimit, teamLimitReason, ROLE_CHOICES as ROLE_CHOICE_LIST } from '../../lib/teamLimits';
import { isOpsManager, isAccountManager, managerLevelOf } from '../../lib/teamScope';
import { deleteTeamLogin, sendTeamPasswordReset, applyLoginChanges, listTeamSignIns } from '../../lib/teamApi';
import { LINK_WITHHELD } from '../../lib/signInLink';
import { SignInLinkModal } from '../../components/SignInLinkPanel';
import { useT } from '../../i18n/react';
import * as timeApi from '../../lib/timeApi';
import TimeClockHistory from '../../components/TimeClockHistory';
import EmployeeHrFieldsCard from '../../components/EmployeeHrFieldsCard';
import EmployeeDocumentsCard from '../../components/EmployeeDocumentsCard';
import EmployeeWarningsCard from '../../components/EmployeeWarningsCard';
import EmployeeIncidentsCard from '../../components/EmployeeIncidentsCard';
import EmployeeTerminationCard from '../../components/EmployeeTerminationCard';
import SupervisedCustomersCard from '../../components/SupervisedCustomersCard';
import AccountManagerAssignmentCard, { OpsManagerLine } from '../../components/AccountManagerAssignmentCard';
import BuildingRatesEditor from './BuildingRatesEditor';
import { PAY_TYPES, payTypeOf } from '../../lib/payTypes';
import BuildingMultiPicker from '../../components/BuildingMultiPicker';
import { worksAtOf, worksAtClients } from '../../lib/worksAt';
import { isActiveBuilding } from '../../lib/customerStatus';
import { customerLabel } from '../../lib/customerNumber';

// The cleaner's "Can request supplies" switch (the Cleaner Hub, D4): the member's permission override
// for this key, the same data the Access tab edits.
const SUPPLY_REQUEST_KEY = 'supplies.request';

export default function SettingsTeamDetail() {
  const { userId } = useParams();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const t = useT();
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
    && isOfficeRole(currentUser?.role);
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
  // CS-661: a reset the app couldn't email hands the caller the one-time link ({ link, why }) to
  // send themselves. Component state only — never stored, gone when the dialog closes.
  const [handedLink, setHandedLink] = useState(null);
  // Whether this member's login has never signed in ('never') or doesn't exist ('none'): the
  // header then says so instead of a bare Active (CS-661). Same reach as the orphan list.
  const [signIn, setSignIn] = useState(null);

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
  // PAY-19: the cutoff follows the org's workweek START as well as its cadence, so this check
  // and the pay run agree on where "the previous period" begins. Passing a cadence-only
  // stand-in silently used Sunday whatever the org had set.
  const payWeekStartDay = state.opsSettings?.payWeekStartDay;
  const checkRecentHours = useCallback(async () => {
    const fromIso = payCutoffIso({ opsSettings: { payPeriodCadence: cadence, payWeekStartDay } });
    const { entries } = await timeApi.entries({ fromIso, userIds: [userId], limit: 1 });
    return entries.length > 0;
  }, [userId, cadence, payWeekStartDay]);
  const [recentHours, setRecentHours] = useState(null);
  useEffect(() => {
    let alive = true;
    setRecentHours(null);
    checkRecentHours()
      .then((has) => { if (alive) setRecentHours(has); })
      .catch(() => { if (alive) setRecentHours('error'); });
    return () => { alive = false; };
  }, [checkRecentHours]);
  const memberEmail = (user?.email || '').trim().toLowerCase();
  useEffect(() => {
    if (!authConfigured || !canEdit || !memberEmail) { setSignIn(null); return undefined; }
    let alive = true;
    listTeamSignIns()
      .then((r) => {
        if (!alive) return;
        setSignIn((r?.neverSignedIn || []).includes(memberEmail) ? 'never' : (r?.noLogin || []).includes(memberEmail) ? 'none' : null);
      })
      .catch(() => { if (alive) setSignIn(null); });
    return () => { alive = false; };
  }, [authConfigured, canEdit, memberEmail]);

  if (!user) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo="/settings/team" title="Team member not found" />
      </div>
    );
  }
  const current = { ...user, ...edits };
  // The Works at picker's customers (crew only): the buildings cleaned now, plus any already
  // linked, so a link to a customer that has since gone inactive can still be unticked.
  const linkedIds = current.role === 'crew' ? worksAtOf(current) : [];
  const worksAtOptions = current.role === 'crew'
    ? (state.clients || []).filter((c) => isActiveBuilding(c) || linkedIds.includes(c.id))
      .map((c) => ({ value: c.id, label: customerLabel(c) }))
      .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  // The owner's limits, which the server holds on every save (lib/teamLimits.js): only a
  // Super Admin acts on a Super Admin; nobody changes their own role (a Super Admin
  // neither), and only a Super Admin edits their own overrides; a role is offered only if
  // the viewer may give it (lib/roles canGiveRole, on the matrix + their overrides). A
  // refused save drops every pending edit with it, so a control the limits block is
  // disabled here with its reason in visible text (no tooltips on touch).
  const roleLimit = teamLimit(currentUser, user, 'role');
  const statusLimit = teamLimit(currentUser, user, 'status');
  const overrideLimit = teamLimit(currentUser, user, 'overrides');
  // The role picker's choices for THIS member (lib/teamLimits roleChoices): the roles this viewer
  // may give, the Manager role as its two levels (Account / Operations Manager, S131), and a choice
  // that changes the member's LEVEL only for someone who may give it — owner / admin with ops.edit,
  // holding everything that level's permission column carries (mayGiveLevel; the guard's rule,
  // CS-858). Assigning account managers to an OM stays mayAssignTeams.
  const canAssignTeams = mayAssignTeams(currentUser, permissions, overrides);
  const choices = roleChoices(currentUser, permissions, overrides, user);
  // A locked field shows the member as stored, never an edit made before the lock applied.
  const roleValue = choiceOf(roleLimit ? user : current);
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
    if ('role' in edits && !roleLimit) {
      patch.role = current.role;
      // A manager's level rides with the role pick (Account / Operations Manager, S131); off the
      // Manager role the reducer drops the level (lib/teamScope teamCascade).
      if (current.role === 'manager') patch.managerLevel = managerLevelOf(current) === 'operations' ? 'operations' : 'account';
    }
    if ('status' in edits && !statusLimit) patch.status = current.status;
    if (!authConfigured && 'email' in edits) patch.email = current.email;
    // Pay rates are owner-only compensation data — thread them through the SAME
    // save (whitelist landmine: a new field silently never persists otherwise).
    if (canEditThisPay && 'pay' in edits) patch.pay = current.pay;
    // The per-cleaner clock exemptions (step 4b). Same whitelist landmine; `null` when
    // nothing is off, so the field stays sparse (lib/clockRules nextClockRules).
    if (canEditThisClockRules && 'clockRules' in edits) patch.clockRules = current.clockRules;
    // The customers a cleaner works at (lib/worksAt; the Team import sets it too). Same whitelist
    // landmine; none = [] and the store drops the field.
    if (canEdit && 'worksAt' in edits) patch.worksAt = worksAtOf(current);
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

  // Emailed when a sending mailbox is connected; otherwise (CS-661) the caller is handed the
  // one-time link to send — or told why not ('link-withheld': the member holds permissions the
  // caller doesn't, and the link signs in as them).
  const sendReset = async () => {
    setResetBusy(true);
    try {
      const res = await sendTeamPasswordReset(user.email);
      if (res?.missing) toast.error(t('signInLink.noLogin', { name: first }));
      else if (res?.emailed === false && res.link) setHandedLink({ link: res.link, why: res.why });
      else toast.success(t('signInLink.resetEmailed', { email: user.email }));
    } catch (err) {
      toast.error(err?.code === LINK_WITHHELD ? t('signInLink.withheld', { name: first }) : (err?.message || t('signInLink.resetFailed')));
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
    // The member's COLUMN (lib/roles columnHolds — an Operations Manager's own, CS-858), with the
    // same fallback can() uses: a key the schema knows but the saved matrix doesn't yet (added in
    // code, no data-op run) resolves to its schema default. Without it the card read "Blocked" for
    // a surface the admin was actively using and could only ever Grant, never Revoke.
    const roleHas = columnHolds(user, permKey, permissions);
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

  // ── "Can request supplies" (the Cleaner Hub, D4, 2026-10-13; Matt: "I need this option to be turned
  // on or off … We can remove their access") — a cleaner's Request Supplies page, switched per person.
  // ONE rule writes it (lib/roles overrideForEffective: a revoke when off, cleared when back on — a
  // grant where the stored matrix lacks crew), saved as you go through the Access tab's own action,
  // behind the Access tab's own guards: staff.editOverrides, the owner's limits (teamLimit), and
  // turning it ON only when the viewer holds the key (canGrantPermission, CS-331; orgStateGuard holds
  // the same on save). For every cleaner at once: Settings → Roles → Crew → Request supplies.
  const supplyRoleHas = columnHolds(user, SUPPLY_REQUEST_KEY, permissions);
  const supplyRequestsOn = can(user, SUPPLY_REQUEST_KEY, permissions, overrides);
  const supplySwitchReason = !canEditOverrides ? "You don't have permission to change a member's access."
    : overrideLimit ? teamLimitReason('overrides', overrideLimit)
      : (!supplyRequestsOn && !canGrant(SUPPLY_REQUEST_KEY)) ? 'You can only turn on permissions you have yourself.'
        : null;
  const setSupplyRequests = (on) => {
    if (!canEditOverrides || overrideLimit) return;
    if (on && !canGrant(SUPPLY_REQUEST_KEY)) return;
    const next = overrideForEffective({ grants: override.grants, revokes: override.revokes, key: SUPPLY_REQUEST_KEY, roleHas: supplyRoleHas, on });
    dispatch({ type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: user.id, ...next });
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
        badge={user.status === 'active' && signIn
          ? <Badge variant={signIn === 'never' ? 'amber' : 'slate'}>{t(signIn === 'never' ? 'teamSignIns.never' : 'teamSignIns.noLogin')}</Badge>
          : <Badge variant={user.status === 'active' ? 'green' : user.status === 'invited' ? 'amber' : 'slate'}>
            {user.status.charAt(0).toUpperCase() + user.status.slice(1)}
          </Badge>}
      />

      <div className="detail-tabs">
        <SectionTabs sections={tabs} activeKey={activeSection} onSelect={setActiveKey} />
        <div className="detail-tabs-body">

        <section id={sectionElementId('profile')} className="detail-section" hidden={activeSection !== 'profile'}>
          <div className="card detail-card">
            {/* The member's photo (UI_RULES §141): the office sets anyone's with the Team key, and
                everyone sets their own — the upload route's own rule. */}
            <AvatarPhotoControl user={user} canEdit={canEdit || ownRow} self={ownRow}>
              <div className="text-sm font-semi">
                {memberRoleLabel(t, user)}
                {hasOverrides && <span className="tier-badge" style={{ marginLeft: 8 }}>Custom access</span>}
              </div>
            </AvatarPhotoControl>
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
                onChange={(e) => edit(choiceRole(e.target.value))}
                disabled={!canAssignRoles || !!roleLimit}
                help={!canAssignRoles ? "You don't have permission to assign roles." : teamLimitReason('role', roleLimit) || undefined}
                options={ROLE_CHOICE_LIST.filter((c) => c.value === roleValue || choices.some((x) => x.value === c.value)).map((c) => ({ value: c.value, label: t(c.labelKey) }))}
              />
              <FormField label="Status" as="select" value={statusValue} onChange={(e) => edit({ status: e.target.value })} disabled={!canEdit || !!statusLimit}
                help={canEdit ? teamLimitReason('status', statusLimit) || undefined : undefined}
                options={[{ value: 'active', label: 'Active' }, { value: 'invited', label: 'Invited' }, { value: 'disabled', label: 'Disabled' }]} />
            </div>
            {/* The customers a cleaner works at (lib/worksAt): a link the office keeps. What the
                cleaner sees still comes from the cleans they're on. */}
            {current.role === 'crew' && (
              <div className="form-group">
                {canEdit ? (
                  <BuildingMultiPicker
                    label={t('worksAt.label')}
                    emptyNote={t('worksAt.empty')}
                    options={worksAtOptions}
                    value={worksAtOf(current)}
                    onChange={(ids) => edit({ worksAt: ids })}
                  />
                ) : (
                  <>
                    <span className="form-label">{t('worksAt.label')}</span>
                    <div className="text-sm">{worksAtClients(current, state.clients).map(customerLabel).join(', ') || '—'}</div>
                  </>
                )}
                <div className="form-help">{t('worksAt.hint')}</div>
              </div>
            )}
            {authConfigured && canResetThisUser && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-light)' }}>
                <div className="text-xs text-muted" style={{ flex: 1, minWidth: 220 }}>
                  {t('signInLink.resetHint', { name: first, email: user.email })}
                </div>
                <button type="button" className="btn btn-outline" onClick={sendReset} disabled={resetBusy} style={{ flexShrink: 0 }}>
                  {resetBusy ? t('signInLink.sending') : t('signInLink.resetButton')}
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
          {/* The Operations Manager's team (S131, UI_RULES §169): on an OM's page, the account managers
              who report to them; on an account manager's, who they report to. Assigning is owner /
              admin with ops.edit (lib/teamLimits mayAssignTeams), the org_state guard's rule. */}
          {isOpsManager(user) && <AccountManagerAssignmentCard om={user} canEdit={canAssignTeams} />}
          {isAccountManager(user) && <OpsManagerLine user={user} canEdit={canAssignTeams} />}
        </section>

        {canViewPay && (
        <section id={sectionElementId('pay')} className="detail-section" hidden={activeSection !== 'pay'}>
          {(() => {
            const pay = current.pay || { type: '' };
            const setPay = (next) => edit({ pay: { ...(current.pay || {}), ...next } });
            const payRateField = payTypeOf(pay.type)?.field ? payTypeOf(pay.type) : null;
            return (
              <div className="card detail-card">
                <h3 className="dash-card-title">Employment &amp; pay</h3>
                <p className="text-xs text-muted" style={{ marginTop: -4, marginBottom: 12 }}>
                  How {user.name.split(' ')[0]} is paid. Feeds the Payroll run (hours × rate → gross). {!canEditThisPay && (canEditRates ? 'Only a Super Admin can change your own pay.' : 'Only a Super Admin can change pay rates.')}
                </p>
                {/* The pay types and their rate fields are lib/payTypes', the list Add Team Member
                    offers too (task 470). */}
                <div className="form-row">
                  <FormField
                    label="Pay type" as="select" value={pay.type || ''} disabled={!canEditThisPay}
                    onChange={(e) => setPay({ type: e.target.value })}
                    options={[{ value: '', label: '— Select pay type —' }, ...PAY_TYPES.map((p) => ({ value: p.value, label: p.label }))]}
                  />
                  {payRateField && <FormField label={payRateField.rateLabel} type="number" min="0" step="0.01" value={pay[payRateField.field] ?? ''} disabled={!canEditThisPay} onChange={(e) => setPay({ [payRateField.field]: Number(e.target.value) || 0 })} />}
                </div>
                {pay.type === 'salary' && (
                  <label className="pay-check" style={{ marginTop: 4 }}>
                    <input type="checkbox" checked={!!pay.otExempt} disabled={!canEditThisPay} onChange={(e) => setPay({ otExempt: e.target.checked })} /> Overtime exempt (salaried — accrues no OT premium)
                  </label>
                )}
                {/* PAY-7 / PAY-18: a different hourly rate at a given building, on top of the
                    main rate above. Hourly only, and the same `pay` patch — so it is gated by
                    `payroll.rates.edit` and the own-pay rule exactly like the rate beside it,
                    and lands in the one Save pay this card already has. */}
                {pay.type === 'hourly' && (
                  <BuildingRatesEditor
                    pay={pay}
                    clients={state.clients}
                    canEdit={canEditThisPay}
                    /* `undefined` rather than null once nothing is overridden, so JSON drops the
                       key and the field is genuinely ABSENT again — the org_state money
                       fingerprint returns to its previous value (lib/payRates). */
                    onChange={(buildingRates) => setPay({ buildingRates: buildingRates || undefined })}
                  />
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
          <EmployeeWarningsCard user={user} />
          <EmployeeIncidentsCard user={user} />
          <EmployeeTerminationCard user={user} />
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
          {/* The cleaner's app (the Cleaner Hub, D4): Request Supplies, on or off for this cleaner.
              Saves as it flips (the Access tab's action); a switch the viewer may not use stays,
              disabled, with the reason under it (UI_RULES §118). */}
          {user.role === 'crew' && (
            <div className="card detail-card">
              <h3 className="dash-card-title">Cleaner app</h3>
              <div className="pref-row">
                <div className="pref-row-text">
                  <div className="pref-row-label">Can request supplies</div>
                  <div className="pref-row-desc">
                    {supplyRequestsOn
                      ? 'On. They can flag low or out supplies for the buildings they clean. Their account manager approves.'
                      : 'Off. Request Supplies is turned off for them.'}
                  </div>
                  {supplySwitchReason && <div className="pref-row-desc">{supplySwitchReason}</div>}
                </div>
                <Toggle on={supplyRequestsOn} disabled={!!supplySwitchReason} onChange={(on) => setSupplyRequests(on)} />
              </div>
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
                  // The member's column, with the schema-default fallback — see togglePermOverride.
                  const roleHas = columnHolds(user, key, permissions);
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

      {/* CS-661: the reset the app couldn't email — the link to send, which replaced any before it. */}
      <SignInLinkModal
        open={!!handedLink}
        onClose={() => setHandedLink(null)}
        name={first}
        link={handedLink?.link}
        why={handedLink?.why}
        replaces
      />

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
