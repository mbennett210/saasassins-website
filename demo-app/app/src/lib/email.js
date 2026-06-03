// ─────────────────────────────────────────────────────────────────────────────
// Email adapter — frontend interface for transactional email send.
//
// Mirrors the Twilio adapter (see ./twilio.js). When VITE_EMAIL_BACKEND_URL is
// set, calls hit the deployment backend (typically a Vercel API route wrapping
// Resend, SendGrid, or similar). When unset, calls are simulated locally with
// realistic timings + a small failure rate so the failure UI gets exercised.
//
// Two layers use this adapter:
//   1. SYSTEM transactional — invitations, reminder emails, billing — sent
//      from the verified app subdomain (e.g. notifications@mail.example.com).
//      The default From comes from `selectEmailDefaultFrom(state)`; backend
//      validates it against the verified-domain allowlist.
//   2. PER-USER conversational (Connected Inboxes) — email channel inside
//      Messaging, sent FROM each employee's own configured ESP. Those calls
//      hit a different backend route (/api/inbox/:id/send) and pass their
//      own From + auth via the lib/connectedInboxes.js client.
//
// `headers` and `tags` parameters are accepted for callers who need to set
// threading headers (Message-ID / In-Reply-To / References) or analytics tags.
// They are passed through unchanged to whichever backend transport handles
// the send.
// ─────────────────────────────────────────────────────────────────────────────

import { IS_DEMO } from '../demo/isDemo';

// The demo build hard-pins this to stub mode regardless of any env var, so the
// sales demo can never reach a real email backend.
const BACKEND = IS_DEMO
  ? null
  : ((typeof import.meta !== 'undefined' && import.meta.env?.VITE_EMAIL_BACKEND_URL) || null);

const STUB_DELAY_MS = 600;
const STUB_FAILURE_RATE = 0.05;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a transactional email through the system provider (Resend).
 *
 * Backend: POST /email/send  { to, from, subject, body, replyTo?, headers?, tags? }
 *          → { id, status: 'sent' | 'queued' | 'failed', failureReason? }
 *
 * Stub: validates shape, simulates timing, returns {id, status: 'sent'}
 *       (or throws ~5% of the time to exercise failure UI).
 *
 * @param {Object} args
 * @param {string} args.to — recipient email
 * @param {string} args.from — sender (must be on the verified domain in prod)
 * @param {string} args.subject
 * @param {string} args.body — plain text or HTML; backend decides format
 * @param {string} [args.replyTo] — Reply-To header
 * @param {Object} [args.headers] — extra MIME headers (e.g. { 'In-Reply-To', 'References', 'Message-ID' })
 * @param {string[]} [args.tags] — provider-side analytics tags
 */
export async function sendEmail({ to, from, subject, body, replyTo, cc, bcc, headers, tags }) {
  if (!to) throw new Error('Recipient email is required.');
  if (!from) throw new Error('From email is required.');
  if (!subject) throw new Error('Subject is required.');
  if (!body || !body.trim()) throw new Error('Body is empty.');
  if (!/^.+@.+\..+$/.test(to)) throw new Error(`Invalid recipient: ${to}`);

  if (BACKEND) {
    const payload = { to, from, subject, body, replyTo };
    if (cc) payload.cc = cc;
    if (bcc) payload.bcc = bcc;
    if (headers && typeof headers === 'object') payload.headers = headers;
    if (Array.isArray(tags) && tags.length) payload.tags = tags;
    const res = await fetch(`${BACKEND}/email/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Email send failed (${res.status})`);
    }
    return res.json();
  }

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
 * Fetch the system email provider's domain verification status.
 *
 * Backend: GET /email/health → {
 *   status: 'verified' | 'pending' | 'failed' | 'not_started',
 *   verifiedDomain, defaultFrom,
 *   dkimRecords: [{ host, type, value, status }],
 *   spfStatus, dmarcStatus, lastCheckedAt, failureReason?
 * }
 *
 * Stub: returns a minimally-shaped pending response so the UI doesn't crash
 * in dev mode.
 */
export async function getEmailHealth() {
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/email/health`, { method: 'GET' });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Email health check failed (${res.status})`);
    }
    return res.json();
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
 * Synthesize an inbound email payload for local dev testing of the
 * RECEIVE_EMAIL routing logic. Used by Settings → Integrations' "Simulate
 * inbound" card before the production webhook is wired. In prod, real
 * inbound payloads come from Resend Inbound (system mail) or Gmail Pub/Sub
 * / Microsoft Graph / IMAP poll (per-user mailboxes) and dispatch the same
 * RECEIVE_EMAIL action.
 */
export function simulateInboundEmail({ fromEmail, toInboxEmail, subject, body, inReplyTo, references }) {
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

export { BACKEND as EMAIL_BACKEND_URL };

// Build an invitation email body. Caller composes the full sendEmail() args.
// The signup link uses window.location.origin so the email points back to
// whatever host the app is served from. The token round-trips back via
// /accept-invite?token=... once auth lands; until then, the link is informational.
export function buildInviteEmail({ inviteeName, inviterName, companyName, roleLabel, token, expiresAt }) {
  const origin = (typeof window !== 'undefined' && window.location?.origin) || '';
  const link = `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
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

— The ${companyName} team`;
  return { subject, body };
}
