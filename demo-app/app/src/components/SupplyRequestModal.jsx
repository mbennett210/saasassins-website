// Request supplies — the ORDER SHEET (round 3, Daniel 2026-10-06: "Go with A"). Opened from the
// Supplies page's Request supplies button and from a customer's Supplies tab (with that building
// picked).
//
// What it fixes, in his words: "there's literally nowhere to do #3" (the office could not add an
// item from where it was looking) and "Why is approved supplies sitting here anyway?" (the list
// lived on a third Supplies tab, away from the building). So:
//   • each row is something THIS building can order — the items the office switched on for it
//     from the master supply list (the Oct 6 call, plan 2026-10-11 §2; GET /api/supplies/items is
//     the building's list, never the whole catalog) — grouped by category, its name with its SKU
//     and how it comes under it, its price, a typed or stepped quantity, tinted once picked, its
//     line total under the price;
//   • what is ALREADY ON ORDER is written out under the item ("4 already on order · waiting for
//     Renata to approve", "2 with the supplier" once submitted), matched by the CATALOG item
//     (lib/supplies supplyOnOrderByItem), not a "pending ×N" chip beside a 0 — so it holds across
//     the item being switched off and on (D6);
//   • the office's "Edit list" (and, with no list, "Set up the list") leads to the building's own
//     Supplies tab with its switches open;
//   • the total and the budget stay PINNED at the dialog's bottom while the sheet scrolls; the
//     budget line is one pure rule in cents (supplyBudgetLine) that counts what is already on
//     order, and it warns — it never blocks: the approver decides (SUP-7).
//
// The on-order figures are a COMPLETE read of the building's open requests
// (suppliesApi.buildingRequests), never the queue's first page: a capped list is not a total.
// LANGUAGES: every word is a catalog line (`supplyPage.form.*`, UI_RULES §140); item names and
// people's names travel as written.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { selectActiveClients, selectClientById } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useToast } from './Toast';
import { money } from '../lib/dates';
import { customerLabel } from '../lib/customerNumber';
import {
  clampSupplyQty, SUPPLY_MAX_QTY, supplyOnOrderByItem, supplyOnOrderCents, supplyBudgetLine,
  supplyToCents, supplyOrderDayFor, groupSupplyByCategory, supplyItemCatalogMap,
} from '../lib/supplies';
import * as suppliesApi from '../lib/suppliesApi';
import { resolveSupplyApprover } from '../lib/notifications';
import Icon from './Icon';
import Modal from './Modal';
import FormField from './FormField';
import SearchSelect from './SearchSelect';
import EmptyState from './EmptyState';
import { useT } from '../i18n/react';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * @param presetClientId  the building to open on (a customer's own tab), else the viewer's first
 * @param budgets         the host page's ONE useSupplyBudgets() (this month's delivered spend)
 * @param onEditList      (clientId) — the office's way to the building's switches
 */
