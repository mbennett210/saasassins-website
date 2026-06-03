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

const DB_NAME = 'rfs-attachments';
const DB_VERSION = 2;
const STORE = 'invoiceAttachments';
const MARKETING_STORE = 'marketingAttachments';

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
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
  return {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
  };
}

export async function loadAttachment(invoiceId) {
  if (!invoiceId) return null;
  let db;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    const record = await new Promise((resolve, reject) => {
      const store = tx(db, 'readonly');
      const req = store.get(invoiceId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return record ? { blob: record.blob, name: record.name, mimeType: record.mimeType } : null;
  } finally {
    db.close();
  }
}

export async function deleteAttachment(invoiceId) {
  if (!invoiceId) return;
  let db;
  try {
    db = await openDb();
  } catch {
    return;
  }
  await new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const req = store.delete(invoiceId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
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
