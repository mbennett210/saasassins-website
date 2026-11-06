// CUSTOMER DOCUMENTS — the certificate of insurance, the W-9 and anything else the office keeps
// for a customer to download (client hub redesign, plan 2026-10-08 §3.6). PURE and node-safe:
// the office route (api/customer-documents), the hub's branches, the office screens, the demo
// and the suites all read the vocabulary and the rules from here, so none can drift.
//
// Matt's team uploads these (kickoff §H: they enter their own data; we import nothing). A
// document belongs to ONE building, or — `clientId` null — to every customer (the company's
// W-9). The office decides whether a customer sees it ("Visible to the customer").
//
// The SERVICE AGREEMENT is not one of these rows: it is the building's active contract
// (api/_lib/contracts), shown by the hub beside them as `agreement`.

// ── vocabulary ────────────────────────────────────────────────────────────────
// No database CHECK on `kind`, deliberately (the activity_log / client_users precedent): the
// vocabulary lives here and the writer refuses anything outside it.
export const CUSTOMER_DOCUMENT_KIND = Object.freeze({ coi: 'coi', w9: 'w9', other: 'other' });
export const CUSTOMER_DOCUMENT_KINDS = Object.freeze(Object.values(CUSTOMER_DOCUMENT_KIND));
// The order the hub draws them in (the agreement first, then the COI, then the W-9).
const KIND_RANK = { coi: 0, w9: 1, other: 2 };

// What may be uploaded: a PDF or a photo of the paper, up to 10 MB (plan §3.6).
export const CUSTOMER_DOCUMENT_MIME = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);
export const CUSTOMER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CUSTOMER_DOCUMENT_TITLE_MAX = 120;
export const CUSTOMER_DOCUMENT_FILE_NAME_MAX = 200;
// Every signed link to one of these (and to the agreement's PDF) lasts five minutes.
export const CUSTOMER_DOCUMENT_URL_TTL_S = 300;
// The hub asks for the agreement's link by this id instead of a document id.
export const AGREEMENT_DOCUMENT_ID = 'agreement';
// What the hub calls an agreement that has no name of its own.
export const AGREEMENT_FALLBACK_TITLE = 'Service Agreement';

// ── the rules ─────────────────────────────────────────────────────────────────
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDayKey = (v) => typeof v === 'string' && DAY_RE.test(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDocumentId = (v) => typeof v === 'string' && UUID_RE.test(v);

// "Valid through Mar 31, 2027": valid ON that day, expired from the day AFTER. `today` is the
// ORG's calendar day (lib/dates dayKey with company.timezone), never the device's or the server's.
// A document with no date (a W-9) never expires.
export function documentExpired(validUntil, today) {
  return isDayKey(validUntil) && isDayKey(today) && validUntil < today;
}

// The file the office picked, before anything is uploaded → null, or a refusal code
// ('file-type' | 'file-size') the screen and the route both name.
export function customerDocumentFileRefusal({ mimeType, sizeBytes }) {
  if (!CUSTOMER_DOCUMENT_MIME.includes(mimeType)) return 'file-type';
  const n = Number(sizeBytes);
  if (!Number.isFinite(n) || n <= 0 || n > CUSTOMER_DOCUMENT_MAX_BYTES) return 'file-size';
  return null;
}

// The fields a save may carry, coerced and bounded. `partial` (an edit) touches only the keys the
// body has. → { value } or { refused: code }. Codes: 'kind' | 'title' | 'valid-until' | 'visible'.
export function customerDocumentFields(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  const value = {};
  if (!partial || has('kind')) {
    if (!CUSTOMER_DOCUMENT_KINDS.includes(b.kind)) return { refused: 'kind' };
    value.kind = b.kind;
  }
  if (!partial || has('title')) {
    const title = typeof b.title === 'string' ? b.title.trim().replace(/\s+/g, ' ') : '';
    if (!title || title.length > CUSTOMER_DOCUMENT_TITLE_MAX) return { refused: 'title' };
    value.title = title;
  }
  if (!partial || has('validUntil')) {
    const v = b.validUntil;
    if (v === null || v === undefined || v === '') value.validUntil = null;
    else if (isDayKey(v)) value.validUntil = v;
    else return { refused: 'valid-until' };
  }
  if (!partial || has('visibleToClient')) {
    if (b.visibleToClient === undefined && !partial) value.visibleToClient = true;
    else if (typeof b.visibleToClient === 'boolean') value.visibleToClient = b.visibleToClient;
    else return { refused: 'visible' };
  }
  return { value };
}

// A file's own name as the office named it: no path, bounded.
export function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().trim();
  return (base || 'document').slice(0, CUSTOMER_DOCUMENT_FILE_NAME_MAX);
}

