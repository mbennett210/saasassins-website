import { NavLink, Outlet } from 'react-router-dom';
import { usePermissionChecker } from '../../hooks/usePermission';
import Icon from '../../components/Icon';

const ITEMS = [
  { to: 'account',       label: 'Account',             icon: 'user',     perm: 'settings.account'    },
  { to: 'company',       label: 'Company',             icon: 'building', perm: 'settings.company'    },
  { to: 'services',      label: 'Services',            icon: 'invoices', perm: 'settings.services'   },
  { to: 'tags',          label: 'Tags',                icon: 'tag',      perm: 'tags.manage'         },
  { to: 'team',          label: 'Team',                icon: 'clients',  perm: 'settings.team.view'  },
  { to: 'roles',         label: 'Roles & Permissions', icon: 'lock',     perm: 'settings.roles.edit' },
  { to: 'integrations',  label: 'Integrations',        icon: 'phone',    perm: 'integrations.view'   },
  { to: 'inboxes',       label: 'Connected Inboxes',   icon: 'mail',     perm: 'messaging.use'       },
];

export default function SettingsLayout() {
  const check = usePermissionChecker();
  const allowed = ITEMS.filter((i) => check(i.perm));

  return (
    <div className="settings-shell">
      <div className="page-head settings-page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Settings</h1>
        </div>
      </div>
      <div className="settings-pill-wrap">
        <nav className="settings-pills">
          {allowed.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `settings-pill ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  );
}
