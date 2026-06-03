import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { selectSnippetFolders, selectSnippetsForChannel } from '../store/selectors';
import Icon from './Icon';

// Popover opened from a compose-bar icon. Shows snippets grouped by folder,
// filtered by the active channel (snippets with channel='all' always appear).
// Clicking a snippet fires `onInsert({ id, body })` and closes the popover.
export default function SnippetPicker({ channel, onInsert, disabled = false }) {
  const state = useStore();
  const folders = selectSnippetFolders(state);
  const channelSnippets = selectSnippetsForChannel(state, channel);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channelSnippets;
    return channelSnippets.filter((s) =>
      s.label.toLowerCase().includes(q) || s.body.toLowerCase().includes(q)
    );
  }, [channelSnippets, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    folders.forEach((f) => map.set(f.id, { folder: f, items: [] }));
    map.set('_none', { folder: { id: '_none', label: 'Unfiled' }, items: [] });
    filtered.forEach((s) => {
      const bucket = map.get(s.folderId) || map.get('_none');
      bucket.items.push(s);
    });
    return Array.from(map.values()).filter((g) => g.items.length > 0);
  }, [folders, filtered]);

  const insert = (snippet) => {
    onInsert({ id: snippet.id, body: snippet.body });
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="snippet-picker" ref={wrapRef}>
      <button
        type="button"
        className="snippet-trigger btn btn-success btn-sm"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Insert snippet"
        aria-label="Insert snippet"
      >
        <Icon name="edit" size={14} />
        <span>Snippet</span>
      </button>
      {open && (
        <div className="snippet-popover" role="dialog" aria-label="Snippet library">
          <div className="snippet-popover-head">
            <input
              className="input"
              placeholder="Search snippets…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <div className="snippet-popover-body">
            {grouped.length === 0 ? (
              <div className="snippet-empty">No snippets match.</div>
            ) : grouped.map((g) => (
              <div key={g.folder.id} className="snippet-group">
                <div className="snippet-group-title">{g.folder.label}</div>
                {g.items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="snippet-option"
                    onClick={() => insert(s)}
                  >
                    <div className="snippet-option-label">{s.label}</div>
                    <div className="snippet-option-body">{s.body}</div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
