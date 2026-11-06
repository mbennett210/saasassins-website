// Service-role data layer for the QuickBooks Online integration. Four tables, all
// service-role-only (RLS enabled, NO policies) and keyed by CLEANSPACE_ORG_ID. The browser
// never touches them — only /api/quickbooks/* does, re-checking authority from JWT claims.
// Tokens are AES-256-GCM encrypted at rest with a DEDICATED key (QBO_TOKEN_ENCRYPTION_KEY),
// never the inbox key (THE LAW II.9).
import { createHash } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { encrypt, decrypt } from '../crypto.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { QBO_KEY_ENV } from './config.js';

const ORG = CLEANSPACE_ORG_ID;
const nowIso = () => new Date().toISOString();

// A store (database) failure, with a machine code so the route's catch can log WHAT failed
// (CS-571: a plain Error has no `.code`, so the log said only "error"). The message names the
// table and carries Supabase's own text — never a token: no token material reaches a query.
export class QboStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QboStoreError';
    this.code = 'store_error';
  }
}
const fail = (what, error) => new QboStoreError(`${what} failed: ${error?.message || 'unknown'}`);

// ── connection (one row per org) ─────────────────────────────────────────────

export async function getConnection() {
  const { data, error } = await getSupabase()
    .from('qbo_connection').select('*').eq('organization_id', ORG).maybeSingle();
  if (error) throw fail('qbo_connection read', error);
  return data ?? null;
}

// The connection ONLY when its environment matches the configured one — sandbox tokens must
// never be sent to production or the reverse (decision 6). Returns null otherwise.
export async function getConnectionForEnv(environment) {
  const row = await getConnection();
  return row && row.environment === environment ? row : null;
}

export function decryptAccessToken(row) { return decrypt(row.access_token_enc, QBO_KEY_ENV); }
export function decryptRefreshToken(row) { return decrypt(row.refresh_token_enc, QBO_KEY_ENV); }

// Fresh connect (or reconnect): replace the whole row. token_version resets to 1; the single
// row is upserted on organization_id.
export async function saveConnection({
  environment, realmId, companyName, accessToken, accessTokenExpiresAt,
  refreshToken, refreshTokenExpiresAt, refreshTokenHardExpiresAt, connectedBy,
}) {
  const row = {
    organization_id: ORG,
    environment,
    realm_id: realmId,
    company_name: companyName ?? null,
    access_token_enc: accessToken ? encrypt(accessToken, QBO_KEY_ENV) : null,
    access_token_expires_at: accessTokenExpiresAt ?? null,
    refresh_token_enc: refreshToken ? encrypt(refreshToken, QBO_KEY_ENV) : null,
    refresh_token_expires_at: refreshTokenExpiresAt ?? null,
    refresh_token_hard_expires_at: refreshTokenHardExpiresAt ?? null,
    token_version: 1,
    refresh_lease_until: null,
    status: 'active',
    last_error: null,
    connected_by: connectedBy ?? null,
    connected_at: nowIso(),
    last_synced_at: null,
    updated_at: nowIso(),
  };
  const { error } = await getSupabase().from('qbo_connection').upsert(row, { onConflict: 'organization_id' });
  if (error) throw fail('qbo_connection write', error);
}

// Optimistic CAS on token_version — the single-flight refresh's only write primitive. Returns
// true iff exactly one row still carried `expectedVersion` (so the caller won the race).
export async function casUpdateConnection(expectedVersion, patch) {
  const { data, error } = await getSupabase()
    .from('qbo_connection')
    .update({ ...patch, updated_at: nowIso() })
    .eq('organization_id', ORG).eq('token_version', expectedVersion)
    .select('token_version');
  if (error) throw fail('qbo_connection CAS', error);
  return Array.isArray(data) && data.length === 1;
}

// Non-CAS patch (status / company name / last_synced_at) — no token material moves here.
export async function patchConnection(patch) {
  const { error } = await getSupabase()
    .from('qbo_connection').update({ ...patch, updated_at: nowIso() }).eq('organization_id', ORG);
  if (error) throw fail('qbo_connection patch', error);
}

export async function deleteConnection() {
  const { error } = await getSupabase().from('qbo_connection').delete().eq('organization_id', ORG);
  if (error) throw fail('qbo_connection delete', error);
}

// ── property links (client_id → QBO entity) ──────────────────────────────────

export async function listLinks() {
  const { data, error } = await getSupabase()
    .from('qbo_property_links').select('*').eq('organization_id', ORG);
  if (error) throw fail('qbo_property_links read', error);
  return data || [];
}

// Allowlisted columns only — never a spread of a request body (3.4.8).
export async function putLink({ clientId, realmId, entityType, entityId, entityName, linkedBy }) {
  const row = {
    organization_id: ORG,
    client_id: clientId,
    realm_id: realmId,
    entity_type: entityType,
    entity_id: entityId,
    entity_name: entityName ?? null,
    linked_by: linkedBy ?? null,
    updated_at: nowIso(),
  };
  const { error } = await getSupabase()
    .from('qbo_property_links').upsert(row, { onConflict: 'organization_id,client_id' });
  if (error) throw fail('qbo_property_links write', error);
}

