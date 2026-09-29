# Table

The data table: a black header band over white and zebra rows, gold on hover, inside its own hairline frame.

These are CSS classes from `components/bundle.css`; the app renders tables as plain `<table>` markup.

## Anatomy (UI_RULES §72, THEME_CLEANSPACE R2)

- `.table-head`: the title (`.table-head-title`, 16px/700) over `.table-controls`, with `TableSearch` on the left, a `.table-count` chip while searching, then a `.spacer` and any period pills.
- `.table-wrap`: the frame itself (`card-bg`, `card-border`, `card-radius`), scrolling sideways when it must. Never wrapped in a `.card`.
- `th`: the band. `table-header-bg` (black) with `table-header-fg` labels at 11px/600 uppercase, 0.04em, `10px 12px`.
- `td`: 13px `text-body`, 12px padding, `border-light` rules. Odd rows `table-row-odd`, even rows `table-row-even`, hover `table-row-hover` (18% gold).
- Cell helpers: `.name` (600, `text-primary`), `.money` (600, tabular figures, no wrap), `.truncate` (one line, the full value in `title`), `.text-right`.
- `ListPager` underneath: 20 rows a page.

## Rules

- A row action gets its own trailing column, right-aligned, so every button of its kind forms one vertical line (R4). A row without the action leaves the cell empty.
- Numbers use tabular figures (§67). Dense rows may use `btn-sm`.
- At 640px and below a `.table-wrap.mobile-stack` turns each row into a card: mark the lead cell `cell-primary`, give every other cell a `data-label`, mark actions `cell-actions` and pure chevrons `cell-chevron` (UI_RULES §24).
