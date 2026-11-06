// -----------------------------------------------------------------------------
// Email adapter - frontend interface for the app's own transactional email.
//
// Mirrors the Twilio adapter (see ./twilio.js). When VITE_EMAIL_BACKEND_URL is set, calls
// hit the deployment backend; when unset, calls are simulated locally with realistic
// timings + a small failure rate so the failure UI gets exercised.
//
// THE BACKEND SENDS THROUGH GOOGLE (Daniel, 2026-09-29: "Clean Space sends email through
// Google, NOT Resend"; CS-012, CS-039). One connected Google mailbox is marked as the
// SYSTEM SENDER in Settings -> Integrations, and /api/email/send puts the message on the
// wire as that mailbox over the Gmail API. Two consequences for callers here:
//
//   1. THERE IS NO `from` TO CHOOSE. Gmail sends as the authenticated mailbox, so a
//      caller-supplied From can only ever become a Reply-To (api/_lib/email.js
//      resolveFromAndReplyTo). It is still accepted - unchanged wire contract - and no
//      longer required. Pass `replyTo` for where replies should land.
//   2. NOT SET UP IS A REAL STATE. With no mailbox marked, the route answers 503 and the
//      Settings card says "Email isn't set up". There is no key to paste anywhere: the old
//      Connect-provider modal kept only `apiKey.slice(-4)` in the shared record and then
//      reported success (CS-039) - it is deleted.
//
// PER-USER conversational email (Connected Inboxes - the email channel inside Messaging) is
// a different layer: those calls go to /api/inbox/:id/send through lib/connectedInboxes.js
// and leave from each employee's own mailbox.
//
// `headers` and `tags` are accepted for callers who need threading headers or analytics
// tags. The route allowlists headers to In-Reply-To / References (CS-015).
// -----------------------------------------------------------------------------

import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { appLink } from './appLink.js';

const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_EMAIL_BACKEND_URL) || null;

// CS-038: mirror the Twilio adapter. The stub is allowed ONLY in a demo/dev build with no
// real backend. The STATIC MODE/PROD checks come FIRST, so a production build folds the whole
// expression to a compile-time `false` (`(false) && !BACKEND` short-circuits before BACKEND)
// and esbuild/rolldown dead-code-eliminate the stub bodies + the 'cs-stub:email' sentinel —
// check-bundle-stubs.mjs asserts it. `MODE === 'demo'` keeps the stub in `build:demo` (where
// PROD is also true). Dispatch keys on the STATIC EMAIL_STUB, never on the runtime BACKEND URL
// (which can't fold — `!BACKEND` first would keep the stub bodies in prod). This module is
// browser-only, so the plain import.meta.env reads need no `typeof import.meta` guard (a guard
// blocks the fold). See lib/twilio.js, lib/demoMode.js.
const EMAIL_STUB =
  (import.meta.env.MODE === 'demo' || !import.meta.env.PROD) && !BACKEND;
if (EMAIL_STUB) markStub('cs-stub:email');

// EMAIL_STUB_ACTIVE: the demo/dev simulation is engaged (fake sends). EMAIL_CONFIGURED: a
// real backend OR the demo stub is available — false only in the broken case (a production
// build with no backend URL), where the UI shows a "not configured" state (CS-038).
export const EMAIL_STUB_ACTIVE = EMAIL_STUB;
export const EMAIL_CONFIGURED = !!BACKEND || EMAIL_STUB;
const NOT_CONFIGURED = 'Email is not configured for this deployment.';

const STUB_DELAY_MS = 600;
const STUB_FAILURE_RATE = 0.05;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Routes return JSON errors ({ error }); pull out the human-readable message
// so failureReason / toasts don't show raw JSON.
async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text)?.error || text;
  } catch {
    return text;
  }
}

/**
 * Send a transactional email as the Google system sender.
 *
 * Backend: POST /email/send  { to, from?, subject, body, replyTo?, headers?, tags? }
 *          -> { id, status: 'sent', from, replyTo? }
 *          503 when no sending mailbox is set up; 403 unless the caller holds
 *          integrations.manage or settings.team.edit (CS-015).
 *
 * Stub: validates shape, simulates timing, returns {id, status: 'sent'}
 *       (or throws ~5% of the time to exercise failure UI).
 *
 * @param {Object} args
 * @param {string} args.to - ONE recipient email (a list is refused, CS-015)
 * @param {string} [args.from] - a REQUEST only: Gmail sends as the system sender, so this
 *                               becomes the Reply-To when it is not that mailbox
 * @param {string} args.subject
 * @param {string} args.body - plain text or HTML; the backend decides format
 * @param {string} [args.replyTo] - Reply-To header
 * @param {Object} [args.headers] - threading headers (In-Reply-To / References; others dropped)
 * @param {string[]} [args.tags] - analytics tags (ride as one X-CleanSpace-Tags header)
 */
