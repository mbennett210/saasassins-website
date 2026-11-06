import { Link, useParams } from 'react-router-dom';
import AreaScanCard from '../../components/AreaScanCard';
import BackLink from '../../components/BackLink';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useFromHere } from '../../hooks/useFromHere';
import { fetchHubArea } from '../../lib/clientHubApi';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { buildingPath, sectionPath } from './hubNav';
import { useHub, useHubRead } from './hubData';

// ONE AREA OF A BUILDING (QR-16, QR Wave 2, 2026-10-17; UI_RULES §173) — `/hub/b/:buildingId/areas/
// :areaId`, the page a customer's scan of that area's code opens (pages/hub/HubScan, the camera or a
// printed code's `?code=`). Matt: "That area's own page: when it was last cleaned, the photo, what
// was done, and a button to make a request about it."
//
// The card is the PUBLIC page's own (components/AreaScanCard — one component, two homes), over the
// same allowlist projection (EP-421, GET /api/hub/area: the building in this login's scope, the area
// on its location): the last clean in the org's zone, the next clean and the last inspection as
// dates, the photo (a short-lived signed thumbnail) and what was done. Under it, "Make a request
// about this area" opens the hub's own New request form for this building, the text started with the
// area's name and the area's id sent with the request (`siteAreaId`), and Back from the form returns
// here. The office's read-only preview draws the button disabled with the preview's words (§151).
// English throughout (LANG-8).
export default function HubArea() {
  const { buildingId, areaId } = useParams();
  const { readOnly } = useHub();
  const here = useFromHere();
  const read = useHubRead(() => fetchHubArea(buildingId, areaId), [buildingId, areaId]);
  const back = <BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />;

  if (read.loading) return <div className="hub-page">{back}<p className="text-muted">Loading the area…</p></div>;
  if (read.error) {
    return (
      <div className="hub-page">
        {back}
        {read.status === 404
          ? <EmptyState icon={<Icon name="building" size={28} />} title="Area not found" message={read.error} />
          : (
            <div className="card hub-card">
              <p className="text-sm">{read.error}</p>
              <button type="button" className="btn btn-outline" onClick={read.reload}>Try again</button>
            </div>
          )}
      </div>
    );
  }

  const { scan, photoUrl } = read.data;
  // The request form's Back names this area; the form starts its text with it and sends its id.
  const requestState = { ...here, fromLabel: scan.area, area: { id: areaId, label: scan.area } };
  return (
    <div className="hub-page">
      {back}
      <AreaScanCard scan={scan} photoUrl={photoUrl}>
        <div className="hub-actions">
          {readOnly ? (
            <button type="button" className="btn btn-primary" disabled title={HUB_PREVIEW_NOTE}>
              <Icon name="forms" size={16} /> Make a request about this area
            </button>
          ) : (
            <Link className="btn btn-primary" to={sectionPath(buildingId, 'tickets/new')} state={requestState}>
              <Icon name="forms" size={16} /> Make a request about this area
            </Link>
          )}
        </div>
        {readOnly && <p className="text-xs text-muted">{HUB_PREVIEW_NOTE}</p>}
      </AreaScanCard>
    </div>
  );
}
