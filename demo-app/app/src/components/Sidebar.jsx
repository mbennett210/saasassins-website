import { NavLink } from 'react-router-dom';
import { useStore } from '../store';
import { selectCompany } from '../store/selectors';
import { usePermissionChecker } from '../hooks/usePermission';
import Icon from './Icon';
import UserSwitcher from './UserSwitcher';

const NAV = [
  { to: '/',          label: 'Dashboard',  icon: 'dashboard', perm: 'dashboard.view', end: true },
  { to: '/schedule',  label: 'Schedule',   icon: 'schedule',  perm: 'schedule.view'  },
  { to: '/messaging', label: 'Messaging',  icon: 'messaging', perm: 'messaging.use'  },
  { to: '/marketing', label: 'Marketing',  icon: 'mail',      perm: 'marketing.view' },
  { to: '/contacts',  label: 'Contacts',   icon: 'clients',   perm: 'contacts.view'  },
  { to: '/clients',   label: 'Clients',    icon: 'clients',   perm: 'clients.view', hideWhen: 'contacts.view' },
  { to: '/pipeline',  label: 'Pipeline',   icon: 'chart',     perm: 'pipeline.view'  },
  { to: '/invoices',  label: 'Invoices',   icon: 'invoices',  perm: 'invoices.view'  },
];

export default function Sidebar({ mobileOpen, onCloseMobile }) {
  const company = selectCompany(useStore());
  const check = usePermissionChecker();

  const allowed = NAV.filter((n) => check(n.perm) && (!n.hideWhen || !check(n.hideWhen)));

  return (
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className={`sidebar-brand${company.logoUrl ? ' sidebar-brand-image' : ''}`}>
        {company.logoUrl ? (
          <img className="sidebar-brand-img" src={company.logoUrl} alt={company.name} />
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
        <div className="nav-group">
          {allowed.map((item) => (
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
          ))}
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
