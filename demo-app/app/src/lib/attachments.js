// IndexedDB-backed blob storage for file attachments.
//
// The main JSON state in localStorage stays lean — it only carries attachment
// metadata (name, size, mimeType, uploadedAt). The actual file blob lives here
// so a few PDFs don't blow the localStorage quota.
//
// Two object stores share one database:
//   - invoiceAttachments    — one blob per invoice, keyed by invoice id.
//   - marketingAttachments  — one blob per marketing step attachment, keyed
//                             by a unique attachment id (a step can have many).
//
// API: saveAttachment / loadAttachment / deleteAttachment (invoices) and
// saveMarketingAttachment / loadMarketingAttachment / deleteMarketingAttachment.

import { supabase } from './supabaseClient';
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';

const DB_NAME = 'rfs-attachments';
const DB_VERSION = 2;
const STORE = 'invoiceAttachments';
const MARKETING_STORE = 'marketingAttachments';

// Supabase Storage mirror for marketing attachments — so the send cron
// (api/marketing/run) can read the blob server-side. Keep the bucket id + key
// in lockstep with api/_lib/marketing/attachments.js. In local-only mode
// (`supabase` is null) these are no-ops; IndexedDB remains the local copy.
const MARKETING_ATTACHMENT_BUCKET = 'marketing-attachments';
const marketingAttachmentKey = (id) => `marketing/${id}`;

async function uploadMarketingAttachmentToStorage(attachmentId, blob, mimeType) {
  if (!supabase) return;
  const { error } = await supabase.storage
    .from(MARKETING_ATTACHMENT_BUCKET)
    .upload(marketingAttachmentKey(attachmentId), blob, {
      upsert: true,
      contentType: mimeType || 'application/octet-stream',
    });
  if (error) throw new Error(`Attachment upload failed: ${error.message}`);
}

// ── Invoice attachments: shared Supabase Storage (Gap 3) ──────────────────────
// Private 'invoice-attachments' bucket, backend-mediated via api/invoice-attachments/*.
// In local/demo mode (no Supabase) BACKEND is null and invoice attachments stay
// IndexedDB-only, exactly as before.
const INVOICE_ATTACHMENT_BUCKET = 'invoice-attachments';
const BACKEND = demoBackendsEngaged()
  ? null
  : ((typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api');

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

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
// Total cap across every attachment on a single email. Gmail caps a whole
// message (body + attachments) at 25 MB; keeping the sum of files under that
// stops the send from bouncing. Per-file is still capped at ATTACHMENT_MAX_BYTES.
export const ATTACHMENT_TOTAL_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
export const ATTACHMENT_ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
];

// Marketing email attachments — PDF + common image types. Email collateral
// is overwhelmingly PDF; images cover the rest. Same 10 MB ceiling.
export const MARKETING_ATTACHMENT_ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(MARKETING_STORE)) {
        db.createObjectStore(MARKETING_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, store = STORE) {
  return db.transaction(store, mode).objectStore(store);
}

export async function saveAttachment(invoiceId, file) {
  if (!invoiceId || !file) throw new Error('Missing invoiceId or file');
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(`File too large (max ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB).`);
  }
  if (file.type && !ATTACHMENT_ALLOWED_MIME.includes(file.type)) {
    throw new Error('File type not supported. Use PDF or PNG/JPG/WebP.');
  }
  // Keep a local copy (offline + instant view on this device).
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const req = store.put(
      { blob: file, name: file.name, mimeType: file.type || 'application/octet-stream' },
      invoiceId,
    );
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
  const meta = {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
  };
  // Connected mode: mirror the bytes to the private 'invoice-attachments' bucket via a
  // role-gated signed upload URL, so any device/user on the shared Supabase can open the
  // attachment. storagePath rides invoice.attachment through org_state sync.
  if (BACKEND && supabase) {
    const { path, token } = await api('/invoice-attachments/upload-url', {
      method: 'POST',
      body: { invoiceId, mimeType: file.type, sizeBytes: file.size },
    });
    const { error } = await supabase.storage.from(INVOICE_ATTACHMENT_BUCKET).uploadToSignedUrl(path, token, file);
    if (error) throw new Error(error.message || 'Attachment upload failed');
    meta.storagePath = path;
  }
  return meta;
}

