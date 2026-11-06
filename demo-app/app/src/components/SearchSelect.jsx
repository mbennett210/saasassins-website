import { useMemo, useRef, useState, useEffect } from 'react';
import PopMenu from './PopMenu';
import PickerCapNote from './PickerCapNote';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import { useT } from '../i18n/react';

// Generic type-to-search combobox (single select). Shares the ContactPicker
// styling (.contact-picker-*) so it matches the pickers used elsewhere.
// options: [{ value, label, sublabel? }]. disabled blocks opening + dims the
// trigger (e.g. "pick a cleaner first").
//
// It picks from the long lists (every building, every cleaner), so it renders the first
// PICKER_MAX_VISIBLE matches and SAYS how many more there are (UI_RULES §127; CS-723: it cut at
// 50 in silence, and a manager scrolling for their building concluded it was missing). Typing
// narrows before the cap, so every option stays reachable.
export default function SearchSelect({
  value, onChange, options = [],
  placeholder, searchPlaceholder,
  disabled = false, disabledText = null, allowClear = true, emptyText,
}) {
  // The built-in words are catalog lines in the reader's language (CS-193); a caller's own
  // (already translated) words win.
  const t = useT();
  const placeholderText = placeholder ?? t('common.select');
  const searchText = searchPlaceholder ?? t('common.search');
  const emptyLabel = emptyText ?? t('common.noMatches');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  useEffect(() => { if (disabled && open) setOpen(false); }, [disabled, open]);

  const selected = useMemo(() => options.find((o) => o.value === value) || null, [options, value]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => !q || `${o.label} ${o.sublabel || ''}`.toLowerCase().includes(q));
  }, [options, query]);
  const { shown, noteMsg } = useMemo(() => capOptions(results, PICKER_MAX_VISIBLE), [results]);

  return (
    <div className={`contact-picker ${disabled ? 'is-disabled' : ''}`} ref={wrapRef}>
      <button type="button" className="select-trigger" disabled={disabled} onClick={() => { if (!disabled) { setQuery(''); setOpen((v) => !v); } }}>
        {selected ? (
          <span className="contact-picker-selected">
            <span className="contact-picker-name">{selected.label}</span>
            {selected.sublabel && <span className="contact-picker-email">{selected.sublabel}</span>}
          </span>
        ) : (
          <span className="contact-picker-placeholder">{disabled && disabledText ? disabledText : placeholderText}</span>
        )}
        <span className="contact-picker-caret">▾</span>
      </button>
      <PopMenu
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        className="contact-picker-menu"
        sheetTitle={placeholderText}
      >
        <input className="input" placeholder={searchText} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        {allowClear && selected && (
          <button type="button" className="menu-option menu-option-danger" onClick={() => { onChange(null); setOpen(false); }}>{t('common.clearSelection')}</button>
        )}
        <div className="contact-picker-list">
          {results.length === 0 && <div className="contact-picker-empty">{emptyLabel}</div>}
          {shown.map((o) => (
            <button key={o.value} type="button" className={`contact-picker-option ${value === o.value ? 'on' : ''}`} onClick={() => { onChange(o.value); setOpen(false); }}>
              <span>
                <div className="contact-option-name">{o.label}</div>
                {o.sublabel && <div className="contact-option-email text-xs text-muted">{o.sublabel}</div>}
              </span>
            </button>
          ))}
        </div>
        <PickerCapNote note={noteMsg} />
      </PopMenu>
    </div>
  );
}
