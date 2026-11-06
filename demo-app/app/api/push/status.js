// GET /api/push/status -> { [userId]: { deviceCount, lastSeenAt } }
//
// The Team view's per-user "is mobile push actually on for this person" indicator.
// Role-gated to the OFFICE tiers (lib/roles OFFICE_ROLES — the supply manager joined them in
// S131; the Team page mounts the column for the same set); crew cannot enumerate the team's
// device state. Returns ACTUAL subscription counts from
// push_subscriptions (the authoritative source), NOT the mobilePushEnabled intent
// pref: a user can have the pref on with no subscribed device (so it would never
// receive a push), and the whole point of this view is to catch exactly that gap.
import { requireRole, OFFICE_ROLES } from '../_lib/authz.js';
import { subscriptionCountsByUser } from '../_lib/push/store.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const g = await requireRole(req, res, OFFICE_ROLES);
    if (!g) return; // 401/403 already written
    // Every device row, read completely (CS-727); a read short of its count is a 503.
    const byUser = await subscriptionCountsByUser();
    res.status(200).json(byUser);
  } catch (e) {
    res.status(readErrorStatus(e)).json({ error: e.message });
  }
}
