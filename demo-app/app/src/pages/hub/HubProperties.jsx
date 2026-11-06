import { Link, useLocation } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useFromHere } from '../../hooks/useFromHere';
import { HUB_NAV, sectionPath, hubSectionOf, hubBuildingIdOf } from './hubNav';
import { useHub, hubVisitDay } from './hubData';
import HubSectionHead from './HubSectionHead';

// YOUR PROPERTIES — the property switcher's page (Matt's boards mobile-04 / web-03, plan §3.1).
// One card per building this login may see: the one in view "Currently viewing", the others
// their next visit ("Next visit Mon, Oct 12", from the view's `nextVisit`). Picking one opens the
// SAME section of that building the person came from (Checklists stays Checklists), else Home.
// "4 locations under Bayside Property Group" when every building is in one of the viewer's groups.
export default function HubProperties() {
  const { hub, loading, error, onRetry, currentId } = useHub();
  const { state } = useLocation();
  const nav = useFromHere();
  const from = typeof state?.from === 'string' ? state.from : '';
  const viewing = hubBuildingIdOf(from) || currentId;
  const section = hubSectionOf(from);
  const back = <BackLink to={viewing ? sectionPath(viewing, '') : '/hub'} label="Back to Dashboard" />;

  if (loading) return <div className="hub-page">{back}<p className="text-muted">Loading your properties…</p></div>;
  if (error) {
    return (
      <div className="hub-page">
        {back}
        <div className="card hub-card">
          <p className="text-sm">{error}</p>
          {onRetry && <button type="button" className="btn btn-outline" onClick={onRetry}>Try again</button>}
        </div>
      </div>
    );
  }

  const buildings = hub?.buildings || [];
  const groups = hub?.groups || [];
  const covered = new Set(groups.flatMap((g) => g.buildingIds || []));
  const under = buildings.length && groups.length && buildings.every((b) => covered.has(b.id))
    ? ` under ${listAnd(groups.map((g) => g.name))}` : '';
  const sections = HUB_NAV.filter((e) => e.switchNote).map((e) => e.label);

  return (
    <div className="hub-page">
      <HubSectionHead back={back} title="Your Properties" />
      <div className="hub-head-sub text-sm hub-props-count">{buildings.length} {buildings.length === 1 ? 'location' : 'locations'}{under}</div>
      {buildings.length === 0 ? (
        <EmptyState
          icon={<Icon name="building" size={28} />}
          title="No buildings yet"
          message="Nobody has given this login a building to look at. Contact the office and they will add it."
        />
      ) : (
        <div className="hub-props">
          {buildings.map((b) => {
            const current = b.id === viewing;
            return (
              <Link key={b.id} className={`card hub-prop${current ? ' is-current' : ''}`} to={sectionPath(b.id, section)} state={nav} aria-current={current ? 'page' : undefined}>
                <span className="hub-prop-icon" aria-hidden><Icon name="building" size={20} /></span>
                <span className="hub-prop-text">
                  <span className="hub-prop-name">{b.name}</span>
                  <span className="hub-prop-sub text-sm">
                    {current ? 'Currently viewing' : (b.nextVisit ? `Next visit ${hubVisitDay(b.nextVisit)}` : 'No visit scheduled')}
                  </span>
                </span>
                <span className="hub-prop-mark" aria-hidden><Icon name={current ? 'check' : 'chevronRight'} size={18} /></span>
              </Link>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted hub-props-note">Switching properties updates {listAnd(sections)} to that location.</p>
    </div>
  );
}

// "A, B, and C" — the boards' own list style.
function listAnd(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}
