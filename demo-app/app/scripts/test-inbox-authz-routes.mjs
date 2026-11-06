// The connected-inbox routes, per role — CS-016, CS-017, CS-088 (2026-09-29).
//
// Drives the REAL handlers through fake-supabase.mjs with `fetch` stubbed at Gmail: no
// network, no credentials, nothing can put mail on the wire.
//
//   CS-016  GET /api/inbox/inbound returned EVERY connected mailbox's mail (bodies and all)
//           to ANY login, and `since=0` dumped the whole buffer. It is now scoped to the
//           mailboxes the caller owns, or every mailbox for a `messaging.manageInboxes`
//           holder. It also ran pollDueInboxes() on every call, so any login drove the
//           company's Gmail polling; the cron owns that now.
//   CS-017  POST /api/inbox/:id/send and /test allowed an UNCLAIMED mailbox, a missing owner
//           column and a failed probe — the gate enforced nothing. All three now refuse. And
//           `{ ...req.body }` handed the caller every performSend argument, including
//           `unsubscribe.enabled: false`, which switches off the CAN-SPAM footer.
//   CS-088  POST /api/inbox/:id/disconnect required `marketing.connectInbox`, a key the
//           Roles page hides while marketing is dormant, and never checked WHOSE mailbox it
//           was. The owner may now disconnect their own; a messaging-inbox manager, any.
//
//   node scripts/test-inbox-authz-routes.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.INBOX_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');
process.env.APP_BASE_URL = 'https://app.example.test';

let wire = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  wire.push({ url: u, body: init?.body });
  if (u.includes('/messages/send')) return { ok: true, status: 200, json: async () => ({ id: 'gm_1', threadId: 'th_1' }) };
  if (/\/messages\/gm_1\?/.test(u)) return { ok: true, status: 200, json: async () => ({ payload: { headers: [{ name: 'Message-ID', value: '<real@host>' }] } }) };
  if (u.includes('oauth2.googleapis.com/revoke')) return { ok: true, status: 200, json: async () => ({}) };
  throw new Error(`network is blocked in this suite (${u})`);
};
const sends = () => wire.filter((w) => w.url.includes('/messages/send'));
const gmailCalls = () => wire.filter((w) => w.url.includes('gmail.googleapis.com'));
const lastMime = () => (sends().length ? Buffer.from(sends()[sends().length - 1].body).toString('utf8') : '');

