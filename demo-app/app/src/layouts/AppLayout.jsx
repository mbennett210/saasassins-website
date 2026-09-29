import { useState, useEffect, Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import FloatingNav from '../components/FloatingNav';
import MessagesDock from '../components/MessagesDock';
import NotificationsBell from '../components/NotificationsBell';
import SyncIndicator from '../components/SyncIndicator';
import MasterSearch from '../components/MasterSearch';
import RoleSyncBanner from '../components/RoleSyncBanner';
import DemoBackendsBanner from '../components/DemoBackendsBanner';
import OfflineQueueFailures from '../components/OfflineQueueFailures';

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);

  // Mobile "bring to top + refresh": the condensed floating-nav puck (FloatingNav)
  // scroll-to-tops the window and fires `cs:refresh-route`; bumping this key remounts
  // the routed page so its data/derived state re-runs fresh (the native tap-active-tab
  // affordance). display:contents keeps the wrapper layout-invisible.
  const [routeRefreshKey, setRouteRefreshKey] = useState(0);
  useEffect(() => {
    const onRefresh = () => setRouteRefreshKey((k) => k + 1);
    window.addEventListener('cs:refresh-route', onRefresh);
    return () => window.removeEventListener('cs:refresh-route', onRefresh);
  }, []);

  // iOS standalone PWAs size `position: fixed` to a short, STICKY viewport, which floats
  // the bottom nav mid-screen and lets the page scroll behind the open menu. GLD's fix
  // (GLD/life-tracker docs/MOBILE_LAYOUT.md + the ReciFeast port): measure the real viewport
  // height into `--cs-vh` and drive a mobile inner-scroll shell off it (index.css @≤640) —
  // #root becomes that exact height, `.main` scrolls INSIDE it, the nav is absolute within
  // #root, and full-bleed pages (messaging) read `var(--cs-vh)` for their height too so they
  // resize WITH the shell. The document never scrolls, so the nav stays pinned to the bottom.
  //
  // THE RESUME SMOOSH (S39): on tab-out→back-in / cold launch / in-call, iOS reports a stale
  // SHORT innerHeight AT the resume event and only corrects it a few hundred ms later — a
  // single re-measure locks in the short value and jams the layout up under the status bar.
  // Fix (per the ReciFeast note): re-measure in a BURST at 0/60/250/600ms after every resume
  // signal, AND FLOOR it — never shrink below a height already measured for this orientation
  // — so neither the stale-short reading nor the settle-timing gap can collapse the shell.
  // The nav (.cs-fnav) is already position:absolute inside #root (S34). No-op cost on desktop.
  useEffect(() => {
    const root = document.documentElement;
    let vh = 0;            // last published shell height (px)
    let timers = [];
    // grow=true → floor (never shrink; survives a stale-short resume reading). Orientation
    // change is the one legit height change (manifest is orientation:any) → grow=false so a
    // shorter landscape recalibrates instead of sticking tall.
    const apply = (grow) => {
      const h = window.innerHeight;
      vh = grow ? Math.max(vh, h) : h;
      root.style.setProperty('--cs-vh', `${vh}px`);
    };
    const burst = (grow) => {
      apply(grow);
      timers.forEach(clearTimeout);
      timers = [60, 250, 600].map((ms) => setTimeout(() => apply(grow), ms));
    };
    const onResume = () => burst(true);
    const onResize = () => apply(true);
    const onOrient = () => burst(false);
    const onVisible = () => { if (document.visibilityState === 'visible') burst(true); };
    burst(true);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onOrient);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onOrient);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    <>
      <DemoBackendsBanner />
      <RoleSyncBanner />
      {/* No mobile top bar (S31): on mobile the bell floats top-right via .bell-floater
          (same as desktop) and content starts right under the OS status bar for max room.
          Home is the Dashboard tab in the floating nav. */}
      <div
        className={`sidebar-overlay ${mobileOpen ? 'visible' : ''}`}
        onClick={() => setMobileOpen(false)}
      />
      <Sidebar
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <main className="main">
        {/* Global search (UI_RULES §116): the fixed desktop top bar, or on mobile a magnifier
            + full-screen sheet. INSIDE .main on purpose, like the bell floater and the
            Messages dock: sharing .main's stacking context means the bell (z 50) paints over
            the bar (z 40), and content drawers/scrims (z 60+) paint over both. */}
        <MasterSearch />
        <div className="bell-floater">
          <SyncIndicator />
          <NotificationsBell />
        </div>
        {/* Buffered checklists / photos that stopped retrying (CS-007). Kept on the device,
            never deleted silently — Retry or Discard. Mounted ONCE here, not per page: a
            cleaner meets it wherever they work a clean (My Day, the crew visit, a job page)
            and it can't render twice; it self-hides when there is nothing failed, and it
            sits inside .main so it already has the page gutter. */}
        <OfflineQueueFailures />
        {/* Page-content Suspense so a lazy route chunk loads WITHOUT tearing down the
            sidebar/nav. Only this area shows the fallback while the chunk arrives. */}
        <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}>
          <div key={routeRefreshKey} style={{ display: 'contents' }}>
            <Outlet />
          </div>
        </Suspense>
        {/* Desktop-only (>640px) floating Messages dock — renders null on mobile.
            Mounted INSIDE .main (not as a sibling) on purpose: it shares .main's
            stacking context, so content-rendered popouts/drawers — e.g. the Payroll
            drawer (.pay-scrim/.pay-drawer at z 60/61) — stack ABOVE the dock (z 50)
            and it sits BEHIND the popout instead of covering pertinent info. .main has
            no transform on desktop, so the fixed dock still pins to the viewport. */}
        <MessagesDock />
      </main>
      {/* Mobile-only (≤640px) glass floating nav — renders null on desktop. */}
      <FloatingNav />
    </>
  );
}
