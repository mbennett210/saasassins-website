// Work Orders — the client-raised ticketing queue inside the Quality hub (the
// evolved "Problems" surface). White command bar (click-to-filter, synced with the
// chips), queue scoping by account supervisor (client.supervisorId — a manager
// lands on their own queue, admin/owner see all; crew are server-scoped), a
// grouped-by-location list, and a detail drawer with status / assign / escalate
// controls + completion photos. Records are relational (qcApi → /api/qc or the demo
// stub); the message thread + the Complaints fold-in land in later increments.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import { selectClientById, selectUserById, selectActiveUsers } from '../store/selectors';
import { SUPERVISOR_ROLES } from '../lib/roles';
import * as qcApi from '../lib/qcApi';
import { fmtDate } from '../lib/dates';
import {
  toWorkOrder, deriveSla, isBreaching, isOpenStatus, nextStatus,
  woStatusLabel, woPriorityLabel, woPriorityRank, woTypeLabel,
  WO_STATUS_META, WO_PRIORITY_META, WO_TYPE_META, WO_PRIORITIES,
} from '../lib/workOrders';
import Badge from './Badge';
import Icon from './Icon';
import Avatar from './Avatar';
import EmptyState from './EmptyState';
import SearchSelect from './SearchSelect';
import MediaGallery from './MediaGallery';
import WorkOrderModal from './WorkOrderModal';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';

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
  breaching: 'Filtered to breaching / at-risk SLA.', resolved: 'Filtered to resolved (last 24h).',
  awaiting_client: 'Filtered to awaiting client.', unassigned: 'Filtered to unassigned.',
};
const initialsOf = (name) => (name || '').split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const fmtMsgTime = (iso) => { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

// One message in the work-order thread. Client messages sit left (gold), office/crew
// right (ink). translated_body renders the auto-translation under the original.
function WorkOrderMessage({ m }) {
  const client = m.author_role === 'client';
  return (
    <div className={`wo-msg ${client ? 'client' : 'us'}`}>
      <span className={`wo-msg-av ${client ? 'client' : ''}`}>{initialsOf(m.author_name) || (client ? 'C' : 'S')}</span>
      <div className="wo-bub">
        <div className="wo-msg-who">{m.author_name || (client ? 'Client' : 'Staff')}</div>
        <div>{m.body}</div>
        {m.translated_body && <div className="wo-trans">“{m.translated_body}” · auto-translated from {m.from_lang}</div>}
        <div className="wo-msg-at">{fmtMsgTime(m.created_at)}</div>
      </div>
    </div>
  );
}

export default function WorkOrdersPanel({ canManage }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const canReport = usePermission('problems.manage');
  const toast = useToast();
  const isSupervisor = !!currentUser && SUPERVISOR_ROLES.includes(currentUser.role);

  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('all');
  const [groupBy, setGroupBy] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Queue = account supervisor. Only managers who actually hold accounts are queues.
  const managers = useMemo(
    () => selectActiveUsers(state).filter((u) => SUPERVISOR_ROLES.includes(u.role) && (state.clients || []).some((c) => c.supervisorId === u.id)),
    [state],
  );
  const myQueueDefault = useMemo(
    () => (isSupervisor && managers.some((m) => m.id === currentUser.id) ? currentUser.id : 'all'),
    [isSupervisor, managers, currentUser],
  );
  const [queue, setQueue] = useState('all');
  useEffect(() => { setQueue(myQueueDefault); }, [myQueueDefault]);

  const load = useCallback(async () => {
    setErr(null);
    try { setRows(await qcApi.listProblems({})); }
    catch (e) { setErr(e.message || 'Could not load work orders'); setRows([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const supervisorOf = useCallback((clientId) => (clientId ? selectClientById(state, clientId)?.supervisorId || null : null), [state]);

  const scoped = useMemo(() => {
    const all = (rows || []).map(toWorkOrder);
    return queue === 'all' ? all : all.filter((w) => supervisorOf(w.client_id) === queue);
  }, [rows, queue, supervisorOf]);
  const withSla = useMemo(
    () => scoped.map((w) => ({ ...w, sla: deriveSla({ dueAt: w.due_at, status: w.status, resolvedAt: w.resolved_at }) })),
    [scoped],
  );

  const counts = useMemo(() => {
    const c = { all: withSla.length, open: 0, escalated: 0, breaching: 0, resolved: 0, awaiting_client: 0, unassigned: 0 };
    for (const w of withSla) {
      if (isOpenStatus(w.status)) c.open += 1;
      if (w.escalated) c.escalated += 1;
      if (isBreaching(w.sla.state)) c.breaching += 1;
      if (w.status === 'resolved') c.resolved += 1;
      if (w.status === 'awaiting_client') c.awaiting_client += 1;
      if (!w.assignee_user_id && isOpenStatus(w.status)) c.unassigned += 1;
    }
    return c;
  }, [withSla]);

  const matches = useCallback((w) => {
    switch (filter) {
      case 'open': return isOpenStatus(w.status);
      case 'escalated': return w.escalated;
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
    const arr = withSla.filter(matches).slice();
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
  }, [withSla, matches, groupBy]);
  const groupCounts = useMemo(() => {
    const m = {};
    for (const w of filtered) { const k = w.client_id || w.site_id || '_none'; m[k] = (m[k] || 0) + 1; }
    return m;
  }, [filtered]);

  const pager = usePagedRows(filtered, { resetKey: `${filter}|${queue}|${groupBy}` });
  const setF = (f) => setFilter((cur) => (f !== 'all' && cur === f ? 'all' : f));

  const clientName = (w) => w.client_name || (w.client_id ? selectClientById(state, w.client_id)?.name : null) || w.site_name || '—';
  const userName = (id) => (id ? selectUserById(state, id)?.name : null) || null;
  const update = async (id, patch) => { try { await qcApi.updateProblem({ id, ...patch }); await load(); } catch (e) { toast.error(e.message || 'Update failed'); } };

  const selected = openId ? withSla.find((w) => w.id === openId) : null;

  const woRow = (w) => (
    <tr key={w.id} className="wo-rowlink" onClick={() => setOpenId(w.id)}>
      <td data-label="Priority"><span className={`wo-pri pri-${w.priority}`}><span className="wo-dot" />{woPriorityLabel(w.priority)}</span></td>
      <td className="cell-primary">
        <div className="truncate" style={{ fontWeight: 600 }} title={w.title}>{w.title}</div>
        <div className="wo-subline">
          <Badge variant={WO_TYPE_META[w.type]?.badge || 'slate'}>{woTypeLabel(w.type)}</Badge>
          <span className={`wo-origin ${w.origin}`}>{w.origin === 'portal' ? '◆ Client portal' : 'Internal'}</span>
        </div>
      </td>
      {!groupBy && <td data-label="Location"><span className="truncate" title={clientName(w)}>{clientName(w)}</span></td>}
      <td data-label="Assignee">{w.assignee_user_id
        ? <span className="wo-assignee"><Avatar initials={initialsOf(userName(w.assignee_user_id))} size="xs" /></span>
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

      {selected && (
        <>
          <div className="wo-drawer-backdrop" onClick={() => setOpenId(null)} />
          <aside className="wo-drawer" aria-label="Work order detail">
            <WorkOrderDetail
              wo={selected} state={state} canManage={canManage} onClose={() => setOpenId(null)}
              onUpdate={update} onRefresh={load} clientName={clientName(selected)} supervisorName={userName(supervisorOf(selected.client_id))}
            />
          </aside>
        </>
      )}

      <WorkOrderModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); load(); }} />
    </>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────
function WorkOrderDetail({ wo, state, canManage, onClose, onUpdate, onRefresh, clientName, supervisorName }) {
  const { currentUser } = useAuth();
  const toast = useToast();
  const assignable = useMemo(() => selectActiveUsers(state), [state]);
  const assigneeName = wo.assignee_user_id ? (selectUserById(state, wo.assignee_user_id)?.name || null) : null;
  const next = nextStatus(wo.status);
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const loadMsgs = useCallback(() => { qcApi.listWorkOrderMessages(wo.id).then(setMessages).catch(() => setMessages([])); }, [wo.id]);
  useEffect(() => { setMessages(null); loadMsgs(); }, [loadMsgs]);
  const send = async () => {
    const b = draft.trim();
    if (!b || sending) return;
    setSending(true);
    try {
      await qcApi.addWorkOrderMessage({ problemId: wo.id, body: b, authorUserId: currentUser?.id || null, authorRole: currentUser?.role === 'crew' ? 'crew' : 'office', authorName: currentUser?.name || null });
      setDraft(''); loadMsgs(); onRefresh && onRefresh(); // reload the list — status may have auto-advanced
    } catch (e) { toast.error(e.message || 'Could not send the message'); } finally { setSending(false); }
  };
  return (
    <>
      <div className="wo-dh">
        <div className="wo-dh-top">
          <span className="mono wo-dh-id">{wo.id?.startsWith('pr_') ? 'WO' : ''} · {fmtDate(wo.created_at)}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <h3 className="wo-dh-title">{wo.title}</h3>
        <div className="wo-dh-acct">{clientName}</div>
        <div className="wo-dh-badges">
          {wo.escalated && <span className="wo-esc-ribbon"><Icon name="warning" size={12} /> Escalated</span>}
          <Badge variant={WO_STATUS_META[wo.status]?.badge || 'slate'}>{woStatusLabel(wo.status)}</Badge>
          <span className={`wo-pri pri-${wo.priority}`}><span className="wo-dot" />{woPriorityLabel(wo.priority)}</span>
          <Badge variant={WO_TYPE_META[wo.type]?.badge || 'slate'}>{woTypeLabel(wo.type)}</Badge>
          <span className={`wo-origin ${wo.origin}`}>{wo.origin === 'portal' ? '◆ Client portal' : 'Internal'}</span>
        </div>
      </div>

      <div className="wo-dmeta">
        <div><div className="wo-k">Queue / supervisor</div><div className="wo-v">{supervisorName || '—'}</div></div>
        <div><div className="wo-k">SLA</div><div className="wo-v"><span className={`wo-sla sla-${wo.sla.state}`}>{wo.sla.label}</span></div></div>
        <div>
          <div className="wo-k">Assignee</div>
          <div className="wo-v">
            {canManage ? (
              <SearchSelect
                value={wo.assignee_user_id || ''}
                onChange={(id) => onUpdate(wo.id, { assigneeUserId: id || null })}
                options={assignable.map((u) => ({ value: u.id, label: u.name }))}
                placeholder="Unassigned" searchPlaceholder="Assign to…"
              />
            ) : (assigneeName || 'Unassigned')}
          </div>
        </div>
        {canManage && (
          <div>
            <div className="wo-k">Priority</div>
            <div className="wo-v">
              <select className="input" value={wo.priority} onChange={(e) => onUpdate(wo.id, { priority: e.target.value })}>
                {WO_PRIORITIES.map((p) => <option key={p} value={p}>{WO_PRIORITY_META[p].label}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {wo.description && <div className="wo-dsec"><div className="wo-k">Details</div><p className="wo-desc">{wo.description}</p></div>}

      <div className="wo-dsec">
        <div className="wo-thread-head">
          <div className="wo-k">Messages</div>
          {wo.origin === 'portal' && <span className="wo-shared">◆ Shared with {clientName} in the portal</span>}
        </div>
        <div className="wo-thread">
          {messages === null ? <div className="wo-thread-empty">Loading…</div>
            : messages.length === 0 ? <div className="wo-thread-empty">No messages yet.{wo.origin === 'portal' ? ' Reply and the client sees it in their portal.' : ''}</div>
            : messages.map((m) => <WorkOrderMessage key={m.id} m={m} />)}
        </div>
        {canManage && (
          <div className="wo-composer">
            <textarea className="input wo-composer-input" rows={2} placeholder={wo.origin === 'portal' ? 'Reply to the client…' : 'Add a note…'} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={sending || !draft.trim()} onClick={send}>{sending ? 'Sending…' : 'Send'}</button>
          </div>
        )}
      </div>

      <div className="wo-dsec">
        <div className="wo-k">Completion photos</div>
        {wo.site_id ? (
          <MediaGallery siteId={wo.site_id} clientId={wo.client_id} scope="problem_report" refId={wo.id} label="" hint="Before / after photos. Managers and (soon) the client see these on the work order." />
        ) : <p className="text-muted text-sm wo-desc">No location set, so photos can’t be attached.</p>}
      </div>

      {canManage && (
        <div className="wo-dactions">
          {next && <button type="button" className="btn btn-primary" onClick={() => onUpdate(wo.id, { status: next })}><Icon name="chevronRight" size={14} /> {woStatusLabel(next)}</button>}
          {!wo.escalated && isOpenStatus(wo.status) && <button type="button" className="btn wo-btn-danger" onClick={() => onUpdate(wo.id, { escalated: true })}><Icon name="warning" size={14} /> Escalate</button>}
          {wo.escalated && <button type="button" className="btn btn-outline" onClick={() => onUpdate(wo.id, { escalated: false })}>De-escalate</button>}
          {wo.status !== 'resolved'
            ? <button type="button" className="btn btn-primary" onClick={() => onUpdate(wo.id, { status: 'resolved' })}>Mark resolved</button>
            : <button type="button" className="btn btn-outline" onClick={() => onUpdate(wo.id, { status: 'open' })}>Reopen</button>}
        </div>
      )}
    </>
  );
}
