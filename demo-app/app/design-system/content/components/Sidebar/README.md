# Sidebar

The desktop navigation rail: black, 240px wide, with a gold pill on the active row. It is the brand's signature surface.

This card shows the app's `Sidebar` markup. The component itself is wired to the router, permissions and the store, so it isn't in the bundle; rebuild it from these classes.

## Anatomy

- `.sidebar`: fixed to the left edge, `sidebar-w` (240px) wide, filled `color-brand-primary-700` with `color-neutral-100` text.
- `.sidebar-brand.sidebar-brand-image`: the white CleanSpace lockup (`assets/Logos/cleanspace-logo.png`) centred, up to 104px tall, over a 10% white hairline.
- `.nav-btn`: a 13px/500 row, `8px 16px`, a 20px icon drawn with `vector-effect: non-scaling-stroke` so strokes stay a crisp 2px (UI_RULES §110), label in `color-neutral-200`. Hover: a 16% gold wash and a near-white label. Active: a solid gold pill (`color-brand-secondary-500`, 10px radius, contained inside the rail) with the label in `color-brand-primary-700` at 600.
- Groups (`.nav-section-group`, `.nav-section-toggle`, `.nav-sub`): Sales, Operations and Finances fold under a chevron; sub-rows hang off a 12% white guide line.
- Markers on the right of a row: `.nav-review-new` (a gold NEW pill), `.nav-review-count` (a red count for Drafts).
- `.sidebar-footer`: "Report an issue" and the user switcher, under one 25% white rule (a single divider, UI_RULES §9).

## Rules

- Navigation only: feature CTAs such as New Job live on their page, never in the rail (UI_RULES §10).
- Labels are the page names in Title Case: Dashboard, Schedule, Messaging, Customers, Reports.
- At 640px and below the rail becomes a slide-in drawer and the floating glass nav takes over.
