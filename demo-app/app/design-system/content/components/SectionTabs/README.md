# SectionTabs

Underline tabs for a record's detail page: one section panel shows at a time, and the active tab is underlined in gold.

## Props

- `sections`: `[{ key, label, count? }]` in tab order. `count` renders a small pill after the label.
- `activeKey`, `onSelect(key)`.
- Give each panel the id `sectionElementId(key)`. Panels stay mounted and use `hidden`, so a half-typed note survives a tab switch.

## Look

14px/600 labels in `text-muted`; the active tab turns `text-primary` over a 2px `color-brand-secondary-500` underline. A `card-border` hairline runs under the row, with 24px between tabs (16px under 900px). Count pills are 12px/600 `text-faint` on `color-brand-primary-50`.

## Rules (UI_RULES §69, §113)

- Build the tab list from what the viewer may see: a permission-gated section leaves the tabs and the panels together, never a dead tab.
- Clamp the active key, so a stale `?tab=` link never lands on a blank body.
- On narrow screens the row scrolls sideways behind a fade; it never wraps or squeezes labels.
- Use tabs once a record passes about four stacked cards; a short page stays a single scroll.
