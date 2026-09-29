# Card

The containers: `.card` for a page-level block, `.detail-card` for a section of a record page, and the wells that sit inside them.

These are CSS classes from `components/bundle.css`; there is no Card component.

## Levels (THEME_CLEANSPACE R1, R6)

- The page ground is `page-bg` (L1). Cards are white `card-bg` (L2) with a `card-border` hairline and `card-radius` (20px): they separate by elevation, never by a shadow.
- A well, or a container that holds row-cards, drops to `inset-bg` (L0).
- Nothing sits on a parent of its own colour. Where a level step is impossible, a hairline is mandatory.

## Anatomy

- `.card`: 20px padding, 14px below. `.detail-card`: 18px padding. Stacked detail cards sit 12px apart; side by side in `.detail-grid` (2fr and 1fr) they stretch to equal height (UI_RULES §111).
- Header: `.overview-card-head` holds the `h3` (13px/600 `text-primary`) and one button labelled exactly "Edit". Editing flips the values into bordered inputs with a Cancel and Save Changes bar (§101).
- Values: `dl.detail-dl`, a 110px term column (14px/500 muted) beside 14px `text-primary` values. A secondary line demotes by colour, never by a smaller size (§112).
- A sub-head inside a card uses the eyebrow `.form-label` (11px/600 uppercase).

## Rules

Don't wrap a lone table, stat grid or list in a card: it already has a frame (UI_RULES §1). Its heading stands on its own above it (§2).
