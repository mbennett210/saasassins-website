// THE ORDER QUEUE (S131, plan docs/plans/2026-10-14-supply-orders.md §4; Matt's boards sm-web-01 /
// sm-mobile-01) — ONE list implementation, read by the Supplies page's Requests tab (every tab) and
// the Supply Manager's Home (pages/SupplyHome: approved onward). Never a second list (II.5).
//
// The status tabs (lib/supplies SUPPLY_QUEUE_TABS: Pending approval · New · With supplier · Partially
// fulfilled · Completed · Declined) live in the URL (?status=), with their counts. One server page of
// 20 with its total (GET /api/supplies/orders), and a search that finds an order by its NUMBER
// ("SO-1047"), its building or an item. A row opens the order page (/supplies/orders/:id).
//
// 🔴 SUP-11 + S131: the bulk bar acts on THIS tab only — Approve on Pending approval (only the rows
// this viewer may decide, lib/supplies maySupplyDecide: the building's account manager, their
// operations manager, the owner or an admin; never the Supply Manager), "Submit to supplier (N)" on
// New (supplies.manage). A row the viewer may not decide shows no Approve / Decline, says who it is
// waiting on in visible words (§118), and is never selectable. "Select all N" takes every match of
// the filtered set (the route's `matches`), split into calls of SUPPLY_DECIDE_MAX.
//
// Each status is worded for the office (lib/supplies supplyOrderLabelKey), in the badge colour every
// screen uses (supplyOrderVariant). The columns are the board's — Order · Customer · Items · Requested
// · Status — and the order's ESTIMATED cost (what was asked for, at the prices frozen on it, the same
// figure the customer's Supplies tab shows) sits under its items at every status; what was delivered
// is the order page's (CS-789).
//
// LANGUAGES (CS-193, UI_RULES §140): every word is a catalog line (`supplyPage.*`). People's own
// words — item names, notes, names — travel as written.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useStore } from '../store';
import { selectClientById } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useTableSearch } from '../hooks/useTableSearch';
import { useServerPager } from '../hooks/useServerPager';
import { useSupplyLinesText } from '../hooks/useSupplyLinesText';
import { useSupplyMoves } from '../hooks/useSupplyMoves';
import { useSupplyRules } from '../hooks/useSupplyRules';
import { useToast } from './Toast';
import { money } from '../lib/dates';
import { customerLabel } from '../lib/customerNumber';
import {
  supplyRequestTotal, SUPPLY_STATUS, SUPPLY_QUEUE_TABS, SUPPLY_QUEUE_TAB_KEYS, SUPPLY_HISTORY_MONTHS,
  supplyOrderNo, supplyOrderLabelKey, supplyOrderVariant,
} from '../lib/supplies';
import * as suppliesApi from '../lib/suppliesApi';
import Icon from './Icon';
import Badge from './Badge';
import ConfirmDialog from './ConfirmDialog';
import EmptyState from './EmptyState';
import TableSearch from './TableSearch';
import ListPager from './ListPager';
import SupplyDeclineModal from './SupplyDeclineModal';
import { useT } from '../i18n/react';

