import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { THREAD_TITLE_MAX } from '../store/reducer';

// Inline rename for an internal team thread's name. Click the title (or its
// pencil) to edit in place: commit on blur, Enter commits, Escape reverts, and
// a blank or unchanged value reverts silently.
//
// No toast — per UI_RULES §8 an inline blur-commit isn't a modal save; the name
// changing in the header and the thread-list row IS the confirmation.
//
// Ownership is the CALLER's job: pass canEdit from selectCanRenameThread so the
// creator-only rule (plus the Super-Admin-on-orphans exception) has exactly one
// definition. When canEdit is false this renders plain, non-interactive text.
export default function ThreadTitleEditor({
  title,
  canEdit,
  onRename,
  placeholder = 'Team discussion',
  className = '',
  inputClassName = '',
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title || '');
  const inputRef = useRef(null);

  // Re-sync when the thread changes under us (switching threads reuses this
  // component) or when another tab renames it through the shared blob.
  useEffect(() => { setDraft(title || ''); }, [title]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  // Losing the right to edit mid-flight (e.g. an orphan's creator is
  // reactivated) must not strand an open input.
  useEffect(() => { if (!canEdit) setEditing(false); }, [canEdit]);

  const display = title || placeholder;

  if (!canEdit) return <span className={className}>{display}</span>;

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) { setDraft(title || ''); return; }
    onRename(trimmed);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`input thread-title-input ${inputClassName}`}
        value={draft}
        maxLength={THREAD_TITLE_MAX}
        aria-label="Channel name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          // Revert the draft BEFORE unmounting the input: whether or not blur
          // fires on unmount, commit() then sees an unchanged value and no-ops.
          if (e.key === 'Escape') { setDraft(title || ''); setEditing(false); }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={`thread-title-btn ${className}`}
      onClick={() => setEditing(true)}
      title="Rename this channel"
    >
      <span className="thread-title-text">{display}</span>
      <Icon name="edit" size={13} />
    </button>
  );
}
