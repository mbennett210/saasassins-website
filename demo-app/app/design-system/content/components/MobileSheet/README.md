# MobileSheet

The bottom sheet: the one surface every phone picker, filter drawer and menu opens in.

## Props

- `open`, `onClose` (a backdrop tap, Escape or the ✕ closes it), `title`, `children`.
- `footer`: a pinned action row; its buttons share the width.
- `titleAside`: rendered right after the title text, e.g. the bell's unread count.
- `actions`: header buttons beside the ✕, e.g. the bell's "Mark all read", so the sheet needs no toolbar row above its content.

## Look

A full-width white sheet (`color-surface-overlay`) with 16px top corners (`radius-xl`), `shadow-overlay` and at most 85% of the viewport's height, sliding up over `duration-base` with `ease-out`. It has a 32×4 grip, a 16px/600 title row over a hairline, `16px 20px` body padding, and a 50% slate backdrop at `z-modal`. The page behind stops scrolling while it is open.

## Rules

- It is portaled to `document.body`, so it always sits above the floating phone nav (UI_RULES §105).
- A `Modal` or `ConfirmDialog` opened from inside a sheet sits UNDER it (`z-overlay`-level 100 against the sheet's `z-modal` 400): ask inside the sheet instead (the bell's Clear all confirms in place).
- On a phone never anchor a popover to its trigger: open a sheet (THEME_CLEANSPACE R9). `PopMenu` switches between the two for you.
