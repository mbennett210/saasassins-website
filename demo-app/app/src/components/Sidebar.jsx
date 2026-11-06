import { createPortal } from 'react-dom'; // polishpoint-demo
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from '../store';
import { selectCompany, selectCurrentUser } from '../store/selectors';
import { useClientReview } from '../store/ClientReviewProvider';
import {
  NAV, visible, managerNav, supplyNav, isSupplyRole, navRowOn, SETTINGS_LEAF, REVIEW_LEAF,
  LAUNCHER_HOME, launcherSections, launcherBlurbKeys, leafOn,
} from '../lib/navData';
import { seesTeamPages } from '../lib/teamScope';
import { usePermissionChecker } from '../hooks/usePermission';
import { useIsMobile } from '../hooks/useIsMobile';
import { useManagerNavCounts, menuCountsFor } from '../hooks/useManagerHomeReads';
import { useFromHere } from '../hooks/useFromHere';
import { useDismissTap } from '../hooks/useDismissTap';
import { OFFICE_SCAN_PATH } from '../lib/scanLanding';
import Icon from './Icon';
import UserSwitcher from './UserSwitcher';
import { useT } from '../i18n/react';
import { IDENTITY } from '../brand/identity.generated.js';

// NAV + visible() live in ../lib/navData.js (a JSX-free module) so the master-search registry and
// scripts/search-lint.mjs can read them under node. Settings and Review are the menu's foot (they are
// deliberately NOT in NAV).
//
// THE LAUNCHER (DES-1, Matt's pick "D"; UI_RULES §182): the menu holds a few rows and the SECTIONS,
// never their pages. A section opens a panel beside the menu, each group in its own column, every page
// named and described (lib/navData LAUNCHER_SECTIONS). Everyone gets it (Daniel, 2026-10-30): the owner
// and an admin see Dashboard and Messaging, then the sections; a manager and a supply manager keep their
// own rows (Matt's boards, UI_RULES §152 and §169) and their "More" becomes the sections. The foot is
// Settings and Review, then the account chip beside Scan and Report an issue.

// ── No review markers in the menu (UI_RULES §185, Daniel, 2026-10-31) ─────────
// A page's row and tile carry no "In Review" or "Approved" mark; a sign-off already given stays in
// the shared review record (store/ClientReviewProvider). The Review button keeps its count.

// The Review leaf's count: a gold pill of how many items need attention (open questions +
// pending drafts), with a small red dot when any of them are NEW from the latest update.
// Inverts on the active (gold) row via CSS. Hidden when nothing needs review.
function ReviewCount() {
  const t = useT();
  const { reviewAttention, reviewNewCount } = useClientReview();
  if (reviewAttention <= 0) return null;
  return (
    <span
      className="nav-review nav-review-count"
      aria-label={t('nav.reviewCountAria', { count: reviewAttention, fresh: reviewNewCount })}
    >
      {reviewAttention > 999 ? '999+' : reviewAttention}
      {reviewNewCount > 0 && <span className="nav-review-dot" aria-hidden="true" />}
    </span>
  );
}

// A nav entry with an explicit `badge` (e.g. Payroll's "NEW") shows that pill; Review shows its
// attention count; every other row shows nothing (no review marker, §185).
function NavRowMarker({ to, badge }) {
  if (badge) return <NewBadge />;
  if (to === '/review') return <ReviewCount />;
  return null;
}

// The "NEW" pill, in the reader's language. (A leaf's `badge` is only ever "NEW".)
function NewBadge() {
  return null; // polishpoint-demo: no NEW pills
}

// A manager row's count pill (UI_RULES §152): crews not checked in, timesheets waiting, open
// requests, buildings needing attention — the Home's own figures (hooks/useManagerHomeReads).
// Nothing at zero or before the figure is read: the row never waits for it.
function NavCount({ count }) {
  const t = useT();
  if (!count) return null;
  return (
    <span className="nav-review nav-review-count nav-count" aria-label={t('nav.countAria', { count })}>
      {count > 999 ? '999+' : count}
    </span>
  );
}

// `rows`: every row the sidebar draws beside this one. Two rows on one path (Supplies and Supply
// Catalog, the Supplies page on its Catalog tab, task #125) are lit by the URL's query, never both
// (lib/navData navRowOn); `aria-current` says the same.
function NavLeaf({ item, onCloseMobile, count = null, rows = [] }) {
  const t = useT();
  const { search } = useLocation();
  const mine = navRowOn(item, rows, search);
  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-current={mine ? 'page' : false}
      className={({ isActive }) => `nav-btn ${isActive && mine ? 'active' : ''}`}
      onClick={onCloseMobile}
    >
      <Icon name={item.icon} />
      <span className="nav-btn-label">{t(item.labelKey)}</span>
      <NavCount count={count} />
      {/* A row with a count shows only its count (one pill per row, as drawn and as on the
          phone); its NEW pill returns when the count is zero. */}
      {!(count > 0) && <NavRowMarker to={item.to} badge={item.badge} />}
    </NavLink>
  );
}

