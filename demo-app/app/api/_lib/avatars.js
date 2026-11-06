// Team PROFILE PHOTOS in Storage (UI_RULES §141) — the one module that builds, writes, signs and
// deletes a member's photo objects. The route is api/avatars/[...path].js.
//
// ══ WHERE THE BYTES LIVE ═══════════════════════════════════════════════════════════════════
// The EXISTING private `ops-media` bucket, under `<org>/_avatars/<userId>/<v>.jpg` — the
// signature image's pattern (signatureUpload.js), so no new bucket, no DDL, no migration. The
// `_avatars/` prefix cannot collide with a site id (those are `st_*`). The shared record carries
// only `users[].photo = { v }` (src/lib/userPhoto.js); a photo never rides org_state, whose 3.5 MB
// save limit the whole org shares (1,500 cleaners × ~20 KB would be 30 MB).
//
// ⚠️ EVERY PATH IS BUILT HERE FROM (userId, v), NEVER ACCEPTED FROM A CALLER. Both segments are
// checked BEFORE they are concatenated: the id with `requireSafeSegment`, the version against
// the minted format. account-media once wrote a caller's `storagePath` verbatim and became a
// read primitive over the whole bucket (AUTHORIZATION_AUDIT #5); a path that is never accepted
// cannot be that.
//
// IMMUTABLE OBJECTS. A new photo is a new random `v`, never an overwrite, so an object can be
// cached for a year and a signed link to it reused until it expires: the browser's HTTP cache
// then serves every avatar on a list after the first visit.
import { randomBytes } from 'node:crypto';
import { getSupabase } from './supabase.js';
import { CLEANSPACE_ORG_ID } from './constants.js';
import { requireSafeSegment, isSafeSegment, isValidStoragePath } from './storagePaths.js';
import { SIGNATURE_BUCKET } from './signatureUpload.js';
import {
  isPhotoVersion, photoVersionOf, PHOTO_MAX_BYTES, PHOTO_URL_TTL_SECONDS, PHOTO_URLS_MAX,
} from '../../src/lib/userPhoto.js';

// The signature images' bucket, on purpose: one private bucket for a member's small images.
export const AVATAR_BUCKET = SIGNATURE_BUCKET;
export const AVATAR_FOLDER = '_avatars';
// A year, in seconds: Storage's `cacheControl` for an object that never changes.
export const AVATAR_CACHE_SECONDS = 365 * 24 * 60 * 60;

// One Storage list page, and how many pages one member's folder may take (it normally holds one
// or two objects; the cap only keeps a hostile folder from looping a request).
const LIST_PAGE = 100;
const MEMBER_LIST_PAGES = 10;

// ── the path ──────────────────────────────────────────────────────────────────────────────

/** A fresh photo version: 128 random bits in lowercase base36 (25 characters). */
export function mintPhotoVersion() {
  return BigInt(`0x${randomBytes(16).toString('hex')}`).toString(36).padStart(25, '0');
}

/** `<org>/_avatars/<userId>` — throws on an id that is not one safe segment. */
export function avatarFolderFor(userId) {
  requireSafeSegment(userId, 'avatar userId');
  return `${CLEANSPACE_ORG_ID}/${AVATAR_FOLDER}/${userId}`;
}

/** `<org>/_avatars/<userId>/<v>.jpg` — throws on a bad id or a `v` the server never mints. */
export function avatarPathFor(userId, v) {
  const folder = avatarFolderFor(userId);
  if (!isPhotoVersion(v)) throw new Error('unsafe avatar version');
  return `${folder}/${v}.jpg`;
}

/** The version an object NAME carries (`<v>.jpg`), or null for a name this module never wrote. */
export function photoVersionFromName(name) {
  const m = typeof name === 'string' ? /^([a-z0-9]+)\.jpg$/.exec(name) : null;
  return m && isPhotoVersion(m[1]) ? m[1] : null;
}

// ── the bytes ─────────────────────────────────────────────────────────────────────────────

// The strict class keeps CR/LF and parameters out, as the signature's parser does.
const DATA_URL_RE = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/;

