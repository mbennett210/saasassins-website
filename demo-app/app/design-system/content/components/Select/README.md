# Select

The themed dropdown that replaces a native `<select>`: a field-styled trigger whose menu reads as one box with it.

## Props

- `value`, `onChange(value)`, `options`: `[{ value, label }]`.
- `placeholder` (default "Select…"), `disabled`, `ghost` (borderless until hover, for inline edits), `id`, `ariaLabel` (also the phone sheet's title).

## Behaviour

On desktop the menu drops from the trigger and the seam between them disappears, so trigger and menu share one 2px ink edge (`border-width-md`), with `shadow-overlay`. A tap outside only closes it; it never also activates what was underneath (UI_RULES §100). At 640px and below the options open in a bottom sheet above the nav instead (§105, §114).

## Look

The trigger matches `.input` exactly (field fill, 2px edge, `9px 12px`, 14px) plus a ▾ caret that flips while open. Options are 14px at `8px 10px` with 6px corners; hover is `primary-bg`, the selected option `primary-soft` at 600.

## Rules

Use Select wherever a form needs a fixed list. For a long or searchable list use FilterSelect in a filter bar, or SearchSelect in a form.
