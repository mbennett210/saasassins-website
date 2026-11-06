import { useState, useMemo, useRef, useEffect } from 'react';
import PopMenu from './PopMenu';
import PickerCapNote from './PickerCapNote';
import { useIsMobile } from '../hooks/useIsMobile';
import { crewPickerRows, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import Avatar from './Avatar';
import Badge from './Badge';
import { useT } from '../i18n/react';

const NO_LEAD = [];
const NO_PREFER = [];

// Multi-select picker for crew assignment. Designed for clients with many
// staff (30+) where a chip-grid would overwhelm the modal — and the ONE crew
// field: New clean, the series blocks and, since CS-673, the clean's own edit
// form (which drew one chip per active person: 1,544 chips at Matt's size).
//
// Behavior:
// - Trigger row shows selected crew as compact chips inline. The row is
//   single-line, no-wrap, with overflow hidden — chips that don't fit get
//   clipped and a CSS mask fades the right edge to signal "more selected
//   than visible." Click the trigger to open the picker and see all chips.
// - Dropdown is a single scrollable list of crew, with a checkmark on the
//   right of those already selected. Clicking a row toggles the assignment
//   without removing the row from the list, so the user can keep clicking the
//   same spot — the dropdown geometry doesn't reflow as items move between
//   selected/unselected. (See the menu's fixed `height: 360px` rule in index.css.)
// - It never renders the whole roster (UI_RULES §127): typing narrows by name,
//   the people picked when the menu OPENED lead the list (a snapshot, so a
//   toggle never moves a row), then the first PICKER_MAX_VISIBLE show with a
//   "Showing 50 of 1,540. Type to narrow." footnote (lib/pickerOptions
//   crewPickerRows). After them, the cleaners who work at the clean's customer (`preferIds`,
//   lib/worksAt), each tagged "Works here".
// - Type-to-search filters the list. Backspace on empty input pops the
//   last chip — chip-input convention.
export default function CrewPicker({ value = [], onChange, pool = [], placeholder = 'Add crew…', preferIds = NO_PREFER }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [lead, setLead] = useState(NO_LEAD);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const isMobile = useIsMobile();

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  // Opening snapshots who is picked, so they lead the list for this whole visit to it.
  const openMenu = () => { if (!open) setLead(value); setOpen(true); };

  // Selected ids missing from the pool (deleted/deactivated users in legacy
  // data) render as a removable "Former member" ghost chip instead of being
  // silently dropped — dropping them made the stale entry invisible AND
  // impossible to deselect, so it lived in the array forever.
  const selected = useMemo(
    () => value.map((id) => pool.find((u) => u.id === id) || { id, ghost: true }),
    [value, pool],
  );

  // Filtering applies to the query only, not to selection state, so selected
  // crew don't disappear when a user toggles them on.
  const { matches, shown, noteMsg } = useMemo(
    () => crewPickerRows(pool, { query, leadIds: lead, preferIds, maxVisible: PICKER_MAX_VISIBLE }),
    [pool, query, lead, preferIds],
  );
  const worksHere = useMemo(() => new Set(preferIds), [preferIds]);

  const isSelected = (id) => value.includes(id);

  const toggle = (user) => {
    if (isSelected(user.id)) {
      onChange(value.filter((id) => id !== user.id));
    } else {
      onChange([...value, user.id]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Backspace' && !query && selected.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape') {
      // An open list takes Esc: it closes, and the pop-up around it stays (UI_RULES §181).
      if (open) e.preventDefault();
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches.length === 1) toggle(matches[0]);
    }
  };

  const focusInput = () => {
    openMenu();
    // On mobile the search field lives in the sheet (autofocus); focusing the read-only
    // row input would just pop the keyboard behind the backdrop.
    if (!isMobile) inputRef.current?.focus();
  };

  return (
    <div className="crew-picker" ref={wrapRef}>
      <div className="crew-trigger" onClick={focusInput}>
        <div className="crew-trigger-strip">
          {selected.map((u) => (u.ghost ? (
            <span key={u.id} className="crew-chip" title="No longer an active team member. Click × to remove">
              <span className="crew-chip-name text-muted">Former member</span>
              <button
                type="button" className="chip-remove" aria-label="Remove former member"
                onClick={(e) => { e.stopPropagation(); onChange(value.filter((id) => id !== u.id)); }}
              >
                ×
              </button>
            </span>
          ) : (
            <span key={u.id} className="crew-chip">
              <Avatar user={u} size="xs" />
              <span className="crew-chip-name">{u.name}</span>
            </span>
          )))}
          <input
            ref={isMobile ? undefined : inputRef}
            className="tag-picker-input crew-trigger-input"
            placeholder={selected.length === 0 ? placeholder : ''}
            value={query}
            readOnly={isMobile}
            onChange={(e) => { setQuery(e.target.value); openMenu(); }}
            onFocus={openMenu}
            onKeyDown={handleKeyDown}
          />
        </div>
      </div>
      <PopMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        className="crew-picker-menu"
        sheetTitle="Crew"
      >
        {isMobile && (
          <input
            ref={inputRef}
            className="input pop-sheet-search"
            placeholder={placeholder}
            value={query}
            onChange={(e) => { setQuery(e.target.value); openMenu(); }}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        )}
        <div className="crew-picker-list">
          {matches.length === 0 ? (
            <div className="tag-picker-empty">No matching crew.</div>
          ) : (
            shown.map((u) => {
              const on = isSelected(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className={`crew-picker-row ${on ? 'is-selected' : ''}`}
                  onClick={() => toggle(u)}
                  aria-pressed={on}
                >
                  <Avatar user={u} size="sm" />
                  <span className="crew-picker-row-name">{u.name}</span>
                  {worksHere.has(u.id) && <Badge variant="blue">{t('worksAt.tag')}</Badge>}
                  {on && <span className="crew-picker-row-check" aria-hidden>✓</span>}
                </button>
              );
            })
          )}
        </div>
        <PickerCapNote note={noteMsg} />
      </PopMenu>
    </div>
  );
}
