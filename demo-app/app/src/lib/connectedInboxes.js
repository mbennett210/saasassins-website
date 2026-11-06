// ─────────────────────────────────────────────────────────────────────────────
// Connected Inboxes adapter — frontend interface for per-user mailbox
// connections (Phase 3 of the email build).
//
// Mirrors the Twilio + email adapter pattern (see ./twilio.js, ./email.js).
// When VITE_EMAIL_BACKEND_URL is set, calls hit the deployment backend's
// /inbox/* routes; when unset, calls fall into a stub that simulates the
// shape of real responses so the UI can be exercised end-to-end.
//
// OAuth refresh tokens NEVER round-trip through this client. The backend holds them
// encrypted at rest (api/_lib/crypto.js). The frontend only
// ever sees the metadata that should be safe to display in the UI:
//   { id, userId, provider, email, displayName, status, ... }
//
// Usage:
//   const popup = await connectGoogle();   // returns { ok, inbox } when popup completes
//   await disconnectInbox(inboxId);
//   await testInboxSend(inboxId, { to, subject, body });
// ─────────────────────────────────────────────────────────────────────────────

// SEC-03: the /inbox/* routes are now authenticated server-side, so every call from
// here must carry the signed-in user's bearer token (same pattern as the other adapters).
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';

const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_EMAIL_BACKEND_URL) || null;

// CS-038: mirror the Twilio adapter — a hosted build with no backend URL would otherwise FAKE
// mailbox connects and sends. The STATIC MODE/PROD checks come FIRST, so a production build
// folds INBOX_STUB to a compile-time `false` (`(false) && !BACKEND` short-circuits before
// BACKEND) and esbuild/rolldown dead-code-eliminate the stub bodies + the
// 'cs-stub:connectedInboxes' sentinel (check-bundle-stubs.mjs asserts it). `MODE === 'demo'`
// keeps the stub in `build:demo`. Dispatch keys on the STATIC INBOX_STUB, never on the runtime
// BACKEND URL (which can't fold). Browser-only, so the plain import.meta.env reads need no
// `typeof import.meta` guard (a guard blocks the fold). See lib/twilio.js, lib/demoMode.js.
const INBOX_STUB =
  (import.meta.env.MODE === 'demo' || !import.meta.env.PROD) && !BACKEND;
if (INBOX_STUB) markStub('cs-stub:connectedInboxes');
// INBOX_CONFIGURED is false only in the broken case (a production build with no backend URL):
// the connect UI shows a "not configured" state instead of faking a connection (CS-038).
export const INBOX_STUB_ACTIVE = INBOX_STUB;
export const INBOX_CONFIGURED = !!BACKEND || INBOX_STUB;
const NOT_CONFIGURED = 'Connected inboxes are not configured for this deployment.';

const STUB_DELAY_MS = 600;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google is the only provider (CS-220), so the demo stub builds one shape. The smtp*/imap*
// keys stay on the row because the store + Connected Inboxes page still read them as null.
function stubInbox({ email, displayName }) {
  return {
    id: `ci_${Math.random().toString(36).slice(2, 14)}`,
    provider: 'google',
    email: email || 'stub.user@google.com',
    displayName: displayName || 'Stub User',
    status: 'active',
    smtpHost: null,
    smtpPort: null,
    smtpSecurity: null,
    imapHost: null,
    imapPort: null,
    imapSecurity: null,
    inboundCapability: 'pubsub',
  };
}

