// Node unit test for the signature image-width helpers + buildOutboundEmail's
// width emission — no DOM / network needed. Verifies the WYSIWYG contract's
// sizing half (§48): the resolved width clamps garbage to the default and the
// sent HTML carries max-width:<resolved>px. Run from repo root:
//   node app/scripts/test-signature-width.mjs
import {
  buildOutboundEmail,
  signatureImageWidth,
  DEFAULT_SIGNATURE_IMAGE_WIDTH,
  SIGNATURE_IMAGE_WIDTH_PRESETS,
} from '../src/lib/signature.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

// A tiny valid 1x1 PNG data URL so buildOutboundEmail takes the HTML/image path.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---- signatureImageWidth unit cases ----
ok(signatureImageWidth({ imageWidth: 360 }) === 360, 'passes through in-range 360');
ok(signatureImageWidth({ imageWidth: 160 }) === 160, 'passes through in-range 160 (S)');
ok(signatureImageWidth({ imageWidth: 600 }) === 600, 'passes through boundary max 600');
ok(signatureImageWidth({ imageWidth: 80 }) === 80, 'passes through boundary min 80');
ok(signatureImageWidth(undefined) === DEFAULT_SIGNATURE_IMAGE_WIDTH, 'undefined prefs → default');
ok(signatureImageWidth({}) === DEFAULT_SIGNATURE_IMAGE_WIDTH, 'missing imageWidth → default');
ok(signatureImageWidth({ imageWidth: 0 }) === DEFAULT_SIGNATURE_IMAGE_WIDTH, 'zero → default');
ok(signatureImageWidth({ imageWidth: 40 }) === DEFAULT_SIGNATURE_IMAGE_WIDTH, 'below-min 40 → default');
ok(signatureImageWidth({ imageWidth: 9999 }) === DEFAULT_SIGNATURE_IMAGE_WIDTH, 'above-max 9999 → default');
ok(signatureImageWidth({ imageWidth: 'garbage' }) === DEFAULT_SIGNATURE_IMAGE_WIDTH, 'non-numeric → default');
ok(signatureImageWidth({ imageWidth: NaN }) === DEFAULT_SIGNATURE_IMAGE_WIDTH, 'NaN → default');
ok(signatureImageWidth({ imageWidth: '240' }) === 240, 'numeric string coerces');
ok(signatureImageWidth({ imageWidth: 240.6 }) === 241, 'fractional rounds');
ok(DEFAULT_SIGNATURE_IMAGE_WIDTH === 240, 'default is 240');
ok(SIGNATURE_IMAGE_WIDTH_PRESETS.S === 160 && SIGNATURE_IMAGE_WIDTH_PRESETS.M === 240 && SIGNATURE_IMAGE_WIDTH_PRESETS.L === 360, 'presets S160/M240/L360');

// ---- buildOutboundEmail width emission ----
const at = (prefs) => buildOutboundEmail('Hello there', prefs).sendBody;

ok(at({ enabled: true, imageDataUrl: PNG, imageWidth: 360 }).includes('max-width:360px'), 'imageWidth 360 → max-width:360px');
ok(at({ enabled: true, imageDataUrl: PNG, imageWidth: 160 }).includes('max-width:160px'), 'imageWidth 160 → max-width:160px');
ok(at({ enabled: true, imageDataUrl: PNG }).includes('max-width:240px'), 'no imageWidth → default max-width:240px');
ok(at({ enabled: true, imageDataUrl: PNG, imageWidth: 'garbage' }).includes('max-width:240px'), 'garbage width clamps to 240px in HTML');
ok(at({ enabled: true, imageDataUrl: PNG, imageWidth: 5000 }).includes('max-width:240px'), 'out-of-range 5000 clamps to 240px in HTML');
ok(!at({ enabled: true, imageDataUrl: PNG, imageWidth: 360 }).includes('max-width:240px'), '360 does not also emit the 240 default');

// No image → plain text, no width markup at all.
const noImg = buildOutboundEmail('Hello', { enabled: true, text: 'Sig' });
ok(noImg.inlineImages.length === 0 && !noImg.sendBody.includes('max-width'), 'text-only signature emits no image width');

console.log(`\ntest-signature-width: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
