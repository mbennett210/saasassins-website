// The app's own email, through Google — CS-012, CS-039, CS-015, CS-280 (2026-09-29).
//
// Daniel, 2026-09-29: "Clean Space sends email through Google, NOT Resend." One connected
// Google mailbox is marked as the SYSTEM SENDER and every system send leaves as that
// mailbox over the Gmail API. This suite drives the REAL handlers
// (api/email/send.js, api/email/health.js, api/email/system-sender.js) through
// fake-supabase.mjs with `fetch` stubbed at the Gmail endpoint: no network, no credentials,
// and nothing can put mail on the wire.
//
// What it pins, and what each check would have caught before the change:
//   CS-012  no sending mailbox -> every send is SKIPPED with a 503 and a clear reason,
//           and NOTHING is attempted at Google. (Before: the same shape, but keyed on a
//           RESEND_API_KEY that was never set in production, so all system email was dead.)
//   CS-039  the sender is chosen from the CONNECTED mailboxes by an owner-only server
//           route. There is no field that swallows a pasted secret and reports success.
//   CS-015  /api/email/send is not an open company-domain relay: crew are refused, `to`
//           must be ONE address (an array used to pass the regex after String()), the
//           recipient count is capped at _lib/email.js MAX_RECIPIENTS, and caller headers
//           are stripped to the two threading ones.
//   CS-280  health reports the Google sender, not a Resend "verified domain" that never had
//           DKIM/SPF records in public DNS.
//
//   node scripts/test-email-system-sender.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000001';
// Set BEFORE anything under api/ loads. The URL is a closed local port and fetch is stubbed.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.INBOX_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
delete process.env.SYSTEM_SENDER_EMAIL;

// Every outbound request is captured, never made. A Gmail send answers as Google does.
let wire = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  wire.push({ url: u, body: init?.body });
  if (u.includes('gmail.googleapis.com') && u.includes('/messages/send')) {
    return { ok: true, status: 200, json: async () => ({ id: 'gm_1', threadId: 'th_1' }) };
  }
  throw new Error(`network is blocked in this suite (${u})`);
};
const sends = () => wire.filter((w) => w.url.includes('/messages/send'));
// The RFC-822 bytes of the last Gmail send (uploadType=media sends them raw).
const lastMime = () => {
  const s = sends();
  return s.length ? Buffer.from(s[s.length - 1].body).toString('utf8') : '';
};
const headerBlock = () => lastMime().split('\r\n\r\n')[0].split('\r\n');
const fieldLines = (name) => headerBlock().filter((l) => !/^[ \t]/.test(l) && l.toLowerCase().startsWith(`${name.toLowerCase()}:`));

