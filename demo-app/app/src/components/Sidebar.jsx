import { NavLink } from 'react-router-dom';
import { useStore } from '../store';
import { selectCompany } from '../store/selectors';
import { usePermissionChecker } from '../hooks/usePermission';
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

// In the marketing demo the live app's home (Dashboard) lives at /polishpoint/demo
// because the index is the product landing page; per-client builds keep it at '/'.
const DASHBOARD_TO = IS_DEMO ? '/demo' : '/';

const NAV = [
  { to: DASHBOARD_TO, label: 'Dashboard',  icon: 'dashboard', perm: 'dashboard.view', end: true },
  { to: '/schedule',  label: 'Schedule',   icon: 'schedule',  perm: 'schedule.view'  },
  { to: '/messaging', label: 'Messaging',  icon: 'messaging', perm: 'messaging.use'  },
  // Marketing is a real Core feature in per-client product builds, but the
  // marketing DEMO sells it as a paid add-on — so in demo mode it moves out of
  // the Core group and into the Add-on group below (linking to its live page).
  { to: '/marketing', label: 'Marketing',  icon: 'mail',      perm: 'marketing.view', demoAddon: true },
  { to: '/contacts',  label: 'Contacts',   icon: 'clients',   perm: 'contacts.view'  },
  { to: '/clients',   label: 'Clients',    icon: 'clients',   perm: 'clients.view', hideWhen: 'contacts.view' },
  { to: '/pipeline',  label: 'Pipeline',   icon: 'chart',     perm: 'pipeline.view'  },
  { to: '/invoices',  label: 'Invoices',   icon: 'invoices',  perm: 'invoices.view'  },
];

export default function Sidebar({ mobileOpen, onCloseMobile }) {
  const company = selectCompany(useStore());
  const check = usePermissionChecker();

  const visible = NAV.filter((n) => check(n.perm) && (!n.hideWhen || !check(n.hideWhen)));
  // In the demo, Marketing is repackaged as an add-on, so it drops out of Core.
  const coreItems = visible.filter((n) => !(IS_DEMO && n.demoAddon));
  // Add-on modules surfaced in the nav (demo only); the catalog drives the list.
  const addonModules = IS_DEMO ? featuredModules() : [];

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

        {IS_DEMO && addonModules.length > 0 && (
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
