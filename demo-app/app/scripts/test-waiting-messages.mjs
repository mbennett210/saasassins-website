// HUB-24 (c), Matt (Review, 2026-10-12): "Yes, they should be separate. Messages and requests should
// be treated separately." / "Especially since we want to track requests and how long it takes us to
// close them." So Client Requests (`/requests`) is REQUESTS ONLY again — the open work orders, their
// tabs, counts, overdue figures and first-reply countdown — and a customer's message waiting for the
// office's reply keeps its OWN place and count: Messaging → Customers (a Waiting view, the longest
// wait first) and the customer page's Messages tab, each saying how long it has waited, and a
// separate "N messages waiting" tile on the manager Home with the Messages row's pill. The alerts
// for a customer's message do not change, and time to resolve already counted requests only.
// (This replaces test-one-queue.mjs, the 2026-10-09 ONE queue of HUB-24 (a): its rules and the
// `threads?waiting=1` route checks live on here, since the waiting messages' count reads them.)
//
// What this pins:
//   A. the rules (lib/hubMessages): a thread waits when its customer wrote last; the wait starts at
//      the first customer line after the office's last (a second line does not restart it), never at
//      a line past retention; how long it has waited, in whole minutes (lib/dates minutesSince);
//   B. 🔴 the REAL /api/client-messages route over fake-supabase.mjs: `threads?waiting=1` lists every
//      waiting thread with `waitingSince`, behind `hub.messages.view`; complete past the 1,000-row
//      cap; and ONE building's thread (`thread`) says since when it has waited, or null;
//   C. the demo answers the same (lib/clientMessagesDemo, the login-free build);
//   D. 🔴 Client Requests is requests only: the merged queue's message half is gone (II.5) from the
//      rules, the page, the drawer, the Home's request figures and the catalog;
//   E. 🔴 the waiting messages' own count: the Home's Customer messages tile, its gate, its read and
//      the Messages row's pill;
//   F. 🔴 the screens: Messaging → Customers' Waiting view and its rows' waits, the thread's wait,
//      their catalog words; the customer-message alert unchanged.
//
// Every module is imported at run time, so on the tree before the change each new check FAILS.
//
//   node app/scripts/test-waiting-messages.mjs
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

