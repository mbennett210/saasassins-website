import { NavLink } from 'react-router-dom';
import { useStore } from '../store';
import { selectCompany } from '../store/selectors';
import { usePermissionChecker } from '../hooks/usePermission';
import { useIsMobile } from '../hooks/useIsMobile';
import Icon from './Icon';
import UserSwitcher from './UserSwitcher';
import { IS_DEMO } from '../demo/isDemo';
import { featuredModules } from '../demo/modules.catalog';
import NavAddonItem from '../demo/components/NavAddonItem';

// Public assets are served under Vite's base path ('/polishpoint/' in the demo
// build, '/' in a per-client product build). company.logoUrl is stored
// root-relative ('/polishpoint-logo.png'), so it must be prefixed with the base
// at render time — otherwise it resolves to the origin root and 404s under a
// non-root base. Absolute (http/https), data:, and blob: URLs pass through.
const BASE_URL = import.meta.env.BASE_URL;
function brandLogoSrc(url) {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return url;
  return `${BASE_URL.replace(/\/$/, '')}${url.startsWith('/') ? url : `/${url}`}`;
}

const NAV = [
  // In the demo, the app home (Dashboard) lives at '/demo' — the marketing
  // landing owns '/'. Per-client product builds keep the Dashboard at '/'.
  { to: IS_DEMO ? '/demo' : '/', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view', end: true },
  { to: '/schedule',  label: 'Schedule',   icon: 'schedule',  perm: 'schedule.view'  },
  { to: '/messaging', label: 'Messaging',  icon: 'messaging', perm: 'messaging.use'  },
  // Marketing is a real Core feature in per-client product builds, but the
  // marketing DEMO sells it as a paid add-on — so in demo mode it moves out of
  // the Core group and into the Add-on group below (linking to its live page).
  { to: '/marketing', label: 'Marketing',  icon: 'mail',      perm: 'marketing.view', demoAddon: true },
  { to: '/contacts',  label: 'Contacts',   icon: 'clients',   perm: 'contacts.view'  },
  { to: '/clients',   label: 'Clients',    icon: 'clients',   perm: 'clients.view', hideWhen: 'contacts.view' },
  // The Pipeline kanban board is desktop-first — too wide to be usable on a
  // phone-class rail, so it's hidden from the mobile nav (still reachable on
  // desktop and by direct URL).
  { to: '/pipeline',  label: 'Pipeline',   icon: 'chart',     perm: 'pipeline.view', desktopOnly: true },
  { to: '/invoices',  label: 'Invoices',   icon: 'invoices',  perm: 'invoices.view'  },
];

// Operations group — lighter ops surfaces. Per-client product builds show both;
// the DEMO trims them: Complaints is hidden (hideInDemo — it doesn't fit the
// sales narrative), and Reviews moves into the Add-on group as part of the
// Marketing module (demoAddon).
const OPS_NAV = [
  { to: '/complaints', label: 'Complaints', icon: 'warning', perm: 'complaints.view', hideInDemo: true },
  { to: '/reviews',    label: 'Reviews',    icon: 'star',    perm: 'reviews.view', demoAddon: true },
];

export default function Sidebar({ mobileOpen, onCloseMobile }) {
  const company = selectCompany(useStore());
  const check = usePermissionChecker();
  const isMobile = useIsMobile();

  // Hide desktop-only items (e.g. the Pipeline board) from the mobile rail.
  const passesDevice = (n) => !(isMobile && n.desktopOnly);
  const visible = NAV.filter((n) => check(n.perm) && (!n.hideWhen || !check(n.hideWhen)) && passesDevice(n));
  // In the demo, Marketing is repackaged as an add-on, so it drops out of Core.
  const coreItems = visible.filter((n) => !(IS_DEMO && n.demoAddon));
  // In the demo, Complaints is hidden and Reviews moves to the Add-on group;
  // in product builds both show under Operations.
  const opsItems = OPS_NAV.filter(
    (n) => check(n.perm) && passesDevice(n) && !(IS_DEMO && (n.hideInDemo || n.demoAddon)),
  );
  // Add-on modules surfaced in the nav (demo only); the catalog drives the list.
  const addonModules = IS_DEMO ? featuredModules() : [];
  // Reviews is part of the Marketing module in the demo (not free Core), but it
  // has its own built page — surface it alongside the add-ons so it stays reachable.
  const showReviews = IS_DEMO && check('reviews.view');

  const renderLink = (item) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
      onClick={onCloseMobile}
    >
      <Icon name={item.icon} />
      <span className="nav-btn-label">{item.label}</span>
    </NavLink>
  );

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className={`sidebar-brand${company.logoUrl ? ' sidebar-brand-image' : ''}`}>
        {company.logoUrl ? (
          <img className="sidebar-brand-img" src={brandLogoSrc(company.logoUrl)} alt={company.name} />
        ) : (
          <>
            <div className="sidebar-logo">{company.logoInitials}</div>
            <div className="sidebar-brand-text">
              <h1>{company.name}</h1>
              <p>Platform</p>
            </div>
          </>
        )}
      </div>

      <nav className="sidebar-nav">
        <div className="nav-group" data-tour="core">
          {IS_DEMO && <p className="nav-group-label">Core platform</p>}
          {coreItems.map(renderLink)}
        </div>

        {opsItems.length > 0 && (
          <div className="nav-group" data-tour="operations">
            {IS_DEMO && <p className="nav-group-label">Operations</p>}
            {opsItems.map(renderLink)}
          </div>
        )}

        {IS_DEMO && (addonModules.length > 0 || showReviews) && (
          <div className="nav-group" data-tour="addons">
            <p className="nav-group-label">Add-on modules</p>
            {addonModules.map((m) =>
              m.route ? (
                <NavLink
                  key={m.id}
                  to={m.route}
                  className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                  onClick={onCloseMobile}
                >
                  <span className="nav-emoji" aria-hidden="true">{m.icon}</span>
                  <span className="nav-btn-label">{m.navLabel || m.name}</span>
                  <span className="pp-addon-badge">Add-on</span>
                </NavLink>
              ) : (
                <NavAddonItem key={m.id} moduleId={m.id} />
              ),
            )}
            {showReviews && (
              <NavLink
                to="/reviews"
                className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                onClick={onCloseMobile}
              >
                <span className="nav-emoji" aria-hidden="true">⭐</span>
                <span className="nav-btn-label">Reviews</span>
                <span className="pp-addon-badge">Add-on</span>
              </NavLink>
            )}
          </div>
        )}

        {check('settings.account') && (
          <div className="nav-group">
            <NavLink
              to="/settings"
              className={({ isActive }) => `nav-btn nav-btn-solo ${isActive ? 'active' : ''}`}
              onClick={onCloseMobile}
            >
              <Icon name="settings" />
              <span className="nav-btn-label">Settings</span>
            </NavLink>
          </div>
        )}
      </nav>

      <div className="sidebar-footer">
        <UserSwitcher />
      </div>
    </aside>
  );
}
