// ONE SUPPLY ORDER — /supplies/orders/:id (S131, plan docs/plans/2026-10-14-supply-orders.md §4;
// Matt's boards sm-web-02 (two columns) and sm-mobile-02 (stacked)). Shared by the Supply Manager,
// the account manager and the office; the route answers office roles holding supplies.view only
// (GET /api/supplies/order — never crew, never the driver).
//
// What it shows, from ONE read (suppliesApi.getOrder): the order's number, building and status (the
// office's words, lib/supplies supplyOrderLabelKey); each line with its state chip (Delivered ·
// Backordered with the supplier's ETA · Cancelled with the reason · Pending), "Delivery photo
// attached" when a photo was filed for that item; who asked and who approved; the delivery photos;
// the comments; the invoice; and the ORDER HISTORY — one timeline built from what is stored (lib/
// supplies supplyOrderHistory), newest last, each line "what · who · when".
//
// What it lets each reader do — exactly the moves the route allows (lib/supplies maySupplyDecide /
// maySupplyCancel, the ONE rule): on Pending approval, Approve / Decline for the building's account
// manager, their operations manager, the owner or an admin — "Waiting on {approver}" for everyone
// else; on New, "Submit to supplier" and "Copy order" (SKU · item · qty, one line each) for the
// Supply Manager; once submitted, per line (each in a kit Modal): Mark delivered (how many, default
// the rest, an optional photo), Backordered (the supplier's ETA), Cancel item (a reason); and MARK
// COMPLETED, disabled with its reason line ("1 item backordered — complete delivery to unlock")
// until every line is delivered or cancelled. Every write is a compare-and-swap on the version this
// page read: a 409 says so and re-reads (UI_RULES §168).
//
// Loading, error-with-Try-again and offline are real states; offline, every control is off and says
// why (nothing is kept on the phone — UI_RULES §131). Every word is a catalog line (`supplyPage.*`);
// item names, notes, reasons, comments and people's names travel as written.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from '../store';
import { selectClientById } from '../store/selectors';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIsMobile } from '../hooks/useIsMobile';
import { useBackTarget } from '../hooks/useBackTarget';
import { useSupplyMoves } from '../hooks/useSupplyMoves';
import { useToast } from '../components/Toast';
import { money, todayKey, addDaysKey } from '../lib/dates';
import { customerLabel } from '../lib/customerNumber';
import {
  SUPPLY_STATUS, SUPPLY_LINE_STATE, SUPPLY_ETA_MAX_DAYS, SUPPLY_CANCEL_REASON_MIN, SUPPLY_CANCEL_REASON_MAX,
  supplyStatusOf, nextSupplyStatus, maySupplyDecide, maySupplyCancel, supplyOrderNo, supplyOrderLabelKey, supplyOrderVariant,
  supplyOrderProgress, supplyOrderHistory, supplyRequestTotal, supplyOrderDeliveredCents, supplyEtaError, supplyEtaInstant,
  SUPPLY_INVOICE_MIME,
} from '../lib/supplies';
import * as suppliesApi from '../lib/suppliesApi';
import { uploadMedia } from '../lib/accountMediaApi';
import Icon from '../components/Icon';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import FormField from '../components/FormField';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import MediaGallery from '../components/MediaGallery';
import SupplyDeclineModal from '../components/SupplyDeclineModal';
import { useT } from '../i18n/react';

