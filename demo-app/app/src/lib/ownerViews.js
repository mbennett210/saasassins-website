// The owner's Home switch (pages/OwnerHome): which views exist, and what a tap on one does to the
// URL. Pure, so the rule is tested under node (scripts/test-supply-shell.mjs §4).
//
// "Owner cockpit · Manager view · Operations view · Supply view" (the manager view redesign's D1,
// S131's §0 previews for the one shared login): the cockpit is the default and has no `?view=`;
// each other view is a Home acting as the owner — the manager Home, an Operations Manager's Home,
// the Supply Manager's Order Queue — kept in the URL (`?view=`, replace) so Back and a shared link
// keep it.
//
// Each view owns URL keys the others do not read: the manager pick (`mgr`), the Operations view's
// OM (`om`), the order queue's tab, search and page (`status`, `q`, `page`), the cockpit's period
// (`window`). A tap on ANOTHER view drops them all, so nothing one view chose leaks into the next;
// a tap on the view you are on keeps its own.
export const OWNER_VIEWS = Object.freeze(['manager', 'ops', 'supply']);
const VIEW_KEYS = ['mgr', 'om', 'status', 'q', 'page', 'window'];

// → the URLSearchParams after a tap on `next` ('' = the cockpit), or null for a view that does not exist.
export function ownerViewParams(params, next) {
  const raw = params.get('view');
  const current = OWNER_VIEWS.includes(raw) ? raw : '';
  const target = next ? (OWNER_VIEWS.includes(next) ? next : null) : '';
  if (target === null) return null;
  const out = new URLSearchParams(params);
  if (current === target && (raw === null || raw === current)) return out;
  for (const key of VIEW_KEYS) out.delete(key);
  if (target) out.set('view', target);
  else out.delete('view');
  return out;
}
