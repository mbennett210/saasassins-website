// CAN-SPAM / bulk-sender compliance for marketing sequence email.
//
// Lives server-side because the unsubscribe link is HMAC-signed and the signing
// secret must never ship to the browser. performSend() (api/_lib/sender.js)
// calls buildUnsubscribeCompliance() for marketing sends to append the footer
// (unsubscribe link + physical postal address) and the List-Unsubscribe /
// List-Unsubscribe-Post headers (RFC 8058 one-click). /api/unsubscribe.js
// verifies the token and writes the email into the org_state suppression list.

import crypto from 'node:crypto';
import { DOC } from '../../../src/brand/doc.js';

// Signing secret: a dedicated UNSUBSCRIBE_SECRET if set, else reuse the existing
// server-only token-encryption key. Either way the secret stays on the backend.
function secret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.INBOX_TOKEN_ENCRYPTION_KEY || '';
}

// Public origin for the absolute unsubscribe URL. A per-tenant override (set in
// Marketing Settings) wins so the link domain stays correct across a production
// domain change; otherwise INBOX_INBOUND_BASE_URL (already set for the OAuth
// redirect), then Vercel's injected prod URL.
function resolveBaseUrl(override) {
  const b = (override && String(override).trim())
    || process.env.INBOX_INBOUND_BASE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return (b || '').replace(/\/+$/, '');
}

// token = base64url(email) + '.' + HMAC-SHA256(base64url(email)). Tamper-proof
// (an attacker can't forge a valid token for an arbitrary email) and stateless.
export function unsubscribeToken(email) {
  const e = String(email || '').trim().toLowerCase();
  const payload = Buffer.from(e, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns the verified lowercased email, or null if the token is malformed,
// unsigned, or tampered with.
export function verifyUnsubscribeToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null; // length mismatch (forged sig) → not equal
  }
  try {
    return Buffer.from(payload, 'base64url').toString('utf8').trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(email, baseOverride) {
  const b = resolveBaseUrl(baseOverride);
  return b ? `${b}/api/unsubscribe?t=${unsubscribeToken(email)}` : '';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the compliant footer + List-Unsubscribe header for one recipient from
// the tenant's (customizable) config. Footer mode matches the body (HTML <a>
// vs. plaintext URL). List-Unsubscribe carries both the https one-click URL
// (Gmail/Yahoo bulk rules) and a mailto to the sending inbox — the inbound reply
// pipeline auto-detects the "unsubscribe" word and suppresses, so opt-out keeps
// working even if the URL's domain ever changes.
//
// config: { message, linkText, includeAddress, address, baseUrl } — all optional.
// `{unsubscribe}` in message is replaced by the link (appended if absent);
// `{company}` is replaced by the company name.
export function buildUnsubscribeCompliance({ recipient, isHtml, config = {}, companyName, inboxEmail }) {
  const url = unsubscribeUrl(recipient, config.baseUrl);
  const linkText = String(config.linkText || '').trim() || 'Unsubscribe';
  const message = (config.message != null && String(config.message).trim())
    ? String(config.message)
    : 'Not interested? {unsubscribe} from these emails.';
  const includeAddress = config.includeAddress !== false;
  const co = String(companyName || '').trim();
  const addr = includeAddress ? String(config.address || '').trim() : '';
  const identity = includeAddress ? [co, addr].filter(Boolean).join(' · ') : '';

  let line;
  if (isHtml) {
    const link = url ? `<a href="${esc(url)}">${esc(linkText)}</a>` : esc(linkText);
    line = esc(message);
    line = line.includes('{unsubscribe}') ? line.split('{unsubscribe}').join(link) : `${line} ${link}`;
    line = line.split('{company}').join(esc(co));
  } else {
    const link = url ? `${linkText}: ${url}` : linkText;
    line = message;
    line = line.includes('{unsubscribe}') ? line.split('{unsubscribe}').join(link) : `${line} ${link}`;
    line = line.split('{company}').join(co);
  }

  let footer;
  if (isHtml) {
    const parts = [line];
    if (identity) parts.push(esc(identity));
    footer = `<br><br><hr style="border:none;border-top:1px solid ${DOC.divider};margin:16px 0">`
      + `<div style="font-size:12px;color:${DOC.muted};line-height:1.5">${parts.join('<br>')}</div>`;
  } else {
    const parts = [line];
    if (identity) parts.push(identity);
    footer = `\n\n—\n${parts.join('\n')}`;
  }

  const items = [];
  if (url) items.push(`<${url}>`);
  if (inboxEmail) items.push(`<mailto:${inboxEmail}?subject=unsubscribe>`);
  const listUnsubscribe = items.length ? items.join(', ') : '';

  return { footer, listUnsubscribe, hasUnsubscribe: Boolean(url) };
}
