// CS-640 — every OPEN work order is read, counted and listed, however many tickets the table holds.
//
// THE BUG (verified 2026-10-09, S127). `api/_lib/qc/store.js` `listProblems` read the newest 500
// work orders of EVERY status (`.order(created_at desc).limit(500)`), and PostgREST caps any one
// response at 1,000 rows besides. Nothing deletes a ticket, so past 500 tickets in total the
// oldest OPEN ones fell off the Work Orders tab, Client Requests, Home's tile and the nav pill,
// and off the Dashboard's open-complaints count — with nothing on screen to say the read was cut.
//
// THE FIX. Three views of `GET /api/qc/problems/list`, each honest about what it holds:
//   default        EVERY open ticket — a complete read (count-first, paged, selectAll);
//   ?resolved=1    ONE page of the resolved history, newest resolved first, with the exact total
//                  and how many were resolved in the last 24 hours;
//   ?since=<iso>   EVERY ticket of any status created since (the Dashboard's windows, the hub demo).
// Same filters and the same crew scope in every view; `supervisorId` scopes to a queue on the
// server. The demo stub runs the same views as pure rules (lib/workOrders).
//
// HOW. The REAL qc route through scripts/fake-supabase.mjs with `world.maxRows = 1000` (Supabase's
// db-max-rows), over 1,212 tickets: an OLD open complaint and a legacy `ack` ticket below 1,150
// newer resolved ones. Every check reads the module or the route at run time, so on the tree
// before the fix it FAILS with a count.
//
//   node app/scripts/test-work-orders-complete.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

// The app's own modules import without extensions (Vite resolves them); add `.js` for node.
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

const ORG = '00000000-0000-0000-0000-000000000640';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const WO = await import('../src/lib/workOrders.js');
const qc = (await import('../api/qc/[...path].js')).default;
let selectComplaintKpisFromWorkOrders = null;
try { ({ selectComplaintKpisFromWorkOrders } = await import('../src/store/selectors.js')); } catch { selectComplaintKpisFromWorkOrders = null; }

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

// ── the world: 1,212 tickets, more than one PostgREST response holds ─────────────────────────
const NOW = Date.now();
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const login = (who, role) => ({ id: `auth-${who}`, email: `${who}@example.test`, app_metadata: { role, org_user_id: who, org_id: ORG } });
const logins = { 'tok-owner': login('u_owner', 'owner'), 'tok-ana': login('u_ana', 'crew') };

const tickets = [];
const tk = (id, { client = 'c1', status = 'open', type = 'request', createdMs, resolvedMs = null, ...rest } = {}) => tickets.push({
  id, organization_id: ORG, client_id: client, site_id: client === 'c1' ? 's1' : 's2', title: id, type, priority: 'medium',
  status, origin: 'portal', reported_by_user_id: 'u_owner', created_at: iso(createdMs),
  resolved_at: resolvedMs == null ? null : iso(resolvedMs), due_at: iso(createdMs + 24 * H), ...rest,
});
// 1,150 RESOLVED tickets, created one hour apart (the newest an hour ago); the newest 30 were
// resolved within the last 24 hours, the rest days ago.
for (let i = 0; i < 1150; i += 1) {
  tk(`r_${String(i).padStart(4, '0')}`, {
    client: i % 2 ? 'c2' : 'c1', status: 'resolved', type: i % 3 ? 'request' : 'complaint',
    createdMs: NOW - (i + 1) * H, resolvedMs: i < 30 ? NOW - (i + 1) * 20 * 60 * 1000 : NOW - (2 + i) * 24 * H,
  });
}
// 60 OPEN tickets, recent, in the three open statuses.
const OPEN_STATUSES = ['open', 'in_progress', 'awaiting_client'];
for (let i = 0; i < 60; i += 1) {
  tk(`o_${String(i).padStart(3, '0')}`, { client: i % 2 ? 'c2' : 'c1', status: OPEN_STATUSES[i % 3], type: i % 4 ? 'request' : 'complaint', createdMs: NOW - (i + 1) * 30 * 60 * 1000 });
}
// 🔴 The OLD open complaint (400 days, at Bayside) and a legacy `ack` ticket (300 days, at Acme):
// both below every resolved ticket in creation order — the newest 500 never reached them.
tk('wo_old', { client: 'c2', status: 'open', type: 'complaint', createdMs: NOW - 400 * 24 * H });
tk('wo_ack', { client: 'c1', status: 'ack', type: 'issue', createdMs: NOW - 300 * 24 * H });

