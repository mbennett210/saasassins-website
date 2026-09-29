import { useCallback, useEffect, useRef, useState } from 'react';
import { reviewNotes } from '../../lib/clientReview';
import { fmtDate } from '../../lib/dates';

// Add-only notes for a review item (question, draft or pick) — CS-402 / UI_RULES §98, §130.
// A dated, read-only list (oldest first: a legacy single `note` string shows first, then the
// add-only notes array), plus a composer: a textarea and an "Add note" button. There is NO
// edit or delete control — a note, once added, stays.
//
// An UNSENT composer draft auto-posts as a NEW note when the card unmounts (including the
// browser/hardware Back button, which pops with no blur), and on pagehide / a
// visibilitychange to hidden — so a note the client typed but didn't click "Add" on isn't
// lost when they navigate or close the tab. It never replaces an existing note: `flush`
// clears the draft ref before posting, so unmount + pagehide firing together can't double-post.
export default function ReviewNotes({ entry, onAdd, placeholder = 'Add a note (saved for everyone)' }) {
  const notes = reviewNotes(entry);
  const [draft, setDraft] = useState('');

  // Latest draft + onAdd for the lifecycle flushers, kept in refs so the (once-registered)
  // unmount/pagehide handlers always read the current values with no stale closure.
  const draftRef = useRef('');
  const onAddRef = useRef(onAdd);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { onAddRef.current = onAdd; }, [onAdd]);

  // Post the current draft as a NEW note, once. Clearing the ref first makes a second flush
  // (unmount after a pagehide, say) a no-op — add-only, never a replace.
  const flush = useCallback(() => {
    const t = draftRef.current;
    if (!t || !t.trim()) return false;
    draftRef.current = '';
    onAddRef.current(t);
    return true;
  }, []);

  // Auto-post on unmount (covers the browser Back button — popstate unmounts with no blur).
  useEffect(() => () => { flush(); }, [flush]);
  // Auto-post on pagehide and when the tab is hidden (a tab close / switch that isn't an unmount).
  useEffect(() => {
    const onHide = () => flush();
    const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [flush]);

  const post = () => { if (flush()) setDraft(''); };

  return (
    <div className="review-notes">
      {notes.length > 0 && (
        <ul className="review-notes-list">
          {notes.map((n, i) => (
            <li key={i} className="review-note-item">
              <span className="review-note-text">{n.text}</span>
              {n.at && <span className="review-note-at">{fmtDate(n.at)}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="review-note-compose">
        <textarea
          className="input textarea-sm review-note-input"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" className="btn btn-secondary review-note-add" onClick={post} disabled={!draft.trim()}>
          Add note
        </button>
      </div>
    </div>
  );
}
