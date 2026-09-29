// Service-role data layer for HR files (employee documents + reimbursement receipts).
// These are employee PII (I-9s, contracts, receipts), so the route gates them like the app's
// HR cards (api/hr-files: hr.view downloads, hr.edit uploads + deletes, owner/admin by role)
// and bytes live in the PRIVATE 'hr-files' bucket, reached
// only through short-lived signed URLs minted here (service role). The object path is
// rebuilt from the ownerId (a user id or a reimbursement id), never trusted from the body
// (storage-path law). Metadata (name/size/storagePath) rides the employeeDocuments /
// reimbursements slices in org_state, so no table is added. No RLS: backend-mediated only.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment } from '../storagePaths.js';

const BUCKET = 'hr-files';
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

// Per-owner object prefix: <org>/hr/<ownerId>/ . ownerId (a user id or reimbursement id)
// is validated as a single safe segment so it can never walk out of the org's HR prefix.
export function ownerPrefix(ownerId) {
  requireSafeSegment(ownerId, 'hr-file ownerId');
  return `${CLEANSPACE_ORG_ID}/hr/${ownerId}/`;
}

// A client-supplied storagePath is only honored under THIS owner's rebuilt prefix, so a
// caller can never read/delete another owner's HR file by passing a different path.
function assertOwnedPath(ownerId, storagePath) {
  const prefix = ownerPrefix(ownerId);
  if (typeof storagePath !== 'string' || !storagePath.startsWith(prefix) || storagePath.includes('..')) {
    throw new Error('storagePath does not belong to this HR owner');
  }
}

export async function signedUploadUrl({ ownerId, mimeType }) {
  const db = getSupabase();
  const ext = EXT[mimeType] || 'bin';
  const path = `${ownerPrefix(ownerId)}${rid()}.${ext}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path: data.path || path, token: data.token, signedUrl: data.signedUrl };
}

export async function signedDownloadUrl({ ownerId, storagePath }) {
  assertOwnedPath(ownerId, storagePath);
  const db = getSupabase();
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(storagePath, 600);
  if (error) throw error;
  return { url: data?.signedUrl || null };
}

export async function removeObject({ ownerId, storagePath }) {
  assertOwnedPath(ownerId, storagePath);
  const db = getSupabase();
  const { error } = await db.storage.from(BUCKET).remove([storagePath]);
  if (error) throw error;
  return { ok: true };
}
