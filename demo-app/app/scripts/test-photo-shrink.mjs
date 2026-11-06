// CS-678 — a photo is shrunk on the device before it is uploaded, on every photo path.
//
// THE BUG. lib/accountMediaApi uploadMedia stored the camera's file as picked (only a 480 px
// poster was made), and the visit, checklist-item, account, work-order and inspection photos,
// the client hub's ticket photo and the support report's all handed the camera file straight
// in: 3–12 MB a photo, kept forever — tens of gigabytes a month at ~16,000 cleans.
//
// THE FIX. ONE helper, lib/imageCanvas shrinkPhoto: a CAMERA photo (JPEG / HEIC) is redrawn at
// most PHOTO_MAX_EDGE (1,600) px on its long edge as a JPEG at PHOTO_QUALITY (0.8), upright (the
// EXIF orientation applied while decoding — the redrawn file has no EXIF); a video, a screenshot
// (PNG), a GIF, a document, an undecodable photo, or one that would not shrink, goes up exactly
// as picked. Every photo upload path calls it first.
//
// HOW. The helper runs in node with the browser's two primitives stubbed — createImageBitmap
// (records how it was asked to decode) and a canvas whose encoder models a JPEG's size (about
// 0.2 bytes a pixel at quality 0.8: 1600×1200 → ~375 KB). The real-browser measurement is in the
// builder's report. The paths are checked in their source.
//
//   node app/scripts/test-photo-shrink.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(APP, rel), 'utf8');

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail)
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// ── the browser's primitives, stubbed ─────────────────────────────────────────────────────
const DIMS = new Map();          // picked File → its decoded size (absent: undecodable, e.g. HEIC on a desktop)
const decodes = [];              // every createImageBitmap call: { src, opts }
const bitmaps = [];              // every bitmap handed out (to see each one closed)
let encoderBroken = false;
const canvases = [];
globalThis.createImageBitmap = async (src, opts) => {
  decodes.push({ src, opts });
  const d = DIMS.get(src);
  if (!d) throw new Error('The source image could not be decoded.');
  const bmp = { width: d.w, height: d.h, closed: false, close() { this.closed = true; } };
  bitmaps.push(bmp);
  return bmp;
};
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
    const c = {
      width: 0, height: 0, type: null, quality: null, draws: 0,
      getContext: () => ({ fillRect() {}, drawImage() { c.draws += 1; } }),
      toBlob(cb, type, quality) {
        c.type = type; c.quality = quality;
        if (encoderBroken) { cb(null); return; }
        cb(new Blob([new Uint8Array(Math.round(c.width * c.height * quality * 0.25))], { type }));
      },
    };
    canvases.push(c);
    return c;
  },
};
const picked = (name, type, bytes, dims) => {
  const f = new File([new Uint8Array(bytes)], name, { type, lastModified: 1700000000000 });
  if (dims) DIMS.set(f, { w: dims[0], h: dims[1] });
  return f;
};
const reset = () => { decodes.length = 0; bitmaps.length = 0; canvases.length = 0; encoderBroken = false; };
const MB = 1024 * 1024;

const ic = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'imageCanvas.js')).href);
const shrink = typeof ic.shrinkPhoto === 'function' ? ic.shrinkPhoto : null;
ok('0.1 🔴 lib/imageCanvas exports shrinkPhoto, the one helper', !!shrink);
ok('0.2 the rule is its constants: 1,600 px long edge, JPEG quality 0.8', ic.PHOTO_MAX_EDGE === 1600 && ic.PHOTO_QUALITY === 0.8);
const run = async (f) => (shrink ? shrink(f) : f);

