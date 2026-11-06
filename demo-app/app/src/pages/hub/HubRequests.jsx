import { Link, useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import { useFromHere } from '../../hooks/useFromHere';
import { fetchHubTickets } from '../../lib/clientHubApi';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { buildingPath, sectionPath } from './hubNav';
import { useHub, useHubPage, hubDay, STAGE_BADGE } from './hubData';
import HubSectionHead, { hubListState } from './HubSectionHead';

// REQUESTS (HUB-13, WO-4, WO-8) — the old building page's Tickets panel as its own section (the
// client hub redesign, plan §3.3). Matt's word is "request" (decision D6); the office keeps
// "ticket", and the URLs stay /tickets/… because the emails already sent link there.
// Every message a customer sends is its own request with its own conversation. Paged on the
// SERVER, 20 a page (UI_RULES §72), and stacked into cards on a phone (.mobile-stack, §24).
export default function HubRequests() {
  const { buildingId } = useParams();
  const { building, readOnly } = useHub();
  const nav = useFromHere();
  const pager = useHubPage((page) => fetchHubTickets(buildingId, page), { param: 'page', deps: [buildingId] });
  const base = sectionPath(buildingId, 'tickets');
  const state = hubListState({
    pager, cols: 3,
    empty: <EmptyState icon={<Icon name="forms" size={28} />} title="No requests in the last year" message="Something not right? Send a request and it goes straight to your account manager." />,
  });
  return (
    <div className="hub-page">
      <HubSectionHead
        back={<BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />}
        title="Requests"
        building={building}
        actions={readOnly
          // The office's READ-ONLY preview (UI_RULES §151): where the customer sees it, disabled.
          ? <button type="button" className="btn btn-primary" disabled title={HUB_PREVIEW_NOTE}>New request</button>
          : <Link className="btn btn-primary" to={`${base}/new`} state={nav}>New request</Link>}
      />
      <p className="text-xs text-muted hub-section-note">
        {readOnly ? HUB_PREVIEW_NOTE : 'Every message you send is its own request, with its own conversation.'}
      </p>
      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>Request</th><th>Stage</th><th>Raised</th></tr></thead>
          <tbody>
            {state || pager.pageRows.map((t) => (
              <tr key={t.id}>
                <td className="cell-primary">
                  <Link className="hub-row-link" to={`${base}/${encodeURIComponent(t.id)}`} state={nav}>
                    <span className="truncate" title={t.title}>{t.title}</span>
                  </Link>
                  <div className="hub-row-sub text-xs text-muted">
                    {t.typeLabel}{t.categoryLabel ? ` · ${t.categoryLabel}` : ''}{t.area ? ` · ${t.area}` : ''}{t.urgent ? ' · Urgent' : ''}
                  </div>
                </td>
                <td data-label="Stage"><Badge variant={STAGE_BADGE[t.stage] || 'slate'}>{t.stageLabel}</Badge></td>
                <td data-label="Raised" className="tnum">{hubDay(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun="requests" />
    </div>
  );
}
