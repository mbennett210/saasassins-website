import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import TagPicker from './TagPicker';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClients, selectContactByEmail, selectCurrentUser } from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { normalizeCompanyName } from '../lib/csv';
import { US_STATE_OPTIONS } from '../lib/usStates';
import { composeAddress } from '../lib/address';
import { clientLocationId, clientGetsLocation } from '../lib/location';
import { geocodeAddress } from '../lib/geoApi';
import { GEOCODE_STATUS, resolveGeocode } from '../lib/geocodeLocation';
import { IDENTITY } from '../brand/identity.generated.js';
import { nextCustomerNumber, customerNumberProblem, normalizeCustomerNumber } from '../lib/customerNumber';
import { useT } from '../i18n/react';
import { usePermission } from '../hooks/usePermission';
import { newOnboarding, missingCompanyFields, FIELD_KEY } from '../lib/onboarding';

// Add customer (company-first). The Customers page's "Add Customer" creates a COMPANY and,
// optionally, its primary contact person in one submit, and STARTS ITS ONBOARDING (task 471,
// UI_RULES §190): the customer's page then shows the onboarding bar, which walks the office through
// the rest of Matt's list (schedule, cleaners, supplies, documents and contracts) and reads
// "Onboarding" until every step is green. The pop-up is the bar's Company step, which can't be
// skipped, so the company name, customer number and the whole address are required here. Matt's
// email "clean corner" (2026-11-03): "You can remove the Customer/Vendor selection since this
// section will only be used for customers." Every customer added here is a customer; a vendor is
// still made from a customer page's status menu or the Customers import. Status (Lead / Active)
// is derived from real work, so it's never asked here. Adding more people happens later on the
// company's page. (The person-level add/edit is AddContactModal; a spreadsheet of buildings is
// Import customers, CsvImportModal.)
// The Customers page opens this for a "Create / edit customers" holder; the person half needs
// "Create / edit contacts" too — the server checks both keys (orgStateGuard), so without the
// second the form adds the customer alone and says why (UI_RULES §118).
const EMPTY = {
  name: '', customerNumber: '',
  street: '', city: '', state: 'FL', zip: '',
  tagIds: [],
  firstName: '', lastName: '', title: '', email: '', phone: '',
};

