// POST /api/inbox/:id/test
// Sends a one-off test email through the connected Gmail account. Called by
// testInboxSend() in src/lib/connectedInboxes.js.

// AUTH (SEC-03): requireAuth — previously ungated, so anyone could send mail through
// the client's connected Gmail account via the "test" path.
//
// AUTH (#2): the test path is the same send primitive with a different label — it
// takes to/subject/body and puts real mail on the wire from a real mailbox — so it
// carries the identical per-mailbox ownership check as /send. Gating one and not the
// other would leave the hole open under another name.
import { requireInboxOwner } from '../../_lib/inboxOwnership.js';
import { performSend } from '../../_lib/sender.js';
import { allow } from '../../_lib/rateLimit.js';

// AUTH (C07): `orgUserId` MUST come from the verified claim and be spread LAST.
// This route passed `req.body` straight through, so a caller could supply their own
// `orgUserId` — which is what a `signatureRef` attachment is resolved against — and have
// the server mail them another user's signature object out of the private `ops-media`
// bucket. `/send.js` was fixed for exactly this and THIS ROUTE WAS MISSED, which is the
// hazard the note above already describes: the test path is the same send primitive
// under a different label, so a gate applied to one and not the other leaves the hole
// open under another name. It applied to the ownership check and to this equally.
export default async function handler(req, res) {
  const authority = await requireInboxOwner(req, res, req.query.id);
  if (!authority) return;
  // Tighter than /send: a test send is a one-off human action, never a workflow. Same
  // reasoning as the ownership gate and the orgUserId override — this route is the same
  // send primitive under a different label, so every control /send carries belongs here.
  if (!allow(req, res, { bucket: 'inbox-test', id: authority.orgUserId || 'anon', limit: 10, windowMs: 10 * 60_000 })) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    res.status(400).send('to, subject and body are required.');
    return;
  }
  try {
    const result = await performSend(req.query.id, { ...req.body, orgUserId: authority.orgUserId });
    res.status(200).json({ ok: true, id: result.id, status: 'sent' });
  } catch (err) {
    res.status(502).send(err.message || 'Test send failed.');
  }
}
