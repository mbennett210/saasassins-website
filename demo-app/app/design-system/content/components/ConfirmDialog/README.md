# ConfirmDialog

A small modal that asks for confirmation before an action that can't be undone.

## Props

- `open`, `onClose`, `onConfirm` (the dialog closes itself after confirming).
- `title` (default "Are you sure?"), `message` (exactly what will happen), `confirmLabel` (default "Confirm"), `cancelLabel` (default "Cancel").
- `variant`: `'default'` (a black confirm) or `'danger'` (a red confirm).

## Look

A 380px `sm` modal with no height floor. The message is 13px `text-body` at line height 1.5; Cancel (`btn-outline`) sits left of the filled action.

## Rules

Name the thing and the consequence ("INV-1047 and its 2 payments will be removed. This can't be undone."). Use `danger` for deletes. When a bulk action would skip some of the selection, say so here, before the user commits.
