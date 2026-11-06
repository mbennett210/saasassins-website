// LOGINS AND ACCESS (S128 fix wave 1, builder B1): CS-660, CS-706, CS-709, CS-661, CS-662, CS-675.
//
// The REAL handlers (api/client-users/[...path].js, api/settings/[...path].js) and the REAL
// client-hub store and reads, over scripts/fake-supabase.mjs: PostgREST with Supabase's 1,000-row
// answer cap (world.maxRows) and GoTrue's admin API (world.authUsers). Offline: SUPABASE_URL is a
// closed port and fetch answers nothing but the Gmail send of the "working mailbox" checks.
//
//   §A CS-660  Remove and Disable act only on a login whose claims prove it is THIS customer's
//              (role client + client_user_id = the row). The live office login (an owner claim,
//              its email on no roster row) is never banned or deleted from Customer logins, and
//              Save refuses a team member's address or any login that is not a customer's.
//   §B CS-706  The invite adopts a login only when it is already this row's customer login, or it
//              carries no claim at all AND its address is on no team roster row (read strictly).
//              A claim-less staff login on the roster is refused, on the lookup and on the race.
//   §C CS-709  The invite answers the one-time link only when nothing was emailed.
//   §D CS-662 / CS-675  1,500 customer logins, grants and group memberships past the cap: the
//              office reads every row; a save replaces a set only when the screen sends the set it
//              loaded and that set is still the stored one; the duplicate check is a targeted
//              lookup answering 409 in words; the hub gate reads only the caller's own groups'
//              memberships (narrowed IN the query); the email audience and the view's groups are
//              complete.
//   §E CS-661  Staff: when the set-password email can't go, the invite and the member page's
//              reset hand the office the link (no-store) — but only to someone who already holds
//              everything the member holds; with a working mailbox the link is emailed and never
//              answered. Team can tell who never signed in. And the staff side never takes a
//              customer's login: the orphan list doesn't show one, a staff invite doesn't adopt
//              one, the team's reset doesn't make its link (E10–E12); the login lookup reads past
//              2,000 logins (E9).
//   §F The screens read the new answers (source pins).
//
// REGRESSION (THE LAW II.3): on ba9629f0 57 of the 66 checks fail; the 9 that pass are the
// controls (a real customer login is still banned, unbanned and adopted on a re-invite, a staff
// role is still refused, a claim-less login on no roster is adopted, an emailed invite still
// answers invited:true, a new address is saved, a new group needs no base).
//
//   node app/scripts/test-client-logins-route.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';

const ORG = '00000000-0000-0000-0000-000000000b01';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.APP_PUBLIC_URL = 'https://app.example.test';
process.env.INBOX_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL']) delete process.env[k];

