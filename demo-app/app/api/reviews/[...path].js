// Google Business Profile integration — connect, review feed, public replies,
// performance tiles, sync cron. Requires its /api/reviews/:rest* rewrite in
// vercel.json (endpoint law: no route without its rewrite).
//
//   GET  /api/reviews/status          owner/admin — connection summary (no token)
//   GET  /api/reviews/oauth/start     owner/admin — returns { url } (Google consent);
//                                     the popup opens that URL DIRECTLY. The popup
//                                     can't carry our Bearer header, so authority is
//                                     established here and carried in the signed state.
//   GET  /api/reviews/oauth/callback  unauthenticated by nature (Google redirects the
//                                     popup here) — verifyState is the gate. Exchanges
//                                     the code, stores the encrypted refresh token,
//                                     auto-links a sole location, else returns a picker.
//   GET  /api/reviews/locations       owner/admin — account/location picker re-entry
//   POST /api/reviews/location        owner/admin — persist the chosen location
//   GET  /api/reviews/feed            owner/admin — reviews from the TABLE,
//                                     sync-on-stale (>6h)
//   GET  /api/reviews/insights        owner/admin — the four tiles, 1h cache
//   POST /api/reviews/reply           owner/admin — PUBLIC reply on Google
//   DELETE /api/reviews/reply         owner/admin — remove the public reply
//   GET  /api/reviews/posts           owner/admin — Google Posts list (10m cache)
//   POST /api/reviews/posts           owner/admin — publish a PUBLIC post
//   DELETE /api/reviews/posts         owner/admin — delete a post from the listing
//   POST /api/reviews/photos/upload-url owner/admin — mint staging upload (no Google call)
//   GET  /api/reviews/photos          owner/admin — listing media grid (10m cache)
//   POST /api/reviews/photos          owner/admin — attach staged photo PUBLICLY
//   DELETE /api/reviews/photos        owner/admin — remove a listing photo
//   GET  /api/reviews/keywords        owner/admin — search-keyword report (1h cache,
//                                     table-backed history, complete months only)
//   GET  /api/reviews/trends          owner/admin — review trends from gmb_reviews
//   POST /api/reviews/sync-now        owner/admin — manual full sync
//   GET  /api/reviews/sync            Vercel cron (6h) — CRON_SECRET, fail CLOSED,
//                                     non-200 on failure (ingest law)
//   POST /api/reviews/disconnect      owner/admin — revoke token, clear row + feed
// EVERY route here is owner/admin-gated (per Mike, 2026-07-31: the whole
// reviews section is admin+ only — reads included, not just writes). The two
// exceptions authenticate by other means: oauth/callback (signed state minted
// by an owner/admin) and cron sync (CRON_SECRET).
import { requirePermission } from '../_lib/authz.js';
import { signState, verifyState } from '../_lib/crypto.js';
import { buildConsentUrl, exchangeCode, revokeToken } from '../_lib/google.js';
import {
  accessTokenFor, listAccounts, listLocations, listReviewsPage,
  putReply, deleteReply, fetchInsights, reviewToRow,
  buildLocalPost, localPostToItem, listLocalPosts, createLocalPost, deleteLocalPost,
  mediaItemToItem, listMediaItems, createMediaItem, deleteMediaItem, validateGbpPhoto,
  PHOTO_CATEGORIES, fetchKeywordsMonth, keywordRowsFrom, computeReviewTrends,
} from '../_lib/gmb/client.js';
import {
  getConnection, refreshTokenOf, saveConnection, updateConnection, deleteConnection,
  upsertReviews, listReviews, deleteAllReviews, updateReviewReply,
  listReviewFacts, listReviewNames, upsertKeywords, listKeywords, deleteAllKeywords,
  signedGbpPhotoUpload, isGbpStagePath, gbpPublicUrl, removeGbpObject,
  notifyManagersOfNewReviews,
} from '../_lib/gmb/store.js';
import { CLEANSPACE_ORG_ID } from '../_lib/constants.js';
import { DOC } from '../../src/brand/doc.js';

const STALE_MS = 6 * 60 * 60 * 1000;   // feed sync-on-stale
const INSIGHTS_TTL_MS = 60 * 60 * 1000; // tiles cache (Places-card precedent)
const MAX_SYNC_PAGES = 40;              // 40 × 50 = 2000 reviews — safety, not a quota

