// ONE SUPPLY ORDER on the cleaner's phone (S131 Builder C; plan docs/plans/2026-10-14-supply-orders.md
// §4 "Cleaner Hub"; UI_RULES §170) — `/my-day/supplies/orders/:id` (crewPaths.supplyOrder), opened from
// the Request Supplies page (its last order and its history) and from every supply bell a cleaner gets
// (lib/supplyFlow supplyOrderLinkFor). So it opens COLD: with no referrer, Back goes to Request
// Supplies for the order's building.
//
//   back · "Order #SO-1046" · the building
//   Items — the status in the cleaner's words, then each line's state with when: delivered on …,
//   backordered with the supplier's day, on order, not available (pages/crew/supplyOrderParts)
//   Approval — who asked for it and when; who approved it and when, or who declined it, when and why
//   (the reason their bell carried); "Waiting for approval" while it waits
//
// ONE read, GET /api/supplies/crew-order (EP-400): the cleaner's OWN order at a building they clean,
// field by field (lib/supplies supplyCrewOrder) — NO prices, totals or office files; any other order
// is "not one you can open" (the server's one 404, naming nothing). The owner's View-as reads through
// the office's door. Nothing on this page writes.
//
// Every word is a catalog line (`crewSupplyOrder.*`, `crewSupplies.*`); item and building names
// travel as written.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import Badge from '../../components/Badge';
import { useT } from '../../i18n/react';
import { useBackTarget } from '../../hooks/useBackTarget';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { usePermission } from '../../hooks/usePermission';
import { useGetState, useSelector } from '../../store';
import { selectCurrentUser, selectClientById } from '../../store/selectors';
import { crewPaths } from '../../lib/crewPaths';
import { SUPPLY_STATUS, supplyOrderLabelKey, supplyOrderVariant } from '../../lib/supplies';
import * as suppliesApi from '../../lib/suppliesApi';
import { CrewOrderLines } from './supplyOrderParts';

