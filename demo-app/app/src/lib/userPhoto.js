// A team member's PROFILE PHOTO — the one shape both halves read (UI_RULES §141).
//
// The bytes live OUTSIDE the shared record: Supabase Storage, the private `ops-media` bucket,
// `<org>/_avatars/<userId>/<v>.jpg` (api/_lib/avatars.js builds that path; nothing else may).
// The shared record carries only `users[].photo = { v }`, where `v` is a random id the SERVER
// mints on upload. A new photo is a new `v`, so an object is never overwritten and a link to
// it can be cached for as long as it is signed for.
//
// ⚠️ NOT `users[].avatar`. That field already exists and is the colour number (1–5) the
// initials sit on; the photo is a separate field so the initials keep their colour as the
// fallback underneath it.
//
// The field is ABSENT when the member has no photo (initials), and `null` reads the same, so
// it is additive and default-safe: no store version bump, no seed change.
//
// The VALUE is checked at every write point (the reducer's SET_USER_PHOTO, the server's crew
// merge), because org_state is browser-writable and the link route trusts what it finds: a
// value that is not exactly `{ v: <id> }` is ignored there, never repaired. Pure and node-safe:
// the browser and the server both import it.

// What `v` looks like: lowercase base36, 16–32 characters. The server mints 25 (128 random
// bits); the range leaves room to change that without a migration.
export const PHOTO_VERSION_RE = /^[a-z0-9]{16,32}$/;

// The shrunk photo the device sends: a square JPEG this many pixels on a side, at this quality
// (about 20 KB). Big enough for the largest avatar (the profile card's) on a 3× phone screen.
export const PHOTO_EDGE_PX = 320;
export const PHOTO_JPEG_QUALITY = 0.85;

// The most the server stores for one photo, in DECODED bytes (the base64 length is what a
// caller controls directly). Ten times the usual photo, so a valid one is never refused.
export const PHOTO_MAX_BYTES = 200 * 1024;

// How long a signed link to a photo lasts, and how many people one link request may ask about.
export const PHOTO_URL_TTL_SECONDS = 6 * 60 * 60;
export const PHOTO_URLS_MAX = 200;

// The device keeps a link until this long before it expires, then asks again.
export const PHOTO_LINK_REFRESH_BEFORE_MS = 10 * 60 * 1000;

/** True when `v` is a photo version the server could have minted. */
export function isPhotoVersion(v) {
  return typeof v === 'string' && PHOTO_VERSION_RE.test(v);
}

/** True when `p` is exactly `{ v }` with a valid version — the only photo value a row may hold. */
export function isUserPhoto(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const keys = Object.keys(p);
  return keys.length === 1 && keys[0] === 'v' && isPhotoVersion(p.v);
}

/** The member's current photo version, or null (no photo, or a value that is not a photo). */
export function photoVersionOf(user) {
  return user && isUserPhoto(user.photo) ? user.photo.v : null;
}