// One page in an open section: its glyph, its name (with its pill) and what it is for.
function LauncherTile({ item, rows, count = null, onPick }) {
  const t = useT();
  const { search } = useLocation();
  const mine = navRowOn(item, rows, search);
  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-current={mine ? 'page' : false}
      className={({ isActive }) => `launcher-tile${isActive && mine ? ' on' : ''}`}
      onClick={onPick}
    >
      <span className="launcher-tile-ic"><Icon name={item.icon} size={16} /></span>
      <span className="launcher-tile-text">
        <span className="launcher-tile-name">
          <span className="launcher-tile-label">{t(item.labelKey)}</span>
          <NavCount count={count} />
          {!(count > 0) && <NavRowMarker to={item.to} badge={item.badge} />}
        </span>
        {item.descKey && <span className="launcher-tile-desc">{t(item.descKey)}</span>}
      </span>
    </NavLink>
  );
}

// The panel's motion (UI_RULES "Smooth transitions"): it grows out of the section's row and fades in
// over 220ms, goes back a little quicker (160ms, ease-in), turns round from where it is when pressed
// again mid-way, and stays on the page until it has gone. Another section: the open panel goes back
// into its row first and the new one grows out of its own, so the panel takes its new size and place
// only while nothing is drawn (a box that snapped to its new size in one frame, then slid, was a jump).
// Reduced motion: the end state at once.
const EASE_OPEN = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const PANEL_ID = 'launcher-panel';
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The panel beside `btn`, inside the window: 10px right of the row, its top level with the row's (less
// 12px) and clamped 12px inside the window, two columns when its section has two groups and room for
// them. Returns the top it took. It grows out of the row's middle.
function placePanel(el, btn, section) {
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const left = Math.round(r.right + 10);
  const multi = section.groups.length > 1;
  const w = Math.max(220, Math.min(multi ? 560 : 300, vw - left - 12));
  el.style.left = `${left}px`;
  el.style.width = `${w}px`;
  el.style.maxHeight = `${vh - 24}px`;
  el.dataset.cols = multi && w >= 500 ? '2' : '1';
  const top = Math.round(Math.max(12, Math.min(r.top - 12, vh - el.offsetHeight - 12)));
  el.style.top = `${top}px`;
  el.style.transformOrigin = `0 ${Math.round(r.top + r.height / 2 - top)}px`;
  return top;
}

