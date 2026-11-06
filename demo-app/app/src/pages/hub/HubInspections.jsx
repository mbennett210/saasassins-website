import { Link, useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import { useFromHere } from '../../hooks/useFromHere';
import { fetchHubInspections } from '../../lib/clientHubApi';
import { buildingPath, sectionPath } from './hubNav';
import { useHub, useHubPage, hubWhen, RESULT_BADGE } from './hubData';
import HubSectionHead, { hubListState } from './HubSectionHead';

// INSPECTIONS (HUB-6, HUB-7) — the old building page's Inspections panel as its own section (the
// client hub redesign, plan §3.3): every submitted report of the last year, its result and score,
// each opening as the full report with its PDF.
export default function HubInspections() {
  const { buildingId } = useParams();
  const { building } = useHub();
  const nav = useFromHere();
  const pager = useHubPage((page) => fetchHubInspections(buildingId, page), { param: 'page', deps: [buildingId] });
  const base = sectionPath(buildingId, 'inspections');
  const state = hubListState({
    pager, cols: 3,
    empty: <EmptyState icon={<Icon name="star" size={28} />} title="No inspections in the last year" message="When a supervisor inspects this building, the full report shows here." />,
  });
  return (
    <div className="hub-page">
      <HubSectionHead back={<BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />} title="Inspections" building={building} />
      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>Inspection</th><th>Result</th><th>When</th></tr></thead>
          <tbody>
            {state || pager.pageRows.map((r) => (
              <tr key={r.id}>
                <td className="cell-primary">
                  <Link className="hub-row-link" to={`${base}/${encodeURIComponent(r.id)}`} state={nav}>
                    <span className="truncate" title={r.name}>{r.name}</span>
                  </Link>
                </td>
                <td data-label="Result">
                  <Badge variant={RESULT_BADGE[r.result] || 'slate'}>{r.resultLabel}{r.score != null ? ` · ${r.score}%` : ''}</Badge>
                </td>
                <td data-label="When" className="tnum">{hubWhen(r.performedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun="inspections" />
    </div>
  );
}
