# EmptyState

What a list, tab or panel shows when it has nothing in it: an icon disc, a title, one line of help, and optionally the action that fills it.

## Props

- `icon`: usually `<Icon name="…" size={28} />`, the list's own icon.
- `title`: what is missing: "No customers yet", "No contacts yet", "No matches".
- `message`: one sentence with the next step: "Add your first customer, or Import CSV to bring in your whole book."
- `action`: optional, a filled button ("New Job").

## Look

A centred column with `48px 24px` padding. A 56px `inset-bg` disc holds the muted icon; the title is 14px/600 `text-primary`; the message 12px muted, at most 320px wide.

## Rules

- Say what is missing and what to do; no blame, no exclamation marks.
- When a search matches nothing but the list isn't empty: `icon="search"`, "No matches", "Try clearing filters or changing search."
- A failed read is an error with Try again, never an empty state (UI_RULES §117).