export async function loadAttachment(invoiceId, storagePath = null) {
  if (!invoiceId) return null;
  // This device's local copy first (fast + offline).
  let db = null;
  try { db = await openDb(); } catch { db = null; }
  if (db) {
    try {
      const record = await new Promise((resolve, reject) => {
        const store = tx(db, 'readonly');
        const req = store.get(invoiceId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (record) return { blob: record.blob, name: record.name, mimeType: record.mimeType };
    } finally {
      db.close();
    }
  }
  // Not on this device: pull from shared Storage (connected mode) with the synced path.
  if (BACKEND && storagePath) {
    try {
      const { url } = await api('/invoice-attachments/download-url', { method: 'POST', body: { invoiceId, storagePath } });
      if (url) {
        const resp = await fetch(url);
        if (resp.ok) return { blob: await resp.blob() };
      }
    } catch { /* fall through to null */ }
  }
  return null;
}

export async function deleteAttachment(invoiceId, storagePath = null) {
  if (!invoiceId) return;
  let db = null;
  try { db = await openDb(); } catch { db = null; }
  if (db) {
    await new Promise((resolve, reject) => {
      const store = tx(db, 'readwrite');
      const req = store.delete(invoiceId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  }
  // Remove the shared Storage object too (connected mode); best-effort.
  if (BACKEND && storagePath) {
    try { await api('/invoice-attachments/delete', { method: 'POST', body: { invoiceId, storagePath } }); } catch { /* best-effort */ }
  }
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------- Outbound email attachment encoding ----------
// Compose/reply keep each picked file as { name, size, file } (the File object).
// The send pipeline (sendViaInbox → backend buildMime) wants the wire shape
// { name, mimeType, content } where content is base64 with no data: prefix.
// These convert one (or many) in the browser via FileReader.

export function fileToBackendAttachment(att) {
  return new Promise((resolve, reject) => {
    const file = att && att.file;
    if (!file) {
      reject(new Error(`Attachment "${(att && att.name) || 'file'}" is missing its data.`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL yields "data:<mime>;base64,<payload>" — keep only the payload.
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve({
        name: file.name || att.name || 'attachment',
        mimeType: file.type || 'application/octet-stream',
        content: comma >= 0 ? result.slice(comma + 1) : '',
      });
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read attachment.'));
    reader.readAsDataURL(file);
  });
}

export function filesToBackendAttachments(atts) {
  return Promise.all((atts || []).filter((a) => a && a.file).map(fileToBackendAttachment));
}

// ---------- Outbound attachments via Storage (preferred) ----------
// The base64 path above puts the whole file in the send REQUEST BODY. Vercel caps
// request bodies at ~4.5MB at the PLATFORM layer (413 before the handler runs) and
// base64 inflates binary by +33%, so the composer's declared 25MB cap was never
// reachable — real-world attachments failed with a 413 the UI could not explain.
// Instead, upload the bytes straight to Storage (the same bucket + direct client
// upload the marketing path already uses) and send only a small metadata reference;
// the server downloads and attaches them. See api/_lib/marketing/attachments.js.
const outboxAttachmentKey = (id) => `outbox/${id}`;

export async function fileToStorageAttachment(att) {
  const file = att && att.file;
  if (!file) throw new Error(`Attachment "${(att && att.name) || 'file'}" is missing its data.`);
  // Local/demo mode has no Storage — fall back to the legacy inline encoding.
  if (!supabase) return fileToBackendAttachment(att);
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const key = outboxAttachmentKey(id);
  const { error } = await supabase.storage
    .from(MARKETING_ATTACHMENT_BUCKET)
    .upload(key, file, { upsert: true, contentType: file.type || 'application/octet-stream' });
  if (error) throw new Error(`Attachment upload failed: ${error.message}`);
  return {
    name: file.name || att.name || 'attachment',
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    storageKey: key,
  };
}

export function filesToStorageAttachments(atts) {
  return Promise.all((atts || []).filter((a) => a && a.file).map(fileToStorageAttachment));
}

// ---------- Marketing step attachments ----------
// A sequence step can carry several attachments, so these are keyed by a
// per-attachment id (not the step id). Metadata lives on step.attachments[];
// the blob lives in the marketingAttachments store.

export async function saveMarketingAttachment(attachmentId, file) {
  if (!attachmentId || !file) throw new Error('Missing attachmentId or file');
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(`File too large (max ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB).`);
  }
  if (file.type && !MARKETING_ATTACHMENT_ALLOWED_MIME.includes(file.type)) {
    throw new Error('File type not supported. Use PDF or PNG/JPG/WebP/GIF.');
  }
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite', MARKETING_STORE);
    const req = store.put(
      { blob: file, name: file.name, mimeType: file.type || 'application/octet-stream' },
      attachmentId,
    );
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
  // Mirror to Supabase Storage so the send cron can read this blob server-side.
  await uploadMarketingAttachmentToStorage(attachmentId, file, file.type);
  return {
    id: attachmentId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
  };
}

export async function loadMarketingAttachment(attachmentId) {
  if (!attachmentId) return null;
  let db;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    const record = await new Promise((resolve, reject) => {
      const store = tx(db, 'readonly', MARKETING_STORE);
      const req = store.get(attachmentId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return record ? { blob: record.blob, name: record.name, mimeType: record.mimeType } : null;
  } finally {
    db.close();
  }
}

export async function deleteMarketingAttachment(attachmentId) {
  if (!attachmentId) return;
  // Remove the Storage mirror first (best-effort — a delete failure shouldn't
  // block removing the local copy).
  if (supabase) {
    try {
      await supabase.storage.from(MARKETING_ATTACHMENT_BUCKET).remove([marketingAttachmentKey(attachmentId)]);
    } catch { /* best-effort */ }
  }
  let db;
  try {
    db = await openDb();
  } catch {
    return;
  }
  await new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite', MARKETING_STORE);
    const req = store.delete(attachmentId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

// One-time-per-device backfill: upload every locally-stored marketing attachment
// blob to Supabase Storage (upsert, so re-runs are harmless), so sequences whose
// steps were created before the Storage mirror existed still attach server-side.
// No-op in local-only mode. The caller gates this to run once per device.
export async function backfillMarketingAttachmentsToStorage() {
  if (!supabase) return { uploaded: 0, skipped: 0 };
  let db;
  try {
    db = await openDb();
  } catch {
    return { uploaded: 0, skipped: 0 };
  }
  let ids = [];
  try {
    ids = await new Promise((resolve, reject) => {
      const store = tx(db, 'readonly', MARKETING_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    db.close();
    return { uploaded: 0, skipped: 0 };
  }
  let uploaded = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      const rec = await new Promise((resolve, reject) => {
        const store = tx(db, 'readonly', MARKETING_STORE);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (!rec?.blob) { skipped += 1; continue; }
      const { error } = await supabase.storage
        .from(MARKETING_ATTACHMENT_BUCKET)
        .upload(marketingAttachmentKey(id), rec.blob, {
          upsert: true,
          contentType: rec.mimeType || 'application/octet-stream',
        });
      if (error) skipped += 1; else uploaded += 1;
    } catch {
      skipped += 1;
    }
  }
  db.close();
  return { uploaded, skipped };
}
