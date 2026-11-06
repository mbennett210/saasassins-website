// Messaging → CUSTOMERS (client hub redesign, plan §3.4; D5): every building's conversation with
// its customers, UNREAD FIRST, filtered by Manager and Customer (searchable FilterSelects in a
// .filter-bar, UI_RULES), "Mine" = the buildings the viewer manages. The Manager filter rides the
// URL (`?mgr=`) and opens a manager on their own buildings (lib/managerFilter, CS-705). The open
// thread is <CustomerThread layout="pane">; the right pane says who the building is and who reads it.
//
// WAITING (HUB-24 (c), Matt 2026-10-12: "Messages and requests should be treated separately"): a
// customer's message waiting for the office's reply is not a client request, so it is told HERE —
// a third view, "Waiting", lists every thread waiting for the office's reply, the longest wait
// first (clientMessagesApi.listWaitingCustomerThreads, complete, narrowed by the same Manager and
// Customer filters), and every waiting row, in any view, says how long it has waited (WaitedFor).
// The manager Home's Customer messages tile opens it (`?view=waiting`).
//
// The same three-pane frame as the rest of Messaging (`.msg-3pane`, its resize handles from the
// page's own hook), so the phone layout follows for free: the list, or the open thread with a
// back arrow. The open building rides the URL (`?inbox=customers&b=<clientId>`) — the bell row a
// customer's message rings links straight to it — and so does the Waiting view (`&view=waiting`).
//
// The list is paged on the SERVER (/api/client-messages/threads, 20 a page): the book is 750
// buildings, so the thread list never renders them all. The waiting threads are a working set read
// whole, so their view pages on the screen.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Avatar from './Avatar';
import EmptyState from './EmptyState';
import FilterSelect from './FilterSelect';
import Icon from './Icon';
import ListPager from './ListPager';
import CustomerThread, { WaitedFor } from './CustomerThread';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useFromHere } from '../hooks/useFromHere';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { timeShort } from '../i18n/relative';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import { TEAM, isOpsManager, managerIdsMatch } from '../lib/teamScope';
import { defaultManagerFor, managerFilterIds, managerFilterParam, managerFilterValue, teamPickLead } from '../lib/managerFilter';
import { customerLabel } from '../lib/customerNumber';
import { OFFICE_THREAD_PAGE_SIZE } from '../lib/hubMessages';
import { listCustomerThreads, listWaitingCustomerThreads } from '../lib/clientMessagesApi';

const LIST_POLL_MS = 60000;
const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