const ORG = '00000000-0000-0000-0000-000000000624';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG, APP_PUBLIC_URL: 'https://hub.example.test',
});
delete process.env.SYSTEM_SENDER_EMAIL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
// The demo store reads the browser's storage; an in-memory one stands in.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();
const roles = await import('../src/lib/roles.js');
const { seedPermissions } = roles;
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const V = await import('../src/lib/hubMessages.js');
const DATES = await import('../src/lib/dates.js');
const WO = await import('../src/lib/workOrders.js');
const CR = await import('../src/lib/clientRequests.js').catch(() => ({}));
const HOME = await import('../src/lib/managerHome.js').catch(() => ({}));
const core = await import('../src/i18n/core.js');
const office = (await import('../api/client-messages/[...path].js')).default;
const hub = (await import('../api/hub/[...path].js')).default;
const demo = await import('../src/lib/clientMessagesDemo.js');
const { CLIENT_MESSAGES_STUB_KEY } = await import('../src/data/stubKeys.js');
const { INITIAL_STATE } = await import('../src/data/seed.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let pass = 0;
const fails = [];
// ok(label, fn): fn returns truthy to pass; a throw is a fail carrying its message.
const ok = (label, fn, detail = () => '') => {
  let good = false;
  let why = '';
  try { good = !!fn(); } catch (e) { why = e.message; }
  if (good) pass += 1;
  else {
    let d = '';
    try { d = why ? '' : detail(); } catch { d = ''; }
    fails.push(`${label}${why ? `\n      threw: ${why}` : ''}${d ? `\n      ${d}` : ''}`);
  }
};
const need = (mod, name) => { if (typeof mod[name] !== 'function') throw new Error(`no ${name}()`); return mod[name]; };
const has = (key) => typeof core.SOURCE_CATALOG[key] !== 'undefined';

const MIN = 60 * 1000;
const H = 60 * MIN;
const DAY = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// ═══ A. the rules ═══════════════════════════════════════════════════════════════════════════
{
  const awaiting = (s) => need(V, 'threadAwaitingReply')(s);
  ok('A1 a thread waits when its customer wrote after the office', () => awaiting({ last_client_message_at: ago(5 * MIN), last_staff_message_at: ago(H) }));
  ok('A2 …or the office never wrote', () => awaiting({ last_client_message_at: ago(5 * MIN), last_staff_message_at: null }));
  ok('A3 it does not once the office answered last, or nobody but the office wrote', () => !awaiting({ last_client_message_at: ago(H), last_staff_message_at: ago(5 * MIN) })
    && !awaiting({ last_client_message_at: null, last_staff_message_at: ago(5 * MIN) }));
  const lines = [
    { client_id: 'c', author_role: 'client', created_at: ago(3 * H) },
    { client_id: 'c', author_role: 'staff', created_at: ago(2 * H) },
    { client_id: 'c', author_role: 'client', created_at: ago(50 * MIN) },
    { client_id: 'c', author_role: 'client', created_at: ago(10 * MIN) },
    { client_id: 'other', author_role: 'client', created_at: ago(70 * MIN) },
  ];
  ok('A4 the wait starts at the FIRST customer line after the office\'s last (a second line does not restart it)',
    () => need(V, 'firstUnansweredAt')(lines, { clientId: 'c', lastStaffAt: ago(2 * H) }) === lines[2].created_at);
  ok('A5 never answered: the first customer line', () => need(V, 'firstUnansweredAt')(lines, { clientId: 'c', lastStaffAt: null }) === lines[0].created_at);
  ok('A6 a line past retention never starts a clock (the wait floor is the retention cutoff)', () => {
    const now = Date.parse('2026-10-09T18:00:00.000Z');
    const cutoff = V.messageRetentionCutoffIso(now);
    const recent = '2026-10-09T17:00:00.000Z';
    const floor = need(V, 'waitFloorIso');
    return floor(null, now) === cutoff && floor(recent, now) === recent && floor('2020-01-01T00:00:00.000Z', now) === cutoff;
  });
  ok('A7 the waiting row\'s fields are the thread list\'s plus waitingSince', () => Array.isArray(V.OFFICE_WAITING_FIELDS)
    && JSON.stringify(V.OFFICE_WAITING_FIELDS) === JSON.stringify([...V.OFFICE_THREAD_FIELDS, 'waitingSince']));
  const since = (s, first) => need(V, 'waitingSinceFrom')(s, first);
  const waitingSummary = { client_id: 'c', last_client_message_at: ago(10 * MIN), last_staff_message_at: ago(2 * H) };
  ok('🔴 A8 one rule for when a wait began: the first unanswered line the reader found, else the customer\'s last line',
    () => since(waitingSummary, lines[2].created_at) === lines[2].created_at);
  ok('🔴 A8b …and no wait at all once the office answered last (or for a building nobody wrote to)', () => since({ client_id: 'c', last_client_message_at: ago(H), last_staff_message_at: ago(5 * MIN) }, ago(H)) === null
    && since(null, null) === null && since(waitingSummary, null) === waitingSummary.last_client_message_at);
  const NOW = Date.parse('2026-10-12T15:00:00.000Z');
  const waited = (iso) => need(DATES, 'minutesSince')(iso, NOW);
  ok('🔴 A9 how long it has waited (lib/dates minutesSince), in whole minutes (50 min, a day and a half), never negative, null when not waiting',
    () => waited(new Date(NOW - 50 * MIN - 20000).toISOString()) === 50 && waited(new Date(NOW - 36 * H).toISOString()) === 36 * 60
      && waited(new Date(NOW + MIN).toISOString()) === 0 && waited(null) === null && waited('nope') === null);
}

// ═══ B. the real route ══════════════════════════════════════════════════════════════════════
const CU1 = 'a0000000-0000-4000-8000-000000000001';
const M = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (id, role, name) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {} });
const cmsg = (id, client, role, { cu = null, uid = null, name = null, body, at }) => ({
  id, organization_id: ORG, client_id: client, author_role: role, author_client_user_id: cu, author_user_id: uid, author_name: name, body, created_at: at,
});
const thread = (client, m, extra = {}) => ({
  organization_id: ORG, client_id: client, last_message_id: m.id, last_message_at: m.created_at, last_author_role: m.author_role,
  last_author_name: m.author_name, last_author_user_id: m.author_user_id, last_author_client_user_id: m.author_client_user_id,
  last_snippet: m.body.slice(0, 200), last_client_message_at: null, last_staff_message_at: null, updated_at: m.created_at, ...extra,
});
const LOGINS = {
  'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  'tok-mgr': { id: 'auth-m', email: 'u_mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
  'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
  'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
};
function seed({ clients, messages, threads }) {
  __resetRateLimit();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 57, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_owner', 'owner', 'Dana Owner'), user('u_mgr', 'manager', 'Renata Cruz'), user('u_mgr2', 'manager', 'Sam Ortiz'), user('u_crew', 'crew', 'Tomas Rivera')],
          clients, sites: [], permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
        },
      }],
      crew_assignments: [],
      client_users: [{ id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1', email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) }],
      client_user_groups: [],
      client_user_group_members: [],
      client_user_assignments: [{ id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null }],
      client_messages: messages,
      client_message_threads: threads,
      client_message_reads: [],
      problem_reports: [],
      work_order_messages: [],
      activity_log: [],
      inspection_records: [],
      inbox_accounts: [],
    },
    logins: LOGINS,
  });
}
async function call(handler, { method = 'GET', path: p, token, body }) {
  const [sub, qs] = p.split('?');
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body ?? {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 60000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const waiting = (token = 'tok-owner', qs = '') => call(office, { path: `threads?waiting=1${qs}`, token });
const oneThread = (clientId, token = 'tok-owner') => call(office, { path: `thread?clientId=${clientId}`, token });
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 300)}`;
const byClient = (r) => new Map(((r && r.body && r.body.threads) || []).map((t) => [t.clientId, t]));

{
  // cl_a: answered, then the customer wrote twice. cl_b: the office wrote last. cl_x: never
  // answered, plus a line from four years back (past retention). cl_q: nobody has written.
  const a1 = cmsg(M(1), 'cl_a', 'client', { cu: CU1, name: 'Pat Manager', body: 'Is the lobby glass on tonight?', at: ago(3 * H) });
  const a2 = cmsg(M(2), 'cl_a', 'staff', { uid: 'u_mgr', name: 'Renata Cruz', body: 'Yes it is.', at: ago(2 * H) });
  const a3 = cmsg(M(3), 'cl_a', 'client', { cu: CU1, name: 'Pat Manager', body: 'It was missed again.', at: ago(50 * MIN) });
  const a4 = cmsg(M(4), 'cl_a', 'client', { cu: CU1, name: 'Pat Manager', body: 'Anyone there?', at: ago(10 * MIN) });
  const b1 = cmsg(M(5), 'cl_b', 'client', { cu: null, name: 'Front desk', body: 'Thanks', at: ago(5 * H) });
  const b2 = cmsg(M(6), 'cl_b', 'staff', { uid: 'u_owner', name: 'Dana Owner', body: 'Booked for Friday.', at: ago(4 * H) });
  const xOld = cmsg(M(7), 'cl_x', 'client', { name: 'Harbor', body: 'ZZANCIENTZZ', at: ago(4 * 365 * DAY) });
  const x1 = cmsg(M(8), 'cl_x', 'client', { name: 'Harbor', body: 'Elevator smells.', at: ago(25 * MIN) });
  seed({
    clients: [
      { id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr' },
      { id: 'cl_b', name: 'Bayshore', supervisorId: 'u_mgr' },
      { id: 'cl_x', name: 'Harbor Tower', supervisorId: 'u_mgr2' },
      { id: 'cl_q', name: 'Quiet Plaza', supervisorId: 'u_mgr2' },
    ],
    messages: [a1, a2, a3, a4, b1, b2, xOld, x1],
    threads: [
      thread('cl_a', a4, { last_client_message_at: a4.created_at, last_staff_message_at: a2.created_at }),
      thread('cl_b', b2, { last_client_message_at: b1.created_at, last_staff_message_at: b2.created_at }),
      thread('cl_x', x1, { last_client_message_at: x1.created_at }),
    ],
  });
  const r = await waiting();
  const got = byClient(r);
  ok('B1 `threads?waiting=1` answers the threads waiting for the office: Coral Bay and Harbor, not Bayshore', () => r.status === 200 && got.has('cl_a') && got.has('cl_x') && !got.has('cl_b') && r.body.total === 2, () => show(r));
  ok('B2 Coral Bay waits from its first unanswered line (50 min), not its latest (10 min)', () => got.get('cl_a')?.waitingSince === a3.created_at, () => show(r));
  ok('B3 Harbor waits from its first line inside retention, never the four-year-old one', () => got.get('cl_x')?.waitingSince === x1.created_at, () => show(r));
  ok('B4 the longest wait first', () => r.body.threads[0]?.clientId === 'cl_a', () => show(r));
  ok('B5 each row carries the building and the latest message, and exactly the waiting fields', () => {
    const t = got.get('cl_a');
    return t && t.clientName === 'Coral Bay HOA' && t.lastBody === 'Anyone there?' && t.managerId === 'u_mgr'
      && Object.keys(t).sort().join() === [...V.OFFICE_WAITING_FIELDS].sort().join();
  }, () => show(r));
  const mine = await waiting('tok-owner', '&managerId=u_mgr2');
  ok('B6 the Manager filter narrows it (Sam\'s Harbor only) — the Home\'s scope for one manager', () => mine.status === 200 && mine.body.total === 1 && mine.body.threads[0].clientId === 'cl_x', () => show(mine));
  const crew = await waiting('tok-crew');
  const cust = await waiting('tok-client');
  const anon = await waiting(null);
  ok('🔴 B7 behind Messaging → Customers\' own key: crew 403, a customer login 403, no login 401', () => crew.status === 403 && cust.status === 403 && anon.status === 401, () => `${crew.status} ${cust.status} ${anon.status}`);
  const mgr = await waiting('tok-mgr');
  ok('B8 a manager holding hub.messages.view reads it', () => mgr.status === 200 && mgr.body.total === 2, () => show(mgr));

  // S131 Wave 2 (the owner's Operations view's tiles): `managerId=team` is the CALLER's team, and an
  // owner or an admin may name WHOSE (`om`, an active Operations Manager — lib/teamScope teamLeadFor);
  // a manager never widens theirs. Sam leads Renata's team for these four checks.
  const users0 = world.tables.org_state[0].state.users;
  world.tables.org_state[0].state.users = users0.map((u) => (u.id === 'u_mgr2' ? { ...u, managerLevel: 'operations' }
    : u.id === 'u_mgr' ? { ...u, opsManagerId: 'u_mgr2' } : u));
  const ownerOm = await waiting('tok-owner', '&managerId=team&om=u_mgr2');
  ok('🔴 B12 the owner names an Operations Manager\'s team (`om`): every thread waiting on it — Coral Bay (Renata\'s) and Harbor (Sam\'s)',
    () => ownerOm.status === 200 && ownerOm.body.total === 2 && byClient(ownerOm).has('cl_a') && byClient(ownerOm).has('cl_x'), () => show(ownerOm));
  const ownerNotOm = await waiting('tok-owner', '&managerId=team&om=u_mgr');
  ok('B13 … an id that is not an active Operations Manager names no team (the owner\'s own: none)', () => ownerNotOm.status === 200 && ownerNotOm.body.total === 0, () => show(ownerNotOm));
  const mgrOm = await waiting('tok-mgr', '&managerId=team&om=u_mgr2');
  ok('🔴 B14 … and a manager never widens their `team` with `om` (Renata: her own building only)',
    () => mgrOm.status === 200 && mgrOm.body.total === 1 && byClient(mgrOm).has('cl_a'), () => show(mgrOm));
  const badOm = await waiting('tok-owner', '&managerId=team&om=a,b');
  ok('B15 … and an `om` that is not one id is refused (400)', () => badOm.status === 400, () => show(badOm));
  world.tables.org_state[0].state.users = users0;

  // ONE building's thread says since when it has waited (the customer page's Messages tab and the
  // open thread in Messaging → Customers).
  const ta = await oneThread('cl_a');
  ok('🔴 B9 one building\'s thread says since when it has waited: Coral Bay from its first unanswered line', () => ta.status === 200 && ta.body.waitingSince === a3.created_at, () => show(ta));
  const tx = await oneThread('cl_x');
  ok('🔴 B10 …Harbor from its first line inside retention', () => tx.status === 200 && tx.body.waitingSince === x1.created_at, () => show(tx));
  const tb = await oneThread('cl_b');
  const tq = await oneThread('cl_q');
  ok('🔴 B11 …and null where the office wrote last, or nobody has written', () => tb.status === 200 && tb.body.waitingSince === null && tq.status === 200 && tq.body.waitingSince === null,
    () => `${show(tb)} · ${show(tq)}`);

  // The office answers Coral Bay IN the thread (the reply the customer sees): it stops waiting.
  const sent = await call(office, { method: 'POST', path: 'send', token: 'tok-mgr', body: { id: M(20), clientId: 'cl_a', body: 'Sending someone tonight.' } });
  const after = await waiting();
  const ta2 = await oneThread('cl_a');
  ok('B12 once the office replies in the thread, it leaves the waiting list', () => sent.status === 200 && !byClient(after).has('cl_a') && byClient(after).has('cl_x') && after.body.total === 1, () => `${show(sent)} → ${show(after)}`);
  ok('🔴 B13 …and its thread no longer says it is waiting', () => ta2.status === 200 && ta2.body.waitingSince === null, () => show(ta2));
  // …and when the customer writes again from the hub, it waits again, from that line.
  const again = await call(hub, { method: 'POST', path: 'message', token: 'tok-client', body: { id: M(21), buildingId: 'cl_a', body: 'Thank you — and the mats?' } });
  const back = await waiting();
  const ta3 = await oneThread('cl_a');
  const line = world.tables.client_messages.find((m) => m.id === M(21));
  ok('B14 the customer writes again from the hub: back in the list, waiting from that line', () => again.status === 200 && byClient(back).get('cl_a')?.waitingSince === line?.created_at, () => `${show(again)} → ${show(back)}`);
  ok('🔴 B15 …and the thread says so too', () => ta3.status === 200 && !!line && ta3.body.waitingSince === line.created_at, () => show(ta3));
}

// Complete past the cap: 1,050 waiting threads — more than one PostgREST response holds.
{
  const N = 1050;
  const clients = [];
  const messages = [];
  const threads = [];
  for (let i = 0; i < N; i += 1) {
    const id = `cl_${String(i).padStart(4, '0')}`;
    clients.push({ id, name: `Building ${i}`, supervisorId: i % 2 ? 'u_mgr' : 'u_mgr2' });
    const m = cmsg(M(1000 + i), id, 'client', { name: 'Desk', body: `Line ${i}`, at: ago((i + 1) * MIN) });
    messages.push(m);
    threads.push(thread(id, m, { last_client_message_at: m.created_at }));
  }
  seed({ clients, messages, threads });
  world.maxRows = 1000; // 🔴 Supabase's db-max-rows
  const r = await waiting();
  const got = byClient(r);
  ok('🔴 B16 all 1,050 waiting threads are listed past the 1,000-row cap, each once (the count is complete)', () => r.status === 200 && r.body.total === N && got.size === N
    && clients.every((c) => got.has(c.id)), () => `${r.status} total ${r.body?.total} · ${got.size} rows`);
  ok('B17 …the oldest wait first', () => r.body.threads[0]?.clientId === `cl_${String(N - 1).padStart(4, '0')}`, () => r.body.threads[0]?.clientId);
  world.maxRows = null;
}

// ═══ C. the demo answers the same ═══════════════════════════════════════════════════════════
{
  const [c1, c2] = (INITIAL_STATE.clients || []).filter((c) => c && c.id);
  const first = ago(40 * MIN);
  mem.set(CLIENT_MESSAGES_STUB_KEY, JSON.stringify({
    messages: [
      { id: 'd1', client_id: c1.id, author_role: 'client', author_name: 'Desk', body: 'First', created_at: first },
      { id: 'd2', client_id: c1.id, author_role: 'client', author_name: 'Desk', body: 'Second', created_at: ago(5 * MIN) },
      { id: 'd3', client_id: c2.id, author_role: 'client', author_name: 'Desk', body: 'Hi', created_at: ago(H) },
      { id: 'd4', client_id: c2.id, author_role: 'staff', author_user_id: 'u1', author_name: 'Office', body: 'Hello', created_at: ago(30 * MIN) },
    ],
    reads: [],
  }));
  const r = await demo.officeThreads({ waiting: 1 });
  ok('C1 the demo lists the same waiting threads by the same rules (waiting from the first unanswered line)', () => r.total === 1 && r.threads[0].clientId === c1.id
    && r.threads[0].waitingSince === first, () => JSON.stringify(r));
  let t1 = {};
  let t2 = {};
  try { t1 = await demo.officeThread(c1.id); t2 = await demo.officeThread(c2.id); } catch { /* reported below */ }
  ok('🔴 C2 the demo\'s thread says since when it has waited (and null where the office wrote last)', () => t1.waitingSince === first && t2.waitingSince === null,
    () => `${t1.waitingSince} · ${t2.waitingSince}`);
  await demo.officeSend({ id: '7d0f1c8e-0000-4000-8000-000000000001', clientId: c1.id, body: 'On it' }, { user: { id: (INITIAL_STATE.users || [])[0]?.id } });
  const after = await demo.officeThreads({ waiting: 1 });
  const t1b = await demo.officeThread(c1.id).catch(() => ({}));
  ok('C3 …and an office reply takes it out of the list', () => after.total === 0, () => JSON.stringify(after));
  ok('🔴 C4 …and off its thread', () => t1b.waitingSince === null, () => String(t1b.waitingSince));
}

// ═══ D. Client Requests is requests only (II.5: the message half is gone) ═══════════════════════
{
  const NOW = Date.parse('2026-10-12T18:00:00.000Z');
  const at = (mins) => new Date(NOW - mins * MIN).toISOString();
  const SUP = { cl_a: 'u_mgr', cl_b: 'u_mgr', cl_x: 'u_mgr2' };
  const supervisorOf = (id) => SUP[id] || null;
  const tickets = [
    { id: 't1', client_id: 'cl_b', type: 'complaint', priority: 'urgent', status: 'in_progress', created_at: at(30), first_reply_at: at(20) },
    { id: 't2', client_id: 'cl_x', type: 'issue', priority: 'low', status: 'open', created_at: at(60) },
  ];
  const threads = [
    { clientId: 'cl_a', clientName: 'Coral Bay HOA', managerId: 'u_mgr', lastBody: 'Anyone there?', waitingSince: at(45) },
    { clientId: 'cl_x', clientName: 'Harbor Tower', managerId: 'u_mgr2', lastBody: 'Elevator smells.', waitingSince: at(10) },
  ];
  const rows = (() => { try { return need(CR, 'clientRequestRows')(tickets, { now: NOW, settings: {}, supervisorOf }); } catch { return []; } })();
  ok('D1 the requests are the open work orders (clientRequestRows), and nothing else', () => rows.length === 2 && rows.every((r) => r.kind === 'ticket'), () => JSON.stringify(rows.map((r) => r.id)));
  ok('🔴 D2 the merged queue\'s message half is gone from the rules (clientRequestQueue, messageRequestRows, threadClock, MESSAGE_KIND, CLIENT_REQUEST_TYPES)',
    () => ['clientRequestQueue', 'messageRequestRows', 'threadClock', 'MESSAGE_KIND', 'CLIENT_REQUEST_TYPES'].every((k) => !(k in CR)) && typeof CR.clientRequestRows === 'function',
    () => ['clientRequestQueue', 'messageRequestRows', 'threadClock', 'MESSAGE_KIND', 'CLIENT_REQUEST_TYPES'].filter((k) => k in CR).join(', '));
  const counts = (() => { try { return need(CR, 'clientRequestCounts')(rows); } catch { return {}; } })();
  ok('D3 the counts are the requests\': 2 open, 1 urgent', () => counts.open === 2 && counts.urgent === 1, () => JSON.stringify(counts));
  const scope = HOME.homeScope ? HOME.homeScope({ viewer: { id: 'u_owner', role: 'owner' }, mgrParam: '', clients: [{ id: 'cl_a' }, { id: 'cl_b' }, { id: 'cl_x' }] }) : null;
  const figs = (() => { try { return need(HOME, 'requestFigures')({ problems: tickets, threads }, { scope, clients: [], now: NOW }); } catch { return {}; } })();
  ok('🔴 D4 the Home\'s Client Requests figure counts requests only — a waiting message is not one', () => figs.open === 2 && figs.urgent === 1, () => JSON.stringify(figs));

  const page = read('../src/pages/ClientRequests.jsx');
  ok('🔴 D5 the page reads no customer threads (no waiting read, no messages key, no thread drawer)', () => !/listWaitingCustomerThreads/.test(page)
    && !/hub\.messages\.view/.test(page) && !/MessageThreadDrawer/.test(page) && !/MESSAGE_KIND/.test(page) && /clientRequestRows\(/.test(page));
  ok('🔴 D6 its Type filter offers the work orders\' own types (WO_TYPES), and its words no "Message" type', () => /WO_TYPES\.map\(/.test(page) && !/clientReq\.type\.message/.test(page)
    && !WO.WO_TYPES.includes('message'));
  const drawer = read('../src/components/WorkOrderDrawer.jsx');
  ok('🔴 D7 the work-order drawer no longer draws a customer\'s thread (MessageThreadDrawer gone)', () => !/MessageThreadDrawer/.test(drawer) && !/import CustomerThread/.test(drawer));
  const gone = ['clientReq.type.message', 'clientReq.waitingJustNow', 'clientReq.waitingFor', 'clientReq.waitingDays', 'clientReq.from',
    'workOrders.thread.kind', 'workOrders.thread.close', 'workOrders.thread.aria'];
  ok('🔴 D8 the catalog lost the message half\'s words', () => gone.every((k) => !has(k)), () => gone.filter(has).join(', '));
  const reads = read('../src/hooks/useManagerHomeReads.js');
  const useRequests = (reads.match(/export function useRequestsRead[\s\S]*?\n}\n/) || [''])[0];
  ok('🔴 D9 the Home\'s requests read is the open tickets only', () => !!useRequests && /qcApi\.listOpenProblems\(/.test(useRequests) && !/listWaitingCustomerThreads/.test(useRequests), () => useRequests.slice(0, 200));
}

// ═══ E. the waiting messages' own count: the Home's tile and the Messages pill ═══════════════════
{
  const NOW = Date.parse('2026-10-12T18:00:00.000Z');
  const at = (mins) => new Date(NOW - mins * MIN).toISOString();
  const clients = [
    { id: 'cl_a', name: 'A', supervisorId: 'u_dana' },
    { id: 'cl_b', name: 'B', supervisorId: 'u_dana' },
    { id: 'cl_c', name: 'C', supervisorId: 'u_lee' },
  ];
  const threads = [
    { clientId: 'cl_a', managerId: 'u_dana', waitingSince: at(50) },
    { clientId: 'cl_b', managerId: 'u_dana', waitingSince: at(12) },
    { clientId: 'cl_c', managerId: 'u_lee', waitingSince: at(36 * 60) },
  ];
  const scopeOf = (viewer, mgrParam = '') => (HOME.homeScope ? HOME.homeScope({ viewer, mgrParam, clients }) : null);
  const figs = (scope) => { try { return need(HOME, 'messageFigures')({ threads }, { scope, now: NOW }); } catch { return null; } };
  const dana = figs(scopeOf({ id: 'u_dana', role: 'manager' }));
  const all = figs(scopeOf({ id: 'u_owner', role: 'owner' }));
  const lee = figs(scopeOf({ id: 'u_owner', role: 'owner' }, 'u_lee'));
  ok('🔴 E1 "N messages waiting" in the manager\'s scope, with the longest wait (Dana: 2, 50 min)', () => dana?.waiting === 2 && dana?.longestMins === 50, () => JSON.stringify(dana));
  ok('🔴 E2 …All managers counts every one (3, the day and a half), a picked manager only theirs (Lee: 1)', () => all?.waiting === 3 && all?.longestMins === 36 * 60 && lee?.waiting === 1,
    () => `${JSON.stringify(all)} · ${JSON.stringify(lee)}`);
  ok('🔴 E3 no answer yet → no figures (never zeros drawn as data); an empty answer is zero waiting', () => (HOME.messageFigures ? HOME.messageFigures(null) === null : false)
    && figs(scopeOf({ id: 'u_owner', role: 'owner' })) !== null && need(HOME, 'messageFigures')({ threads: [] }, { now: NOW }).waiting === 0);
  ok('🔴 E4 the tile is gated by the read\'s own key (hub.messages.view), right after Client Requests', () => JSON.stringify(HOME.TILE_GATES?.messages) === JSON.stringify({ perm: 'hub.messages.view' })
    && Array.isArray(HOME.HOME_TILES) && HOME.HOME_TILES.indexOf('messages') === HOME.HOME_TILES.indexOf('requests') + 1);
  const checkerFor = (role, revokes = []) => {
    const u = { id: `u_${role}`, role };
    const overrides = revokes.length ? [{ userId: u.id, grants: [], revokes }] : [];
    return (key) => roles.can(u, key, undefined, overrides);
  };
  const tiles = (c) => (typeof HOME.homeTiles === 'function' ? HOME.homeTiles(c) : []);
  ok('🔴 E5 a manager on the defaults sees it; revoking hub.messages.view removes it alone; crew never', () => tiles(checkerFor('manager')).includes('messages')
    && !tiles(checkerFor('manager', ['hub.messages.view'])).includes('messages')
    && JSON.stringify(tiles(checkerFor('manager', ['hub.messages.view']))) === JSON.stringify(tiles(checkerFor('manager')).filter((k) => k !== 'messages'))
    && !roles.can({ id: 'u_c', role: 'crew' }, 'hub.messages.view'));
  const pills = (o) => (typeof HOME.navPills === 'function' ? HOME.navPills(o) : {});
  ok('🔴 E6 the Messages row\'s pill is the waiting count; Client Requests\' stays the open requests', () => pills({ requests: { open: 5 }, messages: { waiting: 3 } })['/messaging'] === 3
    && pills({ requests: { open: 5 }, messages: { waiting: 3 } })['/requests'] === 5 && pills({})['/messaging'] === null);

  const reads = read('../src/hooks/useManagerHomeReads.js');
  const useMessages = (reads.match(/export function useMessagesRead[\s\S]*?\n}\n/) || [''])[0];
  ok('🔴 E7 the tile and the pill share ONE read: the waiting threads, scoped to the manager in view', () => /listWaitingCustomerThreads\(\{ managerId: scope\.mgrId \|\| null \}/.test(useMessages)
    && /useHomeRead\('messages', scope, reader, enabled\)/.test(useMessages));
  ok('🔴 E8 the nav counts read it for a hub.messages.view holder', () => /const messages = useMessagesRead\(scope, has\('messages'\)\)/.test(reads)
    && /messages: messages\.data \? messageFigures\(messages\.data, \{ scope/.test(reads));
  const homePage = read('../src/pages/ManagerHome.jsx');
  ok('🔴 E9 the Home draws the Customer messages tile, opening Messaging → Customers\' Waiting view (with its referrer)', () => /show\('messages'\)/.test(homePage)
    && /useMessagesRead\(scope, show\('messages'\)\)/.test(homePage) && /to=\{linkTo\('messages'\)\}/.test(homePage)
    && HOME.TILE_PAGES?.messages?.path === '/messaging?inbox=customers&view=waiting'
    && /t\('mgrHome\.msg\.waiting', \{ count: msgFigures\.waiting \}\)/.test(homePage));
  ok('🔴 E10 its words are catalog lines', () => ['mgrHome.msg.title', 'mgrHome.msg.waiting', 'mgrHome.msg.longest', 'mgrHome.msg.longestDays', 'mgrHome.msg.cta'].every(has)
    && core.english('mgrHome.msg.waiting', { count: 2 }) === '2 messages waiting' && core.english('mgrHome.msg.waiting', { count: 1 }) === '1 message waiting');
}

// ═══ F. the screens: Messaging → Customers and the customer page's Messages tab ═══════════════════
{
  const inbox = read('../src/components/CustomerMessagesInbox.jsx');
  const threadUi = read('../src/components/CustomerThread.jsx');
  const api = read('../src/lib/clientMessagesApi.js');
  ok('F1 the client adapter still reads `threads?waiting=1` (the count and the Waiting view read it)', () => /export async function listWaitingCustomerThreads/.test(api) && /waiting: 1/.test(api));
  ok('🔴 F2 Messaging → Customers has a Waiting view, opened by ?view=waiting, read from the waiting list', () => /\['all', 'mine', 'waiting'\]/.test(inbox)
    && /searchParams\.get\('view'\) === 'waiting'/.test(inbox) && /listWaitingCustomerThreads\(/.test(inbox));
  ok('🔴 F3 every waiting row says how long it has waited (the list\'s rows too, from the same read)', () => /<WaitedFor since=\{/.test(inbox) && /waitingByClient/.test(inbox));
  ok('🔴 F4 the open thread — Messaging\'s pane and the customer page\'s Messages tab — says it too, from the thread\'s own answer', () => /export function WaitedFor/.test(threadUi)
    && /waitingSince: r\.waitingSince/.test(threadUi) && (threadUi.match(/<WaitedFor since=\{data\.waitingSince\}/g) || []).length === 2);
  const words = ['custMsg.list.waiting', 'custMsg.list.waitingCount', 'custMsg.list.emptyWaiting', 'custMsg.list.emptyWaitingHint', 'custMsg.wait.justNow', 'custMsg.wait.for', 'custMsg.wait.days'];
  ok('🔴 F5 their words are catalog lines', () => words.every(has) && core.english('custMsg.wait.for', { time: 50 }) === 'Waiting 50m', () => words.filter((k) => !has(k)).join(', '));
  // M4: the alerts stay exactly as they are — the bell row for a customer's message still opens
  // that building's thread in Messaging → Customers.
  const alert = V.customerMessageAlert({ clientId: 'cl_a', placeName: 'Coral Bay HOA', authorName: 'Pat', body: 'Hello' });
  ok('F6 (control) a customer\'s message still rings the office the same way, linking its thread', () => alert.url === '/messaging?inbox=customers&b=cl_a' && alert.body === 'Hello');
}

if (fails.length) {
  console.error(`\n✖ test-waiting-messages: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`   ✖ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-waiting-messages: ${pass} passed`);
}