/** What the leading bytes say the image is: 'image/jpeg', 'image/png' or null. */
export function sniffPhoto(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

/**
 * Validate a photo data URL. PURE (no I/O), so the whole decision table is unit-testable.
 * A JPEG or PNG whose BYTES say so (the declared type is the caller's word), ≤ PHOTO_MAX_BYTES
 * decoded. The device always sends a 320 px JPEG of about 20 KB; PNG is accepted because a
 * browser that cannot encode JPEG falls back to it.
 * @returns {{ ok: true, mimeType: string, bytes: number, buffer: Buffer } | { ok: false, error: string }}
 */
export function validateAvatarUpload(dataUrl) {
  const NOT_A_PHOTO = 'Use a JPG or PNG photo.';
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: NOT_A_PHOTO };
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return { ok: false, error: NOT_A_PHOTO };
  const [, mimeType, b64] = m;
  const buffer = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (!buffer.length) return { ok: false, error: NOT_A_PHOTO };
  if (buffer.length > PHOTO_MAX_BYTES) {
    return { ok: false, error: `That photo is ${Math.round(buffer.length / 1024)} KB. The limit is ${Math.round(PHOTO_MAX_BYTES / 1024)} KB.` };
  }
  // A file whose bytes disagree with its declared type is how a "photo" becomes something else
  // once it is served back under a signed link.
  const sniffed = sniffPhoto(buffer);
  if (!sniffed || sniffed !== mimeType) return { ok: false, error: NOT_A_PHOTO };
  return { ok: true, mimeType, bytes: buffer.length, buffer };
}

// ── who may set whose photo (pure) ────────────────────────────────────────────────────────

/**
 * The member an upload or remove acts on, or the refusal. PURE: the route reads the inputs.
 *   · no `requestedUserId` (or the caller's own) → yourself, always (no key needed);
 *   · anyone else → only a holder of `settings.team.edit` (the Team page's key: owner, admin and
 *     manager by default, from the COMMITTED matrix + overrides);
 *   · either way the member must be on the committed roster (a photo hangs off a roster row).
 * @param {{ callerId: string|null, requestedUserId: any, roster: any[]|null, holdsTeamEdit: boolean }} f
 */
export function avatarTargetDecision({ callerId, requestedUserId, roster, holdsTeamEdit }) {
  if (!callerId) return { ok: false, status: 403, code: 'no-identity', error: 'Your account could not be resolved. Sign out and back in.' };
  const named = requestedUserId !== undefined && requestedUserId !== null && requestedUserId !== '';
  if (named && !isSafeSegment(requestedUserId)) return { ok: false, status: 400, code: 'bad-user-id', error: 'That team member could not be found.' };
  const userId = named ? requestedUserId : callerId;
  const self = userId === callerId;
  if (!self && !holdsTeamEdit) return { ok: false, status: 403, code: 'not-allowed', error: "You can only change your own photo." };
  if (!Array.isArray(roster)) return { ok: false, status: 503, code: 'roster-unreadable', error: 'The team could not be read just now. Try again.' };
  const row = roster.find((u) => u && u.id === userId);
  if (!row) return { ok: false, status: 404, code: 'not-on-team', error: 'That team member could not be found.' };
  return { ok: true, userId, self, committedV: photoVersionOf(row) };
}

/** The object names to delete from a folder so that only `keep` (versions) remain. PURE. */
export function namesToPrune(names, keep) {
  const kept = new Set((keep || []).filter(isPhotoVersion));
  return (names || []).filter((n) => !kept.has(photoVersionFromName(n)));
}

/**
 * The link requests for `userIds`: one per member on the roster with a CURRENT photo. PURE.
 * Returns undefined when the list is malformed (not an array, an unsafe id, or more than
 * PHOTO_URLS_MAX) — the route answers 400.
 */
export function avatarUrlRequests({ roster, userIds }) {
  if (!Array.isArray(userIds) || userIds.length > PHOTO_URLS_MAX) return undefined;
  if (!userIds.every(isSafeSegment)) return undefined;
  const byId = new Map((Array.isArray(roster) ? roster : []).filter((u) => u && typeof u.id === 'string').map((u) => [u.id, u]));
  const out = [];
  for (const userId of new Set(userIds)) {
    const v = photoVersionOf(byId.get(userId));
    if (v) out.push({ userId, v, path: avatarPathFor(userId, v) });
  }
  return out;
}

// ── Storage ───────────────────────────────────────────────────────────────────────────────

const bucket = () => getSupabase().storage.from(AVATAR_BUCKET);

