import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import TagPicker from './TagPicker';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClients, selectContactByEmail } from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';

const LIFECYCLES = [
  { value: 'lead',     label: 'Lead' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'client',   label: 'Client' },
  { value: 'vendor',   label: 'Vendor' },
];

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

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

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
            className="text-xs text-muted"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            style={{ cursor: 'pointer', padding: '0 6px' }}
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
                className="select-option"
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
                    className={`select-option ${c.id === companyId ? 'on' : ''}`}
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
                  className="btn btn-outline btn-sm"
                  onClick={() => setCreating(false)}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
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

// ── Modal ────────────────────────────────────────────────────────────────

const EMPTY = {
  email: '', firstName: '', lastName: '', title: '', phone: '',
  companyId: '', newCompanyName: '', tagIds: [],
  lifecycle: 'lead',
  notes: '',
};

export default function AddContactModal({ open, onClose, mode = 'create', initialData = null, lockCompanyId = null }) {
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
        tagIds: initialData.tagIds || [],
        lifecycle: initialData.lifecycle || 'lead',
        notes: initialData.notes || '',
      });
    } else {
      setForm({ ...EMPTY, companyId: lockCompanyId || '' });
    }
  }, [open, initialData, mode, lockCompanyId]);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = (e) => {
    e.preventDefault();
    setError('');

    const email = form.email.trim().toLowerCase();
    if (!email) { setError('Email is required.'); return; }
    if (!form.firstName.trim() && !form.lastName.trim()) {
      setError('Enter at least a first or last name.');
      return;
    }

    // Email dedup — one contact per email, full stop.
    const dup = selectContactByEmail(state, email);
    if (dup && (!initialData || dup.id !== initialData.id)) {
      setError(`Email already in use by ${dup.firstName} ${dup.lastName}.`);
      return;
    }

    // Company resolution: existing pick wins. For a free-text new name, dedup
    // case-insensitively against existing clients — link to the match if any,
    // else dispatch ADD_CLIENT and use the freshly-generated id.
    let resolvedCompanyId = form.companyId || null;
    if (!resolvedCompanyId && form.newCompanyName.trim()) {
      const newName = form.newCompanyName.trim();
      const existing = clients.find((c) => c.name.toLowerCase() === newName.toLowerCase());
      if (existing) {
        resolvedCompanyId = existing.id;
      } else {
        const clientId = newId('cl');
        dispatch({
          type: ACTIONS.ADD_CLIENT,
          client: { id: clientId, name: newName },
        });
        resolvedCompanyId = clientId;
      }
    }

    const payload = {
      email,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      title: form.title.trim(),
      phone: form.phone.trim(),
      companyId: resolvedCompanyId,
      tagIds: form.tagIds,
      lifecycle: form.lifecycle,
      notes: form.notes,
    };

    if (mode === 'edit' && initialData) {
      dispatch({ type: ACTIONS.UPDATE_CONTACT, id: initialData.id, patch: payload });
      toast.success('Contact updated');
    } else {
      dispatch({ type: ACTIONS.ADD_CONTACT, contact: payload });
      toast.success('Contact added');
    }
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit Contact' : 'Add Contact'} size="md">
      <form onSubmit={submit}>
        <FormField
          label="Email"
          type="email"
          required
          value={form.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="name@company.com"
          help="Email is the contact's unique identifier — only one contact per address."
        />
        {error && <div className="form-error" style={{ marginTop: -8, marginBottom: 10 }}>{error}</div>}

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

        <div className="form-row">
          <FormField label="Company">
            <CompanyPicker
              clients={clients}
              companyId={form.companyId}
              newCompanyName={form.newCompanyName}
              onPickExisting={(id) => set({ companyId: id, newCompanyName: '' })}
              onCreateNew={(name) => set({ companyId: '', newCompanyName: name })}
              onClear={() => set({ companyId: '', newCompanyName: '' })}
              disabled={Boolean(lockCompanyId)}
            />
          </FormField>
          <FormField
            label="Status"
            as="select"
            value={form.lifecycle}
            onChange={(e) => set({ lifecycle: e.target.value })}
            options={LIFECYCLES}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Tags</label>
          <TagPicker value={form.tagIds} onChange={(ids) => set({ tagIds: ids })} />
        </div>

        <FormField label="Notes" as="textarea" rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Anything worth remembering…" />

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">{mode === 'edit' ? 'Save Changes' : 'Add Contact'}</button>
        </div>
      </form>
    </Modal>
  );
}
