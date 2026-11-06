# Sidebar

The desktop navigation rail, the Launcher (UI_RULES §182, Matt's Option D): black, 240px wide, a few rows, then the SECTIONS, each opening a panel of its pages beside the rail. It is the brand's signature surface.

This card shows the app's `Sidebar` markup. The component itself is wired to the router, permissions and the store, so it isn't in the bundle; rebuild it from these classes. The sections and their groups are one table by path, `lib/navData` `LAUNCHER_SECTIONS`.

## Anatomy

- `.sidebar`: fixed to the left edge, `sidebar-w` (240px) wide, filled `color-brand-primary-700` with `color-neutral-100` text.
- `.sidebar-brand.sidebar-brand-image`: the white logo lockup centred, up to 104px tall, over a 10% white hairline.
- `.nav-btn`: a row above the sections (the owner's and an admin's Dashboard and Messaging; a manager's and a supply manager's own rows, §152, §169). 13px/500, `8px 16px`, a 20px icon drawn with `vector-effect: non-scaling-stroke` so strokes stay a crisp 2px (UI_RULES §110). Active: a solid gold pill (`color-brand-secondary-500`) with the label in `color-brand-primary-700` at 600. `.nav-divider` is the line under them.
- `.launcher-cat`: a section row. A 32px tile with its 20px glyph (`.launcher-cat-tile`), the section's name, and one line of what is in it (`.launcher-cat-blurb`: its groups, or its own line, or its pages), its count, a chevron. The row whose section holds the page on screen wears the gold tile (`.has-on`); the open one a lighter fill (`.open`).
- `.launcher-panel`: the dialog beside the rail, 10px right of its row, two columns (`data-cols="2"`, 560px) when its section shows two groups and has the room, one (300px) otherwise. A head (the name, how many pages, the X), then `.launcher-col` per group with its caption (`.launcher-cap`), every page a `.launcher-tile`: a 16px glyph in a 32px tile, its name with its count or NEW pill, and one line of what it is for. A column's tiles sit 4px apart.
- Pills: `.nav-review-new` (a gold NEW pill), `.nav-review-count` (a count; with `.nav-review-dot` for something new). No page carries a review marker (UI_RULES §185).
- `.sidebar-footer`: Settings and Review side by side (`.sidebar-util-row`, one to a row when a word won't fit), Settings, and Review with its count; then `.sidebar-foot-row`, the account chip beside two icon buttons (`.sidebar-icon-btn`), Scan a QR code and Report an issue. One divider above it (UI_RULES §9).

## Rules

- Navigation only: feature CTAs such as New Job live on their page, never in the rail (UI_RULES §10).
- A new page gets a description and its place in one group of `LAUNCHER_SECTIONS`; one the table misses shows in a last "More" section, and `test-launcher-nav.mjs` fails until it is placed.
- The panel grows out of its row (220ms) and goes back into it (160ms), turns round mid-way, and closes on Esc, a click outside, its X, a new page, the rail scrolling, or focus leaving the rail.
- Labels are the page names in Title Case: Dashboard, Schedule, Messaging, Customers, Reports.
- At 640px and below the rail becomes a slide-in drawer and the floating glass nav takes over; the phone's bar and menu keep their own shape.