// Kind (COI, W-9, other), then title, then the LATEST valid-through first (this year's
// certificate above last year's), then id. Rows here are either table shape (`valid_until`) or
// projected (`validUntil`).
const validOf = (r) => r.validUntil ?? r.valid_until ?? '';
const byKindThenTitle = (a, b) => ((KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9))
  || String(a.title || '').localeCompare(String(b.title || ''), 'en', { sensitivity: 'base' })
  || String(validOf(b)).localeCompare(String(validOf(a)))
  || String(a.id).localeCompare(String(b.id));

// ── the office's view ─────────────────────────────────────────────────────────
// 🔴 ALLOWLISTS, built field by field (never a spread of a row). The office row says where the
// file is NOT (no storage path anywhere: the server rebuilds it from the id and the revision).
export const OFFICE_DOCUMENT_FIELDS = Object.freeze([
  'id', 'clientId', 'kind', 'title', 'validUntil', 'expired', 'fileName', 'fileSize', 'mimeType',
  'visibleToClient', 'revision', 'createdAt', 'updatedAt',
]);
// `row` is the table's snake_case row.
export function projectOfficeDocument(row, today) {
  return {
    id: row.id,
    clientId: row.client_id ?? null,
    kind: row.kind,
    title: row.title,
    validUntil: isDayKey(row.valid_until) ? row.valid_until : null,
    expired: documentExpired(row.valid_until, today),
    fileName: row.file_name || null,
    fileSize: Number.isFinite(row.file_size) ? row.file_size : null,
    mimeType: row.mime_type || null,
    visibleToClient: row.visible_to_client !== false,
    revision: Number.isInteger(row.revision) ? row.revision : 1,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}
export function officeDocumentList(rows, today) {
  return (Array.isArray(rows) ? rows : []).map((r) => projectOfficeDocument(r, today)).sort(byKindThenTitle);
}

// ── the customer's view (the hub) ─────────────────────────────────────────────
export const HUB_DOCUMENT_FIELDS = Object.freeze(['id', 'kind', 'title', 'validUntil', 'expired']);
export const HUB_AGREEMENT_FIELDS = Object.freeze(['title', 'startedDay', 'hasFile']);

// THE ONE SCOPE RULE for what a customer may see and open at a building: visible, and either
// this building's own or the company's (no building). The server's queries say the same thing
// in SQL (building in the query, visible in the query); the demo runs this.
export function documentVisibleAt(row, clientId) {
  if (!row || row.visible_to_client === false) return false;
  return row.client_id == null || row.client_id === clientId;
}

export function projectHubDocument(row, today) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    validUntil: isDayKey(row.valid_until) ? row.valid_until : null,
    expired: documentExpired(row.valid_until, today),
  };
}
export function hubDocumentList(rows, clientId, today) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => documentVisibleAt(r, clientId))
    .map((r) => projectHubDocument(r, today))
    .sort(byKindThenTitle);
}

// The building's ACTIVE contract as the customer sees it: its name (else "Service Agreement"),
// the day it started, and whether a signed copy is on file — never a price, a term or a path.
// `contract` is { name, start_date | startDate, document_path | document }; null → null.
export function projectHubAgreement(contract) {
  if (!contract) return null;
  const name = typeof contract.name === 'string' ? contract.name.trim() : '';
  const started = contract.start_date ?? contract.startDate ?? null;
  const hasFile = contract.document_path !== undefined
    ? !!contract.document_path
    : !!(contract.document && (contract.document.storagePath || contract.document.name));
  return { title: name || AGREEMENT_FALLBACK_TITLE, startedDay: isDayKey(started) ? started : null, hasFile };
}
