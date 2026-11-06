// THE SIGN-IN PAGE'S "Forgot password?" SENDS FROM THE SYSTEM SENDER (Daniel, 2026-10-16: "Do it from
// alerts@"; CS-122). POST /api/public/auth/forgot { email } (EP-413) through the REAL handler and the
// REAL supabase-js against the local fake GoTrue + PostgREST (scripts/fake-supabase-server.mjs), with a
// working Google mailbox marked as the system sender. Offline by construction: a fetch guard answers
// the fake and the Gmail send (captured, never made) and refuses every other host.
//
// What this holds:
//   §A  the answer never says whether an address has a login: an unknown address, a banned login, a
//       Disabled team member, a customer without access (or with no row at all), the customer hub
//       preview's stand-in, a claim-less login no roster row carries, a sender that is not connected and
//       a failure on our side all answer the SAME 200 body as a real send, no-store, with no link in it
//   §B  only a login that may sign in gets an email, exactly one, from the system sender, and it is the
//       office's own reset email (src/lib/signInEmail.js setPasswordEmail 'reset', which users.js
//       sends), landing on the app's /login
//       (appPublicUrl()) — and a login that may not gets no new link made at all (a new link voids the
//       last one)
//   §C  a malformed address is a 400; the per-IP and per-address allowances (src/lib/passwordReset.js
//       FORGOT_RATE) are 429s that do not depend on the address having a login
//   §D  timing: every answer waits out the same floor (FORGOT_MIN_MS)
//   §E  one code path: the member page's reset and this one send the same email through the same
//       function, and only the office's call may be handed the link (CS-661)
//   §F  nothing left the machine; no log line carries an address or a link
//
// REGRESSION (THE LAW II.3): on the tree before the fix there is no api/public/auth route and no
// src/lib/passwordReset.js, so every route check fails (the controls in §E pass).
//
//   node app/scripts/test-forgot-password-route.mjs
import { Readable } from 'node:stream';
import { startFakeSupabase } from './fake-supabase-server.mjs';

const ORG = '00000000-0000-0000-0000-0000000f0413';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_ANON_KEY: 'fake-anon',
  FORMS_ORG_ID: ORG,
  CLEANSPACE_ORG_ID: ORG,
  APP_PUBLIC_URL: 'https://app.forgot.test',
  INBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL', 'APP_BASE_URL']) delete process.env[k];

