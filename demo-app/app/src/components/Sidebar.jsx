import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSelector } from '../store';
import { selectCompany, selectCurrentUser } from '../store/selectors';
import { useClientReview, useSectionReview } from '../store/ClientReviewProvider';
import { NAV, visible } from '../lib/navData';
import { assetUrl } from '../lib/assetUrl';
import { usePermissionChecker } from '../hooks/usePermission';
import { useIsMobile } from '../hooks/useIsMobile';
import Icon from './Icon';
import UserSwitcher from './UserSwitcher';
import ReportIssueModal from './ReportIssueModal';
import ConfirmDialog from './ConfirmDialog';
import { fmtDate } from '../lib/dates';

// NAV + visible() now live in ../lib/navData.js (a JSX-free module) so the
// master-search registry and scripts/search-lint.mjs can read them under node.
// Review + Settings are still rendered as standalone JSX leaves below (they are
// deliberately NOT in NAV). Reviews' route (the Google listing) exists but has no nav row
// (needs a live Google connection); the search registry excludes it with that reason.
const childActive = (pathname, children) =>
  children.some((c) => pathname === c.to || pathname.startsWith(c.to + '/'));

// In the marketing demo (build:demo, MODE === 'demo') the whole client-review layer — the
// in-review / approved nav markers, "NEW" pills, the Review workspace and "Report an issue" —
// is internal build chrome, so it is hidden. Per-client product builds keep it.
const IS_DEMO = import.meta.env.MODE === 'demo';

// ── Client review markers (see store/ClientReviewProvider) ──────────────────
// Every section page shows an IR (in-review) / approved marker in the nav; the
// Review item shows a gold attention-count (with a red new-dot) instead. Markers
// live in the nav ONLY.
function SectionMarker({ route }) {
  const { approved, approve, unapprove, at } = useSectionReview(route);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The marker renders inside the NavLink <a>, so it's a span[role=button] rather
  // than a real <button> (no interactive nesting). preventDefault stops the row
  // from navigating; stopPropagation stops the NavLink onClick (mobile-nav close).
  // ADDITIVE (CS-402, §97): approving is ONE click; UN-approving (green check → In
  // Review) undoes a sign-off, so it asks first via ConfirmDialog and the approval
  // stays in the entry's history. One sitting per click (created in the hook).
  const activate = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (approved) setConfirmOpen(true); else approve();
  };
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className={`nav-review ${approved ? 'nav-review-approved' : 'nav-review-ir'}`}
        title={approved ? 'Approved. Click to mark in review.' : 'In review. Click to mark approved.'}
        aria-label={approved ? 'Section approved, click to mark in review' : 'Section in review, click to mark approved'}
        onClick={activate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activate(e); }}
      >
        {approved ? <Icon name="check" size={14} /> : 'In Review'}
      </span>
      <ConfirmDialog
        open={confirmOpen}
        title="Mark this page In Review again?"
        message={`It was approved on ${fmtDate(at)}. The approval stays in its history.`}
        confirmLabel="Mark In Review"
        onConfirm={() => unapprove()}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}

// The Review leaf's count: a gold pill of how many items need attention (open questions +
// pending drafts), with a small red dot when any of them are NEW from the latest update.
// Inverts on the active (gold) row via CSS. Hidden when nothing needs review.
function ReviewCount() {
  const { reviewAttention, reviewNewCount } = useClientReview();
  if (reviewAttention <= 0) return null;
  return (
    <span
      className="nav-review nav-review-count"
      aria-label={`${reviewAttention} items need review, ${reviewNewCount} new`}
    >
      {reviewAttention > 999 ? '999+' : reviewAttention}
      {reviewNewCount > 0 && <span className="nav-review-dot" aria-hidden="true" />}
    </span>
  );
}

// A nav entry with an explicit `badge` (e.g. Payroll's "NEW") shows that pill and
// opts OUT of the in-review marker. Otherwise: Review shows its attention count; every
// other row shows its section marker.
function NavRowMarker({ to, badge }) {
  if (IS_DEMO) return null;
  if (badge) return <span className="nav-review nav-review-new">{badge}</span>;
  if (to === '/review') return <ReviewCount />;
  return <SectionMarker route={to} />;
}

function NavLeaf({ item, onCloseMobile }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
      onClick={onCloseMobile}
    >
      <Icon name={item.icon} />
      <span className="nav-btn-label">{item.label}</span>
      <NavRowMarker to={item.to} badge={item.badge} />
    </NavLink>
  );
}