// openid+email ride along so the callback can show WHICH Google account got
// connected — both are non-sensitive scopes, no verification impact (Internal app).
const GMB_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'openid',
  'email',
];

// The GBP flow uses its OWN OAuth client — "CleanSpace App - Reviews" on Kyle's
// Workspace-owned "GBP API Project" (gbp-api-project-498522), the project that
// holds Google's Business Profile API access grant. It is NOT the Gmail client:
// GBP quota lives on the client's project, and the Gmail client's project has
// none. Falling back to the Gmail pair keeps status/feed readable if the GMB
// vars are ever unset, but consent/sync would fail with a quota error — set
// GMB_OAUTH_CLIENT_ID + GMB_OAUTH_CLIENT_SECRET in Vercel.
function gmbCreds() {
  return {
    clientId: process.env.GMB_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMB_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
}

// Must be registered VERBATIM on the Internal OAuth client in console.cloud:
//   https://cleanspace-gilt.vercel.app/api/reviews/oauth/callback
function reviewsRedirectUri(host) {
  const base = (process.env.APP_PUBLIC_URL || (host ? `https://${host}` : '')).replace(/\/+$/, '');
  return `${base}/api/reviews/oauth/callback`;
}

// The id_token came straight from Google's token endpoint over TLS — decoding
// without signature verification is fine here (we don't grant anything on it;
// it's display metadata only).
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Same popup postMessage pattern as the inbox callback; message type 'connect-gmb'.
function resultPage(message) {
  const json = JSON.stringify(message).replace(/</g, '\\u003c');
  const note = message.error
    ? 'Connection failed. You can close this window.'
    : 'Connected. You can close this window.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:${DOC.body}">
<p>${note}</p>
<script>
(function () {
  try { if (window.opener) window.opener.postMessage(${json}, '*'); } catch (e) {}
  setTimeout(function () { try { window.close(); } catch (e) {} }, 300);
})();
</script>
</body></html>`;
}

async function pickerPayload(token) {
  const accounts = await listAccounts(token);
  const out = [];
  for (const a of accounts) {
    const locations = await listLocations(token, a.name);
    out.push({
      name: a.name,
      accountName: a.accountName || a.name,
      locations: locations.map((l) => ({ name: l.name, title: l.title || l.name })),
    });
  }
  return out;
}

// Full-list sync into gmb_reviews (idempotent — PK upsert). Stamps
// last_synced_at on success, status='error' + last_error on failure.
async function runSync() {
  const conn = await getConnection();
  if (!conn) throw new Error('Google Business Profile is not connected.');
  if (!conn.location_name) throw new Error('No location linked yet — pick a location first.');
  // FLOOD GUARD, condition 1: only a connection that has synced before may
  // notify — the first sync (and the first after any reconnect) backfills the
  // whole history and must stay silent. saveConnection never sets
  // last_synced_at, so both cases arrive here null.
  const priorSyncedAt = conn.last_synced_at;
  try {
    const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
    // FLOOD GUARD, condition 2: a review only counts as new if its name wasn't
    // in the table before this run (names are added to the set as pages land,
    // so a re-listed review can't count twice within the run).
    const existing = await listReviewNames();
    const newReviews = [];
    let pageToken = null;
    let synced = 0;
    let pages = 0;
    let total = null;
    do {
      const page = await listReviewsPage(token, conn.account_name, conn.location_name, pageToken);
      total = page.totalReviewCount ?? total;
      const rows = page.reviews.map((r) => reviewToRow(r, CLEANSPACE_ORG_ID, conn.location_name));
      for (const row of rows) {
        if (!existing.has(row.review_name)) {
          existing.add(row.review_name);
          newReviews.push(row);
        }
      }
      await upsertReviews(rows);
      synced += page.reviews.length;
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken && pages < MAX_SYNC_PAGES);
    await updateConnection({ status: 'active', last_error: null, last_synced_at: new Date().toISOString() });
    // After the success stamp, and best-effort inside the helper — a notify
    // failure can never fail the sync (cron fail-closed semantics untouched).
    if (priorSyncedAt && newReviews.length) await notifyManagersOfNewReviews(newReviews);
    return { synced, total, newReviews: newReviews.length, truncated: Boolean(pageToken) };
  } catch (err) {
    await updateConnection({ status: 'error', last_error: err.message }).catch(() => {});
    throw err;
  }
}

function rowToFeedItem(row) {
  return {
    name: row.review_name,
    reviewer: row.reviewer_name,
    photo: row.reviewer_photo,
    rating: row.star_rating,
    comment: row.comment,
    createTime: row.create_time,
    updateTime: row.update_time,
    reply: row.reply_comment
      ? { comment: row.reply_comment, updateTime: row.reply_update_time }
      : null,
  };
}

function connectionSummary(conn) {
  if (!conn) return { connected: false };
  return {
    connected: true,
    googleEmail: conn.google_email,
    locationName: conn.location_name,
    locationTitle: conn.location_title,
    needsLocation: !conn.location_name,
    status: conn.status,
    lastError: conn.last_error,
    lastSyncedAt: conn.last_synced_at,
  };
}

let insightsCache = { at: 0, data: null };
// Posts/media are live-listed (Google owns their mutable state + hosting;
// storing them would only show stale `state`). Short caches keep tab loads snappy.
const LIST_TTL_MS = 10 * 60 * 1000;
let postsCache = { at: 0, data: null };
let photosCache = { at: 0, data: null };
let keywordsCache = { at: 0, data: null }; // 1h — monthly data barely moves
function resetSuiteCaches() {
  insightsCache = { at: 0, data: null };
  postsCache = { at: 0, data: null };
  photosCache = { at: 0, data: null };
  keywordsCache = { at: 0, data: null };
}

// Trailing-12 COMPLETE months as 'YYYY-MM' keys, oldest first. The current
// month is excluded — Google's keyword data lags ~a month and a partial month
// would persist misleading totals.
function completeMonthKeys(now = new Date()) {
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1; // 1-12, the CURRENT (excluded) month
  const keys = [];
  for (let i = 0; i < 12; i += 1) {
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    keys.unshift(`${y}-${String(m).padStart(2, '0')}`);
  }
  return keys;
}

// Google fetched the sourceUrl and re-hosted the bytes when the created
// resource carries googleUrl — the staged object is then safe to remove.
// Keep it on any doubt (ingest timing isn't contractual); residue is bounded.
async function cleanupStagedPhoto(path, created) {
  const rehosted = Boolean(created?.googleUrl || created?.media?.[0]?.googleUrl);
  if (rehosted) await removeGbpObject(path);
}

export default async function handler(req, res) {
  // Vercel rewrites multi-segment paths via ?subpath=; single-seg hits the
  // catch-all directly. Same idiom as quotes / time / site-security.
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const route = path.join('/');
  const body = req.body || {};

  try {
    // ---- connection status ----
    if (route === 'status' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reviews.view');
      if (!g) return;
      return res.status(200).json(connectionSummary(await getConnection()));
    }

    // ---- OAuth: mint the consent URL (authority established HERE) ----
    if (route === 'oauth/start' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const state = signState({
        t: 'gmb',
        ts: Date.now(),
        nonce: Math.random().toString(36).slice(2),
        by: g.orgUserId || g.email,
      });
      const url = buildConsentUrl(state, reviewsRedirectUri(req.headers.host), gmbCreds(), GMB_SCOPES);
      return res.status(200).json({ url });
    }

    // ---- OAuth: Google redirects the popup here ----
    if (route === 'oauth/callback' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const { code, state, error } = req.query;
      if (error) {
        return res.status(200).send(resultPage({ type: 'connect-gmb', error: `Google returned: ${error}` }));
      }
      if (!code || !state) {
        return res.status(200).send(resultPage({ type: 'connect-gmb', error: 'Missing authorization code.' }));
      }
      const statePayload = verifyState(state);
      if (!statePayload || statePayload.t !== 'gmb') {
        return res.status(200).send(resultPage({ type: 'connect-gmb', error: 'The connect link expired. Please try again.' }));
      }
      const tokens = await exchangeCode(code, reviewsRedirectUri(req.headers.host), gmbCreds());
      if (!tokens.refresh_token) {
        return res.status(200).send(resultPage({
          type: 'connect-gmb',
          error: 'Google did not return a refresh token. Remove the app at myaccount.google.com → Security → Third-party access, then reconnect.',
        }));
      }
      const googleEmail = tokens.id_token ? emailFromIdToken(tokens.id_token) : null;

      // List accounts/locations with the fresh access token; exactly one
      // location across all accounts → auto-link, else hand back a picker.
      let accounts = [];
      try {
        accounts = await pickerPayload(tokens.access_token);
      } catch (err) {
        // Token stored anyway — the picker can re-list via GET locations once
        // the API-enablement propagates. Surface the reason honestly.
        await saveConnection({ refreshToken: tokens.refresh_token, googleEmail, connectedBy: statePayload.by || null });
        await updateConnection({ status: 'error', last_error: `Connected, but listing locations failed: ${err.message}` });
        return res.status(200).send(resultPage({
          type: 'connect-gmb',
          error: `Connected to Google, but listing your Business Profile locations failed: ${err.message}`,
        }));
      }
      const flat = accounts.flatMap((a) => a.locations.map((l) => ({ account: a.name, ...l })));
      const sole = flat.length === 1 ? flat[0] : null;
      await saveConnection({
        refreshToken: tokens.refresh_token,
        googleEmail,
        accountName: sole ? sole.account : null,
        locationName: sole ? sole.name : null,
        locationTitle: sole ? sole.title : null,
        connectedBy: statePayload.by || null,
      });
      return res.status(200).send(resultPage({
        type: 'connect-gmb',
        connected: {
          googleEmail,
          needsLocation: !sole,
          locationTitle: sole ? sole.title : null,
          accounts: sole ? undefined : accounts,
        },
      }));
    }

    // ---- location picker (re-entry) + choice ----
    if (route === 'locations' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const conn = await getConnection();
      if (!conn) return res.status(400).json({ error: 'Not connected.' });
      const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
      return res.status(200).json({ accounts: await pickerPayload(token) });
    }
    if (route === 'location' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const { accountName, locationName, locationTitle } = body;
      if (!accountName || !locationName) {
        return res.status(400).json({ error: 'accountName and locationName are required.' });
      }
      await updateConnection({
        account_name: accountName,
        location_name: locationName,
        location_title: locationTitle || locationName,
        status: 'active',
        last_error: null,
      });
      return res.status(200).json(connectionSummary(await getConnection()));
    }

    // ---- review feed (table-backed, sync-on-stale) ----
    if (route === 'feed' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reviews.view');
      if (!g) return;
      let conn = await getConnection();
      if (!conn) return res.status(200).json({ connected: false, reviews: [] });
      const stale = !conn.last_synced_at || (Date.now() - new Date(conn.last_synced_at).getTime() > STALE_MS);
      if (stale && conn.location_name) {
        try {
          await runSync();
          conn = await getConnection();
        } catch {
          // Serve what the table has; status/lastError carry the failure.
          conn = await getConnection();
        }
      }
      const rows = await listReviews({
        limit: req.query.limit,
        before: typeof req.query.before === 'string' ? req.query.before : null,
      });
      return res.status(200).json({
        ...connectionSummary(conn),
        reviews: rows.map(rowToFeedItem),
      });
    }

    // ---- performance tiles ----
    if (route === 'insights' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reviews.view');
      if (!g) return;
      const conn = await getConnection();
      if (!conn || !conn.location_name) return res.status(200).json({ connected: false });
      if (insightsCache.data && Date.now() - insightsCache.at < INSIGHTS_TTL_MS) {
        return res.status(200).json({ connected: true, ...insightsCache.data, cached: true });
      }
      const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
      const data = await fetchInsights(token, conn.location_name);
      insightsCache = { at: Date.now(), data };
      return res.status(200).json({ connected: true, ...data });
    }

    // ---- public reply (write-through to Google, then the row) ----
    if (route === 'reply' && (req.method === 'POST' || req.method === 'DELETE')) {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const reviewName = body.reviewName || req.query.reviewName;
      if (!reviewName || typeof reviewName !== 'string' || !reviewName.includes('/reviews/')) {
        return res.status(400).json({ error: 'reviewName (the Google review resource name) is required.' });
      }
      const conn = await getConnection();
      if (!conn) return res.status(400).json({ error: 'Google Business Profile is not connected.' });
      const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
      if (req.method === 'POST') {
        const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
        if (!comment) return res.status(400).json({ error: 'Reply text is required.' });
        if (comment.length > 4000) return res.status(400).json({ error: 'Reply is too long (4000 characters max).' });
        const posted = await putReply(token, reviewName, comment);
        const updateTime = posted.updateTime || new Date().toISOString();
        await updateReviewReply(reviewName, posted.comment || comment, updateTime);
        return res.status(200).json({ ok: true, reply: { comment: posted.comment || comment, updateTime } });
      }
      await deleteReply(token, reviewName);
      await updateReviewReply(reviewName, null, null);
      return res.status(200).json({ ok: true, reply: null });
    }

    // ---- Google Posts (published PUBLICLY on the listing) ----
    if (route === 'posts') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const conn = await getConnection();
      if (!conn || !conn.location_name) return res.status(400).json({ error: 'Google Business Profile is not connected.' });

      if (req.method === 'GET') {
        if (postsCache.data && Date.now() - postsCache.at < LIST_TTL_MS) {
          return res.status(200).json({ ...postsCache.data, cached: true });
        }
        const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
        const { posts, truncated } = await listLocalPosts(token, conn.account_name, conn.location_name);
        const data = { posts: posts.map(localPostToItem), truncated };
        postsCache = { at: Date.now(), data };
        return res.status(200).json(data);
      }

      if (req.method === 'POST') {
        let photoUrl = null;
        const photoPath = typeof body.photoPath === 'string' ? body.photoPath : null;
        if (photoPath) {
          if (!isGbpStagePath(photoPath)) return res.status(400).json({ error: 'Invalid photo reference.' });
          photoUrl = gbpPublicUrl(photoPath);
        }
        const built = buildLocalPost({ ...body, photoUrl });
        if (!built.ok) return res.status(400).json({ error: built.error });
        const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
        let created;
        try {
          created = await createLocalPost(token, conn.account_name, conn.location_name, built.post);
        } catch (err) {
          if (photoPath) await removeGbpObject(photoPath); // don't strand failed stages
          if (err.status === 429) {
            return res.status(429).json({ error: "Google's daily post limit is reached — try again tomorrow." });
          }
          if (err.status === 400) return res.status(400).json({ error: err.message });
          throw err;
        }
        if (photoPath) await cleanupStagedPhoto(photoPath, created);
        postsCache = { at: 0, data: null };
        return res.status(200).json({ ok: true, post: localPostToItem(created) });
      }

      if (req.method === 'DELETE') {
        const name = body.name || req.query.name;
        if (!name || typeof name !== 'string' || !name.includes('/localPosts/')) {
          return res.status(400).json({ error: 'name (the Google post resource name) is required.' });
        }
        const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
        await deleteLocalPost(token, name);
        postsCache = { at: 0, data: null };
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---- Listing photos (published PUBLICLY on the listing) ----
    if (route === 'photos/upload-url' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const check = validateGbpPhoto({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (!check.ok) return res.status(400).json({ error: check.error });
      return res.status(200).json(await signedGbpPhotoUpload({ mimeType: body.mimeType }));
    }
    if (route === 'photos') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const conn = await getConnection();
      if (!conn || !conn.location_name) return res.status(400).json({ error: 'Google Business Profile is not connected.' });

      if (req.method === 'GET') {
        if (photosCache.data && Date.now() - photosCache.at < LIST_TTL_MS) {
          return res.status(200).json({ ...photosCache.data, cached: true });
        }
        const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
        const { items, totalMediaItemCount, truncated } = await listMediaItems(token, conn.account_name, conn.location_name);
        const data = { items: items.map(mediaItemToItem), total: totalMediaItemCount, truncated };
        photosCache = { at: Date.now(), data };
        return res.status(200).json(data);
      }

      if (req.method === 'POST') {
        const { path: stagePath, category } = body;
        if (!isGbpStagePath(stagePath)) return res.status(400).json({ error: 'Invalid photo reference.' });
        if (!PHOTO_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Pick a photo category.' });
        const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
        let created;
        try {
          created = await createMediaItem(token, conn.account_name, conn.location_name, {
            category,
            sourceUrl: gbpPublicUrl(stagePath),
          });
        } catch (err) {
          await removeGbpObject(stagePath);
          // Google fetches the URL during create and 400s on too-small /
          // wrong-ratio / unfetchable — surface its reason verbatim.
          if (err.status === 400) return res.status(400).json({ error: err.message });
          throw err;
        }
        await cleanupStagedPhoto(stagePath, created);
        photosCache = { at: 0, data: null };
        return res.status(200).json({ ok: true, item: mediaItemToItem(created) });
      }

      if (req.method === 'DELETE') {
        const name = body.name || req.query.name;
        if (!name || typeof name !== 'string' || !name.includes('/media/')) {
          return res.status(400).json({ error: 'name (the Google media resource name) is required.' });
        }
        const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
        await deleteMediaItem(token, name);
        photosCache = { at: 0, data: null };
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---- Local SEO: search keywords (table-backed history) ----
    if (route === 'keywords' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reviews.view');
      if (!g) return;
      const conn = await getConnection();
      if (!conn || !conn.location_name) return res.status(200).json({ connected: false });
      if (keywordsCache.data && Date.now() - keywordsCache.at < INSIGHTS_TTL_MS) {
        return res.status(200).json({ connected: true, ...keywordsCache.data, cached: true });
      }
      const monthKeys = completeMonthKeys();
      let rows = await listKeywords({ months: monthKeys });
      const have = new Set(rows.map((r) => r.month));
      const missing = monthKeys.filter((k) => !have.has(k));
      if (missing.length) {
        const token = await accessTokenFor(refreshTokenOf(conn), gmbCreds());
        for (const key of missing) {
          try {
            const [year, month] = key.split('-').map(Number);
            const payload = await fetchKeywordsMonth(token, conn.location_name, { year, month });
            await upsertKeywords(keywordRowsFrom(payload, key, CLEANSPACE_ORG_ID));
          } catch {
            // A month Google hasn't published yet stays absent; retried after
            // the next cache expiry. Stored months still serve below.
          }
        }
        rows = await listKeywords({ months: monthKeys });
      }
      const byMonth = new Map();
      for (const r of rows) byMonth.set(r.month, (byMonth.get(r.month) || 0) + r.impressions);
      const months = monthKeys.map((k) => ({ month: k, totalImpressions: byMonth.get(k) || 0 }));
      const latestMonth = [...byMonth.keys()].sort().pop() || null;
      const top = latestMonth
        ? rows.filter((r) => r.month === latestMonth).slice(0, 20)
          .map((r) => ({ keyword: r.keyword, impressions: r.impressions, thresholded: r.thresholded }))
        : [];
      const data = { months, latestMonth, top };
      keywordsCache = { at: Date.now(), data };
      return res.status(200).json({ connected: true, ...data });
    }

    // ---- Local SEO: review trends (our own table, no Google call) ----
    if (route === 'trends' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'reviews.view');
      if (!g) return;
      const facts = await listReviewFacts();
      return res.status(200).json(computeReviewTrends(facts, new Date().toISOString()));
    }

    // ---- sync: manual + cron ----
    if (route === 'sync-now' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const result = await runSync();
      return res.status(200).json({ ok: true, ...result });
    }
    if (route === 'sync' && req.method === 'GET') {
      // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail CLOSED,
      // and hard-fail (non-200) on error — a 200-with-ok:false hid a month-long
      // outage in the inbox pipeline; never again (ingest law).
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(secret ? 401 : 500).json({ ok: false, error: secret ? 'Unauthorized' : 'CRON_SECRET is not configured' });
      }
      const conn = await getConnection();
      if (!conn || !conn.location_name) {
        // Nothing connected is a healthy no-op, not a failure.
        return res.status(200).json({ ok: true, skipped: 'not connected' });
      }
      const result = await runSync();
      return res.status(200).json({ ok: true, ...result });
    }

    // ---- disconnect ----
    if (route === 'disconnect' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'reviews.manage');
      if (!g) return;
      const conn = await getConnection();
      if (conn) {
        try { await revokeToken(refreshTokenOf(conn)); } catch { /* best effort */ }
        await deleteConnection();
        await deleteAllReviews();
        await deleteAllKeywords();
        resetSuiteCaches();
      }
      return res.status(200).json({ ok: true, connected: false });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Reviews request failed' });
  }
}
