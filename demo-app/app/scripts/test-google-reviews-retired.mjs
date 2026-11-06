// GOOGLE REVIEWS ARE RETIRED (Daniel, 2026-10-20: "Get rid of google reviews it was not part of
// the original scope of this build anyway.") — the whole slice went in one change (BUILD_INTEGRITY
// §3, THE LAW II.5), and this suite holds every piece of it gone:
//   F  the files: the Reviews page, its four Google Business Profile panels, its adapter, the
//      /api/reviews route and its _lib/gmb helpers
//   R  the routing: no /reviews route or nav row, no /api/reviews rewrite or 6-hour cron, no
//      google-reviews branch on /api/settings, no GOOGLE_PLACE_ID constant, no GMB scopes
//      parameter on the shared Google OAuth helper
//   S  the shared record: no `reviews` slice (the Indeed count), no SET_REVIEWS, no
//      selectReviews, no guard rule or protected read for it, no crew-view classification
//   P  the permissions: no reviews.* key, no Reviews group
//   N  the bell: no newGoogleReview event, no words for it
//   M  the customer messages: no review request email or text, no review link, no walker
//   D  the Drafts list: the two review-request drafts are RETIRED in the freeze (their ids kept,
//      never reused, Matt's answers left where they are) and gone from the list
//   E  the env: no GMB_OAUTH_* or GOOGLE_PLACE_ID in .env.example
// Assertions read the source-of-truth modules (PERMISSIONS, INITIAL_STATE, ACTIONS, the message
// catalog, the manifest), never a restated literal list of what remains.
// REGRESSION (THE LAW II.3): every check fails on 9d2669cd, where all of it still ships.
//   node app/scripts/test-google-reviews-retired.mjs
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadStore, installResolveShim } from './deletion-core.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`); };
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

// ── F. the files ────────────────────────────────────────────────────────────────────────────
const GONE = [
  'src/pages/Reviews.jsx',
  'src/components/GmbPostsPanel.jsx',
  'src/components/GmbPhotosPanel.jsx',
  'src/components/GmbInsightsPanel.jsx',
  'src/components/ReviewGrowthPanel.jsx',
  'src/lib/reviewsApi.js',
  'api/reviews/[...path].js',
  'api/_lib/gmb/client.js',
  'api/_lib/gmb/store.js',
  'scripts/test-gmb-mapping.mjs',
  'scripts/test-gmb-wiring.mjs',
  'scripts/test-gmb-live.mjs',
  'scripts/test-gmb-popup-origin.mjs',
  'scripts/test-reviews-route.mjs',
];
for (const rel of GONE) ok(`F ${rel} is deleted`, !existsSync(path.join(APP, rel)));

