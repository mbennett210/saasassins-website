// The cleaner's supplies line on My Stops Today and the visit (Matt, SUP-16 a, 2026-10-12: "so they know
// the supplies are on property, especially if they're not there that day"; plan 2026-10-12 §2, S6) —
// PER LINE since S131 Builder C (Matt's board: "Paper towels delivered today at 9:15 AM · Trash liners
// backordered, ETA Oct 21"):
//
//   Paper towels ×3 delivered today at 9:15 AM          ← each line that came today, with when
//   Trash liners ×2 backordered — ETA Oct 21            ← each line the supplier has on backorder
//   Supplies on the way: Hand soap ×5                   ← everything else submitted, not here yet
//
// `entry` is one building's answer from hooks/useOnsiteSupplies (GET /api/supplies/onsite, lib/supplies
// supplyCrewBuildings): item names and quantities, the day's times and the supplier's day — nothing
// else ever reaches a cleaner, and every cleaner at the building reads the same line. After the day it
// lands, the route stops returning a delivery and its line goes. Nothing at all renders for a building
// with nothing to say. Every word is a catalog line (`crewSupply.*`); item names travel as written.
import Icon from './Icon';
import { useT } from '../i18n/react';
import { supplyEtaInstant } from '../lib/supplies';

export default function CrewSupplyNote({ entry }) {
  const t = useT();
  const delivered = (entry && entry.delivered) || [];
  const backordered = (entry && entry.backordered) || [];
  const coming = (entry && entry.onTheWay) || [];
  if (!delivered.length && !backordered.length && !coming.length) return null;
  const item = (it) => t('supplyPage.lineQty', { item: it.name || t('supplyPage.item'), qty: it.qty });
  return (
    <div className="supply-crew" role="status">
      {/* The lines come whole with each read and never reorder in place: their position is their key. */}
      {delivered.map((d, i) => (
        <div key={`d${i}`} className="supply-crew-line is-delivered">
          <Icon name="check" size={15} />
          <span className="supply-crew-text">{t('crewSupply.lineDelivered', { item: item(d), time: d.at })}</span>
        </div>
      ))}
      {backordered.map((b, i) => (
        <div key={`b${i}`} className="supply-crew-line is-backordered">
          <Icon name="clock" size={15} />
          <span className="supply-crew-text">
            {b.eta ? t('crewSupply.lineBackordered', { item: item(b), eta: supplyEtaInstant(b.eta) }) : t('crewSupply.lineBackorderedNoEta', { item: item(b) })}
          </span>
        </div>
      ))}
      {coming.length > 0 && (
        <div className="supply-crew-line is-coming">
          <Icon name="box" size={15} />
          <span className="supply-crew-text">{t('crewSupply.onTheWay', { items: coming.map(item) })}</span>
        </div>
      )}
    </div>
  );
}
