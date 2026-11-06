// /api/email/system-sender — which connected Google mailbox the app's own email leaves
// from (invites, set-password links, quotes, reminders, client mail).
//
//   GET  → { sender, candidates: [{ id, email, displayName, status }] }
//   POST { inboxId }        → mark that mailbox as the sender
//   POST { inboxId: null }  → clear it (email is then skipped and Settings says so)
//
// 🔴 OWNER ONLY (requireRole, not requirePermission). Choosing the sender decides which
// mailbox every invite and set-password link in the company appears to come from, so it is
// a Super-Admin act in the same family as `settings.company.timezone` and the claim-writing
// routes: `can()` puts no key beyond a grant's reach, so a permission gate here could be
// granted to the very person it should stop (authz.js, "DO NOT use this BARE to gate the
// AUTHORITY surfaces"). A mailbox must already be connected to be nameable, which needs
// `marketing.connectInbox` — so this route widens nothing on its own.
//
// It writes no secret and returns none: the candidates carry an address, a display name and
// an OAuth status, never a token (THE LAW II.9).

import { requireRole } from '../_lib/authz.js';
import { getSupabase } from '../_lib/supabase.js';
import { setSystemSender, systemSenderStatus, systemSenderColumnExists } from '../_lib/systemSender.js';

// The mailboxes the owner may pick from. Selected column-by-column so a token column can
// never ride along in a `select('*')`.
async function listCandidates() {
  const cols = (await systemSenderColumnExists())
    ? 'id, email, display_name, status, is_system_sender'
    : 'id, email, display_name, status';
  const { data, error } = await getSupabase().from('inbox_accounts').select(cols).order('email');
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name || r.email,
    status: r.status || null,
    isSystemSender: r.is_system_sender === true,
  }));
}

export default async function handler(req, res) {
  const a = await requireRole(req, res, ['owner']);
  if (!a) return; // 401/403 already written

  if (req.method === 'GET') {
    try {
      res.status(200).json({ sender: await systemSenderStatus(), candidates: await listCandidates() });
    } catch (err) {
      res.status(502).json({ error: `Could not read the connected mailboxes: ${err.message}` });
    }
    return;
  }

  if (req.method === 'POST') {
    const raw = req.body || {};
    // Absent and null both mean "clear it"; anything else must be a string id.
    const inboxId = raw.inboxId == null ? null : String(raw.inboxId);
    try {
      await setSystemSender(inboxId);
      res.status(200).json({ ok: true, sender: await systemSenderStatus() });
    } catch (err) {
      const code = err?.code;
      const status = code === 'pinned' ? 409 : code === 'not-found' ? 404 : code === 'not-provisioned' ? 409 : 502;
      res.status(status).json({ error: err.message || 'Could not set the sending mailbox.', ...(code ? { code } : {}) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
