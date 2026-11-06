// POST /api/inbox/:id/disconnect
// Revokes the Google token and deletes the account (sent_messages cascade).
// Called by disconnectInbox() in src/lib/connectedInboxes.js.

// AUTH (SEC-03): requireAuth — previously ungated, so anyone who knew an inbox id could
// revoke the client's Gmail connection and delete the account (a denial-of-service on
// their entire outbound email).
import { getAccount, deleteAccount } from '../../_lib/accounts.js';
import { requireInboxAdmin } from '../../_lib/inboxOwnership.js';
import { decrypt } from '../../_lib/crypto.js';
import { revokeToken } from '../../_lib/google.js';

export default async function handler(req, res) {
  // Revoking a mailbox is an administrative act: it kills the Google token and
  // deletes the account row, whose sent_messages cascade destroys the Message-ID
  // set, so reply threading stays broken even after reconnecting. requireAuth let
  // any of the 37 crew accounts do that to any mailbox.
  //
  // ── 🔴 THE GATE, REWORKED (CS-088, 2026-09-29) ────────────────────────────────
  // It required `marketing.connectInbox`, and Settings → Connected Inboxes (a
  // `messaging.startConversation` page) shows a Disconnect button on your own personal
  // mailbox. `marketing.connectInbox` cannot be granted or revoked in Settings → Roles
  // while marketing is dormant (Roles.jsx hides the marketing keys), so a holder without
  // it saw a button that 403'd and no way to fix it. And any holder could disconnect ANY
  // mailbox — `:id` was never ownership-checked.
  //
  // Now: the mailbox's OWNER may disconnect it, and so may a holder of
  // `messaging.manageInboxes` (a visible Messaging key, owner/admin/manager by default)
  // for any mailbox. `marketing.connectInbox` still passes on its own so the Marketing →
  // Inboxes surface is never tightened.
  if (!(await requireInboxAdmin(req, res, req.query.id))) return;
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
