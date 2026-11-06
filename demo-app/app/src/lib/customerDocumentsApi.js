// Customer documents API adapter (client hub redesign, plan 2026-10-08 §3.6): the office's
// certificates of insurance, W-9 and other files a customer downloads from the hub. Real backend
// by default — Vercel serves /api/customer-documents/* over the `customer_documents` table and the
// private `customer-documents` bucket (never org_state).
//
// The localStorage stub engages ONLY in a DEMO build, on the STATIC `import.meta.env.MODE` Vite
// inlines at build time, exactly as lib/contractsApi.js does (the CS-010 lesson). In
// `npm run build` STUB folds to a literal `false`, every `if (STUB)` branch, the
// 'cs-stub:customerDocuments' sentinel and the placeholder-PDF import are dead code esbuild
// removes — check-bundle-stubs.mjs asserts it. The stub keeps rows in the TABLE's own shape and
// runs the same pure projections (lib/customerDocuments.js) the server does; it keeps no files
// (a file picked this session opens from memory, anything else as a placeholder page).
//
// THE UPLOAD, in the order that never leaves a row naming a file nobody has (CS-043): an upload
// address from the server (the path rebuilt there from the id), the bytes straight to Storage,
// THEN the record. The id is minted here, so a retried save is one document.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { supabase } from './supabaseClient';
import { CUSTOMER_DOCUMENTS_STUB_KEY } from '../data/stubKeys';
import {
  customerDocumentFileRefusal, customerDocumentFields, cleanFileName, officeDocumentList, projectOfficeDocument,
  CUSTOMER_DOCUMENT_URL_TTL_S,
} from './customerDocuments';
import { todayKey } from './dates';
import { placeholderPdfUrl } from './demoPdf';

// PLAIN member reads so Vite inlines them and STUB folds to a literal (see the header).
const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_CUSTOMER_DOCUMENTS_STUB === '1' || import.meta.env.VITE_CUSTOMER_DOCUMENTS_STUB === 'true'));
if (STUB) markStub('cs-stub:customerDocuments');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';
const BUCKET = 'customer-documents';

export function isCustomerDocumentsStub() { return STUB; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.code || null;
    throw err;
  }
  return json;
}

// A caller-minted id (a v4 uuid): a retried save inserts nothing the second time.
export function newDocumentId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i += 1) {
    s += (i === 8 || i === 13 || i === 18 || i === 23) ? '-'
      : i === 14 ? '4'
        : i === 19 ? h[(Math.random() * 4 | 0) + 8]
          : h[Math.random() * 16 | 0];
  }
  return s;
}

// A refusal the screen can name (the same codes the route answers).
function refusal(code) {
  const err = new Error(code);
  err.code = code;
  err.status = 400;
  return err;
}

// ── the calls ───────────────────────────────────────────────────────────────
// One building's documents with the company's, or (`clientId` null) the company's alone.
// → { documents, today }
export async function listCustomerDocuments({ clientId = null } = {}) {
  if (!STUB) return api(`/customer-documents/list?${clientId ? `clientId=${encodeURIComponent(clientId)}` : 'scope=company'}`);
  const rows = stubDb().documents.filter((r) => r.client_id == null || (clientId && r.client_id === clientId));
  return { documents: officeDocumentList(rows, todayKey()), today: todayKey() };
}

// Upload a new document: { clientId|null, kind, title, validUntil, visibleToClient, file } → the document.
export async function uploadCustomerDocument({ clientId = null, kind, title, validUntil = null, visibleToClient = true, file, id = newDocumentId() }) {
  const refused = customerDocumentFileRefusal({ mimeType: file?.type, sizeBytes: file?.size });
  if (refused) throw refusal(refused);
  const meta = { id, clientId, kind, title, validUntil, visibleToClient, fileName: cleanFileName(file.name), mimeType: file.type, sizeBytes: file.size };
  if (STUB) return stubUpload(meta, file);
  const up = await api('/customer-documents/upload-url', { method: 'POST', body: { id, clientId, mimeType: file.type, sizeBytes: file.size } });
  await putBytes(up, file);
  return (await api('/customer-documents/confirm', { method: 'POST', body: meta })).document;
}

// A new file for an existing document (the old one is deleted on the server); the title and
// valid-through day may change with it (a renewed COI).
export async function replaceCustomerDocument(doc, { file, title, validUntil }) {
  const refused = customerDocumentFileRefusal({ mimeType: file?.type, sizeBytes: file?.size });
  if (refused) throw refusal(refused);
  if (STUB) return stubReplace(doc, { file, title, validUntil });
  const up = await api('/customer-documents/upload-url', { method: 'POST', body: { id: doc.id, replace: true, mimeType: file.type, sizeBytes: file.size } });
  await putBytes(up, file);
  return (await api('/customer-documents/replace', {
    method: 'POST',
    body: { id: doc.id, revision: up.revision, fileName: cleanFileName(file.name), mimeType: file.type, sizeBytes: file.size, title, validUntil },
  })).document;
}

