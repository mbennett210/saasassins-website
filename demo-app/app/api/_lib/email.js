// Shared server-side transactional email via Resend (the RESEND_API_KEY your
// partner configured).
// No-ops gracefully when the key is unset so a delivery hiccup never fails the
// underlying action (signing a quote, sending it, etc.).
//
// Env:
//   RESEND_API_KEY      — Resend key (set in Vercel + .env.local)
//   RESEND_DEFAULT_FROM — the verified From, e.g. "Name <quotes@billing.example.com>" (on a domain verified
//                         in the deployment's Resend account); unset, the brand's IDENTITY.email.quotesFrom
//   QUOTE_REPLY_TO      — optional reply-to (defaults to the brand's IDENTITY.company.email)

import { IDENTITY } from '../../src/brand/identity.generated.js';
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function defaultFrom() {
  // Fallback MUST be on a Resend-verified domain or sends 403: the brand's quotes sender, whose
  // domain the deployment's Resend account verifies (REBRAND.md §5); override with
  // RESEND_DEFAULT_FROM in Vercel for a different From.
  return (
    process.env.RESEND_DEFAULT_FROM ||
    IDENTITY.email.quotesFrom
  );
}

// to: string | string[]. attachments: [{ filename, content (base64 string) }].
// Returns { ok } on success, { ok:false, skipped } when no key/recipient,
// { ok:false, status, error } on a Resend rejection. Never throws.
export async function sendEmail({ to, subject, html, from, replyTo, attachments }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[email] RESEND_API_KEY not set — email skipped');
    return { ok: false, skipped: true };
  }
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) {
    console.warn('[email] no recipient — email skipped');
    return { ok: false, skipped: true };
  }

  const payload = { from: from || defaultFrom(), to: recipients, subject, html };
  if (replyTo) payload.reply_to = replyTo;
  if (attachments && attachments.length) payload.attachments = attachments;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[email] resend send failed', resp.status, txt);
      return { ok: false, status: resp.status, error: txt };
    }
    return { ok: true };
  } catch (e) {
    console.error('[email] resend threw', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ─── /api/email/send support (NOTIF-01) ─────────────────────────────────────

// Same hint idiom as _lib/sender.js — a body containing structural markup is
// sent as html, anything else as text (so reminder/invite bodies keep their
// newlines instead of collapsing).
const HTML_HINT = /<(?:p|br|div|a|span|table|h[1-6]|ul|ol|li|strong|em|b|i)\b/i;

// Header values must be single-line — CR/LF would let a caller inject extra
// MIME headers.
function stripCrlf(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

// Bare address out of "Name <addr@host>" or "addr@host".
export function addressOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

export function verifiedDomain() {
  const env = (process.env.RESEND_VERIFIED_DOMAIN || '').trim().toLowerCase();
  if (env) return env;
  return addressOf(defaultFrom()).split('@')[1] || '';
}

// The exact From addresses a caller may send AS. Service-controlled: the env
// default plus anything explicitly listed in RESEND_ALLOWED_FROM (comma-separated).
//
// It is an ADDRESS allowlist, deliberately not a domain one — see
// resolveFromAndReplyTo. Unset RESEND_ALLOWED_FROM means "only the default From",
// which is the safe posture for a fresh clone.
export function allowedFromAddresses() {
  const raw = (process.env.RESEND_ALLOWED_FROM || '').trim();
  const extra = raw ? raw.split(',').map((s) => addressOf(s)).filter(Boolean) : [];
  return new Set([addressOf(defaultFrom()), ...extra].filter(Boolean));
}

// From-allowlist. A From outside the allowlist is rewritten to the verified
// default and the requested address is preserved as Reply-To — replies still
// reach the mailbox the caller intended and the send never 403s at Resend.
// Placeholder addresses (the client adapters' no-reply@example.com stub
// fallback) never become a Reply-To.
//
// 🔒 WHY THIS IS AN ADDRESS ALLOWLIST, NOT A DOMAIN ONE
// (AUTHORIZATION_AUDIT.md §2026-07-20 OPEN #3.)
//
// This used to pass through ANY From ending in `@<verifiedDomain>` unmodified.
// Both callers derive their requested From from `state.company` — the
// browser-writable org_state blob — and /api/email/send only asks for a team member
// (requireAuthority; a bare session check until 2026-09-23), so `messaging`-capable
// crew reach it. Either way an attacker chose the From:
// any authenticated user could send DKIM-signed, SPF-passing mail as
// `steve@<verifiedDomain>` from the company's real domain. Domain verification
// proves the DOMAIN is ours; it says nothing about WHICH mailbox on it the
// caller may impersonate, so it was never an authorization check.
//
// Widening is an env change (service-controlled), never a blob edit. Adding a
// domain-wide rule here would reopen the hole exactly as it was.
export function resolveFromAndReplyTo({ from, replyTo }) {
  const requested = addressOf(from);
  if (requested && allowedFromAddresses().has(requested)) {
    // stripCrlf: `from` reaches the Resend payload unsanitised (only `subject`
    // was stripped), so a display name carrying CR/LF could inject MIME headers.
    return { from: stripCrlf(from), replyTo: replyTo || null, rewritten: false };
  }
  const usable = requested && /.+@.+\..+/.test(requested) && !requested.endsWith('@example.com');
  return { from: defaultFrom(), replyTo: replyTo || (usable ? requested : null), rewritten: true };
}

// Full-featured transactional send for the /api/email/send route. Unlike
// sendEmail() above (fire-and-forget convenience for quote/form mail), this
// returns the Resend message id and a structured error so the caller can
// surface real delivery state — the Integrations test card, and the
// reminderFailed manager alert when a reminder send fails. Caller is
// responsible for From allowlisting (resolveFromAndReplyTo above).
export async function sendTransactional({ to, from, subject, body, replyTo, cc, bcc, headers, tags }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[email] RESEND_API_KEY not set — transactional send skipped');
    return { ok: false, skipped: true, error: 'Email provider not configured (RESEND_API_KEY missing)' };
  }
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { ok: false, error: 'No recipient' };

  const payload = { from, to: recipients, subject: stripCrlf(subject) };
  if (HTML_HINT.test(body || '')) payload.html = body;
  else payload.text = body;
  if (replyTo) payload.reply_to = replyTo;
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
  if (headers && typeof headers === 'object') {
    const safe = {};
    for (const [k, v] of Object.entries(headers)) {
      const name = stripCrlf(k);
      const value = stripCrlf(v);
      if (name && value) safe[name] = value;
    }
    if (Object.keys(safe).length) payload.headers = safe;
  }
  if (Array.isArray(tags) && tags.length) {
    // Resend tag names allow only [a-zA-Z0-9_-]; the client sends plain strings.
    payload.tags = tags
      .map((t) => String(t).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200))
      .filter(Boolean)
      .map((name) => ({ name, value: '1' }));
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = json?.message || `Resend rejected the send (${resp.status})`;
      console.error('[email] resend transactional send failed', resp.status, msg);
      return { ok: false, status: resp.status, error: msg };
    }
    return { ok: true, id: json?.id || null };
  } catch (e) {
    console.error('[email] resend transactional send threw', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
