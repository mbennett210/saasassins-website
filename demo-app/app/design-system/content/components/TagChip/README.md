# TagChip

A neutral pill for one user-defined tag, optionally removable.

Every tag wears the same neutral chrome. A tag's stored colour stays in the data for compatibility and is never painted.

## Props

- `tag`: `{ id, label }`. Renders nothing without it.
- `onRemove(tag)`: optional. Renders an × that stops propagation, so a chip inside a clickable row stays safe.
- `size`: `'sm'` (default: `4px 11px`, 12px/600) or `'xs'` (`2px 8px`, 11px).

## Look

White `card-bg`, a `card-border` hairline, a `badge-radius` pill and a `text-body` label. The × is muted and turns `danger` on hover.

## Rules

Tags belong to the company (the Customer), and every row of the Contacts list can be bulk-tagged (UI_RULES §34). A status is a Badge, never a tag.
