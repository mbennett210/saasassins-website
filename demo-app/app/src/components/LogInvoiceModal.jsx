import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import ContactPicker from './ContactPicker';
import Icon from './Icon';
import ServicePicker from './ServicePicker';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectActiveClients, selectClientById, selectSitesForClient, nextInvoiceId,
  selectServiceById, lineItemFromService,
} from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { todayKey, addDaysKey, composeIso } from '../lib/dates';
import {
  saveAttachment,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_ALLOWED_MIME,
  formatBytes,
} from '../lib/attachments';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';

const newLine = () => ({ id: newId('li'), description: '', qty: 1, unitPrice: 0 });

function buildInitialForm({ presetClientId, presetSiteId, presetClient, defaultTaxRate, presetService }) {
  // A preset service (job → invoice flow) seeds a catalog-priced line and opens
  // the line-item detail view so the total is derived, not hand-typed.
  const seededLines = presetService
    ? [{ id: newId('li'), ...lineItemFromService(presetService) }]
    : [newLine()];
  return {
    clientId: presetClientId || '',
    siteId: presetSiteId || '',
    billingContactId: presetClient?.primaryContactId || null,
    issueDate: todayKey(),
    dueDate: addDaysKey(todayKey(), 30),
    totalAmount: '',
    notes: '',
    showDetail: !!presetService,
    taxRate: defaultTaxRate || 0,
    lineItems: seededLines,
  };
}

