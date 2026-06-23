import { useEffect, useMemo, useRef, useState } from 'react';

// Searchable single-select for filter bars. Looks like the themed <Select>
// (shares the select-* styles) but adds a type-to-filter input in the menu —
// the same "click and type" UX as ContactPicker / TagPicker, for a flat option
// list. The first option (typically value '') is the default / "All …" row and
// stays pinned while filtering so resetting is always one click away.
//
// options: [{ value, label }]. Controlled via value / onChange(value).
export default function FilterSelect({ value, onChange, options, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  const selected = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Abandoned typing shouldn't linger after the menu closes.
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    // Keep the default/clear row (index 0) visible so "All …" stays reachable.
    return options.filter((o, i) => i === 0 || o.label.toLowerCase().includes(q));
  }, [options, query]);

  const pick = (v) => { onChange(v); setOpen(false); };

  const onSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Prefer the first real match; fall back to whatever's first.
      const first = results.find((o) => o.value !== '') || results[0];
      if (first) pick(first.value);
    }
  };

  return (
    <div className={`select-shell${open ? ' is-open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="select-trigger-text">{selected?.label}</span>
        <span className="select-trigger-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="select-menu" role="listbox">
          <input
            className="input select-search"
            placeholder="Type to filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            autoFocus
          />
          <div className="select-search-list">
            {results.length === 0 && <div className="select-search-empty">No matches</div>}
            {results.map((o) => (
              <button
                key={o.value || '__default__'}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`select-option${o.value === value ? ' on' : ''}`}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
