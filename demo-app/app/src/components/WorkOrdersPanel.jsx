// Work Orders — the client-raised ticketing queue inside the Quality hub (the
// evolved "Problems" surface). White command bar (click-to-filter, synced with the
// chips), queue scoping by account supervisor (client.supervisorId — a manager
// lands on their own queue, admin/owner see all; crew are server-scoped), a
// grouped-by-location list, and a detail drawer with status / assign / escalate
// controls + completion photos. Records are relational (qcApi → /api/qc or the demo
// stub); the message thread + the Complaints fold-in land in later increments.
// The drawer is its own component, `WorkOrderDrawer`, shared with Client Requests (the manager
// view redesign, 2026-10-09).
//
// 🔴 CS-640: two reads, never the newest N. EVERY open ticket (qcApi.listOpenProblems, a complete
// read) — the queue, its stat cards and chips count that set; and the RESOLVED history one page at
// a time (qcApi.listResolvedProblems: newest resolved first, the exact total and how many were
// resolved in the last 24 hours), scoped to the queue on the server so the page and its total
// describe the same queue, with Load more. It was one read of the newest 500 work orders of every
// status, so past 500 tickets the oldest open ones vanished from the queue and its counts.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import { selectClientById, selectUserById, selectActiveUsers } from '../store/selectors';
import { SUPERVISOR_ROLES } from '../lib/roles';
import { TEAM, isOpsManager, teamClientIds } from '../lib/teamScope';
import * as qcApi from '../lib/qcApi';
import {
  toWorkOrder, deriveSla, isBreaching, isOpenStatus, WO_RESOLVED_PAGE,
  WO_CATEGORIES, WO_CATEGORY_META,
  woStatusLabel, woPriorityLabel, woPriorityRank, woTypeLabel,
  WO_STATUS_META, WO_TYPE_META,
} from '../lib/workOrders';
import Badge from './Badge';
import Icon from './Icon';
import Avatar from './Avatar';
import EmptyState from './EmptyState';
import WorkOrderModal from './WorkOrderModal';
import WorkOrderDrawer, { initialsOf, WorkOrderOriginChip } from './WorkOrderDrawer';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';
import { useT } from '../i18n/react';

const STATS = [
  { f: 'open', label: 'Open work orders', hint: 'in the queue', tone: '' },
  { f: 'escalated', label: 'Escalated', hint: 'past first response', tone: 'bad' },
  { f: 'breaching', label: 'Breaching SLA', hint: 'act now', tone: 'warn' },
  { f: 'resolved', label: 'Resolved (24h)', hint: 'SLA met', tone: 'good' },
];
const CHIPS = [
  { f: 'all', label: 'All' }, { f: 'escalated', label: 'Escalated' },
  { f: 'breaching', label: 'Breaching SLA' }, { f: 'awaiting_client', label: 'Awaiting client' },
  { f: 'unassigned', label: 'Unassigned' },
];
const FILTER_HINT = {
  all: 'Click any stat or chip to filter — they drive the same filter.',
  open: 'Filtered to open work orders.', escalated: 'Filtered to escalated.',
  breaching: 'Filtered to breaching / at-risk SLA.', resolved: 'Filtered to resolved work orders, newest resolved first.',
  awaiting_client: 'Filtered to awaiting client.', unassigned: 'Filtered to unassigned.',
};

