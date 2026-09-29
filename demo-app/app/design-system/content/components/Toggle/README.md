# Toggle

An on/off switch that saves the moment it flips: no Save button and no toast (UI_RULES §8).

## Props

- `on`, `onChange(next)`.
- `disabled`: locked. It still shows its state but can't change, at 55% opacity (for example, notifications a crew member must receive).

## Look

A 36×20 pill with a 16px white knob. On is the brand black; off is `color-neutral-300`. The off track measures 1.5:1 against white, so the knob's position is what tells the state, together with the row's label.

## Rules

- A capability that can't be armed shows a status Badge, never a dead toggle (§41).
- Permission matrices use switches, never checkboxes (§102). The Roles page's own `.rp-toggle` adds a mixed state: a centred `color-neutral-500` knob.
