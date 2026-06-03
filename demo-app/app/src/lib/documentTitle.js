// Tab title manager. The base title is whatever index.html defined (templated
// from BRAND.titleSuffix via the vite-plugin-brand plugin); we mirror that on
// first read so re-renders don't accumulate bracket-counts. When count > 0 the
// title becomes "(N) <base>" so the browser tab bar shows pending work at a
// glance even when the tab is in the background.

import { BRAND } from '../brand.config.js';

let baseTitle = null;

function ensureBase() {
  if (baseTitle === null) {
    // Strip any leading "(N) " in case a prior render left one behind.
    baseTitle = (document.title || BRAND.titleSuffix).replace(/^\(\d+\)\s*/, '');
  }
}

export function setUnreadCount(n) {
  if (typeof document === 'undefined') return;
  ensureBase();
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
}

export function resetTitle() {
  if (typeof document === 'undefined') return;
  ensureBase();
  document.title = baseTitle;
}
