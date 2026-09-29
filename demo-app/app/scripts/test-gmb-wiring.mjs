// Wiring pins for the Google Business Profile integration. These are
// make-it-not-expressible guards: each pin is an invariant whose silent loss
// would break a live surface (Gmail OAuth, the cron, the public-reply gate)
// without any offline test failing.
import { readFileSync, existsSync } from 'node:fs';

const R = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// No-backend demo clone: only app/ is cloned, so supabase/migrations/ isn't
// present. This is a backend-wiring suite — skip cleanly rather than ENOENT.
// (Mirrors sql-definer-lint's skip-when-absent behavior.)
if (!existsSync(new URL('../supabase/migrations/', import.meta.url))) {
  console.log('\ntest-gmb-wiring: SKIPPED — supabase/migrations/ not present (no-backend demo clone).\n');
  process.exit(0);
}

let pass = 0, fail = 0;
function pin(name, ok, detail = '') {
  if (ok) { pass += 1; } else { fail += 1; console.error(`✖ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. Gmail OAuth untouched by the scopes parameterization ────────────────
// buildConsentUrl grew a 4th param for GMB. The Gmail default and the inbox
// call sites must stay byte-equivalent, or every mailbox reconnect breaks.
const google = R('api/_lib/google.js');
pin('google.js SCOPES is exactly the Gmail pair',
  /const SCOPES = \[\s*'https:\/\/www\.googleapis\.com\/auth\/gmail\.send',\s*'https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly',\s*\]/.test(google));
pin('the business.manage scope URL never enters google.js (it lives in the reviews route)',
  !google.includes('googleapis.com/auth/business.manage'));
pin('buildConsentUrl defaults scopes to SCOPES',
  /buildConsentUrl\(state, redirectUri, creds = \{\}, scopes = SCOPES\)/.test(google));
const inboxConnect = R('api/inbox/connect/start.js');
pin('inbox connect leg passes NO scopes override (inherits the Gmail default)',
  /buildConsentUrl\(state, buildRedirectUri\(req\.headers\.host\), creds\)/.test(inboxConnect));
pin('inbox connect INIT is permission-gated on marketing.connectInbox (owner/admin default; Sept 3 → requirePermission)',
  /requirePermission\(req, res, 'marketing\.connectInbox'\)/.test(inboxConnect));

// ── 2. Endpoint law: route ⇄ rewrite ⇄ cron ────────────────────────────────
pin('reviews catch-all exists', existsSync(new URL('../api/reviews/[...path].js', import.meta.url)));
const vercel = JSON.parse(R('vercel.json'));
pin('vercel.json rewrite for /api/reviews/:rest*',
  vercel.rewrites.some((r) => r.source === '/api/reviews/:rest*' && r.destination === '/api/reviews/_?subpath=:rest*'));
pin('vercel.json cron hits /api/reviews/sync every 6h',
  vercel.crons.some((c) => c.path === '/api/reviews/sync' && c.schedule === '0 */6 * * *'));

// ── 3. Route-level guards ──────────────────────────────────────────────────
const route = R('api/reviews/[...path].js');
pin('cron sync is CRON_SECRET fail-CLOSED (500 when unset, 401 when wrong)',
  /status\(secret \? 401 : 500\)/.test(route));
const replyBlock = route.slice(route.indexOf("route === 'reply'"), route.indexOf("route === 'sync-now'"));
pin('reply (public write to Google) gated on requirePermission reviews.manage',
  /requirePermission\(req, res, 'reviews\.manage'\)/.test(replyBlock));
const startBlock = route.slice(route.indexOf("route === 'oauth/start'"), route.indexOf("route === 'oauth/callback'"));
pin('oauth/start gated on requirePermission reviews.manage (authority carried in signed state)',
  /requirePermission\(req, res, 'reviews\.manage'\)/.test(startBlock));
pin('callback verifies signed state and its t=gmb tag',
  /verifyState\(state\)/.test(route) && /statePayload\.t !== 'gmb'/.test(route));
pin('disconnect revokes the token AND clears the feed',
  /revokeToken\(refreshTokenOf\(conn\)\)/.test(route) && /deleteAllReviews\(\)/.test(route));
// Mike, 2026-07-31: the WHOLE section is admin+ — reads included. Every JWT-authed
// route goes through requirePermission (reviews.view/manage, owner/admin default);
// requireAuthority and a leftover requireRole must not creep back in (Sept 3).
// 14 = status, oauth/start, locations, location, feed, insights, reply,
//      posts, photos/upload-url, photos, keywords, trends, sync-now, disconnect.
pin('every authed route is permission-gated (no requireAuthority; no leftover requireRole)',
  !route.includes('requireAuthority')
  && !route.includes('requireRole(')
  && (route.match(/requirePermission\(req, res, 'reviews\.(view|manage)'\)/g) || []).length === 14
  && (route.match(/requirePermission\(req, res, 'reviews\.view'\)/g) || []).length === 5
  && (route.match(/requirePermission\(req, res, 'reviews\.manage'\)/g) || []).length === 9);

// ── 3b. Dedicated GBP OAuth client everywhere ──────────────────────────────
// The GBP quota grant lives on the "CleanSpace App - Reviews" client's project.
// A refresh token is bound to its issuing client, so EVERY leg — consent,
// exchange, and all four token refreshes — must use gmbCreds(). One call site
// silently reverting to the env-default Gmail creds = 401s at that leg only.
pin('gmbCreds() reads GMB_OAUTH_* with Gmail fallback',
  /GMB_OAUTH_CLIENT_ID/.test(route) && /GMB_OAUTH_CLIENT_SECRET/.test(route));
pin('consent + exchange use gmbCreds()',
  /buildConsentUrl\(state, reviewsRedirectUri\(req\.headers\.host\), gmbCreds\(\), GMB_SCOPES\)/.test(route)
  && /exchangeCode\(code, reviewsRedirectUri\(req\.headers\.host\), gmbCreds\(\)\)/.test(route));
// 11 sites: locations, sync, insights, reply, posts×3 (GET/POST/DELETE),
// photos×3, keywords — each method mints its own token.
pin('every token refresh passes gmbCreds() (11 sites, zero bare calls)',
  (route.match(/accessTokenFor\(refreshTokenOf\(conn\), gmbCreds\(\)\)/g) || []).length === 11
  && !/accessTokenFor\(refreshTokenOf\(conn\)\)/.test(route));

// ── 3c. Suite surfaces (posts / photos / keywords / trends) ────────────────
pin('staged photo paths are store-pinned before Google sees a URL (posts + photos)',
  (route.match(/isGbpStagePath\(/g) || []).length >= 2
  && /gbpPublicUrl\(/.test(route));
pin('photo category whitelisted against the v4 enum (TEAMS, not TEAM)',
  /PHOTO_CATEGORIES\.includes\(category\)/.test(route)
  && R('api/_lib/gmb/client.js').includes("'TEAMS'"));
pin('post/photo DELETE names are resource-type-guarded (mirror the reply gate)',
  route.includes("name.includes('/localPosts/')") && route.includes("name.includes('/media/')"));
pin('429 from Google maps to an honest client message',
  /status === 429/.test(route) && route.includes('daily post limit'));
pin('OFFER posts reject a custom CTA (Google adds its own and 400s)',
  /topicType === 'OFFER'[\s\S]{0,200}View offer/.test(R('api/_lib/gmb/client.js')));
pin('keywords fetch only COMPLETE months (current month excluded)',
  /m -= 1;\s*\n\s*if \(m === 0\)/.test(route) && route.includes('completeMonthKeys'));
pin('disconnect wipes keyword history + all suite caches',
  route.includes('deleteAllKeywords()') && route.includes('resetSuiteCaches()'));
pin('gmb_keywords migration shipped (PK org+month+keyword, RLS on)',
  (() => {
    const kw = R('../supabase/migrations/20260801000000_gmb_keywords.sql');
    return kw.includes('primary key (organization_id, month, keyword)')
      && kw.includes('enable row level security');
  })());
pin('place id has a single source (CLEANSPACE_PLACE_ID; no stray literal in settings)',
  R('api/_lib/constants.js').includes('CLEANSPACE_PLACE_ID')
  && !R('api/settings/[...path].js').includes('')
  && R('api/settings/[...path].js').includes('writeReviewUrl'));

// ── 3d. New-review alerts + flood guard ────────────────────────────────────
const notifLib = R('src/lib/notifications.js');
pin('newGoogleReview eventKey registered, owner/admin only',
  /key: 'newGoogleReview',[\s\S]{0,300}roleAllowlist: \['owner', 'admin'\]/.test(notifLib));
const gmbStore = R('api/_lib/gmb/store.js');
pin('notify helper is CAS-retried AND best-effort (try/catch swallows)',
  /notifyManagersOfNewReviews/.test(gmbStore)
  && /fanOutManagerAlert/.test(gmbStore)
  && /catch \{ \/\* best-effort/.test(gmbStore));
pin('flood guard: only pre-existing connections notify (priorSyncedAt), only truly-new names, AFTER the success stamp',
  /const priorSyncedAt = conn\.last_synced_at/.test(route)
  && /listReviewNames\(\)/.test(route)
  && /last_synced_at: new Date\(\)\.toISOString\(\) \}\);[\s\S]{0,300}if \(priorSyncedAt && newReviews\.length\) await notifyManagersOfNewReviews\(newReviews\)/.test(route));
pin('refresh token encrypted with INBOX_TOKEN_ENCRYPTION_KEY (same secret class as inbox)',
  R('api/_lib/gmb/store.js').includes("const KEY_ENV = 'INBOX_TOKEN_ENCRYPTION_KEY'"));

// ── 4. Migration shipped with the code ─────────────────────────────────────
const mig = R('../supabase/migrations/20260731000000_gmb_reviews.sql');
pin('migration creates both tables with RLS enabled (service-role only)',
  mig.includes('create table if not exists gmb_connection')
  && mig.includes('create table if not exists gmb_reviews')
  && (mig.match(/enable row level security/g) || []).length === 2);

// ── 5. Client surface ──────────────────────────────────────────────────────
const roles = R('src/lib/roles.js');
pin('reviews.manage permission registered (owner+admin)',
  /'reviews\.manage':\s*\{ label: '[^']+', defaultRoles: \['owner', 'admin'\] \}/.test(roles));
const page = R('src/pages/Reviews.jsx');
pin('Reviews page gates GBP controls on reviews.manage (not reviews.view)',
  page.includes("usePermission('reviews.manage')"));
pin('reply composer says replies are PUBLIC',
  page.includes('This reply is posted publicly on Google.'));
const apiLib = R('src/lib/reviewsApi.js');
pin('popup message type matches the callback page (connect-gmb)',
  apiLib.includes("'connect-gmb'") && route.includes("type: 'connect-gmb'"));

// ── 6. Stub copy is DEAD (replace-means-delete) ────────────────────────────
pin('no "pending approval" copy anywhere in the page',
  !page.includes('pending approval') && !page.includes('pending Google'));
pin('no hardcoded "Connecting…" badge outside a busy state',
  !/Connecting…<\/span>/.test(page));

// ── 7. Suite UI ────────────────────────────────────────────────────────────
pin('tab whitelist is exactly the five suite views',
  /const VIEWS = \['reviews', 'posts', 'photos', 'insights', 'growth'\]/.test(page));
pin('posts composer says posts are PUBLIC',
  R('src/components/GmbPostsPanel.jsx').includes('This post is published publicly on your Google listing.'));
pin('photo uploader says photos are PUBLIC',
  R('src/components/GmbPhotosPanel.jsx').includes('published publicly on your Google listing'));
pin('client image gate mirrors Google floors (250px, 10KB, jpeg/png)',
  (() => {
    const lib = R('src/lib/reviewsApi.js');
    return lib.includes('250') && lib.includes("'image/jpeg'") && lib.includes('createImageBitmap');
  })());
pin('qrcode is a runtime dep, dynamically imported; sharp stays devDependency-only',
  (() => {
    const pkg = JSON.parse(R('package.json'));
    return Boolean(pkg.dependencies.qrcode) && !pkg.dependencies.sharp && Boolean(pkg.devDependencies.sharp)
      && R('src/components/ReviewGrowthPanel.jsx').includes("import('qrcode')");
  })());
pin('no chart library crept in (house = hand-rolled .rev-chart bars)',
  (() => {
    const pkg = JSON.parse(R('package.json'));
    const banned = ['recharts', 'chart.js', 'd3', 'victory', 'apexcharts'];
    return !banned.some((b) => pkg.dependencies[b] || pkg.devDependencies[b])
      && R('src/components/GmbInsightsPanel.jsx').includes('rev-chart');
  })());
pin('thresholded keywords render as "< N"',
  R('src/components/GmbInsightsPanel.jsx').includes('thresholded'));

console.log(`\ntest-gmb-wiring: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
