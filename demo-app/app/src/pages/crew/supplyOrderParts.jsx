// The lines of one of the cleaner's supply orders, in their words — drawn by the Request Supplies page
// ("Your last order") and by the order's own page (S131 Builder C; Matt's RequestSupplies board:
// "Paper towels (3) delivered" · "Trash liners (2) backordered — ETA Oct 21"). ONE place, so the two
// screens can never word a line two ways.
//
// Once the order is with the supplier (submitted or completed) each line says its OWN state — lib/
// supplies supplyLineState through the crew shape (supplyCrewOrder): delivered · backordered with the
// supplier's day (the org's calendar) · on order · not available; a line part-way there says how many
// came. Before that a line is what was asked for. `withWhen` (the order's page) adds when the last of a
// line came. Built from the crew shape alone: no money; a line the office could not get says "not
// available" and the office's reason, as the cleaner's bell already did (S131 integration). Every word is a catalog line
// (`crewSupplies.*`, `crewSupplyOrder.*`); item names travel as written.
import Icon from '../../components/Icon';
import { useT } from '../../i18n/react';
import { SUPPLY_LINE_STATE, SUPPLY_STATUS, supplyEtaInstant } from '../../lib/supplies';

// The icon and the tint of each state.
const LOOK = {
  [SUPPLY_LINE_STATE.delivered]: { icon: 'check', tone: 'is-delivered' },
  [SUPPLY_LINE_STATE.backordered]: { icon: 'clock', tone: 'is-backordered' },
  [SUPPLY_LINE_STATE.cancelled]: { icon: 'x', tone: 'is-unavailable' },
  [SUPPLY_LINE_STATE.pending]: { icon: 'box', tone: 'is-onorder' },
};
const ASKED = { icon: 'box', tone: 'is-asked' };

// Is the order with the supplier (or done), so its lines have states of their own?
const hasLineStates = (order) => order && (order.status === SUPPLY_STATUS.sent || order.status === SUPPLY_STATUS.completed);

// "Paper towels (3)": the item and how many were asked for.
export function crewItemQty(t, l) {
  return t('crewSupplies.itemQty', { item: l.name || t('supplyPage.item'), qty: l.qty });
}

// One line's sentence.
function lineText(t, l, withStates) {
  const item = crewItemQty(t, l);
  if (!withStates) return item;
  if (l.state === SUPPLY_LINE_STATE.delivered) return t('crewSupplies.line.delivered', { item });
  if (l.state === SUPPLY_LINE_STATE.backordered) {
    return l.eta ? t('crewSupplies.line.backordered', { item, eta: supplyEtaInstant(l.eta) }) : t('crewSupplies.line.backorderedNoEta', { item });
  }
  if (l.state === SUPPLY_LINE_STATE.cancelled) {
    return l.reason ? t('crewSupplies.line.notAvailableReason', { item, reason: l.reason }) : t('crewSupplies.line.notAvailable', { item });
  }
  return t('crewSupplies.line.onOrder', { item });
}

export function CrewOrderLines({ order, withWhen = false }) {
  const t = useT();
  const withStates = hasLineStates(order);
  const lines = (order && Array.isArray(order.lines)) ? order.lines : [];
  return (
    <ul className="crew-sup-lines">
      {lines.map((l, i) => {
        const look = withStates ? (LOOK[l.state] || LOOK[SUPPLY_LINE_STATE.pending]) : ASKED;
        const partly = withStates && l.delivered > 0 && l.delivered < l.qty;
        const when = withWhen && withStates && l.deliveredAt
          ? (l.state === SUPPLY_LINE_STATE.delivered
            ? t('crewSupplyOrder.deliveredOn', { day: l.deliveredAt, time: l.deliveredAt })
            : t('crewSupplyOrder.lastDeliveryOn', { day: l.deliveredAt, time: l.deliveredAt }))
          : null;
        return (
          // A line has no id of its own: its place in the order is its key (an order's lines never move).
          <li key={i} className={`crew-sup-line ${look.tone}`}>
            <Icon name={look.icon} size={16} />
            <span className="crew-sup-line-text">
              <span>{lineText(t, l, withStates)}</span>
              {partly && <span className="crew-sup-line-sub">{t('crewSupplies.line.partly', { delivered: l.delivered, qty: l.qty })}</span>}
              {when && <span className="crew-sup-line-sub">{when}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
