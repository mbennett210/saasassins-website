// Team PROFILE PHOTOS — the device's pure logic (UI_RULES §141):
//   A. the crop (src/lib/photoCrop.js): centred, zoom held to fit–3× (1× = cover), at cover or
//      more the square never leaves the image (no empty corner in the circle), a drag moves the
//      picture with the finger, and "Use photo" keeps exactly the square the circle shows;
//   B. the link cache (src/lib/avatarUrls.js): the ids asked for in one tick go out in ONE call,
//      at most PHOTO_URLS_MAX per call; a held link is reused until 10 minutes before it
//      expires; a `v` change asks again; a member with no photo stored is not asked about again
//      for a while; a link that failed to load is dropped and asked for once more; a reload
//      reuses persisted links (http(s) only, fresh only) and never a data: URL;
//   D. the crop STARTS with the whole photo (fit), zooms out no further, centres the bars, and the
//      saved photo's bars are the disc's colour, drawn into an explicit destination rectangle.
//
// Offline. Run: node scripts/test-avatar-client.mjs
import { register } from 'node:module';
// The client modules use extensionless relative imports; resolve them as .js under plain node.
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Missing before the feature: the checks then FAIL instead of the suite crashing.
const crop = await import('../src/lib/photoCrop.js').catch(() => ({}));
const links = await import('../src/lib/avatarUrls.js').catch(() => ({}));
const photo = await import('../src/lib/userPhoto.js').catch(() => ({}));
const URLS_MAX = photo.PHOTO_URLS_MAX ?? 200;
const MARGIN = photo.PHOTO_LINK_REFRESH_BEFORE_MS ?? 10 * 60 * 1000;

