# Badge

A solid status pill: one or two words saying what state a record is in.

The colour is the meaning, so map it, never pick it:

- `statusBadgeVariant(status)` maps the app's status words: Paid, Active, Confirmed, Available → `green`; Pending, On Site, Prospect → `amber`; Overdue, Missed, Cancelled → `red`; In Progress → `blue`; Inactive, Off Duty → `slate`.
- The variance report maps its flags with `flagBadgeVariant()`: over → `red`, under → `amber`, on target → `green`, incomplete → `blue`, no baseline → `slate`.
- Conversation channels use `ChannelBadge`: SMS `green`, Email and DM `blue`, Internal `purple`.
- Company badges read one map, `DERIVED_STATUS_VARIANTS`: lead `amber`, active `green`, inactive and vendor `slate`.

## Props

- `variant`: `'green' | 'amber' | 'yellow' | 'red' | 'blue' | 'purple' | 'slate' | 'white'` (default `'slate'`).
- `children`: the label in Title Case ("In Progress").
- `style`: geometry only, never colour.

## Look

`<span class="badge {variant}">`: `3px 10px` padding, a `badge-radius` pill, 11px/600, white text on a solid fill. Each fill is the status 500 step; `blue` is the brand black. `yellow` (the Keys "Unknown" badge) carries `color-accent-yellow-700` ink; `white` is a bordered neutral chip (a pending variance row).

## Rules

- Always show the word. White on green measures 3.8:1 and the yellow badge 3.6:1, below AA at this size, so the label carries the meaning, never the colour alone.
- A badge is not a button and is never coloured by hand at a call site.
- A capability that can't be armed shows a status badge, never a dead toggle (UI_RULES §41).