// The title, the kind, the valid-through day, the "Visible to the customer" switch.
export async function updateCustomerDocument(id, patch) {
  if (STUB) return stubUpdate(id, patch);
  return (await api('/customer-documents/update', { method: 'POST', body: { id, ...patch } })).document;
}

export async function deleteCustomerDocument(id) {
  if (STUB) return stubDelete(id);
  return api('/customer-documents/delete', { method: 'POST', body: { id } });
}

// A link to open the file (five minutes).
export async function customerDocumentUrl(id) {
  if (STUB) return stubUrl(id);
  return (await api(`/customer-documents/view-url?id=${encodeURIComponent(id)}`)).url;
}

async function putBytes(up, file) {
  const sent = await supabase.storage.from(BUCKET).uploadToSignedUrl(up.path, up.token, file, { contentType: file.type });
  if (sent.error) throw new Error('The file did not upload. Try again.');
}

// ── stub store (demo only; dead-code-eliminated from a production build) ─────
// Files picked this session, by document id → an object URL. Never persisted.
const demoFiles = STUB ? new Map() : null;
const nowIso = () => new Date().toISOString();
const stubDb = () => {
  try { return JSON.parse(localStorage.getItem(CUSTOMER_DOCUMENTS_STUB_KEY)) || { documents: [] }; } catch { return { documents: [] }; }
};
const saveStub = (db) => { try { localStorage.setItem(CUSTOMER_DOCUMENTS_STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };
const keepFile = (id, file) => {
  try {
    const old = demoFiles.get(id);
    if (old) URL.revokeObjectURL(old);
    demoFiles.set(id, URL.createObjectURL(file));
  } catch { /* no object URLs here: the placeholder opens instead */ }
};

function stubUpload(meta, file) {
  const fields = customerDocumentFields(meta);
  if (fields.refused) throw refusal(fields.refused);
  const db = stubDb();
  const existing = db.documents.find((r) => r.id === meta.id);
  if (existing) return projectOfficeDocument(existing, todayKey());
  const row = {
    id: meta.id, client_id: meta.clientId ?? null, kind: fields.value.kind, title: fields.value.title,
    valid_until: fields.value.validUntil, file_name: meta.fileName, file_size: meta.sizeBytes, mime_type: meta.mimeType,
    visible_to_client: fields.value.visibleToClient, revision: 1, created_at: nowIso(), updated_at: nowIso(), created_by_user_id: null,
  };
  db.documents.push(row);
  saveStub(db);
  keepFile(row.id, file);
  return projectOfficeDocument(row, todayKey());
}

function stubReplace(doc, { file, title, validUntil }) {
  const extra = customerDocumentFields({ title, validUntil }, { partial: true });
  if (extra.refused) throw refusal(extra.refused);
  const db = stubDb();
  const row = db.documents.find((r) => r.id === doc.id);
  if (!row) throw Object.assign(new Error('not-found'), { code: 'not-found', status: 404 });
  Object.assign(row, {
    revision: (row.revision || 1) + 1, file_name: cleanFileName(file.name), file_size: file.size, mime_type: file.type, updated_at: nowIso(),
    ...(extra.value.title !== undefined ? { title: extra.value.title } : {}),
    ...(extra.value.validUntil !== undefined ? { valid_until: extra.value.validUntil } : {}),
  });
  saveStub(db);
  keepFile(row.id, file);
  return projectOfficeDocument(row, todayKey());
}

function stubUpdate(id, patch) {
  const fields = customerDocumentFields(patch, { partial: true });
  if (fields.refused) throw refusal(fields.refused);
  const db = stubDb();
  const row = db.documents.find((r) => r.id === id);
  if (!row) throw Object.assign(new Error('not-found'), { code: 'not-found', status: 404 });
  const v = fields.value;
  if (v.kind !== undefined) row.kind = v.kind;
  if (v.title !== undefined) row.title = v.title;
  if (v.validUntil !== undefined) row.valid_until = v.validUntil;
  if (v.visibleToClient !== undefined) row.visible_to_client = v.visibleToClient;
  row.updated_at = nowIso();
  saveStub(db);
  return projectOfficeDocument(row, todayKey());
}

function stubDelete(id) {
  const db = stubDb();
  db.documents = db.documents.filter((r) => r.id !== id);
  saveStub(db);
  const url = demoFiles.get(id);
  if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } demoFiles.delete(id); }
  return { ok: true };
}

function stubUrl(id) {
  return demoDocumentUrl(stubDb().documents.find((r) => r.id === id) || null);
}

// The demo's link to a document row (also the hub demo's, lib/hubDemo.js): the file picked this
// session, else a placeholder page naming the document. Null for no row.
export function demoDocumentUrl(row) {
  if (!STUB || !row) return null;
  return demoFiles.get(row.id) || placeholderPdfUrl([row.title, row.file_name || '', 'Sample document in the demo. The connected app opens the uploaded file.', `Link valid for ${CUSTOMER_DOCUMENT_URL_TTL_S / 60} minutes in the connected app.`]);
}
