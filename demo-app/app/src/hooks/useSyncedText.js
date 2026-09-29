import { useState, useRef, useEffect } from 'react';

// A focus-aware controlled text field synced to shared state. Use it for any save-on-blur
// text box whose committed value can change UNDER the user: another seat editing the same
// field (the review layer is the shared org_state blob under one login — the realtime
// org_state_signal channel and the backstop poll both land remote edits), or a programmatic
// reset like "Clear answer". `saved` is the committed value; `onSave(text)` commits the draft.
// Returns props to SPREAD onto a controlled <textarea>/<input> (value/onChange/onFocus/onBlur).
//
// Rules:
//   • the draft starts from `saved`;
//   • when `saved` changes under us, adopt it into the draft AT ONCE — UNLESS the user is
//     focused AND has unsaved edits (draft ≠ the value it started from), in which case their
//     typing is kept and never clobbered;
//   • on blur, save only if the draft differs from `saved`;
//   • on UNMOUNT, flush a dirty draft — the browser/hardware Back button (popstate) unmounts
//     the focus card and React fires NO blur, so a save-on-blur box would silently drop the
//     text (NC-A). Only writes when dirty (just viewing and leaving never restamps `at`), and a
//     blur-save then unmount doesn't double-write (the draft already equals saved by then).
//
// Mount ONE instance per item (`key={id}`) so switching items shows the right value. Do NOT
// key on the saved text: that remounts the box mid-typing when a remote edit lands and drops
// the keystrokes (the round-3 NC-1 regression this replaces).
export function useSyncedText(saved, onSave) {
  const [draft, setDraft] = useState(saved);
  const [focused, setFocused] = useState(false);
  // The `saved` value the current draft started from — lets us tell a real remote change from
  // the user's own typing. Adjust-state-during-render (a documented React pattern): reconcile
  // synchronously so a remote edit shows in the same commit, with no post-paint flash.
  const [base, setBase] = useState(saved);
  if (saved !== base) {
    setBase(saved);
    // Adopt the new saved value unless the user is focused with unsaved edits (dirty).
    if (!(focused && draft !== base)) setDraft(saved);
  }

  // Latest draft / saved / onSave for the unmount flush, kept current in an effect (not
  // written during render) so the cleanup closes over the freshest values with no stale ref.
  const latest = useRef({ draft, saved, onSave });
  useEffect(() => { latest.current = { draft, saved, onSave }; });
  useEffect(() => () => {
    const l = latest.current;
    if (l.draft !== l.saved) l.onSave(l.draft); // flush a dirty draft on unmount (NC-A)
  }, []);

  return {
    value: draft,
    onChange: (e) => setDraft(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      if (draft !== saved) onSave(draft);
    },
  };
}

export default useSyncedText;
