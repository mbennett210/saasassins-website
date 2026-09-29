// Signed-URL mint proxy for "Report an issue" screenshots.
//
//   POST /api/support/upload  { name, mimeType, sizeBytes }
//     → 200 { attachmentId, path, signedUrl, ... }   (relayed from the CRM)
//
// The CRM validates type/size BEFORE minting (a rejected file gets no URL) and
// derives the storage path from ids IT mints, so nothing here needs to trust
// the metadata. File BYTES never transit this function: the browser PUTs them
// straight to the signed URL (Vercel caps request bodies ~4.5 MB; files may be
// 10 MB). Flat single-segment route — same reasoning as report.js.
//
// ⚠ SUPPORT_PORTAL_TOKEN must never be logged or echoed — error logs carry the
// CRM's status code only, never the URL (the URL contains the token).
import { requireAuthority } from '../_lib/authz.js';
import { allow } from '../_lib/rateLimit.js';
import { mapCrmFailure } from '../_lib/support/shape.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const a = await requireAuthority(req, res);
  if (!a) return;
  // Looser than report (6 files per ticket is legitimate), still bounded.
  if (!allow(req, res, { bucket: 'support-upload', id: a.orgUserId || a.email, limit: 30, windowMs: 10 * 60 * 1000 })) return;

  const token = process.env.SUPPORT_PORTAL_TOKEN;
  const base = (process.env.SUPPORT_API_BASE || '').replace(/\/$/, '');
  if (!token || !base) return res.status(503).json({ error: 'Support is not configured.' });

  const { name, mimeType, sizeBytes } = req.body || {};

  let r;
  try {
    r = await fetch(`${base}/${encodeURIComponent(token)}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType, sizeBytes }),
    });
  } catch {
    console.error('[support/upload] CRM unreachable');
    return res.status(502).json({ error: 'Support is temporarily unavailable. Please try again shortly.' });
  }

  if (r.status === 200) {
    const data = await r.json().catch(() => null);
    if (!data?.signedUrl || !data?.attachmentId) {
      console.error('[support/upload] CRM mint response malformed');
      return res.status(502).json({ error: 'Support is temporarily unavailable. Please try again shortly.' });
    }
    return res.status(200).json(data);
  }

  let crmError = null;
  try { crmError = (await r.json())?.error || null; } catch { /* non-JSON */ }
  console.error('[support/upload] CRM responded', r.status);
  const mapped = mapCrmFailure(r.status, crmError);
  return res.status(mapped.status).json({ error: mapped.error });
}
