// Combobox for picking a company BY NAME for the Keys page — same look/feel as
// ContactPicker (the New-quote contact dropdown; reuses its .contact-picker CSS).
//
// Two sections, newest first in each:
//   1. Companies that ALREADY HAVE KEYS (so a new key can be filed under the same
//      group) — recency = their latest key activity.
//   2. ── divider ── CRM companies with no keys yet — recency = client createdAt.
// Typing filters both sections; a name with no match can still be used as-is
// (free-text option) so a brand-new company name is never blocked.
//
// Value model: the Keys store groups by clientName (string) with an optional
// clientId link, so onChange emits { name, clientId }.
import { useMemo, useRef, useState } from 'react';
import PopMenu from './PopMenu';
import { useStore } from '../store';
import { selectClients, selectKeys } from '../store/selectors';
import Avatar from './Avatar';

const initialsOf = (name) =>
  String(name || '').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'C';

export default function ClientNamePicker({ value, onChange, placeholder = 'Search companies…' }) {
  const state = useStore();
  const clients = selectClients(state);
  const keys = selectKeys(state);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  // Section 1 — distinct key-holding client names, newest key activity first.
  const keyed = useMemo(() => {
    const groups = new Map(); // name -> { name, count, latest, clientId }
    for (const k of keys) {
      const name = (k.clientName || '').trim();
      if (!name) continue;
      const g = groups.get(name) || { name, count: 0, latest: '', clientId: k.clientId || null };
      g.count += 1;
      if ((k.updatedAt || k.createdAt || '') > g.latest) g.latest = k.updatedAt || k.createdAt || '';
      if (!g.clientId && k.clientId) g.clientId = k.clientId;
      groups.set(name, g);
    }
    // Link a CRM client id by exact name when the keys rows don't carry one.
    for (const g of groups.values()) {
      if (!g.clientId) g.clientId = clients.find((c) => c.name === g.name)?.id || null;
    }
    return [...groups.values()].sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : a.name.localeCompare(b.name)));
  }, [keys, clients]);

  // Section 2 — CRM clients with no keys yet, newest first.
  const fresh = useMemo(() => {
    const keyedNames = new Set(keyed.map((g) => g.name.toLowerCase()));
    return clients
      .filter((c) => c.name && !keyedNames.has(c.name.toLowerCase()))
      .sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? 1 : -1));
  }, [clients, keyed]);

  const q = query.trim().toLowerCase();
  const match = (name) => !q || name.toLowerCase().includes(q);
  const keyedResults = keyed.filter((g) => match(g.name)).slice(0, 25);
  const freshResults = fresh.filter((c) => match(c.name)).slice(0, 25);
  const exactExists = [...keyed.map((g) => g.name), ...fresh.map((c) => c.name)]
    .some((n) => n.toLowerCase() === q);

  const pick = (name, clientId) => { onChange({ name, clientId: clientId || null }); setOpen(false); setQuery(''); };

  return (
    <div className="contact-picker" ref={wrapRef}>
      <button type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {value ? (
          <span className="contact-picker-selected">
            <Avatar initials={initialsOf(value)} variant={(value.length % 5) + 1} size="sm" />
            <span className="contact-picker-name">{value}</span>
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
          placeholder="Type a company name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="contact-picker-list">
          {keyedResults.length > 0 && <div className="contact-picker-section">Has keys</div>}
          {keyedResults.map((g) => (
            <button
              key={`k-${g.name}`}
              type="button"
              className={`contact-picker-option ${value === g.name ? 'on' : ''}`}
              onClick={() => pick(g.name, g.clientId)}
            >
              <Avatar initials={initialsOf(g.name)} variant={(g.name.length % 5) + 1} size="sm" />
              <span>
                <div className="contact-option-name">{g.name}</div>
                <div className="contact-option-email text-xs text-muted">{g.count} key{g.count === 1 ? '' : 's'}</div>
              </span>
            </button>
          ))}
          {keyedResults.length > 0 && freshResults.length > 0 && <div className="contact-picker-divider" />}
          {freshResults.length > 0 && <div className="contact-picker-section">New companies. No keys yet</div>}
          {freshResults.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`contact-picker-option ${value === c.name ? 'on' : ''}`}
              onClick={() => pick(c.name, c.id)}
            >
              <Avatar initials={initialsOf(c.name)} variant={(c.id.length % 5) + 1} size="sm" />
              <span>
                <div className="contact-option-name">{c.name}</div>
                <div className="contact-option-email text-xs text-muted">No keys yet</div>
              </span>
            </button>
          ))}
          {q && !exactExists && (
            <button type="button" className="contact-picker-option" onClick={() => pick(query.trim(), null)}>
              <Avatar initials={initialsOf(query)} variant={1} size="sm" />
              <span>
                <div className="contact-option-name">Use “{query.trim()}”</div>
                <div className="contact-option-email text-xs text-muted">New company name</div>
              </span>
            </button>
          )}
          {keyedResults.length === 0 && freshResults.length === 0 && !q && (
            <div className="contact-picker-empty">No companies yet. Type a name</div>
          )}
        </div>
      </PopMenu>
    </div>
  );
}
