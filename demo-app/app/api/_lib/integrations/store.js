// Service-role data layer for webhooks + the financial snapshot.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { newSecret, newToken } from './hmac.js';

function slugToken() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// ── inbound endpoints ─────────────────────────────────────────────────────
export async function listEndpoints() {
  const db = getSupabase();
  const { data, error } = await db.from('webhook_endpoints').select('*').eq('organization_id', CLEANSPACE_ORG_ID).order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
export async function getEndpointBySlug(slug) {
  const db = getSupabase();
  const { data, error } = await db.from('webhook_endpoints').select('*').eq('slug', slug).maybeSingle();
  if (error) throw error;
  return data ?? null;
}
export async function createEndpoint({ name, purpose, leadConfig }) {
  const db = getSupabase();
  const p = purpose === 'financial_snapshot' || purpose === 'lead_intake' ? purpose : 'generic';
  const row = {
    organization_id: CLEANSPACE_ORG_ID,
    name: name || (p === 'lead_intake' ? 'Lead webhook' : 'Inbound webhook'),
    slug: slugToken(),
    signing_secret: newSecret(),
    is_active: true,
    purpose: p,
  };
  // Lead webhooks carry a Zapier-friendly bearer token + an ingestion-point config.
  if (p === 'lead_intake') {
    row.bearer_token = newToken();
    row.lead_config = leadConfig || null;
  }
  const { data, error } = await db.from('webhook_endpoints').insert(row).select('*').single();
  if (error) throw error;
  return data;
}
export async function updateEndpoint(id, patch) {
  const db = getSupabase();
  const { error } = await db.from('webhook_endpoints').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  return { ok: true };
}
// Regenerate a lead webhook's bearer token (Settings → rotate). Returns the new
// token so the UI can show + copy it.
export async function rotateToken(id) {
  const db = getSupabase();
  const token = newToken();
  const { error } = await db.from('webhook_endpoints').update({ bearer_token: token, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  return { token };
}
export async function deleteEndpoint(id) {
  const db = getSupabase();
  const { error } = await db.from('webhook_endpoints').delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}
export async function touchEndpoint(id) {
  const db = getSupabase();
  await db.from('webhook_endpoints').update({ last_received_at: new Date().toISOString() }).eq('id', id).then(() => undefined, () => undefined);
}

// ── outbound webhooks ─────────────────────────────────────────────────────
export async function listOutbound() {
  const db = getSupabase();
  const { data, error } = await db.from('outbound_webhooks').select('*').eq('organization_id', CLEANSPACE_ORG_ID).order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
export async function createOutbound({ url, eventTypes }) {
  const db = getSupabase();
  const { data, error } = await db.from('outbound_webhooks')
    .insert({ organization_id: CLEANSPACE_ORG_ID, url, secret: newSecret(), event_types: Array.isArray(eventTypes) ? eventTypes : [] })
    .select('*').single();
  if (error) throw error;
  return data;
}
export async function updateOutbound(id, patch) {
  const db = getSupabase();
  const { error } = await db.from('outbound_webhooks').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  return { ok: true };
}
export async function deleteOutbound(id) {
  const db = getSupabase();
  const { error } = await db.from('outbound_webhooks').delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}

// ── deliveries + snapshot ─────────────────────────────────────────────────
export async function recordDelivery({ webhookId, direction, ok, statusCode, error }) {
  const db = getSupabase();
  await db.from('webhook_deliveries').insert({ webhook_id: webhookId, direction, ok: !!ok, status_code: statusCode ?? null, error: error ?? null }).then(() => undefined, () => undefined);
}
export async function listDeliveries(webhookId) {
  const db = getSupabase();
  const { data, error } = await db.from('webhook_deliveries').select('*').eq('webhook_id', webhookId).order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  return data ?? [];
}
export async function getSnapshot() {
  const db = getSupabase();
  const { data, error } = await db.from('financial_snapshot').select('*').eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
  if (error) throw error;
  return data ?? null;
}
export async function upsertSnapshot(metrics) {
  const db = getSupabase();
  // Only write keys that were actually provided, so a push of a subset of cells
  // doesn't wipe the others. (Goal targets keep their column defaults.)
  const row = { organization_id: CLEANSPACE_ORG_ID, source: metrics.source || 'google_sheet', updated_at: new Date().toISOString() };
  const FIELDS = [
    // financial
    'revenue_current_month_cents', 'mrr_cents', 'open_receivables_cents', 'all_time_collected_cents',
    'outstanding_quotes_cents', 'past_due_30_cents', 'ar_cents',
    // goals (actual + target)
    'new_business_actual_cents', 'new_business_goal_cents',
    'google_reviews_actual', 'google_reviews_goal',
    'indeed_reviews_actual', 'indeed_reviews_goal',
    // operational
    'open_complaints', 'variance_yesterday_cents',
  ];
  for (const k of FIELDS) if (metrics[k] != null) row[k] = metrics[k];
  const { data, error } = await db.from('financial_snapshot').upsert(row, { onConflict: 'organization_id' }).select('*').single();
  if (error) throw error;
  return data;
}
