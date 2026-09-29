// Offline photo/VIDEO upload buffer (crew offline-parity, 2026-08-04). When a crew
// member captures a before/after shot at a low-signal site, the file is stored here
// (IndexedDB — Blobs persist natively) and the whole 3-hop upload is replayed on
// reconnect (OfflineMediaSync → accountMediaApi.flushMediaQueue). Survives reloads,
// unlike an in-memory buffer. Mirrors lib/checklistQueue.js; the server dedupes the
// confirm on the device-stamped `client_media_id` (the `id` below), so an over-eager
// flush — or a partial-then-retry — can never create a duplicate account_media row.
// Best-effort: any IndexedDB failure degrades to "no buffer" and NEVER throws to the
// caller.
//
// Files are capped at OFFLINE_CAP (~50MB) before buffering — a phone can hold a short
// job video, but stashing a 200MB clip on the device would exhaust storage. Larger
// videos warn the crew (accountMediaApi) and stay in the camera roll for a live upload.
//
// A buffered upload:
//   {
//     id: clientMediaId,   // 'md_<uuid>' — the server idempotency key
//     file,                // the original File/Blob (image or video)
//     meta,                // { siteId, clientId, scope, areaId, refId, mimeType, sizeBytes, fileName }
//     createdAt,
//   }

const DB_NAME = 'rfs-media-queue';
const DB_VERSION = 1;
const STORE = 'media';

// The largest file we'll stash on the device for offline replay. Images (≤10MB) always
// fit; this caps video so the queue can't fill the phone. Kept in sync with the warning
// copy in accountMediaApi.uploadMedia.
export const OFFLINE_CAP = 50 * 1024 * 1024; // 50 MB

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  let db;
  try { db = await openDb(); } catch { return mode === 'readonly' ? [] : false; }
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, mode).objectStore(STORE);
      fn(store, resolve, reject);
    });
  } catch {
    return mode === 'readonly' ? [] : false;
  } finally {
    db.close();
  }
}

// A device-generated idempotency key. crypto.randomUUID is available in every browser we
// target; the fallback keeps it working in odd/embedded webviews.
export function newMediaId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `md_${crypto.randomUUID()}`;
  } catch { /* fall through */ }
  return `md_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function addMedia(item) {
  if (!item || !item.id || !item.file) return false;
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.put(item);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function allMedia() {
  const rows = await withStore('readonly', (store, resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
  return Array.isArray(rows) ? rows : [];
}

// Cheap depth probe for the support "Report an issue" diagnostic packet. Uses the
// store's native count() so it never deserializes the (potentially large) blobs
// that allMedia() would. Best-effort: 0 on any IndexedDB failure.
export async function countMedia() {
  const n = await withStore('readonly', (store, resolve, reject) => {
    const r = store.count();
    r.onsuccess = () => resolve(r.result || 0);
    r.onerror = () => reject(r.error);
  });
  return typeof n === 'number' ? n : 0;
}

export async function getMedia(id) {
  if (!id) return null;
  const row = await withStore('readonly', (store, resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
  return row && !Array.isArray(row) ? row : null;
}

// Record a drain outcome ON the buffered upload (attempts + backoff, or a terminal
// `failed`) — CS-007: a failed replay must never DELETE a crew member's photos.
// Mirrors timeQueue.updatePunch / checklistQueue.updateChecklist.
export async function updateMedia(id, patch) {
  const existing = await getMedia(id);
  if (!existing) return false;
  return addMedia({ ...existing, ...patch });
}

export async function removeMedia(id) {
  if (!id) return false;
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.delete(id);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

// Sign-out on this device — a buffered upload is per-crew-member, same as the punch/
// checklist buffers.
export async function clearMedia() {
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}
