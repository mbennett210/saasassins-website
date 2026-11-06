// CS-648 and its family (the CS-077 class): a route that answers WITHOUT A LOGIN never puts a
// provider's own words — a database error, Google's error text, a stack-ish message, a URL that
// carries a key — into what it sends back. It answers a fixed sentence and a stable code, and the
// detail goes to the server log, which is the house pattern the public scan page set
// (api/public/scan: `console.error(...code, message)` + `{ error: SENTENCE, code }`).
//
// The family, enumerated BY CAPABILITY (every branch that answers before any login is checked —
// app/api/public/*, the OAuth callbacks Google redirects a popup to, and the public branches of
// the settings catch-all), each driven through its REAL handler over fake-supabase.mjs with a
// forced store or provider failure:
//   P  api/public/qc        the shared inspection report and its PDF          (CS-648)
//   Q  api/public/pay       the quote signing page: the view and the sign
//   S  api/settings         POST inbound/:slug (the HMAC receiver)
//   O  api/inbox/oauth/google/callback   the mailbox connect popup
//   C  api/public/scan      the reference: it already answers this way (a control, passes before)
//   M  a mechanical guard over app/api/public/**: no response there is built from `.message`
//
// (R, the Business Profile connect popup, and S's GET google-reviews left with Google reviews on
// 2026-10-20: their routes are deleted.)
//
// REGRESSION (THE LAW II.3): on the tree before the fix every P / Q / S / O check that names
// the sentence fails, and the leak checks fail where the old body carried the provider's words.
//
//   node app/scripts/test-public-error-bodies.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.INBOX_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-client-secret';
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];

// Every outbound call goes through this router; the default refuses, naming the URL (which, for
// a key-bearing provider call, carries the key — exactly the text a route must not echo).
let fetchRoute = null;
globalThis.fetch = async (url, init) => {
  if (fetchRoute) {
    const r = await fetchRoute(String(url), init);
    if (r) return r;
  }
  throw new Error(`network is blocked in this suite (${url})`);
};
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const { signState } = await import('../api/_lib/crypto.js');
const pubQc = await import('../api/public/qc/[...path].js');
const pubPay = await import('../api/public/pay/[...path].js');
const pubScan = await import('../api/public/scan/[...path].js');
const settings = await import('../api/settings/[...path].js');
const inboxCb = await import('../api/inbox/oauth/google/callback.js');
const { SCAN_UNAVAILABLE_CODE, SCAN_UNAVAILABLE_MESSAGE } = await import('../src/lib/areaScan.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail) — as test-client-hub-routes.mjs.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

// The provider's words a forced failure carries, and the internals that must never leave.
const PROVIDER_TEXT = 'relation "zz_secret_internal_table" does not exist';
const GOOGLE_TEXT = 'ZZGOOGLEZZ Malformed auth code';
const REFLECT = 'ZZREFLECTZZ';
const LEAKS = [/zz_secret/, /ZZGOOGLEZZ/, /ZZREFLECTZZ/, /network is blocked/, /googleapis\.com/];
const leaked = (text) => LEAKS.filter((re) => re.test(String(text || ''))).map(String);
const show = (r) => `${r?.status} ${typeof r?.body === 'string' ? r.body.slice(0, 220) : JSON.stringify(r?.body)?.slice(0, 220)}`;

// A request through the real handler. Logs are CAPTURED (the detail must reach them) not printed.
let logs = [];
async function call(handler, { method = 'GET', path: p, token, body, headers: extra = {}, raw = '' }) {
  const [sub, qs] = p.split('?');
  const listeners = {};
  const req = {
    method,
    headers: { 'x-forwarded-for': '203.0.113.9', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) },
    body: body || {},
    url: `/api/${p}`,
    on(ev, fn) { listeners[ev] = fn; if (ev === 'end') setTimeout(() => { if (raw) listeners.data?.(raw); fn(); }, 0); return req; },
  };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { logs.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = () => {};
  console.warn = capture;
  console.error = capture;
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 15000);
      const done = (status, b, headers) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const headers = {};
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b, headers); return this; },
        send(b) { done(this.statusCode, typeof b === 'string' ? b : b, headers); return this; },
        end(b) { done(this.statusCode, b ?? null, headers); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }, headers));
    });
  } finally { Object.assign(console, quiet); }
}
const bodyText = (r) => (typeof r?.body === 'string' ? r.body : JSON.stringify(r?.body ?? null));
// The popup page posts ONE JSON message to its opener; read it back out of the page.
function popupMessage(html) {
  const m = /postMessage\((\{[\s\S]*?\}), '\*'\)/.exec(String(html || ''));
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\u003c/g, '<')); } catch { return null; }
}
const loggedWith = (re) => logs.some((l) => re.test(l));

