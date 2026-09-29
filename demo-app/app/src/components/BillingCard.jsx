import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { useToast } from './Toast';
import { ACTIONS } from '../store/reducer';
import { selectContactById } from '../store/selectors';
import ContactPicker from './ContactPicker';
import { composeAddress } from '../lib/address';

// Customer-level billing settings, shown on the client Overview. Read-first: an
// "Edit" button flips the card into the form, then Save/Cancel commit (the shared
// convention — UI_RULES §101). Saves via UPDATE_CLIENT (billing is NOT a CLIENT_OPS
// field, so it fires no ops notification). "Same as location" mirrors the customer's
// single location address instead of storing a separate remit-to address.
const PAYMENT_TERMS = [
  { value: 'due-on-receipt', label: 'Due on receipt' },
  { value: 'net15', label: 'Net 15' },
  { value: 'net30', label: 'Net 30' },
  { value: 'net45', label: 'Net 45' },
  { value: 'net60', label: 'Net 60' },
];
const termLabel = (v) => PAYMENT_TERMS.find((t) => t.value === v)?.label || 'Net 30';

export default function BillingCard({ client, location, canEdit }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  const initial = useMemo(() => ({
    billingContactId: client.billingContactId || null,
    billingEmail: client.billingEmail || '',
    billingSameAsLocation: client.billingSameAsLocation !== false,
    billingStreet: client.billingStreet || '',
    billingCity: client.billingCity || '',
    billingState: client.billingState || '',
    billingZip: client.billingZip || '',
    paymentTerms: client.paymentTerms || 'net30',
    poRequired: !!client.poRequired,
    poNumber: client.poNumber || '',
    taxExempt: !!client.taxExempt,
    taxRateOverride: client.taxRateOverride == null ? '' : String(client.taxRateOverride),
  }), [client]);
  const [form, setForm] = useState(initial);
  useEffect(() => { setForm(initial); }, [client.id, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const locationAddress = location ? (location.address || composeAddress(location)) : '';
  const billingContact = client.billingContactId ? selectContactById(state, client.billingContactId) : null;
  const savedBillingAddress = client.billingSameAsLocation !== false
    ? locationAddress
    : composeAddress({ street: client.billingStreet, city: client.billingCity, state: client.billingState, zip: client.billingZip });

  const save = () => {
    const parsedRate = form.taxRateOverride.trim() === '' ? null : Number(form.taxRateOverride);
    dispatch({
      type: ACTIONS.UPDATE_CLIENT,
      id: client.id,
      patch: {
        billingContactId: form.billingContactId || null,
        billingEmail: form.billingEmail.trim() || null,
        billingSameAsLocation: form.billingSameAsLocation,
        billingStreet: form.billingSameAsLocation ? '' : form.billingStreet.trim(),
        billingCity: form.billingSameAsLocation ? '' : form.billingCity.trim(),
        billingState: form.billingSameAsLocation ? '' : form.billingState.trim(),
        billingZip: form.billingSameAsLocation ? '' : form.billingZip.trim(),
        paymentTerms: form.paymentTerms,
        poRequired: form.poRequired,
        poNumber: form.poNumber.trim(),
        taxExempt: form.taxExempt,
        taxRateOverride: form.taxExempt ? null : (Number.isFinite(parsedRate) ? parsedRate : null),
      },
    });
    toast.success('Billing information updated');
    setEditing(false);
  };
  const cancel = () => { setForm(initial); setEditing(false); };

  return (
    <div className="card detail-card">
      <div className="overview-card-head">
        <h3>Billing information</h3>
        {canEdit && !editing && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>

      {!editing ? (
        <dl className="detail-dl">
          <div><dt>Billing contact</dt><dd>{billingContact ? `${billingContact.firstName} ${billingContact.lastName}` : '—'}</dd></div>
          <div><dt>Billing email</dt><dd>{client.billingEmail || '—'}</dd></div>
          <div><dt>Payment terms</dt><dd>{termLabel(client.paymentTerms)}</dd></div>
          <div><dt>PO number</dt><dd>{client.poNumber || '—'}{client.poRequired && <span className="text-muted"> · required on invoices</span>}</dd></div>
          <div><dt>Billing address</dt><dd>{savedBillingAddress || '—'}{client.billingSameAsLocation !== false && <span className="text-muted"> · same as location</span>}</dd></div>
          <div><dt>Tax treatment</dt><dd>{client.taxExempt ? 'Tax exempt' : (client.taxRateOverride != null ? `${client.taxRateOverride}%` : 'Default rate')}</dd></div>
        </dl>
      ) : (
        <>
        <div className="inline-edit-grid">
          <label className="inline-edit-label">Billing contact</label>
          <div className="inline-edit-value">
            <ContactPicker value={form.billingContactId} companyId={client.id} onChange={(id) => set({ billingContactId: id })} />
          </div>

          <label className="inline-edit-label" htmlFor="bill-email">Billing email</label>
          <div className="inline-edit-value">
            <input id="bill-email" type="email" className="input" value={form.billingEmail} onChange={(e) => set({ billingEmail: e.target.value })} placeholder="Where invoices are sent" disabled={!canEdit} />
          </div>

          <label className="inline-edit-label" htmlFor="bill-terms">Payment terms</label>
          <div className="inline-edit-value">
            <select id="bill-terms" className="input" value={form.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} disabled={!canEdit}>
              {PAYMENT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <label className="inline-edit-label" htmlFor="bill-po">PO number</label>
          <div className="inline-edit-value">
            <input id="bill-po" className="input" value={form.poNumber} onChange={(e) => set({ poNumber: e.target.value })} placeholder="Optional" disabled={!canEdit} />
            <label className="text-xs billing-check billing-mt">
              <input type="checkbox" checked={form.poRequired} onChange={(e) => set({ poRequired: e.target.checked })} disabled={!canEdit} />
              PO required on invoices
            </label>
          </div>

          <label className="inline-edit-label">Billing address</label>
          <div className="inline-edit-value">
            <label className="text-xs billing-check">
              <input type="checkbox" checked={form.billingSameAsLocation} onChange={(e) => set({ billingSameAsLocation: e.target.checked })} disabled={!canEdit} />
              Same as location
            </label>
            {form.billingSameAsLocation ? (
              <div className="text-xs text-muted billing-hint">{locationAddress || 'No location address on file.'}</div>
            ) : (
              <div className="billing-addr">
                <input className="input" placeholder="Street" value={form.billingStreet} onChange={(e) => set({ billingStreet: e.target.value })} disabled={!canEdit} />
                <div className="billing-addr-csz">
                  <input className="input" placeholder="City" value={form.billingCity} onChange={(e) => set({ billingCity: e.target.value })} disabled={!canEdit} />
                  <input className="input" placeholder="State" value={form.billingState} onChange={(e) => set({ billingState: e.target.value })} disabled={!canEdit} />
                  <input className="input" placeholder="ZIP" value={form.billingZip} onChange={(e) => set({ billingZip: e.target.value })} disabled={!canEdit} />
                </div>
              </div>
            )}
          </div>

          <label className="inline-edit-label">Tax treatment</label>
          <div className="inline-edit-value">
            <label className="text-xs billing-check">
              <input type="checkbox" checked={form.taxExempt} onChange={(e) => set({ taxExempt: e.target.checked })} disabled={!canEdit} />
              Tax exempt
            </label>
            {!form.taxExempt && (
              <input className="input billing-mt" inputMode="decimal" placeholder="Tax rate % (blank = default)" value={form.taxRateOverride} onChange={(e) => set({ taxRateOverride: e.target.value })} disabled={!canEdit} />
            )}
          </div>
        </div>
        {canEdit && (
          <div className="inline-edit-savebar">
            <span className="save-hint">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
            <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
          </div>
        )}
        </>
      )}
    </div>
  );
}
