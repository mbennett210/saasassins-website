# Interaction rules

How Clean Space behaves, condensed from the app's UI rules. The section numbers point back to `UI_RULES.md` in the codebase.

## Saving and feedback

- **Toasts only confirm saves** (§8): Add, Edit and Save in a modal or on a page, plus every error. Status changes, toggles, bulk actions, drag and drop, copying and exporting never toast.
- **Switches save silently** the moment they flip; there is no Save button behind a toggle (§101, §102).
- **Cards that edit a record are read-first** (§101): values show as text with one "Edit" button; editing flips them into bordered fields with a Cancel and Save Changes bar. Whole settings pages are the exception: one form, always editable, one Save.
- **Don't offer what the server will refuse** for this viewer: the control is off and the reason is written under it, never only in a tooltip (§118). A capability that can't be switched on shows a status badge, not a dead toggle (§41).
- **A report reads its whole window or shows an error** with Try again. Never show a partial or failed read as data or as "No results" (§117).

## Navigation

- **Back returns where you came from** (§108): every link into a detail page passes its referrer, and the page has exactly one back control, the `.detail-back` pill.
- **Lists keep their state in the URL**: filters, search (`?q=`), page (`?page=`) and the open tab (`?tab=`), so Back and shared links restore the exact view.
- **A person is not a destination** (§70): contacts are edited in their company's Contacts tab; names render as plain text, and links point at the company.
- **Global search** is one surface for pages, actions and records, opened from the top bar or ⌘K / Ctrl K, and it shows only what the viewer may open (§116).

## Lists and tables

- **Tables page at 20 rows** with search and a pager; totals and bulk actions still use the full set (§72).
- **People are always sorted by name** (§51).
- **Bulk bars persist** once shown: with nothing selected they keep their place with neutral text, so selecting never shifts the page (§3). Rows offer a ⋯ menu; the header checkbox switches the list into bulk-select (§99).
- **Row actions sit in their own trailing column**, aligned down the table (THEME_CLEANSPACE R4).
- **Long text truncates** to one line with the full value on hover (§28).

## Overlays and pickers

- **A tap outside a menu only closes it**; it never also activates what was underneath (§100).
- **Every picker uses the shared panel**: an anchored popover on desktop, a bottom sheet on a phone (§114).
- **Modals and sheets are portaled to the page body**, so they sit above everything, the phone nav included (§105). Modals never scroll sideways (§103).
- **Recurring cleans ask for scope** (this one or the whole series) before any edit or delete (§49).

## Phones

- At 640px and below: tables become stacked cards, filter bars become one "Filters (N)" sheet, pickers open as bottom sheets, and page heads stack with full-width buttons.
- Icon buttons and inline link buttons grow to 40px tap targets.
- Scroll areas show no scrollbar (§106); fields render at 16px so iOS never zooms; nothing scrolls the page sideways.
