// Where a page opens (CS-960, UI_RULES §186). Daniel, 2026-11-02, after seeing the before-and-after
// pictures: "Fix it next, own change (Recommended)": every page opens at its top from its first
// frame, Back and Forward return you to where you were, and tabs and filters are left as they are.
//
// A page opened from another starts at its top, even one you have seen before. Back and Forward in
// the browser (a history step, POP) go to where that entry was left. The page's own ← Back
// (useBackTarget, DetailHeader) moves with BACK_STATE, so it goes to where that address was left,
// whether or not the page it leaves named it as where it came from: Settings' ← Settings has no
// referrer to name (its sections are opened without one; found live on 2026-11-02). Any other link,
// the menu's to the page you came from included, opens a page at its top. A change on the same page
// (a tab, a filter, a search: only ?… or #… changes) is left alone. The first page of a load is the
// browser's.
//
// components/PageScroll.jsx asks this and moves the page before its first frame. No React and no
// DOM here, so test-page-scroll.mjs runs it on the cases.

/** The address a page is known by: its path and its query, as useFromHere's `from` is made. */
export const addressOf = (loc) => `${loc.pathname}${loc.search || ''}`;

/** What every ← Back control navigates with (useBackTarget, DetailHeader): the move is a Back. */
export const BACK_STATE = Object.freeze({ pageBack: true });
/** Whether a location was reached by a ← Back control. */
export const isPageBack = (loc) => loc?.state?.pageBack === true;

/**
 * Where the page now on screen goes, in px from its top, or null to leave it where it is.
 * @param {null | {key, pathname, search, state}} was  the page before, null for the first of a load
 * @param {{key, pathname, search, state}} now  the page now (useLocation)
 * @param {'PUSH' | 'REPLACE' | 'POP'} how  how it came (useNavigationType)
 * @param {{byKey: Map<string, number>, byAddress: Map<string, number>}} places  where each history
 *   entry, and each address, was last
 */
export function placeFor(was, now, how, places) {
  if (!was || was.key === now.key || was.pathname === now.pathname) return null;
  if (how === 'POP') return places.byKey.get(now.key) ?? 0;
  if (isPageBack(now)) return places.byAddress.get(addressOf(now)) ?? 0;
  return 0;
}
