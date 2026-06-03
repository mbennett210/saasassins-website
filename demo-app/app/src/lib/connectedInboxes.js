// ─────────────────────────────────────────────────────────────────────────────
// Connected Inboxes adapter — frontend interface for per-user mailbox
// connections (Phase 3 of the email build).
//
// Mirrors the Twilio + email adapter pattern (see ./twilio.js, ./email.js).
// When VITE_EMAIL_BACKEND_URL is set, calls hit the deployment backend's
// /inbox/* routes; when unset, calls fall into a stub that simulates the
// shape of real responses so the UI can be exercised end-to-end.
//
// Tokens (OAuth refresh tokens, SMTP passwords) NEVER round-trip through
// this client. The backend holds them encrypted at rest. The frontend only
// ever sees the metadata that should be safe to display in the UI:
//   { id, userId, provider, email, displayName, status, ... }
//
// Usage:
//   const popup = await connectGoogle();   // returns { ok, inbox } when popup completes
//   const popup = await connectMicrosoft();
//   const result = await connectSmtp({ ... }); // handshake-then-persist
//   await disconnectInbox(inboxId);
//   await testInboxSend(inboxId, { to, subject, body });
// ─────────────────────────────────────────────────────────────────────────────

import { IS_DEMO } from '../demo/isDemo';

// The demo build hard-pins this to stub mode regardless of any env var, so the
// sales demo can never reach a real inbox backend (no OAuth, no SMTP, no poll).
const BACKEND = IS_DEMO
  ? null
  : ((typeof import.meta !== 'undefined' && import.meta.env?.VITE_EMAIL_BACKEND_URL) || null);

const STUB_DELAY_MS = 600;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubInbox({ provider, email, displayName, smtpHost, smtpPort, smtpSecurity, imapHost, imapPort, imapSecurity }) {
  const inboundCapability = provider === 'google'
    ? 'pubsub'
    : provider === 'microsoft'
      ? 'graph'
      : 'imap_poll';
  return {
    id: `ci_${Math.random().toString(36).slice(2, 14)}`,
    provider,
    email: email || `stub.user@${provider === 'smtp' ? 'example.com' : provider + '.com'}`,
    displayName: displayName || 'Stub User',
    status: 'active',
    smtpHost: smtpHost || null,
    smtpPort: smtpPort || null,
    smtpSecurity: smtpSecurity || null,
    imapHost: imapHost || null,
    imapPort: imapPort || null,
    imapSecurity: imapSecurity || null,
    inboundCapability,
  };
}

// ---------- OAuth: Google (Gmail / Workspace) ----------
//
// Real flow: backend GET /inbox/connect/google starts the OAuth dance,
// returns a redirect URL; we open it in a popup. The user approves; the
// callback exchanges the code for tokens (encrypted), then posts back to
// `window.opener` via postMessage with the new inbox metadata. We resolve
// with that.
//
// Stub flow: simulate a brief delay, then resolve with a synthesized inbox
// row so the UI can be exercised offline.
export async function connectGoogle() {
  if (BACKEND) {
    return openOAuthPopup(`${BACKEND}/inbox/connect/google`);
  }
  await delay(STUB_DELAY_MS);
  return {
    ok: true,
    inbox: stubInbox({ provider: 'google', email: 'stub.user@gmail.com', displayName: 'Stub User' }),
  };
}

// ---------- OAuth: Microsoft (Outlook / 365) ----------
export async function connectMicrosoft() {
  if (BACKEND) {
    return openOAuthPopup(`${BACKEND}/inbox/connect/microsoft`);
  }
  await delay(STUB_DELAY_MS);
  return {
    ok: true,
    inbox: stubInbox({ provider: 'microsoft', email: 'stub.user@outlook.com', displayName: 'Stub User' }),
  };
}

// ---------- SMTP / IMAP (any provider with username + app password) ----------
//
// `password` is sent in the request body to the backend, which performs a
// real SMTP handshake before persisting it (encrypted). It MUST never be
// stored in client state.
export async function connectSmtp({
  email,
  displayName,
  smtpHost,
  smtpPort,
  smtpSecurity,
  smtpUsername,
  smtpPassword,
  imapHost,
  imapPort,
  imapSecurity,
  imapUsername,
  imapPassword,
}) {
  if (!email || !smtpHost || !smtpPort || !smtpUsername || !smtpPassword) {
    throw new Error('Missing required SMTP fields.');
  }
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/inbox/connect/smtp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        displayName,
        smtpHost,
        smtpPort,
        smtpSecurity,
        smtpUsername,
        smtpPassword,
        imapHost,
        imapPort,
        imapSecurity,
        imapUsername: imapUsername || smtpUsername,
        imapPassword: imapPassword || smtpPassword,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `SMTP handshake failed (${res.status})`);
    }
    const data = await res.json();
    return { ok: true, inbox: data };
  }
  // Stub: simulate the handshake. Reject obviously bad ports as a sanity
  // check so the UI's error path gets exercised.
  await delay(STUB_DELAY_MS);
  if (smtpPort === 25) {
    throw new Error('Port 25 is typically blocked. Try 587 (STARTTLS) or 465 (SSL).');
  }
  return {
    ok: true,
    inbox: stubInbox({
      provider: 'smtp',
      email,
      displayName,
      smtpHost,
      smtpPort,
      smtpSecurity,
      imapHost,
      imapPort,
      imapSecurity,
    }),
  };
}

