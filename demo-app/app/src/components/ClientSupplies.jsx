// A customer's own Supplies tab (round 3, Daniel 2026-10-06: "the separate supply tab in the
// customer view that B has. Wire it up."). Everything about ONE building's supplies in one place:
//   • four tiles — this month's delivered spend against the budget, what is on order, the next
//     order date (lib/supplies nextSupplyOrderKey, the org's calendar) and who approves;
//   • the office's "Edit budget and order day" (the two fields the Overview card used to edit,
//     written the same way) and the requester's "Request supplies" with this building picked;
//   • "{building}'s supply list" — the items the office SWITCHED ON for it from the master supply
//     list (the Oct 6 call; plan 2026-10-11 §2), each with its SKU under the name, when it was last
//     delivered and how many in the last 3 months (a server aggregate keyed on the catalog item,
//     GET /api/supplies/items?history=1, so an item switched off and back on keeps it — D6). The
//     office's "Edit list" (and, with nothing on, "Set up the list") opens the building's switches
//     (components/SupplyListSwitches); an item's name, SKU and price are edited once, on the
//     Supplies page's Catalog tab. The per-building add / edit / remove went with the master list
//     (II.5);
//   • the building's requests: every open one and its newest settled ones (one complete read).
//
// Read-only for a supervisor: no Edit list, no budget button (supplies.manage only — the server
// is the boundary, api/supplies + orgStateGuard). `?edit=1` opens the switches once for the office
// (the order sheet's "Edit list" / "Set up the list"), then the param is stripped.
//
// LANGUAGES: every word is a catalog line (`supplyPage.cust.*`, `supplyPage.list.*`); item names,
// SKUs, notes and people's names travel as written.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useFromHere } from '../hooks/useFromHere';
import { usePagedRows } from '../hooks/usePagedRows';
import { useSupplyLinesText } from '../hooks/useSupplyLinesText';
import { useToast } from './Toast';
import { fmtDate, money, todayKey } from '../lib/dates';
import { customerLabel } from '../lib/customerNumber';
import { searchRows } from '../lib/searchRows';
import {
  supplyOnOrderCents, nextSupplyOrderKey, supplyOrderDayFor, orgSupplyOrderDay, supplyBudgetFor,
  supplyRequestTotal, supplyOrderNo, supplyOrderLabelKey, supplyOrderVariant,
  MAX_SUPPLY_BUDGET, MAX_SUPPLY_ORDER_DAY,
} from '../lib/supplies';
import * as suppliesApi from '../lib/suppliesApi';
import { resolveSupplyApprover } from '../lib/notifications';
import Badge from './Badge';
import Icon from './Icon';
import Modal from './Modal';
import FormField from './FormField';
import EmptyState from './EmptyState';
import TableSearch from './TableSearch';
import ListPager from './ListPager';
import SupplyRequestModal from './SupplyRequestModal';
import SupplyListSwitches from './SupplyListSwitches';
import { useT } from '../i18n/react';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param client   the customer (the building)
 * @param budgets  the page's ONE useSupplyBudgets() (this month's delivered spend)
 * @param list     the page's ONE useSupplyList(client.id, { history: true }) — the tab's count reads it too
 */
