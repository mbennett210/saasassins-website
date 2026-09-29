# FilterSelect

A searchable single-select for filter bars: the Select look with a type-to-filter field at the top of its menu.

## Props

- `value`, `onChange(value)`.
- `options`: `[{ value, label }]`. The FIRST option is the reset row ("All cleaners", value `''`); it stays pinned while filtering, so resetting is always one click away.
- `ariaLabel`: names the facet, since there is no visible label.

Enter picks the first real match, and abandoned typing clears when the menu closes.

## Rules

Filters use FilterSelect inside a `.filter-bar`, never a plain `<select>`. Say "Customer" and "Manager" in filter labels, never "Account".
