import { useState, useMemo, useRef, useEffect } from 'react';
import PopMenu from './PopMenu';
import { useIsMobile } from '../hooks/useIsMobile';
import Avatar from './Avatar';

// Multi-select picker for crew assignment. Designed for clients with many
// staff (30+) where a chip-grid would overwhelm the modal.
//
// Behavior:
// - Trigger row shows selected crew as compact chips inline. The row is
//   single-line, no-wrap, with overflow hidden — chips that don't fit get
//   clipped and a CSS mask fades the right edge to signal "more selected
//   than visible." Click the trigger to open the picker and see all chips.
// - Dropdown is a single scrollable list of every crew member, with a
//   checkmark on the right of those already selected. Clicking a row
//   toggles the assignment without removing the row from the list, so the
//   user can keep clicking the same spot — the dropdown geometry doesn't
//   reflow as items move between selected/unselected. (See the menu's
//   fixed `height: 360px` rule in index.css.)
// - Type-to-search filters the list. Backspace on empty input pops the
//   last chip — chip-input convention.
export default function CrewPicker({ value = [], onChange, pool = [], placeholder = 'Add crew…' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const isMobile = useIsMobile();

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  // Selected ids missing from the pool (deleted/deactivated users in legacy
  // data) render as a removable "Former member" ghost chip instead of being
  // silently dropped — dropping them made the stale entry invisible AND
  // impossible to deselect, so it lived in the array forever.
  const selected = useMemo(
    () => value.map((id) => pool.find((u) => u.id === id) || { id, ghost: true }),
    [value, pool],
  );

  // Single list — all eligible crew shown, with checkmarks on selected.
  // Filtering applies to query only, not to selection state, so selected
  // crew don't disappear when a user toggles them on.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pool.filter((u) => !q || u.name.toLowerCase().includes(q));
  }, [pool, query]);

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
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible.length === 1) toggle(visible[0]);
    }
  };

  const focusInput = () => {
    setOpen(true);
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
              <Avatar initials={u.initials} variant={u.avatar} size="xs" />
              <span className="crew-chip-name">{u.name}</span>
            </span>
          )))}
          <input
            ref={isMobile ? undefined : inputRef}
            className="tag-picker-input crew-trigger-input"
            placeholder={selected.length === 0 ? placeholder : ''}
            value={query}
            readOnly={isMobile}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
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
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        )}
        <div className="crew-picker-list">
          {visible.length === 0 ? (
            <div className="tag-picker-empty">No matching crew.</div>
          ) : (
            visible.map((u) => {
              const on = isSelected(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className={`crew-picker-row ${on ? 'is-selected' : ''}`}
                  onClick={() => toggle(u)}
                  aria-pressed={on}
                >
                  <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                  <span className="crew-picker-row-name">{u.name}</span>
                  {on && <span className="crew-picker-row-check" aria-hidden>✓</span>}
                </button>
              );
            })
          )}
        </div>
      </PopMenu>
    </div>
  );
}
