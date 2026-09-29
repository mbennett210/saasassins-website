# SearchSelect

A type-to-search combobox for picking one record from a long list, with an optional second line per option (an email, an address).

## Props

- `value`, `onChange(value | null)`, `options`: `[{ value, label, sublabel? }]`. The first 50 matches show.
- `placeholder` ("Select…"), `searchPlaceholder` ("Search…"), `emptyText` ("No matches").
- `allowClear` (default true) adds a "Clear selection" row. `disabled` with `disabledText` explains why it can't open yet ("Pick a cleaner first").

## Look

It shares the contact-picker styling: a white bordered trigger (`8px 12px`, `input-radius`) and a white menu with `card-radius`, `shadow-md` and 8px padding, headed by a search field. Options hover to `inset-bg`; the chosen one sits on `primary-bg`.

## Rules

Use it in forms where the list is long enough to need search (pick a cleaner, a customer). Inside a filter bar use FilterSelect instead.
