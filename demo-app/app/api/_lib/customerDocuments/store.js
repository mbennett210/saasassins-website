// Service-role data layer for CUSTOMER DOCUMENTS (client hub redesign, plan 2026-10-08 §3.6):
// the COI, the W-9 and the rest the office keeps for a customer, plus the hub's read of the
// building's ACTIVE service agreement. Only app/api/customer-documents/* (the office) and the
// hub's branches (api/_lib/clientHub/branches/invoicesDocuments.js) call this module.
//
// 🔴 THE THREE RULES THIS MODULE KEEPS
//  1. THE OBJECT PATH IS REBUILT, NEVER RECEIVED. A document's bytes live at
//     `<org>/<document id>/r<revision>` in the private `customer-documents` bucket
//     (migration 20261008120100). No column stores a path and no function here takes one from a
//     caller: every path is `documentObjectPath(row)`, the id validated as ONE safe segment
//     (_lib/storagePaths.js). A replacement uploads to the NEXT revision and the old object is
//     removed once the row points at the new one (replace means delete, BUILD_INTEGRITY §3).
//  2. THE BUILDING IS IN THE QUERY. A hub read filters by the building the route already checked
//     against the login's scope (or `client_id is null`, the company's own) AND by
//     `visible_to_client`, so another building's or a hidden document comes back as nothing.
//  3. DECLARED COLUMNS, BOUNDED READS. No select(*); every list is ordered and limited.
//
// The agreement is read from the contracts tables (CS-194) by the building's ACTIVE row in
// `contract_buildings` (`active` is trigger-derived from the parent's status), and only its
// name, status, start date and document path are SELECTED — never a price.
//
// Errors THROW with the provider's words for the server log; the routes answer a sentence + code.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment, isValidStoragePath } from '../storagePaths.js';
import { BUCKET as CONTRACT_BUCKET, contractPrefix } from '../contracts/store.js';
import { CUSTOMER_DOCUMENT_URL_TTL_S, isDocumentId } from '../../../src/lib/customerDocuments.js';

const ORG = CLEANSPACE_ORG_ID;
export const DOCUMENTS_TABLE = 'customer_documents';
export const DOCUMENTS_BUCKET = 'customer-documents';

// rule 3 — every column the office's row is built from (src/lib/customerDocuments.js
// projectOfficeDocument), and the hub's narrower list.
export const DOCUMENT_COLUMNS = 'id,client_id,kind,title,valid_until,file_name,file_size,mime_type,visible_to_client,revision,created_at,updated_at';
export const HUB_DOCUMENT_COLUMNS = 'id,client_id,kind,title,valid_until,visible_to_client,revision';
const AGREEMENT_COLUMNS = 'id,name,status,start_date,document_path';
// A building keeps a handful of documents; a hundred is far past any real one.
export const DOCUMENTS_MAX = 100;

const must = (res, what) => {
  if (res?.error) {
    const err = new Error(`${what}: ${res.error.message || res.error.code || 'failed'}`);
    err.code = res.error.code || null;
    throw err;
  }
  return res;
};
const nowIso = () => new Date().toISOString();

// ── rule 1: the path ─────────────────────────────────────────────────────────
export function documentObjectPath({ id, revision }) {
  requireSafeSegment(id, 'document id');
  const rev = Number(revision);
  if (!Number.isInteger(rev) || rev < 1) throw new Error('unsafe document revision');
  return `${ORG}/${id}/r${rev}`;
}

// ── office reads ─────────────────────────────────────────────────────────────
// One building's documents (every one, hidden included) AND the company's, or — `clientId`
// null — the company's alone.
export async function listDocuments({ clientId = null } = {}, db = getSupabase()) {
  const base = () => db.from(DOCUMENTS_TABLE).select(DOCUMENT_COLUMNS).eq('organization_id', ORG);
  const reads = [base().is('client_id', null).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(DOCUMENTS_MAX)];
  if (clientId) reads.push(base().eq('client_id', clientId).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(DOCUMENTS_MAX));
  const answers = await Promise.all(reads);
  return answers.flatMap((r) => must(r, 'customer documents read failed').data || []);
}

export async function getDocument(id, db = getSupabase()) {
  if (!isDocumentId(id)) return null;
  const { data } = must(await db.from(DOCUMENTS_TABLE).select(DOCUMENT_COLUMNS)
    .eq('organization_id', ORG).eq('id', id).maybeSingle(), 'customer document read failed');
  return data || null;
}

// ── office writes ────────────────────────────────────────────────────────────
// `row` is fully validated by the route; the id is the caller's (minted on the screen).
export async function insertDocument(row, db = getSupabase()) {
  const { data } = must(await db.from(DOCUMENTS_TABLE).insert({
    id: row.id,
    organization_id: ORG,
    client_id: row.clientId ?? null,
    kind: row.kind,
    title: row.title,
    valid_until: row.validUntil ?? null,
    file_name: row.fileName,
    file_size: Number.isFinite(row.fileSize) ? row.fileSize : null,
    mime_type: row.mimeType,
    visible_to_client: row.visibleToClient !== false,
    revision: 1,
    created_by_user_id: row.createdByUserId || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }).select(DOCUMENT_COLUMNS), 'customer document insert failed');
  return (data && data[0]) || null;
}

// The office's edits: the title, the kind, the valid-through day and the switch.
export async function updateDocument(id, patch, db = getSupabase()) {
  const cols = {};
  if (patch.kind !== undefined) cols.kind = patch.kind;
  if (patch.title !== undefined) cols.title = patch.title;
  if (patch.validUntil !== undefined) cols.valid_until = patch.validUntil;
  if (patch.visibleToClient !== undefined) cols.visible_to_client = patch.visibleToClient;
  const { data } = must(await db.from(DOCUMENTS_TABLE).update({ ...cols, updated_at: nowIso() })
    .eq('organization_id', ORG).eq('id', id).select(DOCUMENT_COLUMNS), 'customer document update failed');
  return (data && data[0]) || null;
}