// ── A. the crop ──────────────────────────────────────────────────────────────────────────
// (2026-10-04, Daniel live: "starts off too zoomed in". A1, A3, A4 and A10 changed with the rule:
// a crop now STARTS at fit (the whole photo inside the square) and zooms out that far; 1× still
// means cover, the short side's square. A2/A5/A6/A8 read the draw plan, cropDrawRects, which
// replaced cropSourceRect.)
const W = 4000; const H = 3000; // a landscape phone photo
const OUT = 320;
const insideImage = (r, w, h) => r.sx >= -1e-9 && r.sy >= -1e-9 && r.sx + r.sw <= w + 1e-9 && r.sy + r.sh <= h + 1e-9;
const fullCanvas = (r) => near(r.dx, 0) && near(r.dy, 0) && near(r.dw, OUT) && near(r.dh, OUT);
if (typeof crop.initialCrop === 'function' && typeof crop.cropDrawRects === 'function' && typeof crop.fitZoom === 'function') {
  const c0 = crop.initialCrop(W, H);
  const fit = crop.fitZoom(W, H);
  ok('A1: a new crop is centred at FIT (the whole photo shows)', c0.cx === W / 2 && c0.cy === H / 2 && near(c0.zoom, 0.75) && near(fit, 0.75));
  const r1 = crop.cropDrawRects(crop.zoomCrop(c0, 1, W, H), W, H, OUT);
  ok('A2: at 1× the crop is the short side\'s square, centred, filling the canvas', near(r1.sw, 3000) && near(r1.sh, 3000) && near(r1.sx, 500) && near(r1.sy, 0) && fullCanvas(r1));
  ok('A3: zoom is held to fit–3×', crop.zoomCrop(c0, 9, W, H).zoom === 3 && near(crop.zoomCrop(c0, 0.2, W, H).zoom, fit) && near(crop.zoomCrop(c0, NaN, W, H).zoom, fit));
  ok('A4: the zoom range: fit (short / long, 1 for a square) up to 3× of cover', crop.MAX_ZOOM === 3 && near(crop.fitZoom(4000, 3000), 0.75) && near(crop.fitZoom(3024, 4032), 0.75) && crop.fitZoom(1000, 1000) === 1 && !('MIN_ZOOM' in crop));
  const r3 = crop.cropDrawRects(crop.zoomCrop(c0, 3, W, H), W, H, OUT);
  ok('A5: at 3× the square is a third of the short side, still centred', near(r3.sw, 1000) && near(r3.sx, 1500) && near(r3.sy, 1000) && fullCanvas(r3));
  // Drag far past every edge: the square stops at the image's edge, never beyond.
  for (const [dx, dy, label] of [[1e6, 0, 'right'], [-1e6, 0, 'left'], [0, 1e6, 'down'], [0, -1e6, 'up']]) {
    const z2 = crop.zoomCrop(c0, 2, W, H);
    const r = crop.cropDrawRects(crop.panCrop(z2, dx, dy, W, H, 300), W, H, OUT);
    ok(`A6: a drag far ${label} leaves no empty corner (the square stays on the image)`, insideImage(r, W, H) && fullCanvas(r));
  }
  {
    // A 300 px viewport at 2×: one screen px = 3000 / 2 / 300 = 5 image px. Dragging the picture
    // 30 px to the RIGHT shows what was to its left: the centre moves 150 image px left.
    const z2 = crop.zoomCrop(c0, 2, W, H);
    const p = crop.panCrop(z2, 30, 0, W, H, 300);
    ok('A7: a drag moves the picture with the finger (30 screen px right = 150 image px left at 2× in 300 px)', near(p.cx, W / 2 - 150) && near(p.cy, H / 2));
  }
  for (const [zoom, dx, dy] of [[1.7, -55, 21], [0.85, 0, 40], [0.75, 0, 0]]) {
    // What is drawn and what is kept agree: the image's box in the viewport, cut to the square,
    // is exactly where the draw plan puts the image on the canvas, and shows the same pixels.
    const c = crop.panCrop(crop.zoomCrop(c0, zoom, W, H), dx, dy, W, H, 320);
    const box = crop.cropImageBox(c, W, H);
    const r = crop.cropDrawRects(c, W, H, OUT);
    const pct = (v) => (v / OUT) * 100;
    const visL = Math.max(0, box.left); const visT = Math.max(0, box.top);
    const visR = Math.min(100, box.left + box.width); const visB = Math.min(100, box.top + box.height);
    const perPx = box.width / W; // viewport % per image px
    ok(`A8: the drawn image and the kept square agree at ${zoom}× (the circle shows exactly what is kept)`,
      near(pct(r.dx), visL, 1e-6) && near(pct(r.dy), visT, 1e-6) && near(pct(r.dx + r.dw), visR, 1e-6) && near(pct(r.dy + r.dh), visB, 1e-6)
      && near(r.sx, (visL - box.left) / perPx, 1e-6) && near(r.sy, (visT - box.top) / perPx, 1e-6) && near(r.sw, (visR - visL) / perPx, 1e-6));
  }
  {
    const box = crop.cropImageBox(crop.zoomCrop(c0, 1.7, W, H), W, H);
    ok('A9: the image is placed in PERCENT (no inline px)', [box.left, box.top, box.width, box.height].every(Number.isFinite) && box.width >= 100 && box.height >= 100);
  }
  const portrait = crop.cropDrawRects(crop.zoomCrop(crop.initialCrop(1000, 2000), 1, 1000, 2000), 1000, 2000, OUT);
  ok('A10: at 1× a portrait photo crops its width\'s square, centred', near(portrait.sw, 1000) && near(portrait.sx, 0) && near(portrait.sy, 500) && fullCanvas(portrait));
} else {
  ok('A0: src/lib/photoCrop.js exports initialCrop, fitZoom and cropDrawRects', false);
}

