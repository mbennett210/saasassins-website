import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { useFromHere } from '../../hooks/useFromHere';
import { fetchHubDocuments } from '../../lib/clientHubApi';
import { sectionPath } from './hubNav';
import { useHubRead } from './hubData';
import { documentsTileLine } from './hubPaperwork';
import HubTile from './HubTile';

// Home's DOCUMENTS tile (Matt's boards mobile-01 / web-01; the client hub redesign, plan §3.6):
// the names it has — "Service agreement · COI · W-9". On a desktop it is a tile like the rest; on
// a phone it is a full-width row with a chevron, as the phone board draws it (HubHome gives it a
// wide slot, which the stylesheet narrows back to one tile from the desktop up). It reads its own
// answer, so Home never waits on it.
// A Tile gets { building, home, preview } (HubHome's TILES); this one needs the building alone, and
// is read-only whoever is looking (a customer, or the office's preview).
export default function HubDocumentsTile({ building }) {
  const nav = useFromHere();
  const read = useHubRead(() => fetchHubDocuments(building.id), [building.id]);
  const to = sectionPath(building.id, 'documents');
  const line = read.loading ? 'Loading…' : read.error ? "Documents couldn't be loaded" : documentsTileLine(read.data);
  return (
    <>
      <div className="hub-tile-frame hub-only-desktop">
        <HubTile to={to} icon="folder" tone="blue" title="Documents" cta="View documents →">
          <span className="hub-tile-line">{line}</span>
        </HubTile>
      </div>
      <Link className="card hub-row-tile hub-only-phone" to={to} state={nav}>
        <span className="hub-tile-icon is-blue" aria-hidden><Icon name="folder" size={20} /></span>
        <span className="hub-row-tile-text">
          <span className="hub-tile-title">Documents</span>
          <span className="text-sm text-muted">{line}</span>
        </span>
        <Icon name="chevronRight" size={20} />
      </Link>
    </>
  );
}
