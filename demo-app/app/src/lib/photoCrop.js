// The profile-photo CROP (UI_RULES §141) — pure math the editor (components/AvatarPhotoEditor)
// and its test share. The editor shows the picked image in a square viewport with a circle
// guide inscribed in it; "Use photo" keeps exactly the circle's square.
//
// The state is resolution-free: `{ cx, cy, zoom }` — the crop square's CENTRE in the image's
// own pixels, and the zoom. 1× is COVER (the square is as big as the image's short side); the
// zoom runs from FIT (the whole photo inside the square: short / long, 0.75 for a 3:4 phone
// photo) up to MAX_ZOOM. A crop STARTS at fit, so the person sees their whole photo and zooms in
// to frame their face — starting at cover cut the head off a portrait photo (Daniel, live,
// 2026-10-04: "starts off too zoomed in").
//
// Below cover, on the axis where the square is bigger than the image, the image stays centred
// (there is nothing to pan to) and the uncovered part of the square shows the avatar disc's own
// colour, in the editor and in the saved photo alike. On an axis where the image is bigger, it
// pans and stops at the image's edge, so at cover or more there is never an empty edge. The
// rendered image is placed in PERCENT of the viewport (no inline px), so a phone rotation or a
// window resize never moves the crop.

export const MAX_ZOOM = 3;
// Arrow keys pan this share of the viewport; +/− zoom by this step.
export const KEY_PAN_FRACTION = 0.05;
export const KEY_ZOOM_STEP = 0.1;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const shortSide = (w, h) => Math.min(w, h);
const longSide = (w, h) => Math.max(w, h);

/** The zoom that shows the WHOLE w×h photo inside the square: short / long (1 for a square). */
export function fitZoom(w, h) {
  const long = longSide(w, h);
  return long > 0 ? shortSide(w, h) / long : 1;
}

/** The crop for a freshly picked w×h image: the whole photo, centred (fit). */
export function initialCrop(w, h) {
  return { cx: w / 2, cy: h / 2, zoom: fitZoom(w, h) };
}

// One axis of the square's centre: centred when the square is at least the image's length on
// that axis (nothing to pan to), else held so the square stays on the image.
function clampAxis(c, side, length) {
  if (side >= length) return length / 2;
  const half = side / 2;
  return clamp(Number.isFinite(c) ? c : length / 2, half, length - half);
}

/** The crop moved back inside the rules: zoom in [fit, 3], each axis centred or on the image. */
export function clampCrop(c, w, h) {
  const zoom = clamp(Number.isFinite(c?.zoom) ? c.zoom : fitZoom(w, h), fitZoom(w, h), MAX_ZOOM);
  const side = shortSide(w, h) / zoom;
  return { cx: clampAxis(c?.cx, side, w), cy: clampAxis(c?.cy, side, h), zoom };
}

/**
 * Pan by a drag of (dx, dy) SCREEN pixels over a viewport `viewportPx` wide. Dragging right
 * moves the picture right, i.e. the crop's centre left.
 */
export function panCrop(c, dx, dy, w, h, viewportPx) {
  const scale = (viewportPx * c.zoom) / shortSide(w, h); // screen px per image px
  if (!(scale > 0)) return clampCrop(c, w, h);
  return clampCrop({ ...c, cx: c.cx - dx / scale, cy: c.cy - dy / scale }, w, h);
}

/** Zoom to `zoom`, keeping the centre where it is (then clamped onto the image). */
export function zoomCrop(c, zoom, w, h) {
  return clampCrop({ ...c, zoom }, w, h);
}

/**
 * What "Use photo" draws on an `out`×`out` canvas: the part of the image inside the crop square
 * (sx, sy, sw, sh — never past the image's edge) and WHERE on the canvas it goes (dx, dy, dw,
 * dh). At cover or more that is the whole canvas; below cover the rest of the canvas is the
 * fill the caller paints first. An explicit destination, so the browser is never asked to clip
 * a source rectangle that runs off the image (Safari has mishandled that).
 */
export function cropDrawRects(c, w, h, out) {
  const k = clampCrop(c, w, h);
  const side = shortSide(w, h) / k.zoom;
  const x0 = k.cx - side / 2;
  const y0 = k.cy - side / 2;
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const sw = Math.min(w, x0 + side) - sx;
  const sh = Math.min(h, y0 + side) - sy;
  const scale = out / side; // canvas px per image px
  return { sx, sy, sw, sh, dx: (sx - x0) * scale, dy: (sy - y0) * scale, dw: sw * scale, dh: sh * scale };
}

/** Where to draw the whole image in the viewport, in PERCENT of the viewport's side. */
export function cropImageBox(c, w, h) {
  const k = clampCrop(c, w, h);
  const per = (k.zoom / shortSide(w, h)) * 100; // viewport % per image px
  return {
    left: 50 - k.cx * per,
    top: 50 - k.cy * per,
    width: w * per,
    height: h * per,
  };
}