// ── D. the crop STARTS with the whole photo (2026-10-04, Daniel: "starts off too zoomed in") ──
// The regression for the live report: a portrait phone photo opened at cover showed the middle
// band of its height and cut the head off, and the person could never zoom out past that.
{
  const PW = 3024; const PH = 4032; // an iPhone portrait photo (3:4)
  const LW = 4032; const LH = 3024; // and a landscape one (4:3)
  // Geometry is judged on the image's box in the square (cropImageBox, in percent of the
  // square's side), which both the old and the new crop have, so the old "starts zoomed in"
  // fails here on its own terms. The draw plan (cropDrawRects) is held to the same box in A8.
  const inSquare = (b) => b.left >= -1e-9 && b.top >= -1e-9 && b.left + b.width <= 100 + 1e-9 && b.top + b.height <= 100 + 1e-9;
  const coversSquare = (b) => b.left <= 1e-9 && b.top <= 1e-9 && b.left + b.width >= 100 - 1e-9 && b.top + b.height >= 100 - 1e-9;
  if (typeof crop.initialCrop === 'function' && typeof crop.cropImageBox === 'function') {
    const s = crop.initialCrop(PW, PH);
    const box = crop.cropImageBox(s, PW, PH);
    ok('D1: a 3024×4032 portrait STARTS with the whole image inside the square', inSquare(box));
    ok('D2: the zoom\'s floor is the fit zoom (short / long = 0.75), and nothing zooms out past it',
      near(s.zoom, 0.75) && near(crop.zoomCrop(s, 0.3, PW, PH).zoom, 0.75)
      && (typeof crop.fitZoom !== 'function' || near(crop.fitZoom(PW, PH), 0.75)));
    // At fit the image is centred with EQUAL bars on its short axis, and no bar on the other.
    ok('D3: at fit a portrait sits centred with equal bars left and right, none top and bottom',
      box.left > 1e-6 && near(box.left, 100 - (box.left + box.width), 1e-6) && near(box.top, 0) && near(box.height, 100) && near(box.width, 75));
    const l = crop.cropImageBox(crop.initialCrop(LW, LH), LW, LH);
    ok('D4: at fit a landscape sits centred with equal bars top and bottom, none left and right',
      l.top > 1e-6 && near(l.top, 100 - (l.top + l.height), 1e-6) && near(l.left, 0) && near(l.width, 100) && near(l.height, 75));
    // At cover or more the old rule holds: never an empty edge, wherever it is dragged.
    let edges = 0; let cases = 0;
    for (const [w, h] of [[PW, PH], [LW, LH]]) {
      for (const z of [1, 1.3, 2, 3]) {
        for (const [dx, dy] of [[1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6], [37, -91]]) {
          cases += 1;
          if (!coversSquare(crop.cropImageBox(crop.panCrop(crop.zoomCrop(crop.initialCrop(w, h), z, w, h), dx, dy, w, h, 300), w, h))) edges += 1;
        }
      }
    }
    ok(`D5: at zoom ≥ 1 there is never an empty edge (${cases} drags, ${edges} with an edge)`, edges === 0);
    // Below cover: the axis where the square is bigger than the image stays centred; the other pans.
    const mid = crop.zoomCrop(s, 0.85, PW, PH); // square 3557 px: wider than 3024, shorter than 4032
    const sideways = crop.cropImageBox(crop.panCrop(mid, 500, 0, PW, PH, 300), PW, PH);
    const down = crop.cropImageBox(crop.panCrop(mid, 0, 1e6, PW, PH, 300), PW, PH);
    ok('D6: below cover the barred axis never pans, and the other pans and stops at the edge',
      near(mid.zoom, 0.85) && near(sideways.left, 100 - (sideways.left + sideways.width), 1e-6) && sideways.left > 1e-6
      && near(down.top, 0) && down.top + down.height >= 100 - 1e-9);
  } else {
    ok('D0: photoCrop exports initialCrop and cropImageBox', false);
  }
  if (typeof crop.cropDrawRects === 'function') {
    // The saved square at fit: the whole image, centred, with equal bars.
    const r = crop.cropDrawRects(crop.initialCrop(PW, PH), PW, PH, OUT);
    ok('D6b: the saved photo at fit keeps the whole image, centred between equal bars',
      near(r.sx, 0) && near(r.sy, 0) && near(r.sw, PW) && near(r.sh, PH) && r.dx > 0 && near(r.dx, OUT - (r.dx + r.dw), 1e-6) && near(r.dy, 0) && near(r.dh, OUT));
  }
  // The saved photo: the canvas is FILLED first, then the image is drawn into an explicit
  // destination rectangle (never a source rectangle that runs past the image for drawImage to
  // clip — Safari has mishandled that).
  const ops = [];
  const fakeCanvas = {
    width: 0, height: 0,
    getContext: () => ({
      set fillStyle(v) { ops.push(['fillStyle', v]); },
      fillRect: (...a) => ops.push(['fillRect', ...a]),
      drawImage: (...a) => ops.push(['drawImage', ...a]),
    }),
    toBlob: (cb) => cb({ fake: true }),
  };
  const hadDoc = 'document' in globalThis;
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => fakeCanvas };
  try {
    const canvasLib = await import('../src/lib/imageCanvas.js');
    const plan = typeof crop.cropDrawRects === 'function' ? crop.cropDrawRects(crop.initialCrop(PW, PH), PW, PH, OUT) : { sx: 0, sy: 0, sw: PW, sh: PH, dx: 40, dy: 0, dw: 240, dh: 320 };
    await canvasLib.drawJpeg({ width: PW, height: PH }, { ...plan, width: OUT, height: OUT, fill: 'rgb(1, 2, 3)' });
    const firstFill = ops.findIndex((o) => o[0] === 'fillRect');
    const draw = ops.find((o) => o[0] === 'drawImage');
    ok('D7: drawJpeg fills the canvas with the given colour BEFORE it draws',
      ops.some((o) => o[0] === 'fillStyle' && o[1] === 'rgb(1, 2, 3)') && firstFill >= 0 && firstFill < ops.findIndex((o) => o[0] === 'drawImage')
      && JSON.stringify(ops[firstFill].slice(1)) === JSON.stringify([0, 0, OUT, OUT]));
    ok('D8: …and draws the image into the explicit destination rectangle (9 arguments, the plan\'s)',
      !!draw && draw.length === 10 && JSON.stringify(draw.slice(2)) === JSON.stringify([plan.sx, plan.sy, plan.sw, plan.sh, plan.dx, plan.dy, plan.dw, plan.dh]));
  } finally {
    if (hadDoc) globalThis.document = prevDoc; else delete globalThis.document;
  }
  // The fill is the avatar disc's own colour token, read at draw time (the colour ledger forbids
  // a literal), and the crop square shows the same colour behind the photo.
  const { readFileSync } = await import('node:fs');
  const editor = readFileSync(new URL('../src/components/AvatarPhotoEditor.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  ok('D9: the editor fills the saved photo with the disc colour token, read at draw time',
    /getComputedStyle\(document\.documentElement\)/.test(editor) && /'--avatar-1'/.test(editor) && /\bfill\s*[:,}]/.test(editor) && /cropDrawRects\(/.test(editor));
  ok('D10: the slider\'s min is the image\'s fit zoom (and the old fixed floor is gone)',
    /min=\{minZoom\}/.test(editor) && /const minZoom = fitZoom\(w, h\)/.test(editor) && !/MIN_ZOOM/.test(editor));
  ok('D11: the crop square shows the same colour behind the photo as the saved avatar\'s bars',
    /\.avatar-crop\s*\{[^}]*background:\s*var\(--avatar-1\)/.test(css));
}