// ── 1. a landscape camera photo: 4032×3024, 4.8 MB ───────────────────────────────────────
reset();
{
  const f = picked('IMG_0412.JPG', 'image/jpeg', Math.round(4.8 * MB), [4032, 3024]);
  const out = await run(f);
  const c = canvases[0];
  ok(`1.1 🔴 redrawn at the long edge ${ic.PHOTO_MAX_EDGE}, the aspect kept: ${c ? `${c.width}×${c.height}` : 'no canvas'}`, !!c && c.width === 1600 && c.height === 1200);
  ok(`1.2 🔴 as a JPEG at ${ic.PHOTO_QUALITY}`, !!c && c.type === 'image/jpeg' && c.quality === 0.8);
  ok(`1.3 🔴 what is uploaded is the small file: ${out?.size} bytes (was ${f.size})`, out !== f && out instanceof File && out.size < 500 * 1024 && out.size < f.size);
  ok('1.4 a JPEG File, named .jpg, its date kept', out?.type === 'image/jpeg' && out?.name === 'IMG_0412.jpg' && out?.lastModified === f.lastModified);
  ok('1.5 🔴 decoded UPRIGHT: the EXIF orientation applied (the redrawn file carries no EXIF)', decodes.some((d) => d.src === f && d.opts?.imageOrientation === 'from-image'));
  ok('1.6 the decoded photo is released (tens of MB on a phone)', bitmaps.length > 0 && bitmaps.every((b) => b.closed));
}

// ── 2. a portrait one stays portrait ─────────────────────────────────────────────────────
reset();
{
  const out = await run(picked('IMG_0413.jpeg', 'image/jpeg', Math.round(3.9 * MB), [3024, 4032]));
  const c = canvases[0];
  ok(`2.1 a portrait photo comes out portrait, 1200×1600: ${c ? `${c.width}×${c.height}` : 'no canvas'}`, !!c && c.width === 1200 && c.height === 1600 && out?.name === 'IMG_0413.jpg');
}

// ── 3. HEIC the browser can read: shrunk to JPEG; HEIC it cannot: as picked ──────────────
reset();
{
  const heic = picked('IMG_0414.HEIC', 'image/heic', Math.round(2.6 * MB), [4032, 3024]);
  const out = await run(heic);
  ok('3.1 a HEIC this browser decodes becomes a small JPEG', out !== heic && out?.type === 'image/jpeg' && out?.name === 'IMG_0414.jpg');
  reset();
  const opaque = picked('IMG_0415.HEIC', 'image/heic', Math.round(2.6 * MB), null);
  ok('3.2 one it cannot decode (a desktop browser) goes up as picked — never lost', (await run(opaque)) === opaque);
  ok('3.3 …after trying with and without the orientation option', decodes.filter((d) => d.src === opaque).length === 2);
}

// ── 4. what is never redrawn ──────────────────────────────────────────────────────────────
reset();
{
  const video = picked('clip.mp4', 'video/mp4', 30 * MB, null);
  const png = picked('screenshot-2026-10-13.png', 'image/png', 2 * MB, [2560, 1440]);
  const gif = picked('spinner.gif', 'image/gif', 1 * MB, [2000, 2000]);
  const pdf = picked('invoice.pdf', 'application/pdf', 1 * MB, null);
  ok('4.1 🔴 a video goes up exactly as picked', (await run(video)) === video);
  ok('4.2 a screenshot (PNG) too — recompressing would blur its text', (await run(png)) === png);
  ok('4.3 a GIF too (it may move)', (await run(gif)) === gif);
  ok('4.4 a document too', (await run(pdf)) === pdf);
  ok('4.5 …none of them even decoded', decodes.length === 0 && canvases.length === 0);
}

