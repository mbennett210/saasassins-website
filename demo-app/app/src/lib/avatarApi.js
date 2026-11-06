// Team PROFILE PHOTOS — the client adapter (UI_RULES §141) over /api/avatars/* (EP-282..284).
// It sends a member id at most, NEVER a storage path: the server builds every path from the id
// and a version it mints itself (api/_lib/avatars.js).
//
//   uploadAvatar(blob, { userId? })  → { v }      (no userId = your own photo)
//   removeAvatar({ userId? })        → { ok: true }
//   fetchAvatarUrls(userIds)         → { urls: { [id]: { v, url, expiresAt } } }
//
// After a successful upload the CALLER dispatches SET_USER_PHOTO { userId, photo: { v } } (and
// after a remove, photo: null): the record goes through the normal guarded save, like every
// other edit, rather than being written by the route.
//
// The DEMO (`--mode demo`, or a dev build with no backend) keeps each member's latest photo as a
// data URL under its own localStorage key (data/stubKeys AVATAR_STUB_KEY) — never in the state
// blob — and answers `fetchAvatarUrls` with those data URLs, so the whole flow works with no
// server. The branch rides the STATIC `import.meta.env.MODE` / `.PROD` Vite inlines, so in
// `npm run build` STUB folds to `false` and the stub, its key and the 'cs-stub:avatars' sentinel
// are dead code the bundler drops; check-bundle-stubs.mjs asserts it (the CS-010 / CS-038 lesson,
// lib/demoMode.js).
import { authHeaders } from './authHeader';
import { markStub, demoBackendsEngaged } from './demoMode';
import { AVATAR_STUB_KEY } from '../data/stubKeys';
import { PHOTO_URL_TTL_SECONDS } from './userPhoto.js';

// Direct optional-chained reads so Vite inlines each one and STUB folds to a literal.
const STUB = import.meta.env?.MODE === 'demo' || (!import.meta.env?.PROD && demoBackendsEngaged());
if (STUB) markStub('cs-stub:avatars');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isAvatarStub() { return STUB; }

function apiError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

async function api(action, body) {
  const res = await fetch(`${BACKEND}/avatars/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw apiError(res.status, json?.code || null, json?.error || `Request failed (${res.status})`);
  return json;
}

/** A Blob as a `data:` URL (what the upload route takes). */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the photo.'));
    r.readAsDataURL(blob);
  });
}

/** Store a cropped photo (a JPEG Blob) for yourself, or for `userId`. → { v } */
export async function uploadAvatar(blob, { userId } = {}) {
  const dataUrl = await blobToDataUrl(blob);
  if (!STUB) return api('upload', { dataUrl, ...(userId ? { userId } : {}) });
  return stubUpload(dataUrl, userId);
}

/** Delete your photo, or `userId`'s. → { ok: true } */
export async function removeAvatar({ userId } = {}) {
  if (!STUB) return api('remove', userId ? { userId } : {});
  return stubRemove(userId);
}

/** Signed links for these members' CURRENT photos (≤ PHOTO_URLS_MAX ids). */
export async function fetchAvatarUrls(userIds) {
  if (!STUB) return api('urls', { userIds });
  return stubUrls(userIds);
}

// ── the demo stub ─────────────────────────────────────────────────────────────────────────
function stubLoad() {
  try { const db = JSON.parse(localStorage.getItem(AVATAR_STUB_KEY) || 'null'); return db && typeof db === 'object' ? db : {}; } catch { return {}; }
}
function stubSave(db) {
  try {
    localStorage.setItem(AVATAR_STUB_KEY, JSON.stringify(db));
  } catch {
    throw apiError(507, 'demo-storage-full', 'This demo browser has no room left for photos. Reset the demo to clear them.');
  }
}
function stubMint() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return BigInt(`0x${hex}`).toString(36).padStart(25, '0');
}
// The demo has no login to read "you" from, so the screens always name the member (the real
// route treats naming yourself exactly as naming no one).
function stubUpload(dataUrl, userId) {
  const id = userId;
  if (!id) throw apiError(403, 'no-identity', 'Your account could not be resolved.');
  if (!/^data:image\/(jpeg|png);base64,/.test(dataUrl)) throw apiError(400, 'bad-photo', 'Use a JPG or PNG photo.');
  const v = stubMint();
  const db = stubLoad();
  db[id] = { v, dataUrl, at: new Date().toISOString() };
  stubSave(db);
  return { v };
}
function stubRemove(userId) {
  const id = userId;
  const db = stubLoad();
  if (id && db[id]) { delete db[id]; stubSave(db); }
  return { ok: true };
}
function stubUrls(userIds) {
  const db = stubLoad();
  const expiresAt = new Date(Date.now() + PHOTO_URL_TTL_SECONDS * 1000).toISOString();
  const urls = {};
  for (const id of Array.isArray(userIds) ? userIds : []) {
    const e = db[id];
    if (e && typeof e.dataUrl === 'string') urls[id] = { v: e.v, url: e.dataUrl, expiresAt };
  }
  return { urls };
}
