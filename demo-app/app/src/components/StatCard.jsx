import { Link } from 'react-router-dom';
import Icon from './Icon';

// A dashboard stat tile. When `to` is passed the whole card becomes a drill-down
// link to its filtered list view (carry referrer state via `navState`, e.g.
// useFromHere()), rendering a chevron affordance. Without `to` it is the plain
// presentational card it has always been — fully backward compatible.
export default function StatCard({ value, label, trend, trendDirection = 'up', to, navState }) {
  const body = (
    <>
      {to && <Icon name="chevronRight" size={14} className="stat-card-chevron" />}
      <div className="stat-val">{value}</div>
      <div className="stat-label">{label}</div>
      {trend && <div className={`stat-trend ${trendDirection}`}>{trend}</div>}
    </>
  );
  if (to) {
    return (
      <Link className="stat-card stat-card-link" to={to} state={navState}>
        {body}
      </Link>
    );
  }
  return <div className="stat-card">{body}</div>;
}
