// CUSTOMER DOCUMENTS — the office's side (client hub redesign, plan 2026-10-08 §3.6): the
// certificate of insurance, the W-9 and the rest Matt's team uploads for a customer to download
// from the hub. A catch-all domain; its `vercel.json` rewrite is
// `/api/customer-documents/:rest* -> /api/customer-documents/_?subpath=:rest*` (THE LAW II.6).
//
//   GET  /api/customer-documents/list?clientId=<cl_*>   -> { documents, today }  the building's + the company's
//   GET  /api/customer-documents/list?scope=company     -> { documents, today }  the company's (every customer)
//   GET  /api/customer-documents/view-url?id=<uuid>     -> { url, expiresIn }    5 minutes
//   POST /api/customer-documents/upload-url { id, clientId|null, mimeType, sizeBytes }        -> { path, token, signedUrl, revision }
//   POST /api/customer-documents/upload-url { id, replace: true, mimeType, sizeBytes }        -> the NEXT revision's address
//   POST /api/customer-documents/confirm { id, clientId|null, kind, title, validUntil, fileName, mimeType, sizeBytes, visibleToClient } -> { document }
//   POST /api/customer-documents/update  { id, kind?, title?, validUntil?, visibleToClient? } -> { document }
//   POST /api/customer-documents/replace { id, revision, fileName, mimeType, sizeBytes, title?, validUntil? } -> { document }
//   POST /api/customer-documents/delete  { id }                                                -> { ok }
//
// AUTH STANCE (declared at creation, by capability): every branch — an unknown one included —
// gates FIRST on `hub.documents.manage` through requirePermission, the SAME can() the screens
// run over the COMMITTED matrix and the caller's overrides. Owner, admin and manager hold it by
// default; crew never. A CUSTOMER login is refused by the central rule before any key is asked
// (403 client-login, _lib/authz.js). RLS is on with no policies (migration 20261008120000), so
// this gate IS the boundary.
//
// 🔴 THE OBJECT PATH IS NEVER TAKEN FROM A BODY. It is rebuilt from the document's id and
// revision (api/_lib/customerDocuments/store.js documentObjectPath). A replacement goes to the
// next revision and the old object is removed (replace means delete); a delete removes the
// object and the row. Ids are CALLER-MINTED, so a retried confirm is one document.
//
// Errors are a sentence + a code; the provider's words go to the server log only.
// Cache-Control: private, no-store — per-login and authority-bearing (playbook II.7).
import { requirePermission } from '../_lib/authz.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { dayKey } from '../../src/lib/dates.js';
import {
  CUSTOMER_DOCUMENT_URL_TTL_S, isDocumentId, customerDocumentFileRefusal, customerDocumentFields,
  cleanFileName, projectOfficeDocument, officeDocumentList,
} from '../../src/lib/customerDocuments.js';
import * as store from '../_lib/customerDocuments/store.js';

export const DOCUMENTS_PERMISSION = 'hub.documents.manage';

const SENTENCES = {
  'not-found': 'That document is no longer here. Refresh the page.',
  'bad-request': 'Name a customer, or the company scope.',
  'unknown-customer': 'That customer is not in the customer list.',
  'document-id': 'This document could not be saved. Refresh the page and try again.',
  'document-exists': 'This document is already saved. Refresh the page.',
  'file-type': 'Upload a PDF, JPG or PNG.',
  'file-size': 'That file is too large. The limit is 10 MB.',
  kind: 'Pick what kind of document this is.',
  title: 'Give the document a title (up to 120 characters).',
  'valid-until': 'The valid-through date is not a date.',
  visible: 'Choose whether the customer sees this document.',
  stale: 'This document was just changed by someone else. Refresh the page and try again.',
  'read-failed': 'Documents could not be loaded just now. Try again in a moment.',
  'save-failed': 'That could not be saved just now. Try again in a moment.',
};
function fail(res, status, code) {
  return res.status(status).json({ error: SENTENCES[code] || 'Something went wrong. Try again.', code });
}

