// PUBLIC unsubscribe route (no auth — token-scoped). Single-segment path, so it
// resolves directly without a vercel.json rewrite.
//   GET  /api/unsubscribe?t=<token>  → suppress + branded HTML confirmation
//   POST /api/unsubscribe?t=<token>  → one-click (RFC 8058 List-Unsubscribe-Post)
//                                      → suppress + 200 JSON
// The token is HMAC-signed (api/_lib/marketing/compliance.js); the resolved
// email is appended to org_state.marketingSuppressions, which the send +
// enrollment walks honor as a hard gate.

import { verifyUnsubscribeToken } from './_lib/marketing/compliance.js';
import { readOrgState, writeOrgState } from './_lib/orgState.js';
import { DOC } from '../src/brand/doc.js';

// Append the email to the suppression list with an optimistic CAS retry loop
// (another writer may bump the version under us). Idempotent: a second
// unsubscribe of the same email is a no-op success.
async function suppressEmail(email, source) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { state, version } = await readOrgState();
    const list = Array.isArray(state.marketingSuppressions) ? state.marketingSuppressions : [];
    if (list.some((s) => (s.email || '').toLowerCase() === e)) return true; // already suppressed
    const next = {
      ...state,
      marketingSuppressions: [
        ...list,
        { email: e, source: source || 'unsubscribe', reason: null, createdAt: new Date().toISOString() },
      ],
    };
    const ok = await writeOrgState(next, version);
    if (ok) return true;
    // Version moved under us — re-read and retry.
  }
  return false;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;`
    + `max-width:480px;margin:64px auto;padding:0 24px;color:${DOC.brand};text-align:center">`
    + `<h1 style="font-size:20px;margin-bottom:12px">${escapeHtml(title)}</h1>`
    + `<p style="color:${DOC.pen};line-height:1.6;font-size:15px">${message}</p></body></html>`;
}

export default async function handler(req, res) {
  const token = (req.query && req.query.t) || '';
  const email = verifyUnsubscribeToken(token);

  if (!email) {
    if (req.method === 'POST') { res.status(400).json({ ok: false, error: 'Invalid token' }); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(400).send(page('Invalid link',
      'This unsubscribe link is invalid or has expired. Please reply to any of our emails with “unsubscribe” and we’ll remove you.'));
    return;
  }

  let ok = false;
  try {
    ok = await suppressEmail(email, req.method === 'POST' ? 'one-click' : 'unsubscribe');
  } catch (err) {
    console.error('[api/unsubscribe] suppress failed:', err?.message || err);
  }

  // One-click (mail client POST): machine response only.
  if (req.method === 'POST') { res.status(ok ? 200 : 500).json({ ok }); return; }

  // Human click: branded confirmation page.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (ok) {
    res.status(200).send(page('You’re unsubscribed',
      `<strong>${escapeHtml(email)}</strong> has been removed from our marketing emails. `
      + 'You won’t receive further sequence emails from us. You may still receive transactional messages '
      + '(like booking confirmations or invoices) related to active service.'));
  } else {
    res.status(500).send(page('Something went wrong',
      'We couldn’t process your request right now. Please try again shortly, or reply to any of our emails with “unsubscribe”.'));
  }
}