// ---------- OAuth: Google (Gmail / Workspace) ----------
//
// Real flow: authenticated GET /inbox/connect/start (owner/admin) mints the Google
// consent URL and returns it; we open that URL in a popup. The user approves; the
// callback exchanges the code for tokens (encrypted), then posts back to
// `window.opener` via postMessage with the new inbox metadata. We resolve
// with that.
//
// Stub flow: simulate a brief delay, then resolve with a synthesized inbox
// row so the UI can be exercised offline.
// `workspaceId` (optional) selects which Google Workspace OAuth app the consent
// flow routes through (multi-Workspace, v47). The backend looks up that
// Workspace's client_id/secret. Omitted → the legacy single env OAuth app.
export async function connectGoogle(workspaceId) {
  if (BACKEND) {
    // Authority is proven at the AUTHENTICATED start endpoint (the popup can't carry our
    // Bearer header); it returns the Google consent URL and we open THAT directly —
    // mirrors qboApi's connectQbo. Replaces opening /inbox/connect/google, which was
    // unauthenticated, so anyone could start the flow and graft in a mailbox they
    // control (2026-08-03 audit S3).
    const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
    const res = await fetch(`${BACKEND}/inbox/connect/start${qs}`, { headers: await authHeaders() });
    if (!res.ok) {
      let msg = `Could not start the connect flow (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    const { url } = await res.json();
    if (!url) throw new Error('Connect flow did not return a URL.');
    return openOAuthPopup(url);
  }
  if (!INBOX_STUB) throw new Error(NOT_CONFIGURED);
  await delay(STUB_DELAY_MS);
  return {
    ok: true,
    inbox: stubInbox({ email: 'stub.marcus@gmail.com', displayName: 'Stub Marcus' }),
  };
}

// ---------- DELETED: Microsoft and SMTP connectors (CS-220, 2026-09-29) ----------
// connectMicrosoft() posted to /api/inbox/connect/microsoft and connectSmtp() to
// /api/inbox/connect/smtp. NEITHER ENDPOINT EXISTS, and neither ever did in this build:
// no handler, no importer, no UI that called them (ConnectInboxModal imports only
// connectGoogle). connectSmtp() was the worse of the two - it took `smtpPassword` /
// `imapPassword` in a request body and sent them, in the clear, to a 404. Deleted rather
// than left as a plausible-looking door (THE LAW II.5, replace means delete).
//
// Google is the only provider: Clean Space is a Google Workspace shop, and the app's own
// email goes through Google too (api/_lib/systemSender.js).

// ---------- Disconnect ----------
export async function disconnectInbox(inboxId) {
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/inbox/${encodeURIComponent(inboxId)}/disconnect`, {
      method: 'POST',
      headers: { ...(await authHeaders()) },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Disconnect failed (${res.status})`);
    }
    return res.json();
  }
  if (!INBOX_STUB) throw new Error(NOT_CONFIGURED);
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
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ to, subject, body, fromName }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Test send failed (${res.status})`);
    }
    return res.json();
  }
  if (!INBOX_STUB) throw new Error(NOT_CONFIGURED);
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
export async function sendViaInbox(inboxId, { to, from, fromName, subject, body, replyTo, cc, bcc, headers, tags, attachments, senderCompanyName, unsubscribe }) {
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
    if (senderCompanyName) payload.senderCompanyName = senderCompanyName;
    if (unsubscribe && typeof unsubscribe === 'object') payload.unsubscribe = unsubscribe;
    const res = await fetch(`${BACKEND}/inbox/${encodeURIComponent(inboxId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Inbox send failed (${res.status})`);
    }
    return res.json();
  }
  if (!INBOX_STUB) throw new Error(NOT_CONFIGURED);
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
  const res = await fetch(`${BACKEND}/inbox/inbound?since=${encodeURIComponent(since)}`, {
    headers: { ...(await authHeaders()) },
  });
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
    // Only trust postMessage from our own app origin or the configured backend origin
    // (the callback runs on one of them). Before this the handler checked only the
    // message TYPE and no origin — despite the comment claiming otherwise — so any
    // window holding a reference to ours could inject a forged 'connect-inbox' payload
    // (2026-08-03 audit S4).
    const allowedOrigins = new Set([window.location.origin]);
    try { if (BACKEND) allowedOrigins.add(new URL(BACKEND, window.location.origin).origin); } catch { /* ignore */ }
    let settled = false;
    const onMessage = (e) => {
      if (!allowedOrigins.has(e.origin)) return;
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
