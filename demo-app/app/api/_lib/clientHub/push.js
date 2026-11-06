// THE CUSTOMER HUB'S PHONE ALERTS (Crew on the way; migration 20261103120000). Service-role only —
// never import client-side.
//
// `client_push_subscriptions` holds one row per phone or computer on which a customer login turned
// alerts on (the hub's Home row or Account switch → api/hub POST push). The staff's devices stay in
// push_subscriptions, which no customer login can reach. Every read and write here names the org
// AND the caller's own client_user_id from the verified claim, never a body's.
//
// A row goes when the switch is turned off (removeClientPush), when the push service answers 404
// or 410 for it (push/store.sendToSubscriptions prunes it at the send), and with the login
// (on delete cascade from client_users).
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { sendToSubscriptions, pushConfigured } from '../push/store.js';

export const CLIENT_PUSH_TABLE = 'client_push_subscriptions';
const ORG = CLEANSPACE_ORG_ID;
const scoped = (q) => q.eq('organization_id', ORG);
const db = () => getSupabase();
const IN_CHUNK = 100;

function unwrap(res, what) {
  if (res.error) throw Object.assign(new Error(`${what}: ${res.error.message}`), { code: res.error.code || null });
  return res.data;
}

// Turn alerts on for this phone (`value` from lib/crewOnTheWay hubPushInput). The push address is
// unique per org: the same phone turned on again updates in place, and a phone that changes hands
// moves to the login that turned it on last.
export async function upsertClientPush({ clientUserId, value }) {
  if (!clientUserId || !value?.endpoint) throw new Error('clientUserId and a subscription are required');
  unwrap(await db().from(CLIENT_PUSH_TABLE).upsert({
    organization_id: ORG,
    client_user_id: clientUserId,
    endpoint: value.endpoint,
    p256dh: value.p256dh,
    auth: value.auth,
    device_label: value.deviceLabel || null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'organization_id,endpoint' }), 'client push subscribe');
  return true;
}

// Turn alerts off for this phone: the caller's own row for this address, nothing else.
export async function removeClientPush({ clientUserId, endpoint }) {
  if (!clientUserId || !endpoint) throw new Error('clientUserId and endpoint are required');
  unwrap(await scoped(db().from(CLIENT_PUSH_TABLE).delete())
    .eq('client_user_id', clientUserId).eq('endpoint', endpoint), 'client push unsubscribe');
  return true;
}

// Is this phone signed up for this login?
export async function clientPushOn({ clientUserId, endpoint }) {
  if (!clientUserId || !endpoint) return false;
  const rows = unwrap(await scoped(db().from(CLIENT_PUSH_TABLE).select('id'))
    .eq('client_user_id', clientUserId).eq('endpoint', endpoint).limit(1), 'client push read');
  return (rows || []).length > 0;
}

// Every phone of these logins (a building's audience: clientHub/store clientUsersWhoCanSee).
export async function clientPushRows(clientUserIds) {
  const ids = [...new Set((clientUserIds || []).filter(Boolean))];
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = unwrap(await scoped(db().from(CLIENT_PUSH_TABLE).select('id, client_user_id, endpoint, p256dh, auth'))
      .in('client_user_id', ids.slice(i, i + IN_CHUNK)).order('id', { ascending: true }), 'client push rows');
    out.push(...(rows || []));
  }
  return out;
}

// Send one alert to every phone of these logins. Best-effort for the caller: { delivered, failed,
// expired } or { skipped } — the push keys unset (a deploy without them still serves the app).
export async function sendClientAlert(clientUserIds, payload) {
  if (!pushConfigured()) return { delivered: 0, failed: 0, expired: 0, skipped: 'vapid_unconfigured' };
  const rows = await clientPushRows(clientUserIds);
  if (!rows.length) return { delivered: 0, failed: 0, expired: 0 };
  return sendToSubscriptions(rows, payload, { table: CLIENT_PUSH_TABLE });
}