export default function WorkOrdersPanel({ canManage }) {
  const t = useT();
  const state = useStore();
  const { currentUser } = useAuth();
  const canReport = usePermission('problems.manage');
  const toast = useToast();
  const isSupervisor = !!currentUser && SUPERVISOR_ROLES.includes(currentUser.role);

  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('all');
  // WO-12: the category is its OWN filter, not one of the CHIPS — those are one
  // mutually-exclusive selection (a chip click replaces the last), and "open AND spills" is a
  // question the queue has to be able to ask.
  const [category, setCategory] = useState('');
  const [groupBy, setGroupBy] = useState(true);
  // A bell about ONE ticket links here with `?wo=<id>` (api/_lib/qc/store.ticketDeepLink — a
  // customer's reply in the hub): that ticket's drawer opens, whichever queue is showing, and
  // the parameter is dropped when it closes so Back and a refresh do not reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedId = searchParams.get('wo');
  const [openId, setOpenId] = useState(() => linkedId || null);
  useEffect(() => { if (linkedId) setOpenId(linkedId); }, [linkedId]);
  const closeDrawer = () => {
    setOpenId(null);
    if (searchParams.get('wo')) {
      const next = new URLSearchParams(searchParams);
      next.delete('wo');
      setSearchParams(next, { replace: true });
    }
  };
  const [createOpen, setCreateOpen] = useState(false);

  // Queue = account supervisor. Only managers who actually hold accounts are queues.
  const managers = useMemo(
    () => selectActiveUsers(state).filter((u) => SUPERVISOR_ROLES.includes(u.role) && (state.clients || []).some((c) => c.supervisorId === u.id)),
    [state],
  );
  // An Operations Manager's queue is their TEAM (S131): their buildings and their account
  // managers' — "My team", where they open when the team holds any. The resolved history asks the
  // server for `team`, which it resolves from the claim (api/qc); the open set is narrowed here.
  const om = isOpsManager(currentUser);
  const teamBuildings = useMemo(
    () => (om ? teamClientIds(state.users, state.clients, currentUser.id) : null),
    [om, state.users, state.clients, currentUser],
  );
  const myQueueDefault = useMemo(() => {
    if (teamBuildings && teamBuildings.size) return TEAM;
    return isSupervisor && managers.some((m) => m.id === currentUser.id) ? currentUser.id : 'all';
  }, [isSupervisor, managers, currentUser, teamBuildings]);
  const [queue, setQueue] = useState('all');
  useEffect(() => { setQueue(myQueueDefault); }, [myQueueDefault]);

  // EVERY open ticket — complete; the queue narrows it here (the open set is the whole truth).
  const loadOpen = useCallback(async () => {
    setErr(null);
    try { setRows(await qcApi.listOpenProblems({})); }
    catch (e) { setErr(e.message || 'Could not load work orders'); setRows([]); }
  }, []);
  // The resolved history, newest resolved first, one page at a time — scoped to the QUEUE on the
  // server, so its total is the queue's. `resolved`: { rows, total, last24h } | null while loading.
  const [resolved, setResolved] = useState(null);
  const [resolvedErr, setResolvedErr] = useState(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const resolvedQueue = queue === 'all' ? undefined : queue;
  const loadResolved = useCallback(async () => {
    setResolvedErr(null);
    try {
      const r = await qcApi.listResolvedProblems({ supervisorId: resolvedQueue, offset: 0 });
      setResolved({ rows: r.problems, total: r.total, last24h: r.last24h });
    } catch (e) { setResolvedErr(e.message || 'Could not load resolved work orders'); setResolved(null); }
  }, [resolvedQueue]);
  const loadMoreResolved = async () => {
    if (!resolved || moreBusy) return;
    setMoreBusy(true);
    try {
      const r = await qcApi.listResolvedProblems({ supervisorId: resolvedQueue, offset: resolved.rows.length });
      setResolved((cur) => {
        const have = new Set((cur?.rows || []).map((x) => x.id));
        return { rows: [...(cur?.rows || []), ...r.problems.filter((x) => !have.has(x.id))], total: r.total, last24h: r.last24h };
      });
    } catch (e) { toast.error(e.message || 'Could not load more resolved work orders'); }
    finally { setMoreBusy(false); }
  };
  const load = useCallback(async () => { await Promise.all([loadOpen(), loadResolved()]); }, [loadOpen, loadResolved]);
  useEffect(() => { loadOpen(); }, [loadOpen]);
  useEffect(() => { loadResolved(); }, [loadResolved]);

  const supervisorOf = useCallback((clientId) => (clientId ? selectClientById(state, clientId)?.supervisorId || null : null), [state]);

  // The open set and the loaded resolved pages, each ticket once (a ticket resolved between the
  // two reads keeps its open copy until the next read), narrowed to the queue.
  const scoped = useMemo(() => {
    const seen = new Set();
    const all = [];
    for (const r of [...(rows || []), ...((resolved && resolved.rows) || [])]) {
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      all.push(toWorkOrder(r));
    }
    if (queue === 'all') return all;
    if (queue === TEAM) return all.filter((w) => !!teamBuildings && teamBuildings.has(w.client_id));
    return all.filter((w) => supervisorOf(w.client_id) === queue);
  }, [rows, resolved, queue, supervisorOf, teamBuildings]);
  const withSla = useMemo(
    () => scoped.map((w) => ({ ...w, sla: deriveSla({ dueAt: w.due_at, status: w.status, resolvedAt: w.resolved_at }) })),
    [scoped],
  );

  // Every count is over a COMPLETE set (CS-640): the open ones count the open set; "Resolved (24h)"
  // and the resolved part of "All" are the server's exact figures for the queue, never the length
  // of the pages loaded so far.
  const counts = useMemo(() => {
    const c = { all: 0, open: 0, escalated: 0, breaching: 0, resolved: resolved ? resolved.last24h : 0, awaiting_client: 0, unassigned: 0 };
    for (const w of withSla) {
      if (!isOpenStatus(w.status)) continue;
      c.open += 1;
      if (w.escalated) c.escalated += 1;
      if (isBreaching(w.sla.state)) c.breaching += 1;
      if (w.status === 'awaiting_client') c.awaiting_client += 1;
      if (!w.assignee_user_id) c.unassigned += 1;
    }
    c.all = c.open + (resolved ? resolved.total : 0);
    return c;
  }, [withSla, resolved]);

  // How many OPEN tickets each category holds in the current queue (the complete set), so the
  // selector can say what picking one would find in the queue's open work.
  const categoryCounts = useMemo(() => {
    const open = withSla.filter((w) => isOpenStatus(w.status));
    const c = { '': open.length };
    for (const w of open) { const k = w.category || '_none'; c[k] = (c[k] || 0) + 1; }
    return c;
  }, [withSla]);

  const matches = useCallback((w) => {
    switch (filter) {
      case 'open': return isOpenStatus(w.status);
      case 'escalated': return w.escalated && isOpenStatus(w.status);
      case 'breaching': return isBreaching(w.sla.state);
      case 'resolved': return w.status === 'resolved';
      case 'awaiting_client': return w.status === 'awaiting_client';
      case 'unassigned': return !w.assignee_user_id && isOpenStatus(w.status);
      default: return true;
    }
  }, [filter]);

  const SLA_ORDER = { breached: 0, soon: 1, ok: 2, paused: 3, met: 4, missed: 4, none: 5 };
  const filtered = useMemo(() => {
    const rank = (w) => (w.escalated ? 0 : 1) * 100 + (SLA_ORDER[w.sla.state] ?? 5) * 10 + woPriorityRank(w.priority);
    const arr = withSla.filter(matches).filter((w) => !category || w.category === category).slice();
    // Grouping keeps a location's rows contiguous (so inline group headers work over
    // the paged rows); severity orders within a group, or overall when ungrouped.
    arr.sort((a, b) => {
      if (groupBy) {
        const ga = (a.client_name || a.site_name || '~').toLowerCase();
        const gb = (b.client_name || b.site_name || '~').toLowerCase();
        if (ga !== gb) return ga < gb ? -1 : 1;
      }
      return rank(a) - rank(b);
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withSla, matches, groupBy, category]);
  const groupCounts = useMemo(() => {
    const m = {};
    for (const w of filtered) { const k = w.client_id || w.site_id || '_none'; m[k] = (m[k] || 0) + 1; }
    return m;
  }, [filtered]);

  const pager = usePagedRows(filtered, { resetKey: `${filter}|${queue}|${groupBy}|${category}` });
  const setF = (f) => setFilter((cur) => (f !== 'all' && cur === f ? 'all' : f));

  const clientName = (w) => w.client_name || (w.client_id ? selectClientById(state, w.client_id)?.name : null) || w.site_name || '—';
  const userName = (id) => (id ? selectUserById(state, id)?.name : null) || null;
  const update = async (id, patch) => { try { await qcApi.updateProblem({ id, ...patch }); await load(); } catch (e) { toast.error(e.message || 'Update failed'); } };

  // Looked up across EVERY row, not only this queue's: a linked ticket may sit in another
  // supervisor's queue (its assignee is the one who was rung).
  const selected = useMemo(() => {
    if (!openId) return null;
    const w = withSla.find((x) => x.id === openId) || (rows || []).map(toWorkOrder).find((x) => x.id === openId);
    return w ? (w.sla ? w : { ...w, sla: deriveSla({ dueAt: w.due_at, status: w.status, resolvedAt: w.resolved_at }) }) : null;
  }, [openId, withSla, rows]);

  const woRow = (w) => (
    <tr key={w.id} className="wo-rowlink" onClick={() => setOpenId(w.id)}>
      <td data-label="Priority"><span className={`wo-pri pri-${w.priority}`}><span className="wo-dot" />{woPriorityLabel(w.priority)}</span></td>
      <td className="cell-primary">
        <div className="truncate" style={{ fontWeight: 600 }} title={w.title}>{w.title}</div>
        <div className="wo-subline">
          <Badge variant={WO_TYPE_META[w.type]?.badge || 'slate'}>{woTypeLabel(w.type)}</Badge>
          <WorkOrderOriginChip origin={w.origin} />
        </div>
      </td>
      {!groupBy && <td data-label="Location"><span className="truncate" title={clientName(w)}>{clientName(w)}</span></td>}
      <td data-label="Assignee">{w.assignee_user_id
        ? <span className="wo-assignee"><Avatar user={selectUserById(state, w.assignee_user_id)} initials={initialsOf(userName(w.assignee_user_id))} size="xs" /></span>
        : <span className="wo-unassigned" title="Unassigned">—</span>}</td>
      <td data-label="SLA"><span className={`wo-sla sla-${w.sla.state}`}>{w.sla.label}</span></td>
      <td data-label="Status">{w.escalated && <span className="wo-esc" title="Escalated"><Icon name="warning" size={12} /></span>}<Badge variant={WO_STATUS_META[w.status]?.badge || 'slate'}>{woStatusLabel(w.status)}</Badge></td>
    </tr>
  );

  const colCount = groupBy ? 5 : 6;

  return (
    <>
      <div className="wo-toolbar">
        {isSupervisor && managers.length > 0 && (
          <label className="wo-queue">
            <span className="wo-queue-lbl">Queue</span>
            <select className="input" value={queue} onChange={(e) => setQueue(e.target.value)}>
              <option value="all">All queues</option>
              {om && <option value={TEAM}>{t('reportKit.myTeam')}</option>}
              {managers.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === currentUser?.id ? ' (me)' : ''}</option>)}
            </select>
          </label>
        )}
        <div className="wo-toolbar-right">
          <button type="button" className={`wo-toggle ${groupBy ? 'on' : ''}`} onClick={() => setGroupBy((g) => !g)} aria-pressed={groupBy}>
            <span className={`toggle ${groupBy ? 'on' : 'off'}`} aria-hidden="true"><span className="toggle-thumb" /></span> Group by location
          </button>
          {canReport && <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>New work order</button>}
        </div>
      </div>

      <div className="wo-cmdbar" role="group" aria-label="Work order stats">
        {STATS.map((s) => {
          const n = counts[s.f];
          const tone = (s.tone === 'bad' || s.tone === 'warn') && n === 0 ? '' : s.tone;
          return (
            <button type="button" key={s.f} className={`wo-seg ${filter === s.f ? 'on' : ''}`} onClick={() => setF(s.f)} aria-pressed={filter === s.f}>
              <div className={`wo-seg-n tnum ${tone}`}>{n}</div>
              <div className="wo-seg-l">{s.label}</div>
              <div className="wo-seg-d">{s.hint}</div>
            </button>
          );
        })}
      </div>
      <p className="wo-filterhint">
        {filter !== 'all' && <span className="wo-hint-dot" />}{FILTER_HINT[filter]}
        {filter !== 'all' && <> · <button type="button" className="linklike" onClick={() => setFilter('all')}>Clear filter ✕</button></>}
      </p>

      <div className="wo-chips" role="group" aria-label="Filters">
        {/* WO-12: filter by reporting category, independent of the chips beside it. */}
        <select
          className="input wo-cat-filter"
          aria-label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t('workOrders.categoryAllOpen', { count: categoryCounts[''] || 0 })}</option>
          {WO_CATEGORIES.map((c) => (
            <option key={c} value={c}>{t('workOrders.categoryOpen', { label: WO_CATEGORY_META[c].label, count: categoryCounts[c] || 0 })}</option>
          ))}
        </select>
        {CHIPS.map((c) => (
          <button type="button" key={c.f} className={`chip ${filter === c.f ? 'on' : ''}`} onClick={() => setF(c.f)}>
            {c.label} <span className="control-count tnum">{counts[c.f]}</span>
          </button>
        ))}
      </div>

      <div className="table-wrap mobile-stack">
        <table className="wo-table">
          <thead>
            <tr>
              <th>Priority</th><th>Work order</th>{!groupBy && <th>Location</th>}<th>Assignee</th><th>SLA</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {err ? (
              <tr className="stack-plain"><td colSpan={colCount} className="wo-cell-msg wo-cell-err">{err} <button className="btn btn-link btn-sm" onClick={load}>Retry</button></td></tr>
            ) : rows === null ? (
              <tr className="stack-plain"><td colSpan={colCount} className="wo-cell-msg">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr className="stack-plain"><td colSpan={colCount}><EmptyState icon={<Icon name="warning" size={28} />} title="No work orders" message={counts.all === 0 ? 'Nothing in this queue yet. Click “New work order” to log one.' : 'Nothing matches this filter.'} /></td></tr>
            ) : (
              pager.pageRows.map((w, i) => {
                const prev = pager.pageRows[i - 1];
                const gk = w.client_id || w.site_id || '_none';
                const showHead = groupBy && (!prev || (prev.client_id || prev.site_id || '_none') !== gk);
                const sup = supervisorOf(w.client_id);
                return (
                  <Fragment key={w.id}>
                    {showHead && <tr className="wo-grouprow"><td colSpan={colCount}>{clientName(w)}{sup ? ` — ${userName(sup) || ''}` : ''} · {groupCounts[gk]}</td></tr>}
                    {woRow(w)}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
        <ListPager pager={pager} noun="work orders" />
      </div>
      {/* The resolved history is paged on the server: say how much of it is here, and fetch more. */}
      {(filter === 'all' || filter === 'resolved') && (
        resolvedErr ? (
          <p className="wo-filterhint wo-resolved-note" role="status">
            {t('workOrders.resolvedFailed')} <button type="button" className="linklike" onClick={loadResolved}>{t('workOrders.retry')}</button>
          </p>
        ) : resolved && resolved.total > 0 ? (
          <p className="wo-filterhint wo-resolved-note" role="status">
            {t('workOrders.resolvedLoaded', { loaded: resolved.rows.length, total: resolved.total })}
            {resolved.rows.length < resolved.total && (
              <> · <button type="button" className="linklike" disabled={moreBusy} onClick={loadMoreResolved}>
                {moreBusy ? t('workOrders.loadingMore') : t('workOrders.loadMore', { count: Math.min(WO_RESOLVED_PAGE, resolved.total - resolved.rows.length) })}
              </button></>
            )}
          </p>
        ) : null
      )}

      {/* Always mounted: it draws nothing while closed, and slides out with the last ticket. */}
      <WorkOrderDrawer
        wo={selected || null} canManage={canManage} onClose={closeDrawer}
        onUpdate={update} onRefresh={load}
        clientName={selected ? clientName(selected) : null}
        supervisorName={selected ? userName(supervisorOf(selected.client_id)) : null}
      />

      <WorkOrderModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); load(); }} />
    </>
  );
}