// ── B. the link cache ────────────────────────────────────────────────────────────────────
const V1 = 'a1b2c3d4e5f6g7h8i9j0k1l2m';
const V2 = 'zz00yy11xx22ww33vv44uu55t';
function rig({ storage = memoryStorage(), answer } = {}) {
  let clock = Date.parse('2026-10-03T12:00:00Z');
  const calls = [];
  const timers = [];
  const fetchUrls = async (ids) => {
    calls.push([...ids]);
    return answer ? answer(ids, clock) : { urls: Object.fromEntries(ids.map((id) => [id, { v: id.endsWith('2') ? V2 : V1, url: `https://store.test/${id}?token=t${calls.length}`, expiresAt: new Date(clock + 6 * 3600e3).toISOString() }])) };
  };
  const loader = links.createAvatarUrlLoader({
    fetchUrls, storage, now: () => clock, schedule: (fn) => { timers.push(fn); return timers.length; },
  });
  const tick = async () => { while (timers.length) await timers.shift()(); };
  return { loader, calls, tick, storage, advance: (ms) => { clock += ms; }, now: () => clock };
}
function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m };
}
if (typeof links.createAvatarUrlLoader === 'function') {
  {
    const r = rig();
    for (let i = 0; i < 5; i += 1) r.loader.request(`u_${i}`, V1);
    r.loader.request('u_0', V1); // asked twice in the same tick
    await r.tick();
    ok('B1: the ids asked for in one tick go out in ONE call', r.calls.length === 1 && r.calls[0].length === 5);
    ok('B2: …and their links are held', r.loader.get('u_1', V1)?.url?.startsWith('https://store.test/u_1'));
    r.loader.request('u_1', V1);
    await r.tick();
    ok('B3: a held link is reused, not asked for again', r.calls.length === 1);
  }
  {
    const r = rig();
    for (let i = 0; i < URLS_MAX * 2 + 1; i += 1) r.loader.request(`u_x${i}`, V1);
    await r.tick();
    ok(`B4: ${URLS_MAX * 2 + 1} ids go out in calls of at most ${URLS_MAX}`, r.calls.length === 3 && r.calls.every((c) => c.length <= URLS_MAX)
      && r.calls.reduce((n, c) => n + c.length, 0) === URLS_MAX * 2 + 1);
  }
  {
    const r = rig();
    r.loader.request('u_a', V1);
    await r.tick();
    r.advance(6 * 3600e3 - MARGIN + 1000); // inside the last 10 minutes of the link
    ok('B5: a link within 10 minutes of expiring is not shown', r.loader.get('u_a', V1) === null);
    r.loader.request('u_a', V1);
    await r.tick();
    ok('B6: …and is asked for again', r.calls.length === 2 && !!r.loader.get('u_a', V1));
  }
  {
    const r = rig();
    r.loader.request('u_a', V1);
    await r.tick();
    r.loader.request('u_a', V2);
    await r.tick();
    ok('B7: a new photo (v change) asks again', r.calls.length === 2);
  }
  {
    const r = rig({ answer: (ids, t) => ({ urls: Object.fromEntries(ids.filter((id) => id !== 'u_none').map((id) => [id, { v: V1, url: `https://store.test/${id}`, expiresAt: new Date(t + 6 * 3600e3).toISOString() }])) }) });
    r.loader.request('u_none', V1);
    r.loader.request('u_ok', V1);
    await r.tick();
    r.loader.request('u_none', V1);
    await r.tick();
    ok('B8: a member the server answered nothing for is not asked about again at once (no polling)', r.calls.length === 1 && r.loader.get('u_none', V1) === null);
    r.advance((links.MISSING_RETRY_MS ?? 300000) + 1);
    r.loader.request('u_none', V1);
    await r.tick();
    ok('B9: …but is asked again after a while', r.calls.length === 2);
  }
  {
    const r = rig({ answer: (ids, t) => ({ urls: Object.fromEntries(ids.map((id) => [id, { v: V2, url: `https://store.test/${id}`, expiresAt: new Date(t + 6 * 3600e3).toISOString() }])) }) });
    r.loader.request('u_a', V1);
    await r.tick();
    ok('B10: a link for a DIFFERENT version than asked is not shown (it would be the wrong face)', r.loader.get('u_a', V1) === null && r.loader.get('u_a', V2) === null);
  }
  {
    const r = rig();
    r.loader.request('u_a', V1);
    await r.tick();
    r.loader.invalidate('u_a', V1);
    ok('B11: a link that failed to load is dropped', r.loader.get('u_a', V1) === null);
    r.loader.request('u_a', V1);
    await r.tick();
    ok('B12: …and asked for once more', r.calls.length === 2 && !!r.loader.get('u_a', V1));
  }
  {
    const storage = memoryStorage();
    const a = rig({ storage });
    a.loader.request('u_a', V1);
    await a.tick();
    const b = rig({ storage });
    ok('B13: a reload reuses the persisted link (the SAME URL, so the HTTP cache hits)',
      b.loader.get('u_a', V1)?.url === a.loader.get('u_a', V1)?.url && b.calls.length === 0);
    const c = rig({ storage, answer: (ids, t) => ({ urls: Object.fromEntries(ids.map((id) => [id, { v: V1, url: 'data:image/jpeg;base64,AAAA', expiresAt: new Date(t + 6 * 3600e3).toISOString() }])) }) });
    c.loader.request('u_demo', V1);
    await c.tick();
    const saved = JSON.parse(storage.getItem(links.LINKS_STORAGE_KEY ?? 'cleanspace_avatar_links_v1') || '{}');
    ok('B14: a data: URL (the demo) is never persisted', !Object.keys(saved).some((k) => k.startsWith('u_demo')) && !!c.loader.get('u_demo', V1));
    const old = memoryStorage({ [links.LINKS_STORAGE_KEY ?? 'cleanspace_avatar_links_v1']: JSON.stringify({ [`u_a:${V1}`]: { url: 'https://store.test/old', expiresAt: '2026-10-03T12:05:00Z' } }) });
    const d = rig({ storage: old });
    ok('B15: a persisted link that is no longer fresh is not reused', d.loader.get('u_a', V1) === null);
  }
  {
    const r = rig({ answer: () => { throw new Error('offline'); } });
    r.loader.request('u_a', V1);
    await r.tick();
    r.loader.request('u_a', V1);
    await r.tick();
    ok('B16: a failed call (offline) is not taken as "no photo": the next ask tries again', r.calls.length === 2);
  }
  {
    // A sign-out on a shared phone: the signed links (bearer links to private photos) go, in
    // memory and on the device, and AuthProvider's two sign-out paths both ask for it.
    const storage = memoryStorage();
    const r = rig({ storage });
    r.loader.request('u_a', V1);
    await r.tick();
    const had = !!r.loader.get('u_a', V1) && storage.getItem(links.LINKS_STORAGE_KEY ?? 'cleanspace_avatar_links_v1') !== null;
    if (typeof r.loader.clear === 'function') r.loader.clear();
    ok('B19: clear() forgets every link, in memory and on the device', had && r.loader.get('u_a', V1) === null
      && storage.getItem(links.LINKS_STORAGE_KEY ?? 'cleanspace_avatar_links_v1') === null);
    const { readFileSync } = await import('node:fs');
    const auth = readFileSync(new URL('../src/auth/AuthProvider.jsx', import.meta.url), 'utf8');
    ok('B20: both sign-out paths (the deliberate one and the terminal-auth one) clear the links',
      typeof links.clearAvatarLinks === 'function' && (auth.match(/clearAvatarLinks\(\)/g) || []).length === 2);
  }
  ok('B17: isLinkFresh refuses junk', links.isLinkFresh(null) === false && links.isLinkFresh({ url: '', expiresAt: '2099-01-01T00:00:00Z' }) === false
    && links.isLinkFresh({ url: 'https://x', expiresAt: 'soon' }) === false);
  ok('B18: chunkIds splits at the cap', JSON.stringify(links.chunkIds(['a', 'b', 'c'], 2)) === JSON.stringify([['a', 'b'], ['c']]));
} else {
  ok('B0: src/lib/avatarUrls.js exists with createAvatarUrlLoader', false);
}

