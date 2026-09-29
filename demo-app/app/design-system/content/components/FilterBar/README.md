# FilterBar

The shared faceted filter bar for lists and reports: every facet in one white bar, a "Clear all (N)" link once anything is set, and an optional trailing action.

## Props

- `specs`: `FilterSpec[]`, each `{ key, label, kind, staticOptions | options(ctx), presets? }`. `kind` is `'multi'` (MultiFacet: grouped, checkable, searchable), `'single'` (FilterSelect), `'dateRange'` (DateRangeFacet: Any time, Today, 7d, 30d, 90d, This week… and Custom…) or `'toggle'` (SegmentedFacet: a small segmented pill).
- `values`, `setValue(key, value)`, `clearAll()`, `activeCount`.
- `ctx`: passed to `options(ctx)` providers.
- `action`: a trailing button pushed to the right (the schedule's New Job).

The page owns the state. In the app, `useUrlFilters` keeps every facet in the URL, so Back restores the filtered view and a facet at its default leaves the URL.

## Look

`.filter-bar`: white, `card-border`, `card-radius`, `12px 14px` padding and 12px gaps, facets bottom-aligned with 11px/600 muted labels above them. At 640px and below the bar collapses to one "Filters (N)" button that opens the facets in a bottom sheet with Clear all and Show results (THEME_CLEANSPACE R9).

## Rules

New list and report filters use this bar, never hand-rolled selects (UI_RULES §19). Facet controls share one height and baseline (§109).