// Every entry of one folder level of the bucket (folders come back with `id: null`), up to
// `maxPages` pages. Returns { entries, more } — `more` when the cap stopped the walk. Exported for
// the cleanup (memberStorage.js), which walks the `_avatars/` and `_signatures/` levels.
export async function listLevel(prefix, maxPages) {
  const entries = [];
  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await bucket().list(prefix, {
      limit: LIST_PAGE, offset: page * LIST_PAGE, sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`avatar list failed: ${error.message}`);
    const rows = Array.isArray(data) ? data : [];
    entries.push(...rows);
    if (rows.length < LIST_PAGE) return { entries, more: false };
  }
  return { entries, more: true };
}

/** The objects in one member's folder: [{ name, v, createdAt }]. */
export async function listAvatarObjects(userId) {
  const { entries } = await listLevel(avatarFolderFor(userId), MEMBER_LIST_PAGES);
  return entries.filter((e) => e && e.id !== null && typeof e.name === 'string')
    .map((e) => ({ name: e.name, v: photoVersionFromName(e.name), createdAt: e.created_at || null }));
}

// Delete these names from one member's folder; returns how many Storage removed. A name comes
// from Storage's own listing of OUR folder, and is still re-checked as a path before Storage is
// asked to delete it (defense in depth: the delete never leaves the folder). Exported for the
// cleanup (memberStorage.js).
export async function removeAvatarNames(userId, names) {
  const folder = avatarFolderFor(userId);
  const paths = names.map((n) => `${folder}/${n}`).filter(isValidStoragePath);
  if (!paths.length) return 0;
  const { data, error } = await bucket().remove(paths);
  if (error) throw new Error(`avatar remove failed: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/** Store a validated photo under a NEW version and return the version. */
export async function putAvatar(userId, { buffer, mimeType }) {
  const v = mintPhotoVersion();
  const { error } = await bucket().upload(avatarPathFor(userId, v), buffer, {
    contentType: mimeType, cacheControl: String(AVATAR_CACHE_SECONDS), upsert: false,
  });
  if (error) throw new Error(`avatar upload failed: ${error.message}`);
  return v;
}

/**
 * RETENTION AT THE WRITE POINT (THE LAW II.8): keep only `keep` (the new version and the one the
 * committed roster row points at) in the member's folder. Returns how many objects went.
 */
export async function pruneAvatars(userId, keep) {
  const objects = await listAvatarObjects(userId);
  return removeAvatarNames(userId, namesToPrune(objects.map((o) => o.name), keep));
}

/** Delete everything in the member's folder. Returns how many objects went. */
export async function removeAvatarFolder(userId) {
  const objects = await listAvatarObjects(userId);
  return removeAvatarNames(userId, objects.map((o) => o.name));
}

/**
 * The bytes of one member's photo version, for the customer hub's `face` branch (HUB-19), which
 * serves the image itself rather than a signed link (a link carries the path, and the path the
 * member's id). → { buffer, mimeType }, or null when the object is missing or its bytes are not a
 * photo this module would have stored (re-checked as on the way in: JPEG or PNG by its bytes,
 * ≤ PHOTO_MAX_BYTES). Throws on a bad id or version (avatarPathFor), never building a path from
 * anything else.
 */
export async function readAvatar(userId, v) {
  const { data, error } = await bucket().download(avatarPathFor(userId, v));
  if (error || !data) return null;
  const buffer = Buffer.from(await data.arrayBuffer());
  if (!buffer.length || buffer.length > PHOTO_MAX_BYTES) return null;
  const mimeType = sniffPhoto(buffer);
  return mimeType ? { buffer, mimeType } : null;
}

/**
 * Signed links for `requests` (from avatarUrlRequests), in ONE Storage call.
 * → { [userId]: { v, url, expiresAt } }; a member whose object is missing is left out (the
 * device then shows their initials).
 */
export async function signAvatarUrls(requests, { now = Date.now() } = {}) {
  if (!requests.length) return {};
  const { data, error } = await bucket().createSignedUrls(requests.map((r) => r.path), PHOTO_URL_TTL_SECONDS);
  if (error) throw new Error(`avatar sign failed: ${error.message}`);
  const byPath = new Map((Array.isArray(data) ? data : []).filter((d) => d && !d.error && d.signedUrl).map((d) => [d.path, d.signedUrl]));
  const expiresAt = new Date(now + PHOTO_URL_TTL_SECONDS * 1000).toISOString();
  const out = {};
  for (const r of requests) {
    const url = byPath.get(r.path);
    if (url) out[r.userId] = { v: r.v, url, expiresAt };
  }
  return out;
}

