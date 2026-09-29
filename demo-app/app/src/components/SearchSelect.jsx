import { useMemo, useRef, useState, useEffect } from 'react';
import PopMenu from './PopMenu';

// Generic type-to-search combobox (single select). Shares the ContactPicker
// styling (.contact-picker-*) so it matches the pickers used elsewhere.
// options: [{ value, label, sublabel? }]. disabled blocks opening + dims the
// trigger (e.g. "pick a cleaner first").
export default function SearchSelect({
  value, onChange, options = [],
  placeholder = 'Select…', searchPlaceholder = 'Search…',
  disabled = false, disabledText = null, allowClear = true, emptyText = 'No matches',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  useEffect(() => { if (disabled && open) setOpen(false); }, [disabled, open]);

  const selected = useMemo(() => options.find((o) => o.value === value) || null, [options, value]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => !q || `${o.label} ${o.sublabel || ''}`.toLowerCase().includes(q)).slice(0, 50);
  }, [options, query]);

  return (
    <div className={`contact-picker ${disabled ? 'is-disabled' : ''}`} ref={wrapRef}>
      <button type="button" className="select-trigger" disabled={disabled} onClick={() => { if (!disabled) { setQuery(''); setOpen((v) => !v); } }}>
        {selected ? (
          <span className="contact-picker-selected">
            <span className="contact-picker-name">{selected.label}</span>
            {selected.sublabel && <span className="contact-picker-email">{selected.sublabel}</span>}
          </span>
        ) : (
          <span className="contact-picker-placeholder">{disabled && disabledText ? disabledText : placeholder}</span>
        )}
        <span className="contact-picker-caret">▾</span>
      </button>
      <PopMenu
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        className="contact-picker-menu"
        sheetTitle={placeholder}
      >
        <input className="input" placeholder={searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        {allowClear && selected && (
          <button type="button" className="menu-option menu-option-danger" onClick={() => { onChange(null); setOpen(false); }}>Clear selection</button>
        )}
        <div className="contact-picker-list">
          {results.length === 0 && <div className="contact-picker-empty">{emptyText}</div>}
          {results.map((o) => (
            <button key={o.value} type="button" className={`contact-picker-option ${value === o.value ? 'on' : ''}`} onClick={() => { onChange(o.value); setOpen(false); }}>
              <span>
                <div className="contact-option-name">{o.label}</div>
                {o.sublabel && <div className="contact-option-email text-xs text-muted">{o.sublabel}</div>}
              </span>
            </button>
          ))}
        </div>
      </PopMenu>
    </div>
  );
}
