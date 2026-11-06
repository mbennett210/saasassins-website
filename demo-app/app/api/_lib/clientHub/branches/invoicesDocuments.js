// THE CLIENT HUB'S INVOICES AND DOCUMENTS (client hub redesign, plan 2026-10-08 §3.5 + §3.6) —
// four READ branches of /api/hub, spread into its BRANCHES table. The route has already run
// `requireClientUser` and built `ctx` (the login's claim-resolved scope); every branch here starts
// with the route's own `buildingIn` gate, so a building outside the scope — and any record that is
// not that building's — is the route's 404 that confirms nothing.
//
//   GET invoices?buildingId[&offset&limit]  -> { state, rows[], total, offset, limit, summary, asOf }
//   GET invoice-pdf?buildingId&id           -> application/pdf (Intuit's own rendering)
//   GET documents?buildingId                -> { agreement: { title, startedDay, hasFile } | null, documents[] }
//   GET document-url?buildingId&id          -> { url, expiresIn }   (id = a document's uuid, or 'agreement')
//
// Every answer is built from an allowlist (src/lib/hubInvoices.js, src/lib/customerDocuments.js),
// shared with the demo's twins (src/lib/hubDemo.js). Errors are a sentence + a code. The hub is
// English (LANG-8). Dates are the ORG's (company.timezone), never the server's.
import { readProtectedSlices } from '../../orgState.js';
import { QboError, isTransient } from '../../qbo/client.js';
import { invoicesForBuilding, buildingInvoicePdf, isQboId } from '../../qbo/invoices.js';
import * as docs from '../../customerDocuments/store.js';
import { hubPage } from '../../../../src/lib/clientHubView.js';
import { HUB_INVOICE_STATE, hubInvoiceList } from '../../../../src/lib/hubInvoices.js';
import {
  AGREEMENT_DOCUMENT_ID, CUSTOMER_DOCUMENT_URL_TTL_S, isDocumentId, hubDocumentList, projectHubAgreement,
} from '../../../../src/lib/customerDocuments.js';
import { dayKey } from '../../../../src/lib/dates.js';

// Every Intuit call one hub request makes ends inside this (the function's limit is 60 s).
export const HUB_QBO_BUDGET_MS = 25 * 1000;

// The appended LIMITS / SENTENCES entries live in the route beside the others; their keys:
export const INVOICE_PDF_LIMIT_KEY = 'invoice-pdf';
export const DOCUMENT_URL_LIMIT_KEY = 'document-url';

// The org's zone: the route's context when it carries it, else one small read of the record.
async function orgZone(ctx) {
  if (ctx && typeof ctx.tz === 'string' && ctx.tz) return ctx.tz;
  try {
    const slices = await readProtectedSlices('company:state->company');
    return slices?.company?.timezone || null;
  } catch {
    return null; // lib/dates falls back to the org default zone, never the server's
  }
}

const EMPTY_SUMMARY = Object.freeze({ openCount: 0, openCents: 0, overdueCount: 0, paidCount: 0 });

// A QuickBooks failure, as the customer is told it. A connection that needs reconnecting reads
// as "not connected" (nothing the customer can do differs); anything else is `unavailable`.
function stateOfError(e) {
  if (e instanceof QboError && (e.code === 'not_connected' || e.code === 'reauth_required' || e.code === 'invalid_grant')) return HUB_INVOICE_STATE.notConnected;
  return HUB_INVOICE_STATE.unavailable;
}

/**
 * @param h the route's own helpers: buildingIn(ctx, id), fail(res, status, code, sentence?),
 *          notFound(res), limited(req, res, c, action)
 */
