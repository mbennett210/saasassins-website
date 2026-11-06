// Client Requests on the cleaner's phone (Matt's Cleaner Hub, "Client Requests" / "Request
// Details"; plan docs/plans/2026-10-13-cleaner-hub.md §3 D3, brief C §1–§2).
//
// Held through the REAL `api/qc/[...path].js` handler over the loopback Supabase fake (never
// production), and the demo stub (lib/qcApi) for the same rows:
//   M  GET problems/mine (EP-380): a cleaner reads ONLY the open tickets naming them, plus the ones
//      resolved in the last week; never another organization's; built field by field (no internal
//      columns), the deadline the one rule's (computeDueAt), "From {First L.}" the ticket's office
//      assignee else the building's supervisor; complete past PostgREST's 1,000-row cap; a crew
//      `userId` is ignored, an office login previews another person only while holding
//      problems.manage (403 without it).
//   R  problems/update `crewUserIds`: OFFICE ONLY (a crew caller → 403, a role floor: crew hold
//      problems.manage); each one an ACTIVE (or invited) cleaner on the roster, de-duplicated,
//      at most MAX_REQUEST_CREW, else 400; stored on the ticket; only the newly ADDED are rung
//      (`crewRequestAssigned`, in their language, opening crewPaths.request(id)).
//   C  a cleaner's Mark Complete: no photo → 409 photo-required (WO-10, the server is the
//      boundary); with one → resolved, and the account manager hears it (`crewRequestCompleted`):
//      the ticket's office assignee, else the building's supervisor, else the office bench —
//      once; the office resolving rings nobody this way; the cleaner's note is an office-only
//      (internal) line on the ticket.
//   N  the two events are in the notification catalog (the cleaner's visible to crew, the account
//      manager's to the office only) and in the bell list's icon table.
//   S  the demo stub answers the same lists by the same rule, and routes by the same rule.
//
// REGRESSION (THE LAW II.3): on the tree before this build there is no `problems/mine`, update
// ignores `crewUserIds`, and the events do not exist, so every §M, §R, §C (but C1), §N and §S
// check fails (counts in the build report).
//
//   node app/scripts/test-crew-requests.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { installResolveShim } from './deletion-core.mjs';

// A fixed clock: Tuesday Oct 13 2026, 3 PM Eastern.
const NOW = '2026-10-13T19:00:00.000Z';
{
  const RealDate = Date;
  const at = { now: RealDate.parse(NOW) };
  globalThis.__clock = at;
  globalThis.Date = class FixedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(at.now); else super(...a); }
    static now() { return at.now; }
  };
}

const ORG = '00000000-0000-0000-0000-000000000031';
const OTHER_ORG = '00000000-0000-0000-0000-000000000098';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
installResolveShim(); // the stub (lib/qcApi) is written for Vite's extensionless imports

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const wo = await import('../src/lib/workOrders.js');
const cr = await tryImport('../src/lib/crewRequests.js');
const { crewPaths } = await import('../src/lib/crewPaths.js');
const notif = await import('../src/lib/notifications.js');
const meta = await import('../src/lib/notificationMeta.js');
const core = await import('../src/i18n/core.js');
const store = await import('../api/_lib/qc/store.js');
const qc = (await import('../api/qc/[...path].js')).default;
const media = (await import('../api/account-media/[...path].js')).default;
const ticketDeepLink = store.ticketDeepLink || ((id) => `/inspections?tab=workorders&wo=${encodeURIComponent(id)}`);
const MAX = Number.isFinite(cr.MAX_REQUEST_CREW) ? cr.MAX_REQUEST_CREW : 20;
const CODES = cr.CREW_ROUTING_CODES || { officeOnly: 'crew-office-only', malformed: 'crew-malformed', notCrew: 'crew-not-crew', tooMany: 'crew-too-many' };
const ASSIGNED = 'crewRequestAssigned';
const COMPLETED = 'crewRequestCompleted';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sorted = (a) => [...(a || [])].sort();

