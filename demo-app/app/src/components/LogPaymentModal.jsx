import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectActiveClients,
  selectInvoicesForClient,
  invoiceBalance,
  deriveInvoiceStatus,
  nextInvoiceId,
} from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { todayIso, composeIso, money } from '../lib/dates';

function todayDate() {
  return todayIso().slice(0, 10);
}

function buildInitialForm({ presetClientId }) {
  return {
    clientId: presetClientId || '',
    invoiceId: '',
    amount: '',
    method: 'ACH',
    date: todayDate(),
    note: '',
  };
}

export default function LogPaymentModal({ open, onClose, presetClientId = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const clients = selectActiveClients(state);

  const [form, setForm] = useState(() => buildInitialForm({ presetClientId }));

  useEffect(() => {
    if (!open) return;
    setForm(buildInitialForm({ presetClientId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetClientId]);

  // Outstanding invoices for the selected client — anything that's not paid or void.
  const outstandingInvoices = useMemo(() => {
    if (!form.clientId) return [];
    return selectInvoicesForClient(state, form.clientId).filter((inv) => {
      const st = deriveInvoiceStatus(inv);
      return st !== 'paid' && st !== 'void';
    });
  }, [state, form.clientId]);

  const linkedInvoice = form.invoiceId
    ? state.invoices.find((i) => i.id === form.invoiceId) || null
    : null;
  const linkedBalance = linkedInvoice ? invoiceBalance(linkedInvoice) : null;

  const onClientChange = (clientId) => {
    setForm({ ...form, clientId, invoiceId: '' });
  };

  const submit = (e) => {
    e.preventDefault();
    if (!form.clientId) return;
    const amount = Number(form.amount);
    if (!amount || amount <= 0) return;

    const dateIso = composeIso(form.date, '12:00');
    const paymentNote = form.note.trim();

    let targetInvoiceId = form.invoiceId;

    if (!targetInvoiceId) {
      // No invoice linked — auto-create a stub invoice so the payment has a home.
      // Single line item carries the amount; status will derive to 'paid' once
      // the payment lands (balance = 0). Forward-compatible with the future
      // Billing Suite, where real invoices will exist before the payment.
      targetInvoiceId = nextInvoiceId(state);
      dispatch({
        type: ACTIONS.ADD_INVOICE,
        invoice: {
          id: targetInvoiceId,
          clientId: form.clientId,
          siteId: null,
          billingContactId: null,
          jobIds: [],
          issueDate: dateIso,
          dueDate: dateIso,
          lineItems: [{
            id: newId('li'),
            description: 'Payment received',
            qty: 1,
            unitPrice: amount,
          }],
          taxRate: 0,
          status: 'pending',
          payments: [],
          notes: paymentNote ? `Logged from payment: ${paymentNote}` : '',
          attachment: null,
        },
      });
    }

    dispatch({
      type: ACTIONS.ADD_INVOICE_PAYMENT,
      id: targetInvoiceId,
      payment: {
        amount,
        method: form.method,
        date: dateIso,
        note: paymentNote,
      },
    });

    toast.success('Payment logged');
    onClose();
  };

  const submitDisabled = !form.clientId || !(Number(form.amount) > 0);

  const invoiceOptions = [
    { value: '', label: 'No invoice — log standalone payment' },
    ...outstandingInvoices.map((inv) => ({
      value: inv.id,
      label: `${inv.id} — balance ${money(invoiceBalance(inv))}`,
    })),
  ];

  return (
    <Modal open={open} onClose={onClose} title="Record Payment">
      <form onSubmit={submit}>
        <div className="form-row">
          <FormField
            label="Client" as="select" required value={form.clientId}
            onChange={(e) => onClientChange(e.target.value)}
            options={[{ value: '', label: 'Select a client' }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
          />
          <FormField
            label="Apply to invoice" as="select" value={form.invoiceId}
            onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}
            options={invoiceOptions}
            disabled={!form.clientId}
            help={form.clientId && outstandingInvoices.length === 0 ? 'No outstanding invoices for this client.' : undefined}
          />
        </div>

        {linkedInvoice && linkedBalance != null && Number(form.amount) > linkedBalance && (
          <div className="form-help" style={{ marginBottom: 8 }}>
            Amount exceeds the invoice balance ({money(linkedBalance)}). The overpayment is still recorded.
          </div>
        )}

        <div className="form-row">
          <FormField
            label="Amount" type="number" step="0.01" min="0" required
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder={linkedBalance != null ? money(linkedBalance) : '0.00'}
          />
          <FormField
            label="Method" as="select" value={form.method}
            onChange={(e) => setForm({ ...form, method: e.target.value })}
            options={[
              { value: 'ACH', label: 'ACH' },
              { value: 'Card', label: 'Card' },
              { value: 'Check', label: 'Check' },
              { value: 'Cash', label: 'Cash' },
              { value: 'Manual', label: 'Manual' },
            ]}
          />
          <FormField
            label="Date" type="date" value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </div>

        <FormField
          label="Note" value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          placeholder="Check #, ref, memo…"
        />

        {!form.invoiceId && form.clientId && (
          <div className="text-xs text-muted" style={{ marginTop: 4 }}>
            We'll create a stub invoice for this client so the payment has a home in reporting.
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-success" disabled={submitDisabled}>Record Payment</button>
        </div>
      </form>
    </Modal>
  );
}
