# Modal

A centred dialog over a dimmed page, for create and edit forms.

## Props

- `open`, `onClose`: the scrim, the × and Escape all close it; with modals stacked, Escape closes only the top one.
- `title`: a verb and noun in Title Case ("Add Customer", "Log Payment").
- `size`: none (480px), `'sm'` (380px, no height floor), `'md'` (600px), `'lg'` (800px) or `'wide'` (760px, the two-column New Job form).
- `children`: the body. End a form with `.modal-actions`: Cancel (`btn-outline`) then the save action, right-aligned.

## Look

A white card with a `card-border` hairline, `card-radius` (20px), 24px padding (`card-pad-lg`) and `shadow-overlay`, over a 40% black scrim. The title is 16px/700; the × is a 28px `inset-bg` disc. The frame keeps a fixed width and a 540px minimum height so it doesn't jump as content changes (the floor drops on short screens). It scrolls vertically and never sideways (UI_RULES §103).

## Rules

- It is portaled to `document.body`, so it covers the whole shell, the phone nav included (§105).
- Anything white inside it (a preview, a list) steps down to `inset-bg` or takes a hairline (THEME_CLEANSPACE R6).
- Saving shows a toast; opening and cancelling don't.
