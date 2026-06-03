import { useMemo, useRef, useState, useEffect } from 'react';
import { useStore } from '../store';
import { selectContacts } from '../store/selectors';
import Avatar from './Avatar';

// Combobox for picking a contact. Filterable by name or email.
// Optional `companyId` filter narrows to that client's contacts (plus "(all)" toggle).

export default function ContactPicker({ value, onChange, companyId = null, placeholder = 'Search contacts…', allowClear = true }) {
  const contacts = selectContacts(useStore());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [companyOnly, setCompanyOnly] = useState(Boolean(companyId));
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

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
      <button type="button" className="contact-picker-trigger" onClick={() => setOpen((v) => !v)}>
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
      {open && (
        <div className="contact-picker-menu">
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
            <button type="button" className="contact-picker-clear" onClick={() => { onChange(null); setOpen(false); }}>
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
          </div>
        </div>
      )}
    </div>
  );
}
