import { useMemo, useState } from 'react';
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
  invoicePaid, deriveInvoiceStatus,
} from '../store/selectors';
import { fmtDate, money, todayIso } from '../lib/dates';

export default function Invoices() {
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const nav = useFromHere();
  const canCreate = usePermission('invoices.edit');
  const canPay = usePermission('invoices.recordPayment');

  const invoices = selectInvoices(state);
  const clients = selectClients(state);

  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key, value, defaultValue) => {
    const next = new URLSearchParams(searchParams);
    if (value === '' || value == null || value === defaultValue) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const [modalOpen, setModalOpen] = useState(false);
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

  const collected = withStatus.reduce((a, inv) => a + invoicePaid(inv), 0);
  const outstanding = withStatus.reduce((a, inv) => inv.derivedStatus === 'pending' ? a + invoiceBalance(inv) : a, 0);
  const overdue = withStatus.reduce((a, inv) => inv.derivedStatus === 'overdue' ? a + invoiceBalance(inv) : a, 0);
  const outstandingCount = withStatus.filter((i) => i.derivedStatus === 'pending').length;
  const overdueCount = withStatus.filter((i) => i.derivedStatus === 'overdue').length;

  const toggleSelect = (id) => {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelection(next);
  };
  const toggleAll = () => {
    if (selection.size === filtered.length) setSelection(new Set());
    else setSelection(new Set(filtered.map((i) => i.id)));
  };

  const bulkMarkPaid = () => {
    [...selection].forEach((id) => {
      const inv = invoices.find((x) => x.id === id);
      if (!inv) return;
      const bal = invoiceBalance(inv);
      if (bal > 0) {
        dispatch({ type: ACTIONS.ADD_INVOICE_PAYMENT, id, payment: { amount: bal, method: 'Manual', note: 'Bulk mark paid', date: todayIso() } });
      }
      dispatch({ type: ACTIONS.SET_INVOICE_STATUS, id, status: 'paid' });
    });
    setSelection(new Set());
    setConfirmPaid(false);
  };

  const exportCsv = () => {
    const rows = [['Invoice', 'Client', 'Issued', 'Due', 'Total', 'Balance', 'Status']];
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
            <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
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

      <div className="filter-bar">
        <FormField label="Status" as="select" value={statusFilter} onChange={(e) => setParam('status', e.target.value, 'all')}
          options={[{ value: 'all', label: 'All statuses' }, { value: 'pending', label: 'Pending' }, { value: 'overdue', label: 'Overdue' }, { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' }]} />
        <FormField label="Date range" as="select" value={dateRange} onChange={(e) => setParam('range', e.target.value, '30')}
          options={[{ value: 'all', label: 'All time' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} />
        <div className="filter-client-search">
          <FormField label="Client" type="text" placeholder="Search by client name…" value={clientFilter}
            onChange={(e) => setParam('client', e.target.value, '')} />
        </div>
      </div>

      <div className={`bulk-bar ${selection.size === 0 ? 'is-empty' : ''}`}>
        <span className="text-sm">
          {selection.size > 0 ? `${selection.size} selected` : 'Select invoices for bulk actions'}
        </span>
        {selection.size > 0 && (
          <>
            {canPay && <button className="btn btn-primary btn-sm" onClick={() => setConfirmPaid(true)}>Mark Paid</button>}
            <button className="btn btn-outline btn-sm" onClick={exportCsv}>Export CSV</button>
            <button className="btn btn-danger btn-sm" onClick={() => setSelection(new Set())}>Clear</button>
          </>
        )}
      </div>

      {filtered.length === 0 ? (
        invoices.length === 0 ? (
          <EmptyState icon={<Icon name="invoices" size={28} />} title="No invoices yet" message="Add your first invoice to start tracking payments." action={canCreate && <button className="btn btn-primary" onClick={() => setModalOpen(true)}>Add Invoice</button>} />
        ) : (
          <EmptyState title="No matches" message="Try adjusting filters or date range." />
        )
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={selection.size === filtered.length && filtered.length > 0} onChange={toggleAll} />
                </th>
                <th>Invoice</th>
                <th>Client</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Total</th>
                <th>Balance</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const client = selectClientById(state, inv.clientId);
                return (
                  <tr key={inv.id} className="clickable" onClick={() => navigate(`/invoices/${inv.id}`, { state: nav })}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selection.has(inv.id)} onChange={() => toggleSelect(inv.id)} />
                    </td>
                    <td className="name">
                      <span className="invoice-id-cell">
                        {inv.id}
                        {inv.attachment && (
                          <span className="attachment-glyph" title={inv.attachment.name} aria-label="Has attachment">
                            <Icon name="paperclip" size={12} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td>{client?.name || '—'}</td>
                    <td>{fmtDate(inv.issueDate)}</td>
                    <td>{fmtDate(inv.dueDate)}</td>
                    <td className="money">{money(invoiceTotal(inv))}</td>
                    <td className="money">{money(invoiceBalance(inv))}</td>
                    <td><Badge variant={statusBadgeVariant(inv.derivedStatus === 'paid' ? 'Paid' : inv.derivedStatus === 'overdue' ? 'Overdue' : inv.derivedStatus === 'void' ? 'Inactive' : 'Pending')}>
                      {inv.derivedStatus.charAt(0).toUpperCase() + inv.derivedStatus.slice(1)}
                    </Badge></td>
                    <td className="text-right"><Icon name="chevronRight" size={14} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <LogInvoiceModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <LogPaymentModal open={paymentModalOpen} onClose={() => setPaymentModalOpen(false)} />
      <ConfirmDialog
        open={confirmPaid}
        title={`Mark ${selection.size} invoice${selection.size === 1 ? '' : 's'} paid?`}
        message="Full balance will be recorded as a manual payment."
        confirmLabel="Mark Paid"
        onConfirm={bulkMarkPaid}
        onClose={() => setConfirmPaid(false)}
      />
    </>
  );
}