installFakeSupabase();
const { encrypt } = await import('../api/_lib/crypto.js');
const { __resetInboxOwnershipCache } = await import('../api/_lib/inboxOwnership.js');
const inbound = (await import('../api/inbox/inbound.js')).default;
const inboxSend = (await import('../api/inbox/[id]/send.js')).default;
const inboxTest = (await import('../api/inbox/[id]/test.js')).default;
const inboxDisconnect = (await import('../api/inbox/[id]/disconnect.js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── the people ──────────────────────────────────────────────────────────────────
// messaging.manageInboxes defaults to owner + admin + manager, so crew reach only their own
// mailbox. crewG is a crew member GRANTED the key; mgrR a manager with it REVOKED.
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  mgrR: { id: 'u_mgr_r', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crewG: { id: 'u_crew_g', role: 'crew', claim: true },
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const OVERRIDES = [
  { userId: 'u_crew_g', grants: ['messaging.manageInboxes'], revokes: [] },
  { userId: 'u_mgr_r', grants: [], revokes: ['messaging.manageInboxes', 'marketing.connectInbox'] },
];

const FAR_FUTURE = new Date(Date.now() + 7 * 24 * 3600e3).toISOString();
const mailbox = (id, email, ownerUserId) => ({
  id, email, display_name: email, provider: 'google', status: 'active',
  refresh_token_enc: encrypt('refresh'), access_token_enc: encrypt('access'),
  access_token_expires_at: FAR_FUTURE, history_id: 'h1', last_polled_at: FAR_FUTURE,
  owner_user_id: ownerUserId ?? null, is_system_sender: false,
});
// Two mailboxes and one buffered message each.
const MINE = mailbox('inbx_crew', 'crew.box@cleanspace.test', 'u_crew');
const THEIRS = mailbox('inbx_mgr', 'mgr.box@cleanspace.test', 'u_mgr');
const UNCLAIMED = mailbox('inbx_orphan', 'orphan@cleanspace.test', null);
const buffer = [
  { seq: 1, gmail_message_id: 'g1', rfc_message_id: '<1@h>', to_inbox_email: 'crew.box@cleanspace.test', from_email: 'a@b.test', subject: 'to crew', body: 'crew body' },
  { seq: 2, gmail_message_id: 'g2', rfc_message_id: '<2@h>', to_inbox_email: 'mgr.box@cleanspace.test', from_email: 'c@d.test', subject: "manager's private mail", body: 'PRIVATE' },
  { seq: 3, gmail_message_id: 'g3', rfc_message_id: '<3@h>', to_inbox_email: 'orphan@cleanspace.test', from_email: 'e@f.test', subject: 'orphan', body: 'ORPHAN' },
];

function buildWorld({ inboxes = [MINE, THEIRS, UNCLAIMED], inbound_emails = buffer, overrides = OVERRIDES } = {}) {
  wire = [];
  __resetInboxOwnershipCache();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG,
        state: { users: roster, permissions: seedPermissions(), userPermissionOverrides: overrides, company: { name: 'Co', email: 'office@example.test' } },
        version: 1,
      }],
      inbox_accounts: structuredClone(inboxes),
      inbound_emails: structuredClone(inbound_emails),
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
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;

// ═══ 1. CS-016 — the inbound poll is scoped per mailbox ═══════════════════════════
const subjectsFor = async (who, since = 0) => {
  buildWorld();
  const r = await call(inbound, { token: `tok-${who}`, query: { since: String(since) } });
  return { r, subjects: (r.body?.emails || []).map((e) => e.subject).sort() };
};
{
  const { r, subjects } = await subjectsFor('crew');
  ok('🔴 crew see ONLY their own mailbox, not the manager\'s private mail',
    r.status === 200 && subjects.join('|') === 'to crew', show(r));
  ok('  ...and no other mailbox\'s BODY is in the response', !JSON.stringify(r.body).includes('PRIVATE'), show(r));
  ok('  ...and personalInboxes is scoped the same way',
    JSON.stringify(r.body?.personalInboxes) === JSON.stringify(['crew.box@cleanspace.test']), show(r));
  ok('  ...and the cursor still advances past the rows they cannot see', r.body?.cursor === 3, show(r));
  ok('  🔴 ...and the poll did NOT drive Gmail', gmailCalls().length === 0, JSON.stringify(wire.map((w) => w.url)));
}
for (const who of ['owner', 'admin', 'mgr', 'crewG']) {
  const { r, subjects } = await subjectsFor(who);
  ok(`${who} (messaging.manageInboxes) sees every mailbox`,
    r.status === 200 && subjects.length === 3 && r.body?.scope === 'all', show(r));
}
{
  const { r, subjects } = await subjectsFor('mgrR');
  ok('a manager with the key REVOKED sees no mailbox of their own... and no one else\'s',
    r.status === 200 && subjects.length === 0 && r.body?.scope === 'owned', show(r));
}
{
  // since=0 used to dump the whole buffer to anyone. It now dumps only what is theirs.
  const { r } = await subjectsFor('crew', 0);
  ok('🔴 since=0 no longer dumps the buffer to a crew login', (r.body?.emails || []).length === 1, show(r));
}
{
  // An unreadable permission matrix must NARROW the scope, never widen it.
  buildWorld();
  world.failWhen = (q) => q.table === 'org_state' && /permissions:/.test(q.cols || '');
  const r = await call(inbound, { token: 'tok-owner', query: { since: '0' } });
  ok('an unreadable permission matrix narrows the scope to owned mailboxes',
    r.status === 200 && (r.body?.emails || []).length === 0, show(r));
}

// ═══ 2. CS-017 — send/test fail closed ═══════════════════════════════════════════
const sendAs = (who, id, body = { to: 'x@y.test', subject: 'S', body: 'B' }) =>
  call(inboxSend, { method: 'POST', token: `tok-${who}`, body, query: { id } });
const testAs = (who, id, body = { to: 'x@y.test', subject: 'S', body: 'B' }) =>
  call(inboxTest, { method: 'POST', token: `tok-${who}`, body, query: { id } });

for (const [label, fn] of [['send', sendAs], ['test', testAs]]) {
  buildWorld();
  {
    const r = await fn('crew', MINE.id);
    ok(`/${label}: the mailbox's OWNER may send`, r.status === 200 && sends().length === 1, show(r));
  }
  buildWorld();
  {
    const r = await fn('crew', THEIRS.id);
    ok(`🔴 /${label}: a DIFFERENT user is refused`, r.status === 403 && sends().length === 0, show(r));
  }
  buildWorld();
  {
    const r = await fn('owner', THEIRS.id);
    ok(`🔴 /${label}: not even the Super Admin sends from someone else's mailbox`,
      r.status === 403 && sends().length === 0, show(r));
  }
  buildWorld();
  {
    const r = await fn('crew', UNCLAIMED.id);
    ok(`🔴 /${label}: an UNCLAIMED mailbox refuses everyone`, r.status === 403 && sends().length === 0, show(r));
    ok(`  ...with a reason of unclaimed`, r.body?.code === 'unclaimed', show(r));
  }
  buildWorld();
  world.failWhen = (q) => q.table === 'inbox_accounts' && /owner_user_id/.test(q.cols || '');
  {
    const r = await fn('crew', MINE.id);
    ok(`🔴 /${label}: no owner column (migration unapplied) refuses`, r.status === 403 && sends().length === 0, show(r));
    ok('  ...and says it is not provisioned', r.body?.code === 'not-provisioned', show(r));
  }
}

// The body is an allowlist, not a spread.
buildWorld();
{
  const r = await sendAs('crew', MINE.id, {
    to: 'x@y.test', subject: 'S', body: 'B',
    headers: { 'In-Reply-To': '<p@h>', 'X-CleanSpace-Marketing-Sequence-Id': 'sq_1', 'X-Evil': 'kept?', Bcc: 'attacker@evil.test' },
    unsubscribe: { enabled: false, baseUrl: 'https://evil.test', message: 'Custom {unsubscribe}' },
    orgUserId: 'u_owner',
  });
  const mime = lastMime();
  ok('body allowlist: the send succeeds', r.status === 200 && sends().length === 1, show(r));
  ok('  ...threading + marketing headers survive', mime.includes('In-Reply-To: <p@h>') && mime.includes('X-CleanSpace-Marketing-Sequence-Id: sq_1'), mime.slice(0, 400));
  ok('  🔴 ...an arbitrary header is dropped', !mime.includes('X-Evil'), mime.slice(0, 400));
  ok('  🔴 ...a Bcc smuggled as a header key is dropped', !/(^|\r\n)Bcc:/.test(mime), mime.slice(0, 400));
  ok('  🔴 ...unsubscribe.enabled:false CANNOT switch off the CAN-SPAM footer',
    mime.includes('List-Unsubscribe'), mime.slice(0, 600));
  ok('  🔴 ...and the unsubscribe link cannot be pointed at the caller\'s own host',
    !mime.includes('evil.test'), mime.slice(0, 900));
  ok('  ...while the wording the org configured is still honoured', /Custom/.test(Buffer.from(mime.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8')) || mime.includes('Custom'), 'footer wording');
}

// ═══ 3. CS-088 — disconnect ══════════════════════════════════════════════════════
const disconnectAs = (who, id) => call(inboxDisconnect, { method: 'POST', token: `tok-${who}`, query: { id } });
buildWorld();
{
  const r = await disconnectAs('crew', MINE.id);
  ok('🔴 disconnect: the mailbox OWNER may disconnect their own (a crew member, no marketing key)',
    r.status === 200, show(r));
  ok('  ...and the row is gone', !(world.tables.inbox_accounts || []).some((m) => m.id === MINE.id));
}
buildWorld();
{
  const r = await disconnectAs('crew', THEIRS.id);
  ok('🔴 disconnect: crew cannot disconnect someone else\'s mailbox', r.status === 403, show(r));
  ok('  ...and the row survives', (world.tables.inbox_accounts || []).some((m) => m.id === THEIRS.id));
}
for (const who of ['owner', 'admin', 'mgr', 'crewG']) {
  buildWorld();
  const r = await disconnectAs(who, THEIRS.id);
  ok(`disconnect: ${who} (messaging.manageInboxes) may disconnect any mailbox`, r.status === 200, show(r));
}
buildWorld();
{
  const r = await disconnectAs('mgrR', THEIRS.id);
  ok('disconnect: a manager with both keys revoked is refused', r.status === 403, show(r));
}

console.log(`\ninbox routes per role (CS-016/017/088): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
