// Client Requests (`/requests`) — the office's queue of what customers have REQUESTED, the way
// Matt's "Account Manager Hub" board draws it (the manager view redesign, 2026-10-09; plan §1, D4
// "Client Requests"; Matt's email of the same day).
//
// Every OPEN work order (the Quality hub's Work Orders list underneath, D4: qcApi.listOpenProblems —
// every open ticket, CS-640 — with each one's first staff reply); Respond opens the one work-order
// drawer, components/WorkOrderDrawer. REQUESTS ONLY (HUB-24 (c), Matt 2026-10-12: "Messages and
// requests should be treated separately"): a customer's message waiting for a reply lives in
// Messaging → Customers and on the manager Home's own count, never here.
// Each row counts down Matt's standards (lib/clientRequests requestClock): the first reply within
// the org's no-reply window, then the fix by the request's TYPE (an issue by urgency). Overdue
// first, then by urgency (WO-20). The banner states the standards from the same rules.
//
// Gate: problems.manage (the Work Orders tab's own), a manager-only nav leaf. Phones allowed.
// Every word is a catalog line (UI_RULES §140); the work-order drawer's are still that tab's English.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePagedRows } from '../hooks/usePagedRows';
import { useToast } from '../components/Toast';
import { selectClientById, selectUserById } from '../store/selectors';
import { SUPERVISOR_ROLES } from '../lib/roles';
import { defaultManagerFor, managerFilterParam, managerFilterValue, managerFilterIds, teamPickLead } from '../lib/managerFilter';
import { TEAM } from '../lib/teamScope';
import * as qcApi from '../lib/qcApi';
import { toWorkOrder, deriveSla, WO_TYPE_META, WO_TYPES, isVisitorReport } from '../lib/workOrders';
import { clientRequestRows, clientRequestCounts, responseStandards } from '../lib/clientRequests';
import { isArchivedCustomer } from '../lib/customerStatus';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import Badge from '../components/Badge';
import Icon from '../components/Icon';
import EmptyState from '../components/EmptyState';
import ListPager from '../components/ListPager';
import WorkOrderDrawer from '../components/WorkOrderDrawer';
import { ManagerFilter, SelectFilter } from './reports/reportKit';

// Each type's word (a literal key per type, so the catalog can find and check it). A failed
// inspection is Builder B's type (WO-19).
const TYPE_KEYS = {
  complaint: 'clientReq.type.complaint',
  request: 'clientReq.type.request',
  issue: 'clientReq.type.issue',
  failed_inspection: 'clientReq.type.failed_inspection',
};
const typeKeyOf = (type) => TYPE_KEYS[type] || TYPE_KEYS.issue;
// A chip colour for a type the work orders' own vocabulary does not colour (yet).
const EXTRA_BADGE = { failed_inspection: 'amber' };
const badgeOf = (type) => WO_TYPE_META[type]?.badge || EXTRA_BADGE[type] || 'slate';
const MINUTES_PER_DAY = 24 * 60;
// The clocks re-read on this beat, so every deadline counts down while the page is open.
const TICK_MS = 30 * 1000;

