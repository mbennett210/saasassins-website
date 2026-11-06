// The team-photo LINK CACHE (UI_RULES §141): every `<Avatar user={u}>` on a screen asks here for
// its member's signed photo link, and this module turns a screen's worth of asks into ONE call
// to /api/avatars/urls (lib/avatarApi), then keeps the answers.
//
// CACHING LAW (THE LAW II.7), layer by layer:
//   · module cache, keyed `userId:v` — a new photo is a new `v`, so an old link can never show a
//     new face, and a `v` change asks again by construction;
//   · localStorage (`cleanspace_avatar_links_v1`) until PHOTO_LINK_REFRESH_BEFORE_MS before the
//     link expires, so a reload reuses the SAME signed URL and the browser's HTTP cache (the
//     object is cached a year) serves the image without a byte on the wire. Only http(s) links
//     are kept there: the demo's data URLs are megabytes of nothing worth persisting;
//   · a batching queue: the ids asked for within BATCH_DELAY_MS go out together, at most
//     PHOTO_URLS_MAX per call (the route's cap);
//   · a member the server answered nothing for (no photo stored, or a missing object) is not
//     asked about again for MISSING_RETRY_MS, so a list of initials never polls.
// The reconcile path: a link that fails to load (an expired one, a deleted object) is dropped
// with `invalidate`, the next render asks again once, and a second failure shows initials
// (components/Avatar).
import { useEffect, useSyncExternalStore } from 'react';
import { fetchAvatarUrls } from './avatarApi';
import { photoVersionOf, PHOTO_URLS_MAX, PHOTO_LINK_REFRESH_BEFORE_MS } from './userPhoto.js';

export const LINKS_STORAGE_KEY = 'cleanspace_avatar_links_v1';
export const BATCH_DELAY_MS = 30;
export const MISSING_RETRY_MS = 5 * 60 * 1000;
// How many links the device keeps across reloads (each is a few hundred bytes).
export const MAX_PERSISTED_LINKS = 600;

/** The cache key for one member's photo version. */
export function linkKey(userId, v) {
  return `${userId}:${v}`;
}

/** True while `entry` can still be shown: a link that is not within the refresh margin of its end. */
export function isLinkFresh(entry, now = Date.now()) {
  if (!entry || typeof entry.url !== 'string' || !entry.url) return false;
  const end = Date.parse(entry.expiresAt || '');
  return Number.isFinite(end) && end - PHOTO_LINK_REFRESH_BEFORE_MS > now;
}

/** `ids` in calls of at most `max`. */
export function chunkIds(ids, max = PHOTO_URLS_MAX) {
  const out = [];
  for (let i = 0; i < ids.length; i += max) out.push(ids.slice(i, i + max));
  return out;
}

const persistable = (entry) => !!entry && /^https?:\/\//.test(entry.url || '');

function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/**
 * A loader: the cache, the queue and the subscribers. Injectable for the test; the app uses the
 * one `defaultLoader()` returns.
 *   fetchUrls(userIds) → Promise<{ urls: { [id]: { v, url, expiresAt } } }>
 */
