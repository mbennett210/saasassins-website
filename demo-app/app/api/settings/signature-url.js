// GET /api/settings/signature-url?ext=png  ->  { url } | { url: null }
//
// C07 part 3. The signature image lives in the PRIVATE `ops-media` bucket, so the
// Settings preview cannot render it from a path alone — an <img> needs a signed URL.
//
// ⚠️ NO PATH PARAMETER, DELIBERATELY. The object key is rebuilt from the caller's JWT
// claim, exactly as in the upload route and the send path. A `?path=` parameter here
// would turn this into a read primitive over the whole private bucket — account media,
// quote PDFs — which is AUTHORIZATION_AUDIT #5 precisely. `ext` is the only caller
// input, and it is checked against a closed set BEFORE it is concatenated into a path.
//
// NO ROLE GATE: a user reads only their own signature, so there is no cross-user
// surface to protect once the path is claim-derived. requireAuthority is the check.
//
// A missing object is `{ url: null }` with a 200, not a 404 — "you have no signature
// stored" is a normal state (today it is the state of all 43 users), and the caller
// renders nothing rather than treating it as an error.
import { requireAuthority } from '../_lib/authz.js';
import { SIGNATURE_EXTS, signedSignatureUrl } from '../_lib/signatureUpload.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const a = await requireAuthority(req, res);
  if (!a) return; // 401 already written
  if (!a.orgUserId) {
    return res.status(403).json({ error: 'Your account could not be resolved. Sign out and back in.' });
  }

  const ext = String(req.query?.ext || '').toLowerCase();
  if (!SIGNATURE_EXTS.includes(ext)) {
    return res.status(400).json({ error: 'Unsupported signature image type.' });
  }

  try {
    const url = await signedSignatureUrl(a.orgUserId, ext);
    // Private, per-caller, and short-lived — never let a shared cache hold it.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ url });
  } catch (e) {
    console.error('[settings/signature-url]', e);
    return res.status(502).json({ error: 'Could not load the signature image.' });
  }
}