function NavSection({ entry, check, isMobile, isCrew, onCloseMobile }) {
  const { pathname } = useLocation();
  const items = entry.children.filter((c) => visible(c, check, isMobile, isCrew));
  const [open, setOpen] = useState(() => childActive(pathname, items));
  if (items.length === 0) return null;
  return (
    <div className={`nav-section-group ${open ? 'open' : ''}`}>
      <button type="button" className="nav-btn nav-section-toggle" onClick={() => setOpen((o) => !o)}>
        <Icon name={entry.icon} />
        <span className="nav-btn-label">{entry.group}</span>
        <span className="nav-chevron"><Icon name="chevronDown" /></span>
      </button>
      <div className="nav-section-items">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `nav-btn nav-sub ${isActive ? 'active' : ''}`}
            onClick={onCloseMobile}
          >
            <Icon name={item.icon} />
            <span className="nav-btn-label">{item.label}</span>
            <NavRowMarker to={item.to} badge={item.badge} />
          </NavLink>
        ))}
      </div>
    </div>
  );
}

export default function Sidebar({ mobileOpen, onCloseMobile }) {
  // Increment 0.4: Sidebar is mounted for the whole authed session and re-rendered on
  // EVERY dispatch. Both selectors return existing values BY REFERENCE — `s.company`,
  // and `.find()` on users — so the default Object.is comparer is correct and no
  // shallowEqual is needed. (A comparer is only required when a selector BUILDS a
  // value: .filter/.map/an object literal/`|| []`.)
  const company = useSelector(selectCompany);
  const currentUser = useSelector(selectCurrentUser);
  const check = usePermissionChecker();
  const isMobile = useIsMobile();
  // "Report an issue" is global chrome (like Settings), deliberately ungated:
  // every role can file — crew in the field hit bugs too.
  const [reportOpen, setReportOpen] = useState(false);
  // Crew get a flat nav with no "Operations" group header (Daniel's ask), and the
  // My Day/Schedule split keys off this. Use the ROLE directly (not a revocable
  // permission) so the split + flat-nav stay stable even when a perm is overridden.
  const isCrew = currentUser?.role === 'crew';

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className={`sidebar-brand${company.logoUrl ? ' sidebar-brand-image' : ''}`}>
        {company.logoUrl ? (
          <img className="sidebar-brand-img" src={assetUrl(company.logoUrl)} alt={company.name} />
        ) : (
          <>
            <div className="sidebar-logo">
              {company.logoMark
                ? <img className="sidebar-logo-glyph" src={assetUrl(company.logoMark)} alt="" />
                : company.logoInitials}
            </div>
            <div className="sidebar-brand-text">
              <h1>{company.name}</h1>
              <p>Platform</p>
            </div>
          </>
        )}
      </div>

      <nav className="sidebar-nav">
        <div className="nav-group">
          {NAV.map((entry) => {
            if (entry.children) {
              // Crew: render the Operations group's visible children (Quality /
              // Keys) as flat top-level leaves instead of inside a
              // collapsible NavSection — no group header. Scoped to Operations;
              // Sales/Finances have no crew-visible children so they drop away
              // either way. Managers keep the grouped section unchanged.
              if (isCrew && entry.group === 'Operations') {
                return entry.children
                  .filter((c) => visible(c, check, isMobile, isCrew))
                  .map((item) => <NavLeaf key={item.to} item={item} onCloseMobile={onCloseMobile} />);
              }
              return <NavSection key={entry.group} entry={entry} check={check} isMobile={isMobile} isCrew={isCrew} onCloseMobile={onCloseMobile} />;
            }
            if (!visible(entry, check, isMobile, isCrew)) return null;
            return <NavLeaf key={entry.to} item={entry} onCloseMobile={onCloseMobile} />;
          })}
        </div>

        {check('settings.account') && (
          <div className="nav-group">
            <NavLink
              to="/settings"
              className={({ isActive }) => `nav-btn nav-btn-solo ${isActive ? 'active' : ''}`}
              onClick={onCloseMobile}
            >
              <Icon name="settings" />
              <span className="nav-btn-label">Settings</span>
              <NavRowMarker to="/settings" />
            </NavLink>
          </div>
        )}

        {/* Review — the client-review workspace (drafts + build decisions), gold
            attention-count with a red new-dot. Pinned to the BOTTOM of the rail
            (.nav-group-bottom → margin-top:auto), flush above the footer divider, as a
            standalone item — deliberately NOT in the main list or grouped with the Settings
            solo item. DESKTOP ONLY (like Pipeline / Quotes): hidden when isMobile. */}
        {!IS_DEMO && check('drafts.view') && !isMobile && (
          <div className="nav-group nav-group-bottom">
            <NavLeaf item={{ to: '/review', label: 'Review', icon: 'edit' }} onCloseMobile={onCloseMobile} />
          </div>
        )}
      </nav>

      <div className="sidebar-footer">
        {!IS_DEMO && (
          <button
            type="button"
            className="sidebar-footer-btn sidebar-report-btn"
            onClick={() => { setReportOpen(true); onCloseMobile?.(); }}
          >
            <Icon name="warning" size={14} /> Report an issue
          </button>
        )}
        <UserSwitcher />
      </div>
      {/* Portals to <body>, so mounting inside the aside is safe on mobile too. */}
      <ReportIssueModal open={reportOpen} onClose={() => setReportOpen(false)} />
    </aside>
  );
}
