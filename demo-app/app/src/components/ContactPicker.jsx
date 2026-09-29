import { useMemo, useRef, useState } from 'react';
import PopMenu from './PopMenu';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { selectVisibleContactsFor } from '../store/selectors';
import Avatar from './Avatar';
import AddContactModal from './AddContactModal';

// Combobox for picking a contact. Filterable by name or email.
// Optional `companyId` filter narrows to that client's contacts (plus "(all)" toggle).

export default function ContactPicker({ value, onChange, companyId = null, placeholder = 'Search contacts…', allowClear = true }) {
  const state = useStore();
  const { currentUser } = useAuth();
  // Crew only see contacts of clients they're assigned to; managers see all.
  const contacts = useMemo(() => selectVisibleContactsFor(state, currentUser), [state, currentUser]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [companyOnly, setCompanyOnly] = useState(Boolean(companyId));
  const [createOpen, setCreateOpen] = useState(false);
  const wrapRef = useRef(null);

  const selected = useMemo(() => contacts.find((c) => c.id === value) || null, [contacts, value]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .filter((c) => !companyOnly || !companyId || c.companyId === companyId)
      .filter((c) => {
        if (!q) return true;
        const name = `${c.firstName} ${c.lastName}`.toLowerCase();
        return name.includes(q) || (c.email || '').toLowerCase().includes(q);
      })
      .slice(0, 30);
  }, [contacts, query, companyOnly, companyId]);

  return (
    <div className="contact-picker" ref={wrapRef}>
      <button type="button" className="select-trigger" onClick={() => setOpen((v) => !v)}>
        {selected ? (
          <span className="contact-picker-selected">
            <Avatar initials={`${(selected.firstName[0] || '').toUpperCase()}${(selected.lastName[0] || '').toUpperCase()}`} variant={(selected.id.length % 5) + 1} size="sm" />
            <span className="contact-picker-name">{selected.firstName} {selected.lastName}</span>
            <span className="contact-picker-email">{selected.email}</span>
          </span>
        ) : (
          <span className="contact-picker-placeholder">{placeholder}</span>
        )}
        <span className="contact-picker-caret">▾</span>
      </button>
      <PopMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        className="contact-picker-menu"
        sheetTitle={placeholder}
      >
        <input
          className="input"
          placeholder="Search by name or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {companyId && (
          <label className="contact-picker-toggle">
            <input type="checkbox" checked={companyOnly} onChange={(e) => setCompanyOnly(e.target.checked)} />
            <span>Restrict to this client</span>
          </label>
        )}
        {allowClear && selected && (
          <button type="button" className="menu-option menu-option-danger" onClick={() => { onChange(null); setOpen(false); }}>
            Clear selection
          </button>
        )}
        <div className="contact-picker-list">
          {results.length === 0 && <div className="contact-picker-empty">No matches</div>}
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`contact-picker-option ${value === c.id ? 'on' : ''}`}
              onClick={() => { onChange(c.id); setOpen(false); }}
            >
              <Avatar initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`} variant={(c.id.length % 5) + 1} size="sm" />
              <span>
                <div className="contact-option-name">{c.firstName} {c.lastName}</div>
                <div className="contact-option-email text-xs text-muted">{c.email}</div>
              </span>
            </button>
          ))}
          {companyId && (
            <button
              type="button"
              className="menu-option menu-option-action contact-picker-create"
              onClick={() => { setCreateOpen(true); setOpen(false); }}
            >
              {query.trim() ? `Create “${query.trim()}”` : 'Create new contact'}
            </button>
          )}
        </div>
      </PopMenu>
      <AddContactModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        lockCompanyId={companyId}
        prefillName={query}
        onCreated={(id) => { onChange(id); setCreateOpen(false); }}
      />
    </div>
  );
}