export default function ClientSupplies({ client, budgets, list }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const online = useOnlineStatus() !== false;
  const nav = useFromHere();
  const navigate = useNavigate();
  const canManage = usePermission('supplies.manage');
  const canRequest = usePermission('supplies.request');
  const linesText = useSupplyLinesText();
  const clientName = customerLabel(client);
  const ops = state.opsSettings || {};

  // ── the building's requests (every open one + its newest settled ones) ──────
  const [building, setBuilding] = useState(null);
  const [buildingErr, setBuildingErr] = useState(null);
  const [tick, setTick] = useState(0);
  const reloadBuilding = () => setTick((n) => n + 1);
  useEffect(() => {
    let live = true;
    setBuildingErr(null);
    suppliesApi.buildingRequests(client.id)
      .then((r) => { if (live) setBuilding({ open: (r && r.open) || [], recent: (r && r.recent) || [] }); })
      .catch((e) => { if (live) { setBuilding(null); setBuildingErr(e); } });
    return () => { live = false; };
  }, [client.id, tick]);

  // ── the tiles ───────────────────────────────────────────────────────────────
  const st = budgets.statusFor(client.id);
  const onOrderCents = building ? supplyOnOrderCents(building.open) : null;
  const orderDay = supplyOrderDayFor(client, ops);
  const nextKey = nextSupplyOrderKey(todayKey(), orderDay);
  const approver = resolveSupplyApprover(state, client.id);
  const namedApprover = !!ops.supplyApproverUserId;

  // ── the list: the building's switched-on items ─────────────────────────────
  const items = list.items;
  const [q, setQ] = useState('');
  const rows = useMemo(() => searchRows(items || [], q, (it) => `${it.name} ${it.sku || ''} ${it.unit || ''}`), [items, q]);
  const pager = usePagedRows(rows, { resetKey: `${client.id}|${q}` });
  const reqRows = useMemo(() => (building ? [...building.open, ...building.recent] : []), [building]);
  const reqPager = usePagedRows(reqRows, { resetKey: client.id });
  const [switchesOpen, setSwitchesOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);

  // The order sheet's "Edit list" / "Set up the list" lands here with ?edit=1: the switches open
  // ONCE for the office, and the param goes either way (a supervisor's link must not keep trying).
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (!params.get('edit')) return;
    if (canManage) setSwitchesOpen(true);
    const next = new URLSearchParams(params);
    next.delete('edit');
    setParams(next, { replace: true });
  }, [params, canManage, setParams]);

  // From the order sheet: "Edit list" here opens this building's switches; for another building,
  // its own tab with them open.
  const editList = (id) => {
    setReqOpen(false);
    if (id === client.id) { if (canManage) setSwitchesOpen(true); return; }
    navigate(`/clients/${id}?tab=supplies&edit=1`, { state: nav });
  };

  const monthSub = st.budget != null ? t('supplyPage.cust.thisMonthOf', { budget: money(st.budget) }) : t('supplyPage.cust.thisMonthNoBudget');
  const openCount = building ? building.open.length : 0;

  return (
    <div>
      <div className="overview-kpis">
        <div className="detail-card kpi kpi-accent">
          <div className="kpi-label">{t('supplyPage.cust.thisMonth')}</div>
          <div className={`stat-card-value ${st.over ? 'text-danger' : ''}`}>{st.loaded ? money(st.spend) : '—'}</div>
          <div className="kpi-sub">{st.loaded
            ? monthSub
            : budgets.error
              ? <button type="button" className="linklike" onClick={budgets.refresh}>{t('supplyPage.budget.failed')}</button>
              : t('common.loading')}</div>
        </div>
        <div className="detail-card kpi">
          <div className="kpi-label">{t('supplyPage.cust.onOrder')}</div>
          <div className="stat-card-value">{onOrderCents == null ? '—' : money(onOrderCents / 100)}</div>
          <div className="kpi-sub">{!building
            ? (buildingErr ? <button type="button" className="linklike" onClick={reloadBuilding}>{t('supplyPage.cust.loadFailed')}</button> : t('common.loading'))
            : openCount ? t('supplyPage.cust.onOrderN', { count: openCount }) : t('supplyPage.cust.onOrderNone')}</div>
        </div>
        <div className="detail-card kpi">
          <div className="kpi-label">{t('supplyPage.cust.nextOrder')}</div>
          <div className="stat-card-value-sm">{fmtDate(nextKey)}</div>
          <div className="kpi-sub">{t('supplyPage.cust.ordersOn', { day: orderDay })}</div>
        </div>
        <div className="detail-card kpi">
          <div className="kpi-label">{t('supplyPage.cust.approver')}</div>
          <div className="stat-card-value-sm">{approver ? approver.name : t('supplyPage.noApprover')}</div>
          <div className="kpi-sub">{approver
            ? t(namedApprover ? 'supplyPage.cust.approverNamed' : 'supplyPage.cust.approverSupervisor')
            : t('supplyPage.cust.approverNone')}</div>
        </div>
      </div>

      {(canManage || canRequest) && (
        <div className="tab-actionbar supply-cust-actions">
          {canManage && <button type="button" className="btn btn-outline" onClick={() => setBudgetOpen(true)}>{t('supplyPage.cust.editBudget')}</button>}
          {canRequest && <button type="button" className="btn btn-primary" onClick={() => setReqOpen(true)} disabled={!online}>{t('supplyPage.request')}</button>}
        </div>
      )}
      {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}

      <div className="table-head">
        <h3 className="table-head-title">{t('supplyPage.list.title', { customer: clientName })}</h3>
        <div className="table-controls">
          {items && items.length > 0 && <TableSearch value={q} onChange={setQ} placeholder={t('supplyPage.list.search')} />}
          {items && (
            <span className="table-count">{q
              ? t('supplyPage.matchCount', { shown: rows.length, total: items.length })
              : t('supplyPage.list.count', { count: items.length })}</span>
          )}
          <span className="spacer" />
          {canManage && items && items.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={() => setSwitchesOpen(true)} disabled={!online}>{t('supplyPage.list.editList')}</button>
          )}
        </div>
      </div>

      {list.error ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('supplyPage.list.loadFailed')}
          message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
          action={<button type="button" className="btn btn-primary" onClick={list.reload}>{t('supplyPage.tryAgain')}</button>}
        />
      ) : !items ? (
        <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Icon name="box" size={28} />}
          title={t('supplyPage.list.emptyTitle', { customer: clientName })}
          message={canManage ? t('supplyPage.list.emptyOffice') : t('supplyPage.list.emptyOther')}
          action={canManage && <button type="button" className="btn btn-primary" onClick={() => setSwitchesOpen(true)} disabled={!online}>{t('supplyPage.list.setUp')}</button>}
        />
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr>
                  <th>{t('supplyPage.list.col.item')}</th>
                  <th>{t('supplyPage.list.col.howItComes')}</th>
                  <th className="supply-num">{t('supplyPage.list.col.price')}</th>
                  <th>{t('supplyPage.list.col.lastDelivered')}</th>
                  <th className="supply-num">{t('supplyPage.list.col.last90')}</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.length ? pager.pageRows.map((it) => (
                  <tr key={it.id}>
                    <td className="cell-primary supply-item-name">
                      <span className="truncate" title={it.name}>{it.name}</span>
                      {/* i18n-ok: the item's SKU, as the office wrote it */}
                      {it.sku && <span className="supply-sku">{it.sku}</span>}
                    </td>
                    <td data-label={t('supplyPage.list.col.howItComes')}><span className="truncate" title={it.unit || t('supplyPage.each')}>{it.unit || t('supplyPage.each')}</span></td>
                    <td data-label={t('supplyPage.list.col.price')} className="supply-money supply-num">{Number(it.unitPrice) > 0 ? money(it.unitPrice) : <span className="text-muted">{t('supplyPage.noPrice')}</span>}</td>
                    <td data-label={t('supplyPage.list.col.lastDelivered')} className="supply-nowrap">{it.lastDeliveredAt
                      ? t('supplyPage.list.lastDeliveredValue', { date: it.lastDeliveredAt, qty: it.lastDeliveredQty })
                      : <span className="text-muted">{t('supplyPage.list.notYet')}</span>}</td>
                    <td data-label={t('supplyPage.list.col.last90')} className="supply-num">{it.qty90d || 0}</td>
                  </tr>
                )) : (
                  <tr className="stack-plain"><td colSpan={5}><span className="text-muted">{t('supplyPage.list.noMatch', { q })}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('pager.noun.items')} />
        </>
      )}

      <div className="table-head supply-cust-reqhead">
        <h3 className="table-head-title">{t('supplyPage.cust.requestsTitle')}</h3>
        <Link className="linklike text-sm" to={`/supplies?cust=${client.id}`} state={nav}>{t('supplyPage.cust.openInSupplies')}</Link>
      </div>
      {buildingErr ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('supplyPage.cust.loadFailed')}
          message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
          action={<button type="button" className="btn btn-primary" onClick={reloadBuilding}>{t('supplyPage.tryAgain')}</button>}
        />
      ) : !building ? (
        <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>
      ) : reqRows.length === 0 ? (
        <p className="text-sm text-muted">{t('supplyPage.cust.noRequests')}</p>
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr>
                  <th>{t('supplyPage.col.request')}</th>
                  <th>{t('supplyPage.cust.col.status')}</th>
                  <th>{t('supplyPage.col.date')}</th>
                  <th>{t('supplyPage.col.requestedBy')}</th>
                  <th className="supply-num">{t('supplyPage.col.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {reqPager.pageRows.map((r) => {
                  const summary = linesText(r.lines);
                  const no = supplyOrderNo(r);
                  const who = (r.requestedByUserId && (state.users || []).find((u) => u.id === r.requestedByUserId)?.name) || r.requestedByName || '—';
                  return (
                    <tr key={r.id}>
                      <td className="cell-primary supply-req-cell">
                        {/* S131: the order's number opens its page (the office's order page). */}
                        {/* i18n-ok: the order's number, as stored */}
                        {no && <Link className="linklike supply-no-link" to={`/supplies/orders/${encodeURIComponent(r.id)}`} state={nav}>#{no}</Link>}
                        <span className="truncate" title={summary}>{summary}</span>
                      </td>
                      <td data-label={t('supplyPage.cust.col.status')}><Badge variant={supplyOrderVariant(r)}>{t(supplyOrderLabelKey(r, 'office'))}</Badge></td>
                      <td data-label={t('supplyPage.col.date')} className="supply-nowrap">{r.createdAt ? fmtDate(r.createdAt) : '—'}</td>
                      <td data-label={t('supplyPage.col.requestedBy')}><span className="truncate" title={who}>{who}</span></td>
                      <td data-label={t('supplyPage.col.cost')} className="supply-money supply-num">{money(supplyRequestTotal(r))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListPager pager={reqPager} noun={t('pager.noun.requests')} />
        </>
      )}

      {switchesOpen && (
        <SupplyListSwitches
          client={client}
          clientName={clientName}
          onIds={(items || []).map((it) => it.catalogItemId).filter(Boolean)}
          onClose={(changed) => { setSwitchesOpen(false); if (changed) list.reload(); }}
        />
      )}

      {budgetOpen && <BudgetModal client={client} ops={ops} dispatch={dispatch} toast={toast} onClose={() => setBudgetOpen(false)} />}

      {reqOpen && (
        <SupplyRequestModal
          presetClientId={client.id}
          budgets={budgets}
          onClose={() => setReqOpen(false)}
          onSubmitted={() => { setReqOpen(false); reloadBuilding(); }}
          onEditList={editList}
        />
      )}
    </div>
  );
}

// The building's monthly supply budget (SUP-7) and its order day (SUP-8), in a small dialog. It
// writes what the Overview's budget card wrote before this tab replaced it: UPDATE_CLIENT_OPS with
// ONLY these two fields, both in lib/notifications INTERNAL_OPS_FIELDS, so a budget change does
// not ping the building's cleaners (NOTIF-05). The server keeps both to the office.
function BudgetModal({ client, ops, dispatch, toast, onClose }) {
  const t = useT();
  const orgDay = orgSupplyOrderDay(ops);
  // Blank = no budget, and blank day = the company default: a field is never pre-filled with a
  // number nobody chose.
  const [budget, setBudget] = useState(supplyBudgetFor(client) != null ? String(supplyBudgetFor(client)) : '');
  const ownDay = Number(client.supplyOrderDayOfMonth);
  const [day, setDay] = useState(Number.isFinite(ownDay) && ownDay >= 1 ? String(Math.floor(ownDay)) : '');
  function save(e) {
    e.preventDefault();
    const b = Number(String(budget).replace(/[^0-9.]/g, ''));
    const d = Number(day);
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_OPS,
      id: client.id,
      patch: {
        // Blank / zero / non-numeric = NO budget, never a budget of zero (which would flag the
        // account the moment anything was delivered).
        supplyBudgetMonthly: Number.isFinite(b) && b > 0 ? round2(Math.min(MAX_SUPPLY_BUDGET, b)) : null,
        supplyOrderDayOfMonth: Number.isFinite(d) && d >= 1 ? Math.min(MAX_SUPPLY_ORDER_DAY, Math.floor(d)) : null,
      },
      summary: 'The building’s supply budget was updated.', // i18n-ok: the activity summary the reducer stores, read by the office's log in English
    });
    toast.success(t('supplyPage.cust.budgetSaved'));
    onClose();
  }
  return (
    <Modal open onClose={onClose} size="sm" title={t('supplyPage.cust.budgetTitle')}>
      <form onSubmit={save} noValidate>
        <FormField label={t('supplyPage.cust.budget')} name="supply-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t('supplyPage.cust.budgetPlaceholder')} help={t('supplyPage.cust.budgetHelp')} autoFocus />
        <FormField
          label={t('supplyPage.cust.orderDay')} name="supply-order-day" type="number" min={1} max={MAX_SUPPLY_ORDER_DAY} step={1}
          value={day} onChange={(e) => setDay(e.target.value)}
          placeholder={t('supplyPage.cust.orderDayPlaceholder', { day: orgDay })}
          help={t('supplyPage.cust.orderDayHelp', { day: orgDay })}
        />
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
