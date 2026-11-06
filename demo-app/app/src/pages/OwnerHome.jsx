// The owner's Home (the manager view redesign, Daniel's D1, 2026-10-09: "Ok do it."): the KPI
// Cockpit as before, with a switch at its top — "Owner cockpit · Manager view · Operations view ·
// Supply view". The Manager view is the manager Home itself (pages/ManagerHome) with the Manager
// filter (`?mgr=`, "All managers" by default). It is how Matt uses the manager Home today, on the
// one shared owner login: the owner's "View as" is view-only and could not approve hours, the switch
// reads and acts as the owner. A manager's own login lands straight on ManagerHome (App.jsx HomeRoute).
//
// The Operations view (S131, plan 2026-10-14 §0 "Previews for the one shared login") is the same
// Home as an Operations Manager sees it — their team, their account managers' section, the team
// picker — for the OM picked in `?om=`. The Supply view (S131 Wave 2) is the Supply Manager's Home,
// the Order Queue (pages/SupplyHome), acting as the owner: its tiles and the queue from approved
// onward. Both keep the owner's nav.
//
// The view is kept in the URL (`?view=manager|ops|supply`, replace) so Back and a shared link keep
// it; the cockpit is the default and drops the param. What a tap does to the URL is lib/ownerViews
// (leaving a view drops its own filters).
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import AccountDashboard from './AccountDashboard';
import ManagerHome from './ManagerHome';
import SupplyHome from './SupplyHome';
import { ownerViewParams } from '../lib/ownerViews';
import { useT } from '../i18n/react';

const MANAGER_VIEW = 'manager';
const OPS_VIEW = 'ops';
const SUPPLY_VIEW = 'supply';

export default function OwnerHome() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const view = params.get('view');
  const manager = view === MANAGER_VIEW;
  const ops = view === OPS_VIEW;
  const supply = view === SUPPLY_VIEW;
  const cockpit = !manager && !ops && !supply;
  const show = (next) => {
    const p = ownerViewParams(params, next);
    if (p) setParams(p, { replace: true });
  };
  // On a phone the switch is a scrolling rail (UI_RULES R9) and four views overflow it: the one on
  // screen is scrolled into reach, so the Supply view never opens with its own tab out of sight.
  const railRef = useRef(null);
  useEffect(() => {
    const on = railRef.current?.querySelector('.tab-btn.active');
    if (on && typeof on.scrollIntoView === 'function') on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [view]);
  const tab = (on, next, label) => (
    <button type="button" className={`tab-btn ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => show(next)}>
      {label}
    </button>
  );
  return (
    <>
      <div ref={railRef} className="tab-container-line mgrh-switch" role="group" aria-label={t('mgrHome.switch.aria')}>
        {tab(cockpit, '', t('mgrHome.switch.owner'))}
        {tab(manager, MANAGER_VIEW, t('mgrHome.switch.manager'))}
        {tab(ops, OPS_VIEW, t('mgrHome.switch.ops'))}
        {tab(supply, SUPPLY_VIEW, t('mgrHome.switch.supply'))}
      </div>
      {manager ? <ManagerHome /> : ops ? <ManagerHome opsView /> : supply ? <SupplyHome /> : <AccountDashboard variant="C" />}
    </>
  );
}
