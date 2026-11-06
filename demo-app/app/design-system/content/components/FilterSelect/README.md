# FilterSelect

A searchable single-select for filter bars: the Select look with a type-to-filter field at the top of its menu.

## Props

- `value`, `onChange(value)`.
- `options`: `[{ value, label }]`. The FIRST option is the reset row ("All cleaners", value `''`); it stays pinned while filtering, so resetting is always one click away.
- `ariaLabel`: names the facet, since there is no visible label.
- `maxVisible` (optional): how many matches RENDER. It is capped **by default** at `PICKER_MAX_VISIBLE` (50): it filters first and caps second, so typing still reaches every option, and the rows past the cap are counted in a plain, non-selectable footnote under the search field (`Showing 50 of 1,500. Type to narrow.`). A short list never reaches the cap, so nothing shows for it. The number and the sentence live in `lib/pickerOptions` (`PICKER_MAX_VISIBLE`, `capOptions`) — never retyped at a call site, and never turned off.
- `float` (optional): for a picker in a TABLE ROW. The menu is drawn at the trigger through a portal in fixed position (PopMenu `float`), below it or above it, whichever has the room, so the table's sideways scroller never cuts it off on a bottom row; the trigger keeps its own corners and the menu is its own box, 4px off it. On a phone it is the sheet, as always.

Enter picks the first real match **of what is on screen**, so it can never choose a row the cap is hiding; abandoned typing clears when the menu closes.

## Rules

Filters use FilterSelect inside a `.filter-bar`, never a plain `<select>`. Say "Customer" and "Manager" in filter labels, never "Account".

A picker over people or the book is FilterSelect (or another capping kit picker), never a native `<select>`: at this build's real scale — 1,500 cleaners, 750 customers, ~3,750 checklists — a select of every login is unsearchable and, on a list, repeated on every row (UI_RULES §127). People come from `personOptions` (active, alphabetical, optionally the office only). `test-picker-cap.mjs` fails a new picker that lists the team or the book without capping.
