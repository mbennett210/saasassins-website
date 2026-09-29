// Admin routes for e-signature quotes (owner/admin only). One serverless function.
//   POST /create            { contact, templateKey }  → draft from template
//   GET  /list                                         → all quotes
//   GET  /:id                                          → one quote
//   POST /:id/save          { fields }                 → merge edits
//   POST /:id/admin-sign    { signerName, signatureDataUrl } → store admin sig
//   POST /:id/send                                     → status 'sent' (+ email stub)
//   GET  /:id/download                                 → { url } signed PDF
//   POST /:id/void                                     → status 'void'
import {
  createFromTemplate, listQuotes, getQuoteById, saveFields,
  recordAdminSignature, markSent, voidQuote, deleteQuote,
  uploadObject, signedUrl, storagePaths,
} from '../_lib/quotes/store.js';
import { renderQuotePdf, pngFromDataUrl } from '../_lib/quotes/render.js';
import { sendEmail } from '../_lib/email.js';
import { signRequestEmail } from '../_lib/quotes/emails.js';
import { requirePermission } from '../_lib/authz.js';
import { readOrgState } from '../_lib/orgState.js';
import { isDoNotContact } from '../../src/lib/contactConsent.js';
import { IDENTITY } from '../../src/brand/identity.generated.js';

// maxDuration: chromium cold-start + PDF render on admin-sign can exceed the
// default function timeout. bodyParser sizeLimit: signature PNGs — set to 4mb
// because Vercel caps request bodies at ~4.5MB at the PLATFORM layer (413 before
// the handler runs), so the previous '8mb' was unreachable configuration. Signature
// PNGs are tens of KB, so this is not a live constraint — but the honest number
// stops the next person raising it and expecting 8mb to work. If anything large
// ever needs to ride this route, use a signed direct-to-Storage upload instead
// (see api/account-media).
export const config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 60 };

// Attach short-lived signed URLs for the signature PNGs so the admin editor can
// render them inline as <img src> (the bucket is private — the raw stored *_path
// is not browser-loadable). 1h expiry comfortably covers an open editor session;
// a reload re-mints. Mirrors what the public route does for admin_signature_url.
async function withSigUrls(quote) {
  if (!quote) return quote;
  const [adminUrl, clientUrl] = await Promise.all([
    quote.admin_signature_path ? signedUrl(quote.admin_signature_path, 3600) : null,
    quote.client_signature_path ? signedUrl(quote.client_signature_path, 3600) : null,
  ]);
  return { ...quote, admin_signature_url: adminUrl, client_signature_url: clientUrl };
}

