// Server-side signature image upload — C07 part 2.
//
// ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════
// Signature images are base64 data URLs inside the org_state blob today. The only
// validation is `file.size > 1024 * 1024` in Settings → Account — CLIENT SIDE, and the
// blob is directly writable under the open RLS policy until Increment 1e, so that
// check is advisory in both directions. This is the server half.
//
// ⚠️ THE PATH IS DERIVED FROM THE CALLER'S CLAIM, NEVER FROM THE BODY.
// That is the whole security property. account-media shipped with the opposite shape —
// it authorized one id and then wrote a caller-supplied `storagePath` verbatim, which
// made it a read primitive over the entire private bucket (AUDIT #5). Here a caller
// can only ever write `<org>/_signatures/<their own org_user_id>.<ext>`, so
// overwriting someone else's signature is not expressible, not merely refused.
//
// Reuses the existing PRIVATE `ops-media` bucket rather than creating one: a new
// bucket is DDL, which would make this route inert until applied, and the security
// posture we need (private, service-role writes, signed reads) is already there. The
// `_signatures/` prefix cannot collide with a site id — those are `st_*`.
import { getSupabase } from './supabase.js';
import { CLEANSPACE_ORG_ID } from './constants.js';
import { requireSafeSegment } from './storagePaths.js';

// Exported because the SEND path reads these objects back out (resolveOutboundAttachments
// resolving a signatureRef). One constant, so the reader cannot drift from the writer.
export const SIGNATURE_BUCKET = 'ops-media';
const BUCKET = SIGNATURE_BUCKET;

// Deliberately narrower than the account-media set. A signature is a small flat image
// rendered inline in an email; SVG is excluded because it is executable markup in some
// clients, and video obviously has no place here.
const MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
});

// The extensions a signature path may end in. Exported so the send path can validate a
// caller-supplied `signatureExt` against a CLOSED set before it is concatenated into a
// Storage path — an open value there would be a path-traversal parameter. Mirrored by
// SIGNATURE_EXT_MIME in src/lib/signature.js; test-signature-ref pins them equal.
export const SIGNATURE_EXTS = Object.freeze(Object.values(MIME_EXT));

// Matches SIGNATURE_MAX_IMAGE_BYTES in settings/Account.jsx and sits inside the
// per-user blob budget in _lib/blobBudget.js (36 KB of image ≈ 48 KB base64). Enforced
// on the DECODED bytes, because the base64 length is what a caller controls directly.
export const SIGNATURE_UPLOAD_MAX_BYTES = 36 * 1024;

// The strict character class is not decoration: a crafted data URL is otherwise a
// route for smuggling CR/LF into a downstream MIME header. Mirrors parseDataUrl in
// src/lib/signature.js, which guards the same thing on the send side.
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Validate a signature data URL. PURE — no I/O, so the whole decision table is
 * unit-testable, and the route stays a thin caller.
 * @returns { ok: true, mimeType, ext, bytes, buffer } | { ok: false, error }
 */
export function validateSignatureUpload(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, error: 'An image is required.' };
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return { ok: false, error: 'Signature must be a PNG, JPG, or GIF image.' };
  const [, mimeType, b64] = m;
  const ext = MIME_EXT[mimeType];
  if (!ext) return { ok: false, error: 'Signature must be a PNG, JPG, or GIF image.' };

  let buffer;
  try {
    buffer = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  } catch {
    return { ok: false, error: 'That image could not be decoded.' };
  }
  // Base64 silently ignores invalid characters rather than throwing, so an empty
  // decode is the real signal that the payload was junk.
  if (!buffer.length) return { ok: false, error: 'That image could not be decoded.' };
  if (buffer.length > SIGNATURE_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: `Signature image is ${Math.round(buffer.length / 1024)} KB — the limit is ${Math.round(SIGNATURE_UPLOAD_MAX_BYTES / 1024)} KB.`,
    };
  }

  // Magic-byte check. The declared mime type is caller-supplied, and storing a file
  // whose bytes disagree with its type is how a "signature" becomes something else
  // entirely once it is served back under a signed URL.
  const sniffed = sniffImage(buffer);
  if (!sniffed) return { ok: false, error: 'That file is not a valid PNG, JPG, or GIF.' };
  if (sniffed !== mimeType) {
    return { ok: false, error: `File content is ${sniffed}, which does not match its declared type.` };
  }

  return { ok: true, mimeType, ext, bytes: buffer.length, buffer };
}

// Identify an image from its leading bytes. Only the three types accepted above.
export function sniffImage(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  return null;
}

// The ONLY path a given caller may write. Server-derived, so a caller cannot address
// another user's object — see the header note.
//
// ⚠️ orgUserId IS VALIDATED HERE, not merely at the routes. Both call sites are supposed
// to pass a JWT-claim value, but `api/inbox/[id]/test.js` shipped passing `req.body`
// wholesale into performSend, which made orgUserId CALLER-SUPPLIED — so an attacker
// could name another user's signature, and an id like `../../marketing/<id>` would have
// escaped the `_signatures/` prefix entirely into the rest of the private bucket
// (account media, quote PDFs). The routes are fixed, but a guard that lives only in the
// callers is one new caller away from being reopened — which is exactly how test.js was
// missed when send.js was fixed. Validating at the point of derivation makes traversal
// NOT EXPRESSIBLE no matter who calls.
//
// Throwing is deliberate: this can only be a programming error or an attack, never a
// user-facing condition. resolveOutboundAttachments already catches around the signature
// branch, so an outbound email loses its signature rather than failing to send.
export function signaturePathFor(orgUserId, ext) {
  requireSafeSegment(orgUserId, 'signature orgUserId');
  if (!SIGNATURE_EXTS.includes(ext)) {
    throw new Error('signaturePathFor: unsupported extension');
  }
  return `${CLEANSPACE_ORG_ID}/_signatures/${orgUserId}.${ext}`;
}

// A short-lived signed URL for the caller's OWN signature object, for rendering the
// Settings preview (the bucket is private, so an <img src> needs one).
//
// ⚠️ SAME PROPERTY AS THE UPLOAD: the path is rebuilt from the caller's claim, so this
// cannot be turned into a read primitive over `ops-media` by passing someone else's
// path. `ext` is the only caller input and is closed to SIGNATURE_EXTS by the route.
// 10 minutes because it is consumed immediately by an <img> on the page that requested
// it; a long-lived URL is a bearer token for a private object.
export async function signedSignatureUrl(orgUserId, ext, expiresSeconds = 600) {
  const path = signaturePathFor(orgUserId, ext);
  const { data, error } = await getSupabase().storage.from(BUCKET).createSignedUrl(path, expiresSeconds);
  if (error || !data?.signedUrl) return null; // no signature stored yet → not an error
  return data.signedUrl;
}

// Upload and return the stored path. Overwrites the caller's own previous signature
// (upsert) so re-uploading does not orphan objects in the bucket.
export async function putSignature(orgUserId, { buffer, mimeType, ext }) {
  const path = signaturePathFor(orgUserId, ext);
  const { error } = await getSupabase().storage.from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (error) throw new Error(`signature upload failed: ${error.message}`);
  return path;
}
