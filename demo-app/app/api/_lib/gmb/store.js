// Service-role data layer for the Google Business Profile integration:
// the per-org connection row (encrypted refresh token + linked location) and
// the synced review feed. Browser never touches these tables — only the
// /api/reviews handlers do, and they re-check authority from JWT claims.
import { randomBytes } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { encrypt, decrypt } from '../crypto.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { readOrgState, writeOrgState } from '../orgState.js';
import { fanOutManagerAlert, previewMessageBody } from '../../../src/lib/notifications.js';

// Same key class as the inbox OAuth tokens — a long-lived Google refresh
// token at rest. Rotating this key invalidates the stored token and the
// office simply reconnects.
const KEY_ENV = 'INBOX_TOKEN_ENCRYPTION_KEY';

export async function getConnection() {
  const { data, error } = await getSupabase()
    .from('gmb_connection').select('*').eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
  if (error) throw new Error(`gmb_connection read failed: ${error.message}`);
  return data ?? null;
}

export function refreshTokenOf(connection) {
  return decrypt(connection.refresh_token_enc, KEY_ENV);
}

export async function saveConnection({ refreshToken, googleEmail, accountName, locationName, locationTitle, connectedBy }) {
  const row = {
    organization_id: CLEANSPACE_ORG_ID,
    refresh_token_enc: encrypt(refreshToken, KEY_ENV),
    google_email: googleEmail ?? null,
    account_name: accountName ?? null,
    location_name: locationName ?? null,
    location_title: locationTitle ?? null,
    connected_by: connectedBy ?? null,
    status: 'active',
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await getSupabase().from('gmb_connection').upsert(row, { onConflict: 'organization_id' });
  if (error) throw new Error(`gmb_connection write failed: ${error.message}`);
}

export async function updateConnection(patch) {
  const { error } = await getSupabase()
    .from('gmb_connection')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('organization_id', CLEANSPACE_ORG_ID);
  if (error) throw new Error(`gmb_connection update failed: ${error.message}`);
}

export async function deleteConnection() {
  const { error } = await getSupabase().from('gmb_connection').delete().eq('organization_id', CLEANSPACE_ORG_ID);
  if (error) throw new Error(`gmb_connection delete failed: ${error.message}`);
}

// Upsert a page of synced reviews — idempotent on review_name (Google's
// canonical resource name), so overlapping syncs are harmless.
export async function upsertReviews(rows) {
  if (!rows.length) return;
  const { error } = await getSupabase().from('gmb_reviews').upsert(rows, { onConflict: 'review_name' });
  if (error) throw new Error(`gmb_reviews upsert failed: ${error.message}`);
}

export async function listReviews({ limit = 50, before = null } = {}) {
  let q = getSupabase()
    .from('gmb_reviews').select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .order('update_time', { ascending: false })
    .limit(Math.min(Number(limit) || 50, 100));
  if (before) q = q.lt('update_time', before);
  const { data, error } = await q;
  if (error) throw new Error(`gmb_reviews read failed: ${error.message}`);
  return data || [];
}

// Disconnect wipes the feed too — rows are re-syncable from Google, and a
// reconnect to a different location must not mix two listings' reviews.
export async function deleteAllReviews() {
  const { error } = await getSupabase().from('gmb_reviews').delete().eq('organization_id', CLEANSPACE_ORG_ID);
  if (error) throw new Error(`gmb_reviews delete failed: ${error.message}`);
}

export async function updateReviewReply(reviewName, replyComment, replyUpdateTime) {
  const { error } = await getSupabase()
    .from('gmb_reviews')
    .update({ reply_comment: replyComment, reply_update_time: replyUpdateTime, synced_at: new Date().toISOString() })
    .eq('review_name', reviewName);
  if (error) throw new Error(`gmb_reviews reply update failed: ${error.message}`);
}

// The set of already-synced review names — the sync's new-review diff (and
// flood-guard) input. Bounded by the sync's own page cap (~2000).
export async function listReviewNames() {
  const { data, error } = await getSupabase()
    .from('gmb_reviews').select('review_name').eq('organization_id', CLEANSPACE_ORG_ID).limit(2500);
  if (error) throw new Error(`gmb_reviews names read failed: ${error.message}`);
  return new Set((data || []).map((r) => r.review_name));
}

// The trend computation's raw facts — stars, when, replied-or-not.
export async function listReviewFacts() {
  const { data, error } = await getSupabase()
    .from('gmb_reviews')
    .select('star_rating, create_time, reply_comment')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .limit(2000);
  if (error) throw new Error(`gmb_reviews facts read failed: ${error.message}`);
  return data || [];
}

// ---------- search-keyword history (gmb_keywords) ----------

export async function upsertKeywords(rows) {
  if (!rows.length) return;
  const { error } = await getSupabase().from('gmb_keywords').upsert(rows, { onConflict: 'organization_id,month,keyword' });
  if (error) throw new Error(`gmb_keywords upsert failed: ${error.message}`);
}

export async function listKeywords({ months }) {
  const { data, error } = await getSupabase()
    .from('gmb_keywords').select('month, keyword, impressions, thresholded')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .in('month', months)
    .order('impressions', { ascending: false });
  if (error) throw new Error(`gmb_keywords read failed: ${error.message}`);
  return data || [];
}

// Disconnect wipe — same argument as deleteAllReviews: a reconnect to a
// different listing must not mix keyword histories.
export async function deleteAllKeywords() {
  const { error } = await getSupabase().from('gmb_keywords').delete().eq('organization_id', CLEANSPACE_ORG_ID);
  if (error) throw new Error(`gmb_keywords delete failed: ${error.message}`);
}

// ---------- photo staging (org-branding bucket) ----------
// Google's media/post create takes a sourceUrl it fetches itself, so the image
// must sit at a PUBLIC https URL first. `org-branding` is the app's one public
// bucket (declared in the forms migration, previously unused). Objects are
// staged under a server-minted prefix and removed once Google re-hosts the
// bytes (or on failure); see the route for the exact keep/delete policy.

const GBP_STAGE_BUCKET = 'org-branding';
const GBP_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };

