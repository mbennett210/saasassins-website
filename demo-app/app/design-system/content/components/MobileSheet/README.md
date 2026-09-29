# MobileSheet

The bottom sheet: the one surface every phone picker, filter drawer and menu opens in.

## Props

- `open`, `onClose` (a backdrop tap, Escape or the ✕ closes it), `title`, `children`.
- `footer`: a pinned action row; its buttons share the width.

## Look

A full-width white sheet (`color-surface-overlay`) with 16px top corners (`radius-xl`), `shadow-overlay` and at most 85% of the viewport's height, sliding up over `duration-base` with `ease-out`. It has a 32×4 grip, a 16px/600 title row over a hairline, `16px 20px` body padding, and a 50% slate backdrop at `z-modal`. The page behind stops scrolling while it is open.

## Rules

- It is portaled to `document.body`, so it always sits above the floating phone nav (UI_RULES §105).
- On a phone never anchor a popover to its trigger: open a sheet (THEME_CLEANSPACE R9). `PopMenu` switches between the two for you.