// Every outbound request: the fake is passed through; a Gmail send is captured and answered (the
// working mailbox); anything else is refused and remembered.
const realFetch = globalThis.fetch;
const strays = [];
let gmail = [];
let gmailFails = false;
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (u.startsWith(fake.url)) return realFetch(input, init);
  if (u.includes('gmail.googleapis.com') && u.includes('/messages/send')) {
    gmail.push(Buffer.from(init?.body || '').toString('utf8'));
    return Promise.resolve(gmailFails
      ? new Response(JSON.stringify({ error: { message: 'fake: Gmail refused it' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ id: `gm_${gmail.length}`, threadId: 'th_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  strays.push(u);
  return Promise.reject(new Error(`offline suite: refused ${u}`));
};

// Every console line the routes write, kept (they must never carry an address or a link) and hidden.
const logs = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
const keep = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : x?.message || JSON.stringify(x))).join(' ')); };
console.warn = keep;
console.error = keep;

const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const route = await soft('../api/public/auth/[...path].js');
const rules = await soft('../src/lib/passwordReset.js');
const usersLib = await import('../api/_lib/users.js');
const { appPublicUrl } = await import('../api/_lib/appUrl.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
const { encrypt } = await import('../api/_lib/crypto.js');
const { hubPreviewStandInEmail } = await import('../src/lib/hubPreview.js');
const { CLIENT_USER_PREVIEW_STATUS } = await import('../src/lib/clientHub.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const settings = (await import('../api/settings/[...path].js')).default;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 200)} cache=${r?.headers?.['cache-control']}`;

// ── the world ─────────────────────────────────────────────────────────────────
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAR = '2126-01-01T00:00:00.000Z';
const login = (id, email, md = {}, extra = {}) => ({
  id, email, app_metadata: { provider: 'email', providers: ['email'], ...md }, user_metadata: {}, banned_until: null,
  created_at: '2026-09-01T12:00:00.000Z', last_sign_in_at: '2026-10-01T12:00:00.000Z', ...extra,
});
const staff = (role, orgUserId) => ({ role, org_user_id: orgUserId, org_id: ORG });
const customer = (clientUserId) => ({ role: 'client', client_user_id: clientUserId, org_id: ORG });
const CU = { pat: uuid(101), old: uuid(102), gone: uuid(103), standIn: uuid(104) };
const STAND_IN = hubPreviewStandInEmail('cl_a'); // the preview stand-in's reserved address (lib/hubPreview)
const E = {
  crew: 'crew@cs.test', office: 'office@cs.test', banned: 'banned@cs.test', disabled: 'disabled@cs.test',
  pat: 'pat@coral.test', old: 'old@coral.test', gone: 'gone@coral.test', stray: 'stray@outside.test',
  kim: 'kim@cs.test', unknown: 'nobody@nowhere.test', standIn: STAND_IN,
};
const AUTH = () => [
  login(uuid(1), E.crew, staff('crew', 'u_crew')),
  login(uuid(2), E.office, staff('owner', 'u_office')), // the shared office login: on no roster row
  login(uuid(3), E.banned, staff('crew', 'u_banned'), { banned_until: FAR }),
  login(uuid(4), E.disabled, staff('crew', 'u_disabled')),
  login(uuid(5), E.pat, customer(CU.pat)),
  login(uuid(6), E.old, customer(CU.old)),
  login(uuid(7), E.gone, customer(CU.gone)), // a customer login whose contact row is gone
  login(uuid(8), STAND_IN, customer(CU.standIn)), // a login at the preview stand-in's address
  login(uuid(9), E.stray, {}), // claim-less, on no roster row: no role, no identity
  login(uuid(10), E.kim, {}), // claim-less, but the roster carries her (active): the gates admit her
];
const member = (id, email, status = 'active', role = 'crew') => ({ id, role, status, name: id.slice(2), email });
const ROSTER = () => [
  member('u_crew', E.crew),
  member('u_banned', E.banned),
  member('u_disabled', E.disabled, 'disabled'),
  member('u_kim', E.kim),
  member('u_nologin', 'nologin@cs.test'),
];
const cuRow = (id, email, status) => ({ id, organization_id: ORG, name: email.split('@')[0], email, phone: null, status, auth_user_id: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' });
const MAILBOX = () => ({
  id: uuid(5000), organization_id: ORG, email: 'alerts@forgot.test', display_name: 'alerts@forgot.test', provider: 'google', status: 'active',
  refresh_token_enc: encrypt('refresh-token'), access_token_enc: encrypt('access-token'), access_token_expires_at: FAR,
  owner_user_id: null, workspace_id: null, is_system_sender: true,
});
function seed({ mailbox = true } = {}) {
  gmail = [];
  gmailFails = false;
  __resetRateLimit();
  __resetSystemSenderCache();
  fake.reset({
    authUsers: AUTH(),
    tokens: { tok_office: uuid(2) },
    orgState: {
      organization_id: ORG, version: 5, protected_fingerprint: null, min_client_build: null,
      state: {
        users: ROSTER(), permissions: seedPermissions(), userPermissionOverrides: [],
        company: { name: 'Forgot Test Co', timezone: 'America/New_York' },
        opsSettings: {}, payrollLines: [], reimbursements: [], sites: [], clients: [], timeOff: [],
      },
    },
    tables: {
      inbox_accounts: mailbox ? [MAILBOX()] : [],
      sent_messages: [],
      client_users: [cuRow(CU.pat, E.pat, 'active'), cuRow(CU.old, E.old, 'disabled'), cuRow(CU.standIn, STAND_IN, CLIENT_USER_PREVIEW_STATUS)],
    },
  });
}

// One call through the public route. No session, no Authorization header: the person can't sign in.
const handler = typeof route.default === 'function' ? route.default : async () => { throw new Error(`no handler: ${route.__error || 'missing'}`); };
const answers = [];
function forgot(body, { ip = '203.0.113.7', method = 'POST', sub = 'forgot' } = {}) {
  const headers = {};
  const req = { method, headers: { 'x-vercel-forwarded-for': ip, 'content-type': 'application/json' }, query: { subpath: sub }, body };
  const started = Date.now();
  return new Promise((resolve) => {
    const done = (status, b) => { const r = { status, body: b, headers, ms: Date.now() - started }; answers.push(r); resolve(r); };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      json(b) { done(this.statusCode, b); return this; },
      send(b) { done(this.statusCode, b); return this; },
      end(b) { done(this.statusCode, b ?? null); return this; },
    };
    Promise.resolve().then(() => handler(req, res)).catch((e) => done('threw', { error: e?.message || String(e) }));
  });
}
const setFloor = (ms) => route.__setForgotMinMsForTests?.(ms);
setFloor(0);

const ANSWER = rules.FORGOT_ANSWER;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const neutral = (r) => !!ANSWER && r.status === 200 && same(r.body, ANSWER) && r.headers['cache-control'] === 'no-store';
const linksMade = () => fake.requests.filter((q) => q.method === 'POST' && q.path === '/auth/v1/admin/generate_link');
const loginReads = () => fake.requests.filter((q) => q.path === '/auth/v1/admin/users');
const landing = (q) => new URLSearchParams(q.query || '').get('redirect_to') || q.body?.redirectTo || q.body?.redirect_to || null;
// A captured Gmail send: its headers and its (base64) html body.
const mime = (raw) => {
  const [head, ...rest] = String(raw).split('\r\n\r\n');
  const header = (name) => (new RegExp(`^${name}: (.*)$`, 'mi').exec(head)?.[1] || '').trim();
  const subject = header('Subject').replace(/^=\?UTF-8\?B\?(.*)\?=$/, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  return { to: header('To'), from: header('From'), subject, html: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') };
};
const { setPasswordEmail } = await import('../src/lib/signInEmail.js');
const RESET = typeof setPasswordEmail === 'function' ? setPasswordEmail('https://x.test/l', 'reset') : { subject: null };
const WANT_LANDING = `${appPublicUrl()}/login`;

ok('F0 the route and its rules load (api/public/auth, src/lib/passwordReset.js)',
  typeof route.default === 'function' && !!ANSWER && typeof rules.forgotEmail === 'function' && !!rules.FORGOT_RATE,
  route.__error || rules.__error || '');

// ── §A the same answer for every well-formed address ───────────────────────────
seed();
const control = await forgot({ email: E.crew });
ok('🔴 A0 a real send answers 200, no-store, with the one neutral body', neutral(control), show(control));
for (const [label, email] of [
  ['an unknown address', E.unknown],
  ['a banned login', E.banned],
  ['a Disabled team member (roster status disabled, login not banned)', E.disabled],
  ['a customer login without access (its row is Disabled)', E.old],
  ['a customer login whose contact row is gone', E.gone],
  ['a login at the customer hub preview stand-in\'s address', E.standIn],
  ['a claim-less login no roster row carries', E.stray],
  ['a team member with no login yet', 'nologin@cs.test'],
]) {
  seed();
  const r = await forgot({ email: email.toUpperCase() });
  ok(`🔴 A1 ${label}: the same 200 and body as a real send, no-store`, neutral(r) && same(r.body, control.body), show(r));
  ok(`🔴 A2 ${label}: nothing is emailed and no link is made (a new link would void the last one)`,
    gmail.length === 0 && linksMade().length === 0, `gmail=${gmail.length} links=${linksMade().length}`);
}
seed({ mailbox: false });
{
  const before = logs.length;
  const r = await forgot({ email: E.crew });
  ok('🔴 A3 no system sender connected: the same 200 and body, nothing sent', neutral(r) && gmail.length === 0, show(r));
  ok('🔴 A4 …and no link made, so one the office handed over keeps working', linksMade().length === 0, `links=${linksMade().length}`);
  const said = logs.slice(before).join('\n');
  ok('🔴 A5 …and one clear server line says no system sender is connected', /no system sender/i.test(said), said);
}
seed();
fake.intercept((q) => (q.path === '/auth/v1/admin/users' ? 'fail' : undefined));
{
  const r = await forgot({ email: E.crew });
  ok('🔴 A6 the logins can\'t be read (a failure on our side): the same 200 and body, nothing sent', neutral(r) && gmail.length === 0, show(r));
}
seed();
fake.failTable('org_state');
{
  const r = await forgot({ email: E.crew });
  ok('🔴 A7 the roster can\'t be read: a public caller is never let through on "couldn\'t check" (same 200, nothing sent)',
    neutral(r) && gmail.length === 0 && linksMade().length === 0, show(r));
}
seed();
gmailFails = true;
{
  const r = await forgot({ email: E.crew });
  ok('🔴 A8 the Gmail send fails: the same 200 and body', neutral(r) && gmail.length === 1, `${show(r)} gmail=${gmail.length}`);
}

// ── §B who gets an email, and which one ─────────────────────────────────────────
seed();
{
  const r = await forgot({ email: '  Crew@CS.test ' });
  const m = gmail[0] ? mime(gmail[0]) : null;
  const made = linksMade();
  ok('🔴 B1 an active staff login: exactly one email, to that login\'s own address', neutral(r) && gmail.length === 1 && m?.to === E.crew, `${show(r)} gmail=${gmail.length} to=${m?.to}`);
  ok('🔴 B2 …from the Google system sender (the marked mailbox), not Supabase\'s mailer', !!m && m.from.includes(MAILBOX().email), m?.from);
  ok('🔴 B3 …and it is the office\'s own reset email (setPasswordEmail \'reset\': the subject)', !!RESET.subject && m?.subject === RESET.subject, `${m?.subject} vs ${RESET.subject}`);
  const link = /https?:\/\/127\.0\.0\.1\/verify\?token=[0-9a-f-]+/.exec(m?.html || '')?.[0] || '';
  ok('🔴 B4 …carrying one fresh recovery link (generate_link type recovery)', made.length === 1 && made[0].body?.type === 'recovery' && !!link, `links=${made.length} type=${made[0]?.body?.type}`);
  ok(`🔴 B5 …that lands on the app's /login (${WANT_LANDING}), exactly as the office's reset does`, made.length === 1 && landing(made[0]) === WANT_LANDING, made.map(landing).join(','));
  ok('🔴 B6 …and the answer never carries the link', !!link && !JSON.stringify(r.body).includes(link.split('token=')[1]) && !/verify|token|http/i.test(JSON.stringify(r.body)), JSON.stringify(r.body));
}
for (const [label, email] of [
  ['the Super Admin\'s shared office login (an owner claim, on no roster row)', E.office],
  ['a customer login with access (its row is active)', E.pat],
  ['a claim-less login the roster carries (active)', E.kim],
]) {
  seed();
  const r = await forgot({ email });
  const m = gmail[0] ? mime(gmail[0]) : null;
  ok(`B7 control: ${label} gets its one reset email`, neutral(r) && gmail.length === 1 && m?.to === email, `${show(r)} gmail=${gmail.length} to=${m?.to}`);
}
{
  // The preview rule alone: a login at the stand-in's reserved address is never sent one, even with claims
  // every gate would admit (an owner's).
  const may = usersLib.loginMayResetOwnPassword;
  seed();
  const verdict = typeof may === 'function' ? await may(login(uuid(77), STAND_IN, staff('owner', 'u_office'))) : 'missing';
  ok('🔴 B8 the preview stand-in\'s reserved address is never sent a reset, whatever its claims (lib/hubPreview isHubPreviewEmail)', verdict === false, String(verdict));
  const banned = typeof may === 'function' ? await may(login(uuid(78), 'owner2@cs.test', staff('owner', 'u_office'), { banned_until: FAR })) : 'missing';
  ok('🔴 B9 a banned login is refused before anything else is read (users.js isLoginBanned)', banned === false, String(banned));
}

// ── §C malformed addresses and the allowances ───────────────────────────────────
seed();
for (const [label, body] of [
  ['no body', undefined],
  ['no email', {}],
  ['an empty email', { email: '   ' }],
  ['not an address', { email: 'not-an-email' }],
  ['no dot in the domain', { email: 'a@b' }],
  ['two addresses', { email: 'crew@cs.test, pat@coral.test' }],
  ['an array', { email: [E.crew] }],
  ['a line break', { email: 'crew@cs.test\r\nBcc: x@evil.test' }],
  ['an address past 254 characters', { email: `${'x'.repeat(250)}@cs.test` }],
]) {
  fake.requests.length = 0;
  const r = await forgot(body);
  ok(`🔴 C1 ${label}: 400 with the bad-email code, no-store, and no login looked up`,
    r.status === 400 && r.body?.code === rules.FORGOT_BAD_EMAIL_CODE && r.headers['cache-control'] === 'no-store' && loginReads().length === 0, show(r));
}
{
  seed();
  const per = rules.FORGOT_RATE?.perEmail || { limit: 0 };
  const rs = [];
  for (let i = 0; i < per.limit; i += 1) rs.push(await forgot({ email: E.crew }, { ip: `198.51.100.${i + 1}` }));
  const over = await forgot({ email: 'CREW@cs.test' }, { ip: '198.51.100.200' });
  ok(`🔴 C2 per address: ${per.limit} asks in the window answer 200, from any network`, per.limit > 0 && rs.every(neutral), rs.map(show).join(' | '));
  ok('🔴 C3 …the next one (another network, another case) is 429 rate-limited with Retry-After, no-store',
    over.status === 429 && over.body?.code === rules.FORGOT_RATE_LIMITED_CODE && Number(over.headers['retry-after']) > 0 && over.headers['cache-control'] === 'no-store', show(over));
  ok('🔴 C4 …so one address gets at most that many emails in the window', gmail.length === per.limit, `gmail=${gmail.length}`);
  seed();
  const unknown = [];
  for (let i = 0; i < per.limit; i += 1) unknown.push(await forgot({ email: E.unknown }, { ip: `198.51.100.${i + 1}` }));
  const unknownOver = await forgot({ email: E.unknown }, { ip: '198.51.100.201' });
  ok('🔴 C5 …and an address with no login meets the same allowance (the 429 says nothing about a login)',
    unknown.every(neutral) && unknownOver.status === 429 && same(unknownOver.body, over.body), `${show(unknownOver)} vs ${show(over)}`);
  const other = await forgot({ email: E.pat }, { ip: '198.51.100.202' });
  ok('C6 …while another address is unaffected', neutral(other), show(other));
}
{
  seed();
  const per = rules.FORGOT_RATE?.perIp || { limit: 0 };
  const rs = [];
  for (let i = 0; i < per.limit; i += 1) rs.push(await forgot({ email: `nobody${i}@nowhere.test` }, { ip: '192.0.2.50' }));
  const over = await forgot({ email: 'someone.else@nowhere.test' }, { ip: '192.0.2.50' });
  ok(`🔴 C7 per network: ${per.limit} asks from one IP answer 200`, per.limit > 0 && rs.every(neutral), rs.map(show).slice(-2).join(' | '));
  ok('🔴 C8 …the next is 429 rate-limited, before any login is looked up', over.status === 429 && over.body?.code === rules.FORGOT_RATE_LIMITED_CODE, show(over));
  const elsewhere = await forgot({ email: 'someone.else@nowhere.test' }, { ip: '192.0.2.51' });
  ok('C9 …while another network is unaffected', neutral(elsewhere), show(elsewhere));
}
{
  seed();
  const get = await forgot({ email: E.crew }, { method: 'GET' });
  const unknownBranch = await forgot({ email: E.crew }, { sub: 'reset' });
  ok('C10 only POST /forgot: a GET is 405, another branch 404, both no-store and nothing sent',
    get.status === 405 && unknownBranch.status === 404 && get.headers['cache-control'] === 'no-store' && unknownBranch.headers['cache-control'] === 'no-store' && gmail.length === 0,
    `${show(get)} | ${show(unknownBranch)}`);
}

// ── §D timing ───────────────────────────────────────────────────────────────────
{
  const FLOOR = 150;
  setFloor(FLOOR);
  seed();
  const nobody = await forgot({ email: E.unknown });
  const sent = await forgot({ email: E.crew });
  const disabled = await forgot({ email: E.disabled });
  ok(`🔴 D1 every answer waits out the floor (${FLOOR} ms here): unknown ${nobody.ms} ms, a real send ${sent.ms} ms, a Disabled member ${disabled.ms} ms`,
    route.__setForgotMinMsForTests && [nobody, sent, disabled].every((r) => neutral(r) && r.ms >= FLOOR - 5));
  setFloor(null);
  seed();
  const shipped = await forgot({ email: E.unknown });
  ok(`🔴 D2 the shipped floor is FORGOT_MIN_MS (${rules.FORGOT_MIN_MS} ms, at least a second): an unknown address took ${shipped.ms} ms`,
    Number(rules.FORGOT_MIN_MS) >= 1000 && neutral(shipped) && shipped.ms >= rules.FORGOT_MIN_MS - 5);
  setFloor(0);
}

// ── §E one code path ────────────────────────────────────────────────────────────
// The member page's reset (api/settings users/reset-link, the office) and the sign-in page's run the SAME
// users.js sendPasswordResetLink: the same link, landing and email. Only the office's call may be handed
// the link when the email can't go (CS-661); the public route never is.
const officeReset = (email) => {
  const raw = JSON.stringify({ email });
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer tok_office' };
  req.query = { subpath: 'users/reset-link' };
  const headers = {};
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers }); return this; },
    };
    Promise.resolve(settings(req, res)).catch((e) => resolve({ status: 'threw', body: { error: e?.message } }));
  });
};
{
  seed();
  await forgot({ email: E.crew });
  const mine = gmail[0] ? mime(gmail[0]) : null;
  const myLanding = linksMade().map(landing)[0];
  seed();
  const office = await officeReset(E.crew);
  const theirs = gmail[0] ? mime(gmail[0]) : null;
  ok('E1 control: the office\'s reset still emails the member (emailed:true, no link answered)',
    office.status === 200 && office.body?.emailed === true && !('link' in (office.body || {})), show(office));
  ok('🔴 E2 the two resets are one email: same subject, same sender, same landing',
    !!mine && !!theirs && mine.subject === theirs.subject && mine.from === theirs.from && myLanding === linksMade().map(landing)[0], `${mine?.subject} | ${theirs?.subject} | ${myLanding}`);
  seed({ mailbox: false });
  const handed = await officeReset(E.crew);
  ok('E3 control: with no mailbox the office is still handed the link (CS-661), no-store',
    handed.status === 200 && handed.body?.emailed === false && /^https?:\/\//.test(handed.body?.link || '') && /no-store/.test(handed.headers?.['cache-control'] || ''), show(handed));
  // The function itself: without the office's hand-over the link never comes back, even when the send fails.
  seed();
  gmailFails = true;
  const quiet = await usersLib.sendPasswordResetLink(E.crew, WANT_LANDING);
  const loud = await usersLib.sendPasswordResetLink(E.crew, WANT_LANDING, { handOver: true });
  ok('🔴 E4 sendPasswordResetLink hands the link back ONLY when the caller asks for the hand-over (the office route)',
    quiet?.emailed === false && !('link' in (quiet || {})) && loud?.emailed === false && /^https?:\/\//.test(loud?.link || ''),
    `${JSON.stringify(quiet)} | ${JSON.stringify({ ...loud, link: loud?.link ? '<link>' : loud?.link })}`);
}

// ── §F offline, and nothing private in the log ──────────────────────────────────
ok('🔴 F1 no answer ever carried a link', answers.length > 20 && answers.every((r) => !/verify\?token=|action_link/.test(JSON.stringify(r.body))), `answers=${answers.length}`);
{
  const addresses = Object.values(E).filter((x) => x.includes('@'));
  const leaked = logs.filter((l) => /verify\?token=/.test(l) || addresses.some((a) => l.toLowerCase().includes(a)));
  ok('🔴 F2 no server line carries an address or a link', logs.length > 0 && leaked.length === 0, leaked.slice(0, 3).join(' || '));
}
ok('F3 no request left the machine', strays.length === 0, strays.join(', '));

Object.assign(console, saved);
await fake.close();
console.log(`\ntest-forgot-password-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
