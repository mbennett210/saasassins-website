// Approvals — the manager's daily desk: every clock-in and clock-out to approve before payroll
// (Matt: "Every clock-in and clock-out must be approved by a manager before our payroll
// specialist pulls the payroll report"). Three tabs behind ?tab= (To approve · Missing time ·
// Overtime), filters in the URL, all reads scoped to the manager's customers (server-enforced;
// the UI options mirror it). Component-local projections (useState) — never the synced blob.
// Spec §8.1. Route-gated time.approve; phones allowed.
//
// HOURS APPROVAL BY PERSON (the manager view redesign, 2026-10-09, Matt's board; plan S4–S6):
// the To approve tab shows one row per cleaner (lib/filters/timeApprovals pendingByPerson):
// their building or "N buildings", their pending hours as reg + OT from the approvals read, and
// Approve — or Review, which opens their punches as before, for anyone with a flag. "Approve
// all" approves only the people with no flag and says how many it left. Every approval is still
// the per-punch approveEntries call, in batches of the route's own cap.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Badge from '../components/Badge';
import Icon from '../components/Icon';
import EmptyState from '../components/EmptyState';
import FormField from '../components/FormField';
import FilterSelect from '../components/FilterSelect';
import ListPager from '../components/ListPager';
import { useToast } from '../components/Toast';
import TimeEntryModal, { TimeDeleteDialog, refusalText, refusalCodeText } from '../components/TimeEntryModal';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useTimeScope } from '../hooks/useTimeScope';
import { usePagedRows } from '../hooks/usePagedRows';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import * as timeApi from '../lib/timeApi';
import { TIME_REFUSAL_KEYS, effectiveTimeFilter } from '../lib/timeRules';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import { TEAM, isOpsManager, teamClientIds, teamMemberIds } from '../lib/teamScope';
import { teamPickLead } from '../lib/managerFilter';
import {
  punchFlagMessages, canActOnPunch,
  pendingByPerson, approveAllPlan, chunkApproveItems, pendingDueKey,
} from '../lib/filters/timeApprovals';
import { checklistFlagText } from '../lib/checklistFlag';
import { overlapFlagText } from '../lib/openPunchRule';
import { lateStartAutoCloseText } from '../lib/autoClose';
import { fmtPunchTime } from '../lib/wallClock';
import { GEOFENCE_REASON_LABELS } from '../lib/clockRules';
import { missedAfterStartMins } from '../lib/opsAlerts';
import {
  computeAttendanceReport, incompleteCount, ATT_NO_PUNCH, ATT_MISSING_OUT,
} from '../lib/attendanceReport';
import {
  fmtDate, fmtTime, fmtDateLong, todayKey, addDaysKey, startOfDayKey, dayKey,
} from '../lib/dates';
import { useT } from '../i18n/react';
import { english } from '../i18n/core';
import { LANGUAGE_INFO, intlLocale } from '../i18n/languages';

const DATE_OPTS = { weekday: 'short', month: 'short', day: 'numeric' };
const TABS = [
  { key: 'approve', labelKey: 'approvals.tab.approve' },
  { key: 'missing', labelKey: 'approvals.tab.missing' },
  { key: 'overtime', labelKey: 'approvals.tab.overtime' },
];
const MISSING_WINDOWS = [7, 14, 30];

