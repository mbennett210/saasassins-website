// PUBLIC e-signature routes (no auth — token-scoped). Reshaped from the old
// Stripe pay flow; the file path is kept so the serverless function count stays
// at 12. Routes:
//   GET  /api/public/pay/:token        → public-safe document view (fields +
//                                         admin signature URL + status)
//   POST /api/public/pay/:token/sign   → client signs → render final PDF →
//                                         store → status 'signed'
import {
  getQuoteByToken, recordClientSignature, notifyManagersOfSignedQuote,
  uploadObject, downloadObject, signedUrl, storagePaths,
} from '../../_lib/quotes/store.js';
import { renderQuotePdf, pngFromDataUrl } from '../../_lib/quotes/render.js';
import { sendEmail } from '../../_lib/email.js';
import { signedCopyEmail } from '../../_lib/quotes/emails.js';
import { IDENTITY } from '../../../src/brand/identity.generated.js';

// maxDuration: chromium cold-start + final PDF render on client sign can exceed
// the default function timeout. bodyParser sizeLimit: signature PNG — set to 4mb
// because Vercel caps request bodies at ~4.5MB at the PLATFORM layer (413 before
// the handler runs), so the previous '8mb' was unreachable configuration. Signature
// PNGs are tens of KB, so this is not a live constraint — the honest number just
// stops it being read as headroom that exists. Anything large belongs on a signed
// direct-to-Storage upload (see api/account-media's signed upload-url).
export const config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 60 };

export default async function handler(req, res) {
  // Vercel doesn't match multi-segment catch-alls on this project, so vercel.json
  // rewrites multi-seg paths in via ?subpath=. Single-seg still hits the catch-all
  // directly (req.query.path). Fall back to parsing the raw URL.
  let path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
    : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  if (path.length === 0 && req.url) {
    const m = req.url.split('?')[0].match(/\/api\/public\/pay\/(.+)$/);
    if (m && m[1] !== '_') path = m[1].split('/').filter(Boolean);
  }
  const [token, action] = path;

  try {
    if (!token) return res.status(400).json({ error: 'Bad path' });
    const quote = await getQuoteByToken(token);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    // ── public-safe document view ─────────────────────────────────────────
    if (!action && req.method === 'GET') {
      return res.status(200).json({
        quote: {
          token: quote.public_token,
          status: quote.status,
          template_key: quote.template_key,
          fields: quote.fields || {},
          contact_name: quote.contact_name,
          admin_signer_name: quote.admin_signer_name,
          admin_signed: !!quote.admin_signed_at,
          admin_signed_at: quote.admin_signed_at,
          // Signed URLs to the signature PNGs so the live review document can show
          // that CleanSpace already signed (and, on a re-opened signed doc, the
          // client's own signature). The builder uses these as <img src>.
          admin_signature_url: quote.admin_signature_path ? await signedUrl(quote.admin_signature_path, 900) : null,
          client_signature_url: quote.client_signature_path ? await signedUrl(quote.client_signature_path, 900) : null,
          client_signer_name: quote.client_signer_name,
          // The document to review: the final signed PDF if signed, else the
          // admin-signed preview (client block blank).
          document_url:
            quote.status === 'signed' && quote.signed_pdf_path
              ? await signedUrl(quote.signed_pdf_path, 900)
              : (quote.admin_signed_at ? await signedUrl(storagePaths(quote.id, quote.doc_version || 1).previewPdf, 900) : null),
          client_signed_at: quote.client_signed_at,
        },
      });
    }

    // ── client signs → finalize ───────────────────────────────────────────
    if (action === 'sign' && req.method === 'POST') {
      if (quote.status === 'signed') return res.status(400).json({ error: 'This document has already been signed.' });
      if (quote.status === 'void') return res.status(400).json({ error: 'This document was voided.' });
      if (quote.status !== 'sent') return res.status(400).json({ error: 'This document is not ready for signing.' });

      const body = req.body || {};
      const clientPng = pngFromDataUrl(body.signatureDataUrl);
      if (!clientPng) return res.status(400).json({ error: 'A signature is required.' });
      const signerName = (body.signerName || '').trim();
      if (!signerName) return res.status(400).json({ error: 'Please type your name.' });

      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
      const paths = storagePaths(quote.id, quote.doc_version || 1);

      await uploadObject(paths.clientSig, clientPng, 'image/png');

      // Compose the final PDF with BOTH signatures (admin sig fetched from store).
      let adminPng = null;
      if (quote.admin_signature_path) {
        try { adminPng = await downloadObject(quote.admin_signature_path); } catch { /* admin sig missing — render client-only */ }
      }
      const renderQuote = { ...quote, client_signed_at: new Date().toISOString() };
      const pdfBytes = await renderQuotePdf(renderQuote, { adminSig: adminPng, clientSig: clientPng, clientPrintedName: signerName });
      await uploadObject(paths.signedPdf, Buffer.from(pdfBytes), 'application/pdf');

      const updated = await recordClientSignature(quote.id, {
        signerName,
        signerEmail: body.signerEmail || quote.contact_email || null,
        signerIp: ip,
        signaturePath: paths.clientSig,
        signedPdfPath: paths.signedPdf,
      });

      // Ping the office in-app (bell + push) — the rep who sent it wants to know a
      // deal closed. Best-effort; never fails the recorded signature.
      await notifyManagersOfSignedQuote(updated);

      // Email the signed copy (PDF attached) to the client + an internal copy to
      // CleanSpace — server-side via Resend so it doesn't need an open admin tab.
      // Best-effort: never fails the signature that was just recorded.
      try {
        const attachments = [{
          filename: `${IDENTITY.slug}-service-agreement-signed.pdf`,
          content: Buffer.from(pdfBytes).toString('base64'),
        }];
        const clientTo = updated.client_signer_email || updated.contact_email || body.signerEmail || null;
        if (clientTo) {
          const m = signedCopyEmail({ quote: updated, toClient: true });
          const replyTo = process.env.QUOTE_REPLY_TO || IDENTITY.company.email;
          await sendEmail({ to: clientTo, subject: m.subject, html: m.html, attachments, replyTo });
        }
        const internalTo = process.env.QUOTE_NOTIFY_EMAIL || process.env.FORMS_NOTIFY_EMAIL || IDENTITY.company.email;
        const mi = signedCopyEmail({ quote: updated, toClient: false });
        await sendEmail({ to: internalTo, subject: mi.subject, html: mi.html, attachments });
      } catch (e) { console.warn('[api/public/pay] signed-copy email failed:', e?.message || e); }

      return res.status(200).json({ ok: true, status: updated.status });
    }

    res.status(404).json({ error: 'Unknown route' });
  } catch (err) {
    // Freeze CAS (store.js): the quote's status moved while this request ran —
    // most likely an admin voided it during the multi-second PDF render. The
    // signature was NOT recorded; tell the signer plainly rather than 500ing.
    if (err?.code === 'QUOTE_FROZEN') {
      return res.status(409).json({ error: 'This document is no longer available for signing — please contact the office.' });
    }
    console.error('[api/public/pay]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
