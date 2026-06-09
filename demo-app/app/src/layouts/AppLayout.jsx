import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import NotificationsBell from '../components/NotificationsBell';
import { useStore } from '../store';
import { selectCompany } from '../store/selectors';
import { IS_DEMO } from '../demo/isDemo';
import DemoTopBar from '../demo/components/DemoTopBar';
import PlacementCTAs from '../demo/components/PlacementCTAs';
import InfoPinLayer from '../demo/tour/InfoPinLayer';

export default function AppLayout() {
  const company = selectCompany(useStore());
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Demo-only: persistent top bar (back to modules + cart/checkout). It folds
          in the notifications bell, so the bell-floater + mobile-header bell below
          are suppressed in the demo. */}
      {IS_DEMO && <DemoTopBar />}
      <div className="mobile-header">
        <button
          className={`hamburger ${mobileOpen ? 'open' : ''}`}
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          <span />
        </button>
        <div className="mobile-brand">{company.name}</div>
        {!IS_DEMO && <NotificationsBell />}
      </div>
      <div
        className={`sidebar-overlay ${mobileOpen ? 'visible' : ''}`}
        onClick={() => setMobileOpen(false)}
      />
      <Sidebar
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <main className="main">
        {!IS_DEMO && (
          <div className="bell-floater">
            <NotificationsBell />
          </div>
        )}
        <Outlet />
        {/* Demo-only: in-content "i" info pins — gentle pings beside each section's header. */}
        {IS_DEMO && <InfoPinLayer />}
        {/* Demo-only: route-aware in-context module upsell (null outside demo / unmapped routes). */}
        {IS_DEMO && <PlacementCTAs />}
      </main>
    </>
  );
}
