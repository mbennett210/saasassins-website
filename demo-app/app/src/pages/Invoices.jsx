import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge, { statusBadgeVariant } from '../components/Badge';
import StatCard from '../components/StatCard';
import EmptyState from '../components/EmptyState';
import FormField from '../components/FormField';
import Icon from '../components/Icon';
import LogInvoiceModal from '../components/LogInvoiceModal';
import LogPaymentModal from '../components/LogPaymentModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { usePermission } from '../hooks/usePermission';
import {
  selectInvoices, selectClients, selectClientById, invoiceTotal, invoiceBalance,
  invoicePaid, deriveInvoiceStatus, selectAgingBuckets, selectUninvoicedCompletedJobs,
  selectServiceById, selectSiteById,
} from '../store/selectors';
import { fmtDate, money, todayIso } from '../lib/dates';
import { newId } from '../lib/ids';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';

export default function Invoices() {
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const nav = useFromHere();
  const canCreate = usePermission('invoices.edit');
  const canPay = usePermission('invoices.recordPayment');

  const invoices = selectInvoices(state);
  const clients = selectClients(state);

  // Sweep for newly-overdue invoices on mount here too (not only the Dashboard),
  // so overdue notifications fire even in an org whose active users live on the
  // Invoices page and rarely open the Dashboard. Idempotent (one-shot per invoice
  // via overdueNotifiedAt), same as the Dashboard sweep.
  useEffect(() => { dispatch({ type: ACTIONS.MARK_INVOICES_OVERDUE }); }, [dispatch]);

  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key, value, defaultValue) => {
    const next = new URLSearchParams(searchParams);
    if (value === '' || value == null || value === defaultValue) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const [modalOpen, setModalOpen] = useState(false);
  // Global search "New invoice" deep-link: ?new=1 opens the log-invoice modal once, then
  // strips the param (preserving filters). Gated on canCreate.
  useEffect(() => {
    if (searchParams.get('new') && canCreate) {
      setModalOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, canCreate, setSearchParams]);
  // When invoicing a completed job, seed the modal from that job (client / site /
  // service / jobId). null → the plain "Add Invoice" flow.
  const [jobPreset, setJobPreset] = useState(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const statusFilter = searchParams.get('status') || 'all';
  const clientFilter = searchParams.get('client') || '';
  const dateRange = searchParams.get('range') || '30';
  const [selection, setSelection] = useState(new Set());
  const [confirmPaid, setConfirmPaid] = useState(false);

  const withStatus = useMemo(() => invoices.map((inv) => ({ ...inv, derivedStatus: deriveInvoiceStatus(inv) })), [invoices]);

  const clientById = useMemo(() => {
    const m = new Map();
    clients.forEach((c) => m.set(c.id, c));
    return m;
  }, [clients]);

  const filtered = useMemo(() => {
    const now = new Date();
    const clientQuery = clientFilter.trim().toLowerCase();
    return withStatus.filter((inv) => {
      if (statusFilter !== 'all' && inv.derivedStatus !== statusFilter) return false;
      if (clientQuery) {
        const c = clientById.get(inv.clientId);
        if (!c?.name?.toLowerCase().includes(clientQuery)) return false;
      }
      if (dateRange !== 'all') {
        const days = Number(dateRange);
        const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - days);
        if (new Date(inv.issueDate) < cutoff) return false;
      }
      return true;
    });
  }, [withStatus, statusFilter, clientFilter, dateRange, clientById]);

  // Pagination (URL-backed, 20/page via the shared hook). StatCards, AR aging,
  // collected/outstanding/overdue and select-all all read the FULL
  // withStatus/filtered sets below — never this page slice.
  const invPager = usePagedRows(filtered, { param: 'ipage', resetKey: `${statusFilter}|${clientFilter}|${dateRange}` });

  const collected = withStatus.reduce((a, inv) => a + invoicePaid(inv), 0);
  const outstanding = withStatus.reduce((a, inv) => inv.derivedStatus === 'pending' ? a + invoiceBalance(inv) : a, 0);
  const overdue = withStatus.reduce((a, inv) => inv.derivedStatus === 'overdue' ? a + invoiceBalance(inv) : a, 0);
  const outstandingCount = withStatus.filter((i) => i.derivedStatus === 'pending').length;
  const overdueCount = withStatus.filter((i) => i.derivedStatus === 'overdue').length;

  // AR aging — computed across ALL invoices (not the filtered view) so the
  // receivable picture is complete regardless of the active status/date filter.
  const aging = useMemo(() => selectAgingBuckets(state), [state]);
  const AGING_BUCKETS = [
    { key: 'current', label: 'Current', hint: 'Not yet due' },
    { key: 'd1_30', label: '1–30 days', hint: 'Past due' },
    { key: 'd31_60', label: '31–60 days', hint: 'Past due' },
    { key: 'd61plus', label: '61–90+ days', hint: 'Past due' },
  ];

  // Completed jobs not yet on any invoice — one-click to invoice, seeding the
  // modal from the job's client / site / service and stamping invoice.jobIds.
  const uninvoicedJobs = useMemo(() => selectUninvoicedCompletedJobs(state), [state]);
  const uninvoicedPager = usePagedRows(uninvoicedJobs);
  const [showUninvoiced, setShowUninvoiced] = useState(false);
  const invoiceJob = (job) => {
    setJobPreset({ clientId: job.clientId, siteId: job.siteId || null, jobId: job.id, serviceId: job.serviceId || null });
    setModalOpen(true);
  };
  const closeInvoiceModal = () => { setModalOpen(false); setJobPreset(null); };

  const toggleSelect = (id) => {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelection(next);
  };
  const toggleAll = () => {
    if (selection.size === filtered.length) setSelection(new Set());
    else setSelection(new Set(filtered.map((i) => i.id)));
  };

  // Split the selection so the confirm dialog can state what will really happen.
  const voidSelectionCount = [...selection]
    .filter((id) => invoices.find((x) => x.id === id)?.status === 'void').length;
  const payableSelectionCount = selection.size - voidSelectionCount;

  const bulkMarkPaid = () => {
    [...selection].forEach((id) => {
      const inv = invoices.find((x) => x.id === id);
      if (!inv) return;
      // 🔴 NEVER RESURRECT A VOID INVOICE. Nothing here excluded them: `canPay` is a
      // permission check, invoiceBalance() ignores void status and returns the full
      // total, and SET_INVOICE_STATUS 'paid' overwrites the void marker that
      // deriveInvoiceStatus treats as authoritative. So selecting a void invoice in the
      // list and clicking Mark Paid FABRICATED a full-balance payment that never
      // happened and un-voided the invoice — corrupting the ledger in two directions at
      // once, and then counting the phantom payment toward Collected and lifetime
      // revenue. Voiding is the correction mechanism; it must not be undoable by a bulk
      // action that never mentions it.
      if (inv.status === 'void') return;
      const bal = invoiceBalance(inv);
      if (bal > 0) {
        // id minted here — the dedupe key that makes a replay safe. See reducer.js.
        dispatch({ type: ACTIONS.ADD_INVOICE_PAYMENT, id, payment: { id: newId('pay'), amount: bal, method: 'Manual', note: 'Bulk mark paid', date: todayIso() } });
      }
      dispatch({ type: ACTIONS.SET_INVOICE_STATUS, id, status: 'paid' });
    });
    setSelection(new Set());
    setConfirmPaid(false);
  };

  const exportCsv = () => {
    const rows = [['Invoice', 'Company', 'Issued', 'Due', 'Total', 'Balance', 'Status']];
    filtered.forEach((inv) => {
      const c = selectClientById(state, inv.clientId);
      rows.push([inv.id, c?.name || '', inv.issueDate, inv.dueDate, invoiceTotal(inv), invoiceBalance(inv), inv.derivedStatus]);
    });
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'invoices.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="page-head">
        <h1>Invoices</h1>
        <div className="page-head-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canPay && (
            <button className="btn btn-success" onClick={() => setPaymentModalOpen(true)}>
              Record Payment
            </button>
          )}
          {canCreate && (
            <button className="btn btn-primary" onClick={() => { setJobPreset(null); setModalOpen(true); }}>
              Add Invoice
            </button>
          )}
        </div>
      </div>

      <div className="stat-grid">
        <StatCard value={money(collected)} label="Collected" trendDirection="up" />
        <StatCard value={money(outstanding)} label="Outstanding" trend={`${outstandingCount} invoice${outstandingCount === 1 ? '' : 's'}`} trendDirection="down" />
        <StatCard value={money(overdue)} label="Overdue" trend={`${overdueCount} invoice${overdueCount === 1 ? '' : 's'}`} trendDirection="down" />
      </div>

      <div className="aging-card">
        <div className="aging-card-head">
          <h3 className="dash-card-title">Accounts receivable aging</h3>
          <span className="text-sm text-muted">{money(aging.total)} outstanding · {aging.count} invoice{aging.count === 1 ? '' : 's'}</span>
        </div>
        <div className="aging-grid">
          {AGING_BUCKETS.map((b) => {
            const cell = aging[b.key];
            const overdueCell = b.key !== 'current' && cell.amount > 0;
            return (
              <div key={b.key} className={`aging-cell ${overdueCell ? 'is-overdue' : ''}`}>
                <div className="aging-cell-label">{b.label}</div>
                <div className="aging-cell-value">{money(cell.amount)}</div>
                <div className="aging-cell-meta">{cell.count} invoice{cell.count === 1 ? '' : 's'} · {b.hint}</div>
              </div>
            );
          })}
        </div>
      </div>

      {canCreate && uninvoicedJobs.length > 0 && (
        <div className="aging-card">
          <button
            type="button"
            className="uninvoiced-head"
            onClick={() => setShowUninvoiced((v) => !v)}
            aria-expanded={showUninvoiced}
          >
            <Icon name={showUninvoiced ? 'chevronDown' : 'chevronRight'} size={14} />
            <h3 className="dash-card-title">Completed work to invoice</h3>
            <span className="badge amber">{uninvoicedJobs.length}</span>
            <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
              Done jobs not yet on an invoice
            </span>
          </button>
          {showUninvoiced && (
            <div className="table-wrap mobile-stack" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr><th>Completed</th><th>Company</th><th>Service</th><th>Location</th><th></th></tr>
                </thead>
                <tbody>
                  {uninvoicedPager.pageRows.map((job) => {
                    const client = clientById.get(job.clientId);
                    const service = job.serviceId ? selectServiceById(state, job.serviceId) : null;
                    const site = job.siteId ? selectSiteById(state, job.siteId) : null;
                    return (
                      <tr key={job.id}>
                        <td data-label="Completed">{fmtDate(job.startAt)}</td>
                        <td className="cell-primary"><span className="truncate" title={client?.name || ''}>{client?.name || '—'}</span></td>
                        <td data-label="Service"><span className="truncate" title={service?.name || ''}>{service?.name || '—'}</span></td>
                        <td data-label="Location"><span className="truncate" title={site?.address || ''}>{site?.address || '—'}</span></td>
                        <td className="text-right cell-actions">
                          <button className="btn btn-success btn-sm" onClick={() => invoiceJob(job)}>Invoice</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <ListPager pager={uninvoicedPager} noun="jobs" />
            </div>
          )}
        </div>
      )}

      <div className="filter-bar">
        <FormField label="Status" as="select" value={statusFilter} onChange={(e) => setParam('status', e.target.value, 'all')}
          options={[{ value: 'all', label: 'All statuses' }, { value: 'pending', label: 'Pending' }, { value: 'overdue', label: 'Overdue' }, { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' }]} />
        <FormField label="Date range" as="select" value={dateRange} onChange={(e) => setParam('range', e.target.value, '30')}
          options={[{ value: 'all', label: 'All time' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} />
        <div className="filter-client-search">
          <FormField label="Company" type="text" placeholder="Search by company name…" value={clientFilter}
            onChange={(e) => setParam('client', e.target.value, '')} />
        </div>
      </div>

      {selection.size > 0 && (
        <div className="bulk-bar">
          <span className="text-sm">{selection.size} selected</span>
          {canPay && <button className="btn btn-primary" onClick={() => setConfirmPaid(true)}>Mark Paid</button>}
          <button className="btn btn-outline" onClick={exportCsv}>Export CSV</button>
          <button className="btn btn-danger" onClick={() => setSelection(new Set())}>Clear</button>
        </div>
      )}

      {filtered.length === 0 ? (
        invoices.length === 0 ? (
          <EmptyState icon={<Icon name="invoices" size={28} />} title="No invoices yet" message="Add your first invoice to start tracking payments." action={canCreate && <button className="btn btn-primary" onClick={() => setModalOpen(true)}>Add Invoice</button>} />
        ) : (
          <EmptyState title="No matches" message="Try adjusting filters or date range." />
        )
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={selection.size === filtered.length && filtered.length > 0} onChange={toggleAll} />
                </th>
                <th>Invoice</th>
                <th>Company</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Total</th>
                <th>Balance</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invPager.pageRows.map((inv) => {
                const client = selectClientById(state, inv.clientId);
                return (
                  <tr key={inv.id} className="clickable" onClick={() => navigate(`/invoices/${inv.id}`, { state: nav })}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selection.has(inv.id)} onChange={() => toggleSelect(inv.id)} />
                    </td>
                    <td className="name cell-primary">
                      <span className="invoice-id-cell">
                        {inv.id}
                        {inv.attachment && (
                          <span className="attachment-glyph" title={inv.attachment.name} aria-label="Has attachment">
                            <Icon name="paperclip" size={12} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td data-label="Company"><span className="truncate" title={client?.name || ''}>{client?.name || '—'}</span></td>
                    <td data-label="Issued">{fmtDate(inv.issueDate)}</td>
                    <td data-label="Due">{fmtDate(inv.dueDate)}</td>
                    <td className="money" data-label="Total">{money(invoiceTotal(inv))}</td>
                    <td className="money" data-label="Balance">{money(invoiceBalance(inv))}</td>
                    <td data-label="Status"><Badge variant={statusBadgeVariant(inv.derivedStatus === 'paid' ? 'Paid' : inv.derivedStatus === 'overdue' ? 'Overdue' : inv.derivedStatus === 'void' ? 'Inactive' : 'Pending')}>
                      {inv.derivedStatus.charAt(0).toUpperCase() + inv.derivedStatus.slice(1)}
                    </Badge></td>
                    <td className="text-right cell-chevron"><Icon name="chevronRight" size={14} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ListPager pager={invPager} noun="invoices" />

      <LogInvoiceModal
        open={modalOpen}
        onClose={closeInvoiceModal}
        presetClientId={jobPreset?.clientId || null}
        presetSiteId={jobPreset?.siteId || null}
        presetJobId={jobPreset?.jobId || null}
        presetServiceId={jobPreset?.serviceId || null}
      />
      <LogPaymentModal open={paymentModalOpen} onClose={() => setPaymentModalOpen(false)} />
      {/* The count must reflect what will ACTUALLY change. Void invoices are skipped
          (they must never be resurrected. See bulkMarkPaid), so counting them here
          would promise an action that silently does not happen to part of the
          selection. Say so before the user commits, not after. */}
      <ConfirmDialog
        open={confirmPaid}
        title={`Mark ${payableSelectionCount} invoice${payableSelectionCount === 1 ? '' : 's'} paid?`}
        message={voidSelectionCount > 0
          ? `Full balance will be recorded as a manual payment. ${voidSelectionCount} void invoice${voidSelectionCount === 1 ? '' : 's'} in your selection will be skipped. Voided invoices cannot be marked paid.`
          : 'Full balance will be recorded as a manual payment.'}
        confirmLabel="Mark Paid"
        onConfirm={bulkMarkPaid}
        onClose={() => setConfirmPaid(false)}
      />
    </>
  );
}
