import { useRef, useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Icon from './Icon';
import UserSwitcher from './UserSwitcher';
import { assetUrl } from '../lib/assetUrl';
import { useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { usePermissionChecker } from '../hooks/usePermission';
import { useIsMobile } from '../hooks/useIsMobile';
import { mobileTabs } from '../lib/navData';

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
// deliberately EXCLUDES the four primary tabs (Dashboard / Schedule·My Day / Messaging
// / Customers) — they already live in the always-visible tray, so the menu lists only
// what the tray doesn't.

// The menu button shows the CleanSpace glyph when closed (see .cs-fnav-logo) and this
// X when open. (The old hamburger MenuGlyph was replaced by the logo.)
const CloseGlyph = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export default function FloatingNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const check = usePermissionChecker();
  const user = useSelector(selectCurrentUser);
  const isMobile = useIsMobile();
  const isCrew = user?.role === 'crew';

  const [menuOpen, setMenuOpen] = useState(false);
  // The destination of a tap whose page is still loading. Navigations run in a React
  // transition, so `pathname` keeps the OLD route until the new page's chunk arrives; on a
  // slow network (a phone just resumed) the tray looked dead for that whole wait. Lighting
  // the tapped tab at once is the feedback; it clears as soon as the route changes.
  const [pendingTo, setPendingTo] = useState(null);
  const [condensed, setCondensed] = useState(false);
  const condensedRef = useRef(false);
  const pillRef = useRef(null);
  const tabRefs = useRef([]);

  // The four primary tray tabs (Dashboard · Schedule/My Day · Messaging · Customers/
  // Quality) come from lib/navData, shared with the search launchpad's "Go to" grid.
  const tabDefs = mobileTabs(check, isCrew);

  // Secondary sections only — the four primary tabs above are omitted here because
  // they already live in the always-visible tray (per Daniel's S31 request).
  const menuDefs = [
    // Review is desktop-only (like Pipeline / Quotes), so it has NO entry in the phone nav.
    { to: '/time', label: 'Time Clock', icon: 'schedule', perm: 'time.view' },
    { to: '/variance', label: 'Variance', icon: 'chart', perm: 'variance.view' },
    { to: '/payroll', label: 'Payroll', icon: 'invoices', perm: 'payroll.view', badge: 'NEW' },
    { to: '/hr', label: 'HR', icon: 'clients', perm: 'hr.view', badge: 'NEW' },
    { to: '/inspections', label: 'Quality', icon: 'check', perm: 'qc.view' },
    { to: '/keys', label: 'Keys', icon: 'lock', perm: 'keys.view' },
    { to: '/supplies', label: 'Supplies', icon: 'box', perm: 'supplies.view', badge: 'NEW' },
    { to: '/reviews', label: 'Reviews', icon: 'star', perm: 'reviews.view' },
    { to: '/invoices', label: 'Invoices', icon: 'invoices', perm: 'invoices.view' },
    { to: '/settings', label: 'Settings', icon: 'settings', perm: 'settings.account' },
  ].filter(Boolean).filter((m) => check(m.perm))
    // Never duplicate a primary tray tab in the menu (e.g. crew's Quality now lives in
    // the tray).
    .filter((m) => !tabDefs.some((t) => t.to === m.to));

  const shownPath = pendingTo ?? pathname;
  const isActive = (to, end) => (end ? shownPath === to : shownPath === to || shownPath.startsWith(`${to}/`));
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
  useEffect(() => { setMenuOpen(false); setPendingTo(null); }, [pathname]);

  if (!isMobile) return null;

  const go = (to) => {
    setMenuOpen(false);
    if (to !== pathname) setPendingTo(to);
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
        aria-label="Close menu"
        tabIndex={menuOpen ? 0 : -1}
        onClick={() => setMenuOpen(false)}
      />

      <nav className="cs-fnav-menu" aria-label="All sections" aria-hidden={!menuOpen}>
        <div className="cs-fnav-cap">Go to</div>
        {/* Global search (MasterSearch listens for cs:open-search). Here on every page for
            non-crew, including the ones whose header owns the top-right corner (Schedule,
            Messaging) where the floating magnifier steps aside. Crew have no search at all
            (owner, 2026-09-22). Dispatched inside this tap so the sheet can focus its field
            and iOS raises the keyboard. */}
        {!isCrew && (
          <button
            type="button"
            className="cs-fnav-mitem"
            tabIndex={menuOpen ? 0 : -1}
            onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('cs:open-search')); }}
          >
            <span className="cs-fnav-mlabel">Search</span>
            <Icon name="search" size={22} />
          </button>
        )}
        {menuDefs.map((m) => (
          <button
            key={`${m.to}-${m.label}`}
            type="button"
            className={`cs-fnav-mitem ${isActive(m.to, m.end) ? 'is-on' : ''}`}
            tabIndex={menuOpen ? 0 : -1}
            onClick={() => go(m.to)}
          >
            {m.badge && <span className="cs-fnav-badge">{m.badge}</span>}
            <span className="cs-fnav-mlabel">{m.label}</span>
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

      <div ref={pillRef} className={`cs-fnav-pill ${condensed ? 'is-condensed' : ''}`} role="tablist" aria-label="Primary navigation">
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
              <span className="cs-fnav-label">{t.label}</span>
            </button>
          );
        })}
        {/* Condensed state: the whole pill becomes one "bring to top + refresh" puck.
            Full gold fill + the active tab's icon on a tab route; a glass up-arrow on
            routes with no tab selected (was a blank puck). Hidden/inert when expanded. */}
        <button
          type="button"
          className={`cs-fnav-puck ${activeTab ? 'is-on' : ''}`}
          aria-label="Scroll to top and refresh"
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
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
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
