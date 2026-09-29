// Storage object-key safety — ONE definition of what may be interpolated into a path.
//
// ══ WHY THIS IS CENTRAL AND NOT A LOCAL REGEX ═════════════════════════════════
// Every Supabase Storage key in this app is built by string interpolation, and the
// buckets are private and MULTI-TENANT BY PREFIX — `<org>/<form>/<field>/…`,
// `<org>/_signatures/<user>.<ext>`, `marketing/<id>`. The prefix IS the boundary. A
// component containing `..` or `/` walks out of it, so an unvalidated interpolation is a
// cross-tenant read or write primitive, not a cosmetic bug.
//
// An adversarial sweep found FOUR of these at once (unauthenticated form uploads,
// outbound attachment download, marketing attachment keys, and the signature path that
// had just been hardened locally). That count is the argument for centralising: the
// guard kept being written at the call site, and the call sites kept multiplying. Each
// new one starts unguarded, and the reviewer has to notice its absence rather than its
// presence — which is exactly how api/inbox/[id]/test.js was missed when its sibling
// was fixed.
//
// The rule: a caller may only ever contribute a SINGLE SEGMENT, and only from the
// alphabet this app's ids actually use (src/lib/ids.js mints `<prefix>_<base36>`).
// Everything else — dots, slashes, backslashes, URL-encoded separators, empty, absurdly
// long — is refused. Not sanitised: REFUSED, because silently rewriting a caller's key
// makes an attack look like a successful upload.

// Letters, digits, underscore, hyphen. No dot: a dot enables `..`, and no legitimate
// SEGMENT in this app needs one (file extensions are appended by the caller, after the
// segment, from a closed set).
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** True when `v` is safe to interpolate as one path segment. */
export function isSafeSegment(v) {
  return typeof v === 'string' && SAFE_SEGMENT.test(v);
}

/**
 * Assert a path segment, throwing with a caller-identifying message.
 * Throwing (not returning null) is deliberate: reaching here with a bad value is either
 * a programming error or an attack, never a normal user condition.
 */
export function requireSafeSegment(v, what = 'path segment') {
  if (!isSafeSegment(v)) throw new Error(`unsafe ${what}`);
  return v;
}

// The only two key shapes the outbound/marketing attachment pipeline ever mints:
//   outbox/<id>     src/lib/attachments.js  (Messaging compose)
//   marketing/<id>  api/_lib/marketing/attachments.js  (sequence steps)
// Anything else arriving as a `storageKey` did not come from this app.
const ATTACHMENT_KEY = /^(outbox|marketing)\/[A-Za-z0-9_-]{1,128}$/;

/** True when `k` is a well-formed attachment object key. */
export function isValidAttachmentKey(k) {
  return typeof k === 'string' && ATTACHMENT_KEY.test(k);
}

// A full, multi-segment object PATH (not a single caller segment) that this app itself
// minted and stored — e.g. an ops-media key `<org>/<site>/<id>.<ext>` or its thumbnail
// `<org>/<site>/<id>.thumb.jpg`. Used to re-validate a path read BACK from our own DB
// before it is handed to Storage.download(), so a corrupted or tampered row can never
// become a cross-tenant read primitive (defense in depth — the write side already
// validates each segment at mint time).
//
// This is the general primitive; it is deliberately NOT the same as
// accountMedia/refs.js `isValidStoragePath(path, siteId)`, which additionally BINDS the
// path to a specific org+site and the exact 3-segment single-extension upload shape (and
// so rejects a legit `.thumb.jpg` double extension). Here we only refuse the traversal
// alphabet: each `/`-separated segment must start alphanumeric/underscore and contain
// only `[A-Za-z0-9._-]`, so dotted filenames and nested prefixes pass while `..`,
// absolute paths, backslashes, URL-encoded separators, empties, and control bytes fail.
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export function isValidStoragePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false;
  if (p.startsWith('/') || p.includes('..') || p.includes('\\') || p.includes('%')) return false;
  return p.split('/').every((seg) => PATH_SEGMENT.test(seg));
}
