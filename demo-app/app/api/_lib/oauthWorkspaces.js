// Backend store for the multi-Workspace OAuth registry. Wraps Supabase access
// for the `oauth_workspaces` table. The client_secret is only ever stored
// encrypted (AES-256-GCM, see crypto.js) and decrypted in-process for the OAuth
// token exchange/refresh — it is NEVER returned to the browser. The frontend
// receives display metadata only (label, domains, clientId, secret last4,
// status).

import crypto from 'node:crypto';
import { getSupabase } from './supabase.js';
import { encrypt, decrypt } from './crypto.js';

export function newWorkspaceId() {
  return `ws_${crypto.randomBytes(8).toString('hex')}`;
}

// Browser-safe projection of a row — no secret material.
function metadata(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    domains: row.domains || [],
    clientId: row.client_id,
    clientSecretLast4: row.client_secret_last4 || null,
    status: row.status,
    isPrimary: !!row.is_primary,
    lastError: row.last_error || null,
  };
}

export async function listWorkspaces() {
  const { data, error } = await getSupabase()
    .from('oauth_workspaces').select('*').order('created_at', { ascending: true });
  if (error) throw new Error(`Workspace list failed: ${error.message}`);
  return (data || []).map(metadata);
}

export async function getWorkspaceMeta(id) {
  const { data, error } = await getSupabase()
    .from('oauth_workspaces').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Workspace lookup failed: ${error.message}`);
  return metadata(data);
}

// Decrypted OAuth credentials. OAuth flow ONLY — never serialize this to a
// response body. Returns null when the workspace doesn't exist.
export async function getWorkspaceCreds(id) {
  const { data, error } = await getSupabase()
    .from('oauth_workspaces').select('client_id, client_secret_enc').eq('id', id).maybeSingle();
  if (error) throw new Error(`Workspace creds lookup failed: ${error.message}`);
  if (!data) return null;
  return { clientId: data.client_id, clientSecret: decrypt(data.client_secret_enc) };
}

export async function createWorkspace({ label, domains, clientId, clientSecret, isPrimary }) {
  const id = newWorkspaceId();
  const secret = String(clientSecret || '');
  const row = {
    id,
    label: String(label),
    domains: Array.isArray(domains) ? domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : [],
    client_id: String(clientId).trim(),
    client_secret_enc: encrypt(secret),
    client_secret_last4: secret.slice(-4),
    status: 'pending',
    is_primary: isPrimary === true,
  };
  const { error } = await getSupabase().from('oauth_workspaces').insert(row);
  if (error) throw new Error(`Workspace create failed: ${error.message}`);
  return metadata({ ...row, last_error: null });
}

export async function updateWorkspace(id, patch = {}) {
  const row = { updated_at: new Date().toISOString() };
  if (patch.label != null) row.label = String(patch.label);
  if (Array.isArray(patch.domains)) row.domains = patch.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (patch.status != null) row.status = String(patch.status);
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.clientId != null) row.client_id = String(patch.clientId).trim();
  if (patch.clientSecret != null) {
    const secret = String(patch.clientSecret);
    row.client_secret_enc = encrypt(secret);
    row.client_secret_last4 = secret.slice(-4);
  }
  const { data, error } = await getSupabase()
    .from('oauth_workspaces').update(row).eq('id', id).select('*').maybeSingle();
  if (error) throw new Error(`Workspace update failed: ${error.message}`);
  return metadata(data);
}

export async function deleteWorkspace(id) {
  const { error } = await getSupabase().from('oauth_workspaces').delete().eq('id', id);
  if (error) throw new Error(`Workspace delete failed: ${error.message}`);
}

// True when any connected mailbox still routes through this Workspace — block
// deletion so we don't strand live tokens.
export async function workspaceInUse(id) {
  const { count, error } = await getSupabase()
    .from('inbox_accounts').select('id', { count: 'exact', head: true }).eq('workspace_id', id);
  if (error) throw new Error(`Workspace usage check failed: ${error.message}`);
  return (count || 0) > 0;
}

// Resolve the OAuth credentials an inbox/connect should use: the Workspace's own
// creds when a workspaceId is given (and exists); otherwise the legacy single
// env OAuth app. Returns { clientId, clientSecret } — either field may be null,
// which the caller must treat as "not configured".
export async function resolveCredsForWorkspaceId(workspaceId) {
  if (workspaceId) {
    return getWorkspaceCreds(workspaceId); // null when the workspace is gone
  }
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || null,
  };
}
