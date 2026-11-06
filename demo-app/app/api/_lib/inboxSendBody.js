// What a BROWSER may put in the body of POST /api/inbox/:id/send and /test.
//
// 🔴 CS-017 (the second half). Both routes did `performSend(id, { ...req.body, orgUserId })`,
// so every argument performSend and buildMime accept was caller-controlled: arbitrary MIME
// headers, `fromName`, `senderCompanyName`, and — the one with teeth —
// `unsubscribe.enabled: false`, which switches OFF the CAN-SPAM footer and the
// List-Unsubscribe headers that _lib/sender.js adds to marketing mail. A spread is an
// allowlist you forgot to write: the next field added to performSend became remotely
// settable the moment it existed. This is that allowlist, written down.
//
// The marketing headers stay ACCEPTED, not refused, because they are load-bearing: the
// client scheduler (src/lib/marketingScheduler.js) sends them and _lib/sender.js keys the
// unsubscribe footer off them. They are the reason for an allowlist rather than a blanket
// "no caller headers" — that would have silently dropped the compliance footer.
//
// Threading headers ride the same list so a Messaging reply still threads.

// Header names a browser may set. Exact match on In-Reply-To / References (case-insensitive),
// prefix match on the marketing tags.
const ALLOWED_HEADERS = new Set(['in-reply-to', 'references']);
const ALLOWED_HEADER_PREFIX = 'x-cleanspace-marketing-';

function headerAllowed(name) {
  const lower = String(name || '').toLowerCase();
  return ALLOWED_HEADERS.has(lower) || lower.startsWith(ALLOWED_HEADER_PREFIX);
}

// The unsubscribe CONFIG a caller may shape — the footer's wording and the physical address
// it names. TWO of the six fields the client sends are deliberately NOT here:
//
//   `enabled`  turns the CAN-SPAM footer and the List-Unsubscribe headers OFF.
//              _lib/sender.js treats an absent config as opt-OUT (the footer is added unless
//              `enabled === false`), so dropping the key is exactly "the footer stays".
//   `baseUrl`  is where the unsubscribe LINK points. Accepting it from a browser let any
//              login aim a link in the company's own marketing mail at any URL they liked —
//              a phishing primitive on a DKIM-signed message. The server's own base URL
//              (INBOX_INBOUND_BASE_URL, else the app's address from appPublicUrl(); see
//              _lib/marketing/compliance.js) is the right source; an override belongs in env.
const UNSUBSCRIBE_FIELDS = ['message', 'linkText', 'includeAddress', 'address'];

export function sanitizeInboxSendBody(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const out = {
    to: b.to,
    subject: b.subject,
    body: b.body,
    replyTo: b.replyTo,
    cc: b.cc,
    bcc: b.bcc,
    fromName: b.fromName,
    senderCompanyName: b.senderCompanyName,
    attachments: Array.isArray(b.attachments) ? b.attachments : undefined,
  };
  if (b.headers && typeof b.headers === 'object') {
    const headers = {};
    for (const [k, v] of Object.entries(b.headers)) {
      if (v == null) continue;
      if (headerAllowed(k)) headers[k] = v;
    }
    if (Object.keys(headers).length) out.headers = headers;
  }
  if (b.unsubscribe && typeof b.unsubscribe === 'object') {
    const u = {};
    for (const f of UNSUBSCRIBE_FIELDS) if (b.unsubscribe[f] != null) u[f] = b.unsubscribe[f];
    if (Object.keys(u).length) out.unsubscribe = u;
  }
  // Drop the keys we never set, so performSend sees absence rather than undefined and its
  // own defaults apply.
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