// ── the fixture ──────────────────────────────────────────────────────────────
const HOUR = 3600e3;
const ago = (h) => new Date(Date.parse(NOW) - h * HOUR).toISOString();
const user = (id, role, name, status = 'active') => ({ id, role, status, name, email: `${id}@example.test` });
const EXTRA_CREW = Array.from({ length: MAX + 1 }, (_, i) => user(`u_x${i}`, 'crew', `Extra ${i}`));
const USERS = [
  user('u_owner', 'owner', 'Olivia Owner'), user('u_adm', 'admin', 'Ada Admin'),
  user('u_sup', 'manager', 'Dana Kim'), user('u_mgr', 'manager', 'Mo Manager'), user('u_mgr2', 'manager', 'Pared Back'),
  user('u_c1', 'crew', 'Carla One'), user('u_c2', 'crew', 'Cody Two'),
  user('u_c3', 'crew', 'Gone Three', 'inactive'), user('u_inv', 'crew', 'Ivy Invited', 'invited'),
  ...EXTRA_CREW,
];
const CLIENTS = [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_sup' }, { id: 'c2', name: 'Bayshore Living', supervisorId: null }];
const SITES = [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }, { id: 's2', clientId: 'c2', name: 'Main' }];
const JOB = (id, siteId, clientId, crewIds) => ({
  id, organization_id: ORG, site_id: siteId, status: 'scheduled', start_at: ago(24),
  data: { id, siteId, clientId, startAt: ago(24), crewIds, status: 'upcoming' },
});
const T = (id, o = {}) => ({
  id, organization_id: ORG, client_id: 'c1', site_id: 's1', job_id: null, client_name: 'Coral Bay HOA', site_name: 'Clubhouse',
  reported_by_user_id: null, assignee_user_id: null, title: `Ticket ${id}`, description: `Details of ${id}`,
  type: 'request', origin: 'portal', category: null, priority: 'medium', status: 'open', created_at: ago(2), due_at: null,
  escalated_at: null, resolved_at: null, crew_user_ids: [], inspection_id: null, raised_by_client_user_id: 'cu_secret', ...o,
});
const TICKETS = [
  T('p1', { crew_user_ids: ['u_c1'], assignee_user_id: 'u_sup' }),
  T('p2', { client_id: 'c2', site_id: 's2', client_name: 'Bayshore Living', site_name: 'Main', crew_user_ids: ['u_c2'] }),
  T('p3', { crew_user_ids: ['u_c1'], status: 'resolved', resolved_at: ago(48) }),
  T('p4', { crew_user_ids: ['u_c1'], status: 'resolved', resolved_at: ago(240) }),
  T('p5', { organization_id: OTHER_ORG, crew_user_ids: ['u_c1'] }),
  T('p6', { crew_user_ids: [] }),
  T('p7', { crew_user_ids: ['u_c1', 'u_c2'], type: 'complaint', created_at: ago(5) }),
  T('p8', { crew_user_ids: ['u_c1'], type: 'complaint', created_at: ago(5), status: 'awaiting_client' }),
  T('p9', { crew_user_ids: ['u_c1'], assignee_user_id: 'u_c2' }),
];
const logins = Object.fromEntries(USERS.filter((u) => !u.id.startsWith('u_x')).map((u) => [`tok-${u.id}`, {
  id: `auth-${u.id}`, email: u.email,
  // Managers are claim-less, as live; everyone else carries the claim.
  app_metadata: u.role === 'manager' ? {} : { role: u.role, org_user_id: u.id, org_id: ORG },
}]));

function seed({ tickets = TICKETS, media = [], overrides = [{ userId: 'u_mgr2', grants: [], revokes: ['problems.manage'] }] } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 7,
        state: {
          version: 58, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: USERS, clients: CLIENTS, sites: SITES, permissions: seedPermissions(),
          userPermissionOverrides: overrides, notifications: [],
        },
      }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      jobs: [JOB('j1', 's1', 'c1', ['u_c1']), JOB('j2', 's2', 'c2', ['u_c2'])],
      problem_reports: structuredClone(tickets),
      work_order_messages: [],
      account_media: structuredClone(media),
      activity_log: [],
      client_users: [],
    },
    logins,
  });
}

