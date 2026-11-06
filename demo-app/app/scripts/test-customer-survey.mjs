// THE SATISFACTION SURVEY (Matt's approved messages, 2026-10-19): the walker that decides who gets
// one, the link minted at send, the customer's public page's two routes, and the office's read.
//   W  every three months per customer we serve, on their own day of the cycle (the ~750 surveys of
//      a quarter spread over its days, never all on the morning it is switched on), once a cycle,
//      a month after they joined, consent and the window as every message
//   M  mintSurvey: a 256-bit CSPRNG token, only its SHA-256 stored, the link on the app's address
//   P  EP-424 / EP-425 (api/public/qc survey): the token is the capability — a malformed one is the
//      same 404 with no read; the page sees the state and the company's name and nothing else; an
//      answer is a 1–5 rating and a comment ≤ 1,000, changeable a few times until the link closes
//      (410 after), JSON only, a honeypot, per-IP and per-link limits
//   O  EP-426 (api/qc/surveys): the office reads a customer's answers; a cleaner never (403
//      office-only); never the token or its hash
//   S  the wiring: the SPA route /survey/:token, the public domain's rewrite, English-only words
// REGRESSION (THE LAW II.3): on 811e54eb there is no survey walker, store, route or page — every
// check fails.
//   node app/scripts/test-customer-survey.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ORG = '00000000-0000-0000-0000-00000000c5a1';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };
process.env.APP_PUBLIC_URL = 'https://app.survey.test';
const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const RS = await soft('../src/lib/reminderScheduler.js');
const CM = await soft('../src/lib/customerMessages.js');
const SV = await soft('../api/_lib/customerMessages/surveys.js');
const pub = await soft('../api/public/qc/[...path].js');
const qc = await soft('../api/qc/[...path].js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const K = CM.MESSAGE_KEY || {};
ok('the walker, the store and both routes load', typeof RS.getDueMessages === 'function' && typeof SV.mintSurvey === 'function' && typeof pub.default === 'function', RS.__error || SV.__error || pub.__error);

// ── W. who gets one, when ────────────────────────────────────────────────────
const HOUR = 3600e3; const DAY = 24 * HOUR;
const NOW = new Date('2026-11-04T16:00:00.000Z');   // 11:00 New York
const N = CM.SURVEY_EVERY_DAYS || 91;
const clients = Array.from({ length: 750 }, (_, i) => ({ id: `cl_${(i * 7919).toString(36)}q${i}`, name: `Building ${i}`, email: `b${i}@corp.test`, createdAt: new Date(NOW.getTime() - 400 * DAY).toISOString() }));
const jobs = clients.map((c, i) => ({ id: `j_${i}x`, clientId: c.id, siteId: null, status: 'upcoming', startAt: new Date(NOW.getTime() + 2 * DAY).toISOString(), endAt: new Date(NOW.getTime() + 2 * DAY + HOUR).toISOString() }));
const state = (o = {}) => ({
  company: { name: 'Survey Co', timezone: 'America/New_York' },
  reminderTemplates: (CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t, enabled: t.key === K.satisfactionSurvey })),
  clients, contacts: [], sites: [], services: [], users: [], marketingSuppressions: [], ...o,
});
const surveysOn = (now, s = state(), js = jobs) => (typeof RS.getDueMessages === 'function' ? RS.getDueMessages({ state: s, jobs: js }, now) : []).filter((d) => d.templateKey === K.satisfactionSurvey);
const today = surveysOn(NOW);
ok(`🔴 W1 switching the survey on for 750 customers sends a day's share, not 750 (got ${today.length})`, today.length > 0 && today.length <= 40, today.length);
const perDay = [];
const ids = new Set();
for (let d = 0; d < N; d += 1) {
  const items = surveysOn(new Date(NOW.getTime() + d * DAY));
  perDay.push(items.length);
  for (const it of items) ids.add(it.id);
}
const keyOf = (id) => id.split(':').slice(0, 2).join(':');
const firstDay = new Set();
for (let d = 0; d < N; d += 1) for (const it of surveysOn(new Date(NOW.getTime() + d * DAY))) firstDay.add(keyOf(it.id));
ok('W2 over one cycle every customer comes due (each on its own day and the grace after)', firstDay.size === clients.length, firstDay.size);
ok(`W3 …spread out: no day carries more than ${Math.max(...perDay)} (the cycle's ${N} days share them)`, Math.max(...perDay) <= 40, perDay.slice(0, 10));
const c0 = clients[0];
const items0 = [];
for (let d = 0; d < 2 * N; d += 1) for (const it of surveysOn(new Date(NOW.getTime() + d * DAY))) if (it.refs.clientId === c0.id) items0.push(it.id);
ok('W4 a customer is due on at most DAY_GRACE_DAYS+1 days a cycle, all under ONE key per cycle (sent once a quarter)', new Set(items0).size === 2 && items0.length <= 2 * ((CM.DAY_GRACE_DAYS || 2) + 1), items0);
ok('W5 the slot is stable (the same customer, the same day of the cycle)', RS.surveySlot?.(c0.id) === RS.surveySlot?.(c0.id) && RS.surveySlot?.(c0.id) < N);
const fresh = state({ clients: clients.map((c) => ({ ...c, createdAt: new Date(NOW.getTime() - 5 * DAY).toISOString() })) });
let freshCount = 0;
for (let d = 0; d < 20; d += 1) freshCount += surveysOn(new Date(NOW.getTime() + d * DAY), fresh).length;
ok(`W6 a customer with us under ${CM.SURVEY_MIN_TENURE_DAYS} days is not surveyed`, freshCount === 0, freshCount);
let unserved = 0;
for (let d = 0; d < N; d += 1) unserved += surveysOn(new Date(NOW.getTime() + d * DAY), state(), []).length;
ok('W7 a customer with no clean in the window (not one we are serving) is not surveyed', unserved === 0, unserved);
ok('W8 the email carries the link placeholder, filled with the customer\'s own link at send', today.every((d) => d.body.includes(RS.SURVEY_LINK_PLACEHOLDER) && d.payload?.survey === true));
ok('W9 a nudge: its opt-out line', today.every((d) => /To stop these emails/.test(d.body)));
ok('W10 not at 3 a.m.', surveysOn(new Date('2026-11-04T08:00:00.000Z')).length === 0);

