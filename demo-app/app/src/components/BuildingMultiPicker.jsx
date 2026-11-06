import { useMemo, useState } from 'react';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';

// Pick MANY customers (buildings) — for a client user's direct access and for a group's
// membership. There was no multi-select for customers in the kit; the single-value pickers
// (ClientPicker, ClientNamePicker) are a different control.
//
// Capped rendering, not capped reach (UI_RULES §127): this list is 750 buildings at the
// stated scale, so it filters FIRST and renders at most PICKER_MAX_VISIBLE, says how many
// are hidden, and typing reaches every one. Selected rows are pinned to the top so a long
// list never hides what you already chose.
export default function BuildingMultiPicker({ options, value, onChange, label = 'Buildings', emptyNote = 'No customers yet.' }) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(value || []), [value]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = (options || []).filter((o) => !q || (o.label || '').toLowerCase().includes(q));
    // Chosen first, then the rest, each alphabetically — the order the office reads it in.
    return [
      ...all.filter((o) => selected.has(o.value)),
      ...all.filter((o) => !selected.has(o.value)),
    ];
  }, [options, query, selected]);

  const { shown, note } = capOptions(rows, PICKER_MAX_VISIBLE);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };

  return (
    <div className="bmp">
      <div className="bmp-head">
        <span className="form-label">{label}</span>
        <span className="text-xs text-muted">{selected.size} selected</span>
      </div>
      <input
        className="input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search buildings…"
        aria-label={`Search ${label.toLowerCase()}`}
      />
      <div className="bmp-list">
        {shown.length === 0 && <div className="text-xs text-muted bmp-empty">{query ? 'No match.' : emptyNote}</div>}
        {shown.map((o) => (
          <label key={o.value} className="bmp-row">
            <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} />
            <span className="truncate" title={o.label}>{o.label}</span>
          </label>
        ))}
        {note && <div className="text-xs text-muted bmp-empty">{note}</div>}
      </div>
    </div>
  );
}
