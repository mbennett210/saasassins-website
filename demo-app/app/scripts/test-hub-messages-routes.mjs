// CUSTOMER MESSAGES, END TO END (client hub redesign, plan §3.4) — the REAL /api/hub handler
// (the customer's side) and the REAL /api/client-messages handler (the office's) over
// fake-supabase.mjs. No network, no credentials, no live project (BUILD_INTEGRITY §6b).
//
// One thread per building, shared by every customer login that can see it and every office user
// who holds `hub.messages.view`. What this holds, in the order it matters:
//   1. 🔴 AUDIENCE. Every new hub branch refuses no login (401), a staff login (403 office-login)
//      and a disabled customer (403); every office branch refuses no login (401), a CUSTOMER
//      login (403 client-login — the isolation rule) and crew (403, the keys are office-only).
//   2. 🔴 SCOPE. A building outside the login's scope is a 404 that confirms nothing; every
//      message read puts the building IN THE QUERY (the query log is read, not the answer).
//   3. 🔴 ALLOWLISTS. Every served object's keys are exactly its constant in src/lib/hubMessages.js;
//      a staff name reaches a customer only as first name + last initial (hubPersonName).
//   4. WRITES. Caller-minted ids, a replay is one row, another login's id is a 409; the author
//      comes from the verified claim, never the body; body 1–4000 characters; 60 an hour per
//      login; retention at the write point (3 years); the activity log (actor role client).
//   5. MATT'S ROUTING RULE, through the CAS loop: the building's manager, else every Admin; the
//      bell is best-effort and never fails the customer's message.
//   6. THE BELL (`updates`): staff replies and stage changes on the viewer's OWN requests, office
//      messages and new inspection reports, in their buildings only, 30 days, ≤20, newest first,
//      unread against `updates_seen_at`; never an internal note or the viewer's own words.
//   7. THE OFFICE: the thread list (unread first, mine / manager / customer filters, paged), one
//      thread with full staff names, a reply (author from the claim, `hub.messages.reply`) that
//      emails the customers who kept "Replies from the office" on, and the read marker.
//
// REGRESSION (THE LAW II.3): on the pre-change tree /api/hub has none of these branches (a 404)
// and /api/client-messages does not exist, so every check below fails.
//
//   node app/scripts/test-hub-messages-routes.mjs
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.APP_PUBLIC_URL = 'https://hub.example.test';
delete process.env.SYSTEM_SENDER_EMAIL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const V = await tryImport('../src/lib/hubMessages.js');
const notify = await tryImport('../api/_lib/clientHub/notify.js');
const hub = (await import('../api/hub/[...path].js')).default;
const officePath = fileURLToPath(new URL('../api/client-messages/[...path].js', import.meta.url));
const office = existsSync(officePath) ? (await import('../api/client-messages/[...path].js')).default : null;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const sameKeys = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).sort().join(',') === [...list].sort().join(',');
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;

// ── the world ─────────────────────────────────────────────────────────────────
const H = 3600000;
const DAY = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const SECRET_HARBOR = 'ZZHARBORZZ another building entirely';
const SECRET_NOTE = 'ZZINTERNALZZ quote it before promising';

