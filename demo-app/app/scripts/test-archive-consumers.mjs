// AN ARCHIVED CUSTOMER LEAVES EVERY WORKING SURFACE (CS-663; S128 F2-01 / F6-06) — the readers.
//
// test-customer-archive.mjs holds the archive itself (the rule, the store, the server's guard, the
// screens). This suite holds what an archived customer must leave, through the REAL handlers over
// fake-supabase.mjs and the real pure walkers (no network, no live project):
//   H. the customer hub: its logins lose the building (view, read, write) — and the office:
//      the thread stays readable but takes no reply ("building archived"), and it leaves the
//      Waiting view (the manager Home's Customer messages count and the Messages pill read it);
//   R. Client Requests: its open requests stay readable on the customer page and in Quality, but
//      leave the queue and the manager Home's counts;
//   T. the ticket repeats and escalations stop for it;
//   K. the contracts book: a contract whose EVERY building is archived leaves the book value and
//      its renewal reminders ring nobody (skipped, never stamped, and read past so they never crowd
//      out a live one); a contract that still covers a live building stays.
//
// REGRESSION (THE LAW II.3): on the tree before this change every reader below ignores the archive:
// the hub still serves the building, the office can reply into it, it waits in the Waiting view,
// its requests count, its tickets repeat, and its contract counts in the book and rings.
//
//   node app/scripts/test-archive-consumers.mjs
import { readFileSync } from 'node:fs';

