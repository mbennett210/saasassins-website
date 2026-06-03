import { useState, useMemo, useRef, useEffect } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectServices } from '../store/selectors';

// Single-select creatable picker for services. Mirrors the TagPicker UX:
// the trigger row shows the current selection (or placeholder) and clicking
// opens a popover with a search input + filtered list. Typing a name not in
// the list surfaces a "Create" affordance — exact (case-insensitive) matches
// suppress the create row and prompt the user to pick the existing service
// instead, so duplicates aren't possible.
//
// New services dispatch ADD_SERVICE with a sensible default duration (60 min)
// — the user can refine that later in Settings → Services. The newly-created
// service is selected immediately so the form flow isn't interrupted.
export default function ServicePicker({ value, onChange, placeholder = 'Pick a service…' }) {
  const state = useStore();
  const dispatch = useDispatch();
  const services = selectServices(state);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  // Clear stale query whenever the popover closes so it doesn't leak into the
  // next open. Commit paths (selectService / createNew) clear it themselves.
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const selected = useMemo(
    () => services.find((s) => s.id === value) || null,
    [services, value],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services.filter((s) => !q || s.name.toLowerCase().includes(q));
  }, [services, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return services.find((s) => s.name.toLowerCase() === q) || null;
  }, [services, query]);

  const showCreate = query.trim().length > 0 && !exactMatch;

  const selectService = (svc) => {
    onChange(svc.id);
    setQuery('');
    setOpen(false);
  };

  const createNew = () => {
    const name = query.trim();
    if (!name) return;
    if (services.some((s) => s.name.toLowerCase() === name.toLowerCase())) return;
    const tmpId = `svc_tmp_${Date.now()}`;
    dispatch({ type: ACTIONS.ADD_SERVICE, service: { id: tmpId, name } });
    onChange(tmpId);
    setQuery('');
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showCreate) createNew();
      else if (exactMatch) selectService(exactMatch);
      else if (visible.length === 1) selectService(visible[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const openAndFocus = () => {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="select-shell" ref={wrapRef}>
      {!open ? (
        <button type="button" className="select-trigger" onClick={openAndFocus}>
          <span className="select-trigger-text">
            {selected ? selected.name : <span className="select-placeholder">{placeholder}</span>}
          </span>
          <span className="select-trigger-caret" aria-hidden>▾</span>
        </button>
      ) : (
        <div className="select-trigger" onClick={() => inputRef.current?.focus()}>
          <input
            ref={inputRef}
            className="picker-search-input"
            placeholder="Type to search or create a new service…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="select-trigger-caret" aria-hidden>▾</span>
        </div>
      )}
      {open && (
        <div className="select-menu">
          {showCreate && (
            <button
              type="button"
              className="select-option tag-picker-create-option"
              onClick={createNew}
            >
              Create &ldquo;{query.trim()}&rdquo;
            </button>
          )}
          {!showCreate && exactMatch && query.trim() && (
            <div className="tag-picker-empty" style={{ borderBottom: '1px solid var(--border-light)', marginBottom: 6, paddingBottom: 8 }}>
              &ldquo;{query.trim()}&rdquo; already exists &mdash; pick it below.
            </div>
          )}
          {visible.length === 0 && !showCreate && (
            <div className="tag-picker-empty">No matches</div>
          )}
          {visible.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`select-option ${s.id === value ? 'on' : ''}`}
              onClick={() => selectService(s)}
            >
              {s.name}
              {s.id === value && <span className="tag-check" style={{ marginLeft: 'auto' }}>✓</span>}
            </button>
          ))}
          {!query.trim() && (
            <div className="picker-create-hint">
              Don&rsquo;t see it? Type a name to create a new service.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
