// POST /api/inbox/:id/disconnect
// Revokes the Google token and deletes the account (sent_messages cascade).
// Called by disconnectInbox() in src/lib/connectedInboxes.js.

// AUTH (SEC-03): requireAuth — previously ungated, so anyone who knew an inbox id could
// revoke the client's Gmail connection and delete the account (a denial-of-service on
// their entire outbound email).
import { requirePermission } from '../../_lib/authz.js';
import { getAccount, deleteAccount } from '../../_lib/accounts.js';
import { decrypt } from '../../_lib/crypto.js';
import { revokeToken } from '../../_lib/google.js';

export default async function handler(req, res) {
  // Revoking a mailbox is an administrative act: it kills the Google token and
  // deletes the account row, whose sent_messages cascade destroys the Message-ID
  // set, so reply threading stays broken even after reconnecting. requireAuth let
  // any of the 37 crew accounts do that to any mailbox. Only Settings -> Connected
  // Inboxes and Marketing -> Inboxes call this, and both are owner/admin UI
  // (marketing.connectInbox = owner+admin, integrations.manage = owner).
  //
  // NOT applied to send.js/test.js in this change: messaging.use is ALWAYS_GRANTED,
  // so crew legitimately send through /inbox/:id/send from Messaging. Those need a
  // per-mailbox OWNERSHIP check, and inbox_accounts has no owner column yet — see
  // AUTHORIZATION_AUDIT.md. A role gate there would be an outage for 37 users.
  if (!(await requirePermission(req, res, 'marketing.connectInbox'))) return;
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  try {
    const account = await getAccount(req.query.id);
    if (account) {
      try {
        await revokeToken(decrypt(account.refresh_token_enc));
      } catch {
        // Revocation is best effort — the row is removed regardless.
      }
      await deleteAccount(account.id);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).send(err.message || 'Disconnect failed.');
  }
}
