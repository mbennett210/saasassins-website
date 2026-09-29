# FormField

A labelled form control: the label above, the field, then an error or a help line.

## Props

- `label`, `name` (the control's id becomes `ff-{name}`), `required` (adds a red asterisk).
- `as`: `'input'` (default, with `type`), `'textarea'` (with `rows`, default 3) or `'select'`, which renders the themed `Select`; `onChange` still receives an event-shaped `{ target: { value, name } }`. `disabled` and `ghost` pass through to that Select; every other prop lands on the input.
- `options` for a select: strings or `{ value, label }`.
- `error`: a red 11px line that replaces the help. `help`: a muted 11px line.
- `children`: pass your own control instead of using `as`.

## Look

`.form-label` is 11px/600 uppercase at 0.04em, muted, 4px above the field. `.input` has a `field-bg` fill, a 2px `card-border` edge, `input-radius`, `9px 12px` padding and 14px text; on focus the fill turns white and the edge turns ink. `.form-group` spaces fields 14px apart, and `.form-row` sets two side by side (one column on phones, where fields also grow to 16px text so iOS doesn't zoom).

## Rules

- Adjacent controls share height, radius, border and baseline, which you get by using these primitives unmodified (UI_RULES §109).
- Placeholders are faint hints in `color-neutral-400`, never example values that could pass for filled ones.
- Required fields are checked on submit, with a toast naming what is missing ("Enter an amount").
