// POST /api/settings/signature-upload  { dataUrl } -> { path, bytes }
//
// C07 part 2. Uploads a user's email-signature image to the private `ops-media`
// bucket and returns the object path, which the client then stores as
// `signaturePrefs.imagePath` — replacing the base64 data URL that currently rides
// inside the org_state blob.
//
// ⚠️ THE PATH IS DERIVED FROM THE CALLER'S JWT CLAIM, NEVER FROM THE BODY. A caller
// can only ever write `<org>/_signatures/<their own org_user_id>.<ext>`, so
// overwriting another user's signature is not expressible rather than merely refused.
// account-media shipped the opposite shape — it authorized one id and wrote a
// caller-supplied `storagePath` verbatim, which made it a read primitive over the
// whole private bucket (AUTHORIZATION_AUDIT #5). Do not add a path parameter here.
//
// NO ROLE GATE, deliberately: every user owns their own signature, and there is no
// cross-user surface to protect once the path is claim-derived. `requireAuthority` is
// the whole check.
//
// LIVE. `src/lib/signatureApi.js` POSTs here from Settings → Account when the user picks
// an image, and the returned path is stored as `signaturePrefs.imagePath` (C07 landed in
// `439d2b0`). Needs no DDL — it reuses the existing private bucket rather than creating
// one, which would have made it inert behind a migration.
//
// (This comment used to say "INERT — nothing calls this yet". That was true when the
// route shipped a few commits ahead of its writer, and false the moment the writer
// landed. A route documented as dead is a route nobody audits.)
import { requireAuthority } from '../_lib/authz.js';
import { validateSignatureUpload, putSignature } from '../_lib/signatureUpload.js';

// The blob cap is ~3.4 MB and a signature is capped at 36 KB, so anything approaching
// this is already malformed. Small on purpose — the platform returns an opaque 413
// above ~4.5 MB, and a readable error beats that.
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const a = await requireAuthority(req, res);
  if (!a) return; // 401 already written
  if (!a.orgUserId) {
    // Without a resolved org user there is no path to derive, and falling back to
    // anything caller-supplied is precisely the hole this route is shaped to avoid.
    return res.status(403).json({ error: 'Your account could not be resolved. Sign out and back in.' });
  }

  const v = validateSignatureUpload(req.body?.dataUrl);
  if (!v.ok) return res.status(400).json({ error: v.error });

  try {
    const path = await putSignature(a.orgUserId, v);
    return res.status(200).json({ path, bytes: v.bytes });
  } catch (e) {
    console.error('[settings/signature-upload]', e);
    return res.status(502).json({ error: 'Could not store the signature image. Please try again.' });
  }
}
