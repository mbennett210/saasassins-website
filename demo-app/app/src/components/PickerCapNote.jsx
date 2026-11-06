import { useT } from '../i18n/react';

// A capped picker's footnote (UI_RULES §127): "Showing 50 of 1,540. Type to narrow." — what is
// not on screen and how to reach it, in the reader's language. ONE component for every picker
// that caps (FilterSelect, SearchSelect, CrewPicker, ContactPicker, ClientNamePicker; CS-723:
// three of them cut names off in silence). Not an option: a plain paragraph — no role, no hover,
// no click. Each picker renders it AFTER its list, so it reads as a footnote, and its menu's
// CSS pins it right under the search field (`.select-search-more`, index.css), where it is seen
// without scrolling 50 rows. `note` is capOptions' `noteMsg`; nothing renders without one.
export default function PickerCapNote({ note }) {
  const t = useT();
  return note ? <p className="select-search-more">{t(note)}</p> : null;
}
