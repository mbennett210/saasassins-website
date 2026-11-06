import { useEffect, useMemo, useRef, useState } from 'react';
import PopMenu from './PopMenu';
import PickerCapNote from './PickerCapNote';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import { useT } from '../i18n/react';

// Searchable single-select for filter bars. Looks like the themed <Select>
// (shares the select-* styles) but adds a type-to-filter input in the menu —
// the same "click and type" UX as ContactPicker / TagPicker, for a flat option
// list. The first option (typically value '') is the default / "All …" row and
// stays pinned while filtering so resetting is always one click away.
//
// options: [{ value, label }]. Controlled via value / onChange(value).
//
// It caps how many matches RENDER at the ONE number, by default (UI_RULES §127; CS-722,
// 2026-10-13: the cap was opt-in, and Approvals', the Time Clock's, the reports' and other
// filters listed all 1,540 cleaners or 768 customers because nobody passed it). It filters
// FIRST and caps SECOND, so typing still reaches every option; what is hidden is counted and
// said in a plain, non-selectable row. A short list never reaches the cap, so nothing changes
// for it. The rule and the sentence live in lib/pickerOptions.
//
// `float`: for a picker in a table row (the Inspections list's follow-up, CS-724) — the menu is
// drawn at the trigger through a portal (PopMenu `float`), so the table's scroller never cuts it
// off; the trigger keeps its own corners (`.select-shell.is-float`, index.css).
export default function FilterSelect({ value, onChange, options, ariaLabel, maxVisible = PICKER_MAX_VISIBLE, float = false }) {
  // Its own words are catalog lines in the reader's language (CS-193).
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  const selected = options.find((o) => o.value === value) || options[0];

  // Abandoned typing shouldn't linger after the menu closes.
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    // Keep the default/clear row (index 0) visible so "All …" stays reachable.
    return options.filter((o, i) => i === 0 || o.label.toLowerCase().includes(q));
  }, [options, query]);

  // What actually renders, and what to say about the rest.
  const { shown, noteMsg } = useMemo(() => capOptions(results, maxVisible), [results, maxVisible]);

  const pick = (v) => { onChange(v); setOpen(false); };

  const onSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Prefer the first row that MATCHES what was typed (the pinned first row stays on screen
      // whether it matches or not, and it is not always a blank "All …" row — the dashboard's
      // period list opens on "This month"), then the first real row, then whatever's first. It
      // picks from what is ON SCREEN, so Enter can never choose a row the cap is hiding.
      const q = query.trim().toLowerCase();
      const hit = (o) => o.label.toLowerCase().includes(q);
      const first = (q && (shown.find((o, i) => i > 0 && hit(o)) || (shown[0] && hit(shown[0]) ? shown[0] : null)))
        || shown.find((o) => o.value !== '') || shown[0];
      if (first) pick(first.value);
    }
  };

  return (
    <div className={`select-shell${open ? ' is-open' : ''}${float ? ' is-float' : ''}`} ref={wrapRef}>
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
      <PopMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        className="select-menu"
        role="listbox"
        sheetTitle={ariaLabel || t('common.filter')}
        float={float}
      >
        <input
          className="input select-search"
          placeholder={t('common.typeToFilter')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          autoFocus
        />
        <div className="select-search-list">
          {results.length === 0 && <div className="select-search-empty">{t('common.noMatches')}</div>}
          {shown.map((o) => (
            <button
              key={o.value || '__default__'}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`menu-option${o.value === value ? ' on' : ''}`}
              onClick={() => pick(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        {/* OUTSIDE the scrolling list, and BELOW it in the DOM so it reads as a footnote —
            CSS pins it under the search field (`order`), because inside the list it would
            sit after the 50th row and nobody scrolls 50 rows to learn why there are only
            50. Not an option either: no role, no click, and visible text, not a tooltip. */}
        <PickerCapNote note={noteMsg} />
      </PopMenu>
    </div>
  );
}