const OPEN_IDS = tickets.filter((t) => t.status !== 'resolved').map((t) => t.id);
const RESOLVED = tickets.filter((t) => t.status === 'resolved');

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 3,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_owner', 'owner'), user('u_ana', 'crew'), user('u_mgr', 'manager')],
          clients: [{ id: 'c1', name: 'Acme Towers', supervisorId: 'u_mgr' }, { id: 'c2', name: 'Bayside Plaza' }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Acme Towers' }, { id: 's2', clientId: 'c2', name: 'Bayside Plaza' }],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
        },
      }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      // Ana cleans Acme tonight, so her scope is Acme's tickets (CS-005's job rule).
      jobs: [{ id: 'j1', organization_id: ORG, site_id: 's1', client_id: 'c1', status: 'upcoming', start_at: iso(NOW + 2 * H),
        data: { id: 'j1', clientId: 'c1', siteId: 's1', startAt: iso(NOW + 2 * H), endAt: iso(NOW + 4 * H), status: 'upcoming', crewIds: ['u_ana'] } }],
      problem_reports: tickets,
      account_media: [],
    },
    logins,
  });
  world.maxRows = 1000; // 🔴 Supabase's db-max-rows: no single response holds more
}

async function call(path, { token = 'tok-owner', query = {} } = {}) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: path, ...query };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path}: no response`)), 20000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(qc(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const ids = (r) => ((r && r.body && r.body.problems) || []).map((p) => p.id);
const show = (r) => `got ${r.status} · ${ids(r).length} rows · total ${r.body?.total} · ${JSON.stringify(r.body).slice(0, 160)}`;

seed();

// ═══ A. every OPEN ticket, past the cap ═════════════════════════════════════════════════════
const open = await call('problems/list');
ok('A1 the default read answers', () => open.status === 200, () => show(open));
ok('🔴 A2 the 400-day-old open complaint is listed (below 1,150 newer resolved tickets)', () => ids(open).includes('wo_old'), () => show(open));
ok('🔴 A3 …and the legacy "ack" ticket, which is open', () => ids(open).includes('wo_ack'), () => show(open));
ok('A4 EVERY open ticket, each once, and nothing resolved', () => {
  const got = ids(open);
  return got.length === OPEN_IDS.length && new Set(got).size === got.length && OPEN_IDS.every((id) => got.includes(id));
}, () => show(open));
ok('A5 the total says how many open tickets there are', () => open.body?.total === OPEN_IDS.length, () => show(open));
ok('A6 newest first (the old ones last)', () => { const g = ids(open); return g[g.length - 1] === 'wo_old' && g[g.length - 2] === 'wo_ack'; }, () => ids(open).slice(-3).join(','));

// ═══ B. the resolved history: a bounded page with the exact total ═══════════════════════════
const r1 = await call('problems/list', { query: { resolved: '1' } });
ok('B1 one page of the resolved history (the default page size)', () => r1.status === 200 && ids(r1).length === WO.WO_RESOLVED_PAGE, () => show(r1));
ok('B2 …every row on it is resolved', () => (r1.body?.problems || []).every((p) => p.status === 'resolved'));
ok('🔴 B3 …and it says how many there are in all (1,150), past the cap', () => r1.body?.total === RESOLVED.length, () => show(r1));
ok('B4 …and how many were resolved in the last 24 hours (30)', () => r1.body?.last24h === 30, () => show(r1));
ok('B5 newest RESOLVED first', () => ids(r1)[0] === 'r_0000' && ids(r1)[1] === 'r_0001', () => ids(r1).slice(0, 3).join(','));
const rLast = await call('problems/list', { query: { resolved: '1', offset: String(RESOLVED.length - WO.WO_RESOLVED_PAGE) } });
ok('B6 the last page reaches the oldest resolved ticket (nothing is cut)', () => ids(rLast).length === WO.WO_RESOLVED_PAGE && ids(rLast).includes('r_1149'), () => show(rLast));
const rBig = await call('problems/list', { query: { resolved: '1', limit: '5000' } });
ok('B7 a page is never bigger than the cap per call', () => ids(rBig).length === WO.WO_RESOLVED_PAGE_MAX && rBig.body?.total === RESOLVED.length, () => show(rBig));
const rPast = await call('problems/list', { query: { resolved: '1', offset: '5000' } });
ok('B8 past the end: no rows, the same total', () => ids(rPast).length === 0 && rPast.body?.total === RESOLVED.length, () => show(rPast));
const rQueue = await call('problems/list', { query: { resolved: '1', supervisorId: 'u_mgr' } });
ok('B9 a queue (supervisorId) scopes the page AND its total on the server', () => rQueue.body?.total === RESOLVED.filter((t) => t.client_id === 'c1').length
  && (rQueue.body?.problems || []).every((p) => p.client_id === 'c1'), () => show(rQueue));

// ═══ C. every ticket since an instant, past the cap ═════════════════════════════════════════
const sinceMs = NOW - 45 * 24 * H;
const SINCE_IDS = tickets.filter((t) => Date.parse(t.created_at) >= sinceMs).map((t) => t.id);
const since = await call('problems/list', { query: { since: iso(sinceMs) } });
ok(`🔴 C1 every ticket created in the window, any status — all ${SINCE_IDS.length}, more than one response holds`, () => ids(since).length === SINCE_IDS.length
  && SINCE_IDS.length > 1000 && SINCE_IDS.every((id) => ids(since).includes(id)), () => show(since));
const bad = await call('problems/list', { query: { since: 'yesterday' } });
ok('C2 a malformed instant is refused', () => bad.status === 400, () => show(bad));
const both = await call('problems/list', { query: { since: iso(sinceMs), resolved: '1' } });
ok('C3 the two views are not mixed', () => both.status === 400, () => show(both));

// ═══ D. the crew scope holds in every view ══════════════════════════════════════════════════
const crewOpen = await call('problems/list', { token: 'tok-ana' });
ok('D1 a cleaner lists every open ticket at her building …', () => {
  const want = tickets.filter((t) => t.status !== 'resolved' && t.client_id === 'c1').map((t) => t.id);
  return crewOpen.status === 200 && ids(crewOpen).length === want.length && want.every((id) => ids(crewOpen).includes(id));
}, () => show(crewOpen));
ok('D2 …and none at another building (the old open complaint is not hers)', () => !ids(crewOpen).includes('wo_old') && (crewOpen.body?.problems || []).every((p) => p.client_id === 'c1'));
const crewResolved = await call('problems/list', { token: 'tok-ana', query: { resolved: '1', supervisorId: 'u_nobody' } });
ok('D3 her resolved history is her building\'s, and a queue filter cannot widen or blank it', () => crewResolved.body?.total === RESOLVED.filter((t) => t.client_id === 'c1').length
  && (crewResolved.body?.problems || []).every((p) => p.client_id === 'c1'), () => show(crewResolved));

// ═══ E. the Dashboard counts every open complaint ═══════════════════════════════════════════
const openComplaints = await call('problems/list', { query: { type: 'complaint' } });
const OPEN_COMPLAINTS = tickets.filter((t) => t.status !== 'resolved' && t.type === 'complaint').map((t) => t.id);
ok('E1 the open-complaints read holds every open complaint, the old one included', () => ids(openComplaints).length === OPEN_COMPLAINTS.length && ids(openComplaints).includes('wo_old'), () => show(openComplaints));
const windowStart = NOW - 60 * 24 * H;
const recentComplaints = await call('problems/list', { query: { type: 'complaint', since: iso(windowStart) } });
ok('🔴 E2 the KPI\'s open count, over the two joined reads, is every open complaint', () => {
  if (typeof WO.mergeWorkOrderRows !== 'function') throw new Error('lib/workOrders has no mergeWorkOrderRows()');
  if (typeof selectComplaintKpisFromWorkOrders !== 'function') throw new Error('selectors not loadable');
  const k = selectComplaintKpisFromWorkOrders({ jobs: [] }, WO.mergeWorkOrderRows(openComplaints.body?.problems, recentComplaints.body?.problems));
  return k.open === OPEN_COMPLAINTS.length;
});
ok('E3 …and every one of its figures equals the same selector over EVERY ticket in the table', () => {
  const k = selectComplaintKpisFromWorkOrders({ jobs: [] }, WO.mergeWorkOrderRows(openComplaints.body?.problems, recentComplaints.body?.problems));
  const truth = selectComplaintKpisFromWorkOrders({ jobs: [] }, tickets);
  return k.open === truth.open && k.complaints === truth.complaints && k.yesterdayDelta === truth.yesterdayDelta
    && JSON.stringify(k.trend) === JSON.stringify(truth.trend) && truth.complaints > 0;
}, () => JSON.stringify([
  selectComplaintKpisFromWorkOrders({ jobs: [] }, WO.mergeWorkOrderRows(openComplaints.body?.problems, recentComplaints.body?.problems)),
  selectComplaintKpisFromWorkOrders({ jobs: [] }, tickets)]));

// ═══ F. the demo stub's views are the same rules ═══════════════════════════════════════════
ok('F1 openWorkOrderRows = the route\'s open view', () => JSON.stringify(WO.openWorkOrderRows(tickets).map((t) => t.id)) === JSON.stringify(ids(open)));
ok('F2 resolvedWorkOrderPage = the route\'s resolved page (rows, total, last 24h)', () => {
  const p = WO.resolvedWorkOrderPage(tickets, { offset: 0 });
  return JSON.stringify(p.problems.map((t) => t.id)) === JSON.stringify(ids(r1)) && p.total === r1.body?.total && p.last24h === r1.body?.last24h;
});
ok('F3 workOrderRowsSince = the route\'s since view', () => JSON.stringify(WO.workOrderRowsSince(tickets, iso(sinceMs)).map((t) => t.id).sort()) === JSON.stringify(ids(since).sort()));

// ═══ G. every caller reads a view, and the capped read is gone (II.5) ═══════════════════════
{
  const store = read('../api/_lib/qc/store.js');
  const api = read('../src/lib/qcApi.js');
  const panel = read('../src/components/WorkOrdersPanel.jsx');
  const requests = read('../src/pages/ClientRequests.jsx');
  const home = read('../src/hooks/useManagerHomeReads.js');
  const dash = read('../src/pages/Dashboard.jsx');
  const hub = read('../src/lib/hubDemo.js');
  const matrix = read('../../docs/playbook/ENDPOINT_AUTHZ_MATRIX.md');
  ok('G1 the newest-500 read is gone from the store and the adapter', () => !/export async function listProblems\(/.test(store) && !/limit = 500/.test(store)
    && !/export async function listProblems\(/.test(api));
  ok('G2 the open view is a complete read (selectAll), ordered with an id tiebreak', () => {
    const body = store.slice(store.indexOf('async function allProblems'), store.indexOf('export async function listOpenProblems'));
    return /selectAll\(/.test(body) && /\.order\('created_at'[^)]*\)\.order\('id'/.test(body);
  });
  ok('G3 the Work Orders tab reads every open ticket and pages the resolved history', () => /qcApi\.listOpenProblems\(/.test(panel) && /qcApi\.listResolvedProblems\(/.test(panel) && /resolved\.total/.test(panel));
  ok('G4 Client Requests and Home\'s tile + nav pill read every open ticket', () => /qcApi\.listOpenProblems\(/.test(requests) && /qcApi\.listOpenProblems\(/.test(home));
  ok('G5 the Dashboard joins every open complaint with the window\'s', () => /listOpenProblems\(\{ type: 'complaint' \}\)/.test(dash) && /listProblemsSince\(/.test(dash) && /mergeWorkOrderRows\(/.test(dash));
  ok('G6 the hub demo reads its year completely', () => /listProblemsSince\(/.test(hub) && !/listProblems\(\{/.test(hub));
  ok('G7 the endpoint row names the three views', () => /\| EP-059 \| GET \/api\/qc\/problems\/list \|[^\n]*resolved=1[^\n]*since/.test(matrix));
}

if (fails.length) {
  console.error(`\n✖ test-work-orders-complete: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`   ✖ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-work-orders-complete: ${pass} passed`);
}
