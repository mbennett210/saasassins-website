# StatCard

A KPI tile: one big number, a short label, and an optional trend. Given `to`, the whole tile drills down to the list behind the number.

## Props

- `value`: the figure, already formatted ("18", "$3,080.00", "42.5 h"). Money always shows cents.
- `label`: sentence case ("Collected", "Cleans today").
- `trend` with `trendDirection` (`'up'` green or `'down'` red): only when there is a real prior-period basis (UI_RULES §40).
- `to`, `navState`: turn the tile into a link with a chevron. In the design-system bundle the link is inert.

## Look

A white tile with a `card-border` hairline, 12px corners and `18px 20px` padding. Value 28px/700 at line height 1.2 and −0.01em; label 11px muted; trend 11px/600. A link tile hovers to an ink hairline and lifts 1px.

## Layout

Tiles sit in `.stat-grid` (auto-fit columns of at least 160px, 10px gaps) straight on the page: no card around them (UI_RULES §1). The green up-trend measures 3.8:1 on white, so the trend always carries words, not just a colour.
