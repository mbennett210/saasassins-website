// Per-user embedded-image budget for the org_state blob.
//
// ══ THE CLIFF THIS PREVENTS ═══════════════════════════════════════════════════
//
// Signature images are stored as base64 data URLs INSIDE the shared blob
// (users[].signaturePrefs), and /api/state/org-state rejects any save whose whole body
// exceeds MAX_STATE_BYTES (3,500,000). Measured live:
//
//     blob today ................. 914,189 bytes
//     server cap ............... 3,500,000 bytes
//     headroom ................. ~2,585,000 bytes
//     users with a signature ..... 0 of 43
//
// ⚠️ THE ARITHMETIC BELOW DESCRIBES THE ORIGINAL HAZARD, NOT TODAY'S STATE. It is kept
// because it is why this module exists, but both halves have since changed:
//   · the client cap is now 36 KB (`SIGNATURE_MAX_IMAGE_BYTES`, Settings → Account) and
//     the server re-checks it (`SIGNATURE_UPLOAD_MAX_BYTES`), so it is no longer a
//     bypassable client-side-only 1 MB check;
//   · C07 moved the bytes OUT of the blob entirely — `signaturePrefs.imagePath` is a
//     Storage object key of a few dozen bytes (see `IMAGE_REFERENCE_FIELDS`).
// The guard stays because the legacy `imageDataUrl` shape is still readable forever, so
// a pre-C07 row can still carry base64.
//
// The original hazard, for the record: the only limit was `file.size > 1024 * 1024` in
// Settings → Account — CLIENT SIDE. A 1 MB image is ~1.37 MB once base64'd, so **two
// users adopting a documented feature push the blob past the cap** — and at that point
// EVERY org_state save in the org 413s, for everyone, until someone works out that a
// signature did it. The error they would see is "body is 3700 KB, over the 3418 KB
// limit", which names nothing.
//
// It was latent rather than active: nobody had a signature. It became reachable
// the moment two people sign a quote.
//
// ══ WHY A PER-USER CAP AND NOT JUST A BIGGER MAX_STATE_BYTES ══════════════════
// Raising the ceiling moves the cliff without removing it, and the blob is exactly
// what the whole SCALE remediation exists to shrink. C07 (signatures → Supabase
// Storage) is the real fix; this is the guard that makes the interim safe and, more
// importantly, ATTRIBUTABLE.
//
// ══ THE ARITHMETIC, so a future change can re-derive it ═══════════════════════
// Worst case is every user holding a signature at once:
//     43 users x 48 KB of base64 = ~2.06 MB, against ~2.58 MB of headroom.
// That leaves ~500 KB for ordinary blob growth. 48 KB of base64 is ~36 KB of image —
// ample for a trimmed signature PNG (a 600x200 stroke is typically 8-15 KB) and far
// below the 1 MB the UI currently allows.
//
// If signatures need to be larger than this, the answer is C07, not a bigger number.
// The whole-blob ceiling. Well under Vercel's platform cap so an oversized save gets a
// readable error rather than an opaque platform one.
//
// ⚠️ EXPORTED BECAUSE THERE ARE TWO WRITE PATHS AND ONLY ONE WAS CHECKING.
// api/state/org-state.js (the client-mediated route) enforced this; api/_lib/orgState.js
// writeOrgState() — the SERVER path used by ten callers including the UNAUTHENTICATED
// public-form lead bridge — did not look at size at all. So the blob could be grown past
// the ceiling through a path that never checked, and past it EVERY BROWSER SAVE IN THE
// ORG 413s. One constant, imported by both, so they cannot drift again.
export const MAX_STATE_BYTES = 3_500_000;

export const SIGNATURE_MAX_B64_BYTES = 48 * 1024;

// Byte length of a string as it will actually be serialized. `.length` counts UTF-16
// code units, which understates any non-ASCII content; a data URL is ASCII, but the
// caller may pass arbitrary values and undercounting is the wrong direction to err.
const byteLen = (s) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0);

// Everything image-shaped a user row can carry.
//
// ⚠️ `imageDataUrl` IS THE REAL FIELD — verified against DEFAULT_SIGNATURE_PREFS in
// data/seed.js and every write in settings/Account.jsx. The first version of this
// guard listed `signatureDataUrl` / `signatureImage` / `initialsDataUrl`, none of
// which exist anywhere in the codebase, so it was completely INERT: it would have
// passed every oversized signature straight through while looking like a working
// guard. Audit by capability — "what does a user row actually store?" — never by a
// plausible-sounding field name. The `signature*` aliases are kept only so a future
// rename cannot silently reopen the hole.
const IMAGE_FIELDS = ['imageDataUrl', 'signatureDataUrl', 'signatureImage', 'initialsDataUrl'];

// Image-SHAPED field names that are deliberately NOT counted, because they hold a
// reference rather than bytes. `imagePath` is a Storage object key of a few dozen
// bytes — not counting it is the entire point of C07, which exists to get the image
// OUT of this blob. Named explicitly (and asserted by test-blob-budget) so that a
// future reader who notices "an image field is missing from IMAGE_FIELDS" finds the
// reason here instead of "fixing" it and re-charging users for a path.
export const IMAGE_REFERENCE_FIELDS = ['imagePath'];

// Total embedded-image bytes on one user row, whatever shape the image is stored in.
export function userImageBytes(user) {
  const prefs = user?.signaturePrefs;
  if (!prefs || typeof prefs !== 'object') return 0;
  let n = 0;
  for (const f of IMAGE_FIELDS) n += byteLen(prefs[f]);
  // Post-C07 shape is { path, w, h } — a Storage reference, a few dozen bytes. It
  // costs nothing here, so this guard stays correct across the migration rather than
  // needing to be removed with it.
  return n;
}

/**
 * Report users whose embedded images exceed the per-user budget.
 *
 * PURE, so the arithmetic is unit-testable and the route stays a thin caller.
 * Returns [] when the state is fine.
 *
 * @returns Array<{ id, name, bytes }>
 */
export function oversizedImageUsers(state, cap = SIGNATURE_MAX_B64_BYTES) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const out = [];
  for (const u of users) {
    const bytes = userImageBytes(u);
    if (bytes > cap) out.push({ id: u?.id ?? null, name: u?.name ?? null, bytes });
  }
  return out;
}

// A human-readable rejection naming WHO and BY HOW MUCH. The existing
// MAX_STATE_BYTES error says "body is 3700 KB, over the 3418 KB limit", which tells
// the one person who can fix it nothing at all.
export function oversizedImageMessage(offenders, cap = SIGNATURE_MAX_B64_BYTES) {
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  const who = offenders
    .map((o) => `${o.name || o.id || 'a user'} (${kb(o.bytes)})`)
    .join(', ');
  return `Signature image too large for ${who} — the limit is ${kb(cap)}. `
    + 'Signatures are stored in the shared workspace document, so an oversized one '
    + 'would eventually block saving for everyone. Re-upload a smaller image.';
}
