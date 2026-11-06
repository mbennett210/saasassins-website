// POST /api/push/test → { ok, delivered, failed, expired }
//
// Auth-gated. Sends a canned push to all of the caller's subscribed devices so a
// user can confirm OS push works end-to-end on this device.
import { requireAuthority } from '../_lib/authz.js';
import { sendToUser, pushConfigured } from '../_lib/push/store.js';
import { IDENTITY } from '../../src/brand/identity.generated.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  // Inside the try: resolving authority now reads org_state, which throws on a
  // missing service-role key — that must surface as JSON, not an unhandled
  // rejection the client can only read as "Request failed (500)".
  try {
    // The login FIRST: a caller who has not passed it learns nothing about the configuration
    // (this answered "VAPID keys missing" to anyone before the check).
    const a = await requireAuthority(req, res);
    if (!a) return;
    if (!pushConfigured()) {
      console.error('[push/test] VAPID keys are not configured: push cannot be sent');
      res.status(503).json({ error: 'Push is not set up on this server yet.' });
      return;
    }
    if (!a.orgUserId) { res.status(403).json({ error: 'No matching team member for this account.' }); return; }
    const result = await sendToUser(a.orgUserId, {
      title: `${IDENTITY.product.wordmark} — test push`, // the app's own push: the software's name (UI_RULES §129)
      body: 'If you can read this, mobile push is wired correctly on this device.',
      url: '/',
      tag: 'cleanspace-test',
    });
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