export default async function handler(req, res) {
  // Vercel doesn't match multi-segment catch-alls on this project, so vercel.json
  // rewrites multi-seg paths in via ?subpath=. Single-seg still hits the catch-all
  // directly (req.query.path). Handle both.
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
    : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [seg0, seg1] = path;

  try {
    // Every branch below is quote ADMINISTRATION. requireAuth alone proved only
    // "some authenticated user", so all 37 crew accounts could chain
    // create -> save{amount} -> admin-sign{signerName} -> send and email a
    // COUNTERSIGNED service agreement to a live customer from the verified
    // CleanSpace domain — while holding none of the quotes.* permissions. They
    // could also hard-delete an executed agreement (purging both signature PNGs
    // and the executed PDF, no soft-delete, no activity trail), rewrite the
    // amount on a quote already out for signature, and read every quote's
    // contact PII and pricing. None of that is reachable any other way: the
    // quotes table is RLS-on with no policies, so this route WAS the exposure.
    //
    // owner+admin matches the UI — quotes.view/create/send/delete all default
    // to owner+admin (roles.js). The customer-facing signing flow is a separate
    // handler (api/public/pay/[...path].js, token-authenticated) and is
    // untouched by this.
    // Per-action authorization (quotes.* — matches the UI). The server now honors
    // a per-user grant, not just role. `save` is part of the create/edit flow, so it
    // maps to quotes.create; admin-sign is part of the send flow → quotes.send. An
    // unrecognized action falls to quotes.view here and then 404s below.
    const quoteAction = (seg0 === 'create' || seg0 === 'list') ? seg0 : (seg1 || 'get');
    const QUOTE_PERM = {
      list: 'quotes.view', get: 'quotes.view', download: 'quotes.view',
      create: 'quotes.create', save: 'quotes.create',
      'admin-sign': 'quotes.send', send: 'quotes.send',
      void: 'quotes.delete', delete: 'quotes.delete',
    };
    const g = await requirePermission(req, res, QUOTE_PERM[quoteAction] || 'quotes.view');
    if (!g) return;
    const user = g.user;

    if (seg0 === 'create' && req.method === 'POST') {
      const b = req.body || {};
      if (!b.contact?.id) return res.status(400).json({ error: 'A contact is required' });
      const quote = await createFromTemplate({ contact: b.contact, templateKey: b.templateKey, createdBy: user.email || null });
      return res.status(200).json({ quote });
    }
    if (seg0 === 'list' && req.method === 'GET') {
      return res.status(200).json({ quotes: await listQuotes() });
    }

    // /:id and /:id/:action  (keywords above can't collide with UUID ids)
    const id = seg0;
    const action = seg1;
    if (!id) return res.status(404).json({ error: 'Unknown route' });

    if (!action && req.method === 'GET') {
      const quote = await getQuoteById(id);
      if (!quote) return res.status(404).json({ error: 'Quote not found' });
      return res.status(200).json({ quote: await withSigUrls(quote) });
    }
    if (action === 'save' && req.method === 'POST') {
      const quote = await saveFields(id, (req.body || {}).fields || {});
      return res.status(200).json({ quote });
    }
    if (action === 'admin-sign' && req.method === 'POST') {
      const { signerName, signatureDataUrl } = req.body || {};
      const png = pngFromDataUrl(signatureDataUrl);
      if (!png) return res.status(400).json({ error: 'A signature is required' });
      // Gate BEFORE the upload: the signature PNG lives at a fixed per-quote
      // path with upsert=true, and every sent/signed quote's admin_signature_path
      // points at exactly that object. Uploading first and letting the store's
      // freeze CAS reject the row afterwards would 409 the caller while having
      // already swapped the signature image under the executed document.
      const existingQuote = await getQuoteById(id);
      if (!existingQuote) return res.status(404).json({ error: 'Quote not found' });
      if (existingQuote.status !== 'draft') {
        return res.status(409).json({ error: `This quote is ${existingQuote.status} — its fields are locked. Void it and create a new quote to change terms.` });
      }
      const paths = storagePaths(id);
      await uploadObject(paths.adminSig, png, 'image/png');
      const quote = await recordAdminSignature(id, { signerName, signaturePath: paths.adminSig });
      // Render the admin-signed preview (client block blank) so both the admin
      // and (after send) the client can review the exact document.
      try {
        const previewBytes = await renderQuotePdf(quote, { adminSig: png });
        await uploadObject(paths.previewPdf, Buffer.from(previewBytes), 'application/pdf');
      } catch (e) { console.warn('[api/quotes] preview render failed:', e?.message || e); }
      return res.status(200).json({ quote: await withSigUrls(quote) });
    }
    if (action === 'send' && req.method === 'POST') {
      const existing = await getQuoteById(id);
      if (!existing) return res.status(404).json({ error: 'Quote not found' });
      if (!existing.admin_signed_at) return res.status(400).json({ error: 'Sign the quote before sending it.' });
      // Server-side Do-Not-Contact gate — the client already blocks, but a direct
      // API call must not slip a quote to a DNC contact. Best-effort: resolve the
      // recipient in org_state (by contact_id, email fallback) and 409 if flagged.
      // Fail-open on read errors so a transient blob outage can't wedge sending.
      try {
        // readOrgState() returns { state, version } — the contacts live on `state`,
        // NOT on the top-level object. Reading orgState.contacts made this always []
        // (recipient null → gate never fired → 100% of sends bypassed DNC).
        const { state } = await readOrgState();
        const contacts = (state && state.contacts) || [];
        const email = (existing.contact_email || '').trim().toLowerCase();
        const recipient = contacts.find((c) => c.id === existing.contact_id)
          || (email ? contacts.find((c) => (c.email || '').toLowerCase() === email) : null);
        if (isDoNotContact(recipient)) {
          return res.status(409).json({ error: 'This contact is marked Do Not Contact — quote not sent.' });
        }
      } catch (e) { console.warn('[api/quotes] DNC gate read failed, allowing send:', e?.message || e); }
      const quote = await markSent(id);
      const merged = { ...existing, ...quote };
      // Email the contact a link to review & sign — server-side via Resend so it
      // doesn't depend on the admin keeping a tab open. Best-effort: a delivery
      // failure does not fail the send (the link is also shown/copyable in-app).
      let emailed = false;
      try {
        const base = (process.env.APP_PUBLIC_URL || `https://${req.headers.host || ''}`).replace(/\/$/, '');
        const link = `${base}/quote/${merged.public_token}`;
        const msg = signRequestEmail({ quote: merged, link });
        const replyTo = process.env.QUOTE_REPLY_TO || IDENTITY.company.email;
        const r = await sendEmail({ to: merged.contact_email, subject: msg.subject, html: msg.html, replyTo });
        emailed = !!r.ok;
        if (!r.ok && !r.skipped) console.warn('[api/quotes] sign-request email not delivered:', r.status, r.error);
      } catch (e) { console.warn('[api/quotes] sign-request email failed:', e?.message || e); }
      return res.status(200).json({ quote: await withSigUrls(quote), emailed });
    }
    if (action === 'download' && req.method === 'GET') {
      const quote = await getQuoteById(id);
      if (quote?.signed_pdf_path) return res.status(200).json({ url: await signedUrl(quote.signed_pdf_path, 600) });
      if (quote?.admin_signed_at) return res.status(200).json({ url: await signedUrl(storagePaths(id).previewPdf, 600) });
      return res.status(404).json({ error: 'No document to download yet' });
    }
    if (action === 'void' && req.method === 'POST') {
      return res.status(200).json({ quote: await withSigUrls(await voidQuote(id)) });
    }
    if (action === 'delete' && req.method === 'POST') {
      await deleteQuote(id);
      return res.status(200).json({ ok: true });
    }

    res.status(404).json({ error: 'Unknown route' });
  } catch (err) {
    // Freeze law (store.js requireDraft): a locked quote is a client-state
    // conflict, not a server failure — 409 with the human-readable reason.
    if (err?.code === 'QUOTE_FROZEN') return res.status(409).json({ error: err.message });
    console.error('[api/quotes]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
