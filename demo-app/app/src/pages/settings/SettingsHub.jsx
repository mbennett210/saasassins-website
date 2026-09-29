// The Settings landing page — grouped cards, each opening a full-width page.
// Replaces the flat centre-wrapped pill row (see settingsNav.js for why).
//
// Chose the hub over a left rail deliberately (Daniel, 2026-07-27): Steve works on
// an iPad in landscape (~1133px), and a settings rail next to the app's own 240px
// sidebar would leave him ~660px of content. The hub costs no horizontal space —
// the grid just reflows from four columns to three — and the one-line descriptions
// do real work for an owner who does not share our vocabulary.
import { Link } from 'react-router-dom';
import { usePermissionChecker } from '../../hooks/usePermission';
import Icon from '../../components/Icon';
import { SETTINGS_GROUPS, SETTINGS_PINNED } from './settingsNav';

export default function SettingsHub() {
  const check = usePermissionChecker();

  // A group whose every item is permission-hidden must not leave its heading
  // behind — a crew user should see no empty "People & access" label.
  const groups = SETTINGS_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => check(i.perm)) }))
    .filter((g) => g.items.length > 0);

  const showPinned = check(SETTINGS_PINNED.perm);

  return (
    <div className="set-hub">
      {showPinned && (
        <Link to={SETTINGS_PINNED.to} className="set-hub-card set-hub-pinned">
          <span className="set-hub-card-title">
            <Icon name={SETTINGS_PINNED.icon} size={16} />
            {SETTINGS_PINNED.label}
          </span>
          <span className="set-hub-card-desc">{SETTINGS_PINNED.desc}</span>
        </Link>
      )}

      {groups.map((group) => (
        <section className="set-hub-group" key={group.key}>
          <h2 className="set-hub-group-title">{group.label}</h2>
          <div className="set-hub-grid">
            {group.items.map((item) => (
              <Link to={item.to} className="set-hub-card" key={item.to}>
                <span className="set-hub-card-title">
                  <Icon name={item.icon} size={16} />
                  {item.label}
                </span>
                <span className="set-hub-card-desc">{item.desc}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
