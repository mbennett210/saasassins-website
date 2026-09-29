// Google OAuth + Gmail REST helpers. No SDK — plain fetch against the
// documented endpoints. Also builds outbound RFC 2822 MIME and flattens
// inbound Gmail messages into the shape RECEIVE_EMAIL expects.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// gmail.send → send sequence mail; gmail.readonly → poll for replies. Both are
// usable without Google verification because the OAuth app is Internal.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

// ---------- OAuth ----------

// `creds` (optional) = { clientId, clientSecret } for a specific Google
// Workspace's OAuth app (multi-Workspace). Falls back to the legacy single env
// app when not supplied.
// `scopes` defaults to the Gmail pair so every existing inbox call site is
// byte-identical; the Business Profile flow (api/reviews) passes its own
// business.manage scope. Same Internal OAuth app either way — Internal apps
// add scopes without a Google verification round-trip.
export function buildConsentUrl(state, redirectUri, creds = {}, scopes = SCOPES) {
  const clientId = creds.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error('No Google OAuth client_id — the Workspace isn’t configured and GOOGLE_OAUTH_CLIENT_ID is unset.');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// The OAuth redirect URI — must be IDENTICAL on the connect + callback legs
// and registered verbatim in the Google Cloud console.
export function buildRedirectUri(host) {
  const origin = (process.env.INBOX_INBOUND_BASE_URL || (host ? `https://${host}` : '')).replace(/\/+$/, '');
  return `${origin}/api/inbox/oauth/google/callback`;
}

export async function exchangeCode(code, redirectUri, creds = {}) {
  return tokenRequest({
    code,
    client_id: creds.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: creds.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

// A Google refresh token is bound to the client_id that issued it, so the same
// Workspace creds that minted it MUST be used to refresh — pass them in.
export async function refreshAccessToken(refreshToken, creds = {}) {
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: creds.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: creds.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
}

async function tokenRequest(fields) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google token request failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export async function revokeToken(token) {
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch {
    // Best effort — the account row is removed regardless.
  }
}

// ---------- Gmail REST ----------

async function gmailFetch(accessToken, path, init = {}) {
  return fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
  });
}

export async function gmailGetProfile(accessToken) {
  const res = await gmailFetch(accessToken, '/profile');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail profile failed: ${data.error?.message || res.status}`);
  return data; // { emailAddress, historyId, ... }
}

// Gmail's UPLOAD host. The standard API host caps a request at 5 MB; this one accepts
// 35 MB. §8 G3.
const GMAIL_UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

// Send a built MIME message.
//
// ⚠️ WHY THE UPLOAD ENDPOINT AND NOT /messages/send.
// This used to POST `{ raw }` as JSON to the STANDARD endpoint, which Google caps at
// 5 MB per request. Attachments are base64 inside the MIME (+33%), and headers add
// more, so the real ceiling was ~3.7 MB of actual file — while the composer advertises
// 10 MB per file and 25 MB total (lib/attachments.js). Anything in between was
// promised by the UI and rejected by the transport.
//
// Worth being precise about the earlier fix: 605b840 moved attachment BYTES out of the
// Vercel request body (which 413'd at ~4.5 MB) and into Storage. That was real, but it
// did not move the user-visible ceiling at all, because Gmail's own 5 MB limit binds
// first and is what the user actually hits. This is the half that moves it.
//
// uploadType=media takes the raw RFC-822 bytes as the body rather than base64url in
// JSON, so the message is decoded back here. Callers keep passing base64url and
// buildMime is untouched.
export async function gmailSend(accessToken, rawBase64Url) {
  const mime = Buffer.from(rawBase64Url, 'base64url');
  const res = await fetch(`${GMAIL_UPLOAD_API}/messages/send?uploadType=media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'message/rfc822',
    },
    body: mime,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail send failed: ${data.error?.message || res.status}`);
  return data; // { id, threadId, labelIds }
}

export async function gmailGetMessage(accessToken, id, { format = 'full', metadataHeaders = [] } = {}) {
  const params = new URLSearchParams({ format });
  metadataHeaders.forEach((h) => params.append('metadataHeaders', h));
  const res = await gmailFetch(accessToken, `/messages/${id}?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail message fetch failed: ${data.error?.message || res.status}`);
  return data;
}

// Walks the messageAdded history since startHistoryId (paginated). Returns
// { messages: [{ id, labelIds }], historyId }, or { expired: true } when the
// cursor is too old and the caller must re-baseline.
export async function gmailHistoryList(accessToken, startHistoryId) {
  const messages = [];
  let pageToken = null;
  let historyId = startHistoryId;
  do {
    const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await gmailFetch(accessToken, `/history?${params}`);
    if (res.status === 404) return { expired: true };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gmail history failed: ${data.error?.message || res.status}`);
    for (const entry of data.history || []) {
      for (const added of entry.messagesAdded || []) {
        if (added.message) messages.push(added.message);
      }
    }
    if (data.historyId) historyId = data.historyId;
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return { messages, historyId };
}

export async function gmailListRecent(accessToken, query) {
  const params = new URLSearchParams({ q: query, maxResults: '25' });
  const res = await gmailFetch(accessToken, `/messages?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail list failed: ${data.error?.message || res.status}`);
  return data.messages || []; // [{ id, threadId }]
}

// ---------- Outbound MIME ----------

