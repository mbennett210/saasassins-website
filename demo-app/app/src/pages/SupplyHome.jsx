// The Supply Manager's HOME (S131, Matt's boards sm-mobile-01 / sm-web-01: "Hey, Renee · Supply
// Coordinator", four tiles, the Order Queue): the `supply_manager` role's `/` (App.jsx HomeRoute,
// Wave 2) and the owner's Supply view (pages/OwnerHome `?view=supply`, acting as the owner). Its nav
// is lib/navData supplyNav (UI_RULES §169); test-supplies-page.mjs and test-supply-home-render.mjs
// hold the page, test-supply-shell.mjs the mount.
//
// ONE queue: the same components/SupplyQueue the Supplies page's Requests tab reads (II.5), limited to
// approved onward (lib/supplies SUPPLY_MANAGER_TABS — Matt: only approved orders reach the Supply
// Manager), with the tiles over it (components/SupplyQueueTiles). A row opens the order page.
import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { roleLabel } from '../lib/roles';
import { SUPPLY_MANAGER_TABS } from '../lib/supplies';
import SupplyQueue from '../components/SupplyQueue';
import SupplyQueueTiles from '../components/SupplyQueueTiles';
import { useT } from '../i18n/react';

export default function SupplyHome() {
  const t = useT();
  const state = useStore();
  const online = useOnlineStatus() !== false;
  const { currentUser } = useAuth();
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
  const [counts, setCounts] = useState(null);
  const onCounts = useCallback((c) => setCounts(c), []);
  const first = String(currentUser?.name || '').trim().split(/\s+/)[0] || '';

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>{first ? t('supplyPage.home.greeting', { name: first }) : t('supplyPage.home.title')}</h1>
          <p className="page-sub">{roleLabel(t, currentUser?.role)}</p>
        </div>
      </div>
      {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}
      <SupplyQueueTiles counts={counts} />
      <div className="section-head"><h3>{t('supplyPage.home.queueTitle')}</h3></div>
      <SupplyQueue ctx={ctx} tabs={SUPPLY_MANAGER_TABS} onCounts={onCounts} />
    </div>
  );
}