// The empty queue, in each tab's own words.
const EMPTY_KEY = {
  open: ['supplyPage.empty.requested', 'supplyPage.empty.requestedHint'],
  approved: ['supplyPage.empty.approved', 'supplyPage.empty.approvedHint'],
  sent: ['supplyPage.empty.sent', 'supplyPage.empty.sentHint'],
  partial: ['supplyPage.empty.partial', 'supplyPage.empty.partialHint'],
  completed: ['supplyPage.empty.completed', 'supplyPage.empty.completedHint'],
  rejected: ['supplyPage.empty.rejected', 'supplyPage.empty.rejectedHint'],
};
// What a refused cancel says, by the route's code (CS-670: once an order has gone to the supplier it
// can't be cancelled; CS-790: the order moved while the cancel was on its way, so nothing was).
const CANCEL_REFUSAL_KEY = {
  stale: 'supplyPage.toast.cancelStale',
  not_cancellable: 'supplyPage.toast.cancelGoneOut',
  not_found: 'supplyPage.toast.cancelGone',
  not_yours: 'supplyPage.toast.cancelRefused',
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default function SupplyQueue({
  ctx, tabs = SUPPLY_QUEUE_TABS, mgrFilter = '', omFilter = '', custFilter = '', filters = null, budgets = null,
  headExtra = null, reloadKey = 0, onCounts = null, onChanged = null,
}) {
  const t = useT();
  const state = useStore();
  const toast = useToast();
  const nav = useFromHere();
  const navigate = useNavigate();
  const online = useOnlineStatus() !== false;
  const canManage = usePermission('supplies.manage');
  const canApprove = usePermission('supplies.approve');
  const linesText = useSupplyLinesText();

  const [params, setParams] = useSearchParams();
  const status = tabs.includes(params.get('status')) ? params.get('status') : tabs[0];
  const setParam = useCallback((patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => { if (v == null || v === '') next.delete(k); else next.set(k, v); });
    return next;
  }, { replace: true }), [setParams]);

  // SUP-11 + S131 + CS-596: the per-order rules, from the route's own module, with the approver (and
  // their operations manager) resolved exactly as the route resolves them — ONE hook, read by By
  // building's approval cards too (S131 Wave 2).
  const rules = useSupplyRules();
  const { mayDecide } = rules;

  // ── the read (a server page; a new search starts on page 1 in the SAME address update, CS-720) ──
  const [q, setQ] = useTableSearch('q', { reset: ['page'] });
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [queue, setQueue] = useState(null);       // { orders, total, page, pageSize, counts, matches? }
  const [queueErr, setQueueErr] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  // A new search, a page or a reload keeps the rows on screen until the next answer lands (the search
  // box lives in the table's head — blanking the table took the field with it, CS-720). A different
  // view (tab, manager, customer) starts from "Loading…".
  const shownView = useRef(null);
  // `omFilter`: whose team `mgr=team` is when the owner named one (pages/Supplies — S131 Wave 2).
  const viewKey = `${status}|${mgrFilter}|${omFilter}|${custFilter}`;
  useEffect(() => {
    let live = true;
    setQueueErr(null);
    if (shownView.current !== viewKey) { shownView.current = viewKey; setQueue(null); }
    const timer = setTimeout(() => {
      suppliesApi.listOrders({ status, mgr: mgrFilter, cust: custFilter, om: omFilter || null, q, page }, ctx)
        .then((r) => { if (!live) return; setQueue(r); if (onCounts) onCounts(r.counts); })
        .catch((e) => { if (live) setQueueErr(e); });
    }, q ? 250 : 0); // a typed search waits for a pause, the way TableSearch's other readers do
    return () => { live = false; clearTimeout(timer); };
    // ctx carries the store for the demo stub; the real read keys on the filters alone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, mgrFilter, omFilter, custFilter, q, page, tick, reloadKey]);

  const moves = useSupplyMoves({ ctx, onDone: () => { reload(); if (onChanged) onChanged(); } });
  const [declining, setDeclining] = useState(null);   // the order(s) being declined (reason modal)
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  async function cancel(r) {
    if (cancelling) return;
    setCancelling(true);
    try {
      await suppliesApi.cancelRequest(r.id, ctx);
      toast.success(t('supplyPage.toast.cancelled'));
      setConfirmCancel(null);
      reload();
      if (onChanged) onChanged();
    } catch (e) {
      // Each refusal in its own words; an order that moved or is gone re-reads the queue.
      const key = (e && CANCEL_REFUSAL_KEY[e.code]) || (e && e.status === 403 ? 'supplyPage.toast.cancelRefused' : 'supplyPage.toast.failed');
      toast.error(t(key));
      if (e && (e.status === 409 || e.status === 404)) { setConfirmCancel(null); reload(); }
    } finally {
      setCancelling(false);
    }
  }

  // The bulk action on THIS tab (§132).
  const bulkDecision = status === SUPPLY_STATUS.requested && canApprove ? 'approve'
    : (status === SUPPLY_STATUS.approved && canManage ? 'submit' : null);
  const rows = queue ? queue.orders : null;
  const pager = useServerPager(rows, {
    total: queue ? queue.total : 0, page: queue ? queue.page : 1, pageSize: queue ? queue.pageSize : suppliesApi.SUPPLY_PAGE_SIZE,
    setPage: (p) => setParam({ page: p > 1 ? p : null }),
  });
  // Selection: the header box selects the visible page; the bar offers "Select all N", every order in
  // the FILTERED set this viewer may move (a row the viewer may not decide is never selectable).
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => { setSelected(new Set()); }, [status, mgrFilter, custFilter, q, queue]);
  const movable = useCallback((r) => !!bulkDecision && mayDecide(r, bulkDecision), [bulkDecision, mayDecide]);
  const allIds = useMemo(() => (queue && queue.matches ? queue.matches.filter(movable).map((m) => m.id) : []), [queue, movable]);
  const pageRows = pager.pageRows;
  const pageIds = pageRows.filter(movable).map((r) => r.id);
  const n = selected.size;
  const pageAll = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const togglePage = () => setSelected((s) => {
    const next = new Set(s);
    if (pageAll) pageIds.forEach((id) => next.delete(id)); else pageIds.forEach((id) => next.add(id));
    return next;
  });
  const toggleRow = (id) => setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const clearSel = () => setSelected(new Set());
  const selectedRows = [...selected].map((id) => pageRows.find((r) => r.id === id) || { id });
  const batchTotal = round2(pageRows.filter((r) => selected.has(r.id)).reduce((a, r) => a + supplyRequestTotal(r), 0));
  const runBulk = async () => { if (n && await moves.run(selectedRows, bulkDecision)) clearSel(); };
  const showChecks = !!bulkDecision && (allIds.length > 0 || pageIds.length > 0);
  const filteredByFacet = !!(mgrFilter || custFilter);
  const counts = queue ? queue.counts : null;
  const working = moves.working || cancelling;
  const open = (r) => navigate(`/supplies/orders/${encodeURIComponent(r.id)}`, { state: nav });

  return (
    <>
      <div className="tab-container-line supply-status-tabs" role="group" aria-label={t('supplyPage.statusAria')}>
        {tabs.map((s) => (
          <button
            key={s}
            type="button"
            className={`tab-btn ${status === s ? 'active' : ''}`}
            aria-pressed={status === s}
            onClick={() => setParam({ status: s === tabs[0] ? null : s, page: null })}
          >
            {t(SUPPLY_QUEUE_TAB_KEYS[s])}
            {counts && <span className="control-count">{counts[s] || 0}</span>}
          </button>
        ))}
      </div>

      {filters}

      {queueErr ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('supplyPage.loadFailed')}
          message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
          action={<button type="button" className="btn btn-primary" onClick={reload}>{t('supplyPage.tryAgain')}</button>}
        />
      ) : !queue ? (
        <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>
      ) : queue.total === 0 && !q ? (
        filteredByFacet && counts && counts[status] > 0
          ? <EmptyState icon={<Icon name="search" size={28} />} title={t('supplyPage.noMatch')} message={t('supplyPage.noMatchHint')} />
          : <EmptyState icon={<Icon name="box" size={28} />} title={t(EMPTY_KEY[status][0])} message={t(EMPTY_KEY[status][1], { months: SUPPLY_HISTORY_MONTHS })} />
      ) : (
        <>
          {showChecks && (
            <div className={`bulk-bar supply-bulkbar ${n === 0 ? 'is-empty' : ''}`} role="status">
              {n === 0 ? (
                <span>{t(bulkDecision === 'approve' ? 'supplyPage.bulk.hintApprove' : 'supplyPage.bulk.hintSubmit')}</span>
              ) : (
                <>
                  <span>{batchTotal > 0 || selectedRows.every((r) => r.lines)
                    ? t.rich('supplyPage.bulk.selected', { count: n, amount: money(batchTotal) })
                    : t.rich('supplyPage.bulk.selectedNoTotal', { count: n })}</span>
                  {n < allIds.length && (
                    <button type="button" className="btn btn-link" onClick={() => setSelected(new Set(allIds))}>{t('supplyPage.selectAllN', { count: allIds.length })}</button>
                  )}
                  <button type="button" className="btn btn-link" onClick={clearSel}>{t('supplyPage.bulk.clear')}</button>
                  <button type="button" className="btn btn-gold" onClick={runBulk} disabled={working || !online}>
                    <Icon name="check" size={15} /> {t(bulkDecision === 'approve' ? 'supplyPage.bulk.approveN' : 'supplyPage.bulk.submitN', { count: n })}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="table-head">
            <div className="table-controls">
              <TableSearch value={q} onChange={setQ} placeholder={t('supplyPage.searchRequests')} />
              {q && <span className="table-count">{t('supplyPage.matchTotal', { count: queue.total })}</span>}
              <span className="spacer" />
              {headExtra}
            </div>
          </div>

          {queue.total === 0 ? (
            <EmptyState icon={<Icon name="search" size={28} />} title={t('supplyPage.noSearchMatch')} message={t('supplyPage.noSearchMatchHint')} />
          ) : (
            <>
              <div className="table-wrap mobile-stack">
                <table>
                  <thead>
                    <tr>
                      {showChecks && (
                        <th className="supply-select-col">
                          <input
                            type="checkbox"
                            aria-label={t('supplyPage.selectPageAria', { count: pageIds.length })}
                            checked={pageAll}
                            ref={(el) => { if (el) el.indeterminate = n > 0 && !pageAll; }}
                            onChange={togglePage}
                            disabled={pageIds.length === 0}
                          />
                        </th>
                      )}
                      <th>{t('supplyPage.col.order')}</th>
                      <th>{t('supplyPage.col.customer')}</th>
                      <th>{t('supplyPage.col.items')}</th>
                      <th>{t('supplyPage.col.requestedBy')}</th>
                      <th>{t('supplyPage.col.status')}</th>
                      <th className="supply-actions-col"><span className="sr-only">{t('supplyPage.col.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageRows.map((r) => {
                      const client = selectClientById(state, r.clientId);
                      const summary = linesText(r.lines);
                      const no = supplyOrderNo(r);
                      // SUP-11: Approve / Decline only where this viewer may decide THIS order.
                      const isPending = status === SUPPLY_STATUS.requested;
                      const mayApprove = isPending && mayDecide(r, 'approve');
                      const maySubmit = status === SUPPLY_STATUS.approved && mayDecide(r, 'submit');
                      const mayProcess = (status === SUPPLY_STATUS.sent || status === 'partial') && canManage;
                      // CS-596 / CS-670: whoever may cancel THIS order sees the button — and only while
                      // it waits or is approved (never once it has gone to the supplier).
                      const showCancel = rules.mayCancel(r);
                      const waitingOn = isPending && !mayApprove ? rules.approverOf(r.clientId) : null;
                      const requester = r.requestedByName || '—';
                      return (
                        <tr key={r.id} className="supply-row" onClick={() => open(r)}>
                          {showChecks && (
                            <td className="supply-select-col" data-label={t('supplyPage.col.select')} onClick={(e) => e.stopPropagation()}>
                              {movable(r) && (
                                <input type="checkbox" aria-label={t('supplyPage.selectRowAria', { customer: client?.name || '—' })} checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
                              )}
                            </td>
                          )}
                          <td className="cell-primary supply-no-cell">
                            {/* i18n-ok: the order's number, as stored */}
                            <Link className="linklike" to={`/supplies/orders/${encodeURIComponent(r.id)}`} state={nav} onClick={(e) => e.stopPropagation()}>{no ? `#${no}` : t('supplyPage.order.noNumber')}</Link>
                          </td>
                          <td data-label={t('supplyPage.col.customer')}>{client
                            ? <span className="supply-cust-cell">
                              <span className="truncate" title={customerLabel(client)}>{customerLabel(client)}</span>
                              {budgets && budgets.isOver(client.id) && <Badge variant="red">{t('supplyPage.overBudget')}</Badge>}
                            </span>
                            : <span className="truncate">—</span>}</td>
                          <td data-label={t('supplyPage.col.items')} className="supply-req-cell">
                            {/* ONE value: a phone card's cell is a row of its label and its value, so three
                                loose lines would sit side by side there (§24). */}
                            <span className="supply-req-items">
                              <span className="truncate" title={summary}>{summary}</span>
                              {/* The order's estimated cost (what was asked, at its frozen prices) — the same
                                  figure the customer's Supplies tab shows; what arrived is the order page's. */}
                              <span className="text-xs text-muted supply-line-sub supply-money">{t('supplyPage.queue.estCost', { amount: money(supplyRequestTotal(r)) })}</span>
                              {/* i18n-ok: the requester's own note, shown as written */}
                              {r.note ? <span className="text-xs text-muted truncate supply-line-sub" title={r.note}>“{r.note}”</span> : null}
                            </span>
                          </td>
                          <td data-label={t('supplyPage.col.requestedBy')}>
                            <span className="supply-who-cell">
                              {/* i18n-ok: the requester's name, stamped on the order */}
                              <span className="truncate" title={requester}>{requester}</span>
                              <span className="text-xs text-muted">{r.createdAt ? t('supplyPage.queue.when', { when: r.createdAt }) : '—'}</span>
                            </span>
                          </td>
                          <td data-label={t('supplyPage.col.status')}><Badge variant={supplyOrderVariant(r)}>{t(supplyOrderLabelKey(r, 'office'))}</Badge></td>
                          <td className="cell-actions supply-actions-col" onClick={(e) => e.stopPropagation()}>
                            <div className="supply-row-actions">
                              {mayApprove && <>
                                <button type="button" className="btn btn-sm btn-gold" disabled={working || !online} onClick={() => moves.run([r], 'approve')}>{t('supplyPage.approve')}</button>
                                <button type="button" className="btn btn-sm btn-outline" disabled={working || !online} onClick={() => setDeclining([r])}>{t('supplyPage.reject')}</button>
                              </>}
                              {/* §118: not this viewer's to decide — say whose it is, in visible words */}
                              {isPending && !mayApprove && (
                                <span className="text-xs text-muted">{waitingOn ? t('supplyPage.detail.waitingOn', { name: waitingOn.name }) : t('supplyPage.noApprover')}</span>
                              )}
                              {maySubmit && <button type="button" className="btn btn-sm btn-gold" disabled={working || !online} onClick={() => moves.run([r], 'submit')}>{t('supplyPage.submitSupplier')}</button>}
                              {mayProcess && (
                                <Link className="btn btn-sm btn-link" to={`/supplies/orders/${encodeURIComponent(r.id)}`} state={nav}>{t('supplyPage.processOrder')}</Link>
                              )}
                              {showCancel && <button type="button" className="btn btn-sm btn-outline" disabled={working || !online} onClick={() => setConfirmCancel(r)}>{t('supplyPage.cancel')}</button>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ListPager pager={pager} noun={t('pager.noun.orders')} />
            </>
          )}
        </>
      )}

      {declining && (
        <SupplyDeclineModal
          request={declining[0]} working={working}
          onDecline={async (reason) => { if (await moves.run(declining, 'reject', reason)) setDeclining(null); }}
          onClose={() => setDeclining(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmCancel}
        title={t('supplyPage.cancelTitle')}
        message={t('supplyPage.cancelMessage')}
        confirmLabel={t('supplyPage.cancelConfirm')}
        variant="danger"
        onConfirm={() => confirmCancel && cancel(confirmCancel)}
        onClose={() => setConfirmCancel(null)}
      />
    </>
  );
}