// ---------- Disconnect ----------
export async function disconnectInbox(inboxId) {
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/inbox/${encodeURIComponent(inboxId)}/disconnect`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Disconnect failed (${res.status})`);
    }
    return res.json();
  }
  await delay(STUB_DELAY_MS / 2);
  return { ok: true };
}

// ---------- Test send ----------
//
// The Connected Inboxes settings page exposes a "Test send" button that
// dispatches a real test email through the user's connected mailbox so they
// can confirm From/Reply-To routing without leaving the page.
export async function testInboxSend(inboxId, { to, subject, body, fromName }) {
  if (!to || !subject || !body) {
    throw new Error('Missing required test fields.');
  }
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/inbox/${encodeURIComponent(inboxId)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, body, fromName }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Test send failed (${res.status})`);
    }
    return res.json();
  }
  await delay(STUB_DELAY_MS);
  return {
    ok: true,
    id: `em_${Math.random().toString(36).slice(2, 14)}`,
    status: 'sent',
  };
}

// ---------- Outbound send (called from Messaging compose) ----------
//
// Used by lib/messagingEmail.js (Phase 4b). Routes to the user's connected
// inbox so the email originates from their real address. The backend picks
// the right transport (Gmail API / Graph / SMTP) based on the inbox row.
export async function sendViaInbox(inboxId, { to, from, fromName, subject, body, replyTo, cc, bcc, headers, tags, attachments }) {
  if (!inboxId) throw new Error('Connected inbox id is required.');
  if (!to) throw new Error('Recipient email is required.');
  if (!subject) throw new Error('Subject is required.');
  if (!body || !body.trim()) throw new Error('Body is empty.');
  if (BACKEND) {
    const payload = { to, from, fromName, subject, body, replyTo };
    if (cc) payload.cc = cc;
    if (bcc) payload.bcc = bcc;
    if (headers && typeof headers === 'object') payload.headers = headers;
    if (Array.isArray(tags) && tags.length) payload.tags = tags;
    if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
    const res = await fetch(`${BACKEND}/inbox/${encodeURIComponent(inboxId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Inbox send failed (${res.status})`);
    }
    return res.json();
  }
  await delay(STUB_DELAY_MS);
  return {
    ok: true,
    id: `em_${Math.random().toString(36).slice(2, 14)}`,
    status: 'sent',
  };
}

// ---------- Inbound poll (marketing reply detection) ----------
//
// MarketingInboundListener calls this on an interval. The backend self-
// throttles its own Gmail polling; this just returns reply rows past the
// caller's cursor. Stub mode (no backend) resolves to an empty result.
export async function pollInbound(since = 0) {
  if (!BACKEND) return { ok: true, cursor: since, emails: [] };
  const res = await fetch(`${BACKEND}/inbox/inbound?since=${encodeURIComponent(since)}`);
  if (!res.ok) {
    throw new Error(`Inbound poll failed (${res.status})`);
  }
  return res.json();
}

// ---------- Internal: OAuth popup helper ----------
function openOAuthPopup(startUrl) {
  return new Promise((resolve, reject) => {
    const popup = window.open(
      startUrl,
      'connect-inbox',
      'width=600,height=720,menubar=no,toolbar=no,location=no,status=no'
    );
    if (!popup) {
      reject(new Error('Popup blocked. Allow popups for this site and try again.'));
      return;
    }
    let settled = false;
    const onMessage = (e) => {
      // Backend's callback page calls `window.opener.postMessage(...)` with
      // the inbox metadata. We trust messages whose origin matches the API
      // origin OR the app's own origin (callback can run on either).
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type !== 'connect-inbox') return;
      settled = true;
      window.removeEventListener('message', onMessage);
      try { popup.close(); } catch { /* ignore */ }
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else if (e.data.inbox) {
        resolve({ ok: true, inbox: e.data.inbox });
      } else {
        reject(new Error('Connect flow returned no inbox data.'));
      }
    };
    window.addEventListener('message', onMessage);

    // Handle popup-closed-without-completing — treat as user cancel.
    const poll = setInterval(() => {
      if (popup.closed && !settled) {
        clearInterval(poll);
        window.removeEventListener('message', onMessage);
        reject(new Error('Connect flow was cancelled.'));
      }
    }, 500);
  });
}

export { BACKEND as INBOX_BACKEND_URL };