const CU1 = 'a0000000-0000-4000-8000-000000000001'; // Pat Manager: cl_a directly, cl_b through G1
const CU2 = 'a0000000-0000-4000-8000-000000000002'; // disabled
const CU3 = 'a0000000-0000-4000-8000-000000000003'; // Jordan: cl_a through G2; turned "messages" emails off
const CU4 = 'a0000000-0000-4000-8000-000000000004'; // only cl_x
const G1 = 'b0000000-0000-4000-8000-000000000001';
const G2 = 'b0000000-0000-4000-8000-000000000002';
const T1 = 'e0000000-0000-4000-8000-000000000001'; // cl_a portal, raised by CU1
const T2 = 'e0000000-0000-4000-8000-000000000002'; // cl_a portal, raised by CU3
const T3 = 'e0000000-0000-4000-8000-000000000003'; // cl_x portal, raised by CU4
const I1 = 'c0000000-0000-4000-8000-000000000001'; // cl_a submitted 3 days ago
const I2 = 'c0000000-0000-4000-8000-000000000002'; // cl_a draft
const I3 = 'c0000000-0000-4000-8000-000000000003'; // cl_x submitted
const I4 = 'c0000000-0000-4000-8000-000000000004'; // cl_a submitted 40 days ago
const M = (n) => `f0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const user = (id, role, name, extra = {}) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {}, ...extra });
const cmsg = (id, client, role, { cu = null, uid = null, name = null, body, at }) => ({
  id, organization_id: ORG, client_id: client, author_role: role, author_client_user_id: cu, author_user_id: uid, author_name: name, body, created_at: at,
});
const thread = (client, m, extra = {}) => ({
  organization_id: ORG, client_id: client, last_message_id: m.id, last_message_at: m.created_at, last_author_role: m.author_role,
  last_author_name: m.author_name, last_author_user_id: m.author_user_id, last_author_client_user_id: m.author_client_user_id,
  last_snippet: m.body.slice(0, 200), last_client_message_at: null, last_staff_message_at: null, updated_at: m.created_at, ...extra,
});

function seed({ prefs3 = { messages: false } } = {}) {
  __resetRateLimit();
  const a1 = cmsg(M(1), 'cl_a', 'client', { cu: CU1, name: 'Pat Manager', body: 'Is the lobby glass on tonight\'s list?', at: ago(3 * DAY) });
  const a2 = cmsg(M(2), 'cl_a', 'staff', { uid: 'u_mgr', name: 'Renata Cruz', body: 'Yes, it is on tonight\'s list.', at: ago(2 * DAY) });
  const aOld = cmsg(M(3), 'cl_a', 'staff', { uid: 'u_mgr', name: 'Renata Cruz', body: 'ZZOLDZZ from last year', at: ago(400 * DAY) });
  const aAncient = cmsg(M(4), 'cl_a', 'client', { cu: CU1, name: 'Pat Manager', body: 'ZZANCIENTZZ four years back', at: ago(4 * 365 * DAY) });
  const x1 = cmsg(M(5), 'cl_x', 'client', { cu: CU4, name: 'Harbor Person', body: SECRET_HARBOR, at: ago(DAY) });
  const xAncient = cmsg(M(6), 'cl_x', 'client', { cu: CU4, name: 'Harbor Person', body: 'ZZXANCIENTZZ', at: ago(4 * 365 * DAY) });
  const b1 = cmsg(M(7), 'cl_b', 'staff', { uid: 'u_admin', name: 'Yolanda Reyes', body: 'Your windows are booked for Friday.', at: ago(DAY) });
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [
            user('u_owner', 'owner', 'Dana Owner'),
            user('u_admin', 'admin', 'Yolanda Reyes'),
            user('u_admin2', 'admin', 'Priya Nair'),
            user('u_mgr', 'manager', 'Renata Cruz'),
            user('u_mgr2', 'manager', 'Sam Ortiz'),
            user('u_crew', 'crew', 'Tomas Rivera'),
          ],
          clients: [
            { id: 'cl_a', name: 'Coral Bay HOA', customerNumber: '0004', supervisorId: 'u_mgr', revenue: 1100, notes: 'gate code 4455' },
            { id: 'cl_b', name: 'Bayshore Senior Living', customerNumber: '0006', supervisorId: null },
            { id: 'cl_x', name: 'Harbor Tower', customerNumber: '0009', supervisorId: 'u_mgr2' },
          ],
          sites: [],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          notifications: [],
        },
      }],
      crew_assignments: [],
      client_users: [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1', email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) },
        { id: CU2, organization_id: ORG, name: 'Old Contact', email: 'old@coralbay.test', phone: null, status: 'disabled', auth_user_id: 'auth-c2', email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) },
        { id: CU3, organization_id: ORG, name: 'Jordan Wells', email: 'jordan@royalpalm.test', phone: null, status: 'invited', auth_user_id: 'auth-c3', email_prefs: prefs3, updates_seen_at: null, updated_at: ago(30 * DAY) },
        { id: CU4, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c4', email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) },
      ],
      client_user_groups: [
        { id: G1, organization_id: ORG, name: 'Royal Palm', kind: 'management' },
        { id: G2, organization_id: ORG, name: 'Boca Raton', kind: 'city' },
      ],
      client_user_group_members: [
        { organization_id: ORG, group_id: G1, client_id: 'cl_b' },
        { organization_id: ORG, group_id: G2, client_id: 'cl_a' },
      ],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null },
        { id: 'as2', organization_id: ORG, client_user_id: CU1, client_id: null, group_id: G1 },
        { id: 'as3', organization_id: ORG, client_user_id: CU2, client_id: 'cl_a', group_id: null },
        { id: 'as4', organization_id: ORG, client_user_id: CU3, client_id: null, group_id: G2 },
        { id: 'as5', organization_id: ORG, client_user_id: CU4, client_id: 'cl_x', group_id: null },
      ],
      client_messages: [a1, a2, aOld, aAncient, x1, xAncient, b1],
      client_message_threads: [
        thread('cl_a', a2, { last_client_message_at: a1.created_at, last_staff_message_at: a2.created_at }),
        thread('cl_x', x1, { last_client_message_at: x1.created_at }),
        thread('cl_b', b1, { last_staff_message_at: b1.created_at }),
      ],
      client_message_reads: [],
      problem_reports: [
        { id: T1, organization_id: ORG, client_id: 'cl_a', client_name: 'Coral Bay HOA', origin: 'portal', title: 'Coffee stain', status: 'in_progress', created_at: ago(5 * DAY), raised_by_client_user_id: CU1, raised_by_client_name: 'Pat Manager' },
        { id: T2, organization_id: ORG, client_id: 'cl_a', client_name: 'Coral Bay HOA', origin: 'portal', title: 'Jordan\'s ticket', status: 'open', created_at: ago(4 * DAY), raised_by_client_user_id: CU3, raised_by_client_name: 'Jordan Wells' },
        { id: T3, organization_id: ORG, client_id: 'cl_x', client_name: 'Harbor Tower', origin: 'portal', title: 'Harbor ticket', status: 'open', created_at: ago(4 * DAY), raised_by_client_user_id: CU4, raised_by_client_name: 'Harbor Person' },
      ],
      work_order_messages: [
        { id: 'w1', organization_id: ORG, problem_id: T1, author_role: 'office', author_name: 'Renata Cruz', author_user_id: 'u_mgr', author_client_user_id: null, body: 'We will treat it tonight.', internal: false, created_at: ago(DAY + H) },
        { id: 'w2', organization_id: ORG, problem_id: T1, author_role: 'office', author_name: 'Renata Cruz', author_user_id: 'u_mgr', author_client_user_id: null, body: SECRET_NOTE, internal: true, created_at: ago(DAY) },
        { id: 'w3', organization_id: ORG, problem_id: T1, author_role: 'client', author_name: 'Pat Manager', author_user_id: null, author_client_user_id: CU1, body: 'ZZMYOWNZZ thanks', internal: false, created_at: ago(20 * H) },
        { id: 'w4', organization_id: ORG, problem_id: T2, author_role: 'office', author_name: 'Renata Cruz', author_user_id: 'u_mgr', author_client_user_id: null, body: 'ZZJORDANZZ reply on someone else\'s', internal: false, created_at: ago(DAY) },
        { id: 'w5', organization_id: ORG, problem_id: T3, author_role: 'office', author_name: 'Sam Ortiz', author_user_id: 'u_mgr2', author_client_user_id: null, body: SECRET_HARBOR, internal: false, created_at: ago(DAY) },
        { id: 'w6', organization_id: ORG, problem_id: T1, author_role: 'office', author_name: 'Renata Cruz', author_user_id: 'u_mgr', author_client_user_id: null, body: 'ZZSTALEZZ', internal: false, created_at: ago(45 * DAY) },
      ],
      activity_log: [
        { id: 'al1', organization_id: ORG, occurred_at: ago(2 * DAY), actor_user_id: 'u_mgr', actor_name: 'Renata Cruz', actor_role: 'manager', auto: false, action: 'ticket.status_changed', entity_type: 'work_order', entity_id: T1, client_id: 'cl_a', client_name: 'Coral Bay HOA', summary: 'x', before: { status: 'open' }, after: { status: 'in_progress' }, is_money: false },
        { id: 'al2', organization_id: ORG, occurred_at: ago(30 * H), actor_user_id: null, actor_name: 'Pat Manager', actor_role: 'client', auto: false, action: 'ticket.status_changed', entity_type: 'work_order', entity_id: T1, client_id: 'cl_a', client_name: 'Coral Bay HOA', summary: 'reopened', before: { status: 'resolved' }, after: { status: 'open' }, is_money: false },
        { id: 'al3', organization_id: ORG, occurred_at: ago(DAY), actor_user_id: 'u_mgr', actor_name: 'Renata Cruz', actor_role: 'manager', auto: false, action: 'ticket.status_changed', entity_type: 'work_order', entity_id: T2, client_id: 'cl_a', client_name: 'Coral Bay HOA', summary: 'x', before: { status: 'open' }, after: { status: 'in_progress' }, is_money: false },
      ],
      inspection_records: [
        { id: I1, organization_id: ORG, client_id: 'cl_a', client_name: 'Coral Bay HOA', status: 'submitted', template_snapshot: { name: 'Restroom QC' }, overall_score: 92, result: 'pass', internal_note: SECRET_NOTE, public_token: 'tok_pub', performed_at: ago(3 * DAY) },
        { id: I2, organization_id: ORG, client_id: 'cl_a', client_name: 'Coral Bay HOA', status: 'draft', template_snapshot: { name: 'Draft walk' }, overall_score: null, result: null, performed_at: ago(DAY) },
        { id: I3, organization_id: ORG, client_id: 'cl_x', client_name: 'Harbor Tower', status: 'submitted', template_snapshot: { name: 'Harbor QC' }, overall_score: 70, result: 'fail', performed_at: ago(DAY) },
        { id: I4, organization_id: ORG, client_id: 'cl_a', client_name: 'Coral Bay HOA', status: 'submitted', template_snapshot: { name: 'Old QC' }, overall_score: 88, result: 'pass', performed_at: ago(40 * DAY) },
      ],
      activity_log_baseline: [],
      inbox_accounts: [],
    },
    logins: {
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client2': { id: 'auth-c2', email: 'old@coralbay.test', app_metadata: { role: 'client', client_user_id: CU2, org_id: ORG } },
      'tok-client3': { id: 'auth-c3', email: 'jordan@royalpalm.test', app_metadata: { role: 'client', client_user_id: CU3, org_id: ORG } },
      'tok-client4': { id: 'auth-c4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU4, org_id: ORG } },
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-admin': { id: 'auth-a', email: 'u_admin@example.test', app_metadata: { role: 'admin', org_user_id: 'u_admin', org_id: ORG } },
      'tok-mgr': { id: 'auth-m', email: 'u_mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      'tok-mgr2': { id: 'auth-m2', email: 'u_mgr2@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr2', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
    },
  });
}

async function call(handler, { method = 'GET', path: p, token, body }) {
  if (!handler) return { status: 'no-handler', body: null, headers: {} };
  const [sub, qs] = p.split('?');
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body ?? {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
      const done = (status, b, headers) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const headers = {};
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b, headers); return this; },
        send(b) { done(this.statusCode, b, headers); return this; },
        end(b) { done(this.statusCode, b ?? null, headers); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }, headers));
    });
  } finally { Object.assign(console, quiet); }
}
const get = (p, token = 'tok-client') => call(hub, { path: p, token });
const post = (p, body, token = 'tok-client') => call(hub, { method: 'POST', path: p, token, body });
const oget = (p, token = 'tok-owner') => call(office, { path: p, token });
const opost = (p, body, token = 'tok-owner') => call(office, { method: 'POST', path: p, token, body });
const bells = () => world.tables.org_state[0].state.notifications || [];
const msgsOf = (client) => world.tables.client_messages.filter((m) => m.client_id === client);

ok('Z0 the shared module loads (src/lib/hubMessages.js)', !V.__error, V.__error || '');
ok('Z1 the office route exists (app/api/client-messages/[...path].js)', !!office);

// ── 1. audience, on every new branch ──────────────────────────────────────────
const HUB_ROUTES = [
  ['GET', 'messages?buildingId=cl_a'],
  ['POST', 'message', { id: M(50), buildingId: 'cl_a', body: 'Hello' }],
  ['POST', 'messages-read', { buildingId: 'cl_a' }],
  ['GET', 'updates'],
  ['POST', 'updates-seen', {}],
  ['GET', 'email-prefs'],
  ['POST', 'email-prefs', { messages: false }],
];
const OFFICE_ROUTES = [
  ['GET', 'threads'],
  ['GET', 'thread?clientId=cl_a'],
  ['POST', 'send', { id: M(60), clientId: 'cl_a', body: 'Hello from the office' }],
  ['POST', 'read', { clientId: 'cl_a' }],
];
seed();
for (const [method, p, body] of HUB_ROUTES) {
  const name = p.split('?')[0];
  const anon = await call(hub, { method, path: p, body });
  ok(`A1 hub ${method} ${name}: no login is a 401`, () => anon.status === 401, show(anon));
  const staff = await call(hub, { method, path: p, token: 'tok-owner', body });
  ok(`🔴 A2 hub ${method} ${name}: a STAFF login is refused (403 office-login)`, () => staff.status === 403 && staff.body?.code === 'office-login', show(staff));
  const disabled = await call(hub, { method, path: p, token: 'tok-client2', body });
  ok(`🔴 A3 hub ${method} ${name}: a DISABLED customer is refused`, () => disabled.status === 403 && disabled.body?.code === 'account-disabled', show(disabled));
}
for (const [method, p, body] of OFFICE_ROUTES) {
  const name = p.split('?')[0];
  const anon = await call(office, { method, path: p, body });
  ok(`A4 office ${method} ${name}: no login is a 401`, () => anon.status === 401, show(anon));
  const client = await call(office, { method, path: p, token: 'tok-client', body });
  ok(`🔴 A5 office ${method} ${name}: a CUSTOMER login is refused (403 client-login)`, () => client.status === 403 && client.body?.code === 'client-login', show(client));
  const crew = await call(office, { method, path: p, token: 'tok-crew', body });
  ok(`🔴 A6 office ${method} ${name}: crew are refused (403)`, () => crew.status === 403, show(crew));
}
ok('A7 nothing the refused calls carried was written', () => msgsOf('cl_a').length === 4 && world.tables.client_message_reads.length === 0, JSON.stringify(msgsOf('cl_a').map((m) => m.id)));

// ── 2. the customer's thread: scope, the building in the query, allowlists ───
seed();
{
  world.log = [];
  const r = await get('messages?buildingId=cl_a');
  ok('S1 a customer reads their building\'s thread', () => r.status === 200 && sameKeys(r.body, ['messages', 'hasMore', 'manager']), show(r));
  const reads = world.log.filter((q) => q.table === 'client_messages' && q.op === 'select');
  ok('🔴 S2 every message read puts the building IN THE QUERY', () => reads.length > 0 && reads.every((q) => q.eq.client_id === 'cl_a' && q.eq.organization_id === ORG), JSON.stringify(reads));
  ok('🔴 S3 …never select(*)', () => reads.every((q) => q.cols && q.cols !== '*'));
  const list = r.body?.messages || [];
  ok('🔴 S4 each message is EXACTLY the hub allowlist', () => list.length > 0 && list.every((m) => sameKeys(m, V.HUB_BUILDING_MESSAGE_FIELDS)), JSON.stringify(list[0]));
  ok('S5 oldest first, the last 12 months only (the 400-day-old reply and the 4-year-old line are not served)',
    () => list.map((m) => m.id).join() === [M(1), M(2)].join(), list.map((m) => m.id).join());
  const mine = list.find((m) => m.id === M(1));
  const theirs = list.find((m) => m.id === M(2));
  ok('S6 my own line is "mine", in my own words', () => mine?.mine === true && mine.authorRole === 'client' && mine.authorName === 'You');
  ok('🔴 S7 the office\'s line names the person as first name + last initial (hubPersonName), never in full', () => theirs?.mine === false && theirs.authorRole === 'staff' && theirs.authorName === 'Renata C.' && !JSON.stringify(r.body).includes('Renata Cruz'), JSON.stringify(theirs));
  ok('S8 the account manager, as the hub may show them', () => r.body.manager?.name === 'Renata C.' && sameKeys(r.body.manager, ['name']), JSON.stringify(r.body?.manager));
  ok('🔴 S9 nothing from another building, no staff ids, no customer ids', () => !/ZZHARBOR|u_mgr|a0000000/.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 200));
  ok('S10 private, never cached', () => /no-store/.test(r.headers?.['cache-control'] || '') && /private/.test(r.headers?.['cache-control'] || ''));
  const group = await get('messages?buildingId=cl_b');
  ok('S11 a building granted through a GROUP opens; with no manager the hub says so (null)', () => group.status === 200 && group.body.manager === null && group.body.messages.length === 1, show(group));
  for (const id of ['cl_x', 'cl_nope', '']) {
    const x = await get(`messages?buildingId=${id}`);
    ok(`🔴 S12 a building outside the scope (${id || 'none'}) is a 404 that confirms nothing`, () => x.status === 404 && x.body?.code === 'not-found' && !JSON.stringify(x.body).includes('Harbor'), show(x));
  }
  const p1 = await get(`messages?buildingId=cl_a&limit=1`);
  ok('S13 paged: the newest page first, with hasMore', () => p1.status === 200 && p1.body.messages.length === 1 && p1.body.messages[0].id === M(2) && p1.body.hasMore === true, show(p1));
  const p2 = await get(`messages?buildingId=cl_a&limit=1&before=${encodeURIComponent(p1.body?.messages?.[0]?.createdAt || '')}`);
  ok('S14 …and `before` reads the older page', () => p2.status === 200 && p2.body.messages.length === 1 && p2.body.messages[0].id === M(1) && p2.body.hasMore === false, show(p2));
  const big = await get('messages?buildingId=cl_a&limit=500');
  ok('S15 a page past the max is held to 50', () => big.status === 200 && big.body.messages.length <= V.HUB_MESSAGE_PAGE_MAX && V.HUB_MESSAGE_PAGE_MAX === 50);
}

// ── 3. the customer writes ────────────────────────────────────────────────────
seed();
{
  const before = bells().length;
  const body = { id: M(20), buildingId: 'cl_a', body: '  The side gate code changed to 7788.  ', authorRole: 'staff', authorUserId: 'u_owner', author_client_user_id: CU4 };
  const r = await post('message', body);
  ok('W1 a customer posts a message', () => r.status === 200 && sameKeys(r.body?.message, V.HUB_BUILDING_MESSAGE_FIELDS) && r.body.message.mine === true, show(r));
  const row = world.tables.client_messages.find((m) => m.id === M(20));
  ok('🔴 W2 stored as a CUSTOMER message by WHICH login — from the claim, never the body', () => row?.author_role === 'client' && row.author_client_user_id === CU1 && !row.author_user_id && row.author_name === 'Pat Manager', JSON.stringify(row));
  ok('W3 …trimmed, in the building it named', () => row?.body === 'The side gate code changed to 7788.' && row.client_id === 'cl_a' && row.organization_id === ORG);
  const sum = world.tables.client_message_threads.find((t) => t.client_id === 'cl_a');
  ok('🔴 W4 the building\'s thread summary moves to it (the office list reads it)', () => sum?.last_message_id === M(20) && sum.last_author_role === 'client' && sum.last_client_message_at === row?.created_at, JSON.stringify(sum));
  ok('🔴 W5 retention at the write point: this building\'s 4-year-old line is gone, the 400-day one kept', () => !msgsOf('cl_a').some((m) => m.id === M(4)) && msgsOf('cl_a').some((m) => m.id === M(3)));
  ok('W6 …and another building\'s old line is not touched', () => msgsOf('cl_x').some((m) => m.id === M(6)));
  const rang = bells().slice(0, bells().length - before);
  const fresh = bells().filter((n) => n.eventKey === 'customerMessage');
  ok('🔴 W7 Matt\'s rule: the building\'s MANAGER is rung, and only them', () => fresh.length === 1 && fresh[0].userId === 'u_mgr', JSON.stringify(rang));
  ok('W8 …linking to the building\'s thread in Messaging → Customers', () => fresh[0]?.url === '/messaging?inbox=customers&b=cl_a');
  ok('W9 …naming the building and the customer, with their words', () => /Coral Bay HOA/.test(fresh[0]?.title || '') && /Pat Manager/.test(fresh[0]?.title || '') && /7788/.test(fresh[0]?.body || ''), JSON.stringify(fresh[0]));
  const log = (world.tables.activity_log || []).filter((a) => a.entity_id === M(20));
  ok('🔴 W10 the activity log records it, the CUSTOMER as the actor (never a staff id)', () => log.length === 1 && log[0].actor_role === 'client' && log[0].actor_user_id === null && log[0].client_id === 'cl_a' && log[0].actor_name === 'Pat Manager', JSON.stringify(log));
  const again = await post('message', body);
  ok('🔴 W11 a double-tap is ONE message (the caller-minted id), answered as the first', () => again.status === 200 && world.tables.client_messages.filter((m) => m.id === M(20)).length === 1 && again.body?.message?.id === M(20), show(again));
  ok('W12 …and rings nobody a second time', () => bells().filter((n) => n.eventKey === 'customerMessage').length === 1);
  const stolen = await post('message', { id: M(20), buildingId: 'cl_x', body: 'mine now' }, 'tok-client4');
  ok('🔴 W13 another login re-using that id is a 409 that confirms nothing', () => stolen.status === 409 && stolen.body?.code === 'message-id' && !JSON.stringify(stolen.body).includes('7788'), show(stolen));
  const sameLoginOtherBuilding = await post('message', { id: M(20), buildingId: 'cl_b', body: 'moved?' });
  ok('W14 …and so is the same login re-using it for another building', () => sameLoginOtherBuilding.status === 409, show(sameLoginOtherBuilding));
}
{
  for (const [label, text, code] of [['an empty body', '   ', 'message-empty'], ['a body over 4,000 characters', 'x'.repeat(4001), 'message-too-long'], ['no body at all', undefined, 'message-empty'], ['a body that is not text', { a: 1 }, 'message-empty']]) {
    const r = await post('message', { id: M(21), buildingId: 'cl_a', body: text });
    ok(`🔴 B1 ${label} is a 400 with a sentence and its code`, () => r.status === 400 && r.body?.code === code && typeof r.body?.error === 'string', show(r));
  }
  ok('B2 …and none of them wrote anything', () => !world.tables.client_messages.some((m) => m.id === M(21)));
  const exact = await post('message', { id: M(22), buildingId: 'cl_a', body: 'y'.repeat(4000) });
  ok('B3 exactly 4,000 characters is accepted', () => exact.status === 200, show(exact));
  const badId = await post('message', { id: 'not-a-uuid', buildingId: 'cl_a', body: 'Hi' });
  ok('B4 an id that is not a uuid is a 400', () => badId.status === 400 && badId.body?.code === 'message-id', show(badId));
  const outside = await post('message', { id: M(23), buildingId: 'cl_x', body: 'Hi' });
  ok('🔴 B5 a message to a building outside the scope is a 404, nothing written', () => outside.status === 404 && !world.tables.client_messages.some((m) => m.id === M(23)), show(outside));
}
seed();
{
  // Every Admin hears a building with no manager; the bell never fails the customer's post.
  const r = await post('message', { id: M(24), buildingId: 'cl_b', body: 'Who do I ask about the windows?' });
  const fresh = bells().filter((n) => n.eventKey === 'customerMessage').map((n) => n.userId).sort().join();
  ok('🔴 R1 a building with NO manager rings EVERY active Admin (not the owner, not the managers)', () => r.status === 200 && fresh === 'u_admin,u_admin2', fresh);
  world.failWhen = (q) => q.table === 'org_state' && q.op === 'update';
  const r2 = await post('message', { id: M(25), buildingId: 'cl_b', body: 'Hello?' });
  world.failWhen = null;
  ok('🔴 R2 a bell that cannot be written never fails the customer\'s message', () => r2.status === 200 && world.tables.client_messages.some((m) => m.id === M(25)), show(r2));
  __resetRateLimit();
  let last = null;
  for (let i = 0; i < 61; i += 1) last = await post('message', { id: `f1000000-0000-4000-8000-${String(i).padStart(12, '0')}`, buildingId: 'cl_a', body: `n${i}` });
  ok('🔴 R3 60 messages an hour per login; the 61st is a 429 with a code', () => last.status === 429 && last.body?.code === 'too-many-requests', show(last));
  __resetRateLimit();
}

// ── 4. read markers ───────────────────────────────────────────────────────────
seed();
{
  const r = await post('messages-read', { buildingId: 'cl_a' });
  const mark = world.tables.client_message_reads.find((x) => x.reader_id === CU1);
  ok('K1 marking the thread read stores THIS login\'s marker for the building', () => r.status === 200 && mark?.client_id === 'cl_a' && mark.reader_kind === 'client' && !!mark.last_read_at, show(r));
  const out = await post('messages-read', { buildingId: 'cl_x' });
  ok('🔴 K2 another building is a 404, no marker', () => out.status === 404 && !world.tables.client_message_reads.some((x) => x.client_id === 'cl_x'), show(out));
  const older = await post('messages-read', { buildingId: 'cl_a', at: ago(10 * DAY) });
  const mark2 = world.tables.client_message_reads.find((x) => x.reader_id === CU1 && x.client_id === 'cl_a');
  ok('K3 a marker never moves backwards', () => older.status === 200 && mark2?.last_read_at === mark?.last_read_at, JSON.stringify(mark2));
}

// ── 5. the bell: updates + updates-seen ───────────────────────────────────────
seed();
{
  const r = await get('updates');
  ok('U1 the bell answers', () => r.status === 200 && sameKeys(r.body, ['updates', 'unseen', 'seenAt', 'messagesUnread']), show(r));
  const list = r.body?.updates || [];
  ok('🔴 U2 each update is EXACTLY the update allowlist', () => list.length > 0 && list.every((u) => sameKeys(u, V.HUB_UPDATE_FIELDS)), JSON.stringify(list[0]));
  const kinds = list.map((u) => `${u.kind}:${u.buildingId}`);
  ok('U3 a staff reply on MY request, its stage change, the office\'s messages and a new inspection report',
    () => ['reply:cl_a', 'stage:cl_a', 'message:cl_a', 'message:cl_b', 'inspection:cl_a'].every((k) => kinds.includes(k)), kinds.join(' | '));
  const blob = JSON.stringify(r.body);
  ok('🔴 U4 never another building\'s, an internal note, my own words, or someone else\'s request', () => !/ZZHARBOR|ZZINTERNAL|ZZMYOWN|ZZJORDAN/.test(blob) && !kinds.some((k) => k.endsWith('cl_x')), blob.slice(0, 300));
  ok('U5 the last 30 days only (the 45-day reply, the 40-day inspection, the 400-day message are not served)', () => !/ZZSTALE|Old QC|ZZOLD/.test(blob));
  ok('U6 the customer\'s own reopen is not news to them', () => list.filter((u) => u.kind === 'stage').length === 1);
  ok('U7 a draft inspection is not a report', () => !/Draft walk/.test(blob));
  ok('U8 newest first, at most 20', () => list.length <= 20 && list.every((u, i) => i === 0 || Date.parse(list[i - 1].at) >= Date.parse(u.at)));
  ok('U9 every update links into the hub (a request, a building\'s messages, a report)', () => list.every((u) => u.url.startsWith('/hub/b/')) && list.find((u) => u.kind === 'message' && u.buildingId === 'cl_a')?.url === '/hub/b/cl_a/messages');
  ok('🔴 U10 a staff name reaches the customer as first name + last initial', () => /Renata C\./.test(blob) && !/Renata Cruz|Yolanda Reyes/.test(blob), blob.slice(0, 300));
  ok('U11 never seen: everything is unread, and the count says so', () => list.every((u) => u.unread === true) && r.body.unseen === list.length && r.body.seenAt === null);
  const unreadA = (r.body?.messagesUnread || []).find((x) => x.buildingId === 'cl_a');
  ok('U12 the Messages badge: the office\'s unread lines per building (never my own)', () => unreadA?.count === 1 && (r.body.messagesUnread || []).find((x) => x.buildingId === 'cl_b')?.count === 1, JSON.stringify(r.body?.messagesUnread));
  const seen = await post('updates-seen', {});
  const rowCU1 = world.tables.client_users.find((u) => u.id === CU1);
  ok('🔴 U13 opening the bell stamps THIS login\'s updates_seen_at (from the claim)', () => seen.status === 200 && !!rowCU1.updates_seen_at && !world.tables.client_users.find((u) => u.id === CU4).updates_seen_at, show(seen));
  const r2 = await get('updates');
  ok('U14 …after which nothing is unread', () => r2.status === 200 && (r2.body?.updates || []).every((u) => u.unread === false) && r2.body.unseen === 0, show(r2));
  await post('messages-read', { buildingId: 'cl_a' });
  const r3 = await get('updates');
  ok('U15 reading the thread clears that building\'s Messages badge', () => !(r3.body?.messagesUnread || []).some((x) => x.buildingId === 'cl_a'), JSON.stringify(r3.body?.messagesUnread));
  const r4 = await get('updates', 'tok-client4');
  ok('U16 another login sees only their own building\'s news', () => r4.status === 200 && (r4.body?.updates || []).every((u) => u.buildingId === 'cl_x') && (r4.body?.updates || []).some((u) => u.kind === 'reply'), show(r4));
}

// ── 6. the office ─────────────────────────────────────────────────────────────
seed();
{
  const r = await oget('threads');
  ok('O1 the office lists one row per building with messages', () => r.status === 200 && sameKeys(r.body, ['threads', 'total', 'offset', 'limit', 'unreadThreads']), show(r));
  const rows = r.body?.threads || [];
  ok('🔴 O2 each row is EXACTLY the office thread allowlist', () => rows.length === 3 && rows.every((t) => sameKeys(t, V.OFFICE_THREAD_FIELDS)), JSON.stringify(rows[0]));
  ok('🔴 O3 UNREAD FIRST (a customer wrote, nobody read it), then the newest', () => rows.map((t) => t.clientId).join() === 'cl_x,cl_a,cl_b', rows.map((t) => `${t.clientId}:${t.unread}`).join());
  ok('O4 …each with its manager, last line and unread count', () => rows[0].managerName === 'Sam Ortiz' && rows[0].unreadCount === 1 && rows[0].lastBody.includes('ZZHARBOR') && rows[2].unread === false, JSON.stringify(rows));
  ok('O5 the tab\'s badge: how many threads are unread', () => r.body.unreadThreads === 2);
  const mine = await oget('threads?filter=mine', 'tok-mgr');
  ok('🔴 O6 "mine" = the buildings the caller manages', () => mine.status === 200 && mine.body.threads.map((t) => t.clientId).join() === 'cl_a', show(mine));
  const byMgr = await oget('threads?managerId=u_mgr2');
  ok('O7 the Manager filter', () => byMgr.body?.threads?.map((t) => t.clientId).join() === 'cl_x', show(byMgr));
  const byCust = await oget('threads?clientId=cl_b');
  ok('O8 the Customer filter', () => byCust.body?.threads?.map((t) => t.clientId).join() === 'cl_b', show(byCust));
  const paged = await oget('threads?limit=1&offset=1');
  ok('O9 paged on the server, the total kept', () => paged.body?.threads?.length === 1 && paged.body.total === 3 && paged.body.threads[0].clientId === 'cl_a', show(paged));

  world.log = [];
  const t = await oget('thread?clientId=cl_a');
  // `waitingSince` (HUB-24 (c), 2026-10-12): since when the thread has waited for the office's reply,
  // or null — the thread's own wait, which test-waiting-messages.mjs holds.
  ok('O10 one building\'s thread for the office', () => t.status === 200 && sameKeys(t.body, ['client', 'manager', 'messages', 'hasMore', 'readAt', 'waitingSince', 'textBack']), show(t));
  const msgs = t.body?.messages || [];
  ok('🔴 O11 each line is EXACTLY the office message allowlist, full staff names', () => msgs.length > 0 && msgs.every((m) => sameKeys(m, V.OFFICE_MESSAGE_FIELDS)) && msgs.some((m) => m.authorName === 'Renata Cruz'), JSON.stringify(msgs[0]));
  ok('O12 the office keeps the retention window, not the hub\'s year (the 400-day line is there)', () => msgs.some((m) => m.id === M(3)));
  const oreads = world.log.filter((q) => q.table === 'client_messages' && q.op === 'select');
  ok('🔴 O13 the building is in the office\'s query too', () => oreads.length > 0 && oreads.every((q) => q.eq.client_id === 'cl_a'), JSON.stringify(oreads));
  const missing = await oget('thread?clientId=cl_gone');
  ok('O14 a building not in the book is a 404', () => missing.status === 404 && missing.body?.code === 'not-found', show(missing));

  const sent = [];
  notify.__setHubMailerForTests?.(async (m) => { sent.push(m); return { ok: true }; });
  const s = await opost('send', { id: M(30), clientId: 'cl_a', body: '  We fixed the gate.  ', authorUserId: 'u_owner', author_role: 'client' }, 'tok-mgr');
  const srow = world.tables.client_messages.find((m) => m.id === M(30));
  ok('W20 the office replies', () => s.status === 200 && sameKeys(s.body?.message, V.OFFICE_MESSAGE_FIELDS) && s.body.message.mine === true, show(s));
  ok('🔴 W21 stored as STAFF, the author from the verified claim (never the body)', () => srow?.author_role === 'staff' && srow.author_user_id === 'u_mgr' && !srow.author_client_user_id && srow.author_name === 'Renata Cruz' && srow.body === 'We fixed the gate.', JSON.stringify(srow));
  ok('🔴 W22 the customers who kept "Replies from the office" on are emailed — Jordan turned it off, a disabled login never', () => sent.map((m) => m.to).join() === 'pat@coralbay.test', JSON.stringify(sent.map((m) => m.to)));
  const ssum = world.tables.client_message_threads.find((x) => x.client_id === 'cl_a');
  ok('W23 the thread summary moves; the sender\'s own read marker too', () => ssum?.last_message_id === M(30) && ssum.last_staff_message_at === srow?.created_at
    && world.tables.client_message_reads.some((x) => x.reader_kind === 'staff' && x.reader_id === 'u_mgr' && x.client_id === 'cl_a'), JSON.stringify(ssum));
  const slog = (world.tables.activity_log || []).filter((a) => a.entity_id === M(30));
  ok('W24 the activity log records the reply with the staff actor', () => slog.length === 1 && slog[0].actor_user_id === 'u_mgr' && slog[0].client_id === 'cl_a', JSON.stringify(slog));
  const again = await opost('send', { id: M(30), clientId: 'cl_a', body: 'We fixed the gate.' }, 'tok-mgr');
  ok('🔴 W25 a double-click is ONE reply and ONE email', () => again.status === 200 && world.tables.client_messages.filter((m) => m.id === M(30)).length === 1 && sent.length === 1, show(again));
  const other = await opost('send', { id: M(30), clientId: 'cl_a', body: 'x' }, 'tok-owner');
  ok('W26 another staff member re-using that id is a 409', () => other.status === 409, show(other));
  const tooLong = await opost('send', { id: M(31), clientId: 'cl_a', body: 'z'.repeat(4001) });
  ok('W27 the office\'s reply has the same bounds (400)', () => tooLong.status === 400 && tooLong.body?.code === 'message-too-long', show(tooLong));
  const noBuilding = await opost('send', { id: M(32), clientId: 'cl_gone', body: 'Hi' });
  ok('W28 a reply to a building not in the book is a 404', () => noBuilding.status === 404, show(noBuilding));
  notify.__setHubMailerForTests?.(null);
  const noSender = await opost('send', { id: M(33), clientId: 'cl_a', body: 'And the lobby.' });
  ok('🔴 W29 with NO system sender the reply still saves (the email is skipped, never an error)', () => noSender.status === 200 && world.tables.client_messages.some((m) => m.id === M(33)), show(noSender));

  const hubSees = await get('messages?buildingId=cl_a');
  const reply = (hubSees.body?.messages || []).find((m) => m.id === M(30));
  ok('W30 the customer sees the reply in the hub, as "Renata C."', () => reply?.authorName === 'Renata C.' && reply.authorRole === 'staff' && reply.body === 'We fixed the gate.', JSON.stringify(reply));

  const rd = await opost('read', { clientId: 'cl_x' }, 'tok-owner');
  const after = await oget('threads');
  ok('W31 marking a thread read clears its unread for THAT person', () => rd.status === 200 && after.body?.threads?.find((x) => x.clientId === 'cl_x')?.unread === false, show(after));
  const forOther = await oget('threads', 'tok-admin');
  ok('W32 …and only for them', () => forOther.body?.threads?.find((x) => x.clientId === 'cl_x')?.unread === true, show(forOther));

  // hub.messages.reply is its own key: pared off, the office can read but not write.
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_mgr2', grants: [], revokes: ['hub.messages.reply'] }];
  const readOnly = await oget('threads', 'tok-mgr2');
  const refused = await opost('send', { id: M(34), clientId: 'cl_x', body: 'Hi' }, 'tok-mgr2');
  ok('🔴 W33 without hub.messages.reply: the threads still read, a reply is a 403', () => readOnly.status === 200 && refused.status === 403 && !world.tables.client_messages.some((m) => m.id === M(34)), `${show(readOnly)} / ${show(refused)}`);
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_mgr2', grants: [], revokes: ['hub.messages.view'] }];
  const noView = await oget('threads', 'tok-mgr2');
  ok('W34 without hub.messages.view the list itself is a 403', () => noView.status === 403, show(noView));
}

// ── 7. error bodies never carry the provider's text (CS-077 class) ────────────
seed();
{
  world.failWhen = (q) => q.table === 'client_messages' && q.op === 'select';
  world.failMessage = 'relation "zz_secret_internal_table" does not exist';
  const r = await get('messages?buildingId=cl_a');
  const o = await oget('thread?clientId=cl_a');
  world.failWhen = null; world.failMessage = null;
  ok('🔴 X1 a failed read answers a sentence and a code, never the provider\'s words', () => r.status >= 500 && typeof r.body?.code === 'string' && !JSON.stringify(r.body).includes('zz_secret'), show(r));
  ok('🔴 X2 …the office route too', () => o.status >= 500 && !JSON.stringify(o.body).includes('zz_secret'), show(o));
}

console.log(`\nhub messages routes: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