installFakeSupabase();
const { encrypt } = await import('../api/_lib/crypto.js');
const { MAX_RECIPIENTS } = await import('../api/_lib/email.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
const emailSend = (await import('../api/email/send.js')).default;
const emailHealth = (await import('../api/email/health.js')).default;
const systemSenderRoute = (await import('../api/email/system-sender.js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── the people ──────────────────────────────────────────────────────────────────
// integrations.manage defaults to owner + manager; settings.team.edit to owner + admin +
// manager. So admin reaches /api/email/send by the invite capability and NOT by the
// integrations one, and crew reaches it by neither.
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },  // claim-less, as live
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crewG: { id: 'u_crew_g', role: 'crew', claim: true }, // granted settings.team.edit
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`,
  email: emailOf(k),
  app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const OVERRIDES = [{ userId: 'u_crew_g', grants: ['settings.team.edit'], revokes: [] }];

const FAR_FUTURE = new Date(Date.now() + 7 * 24 * 3600e3).toISOString();
const mailbox = (id, email, extra = {}) => ({
  id,
  email,
  display_name: email,
  provider: 'google',
  status: 'active',
  refresh_token_enc: encrypt('refresh-token'),
  access_token_enc: encrypt('access-token'),
  access_token_expires_at: FAR_FUTURE,
  owner_user_id: null,
  is_system_sender: false,
  ...extra,
});

function buildWorld({ inboxes = [], overrides = OVERRIDES } = {}) {
  wire = [];
  __resetSystemSenderCache();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG,
        state: { users: roster, permissions: seedPermissions(), userPermissionOverrides: overrides, company: { name: 'Co', email: 'office@example.test' } },
        version: 1,
      }],
      inbox_accounts: inboxes,
      sent_messages: [],
    },
    logins,
  });
}

async function call(handler, { method = 'GET', token, body, query = {} } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = query;
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 5000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally {
    Object.assign(console, quiet);
  }
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const post = (who, body) => call(emailSend, { method: 'POST', token: `tok-${who}`, body });
const GOOD = { to: 'client@example.test', from: 'Office <office@example.test>', subject: 'Hi', body: 'Hello there.' };

// ═══ 1. CS-012 — no sending mailbox: skipped, loudly, and nothing reaches Google ═══
buildWorld({ inboxes: [] });
{
  const r = await post('owner', GOOD);
  ok('no system sender: /api/email/send → 503', r.status === 503, show(r));
  ok("  ...and the error says email isn't set up", /isn't set up|not set up/i.test(r.body?.error || ''), show(r));
  ok('  🔴 ...and NOTHING was attempted at Google', sends().length === 0, JSON.stringify(wire.map((w) => w.url)));
}
{
  const r = await call(emailHealth, { token: 'tok-owner' });
  ok('no system sender: health → not_started', r.body?.status === 'not_started' && r.body?.configured === false, show(r));
  ok('  ...and it names Google, not a provider that was never configured', r.body?.provider === 'google', show(r));
  ok('  ...and tells the owner where to fix it', /Settings/i.test(r.body?.failureReason || ''), show(r));
  ok('  🔴 ...and reports no invented DKIM/SPF/DMARC state (CS-280)',
    Array.isArray(r.body?.dkimRecords) && r.body.dkimRecords.length === 0
    && r.body?.spfStatus === null && r.body?.dmarcStatus === null, show(r));
  ok('  ...and no DNS or provider API was probed', wire.length === 0, JSON.stringify(wire.map((w) => w.url)));
}

// ═══ 2. CS-039 — the sender is CHOSEN, owner only, from connected mailboxes ════════
buildWorld({ inboxes: [mailbox('inbx_a', 'office@cleanspace.test'), mailbox('inbx_b', 'jas@cleanspace.test')] });
for (const [who, status] of [['crew', 403], ['crewG', 403], ['admin', 403], ['mgr', 403], ['owner', 200]]) {
  const r = await call(systemSenderRoute, { token: `tok-${who}` });
  ok(`GET /api/email/system-sender: ${who} → ${status}`, r.status === status, show(r));
}
{
  const r = await call(systemSenderRoute, { token: 'tok-owner' });
  ok('the owner sees both connected mailboxes as candidates', (r.body?.candidates || []).length === 2, show(r));
  ok('  🔴 ...and no token ever leaves the server',
    !JSON.stringify(r.body).includes('refresh_token') && !JSON.stringify(r.body).includes('_enc'), show(r));
}
for (const [who, status] of [['crew', 403], ['admin', 403], ['mgr', 403], ['owner', 200]]) {
  buildWorld({ inboxes: [mailbox('inbx_a', 'office@cleanspace.test'), mailbox('inbx_b', 'jas@cleanspace.test')] });
  const r = await call(systemSenderRoute, { method: 'POST', token: `tok-${who}`, body: { inboxId: 'inbx_a' } });
  ok(`POST /api/email/system-sender: ${who} → ${status}`, r.status === status, show(r));
  const marked = (world.tables.inbox_accounts || []).filter((m) => m.is_system_sender === true).map((m) => m.id);
  ok(`  ...${who} ${status === 200 ? 'set' : 'changed nothing'}`,
    status === 200 ? marked.join() === 'inbx_a' : marked.length === 0, `marked: ${marked.join()}`);
}
{
  // Only ONE mailbox is ever the sender: choosing the second clears the first.
  const r = await call(systemSenderRoute, { method: 'POST', token: 'tok-owner', body: { inboxId: 'inbx_b' } });
  const marked = (world.tables.inbox_accounts || []).filter((m) => m.is_system_sender === true).map((m) => m.id);
  ok('choosing a second mailbox moves the mark, never duplicates it', r.status === 200 && marked.join() === 'inbx_b', `${show(r)} marked: ${marked.join()}`);
  const cleared = await call(systemSenderRoute, { method: 'POST', token: 'tok-owner', body: { inboxId: null } });
  ok('clearing it leaves no sender', cleared.status === 200
    && (world.tables.inbox_accounts || []).every((m) => m.is_system_sender !== true), show(cleared));
}
{
  // A mailbox that is not connected cannot be named.
  buildWorld({ inboxes: [mailbox('inbx_a', 'office@cleanspace.test')] });
  const r = await call(systemSenderRoute, { method: 'POST', token: 'tok-owner', body: { inboxId: 'inbx_nope' } });
  ok('an unconnected mailbox cannot be marked → 404', r.status === 404, show(r));
}

// ═══ 3. the happy path — a marked mailbox sends as itself ═════════════════════════
const withSender = (extra = {}) => buildWorld({
  inboxes: [mailbox('inbx_a', 'office@cleanspace.test', { is_system_sender: true, ...extra }), mailbox('inbx_b', 'jas@cleanspace.test')],
});
withSender();
{
  const r = await post('owner', GOOD);
  ok('a marked mailbox: /api/email/send → 200', r.status === 200, show(r));
  ok('  ...one Gmail send', sends().length === 1, JSON.stringify(wire.map((w) => w.url)));
  ok('  🔴 ...FROM the marked mailbox, not the requested address',
    fieldLines('From').length === 1 && fieldLines('From')[0].includes('office@cleanspace.test')
    && !fieldLines('From')[0].includes('office@example.test'), JSON.stringify(fieldLines('From')));
  ok('  ...with the requested address kept as Reply-To',
    fieldLines('Reply-To').some((l) => l.includes('office@example.test')), JSON.stringify(headerBlock()));
  ok('  ...and the body reached the message', lastMime().includes(Buffer.from('Hello there.').toString('base64')));
  ok('  ...and the Message-ID is logged for reply threading', (world.tables.sent_messages || []).length === 1);
}
withSender();
{
  // The From is not takeable even by asking for another mailbox that IS connected: Gmail
  // sends as the authenticated mailbox, which is what makes the old allowlist unnecessary.
  const r = await post('owner', { ...GOOD, from: 'jas@cleanspace.test' });
  ok('a From naming ANOTHER connected mailbox does not send as it',
    r.status === 200 && fieldLines('From')[0].includes('office@cleanspace.test'), `${show(r)} ${JSON.stringify(fieldLines('From'))}`);
}
withSender({ status: 'expired' });
{
  const r = await post('owner', GOOD);
  ok('a sending mailbox whose token expired: 503 and no send', r.status === 503 && sends().length === 0, show(r));
  const h = await call(emailHealth, { token: 'tok-owner' });
  ok('  ...and health reads failed, with a reconnect message', h.body?.status === 'failed' && /reconnect/i.test(h.body?.failureReason || ''), show(h));
}

// ═══ 4. CS-015 — not an open relay ════════════════════════════════════════════════
for (const [who, status] of [['owner', 200], ['mgr', 200], ['admin', 200], ['crewG', 200], ['crew', 403]]) {
  withSender();
  const r = await post(who, GOOD);
  ok(`🔴 /api/email/send: ${who} → ${status}`, r.status === status, show(r));
  ok(`  ...${who} ${status === 200 ? 'sent' : 'put no mail on the wire'}`,
    sends().length === (status === 200 ? 1 : 0), `${sends().length} sends`);
}
withSender();
{
  const r = await post('owner', { ...GOOD, to: ['a@b.test', 'c@d.test'] });
  ok('🔴 an ARRAY of recipients in `to` → 400', r.status === 400, show(r));
  ok('  ...and nothing was sent', sends().length === 0);
}
withSender();
{
  const r = await post('owner', { ...GOOD, to: 'a@b.test, c@d.test' });
  ok('a comma-joined recipient list in `to` → 400', r.status === 400, show(r));
}
withSender();
{
  const many = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `p${i}@example.test`);
  const r = await post('owner', { ...GOOD, bcc: many });
  ok(`🔴 more than MAX_RECIPIENTS (${MAX_RECIPIENTS}) across to+cc+bcc → 400`, r.status === 400, show(r));
  ok('  ...and the limit in the message is the one the module exports',
    (r.body?.error || '').includes(String(MAX_RECIPIENTS)), show(r));
  ok('  ...and nothing was sent', sends().length === 0);
}
withSender();
{
  const r = await post('owner', { ...GOOD, cc: ['one@example.test'], bcc: ['two@example.test'] });
  ok('a handful of cc/bcc recipients still sends', r.status === 200 && sends().length === 1, show(r));
}
withSender();
{
  const r = await post('owner', {
    ...GOOD,
    headers: { 'In-Reply-To': '<prev@host>', 'X-Evil': 'kept?', Bcc: 'attacker@evil.test', 'X-CleanSpace-Marketing-Sequence-Id': 'sq_1' },
  });
  ok('caller headers: the threading one is kept', r.status === 200 && fieldLines('In-Reply-To').length === 1, JSON.stringify(headerBlock()));
  ok('  🔴 ...an arbitrary one is dropped', !lastMime().includes('X-Evil'), JSON.stringify(headerBlock()));
  ok('  🔴 ...a Bcc header smuggled as a KEY is dropped', fieldLines('Bcc').length === 0, JSON.stringify(headerBlock()));
  ok('  🔴 ...and a marketing tag cannot be forged onto SYSTEM mail', !lastMime().includes('Marketing-Sequence-Id'), JSON.stringify(headerBlock()));
}

// ═══ 5. the env PIN ═══════════════════════════════════════════════════════════════
process.env.SYSTEM_SENDER_EMAIL = 'pinned@cleanspace.test';
buildWorld({ inboxes: [mailbox('inbx_a', 'office@cleanspace.test', { is_system_sender: true }), mailbox('inbx_p', 'pinned@cleanspace.test')] });
{
  const r = await post('owner', GOOD);
  ok('SYSTEM_SENDER_EMAIL wins over the marked mailbox',
    r.status === 200 && fieldLines('From')[0].includes('pinned@cleanspace.test'), `${show(r)} ${JSON.stringify(fieldLines('From'))}`);
  const s = await call(systemSenderRoute, { method: 'POST', token: 'tok-owner', body: { inboxId: 'inbx_a' } });
  ok('  ...and the UI cannot change a pinned sender → 409', s.status === 409 && s.body?.code === 'pinned', show(s));
}
process.env.SYSTEM_SENDER_EMAIL = 'ghost@cleanspace.test';
buildWorld({ inboxes: [mailbox('inbx_a', 'office@cleanspace.test', { is_system_sender: true })] });
{
  const r = await post('owner', GOOD);
  ok('a pin naming an unconnected mailbox sends NOTHING (never falls back)',
    r.status === 503 && sends().length === 0, show(r));
}
delete process.env.SYSTEM_SENDER_EMAIL;

// ═══ 6. no sender-selection column yet (the migration has not landed) ═════════════
buildWorld({ inboxes: [mailbox('inbx_a', 'office@cleanspace.test', { is_system_sender: true })] });
world.failWhen = (q) => q.table === 'inbox_accounts' && /is_system_sender/.test(q.cols || '');
{
  const r = await post('owner', GOOD);
  ok('the selection column missing → skipped, never a wrong sender', r.status === 503 && sends().length === 0, show(r));
  const s = await call(systemSenderRoute, { method: 'POST', token: 'tok-owner', body: { inboxId: 'inbx_a' } });
  ok('  ...and marking a sender says so → 409 not-provisioned',
    s.status === 409 && s.body?.code === 'not-provisioned', show(s));
}

console.log(`\nemail through Google (CS-012/039/015/280): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
