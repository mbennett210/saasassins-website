import { useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import { fetchHubHistory } from '../../lib/clientHubApi';
import { buildingPath } from './hubNav';
import { useHub, useHubPage, hubWhen } from './hubData';
import HubSectionHead, { hubListState } from './HubSectionHead';

// HISTORY (HUB-9, LOG-1, LOG-9) — a year of service, newest first: arrivals and departures,
// checklists, inspections, and the progress of the requests the customer raised. The boards don't
// draw it; Daniel kept it (decision D3), so it is a section of its own (the client hub redesign,
// plan §3.3), in the sidebar on a desktop and a row on Home on a phone.
export default function HubHistory() {
  const { buildingId } = useParams();
  const { building } = useHub();
  const pager = useHubPage((page) => fetchHubHistory(buildingId, page), { param: 'page', deps: [buildingId] });
  const state = hubListState({
    pager, cols: 3,
    empty: <EmptyState icon={<Icon name="schedule" size={28} />} title="No history in the last year" message="Visits, checklists, inspections and request updates show here as they happen." />,
  });
  return (
    <div className="hub-page">
      <HubSectionHead back={<BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />} title="History" building={building} />
      <p className="text-xs text-muted hub-section-note">The last 12 months of service at this building.</p>
      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>What</th><th>Details</th><th>When</th></tr></thead>
          <tbody>
            {state || pager.pageRows.map((e, i) => (
              <tr key={`${e.at}-${e.kind}-${i}`}>
                <td className="cell-primary">{e.label}</td>
                <td data-label="Details">{e.detail || '—'}</td>
                <td data-label="When" className="tnum">{hubWhen(e.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun="events" />
    </div>
  );
}
