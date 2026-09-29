import { useEffect, useState } from 'react';
import Modal from './Modal';
import ContactPicker from './ContactPicker';
import { useStore } from '../store';
import { selectContacts, selectClientById, selectServiceById, billingUnitShort } from '../store/selectors';
import { useToast } from './Toast';
import { money } from '../lib/dates';
import { createQuote, saveQuote } from '../lib/quotesApi';
import { IDENTITY } from '../brand/identity.generated.js';

// The quote proposal has no structured line items — pricing is the free-text
// `fee` field. Pre-fill it from the account's catalog service (name + default
// rate + billing unit) so the rep isn't retyping the standard rate. Returns
// null when there's no priced service to seed from (leave the template default).
function catalogFee(state, client) {
  const svc = client?.serviceId ? selectServiceById(state, client.serviceId) : null;
  const price = Number(svc?.defaultPrice) || 0;
  if (!svc || price <= 0) return null;
  return `${money(price)} ${billingUnitShort(svc.billingUnit)}. ${svc.name}`;
}

function contactName(c) {
  if (!c) return '';
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

export default function CreateQuoteModal({ open, onClose, onCreated }) {
  const state = useStore();
  const toast = useToast();
  const contacts = selectContacts(state);

  const [contactId, setContactId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setContactId(''); setBusy(false); } }, [open]);

  async function submit() {
    const contact = contacts.find((c) => c.id === contactId) || null;
    if (!contact) { toast.error('Pick a contact'); return; }
    const client = contact.companyId ? selectClientById(state, contact.companyId) : null;
    setBusy(true);
    try {
      let quote = await createQuote({
        contact: {
          id: contact.id,
          name: contactName(contact),
          email: contact.email || null,
          phone: contact.phone || null,
          company: client?.name || contact.company || '',
        },
        templateKey: 'cleanspace_quote_v1',
      });
      // Best-effort catalog pre-fill of the fee field. Non-blocking: if the save
      // fails the quote still exists with the template default, editable on the
      // next screen.
      const fee = catalogFee(state, client);
      if (fee && quote?.id) {
        try { quote = await saveQuote(quote.id, { fee }); } catch { /* keep default fee */ }
      }
      onClose();
      onCreated?.(quote);
    } catch (e) {
      toast.error(e.message || 'Could not create quote');
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New quote">
      <div className="form-group">
        <label className="form-label">Contact / prospect</label>
        <ContactPicker value={contactId} onChange={setContactId} placeholder="Search contacts…" />
        <div className="form-help">Their name and company auto-fill into the quote.</div>
      </div>
      <div className="form-group">
        <label className="form-label">Template</label>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
          <div style={{ fontWeight: 600 }}>{IDENTITY.name} Quote</div>
          <span className="badge slate">10-page proposal + agreement</span>
        </div>
        <div className="form-help">You'll edit the details, sign, and send on the next screen.</div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create quote'}
        </button>
      </div>
    </Modal>
  );
}