export async function sendEmail({ to, from, subject, body, replyTo, cc, bcc, headers, tags }) {
  if (!to) throw new Error('Recipient email is required.');
  if (!subject) throw new Error('Subject is required.');
  if (!body || !body.trim()) throw new Error('Body is empty.');
  if (!/^.+@.+\..+$/.test(to)) throw new Error(`Invalid recipient: ${to}`);

  if (BACKEND) {
    const payload = { to, subject, body, replyTo };
    if (from) payload.from = from;
    if (cc) payload.cc = cc;
    if (bcc) payload.bcc = bcc;
    if (headers && typeof headers === 'object') payload.headers = headers;
    if (Array.isArray(tags) && tags.length) payload.tags = tags;
    const res = await fetch(`${BACKEND}/email/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await readError(res);
      throw new Error(err || `Email send failed (${res.status})`);
    }
    return res.json();
  }

  if (!EMAIL_STUB) throw new Error(NOT_CONFIGURED);
  // Stub path — simulate latency + occasional failure.
  await delay(STUB_DELAY_MS);
  if (Math.random() < STUB_FAILURE_RATE) {
    throw new Error('Recipient mailbox bounced (simulated)');
  }
  return {
    id: `em_${Math.random().toString(36).slice(2, 14)}`,
    status: 'sent',
  };
}

/**
 * Can the app send its own email, and as which mailbox?
 *
 * Backend: GET /email/health -> {
 *   provider: 'google',
 *   status: 'verified' | 'failed' | 'not_started',   // live | needs reconnect | none chosen
 *   configured, verifiedDomain, defaultFrom,
 *   senderEmail, senderInboxId, senderSource: 'env' | 'inbox' | null, pinned,
 *   dkimRecords: [], spfStatus: null, dmarcStatus: null,  // Google's to manage, not ours
 *   lastCheckedAt, failureReason?
 * }
 *
 * Stub: returns a minimally-shaped "nothing chosen" response so the UI does not crash in
 * dev mode.
 */
export async function getEmailHealth() {
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/email/health`, {
      method: 'GET',
      headers: await authHeaders(),
    });
    if (!res.ok) {
      const err = await readError(res);
      throw new Error(err || `Email health check failed (${res.status})`);
    }
    return res.json();
  }
  if (!EMAIL_STUB) {
    // Not configured (a production build with no backend URL). Report it honestly instead
    // of a fake pending health, so the Settings card shows "not configured" (CS-038).
    return {
      status: 'not_configured',
      configured: false,
      verifiedDomain: null,
      defaultFrom: null,
      dkimRecords: [],
      spfStatus: null,
      dmarcStatus: null,
      lastCheckedAt: null,
    };
  }
  // Stub — surfaces "Dev mode: simulated" in the Settings card.
  await delay(200);
  return {
    status: 'not_started',
    verifiedDomain: null,
    defaultFrom: null,
    dkimRecords: [],
    spfStatus: null,
    dmarcStatus: null,
    lastCheckedAt: new Date().toISOString(),
    stub: true,
  };
}

/**
 * Which connected Google mailbox sends the app's email, and which mailboxes could.
 * Owner only, server-side (api/email/system-sender.js).
 *
 * Backend: GET /email/system-sender → { sender, candidates: [{ id, email, displayName,
 *          status, isSystemSender }] }. No token is ever returned.
 */
export async function getSystemSender() {
  if (!BACKEND) return { sender: null, candidates: [], stub: true };
  const res = await fetch(`${BACKEND}/email/system-sender`, { headers: await authHeaders() });
  if (!res.ok) throw new Error((await readError(res)) || `Could not read the sending mailbox (${res.status})`);
  return res.json();
}

/**
 * Mark `inboxId` as the mailbox the app sends from, or clear it with null. Owner only.
 * This REPLACED the Connect-provider modal, which kept `apiKey.slice(-4)` in the shared
 * record, never sent the key anywhere, and reported "connected" (CS-039). There is no
 * secret in this call: the mailbox already holds its own OAuth token, encrypted, on the
 * server.
 *
 * Backend: POST /email/system-sender { inboxId } → { ok, sender }
 *          409 when the choice is pinned by SYSTEM_SENDER_EMAIL or not provisioned yet.
 */
export async function setSystemSender(inboxId) {
  if (!BACKEND) throw new Error(NOT_CONFIGURED);
  const res = await fetch(`${BACKEND}/email/system-sender`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ inboxId: inboxId || null }),
  });
  if (!res.ok) throw new Error((await readError(res)) || `Could not set the sending mailbox (${res.status})`);
  return res.json();
}

/**
 * Synthesize an inbound email payload for local dev testing of the
 * RECEIVE_EMAIL routing logic. Used by Settings → Integrations' "Simulate
 * inbound" card before the production webhook is wired. In prod, real
 * inbound payloads come from the Gmail poll (api/inbox/ingest.js, via
 * api/_lib/gmailPoll.js) and dispatch the same RECEIVE_EMAIL action.
 */
export function simulateInboundEmail({ fromEmail, toInboxEmail, subject, body, inReplyTo, references }) {
  if (!EMAIL_STUB) return null; // not configured / production build — no fabricated inbound
  const messageId = `<sim-${Date.now()}@inbound.local>`;
  return {
    fromEmail,
    toInboxEmail: toInboxEmail || null,
    subject: subject || null,
    body: body || '',
    messageId,
    inReplyTo: inReplyTo || null,
    references: references || null,
  };
}

// Build an invitation email body. Caller composes the full sendEmail() args.
// The signup link is on the app's own address (lib/appLink.js: the brand pack's appUrl in a
// deployed build, this page's origin in dev and the demo). The token round-trips back via
// /accept-invite?token=... once auth lands; until then, the link is informational.
export function buildInviteEmail({ inviteeName, inviterName, companyName, roleLabel, token, expiresAt }) {
  const link = appLink(`/accept-invite?token=${encodeURIComponent(token)}`);
  const expires = expiresAt ? new Date(expiresAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const greeting = inviteeName ? `Hi ${inviteeName.split(' ')[0]}` : 'Hi there';
  const subject = `You're invited to join ${companyName}`;
  const body =
`${greeting},

${inviterName} invited you to join ${companyName} as a ${roleLabel}.

Accept your invitation here:
${link}

${expires ? `This invitation expires on ${expires}.` : ''}

If you weren't expecting this email, you can safely ignore it.

The ${companyName} team`;
  return { subject, body };
}

// (The quote email and the local copy of the sign-request email are gone, 2026-10-20: nothing sent
// the first, and the Review section's Drafts now render the server's own sign-request email,
// src/lib/quoteEmails.js.)
