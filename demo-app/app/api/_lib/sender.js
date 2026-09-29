// Orchestrates an outbound send through a connected Gmail account:
// fresh token → MIME → Gmail send → record the Message-ID so a later reply
// can be recognized by the inbound poll. Shared by the send + test routes.

import crypto from 'node:crypto';
import { buildMime, gmailSend, gmailGetMessage } from './google.js';
import { getAccount, getFreshAccessToken, recordSentMessage } from './accounts.js';
import { buildUnsubscribeCompliance } from './marketing/compliance.js';
import { resolveOutboundAttachments } from './marketing/attachments.js';

// Cheap heuristic: treat the body as HTML if it carries common block/inline tags.
const HTML_HINT = /<(?:p|br|div|a|span|table|h[1-6]|ul|ol|li|strong|em|b|i)\b/i;

// Defensive total-attachment cap. The frontend caps before sending, but enforce
// it here too so an oversized payload fails with a clear error instead of
// bouncing off Gmail's whole-message limit. Matches ATTACHMENT_TOTAL_MAX_BYTES.
const TOTAL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// RFC 5322 From-line builder. Caller-provided `fromName` wins (lets the
// frontend's per-inbox profile pick the display name), then the stored
// account.displayName when it's been customised (not just the email fallback),
// and finally the bare address. Always quotes + strips CR/LF to prevent header
// injection from user-controlled name input.
function formatFrom({ name, email }) {
  const raw = (name || '').toString().trim();
  if (!raw) return email;
  const safe = raw.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"');
  return `"${safe}" <${email}>`;
}

export async function performSend(accountId, { to, subject, body, replyTo, cc, bcc, headers, attachments: rawAttachments, fromName, senderCompanyName, unsubscribe, orgUserId } = {}) {
  const account = await getAccount(accountId);
  if (!account) throw new Error('Connected inbox not found — it may have been disconnected.');

  // Attachments now arrive as small Storage references ({ storageKey }) rather than
  // inline base64, because a base64 body could never clear Vercel's ~4.5MB request
  // cap. Download them here into the { name, mimeType, content } shape the MIME
  // builder expects. Legacy inline `content` from a pre-fix tab passes through.
  //
  // `orgUserId` must come from the ROUTE'S VERIFIED CLAIM, never from the request body:
  // it is what a `signatureRef` part is resolved against, so a body-supplied value
  // would let a caller mail out another user's signature object. The marketing cron
  // passes none, which is correct — marketing bodies carry no user signature.
  const attachments = await resolveOutboundAttachments(rawAttachments, { orgUserId });

  // Reject oversized payloads up front (base64 → ~3/4 decoded bytes) before we
  // spend a token refresh + Gmail round-trip on a send that can't succeed.
  const totalAttachmentBytes = (Array.isArray(attachments) ? attachments : [])
    .reduce((sum, a) => sum + (a && a.content ? Buffer.byteLength(a.content, 'base64') : 0), 0);
  if (totalAttachmentBytes > TOTAL_ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachments exceed the 25 MB limit (${Math.round(totalAttachmentBytes / (1024 * 1024))} MB).`);
  }

  const accessToken = await getFreshAccessToken(account);

  // Split caller headers: threading headers go in their own MIME fields,
  // everything else (the X-CleanSpace-Marketing-* tags) rides along verbatim.
  let inReplyTo = null;
  let references = null;
  const extraHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'in-reply-to') inReplyTo = value;
    else if (lower === 'references') references = value;
    else extraHeaders[key] = value;
  }

  const domain = account.email.split('@')[1] || 'mail.local';
  const messageId = `<cleanspace-${crypto.randomBytes(12).toString('hex')}@${domain}>`;

  const customDisplay = account.displayName && account.displayName !== account.email
    ? account.displayName
    : '';

  // CAN-SPAM / bulk-sender compliance: marketing sends (identified by the
  // X-CleanSpace-Marketing-* headers) get an unsubscribe footer + List-Unsubscribe
  // headers appended here, server-side, where the signing secret lives.
  // Non-marketing sends (messaging replies, test sends) are left untouched.
  const isHtmlBody = HTML_HINT.test(body || '');
  let finalBody = body;
  const isMarketing = Boolean(
    extraHeaders['X-CleanSpace-Marketing-Sequence-Id'] || extraHeaders['X-CleanSpace-Marketing-Enrollment-Id']
  );
  // unsubscribe.enabled is opt-OUT — an absent config still gets the footer, so
  // compliance is the default even if the caller omits it.
  if (isMarketing && (!unsubscribe || unsubscribe.enabled !== false)) {
    const { footer, listUnsubscribe } = buildUnsubscribeCompliance({
      recipient: to,
      isHtml: isHtmlBody,
      config: unsubscribe || {},
      companyName: senderCompanyName,
      inboxEmail: account.email,
    });
    if (footer) finalBody = `${body || ''}${footer}`;
    if (listUnsubscribe) {
      extraHeaders['List-Unsubscribe'] = listUnsubscribe;
      extraHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
  }

  const raw = buildMime({
    from: formatFrom({ name: fromName || customDisplay, email: account.email }),
    to,
    subject,
    body: finalBody,
    isHtml: isHtmlBody,
    replyTo,
    cc,
    bcc,
    inReplyTo,
    references,
    messageId,
    extraHeaders,
    attachments,
  });

  const sent = await gmailSend(accessToken, raw);

  // Read back the Message-ID Gmail actually stamped; fall back to ours.
  let rfcMessageId = messageId;
  try {
    const meta = await gmailGetMessage(accessToken, sent.id, {
      format: 'metadata',
      metadataHeaders: ['Message-ID'],
    });
    const header = (meta.payload?.headers || [])
      .find((h) => (h.name || '').toLowerCase() === 'message-id');
    if (header?.value) rfcMessageId = header.value;
  } catch {
    // Non-fatal — the Message-ID we generated was set on the message anyway.
  }
  await recordSentMessage(accountId, rfcMessageId);

  return { id: sent.id, threadId: sent.threadId, messageId: rfcMessageId };
}
