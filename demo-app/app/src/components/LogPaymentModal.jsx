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
} from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { todayKey, composeIso, money, fmtDate } from '../lib/dates';
import { customerLabel } from '../lib/customerNumber';
import { isArchivedCustomer } from '../lib/customerStatus';

function todayDate() {
  return todayKey();
}

// Outstanding invoices for a customer — anything that's not paid or void, OLDEST DUE
// FIRST (CS-145): a payment almost always settles the oldest open invoice, so that is what
// the picker offers at the top instead of whichever happened to be created last. Undated
// invoices sort last rather than jumping the queue. ONE function, so the initial form, the
// customer-change handler and the picker cannot order them differently.
function openInvoicesFor(state, clientId) {
  if (!clientId) return [];
  return selectInvoicesForClient(state, clientId)
    .filter((inv) => {
      const st = deriveInvoiceStatus(inv);
      return st !== 'paid' && st !== 'void';
    })
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
}

// With exactly one open invoice there is one obvious answer, so pre-select it rather than
// leaving a required field blank for the user to decode.
const soleOpenInvoiceId = (state, clientId) => {
  const open = openInvoicesFor(state, clientId);
  return open.length === 1 ? open[0].id : '';
};

function buildInitialForm({ presetClientId, state }) {
  return {
    clientId: presetClientId || '',
    invoiceId: soleOpenInvoiceId(state, presetClientId),
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
  // The customers we serve — and an ARCHIVED one that still owes money (CS-663: it leaves the
  // pickers, but what it owes is still owed), so its payment can be recorded here and from its page.
  const clients = useMemo(() => {
    const live = selectActiveClients(state);
    const all = state.clients || [];
    if (live.length === all.length) return live;
    return all.filter((c) => !isArchivedCustomer(c) || openInvoicesFor(state, c.id).length > 0);
  }, [state]);

  const [form, setForm] = useState(() => buildInitialForm({ presetClientId, state }));

  useEffect(() => {
    if (!open) return;
    setForm(buildInitialForm({ presetClientId, state }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetClientId]);

  const outstandingInvoices = useMemo(() => openInvoicesFor(state, form.clientId), [state, form.clientId]);

  const linkedInvoice = form.invoiceId
    ? state.invoices.find((i) => i.id === form.invoiceId) || null
    : null;
  const linkedBalance = linkedInvoice ? invoiceBalance(linkedInvoice) : null;

  const onClientChange = (clientId) => {
    setForm({ ...form, clientId, invoiceId: soleOpenInvoiceId(state, clientId) });
  };

  // 🔴 A PAYMENT BELONGS TO AN INVOICE (CS-145). This used to fabricate a whole invoice —
  // one line item reading "Payment received", issue date = due date = today, status
  // deriving straight to paid — whenever no invoice was picked, EVEN WHEN the customer had
  // open invoices sitting right there in the dropdown. The money then landed on a
  // fictional document: the real invoice stayed open and chaseable, AR was overstated by
  // its balance while lifetime revenue counted the cash, and the invoice book filled with
  // rows that never described any work. Recording a payment now requires the invoice it
  // pays; when a customer has none, the answer is to raise the invoice first, which the
  // help text says.
  const submit = (e) => {
    e.preventDefault();
    if (!form.clientId || !form.invoiceId) return;
    const amount = Number(form.amount);
    if (!amount || amount <= 0) return;

    const dateIso = composeIso(form.date, '12:00');
    const paymentNote = form.note.trim();

    dispatch({
      type: ACTIONS.ADD_INVOICE_PAYMENT,
      id: form.invoiceId,
      payment: {
        // id minted HERE, not in the reducer: it is the dedupe key that makes this
        // action safe to replay after a save that committed but whose response was lost.
        // See the note on ADD_INVOICE_PAYMENT in store/reducer.js.
        id: newId('pay'),
        amount,
        method: form.method,
        date: dateIso,
        note: paymentNote,
      },
    });

    toast.success('Payment logged');
    onClose();
  };

  const submitDisabled = !form.clientId || !form.invoiceId || !(Number(form.amount) > 0);

  const invoiceOptions = [
    { value: '', label: 'Select an invoice' },
    ...outstandingInvoices.map((inv) => ({
      value: inv.id,
      label: `${inv.id} · ${money(invoiceBalance(inv))} due ${fmtDate(inv.dueDate)}`,
    })),
  ];

  return (
    <Modal open={open} onClose={onClose} title="Record Payment">
      <form onSubmit={submit}>
        <div className="form-row">
          <FormField
            label="Company" as="select" required value={form.clientId}
            onChange={(e) => onClientChange(e.target.value)}
            options={[{ value: '', label: 'Select a company' }, ...clients.map((c) => ({ value: c.id, label: customerLabel(c) }))]}
          />
          <FormField
            label="Apply to invoice" as="select" required value={form.invoiceId}
            onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}
            options={invoiceOptions}
            disabled={!form.clientId}
            help={form.clientId && outstandingInvoices.length === 0
              ? 'No open invoices for this company. Add the invoice first, then record the payment against it.'
              : (form.clientId ? 'Oldest due first.' : undefined)}
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

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-success" disabled={submitDisabled}>Record Payment</button>
        </div>
      </form>
    </Modal>
  );
}