// ── 5. small already, or nothing to gain ──────────────────────────────────────────────────
reset();
{
  const small = picked('small.jpg', 'image/jpeg', 300 * 1024, [1200, 900]);
  ok('5.1 a photo within the edge and under 500 KB goes up as it is (no second JPEG loss)', (await run(small)) === small && canvases.length === 0);
  reset();
  const heavy = picked('scan.jpg', 'image/jpeg', 2 * MB, [1200, 900]);
  const out = await run(heavy);
  ok('5.2 one within the edge but heavy is re-encoded at its own size — never enlarged', out !== heavy && canvases[0]?.width === 1200 && canvases[0]?.height === 900 && out.size < heavy.size);
  reset();
  const tight = picked('tight.jpg', 'image/jpeg', 600 * 1024, [1600, 1200]); // the model encodes 1600×1200 to ~375 KB
  ok('5.3 one that the encoder would make no smaller goes up as it is', (await run(picked('dense.jpg', 'image/jpeg', 200 * 1024 + 1, [4032, 3024]))).name === 'dense.jpg');
  ok('  …and a real gain is taken', (await run(tight)) !== tight);
  reset();
  encoderBroken = true;
  const f = picked('IMG_0416.jpg', 'image/jpeg', 5 * MB, [4032, 3024]);
  ok('5.4 a canvas that cannot encode: the photo goes up as picked, its bitmap still released', (await run(f)) === f && bitmaps.every((b) => b.closed));
}

// ── 6. every photo path shrinks first ─────────────────────────────────────────────────────
{
  const media = read('src/lib/accountMediaApi.js');
  const upload = (media.match(/export async function uploadMedia\([\s\S]*?\n\}/) || [])[0] || '';
  ok('6.1 🔴 uploadMedia (visit, checklist-item, account, work-order and inspection photos) shrinks the picked file first',
    /export async function uploadMedia\(picked,/.test(upload) && /^\s*const file = await shrinkPhoto\(picked\);/m.test(upload.split('\n')[1] || ''));
  ok('  …so the size cap, the upload and the offline queue all see the small file', !/\bpicked\b/.test(upload.split('\n').slice(2).join('\n')));
  ok('6.2 the gallery and the checklist-item photo upload through uploadMedia',
    /mediaApi\.uploadMedia\(/.test(read('src/components/MediaGallery.jsx')) && /mediaApi\.uploadMedia\(/.test(read('src/components/ChecklistItemPhoto.jsx')));
  const hub = read('src/lib/clientHubApi.js');
  const attach = (hub.match(/export async function attachHubTicketPhoto\([\s\S]*?\n\}/) || [])[0] || '';
  ok('6.3 🔴 the client hub\'s ticket photo shrinks first (the demo hub goes through uploadMedia)',
    /file: picked/.test(attach) && /^\s*const file = await shrinkPhoto\(picked\);/m.test(attach.split('\n')[1] || ''));
  const support = read('src/lib/supportApi.js');
  ok('6.4 🔴 the support report shrinks each photo before it is checked and sent',
    /for \(const picked of files\) \{[\s\S]{0,260}const file = await shrinkPhoto\(picked\);\s*\n\s*const problem = validateAttachment\(file\);/.test(support));
  // Every upload into the photo bucket, wherever it is written, goes through the helper — but
  // one: a location's ACCESS ATTACHMENTS (lib/siteAttachmentsApi, CS-043) are documents — a
  // site map, a walkthrough PDF, a key-box photo the crew must read — one set per location, not
  // per clean, kept exactly as uploaded so a map stays legible. A new uploader is caught here.
  const DOCUMENTS = new Set(['src/lib/siteAttachmentsApi.js']);
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : (/\.(jsx?|mjs)$/.test(n) ? [p] : []);
  });
  const uploaders = walk(path.join(APP, 'src')).filter((p) => {
    const s = readFileSync(p, 'utf8');
    return /uploadToSignedUrl\(/.test(s) && /'ops-media'/.test(s);
  }).map((p) => path.relative(APP, p).replace(/\\/g, '/'));
  const photoPaths = uploaders.filter((p) => !DOCUMENTS.has(p));
  ok(`6.5 every file that uploads PHOTOS into the photo bucket shrinks first: ${photoPaths.join(', ')}`,
    photoPaths.length >= 2 && photoPaths.every((p) => /shrinkPhoto\(/.test(read(p))));
  ok('  …and the one document path is still where it was (an exemption that outlives its file is dead)', [...DOCUMENTS].every((p) => uploaders.includes(p)));
}

console.log(`\nphoto shrink: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exitCode = 1; }
