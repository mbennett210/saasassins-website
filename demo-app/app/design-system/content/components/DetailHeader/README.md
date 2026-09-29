# DetailHeader

The header of a record page: the back pill, the record's name with its status, and the record's actions.

## Props

- `backTo`, `backLabel`: the fallback destination and label, used only on a direct visit. A referrer in `location.state.from` / `fromLabel` wins, so Back returns to wherever the user came from.
- `title`, `subtitle` (a customer number such as `#1042`, or an address), `badge` (a Badge or status menu beside the title).
- `actions`: filled buttons on the right. `relationship`: an optional chip row under the subtitle.

## Look

`.detail-back` is a resting pill: `inset-bg`, `radius-full`, 12px muted text reading `← Customers`, hovering to `primary-soft`. The title is 22px/700 at line height 1.2, the subtitle 13px muted. Actions wrap with 8px gaps and take the full width at 640px and below.

## Rules

- One back affordance per page, and it is always this pill (UI_RULES §108): never a `.btn` or a text link.
- In the design-system bundle, navigation is an inert stand-in; in the app it routes through react-router.
