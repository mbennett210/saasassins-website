import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectInvoiceById, selectClientById, selectSiteById, selectContactById,
  invoiceTotal, invoicePaid, invoiceBalance, deriveInvoiceStatus,
} from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import DetailHeader from '../components/DetailHeader';
import Badge, { statusBadgeVariant } from '../components/Badge';
import ConfirmDialog from '../components/ConfirmDialog';
import ContactPicker from '../components/ContactPicker';
import FormField from '../components/FormField';
import Icon from '../components/Icon';
import { newId } from '../lib/ids';
import { fmtDate, fmtDateLong, money, moneyPrecise, todayIso, splitIso } from '../lib/dates';
import {
  saveAttachment,
  loadAttachment,
  deleteAttachment,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_ALLOWED_MIME,
  formatBytes,
} from '../lib/attachments';

export default function InvoiceDetail() {
  const { invoiceId } = useParams();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const nav = useFromHere();
  const canEdit = usePermission('invoices.edit');
  const canPay = usePermission('invoices.recordPayment');

  const invoice = selectInvoiceById(state, invoiceId);
  const client = invoice ? selectClientById(state, invoice.clientId) : null;
  const site = invoice?.siteId ? selectSiteById(state, invoice.siteId) : null;
  const billingContact = invoice?.billingContactId ? selectContactById(state, invoice.billingContactId) : null;

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(invoice);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [payment, setPayment] = useState({ amount: '', method: 'ACH', note: '', date: todayIso().slice(0, 10) });
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState(null);
  const [confirmRemoveAttachment, setConfirmRemoveAttachment] = useState(false);
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const [paymentDraft, setPaymentDraft] = useState(null);
  const fileInputRef = useRef(null);
  const blobUrlRef = useRef(null);
  const paymentFormRef = useRef(null);

  useEffect(() => () => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  if (!invoice) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo="/invoices" title="Invoice not found" />
      </div>
    );
  }

  const currentForm = form && form.id === invoice.id ? form : invoice;
  const total = invoiceTotal(currentForm);
  const paid = invoicePaid(invoice);
  const balance = invoiceBalance(invoice);
  const derivedStatus = deriveInvoiceStatus(invoice);

  const updateLineItem = (id, patch) => {
    setForm({
      ...currentForm,
      lineItems: currentForm.lineItems.map((li) => (li.id === id ? { ...li, ...patch } : li)),
    });
  };
  const addLineItem = () => {
    setForm({
      ...currentForm,
      lineItems: [...currentForm.lineItems, { id: newId('li'), description: '', qty: 1, unitPrice: 0 }],
    });
  };
  const removeLineItem = (id) => {
    setForm({
      ...currentForm,
      lineItems: currentForm.lineItems.filter((li) => li.id !== id),
    });
  };

  const save = () => {
    dispatch({
      type: ACTIONS.UPDATE_INVOICE,
      id: invoice.id,
      patch: {
        issueDate: currentForm.issueDate,
        dueDate: currentForm.dueDate,
        lineItems: currentForm.lineItems.map((li) => ({ ...li, qty: Number(li.qty) || 0, unitPrice: Number(li.unitPrice) || 0 })),
        taxRate: Number(currentForm.taxRate) || 0,
        siteId: currentForm.siteId || null,
        billingContactId: currentForm.billingContactId || null,
        notes: typeof currentForm.notes === 'string' ? currentForm.notes : (invoice.notes || ''),
      },
    });
    setEditing(false);
    toast.success('Invoice updated');
  };

  const recordPayment = () => {
    const amt = Number(payment.amount);
    if (!amt || amt <= 0) return;
    dispatch({
      type: ACTIONS.ADD_INVOICE_PAYMENT,
      id: invoice.id,
      payment: { amount: amt, method: payment.method, note: payment.note, date: payment.date },
    });
    setPayment({ amount: '', method: 'ACH', note: '', date: todayIso().slice(0, 10) });
    setShowPaymentForm(false);
    toast.success('Payment recorded');
  };

  const removePayment = (paymentId) => {
    dispatch({ type: ACTIONS.REMOVE_INVOICE_PAYMENT, id: invoice.id, paymentId });
  };

  // Mark Paid is a fast-path of the Record Payment flow: pre-fill the form
  // with the outstanding balance + a sensible default method + today's date,
  // then let the user adjust details before confirming. Status auto-derives
  // to 'paid' once the payment lands and balance hits 0.
  const markPaid = () => {
    const outstanding = invoiceBalance(invoice);
    setPayment({
      amount: outstanding > 0 ? String(outstanding.toFixed(2)) : '',
      method: 'Check',
      note: '',
      date: todayIso().slice(0, 10),
    });
    setShowPaymentForm(true);
    setTimeout(() => paymentFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };

  const startEditPayment = (p) => {
    setEditingPaymentId(p.id);
    setPaymentDraft({
      amount: String(p.amount ?? ''),
      method: p.method || 'ACH',
      date: p.date ? p.date.slice(0, 10) : todayIso().slice(0, 10),
      note: p.note || '',
    });
  };

  const cancelEditPayment = () => {
    setEditingPaymentId(null);
    setPaymentDraft(null);
  };

  const saveEditPayment = () => {
    if (!editingPaymentId || !paymentDraft) return;
    const amt = Number(paymentDraft.amount);
    if (!amt || amt <= 0) return;
    dispatch({
      type: ACTIONS.UPDATE_INVOICE_PAYMENT,
      id: invoice.id,
      paymentId: editingPaymentId,
      patch: {
        amount: amt,
        method: paymentDraft.method,
        date: paymentDraft.date,
        note: paymentDraft.note,
      },
    });
    setEditingPaymentId(null);
    setPaymentDraft(null);
    toast.success('Payment updated');
  };

  const voidInvoice = () => {
    dispatch({ type: ACTIONS.SET_INVOICE_STATUS, id: invoice.id, status: 'void' });
  };

  const del = () => {
    dispatch({ type: ACTIONS.DELETE_INVOICE, id: invoice.id });
    navigate('/invoices');
  };

  const onPickAttachment = async (file) => {
    setAttachmentError(null);
    if (!file) return;
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setAttachmentError(`File too large (max ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB).`);
      return;
    }
    if (file.type && !ATTACHMENT_ALLOWED_MIME.includes(file.type)) {
      setAttachmentError('File type not supported. Use PDF or PNG/JPG/WebP.');
      return;
    }
    setAttachmentBusy(true);
    try {
      const meta = await saveAttachment(invoice.id, file);
      dispatch({ type: ACTIONS.UPDATE_INVOICE, id: invoice.id, patch: { attachment: meta } });
      toast.success('Attachment saved');
    } catch (err) {
      setAttachmentError(err?.message || 'Could not save attachment.');
    } finally {
      setAttachmentBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onViewAttachment = async () => {
    try {
      const record = await loadAttachment(invoice.id);
      if (!record) {
        setAttachmentError('Attachment file is missing on this device.');
        return;
      }
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = URL.createObjectURL(record.blob);
      window.open(blobUrlRef.current, '_blank', 'noopener,noreferrer');
    } catch {
      setAttachmentError('Could not open attachment.');
    }
  };

  const onRemoveAttachment = async () => {
    setConfirmRemoveAttachment(false);
    setAttachmentBusy(true);
    try {
      await deleteAttachment(invoice.id);
      dispatch({ type: ACTIONS.UPDATE_INVOICE, id: invoice.id, patch: { attachment: null } });
      toast.success('Attachment removed');
    } catch {
      setAttachmentError('Could not remove attachment.');
    } finally {
      setAttachmentBusy(false);
    }
  };

  return (
    <div className="page-pad">
      <DetailHeader
        backTo="/invoices"
        backLabel="Invoices"
        title={invoice.id}
        subtitle={client?.name || '—'}
        badge={
          <Badge variant={statusBadgeVariant(derivedStatus === 'paid' ? 'Paid' : derivedStatus === 'overdue' ? 'Overdue' : derivedStatus === 'void' ? 'Inactive' : 'Pending')}>
            {derivedStatus.charAt(0).toUpperCase() + derivedStatus.slice(1)}
          </Badge>
        }
        actions={
          <div className="flex-row" style={{ gap: 8 }}>
            {derivedStatus !== 'paid' && derivedStatus !== 'void' && (
              <button
                type="button"
                className="btn btn-outline btn-sm btn-suite-locked"
                aria-disabled="true"
                disabled
                title="Sending invoices via email is part of the Billing Suite add-on."
              >
                <Icon name="lock" size={12} /> Send (Billing Suite)
              </button>
            )}
            {canPay && derivedStatus !== 'paid' && derivedStatus !== 'void' && balance > 0 && (
              <button className="btn btn-primary btn-sm" onClick={markPaid}>Mark Paid</button>
            )}
            {canEdit && derivedStatus !== 'void' && (
              <button className="btn btn-primary btn-sm" onClick={voidInvoice}>Void</button>
            )}
            {canEdit && !editing && <button className="btn btn-primary btn-sm" onClick={() => { setEditing(true); setForm(invoice); }}>Edit</button>}
            {canEdit && <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>}
          </div>
        }
      />

      <div className="detail-grid">
        <div className="card detail-card">
          <h3 className="dash-card-title">Summary</h3>
          <dl className="detail-dl">
            <div><dt>Client</dt><dd>{client ? <Link className="link" to={`/clients/${client.id}`} state={nav}>{client.name}</Link> : '—'}</dd></div>
            <div><dt>Site</dt><dd>{site?.name || '—'}{site?.address ? <div className="text-muted text-sm">{site.address}</div> : null}</dd></div>
            <div>
              <dt>Billing contact</dt>
              <dd>
                {billingContact ? (
                  <>
                    <Link className="link" to={`/contacts/${billingContact.id}`} state={nav}>
                      {billingContact.firstName} {billingContact.lastName}
                    </Link>
                    {billingContact.email ? <div className="text-muted text-sm">{billingContact.email}</div> : null}
                  </>
                ) : '—'}
              </dd>
            </div>
            <div><dt>Issued</dt><dd>{fmtDateLong(invoice.issueDate)}</dd></div>
            <div><dt>Due</dt><dd>{fmtDateLong(invoice.dueDate)}</dd></div>
            <div><dt>Total</dt><dd className="money">{money(total)}</dd></div>
            <div><dt>Paid</dt><dd className="money">{money(paid)}</dd></div>
            <div><dt>Balance</dt><dd className="money">{balance > 0 ? <span className="text-danger">{money(balance)}</span> : money(0)}</dd></div>
            {(invoice.notes || editing) && (
              <div>
                <dt>Notes</dt>
                <dd>
                  {editing ? (
                    <textarea
                      className="input" rows={2}
                      value={currentForm.notes || ''}
                      onChange={(e) => setForm({ ...currentForm, notes: e.target.value })}
                      placeholder="PO #, internal reference, etc."
                    />
                  ) : (
                    <span className="invoice-notes">{invoice.notes || '—'}</span>
                  )}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="card detail-card">
          <h3 className="dash-card-title">Attachment</h3>
          {invoice.attachment ? (
            <div className="attachment-card">
              <div className="attachment-card-row">
                <Icon name="paperclip" size={16} />
                <div className="attachment-card-info">
                  <div className="attachment-card-name" title={invoice.attachment.name}>{invoice.attachment.name}</div>
                  <div className="text-muted text-xs">
                    {formatBytes(invoice.attachment.sizeBytes)} · uploaded {fmtDate(invoice.attachment.uploadedAt)}
                  </div>
                </div>
              </div>
              <div className="attachment-card-actions">
                <button type="button" className="btn btn-outline btn-sm" onClick={onViewAttachment}>View</button>
                {canEdit && (
                  <>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()} disabled={attachmentBusy}>Replace</button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmRemoveAttachment(true)} disabled={attachmentBusy}>Remove</button>
                  </>
                )}
              </div>
            </div>
          ) : (
            canEdit ? (
              <div className="attachment-empty">
                <button
                  type="button"
                  className="attachment-picker-label attachment-picker-empty"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attachmentBusy}
                >
                  <Icon name="upload" size={16} />
                  <span>{attachmentBusy ? 'Saving…' : 'Attach invoice PDF'}</span>
                </button>
                <div className="text-xs text-muted" style={{ marginTop: 6 }}>
                  PDF, PNG, JPG, or WebP. Max {Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB. Stored on this device.
                </div>
              </div>
            ) : (
              <div className="text-muted text-sm">No attachment.</div>
            )
          )}
          {attachmentError && <div className="form-error" style={{ marginTop: 8 }}>{attachmentError}</div>}
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ALLOWED_MIME.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => onPickAttachment(e.target.files?.[0] || null)}
          />
        </div>

        <div>
          <div className="section-head">
            <h3 className="dash-card-title">Line Items</h3>
            {editing && <button type="button" className="btn btn-outline btn-sm" onClick={addLineItem}>Add</button>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th style={{ width: 80 }}>Qty</th>
                  <th style={{ width: 120 }}>Unit Price</th>
                  <th style={{ width: 120 }} className="text-right">Line Total</th>
                  {editing && <th style={{ width: 40 }}></th>}
                </tr>
              </thead>
              <tbody>
                {currentForm.lineItems.length === 0 ? (
                  <tr><td colSpan={editing ? 5 : 4} style={{ textAlign: 'center', padding: 16, color: 'var(--text-muted)' }}>No line items yet.</td></tr>
                ) : currentForm.lineItems.map((li) => {
                  const lineTotal = (Number(li.qty) || 0) * (Number(li.unitPrice) || 0);
                  return (
                    <tr key={li.id}>
                      <td>
                        {editing ? (
                          <input className="input" value={li.description} onChange={(e) => updateLineItem(li.id, { description: e.target.value })} />
                        ) : li.description}
                      </td>
                      <td>
                        {editing ? (
                          <input type="number" min="0" step="0.5" className="input" value={li.qty} onChange={(e) => updateLineItem(li.id, { qty: e.target.value })} />
                        ) : li.qty}
                      </td>
                      <td className="money">
                        {editing ? (
                          <input type="number" min="0" step="0.01" className="input" value={li.unitPrice} onChange={(e) => updateLineItem(li.id, { unitPrice: e.target.value })} />
                        ) : moneyPrecise(li.unitPrice)}
                      </td>
                      <td className="money text-right">{moneyPrecise(lineTotal)}</td>
                      {editing && (
                        <td>
                          <button type="button" className="btn-icon btn-icon-danger" onClick={() => removeLineItem(li.id)} aria-label="Remove">
                            <Icon name="trash" size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={editing ? 3 : 2}></td>
                  <td className="money text-right"><strong>Total</strong></td>
                  <td className="money text-right"><strong>{money(total)}</strong></td>
                  {editing && <td></td>}
                </tr>
              </tfoot>
            </table>
          </div>

          {editing && (
            <div className="form-row" style={{ marginTop: 12 }}>
              <FormField label="Issue date" type="date" value={splitIso(currentForm.issueDate).date} onChange={(e) => setForm({ ...currentForm, issueDate: new Date(e.target.value + 'T12:00:00').toISOString() })} />
              <FormField label="Due date" type="date" value={splitIso(currentForm.dueDate).date} onChange={(e) => setForm({ ...currentForm, dueDate: new Date(e.target.value + 'T12:00:00').toISOString() })} />
              <FormField label="Tax rate (%)" type="number" value={currentForm.taxRate || 0} onChange={(e) => setForm({ ...currentForm, taxRate: e.target.value })} />
            </div>
          )}

          {editing && (
            <div className="form-group" style={{ marginTop: 8 }}>
              <label className="form-label">Billing contact</label>
              <ContactPicker
                value={currentForm.billingContactId || null}
                onChange={(id) => setForm({ ...currentForm, billingContactId: id })}
                companyId={currentForm.clientId || null}
                placeholder="Select a billing contact…"
              />
            </div>
          )}

          {editing && (
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => { setEditing(false); setForm(invoice); }}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
            </div>
          )}
        </div>

        <div>
          <div className="section-head">
            <h3 className="dash-card-title">Payments</h3>
            {canPay && derivedStatus !== 'void' && balance > 0 && !showPaymentForm && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowPaymentForm(true)}>Record Payment</button>
            )}
          </div>
          {showPaymentForm && (
            <div ref={paymentFormRef} className="card" style={{ background: 'var(--inset-bg)', marginBottom: 12 }}>
              <div className="form-row">
                <FormField label="Amount" type="number" step="0.01" min="0" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} placeholder={money(balance)} />
                <FormField label="Method" as="select" value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })}
                  options={[{ value: 'ACH', label: 'ACH' }, { value: 'Card', label: 'Card' }, { value: 'Check', label: 'Check' }, { value: 'Cash', label: 'Cash' }, { value: 'Manual', label: 'Manual' }]} />
                <FormField label="Date" type="date" value={payment.date} onChange={(e) => setPayment({ ...payment, date: e.target.value })} />
              </div>
              <FormField label="Note" value={payment.note} onChange={(e) => setPayment({ ...payment, note: e.target.value })} placeholder="Check #, ref, etc." />
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowPaymentForm(false)}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={recordPayment} disabled={!Number(payment.amount)}>Record Payment</button>
              </div>
            </div>
          )}

          {(invoice.payments || []).length === 0 ? (
            <p className="text-muted text-sm">No payments recorded.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Method</th><th>Note</th><th className="text-right">Amount</th>{canPay && <th style={{ width: 84 }}></th>}</tr></thead>
                <tbody>
                  {invoice.payments.map((p) => {
                    const isEditing = editingPaymentId === p.id;
                    if (isEditing && paymentDraft) {
                      return (
                        <tr key={p.id} className="payment-row-editing">
                          <td>
                            <input type="date" className="input" value={paymentDraft.date} onChange={(e) => setPaymentDraft({ ...paymentDraft, date: e.target.value })} />
                          </td>
                          <td>
                            <select className="input" value={paymentDraft.method} onChange={(e) => setPaymentDraft({ ...paymentDraft, method: e.target.value })}>
                              {['ACH', 'Card', 'Check', 'Cash', 'Manual'].map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </td>
                          <td>
                            <input className="input" value={paymentDraft.note} onChange={(e) => setPaymentDraft({ ...paymentDraft, note: e.target.value })} placeholder="Check #, ref, etc." />
                          </td>
                          <td className="money text-right">
                            <input type="number" min="0" step="0.01" className="input" value={paymentDraft.amount} onChange={(e) => setPaymentDraft({ ...paymentDraft, amount: e.target.value })} />
                          </td>
                          {canPay && (
                            <td>
                              <div className="flex-row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                                <button type="button" className="btn-icon" aria-label="Save" onClick={saveEditPayment} disabled={!Number(paymentDraft.amount)} title="Save">
                                  <Icon name="check" size={14} />
                                </button>
                                <button type="button" className="btn-icon" aria-label="Cancel" onClick={cancelEditPayment} title="Cancel">
                                  <Icon name="x" size={14} />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    }
                    return (
                      <tr key={p.id}>
                        <td>{fmtDate(p.date)}</td>
                        <td>{p.method || '—'}</td>
                        <td className="text-muted text-sm">{p.note || '—'}</td>
                        <td className="money text-right">{moneyPrecise(p.amount)}</td>
                        {canPay && (
                          <td>
                            <div className="flex-row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                              <button type="button" className="btn-icon" aria-label="Edit" onClick={() => startEditPayment(p)} title="Edit">
                                <Icon name="edit" size={14} />
                              </button>
                              <button type="button" className="btn-icon btn-icon-danger" aria-label="Remove" onClick={() => removePayment(p.id)} title="Remove">
                                <Icon name="trash" size={14} />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this invoice?"
        message="This can't be undone. Payments recorded against it are also removed."
        confirmLabel="Delete Invoice"
        variant="danger"
        onConfirm={del}
        onClose={() => setConfirmDelete(false)}
      />
      <ConfirmDialog
        open={confirmRemoveAttachment}
        title="Remove attachment?"
        message="The PDF will be deleted from this device."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={onRemoveAttachment}
        onClose={() => setConfirmRemoveAttachment(false)}
      />
    </div>
  );
}
