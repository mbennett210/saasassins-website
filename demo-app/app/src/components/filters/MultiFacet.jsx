import { useEffect, useMemo, useRef, useState } from 'react';
import PopMenu from '../PopMenu';

// A searchable multi-select facet with grouped options (e.g. locations grouped by
// account, cleaners, labels). The label sits ABOVE the box (like the Date-range and
// other facets, so they line up); the box reads a generic "Select" placeholder when
// empty, or the single choice / "N selected". The menu is a type-to-filter checkable
// list. value = string[]; options = [{ value, label, group? }].
export default function MultiFacet({ label, value = [], options = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  // Filter by query, then bucket into groups preserving first-seen order.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    const map = new Map();
    for (const o of matched) {
      const g = o.group || '';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(o);
    }
    return [...map.entries()];
  }, [options, query]);

  const isOn = (v) => value.includes(v);
  const toggle = (v) => onChange(isOn(v) ? value.filter((x) => x !== v) : [...value, v]);
  const count = value.length;
  // The box reads "Select" when empty; otherwise the single choice or "N selected".
  const summary = count === 0
    ? 'Select'
    : count === 1
      ? (options.find((o) => o.value === value[0])?.label || '1 selected')
      : `${count} selected`;

  return (
    <div className="facet facet-multi" ref={wrapRef}>
      {label && <span className="facet-label">{label}</span>}
      <div className={`select-shell${open ? ' is-open' : ''}`}>
        <button
          type="button"
          className="select-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`select-trigger-text${count === 0 ? ' is-placeholder' : ''}`}>{summary}</span>
          <span className="select-trigger-caret" aria-hidden>▾</span>
        </button>
        <PopMenu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={wrapRef}
          className="select-menu"
          role="listbox"
          aria-multiselectable="true"
          sheetTitle={label || 'Select'}
        >
          <input
            className="input select-search"
            placeholder="Type to filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="select-search-list">
            {groups.length === 0 && <div className="select-search-empty">No matches</div>}
            {groups.map(([group, opts]) => (
              <div key={group || '__ungrouped__'}>
                {group && <div className="facet-group-head">{group}</div>}
                {opts.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={isOn(o.value)}
                    className={`menu-option${isOn(o.value) ? ' on' : ''}`}
                    onClick={() => toggle(o.value)}
                  >
                    <span className="facet-option-label">{o.label}</span>
                    {isOn(o.value) && <span className="facet-check" aria-hidden>✓</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {count > 0 && (
            <button type="button" className="menu-option menu-option-action facet-menu-clear" onClick={() => onChange([])}>
              Clear selection
            </button>
          )}
        </PopMenu>
      </div>
    </div>
  );
}
