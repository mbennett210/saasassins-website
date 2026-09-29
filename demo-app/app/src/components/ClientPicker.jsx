import { useState, useMemo, useRef, useEffect } from 'react';
import PopMenu from './PopMenu';
import { useIsMobile } from '../hooks/useIsMobile';
import { useStore } from '../store';
import { selectClients } from '../store/selectors';

// Single-select searchable picker for companies/accounts. Mirrors ServicePicker:
// the trigger shows the current selection (or placeholder), clicking opens a
// popover with a search input + filtered list. Unlike the old plain <select>,
// you can type to find a company — and it lists ALL companies (active, prospect,
// inactive), not just active ones, so every account is reachable when scheduling.
// Non-creatable: companies are created from Contacts, not on the job form.
export default function ClientPicker({ value, onChange, placeholder = 'Select a company', allowClear = false }) {
  const state = useStore();
  const clients = selectClients(state) || [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const isMobile = useIsMobile();

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const selected = useMemo(() => clients.find((c) => c.id === value) || null, [clients, value]);

  // Active first, then by name — so the common case sits at the top of the list.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = { active: 0, prospect: 1, inactive: 2 };
    return clients
      .filter((c) => !q || (c.name || '').toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (rank[a.status] ?? 1) - (rank[b.status] ?? 1) || (a.name || '').localeCompare(b.name || ''));
  }, [clients, query]);

  const pick = (c) => { onChange(c.id); setQuery(''); setOpen(false); };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (visible.length >= 1) pick(visible[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const openAndFocus = () => {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="select-shell" ref={wrapRef}>
      {(!open || isMobile) ? (
        <button type="button" className="select-trigger" onClick={openAndFocus}>
          <span className="select-trigger-text">
            {selected ? selected.name : <span className="select-placeholder">{placeholder}</span>}
          </span>
          <span className="select-trigger-caret" aria-hidden>▾</span>
        </button>
      ) : (
        <div className="select-trigger" onClick={() => inputRef.current?.focus()}>
          <input
            ref={inputRef}
            className="picker-search-input"
            placeholder="Type to search companies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="select-trigger-caret" aria-hidden>▾</span>
        </div>
      )}
      <PopMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        className="select-menu"
        sheetTitle={placeholder}
      >
        {isMobile && (
          <input
            ref={inputRef}
            className="input pop-sheet-search"
            placeholder="Type to search companies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        )}
        {allowClear && (
          <button type="button" className={`menu-option ${!value ? 'on' : ''}`} onClick={() => { onChange(''); setQuery(''); setOpen(false); }}>
            None
          </button>
        )}
        {visible.length === 0 && <div className="tag-picker-empty">No matching companies</div>}
        {visible.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`menu-option ${c.id === value ? 'on' : ''}`}
            onClick={() => pick(c)}
          >
            {c.name}
            {c.status && c.status !== 'active' && (
              <span className="text-xs text-muted" style={{ marginLeft: 6, textTransform: 'capitalize' }}>· {c.status}</span>
            )}
            {c.id === value && <span className="tag-check" style={{ marginLeft: 'auto' }}>✓</span>}
          </button>
        ))}
      </PopMenu>
    </div>
  );
}
