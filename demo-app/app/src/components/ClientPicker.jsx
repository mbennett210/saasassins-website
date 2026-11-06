import { useState, useMemo, useRef, useEffect } from 'react';
import PopMenu from './PopMenu';
import PickerCapNote from './PickerCapNote';
import { useIsMobile } from '../hooks/useIsMobile';
import { useStore } from '../store';
import { selectClients } from '../store/selectors';
import { customerLabel } from '../lib/customerNumber';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';

// Single-select searchable picker for companies/accounts. Mirrors ServicePicker:
// the trigger shows the current selection (or placeholder), clicking opens a
// popover with a search input + filtered list. Unlike the old plain <select>,
// you can type to find a company — and it lists ALL companies (active, prospect,
// inactive), not just active ones, so every account is reachable when scheduling.
// Non-creatable: companies are created from Contacts, not on the job form.
// It never renders the whole book (UI_RULES §127; CS-722: 768 rows, a 28,844 px menu): typing
// narrows first, then the first PICKER_MAX_VISIBLE show with the "Showing 50 of 768" footnote.
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
    // GO-2: a customer is found by its number too ("0001", or "0001 Ball Harbor").
    return clients
      .filter((c) => !q || customerLabel(c).toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (rank[a.status] ?? 1) - (rank[b.status] ?? 1) || (a.name || '').localeCompare(b.name || ''));
  }, [clients, query]);
  const { shown, noteMsg } = useMemo(() => capOptions(visible, PICKER_MAX_VISIBLE), [visible]);

  const pick = (c) => { onChange(c.id); setQuery(''); setOpen(false); };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (visible.length >= 1) pick(visible[0]);
    } else if (e.key === 'Escape') {
      // An open list takes Esc: it closes, and the pop-up around it stays (UI_RULES §181).
      if (open) e.preventDefault();
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
            {selected ? customerLabel(selected) : <span className="select-placeholder">{placeholder}</span>}
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
        <div className="select-search-list">
          {visible.length === 0 && <div className="tag-picker-empty">No matching companies</div>}
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`menu-option ${c.id === value ? 'on' : ''}`}
              onClick={() => pick(c)}
            >
              {customerLabel(c)}
              {c.status && c.status !== 'active' && (
                <span className="text-xs text-muted" style={{ marginLeft: 6, textTransform: 'capitalize' }}>· {c.status}</span>
              )}
              {c.id === value && <span className="tag-check" style={{ marginLeft: 'auto' }}>✓</span>}
            </button>
          ))}
        </div>
        <PickerCapNote note={noteMsg} />
      </PopMenu>
    </div>
  );
}