export function invoiceAndDocumentBranches({ buildingIn, fail, notFound, limited }) {
  return {
    // §3.5: the building's invoices of the last twelve months, read-only from QuickBooks.
    'GET invoices': async ({ res, ctx, q, now }) => {
      const b = buildingIn(ctx, q.buildingId);
      if (!b) return notFound(res);
      const { offset, limit } = hubPage(q);
      const tz = await orgZone(ctx);
      let out;
      try {
        out = await invoicesForBuilding({ clientId: b.id, now, tz, deadline: now + HUB_QBO_BUDGET_MS });
      } catch (e) {
        if (!(e instanceof QboError)) throw e; // a store failure: the route's 503 read-failed
        console.error(`[api/hub] invoices: QuickBooks failed (${e.code}${isTransient(e) ? ', transient' : ''})`);
        out = { state: stateOfError(e), invoices: [], asOf: null };
      }
      if (out.state !== HUB_INVOICE_STATE.ready) {
        return res.status(200).json({ state: out.state, rows: [], total: 0, offset, limit, summary: { ...EMPTY_SUMMARY }, asOf: null });
      }
      const list = hubInvoiceList(out.invoices, { today: dayKey(new Date(now), tz), offset, limit });
      return res.status(200).json({ state: out.state, rows: list.rows, total: list.total, offset, limit, summary: list.summary, asOf: out.asOf });
    },

    // §3.5: one invoice as Intuit renders it — only after re-reading it and finding its customer
    // among THIS building's. A foreign, voided or out-of-window id is a 404; no PDF is fetched.
    'GET invoice-pdf': async ({ req, res, c, ctx, q, now }) => {
      const b = buildingIn(ctx, q.buildingId);
      if (!b || !isQboId(q.id)) return notFound(res);
      if (limited(req, res, c, INVOICE_PDF_LIMIT_KEY)) return undefined;
      const tz = await orgZone(ctx);
      let got;
      try {
        got = await buildingInvoicePdf({ clientId: b.id, invoiceId: q.id, now, tz, deadline: now + HUB_QBO_BUDGET_MS });
      } catch (e) {
        if (!(e instanceof QboError)) throw e;
        console.error(`[api/hub] invoice-pdf: QuickBooks failed (${e.code})`);
        return fail(res, 503, 'invoice-unavailable');
      }
      if (!got.found) return notFound(res);
      const safe = String(got.number || q.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || q.id;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${safe}.pdf"`);
      return res.status(200).send(got.pdf);
    },

    // §3.6: the building's agreement (its ACTIVE contract) and its visible documents, with the
    // company's own (the W-9).
    'GET documents': async ({ res, ctx, q, now }) => {
      const b = buildingIn(ctx, q.buildingId);
      if (!b) return notFound(res);
      const tz = await orgZone(ctx);
      const [agreement, rows] = await Promise.all([docs.activeAgreementFor(b.id), docs.visibleDocumentsFor(b.id)]);
      return res.status(200).json({
        agreement: projectHubAgreement(agreement),
        documents: hubDocumentList(rows, b.id, dayKey(new Date(now), tz)),
      });
    },

    // §3.6: a five-minute link to one document — re-checked here: this building's or the
    // company's, and visible. `agreement` is the active contract's signed PDF.
    'GET document-url': async ({ req, res, c, ctx, q }) => {
      const b = buildingIn(ctx, q.buildingId);
      if (!b) return notFound(res);
      if (q.id === AGREEMENT_DOCUMENT_ID) {
        const agreement = await docs.activeAgreementFor(b.id);
        if (!agreement) return notFound(res);
        if (!agreement.document_path) return fail(res, 404, 'no-file');
        if (limited(req, res, c, DOCUMENT_URL_LIMIT_KEY)) return undefined;
        const url = await docs.signedAgreementUrl(agreement);
        if (!url) return fail(res, 404, 'no-file');
        return res.status(200).json({ url, expiresIn: CUSTOMER_DOCUMENT_URL_TTL_S });
      }
      if (!isDocumentId(q.id)) return notFound(res);
      const row = await docs.visibleDocumentById({ clientId: b.id, id: q.id });
      if (!row) return notFound(res);
      if (limited(req, res, c, DOCUMENT_URL_LIMIT_KEY)) return undefined;
      return res.status(200).json({ url: await docs.signedViewUrl(row), expiresIn: CUSTOMER_DOCUMENT_URL_TTL_S });
    },
  };
}
