// GET /api/inbox/connect/start?workspace=<id>   (owner/admin) → { url }
//
// AUTHENTICATED initiation of the Gmail connect OAuth. Replaces the old
// /api/inbox/connect/google, which redirected to Google's consent screen with NO auth
// gate (2026-08-03 audit S3): anyone could start the flow and, after consenting with a
// mailbox they control, have the callback graft an attacker-controlled inbox into the
// org. Exactly like /api/reviews/oauth/start, authority is proven HERE — the popup
// can't carry our Bearer header — and the popup then opens the returned Google consent
// URL directly. The signed `state` binds the initiating org_user_id.
import { requirePermission } from '../../_lib/authz.js';
import { buildConsentUrl, buildRedirectUri } from '../../_lib/google.js';
import { signState } from '../../_lib/crypto.js';
import { resolveCredsForWorkspaceId } from '../../_lib/oauthWorkspaces.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Connecting a mailbox is a manager action (marketing.connectInbox / integrations).
  const a = await requirePermission(req, res, 'marketing.connectInbox');
  if (!a) return; // 401/403 already written

  try {
    const workspaceId =
      typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null;
    const creds = await resolveCredsForWorkspaceId(workspaceId);
    if (!creds || !creds.clientId || !creds.clientSecret) {
      return res.status(400).json({
        error: 'This Google Workspace isn’t configured yet. A Super Admin needs to add it (with its OAuth Client ID + secret) under Settings → Integrations → Google Workspaces before mailboxes can connect.',
      });
    }
    const state = signState({
      ts: Date.now(),
      nonce: Math.random().toString(36).slice(2),
      workspaceId,
      orgUserId: a.orgUserId || null,
    });
    const url = buildConsentUrl(state, buildRedirectUri(req.headers.host), creds);
    return res.status(200).json({ url });
  } catch (err) {
    return res.status(500).json({ error: `Could not start the Google connect flow: ${err.message}` });
  }
}
