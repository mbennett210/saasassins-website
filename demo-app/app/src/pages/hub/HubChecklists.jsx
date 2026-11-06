import { Link, useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import { useFromHere } from '../../hooks/useFromHere';
import { fetchHubChecklists } from '../../lib/clientHubApi';
import { buildingPath, sectionPath } from './hubNav';
import { useHub, useHubPage, hubWhen } from './hubData';
import HubSectionHead, { hubListState } from './HubSectionHead';
import HubFace from './HubFace';

// CHECKLISTS (HUB-8) — the old building page's Checklists panel as its own section (the client hub
// redesign, plan §3.3): each clean's checklist once the cleaner saves it, newest first, paged on
// the SERVER (20 a page), each one opening item by item. The cleaner shows with their photo
// (HUB-19, ./HubFace).
export default function HubChecklists() {
  const { buildingId } = useParams();
  const { building } = useHub();
  const nav = useFromHere();
  const pager = useHubPage((page) => fetchHubChecklists(buildingId, page), { param: 'page', deps: [buildingId] });
  const base = sectionPath(buildingId, 'checklists');
  const state = hubListState({
    pager, cols: 4,
    empty: <EmptyState icon={<Icon name="check" size={28} />} title="No checklists in the last year" message="Each clean's checklist shows here once the cleaner saves it." />,
  });
  return (
    <div className="hub-page">
      <HubSectionHead back={<BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />} title="Checklists" building={building} />
      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>Checklist</th><th>Done</th><th>Cleaner</th><th>When</th></tr></thead>
          <tbody>
            {state || pager.pageRows.map((c) => (
              <tr key={c.id}>
                <td className="cell-primary">
                  <Link className="hub-row-link" to={`${base}/${encodeURIComponent(c.id)}`} state={nav}>
                    <span className="truncate" title={c.name}>{c.name}</span>
                  </Link>
                </td>
                <td data-label="Done"><Badge variant={c.complete ? 'green' : 'amber'}>{c.done} of {c.total}</Badge></td>
                <td data-label="Cleaner">
                  {c.cleaner ? (
                    <span className="hub-person">
                      <HubFace buildingId={buildingId} name={c.cleaner} photo={c.cleanerPhoto} size="xs" />
                      <span className="truncate" title={c.cleaner}>{c.cleaner}</span>
                    </span>
                  ) : '—'}
                </td>
                <td data-label="When" className="tnum">{hubWhen(c.performedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun="checklists" />
    </div>
  );
}
