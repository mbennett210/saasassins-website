import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import { useToast } from '../../components/Toast';
import { fetchHubInvoices, openHubInvoicePdf } from '../../lib/clientHubApi';
import { HUB_PAGE_SIZE } from '../../lib/clientHubView';
import { HUB_INVOICE_STATE } from '../../lib/hubInvoices';
import { moneyCents } from '../../lib/money';
import { buildingPath } from './hubNav';
import { useHub, hubShortDay, hubTime } from './hubData';
import {
  INVOICE_BANNER, INVOICE_BADGE, invoiceOwed, invoiceDueLine, invoiceDaysLine, invoicePartlyLine, invoiceIssuedDay,
  invoiceStateSentence,
} from './hubPaperwork';
import HubSectionHead from './HubSectionHead';

// INVOICES — read-only from QuickBooks (the client hub redesign, Matt's boards mobile-05 / web-04,
// plan §3.5, 2026-10-08). The last twelve months billed to this building's QuickBooks customer
// (and its sub-customers, M4 ★a / HUB-23), newest first, 20 a page:
//   · the banner, Matt's words: billing and payment are QuickBooks's — there is NO pay button
//     here, by design (his note s2);
//   · desktop: a table, Invoice · Amount · Issued · Status · View, a row still owed tinted;
//   · phone: a card per invoice — "Invoice CS-1042", its status, the amount, "Issued Sep 29 · Due
//     Oct 13" (or "Paid Sep 2"), "View invoice →".
// "View invoice" opens QuickBooks's own PDF of it (GET /api/hub/invoice-pdf: the server re-checks
// the invoice is this building's). Anything but `ready` (QuickBooks not connected, this building
// not linked, QuickBooks down) shows that state's one sentence. The words: ./hubPaperwork.js.

// The invoices list is a server page that ALSO answers the state, the summary and when QuickBooks
// was read; useHubPage keeps only the rows, so this page keeps the whole answer. Same pager shape
// (ListPager reads it; the table maps `.pageRows`, lint:tables), the page in the URL (?page=).
function useInvoicePage(buildingId) {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
  const [state, setState] = useState({ data: null, error: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, error: '' }));
    fetchHubInvoices(buildingId, { offset: (page - 1) * HUB_PAGE_SIZE, limit: HUB_PAGE_SIZE })
      .then((data) => { if (alive) setState({ data, error: '' }); })
      .catch((e) => { if (alive) setState({ data: null, error: e?.message || 'Invoices could not be loaded.' }); });
    return () => { alive = false; };
  }, [buildingId, page, tick]);
  const data = state.data;
  const total = Number(data?.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / HUB_PAGE_SIZE));
  const setPage = (next) => {
    const params = new URLSearchParams(searchParams);
    const clamped = Math.min(Math.max(1, next), totalPages);
    if (clamped <= 1) params.delete('page'); else params.set('page', String(clamped));
    setSearchParams(params, { replace: true });
  };
  return {
    data, error: state.error, loading: !data && !state.error, reload: () => setTick((t) => t + 1),
    pageRows: Array.isArray(data?.rows) ? data.rows : [],
    page, totalPages, setPage, total, pageSize: HUB_PAGE_SIZE,
    start: total === 0 ? 0 : (page - 1) * HUB_PAGE_SIZE + 1,
    end: Math.min(page * HUB_PAGE_SIZE, total),
  };
}

const StatusBadge = ({ r }) => <Badge variant={INVOICE_BADGE[r.status]?.variant || 'slate'}>{INVOICE_BADGE[r.status]?.label || r.status}</Badge>;

