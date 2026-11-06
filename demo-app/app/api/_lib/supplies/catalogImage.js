// A supply catalog item's PRODUCT IMAGE (S131, plan docs/plans/2026-10-14-supply-orders.md §2; brief S
// §3) — the one module that builds, checks, writes, signs and deletes those objects. The route is
// POST /api/supplies/catalog/image (EP-399); every list of items signs its links here, in ONE batch.
//
// ══ COPIED FROM api/_lib/avatars.js (the team photos, UI_RULES §141) ══════════════════════════
//   · WHERE: the existing private `ops-media` bucket, at `<org>/_supply-catalog/<item id>/<v>.jpg` —
//     no new bucket. The `_supply-catalog/` prefix cannot collide with a site id (`st_*`) or the
//     avatars' `_avatars/`. The catalog row carries only `image_v` (an integer, null = none).
//   · EVERY PATH IS BUILT HERE from (item id, v), never accepted from a caller: the id checked as one
//     safe segment, `v` a positive whole number, BEFORE they are joined.
//   · THE BYTES ARE CHECKED: a data URL of a JPEG or PNG whose leading bytes say so (the declared
//     type is the caller's word), at most SUPPLY_IMAGE_MAX_BYTES decoded. The device has already
//     shrunk it to a ~640 px JPEG (lib/imageCanvas shrinkPhoto); the server stores what it got.
//   · IMMUTABLE OBJECTS: a new image is a new `v`, so a signed link can be cached; the previous
//     object is deleted once the row points at the new one (retention at the write point, II.8).
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment, isSafeSegment } from '../storagePaths.js';
import { sniffPhoto } from '../avatars.js';
import { SUPPLY_IMAGE_MAX_BYTES } from '../../../src/lib/supplies.js';

export const CATALOG_IMAGE_BUCKET = 'ops-media';
export const CATALOG_IMAGE_FOLDER = '_supply-catalog';
// How long a signed product-image link lives: a working day (the screens re-read on every visit).
export const CATALOG_IMAGE_URL_TTL_S = 8 * 60 * 60;
// A year: Storage's cacheControl for an object that never changes.
const CACHE_SECONDS = 365 * 24 * 60 * 60;

const bucket = (db) => (db || getSupabase()).storage.from(CATALOG_IMAGE_BUCKET);
const isVersion = (v) => Number.isInteger(v) && v > 0;

/** `<org>/_supply-catalog/<itemId>/<v>.jpg` — throws on an id that is not one safe segment or a bad v. */
export function catalogImagePath(itemId, v) {
  requireSafeSegment(itemId, 'supply catalog item id');
  if (!isVersion(v)) throw new Error('unsafe supply image version');
  return `${CLEANSPACE_ORG_ID}/${CATALOG_IMAGE_FOLDER}/${itemId}/${v}.jpg`;
}

const DATA_URL_RE = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/;
/**
 * Validate an image data URL. PURE (no I/O): a JPEG or PNG whose BYTES say so, at most
 * SUPPLY_IMAGE_MAX_BYTES decoded. → { ok: true, mimeType, bytes, buffer } | { ok: false, code, error }
 */
export function validateCatalogImage(dataUrl) {
  const NOT_AN_IMAGE = { ok: false, code: 'bad_image', error: 'Use a JPG or PNG photo.' };
  if (typeof dataUrl !== 'string' || !dataUrl) return NOT_AN_IMAGE;
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return NOT_AN_IMAGE;
  const [, mimeType, b64] = m;
  const buffer = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (!buffer.length) return NOT_AN_IMAGE;
  if (buffer.length > SUPPLY_IMAGE_MAX_BYTES) return { ok: false, code: 'too_large', error: 'That photo is over 1 MB.' };
  const sniffed = sniffPhoto(buffer);
  if (!sniffed || sniffed !== mimeType) return NOT_AN_IMAGE;
  return { ok: true, mimeType, bytes: buffer.length, buffer };
}

/** Store the image's bytes at version `v` (a retried upload of the same `v` overwrites itself). */
export async function putCatalogImage(itemId, v, { buffer, mimeType }, db) {
  const { error } = await bucket(db).upload(catalogImagePath(itemId, v), buffer, {
    contentType: mimeType, cacheControl: String(CACHE_SECONDS), upsert: true,
  });
  if (error) throw new Error(`supply image upload failed: ${error.message}`);
}

/** Delete the objects of these versions of one item (best-effort: a missing one is not an error). */
export async function removeCatalogImages(itemId, versions, db) {
  if (!isSafeSegment(itemId)) return 0;
  const paths = [...new Set((Array.isArray(versions) ? versions : [versions]).filter(isVersion))].map((v) => catalogImagePath(itemId, v));
  if (!paths.length) return 0;
  try {
    const { data } = await bucket(db).remove(paths);
    return Array.isArray(data) ? data.length : 0;
  } catch { return 0; }
}

/**
 * Signed links for every item that has an image, in ONE Storage call: `items` are app-shape catalog
 * items or a building's items (`id` or `catalogItemId`, and `imageV`). → the same items, each with
 * `imageUrl` (null when it has no image, or its object is missing).
 */
export async function withCatalogImageUrls(items, { idOf = (it) => it.catalogItemId || it.id } = {}, db) {
  const list = Array.isArray(items) ? items : [];
  const wanted = [];
  for (const it of list) {
    const id = it && idOf(it);
    if (id && isSafeSegment(id) && isVersion(it.imageV)) wanted.push({ id, v: it.imageV, path: catalogImagePath(id, it.imageV) });
  }
  const byPath = new Map();
  if (wanted.length) {
    const paths = [...new Set(wanted.map((w) => w.path))];
    try {
      const { data, error } = await bucket(db).createSignedUrls(paths, CATALOG_IMAGE_URL_TTL_S);
      if (!error) for (const d of Array.isArray(data) ? data : []) if (d && !d.error && d.signedUrl) byPath.set(d.path, d.signedUrl);
    } catch { /* best-effort: a list without its pictures is still the list */ }
  }
  return list.map((it) => {
    const id = it && idOf(it);
    const url = id && isVersion(it.imageV) && isSafeSegment(id) ? byPath.get(catalogImagePath(id, it.imageV)) || null : null;
    return { ...it, imageUrl: url };
  });
}
