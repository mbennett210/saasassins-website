# TableSearch

The search field in a list table's header: a magnifier, the text, and a clear ×.

## Props

- `value`, `onChange(text)`: controlled. The app keeps the text in the URL as `?q=` so Back restores the search.
- `placeholder` (default "Search"), `ariaLabel`.

## Look

A `field-bg` fill with a `card-border` hairline, `input-radius`, `8px 12px` padding, 220 to 320px wide. 13px text with a `color-neutral-400` placeholder; the × shows only when there is text. Focus turns the edge ink and adds the field ring, `input-focus-shadow` (UI_RULES §119).

## Rules (UI_RULES §72)

It sits first in `.table-controls`, under the table's title. While a query is active, show a `.table-count` chip ("3 of 48"). Matching is case-insensitive and every word must match.