// The two slices every branch may need: the customer book (a building must exist) and the
// company's zone (a COI's "Expired" is judged on the org's day, never the server's).
async function orgContext() {
  const slices = await readProtectedSlices('clients:state->clients,company:state->company');
  const clients = Array.isArray(slices?.clients) ? slices.clients.filter((c) => c && c.id) : [];
  const tz = slices?.company?.timezone || null;
  return { clientIds: new Set(clients.map((c) => c.id)), today: dayKey(new Date(), tz) };
}
// A document's building: null (every customer) or a customer in the book.
const knownBuilding = (ctx, v) => v === null || v === undefined || (typeof v === 'string' && ctx.clientIds.has(v));

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const q = req.query || {};

  // Authenticate FIRST, on every branch (an unknown one included): 401 / 403 written here.
  const g = await requirePermission(req, res, DOCUMENTS_PERMISSION);
  if (!g) return undefined;
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    const ctx = await orgContext();

    if (req.method === 'GET' && action === 'list') {
      const scopeCompany = q.scope === 'company';
      const clientId = typeof q.clientId === 'string' && q.clientId ? q.clientId : null;
      if (!scopeCompany && !clientId) return fail(res, 400, 'bad-request');
      if (clientId && !ctx.clientIds.has(clientId)) return fail(res, 400, 'unknown-customer');
      const rows = await store.listDocuments({ clientId: scopeCompany ? null : clientId });
      return res.status(200).json({ documents: officeDocumentList(rows, ctx.today), today: ctx.today });
    }

    if (req.method === 'GET' && action === 'view-url') {
      const row = await store.getDocument(q.id);
      if (!row) return fail(res, 404, 'not-found');
      return res.status(200).json({ url: await store.signedViewUrl(row), expiresIn: CUSTOMER_DOCUMENT_URL_TTL_S });
    }

    if (req.method === 'POST' && action === 'upload-url') {
      if (!isDocumentId(body.id)) return fail(res, 400, 'document-id');
      const refused = customerDocumentFileRefusal({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (refused) return fail(res, 400, refused);
      if (body.replace === true) {
        const row = await store.getDocument(body.id);
        if (!row) return fail(res, 404, 'not-found');
        const revision = row.revision + 1;
        return res.status(200).json({ ...(await store.signedUploadUrl(store.documentObjectPath({ id: row.id, revision }))), revision });
      }
      if (!knownBuilding(ctx, body.clientId)) return fail(res, 400, 'unknown-customer');
      if (await store.getDocument(body.id)) return fail(res, 409, 'document-exists');
      return res.status(200).json({ ...(await store.signedUploadUrl(store.documentObjectPath({ id: body.id, revision: 1 }))), revision: 1 });
    }

    if (req.method === 'POST' && action === 'confirm') {
      if (!isDocumentId(body.id)) return fail(res, 400, 'document-id');
      const clientId = body.clientId ?? null;
      // A replay of this save (a double tap, a retried request) answers the document it made; the
      // same id for another building is refused, never moved.
      const existing = await store.getDocument(body.id);
      if (existing) {
        if ((existing.client_id ?? null) !== clientId) return fail(res, 409, 'document-id');
        return res.status(200).json({ document: projectOfficeDocument(existing, ctx.today) });
      }
      if (!knownBuilding(ctx, clientId)) return fail(res, 400, 'unknown-customer');
      const fields = customerDocumentFields(body);
      if (fields.refused) return fail(res, 400, fields.refused);
      const refused = customerDocumentFileRefusal({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (refused) return fail(res, 400, refused);
      const row = await store.insertDocument({
        id: body.id, clientId, ...fields.value,
        fileName: cleanFileName(body.fileName), fileSize: Number(body.sizeBytes), mimeType: body.mimeType,
        // The author is the verified login, never a body field.
        createdByUserId: g.orgUserId || null,
      });
      return res.status(200).json({ document: projectOfficeDocument(row, ctx.today) });
    }

    if (req.method === 'POST' && action === 'update') {
      const row = await store.getDocument(body.id);
      if (!row) return fail(res, 404, 'not-found');
      const fields = customerDocumentFields(body, { partial: true });
      if (fields.refused) return fail(res, 400, fields.refused);
      if (!Object.keys(fields.value).length) return res.status(200).json({ document: projectOfficeDocument(row, ctx.today) });
      const saved = await store.updateDocument(row.id, fields.value);
      if (!saved) return fail(res, 404, 'not-found');
      return res.status(200).json({ document: projectOfficeDocument(saved, ctx.today) });
    }

    if (req.method === 'POST' && action === 'replace') {
      const row = await store.getDocument(body.id);
      if (!row) return fail(res, 404, 'not-found');
      const refused = customerDocumentFileRefusal({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (refused) return fail(res, 400, refused);
      // The revision the upload address was minted for must be the NEXT one: anything else means
      // someone replaced it in between (or this is a replay of a replace that already landed).
      if (Number(body.revision) !== row.revision + 1) return fail(res, 409, 'stale');
      const extra = customerDocumentFields({ title: body.title, validUntil: body.validUntil }, { partial: true });
      if (extra.refused) return fail(res, 400, extra.refused);
      const saved = await store.replaceDocumentFile(row, {
        revision: row.revision + 1, fileName: cleanFileName(body.fileName), fileSize: Number(body.sizeBytes),
        mimeType: body.mimeType, ...extra.value,
      });
      if (!saved) return fail(res, 409, 'stale');
      return res.status(200).json({ document: projectOfficeDocument(saved, ctx.today) });
    }

    if (req.method === 'POST' && action === 'delete') {
      const row = await store.getDocument(body.id);
      if (!row) return fail(res, 404, 'not-found');
      await store.deleteDocument(row);
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown route', code: 'not-found' });
  } catch (e) {
    console.error(`[api/customer-documents] ${req.method} ${action || ''} failed:`, e?.code || '', String(e?.message || e).slice(0, 200));
    return req.method === 'GET' ? fail(res, 503, 'read-failed') : fail(res, 500, 'save-failed');
  }
}