export async function deleteLink(clientId) {
  const { error } = await getSupabase()
    .from('qbo_property_links').delete().eq('organization_id', ORG).eq('client_id', clientId);
  if (error) throw fail('qbo_property_links delete', error);
}

// ── report cache: retention AT THE WRITE POINT (CS-566, THE LAW II.8) ──────────
// A P&L key embeds its window's dates, so every new day mints new keys and an upsert alone
// never bounds the table (the migration's "bounded by construction" was false). Every write
// therefore reaps: rows older than REPORT_CACHE_MAX_AGE_MS go (no reader serves a row past the
// nightly cycle's 26 h), then anything past the newest REPORT_CACHE_MAX_ROWS. The nightly
// refresh reaps again at its end. A reap failure is logged, never thrown: it must not fail the
// read that is writing a fresh row.
export const REPORT_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // three days
export const REPORT_CACHE_MAX_ROWS = 500;

export async function readReportCache(cacheKey) {
  const { data, error } = await getSupabase()
    .from('qbo_report_cache').select('payload, fetched_at')
    .eq('organization_id', ORG).eq('cache_key', cacheKey).maybeSingle();
  if (error) throw fail('qbo_report_cache read', error);
  return data ?? null;
}

export async function writeReportCache(cacheKey, payload) {
  const { error } = await getSupabase().from('qbo_report_cache').upsert(
    { organization_id: ORG, cache_key: cacheKey, payload, fetched_at: nowIso() },
    { onConflict: 'organization_id,cache_key' },
  );
  if (error) throw fail('qbo_report_cache write', error);
  await reapReportCache();
}

// The age ceiling, then the count cap. Returns { aged, capped } (rows removed); never throws.
export async function reapReportCache({ maxAgeMs = REPORT_CACHE_MAX_AGE_MS, maxRows = REPORT_CACHE_MAX_ROWS } = {}) {
  const supa = getSupabase();
  let aged = 0;
  let capped = 0;
  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const { data, error } = await supa.from('qbo_report_cache').delete()
      .eq('organization_id', ORG).lt('fetched_at', cutoff).select('cache_key');
    if (error) throw fail('qbo_report_cache reap', error);
    aged = Array.isArray(data) ? data.length : 0;
    // Past the cap: the oldest rows beyond the newest `maxRows`, a bounded page at a time.
    const { data: over, error: overErr } = await supa.from('qbo_report_cache').select('cache_key')
      .eq('organization_id', ORG).order('fetched_at', { ascending: false }).order('cache_key')
      .range(maxRows, maxRows + 999);
    if (overErr) throw fail('qbo_report_cache cap', overErr);
    const keys = (over || []).map((r) => r.cache_key);
    if (keys.length) {
      const { error: delErr } = await supa.from('qbo_report_cache').delete().eq('organization_id', ORG).in('cache_key', keys);
      if (delErr) throw fail('qbo_report_cache cap', delErr);
      capped = keys.length;
    }
  } catch (e) {
    console.error(`[api/quickbooks] report cache reap failed: ${e?.code || 'error'} ${String(e?.message || '').slice(0, 160)}`);
  }
  return { aged, capped };
}

export async function purgeReportCache() {
  const { error } = await getSupabase().from('qbo_report_cache').delete().eq('organization_id', ORG);
  if (error) throw fail('qbo_report_cache purge', error);
}

// ── single-use OAuth state nonces ────────────────────────────────────────────
// Only a HASH of the nonce is stored, bound to the org user it was minted for. Expired rows
// are purged at the write point, so the table is bounded by construction.

export function hashNonce(nonce) {
  return createHash('sha256').update(String(nonce)).digest('hex');
}

export async function createOAuthState({ nonce, orgUserId, expiresAt }) {
  const supa = getSupabase();
  await supa.from('qbo_oauth_states').delete().eq('organization_id', ORG).lt('expires_at', nowIso());
  const { error } = await supa.from('qbo_oauth_states').insert({
    organization_id: ORG, state_hash: hashNonce(nonce), org_user_id: orgUserId, expires_at: expiresAt,
  });
  if (error) throw fail('qbo_oauth_states write', error);
}

// Single-use consume: delete-returning the UNEXPIRED row for this nonce hash. A replayed or
// expired nonce returns null (the row is already gone, or was never unexpired).
export async function consumeOAuthState(nonce) {
  const { data, error } = await getSupabase()
    .from('qbo_oauth_states').delete()
    .eq('organization_id', ORG).eq('state_hash', hashNonce(nonce)).gt('expires_at', nowIso())
    .select('org_user_id, expires_at');
  if (error) throw fail('qbo_oauth_states consume', error);
  return Array.isArray(data) && data.length ? data[0] : null;
}
