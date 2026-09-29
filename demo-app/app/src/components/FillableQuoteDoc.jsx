// The interactive fillable proposal. Renders the shared quote template (the same
// HTML used for the public view + the server PDF). In edit mode the `*marked*`
// fields carry `contenteditable` baked into the markup (see quoteTemplate.js), so
// they're editable the instant they render — there is NO post-mount activation
// step (that step silently failed in the prod build and left every field dead).
//
// Autosave is wired by ONE delegated React onInput handler on the wrapper: input
// events bubble up from the contenteditable field spans, so a single listener
// catches them all — nothing to attach per-span. The HTML is built once (useState
// initializer) so typing never resets the cursor. Mount fresh per quote with
// key={quote.id}.
import { memo, useRef, useState } from 'react';
import { buildQuoteHtml, mmddyyFromISO } from '../lib/quoteTemplate.js';

function FillableQuoteDoc({ fields, locked = false, opts = null, onFieldChange }) {
  const hostRef = useRef(null);
  const [html] = useState(() => buildQuoteHtml(fields || {}, { locked, ...(opts || {}) }));

  const fieldOf = (target) => (target?.closest ? target.closest('.qfield[data-field]') : null);

  const handleInput = (e) => {
    // The cover-letter date is an <input type="date"> (not a .qfield) — capture its
    // value as MM/DD/YY here too, since 'input' is the most reliable React path.
    if (e.target?.matches?.('input.qdatefield')) {
      onFieldChange?.('date', e.target.value ? mmddyyFromISO(e.target.value) : '');
      return;
    }
    const span = fieldOf(e.target);
    if (!span) return;
    const key = span.getAttribute('data-field');
    const val = span.textContent;
    onFieldChange?.(key, val);
    // Keep duplicate spans for the same field (e.g. client name on the cover + in
    // the letter) in sync, without disturbing the one being typed in.
    const root = hostRef.current;
    if (root) {
      root.querySelectorAll(`.qfield[data-field="${CSS.escape(key)}"]`).forEach((s) => {
        if (s !== span && s.textContent !== val) s.textContent = val;
      });
    }
  };

  // Single-line fields: Enter commits + blurs instead of inserting a newline.
  const handleKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    const span = fieldOf(e.target);
    if (span) { e.preventDefault(); span.blur(); }
  };

  // Strip rich formatting on paste — keep field values plain text.
  const handlePaste = (e) => {
    const span = fieldOf(e.target);
    if (!span) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, text);
  };

  // The cover-letter date is an <input type="date"> (not a contenteditable .qfield),
  // so it's handled here on change: store the picked date as MM/DD/YY, which is what
  // the document prints. handleInput ignores it (it's not a .qfield).
  const handleChange = (e) => {
    const t = e.target;
    if (t?.matches?.('input.qdatefield')) {
      onFieldChange?.('date', t.value ? mmddyyFromISO(t.value) : '');
    }
  };

  return (
    <div className="quote-doc-stage">
      <div
        className="qdoc-host"
        ref={hostRef}
        onInput={locked ? undefined : handleInput}
        onChange={locked ? undefined : handleChange}
        onKeyDown={locked ? undefined : handleKeyDown}
        onPaste={locked ? undefined : handlePaste}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

// Memoized so an edit (which changes `fields`/`onFieldChange` on the parent) does
// NOT re-render this component. A re-render makes React reconcile its
// dangerouslySetInnerHTML over the user-mutated contentEditable DOM — which wiped
// typed text and crashed on rapid typing. Only a locked-state flip rebuilds the doc.
export default memo(FillableQuoteDoc, (prev, next) => prev.locked === next.locked);
