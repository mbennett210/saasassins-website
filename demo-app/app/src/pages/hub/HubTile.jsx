import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useFromHere } from '../../hooks/useFromHere';

// ONE HOME TILE (Matt's boards mobile-01 / web-01): an icon on a tinted square, the title, its
// line, and its way in ("View all →") at the foot. The whole tile is the link, one tap from Home
// (his note s1). Every tile on Home is this frame, so a tile added to HubHome's TILES (Builder C's
// Invoices and Documents) looks like the rest without a class of its own.
//   tone  'amber' | 'blue' | 'green' | 'slate' — the icon square's tint (.hub-tile-icon.is-<tone>)
export default function HubTile({ to, icon, tone = 'slate', title, children, cta }) {
  const nav = useFromHere();
  return (
    <Link className="card hub-tile" to={to} state={nav}>
      <span className={`hub-tile-icon is-${tone}`} aria-hidden><Icon name={icon} size={20} /></span>
      <span className="hub-tile-title">{title}</span>
      <span className="hub-tile-body text-sm">{children}</span>
      <span className="hub-tile-cta text-sm">{cta}</span>
    </Link>
  );
}
