// POST   /api/push/subscribe  { subscription, deviceLabel } → { ok }
// DELETE /api/push/subscribe  { endpoint }                  → { ok }
//
// Auth-gated. The caller's `u_*` id comes from their JWT claim (service-role-
// only), NOT the client-supplied userId and not the browser-writable blob — so
// a signed-in user can only manage their OWN device subscriptions.
import { requireAuthority } from '../_lib/authz.js';
import { upsertSubscription, removeSubscription } from '../_lib/push/store.js';

export default async function handler(req, res) {
  let a;
  try {
    a = await requireAuthority(req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }
  if (!a) return; // 401 already written
  if (!a.orgUserId) {
    res.status(403).json({ error: 'No matching team member for this account.' });
    return;
  }

  try {
    if (req.method === 'POST') {
      const { subscription, deviceLabel } = req.body || {};
      await upsertSubscription({ userId: a.orgUserId, subscription, deviceLabel });
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'DELETE') {
      const { endpoint } = req.body || {};
      if (!endpoint) { res.status(400).json({ error: 'endpoint is required' }); return; }
      await removeSubscription({ userId: a.orgUserId, endpoint });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
