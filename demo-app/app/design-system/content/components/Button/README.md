# Button

The `.btn` class family: every action in the app is a `<button class="btn btn-{role}">`, filled by its role.

There is no Button component. Buttons are plain elements styled by `components/bundle.css`, so they take any children and any native attribute.

## Roles (UI_RULES §11)

| Class | Fill | Use it for |
|---|---|---|
| `btn-primary` | brand black (`primary`), white label | The default CTA and record-state actions: Save Changes, Edit, Mark Done, Add Customer. |
| `btn-gold` | gold (`color-brand-secondary-500`), ink label at 600 | The affirmative or co-primary CTA. Prefer it in new code: Import CSV, Message, Start. |
| `btn-success` | identical to `btn-gold` | Legacy name for the same gold button. **There are no green buttons.** |
| `btn-danger` | `color-semantic-error-500`, white label | Destructive or irreversible: Delete, Cancel Job, Reject. |
| `btn-secondary` | white `card-bg` with a `card-border` hairline | A neutral filled action, for a low-stakes negative such as No-show. |
| `btn-outline` | transparent, ink label, hairline | Only Cancel in modal and inline-edit rows, a bulk-bar Clear, and tiny in-section utilities (Add line). Never a CTA. |

Pairs: create + helper is `btn-primary` + `btn-gold`; edit + delete is `btn-primary` + `btn-danger`; a detail-page triad is gold + primary + danger (Message, Edit, Delete).

## Sizes

- `.btn`: 32px tall (`btn-height`, the `control-height-sm` tier), `0 16px` padding, 13px/600, `btn-radius` (10px), 6px between icon and label. The one action-button height.
- `.btn-sm`: 28px (`btn-height-sm`, the `control-height-xs` tier), `0 12px`, 12px (`font-size-xs2`). Only in data-table rows and dense clusters (segmented toggles, the schedule date nav, the schedule timeline's Reschedule, the compose bar).
- Relatives: `.btn-icon` (a 28px bordered square; 40px on phones), `.btn-link` (a quiet 12px text button in `text-muted`, `6px 8px`, that tints `primary-bg` on hover), `.linklike` (an inline navy link in `color-link`, normal weight).

## States

Hover deepens black to `primary-hover` and gold to `color-brand-secondary-600`, and lifts a filled button by 1px. Disabled is 50% opacity at the same height. Keyboard focus shows the browser's default ring; `.btn` defines no focus style of its own.

## Rules

- The label is a verb, with its noun for page and modal CTAs, in Title Case: "Add Customer", "Record Payment", "Save Changes". No "+" prefix and no plus icon: the verb carries it (§12).
- Every `.btn` carries a role class. A bare `.btn` paints nothing (§115).
- Buttons in a row share one height; never stretch a button to match an input beside it (§13, §16).
- Green (`success`) is status only and never fills a button or any control.
