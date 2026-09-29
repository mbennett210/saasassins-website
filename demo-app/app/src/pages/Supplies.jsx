// Supplies — per-location approved lists + the request queue (S58, direction D:
// the "Swept-familiar" bulk queue). A supervisor requests approved items by qty;
// the office checkboxes the batch and marks it completed (which notifies each
// requester). Two tabs: Requests (In progress / Completed) and Approved items
// (supplies.manage only — the office maintains each location's list).
//
// "Location" is the customer (one location per customer). Prices are internal
// purchasing costs, shown to requesters (Matt's Q5) — NOT customer financials, so
// no invoices.view gate here (see lib/roles.js supplies.* note).
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectSupplyRequests, selectSupplyItemsForClient, selectActiveClients,
  selectClientById, selectUserById,
} from '../store/selectors';
import { SUPERVISOR_ROLES } from '../lib/roles';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { savedMsg } from '../lib/offlineCopy';
import { fmtDate, money } from '../lib/dates';
import { supplyRequestTotal, summarizeLines } from '../lib/supplies';
import Icon from '../components/Icon';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import FormField from '../components/FormField';
import FilterSelect from '../components/FilterSelect';
import SearchSelect from '../components/SearchSelect';
import ConfirmDialog from '../components/ConfirmDialog';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default function Supplies() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const online = useOnlineStatus();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canManage = usePermission('supplies.manage');
  const canRequest = usePermission('supplies.request');

  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'approved' && canManage ? 'approved' : 'requests';
  // Status axis (Swept's In progress / Completed). Filters live in the URL so the
  // back-referrer restores the exact view (repo nav law).
  const status = params.get('status') === 'completed' ? 'completed' : 'open';
  const setParam = (patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => { if (v == null || v === '') next.delete(k); else next.set(k, v); });
    return next;
  }, { replace: true });

  // Account supervisors (the Manager facet) — active owner/admin/manager, the same
  // trio that can be a request's requester. Manager vocab, never "Accounts".
  const managers = useMemo(
    () => (state.users || []).filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)),
    [state.users],
  );
  const activeClients = useMemo(() => selectActiveClients(state), [state]);
  // A deleted requester/completer keeps their name on the request (requestedByName /
  // completedByName), so the list never shows them as "—".
  const liveName = (id) => (id ? selectUserById(state, id)?.name || null : null);
  const userName = (id, storedName) => liveName(id) || storedName || '—';
  // Who a completion actually notifies: a LIVE requester other than you (the reducer
  // skips a self-complete, and a deleted requester has no one to notify). The
  // "notified" toasts name only them, so they never claim a notification that didn't go.
  const notifiedName = (id) => (id && id !== currentUser?.id ? liveName(id) : null);

  // Manager filter defaults to SELF for a manager who supervises accounts (their
  // own queue first); everyone else defaults to all. Read from the URL, else default.
  const iSupervise = useMemo(
    () => (state.clients || []).some((c) => c.supervisorId === currentUser?.id),
    [state.clients, currentUser],
  );
  const mgrParam = params.get('mgr');
  const mgrFilter = mgrParam != null ? mgrParam : (currentUser?.role === 'manager' && iSupervise ? currentUser.id : '');
  const custFilter = params.get('cust') || '';

  const allRequests = useMemo(() => selectSupplyRequests(state), [state]);
  const rows = useMemo(() => allRequests.filter((r) => {
    if (r.status !== status) return false;
    if (mgrFilter && r.requestedByUserId !== mgrFilter) return false;
    if (custFilter && r.clientId !== custFilter) return false;
    return true;
  }), [allRequests, status, mgrFilter, custFilter]);

  const openCount = allRequests.filter((r) => r.status === 'open').length;
  const doneCount = allRequests.length - openCount;

  const pager = usePagedRows(rows, { param: 'page' });
  const [checked, setChecked] = useState({}); // id → true
  const [detailId, setDetailId] = useState(null);
  const [reqOpen, setReqOpen] = useState(false);
  // Global search "Request supplies" deep-link: ?new=1 opens the request modal once, then
  // strips only that param (any ?tab / ?status stays). Gated on canRequest.
  useEffect(() => {
    if (params.get('new') && canRequest) {
      setReqOpen(true);
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  }, [params, canRequest, setParams]);
  const [confirmCancel, setConfirmCancel] = useState(null);

  // Selection operates on the visible page (what the checkbox column shows); totals
  // and counts read the full filtered set.
  const pageIds = pager.pageRows.map((r) => r.id);
  const checkedRows = pager.pageRows.filter((r) => checked[r.id]);
  const allPageChecked = pageIds.length > 0 && pageIds.every((id) => checked[id]);
  const toggleAll = () => setChecked((c) => {
    const next = { ...c };
    if (allPageChecked) pageIds.forEach((id) => { delete next[id]; });
    else pageIds.forEach((id) => { next[id] = true; });
    return next;
  });
  const toggleOne = (id) => setChecked((c) => { const n = { ...c }; if (n[id]) delete n[id]; else n[id] = true; return n; });
  const clearChecked = () => setChecked({});

  function completeOne(id, name) {
    dispatch({ type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id });
    setChecked((c) => { const n = { ...c }; delete n[id]; return n; });
    toast.success(savedMsg(online, name ? `Request completed — ${name} notified` : 'Request completed'));
  }
  function completeBatch() {
    const ids = checkedRows.map((r) => r.id);
    if (!ids.length) return;
    const names = new Set(checkedRows.map((r) => notifiedName(r.requestedByUserId)).filter(Boolean));
    ids.forEach((id) => dispatch({ type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id }));
    clearChecked();
    const notified = names.size ? ` — ${names.size} requester${names.size > 1 ? 's' : ''} notified` : '';
    toast.success(savedMsg(online, ids.length === 1
      ? `Request completed${names.size ? ' — requester notified' : ''}`
      : `${ids.length} requests completed${notified}`));
  }
  function reopen(id) {
    dispatch({ type: ACTIONS.REOPEN_SUPPLY_REQUEST, id });
    toast.info('Request reopened');
  }
  function cancel(id) {
    dispatch({ type: ACTIONS.DELETE_SUPPLY_REQUEST, id });
    setConfirmCancel(null);
    setDetailId(null);
    toast.success('Request cancelled');
  }

  const detail = detailId ? allRequests.find((r) => r.id === detailId) : null;

  return (
    <div className="page">
      <div className="page-head sup-head">
        <div>
          <h1>Supplies</h1>
          <p className="page-sub"><strong>{openCount}</strong> open · {doneCount} completed in the last 90 days</p>
        </div>
        {canRequest && (
          <button className="btn btn-primary" onClick={() => setReqOpen(true)}>Request supplies</button>
        )}
      </div>

      <div className="section-tabs" role="tablist" aria-label="Supplies views">
        <button type="button" role="tab" aria-selected={tab === 'requests'} className={`section-tab ${tab === 'requests' ? 'active' : ''}`} onClick={() => setParam({ tab: null })}>Requests</button>
        {canManage && (
          <button type="button" role="tab" aria-selected={tab === 'approved'} className={`section-tab ${tab === 'approved' ? 'active' : ''}`} onClick={() => setParam({ tab: 'approved' })}>Approved items</button>
        )}
      </div>

      {tab === 'requests' ? (
        <RequestsView
          {...{ status, setParam, managers, currentUser, activeClients, mgrFilter, custFilter,
            rows, pager, canManage, checked, allPageChecked, toggleAll, toggleOne, checkedRows,
            completeBatch, completeOne, reopen, clearChecked, userName, notifiedName, nav, state,
            openCount, doneCount, setDetailId, setConfirmCancel }}
        />
      ) : (
        <ApprovedView state={state} dispatch={dispatch} toast={toast} activeClients={activeClients} custFilter={custFilter} setParam={setParam} />
      )}

      {reqOpen && (
        <RequestModal
          state={state} dispatch={dispatch} toast={toast} online={online} currentUser={currentUser}
          activeClients={activeClients} canManage={canManage} onClose={() => setReqOpen(false)}
        />
      )}

      {detail && (
        <DetailModal
          request={detail} state={state} userName={userName} canManage={canManage}
          isOwnOpen={detail.status === 'open' && detail.requestedByUserId === currentUser?.id}
          onComplete={() => { completeOne(detail.id, notifiedName(detail.requestedByUserId)); setDetailId(null); }}
          onReopen={() => { reopen(detail.id); setDetailId(null); }}
          onCancel={() => setConfirmCancel(detail)}
          onClose={() => setDetailId(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmCancel}
        title="Cancel this request?"
        message="This removes the request from the queue. It cannot be undone."
        confirmLabel="Cancel request"
        variant="danger"
        onConfirm={() => confirmCancel && cancel(confirmCancel.id)}
        onClose={() => setConfirmCancel(null)}
      />
    </div>
  );
}

// ── Requests view (Swept-familiar bulk queue) ───────────────────────────────────
function RequestsView({
  status, setParam, managers, currentUser, activeClients, mgrFilter, custFilter,
  rows, pager, canManage, checked, allPageChecked, toggleAll, toggleOne, checkedRows,
  completeBatch, completeOne, reopen, clearChecked, userName, notifiedName, nav, state,
  openCount, doneCount, setDetailId, setConfirmCancel,
}) {
  const isOpen = status === 'open';
  const mgrOptions = [
    { value: '', label: 'All managers' },
    ...managers.map((m) => ({ value: m.id, label: m.id === currentUser?.id ? `${m.name} (me)` : m.name })),
  ];
  const custOptions = [
    { value: '', label: 'All customers' },
    ...activeClients
      .filter((c) => !mgrFilter || c.supervisorId === mgrFilter)
      .map((c) => ({ value: c.id, label: c.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const batchTotal = round2(checkedRows.reduce((a, r) => a + supplyRequestTotal(r), 0));

  return (
    <>
      <div className="filter-bar">
        <FormField label="Status">
          <div className="tab-container-line" role="group" aria-label="Status">
            <button type="button" className={`tab-btn ${isOpen ? 'active' : ''}`} onClick={() => setParam({ status: null, page: null })}>In progress ({openCount})</button>
            <button type="button" className={`tab-btn ${!isOpen ? 'active' : ''}`} onClick={() => setParam({ status: 'completed', page: null })}>Completed ({doneCount})</button>
          </div>
        </FormField>
        <FormField label="Manager"><FilterSelect ariaLabel="Manager" value={mgrFilter} onChange={(v) => setParam({ mgr: v, cust: null, page: null })} options={mgrOptions} /></FormField>
        <FormField label="Customer"><FilterSelect ariaLabel="Customer" value={custFilter} onChange={(v) => setParam({ cust: v, page: null })} options={custOptions} /></FormField>
      </div>

      {isOpen && canManage && checkedRows.length > 0 && (
        <div className="sup-bulkbar">
          <strong>{checkedRows.length} selected · {money(batchTotal)}</strong>
          <button className="btn btn-success" onClick={completeBatch}><Icon name="check" size={15} /> Mark completed</button>
          <button className="btn btn-link" onClick={clearChecked}>Clear</button>
        </div>
      )}

      <div className="table-wrap mobile-stack">
        <table>
          <thead>
            <tr>
              {isOpen && canManage && (
                <th className="sup-check-col">
                  <input type="checkbox" className="sup-check" aria-label="Select all on page" checked={allPageChecked} onChange={toggleAll} />
                </th>
              )}
              <th>Request</th>
              <th>Customer</th>
              <th>Requested by</th>
              <th>Est. cost</th>
              <th>Date</th>
              {!isOpen && <th>Completed</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="stack-plain"><td colSpan={8} className="sup-empty">
                {isOpen ? 'No open requests. When a supervisor requests supplies, they land here.' : 'No completed requests in the last 90 days.'}
              </td></tr>
            ) : pager.pageRows.map((r) => {
              const client = selectClientById(state, r.clientId);
              return (
                <tr key={r.id} className="sup-row" onClick={() => setDetailId(r.id)}>
                  {isOpen && canManage && (
                    <td className="sup-check-col" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="sup-check" aria-label={`Select request for ${client?.name || 'location'}`} checked={!!checked[r.id]} onChange={() => toggleOne(r.id)} />
                    </td>
                  )}
                  <td className="cell-primary sup-req-cell">
                    <span className="truncate" title={summarizeLines(r.lines)}>{summarizeLines(r.lines) || '—'}</span>
                    {r.note ? <div className="text-xs text-muted truncate sup-line-sub" title={r.note}>“{r.note}”</div> : null}
                  </td>
                  <td data-label="Customer">{client
                    ? <Link className="linklike truncate" to={`/clients/${client.id}`} state={nav} title={client.name} onClick={(e) => e.stopPropagation()}>{client.name}</Link>
                    : <span className="truncate">—</span>}</td>
                  <td data-label="Requested by"><span className="truncate" title={userName(r.requestedByUserId, r.requestedByName)}>{userName(r.requestedByUserId, r.requestedByName)}</span></td>
                  <td data-label="Est. cost" className="sup-money">{money(supplyRequestTotal(r))}</td>
                  <td data-label="Date">{r.createdAt ? fmtDate(r.createdAt) : '—'}</td>
                  {!isOpen && <td data-label="Completed">{r.completedAt ? fmtDate(r.completedAt) : '—'}</td>}
                  <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    {isOpen && canManage && <button className="btn btn-success btn-sm" onClick={() => completeOne(r.id, notifiedName(r.requestedByUserId))}>Complete</button>}
                    {isOpen && !canManage && r.requestedByUserId === currentUser?.id && <button className="btn btn-link btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setConfirmCancel(r)}>Cancel</button>}
                    {!isOpen && canManage && <button className="btn btn-link btn-sm" onClick={() => reopen(r.id)}>Reopen</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ListPager pager={pager} noun="requests" />
      </div>
    </>
  );
}

// ── Approved items (office maintains each location's list) ───────────────────────
function ApprovedView({ state, dispatch, toast, activeClients, custFilter, setParam }) {
  const clientId = custFilter || (activeClients[0] && activeClients[0].id) || '';
  const items = useMemo(() => selectSupplyItemsForClient(state, clientId), [state, clientId]);
  const pager = usePagedRows(items, { param: 'page' });
  const [form, setForm] = useState({ name: '', unit: '', price: '' });
  const [confirmRm, setConfirmRm] = useState(null);
  const client = selectClientById(state, clientId);

  const custOptions = activeClients.map((c) => ({ value: c.id, label: c.name })).sort((a, b) => a.label.localeCompare(b.label));

  function add() {
    const name = form.name.trim();
    const price = parseFloat(String(form.price).replace(/[^0-9.]/g, ''));
    if (!name) { toast.error('Give the item a name.'); return; }
    if (!(price > 0)) { toast.error('Enter a price.'); return; }
    dispatch({ type: ACTIONS.ADD_SUPPLY_ITEM, item: { clientId, name, unit: form.unit.trim(), unitPrice: price } });
    setForm({ name: '', unit: '', price: '' });
    toast.success(`“${name}” added to ${client?.name || 'this location'}`);
  }

  return (
    <>
      <div className="filter-bar">
        <FormField label="Customer"><FilterSelect ariaLabel="Customer" value={clientId} onChange={(v) => setParam({ cust: v, page: null })} options={custOptions} /></FormField>
        <div className="sup-appr-count">{items.length} approved item{items.length === 1 ? '' : 's'} · what the supervisor can request</div>
      </div>

      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>Item</th><th>Unit</th><th>Price</th><th></th></tr></thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="stack-plain"><td colSpan={4} className="sup-empty">No approved supplies for this location yet. Add the items the supervisor can request.</td></tr>
            ) : pager.pageRows.map((it) => (
              <tr key={it.id}>
                <td className="cell-primary" style={{ fontWeight: 600 }}><span className="truncate" title={it.name}>{it.name}</span></td>
                <td data-label="Unit"><span className="truncate text-muted" title={it.unit || 'each'}>{it.unit || 'each'}</span></td>
                <td data-label="Price" className="sup-money">{money(it.unitPrice)}</td>
                <td className="cell-actions" style={{ textAlign: 'right' }}>
                  <button className="btn btn-link btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setConfirmRm(it)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ListPager pager={pager} noun="items" />
      </div>

      <div className="sup-addrow">
        <input className="input sup-add-name" placeholder="Item name (e.g. Glass cleaner 32 oz)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input className="input sup-add-unit" placeholder="Unit (each)" value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} />
        <input className="input sup-add-price" inputMode="decimal" placeholder="$ 0.00" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn btn-success" onClick={add}>Add item</button>
      </div>
      <p className="hint sup-hint">Requests already submitted keep their snapshot of an item’s name and price — edits here never rewrite history.</p>

      <ConfirmDialog
        open={!!confirmRm}
        title="Remove this item?"
        message="It won’t be requestable for this location. Submitted requests keep their copy."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => { if (confirmRm) { dispatch({ type: ACTIONS.DELETE_SUPPLY_ITEM, id: confirmRm.id }); toast.success('Item removed'); } setConfirmRm(null); }}
        onClose={() => setConfirmRm(null)}
      />
    </>
  );
}

// ── Request modal (supervisor requests approved items by qty) ────────────────────
function RequestModal({ state, dispatch, toast, online, currentUser, activeClients, canManage, onClose }) {
  // Current user's supervised customers sort first.
  const clientOptions = useMemo(() => {
    const mine = (c) => (c.supervisorId === currentUser?.id ? 0 : 1);
    return activeClients
      .slice()
      .sort((a, b) => mine(a) - mine(b) || a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name }));
  }, [activeClients, currentUser]);

  const [clientId, setClientId] = useState(clientOptions[0]?.value || null);
  const [qtys, setQtys] = useState({}); // itemId → qty
  const [note, setNote] = useState('');

  const items = useMemo(() => selectSupplyItemsForClient(state, clientId), [state, clientId]);
  // Duplicate-order guard: qty already on an OPEN request for this location, by item name.
  const pending = useMemo(() => {
    const m = {};
    (state.supplyRequests || []).forEach((r) => {
      if (r.status === 'open' && r.clientId === clientId) (r.lines || []).forEach((l) => { m[l.name] = (m[l.name] || 0) + l.qty; });
    });
    return m;
  }, [state.supplyRequests, clientId]);

  const bump = (id, d) => setQtys((q) => ({ ...q, [id]: Math.max(0, (q[id] || 0) + d) }));
  const lines = items.filter((it) => (qtys[it.id] || 0) > 0).map((it) => ({ itemId: it.id, name: it.name, qty: qtys[it.id], unitPrice: it.unitPrice }));
  const total = round2(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0));

  function submit() {
    if (!clientId) { toast.error('Pick a location.'); return; }
    if (!lines.length) { toast.error('Add at least one item.'); return; }
    dispatch({ type: ACTIONS.ADD_SUPPLY_REQUEST, request: { clientId, lines, note } });
    onClose();
    toast.success(savedMsg(online, 'Request submitted — the office has been notified'));
  }

  return (
    <Modal open onClose={onClose} title="Request supplies">
      <FormField label="Location">
        <SearchSelect value={clientId} onChange={(id) => { setClientId(id || null); setQtys({}); }} options={clientOptions} placeholder="Pick a location…" searchPlaceholder="Search locations…" />
      </FormField>
      <label className="form-label sup-modal-label">Approved supplies</label>
      <div className="sup-items">
        {items.length === 0 ? (
          <div className="sup-items-empty">
            No approved supplies for this location yet.
            {canManage ? <div className="text-xs text-muted sup-modal-sub">Add items on the Approved items tab.</div> : null}
          </div>
        ) : items.map((it) => {
          const q = qtys[it.id] || 0;
          return (
            <div key={it.id} className={`sup-item ${q > 0 ? 'picked' : ''}`}>
              <div className="sup-item-nm">
                <b>{it.name}</b>
                {pending[it.name] ? <span className="sup-pending" title="Already on an open request for this location">pending ×{pending[it.name]}</span> : null}
                <span>{(it.unit || 'each')} · {money(it.unitPrice)}</span>
              </div>
              <div className="sup-step">
                <button type="button" className="btn-icon" onClick={() => bump(it.id, -1)} disabled={q === 0} aria-label={`Decrease ${it.name}`}>−</button>
                <span className="sup-qv">{q}</span>
                <button type="button" className="btn-icon" onClick={() => bump(it.id, 1)} aria-label={`Increase ${it.name}`}>+</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="sup-total"><span>Estimated total</span><b>{money(total)}</b></div>
      <FormField label="Note for the office (optional)">
        <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the office should know?" />
      </FormField>
      <div className="sup-modal-foot">
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-success" onClick={submit} disabled={!lines.length}>Submit request</button>
      </div>
    </Modal>
  );
}

// ── Read-only detail modal (row click) ───────────────────────────────────────────
function DetailModal({ request, state, userName, canManage, isOwnOpen, onComplete, onReopen, onCancel, onClose }) {
  const r = request;
  const client = selectClientById(state, r.clientId);
  const open = r.status === 'open';
  return (
    <Modal open onClose={onClose} title={client ? client.name : 'Supply request'}>
      <div className="text-xs text-muted sup-detail-meta">
        Requested by {userName(r.requestedByUserId, r.requestedByName)} · {r.createdAt ? fmtDate(r.createdAt) : '—'}
        {!open && r.completedAt ? ` · completed ${fmtDate(r.completedAt)} by ${userName(r.completedByUserId, r.completedByName)}` : ''}
      </div>
      <div className="sup-detail-badge"><Badge variant={open ? 'amber' : 'green'}>{open ? 'Open' : 'Completed'}</Badge></div>
      <div className="sup-items">
        {r.lines.map((l, i) => (
          <div key={i} className="sup-item">
            <div className="sup-item-nm"><b>{l.name}</b><span>{money(l.unitPrice)} each</span></div>
            <div className="text-muted" style={{ whiteSpace: 'nowrap' }}>×{l.qty}</div>
            <div className="sup-money sup-line-total">{money(round2(l.qty * l.unitPrice))}</div>
          </div>
        ))}
      </div>
      {r.note ? <div className="sup-note">“{r.note}”</div> : null}
      <div className="sup-total"><span>Estimated total</span><b>{money(supplyRequestTotal(r))}</b> </div>
      <div className="sup-modal-foot">
        {open && (isOwnOpen || canManage) && <button className="btn btn-link" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={onCancel}>Cancel request</button>}
        <button className="btn btn-outline" onClick={onClose}>Close</button>
        {open && canManage && <button className="btn btn-success" onClick={onComplete}><Icon name="check" size={15} /> Complete</button>}
        {!open && canManage && <button className="btn btn-outline" onClick={onReopen}>Reopen</button>}
      </div>
    </Modal>
  );
}