// A line's chip: its state's word and colour (Badge variants, as the queue's).
const LINE_CHIP = {
  [SUPPLY_LINE_STATE.delivered]: ['supplyPage.order.state.delivered', 'green'],
  [SUPPLY_LINE_STATE.backordered]: ['supplyPage.order.state.backordered', 'amber'],
  [SUPPLY_LINE_STATE.cancelled]: ['supplyPage.order.state.cancelled', 'slate'],
  [SUPPLY_LINE_STATE.pending]: ['supplyPage.order.state.pending', 'slate'],
};
// A refused write, in its own words (the route's codes); anything else is the generic one.
const REFUSAL_KEY = {
  stale: 'supplyPage.order.toast.stale',
  lines_open: 'supplyPage.order.toast.linesOpen',
  not_submitted: 'supplyPage.order.toast.moved',
  illegal_move: 'supplyPage.order.toast.moved',
  line_resolved: 'supplyPage.order.toast.lineResolved',
  not_found: 'supplyPage.order.gone',
  not_yours: 'supplyPage.order.toast.notYours',
  too_many: 'supplyPage.order.toast.tooManyFiles',
  bad_type: 'supplyPage.order.toast.invoiceType',
  too_large: 'supplyPage.order.toast.invoiceType',
  bad_size: 'supplyPage.order.toast.invoiceType',
};
// The order history's words, per kind (lib/supplies supplyOrderHistory).
const HISTORY_KEY = {
  requested: 'supplyPage.order.history.requested',
  approved: 'supplyPage.order.history.approved',
  declined: 'supplyPage.order.history.declined',
  submitted: 'supplyPage.order.history.submitted',
  delivered: 'supplyPage.order.history.delivered',
  backordered: 'supplyPage.order.history.backordered',
  lineCancelled: 'supplyPage.order.history.lineCancelled',
  comment: 'supplyPage.order.history.comment',
  photo: 'supplyPage.order.history.photo',
  invoice: 'supplyPage.order.history.invoice',
  completed: 'supplyPage.order.history.completed',
};

