import { useEffect, useMemo, useRef, useState } from 'react';
import { useDismissTap } from '../hooks/useDismissTap';
import Modal from './Modal';
import FormField from './FormField';
import Toggle from './Toggle';
import Badge from './Badge';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClients, selectContactByEmail, selectContactById, selectMarketingSuppressionForEmail } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { fmtDate } from '../lib/dates';
import { normalizeCompanyName } from '../lib/csv';

// ── Phone helpers ────────────────────────────────────────────────────────
// Storage shape: "+1 XXX-XXX-XXXX". Twilio (lib/twilio.js) needs E.164 with
// a leading + at send-time — strip non-digits there. Existing seed values
// like "(206) 555-0201" are parsed to digits on load and re-formatted.

function phoneDigitsOnly(value) {
  if (!value) return '';
  const s = String(value).trim();
  // Drop the explicit "+1" country code if present (storage format).
  const noCountry = s.startsWith('+1') ? s.slice(2) : s;
  const all = noCountry.replace(/\D/g, '');
  // Legacy seed shape may carry 11 digits leading with 1, no "+" — strip too.
  if (all.length === 11 && all.startsWith('1')) return all.slice(1);
  return all.slice(0, 10);
}

function formatPhoneDigits(d) {
  if (!d) return '';
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

function phoneStorageValue(d) {
  return d ? `+1 ${formatPhoneDigits(d)}` : '';
}

function PhoneInput({ value, onChange, disabled }) {
  const digits = phoneDigitsOnly(value);
  const formatted = formatPhoneDigits(digits);

  const handle = (e) => {
    const next = phoneDigitsOnly(e.target.value);
    onChange(phoneStorageValue(next));
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        border: '2px solid transparent',
        borderRadius: 'var(--input-radius)',
        background:
          'linear-gradient(var(--card-bg), var(--card-bg)) padding-box, var(--input-border-grad) border-box',
        overflow: 'hidden',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '0 10px',
          color: 'var(--text-muted)',
          fontSize: 14,
          background: 'var(--inset-bg)',
          borderRight: '1px solid var(--card-border)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        +1
      </span>
      <input
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={formatted}
        onChange={handle}
        disabled={disabled}
        placeholder="XXX-XXX-XXXX"
        style={{
          flex: 1,
          border: 'none',
          background: 'transparent',
          padding: '9px 12px',
          fontFamily: 'var(--font)',
          fontSize: 14,
          color: 'var(--text-primary)',
          outline: 'none',
          fontVariantNumeric: 'tabular-nums',
        }}
      />
    </div>
  );
}

// ── Company combobox ────────────────────────────────────────────────────
// Dropdown shows (1) a search field, (2) an inline "Add new company" flow at
// the top, (3) matching existing clients below. Mutually-exclusive output:
// either a `companyId` for an existing client OR a `newCompanyName` string
// the parent will dedup + create at submit time.

function CompanyPicker({
  clients,
  companyId,
  newCompanyName,
  onPickExisting,
  onCreateNew,
  onClear,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState('');
  const wrapRef = useRef(null);

  useDismissTap({ open, ref: wrapRef, onDismiss: () => setOpen(false) });

  useEffect(() => {
    if (!open) {
      setSearch('');
      setCreating(false);
      setCreateDraft('');
    }
  }, [open]);

  const selected = companyId ? clients.find((c) => c.id === companyId) : null;
  const displayLabel = selected
    ? selected.name
    : newCompanyName
    ? `${newCompanyName} (new)`
    : '';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(q));
  }, [clients, search]);

  const startCreate = () => {
    setCreating(true);
    setCreateDraft(search);
  };

  const commitCreate = () => {
    const name = createDraft.trim();
    if (!name) return;
    onCreateNew(name);
    setOpen(false);
  };

  const pickExisting = (id) => {
    onPickExisting(id);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="select-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        style={{ width: '100%' }}
      >
        <span className={`select-trigger-text ${displayLabel ? '' : 'select-placeholder'}`}>
          {displayLabel || 'Select or add a company'}
        </span>
        {(selected || newCompanyName) && !disabled && (
          <span
            className="input-clear"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            title="Clear"
            role="button"
            tabIndex={-1}
          >
            ×
          </span>
        )}
        <span className="select-trigger-caret">▾</span>
      </button>

      {open && (
        <div className="select-menu" style={{ padding: 8, maxHeight: 320 }}>
          {!creating && (
            <>
              <input
                className="input"
                placeholder="Search companies…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                style={{ marginBottom: 8 }}
              />
              <button
                type="button"
                className="menu-option"
                style={{
                  borderBottom: '1px solid var(--border-light)',
                  paddingBottom: 8,
                  marginBottom: 6,
                  fontWeight: 600,
                  color: 'var(--primary)',
                }}
                onClick={startCreate}
              >
                Add new company{search.trim() ? ` "${search.trim()}"` : ''}
              </button>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {filtered.length === 0 && (
                  <div className="text-sm text-muted" style={{ padding: '6px 8px' }}>
                    No matches.
                  </div>
                )}
                {filtered.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`menu-option ${c.id === companyId ? 'on' : ''}`}
                    onClick={() => pickExisting(c.id)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {creating && (
            <>
              <label className="form-label" style={{ display: 'block', marginBottom: 4 }}>
                New company name
              </label>
              <input
                className="input"
                value={createDraft}
                onChange={(e) => setCreateDraft(e.target.value)}
                placeholder="e.g. Northside Auto Group"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitCreate(); }
                  if (e.key === 'Escape') { setCreating(false); }
                }}
                style={{ marginBottom: 8 }}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setCreating(false)}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={commitCreate}
                  disabled={!createDraft.trim()}
                >
                  Use this name
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Communication preferences ───────────────────────────────────────────
// Relocated from the retired ContactDetail page into the Edit Contact modal (a
// person is only edited here now). Reads the LIVE contact from the store so a
// toggle reflects immediately; each flip is a silent, immediate dispatch (there
// is no per-toggle Save) and inert without contacts.edit. Enforcement lives in
// the shared consent walkers (lib/contactConsent.js + the scheduler gates).

const SUPPRESSION_SOURCE_LABEL = {
  reply: 'Unsubscribed via reply',
  unsubscribe: 'Unsubscribed via link',
  manual: 'Suppressed manually',
};

function ContactCommPrefs({ contactId }) {
  const state = useStore();
  const dispatch = useDispatch();
  const canEdit = usePermission('contacts.edit');
  const contact = selectContactById(state, contactId);
  if (!contact) return null;

  const dnc = contact.doNotContact === true;
  const email = (contact.email || '').trim();
  const suppression = email ? selectMarketingSuppressionForEmail(state, email) : null;

  const setDnc = (v) => { if (canEdit) dispatch({ type: ACTIONS.UPDATE_CONTACT, id: contact.id, patch: { doNotContact: v } }); };
  // Store the opt-OUT so a sparse/absent flag means "receives" (opt-out model).
  const setReminders = (v) => { if (canEdit) dispatch({ type: ACTIONS.UPDATE_CONTACT, id: contact.id, patch: { reminderOptOut: !v } }); };
  const setMarketing = (v) => {
    if (!canEdit || !email) return;
    if (v) dispatch({ type: ACTIONS.REMOVE_MARKETING_SUPPRESSION, email });
    else dispatch({ type: ACTIONS.ADD_MARKETING_SUPPRESSION, email, source: 'manual', reason: 'Opted out from contact edit' });
  };

  const marketingDesc = suppression
    ? `${SUPPRESSION_SOURCE_LABEL[suppression.source] || 'Suppressed'}${suppression.createdAt ? ` · ${fmtDate(suppression.createdAt)}` : ''}`
    : 'Promotional email campaigns and drip sequences.';

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <div className="form-label">Communication preferences</div>
      <p className="text-xs text-muted" style={{ marginTop: 'calc(var(--space-1) * -1)', marginBottom: 'var(--space-2)' }}>
        Saved as you toggle.
      </p>

      <div className="pref-row">
        <div className="pref-row-text">
          <div className="pref-row-label">Do Not Contact</div>
          <div className="pref-row-desc">Blocks all automated emails and reminders. Manual messages show a warning; quotes can&rsquo;t be sent.</div>
        </div>
        <Toggle on={dnc} onChange={setDnc} />
      </div>

      <div className="pref-row">
        <div className="pref-row-text">
          <div className="pref-row-label">Automated reminders</div>
          <div className="pref-row-desc">Service reminders and follow-ups sent automatically.</div>
        </div>
        {dnc
          ? <Badge variant="red">Blocked by DNC</Badge>
          : <Toggle on={contact.reminderOptOut !== true} onChange={setReminders} />}
      </div>

      <div className="pref-row">
        <div className="pref-row-text">
          <div className="pref-row-label">Marketing emails</div>
          <div className="pref-row-desc">{marketingDesc}</div>
        </div>
        {!email
          ? <Badge variant="slate">No email on file</Badge>
          : dnc
          ? <Badge variant="red">Blocked by DNC</Badge>
          : <Toggle on={!suppression} onChange={setMarketing} />}
      </div>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────

// A person carries only their own identity fields. Address is account/site level
// and tags are company level (a person is never tagged), so neither lives here.
const EMPTY = {
  email: '', firstName: '', lastName: '', title: '', phone: '',
  companyId: '', newCompanyName: '',
  notes: '',
};

export default function AddContactModal({ open, onClose, mode = 'create', initialData = null, lockCompanyId = null, prefillName = '', onCreated = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const clients = selectClients(state);

  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    if (mode === 'edit' && initialData) {
      setForm({
        email: initialData.email || '',
        firstName: initialData.firstName || '',
        lastName: initialData.lastName || '',
        title: initialData.title || '',
        phone: initialData.phone || '',
        companyId: initialData.companyId || '',
        newCompanyName: '',
        notes: initialData.notes || '',
      });
    } else {
      // Prefill from the picker's typed text: treat it as an email if it looks
      // like one, otherwise split into first / last name.
      const seed = (prefillName || '').trim();
      const isEmail = seed.includes('@');
      const [first, ...rest] = isEmail ? [''] : seed.split(/\s+/);
      setForm({
        ...EMPTY,
        companyId: lockCompanyId || '',
        email: isEmail ? seed.toLowerCase() : '',
        firstName: first || '',
        lastName: rest.join(' '),
      });
    }
  }, [open, initialData, mode, lockCompanyId, prefillName]);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = (e) => {
    e.preventDefault();
    setError('');

    const email = form.email.trim().toLowerCase();
    // Email is OPTIONAL. A contact can be identified by name (plus company) or
    // phone alone, matching the CSV importer and the reducer. When an email IS
    // given it must be well-formed, and it stays the unique key (deduped below).
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email, or leave it blank.');
      return;
    }
    if (!form.firstName.trim() && !form.lastName.trim()) {
      setError('Enter at least a first or last name.');
      return;
    }

    // Every NEW contact belongs to a company (B2B) — mirrors the CSV import gate,
    // which requires a company on create rows but never blocks an edit. The inline
    // CompanyPicker can mint one on the fly, so this stays low-friction.
    if (mode !== 'edit' && !form.companyId && !form.newCompanyName.trim()) {
      setError('Company is required. Pick one or add a new company.');
      return;
    }

    // Email dedup: one contact per email, full stop (only when an email is set).
    if (email) {
      const dup = selectContactByEmail(state, email);
      if (dup && (!initialData || dup.id !== initialData.id)) {
        setError(`Email already in use by ${dup.firstName} ${dup.lastName}.`);
        return;
      }
    }

    // Company resolution: existing pick wins. For a free-text new name, dedup
    // case-insensitively against existing clients: link to the match if any,
    // else dispatch ADD_CLIENT and use the freshly-generated id. Customer status
    // is derived (Lead until it has real work), so none is set here.
    let resolvedCompanyId = form.companyId || null;
    let createdCompany = null;
    if (!resolvedCompanyId && form.newCompanyName.trim()) {
      const newName = form.newCompanyName.trim();
      // Match the importer's account tie: normalize legal suffixes + punctuation
      // so "Acme LLC" links to an existing "Acme" instead of spawning a duplicate.
      const target = normalizeCompanyName(newName);
      const existing = clients.find((c) => normalizeCompanyName(c.name) === target);
      if (existing) {
        resolvedCompanyId = existing.id;
      } else {
        const clientId = newId('cl');
        dispatch({
          type: ACTIONS.ADD_CLIENT,
          client: { id: clientId, name: newName },
        });
        resolvedCompanyId = clientId;
        createdCompany = { name: newName };
      }
    }

    const payload = {
      email,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      title: form.title.trim(),
      phone: form.phone.trim(),
      companyId: resolvedCompanyId,
      notes: form.notes,
    };

    // The toast names the company outcome — silently creating an account
    // record was the old behavior's biggest surprise.
    const companyNote = createdCompany
      ? `. Created customer "${createdCompany.name}"`
      : '';
    if (mode === 'edit' && initialData) {
      dispatch({ type: ACTIONS.UPDATE_CONTACT, id: initialData.id, patch: payload });
      toast.success(`Contact updated${companyNote}`);
    } else {
      // Mint the id here so callers (e.g. ContactPicker) can immediately select
      // the new contact — the reducer respects a provided id (spreads it over base).
      const contactId = newId('ct');
      dispatch({ type: ACTIONS.ADD_CONTACT, contact: { id: contactId, ...payload } });
      toast.success(`Contact added${companyNote}`);
      onCreated?.(contactId);
    }
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit Contact' : 'Add Contact'} size="md">
      <form onSubmit={submit} noValidate>
        {error && <div className="form-error" style={{ marginBottom: 'var(--space-3)' }}>{error}</div>}

        <div className="form-row">
          <FormField label="First name" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} />
          <FormField label="Last name" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
        </div>

        <div className="form-row">
          <FormField label="Title" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Office Manager, Facilities Director…" />
          <FormField label="Phone">
            <PhoneInput value={form.phone} onChange={(v) => set({ phone: v })} />
          </FormField>
        </div>

        {/* The account is only asked when it isn't already fixed. On a company's own
            page (lockCompanyId) the person is added under it, so we don't ask again. */}
        {!lockCompanyId && (
          <FormField label="Company" required={mode !== 'edit'}>
            <CompanyPicker
              clients={clients}
              companyId={form.companyId}
              newCompanyName={form.newCompanyName}
              onPickExisting={(id) => set({ companyId: id, newCompanyName: '' })}
              onCreateNew={(name) => set({ companyId: '', newCompanyName: name })}
              onClear={() => set({ companyId: '', newCompanyName: '' })}
            />
          </FormField>
        )}

        <FormField
          label="Email"
          type="email"
          value={form.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="name@company.com"
          help="Optional. When set, it's the person's unique identifier and how messaging reaches them."
        />

        <FormField label="Notes" as="textarea" rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Anything worth remembering…" />

        {mode === 'edit' && initialData && <ContactCommPrefs contactId={initialData.id} />}

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">{mode === 'edit' ? 'Save Changes' : 'Add Contact'}</button>
        </div>
      </form>
    </Modal>
  );
}
