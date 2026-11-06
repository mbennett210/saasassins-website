// test-app-links — every link a person follows out of an email lands on the app's own address
// (DEV_PLAYBOOK 3.4.18, UI_RULES §129; CS-287 the Clean Corner move, CS-111 the unset APP_* URLs).
//
// WHY. The app's address is https://www.cleancorner.app (checked live 2026-10-03: cleancorner.app
// answers 308 to https://www.cleancorner.app, which answers 200), and the old alias
// cleanspace-gilt.vercel.app still serves the same deployment. A session lives per origin, so a link
// built from a request's Host, or from the tab's own origin, sends a customer or a new member to
// whichever alias the office user happened to be signed in on, where they sign in again. And the
// brand pack still named the old alias, so the client hub's emails linked there outright.
//
//   1. the address: Clean Space's brand pack names the live address, and IDENTITY is the active pack's
//   2. the server's resolver (api/_lib/appUrl.js): APP_PUBLIC_URL, else APP_BASE_URL, else the pack's
//   3. the server's ledger: a read of a request's Host or Origin in app/api is an OAuth redirect or a
//      printed QR code's LAST-RESORT base, each named below with its reason; the link builders read
//      none and call the resolver — and since 2026-10-16 so do the printed codes (a label outlives
//      every alias, so it follows the emailed links' rule); no link is built from a URL Vercel injects
//      (its pick of a production domain); and the marketing unsubscribe link (a link in an email too)
//      lands on the resolver's address
//   4. the real Settings → Team route (the real handler and supabase-js against the local fake
//      GoTrue): an invite and a password reset made from another alias land on the app's /login
//   5. the browser (src/lib/appLink.js): the pack's address in a deployed build, the page's own
//      origin in dev and the demo; and its ledger of every place app/src reads the page's origin
//
// Offline: the fake answers every Supabase call and a fetch guard refuses any other host.
//   node app/scripts/test-app-links.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeSupabase } from './fake-supabase-server.mjs';
import { seedPermissions } from '../src/lib/roles.js';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.join(APP, '..');
let pass = 0;
const fails = [];
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir, re, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, re, out); } else if (re.test(e.name)) out.push(p);
  }
  return out;
};
const rel = (from, p) => path.relative(from, p).split(path.sep).join('/');
// A line that is only a comment (the ledgers read code, not prose about it)
const isCommentLine = (l) => /^\s*(\/\/|\/?\*)/.test(l);

// ── 1. the address ────────────────────────────────────────────────────────────
// The live address is a fact about the deployment (the domain on the Vercel team), so it is pinned
// here as the requirement it is: Clean Space's pack must name it, whichever pack is active.
const LIVE = 'https://www.cleancorner.app';
const cleanspace = JSON.parse(read(ROOT, 'brands', 'cleanspace', 'brand.json'));
ok(`Clean Space's brand pack names the app's live address (${LIVE})`, cleanspace.appUrl === LIVE, cleanspace.appUrl);
const { IDENTITY } = await import(pathToFileURL(path.join(APP, 'src', 'brand', 'identity.generated.js')).href);
const activePack = JSON.parse(read(ROOT, 'brands', IDENTITY.id, 'brand.json'));
ok("IDENTITY.appUrl is the active pack's appUrl", IDENTITY.appUrl === activePack.appUrl, IDENTITY.appUrl);

// ── 2. the server's resolver ─────────────────────────────────────────────────
let appPublicUrl = null;
try { ({ appPublicUrl } = await import('../api/_lib/appUrl.js')); } catch { /* missing before the fix: the checks below fail */ }
ok('api/_lib/appUrl.js exports appPublicUrl()', typeof appPublicUrl === 'function');
if (typeof appPublicUrl === 'function') {
  ok('with no APP_* env, the address is the brand pack\'s (IDENTITY.appUrl)', appPublicUrl({}) === IDENTITY.appUrl, appPublicUrl({}));
  ok('APP_PUBLIC_URL wins, without its trailing slash', appPublicUrl({ APP_PUBLIC_URL: 'https://a.example/', APP_BASE_URL: 'https://b.example' }) === 'https://a.example');
  ok('then APP_BASE_URL', appPublicUrl({ APP_BASE_URL: 'https://b.example//' }) === 'https://b.example');
  ok('a blank env value falls through to the pack', appPublicUrl({ APP_PUBLIC_URL: '   ', APP_BASE_URL: '' }) === IDENTITY.appUrl);
}

