# ListPager

The one pager under a truncated table: "Showing 21–40 of 97 invoices" with Previous and Next.

## Props

- `pager`: `{ page, totalPages, setPage, start, end, total }`. The app builds it with `usePagedRows`: 20 rows a page, the page number in the URL.
- `noun`: the plural for the count line (`'invoices'`, `'punches'`).

It renders nothing when everything fits on one page.

## Look

The count and the page label are 13px muted. The buttons are white with a hairline, 8px corners and `6px 12px` padding; disabled ones drop to 45%.

## Rules

Every data table pages at 20 rows, while totals and bulk actions still read the whole set (UI_RULES §72; the `lint:tables` gate enforces it).
