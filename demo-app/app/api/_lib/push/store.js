// Web Push backend — subscription storage + sending. Service-role only; never
// import client-side. Mirrors the api/_lib/{time,accountMedia}/store.js pattern.
//
// Subscriptions live in the relational `push_subscriptions` table (not the
// org_state blob) — they are per-device, high-churn, and security-sensitive, so
// they don't belong in the shared CAS document. Sending uses the `web-push`
// library with the server-only VAPID private key.

import webpush from 'web-push';
import { getSupabase } from '../supabase.js';
import { IDENTITY } from '../../../src/brand/identity.generated.js';

// Pin to the same org the rest of the backend uses (orgState.js / sync.js).
const ORG_ID = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';

// True only when the VAPID keypair is provisioned. Routes degrade gracefully
// (no-op, no 500) when it isn't, so a deploy without keys still serves the app.
export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return true;
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || `mailto:${IDENTITY.company.email}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  vapidReady = true;
  return true;
}

// (Removed in Increment 1c: this resolved the caller's `u_*` id through the
// browser-writable org_state roster. The push routes now take it from the
// service-role-only JWT claim — see authz.resolveAuthority — so a signed-in
// user still can only manage their OWN subscriptions, but the binding is no
// longer forgeable by editing the blob.)

export async function upsertSubscription({ userId, subscription, deviceLabel }) {
  const sub = subscription || {};
  const endpoint = sub.endpoint;
  const keys = sub.keys || {};
  if (!userId) throw new Error('userId is required');
  if (!endpoint || !keys.p256dh || !keys.auth) throw new Error('Invalid push subscription');
  const { error } = await getSupabase().from('push_subscriptions').upsert(
    {
      organization_id: ORG_ID,
      user_id: userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      device_label: deviceLabel || null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,endpoint' },
  );
  if (error) throw new Error(`subscribe failed: ${error.message}`);
  return { ok: true };
}

export async function removeSubscription({ userId, endpoint }) {
  if (!userId || !endpoint) throw new Error('userId and endpoint are required');
  // Always scope the delete to the caller's own rows.
  const { error } = await getSupabase().from('push_subscriptions').delete()
    .eq('organization_id', ORG_ID).eq('user_id', userId).eq('endpoint', endpoint);
  if (error) throw new Error(`unsubscribe failed: ${error.message}`);
  return { ok: true };
}

export async function listSubscriptions(userId) {
  const { data, error } = await getSupabase().from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, device_label, last_seen_at')
    .eq('organization_id', ORG_ID).eq('user_id', userId);
  if (error) throw new Error(`device list failed: ${error.message}`);
  return data || [];
}

// Shape subscription rows for the Account → Notifications device list. The full
// `endpoint` is returned because the Remove-device action needs it; only the
// crypto keys (p256dh / auth) are withheld. `endpointMasked` is for display.
export function maskDevices(rows) {
  return (rows || []).map((r) => ({
    subscriptionId: r.id,
    deviceLabel: r.device_label || 'This device',
    endpoint: r.endpoint,
    endpointMasked: (r.endpoint || '').slice(0, 28) + '…',
    lastSeenAt: r.last_seen_at,
  }));
}

// Per-user subscription rollup for the Team view: how many devices each user has
// subscribed and when any was last seen. Service-role only; the caller
// (api/push/status) is role-gated to owner/admin/manager. One query, aggregated in
// JS. This is the AUTHORITATIVE "is mobile push actually on for this person" signal
// (an actual subscribed device), distinct from the mobilePushEnabled intent pref.
export async function subscriptionCountsByUser() {
  const { data, error } = await getSupabase().from('push_subscriptions')
    .select('user_id, last_seen_at')
    .eq('organization_id', ORG_ID);
  if (error) throw new Error(`push status read failed: ${error.message}`);
  const byUser = {};
  for (const r of data || []) {
    if (!r.user_id) continue;
    const cur = byUser[r.user_id] || { deviceCount: 0, lastSeenAt: null };
    cur.deviceCount += 1;
    if (r.last_seen_at && (!cur.lastSeenAt || r.last_seen_at > cur.lastSeenAt)) cur.lastSeenAt = r.last_seen_at;
    byUser[r.user_id] = cur;
  }
  return byUser;
}

// Send a payload to an explicit set of subscription rows. Expired endpoints
// (404/410) are pruned. Returns { delivered, failed, expired }.
export async function sendToSubscriptions(subs, payload) {
  if (!ensureVapid()) return { delivered: 0, failed: 0, expired: 0, skipped: 'vapid_unconfigured' };
  const body = JSON.stringify(payload || {});
  let delivered = 0;
  let failed = 0;
  let expired = 0;
  const dead = [];
  await Promise.all((subs || []).map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, body);
      delivered += 1;
    } catch (err) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) { expired += 1; dead.push(s.endpoint); }
      else failed += 1;
    }
  }));
  if (dead.length) {
    try {
      await getSupabase().from('push_subscriptions').delete()
        .eq('organization_id', ORG_ID).in('endpoint', dead);
    } catch { /* best-effort prune; the next 410 prunes it anyway */ }
  }
  return { delivered, failed, expired };
}

// Convenience: send to all of a user's devices.
export async function sendToUser(userId, payload) {
  if (!ensureVapid()) return { delivered: 0, failed: 0, expired: 0, skipped: 'vapid_unconfigured' };
  const subs = await listSubscriptions(userId);
  return sendToSubscriptions(subs, payload);
}
