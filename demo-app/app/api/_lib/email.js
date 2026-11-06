// Shared server-side transactional email — THROUGH GOOGLE, over the Gmail API, as the
// connected mailbox marked as the SYSTEM SENDER (api/_lib/systemSender.js).
//
// Daniel, 2026-09-29: "Clean Space sends email through Google, NOT Resend." Resend is gone
// from this build — no key, no verified sending domain, no provider account. The same
// Google OAuth client that connects Messaging mailboxes connects the sending one, and the
// owner marks one of them in Settings → Integrations. (CS-012, CS-039; the CS-280 claim
// that billing.cleanspaceonline.com was Resend-verified is deleted with the rest — it was
// never true: no DKIM/SPF records for it exist in public DNS, G7 `dig`, V 2026-09-25.)
//
// No sender configured → every send is SKIPPED, loudly, and the action that triggered it
// still succeeds: signing a quote must not fail because the office hasn't connected a
// mailbox. Settings shows "Email isn't set up". Same shape as the old no-key behaviour.
//
// ENV (names only — values live in Vercel):
//   SYSTEM_SENDER_EMAIL   optional PIN: the address that must be the sender; the UI then
//                         cannot change it. Unset = the owner's choice in Settings.
//   QUOTE_REPLY_TO        optional Reply-To for quote mail (callers pass it)
//   GOOGLE_OAUTH_CLIENT_ID / _SECRET, INBOX_TOKEN_ENCRYPTION_KEY — the OAuth + token-at-rest
//                         keys the connected mailbox already needs (api/_lib/google.js,
//                         api/_lib/crypto.js). This module adds no secret of its own.
//
// 🔴 GMAIL DECIDES THE From, NOT THE CALLER. A Gmail send always leaves as the
// authenticated mailbox, so a caller-supplied `from` is a REQUEST for a Reply-To and
// nothing more (resolveFromAndReplyTo). That closes by construction the hole the Resend
// path had to police by hand: both /api/email/send and the reminder cron derive their
// requested From from `state.company` — the browser-writable blob — so a From taken on
// trust let any login send DKIM-signed mail as any address on the company domain
// (AUTHORIZATION_AUDIT §2026-07-20 #3). There is no allowlist to widen or get wrong now:
// the set of addresses this server can send as is exactly {the system sender}.

