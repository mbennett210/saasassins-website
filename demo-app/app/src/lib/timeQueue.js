// Offline clock-punch buffer (CLEANSPACE_SWEPT.md §5.4). When the crew clock in/out
// while Supabase/network is down, the punch is stored here (IndexedDB) and replayed
// to POST /api/time/replay on reconnect. Survives reloads, unlike an in-memory
// buffer. Best-effort: any IndexedDB failure degrades to "no buffer" and NEVER
// throws to the caller (the timeApi layer decides what to surface).
//
// A buffered punch:
//   {
//     id: clientPunchId,          // uuid — the server idempotency key
//     kind: 'in' | 'out',
//     userId,
//     jobId,                      // 'in': the clean being clocked into
//     entryId,                    // 'out': the already-synced server entry being closed
//     ctx,                        // resolved clock context (names/site/coords) for the synthesized UI entry
//     assertedInAt, inLat, inLng, inAccuracyM,
//     assertedOutAt, outLat, outLng,
//     createdAt,
//   }
//
// Same hand-rolled promise wrapper as lib/attachments.js / store/offlineCache.js.

const DB_NAME = 'rfs-time-queue';
const DB_VERSION = 1;
const STORE = 'punches';

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

// A device-generated idempotency key. crypto.randomUUID is available in every
// browser we target; the fallback keeps it working in odd/embedded webviews.
export function newPunchId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `op_${crypto.randomUUID()}`;
  } catch { /* fall through */ }
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function addPunch(punch) {
  if (!punch || !punch.id) return false;
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.put(punch);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function getPunch(id) {
  if (!id) return null;
  return withStore('readonly', (store, resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export async function updatePunch(id, patch) {
  const existing = await getPunch(id);
  if (!existing) return false;
  return addPunch({ ...existing, ...patch });
}

export async function allPunches() {
  const rows = await withStore('readonly', (store, resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
  return Array.isArray(rows) ? rows : [];
}

export async function removePunch(id) {
  if (!id) return false;
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.delete(id);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

// Wipe the buffer (sign-out on this device — a punch is per-crew-member).
export async function clearPunches() {
  return withStore('readwrite', (store, resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}
