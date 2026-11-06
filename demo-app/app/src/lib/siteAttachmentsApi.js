// Client adapter for location access attachments + office-note attachments (CS-043).
//
// The real upload is three hops, the same shape the account photo/video path uses:
//   1. POST /api/site-attachments/upload-url  — the server validates type + size and only
//      THEN mints a signed URL (a refused file never gets one)
//   2. PUT the bytes straight to Storage with uploadToSignedUrl — they never transit our
//      functions, which cap request bodies at ~4.5 MB while these files may be 10 MB
//   3. the returned `storagePath` is stored on the record in org_state, so any device or
//      user on the shared backend can open the file by asking for a signed download URL
//
// Before this, an attachment was `{ name, size, type }` and the bytes were dropped on the
// floor: the chip in the read view named a document nobody could open, while the copy
// promised crew site maps and walkthrough PDFs.
//
// In local/demo mode there is no backend, so `isAttachmentStub()` is true and the bytes
// are kept as a data URL in localStorage — the gallery and the Open link stay exercisable
// without pretending a server round-trip happened.
import { authHeaders } from './authHeader';
import { supabase } from './supabaseClient';
import { demoBackendsEngaged } from './demoMode';
import { validateSiteAttachment, ATTACHMENT_SCOPE } from './siteAttachmentRules';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';
const BUCKET = 'ops-media';

export { ATTACHMENT_SCOPE };
export function isAttachmentStub() { return !BACKEND || !supabase; }

async function api(path, body) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Upload one file and return the metadata to store on the record:
 * `{ name, size, type, storagePath }` — `name`/`size`/`type` keep the shape every existing
 * reader already renders, and `storagePath` is what makes it openable. In stub mode
 * `dataUrl` stands in for `storagePath`.
 */
export async function uploadSiteAttachment(file, { scope, ownerId }) {
  const v = validateSiteAttachment({ mimeType: file.type, sizeBytes: file.size });
  if (!v.ok) throw new Error(v.error);
  const meta = { name: file.name, size: file.size, type: file.type || 'application/octet-stream' };
  if (isAttachmentStub()) return { ...meta, dataUrl: await readAsDataUrl(file) };

  const { path, token } = await api('/site-attachments/upload-url', {
    scope, ownerId, mimeType: file.type, sizeBytes: file.size,
  });
  const { error } = await supabase.storage.from(BUCKET).uploadToSignedUrl(path, token, file);
  if (error) throw new Error(error.message || `Upload failed for ${file.name}`);
  return { ...meta, storagePath: path };
}

/**
 * A short-lived URL for opening an attachment, or null when there is nothing to open (a
 * metadata-only row from before CS-043 — those files were never uploaded and cannot be
 * recovered, so callers show the chip as unavailable rather than a dead link).
 */
export async function attachmentUrl(attachment, { scope, ownerId }) {
  if (!attachment) return null;
  if (attachment.dataUrl) return attachment.dataUrl;          // demo / stub
  if (!attachment.storagePath || isAttachmentStub()) return null;
  const { url } = await api('/site-attachments/download-url', {
    scope, ownerId, storagePath: attachment.storagePath,
  });
  return url || null;
}

/** Remove the bytes. Best-effort: a failed delete must not block removing the record's row. */
export async function deleteSiteAttachment(attachment, { scope, ownerId }) {
  if (!attachment?.storagePath || isAttachmentStub()) return { ok: true };
  try {
    return await api('/site-attachments/delete', { scope, ownerId, storagePath: attachment.storagePath });
  } catch {
    return { ok: false };
  }
}

/** True when this row has bytes behind it. A pre-CS-043 row does not. */
export function isAttachmentStored(attachment) {
  return !!(attachment && (attachment.storagePath || attachment.dataUrl));
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}