import { IDENTITY } from '../../src/brand/identity.generated.js';
import { getSystemSenderAccount, systemSenderStatus } from './systemSender.js';
import { getFreshAccessToken, recordSentMessage } from './accounts.js';
import { buildMime, gmailSend } from './google.js';
import crypto from 'node:crypto';

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 🔴 THE RECIPIENT CAP (CS-015). /api/email/send accepted an arbitrary `to` (an array
// passed the old regex after String()) plus unbounded cc/bcc, so one call could address
// thousands. The cap is exported so the route, sendTransactional and the regression suite
// all read ONE number instead of three restatements of it.
export const MAX_RECIPIENTS = 20;

// What every caller shows and logs when no mailbox is marked as the sender.
export const NOT_SET_UP = "Email isn't set up: no Google mailbox is marked as the sender.";

// Same hint idiom as _lib/sender.js — a body containing structural markup is sent as
// html, anything else as text (so reminder/invite bodies keep their newlines).
const HTML_HINT = /<(?:p|br|div|a|span|table|h[1-6]|ul|ol|li|strong|em|b|i)\b/i;

// Header values must be single-line: CR/LF would let a caller inject extra MIME headers.
// buildMime sanitizes every header it writes as well (CS-075); this is the caller-side half.
function stripCrlf(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

// Bare address out of "Name <addr@host>" or "addr@host".
export function addressOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

// The From line the app sends under: the system sender's address, with the mailbox's own
// display name when it has been customised, else the brand's name (IDENTITY, never a
// literal — UI_RULES §129). '' when no sender is configured.
export async function defaultFrom() {
  const account = await getSystemSenderAccount();
  return account ? fromLineFor(account) : '';
}

function fromLineFor(account) {
  const email = account.email;
  const custom = account.display_name && account.display_name !== email ? account.display_name : '';
  const name = stripCrlf(custom || IDENTITY.name).replace(/"/g, '\\"');
  return name ? `"${name}" <${email}>` : email;
}

// Could a send leave right now: a system sender is marked and its mailbox is active? For a
// caller that should not do something irreversible when email is off — the member page's reset
// makes a new link (voiding the last one) only when it can be emailed or handed to the caller
// (api/settings, CS-661). Never throws: a lookup fault reads as "can't send", like the send.
export async function systemSenderReady() {
  const account = await getSystemSenderAccount();
  return !!account && (!account.status || account.status === 'active');
}

// The domain the app's mail leaves from — the system sender's own domain. Under Google,
// DKIM/SPF are the Workspace's, so there is no separate "verified domain" to configure and
// nothing for an env var to override. '' when no sender is configured.
export async function verifiedDomain() {
  return addressOf(await defaultFrom()).split('@')[1] || '';
}

// The exact From addresses this server can send as. Under Gmail that is one address — the
// authenticated mailbox — so the set has at most one member and no env can widen it.
export async function allowedFromAddresses() {
  const account = await getSystemSenderAccount();
  return new Set(account ? [String(account.email).toLowerCase()] : []);
}

// A requested From is honoured only when it IS the system sender; otherwise the send goes
// out as the sender and the requested address is preserved as Reply-To, so replies still
// reach the mailbox the caller intended. Placeholder addresses (the client adapters'
// no-reply@example.com fallback) never become a Reply-To.
// Async because the sender is a lookup, not an env string. Callers: api/email/send.js,
// api/reminders/run.js.
export async function resolveFromAndReplyTo({ from, replyTo } = {}) {
  const sender = await defaultFrom();
  const requested = addressOf(from);
  if (sender && requested && requested === addressOf(sender)) {
    return { from: sender, replyTo: replyTo ? stripCrlf(replyTo) : null, rewritten: false };
  }
  const usable = requested && /.+@.+\..+/.test(requested) && !requested.endsWith('@example.com');
  return {
    from: sender,
    replyTo: stripCrlf(replyTo || (usable ? requested : '')) || null,
    rewritten: true,
  };
}

// ── the one send primitive ───────────────────────────────────────────────────────────
//
// Both public senders funnel here. Never throws: a caller's action (a recorded signature,
// a created login) must not fail because delivery did.
//   { ok: true, id }                        sent
//   { ok: false, skipped: true, error }     no sender configured / nothing to send to
//   { ok: false, error, status? }           Gmail rejected it
async function sendViaSystemSender({ to, cc, bcc, subject, body, isHtml, replyTo, headers, attachments }) {
  const account = await getSystemSenderAccount();
  if (!account) {
    const why = (await systemSenderStatus()).reason;
    console.warn(`[email] no system sender configured (${why}) — email skipped. Connect a Google mailbox in Settings → Integrations.`);
    return { ok: false, skipped: true, error: NOT_SET_UP };
  }
  if (account.status && account.status !== 'active') {
    console.warn(`[email] the sending mailbox ${account.email} is ${account.status} — email skipped`);
    return { ok: false, skipped: true, error: 'The sending mailbox needs to be reconnected.' };
  }
  const recipients = list(to);
  if (!recipients.length) {
    console.warn('[email] no recipient — email skipped');
    return { ok: false, skipped: true, error: 'No recipient' };
  }
  const ccList = list(cc);
  const bccList = list(bcc);
  const total = recipients.length + ccList.length + bccList.length;
  if (total > MAX_RECIPIENTS) {
    return { ok: false, error: `Too many recipients (${total}); the limit is ${MAX_RECIPIENTS}.` };
  }

  const domain = String(account.email).split('@')[1] || 'mail.local';
  const messageId = `<cleanspace-${crypto.randomBytes(12).toString('hex')}@${domain}>`;
  // The threading headers are buildMime's OWN fields, not extraHeaders — it drops a key that
  // restates a header it writes itself (CS-075), so a caller's In-Reply-To has to be lifted
  // out here or it is silently discarded. Same split _lib/sender.js does for Messaging.
  let inReplyTo = null;
  let references = null;
  const extraHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = String(k).toLowerCase();
    if (lower === 'in-reply-to') inReplyTo = v;
    else if (lower === 'references') references = v;
    else extraHeaders[k] = v;
  }
  let raw;
  try {
    raw = buildMime({
      from: fromLineFor(account),
      to: recipients.join(', '),
      cc: ccList.length ? ccList.join(', ') : null,
      bcc: bccList.length ? bccList.join(', ') : null,
      subject: stripCrlf(subject),
      body,
      isHtml,
      replyTo: replyTo ? stripCrlf(replyTo) : null,
      inReplyTo,
      references,
      messageId,
      extraHeaders,
      attachments: normaliseAttachments(attachments),
    });
  } catch (e) {
    console.error('[email] could not build the message:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }

  let token;
  try {
    token = await getFreshAccessToken(account);
  } catch (e) {
    // A revoked refresh token flips the row to 'expired' inside getFreshAccessToken; the
    // Settings card then shows "reconnect". Never log the token or the error body verbatim
    // beyond its message (THE LAW II.9).
    console.error('[email] could not refresh the sending mailbox token:', e?.message || e);
    return { ok: false, error: 'The sending mailbox needs to be reconnected.' };
  }
  try {
    const sent = await gmailSend(token, raw);
    // Best-effort: lets an inbound reply to app mail be recognised by the poll, exactly as
    // a Messaging send is. Never fails the send that already left.
    try { await recordSentMessage(account.id, messageId); } catch { /* logging only */ }
    return { ok: true, id: sent?.id || null };
  } catch (e) {
    const msg = String(e?.message || e);
    console.error('[email] gmail send failed:', msg);
    return { ok: false, error: msg };
  }
}

function list(v) {
  return (Array.isArray(v) ? v : [v])
    .map((x) => stripCrlf(x))
    .filter(Boolean);
}

// Quote mail passes Resend's attachment shape ({ filename, content } with content already
// base64). buildMime wants { name, mimeType, content }. Map it here so no caller changes.
const EXT_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', txt: 'text/plain' };
function normaliseAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((a) => a && a.content).map((a) => {
    const name = a.name || a.filename || 'attachment';
    const ext = String(name).split('.').pop().toLowerCase();
    return {
      name,
      mimeType: a.mimeType || EXT_TYPES[ext] || 'application/octet-stream',
      content: a.content,
      inline: a.inline,
      contentId: a.contentId,
    };
  });
}

// Fire-and-forget convenience for quote / invite / signed-copy mail. `html` is HTML,
// `attachments` is [{ filename, content (base64) }]. Signature unchanged from the Resend
// version so quotes/[...path].js, public/pay, and _lib/users.js are untouched.
export async function sendEmail({ to, subject, html, from, replyTo, attachments }) {
  const resolved = await resolveFromAndReplyTo({ from, replyTo });
  return sendViaSystemSender({
    to,
    subject,
    body: html,
    isHtml: true,
    replyTo: resolved.replyTo,
    attachments,
  });
}

// Full-featured send for /api/email/send and the reminder cron: returns the provider
// message id and a structured error so the caller can surface real delivery state (the
// Integrations test card, the reminderFailed manager alert). `from` is accepted and
// ignored for the envelope — Gmail sends as the mailbox — and folded into the Reply-To by
// resolveFromAndReplyTo, which is idempotent: a caller that already resolved (both of them
// do) passes the same pair back in and gets it unchanged.
// `tags` has no Gmail equivalent; they ride as one X-CleanSpace-Tags header rather than
// being silently dropped.
export async function sendTransactional({ to, from, subject, body, replyTo, cc, bcc, headers, tags, attachments }) {
  const resolved = await resolveFromAndReplyTo({ from, replyTo });
  const safeHeaders = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      const name = stripCrlf(k);
      const value = stripCrlf(v);
      if (name && value) safeHeaders[name] = value;
    }
  }
  if (Array.isArray(tags) && tags.length) {
    const clean = tags.map((t) => String(t).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200)).filter(Boolean);
    if (clean.length) safeHeaders['X-CleanSpace-Tags'] = clean.join(' ').slice(0, 500);
  }
  return sendViaSystemSender({
    to,
    cc,
    bcc,
    subject,
    body,
    isHtml: HTML_HINT.test(body || ''),
    replyTo: resolved.replyTo,
    headers: safeHeaders,
    // [{ filename, content (base64) }] — the monthly statement's PDF (api/reminders/run.js).
    attachments,
  });
}
