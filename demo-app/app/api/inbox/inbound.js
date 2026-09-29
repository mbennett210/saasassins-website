// GET /api/inbox/inbound?since=<seq>
// Client-facing inbound poll (src/components/InboundListener.jsx). Refreshes
// each connected inbox's Gmail view, buffers any replies, and returns rows past
// the caller's cursor for the browser to thread in. The Gmail-poll itself is
// shared with the server-side cron ingest (api/inbox/ingest.js) via _lib/gmailPoll.

// AUTH (SEC-03): requireAuthority — previously ungated, and this route RETURNS EMAIL
// CONTENT. Anyone who could guess the URL could read the client's inbound customer
// replies by walking the `since` cursor. This is a browser-facing poll (the cron ingest
// uses api/inbox/ingest.js), so a team member's session is the right gate. It was a bare
// session check until 2026-09-23, so a member set to Disabled kept reading the company's
// inbound mail (authz.js ROSTER STATUS).
import { requireAuthority } from '../_lib/authz.js';
import { getInboundSince, listAccountEmails } from '../_lib/accounts.js';
import { pollDueInboxes } from '../_lib/gmailPoll.js';

export default async function handler(req, res) {
  if (!(await requireAuthority(req, res))) return;
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed', emails: [] });
    return;
  }
  const since = Number(req.query.since) || 0;
  try {
    await pollDueInboxes();
    const rows = await getInboundSince(since);
    // personalInboxes rides along so the client fork routes on DB truth — the
    // blob's connectedInboxes was EMPTY in prod and silently diverted all
    // inbound mail away from Messaging (2026-06-21 → 2026-07-30).
    const personalInboxes = await listAccountEmails();
    res.status(200).json({
      ok: true,
      personalInboxes,
      cursor: rows.length ? rows[rows.length - 1].seq : since,
      emails: rows.map((r) => ({
        seq: r.seq,
        fromEmail: r.from_email,
        toInboxEmail: r.to_inbox_email,
        subject: r.subject,
        body: r.body,
        messageId: r.rfc_message_id,
        inReplyTo: r.in_reply_to,
        references: r.references_header,
      })),
    });
  } catch (err) {
    // Soft-fail — the listener simply retries on its next tick.
    res.status(200).json({ ok: false, error: err.message, cursor: since, emails: [] });
  }
}