export default function CrewSupplyOrder() {
  const { id } = useParams();
  const t = useT();
  const online = useOnlineStatus();
  const getState = useGetState();
  const canRequest = usePermission('supplies.request');
  const canView = usePermission('supplies.view');
  const me = useSelector(selectCurrentUser);

  const [read, setRead] = useState({ loading: true, order: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, []);
  useEffect(() => {
    if (!canRequest || !id) { setRead({ loading: false, order: null, error: null }); return undefined; }
    let live = true;
    setRead((r) => ({ loading: true, order: r.order && r.order.id === id ? r.order : null, error: null }));
    suppliesApi.crewOrder(id, { state: getState(), user: me, holds: { request: canRequest, view: canView } })
      .then((res) => { if (live) setRead({ loading: false, order: (res && res.order) || null, error: null }); })
      .catch((err) => { if (live) setRead({ loading: false, order: null, error: err || {} }); });
    return () => { live = false; };
    // `me` and the store are read for the demo stub only; the identity that matters is the login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canRequest, me?.id, tick]);

  const order = read.order;
  const clientId = order ? order.clientId : null;
  const building = useSelector(useCallback((s) => (clientId ? selectClientById(s, clientId) : null), [clientId]));
  const { href, label, goBack } = useBackTarget(crewPaths.supplies(clientId), t('crewSupplies.title'));

  const head = (
    <header className="crew-sup-head">
      <a href={href} onClick={goBack} className="btn-icon crew-sup-back" aria-label={label}>
        <Icon name="chevronLeft" size={20} />
      </a>
      <div className="crew-sup-head-text">
        <h1 className="crew-sup-title">{order && order.no ? t('crewSupplyOrder.title', { no: order.no }) : t('crewSupplyOrder.titleNoNumber')}</h1>
        {building?.name && <div className="crew-sup-sub">{building.name}</div>}
      </div>
    </header>
  );

  if (!canRequest) {
    return (
      <div className="crew-sup">
        {head}
        <div className="card crew-sup-card crew-sup-note" role="status"><Icon name="lock" size={18} /><span>{t('crewSupplies.off')}</span></div>
      </div>
    );
  }

  if (!order) {
    const err = read.error;
    const gone = !!err && err.code === 'not_found';
    const noSignal = !online || (!!err && err.status == null);
    return (
      <div className="crew-sup">
        {head}
        {read.loading ? (
          <p className="crew-sup-muted" role="status">{t('common.loading')}</p>
        ) : gone ? (
          <div className="card crew-sup-card crew-sup-note" role="status">
            <Icon name="warning" size={18} />
            <span>{t('crewSupplyOrder.notFound')}</span>
            <Link className="btn btn-outline crew-sup-retry" to={crewPaths.supplies()}>{t('crewSupplyOrder.backToSupplies')}</Link>
          </div>
        ) : (
          <div className="card crew-sup-card crew-sup-note" role="status">
            <Icon name="warning" size={18} />
            <span>{noSignal ? t('crewSupplyOrder.offline') : t('crewSupplyOrder.loadFailed')}</span>
            <button type="button" className="btn btn-outline crew-sup-retry" onClick={() => setTick((n) => n + 1)}>{t('crewSupplies.tryAgain')}</button>
          </div>
        )}
      </div>
    );
  }

  const at = (iso) => ({ day: iso, time: iso });
  return (
    <div className="crew-sup">
      {head}

      <section className={`card crew-sup-card crew-sup-last is-${supplyOrderVariant(order)}`} aria-labelledby="crew-sup-order-items">
        <div className="crew-sup-last-head">
          <h2 id="crew-sup-order-items" className="crew-sup-kicker">{t('crewSupplyOrder.items')}</h2>
          <Badge variant={supplyOrderVariant(order)}>{t(supplyOrderLabelKey(order, 'crew'))}</Badge>
        </div>
        <CrewOrderLines order={order} withWhen />
      </section>

      <section className="card crew-sup-card" aria-labelledby="crew-sup-order-who">
        <h2 id="crew-sup-order-who" className="crew-sup-kicker">{t('crewSupplyOrder.approval')}</h2>
        <ul className="crew-sup-lines">
          {order.requestedAt && (
            <li className="crew-sup-line is-asked">
              <Icon name="user" size={16} />
              <span className="crew-sup-line-text">
                {order.requestedBy
                  ? t('crewSupplyOrder.requested', { name: order.requestedBy, ...at(order.requestedAt) })
                  : t('crewSupplyOrder.requestedNoName', at(order.requestedAt))}
              </span>
            </li>
          )}
          {order.approvedAt && (
            <li className="crew-sup-line is-delivered">
              <Icon name="check" size={16} />
              <span className="crew-sup-line-text">
                {order.approvedBy
                  ? t('crewSupplyOrder.approved', { name: order.approvedBy, ...at(order.approvedAt) })
                  : t('crewSupplyOrder.approvedNoName', at(order.approvedAt))}
              </span>
            </li>
          )}
          {order.declinedAt && (
            <li className="crew-sup-line is-unavailable">
              <Icon name="x" size={16} />
              <span className="crew-sup-line-text">
                <span>
                  {order.declinedBy
                    ? t('crewSupplyOrder.declined', { name: order.declinedBy, ...at(order.declinedAt) })
                    : t('crewSupplyOrder.declinedNoName', at(order.declinedAt))}
                </span>
                {order.declineReason && <span className="crew-sup-line-sub">{t('crewSupplyOrder.declineReason', { reason: order.declineReason })}</span>}
              </span>
            </li>
          )}
          {order.status === SUPPLY_STATUS.requested && (
            <li className="crew-sup-line is-onorder">
              <Icon name="clock" size={16} />
              <span className="crew-sup-line-text">{t('crewSupplyOrder.waiting')}</span>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
