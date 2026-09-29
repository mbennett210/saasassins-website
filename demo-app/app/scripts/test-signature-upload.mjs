// Server-side signature upload validation — C07 part 2.
//
// The only check today is `file.size > 1024 * 1024` in Settings → Account, CLIENT
// SIDE — and the blob is directly writable under the open RLS policy until Increment
// 1e, so that check is advisory in both directions. This is the server half.
//
// ⚠️ THE PATH PROPERTY IS THE POINT. It is derived from the caller's JWT claim, never
// from the body, so writing another user's object is NOT EXPRESSIBLE rather than
// merely refused. account-media shipped the opposite shape — authorize one id, write a
// caller-supplied `storagePath` verbatim — which made it a read primitive over the
// whole private bucket (AUTHORIZATION_AUDIT #5).
//
//   node scripts/test-signature-upload.mjs
import {
  validateSignatureUpload, sniffImage, signaturePathFor, SIGNATURE_UPLOAD_MAX_BYTES,
} from '../api/_lib/signatureUpload.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// Real magic bytes — a size check that never looks at content is how a "signature"
// becomes something else once it is served back under a signed URL.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]);
const url = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
const pad = (buf, n) => Buffer.concat([buf, Buffer.alloc(Math.max(0, n - buf.length))]);

// ── 🔴 the path can only ever be the caller's own ───────────────────────
{
  const p = signaturePathFor('u_kyle', 'png');
  ok('the path contains the caller org user id', p.includes('u_kyle'));
  ok('  ...under a _signatures prefix that cannot be a site id (those are st_*)', p.includes('/_signatures/'));
  ok('  ...and is org-pinned', p.split('/').length === 3);
  ok('a different user yields a different path', signaturePathFor('u_liz', 'png') !== p);
  // There is no parameter through which a caller could express someone else's path —
  // the only inputs are their own claim id and a validated extension.
  ok('the extension is the only other input', signaturePathFor('u_kyle', 'jpg').endsWith('u_kyle.jpg'));
}

// ── accepted types ──────────────────────────────────────────────────────
ok('PNG accepted', validateSignatureUpload(url('image/png', PNG)).ok);
ok('JPEG accepted', validateSignatureUpload(url('image/jpeg', JPG)).ok);
ok('GIF accepted', validateSignatureUpload(url('image/gif', GIF)).ok);
ok('  ...and the extension is derived, not taken from the caller',
  validateSignatureUpload(url('image/jpeg', JPG)).ext === 'jpg');
ok('  ...decoded byte count is returned', validateSignatureUpload(url('image/png', PNG)).bytes === PNG.length);

// ── rejected types ──────────────────────────────────────────────────────
// SVG is excluded on purpose: it is executable markup in some mail clients.
ok('SVG rejected', !validateSignatureUpload(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`).ok);
ok('webp rejected', !validateSignatureUpload(`data:image/webp;base64,${PNG.toString('base64')}`).ok);
ok('pdf rejected', !validateSignatureUpload(`data:application/pdf;base64,${PNG.toString('base64')}`).ok);
ok('a plain http url is rejected', !validateSignatureUpload('https://example.com/sig.png').ok);
ok('a non-base64 data url is rejected', !validateSignatureUpload('data:image/png,rawbytes').ok);

// ── 🔴 declared type must match actual bytes ────────────────────────────
{
  const lying = validateSignatureUpload(url('image/png', JPG));
  ok('a JPEG declared as PNG is rejected', !lying.ok);
  ok('  ...and the error says what it really is', /image\/jpeg/.test(lying.error));
  ok('arbitrary bytes declared as PNG are rejected',
    !validateSignatureUpload(url('image/png', Buffer.from('not an image at all'))).ok);
  // A payload that is valid base64 of nothing useful must not slip through on size.
  ok('an HTML payload declared as GIF is rejected',
    !validateSignatureUpload(url('image/gif', Buffer.from('<html><script>x</script></html>'))).ok);
}

// ── size, enforced on DECODED bytes ─────────────────────────────────────
// The caller controls the base64 length directly; the decoded length is what actually
// lands in Storage and, pre-C07, in the blob.
{
  const big = pad(PNG, SIGNATURE_UPLOAD_MAX_BYTES + 1);
  const r = validateSignatureUpload(url('image/png', big));
  ok('over the cap is rejected', !r.ok);
  ok('  ...and the message states both sizes', /\d+ KB/.test(r.error) && /limit/.test(r.error));
  ok('exactly at the cap is accepted', validateSignatureUpload(url('image/png', pad(PNG, SIGNATURE_UPLOAD_MAX_BYTES))).ok);
  ok('the cap sits inside the per-user blob budget (36 KB image vs 48 KB base64)',
    Math.ceil(SIGNATURE_UPLOAD_MAX_BYTES * 4 / 3) <= 48 * 1024);
}

// ── CRLF cannot be smuggled toward a MIME header ────────────────────────
// The image rides out as an inline CID attachment; a data URL carrying CR/LF is the
// classic route into a downstream header.
ok('CR/LF in the payload is rejected', !validateSignatureUpload('data:image/png;base64,AAAA\r\nBcc: x@y.z').ok);
ok('a semicolon parameter is rejected', !validateSignatureUpload(`data:image/png;charset=utf-8;base64,${PNG.toString('base64')}`).ok);
// Whitespace inside base64 is legal per RFC 2045 line folding and must still decode.
ok('folded base64 (whitespace) still decodes', validateSignatureUpload(
  `data:image/png;base64,${PNG.toString('base64').replace(/(.{4})/, '$1\n')}`).ok);

// ── degenerate input never throws ───────────────────────────────────────
for (const [label, v] of [
  ['undefined', undefined], ['null', null], ['empty string', ''], ['a number', 12345],
  ['an object', { dataUrl: 'x' }], ['an array', []], ['just the prefix', 'data:image/png;base64,'],
]) ok(`${label} is rejected without throwing`, validateSignatureUpload(v).ok === false);

// ── sniffImage on its own ───────────────────────────────────────────────
ok('sniff PNG', sniffImage(PNG) === 'image/png');
ok('sniff JPEG', sniffImage(JPG) === 'image/jpeg');
ok('sniff GIF', sniffImage(GIF) === 'image/gif');
ok('sniff rejects short buffers', sniffImage(Buffer.from([0x89, 0x50])) === null);
ok('sniff rejects null', sniffImage(null) === null);
ok('sniff rejects unknown magic', sniffImage(Buffer.from('PKabcdefgh')) === null);

console.log(`\nsignature upload: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
