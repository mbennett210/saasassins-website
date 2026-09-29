// GET /api/push/devices → [{ subscriptionId, deviceLabel, endpointMasked, lastSeenAt }]
//
// Auth-gated; returns only the caller's own subscribed devices (resolved from
// their JWT claim, not a client-supplied userId).
import { requireAuthority } from '../_lib/authz.js';
import { listSubscriptions, maskDevices } from '../_lib/push/store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  // Inside the try: resolving authority now reads org_state, which throws on a
  // missing service-role key — that must surface as JSON, not an unhandled
  // rejection the client can only read as "Request failed (500)".
  try {
    const a = await requireAuthority(req, res);
    if (!a) return;
    if (!a.orgUserId) { res.status(403).json({ error: 'No matching team member for this account.' }); return; }
    const rows = await listSubscriptions(a.orgUserId);
    res.status(200).json(maskDevices(rows));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
