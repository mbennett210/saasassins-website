// Client half of the signature-image upload (C07).
//
// The bytes go to Supabase Storage via an authed server route and only the object PATH
// comes back to live in the blob. Previously the base64 data URL itself was stored in
// org_state, where 36 KB of image became ~48 KB of shared document that every user in
// the org downloads on every hydrate — and two large ones would have pushed the whole
// blob past MAX_STATE_BYTES, failing every save org-wide.
//
// No path is sent or chosen here: the server derives the object key from the caller's
// JWT claim. See api/settings/signature-upload.js.
import { authHeaders } from './authHeader';

/**
 * Upload a signature image and return its stored object path.
 * @param {string} dataUrl a `data:image/(png|jpeg|gif);base64,…` URL
 * @returns {Promise<{ ok: true, path: string } | { ok: false, error: string }>}
 */
export async function uploadSignatureImage(dataUrl) {
  try {
    const res = await fetch('/api/settings/signature-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ dataUrl }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok || !json?.path) {
      return { ok: false, error: json?.error || 'Could not upload the signature image.' };
    }
    return { ok: true, path: json.path };
  } catch {
    // Local/demo mode has no backend, and a dropped connection lands here too. The
    // caller keeps the draft unchanged so the user can retry rather than silently
    // losing the image they just picked.
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
}