// The sections and their panel. `sections` from lib/navData launcherSections, `rows` every row the
// menu draws (navRowOn), `pills` the menu's counts by path, `asideRef` the menu itself: a click in it
// never gets eaten (a row there still opens its page), and one outside a section closes the panel. The
// panel comes right after its row in the page, so Tab goes from the row into it and on to the next row
// (and Shift+Tab back to the row).
function Launcher({ sections, rows, pills, onCloseMobile, asideRef, isMobile }) {
  const t = useT();
  const { pathname, search } = useLocation();
  const [openId, setOpenId] = useState(null);      // the section asked for (null: closed or closing)
  const [shownId, setShownId] = useState(null);    // the section the panel draws, kept while it goes back
  const panelRef = useRef(null);
  const btns = useRef(new Map());
  const anim = useRef(null);                       // the open/close animation while it runs
  const heading = useRef(false);                   // where the panel is going: true = open
  const want = useRef(null);                       // the section asked for, read when the panel has gone
  const focusIn = useRef(false);

  const shown = sections.find((s) => s.id === shownId) || null;
  const close = () => setOpenId(null);
  // Focus left in the panel goes back to its section's row (Esc, a click outside, a tile picked from
  // the keyboard), never to the page's top.
  const focusRow = () => {
    if (panelRef.current?.contains(document.activeElement)) btns.current.get(shownId)?.focus({ preventScroll: true });
  };
  const toggle = (id, e) => {
    if (openId === id) { close(); return; }
    focusIn.current = e?.detail === 0;   // pressed from the keyboard: the panel takes the focus
    if (!shownId) setShownId(id);        // another section's panel, open or going back, goes first
    setOpenId(id);
  };

  const fly = (open) => {
    const el = panelRef.current;
    if (!el) return;
    const run = anim.current;
    if (run && run.playState === 'running') {
      if (heading.current !== open) { heading.current = open; run.reverse(); }
      return;
    }
    if (open && heading.current) return;   // already open: nothing to grow
    heading.current = open;
    if (reducedMotion()) { if (!open) setShownId(want.current); return; }
    const frames = [{ opacity: 0, transform: 'translateX(-8px) scale(0.97)' }, { opacity: 1, transform: 'none' }];
    const a = el.animate(open ? frames : [...frames].reverse(), { duration: open ? 220 : 160, easing: open ? EASE_OPEN : 'ease-in', fill: 'both' });
    anim.current = a;
    a.onfinish = () => {
      anim.current = null;
      // Open: back to its own styles. Gone: dropped while still drawn at nothing (never a frame at
      // full), or the section asked for meanwhile drawn in its place, to grow out of its own row.
      if (heading.current) a.cancel(); else setShownId(want.current);
    };
  };

  useLayoutEffect(() => {
    want.current = openId;
    const el = panelRef.current;
    if (!shownId || !el) return;
    if (openId !== shownId) {
      // Going back: closed, or before another section opens. A panel never drawn goes straight there.
      if (heading.current || anim.current?.playState === 'running') fly(false);
      else setShownId(openId);
      return;
    }
    const btn = btns.current.get(openId);
    const section = sections.find((s) => s.id === openId);
    if (!btn || !section) return;
    placePanel(el, btn, section);
    fly(true);
    if (focusIn.current) {
      focusIn.current = false;
      el.querySelector('.launcher-tile')?.focus({ preventScroll: true });
    }
  }, [openId, shownId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new page closes it (a tile, or a row elsewhere in the menu).
  useEffect(() => { setOpenId(null); }, [pathname, search]);
  // Down to a phone's width the menu leaves the screen (the phone has its own): the panel goes with it.
  useEffect(() => { if (isMobile) setOpenId(null); }, [isMobile]);
  // The window resized: the panel follows its row. The menu scrolled: its row moved out from beside
  // it, so it goes.
  useEffect(() => {
    if (!openId) return undefined;
    const onResize = () => {
      const el = panelRef.current;
      const btn = btns.current.get(openId);
      const section = sections.find((s) => s.id === openId);
      if (el && btn && section && openId === shownId) placePanel(el, btn, section);
    };
    const scroller = btns.current.get(openId)?.closest('.sidebar-nav');
    window.addEventListener('resize', onResize);
    scroller?.addEventListener('scroll', close, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      scroller?.removeEventListener('scroll', close);
    };
  }, [openId, shownId, sections]);
  // A click elsewhere in the menu closes it and still does its own work (the account chip, a row).
  useEffect(() => {
    const aside = asideRef.current;
    if (!openId || !aside) return undefined;
    const onClick = (e) => {
      if (e.target.closest?.('.launcher-cat') || panelRef.current?.contains(e.target)) return;
      close();
    };
    aside.addEventListener('click', onClick, true);
    return () => aside.removeEventListener('click', onClick, true);
  }, [openId, asideRef]);
  // Focus that leaves the menu without a press (Tab past its end, Ctrl+K into the search) takes the
  // panel with it, or the search's list opens under it. A press is the dismiss tap's, below.
  useEffect(() => {
    if (!openId) return undefined;
    let pressing = false;
    const down = () => { pressing = true; };
    const up = () => { pressing = false; };
    const onFocus = (e) => {
      if (pressing || asideRef.current?.contains(e.target) || panelRef.current?.contains(e.target) || e.target?.closest?.('.modal-overlay')) return; // polishpoint-demo: the panel is outside the menu now
      close();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      document.removeEventListener('focusin', onFocus);
    };
  }, [openId, asideRef]);
  // Outside the menu, a click only closes it (UI_RULES §100), and Esc closes it (the one Escape stack,
  // §181). A pop-up over it is its own: one portaled to <body> (a .modal-overlay) takes its own
  // clicks, which must reach its buttons, not close the panel (and the pop-up with it).
  useDismissTap({
    open: !!openId,
    ref: panelRef,
    ref2: asideRef,
    spare: (target) => !!target?.closest?.('.modal-overlay'),
    onDismiss: () => { focusRow(); close(); },
  });

  if (!sections.length) return null;
  const panel = shown && createPortal( // polishpoint-demo: the panel at the page's top level
    <div ref={panelRef} id={PANEL_ID} className="launcher-panel" role="dialog" aria-label={t(shown.labelKey)}>
      <div className="launcher-panel-head">
        <span className="launcher-panel-title">{t(shown.labelKey)}</span>
        <span className="launcher-panel-count">{t('nav.pageCount', { count: shown.leaves.length })}</span>
        <button
          type="button"
          className="launcher-x"
          aria-label={t('nav.closeSection')}
          title={t('nav.closeSection')}
          onClick={() => { btns.current.get(shownId)?.focus({ preventScroll: true }); close(); }}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="launcher-cols">
        {shown.groups.map((g, i) => (
          <div className="launcher-col" key={g.labelKey || `g${i}`}>
            {shown.groups.length > 1 && g.labelKey && <div className="launcher-cap">{t(g.labelKey)}</div>}
            {g.leaves.map((leaf) => (
              <LauncherTile
                key={leaf.to}
                item={leaf}
                rows={rows}
                count={pills[leaf.to]}
                onPick={() => { focusRow(); close(); onCloseMobile?.(); }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
  return (
    <div className="nav-group launcher">
      {sections.map((sec) => {
        const open = openId === sec.id;
        const hasOn = sec.leaves.some((l) => leafOn(l, rows, pathname, search));
        const blurb = launcherBlurbKeys(sec).map((k) => t(k)).join(' · ');
        const count = sec.leaves.reduce((n, l) => n + (pills[l.to] || 0), 0);
        return (
          <Fragment key={sec.id}>
            <button
              ref={(node) => { if (node) btns.current.set(sec.id, node); else btns.current.delete(sec.id); }}
              type="button"
              className={`launcher-cat${open ? ' open' : ''}${hasOn ? ' has-on' : ''}`}
              aria-expanded={open}
              aria-haspopup="dialog"
              aria-controls={open ? PANEL_ID : undefined}
              onClick={(e) => toggle(sec.id, e)}
            >
              <span className="launcher-cat-tile"><Icon name={sec.icon} /></span>
              <span className="launcher-cat-text">
                <span className="launcher-cat-name">{t(sec.labelKey)}</span>
                <span className="launcher-cat-blurb" title={blurb}>{blurb}</span>
              </span>
              <NavCount count={count} />
              <span className="launcher-chev" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
            </button>
            {shownId === sec.id && panel}
          </Fragment>
        );
      })}
    </div>
  );
}

export default function Sidebar({ mobileOpen, onCloseMobile }) {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const asideRef = useRef(null);
  // Increment 0.4: Sidebar is mounted for the whole authed session and re-rendered on
  // EVERY dispatch. Both selectors return existing values BY REFERENCE — `s.company`,
  // and `.find()` on users — so the default Object.is comparer is correct and no
  // shallowEqual is needed. (A comparer is only required when a selector BUILDS a
  // value: .filter/.map/an object literal/`|| []`.)
  const company = useSelector(selectCompany);
  const currentUser = useSelector(selectCurrentUser);
  const check = usePermissionChecker();
  const isMobile = useIsMobile();
  // "Report an issue" is global chrome (like Settings), deliberately ungated: every role can file —
  // crew in the field hit bugs too. The foot's button only ASKS (`cs:open-report`); the one modal
  // lives in components/ReportIssueHost, which AppLayout mounts for every role — the crew shell
  // has no sidebar at all (the Cleaner Hub), and FloatingNav's menu row asks the same way (CS-049).
  // A MANAGER (or the owner viewing as one) gets Matt's order, a line, Messages and Account, and
  // every other page in the sections (D2, UI_RULES §152; lib/navData managerNav). By ROLE; the owner
  // and admin get Dashboard and Messaging, then the sections, from NAV. (Crew never see this sidebar:
  // the crew shell, UI_RULES §165.)
  const isManager = currentUser?.role === 'manager';
  // The team pages (Accounts, S131): the owner's, an admin's and an Operations Manager's.
  const team = seesTeamPages(currentUser);
  // A SUPPLY MANAGER gets their own app's order (S131 Wave 2, UI_RULES §169: Order Queue · Supply
  // Catalog · Reports, a line, Messages · Account, then the sections); the same rows component draws it.
  const isSupply = isSupplyRole(currentUser);
  const mgr = isManager ? managerNav(check, { isMobile, team }) : isSupply ? supplyNav(check, { isMobile }) : null;
  // The count pills (UI_RULES §152, §182): a manager's over their own buildings, and, as Matt's Option D
  // drew them, the owner's and an admin's over every building (Daniel, 2026-10-30), on the same rows
  // and tiles (menuCountsFor, shared with the phone's menu).
  const pills = useManagerNavCounts(menuCountsFor(currentUser?.role));
  // The owner's and an admin's pages: every NAV leaf they may open, in NAV's order.
  const leaves = mgr ? null : NAV.flatMap((entry) => entry.children || [entry]).filter((leaf) => visible(leaf, check, isMobile, false, { team }));
  const homeRows = mgr ? mgr.primary : leaves.filter((leaf) => LAUNCHER_HOME.includes(leaf.to));
  const sections = mgr ? launcherSections(mgr.more) : launcherSections(leaves, { home: LAUNCHER_HOME });
  const showSettings = visible(SETTINGS_LEAF, check, isMobile, false);
  const showReview = false; // polishpoint-demo: no Review page
  // Every row this sidebar draws, so two rows on one path are lit by the URL's query (navRowOn).
  const rows = [
    ...homeRows.filter((r) => !r.divider),
    ...sections.flatMap((s) => s.leaves),
    ...(showSettings ? [SETTINGS_LEAF] : []),
    ...(showReview ? [REVIEW_LEAF] : []),
  ];

  return (
    <aside ref={asideRef} className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className={`sidebar-brand${company.logoUrl ? ' sidebar-brand-image' : ''}`}>
        {/* The nav bar's logo is the SOFTWARE's (the brand pack's product, UI_RULES §129); the no-logo
            fallback below names the org itself, as the company edits it in Settings → Company. */}
        {company.logoUrl ? (
          <img className="sidebar-brand-img" src={company.logoUrl} alt={IDENTITY.product.name} />
        ) : (
          <>
            <div className="sidebar-logo">
              {company.logoMark
                ? <img className="sidebar-logo-glyph" src={company.logoMark} alt="" />
                : company.logoInitials}
            </div>
            <div className="sidebar-brand-text">
              <h1>{company.name}</h1>
              <p>{t('nav.platform')}</p>
            </div>
          </>
        )}
      </div>

      <nav className="sidebar-nav">
        {homeRows.length > 0 && (
          <div className="nav-group">
            {homeRows.map((item, i) => (item.divider
              ? <div key={`line-${i}`} className="nav-divider" role="separator" />
              : <NavLeaf key={item.to} item={item} onCloseMobile={onCloseMobile} count={pills[item.to]} rows={rows} />))}
          </div>
        )}
        {homeRows.length > 0 && sections.length > 0 && <div className="nav-divider" role="separator" />}
        <Launcher sections={sections} rows={rows} pills={pills} onCloseMobile={onCloseMobile} asideRef={asideRef} isMobile={isMobile} />
      </nav>

      <div className="sidebar-footer">
        {/* Settings and Review, side by side (Review is desktop only, REVIEW_LEAF desktopOnly; its gold
            count with a red new-dot). */}
        {(showSettings || showReview) && (
          <div className="sidebar-util-row">
            {showSettings && (
              <NavLink
                to={SETTINGS_LEAF.to}
                className={({ isActive }) => `sidebar-util ${isActive ? 'on' : ''}`}
                onClick={onCloseMobile}
              >
                <Icon name={SETTINGS_LEAF.icon} size={16} />
                <span className="sidebar-util-label">{t(SETTINGS_LEAF.labelKey)}</span>
              </NavLink>
            )}
            {showReview && (
              <NavLink
                to={REVIEW_LEAF.to}
                className={({ isActive }) => `sidebar-util ${isActive ? 'on' : ''}`}
                onClick={onCloseMobile}
              >
                <Icon name={REVIEW_LEAF.icon} size={16} />
                <span className="sidebar-util-label">{t(REVIEW_LEAF.labelKey)}</span>
                <ReviewCount />
              </NavLink>
            )}
          </div>
        )}
        <div className="sidebar-foot-row">
          <UserSwitcher />
          {/* QR-21: the office's Scan on the desktop (a webcam, or "Take a photo of the code"), every office
              role — the crew shell draws no sidebar. The camera, then the scanned area's page (§172). */}
          <button
            type="button"
            className="sidebar-icon-btn sidebar-scan-btn"
            title={t('officeScan.menu')}
            aria-label={t('officeScan.menu')}
            onClick={() => { navigate(OFFICE_SCAN_PATH, { state: nav }); onCloseMobile?.(); }}
          >
            <Icon name="camera" size={16} />
          </button>
          <button
            type="button"
            className="sidebar-icon-btn sidebar-report-btn"
            style={{ display: 'none' }} // polishpoint-demo: no Report an issue
            title={t('nav.reportIssue')}
            aria-label={t('nav.reportIssue')}
            onClick={() => { window.dispatchEvent(new CustomEvent('cs:open-report')); onCloseMobile?.(); }}
          >
            <Icon name="warning" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
