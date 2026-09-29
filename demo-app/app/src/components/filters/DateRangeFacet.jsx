import { useEffect, useRef, useState } from 'react';
import PopMenu from '../PopMenu';

// A date-range facet rendered with the SHARED custom-select pattern (.select-shell /
// .select-trigger / .select-menu) — the SAME shell FilterSelect + MultiFacet use — so
// it matches the other filter selectors (Locations, Cleaners, Tags, …) box-for-box:
// same trigger fill + caret, same dropdown menu. It carries NO type-to-filter search
// (the preset list is short + fixed, and a date range has nothing to search) — the one
// intentional difference from the multi-selects. Presets (Today / 7d / 30d / This
// week…year) plus a "Custom…" option that reveals a from/to pair.
// Value: { preset } | { from, to } | null. See applyFilters.rangeBounds() + UI_RULES §53.
//
// (Previously a native <select className="input">, which rendered a white --card-bg box
// with the browser chevron and a native OS popup — visibly out of step with the grey
// --field-bg .select-trigger boxes beside it, and a dropdown that could not be themed
// to match. The shared shell fixes both, 2026-09-18.)

function sameRange(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (a.preset || '') === (b.preset || '') && (a.from || '') === (b.from || '') && (a.to || '') === (b.to || '');
}

export default function DateRangeFacet({ label, value, presets = [], onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // LOCAL DRAFT is the source of truth for the controls. The committed value
  // round-trips through the URL (useUrlFilters → setSearchParams, which
  // react-router 7 runs inside a TRANSITION); driving the custom from/to date
  // <input>s straight off that deferred value made them fight the user — fast-
  // typed digits got dropped/reset because the controlled value lagged the
  // keystrokes. So the controls read draft (instant), we push every change up,
  // and we only re-sync draft FROM the prop when the external value genuinely
  // differs (Clear all, a preset cleared elsewhere, a back-nav restoring the
  // URL). The preset menu no longer needs this (it's not a native <select> that
  // can snap back), but the date inputs still do. See UI_RULES §53.
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft((d) => (sameRange(d, value) ? d : value));
  }, [value]);

  // '__custom' is a real value the codec round-trips (encoded as 'from~to', even
  // '~' when empty). The old shape — Custom = bare {from:'',to:''} — encoded to ''
  // and was DELETED from the URL, snapping the control back to "Any time" before
  // the date inputs ever rendered: Custom was unreachable (2026-07-30 report).
  const isCustom = draft?.preset === '__custom' || !!(draft && (draft.from || draft.to));
  const selectValue = isCustom ? '__custom' : (draft?.preset || '');

  // Update the control instantly, then commit up (the URL write can lag freely).
  const push = (next) => { setDraft(next); onChange(next); };

  const onSelect = (v) => {
    if (!v) push(null);
    else if (v === '__custom') push({ preset: '__custom', from: draft?.from || '', to: draft?.to || '' });
    else push({ preset: v });
    setOpen(false);
  };

  // Trigger summary — mirrors the selected option's label. Empty ("Any time")
  // reads muted, exactly like the other facets' "Select" placeholder.
  const options = [
    { value: '', label: 'Any time' },
    ...presets.map((p) => ({ value: p.value, label: p.label })),
    { value: '__custom', label: 'Custom…' },
  ];
  const summary = options.find((o) => o.value === selectValue)?.label || 'Any time';

  return (
    <div className="facet facet-daterange" ref={wrapRef}>
      {label && <span className="facet-label">{label}</span>}
      <div className={`select-shell${open ? ' is-open' : ''}`}>
        <button
          type="button"
          className="select-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`select-trigger-text${selectValue === '' ? ' is-placeholder' : ''}`}>{summary}</span>
          <span className="select-trigger-caret" aria-hidden>▾</span>
        </button>
        <PopMenu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={wrapRef}
          className="select-menu"
          role="listbox"
          sheetTitle={label || 'Date range'}
        >
          {options.map((o) => (
            <button
              key={o.value || '__any__'}
              type="button"
              role="option"
              aria-selected={o.value === selectValue}
              className={`menu-option${o.value === selectValue ? ' on' : ''}`}
              onClick={() => onSelect(o.value)}
            >
              {o.label}
            </button>
          ))}
        </PopMenu>
      </div>
      {isCustom && (
        <div className="facet-daterange-custom">
          <input
            type="date"
            className="input"
            aria-label={label ? `${label} from` : 'From'}
            value={draft?.from || ''}
            max={draft?.to || undefined}
            onChange={(e) => push({ preset: '__custom', from: e.target.value, to: draft?.to || '' })}
          />
          <span className="facet-daterange-sep" aria-hidden>–</span>
          <input
            type="date"
            className="input"
            aria-label={label ? `${label} to` : 'To'}
            value={draft?.to || ''}
            min={draft?.from || undefined}
            onChange={(e) => push({ preset: '__custom', from: draft?.from || '', to: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