export default function AddCompanyModal({ open, onClose, onCreated = null }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const clients = selectClients(state);
  const canAddPerson = usePermission('contacts.edit');
  const currentUser = selectCurrentUser(state);

  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  // GO-2 / CS-068: a new customer is OFFERED the next number (the highest in use + 1). Kept as
  // offered, the reducer moves it on if another office took it meanwhile; typed, it is refused.
  const [offered, setOffered] = useState('');

  useEffect(() => {
    if (!open) return;
    const next = nextCustomerNumber(clients) || '';
    setOffered(next);
    setForm({ ...EMPTY, customerNumber: next });
    setError('');
    // Offer the number once per opening — never re-offer under the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = (e) => {
    e.preventDefault();
    setError('');

    const name = form.name.trim();
    if (!name) { setError('Company name is required.'); return; }
    // The onboarding's Company step (lib/onboarding COMPANY_FIELDS): every field, never skipped.
    const missing = missingCompanyFields({ ...form, name }).filter((k) => k !== 'name');
    if (missing.length) { setError(t('onboarding.add.missing', { fields: missing.map((k) => t(FIELD_KEY[k])) })); return; }
    // Dedup against existing accounts (normalized, ignoring legal suffixes) so a
    // second "Acme LLC" doesn't spawn a duplicate of "Acme".
    const target = normalizeCompanyName(name);
    const dupCompany = clients.find((c) => normalizeCompanyName(c.name) === target);
    if (dupCompany) { setError(`A company named "${dupCompany.name}" already exists.`); return; }

    // Primary contact is OPTIONAL (and only offered with contacts.edit). When given, email (if
    // any) must be well-formed and unique, matching the person model + the Customers import.
    const email = canAddPerson ? form.email.trim().toLowerCase() : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email for the primary contact, or leave it blank.');
      return;
    }
    if (email) {
      const dup = selectContactByEmail(state, email);
      if (dup) { setError(`Email already in use by ${dup.firstName} ${dup.lastName}.`); return; }
    }

    // The customer number: four digits and nobody else's.
    const problem = customerNumberProblem(clients, form.customerNumber);
    if (problem) {
      setError(problem.code === 'taken'
        ? t('custNumber.taken', { number: problem.number, customer: problem.holder.name || problem.number })
        : t('custNumber.invalid'));
      return;
    }
    const customerNumber = normalizeCustomerNumber(form.customerNumber);

    // Create the company first (its number is checked again by the reducer's one rule), then its
    // primary person with companyId set — the reducer wires it as primaryContactId.
    const clientId = newId('cl');
    dispatch({
      type: ACTIONS.ADD_CLIENT,
      client: {
        id: clientId,
        name,
        type: 'customer',
        customerNumber,
        street: form.street.trim(),
        city: form.city.trim(),
        state: form.state,
        zip: form.zip.trim(),
        tagIds: form.tagIds,
        onboarding: newOnboarding({ at: new Date().toISOString(), by: currentUser?.id || null }),
      },
      // The office kept the offered next number: on a race it moves on rather than vanishing.
      customerNumberAuto: !!customerNumber && customerNumber === offered,
    });

    const hasPerson = canAddPerson && (form.firstName.trim() || form.lastName.trim());
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

    // Locate the new customer's clock-in area from the address it was just created with
    // (CS-042). ADD_CLIENT mints the location at the deterministic clientLocationId, so
    // this patches THAT record through the same rule LocationCard's Save uses — one
    // lookup, fired once per create, never per keystroke. Deliberately NOT awaited: the
    // modal closes straight away and the result lands when it lands; until then the
    // Location card shows "Address not located" rather than the old lie, "locating from
    // the address", which no code path was ever doing.
    const address = composeAddress({ street: form.street, city: form.city, state: form.state, zip: form.zip });
    if (address && clientGetsLocation({ type: 'customer' })) {
      resolveGeocode({ address, previous: {}, geocode: geocodeAddress })
        .then((patch) => {
          dispatch({ type: ACTIONS.UPDATE_SITE, id: clientLocationId(clientId), patch });
          if (patch.geocodeStatus === GEOCODE_STATUS.NOT_LOCATED) {
            toast.error(`${name}: we couldn’t find that address on the map, so the clock-in area isn’t set. Check it on the account’s Access tab.`);
          }
        })
        .catch(() => { /* resolveGeocode already turns every failure into a status */ });
    }

    toast.success(`Customer added · ${name}`);
    onCreated?.(clientId);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add customer" size="lg">
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
              label={t('custNumber.label')}
              required
              value={form.customerNumber}
              onChange={(e) => set({ customerNumber: e.target.value })}
              placeholder="0001"
              inputMode="numeric"
              maxLength={4}
              help={t('custNumber.offered')}
            />
            <FormField
              label="Street address"
              required
              value={form.street}
              onChange={(e) => set({ street: e.target.value })}
              placeholder="123 Main St, Suite 200"
            />
            <FormField
              label="City"
              required
              value={form.city}
              onChange={(e) => set({ city: e.target.value })}
              placeholder={IDENTITY.company.locality}
            />
            <div className="form-row">
              <FormField
                label="State"
                required
                as="select"
                value={form.state}
                onChange={(e) => set({ state: e.target.value })}
                options={US_STATE_OPTIONS}
              />
              <FormField
                label="ZIP"
                required
                value={form.zip}
                onChange={(e) => set({ zip: e.target.value })}
                placeholder={IDENTITY.company.postalCode}
              />
            </div>
          </div>

          {/* Primary contact — only for a "Create / edit contacts" holder (the server's rule). */}
          {!canAddPerson ? (
            <div>
              <p className="acm-col-title">Primary contact</p>
              <p className="form-help">Adding a contact needs “Create / edit contacts”. Someone who has it can add one from the customer’s Contacts tab.</p>
            </div>
          ) : (
          <div>
            <p className="acm-col-title">Primary contact</p>
            <p className="form-help acm-col-help">{t('onboarding.add.contactHelp')}</p>
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
          )}
        </div>

        <div className="form-group" style={{ marginTop: 'var(--space-3)' }}>
          <label className="form-label">Tags</label>
          <TagPicker value={form.tagIds} onChange={(ids) => set({ tagIds: ids })} />
          <div className="form-help">Tags apply to the company, shared by everyone there.</div>
        </div>

        <p className="form-help acm-onb-note">{t('onboarding.add.next')}</p>

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Add customer</button>
        </div>
      </form>
    </Modal>
  );
}