export function createAvatarUrlLoader({
  fetchUrls, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms),
  storage = safeStorage(), delayMs = BATCH_DELAY_MS,
} = {}) {
  const links = new Map();    // key → { url, expiresAt }
  const missing = new Map();  // key → when the server answered nothing
  const queued = new Map();   // userId → v (the version this screen wants)
  const inFlight = new Set(); // keys being asked about right now
  const listeners = new Set();
  let timer = null;

  // A reload starts from what is still fresh.
  try {
    const saved = JSON.parse(storage?.getItem(LINKS_STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const [key, entry] of Object.entries(saved)) {
        if (persistable(entry) && isLinkFresh(entry, now())) links.set(key, { url: entry.url, expiresAt: entry.expiresAt });
      }
    }
  } catch { /* unreadable storage: start empty */ }

  const notify = () => { for (const fn of [...listeners]) fn(); };
  const persist = () => {
    if (!storage) return;
    try {
      const t = now();
      const keep = [...links.entries()].filter(([, e]) => persistable(e) && isLinkFresh(e, t))
        .sort((a, b) => Date.parse(b[1].expiresAt) - Date.parse(a[1].expiresAt))
        .slice(0, MAX_PERSISTED_LINKS);
      storage.setItem(LINKS_STORAGE_KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch { /* full or blocked: the in-memory cache still works */ }
  };

  async function flush() {
    timer = null;
    const batch = [...queued.entries()];
    queued.clear();
    if (!batch.length) return;
    const wanted = new Map(batch);
    for (const [id, v] of batch) inFlight.add(linkKey(id, v));
    for (const ids of chunkIds(batch.map(([id]) => id))) {
      let answered = {};
      let failed = false;
      try {
        answered = (await fetchUrls(ids))?.urls || {};
      } catch {
        failed = true; // offline or refused: leave them unmarked, a later render asks again
      }
      const t = now();
      for (const id of ids) {
        const v = wanted.get(id);
        const key = linkKey(id, v);
        inFlight.delete(key);
        if (failed) continue;
        const e = answered[id];
        // Only the version this screen asked for: a link for an older or newer photo is a
        // different key, and would show the wrong face.
        if (e && e.v === v && typeof e.url === 'string') {
          links.set(key, { url: e.url, expiresAt: e.expiresAt });
          missing.delete(key);
        } else {
          missing.set(key, t);
        }
      }
    }
    persist();
    notify();
  }

  return {
    /** The fresh link for this member's photo version, or null. */
    get(userId, v) {
      if (!userId || !v) return null;
      const e = links.get(linkKey(userId, v));
      return isLinkFresh(e, now()) ? e : null;
    },
    /** Ask for a link unless a fresh one is held, one is on its way, or the server just said none. */
    request(userId, v) {
      if (!userId || !v) return;
      const key = linkKey(userId, v);
      if (isLinkFresh(links.get(key), now()) || inFlight.has(key)) return;
      const m = missing.get(key);
      if (m !== undefined && now() - m < MISSING_RETRY_MS) return;
      queued.set(userId, v);
      if (!timer) timer = schedule(flush, delayMs);
    },
    /** Drop a link that failed to load, so the next ask fetches a new one. */
    invalidate(userId, v) {
      const key = linkKey(userId, v);
      const had = links.delete(key);
      missing.delete(key);
      if (had) { persist(); notify(); }
    },
    /** Forget every link, in memory and on the device (a sign-out on a shared phone). */
    clear() {
      links.clear();
      missing.clear();
      queued.clear();
      try { storage?.removeItem?.(LINKS_STORAGE_KEY); } catch { /* blocked storage */ }
      notify();
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    flush,
  };
}

let loader = null;
/** The app's one loader, over /api/avatars/urls (or the demo stub). */
export function defaultLoader() {
  if (!loader) loader = createAvatarUrlLoader({ fetchUrls: fetchAvatarUrls });
  return loader;
}

/**
 * Sign-out (auth/AuthProvider): drop the signed links this device holds. Each one is a bearer
 * link to a private photo for hours, so on a shared phone they leave with the person, like the
 * offline workspace cache; the next sign-in asks again.
 */
export function clearAvatarLinks() {
  if (loader) { loader.clear(); return; }
  try { localStorage.removeItem(LINKS_STORAGE_KEY); } catch { /* blocked storage */ }
}

/**
 * The signed photo link for `user`'s CURRENT photo, or null (no photo, not loaded yet, or none
 * stored). A `v` change asks again. `retry()` drops a link that failed to load.
 */
export function useAvatarUrl(user) {
  const l = defaultLoader();
  const id = user?.id || null;
  const v = photoVersionOf(user);
  // The snapshot is this member's URL string (or null), so an avatar re-renders only when ITS
  // link changes, not whenever any link on the screen lands.
  const urlNow = () => (id && v ? l.get(id, v)?.url || null : null);
  const url = useSyncExternalStore(l.subscribe, urlNow, urlNow);
  // Asks whenever there is no link to show: on mount, on a `v` change, and after a link
  // aged out or was dropped by `retry`.
  useEffect(() => { if (id && v && !url) l.request(id, v); }, [l, id, v, url]);
  return {
    url,
    key: id && v ? linkKey(id, v) : null,
    retry: () => { if (id && v) { l.invalidate(id, v); l.request(id, v); } },
  };
}