export default function SupplyRequestModal({ presetClientId = null, budgets, onClose, onSubmitted, onEditList }) {
  const t = useT();
  const state = useStore();
  const toast = useToast();
  const online = useOnlineStatus() !== false;
  const { currentUser } = useAuth();
  const canManage = usePermission('supplies.manage');
  const canApprove = usePermission('supplies.approve');
  const canRequest = usePermission('supplies.request');
  // What the demo stub reads to judge like the route does (the real route reads the claim).
  const ctx = useMemo(() => ({
    state, user: currentUser, holds: { request: canRequest, approve: canApprove, manage: canManage },
  }), [state, currentUser, canRequest, canApprove, canManage]);

  // The viewer's own buildings (the ones they supervise) sort first.
  const clientOptions = useMemo(() => {
    const mine = (c) => (c.supervisorId === currentUser?.id ? 0 : 1);
    return selectActiveClients(state)
      .slice()
      .sort((a, b) => mine(a) - mine(b) || customerLabel(a).localeCompare(customerLabel(b)))
      .map((c) => ({ value: c.id, label: customerLabel(c) }));
  }, [state, currentUser]);

  const [clientId, setClientId] = useState(() => (
    presetClientId && clientOptions.some((o) => o.value === presetClientId) ? presetClientId : (clientOptions[0]?.value || null)
  ));
  const [qtys, setQtys] = useState({}); // itemId → qty
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [items, setItems] = useState(null);
  const [itemsErr, setItemsErr] = useState(null);
  const [open, setOpen] = useState(null);       // the building's OPEN requests — null until read
  const [openErr, setOpenErr] = useState(null);
  const [tick, setTick] = useState(0);
  const [sending, setSending] = useState(false);
  // 🔴 CS-798: the order's id is minted ONCE and kept until it lands — a submit whose answer was lost
  // (the signal dropped after the server saved it) is retried under the SAME id, so the building gets
  // one order, not two. A refusal the server named is not a retry: the next submit mints anew.
  const pendingId = useRef(null);
  useEffect(() => {
    if (!clientId) { setItems([]); setOpen([]); return undefined; }
    let live = true;
    setItems(null); setItemsErr(null); setOpen(null); setOpenErr(null);
    suppliesApi.listItems(clientId).then((list) => { if (live) setItems(list || []); }).catch((e) => { if (live) setItemsErr(e); });
    suppliesApi.buildingRequests(clientId, ctx).then((r) => { if (live) setOpen((r && r.open) || []); }).catch((e) => { if (live) setOpenErr(e); });
    return () => { live = false; };
    // ctx carries the store for the demo stub only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, tick]);

  const client = clientId ? selectClientById(state, clientId) : null;
  const clientName = client ? customerLabel(client) : '';
  // Who approves (SUP-9 / SUP-11), so nobody submits into a void — and whether that is YOU.
  const approver = useMemo(() => resolveSupplyApprover(state, clientId), [state, clientId]);
  const selfApprover = !!approver && approver.id === currentUser?.id;
  const namedApprover = !!(state.opsSettings && state.opsSettings.supplyApproverUserId);
  const approverFirst = approver ? firstName(approver.name) : '';
  const orderDay = supplyOrderDayFor(client, state.opsSettings || {});

  const list = useMemo(() => items || [], [items]);
  // The sheet's rows by category, A to Z, the unlabelled last; the heads show only when there is
  // more than one group, or one with a name.
  const groups = useMemo(() => groupSupplyByCategory(list), [list]);
  const showGroupHeads = groups.length > 1 || (groups.length === 1 && groups[0].category !== null);
  // What is on order, keyed on the catalog item (a line from before the master list is resolved
  // through this building's list).
  const onOrder = useMemo(() => supplyOnOrderByItem(open || [], { itemCatalog: supplyItemCatalogMap(list) }), [open, list]);
  const onOrderCents = useMemo(() => supplyOnOrderCents(open || []), [open]);
  // Typed or stepped, a quantity is a whole number from 0 (not ordered) to SUPPLY_MAX_QTY.
  const setQty = (id, v) => setQtys((q) => ({ ...q, [id]: clampSupplyQty(v) }));
  const lines = list.filter((it) => (qtys[it.id] || 0) > 0)
    .map((it) => ({ itemId: it.id, catalogItemId: it.catalogItemId || null, qty: qtys[it.id], unitPrice: Number(it.unitPrice) > 0 ? it.unitPrice : null }));
  const thisCents = lines.reduce((a, l) => a + l.qty * (supplyToCents(l.unitPrice) || 0), 0);

  // The budget line (one pure rule, cents inside). The delivered spend and the on-order money
  // must BOTH have loaded, or the line says it is checking — an unread figure is not $0.00.
  const st = client ? budgets.statusFor(client.id) : null;
  const deliveredCents = st && st.loaded && open !== null ? Math.round(st.spend * 100) : null;
  const line = supplyBudgetLine({ budget: st ? st.budget : null, deliveredCents, onOrderCents, thisCents });
  const budgetText = (() => {
    switch (line.kind) {
      case 'none': return t('supplyPage.form.budget.none');
      case 'unknown': return budgets.error || openErr ? t('supplyPage.budget.failed') : t('supplyPage.form.budget.loading');
      case 'month': return t('supplyPage.form.budget.month', { delivered: money(line.delivered), onOrder: money(line.onOrder), budget: money(line.budget) });
      case 'with': return line.onOrder
        ? t('supplyPage.form.budget.with', { amount: money(line.withThis), budget: money(line.budget), onOrder: money(line.onOrder) })
        : t('supplyPage.form.budget.withNoOrder', { amount: money(line.withThis), budget: money(line.budget) });
      default: {
        const head = line.onOrder
          ? t('supplyPage.form.budget.over', { amount: money(line.over), budget: money(line.budget), onOrder: money(line.onOrder) })
          : t('supplyPage.form.budget.overNoOrder', { amount: money(line.over), budget: money(line.budget) });
        // The approver sees it too — unless you ARE the approver (or nobody is).
        return approver && !selfApprover ? `${head} ${t('supplyPage.form.budget.overSees', { name: approverFirst })}` : head;
      }
    }
  })();

  // "{n} already on order · …", one line per in-flight state the item is in.
  const onOrderLines = (id) => {
    const o = onOrder[id];
    if (!o) return [];
    const out = [];
    if (o.requested) {
      out.push(selfApprover
        ? t('supplyPage.form.onOrderYou', { count: o.requested })
        : approver
          ? t('supplyPage.form.onOrderWaiting', { count: o.requested, name: approverFirst })
          : t('supplyPage.form.onOrderNoApprover', { count: o.requested }));
    }
    if (o.approved) out.push(t('supplyPage.form.onOrderApproved', { count: o.approved }));
    // S131: with the supplier — what is still to come (a delivered or cancelled line is not).
    if (o.sent) out.push(t('supplyPage.form.onOrderSent', { count: o.sent }));
    return out;
  };

  async function submit() {
    if (!clientId || !lines.length || sending || !online) return;
    setSending(true);
    if (!pendingId.current) pendingId.current = suppliesApi.newSupplyRequestId();
    try {
      // The server snapshots each line's name, SKU and price from this building's own list; the
      // body names items (the row and its catalog item, so an item switched off and back on while
      // the sheet was open still sends) and quantities only.
      await suppliesApi.createRequest({
        id: pendingId.current, clientId, note: noteOpen ? note : '',
        lines: lines.map((l) => ({ itemId: l.itemId, catalogItemId: l.catalogItemId, qty: l.qty })),
      }, ctx);
      pendingId.current = null;
      toast.success(approver
        ? t('supplyPage.toast.submitted', { name: approver.name })
        : t('supplyPage.toast.submittedNoApprover'));
      onSubmitted(clientId);
    } catch (e) {
      if (e && e.status) pendingId.current = null;
      toast.error(e && e.code === 'unknown_item' ? t('supplyPage.toast.itemGone') : t('supplyPage.toast.failed'));
      setSending(false);
    }
  }

  const routeText = !approver
    ? t('supplyPage.form.noApprover')
    : selfApprover
      ? t(namedApprover ? 'supplyPage.form.routeSelf' : 'supplyPage.form.routeSelfSupervisor')
      : t('supplyPage.form.route', { name: approver.name });
  const noteFor = selfApprover
    ? { button: t('supplyPage.form.addNoteOffice'), label: t('supplyPage.form.noteOffice') }
    : approver
      ? { button: t('supplyPage.form.addNoteFor', { name: approverFirst }), label: t('supplyPage.form.noteFor', { name: approverFirst }) }
      : { button: t('supplyPage.form.addNote'), label: t('supplyPage.form.note') };

  let sheet;
  if (!clientOptions.length) {
    sheet = <div className="supply-sheet"><EmptyState icon={<Icon name="building" size={26} />} title={t('supplyPage.form.noCustomers')} message={t('supplyPage.form.noCustomersHint')} /></div>;
  } else if (itemsErr) {
    sheet = (
      <div className="supply-sheet">
        <EmptyState
          icon={<Icon name="warning" size={26} />}
          title={t('supplyPage.list.loadFailed')}
          message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
          action={<button type="button" className="btn btn-primary" onClick={() => setTick((n) => n + 1)}>{t('supplyPage.tryAgain')}</button>}
        />
      </div>
    );
  } else if (!items) {
    sheet = <div className="supply-sheet supply-sheet-msg">{t('common.loading')}</div>;
  } else if (!list.length) {
    // A building with NO list says so, and says who can fix it.
    sheet = (
      <div className="supply-sheet">
        <EmptyState
          icon={<Icon name="box" size={26} />}
          title={t('supplyPage.list.emptyTitle', { customer: clientName })}
          message={canManage ? t('supplyPage.list.emptyOffice') : t('supplyPage.list.emptyOther')}
          action={canManage && <button type="button" className="btn btn-primary" onClick={() => onEditList(clientId)}>{t('supplyPage.list.setUp')}</button>}
        />
      </div>
    );
  } else {
    sheet = (
      <>
        <div className="supply-sheet" role="table" aria-label={t('supplyPage.form.sheetAria', { customer: clientName })}>
          <div className="supply-sheet-row supply-sheet-cols" role="row">
            <span role="columnheader">{t('supplyPage.form.col.item')}</span>
            <span role="columnheader" className="supply-num">{t('supplyPage.form.col.price')}</span>
            <span role="columnheader">{t('supplyPage.form.col.qty')}</span>
          </div>
          {groups.map((g) => [
            showGroupHeads && (
              <div key={`g-${g.key}`} className="supply-sheet-group" role="row">
                <span role="cell">{g.category || t('supplyPage.catalog.noCategory')}</span>
              </div>
            ),
            ...g.items.map((it) => {
              const q = qtys[it.id] || 0;
              const priced = Number(it.unitPrice) > 0;
              const unit = it.unit || t('supplyPage.each');
              return (
                <div key={it.id} className={`supply-sheet-row ${q > 0 ? 'is-picked' : ''}`} role="row">
                  <div className="supply-sheet-item" role="cell">
                    <b>{it.name}</b>
                    {/* The SKU under the name, with how it comes (the SKU as the office wrote it). */}
                    <span className="supply-sheet-meta">{it.sku ? t('supplyPage.skuUnit', { sku: it.sku, unit }) : unit}</span>
                    {onOrderLines(it.catalogItemId).map((text) => <span key={text} className="supply-onorder">{text}</span>)}
                  </div>
                  <div className="supply-sheet-price supply-num" role="cell">
                    {priced ? money(it.unitPrice) : <span className="text-muted">{t('supplyPage.noPrice')}</span>}
                    {q > 0 && priced && <span className="supply-sheet-line">{money(q * it.unitPrice)}</span>}
                  </div>
                  <div className="supply-sheet-qty" role="cell">
                    <div className="supply-step">
                      <button type="button" className="btn-icon" onClick={() => setQty(it.id, q - 1)} disabled={q === 0} aria-label={t('supplyPage.form.less', { item: it.name })}><Icon name="minus" size={14} /></button>
                      <input
                        type="number" inputMode="numeric" min={0} max={SUPPLY_MAX_QTY} step={1}
                        className="input supply-qty" value={q}
                        aria-label={t('supplyPage.form.qtyAria', { item: it.name })}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setQty(it.id, e.target.value)}
                      />
                      <button type="button" className="btn-icon" onClick={() => setQty(it.id, q + 1)} disabled={q >= SUPPLY_MAX_QTY} aria-label={t('supplyPage.form.more', { item: it.name })}><Icon name="plus" size={14} /></button>
                    </div>
                  </div>
                </div>
              );
            }),
          ])}
        </div>
        <p className="form-help">{t('supplyPage.form.qtyHint')}</p>
        {noteOpen ? (
          <FormField label={noteFor.label} name="supply-request-note" as="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('supplyPage.form.notePlaceholder')} autoFocus />
        ) : (
          <button type="button" className="btn btn-link supply-sheet-note-btn" onClick={() => setNoteOpen(true)}>{noteFor.button}</button>
        )}
      </>
    );
  }

  return (
    <Modal open onClose={onClose} title={t('supplyPage.request')} size="md">
      <div className="supply-order">
        <FormField label={t('supplyPage.form.for')}>
          <SearchSelect
            value={clientId}
            onChange={(id) => { setClientId(id || null); setQtys({}); setNote(''); setNoteOpen(false); }}
            options={clientOptions}
            placeholder={t('supplyPage.form.pickLocation')}
            searchPlaceholder={t('supplyPage.form.searchLocations')}
          />
          {client && (
            <div className="form-help">
              {routeText} {t('supplyPage.form.orderDay', { day: orderDay })}
            </div>
          )}
        </FormField>

        {client && (
          <div className="supply-sheet-head">
            <h3 className="supply-sheet-title">{t('supplyPage.form.need', { customer: clientName })}</h3>
            {canManage && list.length > 0 && (
              <button type="button" className="btn btn-link" onClick={() => onEditList(clientId)}>{t('supplyPage.form.editList')}</button>
            )}
          </div>
        )}
        {sheet}

        <div className="supply-sheet-gap" />
        {!online && <p className="form-error" role="status">{t('supplyPage.form.offline')}</p>}
        <div className="supply-sheet-foot">
          <div className="supply-sheet-sum">
            <div className={`supply-sheet-total ${lines.length ? '' : 'is-none'}`}>
              {lines.length
                ? t.rich('supplyPage.form.picked', { count: lines.length, amount: money(thisCents / 100) })
                : t(list.length ? 'supplyPage.form.nothingPicked' : 'supplyPage.form.nothingToOrder')}
            </div>
            {client && <div className={`supply-sheet-budget ${line.kind === 'over' ? 'is-over' : ''}`}>{budgetText}</div>}
          </div>
          <div className="supply-sheet-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={!clientId || !lines.length || sending || !online}>{t('supplyPage.form.submit')}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
