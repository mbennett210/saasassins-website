import Badge from '../../components/Badge';
import { fetchHubInvoices } from '../../lib/clientHubApi';
import { HUB_INVOICE_STATE } from '../../lib/hubInvoices';
import { sectionPath } from './hubNav';
import { useHubRead } from './hubData';
import { invoicesTileLine } from './hubPaperwork';
import HubTile from './HubTile';

// Home's INVOICES tile (Matt's boards mobile-01 / web-01; the client hub redesign, plan §3.5):
// "1 open ($1,160.00) · 2 paid · via QuickBooks", and the overdue ones flagged. It reads its OWN
// answer — the invoices list's summary, one row asked for (the summary covers the whole twelve
// months whatever the page) — so a slow QuickBooks never holds Home up: the tile says "Loading…"
// while the rest of Home is already there. A building QuickBooks can't show yet gets a short line
// instead (the Invoices page says why in full).
// A Tile gets { building, home, preview } (HubHome's TILES); this one needs the building alone, and
// is read-only whoever is looking (a customer, or the office's preview).
export default function HubInvoicesTile({ building }) {
  const read = useHubRead(() => fetchHubInvoices(building.id, { limit: 1 }), [building.id]);
  const overdue = read.data?.state === HUB_INVOICE_STATE.ready ? read.data.summary?.overdueCount || 0 : 0;
  return (
    <HubTile to={sectionPath(building.id, 'invoices')} icon="invoices" tone="purple" title="Invoices" cta="View all invoices →">
      {read.loading ? 'Loading…' : read.error ? "Invoices couldn't be loaded" : (
        <>
          <span className="hub-tile-line">{invoicesTileLine(read.data)}</span>
          {overdue > 0 && <span className="hub-tile-flag"><Badge variant="red">{overdue} overdue</Badge></span>}
        </>
      )}
    </HubTile>
  );
}
