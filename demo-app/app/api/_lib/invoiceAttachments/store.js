// Service-role data layer for invoice PDF attachments. Bytes live in the private
// 'invoice-attachments' bucket; the browser never holds the bucket key. Uploads go
// through a short-lived SIGNED UPLOAD URL and reads through a short-lived signed
// download URL, both minted here (service role). The object path is rebuilt from the
// invoiceId, never trusted from the body (storage-path law, _lib/storagePaths.js).
// The metadata (name/size/storagePath) rides invoice.attachment in org_state, so no
// separate table is needed. Backend-mediated only, so the bucket carries no RLS.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment } from '../storagePaths.js';

const BUCKET = 'invoice-attachments';
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const rid = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; for (let i = 0; i < 16; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

export function validateUpload({ mimeType, sizeBytes }) {
  if (!ALLOWED_MIME.includes(mimeType)) return { ok: false, error: 'Unsupported file type (use PDF, PNG, JPG, or WebP)' };
  if (Number.isFinite(sizeBytes) && sizeBytes > MAX_BYTES) return { ok: false, error: 'File is too large (max 10MB)' };
  return { ok: true };
}

// The per-invoice object prefix: <org>/<invoiceId>/ . invoiceId is validated as a single
// safe segment so it can never walk out of this invoice's (or the org's) prefix.
export function invoicePrefix(invoiceId) {
  requireSafeSegment(invoiceId, 'invoice-attachment invoiceId');
  return `${CLEANSPACE_ORG_ID}/${invoiceId}/`;
}

// A client-supplied storagePath (from the synced invoice.attachment) is only honored if it
// sits under THIS invoice's rebuilt prefix, so a caller can never read/delete another
// invoice's or org's object by passing a different path.
function assertOwnedPath(invoiceId, storagePath) {
  const prefix = invoicePrefix(invoiceId);
  if (typeof storagePath !== 'string' || !storagePath.startsWith(prefix) || storagePath.includes('..')) {
    throw new Error('storagePath does not belong to this invoice');
  }
}

export async function signedUploadUrl({ invoiceId, mimeType }) {
  const db = getSupabase();
  const ext = EXT[mimeType] || 'bin';
  const path = `${invoicePrefix(invoiceId)}${rid()}.${ext}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path: data.path || path, token: data.token, signedUrl: data.signedUrl };
}

export async function signedDownloadUrl({ invoiceId, storagePath }) {
  assertOwnedPath(invoiceId, storagePath);
  const db = getSupabase();
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(storagePath, 600);
  if (error) throw error;
  return { url: data?.signedUrl || null };
}

export async function removeObject({ invoiceId, storagePath }) {
  assertOwnedPath(invoiceId, storagePath);
  const db = getSupabase();
  const { error } = await db.storage.from(BUCKET).remove([storagePath]);
  if (error) throw error;
  return { ok: true };
}