function seed(tables = {}) {
  resetWorld({ tables: { org_state: [{ organization_id: ORG, version: 1, state: { version: 57, company: { timezone: 'America/New_York' }, users: [], clients: [] } }], ...tables } });
  fetchRoute = null;
  logs = [];
}
// Throw from failWhen: the documented way (fake-supabase.mjs) to make a read REJECT, as a client
// whose call fails outright does — the store rethrows it with the provider's words.
const throwOn = (table) => (q) => {
  if (q.table === table) { const e = new Error(PROVIDER_TEXT); e.code = '42P01'; throw e; }
  return false;
};

// ── P. the shared inspection report (CS-648) ─────────────────────────────────
const P_CONST = pubQc.PUBLIC_REPORT_UNAVAILABLE;
for (const action of ['inspection', 'inspection-pdf']) {
  seed();
  world.failWhen = throwOn('inspection_records');
  const r = await call(pubQc.default, { path: `${action}?token=tok_pub_any` });
  ok(`🔴 P1 ${action}: a store failure answers none of the provider's words`, () => r.status !== 'threw' && leaked(bodyText(r)).length === 0, show(r));
  ok(`P2 ${action}: …it answers the route's fixed sentence and code (${P_CONST?.code})`,
    () => !!P_CONST && r.status === P_CONST.status && r.body?.error === P_CONST.error && r.body?.code === P_CONST.code, show(r));
  ok(`P3 ${action}: …and the detail is in the server log`, () => loggedWith(/zz_secret_internal_table/), logs.join(' | ').slice(0, 200));
}

// ── Q. the quote signing page ────────────────────────────────────────────────
{
  const Q = pubPay.PUBLIC_DOCUMENT_ERRORS;
  seed({ quotes: [] });
  world.failWhen = (q) => q.table === 'quotes';
  world.failMessage = PROVIDER_TEXT;
  const view = await call(pubPay.default, { path: 'tok123abc' });
  ok('🔴 Q1 the signing page\'s view: a store failure answers none of the provider\'s words', () => leaked(bodyText(view)).length === 0, show(view));
  ok('Q2 …the view\'s own sentence and code', () => !!Q && view.status === Q.view.status && view.body?.error === Q.view.error && view.body?.code === Q.view.code, show(view));
  logs = [];
  const sign = await call(pubPay.default, { method: 'POST', path: 'tok123abc/sign', body: { signerName: 'Pat', signatureDataUrl: 'data:image/png;base64,AAAA' } });
  ok('🔴 Q3 the sign: a store failure answers none of the provider\'s words', () => leaked(bodyText(sign)).length === 0, show(sign));
  ok('Q4 …the sign\'s own sentence and code (what the signer reads)', () => !!Q && sign.status === Q.sign.status && sign.body?.error === Q.sign.error && sign.body?.code === Q.sign.code, show(sign));
  ok('Q5 …and the detail is in the server log', () => loggedWith(/zz_secret_internal_table/), logs.join(' | ').slice(0, 200));
}

// ── S. the settings catch-all's public branch ─────────────────────────
{
  const S = settings.PUBLIC_SETTINGS_ERRORS;
  seed({ webhook_endpoints: [] });
  world.failWhen = (q) => q.table === 'webhook_endpoints';
  world.failMessage = PROVIDER_TEXT;
  const inbound = await call(settings.default, { method: 'POST', path: 'inbound/some-slug', raw: '{}' });
  ok('🔴 S1 POST inbound/:slug (no login): a store failure answers none of the provider\'s words', () => leaked(bodyText(inbound)).length === 0, show(inbound));
  ok('S2 …a 5xx (so the sender retries) with the receiver\'s sentence and code', () => !!S && inbound.status === S.inbound.status && inbound.status >= 500
    && inbound.body?.error === S.inbound.error && inbound.body?.code === S.inbound.code, show(inbound));
  ok('S3 …and the detail is in the server log', () => loggedWith(/zz_secret_internal_table/), logs.join(' | ').slice(0, 200));
}

