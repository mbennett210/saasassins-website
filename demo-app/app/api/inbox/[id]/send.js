// POST /api/inbox/:id/send
// Sends a sequence email through the connected Gmail account. Called by the
// marketing scheduler via sendViaInbox() in src/lib/connectedInboxes.js.
//
// AUTH (SEC-03): requireAuth. This route was previously UNGATED — anyone who knew the
// URL and an inbox id could send arbitrary email through the client's connected Gmail
// account, i.e. spam or phishing from their real domain, burning the sending
// reputation their entire outbound business depends on. The server cron path is
// unaffected: it calls performSend() in-process, never over HTTP.
//
// AUTH (#2): requireAuth alone still let ANY authenticated user send from ANY
// mailbox — including a manager's real Gmail — because the account ids are in the
// blob everyone can read. A role gate is not available (`messaging.use` is
// ALWAYS_GRANTED), so the check is per-mailbox OWNERSHIP. It is inert on today's
// schema and inert per unclaimed row; see _lib/inboxOwnership.js.
import { requireInboxOwner } from '../../_lib/inboxOwnership.js';
import { performSend } from '../../_lib/sender.js';
import { allow } from '../../_lib/rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const authority = await requireInboxOwner(req, res, req.query.id);
  if (!authority) return;
  // Same volume cap as /api/email/send. That route is throttled precisely so one caller
  // cannot burn the domain's sending reputation for everyone — and this route is the
  // STRICTLY MORE POWERFUL sibling: it sends through the client's real connected Gmail
  // rather than Resend. Gating the weaker path and not this one protected nothing.
  if (!allow(req, res, { bucket: 'inbox-send', id: authority.orgUserId || 'anon', limit: 30, windowMs: 10 * 60_000 })) return;
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    res.status(400).send('to, subject and body are required.');
    return;
  }
  try {
    // ⚠️ `orgUserId` LAST, so it overrides anything of that name in the body. It is what
    // a `signatureRef` attachment is resolved against (api/_lib/marketing/attachments.js);
    // taking it from the body would let a caller mail out another user's signature object
    // — the whole point of deriving the path from the claim instead of accepting one.
    const result = await performSend(req.query.id, { ...req.body, orgUserId: authority.orgUserId });
    res.status(200).json({ ok: true, id: result.id, messageId: result.messageId, status: 'sent' });
  } catch (err) {
    res.status(502).send(err.message || 'Send failed.');
  }
}
