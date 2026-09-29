# Toast

A short confirmation card in the bottom-right corner that appears only after an explicit save.

Toasts come from the provider, not from markup: wrap the app in `ToastProvider`, then `const toast = useToast()` and call `toast.success(message, opts)`, `toast.error(...)` or `toast.info(...)`. `opts.duration` defaults to 3000ms (0 keeps it until dismissed). At most five show at once; the oldest drops.

## When to toast (UI_RULES §8)

- Yes: Add, Edit and Save in a modal or on a page ("Note added", "Job updated", "Tag added"), form-shaped submissions, and every error or failed validation.
- No: status changes (mark paid, archive, delete), toggles, bulk actions, drag and drop, copy and export. The UI updating is the confirmation. When unsure, don't toast.

## Copy

Past tense, no exclamation marks, usually two or three words: "Note added", "Signature saved". Errors say what to do next: "Enter an amount", "Enter a valid email address.", "Could not read that image."

## Look

A `card-bg` card with a `card-border` hairline, `card-radius`, a 4px left rule, 13px/500 text and `shadow-overlay`, 280 to 440px wide. Success tints `color-semantic-success-50` with a green rule, error tints `color-semantic-error-50` with a red rule, info sits on `primary-bg` with an ink rule. The stack is fixed 20px from the bottom-right corner.