// ── O. the mailbox connect popup (Google redirects here; no login, the signed state) ──
{
  const O = inboxCb.CONNECT_INBOX_ERRORS;
  const state = () => signState({ ts: Date.now(), workspaceId: null, orgUserId: 'u_owner' });
  // The token exchange fails with Google's words.
  seed({ inbox_accounts: [] });
  fetchRoute = (url) => (url.includes('oauth2.googleapis.com/token') ? jsonResponse(400, { error: 'invalid_grant', error_description: GOOGLE_TEXT }) : null);
  const ex = await call(inboxCb.default, { path: `inbox/oauth/google/callback?code=x&state=${encodeURIComponent(state())}` });
  const exMsg = popupMessage(ex.body);
  ok('🔴 O1 a failed code exchange: the page and its message carry none of Google\'s words', () => ex.status === 200 && leaked(ex.body).length === 0, show(ex));
  ok('O2 …the popup still reports a failure, in the route\'s sentence, with its code', () => !!O && exMsg?.type === 'connect-inbox' && exMsg.error === O.failed.error && exMsg.code === O.failed.code, JSON.stringify(exMsg));
  ok('O3 …and Google\'s reason is in the server log', () => loggedWith(/ZZGOOGLEZZ/), logs.join(' | ').slice(0, 200));
  // The exchange works and the mailbox read works; the database refuses the save's lookup.
  seed({ inbox_accounts: [] });
  fetchRoute = (url) => {
    if (url.includes('oauth2.googleapis.com/token')) return jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    if (url.includes('gmail.googleapis.com')) return jsonResponse(200, { emailAddress: 'office@example.test', historyId: '1' });
    return null;
  };
  world.failWhen = (q) => q.table === 'inbox_accounts';
  world.failMessage = PROVIDER_TEXT;
  const db = await call(inboxCb.default, { path: `inbox/oauth/google/callback?code=x&state=${encodeURIComponent(state())}` });
  ok('🔴 O4 a database failure during the connect: none of the provider\'s words in the page', () => db.status === 200 && leaked(db.body).length === 0, show(db));
  ok('O5 …the same sentence and code', () => !!O && popupMessage(db.body)?.error === O.failed.error && popupMessage(db.body)?.code === O.failed.code, JSON.stringify(popupMessage(db.body)));
  // Google sends ?error= back (the person declined, or anything else): it is not reflected.
  seed();
  const refl = await call(inboxCb.default, { path: `inbox/oauth/google/callback?error=${encodeURIComponent(`${REFLECT}<b>`)}` });
  ok('🔴 O6 an ?error= from the redirect is never written back into the page', () => refl.status === 200 && leaked(refl.body).length === 0 && !/<b>/.test(refl.body), show(refl));
  const declined = await call(inboxCb.default, { path: 'inbox/oauth/google/callback?error=access_denied' });
  ok('O7 …a declined consent says so in the route\'s words', () => !!O && popupMessage(declined.body)?.error === O.denied.error && popupMessage(declined.body)?.code === O.denied.code, show(declined));
}

// ── C. the reference: the public scan page already answers this way ─────────
{
  seed();
  world.failWhen = throwOn('area_scan_codes');
  const r = await call(pubScan.default, { path: `area?token=${'A'.repeat(32)}` });
  ok('C1 (control) the QR scan page: a store failure answers its sentence and code, none of the provider\'s words',
    () => r.status === 503 && r.body?.error === SCAN_UNAVAILABLE_MESSAGE && r.body?.code === SCAN_UNAVAILABLE_CODE && leaked(bodyText(r)).length === 0, show(r));
}

// ── M. a mechanical guard: nothing under app/api/public/ answers with `.message` ──
{
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(n)) files.push(p); } };
  walk(path.join(APP, 'api', 'public'));
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/res\.(status|json|send)\(/.test(line) && /\b(e|err|error)\??\.message\b/.test(line)) hits.push(`${path.relative(APP, f)}:${i + 1}`);
    });
  }
  ok(`M1 no response under app/api/public/ is built from an error's .message (${files.length} files; hits: ${hits.join(', ') || 'none'})`, () => files.length >= 3 && hits.length === 0);
}

console.log(`\ntest-public-error-bodies: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
