// POST /api/push/test → { ok, delivered, failed, expired }
//
// Auth-gated. Sends a canned push to all of the caller's subscribed devices so a
// user can confirm OS push works end-to-end on this device.
import { requireAuthority } from '../_lib/authz.js';
import { sendToUser, pushConfigured } from '../_lib/push/store.js';
import { IDENTITY } from '../../src/brand/identity.generated.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!pushConfigured()) {
    res.status(503).json({ error: 'Push is not configured for this deployment (VAPID keys missing).' });
    return;
  }
  // Inside the try: resolving authority now reads org_state, which throws on a
  // missing service-role key — that must surface as JSON, not an unhandled
  // rejection the client can only read as "Request failed (500)".
  try {
    const a = await requireAuthority(req, res);
    if (!a) return;
    if (!a.orgUserId) { res.status(403).json({ error: 'No matching team member for this account.' }); return; }
    const result = await sendToUser(a.orgUserId, {
      title: `${IDENTITY.wordmark} — test push`,
      body: 'If you can read this, mobile push is wired correctly on this device.',
      url: '/',
      tag: 'cleanspace-test',
    });
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