// ── M. minting ───────────────────────────────────────────────────────────────
function seed({ surveys = [] } = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 2, state: {
        company: { name: 'Survey Co', timezone: 'America/New_York' },
        users: [{ id: 'u_owner', role: 'owner', status: 'active', name: 'O', email: 'u_owner@example.test' }, { id: 'u_crew', role: 'crew', status: 'active', name: 'C', email: 'u_crew@example.test' }],
        permissions: seedPermissions(), userPermissionOverrides: [], clients: [{ id: 'cl_a', name: 'Coral Bay' }],
      } }],
      customer_surveys: surveys,
    },
    logins: {
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-crew': { id: 'auth-c', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
    },
  });
  __resetRateLimit();
}
seed();
const minted = SV.mintSurvey ? await SV.mintSurvey({ messageId: 'satisfaction_survey:cl_a:226', clientId: 'cl_a', contactId: 'ct_a' }) : {};
const row = (world.tables.customer_surveys || [])[0] || {};
ok('🔴 M1 the token is 32 random bytes (43 base64url characters)', /^[A-Za-z0-9_-]{43}$/.test(minted.token || ''), minted.token);
ok('🔴 M2 the table keeps only its SHA-256, never the token', row.token_hash === createHash('sha256').update(minted.token || '').digest('hex') && !JSON.stringify(world.tables.customer_surveys).includes(minted.token || '§'), row);
ok('M3 the link is on the app\'s own address', minted.link === `https://app.survey.test/survey/${minted.token}`, minted.link);
ok(`M4 the link works for ${CM.SURVEY_LINK_DAYS} days`, Math.round((Date.parse(row.expires_at) - Date.parse(row.sent_at)) / DAY) === CM.SURVEY_LINK_DAYS, row);
ok('M5 two mints are two different tokens', SV.mintSurvey && (await SV.mintSurvey({ messageId: 'm2', clientId: 'cl_a' })).token !== minted.token);

