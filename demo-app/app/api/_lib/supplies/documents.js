// Service-role data layer for a supply ORDER's INVOICE (S131, plan docs/plans/2026-10-14-supply-orders.md
// §2; brief S §3) — the supplier's invoice the Supply Manager keeps with the order. Its own table
// (`supply_order_documents`, migration 20261014120000) and its own PRIVATE bucket
// (`supply-documents`): the customer-documents table is shown in the customer's portal, and an
// invoice never is. Only app/api/supplies/* calls this module.
//
// 🔴 THE RULES IT KEEPS (copied from api/_lib/customerDocuments/store.js)
//  1. THE OBJECT PATH IS BUILT HERE, NEVER RECEIVED: `<org>/<order id>/<document id>`, each id
//     checked as ONE safe segment (_lib/storagePaths.js) before it is joined. The path is stored
//     with the row (the order may be gone by the time a prune removes the object) and RE-CHECKED
//     against the row's own order before Storage is asked to sign or delete it.
//  2. UPLOAD → CONFIRM → VIEW: the route mints a signed upload link for the path it built, the
//     browser puts the bytes there, `confirm` inserts the row (a caller-minted id: a retried
//     confirm answers the row that landed), and `view-url` signs a 300-second link.
//  3. THE OBJECT GOES BEFORE THE ROW: a deleted invoice must not stay readable by its path.
//  4. PDF / JPEG / PNG up to 10 MB — the table's own checks (lib/supplies SUPPLY_INVOICE_*).
// Errors THROW with the provider's words for the server log; the route answers a sentence + code.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment, isSafeSegment, isValidStoragePath } from '../storagePaths.js';
import { SUPPLY_INVOICE_MAX_BYTES, SUPPLY_INVOICE_MIME } from '../../../src/lib/supplies.js';

export { SUPPLY_INVOICE_MAX_BYTES, SUPPLY_INVOICE_MIME };
const ORG = CLEANSPACE_ORG_ID;
export const SUPPLY_DOCUMENTS_TABLE = 'supply_order_documents';
export const SUPPLY_DOCUMENTS_BUCKET = 'supply-documents';
// How long a view link lives (brief S §3: a 300-second link).
export const SUPPLY_INVOICE_URL_TTL_S = 300;
// An order keeps a handful of invoices; twenty is far past any real one.
export const SUPPLY_INVOICES_MAX = 20;
const COLUMNS = 'id, request_id, kind, file_name, mime_type, size_bytes, storage_path, uploaded_by_user_id, uploader_name, created_at';

const must = (res, what) => {
  if (res && res.error) {
    const err = new Error(`${what}: ${res.error.message || res.error.code || 'failed'}`);
    err.code = res.error.code || null;
    throw err;
  }
  return res;
};

// ── rule 1: the path ─────────────────────────────────────────────────────────
export function invoicePathFor(requestId, docId) {
  requireSafeSegment(requestId, 'supply order id');
  requireSafeSegment(docId, 'supply document id');
  return `${ORG}/${requestId}/${docId}`;
}
// A stored path is used only when it is exactly the one this module builds for its row.
function pathOf(row) {
  const path = row && row.storage_path;
  if (!path || !isValidStoragePath(path)) return null;
  if (!isSafeSegment(row.request_id) || !isSafeSegment(row.id)) return null;
  return path === `${ORG}/${row.request_id}/${row.id}` ? path : null;
}

// The upload's own checks, before any link is minted: a caller-minted id, a file name, one of the
// three types, a size the table takes. → { ok: true, fileName } | { ok: false, code, error }
export function validateInvoiceUpload({ docId, fileName, mimeType, sizeBytes } = {}) {
  if (!isSafeSegment(docId)) return { ok: false, code: 'bad_id', error: 'An invoice needs a caller-minted id.' };
  // The name as shown: control characters (and line breaks) dropped, trimmed, at most 200.
  let name = '';
  for (const ch of typeof fileName === 'string' ? fileName : '') { const c = ch.charCodeAt(0); if (c >= 32 && c !== 127) name += ch; }
  name = name.trim().slice(0, 200);
  if (!name) return { ok: false, code: 'file_name_required', error: 'Name the file.' };
  if (!SUPPLY_INVOICE_MIME.includes(mimeType)) return { ok: false, code: 'bad_type', error: 'Use a PDF, JPG or PNG file.' };
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) return { ok: false, code: 'bad_size', error: 'That file is empty.' };
  if (size > SUPPLY_INVOICE_MAX_BYTES) return { ok: false, code: 'too_large', error: 'That file is over 10 MB.' };
  return { ok: true, fileName: name, sizeBytes: size };
}

// ── the rows ─────────────────────────────────────────────────────────────────
export const toInvoice = (row) => ({
  id: row.id, requestId: row.request_id, kind: row.kind || 'invoice', fileName: row.file_name || '',
  mimeType: row.mime_type || null, sizeBytes: Number(row.size_bytes) || 0,
  uploadedByUserId: row.uploaded_by_user_id || null, uploaderName: row.uploader_name || null,
  createdAt: row.created_at || null,
});

export async function listInvoices(requestId, db = getSupabase()) {
  if (!isSafeSegment(requestId)) return [];
  const { data } = must(await db.from(SUPPLY_DOCUMENTS_TABLE).select(COLUMNS)
    .eq('organization_id', ORG).eq('request_id', requestId)
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .limit(SUPPLY_INVOICES_MAX), 'supply invoices read failed');
  return (data || []).map(toInvoice);
}

