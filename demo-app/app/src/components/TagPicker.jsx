import { useState, useMemo, useRef, useEffect } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectTags } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import TagChip from './TagChip';

// Multi-select picker for attaching tags to a contact. Single-input UX:
// the main row has chips + a real text input that doubles as both the
// filter and the create field. Typing filters the dropdown; if no exact
// match (case-insensitive) the dropdown surfaces a "Create" affordance.
// Exact matches block creation — no duplicate tag names allowed.
//
// Color conventions are removed (GHL convention). Pressing Enter or
// clicking the Create row commits the new tag immediately — no color
// picker step. Closing the picker without committing wipes the query so
// stray text doesn't linger in the input.

export default function TagPicker({ value = [], onChange, canCreate = true, placeholder = 'Add tag…' }) {
  const state = useStore();
  const dispatch = useDispatch();
  const allTags = selectTags(state);
  const canManage = usePermission('tags.manage');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  // Clear any uncommitted query whenever the picker closes — abandoned typing
  // shouldn't survive a click-outside / Escape. createNew / Enter-commit paths
  // already setQuery('') before this fires, so commits are unaffected.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const selected = useMemo(
    () => value.map((id) => allTags.find((t) => t.id === id)).filter(Boolean),
    [value, allTags],
  );

  const visibleTags = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allTags.filter((t) => !q || t.label.toLowerCase().includes(q));
  }, [allTags, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return allTags.find((t) => t.label.toLowerCase() === q) || null;
  }, [allTags, query]);

  const showCreate = canCreate && canManage && query.trim().length > 0 && !exactMatch;

  const toggle = (tag) => {
    if (value.includes(tag.id)) {
      onChange(value.filter((id) => id !== tag.id));
    } else {
      onChange([...value, tag.id]);
    }
  };

  const createNew = () => {
    const label = query.trim();
    if (!label) return;
    // Dedup safeguard — Enter / Add button only fires when showCreate is true,
    // but guard here too in case state lags behind.
    if (allTags.some((t) => t.label.toLowerCase() === label.toLowerCase())) return;
    const fakeId = `ct_tmp_${Date.now()}`;
    dispatch({ type: ACTIONS.ADD_TAG, tag: { id: fakeId, label, scope: 'contact' } });
    onChange([...value, fakeId]);
    setQuery('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showCreate) {
        createNew();
      } else if (exactMatch) {
        toggle(exactMatch);
        setQuery('');
      }
    } else if (e.key === 'Backspace' && !query && selected.length > 0) {
      // Empty input + backspace → pop the last attached tag (chip-input convention).
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const focusInput = () => {
    setOpen(true);
    inputRef.current?.focus();
  };

  return (
    <div className="tag-picker" ref={wrapRef}>
      <div className="tag-picker-row" onClick={focusInput}>
        {selected.map((t) => (
          <TagChip key={t.id} tag={t} onRemove={() => toggle(t)} />
        ))}
        <input
          ref={inputRef}
          className="tag-picker-input"
          placeholder={selected.length === 0 ? placeholder : ''}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {open && (visibleTags.length > 0 || showCreate || query.trim()) && (
        <div className="tag-picker-menu">
          {showCreate && (
            <button
              type="button"
              className="tag-picker-option tag-picker-create-option"
              onClick={createNew}
            >
              Create “{query.trim()}”
            </button>
          )}
          {!showCreate && exactMatch && query.trim() && (
            <div className="tag-picker-empty" style={{ borderBottom: '1px solid var(--border-light)', marginBottom: 6, paddingBottom: 8 }}>
              "{query.trim()}" already exists — pick it below.
            </div>
          )}
          <div className="tag-picker-list">
            {visibleTags.length === 0 && !showCreate && (
              <div className="tag-picker-empty">No matches</div>
            )}
            {visibleTags.map((t) => {
              const on = value.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`tag-picker-option ${on ? 'on' : ''}`}
                  onClick={() => toggle(t)}
                >
                  <TagChip tag={t} />
                  {on && <span className="tag-check">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
