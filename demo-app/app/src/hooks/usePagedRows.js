import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// Table row truncation — THE ONE implementation (Daniel, 2026-07-27: "We need to truncate
// all of the tables… Default of 20 rows per tab. Do this throughout the app").
//
// Before this there were three ad-hoc pagers at three different page sizes (Clients 25,
// Invoices 25, marketing Sequences 10) and twenty-odd tables with none at all — every one
// of which rendered its entire collection, so a real Jobber import would have painted
// thousands of rows on first open.
//
// 🔴 TWENTY IS THE DEFAULT AND IT LIVES HERE. Do not retype the number at a call site;
// import the constant or omit the option. A page size copied by hand is how the 25/25/10
// drift happened in the first place.
export const DEFAULT_PAGE_SIZE = 20;

// Where the page number lives, and why it is a choice:
//   `param` given → the URL (`?cpage=3`), matching CLAUDE.md's "list pages keep filter
//     state in the URL" rule, so Back restores the exact page the user was on and a
//     referrer link is meaningful.
//   `param` omitted → local state, for tables inside a modal or a detail panel where a
//     URL parameter would leak a transient scroll position into the address bar and
//     survive the modal closing.
//
// Every filter control must reset the page to 1 — see `resetKey`. Filtering a 5-page list
// down to 1 page while sitting on page 4 renders an empty table, which reads as "no
// results" for a filter that actually matched plenty. `resetKey` is the guard: pass
// whatever the filters derive to and the page snaps back whenever it changes.
export function usePagedRows(rows, { param, pageSize = DEFAULT_PAGE_SIZE, resetKey } = {}) {
  // Always called — every surface in this app renders inside <BrowserRouter> (App.jsx),
  // and a hook cannot be called conditionally. The result is simply ignored for the
  // local-state variant.
  const [searchParams, setSearchParams] = useSearchParams();
  const [localPage, setLocalPage] = useState(1);
  const [seenResetKey, setSeenResetKey] = useState(resetKey);

  const total = rows?.length || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const rawPage = param
    ? parseInt(searchParams.get(param) || '1', 10) || 1
    : localPage;

  // Derive the reset DURING render rather than in an effect: an effect would paint one
  // frame of the wrong (empty) page first, and that flash is the bug this prevents.
  const resetting = resetKey !== undefined && resetKey !== seenResetKey;
  if (resetting) setSeenResetKey(resetKey);

  // Clamped, so a stale `?cpage=9` from a wider filter — or a page that emptied when rows
  // were deleted — lands on the last real page instead of rendering nothing.
  const page = resetting ? 1 : Math.min(Math.max(1, rawPage), totalPages);

  const setPage = (next) => {
    const clamped = Math.min(Math.max(1, next), totalPages);
    if (!param) { setLocalPage(clamped); return; }
    const params = new URLSearchParams(searchParams);
    if (clamped <= 1) params.delete(param); else params.set(param, String(clamped));
    // `replace` matches the setParam convention used by every other list filter: paging
    // must not stack history entries the Back button then has to walk through.
    setSearchParams(params, { replace: true });
  };

  // Jump to whatever the last page turns out to be. For an EDITABLE table this is what
  // an "Add line" must call: the new row lands at the end, and on a full page that end
  // is on a page the user is not looking at — a row you just created and cannot see
  // reads as the button being broken.
  //
  // It stores a deliberately out-of-range page and lets the render-time clamp above
  // resolve it. That is not a trick, it is the only thing that works: `totalPages` here
  // is still the PRE-insert count, so clamping now would land one page short.
  const goToLast = () => setPageRaw(Number.MAX_SAFE_INTEGER);
  function setPageRaw(next) {
    if (!param) { setLocalPage(next); return; }
    const params = new URLSearchParams(searchParams);
    params.set(param, String(next));
    setSearchParams(params, { replace: true });
  }

  const pageRows = useMemo(
    () => (rows || []).slice((page - 1) * pageSize, page * pageSize),
    [rows, page, pageSize],
  );

  return {
    pageRows,
    page,
    totalPages,
    setPage,
    goToLast,
    total,
    pageSize,
    // 1-based inclusive bounds for the "Showing 1–20 of 137" readout. Zero rows reports
    // `0–0`, never `1–0`.
    start: total === 0 ? 0 : (page - 1) * pageSize + 1,
    end: Math.min(page * pageSize, total),
  };
}

export default usePagedRows;