function encodeHeader(value) {
  const s = String(value || '');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// Builds an RFC 2822 message and returns it base64url-encoded for Gmail's
// `raw` send field. Without attachments it's a single text/plain or text/html
// part; with attachments it's multipart/mixed — the body part followed by one
// base64 part per file. `attachments` is [{ name, mimeType, content }] where
// `content` is already base64-encoded.
export function buildMime({ from, to, subject, body, isHtml, replyTo, cc, bcc, inReplyTo, references, messageId, extraHeaders, attachments }) {
  const headerLines = [`From: ${from}`, `To: ${to}`];
  if (cc) headerLines.push(`Cc: ${cc}`);
  if (bcc) headerLines.push(`Bcc: ${bcc}`);
  if (replyTo) headerLines.push(`Reply-To: ${replyTo}`);
  headerLines.push(`Subject: ${encodeHeader(subject)}`);
  headerLines.push(`Message-ID: ${messageId}`);
  if (inReplyTo) headerLines.push(`In-Reply-To: ${String(inReplyTo).replace(/[\r\n]+/g, ' ')}`);
  if (references) headerLines.push(`References: ${String(references).replace(/[\r\n]+/g, ' ')}`);
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (value != null) headerLines.push(`${key}: ${String(value).replace(/[\r\n]+/g, ' ')}`);
  }
  headerLines.push('MIME-Version: 1.0');

  // base64, wrapped at 76 chars per RFC 2045.
  const wrap = (b64) => String(b64 || '').replace(/(.{76})/g, '$1\r\n');
  const bodyB64 = wrap(Buffer.from(body || '', 'utf8').toString('base64'));
  const contentType = `text/${isHtml ? 'html' : 'plain'}; charset="UTF-8"`;
  const newBoundary = () => `cleanspace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;

  // The message body as a MIME part.
  const bodyPart = [`Content-Type: ${contentType}`, 'Content-Transfer-Encoding: base64', '', bodyB64];

  // One attachment part. `inline` images carry a Content-ID so an HTML body can
  // reference them with <img src="cid:...">, and use Content-Disposition: inline
  // so clients render them in place (e.g. a signature image) rather than as a
  // download. Everything else is a normal downloadable attachment.
  const filePart = (file) => {
    const name = String(file.name || 'attachment').replace(/[\r\n"]/g, '');
    // Strip CR/LF (+ quote/semicolon) so a crafted mimeType can't inject extra
    // MIME headers — mirrors the name/contentId sanitization below.
    const mimeType = String(file.mimeType || 'application/octet-stream').replace(/[\r\n";]/g, '') || 'application/octet-stream';
    const ct = `${mimeType}; name="${name}"`;
    if (file.inline && file.contentId) {
      const cid = String(file.contentId).replace(/[\r\n<>"]/g, '');
      return [
        `Content-Type: ${ct}`,
        `Content-Disposition: inline; filename="${name}"`,
        `Content-ID: <${cid}>`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap(file.content),
      ];
    }
    return [
      `Content-Type: ${ct}`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap(file.content),
    ];
  };

  const files = Array.isArray(attachments) ? attachments.filter((a) => a && a.content) : [];
  const inlineFiles = files.filter((a) => a.inline && a.contentId);
  const regularFiles = files.filter((a) => !(a.inline && a.contentId));

  // No attachments → a single body part (text/plain or text/html).
  if (files.length === 0) {
    return Buffer.from([...headerLines, ...bodyPart].join('\r\n'), 'utf8').toString('base64url');
  }

  // Assemble a multipart container from pre-built sub-parts.
  const multipart = (subtype, parts) => {
    const boundary = newBoundary();
    const out = [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, ''];
    for (const part of parts) out.push(`--${boundary}`, ...part);
    out.push(`--${boundary}--`);
    return out;
  };

  // Inline images → body + images go in multipart/related so the HTML can
  // reference them by cid; regular attachments (if any) wrap that in
  // multipart/mixed. With no inline images it's a plain multipart/mixed —
  // structurally identical to the previous behaviour.
  let tree;
  if (inlineFiles.length > 0) {
    const related = multipart('related', [bodyPart, ...inlineFiles.map(filePart)]);
    tree = regularFiles.length > 0
      ? multipart('mixed', [related, ...regularFiles.map(filePart)])
      : related;
  } else {
    tree = multipart('mixed', [bodyPart, ...regularFiles.map(filePart)]);
  }
  return Buffer.from([...headerLines, ...tree].join('\r\n'), 'utf8').toString('base64url');
}

// ---------- Inbound parsing ----------

function headerValue(headers, name) {
  const found = (headers || []).find((h) => (h.name || '').toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

function findPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const text = findPlainText(part);
    if (text) return text;
  }
  return '';
}

// Flattens a Gmail `format=full` message into the fields RECEIVE_EMAIL wants.
export function parseInboundMessage(message) {
  const headers = message.payload?.headers || [];
  const from = headerValue(headers, 'From') || '';
  const match = from.match(/<([^>]+)>/) || from.match(/([^\s<>]+@[^\s<>]+)/);
  return {
    fromEmail: (match ? match[1] : from).trim().toLowerCase(),
    subject: headerValue(headers, 'Subject'),
    messageId: headerValue(headers, 'Message-ID'),
    inReplyTo: headerValue(headers, 'In-Reply-To'),
    references: headerValue(headers, 'References'),
    body: findPlainText(message.payload) || message.snippet || '',
    labelIds: message.labelIds || [],
  };
}