// ── 3. the server's ledger ────────────────────────────────────────────────────
// Every read of a request's Host or Origin header in app/api. Only these may read one, and each says
// why the request's own origin is right there. A link a person follows out of an email (an invite,
// a reset, a quote, the client hub's) is not one of them: it comes from appPublicUrl().
const HOST_ALLOWED = new Map([
  ['inbox/connect/start.js', "the Gmail inbox OAuth consent: its redirect URI must come back to the origin the consent started on (INBOX_INBOUND_BASE_URL pins it)"],
  ['inbox/oauth/google/callback.js', 'the same inbox OAuth redirect URI, which the code exchange must repeat verbatim'],
  ['scan-codes/[...path].js', "a printed QR code's base is appPublicUrl(); the office request's own origin is read only as the last resort when no address is configured at all (UI_RULES §139)"],
]);
const HOST_READ = /x-forwarded-host|\bheaders\s*(?:\?\.)?\s*(?:\.\s*(?:host|origin)\b|\[\s*['"](?:host|origin)['"]\s*\])/i;
const API = path.join(APP, 'api');
const hostReads = new Map();
for (const f of walk(API, /\.(js|mjs)$/)) {
  const lines = read(f).split('\n');
  lines.forEach((l, i) => {
    if (!isCommentLine(l) && HOST_READ.test(l)) {
      const r = rel(API, f);
      hostReads.set(r, [...(hostReads.get(r) || []), i + 1]);
    }
  });
}
const strays = [...hostReads.keys()].filter((r) => !HOST_ALLOWED.has(r));
ok('no server file builds a link from the request\'s Host or Origin outside the OAuth redirects and the QR base',
  strays.length === 0, strays.map((r) => `${r}:${hostReads.get(r).join(',')}`).join('; '));
const stale = [...HOST_ALLOWED.keys()].filter((r) => !hostReads.has(r));
ok('every file the ledger allows still reads one (the list is current)', stale.length === 0, stale.join('; '));
ok('every allowed read states its reason', [...HOST_ALLOWED.values()].every((why) => why.length > 30));
// public/auth: the sign-in page's "Forgot password?" (EP-413, CS-122) — its reset link's landing is built
// here on the server since 2026-10-16, where AuthProvider used to build it with appLink.
for (const r of ['_lib/clientHub/notify.js', 'quotes/[...path].js', 'settings/[...path].js', 'client-users/[...path].js', '_lib/marketing/compliance.js', 'scan-codes/[...path].js', 'public/auth/[...path].js']) {
  const text = read(API, ...r.split('/'));
  ok(`${r} takes its link's address from appPublicUrl()`, /\bappPublicUrl\(\)/.test(text) && /from '\.{1,2}(?:\/\.\.)*\/(?:_lib\/)?appUrl\.js'/.test(text));
}
// Vercel injects VERCEL_URL (the deployment's own host) and VERCEL_PROJECT_PRODUCTION_URL (ITS pick of a
// production domain: the shortest custom one, which can be a bare domain that only redirects, as
// cleancorner.app does). Neither is the address a reader should land on; the brand pack names that one.
const VERCEL_URL_READ = /\bVERCEL_(?:URL|BRANCH_URL|PROJECT_PRODUCTION_URL)\b/;
const vercelReads = [];
for (const f of walk(API, /\.(js|mjs)$/)) {
  read(f).split('\n').forEach((l, i) => { if (!isCommentLine(l) && VERCEL_URL_READ.test(l)) vercelReads.push(`${rel(API, f)}:${i + 1}`); });
}
ok('no server file builds a link from a URL Vercel injects (VERCEL_URL, VERCEL_PROJECT_PRODUCTION_URL)', vercelReads.length === 0, vercelReads.join('; '));
// The marketing unsubscribe link, in the CAN-SPAM footer and the one-click List-Unsubscribe header: the
// tenant's own address when Marketing settings name one (the server's cron reads it), else
// INBOX_INBOUND_BASE_URL, else appPublicUrl(). Driven with Vercel's variable set, as it is on every deployment.
{
  const keys = ['APP_PUBLIC_URL', 'APP_BASE_URL', 'INBOX_INBOUND_BASE_URL', 'VERCEL_PROJECT_PRODUCTION_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cleancorner.app';
  try {
    const { unsubscribeUrl, buildUnsubscribeCompliance } = await import('../api/_lib/marketing/compliance.js');
    const want = `${IDENTITY.appUrl}/api/unsubscribe?t=`;
    const u = unsubscribeUrl('lead@links.test');
    ok(`the marketing unsubscribe link lands on the app's address (${want}…)`, u.startsWith(want), u);
    const c = buildUnsubscribeCompliance({ recipient: 'lead@links.test', isHtml: false, config: {}, companyName: 'Links Test', inboxEmail: 'hello@links.test' });
    ok('  ...and so does the one-click List-Unsubscribe header', c.listUnsubscribe.startsWith(`<${want}`), c.listUnsubscribe);
    ok("  ...while a tenant's own unsubscribe address still wins", unsubscribeUrl('lead@links.test', 'https://mail.tenant.test/').startsWith('https://mail.tenant.test/api/unsubscribe?t='));
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ── 4. the real Settings → Team route ────────────────────────────────────────
const ORG = '00000000-0000-0000-0000-0000000a11c5';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_ANON_KEY: 'fake-anon',
  FORMS_ORG_ID: ORG,
  CLEANSPACE_ORG_ID: ORG,
});
// no system sender (so no email can leave), and no APP_* address: the brand pack's must be the one used
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'INBOX_INBOUND_BASE_URL']) delete process.env[k];
const realFetch = globalThis.fetch;
const offHost = [];
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!u.startsWith(fake.url)) { offHost.push(u); return Promise.reject(new Error(`offline suite: refused ${u}`)); }
  return realFetch(input, init);
};
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};
try {
  const settings = (await import('../api/settings/[...path].js')).default;
  const authUser = (email, role, orgUserId) => ({
    id: randomUUID(), email, user_metadata: {}, banned_until: null,
    app_metadata: { provider: 'email', providers: ['email'], role, org_user_id: orgUserId, org_id: ORG },
  });
  const owner = authUser('owner@links.test', 'owner', 'u_owner');
  const crew = authUser('crew@links.test', 'crew', 'u_crew');
  const reset = () => fake.reset({
    authUsers: [owner, crew],
    tokens: { tok_owner: owner.id },
    orgState: {
      organization_id: ORG, version: 3, protected_fingerprint: null, min_client_build: null,
      state: {
        users: [
          { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: owner.email },
          { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: crew.email },
        ],
        permissions: seedPermissions(), userPermissionOverrides: [],
        company: { name: 'Links Test', timezone: 'America/New_York' },
        opsSettings: {}, payrollLines: [], reimbursements: [], sites: [], clients: [], timeOff: [],
      },
    },
    timeEntries: [],
  });
  // POST /api/settings/users[/sub] as the owner, signed in on an alias that is not the app's address
  const ALIAS = 'cs-preview-a1b2.vercel.app';
  const call = async (sub, body) => {
    const raw = JSON.stringify(body);
    const req = Readable.from([Buffer.from(raw)]);
    req.method = 'POST';
    req.headers = { authorization: 'Bearer tok_owner', host: ALIAS, 'x-forwarded-host': ALIAS, origin: `https://${ALIAS}` };
    req.query = { subpath: sub ? `users/${sub}` : 'users' };
    // setHeader as a real response has it: an answer carrying a one-time link is no-store (CS-661).
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(o) { this.body = o; return this; } };
    await settings(req, res);
    return res;
  };
  // where the set-password link lands: the redirect supabase-js asked GoTrue for
  const landings = () => fake.requests
    .filter((q) => q.method === 'POST' && q.path === '/auth/v1/admin/generate_link')
    .map((q) => new URLSearchParams(q.query || '').get('redirect_to') || q.body?.redirectTo || q.body?.redirect_to || null);
  const want = `${IDENTITY.appUrl}/login`;

  reset();
  const inv = await call('', { email: 'new.member@links.test', role: 'crew', orgUserId: 'u_new_member' });
  ok('the owner\'s invite is accepted (the drive reached the link)', inv.statusCode === 200, inv);
  ok(`an invite made on another alias lands on the app's /login (${want})`, landings().length === 1 && landings()[0] === want, landings());

  reset();
  await call('reset-link', { email: crew.email });
  ok(`a password reset made on another alias lands on the app's /login (${want})`, landings().length === 1 && landings()[0] === want, landings());
  ok('the drive stayed offline (no request left for any other host)', offHost.length === 0, offHost);
} finally {
  console.warn = quiet.warn;
  console.error = quiet.error;
  globalThis.fetch = realFetch;
  await fake.close();
}