const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.APP_PUBLIC_URL = 'https://hub.example.test';
delete process.env.SYSTEM_SENDER_EMAIL;
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const { dayKey, addDaysKey } = await import('../src/lib/dates.js');
const { CONTRACT_STATUS, TERM_TYPE, REMINDER_KIND, REMINDER_STATUS, CONTRACT_REMINDER_MAX_PER_RUN } = await import('../src/lib/contracts.js');
const { getDueTicketAlerts } = await import('../src/lib/ticketAlerts.js');
const { clientRequestRows } = await import('../src/lib/clientRequests.js');
const { requestFigures } = await import('../src/lib/managerHome.js');
const hub = (await import('../api/hub/[...path].js')).default;
const office = (await import('../api/client-messages/[...path].js')).default;
const contractsRoute = (await import('../api/contracts/[...path].js')).default;
const { contractAlertsFor } = await import('../api/cron/ops-alerts.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). This suite is label-first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;

const H = 3600000;
const DAY = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const uuid = (p, n) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The book: Coral Bay is ARCHIVED, Harbor Tower is a customer we serve.
const ARCHIVED = { id: 'cl_a', name: 'Coral Bay HOA', customerNumber: '0004', supervisorId: 'u_mgr', statusOverride: 'archived', archivedAt: ago(DAY), archivedBy: 'u_owner', statusBeforeArchive: 'active' };
const LIVE = { id: 'cl_x', name: 'Harbor Tower', customerNumber: '0009', supervisorId: 'u_mgr' };
const user = (id, role, name) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {} });
const USERS = [user('u_owner', 'owner', 'Dana Owner'), user('u_admin', 'admin', 'Yolanda Reyes'), user('u_mgr', 'manager', 'Renata Cruz')];
const LOGINS = {
  'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: uuid('a', 1), org_id: ORG } },
  'tok-client4': { id: 'auth-c4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: uuid('a', 4), org_id: ORG } },
  'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
};

async function call(handler, { method = 'GET', path: p, token, body }) {
  const [sub, qs] = p.split('?');
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body ?? {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
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

// ── H. the customer hub and the office's messages ──────────────────────────────
{
  __resetRateLimit();
  const cmsg = (id, client, cu, name, body, at) => ({
    id, organization_id: ORG, client_id: client, author_role: 'client', author_client_user_id: cu, author_user_id: null, author_name: name, body, created_at: at,
  });
  const a1 = cmsg(uuid('f', 1), 'cl_a', uuid('a', 1), 'Pat Manager', 'Is the lobby glass on tonight\'s list?', ago(DAY));
  const x1 = cmsg(uuid('f', 2), 'cl_x', uuid('a', 4), 'Harbor Person', 'Can you do the garage this week?', ago(DAY));
  const thread = (m) => ({
    organization_id: ORG, client_id: m.client_id, last_message_id: m.id, last_message_at: m.created_at, last_author_role: 'client',
    last_author_name: m.author_name, last_author_user_id: null, last_author_client_user_id: m.author_client_user_id,
    last_snippet: m.body.slice(0, 200), last_client_message_at: m.created_at, last_staff_message_at: null, updated_at: m.created_at,
  });
  const cu = (n, name, email) => ({ id: uuid('a', n), organization_id: ORG, name, email, phone: null, status: 'active', auth_user_id: `auth-c${n}`, email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) });
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 58,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: USERS, clients: [ARCHIVED, LIVE], sites: [],
          permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
        },
      }],
      crew_assignments: [], jobs: [],
      client_users: [cu(1, 'Pat Manager', 'pat@coralbay.test'), cu(4, 'Harbor Person', 'h@harbor.test')],
      client_user_groups: [], client_user_group_members: [],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: uuid('a', 1), client_id: 'cl_a', group_id: null },
        { id: 'as5', organization_id: ORG, client_user_id: uuid('a', 4), client_id: 'cl_x', group_id: null },
      ],
      client_messages: [a1, x1],
      client_message_threads: [thread(a1), thread(x1)],
      client_message_reads: [], problem_reports: [], work_order_messages: [], inspection_records: [],
      activity_log: [], activity_log_baseline: [], inbox_accounts: [],
    },
    logins: LOGINS,
  });
  const view = await call(hub, { path: 'view', token: 'tok-client' });
  const ids = (view.body?.buildings || []).map((b) => b.id);
  ok('H1 🔴 the archived building\'s customer login no longer sees it in the hub', view.status === 200 && !ids.includes('cl_a'), show(view));
  const read = await call(hub, { path: 'messages?buildingId=cl_a', token: 'tok-client' });
  ok('H2 🔴 …nor reads its messages (a 404 that confirms nothing)', read.status === 404, show(read));
  const before = world.tables.client_messages.length;
  const wrote = await call(hub, { method: 'POST', path: 'message', token: 'tok-client', body: { id: uuid('f', 50), buildingId: 'cl_a', body: 'Hello?' } });
  ok('H3 🔴 …nor writes to it', wrote.status === 404 && world.tables.client_messages.length === before, show(wrote));
  const live = await call(hub, { path: 'messages?buildingId=cl_x', token: 'tok-client4' });
  ok('H4 a live building\'s login is untouched', live.status === 200 && (live.body?.messages || []).length === 1, show(live));

  // Before any reply below (a reply ends a wait): both customers wrote last.
  const waiting = await call(office, { path: 'threads?waiting=1', token: 'tok-owner' });
  const waitingIds = (waiting.body?.threads || []).map((t) => t.clientId);
  ok('H5 🔴 it leaves the Waiting view (the Home count and the Messages pill read it)', waiting.status === 200 && !waitingIds.includes('cl_a'), show(waiting));
  ok('H6 …while a live customer\'s waiting message is still there', waitingIds.includes('cl_x'), JSON.stringify(waitingIds));

  const send = await call(office, { method: 'POST', path: 'send', token: 'tok-owner', body: { id: uuid('f', 60), clientId: 'cl_a', body: 'We are on it.' } });
  ok('H7 🔴 the office cannot reply into an archived customer\'s thread (its logins cannot read it)', send.status === 409 && send.body?.code === 'building-archived' && world.tables.client_messages.length === before, show(send));
  ok('H7b …and is told why, in words', typeof send.body?.error === 'string' && /archived/i.test(send.body.error), show(send));
  const sendLive = await call(office, { method: 'POST', path: 'send', token: 'tok-owner', body: { id: uuid('f', 61), clientId: 'cl_x', body: 'Booked for Thursday.' } });
  ok('H8 a reply to a live customer still goes', sendLive.status === 200 && !!sendLive.body?.message, show(sendLive));
  const thr = await call(office, { path: 'thread?clientId=cl_a', token: 'tok-owner' });
  ok('H9 the archived customer\'s thread stays readable to the office (history)', thr.status === 200 && (thr.body?.messages || []).length === 1, show(thr));
  ok('H10 …and says the customer is archived (the composer reads it)', thr.body?.client?.archived === true, JSON.stringify(thr.body?.client));
  ok('H10b …and its header says it waits on nobody (no "Waiting 5h" on a thread nobody can answer)', thr.status === 200 && thr.body?.waitingSince === null, JSON.stringify({ waitingSince: thr.body?.waitingSince }));
  const all = await call(office, { path: 'threads', token: 'tok-owner' });
  ok('H11 the full thread list still lists it (readable history)', (all.body?.threads || []).some((t) => t.clientId === 'cl_a'), show(all));
}