export default function LogInvoiceModal({ open, onClose, presetClientId = null, presetSiteId = null, presetJobId = null, presetServiceId = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const clients = selectActiveClients(state);

  const presetClient = presetClientId ? selectClientById(state, presetClientId) : null;
  const presetService = presetServiceId ? selectServiceById(state, presetServiceId) : null;
  const defaultTaxRate = state.company.taxRate || 0;

  const [form, setForm] = useState(() => buildInitialForm({ presetClientId, presetSiteId, presetClient, defaultTaxRate, presetService }));
  const [pendingFile, setPendingFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const linesPager = usePagedRows(form.lineItems);

  useEffect(() => {
    if (!open) return;
    const seededClient = presetClientId ? selectClientById(state, presetClientId) : null;
    const seededService = presetServiceId ? selectServiceById(state, presetServiceId) : null;
    setForm(buildInitialForm({ presetClientId, presetSiteId, presetClient: seededClient, defaultTaxRate, presetService: seededService }));
    setPendingFile(null);
    setFileError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetClientId, presetSiteId, presetServiceId]);

  const onClientChange = (clientId) => {
    const picked = clientId ? selectClientById(state, clientId) : null;
    // Every customer has exactly one location; default the invoice to it.
    const loc = clientId ? selectSitesForClient(state, clientId)[0] : null;
    setForm({
      ...form,
      clientId,
      siteId: loc?.id || '',
      billingContactId: picked?.primaryContactId || null,
    });
  };

  const updateLine = (id, patch) => setForm({
    ...form,
    lineItems: form.lineItems.map((li) => (li.id === id ? { ...li, ...patch } : li)),
  });
  const addLine = () => { setForm({ ...form, lineItems: [...form.lineItems, newLine()] }); linesPager.goToLast(); };
  const removeLine = (id) => setForm({ ...form, lineItems: form.lineItems.filter((li) => li.id !== id) });

  // Pre-fill a line item from the services catalog (description + default rate).
  // Replaces a single blank starter row rather than stacking an empty line.
  const addLineFromService = (serviceId) => {
    const svc = serviceId ? selectServiceById(state, serviceId) : null;
    if (!svc) return;
    const line = { id: newId('li'), ...lineItemFromService(svc) };
    setForm((f) => {
      const items = f.lineItems.filter((li) => li.description.trim() || Number(li.unitPrice) > 0);
      return { ...f, showDetail: true, lineItems: [...items, line] };
    });
    linesPager.goToLast();
  };

  // 🔴 PREVIEW THE SAVED SET, NOT THE TYPED SET. save() drops any line with a blank
  // description (`.filter((li) => li.description.trim())`) but this total summed every
  // row — so a line with a price and no description was included in the figure the user
  // read and then silently excluded from the invoice that was stored. The user agreed to
  // one number and got another, at creation time, with nothing indicating why.
  //
  // Same predicate as save(), deliberately duplicated rather than approximated: if the
  // two ever diverge again the displayed total stops meaning anything.
  const savedLineItems = form.lineItems.filter((li) => li.description.trim());
  const subtotal = savedLineItems.reduce((a, li) => a + (Number(li.qty) || 0) * (Number(li.unitPrice) || 0), 0);
  const taxAmount = subtotal * ((Number(form.taxRate) || 0) / 100);
  const detailTotal = subtotal + taxAmount;
  const effectiveTotal = form.showDetail ? detailTotal : (Number(form.totalAmount) || 0);

  const onPickFile = (file) => {
    setFileError(null);
    if (!file) {
      setPendingFile(null);
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setFileError(`File too large (max ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB).`);
      return;
    }
    if (file.type && !ATTACHMENT_ALLOWED_MIME.includes(file.type)) {
      setFileError('File type not supported. Use PDF or PNG/JPG/WebP.');
      return;
    }
    setPendingFile(file);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.clientId) return;
    if (effectiveTotal <= 0) return;

    let lineItems;
    let taxRate;
    if (form.showDetail) {
      const cleanItems = form.lineItems
        .filter((li) => li.description.trim())
        .map((li) => ({ ...li, qty: Number(li.qty) || 0, unitPrice: Number(li.unitPrice) || 0 }));
      if (cleanItems.length === 0) return;
      lineItems = cleanItems;
      taxRate = Number(form.taxRate) || 0;
    } else {
      // Amount-first path: synthesize a single line item that stores the typed total.
      // This keeps the data shape uniform (totals/balance selectors keep working) and
      // a future Billing Suite migration can split it back into proper line items.
      lineItems = [{
        id: newId('li'),
        description: 'Invoice total',
        qty: 1,
        unitPrice: Number(form.totalAmount) || 0,
      }];
      taxRate = 0;
    }

    const invoiceId = nextInvoiceId(state);
    let attachmentMeta = null;
    if (pendingFile) {
      try {
        attachmentMeta = await saveAttachment(invoiceId, pendingFile);
      } catch (err) {
        setFileError(err?.message || 'Could not save attachment.');
        return;
      }
    }

    dispatch({
      type: ACTIONS.ADD_INVOICE,
      invoice: {
        id: invoiceId,
        clientId: form.clientId,
        siteId: form.siteId || null,
        billingContactId: form.billingContactId || null,
        jobIds: presetJobId ? [presetJobId] : [],
        issueDate: composeIso(form.issueDate, '12:00'),
        dueDate: composeIso(form.dueDate, '12:00'),
        lineItems,
        taxRate,
        status: 'pending',
        payments: [],
        notes: form.notes.trim(),
        attachment: attachmentMeta,
      },
    });
    toast.success('Invoice logged');
    onClose();
  };

  const accept = ATTACHMENT_ALLOWED_MIME.join(',');
  const submitDisabled = !form.clientId || effectiveTotal <= 0;

  return (
    <Modal open={open} onClose={onClose} title="Add Invoice">
      <form onSubmit={submit}>
        <div className="form-row">
          <FormField
            label="Client" as="select" required value={form.clientId}
            onChange={(e) => onClientChange(e.target.value)}
            options={[{ value: '', label: 'Select a client' }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Billing contact</label>
          <ContactPicker
            value={form.billingContactId}
            onChange={(id) => setForm({ ...form, billingContactId: id })}
            companyId={form.clientId || null}
            placeholder="Select a billing contact…"
          />
          <div className="text-xs text-muted" style={{ marginTop: 4 }}>
            Optional. Defaults to the client's primary contact.
          </div>
        </div>

        <div className="form-row">
          <FormField label="Issue date" type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} />
          <FormField label="Due date" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          {!form.showDetail && (
            <FormField
              label="Total amount" type="number" step="0.01" min="0" required
              value={form.totalAmount}
              onChange={(e) => setForm({ ...form, totalAmount: e.target.value })}
              placeholder="0.00"
            />
          )}
        </div>

        <div className="form-group">
          <label className="form-label">Notes</label>
          <textarea
            className="input" rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Optional. PO #, internal reference, etc."
          />
        </div>

        <div className="form-group">
          <label className="form-label">Attach invoice PDF</label>
          <div className="attachment-dropzone">
            {pendingFile ? (
              <div className="attachment-pending">
                <Icon name="paperclip" size={16} />
                <span className="attachment-pending-name">{pendingFile.name}</span>
                <span className="text-muted text-sm">{formatBytes(pendingFile.size)}</span>
                <button type="button" className="btn-icon btn-icon-danger" aria-label="Remove file" onClick={() => setPendingFile(null)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ) : (
              <label className="btn btn-secondary">
                <Icon name="upload" size={16} />
                <span>Choose PDF or image</span>
                <input
                  type="file"
                  accept={accept}
                  onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                  style={{ display: 'none' }}
                />
              </label>
            )}
          </div>
          {fileError && <div className="form-error" style={{ marginTop: 6 }}>{fileError}</div>}
          <div className="text-xs text-muted" style={{ marginTop: 4 }}>
            Optional. PDF, PNG, JPG, or WebP. Max {Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB. Stored locally on this device.
          </div>
        </div>

        <button
          type="button"
          className="btn btn-link log-invoice-detail-toggle"
          onClick={() => setForm({ ...form, showDetail: !form.showDetail })}
          aria-expanded={form.showDetail}
        >
          <Icon name={form.showDetail ? 'chevronUp' : 'chevronDown'} size={12} />
          {form.showDetail ? 'Hide line-item detail' : 'Add line-item detail'}
        </button>

        {form.showDetail && (
          <div className="disclosure-body">
            <div className="form-group">
              <label className="form-label">Line items</label>
              <div className="catalog-prefill-row">
                <span className="text-sm text-muted">Pre-fill from catalog</span>
                <div className="catalog-prefill-picker">
                  <ServicePicker value={null} onChange={addLineFromService} placeholder="Pick a service…" />
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th style={{ width: 70 }}>Qty</th>
                      <th style={{ width: 110 }}>Unit Price</th>
                      <th style={{ width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {linesPager.pageRows.map((li) => (
                      <tr key={li.id}>
                        <td><input className="input" placeholder="e.g., Weekly janitorial" value={li.description} onChange={(e) => updateLine(li.id, { description: e.target.value })} /></td>
                        <td><input type="number" min="0" step="0.5" className="input" value={li.qty} onChange={(e) => updateLine(li.id, { qty: e.target.value })} /></td>
                        <td><input type="number" min="0" step="0.01" className="input" value={li.unitPrice} onChange={(e) => updateLine(li.id, { unitPrice: e.target.value })} /></td>
                        <td>
                          {form.lineItems.length > 1 && (
                            <button type="button" className="btn-icon btn-icon-danger" aria-label="Remove" onClick={() => removeLine(li.id)}>×</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ListPager pager={linesPager} noun="lines" />
              </div>
              <button type="button" className="btn btn-outline" onClick={addLine} style={{ marginTop: 8 }}>Add line</button>
            </div>

            <FormField
              label="Tax rate (%)" type="number" step="0.01" min="0"
              value={form.taxRate}
              onChange={(e) => setForm({ ...form, taxRate: e.target.value })}
            />

            <div className="invoice-totals">
              <div><span className="text-muted">Subtotal</span><span className="money">${subtotal.toFixed(2)}</span></div>
              {Number(form.taxRate) > 0 && (
                <div><span className="text-muted">Tax ({form.taxRate}%)</span><span className="money">${taxAmount.toFixed(2)}</span></div>
              )}
              <div><strong>Total</strong><strong className="money">${detailTotal.toFixed(2)}</strong></div>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={submitDisabled}>Add Invoice</button>
        </div>
      </form>
    </Modal>
  );
}