export default function SupplyOrder() {
  const t = useT();
  const { id } = useParams();
  const state = useStore();
  const toast = useToast();
  const isMobile = useIsMobile();
  const online = useOnlineStatus() !== false;
  const { currentUser } = useAuth();
  const back = useBackTarget('/supplies');
  const holds = {
    view: usePermission('supplies.view'),
    request: usePermission('supplies.request'),
    approve: usePermission('supplies.approve'),
    manage: usePermission('supplies.manage'),
    deliver: usePermission('supplies.deliver'),
  };
  // What the demo stub reads to judge like the route does (the real route reads the claim).
  const ctx = useMemo(() => ({ state, user: currentUser, holds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, currentUser, holds.view, holds.request, holds.approve, holds.manage, holds.deliver]);

  // ── the read ──
  const [data, setData] = useState(null);   // { order, progress, comments, photos, invoices, approver, approverOpsManagerId }
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    setErr(null);
    suppliesApi.getOrder(id, ctx)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
    // ctx carries the store for the demo stub; the real read keys on the id alone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tick]);

  const moves = useSupplyMoves({ ctx, onDone: () => reload() });
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  // Every write here: one at a time, then the toast, then a re-read. A refusal says why in its own
  // words; a stale or moved order re-reads so the page shows where it is now.
  async function act(fn, okText) {
    if (busy.current || !online) return false;
    busy.current = true; setWorking(true);
    try {
      await fn();
      if (okText) toast.success(okText);
      reload();
      return true;
    } catch (e) {
      toast.error(t((e && REFUSAL_KEY[e.code]) || 'supplyPage.toast.failed'));
      if (e && (e.status === 409 || e.status === 404)) reload();
      return false;
    } finally {
      busy.current = false; setWorking(false);
    }
  }

  const [lineModal, setLineModal] = useState(null);  // { kind: 'deliver' | 'backorder' | 'cancel', line }
  const [declining, setDeclining] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (err && !data) {
    const gone = err.status === 404;
    return (
      <div className="page">
        <div className="detail-head"><div className="detail-head-top"><a href={back.href} className="detail-back" onClick={back.goBack}>← {back.label}</a></div></div>
        <EmptyState
          icon={<Icon name={gone ? 'box' : 'warning'} size={28} />}
          title={t(gone ? 'supplyPage.order.gone' : 'supplyPage.order.loadFailed')}
          message={gone ? t('supplyPage.order.goneHint') : (online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline'))}
          action={gone ? null : <button type="button" className="btn btn-primary" onClick={reload}>{t('supplyPage.tryAgain')}</button>}
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <div className="detail-head"><div className="detail-head-top"><a href={back.href} className="detail-back" onClick={back.goBack}>← {back.label}</a></div></div>
        <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>
      </div>
    );
  }

  const order = data.order;
  const progress = data.progress || supplyOrderProgress(order);
  const status = supplyStatusOf(order);
  const client = selectClientById(state, order.clientId);
  const building = client ? customerLabel(client) : t('supplyPage.order.noBuilding');
  const no = supplyOrderNo(order);
  const off = working || moves.working || !online;
  const mayDecide = (decision) => maySupplyDecide({
    request: order, decision, selfId: currentUser?.id || null, role: currentUser?.role || null,
    approverId: data.approver ? data.approver.id : null, approverOpsManagerId: data.approverOpsManagerId || null,
    holdsApprove: holds.approve, holdsManage: holds.manage, holdsDeliver: holds.deliver,
  });
  const may = (decision) => !!nextSupplyStatus(status, decision) && mayDecide(decision);
  const isSent = status === SUPPLY_STATUS.sent;
  // S131 Wave 2: a waiting order is cancelled by whoever may decide it (never supplies.manage alone).
  const canCancel = maySupplyCancel({
    request: order, selfId: currentUser?.id || null, role: currentUser?.role || null,
    approverId: data.approver ? data.approver.id : null, approverOpsManagerId: data.approverOpsManagerId || null,
    holdsRequest: holds.request, holdsApprove: holds.approve, holdsManage: holds.manage,
  });
  const photoFor = (line) => (data.photos || []).some((p) => p.areaId && p.areaId === line.catalogItemId);
  const openLines = progress.lines.filter((l) => l.state !== SUPPLY_LINE_STATE.delivered && l.state !== SUPPLY_LINE_STATE.cancelled);
  const anyDelivered = progress.lines.some((l) => l.delivered > 0);
  const deliveredCents = supplyOrderDeliveredCents(order);
  const history = supplyOrderHistory(order, { comments: data.comments, photos: data.photos, invoices: data.invoices });

  // ── the per-line acts (EP-393) ──
  const fulfill = (acts, okText) => act(() => suppliesApi.fulfillOrder({ id: order.id, version: order.version, acts }, ctx), okText);
  async function deliverLine(line, qty, photo) {
    const done = await fulfill([{ line: line.index, act: 'deliver', qty }], t('supplyPage.order.toast.delivered', { item: line.name || t('supplyPage.item'), qty }));
    if (!done) return false;
    if (photo) {
      try {
        await uploadMedia(photo, { siteId: null, clientId: order.clientId, scope: 'supply', refId: order.id, areaId: line.catalogItemId || null });
        reload();
      } catch { toast.error(t('supplyPage.order.toast.photoFailed')); }
    }
    return true;
  }
  // Copy order: SKU · item · qty, one line each (the supplier's order form or email).
  async function copyOrder() {
    const text = (order.lines || []).map((l) => [l.sku, l.name, l.qty].filter((x) => x !== null && x !== undefined && x !== '').join(' · ')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('supplyPage.order.copied'));
    } catch { toast.error(t('supplyPage.order.copyFailed')); }
  }

  // ── the cards ──
  const itemsCard = (
    <section className="card supply-op-card" key="items">
      <h3 className="supply-op-title">{t('supplyPage.order.items')}</h3>
      <ul className="supply-op-lines">
        {progress.lines.map((l) => {
          const submitted = isSent || status === SUPPLY_STATUS.completed;
          const [chipKey, chipVariant] = l.state === SUPPLY_LINE_STATE.pending && l.delivered > 0
            ? ['supplyPage.order.state.partly', 'amber'] : LINE_CHIP[l.state];
          const open = isSent && l.state !== SUPPLY_LINE_STATE.delivered && l.state !== SUPPLY_LINE_STATE.cancelled;
          return (
            <li key={`${l.index}-${l.itemId || l.name}`} className={`supply-op-line is-${l.state}`}>
              <div className="supply-op-line-head">
                {/* i18n-ok: the item's own name and SKU, as the office wrote them */}
                <span className="supply-op-line-name"><b>{l.name || t('supplyPage.item')}</b> <span className="text-muted">{t('supplyPage.order.times', { qty: l.qty })}</span></span>
                {submitted && <Badge variant={chipVariant}>{t(chipKey)}</Badge>}
              </div>
              {l.sku ? <span className="supply-sku">{l.sku}</span> : null}
              {l.delivered > 0 && l.state !== SUPPLY_LINE_STATE.delivered && (
                <span className="text-xs">{t('supplyPage.order.deliveredOf', { delivered: l.delivered, qty: l.qty })}</span>
              )}
              {l.state === SUPPLY_LINE_STATE.backordered && l.eta && (
                <span className="text-xs supply-op-eta">{t('supplyPage.order.eta', { eta: supplyEtaInstant(l.eta) })}</span>
              )}
              {l.cancelled && (
                <span className="text-xs text-muted">{l.cancelled.reason ? t('supplyPage.order.cancelledReason', { reason: l.cancelled.reason }) : t('supplyPage.order.cancelledLegacy')}</span>
              )}
              {photoFor(l) && <span className="text-xs supply-op-photo"><Icon name="camera" size={14} /> {t('supplyPage.order.photoAttached')}</span>}
              {open && (mayDecide('deliver') || mayDecide('backorder') || mayDecide('cancelLine')) && (
                <div className="supply-op-line-actions">
                  {mayDecide('deliver') && <button type="button" className="btn btn-gold" disabled={off} onClick={() => setLineModal({ kind: 'deliver', line: l })}>{t('supplyPage.markDelivered')}</button>}
                  {mayDecide('backorder') && (
                    <button type="button" className="btn btn-outline" disabled={off} onClick={() => setLineModal({ kind: 'backorder', line: l })}>
                      {t(l.state === SUPPLY_LINE_STATE.backordered ? 'supplyPage.order.changeEta' : 'supplyPage.order.backorder')}
                    </button>
                  )}
                  {mayDecide('cancelLine') && <button type="button" className="btn btn-outline" disabled={off} onClick={() => setLineModal({ kind: 'cancel', line: l })}>{t('supplyPage.order.cancelItem')}</button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* i18n-ok: the requester's own note, shown as written */}
      {order.note ? <div className="supply-note">“{order.note}”</div> : null}
      <div className="supply-total"><span>{t('supplyPage.estTotal')}</span><b>{money(supplyRequestTotal(order))}</b></div>
      {anyDelivered && <div className="supply-total"><span>{t('supplyPage.order.deliveredSoFar')}</span><b>{money(deliveredCents / 100)}</b></div>}
    </section>
  );

  const person = (name, when) => t('supplyPage.order.personWhen', { name: name || '—', when });
  const approvalsCard = (
    <section className="card supply-op-card" key="approvals">
      {!isMobile && <h3 className="supply-op-title">{t('supplyPage.order.approvals')}</h3>}
      <dl className="supply-op-people">
        <div><dt>{t('supplyPage.order.requestedBy')}</dt><dd>{order.createdAt ? person(order.requestedByName, order.createdAt) : (order.requestedByName || '—')}</dd></div>
        {order.rejectedAt ? (
          <div><dt>{t('supplyPage.order.declinedBy')}</dt><dd>{person(order.rejectedByName, order.rejectedAt)}</dd></div>
        ) : (
          <div><dt>{t('supplyPage.order.approvedBy')}</dt><dd>{order.approvedAt
            ? person(order.approvedByName, order.approvedAt)
            : (data.approver ? t('supplyPage.detail.waitingOn', { name: data.approver.name || '—' }) : t('supplyPage.noApprover'))}</dd></div>
        )}
      </dl>
      {order.rejectionReason ? <div className="supply-note supply-note-reject">{t.rich('supplyPage.detail.rejectedReason', { reason: order.rejectionReason })}</div> : null}
    </section>
  );

  // The primary action for this order's step, and its reason line when it is held back.
  const reasonLine = openLines.length === 0 ? null
    : openLines.every((l) => l.state === SUPPLY_LINE_STATE.backordered)
      ? t('supplyPage.order.lockedBackordered', { count: openLines.length, items: openLines.map((l) => l.name || t('supplyPage.item')) })
      : t('supplyPage.order.lockedOpen', { count: openLines.length, items: openLines.map((l) => l.name || t('supplyPage.item')) });
  const actionsCard = (
    <section className="supply-op-actions" key="actions">
      {status === SUPPLY_STATUS.requested && (may('approve') ? (
        <div className="supply-op-buttons">
          <button type="button" className="btn btn-gold" disabled={off} onClick={() => moves.run([order], 'approve')}><Icon name="check" size={15} /> {t('supplyPage.approve')}</button>
          <button type="button" className="btn btn-outline" disabled={off} onClick={() => setDeclining(true)}>{t('supplyPage.reject')}</button>
        </div>
      ) : (
        // SUP-11 on screen: not this viewer's to decide — whose it is, in visible words (§118).
        <p className="text-sm text-muted">{data.approver ? t('supplyPage.detail.waitingOn', { name: data.approver.name || '—' }) : t('supplyPage.noApprover')}</p>
      ))}
      {status === SUPPLY_STATUS.approved && may('submit') && (
        <div className="supply-op-buttons">
          <button type="button" className="btn btn-gold" disabled={off} onClick={() => moves.run([order], 'submit')}><Icon name="box" size={15} /> {t('supplyPage.submitSupplier')}</button>
          <button type="button" className="btn btn-outline" onClick={copyOrder}>{t('supplyPage.order.copy')}</button>
        </div>
      )}
      {isSent && may('complete') && (
        <>
          <button
            type="button" className="btn btn-gold supply-op-complete" disabled={off || !progress.ready}
            onClick={() => act(() => suppliesApi.completeOrder({ id: order.id, version: order.version }, ctx), t('supplyPage.order.toast.completed'))}
          >{t('supplyPage.order.complete')}</button>
          {!progress.ready && reasonLine && <p className="text-xs text-muted supply-op-reason">{reasonLine}</p>}
        </>
      )}
      {status === SUPPLY_STATUS.completed && (
        <p className="text-sm text-muted">{t('supplyPage.order.completedBy', { name: order.completedByName || '—', when: order.completedAt })}</p>
      )}
      {(isSent ? !anyDelivered : status === SUPPLY_STATUS.rejected) && may('reopen') && (
        <button type="button" className="btn btn-outline" disabled={off} onClick={() => moves.run([order], 'reopen')}>{t('supplyPage.reopen')}</button>
      )}
      {canCancel && (
        <button type="button" className="btn btn-outline" disabled={off} onClick={() => setConfirmCancel(true)}>{t('supplyPage.cancelConfirm')}</button>
      )}
    </section>
  );

  const photos = (
    <MediaGallery
      key={`photos-${tick}`}
      siteId={null} clientId={order.clientId} scope="supply" refId={order.id}
      label={isMobile ? '' : t('supplyPage.order.photosTitle')} hint={null}
      emptyText={t('supplyPage.order.photosEmpty')}
      canAdd={online && (holds.manage || (holds.deliver && isSent))} canRemove={holds.manage}
      accept="image/*" captions={false} uploadLabel={t('supplyPage.order.uploadPhotos')}
    />
  );
  const invoice = <InvoiceSection {...{ order, invoices: data.invoices || [], canManage: holds.manage, online, ctx, onChanged: reload }} />;
  const photosCards = isMobile ? [
    <section className="card supply-op-card" key="photos"><h3 className="supply-op-title">{t('supplyPage.order.photosTitle')}</h3>{photos}</section>,
  ] : [
    <section className="card supply-op-card" key="photos-invoice">
      <h3 className="supply-op-title">{t('supplyPage.order.photosInvoiceTitle')}</h3>
      {photos}
      {invoice}
    </section>,
  ];
  const invoiceCard = isMobile ? <section className="card supply-op-card" key="invoice"><h3 className="supply-op-title">{t('supplyPage.order.invoiceTitle')}</h3>{invoice}</section> : null;
  const commentsCard = <CommentsCard key="comments" {...{ order, comments: data.comments || [], online, ctx, onChanged: reload }} />;
  const historyCard = (
    <section className="card supply-op-card" key="history">
      <h3 className="supply-op-title">{t('supplyPage.order.historyTitle')}</h3>
      <ol className="supply-op-history">
        {history.map((h, i) => (
          <li key={`${h.kind}-${h.at}-${i}`} className={`is-${h.kind}`}>
            <b>{t(HISTORY_KEY[h.kind], { item: h.name || t('supplyPage.item'), qty: h.qty || 0, eta: supplyEtaInstant(h.eta), file: h.fileName || '' })}</b>
            {h.byName ? <> · {h.byName}</> : null}
            {' · '}{t('supplyPage.queue.when', { when: h.at })}
          </li>
        ))}
      </ol>
    </section>
  );

  return (
    <div className="page">
      <div className="detail-head">
        <div className="detail-head-top"><a href={back.href} className="detail-back" onClick={back.goBack}>← {back.label}</a></div>
        <div className="detail-head-body">
          <div className="detail-head-text">
            {/* i18n-ok: the order's number, as stored */}
            <span className="supply-op-no">{no ? `#${no}` : t('supplyPage.order.noNumber')}</span>
            <div className="detail-head-title-row">
              <h1 className="detail-head-title">{building}</h1>
              <Badge variant={supplyOrderVariant(order)}>{t(supplyOrderLabelKey(order, 'office'))}</Badge>
            </div>
          </div>
        </div>
      </div>
      {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}

      {isMobile ? (
        <div className="supply-op-stack">
          {itemsCard}
          {approvalsCard}
          {photosCards}
          {commentsCard}
          {invoiceCard}
          {actionsCard}
          {historyCard}
        </div>
      ) : (
        <div className="supply-op-grid">
          <div className="supply-op-main">
            {itemsCard}
            {photosCards}
            {commentsCard}
          </div>
          <div className="supply-op-side">
            {approvalsCard}
            {actionsCard}
            {historyCard}
          </div>
        </div>
      )}

      {lineModal && lineModal.kind === 'deliver' && (
        <DeliverLineModal
          line={lineModal.line} building={building} working={off}
          onConfirm={async (qty, photo) => { if (await deliverLine(lineModal.line, qty, photo)) setLineModal(null); }}
          onClose={() => setLineModal(null)}
        />
      )}
      {lineModal && lineModal.kind === 'backorder' && (
        <BackorderModal
          line={lineModal.line} working={off}
          onConfirm={async (eta) => {
            if (await fulfill([{ line: lineModal.line.index, act: 'backorder', eta }], t('supplyPage.order.toast.backordered', { item: lineModal.line.name || t('supplyPage.item') }))) setLineModal(null);
          }}
          onClose={() => setLineModal(null)}
        />
      )}
      {lineModal && lineModal.kind === 'cancel' && (
        <CancelLineModal
          line={lineModal.line} working={off}
          onConfirm={async (reason) => {
            if (await fulfill([{ line: lineModal.line.index, act: 'cancel', reason }], t('supplyPage.order.toast.cancelledItem', { item: lineModal.line.name || t('supplyPage.item') }))) setLineModal(null);
          }}
          onClose={() => setLineModal(null)}
        />
      )}
      {declining && (
        <SupplyDeclineModal
          request={order} working={off}
          onDecline={async (reason) => { if (await moves.run([order], 'reject', reason)) setDeclining(false); }}
          onClose={() => setDeclining(false)}
        />
      )}
      <ConfirmDialog
        open={confirmCancel}
        title={t('supplyPage.cancelTitle')}
        message={t('supplyPage.cancelMessage')}
        confirmLabel={t('supplyPage.cancelConfirm')}
        variant="danger"
        onConfirm={async () => {
          setConfirmCancel(false);
          if (await act(() => suppliesApi.cancelRequest(order.id, ctx), t('supplyPage.toast.cancelled'))) back.goBack();
        }}
        onClose={() => setConfirmCancel(false)}
      />
    </div>
  );
}

// ── Mark delivered: how many arrived (1..the rest, default the rest), an optional photo ──
function DeliverLineModal({ line, building, working, onConfirm, onClose }) {
  const t = useT();
  const [qty, setQty] = useState(String(line.remaining));
  const [photo, setPhoto] = useState(null);
  const n = Number(qty);
  const valid = Number.isInteger(n) && n >= 1 && n <= line.remaining;
  const step = (d) => setQty(String(Math.min(line.remaining, Math.max(1, (Number(qty) || 0) + d))));
  const item = line.name || t('supplyPage.item');
  return (
    <Modal open onClose={onClose} title={t('supplyPage.order.deliverTitle', { item })}>
      <p className="text-sm text-muted">{t('supplyPage.order.deliverTo', { building })}</p>
      <FormField label={t('supplyPage.order.deliverQty')} help={t('supplyPage.order.deliverQtyHelp', { count: line.remaining })}>
        <div className="supply-step">
          <button type="button" className="btn-icon" aria-label={t('supplyPage.form.less', { item })} onClick={() => step(-1)} disabled={n <= 1}><Icon name="minus" size={14} /></button>
          <input
            className="input supply-qty" type="number" inputMode="numeric" min={1} max={line.remaining} value={qty}
            aria-label={t('supplyPage.form.qtyAria', { item })} onChange={(e) => setQty(e.target.value)}
          />
          <button type="button" className="btn-icon" aria-label={t('supplyPage.form.more', { item })} onClick={() => step(1)} disabled={n >= line.remaining}><Icon name="plus" size={14} /></button>
        </div>
      </FormField>
      <FormField label={t('supplyPage.order.deliverPhoto')}>
        <input className="input" type="file" accept="image/*" onChange={(e) => setPhoto((e.target.files && e.target.files[0]) || null)} />
      </FormField>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-gold" disabled={!valid || working} onClick={() => onConfirm(n, photo)}>{t('supplyPage.markDelivered')}</button>
      </div>
    </Modal>
  );
}

// ── Backordered: the supplier's ETA, a day from today to a year out ──
function BackorderModal({ line, working, onConfirm, onClose }) {
  const t = useT();
  const today = todayKey();
  const [eta, setEta] = useState(line.eta || '');
  const bad = eta ? supplyEtaError(eta, today) : null;
  const item = line.name || t('supplyPage.item');
  return (
    <Modal open onClose={onClose} title={t('supplyPage.order.backorderTitle', { item })}>
      <p className="text-sm text-muted">{t('supplyPage.order.backorderHelp')}</p>
      <FormField label={t('supplyPage.order.backorderEta')} error={bad ? t('supplyPage.order.etaInvalid') : null}>
        <input className="input" type="date" value={eta} min={today} max={addDaysKey(today, SUPPLY_ETA_MAX_DAYS)} onChange={(e) => setEta(e.target.value)} />
      </FormField>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-gold" disabled={!eta || !!bad || working} onClick={() => onConfirm(eta)}>{t('supplyPage.order.backorderConfirm')}</button>
      </div>
    </Modal>
  );
}

// ── Cancel item: a reason of 3–300 characters (a discontinued item) ──
function CancelLineModal({ line, working, onConfirm, onClose }) {
  const t = useT();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const valid = trimmed.length >= SUPPLY_CANCEL_REASON_MIN && trimmed.length <= SUPPLY_CANCEL_REASON_MAX;
  const item = line.name || t('supplyPage.item');
  return (
    <Modal open onClose={onClose} title={t('supplyPage.order.cancelItemTitle', { item })}>
      <p className="text-sm text-muted">{t('supplyPage.order.cancelItemHelp')}</p>
      <FormField label={t('supplyPage.order.cancelItemReason')} error={trimmed && !valid ? t('supplyPage.order.reasonInvalid') : null}>
        <textarea className="input" rows={3} value={reason} maxLength={SUPPLY_CANCEL_REASON_MAX} autoFocus onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-danger" disabled={!valid || working} onClick={() => onConfirm(trimmed)}>{t('supplyPage.order.cancelItemConfirm')}</button>
      </div>
    </Modal>
  );
}

// ── Comments: the office's notes, append-only. The id is minted ONCE per draft and kept until it
// lands, so a retry after a lost answer adds one comment (CS-798's rule). ──
function CommentsCard({ order, comments, online, ctx, onChanged }) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const draftId = useRef(null);
  async function post() {
    const text = body.trim();
    if (!text || saving) return;
    if (!draftId.current) draftId.current = suppliesApi.newSupplyCommentId();
    setSaving(true);
    try {
      await suppliesApi.addOrderComment({ id: draftId.current, requestId: order.id, body: text }, ctx);
      draftId.current = null;
      setBody(''); setOpen(false);
      toast.success(t('supplyPage.order.toast.commentAdded'));
      onChanged();
    } catch (e) {
      toast.error(t(e && e.code === 'body_too_long' ? 'supplyPage.order.commentTooLong' : 'supplyPage.toast.failed'));
    } finally { setSaving(false); }
  }
  return (
    <section className="card supply-op-card">
      <h3 className="supply-op-title">{t('supplyPage.order.commentsTitle')}</h3>
      {comments.length === 0 ? <p className="text-sm text-muted">{t('supplyPage.order.commentsNone')}</p> : (
        <ul className="supply-op-comments">
          {comments.map((c) => (
            <li key={c.id} className="supply-op-comment">
              {/* i18n-ok: the comment as its author wrote it */}
              <p>“{c.body}”</p>
              <span className="text-xs">{t('supplyPage.order.personWhen', { name: c.authorName || '—', when: c.createdAt })}</span>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <div className="supply-op-comment-form">
          <textarea className="input" rows={3} value={body} maxLength={1000} autoFocus placeholder={t('supplyPage.order.commentPlaceholder')} onChange={(e) => setBody(e.target.value)} />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => { setOpen(false); setBody(''); }}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-gold" disabled={!body.trim() || saving || !online} onClick={post}>{t('supplyPage.order.commentPost')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-outline" disabled={!online} onClick={() => setOpen(true)}>{t('supplyPage.order.addComment')}</button>
      )}
    </section>
  );
}

// ── The invoice: the Supply Manager adds the supplier's PDF / JPG / PNG (up to 10 MB) once the order
// is with the supplier; the office opens it (a 5-minute link). The document id is minted once per
// picked file and kept until it lands. ──
function InvoiceSection({ order, invoices, canManage, online, ctx, onChanged }) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef(null);
  const pending = useRef(null);   // { file, docId } — kept until the upload lands
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(null);
  const status = supplyStatusOf(order);
  const takes = status === SUPPLY_STATUS.sent || status === SUPPLY_STATUS.completed;
  async function upload(file) {
    if (!file) return;
    if (!pending.current || pending.current.file !== file) pending.current = { file, docId: suppliesApi.newSupplyDocumentId() };
    setUploading(true);
    try {
      await suppliesApi.uploadOrderInvoice({ requestId: order.id, docId: pending.current.docId, file }, ctx);
      pending.current = null;
      toast.success(t('supplyPage.order.toast.invoiceAdded'));
      onChanged();
    } catch (e) {
      toast.error(t((e && REFUSAL_KEY[e.code]) || 'supplyPage.toast.failed'));
    } finally { setUploading(false); }
  }
  async function view(inv) {
    try {
      const url = await suppliesApi.invoiceViewUrl(inv.id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(t(e && e.code === 'demo_file' ? 'supplyPage.order.invoiceDemoHint' : 'supplyPage.order.invoiceOpenFailed'));
    }
  }
  async function remove(inv) {
    try {
      await suppliesApi.invoiceDelete(inv.id, ctx);
      toast.success(t('supplyPage.order.toast.invoiceRemoved'));
      onChanged();
    } catch { toast.error(t('supplyPage.toast.failed')); }
    finally { setRemoving(null); }
  }
  return (
    <div className="supply-op-invoice">
      {invoices.length === 0 ? (
        <p className="text-sm text-muted">{takes ? t('supplyPage.order.invoiceNone') : t('supplyPage.order.invoiceWaiting')}</p>
      ) : (
        <ul className="supply-op-files">
          {invoices.map((inv) => (
            <li key={inv.id}>
              <span className="supply-op-file">
                <Icon name="paperclip" size={16} />
                {/* i18n-ok: the file's own name */}
                <span className="truncate" title={inv.fileName}>{inv.fileName}</span>
              </span>
              <span className="text-xs text-muted">{inv.uploaderName ? t('supplyPage.order.personWhen', { name: inv.uploaderName, when: inv.createdAt }) : t('supplyPage.queue.when', { when: inv.createdAt })}</span>
              <span className="supply-op-file-actions">
                {inv.demoFile
                  ? <button type="button" className="btn btn-outline" disabled>{t('supplyPage.order.invoiceDemo')}</button>
                  : <button type="button" className="btn btn-outline" disabled={!online} onClick={() => view(inv)}>{t('supplyPage.order.invoiceOpen')}</button>}
                {canManage && <button type="button" className="btn btn-outline" disabled={!online} onClick={() => setRemoving(inv)}>{t('supplyPage.order.invoiceRemove')}</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage && takes && (
        <>
          <input ref={fileRef} type="file" accept={SUPPLY_INVOICE_MIME.join(',')} hidden onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; upload(f); }} />
          <button type="button" className="btn btn-outline" disabled={uploading || !online} onClick={() => fileRef.current && fileRef.current.click()}>
            <Icon name="paperclip" size={15} /> {uploading ? t('supplyPage.order.invoiceUploading') : t('supplyPage.order.uploadInvoice')}
          </button>
        </>
      )}
      <ConfirmDialog
        open={!!removing}
        title={removing ? t('supplyPage.order.invoiceRemoveTitle', { file: removing.fileName }) : ''}
        message={t('supplyPage.order.invoiceRemoveMessage')}
        confirmLabel={t('supplyPage.order.invoiceRemove')}
        variant="danger"
        onConfirm={() => removing && remove(removing)}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
