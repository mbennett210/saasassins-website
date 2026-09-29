// Tri-shape signature image reader — C07 foundation.
//
// The image is moving out of the org_state blob into Supabase Storage. The plan says
// "dual-shape readers"; it is THREE, and the third is the one that actually exists:
//
//   'none'     signaturePrefs absent / disabled / no image.
//              ⚠️ 0 of 43 live users have signaturePrefs at all (verified by SELECT).
//              The v45→v46 backfill that would have created it runs only in
//              local/demo mode, so production never got it. A migration written for
//              "legacy → new" would find nothing and silently do nothing.
//   'inline'   imageDataUrl — base64 in the blob. What the app writes today.
//   'storage'  imagePath — a Storage object key; bytes are NOT in the blob.
//
// ⚠️ FIELD NAMES ARE ASSERTED AGAINST seed.js, NOT RESTATED. The blob-budget guard
// shipped INERT in this exact area by assuming `signatureDataUrl` when the real field
// is `imageDataUrl`, and its tests passed because they shared the wrong premise.
//
//   node scripts/test-signature-shapes.mjs
import { readFileSync } from 'node:fs';
import {
  resolveSignatureImage, SIGNATURE_SHAPE, signatureHasContent,
  signatureImageWidth, DEFAULT_SIGNATURE_IMAGE_WIDTH,
} from '../src/lib/signature.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const on = (over = {}) => ({ enabled: true, text: '', imageWidth: 240, ...over });

// ── 🔴 the field names must match the app's real shape ──────────────────
{
  const seed = readFileSync(new URL('../src/data/seed.js', import.meta.url), 'utf8');
  const block = (seed.match(/DEFAULT_SIGNATURE_PREFS = \{[\s\S]*?\n\};/) || [])[0] || '';
  ok('DEFAULT_SIGNATURE_PREFS found', block.length > 0);
  ok('  ...declares imageDataUrl (the INLINE shape)', /imageDataUrl\s*:/.test(block));
  ok('  ...declares imageWidth', /imageWidth\s*:/.test(block));
  ok('  ...declares enabled', /enabled\s*:/.test(block));
  // The reader must actually key off those names, not lookalikes.
  ok('the reader reads imageDataUrl', resolveSignatureImage(on({ imageDataUrl: DATA_URL })).kind === SIGNATURE_SHAPE.INLINE);
  ok('a lookalike field is NOT mistaken for an image',
    resolveSignatureImage(on({ signatureDataUrl: DATA_URL })).kind === SIGNATURE_SHAPE.NONE);
}

// ── the three shapes ────────────────────────────────────────────────────
ok('absent prefs -> none', resolveSignatureImage(undefined).kind === SIGNATURE_SHAPE.NONE);
ok('null prefs -> none', resolveSignatureImage(null).kind === SIGNATURE_SHAPE.NONE);
ok('THE LIVE STATE (no signaturePrefs at all) -> none', resolveSignatureImage({}).kind === SIGNATURE_SHAPE.NONE);
ok('enabled but empty -> none', resolveSignatureImage(on()).kind === SIGNATURE_SHAPE.NONE);
ok('inline data URL -> inline', resolveSignatureImage(on({ imageDataUrl: DATA_URL })).kind === SIGNATURE_SHAPE.INLINE);
ok('  ...carries the data URL through', resolveSignatureImage(on({ imageDataUrl: DATA_URL })).dataUrl === DATA_URL);
ok('storage path -> storage', resolveSignatureImage(on({ imagePath: 'sig/u1.png' })).kind === SIGNATURE_SHAPE.STORAGE);
ok('  ...carries the path through', resolveSignatureImage(on({ imagePath: 'sig/u1.png' })).path === 'sig/u1.png');

// ── disabled beats everything ───────────────────────────────────────────
// A user who turned the signature off must not have it attached, regardless of shape.
ok('disabled + inline -> none', resolveSignatureImage({ enabled: false, imageDataUrl: DATA_URL }).kind === SIGNATURE_SHAPE.NONE);
ok('disabled + storage -> none', resolveSignatureImage({ enabled: false, imagePath: 'sig/u1.png' }).kind === SIGNATURE_SHAPE.NONE);
ok('missing `enabled` reads as off', resolveSignatureImage({ imageDataUrl: DATA_URL }).kind === SIGNATURE_SHAPE.NONE);

// ── 🔴 the migration window: BOTH shapes present ────────────────────────
// Storage must win. Preferring the data URL would leave a half-migrated user silently
// on the blob copy forever — they would never converge, and the blob would never shrink.
{
  const both = on({ imageDataUrl: DATA_URL, imagePath: 'sig/u1.png' });
  ok('both present -> STORAGE wins', resolveSignatureImage(both).kind === SIGNATURE_SHAPE.STORAGE);
  ok('  ...and it is the path that is returned', resolveSignatureImage(both).path === 'sig/u1.png');
}

// ── degenerate values must not read as an image ─────────────────────────
for (const [label, prefs] of [
  ['empty-string dataUrl', on({ imageDataUrl: '' })],
  ['null dataUrl', on({ imageDataUrl: null })],
  ['empty-string path', on({ imagePath: '' })],
  ['null path', on({ imagePath: null })],
  ['numeric dataUrl', on({ imageDataUrl: 12345 })],
  ['object path', on({ imagePath: { p: 'x' } })],
  ['array dataUrl', on({ imageDataUrl: [DATA_URL] })],
]) ok(`${label} -> none`, resolveSignatureImage(prefs).kind === SIGNATURE_SHAPE.NONE);

// ── width travels with every shape ──────────────────────────────────────
ok('inline carries a width', resolveSignatureImage(on({ imageDataUrl: DATA_URL, imageWidth: 360 })).width === 360);
ok('storage carries a width', resolveSignatureImage(on({ imagePath: 'p', imageWidth: 160 })).width === 160);
ok('an out-of-range width falls back to the default',
  resolveSignatureImage(on({ imageDataUrl: DATA_URL, imageWidth: 9999 })).width === DEFAULT_SIGNATURE_IMAGE_WIDTH);
ok('signatureImageWidth is unchanged for a bare prefs', signatureImageWidth({}) === DEFAULT_SIGNATURE_IMAGE_WIDTH);

// ── signatureHasContent still behaves (it now routes through the reader) ─
ok('text-only signature has content', signatureHasContent(on({ text: 'Kyle' })));
ok('inline-image-only has content', signatureHasContent(on({ imageDataUrl: DATA_URL })));
ok('STORAGE-image-only has content (the new shape counts)', signatureHasContent(on({ imagePath: 'sig/u1.png' })));
ok('empty enabled signature has no content', !signatureHasContent(on()));
ok('disabled with text has no content', !signatureHasContent({ enabled: false, text: 'Kyle' }));
ok('absent prefs has no content', !signatureHasContent(undefined));
ok('whitespace-only text does not count', !signatureHasContent(on({ text: '   \n ' })));

console.log(`\nsignature shapes: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