function ThreadRow({ row, waitingSince, active, onSelect }) {
  const t = useT();
  const label = customerLabel({ name: row.clientName, customerNumber: row.customerNumber });
  const preview = row.lastAuthorName ? `${row.lastAuthorName}: ${row.lastBody}` : row.lastBody;
  const pick = () => onSelect(row.clientId);
  return (
    <div
      className={`thread-row ${active ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={pick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
    >
      <Avatar initials={initialsOf(row.clientName)} variant={(String(row.clientId).length % 5) + 1} size="sm" />
      <div className="thread-row-body">
        <div className="thread-row-name">{label}</div>
        <div className="thread-row-preview">{preview}</div>
      </div>
      <div className="thread-row-right">
        <div className="thread-row-top">
          {row.unread && (
            <span className="thread-unread" aria-label={t('custMsg.list.unread', { count: row.unreadCount || 1 })}>{row.unreadCount || 1}</span>
          )}
        </div>
        <span className="thread-row-time">{timeShort(t, row.lastAt)}</span>
        {waitingSince && <WaitedFor since={waitingSince} className="cmsg-wait-row" />}
      </div>
    </div>
  );
}

export default function CustomerMessagesInbox({ panes, paneRef, onActivity }) {
  const t = useT();
  const nav = useFromHere();
  const state = useStore();
  const { currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.get('b') || null;
  // 'all' | 'mine' | 'waiting' — the Waiting view rides the URL (`view=waiting`), so the manager
  // Home's Customer messages tile opens straight on it.
  const viewParam = searchParams.get('view');
  const [scope, setScope] = useState(() => (searchParams.get('view') === 'waiting' ? 'waiting' : 'all'));
  useEffect(() => { if (viewParam === 'waiting') setScope('waiting'); }, [viewParam]);
  // The Manager filter rides the URL (`?mgr=`, lib/managerFilter — the rule Client Requests
  // reads): a manager opens on their OWN buildings, "(me)", with the filter to widen (CS-705),
  // and the owner's Manager view carries its pick in from the Customer messages tile (CS-702).
  // An Operations Manager opens on their whole team (`team`, S131): the route resolves it from
  // their claim (api/client-messages), so the value is sent as it is. The owner arriving from the
  // Operations view's Customer messages tile (`?mgr=team&om=<the OM>`, S131 Wave 2) reads THAT team:
  // the `om` goes with both reads, and the route holds it to an owner or an admin naming an active
  // Operations Manager (lib/teamScope teamLeadFor). Picking anything else drops it.
  const defaultMgr = useMemo(() => defaultManagerFor(currentUser, state.clients, state.users), [currentUser, state.clients, state.users]);
  const managerId = managerFilterValue({ viewer: currentUser, clients: state.clients, users: state.users, mgrParam: searchParams.get('mgr') });
  const omParam = searchParams.get('om') || '';
  const teamLead = useMemo(() => teamPickLead({ viewer: currentUser, users: state.users, value: managerId, omParam }), [currentUser, state.users, managerId, omParam]);
  const teamOm = teamLead ? teamLead.id : null;
  const setManagerId = (v) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set('inbox', 'customers');
    const p = managerFilterParam(v, defaultMgr);
    if (p) next.set('mgr', p); else next.delete('mgr');
    if (v !== TEAM) next.delete('om');
    return next;
  }, { replace: true });
  const [clientFilter, setClientFilter] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [waitingAll, setWaitingAll] = useState(null);
  const [waitingError, setWaitingError] = useState('');
  const waitingView = scope === 'waiting';

  // The paged list (All / Mine).
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (waitingView) return;
    try {
      const r = await listCustomerThreads({
        filter: scope, managerId: managerId || null, clientId: clientFilter || null, om: teamOm,
        offset: (page - 1) * OFFICE_THREAD_PAGE_SIZE, limit: OFFICE_THREAD_PAGE_SIZE,
      }, { user: currentUser });
      setList(r);
      setError('');
    } catch (e) {
      if (!quiet) setError(errorText(t, e, 'custMsg.error.list'));
    }
  }, [waitingView, scope, managerId, teamOm, clientFilter, page, t, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every thread waiting for the office's reply (complete) for the manager in view, narrowed on
  // the server as the Home's Customer messages tile reads it: the Waiting view, and each row's wait.
  const loadWaiting = useCallback(async ({ quiet = false } = {}) => {
    try {
      const r = await listWaitingCustomerThreads({ managerId: managerId || null, om: teamOm }, { user: currentUser });
      setWaitingAll((r && r.threads) || []);
      setWaitingError('');
    } catch (e) {
      if (!quiet) setWaitingError(errorText(t, e, 'custMsg.error.list'));
    }
  }, [t, managerId, teamOm, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadWaiting(); }, [loadWaiting]);
  useEffect(() => { setPage(1); }, [scope, managerId, teamOm, clientFilter]);
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        load({ quiet: true });
        loadWaiting({ quiet: true });
      }
    }, LIST_POLL_MS);
    return () => clearInterval(id);
  }, [load, loadWaiting]);

  const pickScope = (v) => {
    setScope(v);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('inbox', 'customers');
      if (v === 'waiting') next.set('view', 'waiting'); else next.delete('view');
      return next;
    }, { replace: true });
  };

  const setActive = (clientId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('inbox', 'customers');
      if (clientId) next.set('b', clientId); else next.delete('b');
      return next;
    }, { replace: true });
  };

  // A thread was read or answered: the lists (unread marks, order, who is still waiting) and the
  // tab's badge move.
  const refresh = () => { load({ quiet: true }); loadWaiting({ quiet: true }); onActivity?.(); };

  // "(me)" names the viewer's own row, in Client Requests' words (its Manager filter).
  const managerOptions = useMemo(() => [
    { value: '', label: t('custMsg.filter.anyManager') },
    ...(isOpsManager(currentUser) ? [{ value: TEAM, label: t('reportKit.myTeam') }] : []),
    // The owner's pick of an Operations Manager's team, named (S131 Wave 2).
    ...(!isOpsManager(currentUser) && teamLead ? [{ value: TEAM, label: t('mgrTeam.teamOf', { name: teamLead.name || '—' }) }] : []),
    ...(state.users || [])
      .filter((u) => u && SUPERVISOR_ROLES.includes(u.role) && u.status === 'active')
      .sort(compareUsersByName)
      .map((u) => {
        const name = u.name || u.email || u.id;
        return { value: u.id, label: u.id === currentUser?.id ? t('reportKit.me', { name }) : name };
      }),
  ], [state.users, currentUser?.id, currentUser?.managerLevel, teamLead, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const customerOptions = useMemo(() => [
    { value: '', label: t('custMsg.filter.anyCustomer') },
    ...(state.clients || [])
      .filter((c) => c && c.id)
      .map((c) => ({ value: c.id, label: customerLabel(c) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true })),
  ], [state.clients, t]);

  // Since when each waiting thread has waited, by building — every view's rows read it.
  const waitingByClient = useMemo(() => new Map((waitingAll || []).map((w) => [w.clientId, w.waitingSince])), [waitingAll]);
  // The Waiting view: the waiting threads under the Manager and Customer filters, the longest wait
  // first (the read's own order), a page at a time. The read is already the manager's; the check
  // here keeps a late answer for an earlier pick off the screen.
  // `team` (an Operations Manager's, or the one the owner named with `om`) is the team's managers
  // here, as the route reads it (S131).
  const waitingRows = useMemo(() => {
    const keep = managerFilterIds(managerId, { viewer: currentUser, users: state.users, omParam });
    return (waitingAll || []).filter((w) => managerIdsMatch(keep, w.managerId) && (!clientFilter || w.clientId === clientFilter));
  }, [waitingAll, managerId, omParam, clientFilter, currentUser, state.users]);

  const rows = waitingView
    ? waitingRows.slice((page - 1) * OFFICE_THREAD_PAGE_SIZE, page * OFFICE_THREAD_PAGE_SIZE)
    : (list?.threads || []);
  const total = waitingView ? waitingRows.length : (list?.total || 0);
  const loaded = waitingView ? waitingAll !== null : list !== null;
  const shownError = waitingView ? waitingError : error;
  const pager = {
    page,
    totalPages: Math.max(1, Math.ceil(total / OFFICE_THREAD_PAGE_SIZE)),
    setPage,
    start: total ? (page - 1) * OFFICE_THREAD_PAGE_SIZE + 1 : 0,
    end: (page - 1) * OFFICE_THREAD_PAGE_SIZE + rows.length,
    total,
  };
  // A manager's own buildings are where the view opens, not a filter someone set.
  const filtered = scope === 'mine' || (!!managerId && managerId !== defaultMgr) || !!clientFilter;
  const activeClient = activeId ? (state.clients || []).find((c) => c.id === activeId) || null : null;
  const activeManager = activeClient?.supervisorId ? (state.users || []).find((u) => u.id === activeClient.supervisorId) || null : null;
  const scopeLabel = (v) => {
    if (v === 'mine') return t('custMsg.list.mine');
    if (v === 'waiting') return t('custMsg.list.waiting');
    return t('custMsg.list.all');
  };
  let emptyTitle = t('custMsg.list.empty');
  let emptyHint = t('custMsg.list.emptyHint');
  if (filtered) { emptyTitle = t('custMsg.list.emptyFiltered'); emptyHint = ''; }
  else if (waitingView) { emptyTitle = t('custMsg.list.emptyWaiting'); emptyHint = t('custMsg.list.emptyWaitingHint'); }

  return (
    <div
      className={`msg-3pane ${activeId ? 'has-active' : ''}`}
      ref={paneRef}
      style={{ '--pane-left': `${panes.sizes.left}px`, '--pane-right': `${panes.sizes.right}px` }}
    >
      <section className="thread-list-pane">
        <div className="thread-list-head">
          <div className="segmented" role="group" aria-label={t('custMsg.list.scope')}>
            {['all', 'mine', 'waiting'].map((v) => (
              <button key={v} type="button" className={`segmented-btn ${scope === v ? 'active' : ''}`} aria-pressed={scope === v} onClick={() => pickScope(v)}>
                {scopeLabel(v)}
              </button>
            ))}
          </div>
          <div className="filter-bar">
            <FilterSelect ariaLabel={t('custMsg.filter.manager')} value={managerId} onChange={setManagerId} options={managerOptions} />
            <FilterSelect ariaLabel={t('custMsg.filter.customer')} value={clientFilter} onChange={setClientFilter} options={customerOptions} />
          </div>
          <div className="thread-list-subhead">
            <span className="text-xs text-muted">
              {waitingView ? t('custMsg.list.waitingCount', { count: total }) : t('custMsg.list.count', { count: total })}
            </span>
          </div>
        </div>
        <div className="thread-list-rows">
          {shownError && (
            <div className="form-error">
              {shownError}{' '}
              <button type="button" className="btn btn-link" onClick={() => (waitingView ? loadWaiting() : load())}>{t('common.retry')}</button>
            </div>
          )}
          {!loaded && !shownError && <div className="wo-thread-empty">{t('common.loading')}</div>}
          {loaded && rows.length === 0 && (
            <EmptyState icon={<Icon name="messaging" size={24} />} title={emptyTitle} message={emptyHint} />
          )}
          {rows.map((r) => (
            <ThreadRow
              key={r.clientId} row={r} active={r.clientId === activeId} onSelect={setActive}
              waitingSince={r.waitingSince || waitingByClient.get(r.clientId) || null}
            />
          ))}
          <ListPager pager={pager} noun={t('custMsg.list.noun')} />
        </div>
      </section>
      <div
        className={`msg-pane-handle msg-pane-handle-left ${panes.dragging === 'left' ? 'is-dragging' : ''}`}
        onPointerDown={panes.onDragStart('left')}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('messages.resizeList')}
        title={t('messages.dragToResize')}
      />
      {activeId ? (
        <CustomerThread key={activeId} clientId={activeId} layout="pane" onBack={() => setActive(null)} onActivity={refresh} />
      ) : (
        <section className="message-pane">
          <EmptyState icon={<Icon name="messaging" size={28} />} title={t('custMsg.thread.pick')} message={t('custMsg.thread.pickHint')} />
        </section>
      )}
      <div
        className={`msg-pane-handle msg-pane-handle-right ${panes.dragging === 'right' ? 'is-dragging' : ''}`}
        onPointerDown={panes.onDragStart('right')}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('messages.resizeContext')}
        title={t('messages.dragToResize')}
      />
      {activeClient ? (
        <aside className="context-pane">
          <div className="context-head">
            <Avatar initials={initialsOf(activeClient.name)} variant={(String(activeClient.id).length % 5) + 1} size="md" />
            <div className="context-head-text">
              <Link className="context-head-name" to={`/clients/${encodeURIComponent(activeClient.id)}?tab=messages`} state={nav}>{customerLabel(activeClient)}</Link>
            </div>
          </div>
          <div className="context-body">
            <div className="context-card">
              <div className="context-card-title">{t('custMsg.ctx.title')}</div>
              <dl className="context-dl">
                <div><dt>{t('custMsg.ctx.number')}</dt><dd>{activeClient.customerNumber || <span className="text-muted">—</span>}</dd></div>
                <div><dt>{t('custMsg.ctx.manager')}</dt><dd>{activeManager?.name || <span className="text-muted">{t('custMsg.list.noManager')}</span>}</dd></div>
                <div><dt>{t('custMsg.ctx.audience')}</dt><dd>{t('custMsg.ctx.audienceText')}</dd></div>
              </dl>
            </div>
          </div>
        </aside>
      ) : (
        <aside className="context-pane context-pane-empty">
          <EmptyState message={t('custMsg.thread.pickHint')} />
        </aside>
      )}
    </div>
  );
}