export default function HubInvoices() {
  const { buildingId } = useParams();
  const { building } = useHub();
  const toast = useToast();
  const pager = useInvoicePage(buildingId);
  const [opening, setOpening] = useState(null);
  const data = pager.data;

  const view = async (r) => {
    setOpening(r.id);
    try { await openHubInvoicePdf(buildingId, r.id); }
    catch (e) { toast.error(e?.message || 'This invoice could not be opened. Try again in a moment.'); }
    finally { setOpening(null); }
  };

  let body;
  if (pager.loading) {
    body = <p className="text-muted">Loading invoices…</p>;
  } else if (pager.error) {
    body = (
      <div className="card hub-card">
        <p className="text-sm">{pager.error}</p>
        <button type="button" className="btn btn-outline" onClick={pager.reload}>Try again</button>
      </div>
    );
  } else if (data?.state !== HUB_INVOICE_STATE.ready) {
    body = (
      <div className="card hub-card">
        <p className="text-sm">{invoiceStateSentence(data?.state)}</p>
        {data?.state === HUB_INVOICE_STATE.unavailable && (
          <button type="button" className="btn btn-outline" onClick={pager.reload}>Try again</button>
        )}
      </div>
    );
  } else if (pager.total === 0) {
    body = <EmptyState icon={<Icon name="invoices" size={28} />} title="No invoices in the last 12 months" message="When this building is billed, its invoices show here." />;
  } else {
    body = (
      <>
        {/* Desktop: the table (Matt's web-04). */}
        <div className="table-wrap hub-only-desktop">
          <table>
            <thead><tr><th>Invoice</th><th>Amount</th><th>Issued</th><th>Status</th><th><span className="sr-only">View</span></th></tr></thead>
            <tbody>
              {pager.pageRows.map((r) => (
                <tr key={r.id} className={invoiceOwed(r) ? 'hub-inv-row is-owed' : 'hub-inv-row'}>
                  <td className="cell-primary"><span className="truncate" title={r.number}>{r.number}</span></td>
                  <td className="tnum hub-inv-amount">{moneyCents(r.totalCents)}</td>
                  <td className="tnum">{invoiceIssuedDay(r)}</td>
                  <td>
                    <span className="hub-badges">
                      <StatusBadge r={r} />
                      <span className="text-xs text-muted">{invoiceDueLine(r)}</span>
                    </span>
                    {r.partlyPaid && <span className="hub-inv-note text-xs">{invoicePartlyLine(r)}</span>}
                  </td>
                  <td className="cell-actions">
                    <button type="button" className="btn btn-link hub-inv-view" disabled={opening === r.id} onClick={() => view(r)} aria-label={`View invoice ${r.number}`}>
                      {opening === r.id ? 'Opening…' : 'View →'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Phone: a card per invoice (Matt's mobile-05). */}
        <div className="hub-inv-cards hub-only-phone">
          {pager.pageRows.map((r) => (
            <article key={r.id} className={`card hub-inv-card${invoiceOwed(r) ? ' is-owed' : ''}`}>
              <div className="hub-inv-card-head">
                <span className="hub-inv-card-title">Invoice {r.number}</span>
                <StatusBadge r={r} />
              </div>
              <div className="hub-inv-card-amount tnum">{moneyCents(r.totalCents)}</div>
              <div className="text-sm text-muted">{invoiceDaysLine(r)}</div>
              {r.partlyPaid && <div className="hub-inv-note text-sm">{invoicePartlyLine(r)}</div>}
              <button type="button" className="btn btn-link hub-inv-card-view" disabled={opening === r.id} onClick={() => view(r)}>
                {opening === r.id ? 'Opening…' : 'View invoice →'}
              </button>
            </article>
          ))}
        </div>
        <ListPager pager={pager} noun="invoices" />
        {data?.asOf && <p className="text-xs text-muted hub-section-note">Updated {hubShortDay(data.asOf)}, {hubTime(data.asOf)}</p>}
      </>
    );
  }

  return (
    <div className="hub-page">
      <HubSectionHead back={<BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />} title="Invoices" building={building} />
      <div className="callout callout-warning hub-callout text-sm" role="note">
        <Icon name="warning" size={16} />
        <span>{INVOICE_BANNER}</span>
      </div>
      {body}
    </div>
  );
}