// ── R. Client Requests: out of the queue and the Home counts, readable elsewhere ──────
{
  const now = Date.now();
  const problems = [
    { id: 'p_a', client_id: 'cl_a', status: 'open', priority: 'medium', type: 'complaint', title: 'Stained carpet', created_at: new Date(now - 3 * H).toISOString(), first_reply_at: null },
    { id: 'p_x', client_id: 'cl_x', status: 'open', priority: 'medium', type: 'complaint', title: 'Garage', created_at: new Date(now - 3 * H).toISOString(), first_reply_at: null },
  ];
  const figures = requestFigures({ problems }, { scope: { mgrId: '' }, clients: [ARCHIVED, LIVE], settings: {}, now });
  ok('R1 🔴 the manager Home\'s request count leaves an archived customer\'s request out', figures?.open === 1, JSON.stringify(figures));
  const rows = clientRequestRows(problems, { now, clientArchived: (id) => id === 'cl_a' });
  ok('R2 🔴 the Client Requests queue leaves it out', rows.length === 1 && rows[0].client_id === 'cl_x', JSON.stringify(rows.map((r) => r.client_id)));
  ok('R3 a caller that names no archive rule keeps every row (the Quality list reads them all)', clientRequestRows(problems, { now }).length === 2);
}

// ── T. the ticket repeats and escalations ────────────────────────────────────
{
  const now = Date.now();
  const tickets = [
    { id: 't_a', client_id: 'cl_a', status: 'open', priority: 'urgent', title: 'Flood in the lobby', created_at: new Date(now - 2 * H).toISOString() },
    { id: 't_x', client_id: 'cl_x', status: 'open', priority: 'urgent', title: 'Broken door', created_at: new Date(now - 2 * H).toISOString() },
  ];
  const alerts = getDueTicketAlerts({ tickets, repliedAt: new Map(), firedIds: new Set(), now, settings: {}, timeZone: 'America/New_York', clients: [ARCHIVED, LIVE] });
  ok('T1 🔴 an archived customer\'s open ticket stops repeating and escalating', alerts.length > 0 && alerts.every((a) => a.clientId !== 'cl_a'), JSON.stringify(alerts.map((a) => [a.kind, a.clientId])));
  ok('T2 a live customer\'s still does', alerts.some((a) => a.clientId === 'cl_x'));
}

