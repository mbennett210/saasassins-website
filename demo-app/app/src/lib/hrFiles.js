// HR receipts + employee documents file store.
//   - CONNECTED (Supabase configured): bytes go to the PRIVATE 'hr-files' bucket via the
//     api/hr-files route, gated like these cards (hr.view to download, hr.edit to upload or
//     delete; owner/admin by role), since these are employee PII: I-9s, contracts, receipts.
//     The object path is rebuilt server-side from the ownerId, never
//     the body. The record slices (reimbursements / employeeDocuments) keep only the small
//     { fileId, name, mimeType, sizeBytes, storagePath } metadata, which syncs via org_state.
//   - DEMO/local (no Supabase): bytes are data URLs in a dedicated localStorage key so the
//     surfaces are exercisable without a backend. NEVER the synced blob (the CAS ceiling).
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';
import { supabase } from './supabaseClient';

const BUCKET = 'hr-files';
const STUB_KEY = 'cleanspace_hr_files_stub_v1';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per receipt / document
export const HR_FILE_ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const BACKEND = demoBackendsEngaged()
  ? null
  : ((typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api');

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

// ── demo/local stub ─────────────────────────────────────────────────────────
const load = () => { try { return JSON.parse(localStorage.getItem(STUB_KEY)) || { files: [] }; } catch { return { files: [] }; } };
const save = (db) => { try { localStorage.setItem(STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

// kind: 'receipt' | 'document'. ownerId ties the file to a reimbursement or a user and is
// the storage path segment in connected mode. Returns { id, kind, ownerId, name, mimeType,
// sizeBytes, createdAt, storagePath? }. The caller keeps { fileId:id, name, mimeType,
// sizeBytes, storagePath } on the synced record; the bytes live in Storage (connected) or
// the localStorage stub (demo).
export async function saveHrFile(file, { kind, ownerId } = {}) {
  if (file.size > MAX_BYTES) throw new Error('That file is too large (max 10 MB).');
  if (file.type && !HR_FILE_ALLOWED_MIME.includes(file.type)) throw new Error('Use a PDF, PNG, JPEG or WebP.');
  const base = {
    id: rid('hrf'), kind: kind || 'document', ownerId: ownerId || null,
    name: file.name || 'file', mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size, createdAt: new Date().toISOString(),
  };
  if (BACKEND && supabase) {
    if (!ownerId) throw new Error('Missing owner for the HR file');
    const { path, token } = await api('/hr-files/upload-url', { method: 'POST', body: { ownerId, mimeType: file.type, sizeBytes: file.size } });
    const { error } = await supabase.storage.from(BUCKET).uploadToSignedUrl(path, token, file);
    if (error) throw new Error(error.message || 'Upload failed');
    return { ...base, storagePath: path };
  }
  const url = await readAsDataUrl(file);
  const db = load(); db.files.push({ ...base, url }); save(db);
  return { ...base, url };
}

// Resolve a file for viewing/download. ASYNC (connected reads mint a short-lived signed
// URL). `opts` carries the synced record's { storagePath, ownerId, name, mimeType } for
// connected mode. Returns { url, name, mimeType } or null.
export async function getHrFile(id, opts = {}) {
  if (BACKEND) {
    if (!opts.storagePath || !opts.ownerId) return null;
    try {
      const { url } = await api('/hr-files/download-url', { method: 'POST', body: { ownerId: opts.ownerId, storagePath: opts.storagePath } });
      return url ? { url, name: opts.name || null, mimeType: opts.mimeType || null } : null;
    } catch { return null; }
  }
  if (!id) return null;
  const rec = load().files.find((f) => f.id === id);
  return rec ? { url: rec.url, name: rec.name, mimeType: rec.mimeType } : null;
}

export async function removeHrFile(id, opts = {}) {
  if (BACKEND) {
    if (opts.storagePath && opts.ownerId) {
      try { await api('/hr-files/delete', { method: 'POST', body: { ownerId: opts.ownerId, storagePath: opts.storagePath } }); } catch { /* best-effort */ }
    }
    return;
  }
  if (!id) return;
  const db = load(); db.files = db.files.filter((f) => f.id !== id); save(db);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