// ── P. the public page's routes ──────────────────────────────────────────────
async function call(handler, { method = 'GET', path: p, token, body, query = {}, headers = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  req.query = { ...query, subpath: p };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const hdrs = {};
      const done = (status, b) => resolve({ status, body: b, headers: hdrs });
      const res = {
        statusCode: 200,
        setHeader(k, v) { hdrs[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  } finally { Object.assign(console, quiet); }
}
let ip = 0;
const get = (t) => call(pub.default, { path: 'survey', query: { token: t }, headers: { 'x-vercel-forwarded-for': `198.51.100.${(ip += 1) % 250}` } });
const post = (b, { headers = { 'content-type': 'application/json' }, fixedIp } = {}) => call(pub.default, { method: 'POST', path: 'survey', body: b, headers: { 'x-vercel-forwarded-for': fixedIp || `198.51.100.${(ip += 1) % 250}`, ...headers } });
const surveyRow = (token, o = {}) => ({ id: `a0000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`, organization_id: ORG, token_hash: createHash('sha256').update(token).digest('hex'), message_id: 'm', client_id: 'cl_a', contact_id: null, sent_at: new Date(Date.now() - DAY).toISOString(), expires_at: new Date(Date.now() + 20 * DAY).toISOString(), rating: null, comment: null, answered_at: null, answer_count: 0, ...o });
const T1 = 'A'.repeat(43); const TX = 'B'.repeat(43);
if (typeof pub.default === 'function') {
  seed({ surveys: [surveyRow(T1), surveyRow(TX, { expires_at: new Date(Date.now() - DAY).toISOString() })] });
  const before = world.log.length;
  const bad = await get('not-a-token');
  ok('🔴 P1 a malformed token: 404 survey-not-found, and nothing is read', bad.status === 404 && bad.body?.code === 'survey-not-found' && !world.log.slice(before).some((q) => q.table === 'customer_surveys'), bad);
  const unknown = await get('C'.repeat(43));
  ok('P2 an unknown token: the same 404', unknown.status === 404 && unknown.body?.code === 'survey-not-found', unknown);
  const open = await get(T1);
  ok('P3 a live link: open, with the company\'s name, never cached', open.status === 200 && open.body?.state === 'open' && open.body?.company === 'Survey Co' && open.headers['cache-control'] === 'no-store', open);
  ok('🔴 P4 …and nothing else: no id, no customer, no token or hash', JSON.stringify(Object.keys(open.body || {}).sort()) === JSON.stringify(['comment', 'company', 'rating', 'state']), Object.keys(open.body || {}));
  ok('P5 an expired link reads as expired', (await get(TX)).body?.state === 'expired');
  ok('P6 an answer must be JSON (415)', (await post({ token: T1, rating: 5 }, { headers: { 'content-type': 'text/plain' } })).status === 415);
  for (const r of [0, 6, 2.5, 'five', null]) ok(`P7 a rating of ${JSON.stringify(r)} is refused (400 survey-rating)`, (await post({ token: T1, rating: r })).body?.code === 'survey-rating');
  ok('P8 a comment over 1,000 characters is refused', (await post({ token: T1, rating: 4, comment: 'x'.repeat(1001) })).body?.code === 'survey-comment');
  const hp = await post({ token: T1, rating: 1, website: 'http://spam' });
  ok('P9 the honeypot answers like a save and writes nothing', hp.status === 200 && !(world.tables.customer_surveys[0].answered_at), hp);
  __resetRateLimit();   // the refusals above spent this link's hourly allowance
  const saved = await post({ token: T1, rating: 5, comment: '  Great crew  ' });
  const r0 = world.tables.customer_surveys[0];
  ok('🔴 P10 a 5 with a comment is saved (trimmed), answered now', saved.status === 200 && saved.body?.state === 'answered' && r0.rating === 5 && r0.comment === 'Great crew' && !!r0.answered_at && r0.answer_count === 1, r0);
  const changed = await post({ token: T1, rating: 4, comment: '' });
  ok('P11 the answer may be changed from the same link (an empty comment clears it)', changed.status === 200 && world.tables.customer_surveys[0].rating === 4 && world.tables.customer_surveys[0].comment === null && world.tables.customer_surveys[0].answer_count === 2);
  for (let i = 0; i < 3; i += 1) await post({ token: T1, rating: 3 });
  const limited = await post({ token: T1, rating: 2 });
  ok(`P12 …at most ${SV.SURVEY_MAX_ANSWERS} times (then 429 survey-limit)`, limited.status === 429 && limited.body?.code === 'survey-limit' && world.tables.customer_surveys[0].rating === 3, limited);
  const closed = await post({ token: TX, rating: 5 });
  ok('🔴 P13 a closed link takes no answer (410 survey-expired)', closed.status === 410 && closed.body?.code === 'survey-expired' && !world.tables.customer_surveys[1].answered_at, closed);
  __resetRateLimit();
  let limitedIp = null;
  for (let i = 0; i < 40 && !limitedIp; i += 1) { const r = await post({ token: 'C'.repeat(43), rating: 5 }, { fixedIp: '192.0.2.9' }); if (r.status === 429) limitedIp = r; }
  ok('P14 one IP hammering the route is limited (429 rate-limited)', limitedIp?.body?.code === 'rate-limited', limitedIp);
}

// ── O. the office's read ─────────────────────────────────────────────────────
if (typeof qc.default === 'function') {
  seed({ surveys: [surveyRow(T1, { rating: 4, comment: 'Good', answered_at: new Date().toISOString(), answer_count: 1 }), surveyRow(TX, { client_id: 'cl_other' })] });
  const office = await call(qc.default, { path: 'surveys', token: 'tok-owner', query: { clientId: 'cl_a' } });
  ok('🔴 O1 the office reads the customer\'s surveys: theirs only, the rating and the comment', office.status === 200 && office.body?.surveys?.length === 1 && office.body.surveys[0].rating === 4 && office.body.surveys[0].comment === 'Good', office);
  ok('🔴 O2 …never the token\'s hash', !JSON.stringify(office.body || {}).includes('token') && !JSON.stringify(office.body || {}).includes(world.tables.customer_surveys[0].token_hash));
  const crew = await call(qc.default, { path: 'surveys', token: 'tok-crew', query: { clientId: 'cl_a' } });
  ok('🔴 O3 a cleaner is refused (403 office-only), whatever they hold', crew.status === 403 && crew.body?.code === 'office-only', crew);
  ok('O4 no login: 401', (await call(qc.default, { path: 'surveys', query: { clientId: 'cl_a' } })).status === 401);
  ok('O5 no customer named: 400', (await call(qc.default, { path: 'surveys', token: 'tok-owner', query: {} })).status === 400);
}

// ── S. the wiring ────────────────────────────────────────────────────────────
const read = (...p) => { try { return fs.readFileSync(path.join(APP, ...p), 'utf8'); } catch { return ''; } };
ok('S1 the SPA route /survey/:token renders the public page (no sign-in)', /<Route path="\/survey\/:token" element={<PublicSurvey \/>} \/>/.test(read('src', 'App.jsx')));
ok('S2 the public domain\'s rewrite already carries the new branch', /"\/api\/public\/qc\/:rest\*"/.test(read('vercel.json')));
const terms = await soft('../src/i18n/terms.js');
ok('S3 the page\'s words are English-only (LANG-8: what a customer reads)', terms.isEnglishOnly?.('publicSurvey.title') === true);
const en = read('src', 'i18n', 'catalog', 'en.js');
const used = [...read('src', 'pages', 'PublicSurvey.jsx').matchAll(/english\('([^']+)'/g)].map((m) => m[1]);
ok('S4 every word the page shows is in the catalog', used.length > 10 && used.every((k) => en.includes(`'${k}':`)), used.filter((k) => !en.includes(`'${k}':`)));

console.log(`test-customer-survey: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