// Every outbound request is captured, never made: only a Gmail send is answered (the working
// mailbox of §C / §E); anything else is refused.
let wire = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  wire.push({ url: u, body: init?.body });
  if (u.includes('gmail.googleapis.com') && u.includes('/messages/send')) {
    return { ok: true, status: 200, json: async () => ({ id: 'gm_1', threadId: 'th_1' }) };
  }
  throw new Error(`network is blocked in this suite (${u})`);
};
const gmailSends = () => wire.filter((w) => w.url.includes('/messages/send'));
const sentTo = () => gmailSends().map((w) => (/^To: (.+)$/m.exec(Buffer.from(w.body || '').toString('utf8'))?.[1] || '').trim());

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const { encrypt } = await import('../api/_lib/crypto.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
const clientUsers = (await import('../api/client-users/[...path].js')).default;
const settings = (await import('../api/settings/[...path].js')).default;
const store = await import('../api/_lib/clientHub/store.js');
const reads = await import('../api/_lib/clientHub/reads.js');
const usersLib = await import('../api/_lib/users.js');
// How long a handed-over link lasts, as the screens say it (src/lib/signInLink.js). Soft: the
// pre-fix tree has no such module, and F1 then fails on its own.
const linkLib = await soft('../src/lib/signInLink.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). The repo's suites disagree; read before adding.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;

// ── the people ───────────────────────────────────────────────────────────────
// The live shape (V qv1): ONE login, the shared office login, carrying an owner claim, whose email
// is on NO roster row. Beside it, the team as the app makes it, and the odd logins each rule is for.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = {
  office: uuid(9001), lee: uuid(9002), mia: uuid(9003), tom: uuid(9004), drew: uuid(9005),
  stray: uuid(9006), pat: uuid(9007), ghost: uuid(9008), vic: uuid(9009),
};
const CU_PAT = uuid(1);      // a real customer contact with her own customer login
const CU_GHOST = uuid(777);  // a customer row that no longer exists
const login = (id, email, app_metadata, extra = {}) => ({ id, email, app_metadata: { provider: 'email', providers: ['email'], ...app_metadata }, banned_until: null, last_sign_in_at: '2026-10-01T12:00:00.000Z', created_at: '2026-09-01T12:00:00.000Z', ...extra });
const AUTH = () => [
  login(A.office, 'office@cs.test', { role: 'owner', org_user_id: 'u_office', org_id: ORG }),
  login(A.lee, 'lee@cs.test', { role: 'admin', org_user_id: 'u_lee', org_id: ORG }),
  login(A.mia, 'mia@cs.test', { role: 'manager', org_user_id: 'u_mia', org_id: ORG }),
  login(A.tom, 'tom@cs.test', { role: 'crew', org_user_id: 'u_tom', org_id: ORG }, { last_sign_in_at: null }),
  login(A.drew, 'drew@cs.test', {}), // claim-less, on the roster (F7-02's precondition)
  login(A.stray, 'stray@outside.test', {}), // claim-less, on no roster
  login(A.pat, 'pat@coral.test', { role: 'client', client_user_id: CU_PAT, org_id: ORG }),
  login(A.ghost, 'ghost@coral.test', { role: 'client', client_user_id: CU_GHOST, org_id: ORG }),
  login(A.vic, 'vic@cs.test', { role: 'crew', org_user_id: 'u_vic', org_id: ORG }),
];
const member = (id, role, email) => ({ id, role, email, name: id.slice(2), status: 'active' });
const ROSTER = () => [
  member('u_lee', 'admin', 'lee@cs.test'),
  member('u_mia', 'manager', 'mia@cs.test'),
  member('u_tom', 'crew', 'tom@cs.test'),
  member('u_drew', 'crew', 'drew@cs.test'),
  member('u_kim', 'crew', 'kim@cs.test'), // no login at all
  member('u_vic', 'crew', 'vic@cs.test'),
];
const TOKENS = () => {
  const by = Object.fromEntries(AUTH().map((u) => [u.id, u]));
  return { 'tok-office': by[A.office], 'tok-lee': by[A.lee], 'tok-mia': by[A.mia], 'tok-tom': by[A.tom] };
};
const cuRow = (id, email, extra = {}) => ({ id, organization_id: ORG, name: email.split('@')[0], email, phone: null, status: 'invited', auth_user_id: null, invited_at: null, invited_by: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...extra });

const FAR = new Date(Date.now() + 7 * 864e5).toISOString();
const MAILBOX = () => ({
  id: uuid(5000), email: 'mail@cs.test', display_name: 'mail@cs.test', provider: 'google', status: 'active',
  refresh_token_enc: encrypt('refresh-token'), access_token_enc: encrypt('access-token'), access_token_expires_at: FAR,
  owner_user_id: null, is_system_sender: true,
});

function seed({ clientUsersRows = [], assignments = [], groups = [], members = [], clients = [], authUsers = AUTH(), roster = ROSTER(), overrides = [], mailbox = false, maxRows = null } = {}) {
  wire = [];
  __resetSystemSenderCache();
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: { users: roster, permissions: seedPermissions(), userPermissionOverrides: overrides, clients, company: { name: 'Clean Co', timezone: 'America/New_York' } } }],
      client_users: clientUsersRows, client_user_assignments: assignments, client_user_groups: groups, client_user_group_members: members,
      inbox_accounts: mailbox ? [MAILBOX()] : [], sent_messages: [],
    },
    logins: TOKENS(),
    authUsers,
  });
  world.maxRows = maxRows;
  // The unique index on (organization_id, lower(email)) — a missed duplicate meets it.
  world.uniqueKeys = { client_users: [(r) => (r.email ? `${r.organization_id}|${String(r.email).toLowerCase()}` : null)] };
}
const authUser = (id) => (world.authUsers || []).find((u) => u.id === id) || null;
const adminCalls = (op) => world.log.filter((q) => q.table === 'auth.admin' && q.op === op);

