import { useState, useEffect, useLayoutEffect, Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { APP_SHELL_CLASS } from '../lib/appShell';
import Sidebar from '../components/Sidebar';
import FloatingNav from '../components/FloatingNav';
import MessagesDock from '../components/MessagesDock';
import NotificationsBell from '../components/NotificationsBell';
import SyncIndicator from '../components/SyncIndicator';
import MasterSearch from '../components/MasterSearch';
import RoleSyncBanner from '../components/RoleSyncBanner';
import DemoBackendsBanner from '../components/DemoBackendsBanner';
import OfflineQueueFailures from '../components/OfflineQueueFailures';
import SyncProblemDialog from '../components/SyncProblemDialog';
import ReportIssueHost from '../components/ReportIssueHost';
import PageScroll from '../components/PageScroll';
import { prefetchTicketCounts } from '../hooks/useTicketFlags';
import { prefetchSupplyBudgets } from '../hooks/useSupplyBudgets';
import { usePermission } from '../hooks/usePermission';
import { CrewPreviewLine, CrewBackBar } from '../components/CrewChrome';
import { useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { isCrewRole } from '../lib/navData';
import { useT } from '../i18n/react';

export default function AppLayout() {
  const t = useT();
  const [mobileOpen, setMobileOpen] = useState(false);
  // THE CREW SHELL (the Cleaner Hub, 2026-10-13; plan docs/plans/2026-10-13-cleaner-hub.md D6/D7,
  // UI_RULES §165): a cleaner's app is a phone app — no sidebar, no bottom tray, no global search,
  // no Messages dock, no floating bell (the bell, Messages and the account menu sit in Home's
  // header). "Crew" is lib/navData's one rule, by ROLE, the same the sidebar and the tray use; the
  // owner's View-as a cleaner reads the viewed person, so the preview draws the cleaner's app.
  const me = useSelector(selectCurrentUser);
  const crew = isCrewRole(me);
  const seesTickets = usePermission('qc.view');
  const seesSupplies = usePermission('supplies.view');

  // CS-962, CS-963: the ticket counts behind the customers' "tickets in 30 days" flags and the
  // supply spend behind "Over supply budget" are read as the app opens and kept
  // (hooks/useTicketFlags.js, hooks/useSupplyBudgets.js), so the Customers list and a customer's
  // page draw with their flags in place. The office's only: a cleaner's app shows no flag.
  useEffect(() => {
    if (!crew && seesTickets) prefetchTicketCounts(me?.id ?? null);
    if (!crew && seesSupplies) prefetchSupplyBudgets(me?.id ?? null);
  }, [crew, seesTickets, seesSupplies, me?.id]);

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

  // The phone scroll lock is the office shell's alone (UI_RULES §106): index.css writes it
  // under html.<APP_SHELL_CLASS>, set here while the shell is mounted and removed when it
  // unmounts, so every page outside the shell (the login, the public quote / report / scan
  // pages, the customer hub) scrolls as an ordinary document. A LAYOUT effect, so the shell's
  // first paint is already locked: a plain effect would paint one frame with a scrolling
  // document and the nav at the bottom of the content instead of the screen.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add(APP_SHELL_CLASS);
    return () => html.classList.remove(APP_SHELL_CLASS);
  }, []);

  // iOS standalone PWAs size `position: fixed` to a short, STICKY viewport, which floats
  // the bottom nav mid-screen and lets the page scroll behind the open menu. GLD's fix
  // (GLD/life-tracker docs/MOBILE_LAYOUT.md + the ReciFeast port): measure the real viewport
  // height into `--cs-vh` and drive a mobile inner-scroll shell off it (index.css @≤640,
  // under the class above) — #root becomes that exact height, `.main` scrolls INSIDE it, the
  // nav is absolute within #root, and full-bleed pages (messaging) read `var(--cs-vh)` for
  // their height too so they resize WITH the shell. The document never scrolls, so the nav
  // stays pinned to the bottom.
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

  // The route's page, under one Suspense so a lazy chunk loads without tearing down the frame
  // (only this area shows the fallback while it arrives). Shared by both shells.
  const page = (
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{t('common.loading')}</div>}>
      <div key={routeRefreshKey} style={{ display: 'contents' }}>
        <Outlet />
      </div>
    </Suspense>
  );

  if (crew) {
    // One phone-width column on EVERY viewport (D7), centred; `.main` stays the iOS inner scroller
    // (index.css @≤640). The preview line and the back bar sit above it, outside the scroller, so
    // they never scroll away and a full-bleed page (Messaging) still fills what is left.
    return (
      <>
        <div className="crew-shell">
          <DemoBackendsBanner />
          <RoleSyncBanner />
          <CrewPreviewLine />
          <CrewBackBar />
          <main className="main crew-shell-main">
            {/* Buffered checklists / photos that stopped retrying (CS-007) and a change the
                server refused (CS-008): once each, as in the office shell. */}
            <OfflineQueueFailures />
            <SyncProblemDialog />
            {/* Where the page opens (CS-960, UI_RULES §186): before the page, as in the office shell. */}
            <PageScroll />
            {page}
          </main>
        </div>
        <ReportIssueHost />
      </>
    );
  }

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
            the bar (z 40). Side panels and pop-ups portal to <body> and paint over all of it
            (UI_RULES §105). */}
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
        {/* A change the server refused, named, until the person closes it (CS-008). Once,
            here: it portals to <body>, and a second mount would show the message twice. */}
        <SyncProblemDialog />
        {/* Where the page opens (CS-960, UI_RULES §186): at its top, or where Back left it, before
            its first frame. BEFORE the page on purpose, so its layout effect runs ahead of the
            page's own and a page that moves itself (a QR code's area) still has the last word. */}
        <PageScroll />
        {/* Page-content Suspense so a lazy route chunk loads WITHOUT tearing down the
            sidebar/nav. Only this area shows the fallback while the chunk arrives. */}
        {page}
        {/* Desktop-only (>640px) floating Messages dock — renders null on mobile.
            Mounted INSIDE .main (not as a sibling) on purpose: it shares .main's
            stacking context, so a popout a page draws inside .main stacks ABOVE the dock
            (z 50) and the dock sits BEHIND it instead of covering pertinent info. The side
            panels (work order, Payroll) and every pop-up portal to <body>, over the whole
            app (UI_RULES §105). .main has no transform on desktop, so the fixed dock still
            pins to the viewport. */}
        <MessagesDock />
      </main>
      {/* Mobile-only (≤640px) glass floating nav — renders null on desktop. */}
      <FloatingNav />
      {/* "Report an issue": the one form every surface asks for (cs:open-report, CS-049). */}
      <ReportIssueHost />
    </>
  );
}