// A new file for an existing document: CAS on the revision the caller replaced, so two replaces
// cannot both land (the loser's row is null). The OLD object is removed only after the row
// points at the new one.
export async function replaceDocumentFile(row, { revision, fileName, fileSize, mimeType, title, validUntil }, db = getSupabase()) {
  const cols = { revision, file_name: fileName, file_size: Number.isFinite(fileSize) ? fileSize : null, mime_type: mimeType, updated_at: nowIso() };
  if (title !== undefined) cols.title = title;
  if (validUntil !== undefined) cols.valid_until = validUntil;
  const { data } = must(await db.from(DOCUMENTS_TABLE).update(cols)
    .eq('organization_id', ORG).eq('id', row.id).eq('revision', row.revision)
    .select(DOCUMENT_COLUMNS), 'customer document replace failed');
  const saved = (data && data[0]) || null;
  if (saved) await removeObject(documentObjectPath(row), db);
  return saved;
}

// The object first (a deleted document must not stay readable by its path), then the row.
export async function deleteDocument(row, db = getSupabase()) {
  await removeObject(documentObjectPath(row), db);
  must(await db.from(DOCUMENTS_TABLE).delete().eq('organization_id', ORG).eq('id', row.id), 'customer document delete failed');
}

async function removeObject(path, db) {
  const { error } = await db.storage.from(DOCUMENTS_BUCKET).remove([path]);
  if (error) throw new Error(`customer document object remove failed: ${error.message || 'unknown'}`);
}

// ── storage links ────────────────────────────────────────────────────────────
// An upload address for the revision the route chose. `upsert` so a retried upload of the same
// revision (the bytes landed, the confirm did not) succeeds rather than failing on "exists".
export async function signedUploadUrl(path, db = getSupabase()) {
  const { data, error } = await db.storage.from(DOCUMENTS_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error) throw new Error(`customer document upload address failed: ${error.message || 'unknown'}`);
  return { path: (data && data.path) || path, token: data && data.token, signedUrl: data && data.signedUrl };
}

export async function signedViewUrl(row, db = getSupabase()) {
  const path = documentObjectPath(row);
  const { data, error } = await db.storage.from(DOCUMENTS_BUCKET).createSignedUrl(path, CUSTOMER_DOCUMENT_URL_TTL_S);
  if (error) throw new Error(`customer document link failed: ${error.message || 'unknown'}`);
  return (data && data.signedUrl) || null;
}

// ── the hub's reads (rule 2) ─────────────────────────────────────────────────
// Two queries — this building's, the company's — each with `visible_to_client` IN THE QUERY.
export async function visibleDocumentsFor(clientId, db = getSupabase()) {
  const base = () => db.from(DOCUMENTS_TABLE).select(HUB_DOCUMENT_COLUMNS).eq('organization_id', ORG).eq('visible_to_client', true);
  const [own, company] = await Promise.all([
    base().eq('client_id', clientId).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(DOCUMENTS_MAX),
    base().is('client_id', null).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(DOCUMENTS_MAX),
  ]);
  return [...(must(own, 'hub documents read failed').data || []), ...(must(company, 'hub documents read failed').data || [])];
}

// One document by id — this building's or the company's, and visible — or null.
export async function visibleDocumentById({ clientId, id }, db = getSupabase()) {
  if (!isDocumentId(id)) return null;
  const { data } = must(await db.from(DOCUMENTS_TABLE).select(HUB_DOCUMENT_COLUMNS)
    .eq('organization_id', ORG).eq('id', id).eq('visible_to_client', true)
    .maybeSingle(), 'hub document read failed');
  if (!data) return null;
  return data.client_id == null || data.client_id === clientId ? data : null;
}

// THE AGREEMENT: the building's ACTIVE contract (one, by the partial unique index; a master
// agreement covering several buildings is found from any of them — M3 ★a), or null.
export async function activeAgreementFor(clientId, db = getSupabase()) {
  const { data: links } = must(await db.from('contract_buildings').select('contract_id')
    .eq('organization_id', ORG).eq('client_id', clientId).eq('active', true)
    .order('contract_id', { ascending: true }).limit(5), 'agreement read failed');
  const ids = [...new Set((links || []).map((l) => l.contract_id).filter(Boolean))];
  if (!ids.length) return null;
  const { data: rows } = must(await db.from('contracts').select(AGREEMENT_COLUMNS)
    .eq('organization_id', ORG).in('id', ids).eq('status', 'active')
    .order('start_date', { ascending: false }).order('id', { ascending: true }).limit(5), 'agreement read failed');
  return (rows || [])[0] || null;
}

// The agreement's signed PDF, five minutes. The stored path must sit under THIS contract's own
// prefix (contracts' rule) and pass the storage-path alphabet, or nothing is signed.
export async function signedAgreementUrl(agreement, db = getSupabase()) {
  const path = agreement?.document_path;
  if (!path || !isValidStoragePath(path) || !path.startsWith(contractPrefix(agreement.id))) return null;
  const { data, error } = await db.storage.from(CONTRACT_BUCKET).createSignedUrl(path, CUSTOMER_DOCUMENT_URL_TTL_S);
  if (error) throw new Error(`agreement link failed: ${error.message || 'unknown'}`);
  return (data && data.signedUrl) || null;
}
