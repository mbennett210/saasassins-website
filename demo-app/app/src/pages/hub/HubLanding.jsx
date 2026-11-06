import { Navigate } from 'react-router-dom';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useHub } from './hubData';
import { buildingPath } from './hubNav';

// `/hub` — straight to the current building's Home (plan §3.1): the building last viewed in this
// browser while it is still one of this login's, else the first by name (HubRoot hubCurrentId).
// While the view loads it says so; with no building at all it says why and who adds one.
export default function HubLanding() {
  const { loading, error, onRetry, buildings = [], currentId } = useHub();

  if (loading) return <p className="text-muted">Loading your buildings…</p>;
  if (error) {
    return (
      <div className="card hub-card">
        <p className="text-sm">{error}</p>
        {onRetry && <button type="button" className="btn btn-outline" onClick={onRetry}>Try again</button>}
      </div>
    );
  }
  if (!buildings.length || !currentId) {
    return (
      <EmptyState
        icon={<Icon name="building" size={28} />}
        title="No buildings yet"
        message="Nobody has given this login a building to look at. Contact the office and they will add it."
      />
    );
  }
  return <Navigate to={buildingPath(currentId)} replace />;
}
