// The Supply Manager's four tiles (S131, Matt's boards sm-web-01 / sm-mobile-01): New orders · With
// supplier · Partially fulfilled · Completed today — over the order queue, for whoever holds
// supplies.manage (the Supplies page) and on the Supply Manager's Home (pages/SupplyHome). The counts
// are the queue's own (GET /api/supplies/orders `counts`; "Completed today" in the ORG's zone, II.8),
// and each tile opens its tab (?status=) on the page it sits on. Kit StatCards, one row of four on a
// desktop, two by two on a phone (the kit's auto-fit grid).
import StatCard from './StatCard';
import { useT } from '../i18n/react';

export default function SupplyQueueTiles({ counts, basePath = '' }) {
  const t = useT();
  const n = (k) => (counts ? counts[k] || 0 : '—');
  const to = (status) => `${basePath}?status=${status}`;
  return (
    <div className="stat-grid supply-tiles">
      <StatCard label={t('supplyPage.tiles.new')} value={n('approved')} to={to('approved')} />
      <StatCard label={t('supplyPage.tiles.supplier')} value={n('sent')} to={to('sent')} />
      <StatCard label={t('supplyPage.tiles.partial')} value={n('partial')} to={to('partial')} />
      <StatCard label={t('supplyPage.tiles.completedToday')} value={n('completedToday')} to={to('completed')} />
    </div>
  );
}
