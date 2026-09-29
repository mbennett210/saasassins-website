// Offline checklist-submission buffer (crew audit C1, 2026-08-03). When a crew member
// completes a per-account checklist while the network is down, the submission is stored
// here (IndexedDB) and replayed to POST /api/qc/checklists/submit on reconnect. Survives
// reloads, unlike an in-memory buffer. Mirrors lib/timeQueue.js (the clock-punch buffer);
// the server dedupes replays by the device-stamped `client_submit_id` (the `id` below),
// so an over-eager flush can never create a duplicate checklist_results row. Best-effort:
// any IndexedDB failure degrades to "no buffer" and NEVER throws to the caller.
//
// A buffered checklist:
//   {
//     id: clientSubmitId,   // 'cl_<uuid>' — the server idempotency key
//     payload,              // the exact POST body (templateId, siteId, clientId, jobId,
//                           //   items, completedByUserId, clientSubmitId)
//     createdAt,
//   }

const DB_NAME = 'rfs-checklist-queue';
const DB_VERSION = 1;
const STORE = 'checklists';

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
export function newChecklistId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `cl_${crypto.randomUUID()}`;
  } catch { /* fall through */ }
  return `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function addChecklist(item) {
  if (!item || !item.id) return false;
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.put(item);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function allChecklists() {
  const rows = await withStore('readonly', (store, resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
  return Array.isArray(rows) ? rows : [];
}

// Cheap depth probe for the support "Report an issue" diagnostic packet — native
// count(), no row deserialization. Best-effort: 0 on any IndexedDB failure.
export async function countChecklists() {
  const n = await withStore('readonly', (store, resolve, reject) => {
    const r = store.count();
    r.onsuccess = () => resolve(r.result || 0);
    r.onerror = () => reject(r.error);
  });
  return typeof n === 'number' ? n : 0;
}

export async function getChecklist(id) {
  if (!id) return null;
  const row = await withStore('readonly', (store, resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
  return row && !Array.isArray(row) ? row : null;
}

// Record a drain outcome ON the buffered item (attempts + backoff, or a terminal
// `failed`) — CS-007: a failed replay must never DELETE a cleaner's submitted checklist.
// Mirrors timeQueue.updatePunch.
export async function updateChecklist(id, patch) {
  const existing = await getChecklist(id);
  if (!existing) return false;
  return addChecklist({ ...existing, ...patch });
}

export async function removeChecklist(id) {
  if (!id) return false;
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.delete(id);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

// Sign-out on this device — a buffered checklist is per-crew-member, same as the punch buffer.
export async function clearChecklists() {
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}
