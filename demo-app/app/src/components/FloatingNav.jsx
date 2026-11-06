import { assetUrl } from '../lib/assetUrl'; // polishpoint-demo
import { useRef, useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Icon from './Icon';
import UserSwitcher from './UserSwitcher';
import { useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { usePermissionChecker } from '../hooks/usePermission';
import { useIsMobile } from '../hooks/useIsMobile';
import { mobileTabs, mobileMenu, managerNav, supplyNav, isSupplyRole, navPath, navRowOn } from '../lib/navData';
import { seesTeamPages } from '../lib/teamScope';
import { useT } from '../i18n/react';
import { useManagerNavCounts, menuCountsFor } from '../hooks/useManagerHomeReads';
import { useFromHere } from '../hooks/useFromHere';
import { OFFICE_SCAN_PATH } from '../lib/scanLanding';

// Mobile-only (≤640px) glass floating nav — the CleanSpace port of the ReciFeast
// "liquid glass" bar (adapted: CleanSpace gold accents, no orange; see the
// no-recifeast-orange rule). Four primary tabs ride a liquid-glass pill that
// condenses on scroll; when condensed the pill becomes a single "bring to top +
// refresh" puck (up-arrow on routes with no tab selected, a full gold fill on the
// four tab routes). The glass menu button opens a frosted side panel of the
// SECONDARY sections, cascading UP from the button. Replaces the hamburger →
// slide-in sidebar as the mobile navigation. The desktop sidebar (Sidebar.jsx) is
// unchanged; this returns null above 640px.
//
// The lists mirror Sidebar.jsx's NAV (same routes/perms/crew split), with desktopOnly
// surfaces (Pipeline, Quotes) omitted on mobile. (Marketing is desktopOnly too but is
// currently dormant everywhere — gated off via MARKETING_ENABLED, lib/features.js.)
// The slide-out menu
// deliberately EXCLUDES the four primary tabs (Dashboard / Schedule / Messaging
// / Customers) — they already live in the always-visible tray, so the menu lists only
// what the tray doesn't. For a MANAGER the menu is Matt's order instead (D2, UI_RULES §152:
// lib/navData managerNav — his rows, a line, Account, then "More"); their tray never changes. A
// SUPPLY MANAGER's phone is their own app (S131 Wave 2, UI_RULES §169): the bar is Order Queue ·
// Supply Catalog · Messages (lib/navData SUPPLY_TABS) and the menu supplyNav's rows. OFFICE viewers
// only: a cleaner gets the crew shell, which mounts no FloatingNav (layouts/AppLayout, UI_RULES §165).

// The menu button shows the CleanSpace glyph when closed (see .cs-fnav-logo) and this
// X when open. (The old hamburger MenuGlyph was replaced by the logo.)
const CloseGlyph = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export default function FloatingNav() {
  // `tr`, not `t`: this component already names its tabs `t` in its loops. Every label is
  // the catalog's line in the reader's language (CS-193); labelKey comes from lib/navData.
  const tr = useT();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // The Scan row's referrer: Back from the scanner returns to the page it was opened on.
  const nav = useFromHere();
  const check = usePermissionChecker();
  const user = useSelector(selectCurrentUser);
  const isMobile = useIsMobile();
  // A MANAGER's menu is Matt's order (D2, UI_RULES §152), by ROLE like the sidebar's.
  const isManager = user?.role === 'manager';
  // The team pages (Accounts, S131): the owner's, an admin's and an Operations Manager's.
  const team = seesTeamPages(user);
  // A SUPPLY MANAGER's phone is their own app (S131 Wave 2, UI_RULES §169): their bar (Order Queue ·
  // Supply Catalog · Messages) and their menu (supplyNav), by ROLE like the manager's.
  const supply = isSupplyRole(user);

  const [menuOpen, setMenuOpen] = useState(false);
  // The manager menu's "More" list: shut until tapped (or while one of its pages is open).
  const [moreOpen, setMoreOpen] = useState(false);
  // The destination of a tap whose page is still loading. Navigations run in a React
  // transition, so `pathname` keeps the OLD route until the new page's chunk arrives; on a
  // slow network (a phone just resumed) the tray looked dead for that whole wait. Lighting
  // the tapped tab at once is the feedback; it clears as soon as the route changes.
  const [pendingTo, setPendingTo] = useState(null);
  const [condensed, setCondensed] = useState(false);
  const condensedRef = useRef(false);
  const pillRef = useRef(null);
  const tabRefs = useRef([]);

  // The primary tray tabs (Dashboard · Schedule · Messaging · Customers for the office; the supply
  // manager's own three) come from lib/navData, shared with the search launchpad's "Go to" grid.
  const tabDefs = mobileTabs(check, { supply });

  // Secondary sections only — the four primary tabs above are omitted here because
  // they already live in the always-visible tray (per Daniel's S31 request). The list lives in
  // lib/navData (MOBILE_MENU; Review is desktop-only, so it has NO entry in the phone nav), and
  // mobileMenu() drops what the viewer can't open and every tab the tray already shows.
  // A MANAGER instead gets Matt's order, a line, Account, then "More" with every other page the
  // menu offered them before (managerNav, the tray's paths excluded the same way).
  const mgr = isManager ? managerNav(check, { isMobile: true, tray: tabDefs.map((t) => t.to), team })
    : supply ? supplyNav(check, { isMobile: true, tray: tabDefs.map((t) => t.to) }) : null;
  // The count pills, the same shared reads as the sidebar's and the Home's: a manager's, and the
  // owner's and an admin's (menuCountsFor; Daniel, 2026-10-30).
  const pills = useManagerNavCounts(menuCountsFor(user?.role));
  const menuDefs = mgr ? mgr.primary : mobileMenu(check, { team });

  const shownPath = navPath(pendingTo ?? pathname);
  const shownSearch = pendingTo != null ? (String(pendingTo).split('?')[1] || '') : search;
  // Every row this phone draws (the bar and the menu, More included), for navRowOn below.
  const drawn = [...tabDefs, ...menuDefs, ...(mgr ? mgr.more : [])];
  // By PATH: a row with a query (the supply manager's Supply Catalog, the Supplies page's Catalog tab)
  // is lit on its page. Two rows on one path (the office's Supplies and Supply Catalog, task #125)
  // are lit by the query, never both (lib/navData navRowOn).
  const isActive = (to, end) => {
    const p = navPath(to);
    const onPath = end ? shownPath === p : shownPath === p || shownPath.startsWith(`${p}/`);
    return onPath && navRowOn({ to }, drawn, shownSearch);
  };
  const moreShown = !!mgr && (moreOpen || mgr.more.some((m) => isActive(m.to, m.end)));
  // The active primary tab (if the current route is one of the four); drives the
  // condensed puck's fill + icon.
  const activeTab = tabDefs.find((t) => isActive(t.to, t.end));

  // Condense the pill straight from scroll — write widths/opacities to the DOM (no
  // React render per scroll event); short CSS transitions smooth the steps.
  const applyCondense = useCallback((raw) => {
    const p = Math.max(0, Math.min(1, raw));
    const pill = pillRef.current;
    if (!pill) return;
    const tabs = tabRefs.current.filter(Boolean);
    const N = tabs.length || 1;
    const RIGHT = 100; const MINW = 58; const PAD = 0; const TABMIN = 46;
    const fullW = Math.max(N * TABMIN + PAD * 2, window.innerWidth - RIGHT);
    const tabW = (fullW - PAD * 2) / N;
    pill.style.width = `${(fullW - p * (fullW - MINW)).toFixed(1)}px`;
    tabs.forEach((t) => {
      const on = t.dataset.active === 'true';
      const lab = t.querySelector('.cs-fnav-label');
      if (on) {
        t.style.width = `${(tabW - p * (tabW - TABMIN)).toFixed(1)}px`;
        if (lab) {
          lab.style.maxWidth = `${((1 - p) * 68).toFixed(1)}px`;
          lab.style.maxHeight = `${((1 - p) * 13).toFixed(1)}px`;
          lab.style.opacity = String(1 - p);
        }
      } else {
        t.style.width = `${((1 - p) * tabW).toFixed(1)}px`;
        t.style.opacity = String(1 - p);
        t.style.paddingLeft = `${(10 * (1 - p)).toFixed(1)}px`;
        t.style.paddingRight = t.style.paddingLeft;
      }
    });
  }, []);

  useEffect(() => {
    if (!isMobile) return undefined;
    // Condense off the mobile inner-scroll container (.main), not the window — the
    // document no longer scrolls on mobile (iOS-PWA fixed-nav fix, see AppLayout).
    const scroller = document.querySelector('.main');
    if (!scroller) return undefined;
    const onScroll = () => {
      const y = scroller.scrollTop;
      applyCondense(y / 120);
      // Flip the pill into "puck" mode once it's essentially condensed; hysteresis
      // (84 down / 46 up) stops a flicker at the seam. Only setState on a real change
      // so scrolling stays render-free (applyCondense already writes the DOM directly).
      const next = condensedRef.current ? y > 46 : y > 84;
      if (next !== condensedRef.current) {
        condensedRef.current = next;
        setCondensed(next);
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [isMobile, applyCondense, pathname]);

  // Lock the background while the menu is open. The app scrolls in `.main` (the mobile
  // inner-scroll container — see AppLayout/index.css), NOT the document, so locking .main's
  // overflow reliably freezes the page behind the frosted menu (a regular element honors
  // overflow:hidden on iOS, unlike body/document). The menu keeps its own internal scroll.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const scroller = document.querySelector('.main');
    if (!scroller) return undefined;
    const prev = scroller.style.overflow;
    scroller.style.overflow = 'hidden';
    return () => { scroller.style.overflow = prev; };
  }, [menuOpen]);
  // The query too: a tap on the Supply Catalog row (/supplies?tab=catalog) from the Supplies page lands
  // on the same path, and a tap still "pending" would keep the wrong row lit.
  useEffect(() => { setMenuOpen(false); setMoreOpen(false); setPendingTo(null); }, [pathname, search]);

  if (!isMobile) return null;

  const go = (to) => {
    setMenuOpen(false);
    if (to !== pathname + search) setPendingTo(to);
    navigate(to);
  };

  // Condensed-puck tap = native "tap the active tab" affordance: smooth-scroll the
  // page to the top AND refresh the current route (AppLayout listens for the event
  // and remounts the routed page). Works on every route, tab-backed or not.
  const bringToTop = () => {
    setMenuOpen(false);
    const scroller = document.querySelector('.main');
    (scroller || window).scrollTo({ top: 0, behavior: 'smooth' });
    window.dispatchEvent(new CustomEvent('cs:refresh-route'));
  };

  return (
    <div className={`cs-fnav ${menuOpen ? 'is-open' : ''}`} data-testid="floating-nav">
      <button
        type="button"
        className="cs-fnav-scrim"
        aria-label={tr('nav.closeMenu')}
        tabIndex={menuOpen ? 0 : -1}
        onClick={() => setMenuOpen(false)}
      />

      <nav className="cs-fnav-menu" aria-label={tr('nav.allSections')} aria-hidden={!menuOpen}>
        <div className="cs-fnav-cap">{tr('nav.goTo')}</div>
        {/* Global search (MasterSearch listens for cs:open-search). Here on every page, including
            the ones whose header owns the top-right corner (Schedule, Messaging) where the
            floating magnifier steps aside. This menu is the office shell's alone: crew have no
            search (owner, 2026-09-22) and no tray at all (the crew shell, UI_RULES §165).
            Dispatched inside this tap so the sheet can focus its field and iOS raises the
            keyboard. */}
        <button
          type="button"
          className="cs-fnav-mitem"
          tabIndex={menuOpen ? 0 : -1}
          onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('cs:open-search')); }}
        >
          <span className="cs-fnav-mlabel">{tr('nav.search')}</span>
          <Icon name="search" size={22} />
        </button>
        {/* QR-21: the office's Scan, beside Search on every page of a phone, for every office viewer (this
            menu is the office shell's alone): the camera, then the scanned area's page (UI_RULES §172). */}
        <button
          type="button"
          className="cs-fnav-mitem"
          tabIndex={menuOpen ? 0 : -1}
          onClick={() => { setMenuOpen(false); navigate(OFFICE_SCAN_PATH, { state: nav }); }}
        >
          <span className="cs-fnav-mlabel">{tr('officeScan.menu')}</span>
          <Icon name="camera" size={22} />
        </button>
        {/* Report an issue — the phone's ONLY route to it (CS-049). The desktop sidebar
            owns the button, and the mobile sidebar is off-canvas and never opened, so
            crew in the field, the intended reporters, could not file anything. Dispatched
            like Search: the sidebar stays mounted and its modal portals to <body>.
            Unpermissioned on purpose — anyone who can reach a broken screen may report it. */}
        <button
          type="button"
          className="cs-fnav-mitem"
          style={{ display: 'none' }} // polishpoint-demo: no Report an issue
          tabIndex={menuOpen ? 0 : -1}
          onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('cs:open-report')); }}
        >
          <span className="cs-fnav-mlabel">{tr('nav.reportIssue')}</span>
          <Icon name="warning" size={22} />
        </button>
        {menuDefs.map((m, i) => (m.divider ? (
          <span key={`line-${i}`} className="cs-fnav-rule" role="separator" />
        ) : (
          <button
            key={`${m.to}-${m.labelKey}`}
            type="button"
            className={`cs-fnav-mitem ${isActive(m.to, m.end) ? 'is-on' : ''}`}
            tabIndex={menuOpen ? 0 : -1}
            onClick={() => go(m.to)}
          >
            {pills[m.to] > 0 ? (
              <span className="cs-fnav-badge" aria-label={tr('nav.countAria', { count: pills[m.to] })}>{pills[m.to] > 999 ? '999+' : pills[m.to]}</span>
            ) : null /* polishpoint-demo: no NEW pills */}
            <span className="cs-fnav-mlabel">{tr(m.labelKey)}</span>
            <Icon name={m.icon} size={22} />
          </button>
        )))}
        {/* The manager's "More": every other page the menu offered them before, folded under one
            row so Matt's order stays short (D2). It opens on a tap, and stays open while one of
            its pages is the one on screen. */}
        {mgr && mgr.more.length > 0 && (
          <button
            type="button"
            className={`cs-fnav-mitem cs-fnav-more ${moreShown ? 'is-open' : ''}`}
            tabIndex={menuOpen ? 0 : -1}
            aria-expanded={moreShown}
            onClick={() => setMoreOpen((o) => !o)}
          >
            <span className="cs-fnav-mlabel">{tr('nav.more')}</span>
            <Icon name={moreShown ? 'chevronUp' : 'chevronDown'} size={22} />
          </button>
        )}
        {mgr && moreShown && mgr.more.map((m) => (
          <button
            key={`more-${m.to}`}
            type="button"
            className={`cs-fnav-mitem cs-fnav-sub ${isActive(m.to, m.end) ? 'is-on' : ''}`}
            tabIndex={menuOpen ? 0 : -1}
            onClick={() => go(m.to)}
          >
            {null /* polishpoint-demo: no NEW pills */}
            <span className="cs-fnav-mlabel">{tr(m.labelKey)}</span>
            <Icon name={m.icon} size={22} />
          </button>
        ))}
        {/* Sandbox role/user switch — its home is the desktop sidebar, unreachable on
            mobile, so it lives here at the bottom-right of the menu. Its own dropdown
            opens upward (bottom:100%), clear of the nav. */}
        <div className="cs-fnav-switcher">
          <UserSwitcher />
        </div>
      </nav>

      <div ref={pillRef} className={`cs-fnav-pill ${condensed ? 'is-condensed' : ''}`} role="tablist" aria-label={tr('nav.primary')}>
        {tabDefs.map((t, i) => {
          const on = isActive(t.to, t.end);
          return (
            <button
              key={t.to}
              ref={(el) => { tabRefs.current[i] = el; }}
              data-active={on ? 'true' : 'false'}
              type="button"
              role="tab"
              aria-selected={on}
              className={`cs-fnav-tab ${on ? 'is-on' : ''}`}
              onClick={() => go(t.to)}
            >
              <Icon name={t.icon} size={22} />
              <span className="cs-fnav-label">{tr(t.labelKey)}</span>
            </button>
          );
        })}
        {/* Condensed state: the whole pill becomes one "bring to top + refresh" puck.
            Full gold fill + the active tab's icon on a tab route; a glass up-arrow on
            routes with no tab selected (was a blank puck). Hidden/inert when expanded. */}
        <button
          type="button"
          className={`cs-fnav-puck ${activeTab ? 'is-on' : ''}`}
          aria-label={tr('nav.toTop')}
          aria-hidden={!condensed}
          tabIndex={condensed ? 0 : -1}
          onClick={bringToTop}
        >
          <Icon name={activeTab ? activeTab.icon : 'chevronUp'} size={activeTab ? 22 : 25} strokeWidth={activeTab ? 2 : 2.6} />
        </button>
      </div>

      <button
        type="button"
        className="cs-fnav-menu-btn"
        aria-label={menuOpen ? tr('nav.closeMenu') : tr('nav.openMenu')}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <span className="cs-fnav-ic cs-fnav-ic-open">
          <img className="cs-fnav-logo" src={assetUrl('/cleanspace-glyph-ink.png')} alt="" aria-hidden="true" />
        </span>
        <span className="cs-fnav-ic cs-fnav-ic-close"><CloseGlyph /></span>
      </button>
    </div>
  );
}