// ── C. every avatar on a screen is classified (UI_RULES §141's ledger) ───────────────────
// A team member's avatar passes the roster row (`user={u}`), so it shows their photo; anything
// else on initials alone must be a contact, customer, company or channel, listed here by file
// with its count. A new initials-only `<Avatar>` fails until someone says which it is — the
// shape that existed before the photos (`initials={x.initials} variant={x.avatar}`, a user's
// two fields passed apart) is exactly how a team member would silently lose their photo.
{
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const APP = fileURLToPath(new URL('..', import.meta.url));
  const INITIALS_ONLY = {
    'src/components/AddContactsToStageModal.jsx': 1, // a company in the pipeline picker
    'src/components/ClientNamePicker.jsx': 4,        // customers and groups
    'src/components/ContactPicker.jsx': 2,           // contacts
    'src/components/ConversationContextPanel.jsx': 2, // a customer thread's contact, and a DM with nobody ("?")
    'src/components/CustomerMessagesInbox.jsx': 2,   // a building (customer) in the Customers list and its context pane
    'src/components/MessageContactMenu.jsx': 1,      // a contact
    'src/components/NewConversationModal.jsx': 1,    // a contact
    'src/components/OpportunityDetailModal.jsx': 1,  // the opportunity's contact
    'src/pages/ClientDetail.jsx': 1,                 // a customer's contact (the note author passes user)
    'src/pages/Clients.jsx': 1,                      // a company row
    'src/pages/marketing/SequenceContactsModal.jsx': 2, // enrolled contacts
    'src/pages/marketing/SequenceEditorPanel.jsx': 2,   // enrolled contacts
    'src/pages/marketing/StepEnrollmentsModal.jsx': 1,  // enrolled contacts
  };
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.jsx?$/.test(name)) files.push(p);
    }
  };
  walk(join(APP, 'src'));
  const found = {};
  let users = 0;
  let oldShape = 0;
  for (const f of files) {
    const rel = relative(APP, f).split('\\').join('/');
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Each `<Avatar` element (not `<AvatarPhotoEditor`), whole, across lines.
    for (const m of src.matchAll(/<Avatar(\s[^>]*?)\/>/g)) {
      if (/\buser=\{/.test(m[1])) { users += 1; continue; }
      if (/initials=\{([\w.]+)\.initials\}\s+variant=\{\1\.avatar\}/.test(m[1])) oldShape += 1;
      found[rel] = (found[rel] || 0) + 1;
    }
  }
  ok(`C1: no avatar passes a person's initials and colour apart (the pre-photo shape; found ${oldShape})`, oldShape === 0);
  const same = JSON.stringify(Object.entries(found).sort()) === JSON.stringify(Object.entries(INITIALS_ONLY).sort());
  ok(`C2: every initials-only avatar is a classified non-member (${Object.values(found).reduce((a, b) => a + b, 0)} found; ${JSON.stringify(found)})`, same);
  ok(`C3: the team-member avatars pass the row (${users} sites)`, users >= 40);
  const avatar = readFileSync(join(APP, 'src/components/Avatar.jsx'), 'utf8');
  ok('C4: the Avatar draws the initials first and layers the photo over them, hidden until it loads',
    /\{letters\}[\s\S]*<img[\s\S]*className=\{`avatar-img\$\{loaded === url \? ' is-loaded' : ''\}`\}/.test(avatar)
    && /loading="lazy"/.test(avatar) && /decoding="async"/.test(avatar) && /alt=""/.test(avatar) && /onError=\{onError\}/.test(avatar));
  const css = readFileSync(join(APP, 'src/index.css'), 'utf8');
  ok('C5: the photo fills the disc without changing its size (absolute, inset 0, cover; the disc clips it)',
    /\.avatar-img\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*object-fit:\s*cover;[^}]*opacity:\s*0;/.test(css)
    && /\.avatar\s*\{[^}]*position:\s*relative;\s*overflow:\s*hidden;/.test(css));
}

console.log(`\ntest-avatar-client: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
