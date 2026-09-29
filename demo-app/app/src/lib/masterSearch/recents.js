// masterSearch/recents.js — recently-opened search results, per user, in localStorage.
// Deliberately NOT a store slice: it is per-browser convenience, so it needs no seed, no
// version bump, no CAS. Capped at write (retention law) and cleared on ?demo=reset by a
// prefix wipe in lib/demoBootstrap.js. Every access is wrapped — private mode / quota /
// disabled storage must never break search.
export const RECENTS_KEY_PREFIX = 'cs.msearch.recents.';
const CAP = 10;

function keyFor(userId) {
  return `${RECENTS_KEY_PREFIX}${userId || 'anon'}`;
}

export function loadRecents(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Record what the user just opened from search. Dedupes by `to` (most-recent-first) and
// caps at write. Stores the minimum needed to render + re-resolve a record recent later.
export function pushRecent(userId, entry) {
  if (!entry || !entry.to) return;
  try {
    const kept = loadRecents(userId).filter((r) => r.to !== entry.to);
    kept.unshift({
      kind: entry.kind,
      type: entry.type,
      refId: entry.refId,
      to: entry.to,
      label: entry.label,
      icon: entry.icon,
      ts: Date.now(),
    });
    localStorage.setItem(keyFor(userId), JSON.stringify(kept.slice(0, CAP)));
  } catch {
    /* convenience only — never fatal */
  }
}

export function clearRecents(userId) {
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    /* ignore */
  }
}
