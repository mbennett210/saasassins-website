// Account + buffer persistence for the connected-inbox backend. Wraps Supabase
// access and the OAuth token-refresh cycle. Tokens are only ever stored
// encrypted (see crypto.js) and never returned to the browser.

import crypto from 'node:crypto';
import { getSupabase } from './supabase.js';
import { encrypt, decrypt } from './crypto.js';
import { refreshAccessToken } from './google.js';
import { resolveCredsForWorkspaceId } from './oauthWorkspaces.js';

export function newInboxId() {
  return `inbx_${crypto.randomBytes(9).toString('hex')}`;
}

export async function getAccount(id) {
  const { data, error } = await getSupabase()
    .from('inbox_accounts').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Inbox lookup failed: ${error.message}`);
  return data;
}

export async function getAccountByEmail(email) {
  const { data, error } = await getSupabase()
    .from('inbox_accounts').select('*')
    .eq('email', String(email).toLowerCase()).maybeSingle();
  if (error) throw new Error(`Inbox lookup failed: ${error.message}`);
  return data;
}

// Active accounts not polled within `throttleMs` — the inbound endpoint's
// self-throttle so a 60s client poll doesn't hammer Gmail.
export async function listAccountsDueForPoll(throttleMs = 60 * 1000) {
  const { data, error } = await getSupabase()
    .from('inbox_accounts').select('*').eq('status', 'active');
  if (error) throw new Error(`Inbox list failed: ${error.message}`);
  const now = Date.now();
  return (data || []).filter(
    (a) => !a.last_polled_at || now - new Date(a.last_polled_at).getTime() >= throttleMs
  );
}

export async function upsertAccount({ id, email, displayName, provider, refreshToken, accessToken, accessTokenExpiresAt, historyId, workspaceId }) {
  const row = {
    id,
    email: String(email).toLowerCase(),
    display_name: displayName || email,
    provider: provider || 'google',
    refresh_token_enc: encrypt(refreshToken),
    access_token_enc: accessToken ? encrypt(accessToken) : null,
    access_token_expires_at: accessTokenExpiresAt || null,
    history_id: historyId || null,
    // Which Workspace's OAuth app minted these tokens — drives which creds we
    // refresh with. null = legacy single env app.
    workspace_id: workspaceId || null,
    status: 'active',
    last_error: null,
  };
  const { error } = await getSupabase()
    .from('inbox_accounts').upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`Inbox save failed: ${error.message}`);
}

export async function updateAccountPollState(id, { historyId, lastError } = {}) {
  const patch = { last_polled_at: new Date().toISOString() };
  if (historyId !== undefined) patch.history_id = historyId;
  if (lastError !== undefined) patch.last_error = lastError;
  const { error } = await getSupabase()
    .from('inbox_accounts').update(patch).eq('id', id);
  if (error) throw new Error(`Inbox update failed: ${error.message}`);
}

export async function deleteAccount(id) {
  const { error } = await getSupabase()
    .from('inbox_accounts').delete().eq('id', id);
  if (error) throw new Error(`Inbox delete failed: ${error.message}`);
}

// Returns a valid access token, refreshing + persisting it when within 2
// minutes of expiry. Mutates `account` so the rest of the request sees it.
export async function getFreshAccessToken(account) {
  const expiresAt = account.access_token_expires_at
    ? new Date(account.access_token_expires_at).getTime() : 0;
  if (account.access_token_enc && expiresAt - Date.now() > 2 * 60 * 1000) {
    return decrypt(account.access_token_enc);
  }
  const creds = await resolveCredsForWorkspaceId(account.workspace_id);
  let refreshed;
  try {
    refreshed = await refreshAccessToken(decrypt(account.refresh_token_enc), creds);
  } catch (err) {
    // A revoked/expired refresh token is permanent until the user reconnects —
    // flag the account so it leaves polling/rotation and the UI can prompt (INT-01).
    const msg = String(err?.message || err);
    if (/invalid_grant|invalid_request|unauthor|401|403|expired|revoked/i.test(msg)) {
      try {
        await getSupabase().from('inbox_accounts')
          .update({ status: 'expired', last_error: msg.slice(0, 300) })
          .eq('id', account.id);
      } catch { /* best-effort — don't mask the original error */ }
    }
    throw err;
  }
  const accessToken = refreshed.access_token;
  const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  const enc = encrypt(accessToken);
  const { error } = await getSupabase().from('inbox_accounts').update({
    access_token_enc: enc,
    access_token_expires_at: newExpiry,
  }).eq('id', account.id);
  if (error) throw new Error(`Token cache update failed: ${error.message}`);
  account.access_token_enc = enc;
  account.access_token_expires_at = newExpiry;
  return accessToken;
}

export async function recordSentMessage(inboxId, rfcMessageId) {
  if (!rfcMessageId) return;
  const { error } = await getSupabase()
    .from('sent_messages').insert({ inbox_id: inboxId, rfc_message_id: rfcMessageId });
  if (error) throw new Error(`Sent-message log failed: ${error.message}`);
}

// RFC Message-IDs sent from this inbox in the last `sinceDays` days — the set
// an inbound reply's In-Reply-To / References is matched against.
export async function getSentMessageIds(inboxId, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('sent_messages').select('rfc_message_id')
    .eq('inbox_id', inboxId).gte('sent_at', since);
  if (error) throw new Error(`Sent-message lookup failed: ${error.message}`);
  return new Set((data || []).map((r) => r.rfc_message_id));
}

// Every connected inbox email, regardless of poll status — the ROUTING truth
// for "did this mail land on a personal inbox". The ingest fork used to read
// the blob's `connectedInboxes`, which was EMPTY in production while the real
// accounts lived here — so 100% of inbound mail was diverted away from
// Messaging from 2026-06-21 until this fix (the frozen "End of shift
// reporting" thread). The DB table is the only source that provably matches
// what the poller actually polls.
export async function listAccountEmails() {
  const { data, error } = await getSupabase().from('inbox_accounts').select('email');
  if (error) throw new Error(`Account list failed: ${error.message}`);
  return (data || []).map((r) => (r.email || '').toLowerCase()).filter(Boolean);
}

export async function bufferInbound(rows) {
  if (!rows.length) return;
  const { error } = await getSupabase()
    .from('inbound_emails')
    .upsert(rows, { onConflict: 'gmail_message_id', ignoreDuplicates: true });
  if (error) throw new Error(`Inbound buffer write failed: ${error.message}`);
}

export async function getInboundSince(since, limit = 100) {
  const { data, error } = await getSupabase()
    .from('inbound_emails').select('*')
    .gt('seq', Number(since) || 0)
    .order('seq', { ascending: true }).limit(limit);
  if (error) throw new Error(`Inbound read failed: ${error.message}`);
  return data || [];
}
