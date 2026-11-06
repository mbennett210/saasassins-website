// SIGN-IN LINKS GO BY EMAIL ONLY (Daniel, 2026-10-28, once Twilio went live). The approved A2P
// campaign covers the customer texts only (the 24-hour reminder, the day-of reminder, On my way),
// so the app never texts a sign-in link: not a new cleaner's set-password link (GO-7's text) and
// not a new customer's hub invite. Replace means delete (THE LAW II.5): the text path is gone, not
// switched off. With no mailbox the office hand-over is the fallback, as it always was.
//
// The REAL handlers (api/settings users, api/client-users invite) over scripts/fake-supabase.mjs,
// Gmail and Twilio captured by a stubbed fetch, with texting SET UP and a number on file, so a
// text path left anywhere would show.
//   E1  a new cleaner with a phone: emailed, never texted; the answer has no `texted`
//   E2  …no mailbox: never texted, the office is handed the link (the hand-over)
//   E3  a new customer contact with a phone: the hub invite is emailed, never texted
//   E4  the text path is gone from the code: users.js no longer reaches the send step or Twilio,
//       and the words of a texted link are gone from the catalog
// REGRESSION (THE LAW II.3): on e489af8f the cleaner and the customer are both texted (E1, E2,
// E3 fail) and the text path is there (E4 fails).
//   node app/scripts/test-sign-in-links-email-only.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';

const ORG = '00000000-0000-0000-0000-000000000e01';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG, APP_PUBLIC_URL: 'https://app.email-only.test', INBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'),
  TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MGfake',
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL', 'TWILIO_FROM_NUMBER']) delete process.env[k];

let wire = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  wire.push({ url: u, body: init?.body });
  if (u.includes('gmail.googleapis.com') && u.includes('/messages/send')) return { ok: true, status: 200, json: async () => ({ id: 'gm_1', threadId: 't' }) };
  if (u.startsWith('https://api.twilio.com/')) return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }) };
  throw new Error(`network is blocked in this suite (${u})`);
};
const gmail = () => wire.filter((w) => w.url.includes('/messages/send'));
const texts = () => wire.filter((w) => w.url.startsWith('https://api.twilio.com/'));

const { installFakeSupabase, resetWorld } = await import('./fake-supabase.mjs');
installFakeSupabase();
const { seedPermissions } = await import('../src/lib/roles.js');
const { encrypt } = await import('../api/_lib/crypto.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
const clientUsers = (await import('../api/client-users/[...path].js')).default;
const settings = (await import('../api/settings/[...path].js')).default;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OFFICE = { id: uuid(9001), email: 'office@eo.test', app_metadata: { provider: 'email', providers: ['email'], role: 'owner', org_user_id: 'u_office', org_id: ORG }, banned_until: null, created_at: '2026-09-01T00:00:00Z' };
const FAR = new Date(Date.now() + 7 * 864e5).toISOString();
const MAILBOX = () => ({ id: uuid(5000), email: 'mail@eo.test', display_name: 'mail@eo.test', provider: 'google', status: 'active', refresh_token_enc: encrypt('r'), access_token_enc: encrypt('a'), access_token_expires_at: FAR, owner_user_id: null, is_system_sender: true });
const cuRow = (id, email, phone) => ({ id, organization_id: ORG, name: email.split('@')[0], email, phone, status: 'invited', auth_user_id: null, invited_at: null, invited_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });

function seed({ mailbox = true, clientUsersRows = [], assignments = [] } = {}) {
  wire = [];
  __resetSystemSenderCache();
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: { users: [{ id: 'u_office', role: 'owner', email: OFFICE.email, name: 'Office', status: 'active' }], permissions: seedPermissions(), userPermissionOverrides: [], clients: [], company: { name: 'Clean Co', timezone: 'America/New_York' } } }],
      client_users: clientUsersRows, client_user_assignments: assignments, client_user_groups: [], client_user_group_members: [],
      inbox_accounts: mailbox ? [MAILBOX()] : [], sent_messages: [],
    },
    logins: { 'tok-office': OFFICE },
    authUsers: [OFFICE],
  });
}
function respond(handler, req) {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return new Promise((resolve) => {
    const done = (status, body) => { Object.assign(console, quiet); resolve({ status, body }); };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
    Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message || String(e) }));
  });
}
const invite = (body) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer tok-office' };
  req.query = { subpath: 'users' };
  return respond(settings, req);
};
const cuInvite = (id) => respond(clientUsers, { method: 'POST', headers: { authorization: 'Bearer tok-office' }, query: { subpath: 'invite' }, body: { id } });

// ── E1–E2: a new cleaner ────────────────────────────────────────────────────
seed();
let r = await invite({ email: 'ana@eo.test', role: 'crew', orgUserId: 'u_ana', phone: '(754) 555-0123' });
ok('🔴 E1 a new cleaner with a phone: the link is EMAILED, never texted', r.status === 200 && r.body?.invited === true && gmail().length === 1 && texts().length === 0, { r, gmail: gmail().length, texts: texts().length });
ok('🔴 E1 …and the answer says nothing of a text', r.body && !('texted' in r.body) && !('emailed' in r.body), r.body);
seed({ mailbox: false });
r = await invite({ email: 'ben@eo.test', role: 'crew', orgUserId: 'u_ben', phone: '754-555-0124' });
ok('🔴 E2 no mailbox: never texted — the office is handed the link, as before', r.status === 200 && texts().length === 0 && r.body?.invited === false && typeof r.body?.link === 'string' && !('texted' in r.body), { r, texts: texts().length });

// ── E3: a new customer contact ──────────────────────────────────────────────
const CU = uuid(11);
seed({ clientUsersRows: [cuRow(CU, 'pat@coral.test', '754-555-0201')], assignments: [{ id: uuid(21), organization_id: ORG, client_user_id: CU, client_id: 'cl_real1x', group_id: null }] });
r = await cuInvite(CU);
ok('🔴 E3 a customer contact with a phone: the hub invite is emailed, never texted', r.status === 200 && gmail().length === 1 && texts().length === 0 && !('texted' in (r.body || {})), { r, texts: texts().length });

// ── E4: the text path is gone ───────────────────────────────────────────────
const usersSrc = readFileSync(new URL('../api/_lib/users.js', import.meta.url), 'utf8');
ok('🔴 E4 users.js no longer reaches the customer-message send step or Twilio', !/customerMessages\/send\.js/.test(usersSrc) && !/sms\/twilio\.js/.test(usersSrc) && !/sendCustomerMessage|smsConfigured/.test(usersSrc));
const en = readFileSync(new URL('../src/i18n/catalog/en.js', import.meta.url), 'utf8');
ok('🔴 E4 …and the words of a texted link are gone from the catalog', !/'loginText\.staffInvite'|'signInLink\.texted'|'clientLogins\.inviteTexted'|'clientLogins\.inviteEmailedTexted'/.test(en));

console.log(`test-sign-in-links-email-only: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