// One call through a handler. `headers` captures what the route set (Cache-Control).
function respond(handler, req) {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return new Promise((resolve) => {
    const headers = {};
    const done = (status, body) => { Object.assign(console, quiet); resolve({ status, body, headers }); };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      json(b) { done(this.statusCode, b); return this; },
      send(b) { done(this.statusCode, b); return this; },
      end(b) { done(this.statusCode, b ?? null); return this; },
    };
    Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message || String(e) }));
  });
}
const cu = (action, body, { token = 'tok-office', query = {} } = {}) => respond(clientUsers, {
  method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` },
  query: { subpath: action, ...query }, body: body ?? {},
});
// The settings catch-all reads its raw body (bodyParser off).
const su = (sub, body, { token = 'tok-office' } = {}) => {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { authorization: `Bearer ${token}` };
  req.query = { subpath: sub ? `users/${sub}` : 'users' };
  return respond(settings, req);
};

// ── §A CS-660: the office login is never touched from Customer logins ────────────
{
  seed();
  const r = await cu('save', { name: 'Test Customer', email: 'office@cs.test', phone: '' });
  ok('🔴 A1 Save refuses the office login\'s address (an owner login on NO roster row): 409 login-email, no row',
    r.status === 409 && r.body?.code === 'login-email' && !world.tables.client_users.length, show(r));
}
{
  seed();
  const r = await cu('save', { name: 'Kim as a customer', email: 'kim@cs.test', phone: '' });
  ok('🔴 A2 Save refuses a team member\'s address (on the roster, no login yet): 409 team-email, no row',
    r.status === 409 && r.body?.code === 'team-email' && !world.tables.client_users.length, show(r));
}
{
  // F7-01 as it was armed: the row was saved before the fix, never invited (no auth_user_id).
  seed({ clientUsersRows: [cuRow(uuid(11), 'office@cs.test')] });
  const r = await cu('remove', { id: uuid(11) });
  const office = authUser(A.office);
  ok('🔴 A3 Remove of a contact holding the office login\'s address leaves that login alone (not banned, not deleted)',
    !!office && office.banned_until === null && !adminCalls('deleteUser').length && !adminCalls('updateUserById').length, show(r));
  ok('A3b …still removes the contact, and says the login was kept (loginKept)',
    r.status === 200 && r.body?.ok === true && r.body?.loginKept === true && !world.tables.client_users.some((x) => x.id === uuid(11)), show(r));
}
{
  // F7-02's aftermath: the row even holds that login's id.
  seed({ clientUsersRows: [cuRow(uuid(12), 'office@cs.test', { auth_user_id: A.office })] });
  const r = await cu('remove', { id: uuid(12) });
  ok('🔴 A4 …and when the row names that login as its own (auth_user_id), Remove still leaves it alone',
    !!authUser(A.office) && authUser(A.office).banned_until === null && r.status === 200 && r.body?.loginKept === true, show(r));
}
{
  seed({ clientUsersRows: [cuRow(uuid(13), 'office@cs.test', { auth_user_id: A.office, status: 'active' })] });
  const r = await cu('status', { id: uuid(13), status: 'disabled' });
  ok('🔴 A5 Disable never bans a login that is not this customer\'s (the row\'s status still moves)',
    authUser(A.office)?.banned_until === null && r.status === 200 && r.body?.user?.status === 'disabled' && r.body?.loginKept === true, show(r));
}
{
  // Control: a real customer login is banned, unbanned and deleted as before.
  seed({ clientUsersRows: [cuRow(CU_PAT, 'pat@coral.test', { auth_user_id: A.pat, status: 'active' })] });
  let r = await cu('status', { id: CU_PAT, status: 'disabled' });
  ok('A6 control: Disable bans the customer\'s own login', r.status === 200 && r.body?.loginBanned === true && !!authUser(A.pat)?.banned_until, show(r));
  r = await cu('status', { id: CU_PAT, status: 'active' });
  ok('A6b control: Enable lifts it', r.status === 200 && r.body?.loginBanned === false && authUser(A.pat)?.banned_until === null, show(r));
  r = await cu('remove', { id: CU_PAT });
  ok('A6c Remove deletes the customer\'s own login and the row, and says so (loginRemoved)', r.status === 200 && !authUser(A.pat) && !world.tables.client_users.length && r.body?.loginRemoved === true, show(r));
}
{
  // The row lost its auth_user_id (an invite whose row write was lost): the email finds her login,
  // and its claims prove it is hers.
  seed({ clientUsersRows: [cuRow(CU_PAT, 'pat@coral.test')] });
  const r = await cu('remove', { id: CU_PAT });
  ok('A7 with no auth_user_id, the address finds the customer\'s own login and Remove deletes it',
    r.status === 200 && !authUser(A.pat) && r.body?.loginRemoved === true, show(r));
}
{
  seed({ clientUsersRows: [cuRow(uuid(14), 'office@cs.test')] });
  world.authFail = (op) => op === 'listUsers' || op === 'getUserById';
  const r = await cu('remove', { id: uuid(14) });
  ok('🔴 A8 Remove when the logins can\'t be read: 503, the contact kept, no login touched',
    r.status === 503 && world.tables.client_users.some((x) => x.id === uuid(14)) && !adminCalls('deleteUser').length, show(r));
}
{
  seed();
  world.authFail = (op) => op === 'listUsers';
  const r = await cu('save', { name: 'Someone', email: 'someone@coral.test', phone: '' });
  ok('🔴 A9 Save when the logins can\'t be read: 503 check-failed, nothing added', r.status === 503 && r.body?.code === 'check-failed' && !world.tables.client_users.length, show(r));
}
{
  seed();
  const r = await cu('save', { name: 'New Customer', email: 'New.Person@Coral.test', phone: '' });
  ok('A10 control: an address with no login and on no roster is saved (lower-cased)',
    r.status === 200 && world.tables.client_users.some((x) => x.email === 'new.person@coral.test'), show(r));
}

// ── §B CS-706: the invite never converts a staff login ──────────────────────────
{
  // F7-02 exactly: a claim-less login whose address is on the team roster (Drew, crew).
  seed({ clientUsersRows: [cuRow(uuid(21), 'drew@cs.test')] });
  const before = JSON.stringify(authUser(A.drew).app_metadata);
  const r = await cu('invite', { id: uuid(21) });
  ok('🔴 B1 Invite refuses a claim-less login whose address is on the team roster (409), its claims untouched',
    r.status === 409 && JSON.stringify(authUser(A.drew).app_metadata) === before, show(r));
  ok('B1b …and the row is not bound to it', !world.tables.client_users.find((x) => x.id === uuid(21))?.auth_user_id);
}
{
  seed({ clientUsersRows: [cuRow(uuid(22), 'ghost@coral.test')] });
  const r = await cu('invite', { id: uuid(22) });
  ok('🔴 B2 Invite refuses a customer login that belongs to ANOTHER contact (409), its claims untouched',
    r.status === 409 && authUser(A.ghost)?.app_metadata?.client_user_id === CU_GHOST, show(r));
}
{
  seed({ clientUsersRows: [cuRow(uuid(23), 'stray@outside.test')] });
  const r = await cu('invite', { id: uuid(23) });
  const md = authUser(A.stray)?.app_metadata || {};
  ok('B3 control: a claim-less login on no roster is adopted as this customer\'s (role client, this row, no org id)',
    r.status === 200 && r.body?.adopted === true && md.role === 'client' && md.client_user_id === uuid(23) && md.org_user_id === undefined, show(r));
}
{
  seed({ clientUsersRows: [cuRow(CU_PAT, 'pat@coral.test', { auth_user_id: A.pat, status: 'active' })] });
  const r = await cu('invite', { id: CU_PAT });
  ok('B4 control: re-inviting the contact\'s own customer login works', r.status === 200 && r.body?.adopted === true, show(r));
}
{
  seed({ clientUsersRows: [cuRow(uuid(24), 'lee@cs.test')] });
  const r = await cu('invite', { id: uuid(24) });
  ok('B5 control: a staff role login is refused', r.status === 409 && authUser(A.lee)?.app_metadata?.role === 'admin', show(r));
}
{
  seed({ clientUsersRows: [cuRow(uuid(25), 'stray@outside.test')] });
  // Every org_state read but the permission matrix's fails (the gate itself decides on the claim).
  world.failWhen = (q) => q.table === 'org_state' && !/permissions/.test(q.cols);
  const r = await cu('invite', { id: uuid(25) });
  ok('🔴 B6 a claim-less login when the roster can\'t be read: refused (503), its claims untouched',
    r.status === 503 && !authUser(A.stray)?.app_metadata?.role, show(r));
}
{
  // The race: no login at the lookup, a claim-less staff login by the time of the create.
  seed({ clientUsersRows: [cuRow(uuid(26), 'drew@cs.test')], authUsers: AUTH().filter((u) => u.id !== A.drew) });
  let staged = false;
  world.authBefore = async (op) => {
    if (op === 'createUser' && !staged) { staged = true; world.authUsers.push(login(A.drew, 'drew@cs.test', {})); }
  };
  const r = await cu('invite', { id: uuid(26) });
  ok('🔴 B7 the create race re-applies the same rule: the claim-less staff login that appeared is refused, not re-stamped',
    staged && r.status === 409 && !authUser(A.drew)?.app_metadata?.role, show(r));
}

{
  // The rule itself, as a table (users.js resolveClientAdoption, pure): "prefer refusing when unsure".
  const R = typeof usersLib.resolveClientAdoption === 'function' ? usersLib.resolveClientAdoption : null;
  const is = (args, want) => { const p = R?.(args); return !!p && (want === 'adopt' ? p.action === 'adopt' : p.action === 'reject' && p.reason === want); };
  ok('B8 the adoption rule as a table: team / other contact / other org / another claim / on the roster / roster unread are refused; this contact\'s login and a claim-less one on no roster are adopted',
    !!R
      && is({ claims: { role: 'crew', org_user_id: 'u_x' }, clientUserId: CU_PAT, onRoster: false }, 'team')
      && is({ claims: { role: 'client', client_user_id: CU_PAT, org_id: ORG }, clientUserId: CU_PAT }, 'adopt')
      && is({ claims: { role: 'client', client_user_id: CU_GHOST, org_id: ORG }, clientUserId: CU_PAT }, 'other')
      && is({ claims: { role: 'client', client_user_id: CU_PAT, org_id: 'another-org' }, clientUserId: CU_PAT }, 'other')
      && is({ claims: { org_id: ORG }, clientUserId: CU_PAT, onRoster: false }, 'kind')
      && is({ claims: { provider: 'email' }, clientUserId: CU_PAT, onRoster: true }, 'roster')
      && is({ claims: { provider: 'email' }, clientUserId: CU_PAT, onRoster: null }, 'unknown')
      && is({ claims: { provider: 'email', providers: ['email'] }, clientUserId: CU_PAT, onRoster: false }, 'adopt'));
}

// ── §C CS-709 (server half): the link only when nothing was emailed ──────────────
{
  seed({ clientUsersRows: [cuRow(uuid(31), 'new1@coral.test')] });
  const r = await cu('invite', { id: uuid(31) });
  ok('C1 no sending mailbox: the invite answers invited:false WITH the one-time link, no-store',
    r.status === 200 && r.body?.invited === false && /^https:\/\/fake\.auth\//.test(r.body?.link || '') && /no-store/.test(r.headers['cache-control'] || ''), show(r));
}
{
  seed({ clientUsersRows: [cuRow(uuid(32), 'new2@coral.test')], mailbox: true });
  const r = await cu('invite', { id: uuid(32) });
  ok('🔴 C2 a working mailbox: the link is EMAILED and never answered (invited:true, no link)',
    r.status === 200 && r.body?.invited === true && !('link' in (r.body || {})) && sentTo().includes('new2@coral.test'), `${show(r)} sent=${JSON.stringify(sentTo())}`);
}

// ── §D CS-662 / CS-675: 1,500 of everything, past the 1,000-row cap ───────────────
const pad = (n) => String(n).padStart(4, '0');
const N = 1500;
const G_NORTH = uuid(300001);
const G_SOUTH = uuid(300002);
function scale() {
  const rows = []; const assigns = []; const members = [];
  for (let i = 1; i <= N; i += 1) {
    rows.push(cuRow(uuid(i), `cust${pad(i)}@example.test`, { name: `Cust ${pad(i)}`, status: 'active' }));
    assigns.push({ id: uuid(100000 + i), organization_id: ORG, client_user_id: uuid(i), client_id: `cl_b${pad(i)}`, group_id: null, created_at: '2026-10-01T00:00:00.000Z' });
    members.push({ organization_id: ORG, group_id: i <= 750 ? G_NORTH : G_SOUTH, client_id: `cl_b${pad(i)}` });
  }
  // Cust 0005 also holds building 1450: that grant is row 1,501.
  assigns.push({ id: uuid(200000), organization_id: ORG, client_user_id: uuid(5), client_id: 'cl_b1450', group_id: null, created_at: '2026-10-01T00:00:00.000Z' });
  const groups = [
    { id: G_NORTH, organization_id: ORG, name: 'North region', kind: 'other', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
    { id: G_SOUTH, organization_id: ORG, name: 'South region', kind: 'other', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
  ];
  const clients = Array.from({ length: N }, (_, k) => ({ id: `cl_b${pad(k + 1)}`, name: `Building ${pad(k + 1)}` }));
  return { clientUsersRows: rows, assignments: assigns, groups, members, clients, authUsers: AUTH().filter((u) => u.id !== A.pat && u.id !== A.ghost), maxRows: 1000 };
}
{
  seed(scale());
  const r = await cu('list');
  const b = r.body || {};
  ok('🔴 D1 the office list holds EVERY customer login, grant and group membership (1,500 / 1,501 / 1,500 past the 1,000-row cap)',
    r.status === 200 && (b.users || []).length === N && (b.assignments || []).length === N + 1 && (b.groupMembers || []).length === N,
    `users=${(b.users || []).length} assignments=${(b.assignments || []).length} members=${(b.groupMembers || []).length}`);
  const fc = await cu('for-client', undefined, { query: { clientId: 'cl_b1400' } });
  ok('🔴 D2 "who can see this building" finds a grant and a group past row 1,000 (Cust 1400 direct; South region)',
    fc.status === 200 && (fc.body?.direct || []).some((u) => u.name === 'Cust 1400') && (fc.body?.groups || []).some((g) => g.name === 'South region'), show(fc));
  // The Access dialog as ClientLogins.jsx builds it, saved unchanged, with the set it loaded.
  const mine = (b.assignments || []).filter((a) => a.clientUserId === uuid(5));
  const loaded = { clientIds: mine.map((a) => a.clientId).filter(Boolean), groupIds: mine.map((a) => a.groupId).filter(Boolean) };
  const ac = await cu('assign', { id: uuid(5), ...loaded, base: loaded });
  const kept = world.tables.client_user_assignments.filter((a) => a.client_user_id === uuid(5)).map((a) => a.client_id).sort();
  ok('🔴 D3 the Access dialog saved unchanged keeps both grants (b0005 + b1450, the 1,501st row)',
    ac.status === 200 && kept.join(',') === 'cl_b0005,cl_b1450', `${show(ac)} kept=${kept}`);
}
{
  seed(scale());
  // A screen that loaded only part of the set (the old 1,000-row list) saves what it held.
  const partial = { clientIds: ['cl_b0005'], groupIds: [] };
  const r = await cu('assign', { id: uuid(5), ...partial, base: partial });
  const kept = world.tables.client_user_assignments.filter((a) => a.client_user_id === uuid(5)).map((a) => a.client_id).sort();
  ok('🔴 D4 a save whose base is not the stored set is refused (409 stale) and deletes nothing',
    r.status === 409 && r.body?.code === 'stale' && kept.join(',') === 'cl_b0005,cl_b1450', `${show(r)} kept=${kept}`);
  const r2 = await cu('assign', { id: uuid(5), clientIds: ['cl_b0005'], groupIds: [] });
  const kept2 = world.tables.client_user_assignments.filter((a) => a.client_user_id === uuid(5)).length;
  ok('🔴 D5 a save that says nothing about what it loaded is refused (409 reload) and deletes nothing',
    r2.status === 409 && r2.body?.code === 'reload' && kept2 === 2, show(r2));
}
{
  seed(scale());
  const list = (await cu('list')).body || {};
  const south = (list.groupMembers || []).filter((m) => m.groupId === G_SOUTH).map((m) => m.clientId);
  const r = await cu('group-save', { id: G_SOUTH, name: 'South region', kind: 'other', clientIds: south, baseClientIds: south });
  const now = world.tables.client_user_group_members.filter((m) => m.group_id === G_SOUTH).length;
  ok('🔴 D6 the group editor saved unchanged keeps all 750 buildings of South region', r.status === 200 && now === 750, `${show(r)} members=${now}`);
  const part = south.slice(0, 250);
  const r2 = await cu('group-save', { id: G_SOUTH, name: 'South region', kind: 'other', clientIds: part, baseClientIds: part });
  const now2 = world.tables.client_user_group_members.filter((m) => m.group_id === G_SOUTH).length;
  ok('🔴 D7 a group save from a partial load is refused (409 stale) and drops nothing', r2.status === 409 && r2.body?.code === 'stale' && now2 === 750, `${show(r2)} members=${now2}`);
  const r3 = await cu('group-save', { id: G_SOUTH, name: 'South region', kind: 'other', clientIds: part });
  ok('🔴 D7b …and one with no base is refused too (409 reload)', r3.status === 409 && r3.body?.code === 'reload'
    && world.tables.client_user_group_members.filter((m) => m.group_id === G_SOUTH).length === 750, show(r3));
  const r4 = await cu('group-save', { name: 'East region', kind: 'city', clientIds: ['cl_b0001', 'cl_b0002'] });
  ok('D7c control: a NEW group needs no base', r4.status === 200 && (r4.body?.members || []).length === 2, show(r4));
}
{
  seed(scale());
  const r = await cu('save', { name: 'Dup', email: 'cust1200@example.test' });
  ok('🔴 D8 an address that already has a customer login past row 1,000 is a 409 duplicate in words, nothing added',
    r.status === 409 && r.body?.code === 'duplicate' && !/constraint|duplicate key/i.test(r.body?.error || '') && world.tables.client_users.length === N, show(r));
  ok('D8b …found by a targeted lookup (the email is IN the query), not by reading the list',
    world.log.some((q) => q.table === 'client_users' && q.eq?.email === 'cust1200@example.test'));
}
{
  seed(scale());
  // A row written outside the app in mixed case: the targeted lookup misses it, the unique index does not.
  world.tables.client_users.push(cuRow(uuid(1999), 'Mixed.Case@Example.test'));
  const r = await cu('save', { name: 'Dup 2', email: 'mixed.case@example.test' });
  ok('🔴 D9 a duplicate the lookup misses meets the unique index and is STILL a 409 duplicate in words (no provider text)',
    r.status === 409 && r.body?.code === 'duplicate' && !/constraint|duplicate key/i.test(r.body?.error || ''), show(r));
}
{
  // S9: the hub gate for a director who holds South region through a group (row 1 → the group).
  const sc = scale();
  sc.assignments = sc.assignments.map((a) => (a.client_user_id === uuid(1) && a.client_id === 'cl_b0001' ? { ...a, client_id: null, group_id: G_SOUTH } : a));
  // Unrelated memberships the gate must never read: a third group holding every building (1,500
  // more rows, so the table is 3,000). Membership rows carry no `id`: the table's key is
  // (group_id, client_id), as in the migration.
  const G_OTHER = uuid(300003);
  for (let i = 1; i <= N; i += 1) sc.members.push({ organization_id: ORG, group_id: G_OTHER, client_id: `cl_b${pad(i)}` });
  sc.groups.push({ id: G_OTHER, organization_id: ORG, name: 'Other', kind: 'other' });
  seed(sc);
  const before = world.log.length;
  const director = world.tables.client_users.find((u) => u.id === uuid(1));
  const scope = await store.resolveScopeForClientUser(director, { clientIds: sc.clients.map((c) => c.id) });
  ok('🔴 D10 the hub gate allows all 750 of the group\'s buildings (b1400 included)', scope.length === 750 && scope.includes('cl_b1400'), `allowed=${scope.length}`);
  const memberReads = world.log.slice(before).filter((q) => q.table === 'client_user_group_members' && q.op === 'select');
  ok('🔴 D11 …reading only the caller\'s own groups\' memberships, narrowed IN the query (never the org\'s whole table)',
    memberReads.length > 0 && memberReads.every((q) => q.eq?.group_id === G_SOUTH || (Array.isArray(q.in?.group_id) && q.in.group_id.length && q.in.group_id.every((g) => g === G_SOUTH))),
    JSON.stringify(memberReads.map((q) => ({ eq: q.eq, in: q.in }))));
  // S10: the email audience for b1400 — Cust 1400 directly, Cust 0001 through the group; a disabled
  // grant-holder and the preview stand-in are not.
  world.tables.client_users.push(cuRow(uuid(1601), 'off@example.test', { status: 'disabled' }));
  world.tables.client_user_assignments.push({ id: uuid(1602), organization_id: ORG, client_user_id: uuid(1601), client_id: 'cl_b1400', group_id: null });
  const who = (await store.clientUsersWhoCanSee('cl_b1400')).map((u) => u.name).sort();
  ok('🔴 D12 the hub email audience is complete: Cust 0001 (group) + Cust 1400 (direct), never the disabled one',
    who.join(',') === 'Cust 0001,Cust 1400', JSON.stringify(who));
}
{
  // The view's groups: a login assigned both regions (1,500 memberships) sees every building listed.
  const sc = scale();
  sc.assignments.push({ id: uuid(1700), organization_id: ORG, client_user_id: uuid(2), client_id: null, group_id: G_NORTH });
  sc.assignments.push({ id: uuid(1701), organization_id: ORG, client_user_id: uuid(2), client_id: null, group_id: G_SOUTH });
  seed(sc);
  const vg = await reads.viewerGroups({ clientUserId: uuid(2) });
  ok('🔴 D13 the hub view\'s groups carry every membership of the login\'s groups (1,500, past the cap)', (vg.members || []).length === N, `members=${(vg.members || []).length}`);
}

// ── §E CS-661: staff get their link even with no mailbox ──────────────────────────
{
  seed();
  const r = await su('', { email: 'new.cleaner@cs.test', role: 'crew', orgUserId: 'u_newcl' });
  const made = (world.authUsers || []).find((u) => u.email === 'new.cleaner@cs.test');
  ok('🔴 E1 no mailbox: the staff invite creates the login AND answers the one-time link (no-store) to the Super Admin',
    r.status === 200 && r.body?.invited === false && /^https:\/\/fake\.auth\//.test(r.body?.link || '') && /no-store/.test(r.headers['cache-control'] || '')
      && made?.app_metadata?.role === 'crew' && made?.app_metadata?.org_user_id === 'u_newcl', show(r));
  ok('E1b …and says why nothing was sent (not set up)', r.body?.why === 'not-set-up', show(r));
}
{
  seed({ mailbox: true });
  const r = await su('', { email: 'new.cleaner2@cs.test', role: 'crew', orgUserId: 'u_newcl2' });
  ok('E2 a working mailbox: the invite is emailed and the link is never answered', r.status === 200 && r.body?.invited === true && !('link' in (r.body || {}))
    && sentTo().includes('new.cleaner2@cs.test'), `${show(r)} sent=${JSON.stringify(sentTo())}`);
}
{
  seed();
  const r = await su('reset-link', { email: 'tom@cs.test' });
  ok('🔴 E3 no mailbox: the member page\'s reset answers the one-time link (emailed:false, no-store)',
    r.status === 200 && r.body?.emailed === false && /^https:\/\/fake\.auth\//.test(r.body?.link || '') && /no-store/.test(r.headers['cache-control'] || ''), show(r));
}
{
  seed({ mailbox: true });
  const r = await su('reset-link', { email: 'tom@cs.test' });
  ok('🔴 E4 a working mailbox: the reset is emailed (emailed:true) and the link is never answered',
    r.status === 200 && r.body?.emailed === true && !('link' in (r.body || {})) && sentTo().includes('tom@cs.test'), `${show(r)} sent=${JSON.stringify(sentTo())}`);
}
{
  seed();
  const generated = () => adminCalls('generateLink').length;
  const r = await su('reset-link', { email: 'mia@cs.test' }, { token: 'tok-lee' });
  ok('🔴 E5 an Admin is NOT handed a Manager\'s link (the manager holds money and HR keys an Admin lacks): 409 link-withheld, no link',
    r.status === 409 && r.body?.code === 'link-withheld' && !('link' in (r.body || {})), show(r));
  ok('🔴 E5b …and no link was even made, so one already handed over keeps working', generated() === 0, `generateLink calls=${generated()}`);
  const r2 = await su('reset-link', { email: 'tom@cs.test' }, { token: 'tok-lee' });
  ok('🔴 E6 …while an Admin IS handed a crew member\'s link (they hold everything crew holds)', r2.status === 200 && r2.body?.emailed === false && !!r2.body?.link, show(r2));
}
{
  // The member's OWN overrides count: crew granted invoices.view, which an Admin lacks.
  seed({ overrides: [{ userId: 'u_tom', grants: ['invoices.view'], revokes: [] }] });
  const r = await su('reset-link', { email: 'tom@cs.test' }, { token: 'tok-lee' });
  ok('🔴 E7 a crew member granted a key the Admin lacks: the Admin is not handed their link (409 link-withheld)',
    r.status === 409 && r.body?.code === 'link-withheld' && !('link' in (r.body || {})), show(r));
  const r2 = await su('reset-link', { email: 'tom@cs.test' });
  ok('E7b …the Super Admin always is', r2.status === 200 && !!r2.body?.link, show(r2));
}
{
  seed();
  const r = await su('sign-ins');
  const never = r.body?.neverSignedIn || [];
  const none = r.body?.noLogin || [];
  ok('🔴 E8 Team can tell who never signed in: Tom (login, never signed in) yes; Vic (signed in) no',
    r.status === 200 && never.includes('tom@cs.test') && !never.includes('vic@cs.test') && !never.includes('lee@cs.test'), show(r));
  ok('E8b …and who has no login at all (Kim)', none.includes('kim@cs.test') && !none.includes('tom@cs.test'), show(r));
  const r2 = await su('sign-ins', undefined, { token: 'tok-tom' });
  ok('E8c crew may not read it (403)', r2.status === 403, show(r2));
}
{
  // The other direction of CS-706: the staff side never takes a CUSTOMER's login.
  seed();
  const r = await su('orphans');
  const orphans = (r.body?.orphans || []).map((o) => o.email);
  ok('🔴 E10 Team\'s "logins with no team record" never lists a customer login (it would offer "Add to team")',
    r.status === 200 && !orphans.includes('pat@coral.test') && !orphans.includes('ghost@coral.test') && orphans.includes('stray@outside.test'), show(r));
  const before = JSON.stringify(authUser(A.pat).app_metadata);
  const r2 = await su('', { email: 'pat@coral.test', role: 'crew', orgUserId: 'u_patstaff' });
  ok('🔴 E11 a staff invite refuses a customer login\'s address (409) and leaves that login a customer\'s',
    r2.status === 409 && JSON.stringify(authUser(A.pat).app_metadata) === before, show(r2));
  const made = adminCalls('generateLink').length;
  const r3 = await su('reset-link', { email: 'pat@coral.test' }, { token: 'tok-lee' });
  ok('🔴 E12 the team\'s reset never makes (or hands over) a CUSTOMER login\'s link: 409, no link made',
    r3.status === 409 && r3.body?.code === 'client-login' && !('link' in (r3.body || {})) && adminCalls('generateLink').length === made, show(r3));
}
{
  // findAuthUserByEmail reads past 2,000 logins (it stopped at 10 pages of 200).
  const many = [];
  for (let i = 0; i < 2300; i += 1) many.push(login(uuid(700000 + i), `bulk${i}@outside.test`, { role: 'client', client_user_id: uuid(800000 + i), org_id: ORG }));
  many.push(login(uuid(799999), 'late.staff@cs.test', { role: 'crew', org_user_id: 'u_late', org_id: ORG }));
  seed({ authUsers: [...AUTH(), ...many] });
  const found = await usersLib.findAuthUserByEmail('late.staff@cs.test').catch(() => null);
  ok('🔴 E9 a login past the 2,000th is found (the lookup no longer stops at 10 pages)', found?.id === uuid(799999));
  const r = await cu('save', { name: 'Late', email: 'late.staff@cs.test' });
  ok('🔴 E9b …so Save refuses a staff address however many logins there are', r.status === 409 && r.body?.code === 'login-email', show(r));
}

// ── §F the screens read the new answers ─────────────────────────────────────────
{
  const src = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { return ''; } };
  const panelSrc = src('../src/components/SignInLinkPanel.jsx');
  ok('F1 one panel shows a one-time link to copy (SignInLinkPanel), with how long it lasts from ONE constant',
    !!panelSrc && Number.isInteger(linkLib.SIGN_IN_LINK_HOURS) && linkLib.SIGN_IN_LINK_HOURS > 0 && /SIGN_IN_LINK_HOURS/.test(panelSrc) && /clipboard/.test(panelSrc));
  const coverage = src('./test-i18n-coverage.mjs');
  ok('F2 …written on the catalog (in CONVERTED)', /'src\/components\/SignInLinkPanel\.jsx'/.test(coverage));
  const addUser = src('../src/components/AddUserModal.jsx');
  ok('🔴 F3 the staff invite shows the link when nothing was emailed, and no longer sends the office to a reset that fails too',
    /SignInLinkPanel/.test(addUser) && /created\.link|link:\s*result\.link/.test(addUser) && !/Email password-reset link/.test(addUser));
  const detail = src('../src/pages/settings/TeamDetail.jsx');
  ok('🔴 F4 the member page\'s reset shows the link when nothing was emailed, and the withheld reason',
    /SignInLinkModal/.test(detail) && /emailed === false/.test(detail) && /LINK_WITHHELD/.test(detail)
      && linkLib.LINK_WITHHELD === 'link-withheld');
  const card = src('../src/components/ClientLoginsCard.jsx');
  ok('🔴 F5 the customer page\'s card reads invited:false and shows the link (no more "Invite sent" for nothing sent)',
    /SignInLinkModal/.test(card) && /invited === false|!out\.invited|out\.invited === false/.test(card) && !/toast\.success\(`Invite sent to/.test(card));
  ok('🔴 F6 …and a re-invite says the old link stops working, before it is made', /ConfirmDialog/.test(card) && /clientLogins\.reinvite\./.test(card));
  const page = src('../src/pages/settings/ClientLogins.jsx');
  ok('🔴 F7 Settings → Customer logins sends the set it loaded with each save (Access and group)',
    /setClientUserAssignments\(\{[^}]*\bbase\b/.test(page) && /baseClientIds/.test(page) && /clientLogins\.reinvite\./.test(page) && /SignInLinkModal/.test(page));
  const team = src('../src/pages/settings/Team.jsx');
  ok('F8 Team shows a member who never signed in', /teamSignIns\.never/.test(team) && /listTeamSignIns/.test(team));
}

console.log(`\ntest-client-logins-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