async function call(method, subpath, { token = 'tok-u_mgr', body = null, query = {}, handler = qc } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath, ...query };
  req.body = body || {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const mine = (who, query = {}) => call('GET', 'problems/mine', { token: who ? `tok-${who}` : null, query });
const update = (who, body) => call('POST', 'problems/update', { token: `tok-${who}`, body });
const ticket = (id) => (world.tables.problem_reports || []).find((p) => p.id === id) || {};
const bells = (eventKey) => (world.tables.org_state[0].state.notifications || []).filter((n) => !eventKey || n.eventKey === eventKey);
const ids = (list) => (list || []).map((r) => r.id);
const photo = (refId) => ({ id: `m_${refId}`, organization_id: ORG, scope: 'problem_report', ref_id: refId, site_id: 's1', client_id: 'c1', kind: 'image', storage_path: `s1/${refId}.jpg` });
const show = (r) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 180)}`;

// ── M. the cleaner's read ────────────────────────────────────────────────────
{
  seed();
  const r = await mine('u_c1');
  eq('M1 a cleaner reads their open requests (only the tickets naming them)', [r.status, sorted(ids(r.body?.open))], [200, ['p1', 'p7', 'p8', 'p9']]);
  eq('M2 …and the ones resolved in the last week (not ten days ago)', ids(r.body?.recentDone), ['p3']);
  ok('M3 another organization\'s ticket naming them never comes back', !JSON.stringify(r.body || {}).includes('"p5"'));
  const first = (r.body?.open || []).find((x) => x.id === 'p1') || {};
  eq('M4 a request is built field by field (no internal columns travel)', Object.keys(first).sort(),
    ['clientId', 'clientName', 'createdAt', 'description', 'dueAt', 'id', 'managerId', 'managerName', 'resolvedAt', 'siteId', 'siteName', 'status', 'title', 'type']);
  ok('M5 …nothing of the customer contact, the crew list or the reporter', !/cu_secret|crew_user_ids|reported_by|raised_by/.test(JSON.stringify(r.body || {})));
  eq('M6 its deadline is the one rule\'s (lib/workOrders computeDueAt), not the stored cache', first.dueAt, wo.computeDueAt(T('p1').created_at, { type: 'request', priority: 'medium' }));
  eq('M7 "From" is the ticket\'s office assignee, as "First L."', [first.managerId, first.managerName], ['u_sup', 'Dana K.']);
  const p9 = (r.body?.open || []).find((x) => x.id === 'p9') || {};
  eq('M8 a ticket assigned to a cleaner is "From" the building\'s supervisor', [p9.managerId, p9.managerName], ['u_sup', 'Dana K.']);
  ok('M9 open requests come nearest deadline first (the 2-hour complaints before the 24-hour requests)',
    sorted(ids(r.body?.open).slice(0, 2)).join() === 'p7,p8', JSON.stringify(ids(r.body?.open)));
  const viaOther = await mine('u_c1', { userId: 'u_c2' });
  eq('M10 a CREW login naming someone else still reads themselves', sorted(ids(viaOther.body?.open)), ['p1', 'p7', 'p8', 'p9']);
  const office = await mine('u_mgr', { userId: 'u_c2' });
  eq('M11 an office login holding problems.manage previews that cleaner (View-as)', [office.status, sorted(ids(office.body?.open))], [200, ['p2', 'p7']]);
  const p2 = (office.body?.open || []).find((x) => x.id === 'p2') || {};
  eq('M12 a building with no supervisor and no office assignee: no "From"', [p2.managerId, p2.managerName], [null, '']);
  const pared = await mine('u_mgr2', { userId: 'u_c2' });
  eq('M13 an office login WITHOUT problems.manage naming someone → 403', pared.status, 403);
  eq('M14 malformed userId → 400', (await mine('u_mgr', { userId: 'u_c2),or(x' })).status, 400);
  eq('M15 no session → 401', (await mine(null)).status, 401);
  const reads = world.log.filter((q) => q.table === 'problem_reports' && q.op === 'select');
  ok('M16 every read is pinned to the organization', reads.length > 0 && reads.every((q) => q.eq?.organization_id === ORG), JSON.stringify(reads.slice(0, 2)));
}
{
  // COMPLETE: 1,050 open tickets naming the cleaner, past a 1,000-row cap, all come back.
  const many = Array.from({ length: 1050 }, (_, i) => T(`q${String(i).padStart(4, '0')}`, { crew_user_ids: ['u_c1'], created_at: ago(1 + i / 1000) }));
  seed({ tickets: many });
  world.maxRows = 1000;
  const r = await mine('u_c1');
  eq('M17 every open request comes back, past the 1,000-row cap (never the newest N)', [r.status, (r.body?.open || []).length], [200, 1050]);
}
{
  eq('M18 overdue: past its deadline; a paused (awaiting the client) one is not',
    [cr.crewRequestOverdue?.({ status: 'open', dueAt: ago(1) }), cr.crewRequestOverdue?.({ status: 'awaiting_client', dueAt: ago(1) }), cr.crewRequestOverdue?.({ status: 'open', dueAt: ago(-1) })],
    [true, false, false]);
  eq('M19 "First L." names', [cr.shortName?.('Dana Kim'), cr.shortName?.('Prince'), cr.shortName?.('  mary  ann  lee ')], ['Dana K.', 'Prince', 'mary L.']);
}

// ── R. the office routes a ticket to cleaners ────────────────────────────────
{
  seed();
  const r = await update('u_mgr', { id: 'p6', crewUserIds: ['u_c1', 'u_c2', 'u_c1'] });
  eq('R1 the office puts cleaners on a ticket (200), de-duplicated', [r.status, ticket('p6').crew_user_ids], [200, ['u_c1', 'u_c2']]);
  const b = bells(ASSIGNED);
  eq('R2 each newly added cleaner is rung once', sorted(b.map((n) => n.userId)), ['u_c1', 'u_c2']);
  ok('R3 …opening their request on the phone (crewPaths.request)', b.length === 2 && b.every((n) => n.url === crewPaths.request('p6')), JSON.stringify(b.map((n) => n.url)));
  ok('R4 …"New request at {customer}: {title}" in their language',
    b.length > 0 && b.every((n) => n.title === core.english('alerts.crewRequest.assigned', { customer: 'Coral Bay HOA', title: 'Ticket p6' })), JSON.stringify(b.map((n) => n.title)));
  await update('u_mgr', { id: 'p6', crewUserIds: ['u_c1', 'u_c2'] });
  eq('R5 saving the same list rings nobody again', bells(ASSIGNED).length, 2);
  await update('u_mgr', { id: 'p6', crewUserIds: ['u_c1'] });
  eq('R6 removing a cleaner rings nobody', [ticket('p6').crew_user_ids, bells(ASSIGNED).length], [['u_c1'], 2]);
  await update('u_mgr', { id: 'p6', crewUserIds: ['u_c1', 'u_c2'] });
  eq('R7 adding them back rings only them', [bells(ASSIGNED).length, bells(ASSIGNED).filter((n) => n.userId === 'u_c2').length], [3, 2]);
  const crew = await update('u_c1', { id: 'p1', crewUserIds: ['u_c1', 'u_c2'] });
  eq('R8 a CREW caller cannot choose the cleaners (403, a role floor)', [crew.status, crew.body?.code, ticket('p1').crew_user_ids], [403, CODES.officeOnly, ['u_c1']]);
  const gone = await update('u_mgr', { id: 'p6', crewUserIds: ['u_c3'] });
  eq('R9 someone who has left (inactive) → 400', [gone.status, gone.body?.code], [400, CODES.notCrew]);
  const office = await update('u_mgr', { id: 'p6', crewUserIds: ['u_sup'] });
  eq('R10 an office member is not a cleaner → 400', [office.status, office.body?.code], [400, CODES.notCrew]);
  const unknown = await update('u_mgr', { id: 'p6', crewUserIds: ['u_nobody'] });
  eq('R11 someone not on the roster → 400', unknown.status, 400);
  const invited = await update('u_mgr', { id: 'p6', crewUserIds: ['u_inv'] });
  eq('R12 an invited cleaner may be put on a ticket', [invited.status, ticket('p6').crew_user_ids], [200, ['u_inv']]);
  const notList = await update('u_mgr', { id: 'p6', crewUserIds: 'u_c1' });
  eq('R13 not a list → 400', [notList.status, notList.body?.code], [400, CODES.malformed]);
  const tooMany = await update('u_mgr', { id: 'p6', crewUserIds: EXTRA_CREW.map((u) => u.id) });
  eq(`R14 more than ${MAX} → 400`, [tooMany.status, tooMany.body?.code], [400, CODES.tooMany]);
  ok('R15 a refused list wrote nothing', JSON.stringify(ticket('p6').crew_user_ids) === JSON.stringify(['u_inv']));
  const otherOrg = await update('u_mgr', { id: 'p5', crewUserIds: ['u_c1'] });
  eq('R16 another organization\'s ticket is a 404', otherOrg.status, 404);
  const pared = await update('u_mgr2', { id: 'p6', crewUserIds: ['u_c1'] });
  eq('R17 an office login without problems.manage is refused at the door (403)', pared.status, 403);
  const status = ticket('p6').status;
  eq('R18 choosing cleaners changes nothing else on the ticket', status, 'open');
}

// ── C. the cleaner completes a request ───────────────────────────────────────
{
  seed();
  const r = await update('u_c1', { id: 'p1', status: 'resolved' });
  eq('C1 no completion photo → 409 photo-required, still open', [r.status, r.body?.code, ticket('p1').status], [409, wo.RESOLVE_PHOTO_CODE, 'open']);
  eq('C2 …and nobody is told', bells(COMPLETED).length, 0);
}
{
  seed({ media: [photo('p1'), photo('p9'), photo('p2'), photo('p6')] });
  const r = await update('u_c1', { id: 'p1', status: 'resolved' });
  eq('C3 with a photo → resolved', [r.status, ticket('p1').status], [200, 'resolved']);
  const b = bells(COMPLETED);
  eq('C4 the account manager (the ticket\'s office assignee) is told, once', b.map((n) => n.userId), ['u_sup']);
  ok('C5 …"{cleaner} completed {title} at {customer}", opening the ticket\'s drawer',
    b[0]?.title === core.english('alerts.crewRequest.completed', { cleaner: 'Carla One', title: 'Ticket p1', customer: 'Coral Bay HOA' }) && b[0]?.url === ticketDeepLink('p1'),
    JSON.stringify(b[0]));
  await update('u_c1', { id: 'p1', status: 'resolved' });
  eq('C6 a retried Mark Complete rings nobody again', bells(COMPLETED).length, 1);
  await update('u_c1', { id: 'p9', status: 'resolved' });
  eq('C7 a ticket assigned to a cleaner: the building\'s supervisor is told', bells(COMPLETED).filter((n) => n.url === ticketDeepLink('p9')).map((n) => n.userId), ['u_sup']);
  await update('u_c2', { id: 'p2', status: 'resolved' });
  const bench = bells(COMPLETED).filter((n) => n.url === ticketDeepLink('p2')).map((n) => n.userId);
  // p2 is a customer's request (origin portal), so with no supervisor it follows HUB-21 (Matt, (a)):
  // the Admins, the people its first alert rang, never the whole bench and never a cleaner.
  ok('C8 no assignee and no supervisor: the Admins are told (HUB-21), never a cleaner',
    bench.join() === 'u_adm', JSON.stringify(bench));
  const before = bells(COMPLETED).length;
  await update('u_mgr', { id: 'p6', status: 'resolved' });
  eq('C9 the office resolving a ticket rings nobody this way', bells(COMPLETED).length, before);
  const note = await call('POST', 'problems/message', { token: 'tok-u_c1', body: { problemId: 'p7', body: 'Done, refilled both.', internal: true } });
  const msg = (world.tables.work_order_messages || []).find((m) => m.problem_id === 'p7') || {};
  eq('C10 the cleaner\'s note is an office-only line on the ticket', [note.status, msg.internal, msg.author_role, msg.author_user_id], [200, true, 'crew', 'u_c1']);
  const notMine = await update('u_c1', { id: 'p2', status: 'open' });
  eq('C11 a cleaner cannot change a ticket at a building that is not theirs', notMine.status, 403);
}

// ── N. the catalog ───────────────────────────────────────────────────────────
{
  const crew = { id: 'u_c1', role: 'crew' };
  const mgr = { id: 'u_sup', role: 'manager' };
  const v = (k, u) => notif.isNotificationVisibleForUser(k, u, seedPermissions(), []);
  eq('N1 the cleaner\'s event reaches crew (and its toggle shows for them)', v(ASSIGNED, crew), true);
  eq('N2 the account manager\'s event is the office\'s only', [v(COMPLETED, mgr), v(COMPLETED, crew)], [true, false]);
  ok('N3 both are in the bell list\'s icon table', !!meta.EVENT_META[ASSIGNED] && !!meta.EVENT_META[COMPLETED]);
  ok('N4 both are opt-out like every other alert', notif.isNotificationEnabled({}, ASSIGNED) && notif.isNotificationEnabled({}, COMPLETED));
}

// ── S. the demo stub ─────────────────────────────────────────────────────────
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
  globalThis.window = { __ppGetState: () => ({ company: { timezone: 'America/New_York' }, users: USERS, clients: CLIENTS, sites: SITES, jobs: [], currentUserId: 'u_mgr' }) };
  const { QC_PROBLEMS_STUB_KEY } = await import('../src/data/stubKeys.js');
  mem.set(QC_PROBLEMS_STUB_KEY, JSON.stringify({ problems: TICKETS.filter((t) => t.organization_id === ORG).map((t) => ({ ...t, messages: [] })) }));
  let qcApi = {};
  try { qcApi = await import('../src/lib/qcApi.js'); } catch (e) { fails.push(`the stub loads (${e.message})`); }
  const run = async (name, ...args) => { try { return typeof qcApi[name] === 'function' ? await qcApi[name](...args) : { __error: new Error(`${name} missing`) }; } catch (e) { return { __error: e }; } };
  const s = await run('listMyRequests', { userId: 'u_c1' });
  eq('S1 the stub lists the same open requests by the same rule', sorted(ids(s?.open)), ['p1', 'p7', 'p8', 'p9']);
  eq('S2 …and the same recently done', ids(s?.recentDone), ['p3']);
  const via = typeof cr.crewRequestViews === 'function' ? cr.crewRequestViews(TICKETS.filter((t) => t.organization_id === ORG), { userId: 'u_c1', users: USERS, clients: CLIENTS, now: Date.parse(NOW) }) : {};
  eq('S3 …exactly what the shared rule answers', JSON.stringify(s?.open), JSON.stringify(via.open));
  const routed = await run('updateProblem', { id: 'p6', crewUserIds: ['u_c2', 'u_c2'] });
  eq('S4 the stub routes by the same rule (de-duplicated)', routed?.crew_user_ids, ['u_c2']);
  const bad = await run('updateProblem', { id: 'p6', crewUserIds: ['u_c3'] });
  eq('S5 …and refuses who the server refuses (400, the same code)', [bad?.__error?.status, bad?.__error?.code], [400, CODES.notCrew]);
}

// ── X. a cleaner NAMED on a ticket outside their buildings can still complete it ──
// Daniel's D3 ("Cleaner closes it"), the follow-up to Builder C's open item: the office may put
// any active cleaner on a ticket, so one named on a ticket at a building they do not clean must
// be able to file THAT ticket's completion photo and resolve it — keyed on the ticket's STORED
// crew_user_ids, never on anything the client sends. Nothing else widens: no other ticket at that
// building, no other media scope, and an un-named cleaner outside scope is refused as before.
// Carla (u_c1) cleans only s1 (Coral Bay); s2 (Bayshore) is Cody's.
{
  const TN = '7f1c2a90-0000-4000-8000-0000000000a1';   // at s2, names u_c1
  const TO = '7f1c2a90-0000-4000-8000-0000000000a2';   // at s2, names only u_c2
  const at2 = { client_id: 'c2', site_id: 's2', client_name: 'Bayshore Living', site_name: 'Main' };
  seed({ tickets: [...TICKETS, T(TN, { ...at2, crew_user_ids: ['u_c1'] }), T(TO, { ...at2, crew_user_ids: ['u_c2'] })] });
  const asC1 = (subpath, body, method = 'POST') => call(method, subpath, { token: 'tok-u_c1', handler: media, ...(method === 'GET' ? { query: body } : { body }) });
  const mint = (refId, extra = {}) => asC1('upload-url', { siteId: 's2', mimeType: 'image/jpeg', sizeBytes: 1200, scope: 'problem_report', refId, ...extra });

  // the named ticket: photo, list, note, resolve
  const u = await mint(TN);
  ok('X1 a named cleaner outside their buildings gets an upload link for THAT ticket\'s photo', u.status === 200 && typeof u.body?.path === 'string', show(u));
  const c = await asC1('confirm', { siteId: 's2', clientId: 'c2', scope: 'problem_report', refId: TN, kind: 'image', mimeType: 'image/jpeg', storagePath: u.body?.path, sizeBytes: 1200 });
  const row = (world.tables.account_media || []).find((m) => m.ref_id === TN) || {};
  ok('X2 …and files it on the ticket, under the ticket\'s own building', (c.status === 200 || c.status === 201) && row.scope === 'problem_report' && row.site_id === 's2' && row.uploaded_by_user_id === 'u_c1', `${show(c)} ${JSON.stringify(row)}`);
  const l = await asC1('list', { siteId: 's2', scope: 'problem_report', refId: TN }, 'GET');
  eq('X3 …and sees that ticket\'s photos (what Mark Complete counts)', [l.status, (l.body?.media || []).length], [200, 1]);
  const n = await call('POST', 'problems/message', { token: 'tok-u_c1', body: { problemId: TN, body: 'Done, the lobby is clean.', internal: true } });
  eq('X4 …and leaves the account manager an office-only note on it', [n.status, n.body?.message?.internal], [200, true]);
  const r = await update('u_c1', { id: TN, status: 'resolved' });
  eq('X5 …and resolves it (Mark Complete)', [r.status, ticket(TN).status], [200, 'resolved']);
  ok('X6 …and the account manager is told (Bayshore has none: the office bench)', bells(COMPLETED).some((b) => b.url === ticketDeepLink(TN)), JSON.stringify(bells(COMPLETED).map((b) => b.url)));
}
{
  const TN = '7f1c2a90-0000-4000-8000-0000000000a1';
  const TO = '7f1c2a90-0000-4000-8000-0000000000a2';
  const at2 = { client_id: 'c2', site_id: 's2', client_name: 'Bayshore Living', site_name: 'Main' };
  seed({ tickets: [...TICKETS, T(TN, { ...at2, crew_user_ids: ['u_c1'] }), T(TO, { ...at2, crew_user_ids: ['u_c2'] })], media: [{ ...photo(TO), site_id: 's2', client_id: 'c2' }] });
  const asC1 = (subpath, body, method = 'POST') => call(method, subpath, { token: 'tok-u_c1', handler: media, ...(method === 'GET' ? { query: body } : { body }) });
  // a DIFFERENT ticket at that building (she is not named on it): refused everywhere, as before
  const u = await asC1('upload-url', { siteId: 's2', mimeType: 'image/jpeg', sizeBytes: 1200, scope: 'problem_report', refId: TO });
  eq('X7 a ticket she is NOT named on at that building: no upload link (403)', u.status, 403);
  const c = await asC1('confirm', { siteId: 's2', clientId: 'c2', scope: 'problem_report', refId: TO, kind: 'image', mimeType: 'image/jpeg', storagePath: `${ORG}/s2/abcdefabcdefabcd.jpg`, sizeBytes: 1200 });
  eq('X8 …no photo filed on it (403)', c.status, 403);
  const l = await asC1('list', { siteId: 's2', scope: 'problem_report', refId: TO }, 'GET');
  eq('X9 …no reading its photos (403)', l.status, 403);
  const r = await update('u_c1', { id: TO, status: 'resolved' });
  eq('X10 …and no resolving it (403, still open)', [r.status, ticket(TO).status], [403, 'open']);
  const m = await call('POST', 'problems/message', { token: 'tok-u_c1', body: { problemId: TO, body: 'x', internal: true } });
  eq('X11 …nor a note on it (403)', m.status, 403);
  // her own ticket opens nothing else at that building
  const site = await asC1('upload-url', { siteId: 's2', mimeType: 'image/jpeg', sizeBytes: 1200 });
  eq('X12 no upload at that building without the ticket (a site photo, 403)', site.status, 403);
  const other = await asC1('upload-url', { siteId: 's2', mimeType: 'image/jpeg', sizeBytes: 1200, scope: 'inspection', refId: TN });
  eq('X13 no other media scope through the ticket\'s id (403)', other.status, 403);
  const siteList = await asC1('list', { siteId: 's2', scope: 'cleaning_instruction' }, 'GET');
  eq('X14 no other read at that building (its instructions\' photos, 403)', siteList.status, 403);
  const elsewhere = await asC1('upload-url', { siteId: 's3', mimeType: 'image/jpeg', sizeBytes: 1200, scope: 'problem_report', refId: TN });
  eq('X15 the ticket\'s link is minted only under the ticket\'s own building (403 elsewhere)', elsewhere.status, 403);
  const reply = await call('POST', 'problems/message', { token: 'tok-u_c1', body: { problemId: TN, body: 'Hi', internal: false } });
  eq('X16 on her named ticket a reply to the CUSTOMER is not hers to send (403; only the office-only note)', reply.status, 403);
  const prio = await update('u_c1', { id: TN, priority: 'urgent' });
  eq('X17 …nor any other change to it (a priority, 403)', [prio.status, ticket(TN).priority], [403, 'medium']);
  const both = await update('u_c1', { id: TN, status: 'resolved', title: 'Changed' });
  eq('X18 …nor a resolve that carries another change (403)', [both.status, ticket(TN).title, ticket(TN).status], [403, `Ticket ${TN}`, 'open']);
  const reopen = await update('u_c1', { id: TN, status: 'open' });
  eq('X19 …nor any status but resolved (403)', reopen.status, 403);
  // someone else, named on nothing there, is refused exactly as today
  const x2 = await call('POST', 'upload-url', { token: 'tok-u_c2', handler: media, body: { siteId: 's1', mimeType: 'image/jpeg', sizeBytes: 1200, scope: 'problem_report', refId: TN } });
  eq('X20 an un-named cleaner outside scope: no upload link (403)', x2.status, 403);
  const r2 = await update('u_c2', { id: '7f1c2a90-0000-4000-8000-0000000000a9', status: 'resolved' });
  eq('X21 …(an unknown ticket is a 404, as before)', r2.status, 404);
}
{
  // The client sends the ticket with the upload-link request, so a named cleaner's photo can be
  // minted (lib/accountMediaApi — the live upload and the offline replay share doUpload).
  const src = (await import('node:fs')).readFileSync(new URL('../src/lib/accountMediaApi.js', import.meta.url), 'utf8');
  ok('X22 the upload-link request carries the scope and the ticket id',
    /'\/account-media\/upload-url',\s*\{\s*method: 'POST',\s*body: \{[^}]*\bscope\b[^}]*\brefId\b[^}]*\}/.test(src));
}

console.log(`\ntest-crew-requests: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