const fmtDur = (mins) => {
  if (!Number.isFinite(mins) || mins < 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};
const hoursLabel = (mins) => `${Math.round(((Number(mins) || 0) / 60) * 10) / 10}h`;
const FLAG_VARIANT = {
  'Off-site': 'red', Override: 'amber', Offline: 'slate', 'Auto-closed': 'amber',
  // CS-667: closed by the app after a clock-in past the clean's scheduled end — the same amber.
  'Auto-closed · late start': 'amber',
  Manual: 'blue', Edited: 'slate', 'Clean cancelled': 'slate',
  // PAY-13 / CS-318: overlapping punches both reach payroll, so this is RED — the one flag
  // in this queue that can mean paid hours were doubled.
  'Two cleans at once': 'red',
  // An override chip now names WHICH rule skipped the geofence (lib/clockRules), so each
  // of those wordings wears the same amber the bare "Override" did.
  ...Object.fromEntries(Object.values(GEOFENCE_REASON_LABELS).map((label) => [label, 'amber'])),
};
// "Checklist 3/12" / "Checklist unknown" — a review flag, the same amber as the other
// "look at this before you approve" chips. "incl. 1.5h OT" stays purple.
// The colour is decided on the flag's ENGLISH (CS-193: the chip itself shows in the reader's
// language), so a translation can never change what colour a flag wears.
const flagVariant = (f) => (f.startsWith('incl.') ? 'purple' : f.startsWith('Checklist') ? 'amber' : (FLAG_VARIANT[f] || 'slate'));

// The correct-mode entry shape TimeEntryModal expects, from a snake_case pending row.
const toCorrectTarget = (r) => ({
  id: r.id, userId: r.user_id, jobId: r.job_id, rowVersion: r.row_version ?? null,
  clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, note: r.note || '',
  userName: r.user_name, siteName: r.site_name, clientName: r.client_name,
  approvalStatus: r.approval_status,
});

export default function Approvals() {
  const t = useT();
  const state = useStore();
  const toast = useToast();
  // The signed-in person (the viewed-as one under "View as"). useAuth() has no `user` key: reading
  // one gave undefined, so the own-punch skip, the "Me" label and the OM's team filter never ran
  // (S131; test-use-auth-keys.mjs).
  const { currentUser: user } = useAuth();
  const { scope, unscoped, clientIds } = useTimeScope();
  const [params, setParams] = useSearchParams();
  // An OPERATIONS MANAGER's scope is their team (useTimeScope → lib/timeRules, S131), and the
  // Manager filter narrows it to one member — never beyond it: the server answers the same rule
  // (api/time approvals). The owner's Home carries the pick in as ?mgr= (CS-702).
  const om = !unscoped && isOpsManager(user);
  const teamIds = useMemo(() => (om ? teamMemberIds(state.users, user.id) : []), [om, state.users, user]);
  // The owner's (or an admin's) pick of an Operations Manager's WHOLE team, carried in by the
  // Operations view's Hours tile as `?mgr=team&om=<the OM>` (S131 Wave 2; lib/managerFilter
  // teamPickLead — lib/teamScope teamLeadFor, the route's own rule): the page reads that team, the
  // figures the tile counted. Any other `team` reads All managers for them, as on the today pages.
  const rawMgr = params.get('mgr') || '';
  const omParam = params.get('om') || '';
  const teamLead = useMemo(
    () => (unscoped ? teamPickLead({ viewer: user, users: state.users, value: rawMgr, omParam }) : null),
    [unscoped, user, state.users, rawMgr, omParam],
  );
  const teamClients = useMemo(
    () => (teamLead ? teamClientIds(state.users, state.clients, teamLead.id) : null),
    [teamLead, state.users, state.clients],
  );

  const tab = TABS.some((tb) => tb.key === params.get('tab')) ? params.get('tab') : 'approve';
  const custId = params.get('cust') || '';
  const cleanerId = params.get('cleaner') || '';
  const mgrId = unscoped ? (teamLead ? TEAM : (rawMgr === TEAM ? '' : rawMgr)) : (om && teamIds.includes(rawMgr) ? rawMgr : '');
  const missingDays = MISSING_WINDOWS.includes(Number(params.get('days'))) ? Number(params.get('days')) : 7;
  const setParam = (key, value, def = '') => {
    const next = new URLSearchParams(params);
    if (value === def || value == null || value === '') next.delete(key); else next.set(key, String(value));
    setParams(next, { replace: true });
  };
  // A Manager pick: anything but the owner's team pick drops whose team it was (`om`).
  const setManager = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set('mgr', String(value)); else next.delete('mgr');
    if (value !== TEAM) next.delete('om');
    setParams(next, { replace: true });
  };

  // A manager assigned no customers reads nothing company-wide — the no-locations state instead.
  const noLocations = !unscoped && Array.isArray(clientIds) && clientIds.length === 0;

  // ── the Approvals read (pending + overtime), scoped; owner/admin may pick a Manager ──
  const [data, setData] = useState(null); // { pending, overtime, ledger, asOf } | null while loading
  const [dataErr, setDataErr] = useState(null);
  const supervisorId = (unscoped || om) ? (mgrId || undefined) : undefined;
  const teamOm = teamLead ? teamLead.id : undefined; // whose team `team` is, for the owner's pick
  const loadApprovals = useCallback(async () => {
    if (noLocations) { setData({ pending: [], overtime: [] }); setDataErr(null); return; }
    setDataErr(null); setData(null);
    try { setData(await timeApi.approvals({ supervisorId, om: teamOm })); }
    catch (e) { setDataErr(refusalText(t, e, 'approvals.loadFailed')); }
  }, [supervisorId, teamOm, noLocations, t]);
  useEffect(() => { loadApprovals(); }, [loadApprovals]);

  // ── Missing time: the attendance report over the last N org days, scoped ──
  const usersById = useMemo(() => new Map((state.users || []).map((u) => [u.id, u])), [state.users]);
  const clientsById = useMemo(() => new Map((state.clients || []).map((c) => [c.id, c])), [state.clients]);
  const sitesById = useMemo(() => new Map((state.sites || []).map((s) => [s.id, s])), [state.sites]);
  const [attendance, setAttendance] = useState(null);
  const [attErr, setAttErr] = useState(null);
  // An OM's team spans managers: the report reads the team (the scope filter below), one member
  // when the filter names them. The owner's pick of a team is filtered by its buildings below.
  const attManagerId = unscoped ? (mgrId && mgrId !== 'none' && mgrId !== TEAM ? mgrId : null) : om ? (mgrId || null) : user?.id || null;
  // 🔴 THE READ IS SCOPED SERVER-SIDE, not filtered in the browser (W5-M F5). `/api/time/entries`
  // answers COMPANY-WIDE for any `time.view` holder, and the lite column set carries
  // `user_name` and both punch times — so asking unfiltered and hiding the rest below meant a
  // manager downloaded every other location's cleaners and their hours. Same rule TimeClockHistory
  // runs since W4-F: `effectiveTimeFilter` never returns an empty clientIds (the server and the
  // demo stub both DROP one and answer company-wide), it returns "don't read at all".
  const readFilter = useMemo(
    () => effectiveTimeFilter({ unscoped, scopeClientIds: clientIds }),
    [unscoped, clientIds],
  );
  const loadAttendance = useCallback(async () => {
    if (noLocations || !readFilter.fetch) { setAttendance([]); setAttErr(null); return; }
    setAttErr(null); setAttendance(null);
    try {
      const toKey = todayKey();
      const fromKey = addDaysKey(toKey, -(missingDays - 1));
      const fromIso = startOfDayKey(fromKey).toISOString();
      const toIso = new Date().toISOString();
      const entries = await timeApi.entriesAll({ fromIso, toIso, lite: true, clientIds: readFilter.clientIds });
      const rows = computeAttendanceReport({
        jobs: state.jobs || [], timeEntries: entries,
        usersById, clientsById, sitesById,
        fromMs: startOfDayKey(fromKey).getTime(), toMs: Date.now(),
        managerId: attManagerId, now: Date.now(),
        // ALR-11: the one missed-shift mark (opsSettings.missedAfterStartMins).
        graceMins: missedAfterStartMins(state.opsSettings || {}), timeOff: state.timeOff || [],
      }).filter((r) => r.status === ATT_NO_PUNCH || r.status === ATT_MISSING_OUT)
        // Unscoped "No manager" view: only customers with no supervisor.
        .filter((r) => !(unscoped && mgrId === 'none') || !clientsById.get(r.clientId)?.supervisorId)
        // The owner's pick of an Operations Manager's team: that team's buildings.
        .filter((r) => !teamClients || (r.clientId && teamClients.has(r.clientId)))
        // A scoped manager reads company-wide punches but only their own cleans matter.
        .filter((r) => unscoped || (scope && r.clientId && scope.has(r.clientId)));
      setAttendance(rows);
    } catch (e) { setAttErr(refusalText(t, e, 'approvals.missingLoadFailed')); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingDays, attManagerId, unscoped, mgrId, teamClients, noLocations, readFilter, state.jobs, usersById, clientsById, sitesById, state.opsSettings, state.timeOff, t]);
  useEffect(() => { loadAttendance(); }, [loadAttendance]);

  // ── customer + cleaner options (scoped) and the manager list ──
  const scopedClients = useMemo(() => {
    let cs = state.clients || [];
    if (!unscoped) {
      cs = cs.filter((c) => scope.has(c.id));
      if (om && mgrId) cs = cs.filter((c) => c.supervisorId === mgrId);
    } else if (mgrId === 'none') cs = cs.filter((c) => !c.supervisorId);
    else if (mgrId === TEAM) cs = cs.filter((c) => !!teamClients && teamClients.has(c.id));
    else if (mgrId) cs = cs.filter((c) => c.supervisorId === mgrId);
    return cs.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [state.clients, unscoped, scope, mgrId, om, teamClients]);
  const customerOptions = useMemo(
    () => [{ value: '', label: t('approvals.allCustomers') }, ...scopedClients.map((c) => ({ value: c.id, label: c.name }))],
    [scopedClients, t],
  );
  const cleanerOptions = useMemo(() => [
    { value: '', label: t('approvals.allCleaners') },
    ...(state.users || []).filter((u) => u.status === 'active').slice().sort(compareUsersByName).map((u) => ({ value: u.id, label: u.name })),
  ], [state.users, t]);
  const managerOptions = useMemo(() => (om ? [
    { value: '', label: t('mgrTeam.allMyTeam') },
    ...teamIds.map((id) => (state.users || []).find((u) => u.id === id)).filter(Boolean)
      .map((m) => ({ value: m.id, label: m.id === user?.id ? t('approvals.me', { name: m.name }) : m.name })),
  ] : [
    { value: '', label: t('approvals.allManagers') },
    ...(teamLead ? [{ value: TEAM, label: t('mgrTeam.teamOf', { name: teamLead.name || '—' }) }] : []),
    ...(state.users || []).filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)).slice().sort(compareUsersByName)
      .map((m) => ({ value: m.id, label: m.id === user?.id ? t('approvals.me', { name: m.name }) : m.name })),
    { value: 'none', label: t('approvals.noManager') },
  ]), [state.users, user, t, om, teamIds, teamLead]);

  // ── facet filters (client-side, over the scoped read) ──
  const pending = useMemo(() => {
    let rows = (data?.pending || []).slice().sort((a, b) => String(a.clock_in_at).localeCompare(String(b.clock_in_at)));
    if (custId) rows = rows.filter((r) => r.client_id === custId);
    if (cleanerId) rows = rows.filter((r) => r.user_id === cleanerId);
    return rows;
  }, [data, custId, cleanerId]);
  const overtime = useMemo(() => {
    let rows = data?.overtime || [];
    if (custId) rows = rows.filter((u) => u.clientId === custId);
    if (cleanerId) rows = rows.filter((u) => u.userId === cleanerId);
    return rows;
  }, [data, custId, cleanerId]);
  const missing = useMemo(() => {
    let rows = attendance || [];
    if (custId) rows = rows.filter((r) => r.clientId === custId);
    if (cleanerId) rows = rows.filter((r) => r.userId === cleanerId);
    return rows;
  }, [attendance, custId, cleanerId]);

  // ── the To approve tab, one row per PERSON (plan S4–S6) ──
  // `people` follows the facet filters; `allPeople` is the scoped backlog the header and the
  // tab count read (what's waiting, before a facet), exactly as the tab counts always did.
  const people = useMemo(() => pendingByPerson(pending, user), [pending, user]);
  const allPeople = useMemo(() => pendingByPerson(data?.pending || [], user), [data, user]);
  const dueKey = useMemo(
    () => pendingDueKey({ rows: data?.pending || [], opsSettings: state.opsSettings, now: new Date() }),
    [data, state.opsSettings],
  );
  const plan = useMemo(() => approveAllPlan(people), [people]);

  const counts = {
    approve: data?.pending ? allPeople.length : null,
    missing: attendance ? incompleteCount(attendance) : null,
    overtime: data?.overtime?.length ?? null,
  };

  // One approval at a time (a double-tap fires once): 'all' or the person's id.
  const online = useOnlineStatus() !== false;
  const approveGuard = useRef(false);
  const [busyKey, setBusyKey] = useState(null);

  const [correctTarget, setCorrectTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [addPrefill, setAddPrefill] = useState(null); // Missing-time "Add time"
  const [otBusy, setOtBusy] = useState(() => new Set());

  const reload = useCallback(() => { loadApprovals(); loadAttendance(); }, [loadApprovals, loadAttendance]);

  const approveOne = async (r) => {
    try {
      const [res] = await timeApi.approveEntries([{ entryId: r.id, version: r.row_version ?? null }]);
      if (res && res.ok === false) toast.error(refusalCodeText(t, res.code, 'approvals.approveFailed'));
      else toast.success(t('approvals.approved'));
      reload();
    } catch (e) { toast.error(refusalText(t, e, 'approvals.approveFailed')); }
  };
  // Send approve items in the route's own batch size; every per-punch result comes back, and
  // one refused punch never blocks the others (the server judges each alone).
  const sendApprovals = async (items) => {
    const results = [];
    for (const batch of chunkApproveItems(items)) results.push(...(await timeApi.approveEntries(batch)));
    return results;
  };
  // The sentences for punches that did not go through: changed since the page loaded, or refused.
  const partialText = (results) => {
    const staleN = results.filter((x) => !x.ok && x.code === 'stale').length;
    const otherN = results.filter((x) => !x.ok && x.code !== 'stale').length;
    return [
      staleN ? t('approvals.bulkStale', { count: staleN }) : '',
      otherN ? t('approvals.bulkOther', { count: otherN }) : '',
    ].filter(Boolean).join(' ');
  };
  const runGuarded = async (key, fn) => {
    if (approveGuard.current) return;
    approveGuard.current = true; setBusyKey(key);
    try { await fn(); } catch (e) { toast.error(refusalText(t, e, 'approvals.bulkFailed')); }
    finally { setBusyKey(null); approveGuard.current = false; reload(); }
  };
  // Approve: every punch of ONE person this viewer may approve (their timesheet in one tap).
  const approvePerson = (p) => runGuarded(p.userId, async () => {
    const results = await sendApprovals(p.items);
    const okN = results.filter((x) => x.ok).length;
    const partial = partialText(results);
    if (!partial) toast.success(t('approvals.person.approvedToast', { name: p.userName || '—' }));
    else toast.info([t('approvals.bulkApproved', { count: okN }), partial].join(' '));
  });
  // Approve all (plan S6): only the people with no flag; then say how many need a look.
  const approveAll = () => runGuarded('all', async () => {
    const results = await sendApprovals(plan.items);
    const okIds = new Set(results.filter((x) => x.ok).map((x) => x.entryId));
    const approvedPeople = plan.people.filter((p) => p.items.every((i) => okIds.has(i.entryId))).length;
    const partial = partialText(results);
    const summary = [
      t('approvals.all.approved', { count: approvedPeople }),
      plan.skipped ? t('approvals.all.needLook', { count: plan.skipped }) : '',
    ].filter(Boolean).join(' · ');
    if (!partial && !plan.skipped) toast.success(summary);
    else toast.info(partial ? `${summary}. ${partial}` : summary);
  });
  const approveOt = async (u) => {
    const key = `${u.userId}|${u.weekKey}|${u.clientId}`;
    if (otBusy.has(key)) return;
    setOtBusy((s) => new Set(s).add(key));
    try {
      const [res] = await timeApi.approveOvertime([{ userId: u.userId, weekKey: u.weekKey, clientId: u.clientId, minutes: u.dueMinutes }]);
      if (res && res.ok === false) toast.error(refusalCodeText(t, res.code, 'approvals.otFailed'));
      else toast.success(t('approvals.otApproved'));
      loadApprovals();
    } catch (e) { toast.error(refusalText(t, e, 'approvals.otFailed')); }
    finally { setOtBusy((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };

  const openAdd = (r) => setAddPrefill({
    userId: r.userId, jobId: r.jobId, dayKey: r.scheduledStart ? dayKey(r.scheduledStart) : todayKey(),
    clockInAt: r.scheduledStart, clockOutAt: r.scheduledEnd,
  });
  const openFixClockOut = (r) => setCorrectTarget({
    id: r.entryId, rowVersion: r.entryVersion, userId: r.userId, jobId: r.jobId,
    clockInAt: r.clockInAt, clockOutAt: r.clockOutAt, note: '',
    userName: r.userName, clientName: r.clientName, siteName: r.siteName,
  });

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>{t('approvals.title')}</h1>
          {/* Matt's board: "N timesheets pending · due <the pay period's last day>" once the read
              has landed (plan S4); the page's own sentence until then and on a failed read. */}
          <p className="page-sub">
            {data?.pending && !dataErr && !noLocations
              ? t('approvals.person.summary', { count: allPeople.length, due: dueKey })
              : t('approvals.intro')}
          </p>
        </div>
        {tab === 'approve' && !noLocations && data?.pending && !dataErr && people.length > 0 && (
          <div className="page-head-actions">
            <button
              type="button" className="btn btn-primary"
              disabled={busyKey !== null || !online || plan.items.length === 0}
              aria-describedby={plan.items.length === 0 ? 'appr-all-note' : undefined}
              onClick={approveAll}
            >{busyKey === 'all' ? t('approvals.approving') : t('approvals.all.button')}</button>
          </div>
        )}
      </div>
      {!online && <p className="appr-offline text-sm" role="status">{t('approvals.offline')}</p>}

      <div className="tab-container-line appr-tabs" role="group" aria-label={t('approvals.viewAria')}>
        {TABS.map((tb) => (
          <button key={tb.key} type="button" className={`tab-btn ${tab === tb.key ? 'active' : ''}`} onClick={() => setParam('tab', tb.key, 'approve')}>
            {counts[tb.key] != null && counts[tb.key] > 0 ? t('approvals.tabCount', { label: t(tb.labelKey), count: counts[tb.key] }) : t(tb.labelKey)}
          </button>
        ))}
      </div>

      <div className="filter-bar appr-filters">
        <FormField label={t('approvals.customer')}><FilterSelect ariaLabel={t('approvals.customer')} value={custId} onChange={(v) => setParam('cust', v)} options={customerOptions} /></FormField>
        <FormField label={t('approvals.cleaner')}><FilterSelect ariaLabel={t('approvals.cleaner')} value={cleanerId} onChange={(v) => setParam('cleaner', v)} options={cleanerOptions} /></FormField>
        {(unscoped || om) && <FormField label={t('approvals.manager')}><FilterSelect ariaLabel={t('approvals.manager')} value={mgrId} onChange={setManager} options={managerOptions} /></FormField>}
        {tab === 'missing' && (
          <FormField label={t('approvals.window')}>
            <div className="tab-container-line appr-days" role="group" aria-label={t('approvals.window')}>
              {MISSING_WINDOWS.map((d) => (
                <button key={d} type="button" className={`tab-btn ${missingDays === d ? 'active' : ''}`} onClick={() => setParam('days', d, 7)}>{t('approvals.days', { days: d })}</button>
              ))}
            </div>
          </FormField>
        )}
      </div>

      {noLocations ? (
        <EmptyState
          icon={<Icon name="building" size={28} />}
          title={t('approvals.noLocations')}
          message={t('approvals.noLocationsHint')}
        />
      ) : tab === 'approve' ? (
        <ApproveTab
          data={data} error={dataErr} people={people} plan={plan} user={user}
          busyKey={busyKey} online={online} onApprovePerson={approvePerson}
          onApprove={approveOne} onEdit={(r) => setCorrectTarget(toCorrectTarget(r))} onDelete={(r) => setDeleteTarget(r)}
          filtered={!!(custId || cleanerId)} onRetry={loadApprovals}
        />
      ) : tab === 'missing' ? (
        <MissingTab
          rows={missing} loading={attendance === null} error={attErr}
          filtered={!!(custId || cleanerId)} onRetry={loadAttendance}
          onAdd={openAdd} onFix={openFixClockOut}
        />
      ) : (
        <OvertimeTab
          data={data} error={dataErr} rows={overtime} filtered={!!(custId || cleanerId)}
          onApprove={approveOt} otBusy={otBusy} onRetry={loadApprovals}
        />
      )}

      <TimeEntryModal open={!!correctTarget} onClose={() => setCorrectTarget(null)} mode="correct" entry={correctTarget} onSaved={() => { setCorrectTarget(null); reload(); }} />
      <TimeEntryModal open={!!addPrefill} onClose={() => setAddPrefill(null)} mode="manual" prefill={addPrefill} onSaved={() => { setAddPrefill(null); reload(); }} />
      <TimeDeleteDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} entry={deleteTarget} label={deleteTarget?.user_name} onDeleted={() => { setDeleteTarget(null); reload(); }} />
    </div>
  );
}

// ── To approve: one row per PERSON (Matt's board; plan S4–S6) ───────────────────────
// Desktop: Employee · Property · Hours · action. A phone reads each person as a card
// (.mobile-stack, UI_RULES §24). The name opens the person's punches; a flagged person's
// only action is Review, which does the same: the punches exactly as the queue has always
// shown them, flags and the recorded sentences included, each with Approve · Edit · Delete.
function ApproveTab({ data, error, people, plan, user, busyKey, online, onApprovePerson, onApprove, onEdit, onDelete, filtered, onRetry }) {
  const t = useT();
  const pager = usePagedRows(people, { param: 'ap', resetKey: people });
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  if (error) return <RetryState message={error} onRetry={onRetry} />;
  if (data === null) return <p className="text-muted text-sm appr-loading">{t('approvals.loading')}</p>;
  if (people.length === 0) {
    return filtered
      ? <EmptyState icon={<Icon name="search" size={28} />} title={t('approvals.noMatch')} message={t('approvals.noMatchHint')} />
      : <EmptyState icon={<Icon name="check" size={28} />} title={t('approvals.nothingWaiting')} message={t('approvals.nothingWaitingHint')} />;
  }
  // Hours to one decimal, as the board draws them ("8.0 hrs reg"), in the reader's own number format.
  const hours = (mins) => new Intl.NumberFormat(intlLocale(LANGUAGE_INFO[t.lang]?.dateLocale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((Number(mins) || 0) / 60);
  return (
    <>
      {/* Approve all is off when every timesheet left has a flag; the reason is visible, never a tooltip (§131). */}
      {plan.items.length === 0 && <p id="appr-all-note" className="text-muted text-sm appr-all-note">{t('approvals.all.noneHint')}</p>}
      <div className="table-wrap mobile-stack">
        <table className="appr-people">
          <thead>
            <tr>
              <th>{t('approvals.col.employee')}</th><th>{t('approvals.col.property')}</th><th>{t('approvals.col.hours')}</th>
              <th className="col-review">{t('approvals.col.review')}</th>
            </tr>
          </thead>
          <tbody>
            {pager.pageRows.map((p) => {
              const key = p.userId || '_none';
              const isOpen = open.has(key);
              const panelId = `appr-person-${key}`;
              return (
                <Fragment key={key}>
                  <tr className={`appr-person${p.flagged ? ' flagged' : ''}${isOpen ? ' open' : ''}`}>
                    <td className="cell-primary">
                      <button type="button" className="linklike appr-person-name" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(key)}>
                        {p.userName || '—'}
                        <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={14} />
                      </button>
                      {p.flags.length > 0 && (
                        <span className="appr-flags appr-person-flags">
                          {p.flags.map((f) => { const en = english(f); return <Badge key={en} variant={flagVariant(en)}>{t(f)}</Badge>; })}
                        </span>
                      )}
                    </td>
                    <td data-label={t('approvals.col.property')}>
                      {p.places.length === 1
                        ? <span className="truncate" title={p.places[0].name}>{p.places[0].name || '—'}</span>
                        : t('approvals.person.buildings', { count: p.places.length })}
                    </td>
                    <td data-label={t('approvals.col.hours')} className="appr-hours">
                      <span>{t('approvals.person.reg', { hours: hours(p.regMinutes) })}</span>
                      {p.otMinutes > 0 && <span className="appr-hours-ot">{t('approvals.person.ot', { hours: hours(p.otMinutes) })}</span>}
                    </td>
                    <td className="cell-actions col-review appr-actions">
                      {!p.actionable ? (
                        <span className="text-muted text-xs">{t(TIME_REFUSAL_KEYS['own-entry'])}</span>
                      ) : p.flagged ? (
                        <button type="button" className="btn btn-sm btn-outline" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(key)}>
                          {t('approvals.person.review')}
                        </button>
                      ) : (
                        <button type="button" className="btn btn-sm btn-gold" disabled={busyKey !== null || !online} onClick={() => onApprovePerson(p)}>
                          {busyKey === p.userId ? t('approvals.approving') : t('approvals.approve')}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="appr-person-drill" id={panelId}>
                      <td colSpan={4}>
                        <div className="appr-person-panel">
                          <PunchTable rows={p.rows} user={user} online={online} onApprove={onApprove} onEdit={onEdit} onDelete={onDelete} />
                          {p.actionable && (
                            <div className="appr-person-foot">
                              <button type="button" className="btn btn-gold" disabled={busyKey !== null || !online} onClick={() => onApprovePerson(p)}>
                                {busyKey === p.userId ? t('approvals.approving') : t('approvals.person.approveAll', { count: p.items.length, name: p.userName || '—' })}
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun={t('pager.noun.timesheets')} />
    </>
  );
}

// One person's pending punches, as the queue has always shown them (minus the cleaner column:
// the panel is the person's). Paged in local state, since several panels can be open at once.
function PunchTable({ rows, user, online, onApprove, onEdit, onDelete }) {
  const t = useT();
  const pager = usePagedRows(rows, { resetKey: rows });
  return (
    <>
      <div className="table-wrap mobile-stack appr-punches">
        <table>
          <thead>
            <tr>
              <th>{t('approvals.col.date')}</th><th>{t('approvals.col.location')}</th><th>{t('approvals.col.in')}</th><th>{t('approvals.col.out')}</th>
              <th className="tc-num">{t('approvals.col.duration')}</th><th className="tc-num">{t('approvals.col.expected')}</th><th>{t('approvals.col.flags')}</th><th className="col-review">{t('approvals.col.review')}</th>
            </tr>
          </thead>
          <tbody>
            {pager.pageRows.map((r) => {
              const actionable = canActOnPunch(user, r);
              // Messages (CS-193): each chip in the reader's language, its colour from its English.
              const flags = punchFlagMessages(r);
              // The chip is short; the sentence the server actually recorded goes under it,
              // VISIBLE (a title would be invisible on the phones half this queue is worked
              // on) so the approver reads the same words the punch carries.
              const checklistNote = checklistFlagText(r);
              const overlapNote = overlapFlagText(r);
              const lateCloseNote = lateStartAutoCloseText(r);
              return (
                <tr key={r.id}>
                  <td className="cell-primary">{fmtDate(r.clock_in_at, DATE_OPTS)}</td>
                  <td data-label={t('approvals.col.location')}><span className="truncate" title={r.client_name || r.site_name}>{r.client_name || r.site_name || '—'}</span></td>
                  <td data-label={t('approvals.col.in')}>{fmtPunchTime(r.clock_in_at)}</td>
                  <td data-label={t('approvals.col.out')}>{r.clock_out_at ? fmtPunchTime(r.clock_out_at) : <span className="text-muted">—</span>}</td>
                  <td data-label={t('approvals.col.duration')} className="tc-num">{fmtDur(r.duration_minutes)}</td>
                  <td data-label={t('approvals.col.expected')} className="tc-num">{Number.isFinite(r.expected_minutes_snapshot) ? fmtDur(r.expected_minutes_snapshot) : '—'}</td>
                  <td data-label={t('approvals.col.flags')}>
                    {/* ONE cell child, so the phone card's label/value row stays two columns
                        and the note stacks UNDER the chips instead of beside them (§24). */}
                    <div className="appr-flagcell">
                      {flags.length ? <span className="appr-flags">{flags.map((f) => { const en = english(f); return <Badge key={en} variant={flagVariant(en)}>{t(f)}</Badge>; })}</span> : <span className="text-muted">—</span>}
                      {checklistNote && <div className="text-muted text-xs appr-flag-note">{checklistNote}</div>}
                      {overlapNote && <div className="text-muted text-xs appr-flag-note">{overlapNote}</div>}
                      {lateCloseNote && <div className="text-muted text-xs appr-flag-note">{lateCloseNote}</div>}
                    </div>
                  </td>
                  <td data-label={t('approvals.col.review')} className="col-review appr-actions">
                    {actionable ? (
                      <>
                        <button type="button" className="btn btn-sm btn-gold" disabled={!online} onClick={() => onApprove(r)}>{t('approvals.approve')}</button>
                        <button type="button" className="btn btn-sm btn-outline" onClick={() => onEdit(r)}>{t('approvals.edit')}</button>
                        <button type="button" className="btn btn-sm btn-outline" onClick={() => onDelete(r)}>{t('approvals.delete')}</button>
                      </>
                    ) : (
                      <span className="text-muted text-xs">{t(TIME_REFUSAL_KEYS['own-entry'])}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun={t('pager.noun.punches')} />
    </>
  );
}

// ── Missing time ─────────────────────────────────────────────────────────────────
function MissingTab({ rows, loading, error, filtered, onRetry, onAdd, onFix }) {
  const t = useT();
  const pager = usePagedRows(rows, { param: 'mp', resetKey: rows });
  if (error) return <RetryState message={error} onRetry={onRetry} />;
  if (loading) return <div className="text-muted text-sm" style={{ padding: 'var(--space-4)' }}>{t('approvals.loading')}</div>;
  if (rows.length === 0) {
    return filtered
      ? <EmptyState icon={<Icon name="search" size={28} />} title={t('approvals.noMatch')} message={t('approvals.noMatchHint')} />
      : <EmptyState icon={<Icon name="check" size={28} />} title={t('approvals.noMissing')} message={t('approvals.noMissingHint')} />;
  }
  return (
    <>
      <div className="table-wrap mobile-stack">
        <table>
          <thead>
            <tr><th>{t('approvals.col.date')}</th><th>{t('approvals.col.cleaner')}</th><th>{t('approvals.col.location')}</th><th>{t('approvals.col.scheduled')}</th><th>{t('approvals.col.status')}</th><th className="col-review">{t('approvals.col.fix')}</th></tr>
          </thead>
          <tbody>
            {pager.pageRows.map((r) => (
              <tr key={`${r.jobId}|${r.userId}`}>
                <td className="cell-primary">{r.scheduledStart ? fmtDate(r.scheduledStart, DATE_OPTS) : '—'}</td>
                <td data-label={t('approvals.col.cleaner')}><span className="truncate" title={r.userName}>{r.userName}</span></td>
                <td data-label={t('approvals.col.location')}><span className="truncate" title={r.clientName || r.siteName}>{r.clientName || r.siteName || '—'}</span></td>
                <td data-label={t('approvals.col.scheduled')}>{r.scheduledStart ? fmtTime(r.scheduledStart) : '—'}{r.scheduledEnd ? `–${fmtTime(r.scheduledEnd)}` : ''}</td>
                <td data-label={t('approvals.col.status')}>
                  {r.status === ATT_NO_PUNCH
                    ? <Badge variant="red">{t('approvals.noClockIn')}</Badge>
                    : <Badge variant="amber">{r.autoClosed ? t('approvals.missingOutAuto') : t('approvals.missingOut')}</Badge>}
                </td>
                <td data-label={t('approvals.col.fix')} className="col-review appr-actions">
                  {r.status === ATT_NO_PUNCH
                    ? <button type="button" className="btn btn-sm btn-gold" onClick={() => onAdd(r)}>{t('approvals.addTime')}</button>
                    : <button type="button" className="btn btn-sm btn-outline" onClick={() => onFix(r)} disabled={!r.entryId}>{t('approvals.fixOut')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun={t('pager.noun.cleans')} />
    </>
  );
}

// ── Overtime ─────────────────────────────────────────────────────────────────────
function OvertimeTab({ data, error, rows, filtered, onApprove, otBusy, onRetry }) {
  const t = useT();
  const pager = usePagedRows(rows, { param: 'op', resetKey: rows });
  if (error) return <RetryState message={error} onRetry={onRetry} />;
  if (data === null) return <div className="text-muted text-sm" style={{ padding: 'var(--space-4)' }}>{t('approvals.loading')}</div>;
  if (rows.length === 0) {
    return filtered
      ? <EmptyState icon={<Icon name="search" size={28} />} title={t('approvals.noMatch')} message={t('approvals.noMatchHint')} />
      : <EmptyState icon={<Icon name="check" size={28} />} title={t('approvals.noOvertime')} message={t('approvals.noOvertimeHint')} />;
  }
  return (
    <>
      <p className="hint appr-help">{t('approvals.otHelp')}</p>
      <div className="table-wrap mobile-stack">
        <table>
          <thead>
            <tr><th>{t('approvals.col.cleaner')}</th><th>{t('approvals.col.weekOf')}</th><th>{t('approvals.col.location')}</th><th className="tc-num">{t('approvals.col.overtime')}</th><th className="tc-num">{t('approvals.col.approvedOt')}</th><th className="tc-num">{t('approvals.col.awaiting')}</th><th className="col-review">{t('approvals.col.review')}</th></tr>
          </thead>
          <tbody>
            {pager.pageRows.map((u) => {
              const key = `${u.userId}|${u.weekKey}|${u.clientId}`;
              return (
                <tr key={key}>
                  <td className="cell-primary"><span className="truncate" title={u.userName}>{u.userName}</span></td>
                  <td data-label={t('approvals.col.weekOf')}>{fmtDateLong(startOfDayKey(u.weekKey).toISOString())}</td>
                  <td data-label={t('approvals.col.location')}><span className="truncate" title={u.clientName || t('approvals.noCustomer')}>{u.clientName || t('approvals.noCustomer')}</span></td>
                  <td data-label={t('approvals.col.overtime')} className="tc-num">{hoursLabel(u.dueMinutes)}</td>
                  <td data-label={t('approvals.col.approvedOt')} className="tc-num">{hoursLabel(u.approvedMinutes)}</td>
                  <td data-label={t('approvals.col.awaiting')} className="tc-num"><strong>{hoursLabel(u.awaitingMinutes)}</strong></td>
                  <td data-label={t('approvals.col.review')} className="col-review appr-actions">
                    <button type="button" className="btn btn-sm btn-gold" disabled={otBusy.has(key)} onClick={() => onApprove(u)}>{otBusy.has(key) ? t('approvals.approving') : t('approvals.approveOt')}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun={t('pager.noun.weeks')} />
    </>
  );
}

function RetryState({ message, onRetry }) {
  const t = useT();
  return (
    <EmptyState
      icon={<Icon name="warning" size={28} />}
      title={t('approvals.couldNotLoad')}
      message={message}
      action={<button type="button" className="btn btn-primary" onClick={onRetry}>{t('approvals.tryAgain')}</button>}
    />
  );
}