// All three path segments are server-minted (org constant, literal 'gbp',
// random id) — nothing user-influenced, so requireSafeSegment is deliberately
// not needed here.
export async function signedGbpPhotoUpload({ mimeType }) {
  const ext = GBP_EXT[mimeType];
  if (!ext) throw new Error('Unsupported image type.');
  const path = `${CLEANSPACE_ORG_ID}/gbp/${randomBytes(8).toString('hex')}.${ext}`;
  const { data, error } = await getSupabase().storage.from(GBP_STAGE_BUCKET).createSignedUploadUrl(path);
  if (error) throw new Error(`Staging upload URL failed: ${error.message}`);
  return { path, token: data.token };
}

// Server pin: routes accept only paths this store could have minted — a caller
// must not be able to point Google at arbitrary bucket objects.
export function isGbpStagePath(path) {
  return typeof path === 'string' && new RegExp(`^${CLEANSPACE_ORG_ID}/gbp/[a-f0-9]{16}\\.(jpg|png)$`).test(path);
}

// Pure local string builder — no network. Publicly fetchable because the
// bucket is public.
export function gbpPublicUrl(path) {
  return getSupabase().storage.from(GBP_STAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function removeGbpObject(path) {
  try {
    await getSupabase().storage.from(GBP_STAGE_BUCKET).remove([path]);
  } catch {
    // Best effort — a stranded staging object is bounded and harmless.
  }
}

// ---------- new-review manager alerts ----------

// Fan out ONE bell row per sync batch after new reviews land — server-side so
// the office hears even with no tab open (push-dispatch delivers the row to
// their phones). CAS-guarded, fully best-effort: a notification failure must
// never fail the sync that found the reviews (qc/store notifyManagersOfProblem
// precedent). The FLOOD GUARD lives in the caller (runSync): it only passes
// reviews whose names weren't in gmb_reviews before this run, and only when
// the connection had synced before (backfills stay silent).
export async function notifyManagersOfNewReviews(newReviews, tries = 4) {
  if (!Array.isArray(newReviews) || !newReviews.length) return;
  try {
    const stars = (r) => '★'.repeat(Math.max(1, Math.min(5, Number(r.star_rating) || 0)));
    const one = newReviews[0];
    const title = newReviews.length === 1
      ? `New ${stars(one)} Google review from ${one.reviewer_name || 'a customer'}`
      : `${newReviews.length} new Google reviews`;
    const body = newReviews.length === 1
      ? previewMessageBody(one.comment || '')
      : newReviews.map((r) => r.reviewer_name || 'a customer').join(', ');
    for (let i = 0; i < tries; i += 1) {
      const { state, version } = await readOrgState();
      const notifications = fanOutManagerAlert({ ...state, notifications: state.notifications || [] }, {
        eventKey: 'newGoogleReview',
        title,
        body,
        url: '/reviews',
      });
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return;
    }
  } catch { /* best-effort — the reviews are already synced */ }
}
