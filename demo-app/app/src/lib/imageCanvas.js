// Shrinking a picture ON THE DEVICE — the one canvas routine the app's photo paths share: every
// photo before it is uploaded (shrinkPhoto, CS-678: lib/accountMediaApi uploadMedia — the visit,
// checklist-item, account, work-order and inspection photos — the client hub's ticket photo and
// the support report's), the gallery's posters (lib/accountMediaApi makeThumbnail) and the team
// profile photo's crop (components/AvatarPhotoEditor, UI_RULES §141). One helper means one place
// to get a decode failure, a canvas that will not encode, or a leaked bitmap right.

/**
 * Decode a picked file (or a video frame, or any image source) into an ImageBitmap, or null when
 * this browser cannot read it — e.g. an iPhone HEIC on a desktop browser. A null is the caller's
 * cue to say "Use a JPG or PNG photo", never a silent failure. `options` go to
 * createImageBitmap as they are (a browser that refuses one answers null too).
 */
export async function decodeImage(source, options = null) {
  try {
    if (typeof createImageBitmap !== 'function' || !source) return null;
    return await (options ? createImageBitmap(source, options) : createImageBitmap(source));
  } catch {
    return null;
  }
}

// ── A photo, shrunk before it is uploaded (CS-678) ───────────────────────────────────────────
// A phone's camera writes 3–12 MB per photo (4,000 px and more on the long edge) and every one
// was stored as it came, forever: at ~16,000 cleans a month that is tens of gigabytes a month.
// A photo is now redrawn on the device at most PHOTO_MAX_EDGE on its long edge as a JPEG at
// PHOTO_QUALITY — a few hundred KB, still sharp on a laptop screen. Upright: the camera's EXIF
// orientation is applied while decoding (asked for explicitly), because the redrawn file carries
// no EXIF (which also drops the photo's GPS tag). Only CAMERA formats are redrawn: a PNG or WebP
// is a screenshot or a graphic, where recompressing blurs the text, and a GIF may be animated;
// a video, a document, a photo this browser cannot decode, or one that would come out no smaller
// is uploaded exactly as picked.
export const PHOTO_MAX_EDGE = 1600;
export const PHOTO_QUALITY = 0.8;
// A camera photo already within the edge and at most this size is uploaded as it is (no second
// round of JPEG loss for nothing).
export const PHOTO_SMALL_BYTES = 500 * 1024;
const CAMERA_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/heic', 'image/heif']);

/** A camera photo (JPEG / HEIC), by its type — or, when the browser gave none, by its name. */
export function isCameraPhoto(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type) return CAMERA_TYPES.has(type);
  return /\.(jpe?g|heic|heif)$/i.test(String(file?.name || ''));
}

/**
 * The file to upload for a picked `file`: a camera photo redrawn at most `maxEdge` px on its long
 * edge as a JPEG (a File named *.jpg), or `file` itself — anything that is not a camera photo,
 * one already small, one this browser cannot decode or encode, or one that would not shrink.
 * Never throws.
 */
export async function shrinkPhoto(file, { maxEdge = PHOTO_MAX_EDGE, quality = PHOTO_QUALITY, smallBytes = PHOTO_SMALL_BYTES } = {}) {
  if (!file || !isCameraPhoto(file)) return file;
  const bmp = (await decodeImage(file, { imageOrientation: 'from-image' })) || (await decodeImage(file));
  if (!bmp) return file;
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (!(long > 0)) return file;
    if (long <= maxEdge && file.size <= smallBytes) return file;
    const scale = Math.min(1, maxEdge / long);
    const blob = await drawJpeg(bmp, { width: bmp.width * scale, height: bmp.height * scale, quality });
    if (!blob || !(blob.size > 0) || blob.size >= file.size) return file;
    const name = `${String(file.name || 'photo').replace(/\.[^./\\]*$/, '') || 'photo'}.jpg`;
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
  } catch {
    return file;
  } finally {
    closeBitmap(bmp);
  }
}

/**
 * Draw the source rectangle (sx, sy, sw, sh) of `bitmap` into the destination rectangle (dx, dy,
 * dw, dh) of a `width`×`height` canvas, and encode it as a JPEG at `quality`. Resolves the Blob,
 * or null when the canvas cannot encode. With no rectangles: the whole bitmap over the whole
 * canvas. `fill` (a CSS colour) paints the canvas first, for any part the image doesn't cover —
 * a JPEG has no transparency, so an unpainted part would come out black.
 */
export async function drawJpeg(bitmap, { sx = 0, sy = 0, sw, sh, dx = 0, dy = 0, dw, dh, width, height, quality = 0.85, fill = null }) {
  try {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bitmap, sx, sy, sw ?? bitmap.width, sh ?? bitmap.height, dx, dy, dw ?? w, dh ?? h);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } catch {
    return null;
  }
}

/**
 * Any picture this browser can draw — a PNG with a transparent background, a WebP, a GIF's first
 * frame, a BMP — redrawn as a JPEG at most `maxEdge` px on its long edge, on `fill` where it is
 * transparent (a JPEG has none, so it would come out black). The supply catalog import's pictures
 * (task 257): the product-image door stores a JPEG or PNG of at most 1 MB, and a pasted picture can
 * be any kind and any size. A JPEG already within the edge and at most `keepBytes` is kept as it is.
 * Resolves a Blob, or null when this browser cannot read the picture.
 */
export async function pictureAsJpeg(source, { maxEdge, quality = 0.85, fill = null, keepBytes = 0 }) {
  const bmp = (await decodeImage(source, { imageOrientation: 'from-image' })) || (await decodeImage(source));
  if (!bmp) return null;
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (!(long > 0)) return null;
    if (source.type === 'image/jpeg' && long <= maxEdge && source.size <= keepBytes) return source;
    const scale = Math.min(1, maxEdge / long);
    return await drawJpeg(bmp, { width: bmp.width * scale, height: bmp.height * scale, quality, fill });
  } finally {
    closeBitmap(bmp);
  }
}

/** Release a bitmap's memory (a phone's camera photo is tens of megabytes decoded). */
export function closeBitmap(bitmap) {
  try { bitmap?.close?.(); } catch { /* already closed */ }
}