// ── K. the contracts book and its reminders ──────────────────────────────────
{
  const NOW = Date.parse('2026-10-07T14:00:00.000Z'); // a Wednesday, 10:00 in New York: office hours
  const TZ = 'America/New_York';
  const TODAY = dayKey(NOW, TZ);
  const K1 = uuid('c', 1); // Coral Bay only (archived)
  const K2 = uuid('c', 2); // Harbor Tower only (live)
  const K3 = uuid('c', 3); // a master agreement over both
  const contract = (id, name, cents) => ({
    id, organization_id: ORG, name, status: CONTRACT_STATUS.active, is_master: id === K3, start_date: '2026-01-01', end_date: '2027-12-31',
    term_type: TERM_TYPE.fixed, term_months: 24, renewal_term_months: null, cancellation_notice_days: null, service_frequency: null,
    square_footage: null, special_terms: null, base_monthly_cents: cents, document_path: null, notes: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', created_by_user_id: 'u_owner',
  });
  const building = (n, contractId, clientId) => ({ id: uuid('d', n), organization_id: ORG, contract_id: contractId, client_id: clientId });
  const reminder = (n, contractId, dueOn = TODAY) => ({
    id: uuid('e', n), organization_id: ORG, contract_id: contractId, kind: REMINDER_KIND.renewal, target_date: addDaysKey(TODAY, 60),
    due_on: dueOn, next_due_on: dueOn, status: REMINDER_STATUS.pending, note: null, notified_at: null, done_at: null, done_by_user_id: null,
  });
  // More due reminders on the archived contract than one bounded read holds (CONTRACT_REMINDER_
  // MAX_PER_RUN), all due a day before the live one, so they sort in front of it.
  const silenced = Array.from({ length: CONTRACT_REMINDER_MAX_PER_RUN + 1 }, (_, i) => reminder(100 + i, K1, addDaysKey(TODAY, -1)));
  const state = {
    version: 58, company: { id: 'co', name: 'Clean Space', timezone: TZ }, users: USERS, clients: [ARCHIVED, LIVE],
    permissions: seedPermissions(), userPermissionOverrides: [], notifications: [], opsAlertEvents: [], opsSettings: {},
    invoices: [], pipelines: [], opportunities: [],
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 4 }],
      contracts: [contract(K1, 'Coral Bay agreement', 100000), contract(K2, 'Harbor agreement', 50000), contract(K3, 'City master agreement', 20000)],
      contract_buildings: [building(1, K1, 'cl_a'), building(2, K2, 'cl_x'), building(3, K3, 'cl_a'), building(4, K3, 'cl_x')],
      contract_years: [], contract_lines: [],
      contract_reminders: [...silenced, reminder(2, K2)],
      activity_log: [], activity_log_baseline: [],
    },
    logins: LOGINS,
  });
  const list = await call(contractsRoute, { path: 'list', token: 'tok-owner' });
  const byId = new Map((list.body?.contracts || []).map((c) => [c.id, c]));
  const annual = (id) => byId.get(id)?.annualValueCents;
  ok('K0 the list answers', list.status === 200 && byId.size === 3, show(list));
  ok('K1 🔴 a contract whose every building is archived leaves the book value', list.body?.bookValueCents === annual(K2) + annual(K3), `${list.body?.bookValueCents} vs ${annual(K2)} + ${annual(K3)}`);
  ok('K2 …and says so, so the list can mark it', byId.get(K1)?.buildingsArchived === true && byId.get(K2)?.buildingsArchived === false, JSON.stringify([...byId.values()].map((c) => [c.name, c.buildingsArchived])));
  ok('K3 a master agreement that still covers a live building stays in the book', byId.get(K3)?.buildingsArchived === false);

  const alerts = await contractAlertsFor(state, NOW, new Set());
  ok('K4 🔴 its reminders ring nobody', !alerts.some((a) => a.contractId === K1), JSON.stringify(alerts.map((a) => a.contractId)));
  ok('K5 🔴 a live contract\'s reminder behind more of them than one read holds still rings', alerts.some((a) => a.contractId === K2), JSON.stringify(alerts.map((a) => a.contractId)));
  ok('K6 reading them writes nothing (the run stamps only what rang, after its bell; a dry run stays dry)',
    world.tables.contract_reminders.every((r) => !r.notified_at));
}

// ── S. the screens and the demo (read mechanically; the drive is the screenshots) ──────
{
  const flat = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('S1 Client Requests passes the archive rule to its queue', /clientArchived/.test(flat('../src/pages/ClientRequests.jsx')));
  const CT = flat('../src/components/CustomerThread.jsx');
  ok('S2 the office thread says the customer is archived instead of offering a reply', /client\?\.archived/.test(CT) && /custArchive\.threadNotice/.test(CT));
  const CO = flat('../src/pages/Contracts.jsx');
  ok('S3 the Contracts list marks a contract whose buildings are all archived, and leaves it out of the active count', /buildingsArchived/.test(CO));
  ok('S3b …and shows its next reminder without a Due mark (it rings nobody)', /reminderIsDue\(next, today\) && !c\.buildingsArchived && <> <Badge variant="amber">Due<\/Badge>/.test(CO));
  const DM = flat('../src/lib/clientMessagesDemo.js');
  ok('S4 the demo\'s messages mirror the server (no reply, out of Waiting)', /isArchivedCustomer/.test(DM) && /building-archived/.test(DM));
  ok('S5 the demo\'s contracts mirror the server\'s book', /buildingsArchived/.test(flat('../src/lib/contractsApi.js')));
}

console.log(`\n${pass}/${pass + fails.length} archive-consumer checks passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exitCode = fails.length ? 1 : 0;