// ── R. routing ──────────────────────────────────────────────────────────────────────────────
const app = read('src/App.jsx');
ok('R1 App.jsx has no /reviews route and no Reviews page import', !/path="reviews"/.test(app) && !/pages\/Reviews'/.test(app));
const NAV = await soft('../src/lib/navData.js');
const navRows = JSON.stringify(Object.values(NAV).filter((v) => Array.isArray(v) || (v && typeof v === 'object')));
ok('R2 no nav row opens /reviews', !NAV.__error && !/"\/reviews"/.test(navRows), NAV.__error);
ok('R3 the master search registry names no /reviews route', !/'\/reviews'/.test(read('src/lib/masterSearch/registry.js')));
ok('R4 Quick Start no longer points at /reviews', !/'\/reviews'/.test(read('src/pages/settings/QuickStart.jsx')));
let vercel = {};
try { vercel = JSON.parse(read('vercel.json')); } catch { vercel = {}; }
ok('R5 vercel.json has no /api/reviews rewrite', !(vercel.rewrites || []).some((r) => /\/api\/reviews/.test(r.source)));
ok('R6 vercel.json has no /api/reviews cron', !(vercel.crons || []).some((c) => /\/api\/reviews/.test(c.path)));
const settingsRoute = read('api/settings/[...path].js');
ok('R7 /api/settings has no google-reviews branch (the Places rating card)', settingsRoute.length > 0 && !/google-reviews/.test(settingsRoute) && !/maps\.googleapis\.com\/maps\/api\/place/.test(settingsRoute));
const CONST = await soft('../api/_lib/constants.js');
ok('R8 api/_lib/constants.js exports no place id', !CONST.__error && !('CLEANSPACE_PLACE_ID' in CONST), CONST.__error);
const google = read('api/_lib/google.js');
ok('R9 the shared Google OAuth helper takes no Business Profile scopes parameter', /export function buildConsentUrl\(state, redirectUri, creds = \{\}\)/.test(google) && !/api\/reviews/.test(google));
ok('R10 no Dashboard fetch of the Places rating card, no review goals', !/google-reviews/.test(read('src/pages/Dashboard.jsx')) && !/Google reviews|Indeed reviews/.test(read('src/pages/Dashboard.jsx')));

// ── S. the shared record ────────────────────────────────────────────────────────────────────
installResolveShim();
const { ACTIONS, INITIAL_STATE } = await loadStore();
ok('S1 INITIAL_STATE carries no `reviews` slice', !('reviews' in INITIAL_STATE));
ok('S2 ACTIONS has no SET_REVIEWS', !('SET_REVIEWS' in ACTIONS));
const SEL = await soft('../src/store/selectors.js');
ok('S3 no selectReviews selector', !SEL.__error && !('selectReviews' in SEL), SEL.__error);
const GUARD = await soft('../api/_lib/orgStateGuard.js');
ok('S4 the org-state guard no longer reads or gates a reviews slice', !GUARD.__error && !/reviews/.test(GUARD.PROTECTED_SELECT || 'reviews') && !/reviews figures/.test(read('api/_lib/orgStateGuard.js')), GUARD.__error);
const CREW = read('api/_lib/crewView.js');
ok('S5 crewView classifies no reviews slice', CREW.length > 0 && !/^\s*reviews:\s*'/m.test(CREW));
ok('S6 persist.js normalizes no reviews slice', !/s\.reviews/.test(read('src/store/persist.js')));

// ── P. permissions ──────────────────────────────────────────────────────────────────────────
const ROLES = await soft('../src/lib/roles.js');
const reviewKeys = Object.keys(ROLES.PERMISSIONS || { 'reviews.view': 1 }).filter((k) => k.startsWith('reviews.'));
ok('P1 PERMISSIONS defines no reviews.* key', !ROLES.__error && reviewKeys.length === 0, reviewKeys);
ok('P2 no Reviews group on Settings → Roles', !ROLES.__error && !(ROLES.PERM_GROUPS || [{ id: 'reviews' }]).some((g) => g.id === 'reviews' || (g.keys || []).some((k) => k.startsWith('reviews.'))));

// ── N. the bell ─────────────────────────────────────────────────────────────────────────────
const NOTIF = await soft('../src/lib/notifications.js');
const events = (NOTIF.NOTIFICATION_GROUPS || [{ events: [{ key: 'newGoogleReview' }] }]).flatMap((g) => g.events || g.items || []);
ok('N1 no newGoogleReview notification event', !NOTIF.__error && !events.some((e) => e.key === 'newGoogleReview'), NOTIF.__error);
const META = await soft('../src/lib/notificationMeta.js');
ok('N2 no notification meta for newGoogleReview', !META.__error && !('newGoogleReview' in (META.EVENT_META || { newGoogleReview: 1 })));
const EN = (await soft('../src/i18n/catalog/en.js')).default || {};
ok('N3 the catalog has no words for the retired event or nav row', !('notifPrefs.newGoogleReview' in EN) && !('nav.reviews' in EN) && Object.keys(EN).length > 0);

// ── M. the customer messages ────────────────────────────────────────────────────────────────
const CM = await soft('../src/lib/customerMessages.js');
const keys = (CM.CUSTOMER_MESSAGES || [{ key: 'review_request' }]).map((m) => m.key);
ok('M1 the catalog has no review request email or text', !CM.__error && !keys.some((k) => /^review_request/.test(k)), keys.filter((k) => /review/.test(k)));
ok('M2 no review-request key, timing or token', !CM.__error && !Object.values(CM.MESSAGE_KEY || {}).some((k) => /^review_request/.test(k))
  && !('REVIEW_REQUEST_MIN_SCORE' in CM) && !('REVIEW_REQUEST_EVERY_DAYS' in CM) && !/\{review_link\}/.test(read('src/lib/customerMessages.js')));
ok('M3 the seed carries no review request template', !CM.__error && !(CM.DEFAULT_REMINDER_TEMPLATES || []).some((t) => /^review_request/.test(t.key))
  && !(INITIAL_STATE.reminderTemplates || []).some((t) => /^review_request/.test(t.key)));
const RS = await soft('../src/lib/reminderScheduler.js');
ok('M4 the walkers have no review link rule and no review walker', !RS.__error && !('reviewLinkOf' in RS) && !/walkReviews/.test(read('src/lib/reminderScheduler.js')), RS.__error);
ok('M5 the run reads no inspections for review requests', !/readRecentInspections|reviewRequest/.test(read('api/reminders/run.js')));
ok('M6 Settings → Customer Reminders has no Google review link field', !/googleReviewUrl|review link/i.test(read('src/pages/settings/Reminders.jsx')));
ok('M7 the history checks have no "recently sent" kind (only the review requests asked it)', !/recentlySent/.test(read('api/_lib/customerMessages/checks.js')));

// ── D. the Drafts list + the freeze ─────────────────────────────────────────────────────────
const IDS = await soft('../src/data/emailDraftIds.js');
let manifest = {};
try { manifest = JSON.parse(read('src/data/reviewManifest.json')); } catch { manifest = {}; }
for (const id of ['review-request', 'review-request-sms']) {
  ok(`D1 ${id} is off the Drafts list`, !IDS.__error && !(IDS.EMAIL_DRAFT_IDS || [id]).includes(id));
  ok(`D2 ${id} stays in the freeze as RETIRED (its id is never reused; Matt's answer stays where it is)`,
    (manifest.drafts || []).includes(id) && !!manifest.retiredDrafts?.[id]?.retired);
}

// ── E. the env ──────────────────────────────────────────────────────────────────────────────
const env = read('.env.example');
ok('E1 .env.example names no GMB_OAUTH_* or GOOGLE_PLACE_ID', env.length > 0 && !/GMB_OAUTH_|GOOGLE_PLACE_ID/.test(env));

console.log(`test-google-reviews-retired: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
