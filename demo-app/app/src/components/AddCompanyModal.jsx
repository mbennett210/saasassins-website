import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import TagPicker from './TagPicker';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClients, selectContactByEmail } from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { normalizeCompanyName } from '../lib/csv';
import { US_STATE_OPTIONS } from '../lib/usStates';
import { IDENTITY } from '../brand/identity.generated.js';

// Add Contact (company-first). In the unified model a Contact IS a company, so the
// hub's "Add Contact" creates a COMPANY and, optionally, its primary contact person
// in one submit. Type (Customer / Vendor) is the ONE manual flag; Status (Lead /
// Active) is derived from real work, so it's never asked here. Adding more people
// happens later on the company's page. (The person-level add/edit is AddContactModal.)
const EMPTY = {
  name: '', type: 'customer',
  street: '', city: '', state: 'FL', zip: '',
  tagIds: [],
  firstName: '', lastName: '', title: '', email: '', phone: '',
};

export default function AddCompanyModal({ open, onClose, onCreated = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const clients = selectClients(state);

  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setError('');
  }, [open]);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = (e) => {
    e.preventDefault();
    setError('');

    const name = form.name.trim();
    if (!name) { setError('Company name is required.'); return; }
    // Dedup against existing accounts (normalized, ignoring legal suffixes) so a
    // second "Acme LLC" doesn't spawn a duplicate of "Acme".
    const target = normalizeCompanyName(name);
    const dupCompany = clients.find((c) => normalizeCompanyName(c.name) === target);
    if (dupCompany) { setError(`A company named "${dupCompany.name}" already exists.`); return; }

    // Primary contact is OPTIONAL. When given, email (if any) must be well-formed
    // and unique, matching the person model + CSV importer.
    const email = form.email.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email for the primary contact, or leave it blank.');
      return;
    }
    if (email) {
      const dup = selectContactByEmail(state, email);
      if (dup) { setError(`Email already in use by ${dup.firstName} ${dup.lastName}.`); return; }
    }

    // Create the company first (Contact # is allocated by the reducer), then its
    // primary person with companyId set — the reducer wires it as primaryContactId.
    const clientId = newId('cl');
    dispatch({
      type: ACTIONS.ADD_CLIENT,
      client: {
        id: clientId,
        name,
        type: form.type,
        street: form.street.trim(),
        city: form.city.trim(),
        state: form.state,
        zip: form.zip.trim(),
        tagIds: form.tagIds,
      },
    });

    const hasPerson = form.firstName.trim() || form.lastName.trim();
    if (hasPerson) {
      dispatch({
        type: ACTIONS.ADD_CONTACT,
        contact: {
          id: newId('ct'),
          companyId: clientId,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          title: form.title.trim(),
          email,
          phone: form.phone.trim(),
        },
      });
    }

    toast.success(`Contact added · ${name}`);
    onCreated?.(clientId);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Contact" size="lg">
      <form onSubmit={submit} noValidate>
        {error && <div className="form-error" style={{ marginBottom: 'var(--space-3)' }}>{error}</div>}

        <div className="acm-cols">
          {/* Company */}
          <div>
            <p className="acm-col-title">Company</p>
            <FormField
              label="Company name"
              required
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Bayshore Senior Living"
            />
            <FormField
              label="Type"
              help={form.type === 'vendor'
                ? 'A supplier you buy from. Stays in your Customers list but is kept out of the Pipeline, Marketing, and lead counts.'
                : undefined}
            >
              <div className="acm-type">
                <button
                  type="button"
                  className={`btn btn-sm ${form.type === 'customer' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => set({ type: 'customer' })}
                  aria-pressed={form.type === 'customer'}
                >
                  Customer
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${form.type === 'vendor' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => set({ type: 'vendor' })}
                  aria-pressed={form.type === 'vendor'}
                >
                  Vendor
                </button>
              </div>
            </FormField>
            <FormField
              label="Street address"
              value={form.street}
              onChange={(e) => set({ street: e.target.value })}
              placeholder="123 Main St, Suite 200"
            />
            <FormField
              label="City"
              value={form.city}
              onChange={(e) => set({ city: e.target.value })}
              placeholder={IDENTITY.company.locality}
            />
            <div className="form-row">
              <FormField
                label="State"
                as="select"
                value={form.state}
                onChange={(e) => set({ state: e.target.value })}
                options={US_STATE_OPTIONS}
              />
              <FormField
                label="ZIP"
                value={form.zip}
                onChange={(e) => set({ zip: e.target.value })}
                placeholder={IDENTITY.company.postalCode}
              />
            </div>
          </div>

          {/* Primary contact */}
          <div>
            <p className="acm-col-title">Primary contact</p>
            <div className="form-row">
              <FormField label="First name" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} />
              <FormField label="Last name" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
            </div>
            <FormField
              label="Title"
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Office Manager, Facilities Director…"
            />
            <FormField
              label="Email"
              type="email"
              value={form.email}
              onChange={(e) => set({ email: e.target.value })}
              placeholder="name@company.com"
              help="Optional. When set, it's the contact's unique identifier."
            />
            <FormField
              label="Phone"
              value={form.phone}
              onChange={(e) => set({ phone: e.target.value })}
              placeholder={`(${IDENTITY.company.areaCode}) 555-0100`}
            />
          </div>
        </div>

        <div className="form-group" style={{ marginTop: 'var(--space-3)' }}>
          <label className="form-label">Tags</label>
          <TagPicker value={form.tagIds} onChange={(ids) => set({ tagIds: ids })} />
          <div className="form-help">Tags apply to the company, shared by everyone there.</div>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Add Contact</button>
        </div>
      </form>
    </Modal>
  );
}