export default function ClientRequests() {
  const t = useT();
  const state = useStore();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canManage = usePermission('problems.manage');
  const online = useOnlineStatus() !== false;
  const [params, setParams] = useSearchParams();
  const setParam = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, String(v)); }
    setParams(next, { replace: true });
  };

  // ── the Manager filter (lib/managerFilter, the one rule Messaging → Customers reads too): a
  // manager who supervises buildings starts on their own; everyone else on all; `?mgr=` carries
  // the owner's pick from the Manager view's tile (CS-702). ──
  const managers = useMemo(
    () => (state.users || []).filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)),
    [state.users],
  );
  // An Operations Manager opens on their whole team (`team`, S131 — lib/managerFilter), the queue
  // kept to their team's managers in the browser (managerFilterIds). The owner arriving from the
  // Operations view's Requests tile (`?mgr=team&om=<the OM>`, S131 Wave 2) reads THAT team — the
  // figure the tile counted; picking anything else drops the `om`.
  const defaultMgr = useMemo(() => defaultManagerFor(currentUser, state.clients, state.users), [currentUser, state.clients, state.users]);
  const mgrFilter = managerFilterValue({ viewer: currentUser, clients: state.clients, users: state.users, mgrParam: params.get('mgr') });
  const omParam = params.get('om') || '';
  const mgrIds = useMemo(() => managerFilterIds(mgrFilter, { viewer: currentUser, users: state.users, omParam }), [mgrFilter, currentUser, state.users, omParam]);
  const teamLead = useMemo(() => teamPickLead({ viewer: currentUser, users: state.users, value: mgrFilter, omParam }), [currentUser, state.users, mgrFilter, omParam]);
  const setManager = (v) => setParam({ mgr: managerFilterParam(v, defaultMgr), om: v === TEAM ? omParam || null : null, rp: null });
  const typeFilter = WO_TYPES.includes(params.get('type')) ? params.get('type') : '';
  const typeOptions = useMemo(() => [
    { value: '', label: t('clientReq.allTypes') },
    ...WO_TYPES.map((ty) => ({ value: ty, label: t(typeKeyOf(ty)) })),
  ], [t]);

  // ── the read: every open ticket (CS-640) ──
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    setErr(null);
    try { setRows(await qcApi.listOpenProblems({})); }
    catch (e) { setErr(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const loaded = rows !== null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(id); }, []);

  const settings = state.opsSettings || {};
  const supervisorOf = useCallback((clientId) => (clientId ? selectClientById(state, clientId)?.supervisorId || null : null), [state]);
  // An archived customer's requests leave the queue (CS-663; lib/clientRequests).
  const clientArchived = useCallback((clientId) => isArchivedCustomer(selectClientById(state, clientId)), [state]);
  // Every open request for the manager in view (the header counts these), then the type facet.
  const queueOf = useCallback((type) => clientRequestRows(rows || [], {
    now, settings, supervisorOf, managerId: mgrIds, type, clientArchived,
  }), [rows, now, settings, supervisorOf, mgrIds, clientArchived]);
  const inView = useMemo(() => queueOf(''), [queueOf]);
  const list = useMemo(() => (typeFilter ? queueOf(typeFilter) : inView), [typeFilter, queueOf, inView]);
  const counts = clientRequestCounts(inView);
  const pager = usePagedRows(list, { param: 'rp', resetKey: `${mgrFilter}|${teamLead ? teamLead.id : ''}|${typeFilter}` });

  // ── the banner: Matt's standards, every figure from its rule ──
  const standards = useMemo(() => responseStandards(settings), [settings]);
  const durText = (target) => (target.unit === 'days'
    ? t('clientReq.dur.days', { count: target.count })
    : t('clientReq.dur.hours', { count: target.count }));
  const typeTarget = (type) => standards.types.find((x) => x.type === type);
  const issueTarget = (priority) => standards.issues.find((x) => x.priority === priority);

  // ── the drawer: a ticket's (Respond, or a bell's `?wo=<id>`, dropped again on close) ──
  const linkedId = params.get('wo');
  const [openId, setOpenId] = useState(() => linkedId || null);
  useEffect(() => { if (linkedId) setOpenId(linkedId); }, [linkedId]);
  const closeDrawer = () => {
    setOpenId(null);
    if (params.get('wo')) setParam({ wo: null });
  };
  // The open set holds only open tickets, so a ticket resolved from the drawer leaves it on the
  // next read: the drawer then shows the ticket as the update returned it (`touched`), and stays.
  const [touched, setTouched] = useState(null);
  const selected = useMemo(() => {
    if (!openId) return null;
    const raw = (rows || []).find((x) => x.id === openId) || (touched && touched.id === openId ? touched : null);
    if (!raw) return null;
    const w = { ...toWorkOrder(raw), first_reply_at: raw.first_reply_at ?? null };
    return { ...w, sla: deriveSla({ dueAt: w.due_at, status: w.status, resolvedAt: w.resolved_at, now }) };
  }, [openId, rows, touched, now]);
  const clientName = (w) => w.client_name || (w.client_id ? selectClientById(state, w.client_id)?.name : null) || w.site_name || '—';
  const userName = (id) => (id ? selectUserById(state, id)?.name : null) || null;
  const update = async (id, patch) => {
    try {
      const after = await qcApi.updateProblem({ id, ...patch });
      if (after && after.id) setTouched(after);
      await load();
    }
    catch (e) { toast.error(errorText(t, e, 'clientReq.updateFailed')); }
  };

  // The clock in words: the first reply, then the fix; paused while the client is asked.
  const leftText = (left) => {
    if (left.phase === 'reply') {
      return left.state === 'breached'
        ? t('clientReq.left.replyOverdue', { time: left.minutes })
        : t('clientReq.left.replyRemaining', { time: left.minutes });
    }
    if (left.state === 'breached') return t('clientReq.left.overdue', { time: left.minutes });
    if (left.state === 'soon' || left.state === 'ok') return t('clientReq.left.remaining', { time: left.minutes });
    if (left.state === 'paused') return t('clientReq.left.paused');
    return '—';
  };
  const openedText = (w) => {
    const mins = w.openedMinutes;
    if (mins == null) return '';
    if (mins < 1) return t('clientReq.openedJustNow');
    if (mins < MINUTES_PER_DAY) return t('clientReq.openedAgo', { time: mins });
    return t('clientReq.openedDays', { count: Math.floor(mins / MINUTES_PER_DAY) });
  };

  const urgent = issueTarget('urgent');
  const medium = issueTarget('medium');
  const low = issueTarget('low');
  const fixes = {
    complaint: durText(typeTarget('complaint')),
    request: durText(typeTarget('request')),
    failed: durText(typeTarget('failed_inspection')),
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>{t('clientReq.title')}</h1>
          <p className="page-sub">
            {loaded && !err
              ? <>
                {t('clientReq.openCount', { count: counts.open })} · {t('clientReq.urgentCount', { count: counts.urgent })}
                {counts.overdue > 0 && <> · <span className="creq-overdue-count">{t('clientReq.overdueCount', { count: counts.overdue })}</span></>}
              </>
              : t('clientReq.intro')}
          </p>
        </div>
      </div>
      {!online && <p className="creq-offline text-sm" role="status">{t('clientReq.offline')}</p>}

      {/* Matt's standards (his email, 2026-10-09; WO-20 / WO-21; the first reply is WO-5's window). */}
      <p className="creq-banner" role="note">
        {standards.replyMins > 0
          ? t.rich('clientReq.standards.line', { reply: t('clientReq.dur.minutes', { count: standards.replyMins }), ...fixes })
          : t.rich('clientReq.standards.lineNow', fixes)}
        {' '}
        {t('clientReq.standards.issues', { urgent: durText(urgent), medium: durText(medium), low: durText(low) })}
      </p>

      <div className="filter-bar creq-filters">
        <ManagerFilter managers={managers} currentUser={currentUser} value={mgrFilter} onChange={setManager} team teamLead={teamLead} />
        <SelectFilter label={t('clientReq.type')} value={typeFilter} onChange={(v) => setParam({ type: v, rp: null })} options={typeOptions} />
      </div>

      {err ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('clientReq.loadFailed')}
          message={online ? errorText(t, err, 'clientReq.loadFailedHint') : t('clientReq.offline')}
          action={<button type="button" className="btn btn-primary" onClick={load}>{t('clientReq.tryAgain')}</button>}
        />
      ) : !loaded ? (
        <p className="text-muted text-sm creq-loading">{t('common.loading')}</p>
      ) : list.length === 0 ? (
        typeFilter && inView.length > 0
          ? <EmptyState icon={<Icon name="search" size={28} />} title={t('clientReq.noMatch')} message={t('clientReq.noMatchHint')} />
          : <EmptyState icon={<Icon name="check" size={28} />} title={t('clientReq.empty')} message={t('clientReq.emptyHint')} />
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table className="creq-table">
              <thead>
                <tr>
                  <th>{t('clientReq.col.property')}</th><th>{t('clientReq.col.type')}</th><th>{t('clientReq.col.details')}</th>
                  <th>{t('clientReq.col.timeLeft')}</th><th className="col-review"><span className="sr-only">{t('clientReq.respond')}</span></th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((w) => (
                  <tr key={w.id} className={`creq-row creq-${w.left.state}`}>
                    <td className="cell-primary"><span className="truncate" title={clientName(w)}>{clientName(w)}</span></td>
                    <td data-label={t('clientReq.col.type')}><Badge variant={badgeOf(w.type)}>{t(typeKeyOf(w.type))}</Badge></td>
                    <td data-label={t('clientReq.col.details')}>
                      <div className="creq-details">
                        <span className="creq-title">{w.title}</span>
                        <span className="text-muted text-xs">{openedText(w)}</span>
                        {/* QR-22..QR-26: a visitor's report from a QR code says so, here as in the drawer. */}
                        {isVisitorReport(w) && <span className="text-muted text-xs">{t('workOrders.origin.visitor')}</span>}
                      </div>
                    </td>
                    <td data-label={t('clientReq.col.timeLeft')}><span className={`creq-left creq-left-${w.left.state}`}>{leftText(w.left)}</span></td>
                    <td className="cell-actions col-review">
                      <button
                        type="button"
                        className={`btn btn-sm ${w.left.state === 'breached' ? 'btn-danger' : w.left.state === 'soon' ? 'btn-gold' : 'btn-outline'}`}
                        onClick={() => setOpenId(w.id)}
                      >{t('clientReq.respond')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('pager.noun.requests')} />
        </>
      )}

      {/* Always mounted: it draws nothing while closed, and slides out with the last ticket. */}
      <WorkOrderDrawer
        wo={selected || null} canManage={canManage} onClose={closeDrawer}
        onUpdate={update} onRefresh={load}
        clientName={selected ? clientName(selected) : null}
        supervisorName={selected ? userName(supervisorOf(selected.client_id)) : null}
      />
    </div>
  );
}
