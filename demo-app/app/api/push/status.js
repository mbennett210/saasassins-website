// GET /api/push/status -> { [userId]: { deviceCount, lastSeenAt } }
//
// The Team view's per-user "is mobile push actually on for this person" indicator.
// Role-gated to owner/admin/manager (the tiers that manage the team); crew cannot
// enumerate the team's device state. Returns ACTUAL subscription counts from
// push_subscriptions (the authoritative source), NOT the mobilePushEnabled intent
// pref: a user can have the pref on with no subscribed device (so it would never
// receive a push), and the whole point of this view is to catch exactly that gap.
import { requireRole } from '../_lib/authz.js';
import { subscriptionCountsByUser } from '../_lib/push/store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const g = await requireRole(req, res, ['owner', 'admin', 'manager']);
    if (!g) return; // 401/403 already written
    const byUser = await subscriptionCountsByUser();
    res.status(200).json(byUser);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