export async function getInvoiceRow(id, db = getSupabase()) {
  if (!isSafeSegment(id)) return null;
  const { data } = must(await db.from(SUPPLY_DOCUMENTS_TABLE).select(COLUMNS)
    .eq('organization_id', ORG).eq('id', id).maybeSingle(), 'supply invoice read failed');
  return data || null;
}

// CONFIRM: the row, after the bytes landed. A caller-minted id, so a retried confirm answers the row
// that landed — if it is this order's (an id another order holds is refused: `id_taken`).
// → { row, created }
export async function insertInvoice({ docId, requestId, fileName, mimeType, sizeBytes, uploadedByUserId, uploaderName }, db = getSupabase()) {
  const storagePath = invoicePathFor(requestId, docId);
  const res = await db.from(SUPPLY_DOCUMENTS_TABLE).insert({
    id: docId, organization_id: ORG, request_id: requestId, kind: 'invoice', file_name: fileName,
    mime_type: mimeType, size_bytes: sizeBytes, storage_path: storagePath,
    uploaded_by_user_id: uploadedByUserId || null, uploader_name: uploaderName || null,
  }).select(COLUMNS);
  if (res.error && res.error.code === '23505') {
    const existing = await getInvoiceRow(docId, db);
    if (existing && existing.request_id === requestId) return { row: existing, created: false };
    const err = new Error('supply invoice id taken');
    err.code = 'id_taken';
    throw err;
  }
  must(res, 'supply invoice insert failed');
  return { row: (res.data && res.data[0]) || (await getInvoiceRow(docId, db)), created: true };
}

// ── storage links ────────────────────────────────────────────────────────────
// An upload address for the path the route built. `upsert` so a retried upload of the same id (the
// bytes landed, the confirm did not) succeeds rather than failing on "exists".
export async function signedInvoiceUploadUrl(path, db = getSupabase()) {
  const { data, error } = await db.storage.from(SUPPLY_DOCUMENTS_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error) throw new Error(`supply invoice upload address failed: ${error.message || 'unknown'}`);
  return { path: (data && data.path) || path, token: data && data.token, signedUrl: data && data.signedUrl };
}

// A 300-second link to read it, or null when the row's path is not the one this module builds (the
// route answers that as a missing file).
export async function signedInvoiceViewUrl(row, db = getSupabase()) {
  const path = pathOf(row);
  if (!path) return null;
  const { data, error } = await db.storage.from(SUPPLY_DOCUMENTS_BUCKET).createSignedUrl(path, SUPPLY_INVOICE_URL_TTL_S);
  if (error) {
    // A row whose object is gone (a seed row, an interrupted upload): no link, not a 500.
    if (/not.?found/i.test(String(error.message || '')) || String(error.statusCode) === '404') return null;
    throw new Error(`supply invoice link failed: ${error.message || 'unknown'}`);
  }
  return (data && data.signedUrl) || null;
}

// rule 3 — the object first, then the row.
export async function deleteInvoice(row, db = getSupabase()) {
  const path = pathOf(row);
  if (path) {
    const { error } = await db.storage.from(SUPPLY_DOCUMENTS_BUCKET).remove([path]);
    if (error) throw new Error(`supply invoice object remove failed: ${error.message || 'unknown'}`);
  }
  must(await db.from(SUPPLY_DOCUMENTS_TABLE).delete().eq('organization_id', ORG).eq('id', row.id), 'supply invoice delete failed');
}

// RETENTION AT THE WRITE POINT (II.8): the invoices of orders being deleted — a cancel, or the
// 12-month prune — leave Storage too. Their rows go with the order (on delete cascade), taking the
// paths with them, so the caller reads the paths FIRST (`invoiceObjectPaths`), deletes the orders,
// then removes the objects (`removeInvoiceObjects`) — an order that was not deleted after all (a
// stale cancel) keeps its files. Complete on the read; best-effort on the objects.
export async function invoiceObjectPaths(requestIds, db = getSupabase()) {
  const ids = [...new Set((Array.isArray(requestIds) ? requestIds : []).filter(isSafeSegment))];
  const paths = [];
  // 50 orders a read × at most SUPPLY_INVOICES_MAX each stays inside PostgREST's 1000-row cap.
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = must(await db.from(SUPPLY_DOCUMENTS_TABLE).select('id, request_id, storage_path')
      .eq('organization_id', ORG).in('request_id', ids.slice(i, i + 50))
      .order('id', { ascending: true }).limit(50 * SUPPLY_INVOICES_MAX), 'supply invoices read failed');
    paths.push(...(data || []).map(pathOf).filter(Boolean));
  }
  return paths;
}
export async function removeInvoiceObjects(paths, db = getSupabase()) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && isValidStoragePath(p) && p.startsWith(`${ORG}/`));
  let removed = 0;
  for (let i = 0; i < list.length; i += 100) {
    try {
      await db.storage.from(SUPPLY_DOCUMENTS_BUCKET).remove(list.slice(i, i + 100));
      removed += Math.min(100, list.length - i);
    } catch { /* best-effort: the rows went with their order */ }
  }
  return removed;
}