// ── 5. the browser ────────────────────────────────────────────────────────────
let link = null;
try { link = await import('../src/lib/appLink.js'); } catch { /* missing before the fix: the checks below fail */ }
ok('src/lib/appLink.js exports appLinkBase() and isDeployedBuild()', typeof link?.appLinkBase === 'function' && typeof link?.isDeployedBuild === 'function');
if (typeof link?.appLinkBase === 'function' && typeof link?.isDeployedBuild === 'function') {
  ok('a deployed build links to the brand pack\'s address, whatever alias the tab is on',
    link.appLinkBase({ deployed: true, origin: 'https://cleanspace-gilt.vercel.app' }) === IDENTITY.appUrl);
  ok('the dev server and the demo link to the page\'s own origin',
    link.appLinkBase({ deployed: false, origin: 'http://localhost:5242' }) === 'http://localhost:5242');
  ok('"deployed" is a production build that is not the demo',
    link.isDeployedBuild({ PROD: true, MODE: 'production' }) === true
    && link.isDeployedBuild({ PROD: true, MODE: 'demo' }) === false
    && link.isDeployedBuild({ PROD: false, MODE: 'development' }) === false
    && link.isDeployedBuild({}) === false);
}
// Every place app/src reads the page's own origin. A link that LEAVES the browser (a quote's or an
// inspection report's link the office copies into an email, an emailed invite) goes through appLink;
// only these keep the page's origin, each for its reason. (A password reset's landing is the server's
// now: "Forgot password?" posts to api/public/auth, which reads appPublicUrl() — section 3.)
const ORIGIN_ALLOWED = new Map([
  ['lib/appLink.js', "the helper itself: the page's own origin on the dev server and in the demo"],
  ['components/ContactDocuments.jsx', 'opens the public quote in a new tab for the office user; nothing leaves the browser'],
  ['components/WebhooksSection.jsx', "an inbound webhook's endpoint, shown to configure an integration from this deployment"],
  ['components/LeadWebhooksSection.jsx', "a lead webhook's endpoint, shown to configure an integration from this deployment"],
  ['lib/connectedInboxes.js', "the inbox OAuth popup's postMessage check: it must be this page's own origin"],
  ['lib/qboApi.js', "the QuickBooks OAuth popup's postMessage check: it must be this page's own origin"],
  ['pages/review/MockupFrame.jsx', "a Review design question's mockup: the postMessage to its own srcdoc frame, which has this page's origin (UI_RULES §179)"],
  ['lib/scanCodesApi.js', "the QR demo's printed base: the demo has no deployment address, so its codes print the page's own origin (UI_RULES §139)"],
  ['lib/twilio.js', "the texting demo stub's inbound webhook on this page's origin"],
]);
const SRC = path.join(APP, 'src');
const originReads = new Map();
for (const f of walk(SRC, /\.(js|jsx|mjs)$/)) {
  read(f).split('\n').forEach((l, i) => {
    if (!isCommentLine(l) && /\blocation\s*(?:\?\.|\.)\s*origin\b/.test(l)) {
      const r = rel(SRC, f);
      originReads.set(r, [...(originReads.get(r) || []), i + 1]);
    }
  });
}
const loose = [...originReads.keys()].filter((r) => !ORIGIN_ALLOWED.has(r));
ok('no link that leaves the browser is built from the page\'s own origin (it reads appLink)',
  loose.length === 0, loose.map((r) => `${r}:${originReads.get(r).join(',')}`).join('; '));
const staleOrigin = [...ORIGIN_ALLOWED.keys()].filter((r) => !originReads.has(r));
ok('every browser file the ledger allows still reads the origin (the list is current)', staleOrigin.length === 0, staleOrigin.join('; '));
for (const r of ['pages/QuoteEditor.jsx', 'pages/Quotes.jsx', 'pages/Inspections.jsx', 'components/InspectionReportModal.jsx', 'lib/email.js']) {
  ok(`${r} builds its outgoing link with appLink()`, /\bappLink\(/.test(read(SRC, ...r.split('/'))));
}

console.log(`\ntest-app-links: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
}
