// A CLIENT LOGIN REACHES THE HUB AND NOTHING ELSE (Phase 2 Wave 2, the client hub).
//
// A client user — Matt's property manager or a city's facility director — signs in through
// the same Supabase project as the office. Their login carries `app_metadata.role = 'client'`
// and a `client_user_id`, and deliberately NO `org_user_id` (the jobs RLS policy admits a
// login whose org_user_id is in a job's crewIds). Everything the office API serves is
// off-limits to them: one endpoint family, /api/hub/*, and nothing else.
//
// 🔴 WHY A TEST AND NOT A CODE REVIEW. Before this, NOTHING in the server refused role
// 'client' on purpose. A client login was refused only as a side effect of not being on the
// team roster — which is not a boundary, because:
//   · an unreadable roster decides "as before" (rosterStatusVerdict returns refused:false),
//     so a transient PostgREST failure handed a client login the crew projection of the
//     whole shared record;
//   · a roster row carrying the same email resolves the login to THAT MEMBER'S ROLE
//     (the claim-less fallback). Matt is both the owner and a plausible client contact;
//   · a stray `org_user_id` on the login (a hand edit, a half-finished migration, a GoTrue
//     app_metadata merge that kept an old key) resolves a full crew identity.
// Each of those is exercised below and each FAILED before the fix.
//
// Three layers, the shape of test-disabled-authority.mjs:
//   A. the central rule, by enumeration: every route either funnels through an
//      _lib/authz.js gate (all of which refuse role client) or declares a session-less
//      stance in the generated inventory. A new route cannot forget.
//   B. the REAL route handlers + the real supabase-js against a loopback fake of GoTrue +
//      PostgREST. Nothing leaves 127.0.0.1.
//   C. the hub route itself: a client sees their own buildings and whitelisted fields only;
//      an office login is refused there.
//
//   node app/scripts/test-client-login-isolation.mjs
import http from 'node:http';
import path from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeDb } from './fake-postgrest.mjs';
import { installResolveShim } from './deletion-core.mjs';
import * as clientHubLib from '../src/lib/clientHub.js';

installResolveShim(); // Vite writes extensionless imports; plain node needs `.js`
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(APP, 'api');
const ORG = '00000000-0000-0000-0000-000000000001';
// Round 2's projections (src/lib/clientHubView.js). Imported softly so the pre-change tree, which
// has no such module, fails section D's checks one by one instead of crashing the whole suite.
const hubView = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'clientHubView.js')).href).catch(() => ({}));
// The redesign's messages vocabulary (src/lib/hubMessages.js), imported softly for the same reason.
const hubMessages = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'hubMessages.js')).href).catch(() => ({}));
// Read through the namespace, so a tree without the redesign's view lists fails C3/C14..C18 one by
// one rather than at the import.
const { HUB_BUILDING_FIELDS, HUB_SUPERVISOR_FIELDS } = clientHubLib;
const HUB_VIEW_FIELDS = clientHubLib.HUB_VIEW_FIELDS || [];
const HUB_VIEWER_FIELDS = clientHubLib.HUB_VIEWER_FIELDS || [];
const HUB_GROUP_FIELDS = clientHubLib.HUB_GROUP_FIELDS || [];
const HUB_VIEW_BUILDING_FIELDS = clientHubLib.HUB_VIEW_BUILDING_FIELDS || [];
// The redesign's projections (2026-10-08): Home's tiles and the crew status / Today's Visit.
const VH = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'hubHome.js')).href).catch(() => ({}));
const VV = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'hubVisit.js')).href).catch(() => ({}));
// The office's "Preview as customer" vocabulary (plan §3.7): the header, read from the module the
// server reads it from (the fallback only lets the pre-change tree run far enough to fail).
const PV = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'hubPreview.js')).href).catch(() => ({}));
const PREVIEW_HEADER = PV.HUB_PREVIEW_HEADER || 'x-hub-preview';
// The building's stand-in address (2026-10-09), from the same module.
const STAND_IN_EMAIL_ONE = PV.hubPreviewStandInEmail?.('cl_one') || 'preview+cl_one@preview.invalid';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: (label, cond) — the same order as test-disabled-authority.mjs, which
// this file is modelled on. The repo's suites disagree on this; read before you add a check.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── identities ────────────────────────────────────────────────────────────────
// CU_ID is the client user's row id; it is a claim, never a body field.
const CU_ID = '11111111-1111-4111-8111-111111111111';
const AUTH = {
  'tok-owner': { id: 'a-owner', email: 'owner@cs.test', app_metadata: { role: 'owner', org_user_id: 'u_owner' } },
  'tok-crew': { id: 'a-crew', email: 'crew@cs.test', app_metadata: { role: 'crew', org_user_id: 'u_crew' } },
  // The client login as the invite path mints it.
  'tok-client': { id: 'a-client', email: 'pm@building.test', app_metadata: { role: 'client', client_user_id: CU_ID, org_id: ORG } },
  // …the same login whose email ALSO appears on a team roster row (the claim-less fallback
  // used to resolve it to that member's role).
  'tok-client-oncrew': { id: 'a-client2', email: 'crew@cs.test', app_metadata: { role: 'client', client_user_id: CU_ID, org_id: ORG } },
  // …and one that carries a stray org_user_id next to the client role.
  'tok-client-orguser': { id: 'a-client3', email: 'pm3@building.test', app_metadata: { role: 'client', client_user_id: CU_ID, org_user_id: 'u_crew', org_id: ORG } },
};
const member = (id, role, status = 'active') => ({ id, name: id, email: `${id.slice(2)}@cs.test`, role, status });
const ROSTER = () => [member('u_owner', 'owner'), member('u_crew', 'crew')];

// Two buildings, one allowed and one not, plus a supervisor with a phone (HUB-12/HUB-18).
const CLIENTS = () => [
  { id: 'cl_one', name: 'Harbor Tower', supervisorId: 'u_owner', street: '1 Harbor Way', city: 'Fort Lauderdale', state: 'FL', zip: '33301', revenue: 5400, notes: 'gate code 4455', email: 'ap@harbor.test' },
  { id: 'cl_two', name: 'Palm Center', supervisorId: 'u_owner', street: '2 Palm Ave', city: 'Miami', state: 'FL', zip: '33101', revenue: 9900, notes: 'alarm 9911', email: 'ap@palm.test' },
];
const SITES = () => [
  { id: 'st_loc_cl_one', clientId: 'cl_one', name: 'Main Location', address: '1 Harbor Way, Fort Lauderdale, FL 33301', lat: 26.1, lng: -80.1 },
  { id: 'st_loc_cl_two', clientId: 'cl_two', name: 'Main Location', address: '2 Palm Ave, Miami, FL 33101', lat: 25.7, lng: -80.2 },
];
// Active, as every live roster row is: the hub names a building's manager only while they are one
// (resolveAccountSupervisor — active, still Super Admin / Admin / Manager; decision D4).
const OWNER_ROW = { id: 'u_owner', name: 'Dana Owner', email: 'owner@cs.test', role: 'owner', status: 'active', phone: '(754) 555-0100', pay: { rateCents: 4200 } };

// ── the fake backend ──────────────────────────────────────────────────────────
const db = fakeDb({}, { maxRows: 1000 });
let failRosterRead = false;
function reset() {
  db.tables.org_state = [{
    organization_id: ORG, version: 7, min_client_build: null, protected_fingerprint: null,
    state: {
      users: [...ROSTER().filter((u) => u.id !== 'u_owner'), OWNER_ROW],
      permissions: null, userPermissionOverrides: [],
      clients: CLIENTS(), sites: SITES(), jobs: [], company: { name: 'Clean Space', timezone: 'America/New_York' },
      invoices: [], contacts: [], timeOff: [],
    },
  }];
  db.tables.client_heartbeats = [];
  db.tables.crew_assignments = [];
  db.tables.jobs = [];
  db.tables.job_deletes = [];
  db.tables.client_users = [{
    id: CU_ID, organization_id: ORG, name: 'Pat Manager', email: 'pm@building.test', phone: '(754) 555-0300',
    status: 'active', auth_user_id: 'a-client', invited_at: null, invited_by: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  }];
  db.tables.client_user_groups = [];
  db.tables.client_user_group_members = [];
  db.tables.client_user_assignments = [
    { id: 'as-1', organization_id: ORG, client_user_id: CU_ID, client_id: 'cl_one', group_id: null, created_at: '2026-10-01T00:00:00Z' },
  ];
  // Round 2: one record of every kind the hub serves, at the assigned building (cl_one) AND at
  // the one this login was never given (cl_two). Recent, so the 365-day window keeps them.
  const recent = new Date(Date.now() - 3600000).toISOString();
  const snap = { name: 'Walkthrough', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, schema: { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Glass' }] }] } };
  const ck = { name: 'Nightly', kind: 'checklist', schema: { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'k1', label: 'Glass' }] }] } };
  const per = (client, site, n) => ({
    time: { id: `te-${n}`, organization_id: ORG, client_id: client, site_id: site, user_id: 'u_crew', user_name: 'Casey Crew', clock_in_at: recent, clock_out_at: null, status: 'in_progress', geofence_result: 'inside', clock_in_distance_m: 4 },
    checklist: { id: R2[`ck${n}`], organization_id: ORG, client_id: client, site_id: site, template_snapshot: ck, items: [{ key: 'k1', checked: true, note: 'ok' }], completed_count: 1, total_count: 1, completed_by_user_id: 'u_crew', client_submit_id: `cs-${n}`, performed_at: recent },
    inspection: { id: R2[`in${n}`], organization_id: ORG, client_id: client, site_id: site, status: 'submitted', template_snapshot: snap, overall_score: 100, result: 'pass', inspector_name: 'Dana Owner', client_name: client, site_name: 'Main', public_token: `tok-${n}`, internal_note: 'ZZNOTEZZ office only', performed_at: recent },
    item: { id: `ii-${n}`, inspection_id: R2[`in${n}`], item_key: 'i1', label: 'Lobby. Glass', rating: 'pass', comment: 'Clean' },
    ticket: { id: R2[`tk${n}`], organization_id: ORG, client_id: client, site_id: site, origin: 'portal', title: 'Spill', description: 'A spill', type: 'complaint', category: 'spill', priority: 'medium', status: 'open', created_at: recent, resolved_at: null, raised_by_client_user_id: CU_ID, raised_by_client_name: 'Pat Manager' },
    message: { id: `wm-${n}`, organization_id: ORG, problem_id: R2[`tk${n}`], author_role: 'office', author_name: 'Dana Owner', author_user_id: 'u_owner', body: 'On it', internal: false, created_at: recent },
  });
  const one = per('cl_one', 'st_loc_cl_one', 1);
  const two = per('cl_two', 'st_loc_cl_two', 2);
  db.tables.time_entries = [one.time, two.time];
  db.tables.checklist_results = [one.checklist, two.checklist];
  db.tables.inspection_records = [one.inspection, two.inspection];
  db.tables.inspection_items = [one.item, two.item];
  db.tables.problem_reports = [one.ticket, two.ticket];
  db.tables.work_order_messages = [one.message, two.message];
  db.tables.account_media = [];
  db.tables.activity_log = [];
  // The client hub redesign (Builder C): a document at each building, and no contracts or
  // QuickBooks connection (the invoices answer `not-connected` without asking anyone).
  const doc = (id, client) => ({ id, organization_id: ORG, client_id: client, kind: 'coi', title: `Certificate ${client}`, valid_until: null, file_name: 'coi.pdf', file_size: 10, mime_type: 'application/pdf', visible_to_client: true, revision: 1, created_at: recent, updated_at: recent, created_by_user_id: 'u_owner' });
  db.tables.customer_documents = [doc(R2.doc1, 'cl_one'), doc(R2.doc2, 'cl_two')];
  db.tables.contracts = [];
  db.tables.contract_buildings = [];
  db.tables.qbo_connection = [];
  db.tables.qbo_property_links = [];
  db.tables.qbo_invoice_cache = [];
  failRosterRead = false;
}
// Round 2's record ids (uuids, as the real columns are).
const R2 = {
  ck1: 'd1000000-0000-4000-8000-000000000001', ck2: 'd1000000-0000-4000-8000-000000000002',
  in1: 'd2000000-0000-4000-8000-000000000001', in2: 'd2000000-0000-4000-8000-000000000002',
  tk1: 'd3000000-0000-4000-8000-000000000001', tk2: 'd3000000-0000-4000-8000-000000000002',
  doc1: 'd6000000-0000-4000-8000-000000000001', doc2: 'd6000000-0000-4000-8000-000000000002',
};
const committed = () => db.tables.org_state[0];
// Every set of building ids the hub view asked hub_next_visits about.
const rpcAsked = [];
// A building's next visit (and the other building's), for the view's `nextVisit` and the visit
// page's reads. Set in sections C and D only, so no office route above ever reads them.
const SOON = (days) => new Date(Date.now() + days * 86400000).toISOString();
const HUB_JOBS = () => [
  { id: 'j-one', organization_id: ORG, client_id: 'cl_one', site_id: 'st_loc_cl_one', status: 'upcoming', start_at: SOON(3), data: { id: 'j-one', clientId: 'cl_one', startAt: SOON(3), crewIds: ['u_crew'], notes: 'ZZJOBNOTEZZ alarm code 1234' } },
  { id: 'j-two', organization_id: ORG, client_id: 'cl_two', site_id: 'st_loc_cl_two', status: 'upcoming', start_at: SOON(2), data: { id: 'j-two', clientId: 'cl_two', startAt: SOON(2), crewIds: ['u_crew'] } },
];

function applyParam(q, key, raw) {
  const dot = raw.indexOf('.');
  const op = raw.slice(0, dot);
  const val = raw.slice(dot + 1);
  if (op === 'in') return q.in(key, val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')));
  if (op === 'is') return q.is(key, val === 'null' ? null : val);
  // `not.is.null` — the hub view's own group assignments (client_user_assignments.group_id).
  if (op === 'not' && val === 'is.null') return q.not(key, 'is', null);
  // `cs` is PostgREST's jsonb containment — getCrewJobs asks for the jobs whose
  // data->crewIds contains the caller. The fake holds no jobs, so match nothing.
  if (op === 'cs') return q.eq('__never__', '1');
  if (!['eq', 'neq', 'gte', 'lte', 'gt', 'lt'].includes(op)) throw new Error(`fake: op ${op} unsupported`);
  return q[op](key, val);
}
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => resolve(s ? JSON.parse(s) : null));
});
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const body = await readBody(req);
  if (u.pathname === '/auth/v1/user') {
    const user = AUTH[String(req.headers.authorization || '').replace(/^Bearer /, '')];
    return user ? send(200, { aud: 'authenticated', role: 'authenticated', ...user }) : send(401, { msg: 'invalid JWT' });
  }
  // The hub view's next visits (migration 20261008100000 hub_next_visits): `distinct on
  // (client_id)` the soonest upcoming job from p_from within 60 days, for the ids passed — the
  // function's own rule, so the suite can see the view never asks for a building out of scope.
  if (req.method === 'POST' && u.pathname === '/rest/v1/rpc/hub_next_visits') {
    const ids = new Set(body?.p_client_ids || []);
    const from = Date.parse(body?.p_from);
    const best = new Map();
    for (const j of db.tables.jobs || []) {
      const t = Date.parse(j.start_at);
      if (j.organization_id !== body?.p_org || !ids.has(j.client_id) || j.status !== 'upcoming') continue;
      if (!(t >= from && t < from + 60 * 86400000)) continue;
      const cur = best.get(j.client_id);
      if (!cur || t < Date.parse(cur.start_at)) best.set(j.client_id, { client_id: j.client_id, start_at: j.start_at });
    }
    rpcAsked.push([...ids]);
    return send(200, [...best.values()]);
  }
  const m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  if (!m) return send(404, { message: 'no route' });
  const table = m[1];
  const select = u.searchParams.get('select') || '*';
  // A COUNT is a HEAD with `Prefer: count=exact` whose answer is the Content-Range header (the
  // count half of every paged hub list); a page carries `offset` + `limit`.
  const head = req.method === 'HEAD';
  const counted = /count=exact/.test(String(req.headers.prefer || ''));
  try {
    if (req.method !== 'GET' && !head) return send(405, { message: `fake: ${req.method} ${table}` });
    if (failRosterRead && table === 'org_state' && select === 'users:state->users') return send(500, { code: 'XX000', message: 'fake: roster read failed' });
    let q = db.from(table).select(select, counted ? { count: 'exact', head } : {});
    for (const [key, raw] of u.searchParams) {
      if (['select', 'offset', 'limit', 'order'].includes(key)) continue;
      q = applyParam(q, key, raw);
    }
    for (const part of (u.searchParams.get('order') || '').split(',').filter(Boolean)) {
      const [col, dir] = part.split('.');
      q = q.order(col, { ascending: dir !== 'desc' });
    }
    const offset = Number(u.searchParams.get('offset') || 0);
    if (u.searchParams.has('limit')) q = q.range(offset, offset + Number(u.searchParams.get('limit')) - 1);
    const r = await q;
    if (r.error) return send(400, r.error);
    if (head) {
      res.writeHead(200, { 'Content-Range': `*/${r.count ?? 0}` });
      return res.end();
    }
    if (counted) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': `${offset}-${offset + r.data.length - 1}/${r.count}` });
      return res.end(JSON.stringify(r.data));
    }
    return send(200, r.data);
  } catch (e) {
    return send(400, { message: e.message });
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'GOOGLE_MAPS_API_KEY', 'ALERT_WEBHOOK_URL']) delete process.env[k];

const load = async (rel) => (await import(pathToFileURL(path.join(APP, ...rel.split('/'))).href)).default;
const stateView = await load('api/state/view.js');
const hubPath = path.join(API, 'hub', '[...path].js');
const hub = existsSync(hubPath) ? await load('api/hub/[...path].js') : null;
const authz = await import(pathToFileURL(path.join(API, '_lib', 'authz.js')).href);
// The hub's tables' store, for the preview stand-in's id (2026-10-09).
const clientHubStore = await import(pathToFileURL(path.join(API, '_lib', 'clientHub', 'store.js')).href);

function call(handler, { token, method = 'GET', query = {}, body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader() {},
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    const req = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, query, body: body || {} };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 'threw', body: { error: e.message } }));
  });
}
const quiet = async (fn) => {
  const { warn, error } = console;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.error = error; }
};
// A client login's refusal must be ITS OWN, not a side effect of the roster: `client-login`.
const refusedClient = (r) => r.status === 403 && r.body?.code === 'client-login';

reset();

try {
  // ── A. the central rule, by enumeration ─────────────────────────────────────
  // Every route either funnels through an _lib/authz.js gate (and every gate refuses role
  // client, proved executably in B) or is session-less by declared stance. No hand list of
  // "the routes that matter": the set is read off disk, so a new route is covered or fails.
  {
    const files = [];
    const walk = (dir) => {
      for (const n of readdirSync(dir)) {
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) { if (n !== '_lib') walk(p); } else if (p.endsWith('.js')) files.push(p);
      }
    };
    walk(API);
    const routeOf = (p) => `/${path.relative(API, p).replace(/\\/g, '/').replace(/\.js$/, '')}`;
    // The generated inventory's stance column — the artifact playbook II.6 requires, kept
    // true by endpoint-lint. A session-less stance cannot be reached with a client JWT.
    const inv = readFileSync(path.join(API, 'ENDPOINTS.md'), 'utf8');
    const stance = new Map([...inv.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/gm)].map((m) => [m[1], m[2]]));
    const SESSIONLESS = /cron-secret|bearer \/ HMAC|signed OAuth state|signed-token|token-scoped|declared PUBLIC/;
    // The ONE family a client login may reach. Everything else must be gated.
    const HUB = /^\/hub(\/|$)/;
    // "Gated" is TRANSITIVE through _lib: /inbox/[id]/send calls requireInboxOwner, which is
    // requireAuthority plus an ownership check (_lib/inboxOwnership.js). A direct-import-only
    // test would report those three as ungated and teach the next person to widen the rule.
    const LIB = path.join(API, '_lib');
    const libFiles = [];
    const walkLib = (dir) => {
      for (const n of readdirSync(dir)) {
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) walkLib(p); else if (p.endsWith('.js')) libFiles.push(p);
      }
    };
    walkLib(LIB);
    const importsOf = (p) => [...readFileSync(p, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1]).filter((s) => s.startsWith('.'))
      .map((s) => path.resolve(path.dirname(p), s));
    const carriers = new Set([path.join(LIB, 'authz.js')]);
    for (let i = 0; i < libFiles.length; i += 1) { // fixed point: cheap at this size
      let grew = false;
      for (const f of libFiles) {
        if (carriers.has(f)) continue;
        if (importsOf(f).some((d) => carriers.has(d))) { carriers.add(f); grew = true; }
      }
      if (!grew) break;
    }
    const gated = (p) => importsOf(p).some((d) => carriers.has(d));
    const uncovered = files.filter((p) => {
      const route = routeOf(p);
      if (HUB.test(route)) return false;
      if (gated(p)) return false;
      return !SESSIONLESS.test(stance.get(route) || '');
    });
    ok(`🔴 A1 every non-hub route is gated by _lib/authz.js or declared session-less (${uncovered.map(routeOf).join(', ') || 'none uncovered'})`,
      uncovered.length === 0);
    ok('A2 the sweep is not vacuous: it walks the whole of app/api and sees the catch-alls',
      files.length > 40 && files.some((p) => /\[\.\.\.path\]\.js$/.test(p)));
    // Every gate authz.js exports must be exercised below. A new helper that forgets the
    // client rule is then a FAILING test, not a quiet hole.
    const authzSrc = readFileSync(path.join(API, '_lib', 'authz.js'), 'utf8');
    const exported = [...authzSrc.matchAll(/^export\s+async\s+function\s+(require[A-Z]\w*)/gm)].map((m) => m[1]);
    const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const untested = exported.filter((n) => !new RegExp(`authz\\.${n}\\b`).test(selfSrc));
    ok(`🔴 A3 every require* gate authz.js exports is exercised against a client login (${untested.join(', ') || 'all covered'})`,
      exported.length >= 5 && untested.length === 0);
    // The client role is NOT an office role: nothing may stamp it through the staff path.
    const claims = readFileSync(path.join(API, '_lib', 'claims.js'), 'utf8');
    ok('A4 the office claim vocabulary (VALID_ROLES) is still the app\'s ROLES and excludes client',
      /VALID_ROLES\s*=\s*Object\.freeze\(\[\.\.\.ROLES\]\)/.test(claims)
        && !/^export const ROLES[^\n]*client/m.test(readFileSync(path.join(APP, 'src', 'lib', 'roles.js'), 'utf8')));
  }

  // ── B. the gates, executed ──────────────────────────────────────────────────
  const hdr = (token) => ({ headers: { authorization: `Bearer ${token}` } });
  const authority = (token) => quiet(() => authz.resolveAuthority(hdr(token)));

  ok('🔴 B1 resolveAuthority holds nothing for a client login', (await authority('tok-client')) === null);
  // The three configurations the roster side-effect used to let through.
  failRosterRead = true;
  ok('🔴 B2 …and still nothing when the roster read FAILS (the fallback contract must not widen to a client)',
    (await authority('tok-client')) === null);
  failRosterRead = false;
  ok('🔴 B3 …nor when a team roster row carries the same email (the claim-less fallback)',
    (await authority('tok-client-oncrew')) === null);
  ok('🔴 B4 …nor when the login also carries a stray org_user_id claim',
    (await authority('tok-client-orguser')) === null);
  ok('B5 control: the owner and a crew member still resolve',
    (await authority('tok-owner'))?.role === 'owner' && (await authority('tok-crew'))?.orgUserId === 'u_crew');

  // Every exported gate, against a client login. Each writes its own refusal.
  const res402 = () => {
    const sink = { statusCode: 0, body: null };
    return {
      sink,
      res: {
        status(c) { sink.statusCode = c; return this; },
        setHeader() {},
        json(b) { sink.body = b; return this; },
        send(b) { sink.body = b; return this; },
        end() { return this; },
      },
    };
  };
  const gate = async (fn, ...args) => {
    const { sink, res } = res402();
    const out = await quiet(() => fn(hdr('tok-client'), res, ...args));
    return { out, status: sink.statusCode, body: sink.body };
  };
  let g = await gate(authz.requireAuthority);
  ok('🔴 B6 requireAuthority refuses a client login: 403 client-login', g.out === null && refusedClient(g));
  g = await gate(authz.requireRole, ['owner', 'admin', 'manager', 'crew']);
  ok('🔴 B7 requireRole refuses a client login', g.out === null && refusedClient(g));
  g = await gate(authz.requirePermission, 'time.clock'); // ALWAYS_GRANTED: can() says yes to any identity
  ok('🔴 B8 requirePermission refuses a client login even on an ALWAYS_GRANTED key', g.out === null && refusedClient(g));
  g = await gate(authz.requireAnyPermission, ['time.clock', 'schedule.view']);
  ok('🔴 B9 requireAnyPermission refuses a client login', g.out === null && refusedClient(g));
  g = await gate(authz.requireRoleOrPermission, ['owner'], 'time.clock');
  ok('🔴 B10 requireRoleOrPermission refuses a client login', g.out === null && refusedClient(g));
  g = await gate(authz.requireSiteAssignment, 'st_loc_cl_one', { managerRoles: authz.OFFICE_ROLES });
  ok('🔴 B11 requireSiteAssignment refuses a client login on a site they are assigned to as a CUSTOMER',
    g.out === null && refusedClient(g));

  // The named gap: state/view serves "crew, or any other/absent role" a crew projection.
  let r = await quiet(() => call(stateView, { token: 'tok-client' }));
  ok('🔴 B12 GET /api/state/view refuses a client login (it used to answer a crew projection)', refusedClient(r));
  failRosterRead = true;
  r = await quiet(() => call(stateView, { token: 'tok-client' }));
  ok('🔴 B13 …including when the roster read fails', refusedClient(r));
  failRosterRead = false;
  r = await quiet(() => call(stateView, { token: 'tok-client-oncrew' }));
  ok('🔴 B14 …and for a client login whose email is on the roster', refusedClient(r));
  r = await quiet(() => call(stateView, { token: 'tok-client-orguser' }));
  ok('🔴 B15 …and for one carrying a stray org_user_id', refusedClient(r));
  r = await quiet(() => call(stateView, { token: 'tok-owner' }));
  ok('B16 control: the owner still gets the FULL blob', r.status === 200 && r.body?.projection === 'full'
    && Array.isArray(r.body?.state?.clients) && r.body.state.clients.length === 2);
  r = await quiet(() => call(stateView, { token: 'tok-crew' }));
  ok('B17 control: a crew login still gets the crew projection', r.status === 200 && r.body?.projection === 'crew');
  r = await quiet(() => call(stateView, {}));
  ok('B18 control: no session is still 401', r.status === 401);

  // ── C. the hub route: the one family a client login MAY reach ───────────────
  if (hub) {
    db.tables.jobs = HUB_JOBS();
    rpcAsked.length = 0;
    r = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'view' } }));
    const buildings = r.body?.buildings || [];
    ok('C1 GET /api/hub/view answers a client login', r.status === 200 && Array.isArray(buildings));
    ok('🔴 C2 …with ONLY the buildings they are assigned (1 of 2)',
      buildings.length === 1 && buildings[0]?.id === 'cl_one');
    // The whitelist, asserted as a whole-object comparison against the SOURCE-OF-TRUTH
    // constant (never a restated literal): a field added to the customer record must never
    // reach a client login by default, and a field added to the projection must be a
    // deliberate edit of HUB_BUILDING_FIELDS. A view ROW is that projection plus its next visit
    // (HUB_VIEW_BUILDING_FIELDS, the redesign 2026-10-08) — the building projection itself is
    // unchanged.
    const keys = Object.keys(buildings[0] || {}).sort().join(',');
    ok(`🔴 C3 …and ONLY the whitelisted fields (${keys})`,
      HUB_BUILDING_FIELDS.length === 9 && HUB_VIEW_BUILDING_FIELDS.length === 10
        && HUB_VIEW_BUILDING_FIELDS.every((f) => f === 'nextVisit' || HUB_BUILDING_FIELDS.includes(f))
        && keys === [...HUB_VIEW_BUILDING_FIELDS].sort().join(','));
    const sup = buildings[0]?.supervisor || {};
    ok('C4 the supervisor is first name + last initial + their own phone, nothing else (HUB-12 / HUB-18)',
      Object.keys(sup).sort().join(',') === [...HUB_SUPERVISOR_FIELDS].sort().join(',')
        && sup.phone === '(754) 555-0100' && sup.name === 'Dana O.');
    const blob = JSON.stringify(r.body);
    ok('🔴 C5 nothing else from the shared record rides along (revenue, notes, pay, the other building, a full staff name)',
      !blob.includes('5400') && !blob.includes('gate code') && !blob.includes('Palm Center')
        && !blob.includes('4200') && !blob.includes('ap@harbor.test') && !blob.includes('Dana Owner'));
    ok('🔴 C14 the view is EXACTLY its allowlist, the viewer theirs (their own name, first name, email, phone)',
      Object.keys(r.body || {}).sort().join(',') === [...HUB_VIEW_FIELDS].sort().join(',')
        && Object.keys(r.body?.viewer || {}).sort().join(',') === [...HUB_VIEWER_FIELDS].sort().join(',')
        && r.body.viewer.firstName === 'Pat' && r.body.viewer.phone === '(754) 555-0300');
    ok('C15 …with the org\'s zone from company.timezone (never the server\'s)', r.body?.timezone === 'America/New_York');
    ok('🔴 C16 each building\'s next visit is its own; the next visits are asked ONLY for the buildings in scope',
      buildings[0]?.nextVisit === new Date(db.tables.jobs[0].start_at).toISOString()
        && rpcAsked.length === 1 && rpcAsked[0].join(',') === 'cl_one' && !blob.includes('j-two') && !blob.includes('ZZJOBNOTEZZ'));
    ok('C17 …and a login assigned no group is shown none', Array.isArray(r.body?.groups) && r.body.groups.length === 0);
    r = await quiet(() => call(hub, { token: 'tok-owner', query: { subpath: 'view' } }));
    ok('🔴 C6 an OFFICE login is refused at the hub: it has no client-user identity', r.status === 403);
    r = await quiet(() => call(hub, { query: { subpath: 'view' } }));
    ok('C7 no session is 401 at the hub', r.status === 401);
    // A disabled client user holds nothing, even with a valid token.
    db.tables.client_users[0].status = 'disabled';
    r = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'view' } }));
    ok('🔴 C8 a DISABLED client user is refused (status, not only the GoTrue ban)',
      r.status === 403 && r.body?.code === 'account-disabled');
    reset();
    // The hub's gate on its own — the one require* in authz.js that ADMITS a client login,
    // so A3's "every gate is exercised" sweep is not satisfied by a comment.
    const cg = await (async () => {
      const { sink, res } = res402();
      const out = await quiet(() => authz.requireClientUser(hdr('tok-client'), res));
      return { out, status: sink.statusCode, body: sink.body };
    })();
    ok('C9 authz.requireClientUser admits the client login and hands back its row',
      cg.out?.clientUser?.id === CU_ID && cg.status === 0);
    const og = await (async () => {
      const { sink, res } = res402();
      const out = await quiet(() => authz.requireClientUser(hdr('tok-owner'), res));
      return { out, status: sink.statusCode, body: sink.body };
    })();
    ok('🔴 C10 …and refuses an office login: 403 office-login',
      og.out === null && og.status === 403 && og.body?.code === 'office-login');
    // The hub route's own gate since the client hub redesign (plan §3.7, "Preview as customer"):
    // requireClientUser for a customer, UNCHANGED, plus one way in for staff — the preview header
    // AND hub.users.view (claims-first). A customer login sending the header gains nothing.
    const hubGate = async (token, preview) => {
      if (typeof authz.requireHubCaller !== 'function') return { out: undefined, status: -1, body: null };
      const { sink, res } = res402();
      const req = hdr(token);
      if (preview !== undefined) req.headers[PREVIEW_HEADER] = preview;
      const out = await quiet(() => authz.requireHubCaller(req, res));
      return { out, status: sink.statusCode, body: sink.body };
    };
    const hc = await hubGate('tok-client', 'cl_two');
    ok('🔴 C19 authz.requireHubCaller admits the client login as ITSELF, its preview header ignored',
      hc.out?.clientUser?.id === CU_ID && hc.out?.preview === null && hc.status === 0);
    const hs = await hubGate('tok-owner');
    ok('🔴 C20 …refuses a staff login with no preview header: 403 office-login (the old answer)',
      hs.out === null && hs.status === 403 && hs.body?.code === 'office-login');
    const hcrew = await hubGate('tok-crew', 'cl_one');
    ok('🔴 C21 …refuses a cleaner sending the header: no hub.users.view, no preview (403)',
      hcrew.out === null && hcrew.status === 403);
    const hown = await hubGate('tok-owner', 'cl_one');
    ok('C22 …and admits the owner with the header as a PREVIEW of that building (the gate names no customer: the route puts the building\'s stand-in behind it once the building is found in the book)',
      hown.out?.preview?.buildingId === 'cl_one' && hown.out?.clientUser === null && hown.status === 0);
    // The preview's STAND-IN customer login (2026-10-09, the office's preview acts as the customer):
    // a client_users row with status 'preview' and no login. A login whose claim names it anyway is
    // refused by the customer gate, so the stand-in can never be signed into.
    const standInId = typeof clientHubStore.previewStandInId === 'function' ? clientHubStore.previewStandInId('cl_one') : 'c0ffee00-0000-4000-8000-000000000001';
    db.tables.client_users.push({ id: standInId, organization_id: ORG, name: 'Preview customer', email: STAND_IN_EMAIL_ONE, phone: null, status: 'preview', auth_user_id: null, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z' });
    AUTH['tok-standin'] = { id: 'a-standin', email: STAND_IN_EMAIL_ONE, app_metadata: { role: 'client', client_user_id: standInId, org_id: ORG } };
    const si = await (async () => {
      const { sink, res } = res402();
      const out = await quiet(() => authz.requireClientUser(hdr('tok-standin'), res));
      return { out, status: sink.statusCode, body: sink.body };
    })();
    ok('🔴 C23 requireClientUser refuses a login naming the preview\'s stand-in (status preview holds no access): 403 account-disabled',
      typeof clientHubStore.previewStandInId === 'function' && si.out === null && si.status === 403 && si.body?.code === 'account-disabled');
    delete AUTH['tok-standin'];
    db.tables.client_users = db.tables.client_users.filter((u) => u.id !== standInId);
    // A group grants every building in it, INCLUDING one added to the group afterwards
    // (HUB-17), and a group assignment is resolved live rather than copied onto the person.
    db.tables.client_user_assignments = [
      { id: 'as-g', organization_id: ORG, client_user_id: CU_ID, client_id: null, group_id: 'g-1', created_at: '2026-10-01T00:00:00Z' },
    ];
    db.tables.client_user_groups = [{ id: 'g-1', organization_id: ORG, name: 'Harbor Holdings', kind: 'management', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }];
    db.tables.client_user_group_members = [{ organization_id: ORG, group_id: 'g-1', client_id: 'cl_two', created_at: '2026-10-01T00:00:00Z' }];
    // A group this login is NOT assigned, holding a building they can see: never named to them.
    db.tables.client_user_groups.push({ id: 'g-other', organization_id: ORG, name: 'ZZ Other Group', kind: 'city', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
    db.tables.client_user_group_members.push({ organization_id: ORG, group_id: 'g-other', client_id: 'cl_two', created_at: '2026-10-01T00:00:00Z' });
    r = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'view' } }));
    ok('🔴 C11 a GROUP assignment grants its buildings, resolved live at request time (HUB-17)',
      r.status === 200 && (r.body?.buildings || []).map((b) => b.id).join(',') === 'cl_two');
    const groups = r.body?.groups || [];
    ok('🔴 C18 the view names the groups this login is ASSIGNED, exactly their allowlist, with their in-scope buildings — never another group',
      groups.length === 1 && groups[0].id === 'g-1' && groups[0].name === 'Harbor Holdings'
        && Object.keys(groups[0]).sort().join(',') === [...HUB_GROUP_FIELDS].sort().join(',')
        && groups[0].buildingIds.join(',') === 'cl_two' && !JSON.stringify(r.body).includes('ZZ Other Group'));
    db.tables.client_user_group_members.push({ organization_id: ORG, group_id: 'g-1', client_id: 'cl_one', created_at: '2026-10-02T00:00:00Z' });
    r = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'view' } }));
    ok('C12 …and a building added to the group afterwards appears with no change to the person',
      (r.body?.buildings || []).map((b) => b.id).sort().join(',') === 'cl_one,cl_two'
        && (r.body?.groups?.[0]?.buildingIds || []).join(',') === 'cl_one,cl_two');
    // A customer the office deleted grants nothing, even with the assignment row still there.
    committed().state.clients = committed().state.clients.filter((x) => x.id !== 'cl_two');
    r = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'view' } }));
    ok('🔴 C13 a removed customer drops out of the scope, stale membership row and all',
      (r.body?.buildings || []).map((b) => b.id).join(',') === 'cl_one');
    reset();
  } else {
    ok('C0 the hub route exists at app/api/hub/[...path].js', false);
  }

  // ── D. Round 2: EVERY hub route — scope, audience and allowlists ─────────────
  // The rule for each new branch is the one Round 1 set for /hub/view: it starts from the
  // login's own scope (allowedIds), so a building, checklist, inspection or ticket outside it
  // is a 404 that never confirms the record exists; a staff login with no preview header is
  // refused before anything is read (with the header and hub.users.view it previews, acting as the
  // building's stand-in customer, or read-only with the switch off — D6b/D6c below and
  // test-hub-preview.mjs); and every served object is exactly its allowlist
  // (src/lib/clientHubView.js).
  if (hub) {
    reset();
    db.tables.jobs = HUB_JOBS();
    const V = hubView;
    // The branches, each asked for the ASSIGNED building and for the one this login never got.
    const reads = [
      ['home', (b) => `home?buildingId=${b}`],
      ['visit', (b) => `visit?buildingId=${b}`],
      ['checklists', (b) => `checklists?buildingId=${b}`],
      ['checklist', (b, n) => `checklist?buildingId=${b}&id=${R2[`ck${n}`]}`],
      ['inspections', (b) => `inspections?buildingId=${b}`],
      ['inspection', (b, n) => `inspection?buildingId=${b}&id=${R2[`in${n}`]}`],
      ['inspection-pdf', (b, n) => `inspection-pdf?buildingId=${b}&id=${R2[`in${n}`]}`],
      ['tickets', (b) => `tickets?buildingId=${b}`],
      ['ticket', (b, n) => `ticket?buildingId=${b}&id=${R2[`tk${n}`]}`],
      ['history', (b) => `history?buildingId=${b}`],
    ];
    const writes = [
      ['ticket-create', (b) => ({ id: 'd4000000-0000-4000-8000-000000000001', buildingId: b, type: 'request', category: 'other', description: 'Please' })],
      ['ticket-message', (b, n) => ({ id: 'd5000000-0000-4000-8000-000000000001', buildingId: b, ticketId: R2[`tk${n}`], body: 'Hello' })],
      ['ticket-reopen', (b, n) => ({ buildingId: b, ticketId: R2[`tk${n}`] })],
      ['ticket-photo-url', (b, n) => ({ buildingId: b, ticketId: R2[`tk${n}`], mimeType: 'image/jpeg', sizeBytes: 100 })],
      ['ticket-photo', (b, n) => ({ buildingId: b, ticketId: R2[`tk${n}`], storagePath: `${ORG}/st_loc_${b}/abcdef0123456789.jpg`, mimeType: 'image/jpeg', sizeBytes: 100 })],
    ];
    const subpath = (p) => p.split('?')[0];
    const query = (p) => ({ subpath: subpath(p), ...Object.fromEntries(new URLSearchParams(p.split('?')[1] || '')) });

    for (const [name, mk] of reads) {
      const out = await quiet(() => call(hub, { token: 'tok-client', query: query(mk('cl_two', 2)) }));
      ok(`🔴 D1 GET /api/hub/${name} for a building this login was never given is a 404`, out.status === 404 && out.body?.code === 'not-found');
      ok(`🔴 D2 …and the 404 names nothing from that building`, out.status === 404 && out.body?.code === 'not-found' && !JSON.stringify(out.body || {}).includes('Palm Center'));
      // A detail route names a building AND a record: the other building's record, asked
      // through the building this login does hold, is still a 404.
      if (['checklist', 'inspection', 'inspection-pdf', 'ticket'].includes(name)) {
        const crossed = await quiet(() => call(hub, { token: 'tok-client', query: query(mk('cl_one', 2)) }));
        ok(`🔴 D3 GET /api/hub/${name}: another building's record asked through MY building is a 404`, crossed.status === 404 && crossed.body?.code === 'not-found');
      }
      const staff = await quiet(() => call(hub, { token: 'tok-owner', query: query(mk('cl_one', 1)) }));
      ok(`🔴 D4 GET /api/hub/${name} refuses a STAFF login with no preview header (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login');
    }
    for (const [name, mk] of writes) {
      const out = await quiet(() => call(hub, { method: 'POST', token: 'tok-client', query: { subpath: name }, body: mk('cl_two', 2) }));
      ok(`🔴 D5 POST /api/hub/${name} for a building this login was never given is a 404`, out.status === 404 && out.body?.code === 'not-found');
      const staff = await quiet(() => call(hub, { method: 'POST', token: 'tok-owner', query: { subpath: name }, body: mk('cl_one', 1) }));
      ok(`🔴 D6 POST /api/hub/${name} refuses a STAFF login with no preview header (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login');
      // WITH the header and hub.users.view it is the office's preview (2026-10-09: it ACTS as the
      // building's stand-in customer; HUB_PREVIEW_ACTS_AS_CUSTOMER off brings back read-only).
      PV.__setHubPreviewActsForTests?.(false);
      const readOnly = await quiet(() => call(hub, { method: 'POST', token: 'tok-owner', query: { subpath: name }, body: mk('cl_one', 1), headers: { [PREVIEW_HEADER]: 'cl_one' } }));
      PV.__setHubPreviewActsForTests?.(undefined);
      ok(`🔴 D6b POST /api/hub/${name} WITH the header, the switch off: a read-only preview writes nothing (403 preview-read-only)`,
        typeof PV.__setHubPreviewActsForTests === 'function' && readOnly.status === 403 && !!PV.HUB_PREVIEW_READ_ONLY && readOnly.body?.code === PV.HUB_PREVIEW_READ_ONLY);
      const standIn = typeof clientHubStore.previewStandInId === 'function' ? clientHubStore.previewStandInId('cl_one') : null;
      if (standIn && !db.tables.client_users.some((u) => u.id === standIn)) {
        // This suite's fake is read-only, so the building's stand-in is seeded as the first preview
        // would create it (test-hub-preview.mjs drives the creation and the writes themselves).
        db.tables.client_users.push({ id: standIn, organization_id: ORG, name: 'Preview customer', email: STAND_IN_EMAIL_ONE, phone: null, status: 'preview', auth_user_id: null, email_prefs: null, updates_seen_at: null, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z' });
      }
      const acting = await quiet(() => call(hub, { method: 'POST', token: 'tok-owner', query: { subpath: name }, body: mk('cl_one', 1), headers: { [PREVIEW_HEADER]: 'cl_one' } }));
      ok(`🔴 D6c POST /api/hub/${name} WITH the header, the switch on (the default): the preview is no longer refused — it reaches the branch as the building's stand-in`,
        !!standIn && acting.status !== 401 && acting.status !== 403 && acting.body?.code !== PV.HUB_PREVIEW_READ_ONLY);
    }
    // Every served object is EXACTLY its allowlist — compared against the constants, never a
    // restated literal, so a field added to a source row can never reach a client by default.
    const exact = (o, list) => !!o && Array.isArray(list) && Object.keys(o).sort().join(',') === [...list].sort().join(',');
    // The redesign's two reads (2026-10-08): Home (EP-305) and Today's Visit (EP-306).
    const h = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'home', buildingId: 'cl_one' } }));
    ok('🔴 D7 home: exactly HUB_HOME_FIELDS; the building HUB_BUILDING_FIELDS; the crew band HUB_CREW_FIELDS; the counts theirs',
      h.status === 200 && exact(h.body, VH.HUB_HOME_FIELDS) && exact(h.body?.building, HUB_BUILDING_FIELDS)
        && exact(h.body?.crew, VV.HUB_CREW_FIELDS) && exact(h.body?.crew?.crew, VV.HUB_CREW_PEOPLE_FIELDS)
        && exact(h.body?.requests, VH.HUB_REQUEST_COUNT_FIELDS) && exact(h.body?.checklists, VH.HUB_CHECKLIST_TILE_FIELDS)
        && exact(h.body?.inspections, VH.HUB_INSPECTION_TILE_FIELDS) && h.body.crew.state === 'on_site');
    const vis = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'visit', buildingId: 'cl_one' } }));
    ok('🔴 D7b visit: exactly HUB_VISIT_FIELDS; each person on site HUB_ON_SITE_FIELDS; each step HUB_TIMELINE_FIELDS; the photos and the visits theirs',
      vis.status === 200 && exact(vis.body, VV.HUB_VISIT_FIELDS) && exact(vis.body?.crew, VV.HUB_CREW_FIELDS)
        && (vis.body?.onSite || []).length === 1 && vis.body.onSite.every((p) => exact(p, V.HUB_ON_SITE_FIELDS))
        && (vis.body?.timeline || []).every((s) => exact(s, VV.HUB_TIMELINE_FIELDS)) && exact(vis.body?.photos, VV.HUB_VISIT_PHOTOS_FIELDS)
        && (vis.body?.upcoming || []).length === 1 && vis.body.upcoming.every((u) => exact(u, VV.HUB_UPCOMING_FIELDS))
        && exact(vis.body?.manager, VV.HUB_MANAGER_FIELDS));
    const both = JSON.stringify([h.body, vis.body]);
    // (The building's supervisor keeps their id: the Round 1 projection, HUB_SUPERVISOR_FIELDS.)
    ok('🔴 D7c …and no full staff name, cleaner id, job id or job note reaches either (first name + last initial only)',
      h.status === 200 && vis.status === 200 && both.includes('Casey C.') && both.includes('Dana O.')
        && !/Casey Crew|Dana Owner|u_crew|j-one|j-two|ZZJOBNOTEZZ|crewIds|crew_ids/.test(both));
    const lists = [
      ['checklists', V.HUB_CHECKLIST_ROW_FIELDS], ['inspections', V.HUB_INSPECTION_ROW_FIELDS],
      ['tickets', V.HUB_TICKET_ROW_FIELDS], ['history', V.HUB_EVENT_FIELDS],
    ];
    for (const [name, fields] of lists) {
      const r = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: name, buildingId: 'cl_one' } }));
      const rows = r.body?.rows || r.body?.events || [];
      ok(`🔴 D8 ${name}: every row is exactly its allowlist (${rows.length} row(s))`, r.status === 200 && rows.length > 0 && rows.every((x) => exact(x, fields)));
    }
    const ckd = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'checklist', buildingId: 'cl_one', id: R2.ck1 } }));
    ok('🔴 D9 checklist: exactly HUB_CHECKLIST_FIELDS', ckd.status === 200 && exact(ckd.body?.checklist, V.HUB_CHECKLIST_FIELDS));
    const ind = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'inspection', buildingId: 'cl_one', id: R2.in1 } }));
    ok('🔴 D10 inspection: exactly HUB_INSPECTION_FIELDS, and never the internal note or the share token',
      ind.status === 200 && exact(ind.body?.inspection, V.HUB_INSPECTION_FIELDS) && !/ZZNOTEZZ|tok-1/.test(JSON.stringify(ind.body)));
    const tkd = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'ticket', buildingId: 'cl_one', id: R2.tk1 } }));
    ok('🔴 D11 ticket: exactly HUB_TICKET_FIELDS, each message HUB_MESSAGE_FIELDS',
      tkd.status === 200 && exact(tkd.body?.ticket, V.HUB_TICKET_FIELDS) && (tkd.body.ticket.messages || []).every((m) => exact(m, V.HUB_MESSAGE_FIELDS)));
    ok('D12 the sweep is not vacuous: every hub branch was asked for both buildings', reads.length === 10 && writes.length === 5);
    reset();
  }

  // ── D'. the client hub redesign's messages, updates and email switches (Builder B) ──
  // The building-scoped branches hold the D1..D6 rule; the login-scoped ones (the bell, the
  // email switches) name no building, so they are held to "a staff login is refused" and "it
  // answers the customer's own login" — and every one must ANSWER the assigned building, which is
  // what fails on a tree that does not have them (a missing branch is also a 404).
  if (hub) {
    reset();
    db.tables.client_messages = [
      { id: 'd6000000-0000-4000-8000-000000000001', organization_id: ORG, client_id: 'cl_one', author_role: 'staff', author_client_user_id: null, author_user_id: 'u_owner', author_name: 'Dana Owner', body: 'Hello from the office', created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: 'd6000000-0000-4000-8000-000000000002', organization_id: ORG, client_id: 'cl_two', author_role: 'staff', author_client_user_id: null, author_user_id: 'u_owner', author_name: 'Dana Owner', body: 'ZZPALMZZ not yours', created_at: new Date(Date.now() - 3600000).toISOString() },
    ];
    db.tables.client_message_threads = [];
    db.tables.client_message_reads = [];
    const subpathOf = (p) => p.split('?')[0];
    const queryOf = (p) => ({ subpath: subpathOf(p), ...Object.fromEntries(new URLSearchParams(p.split('?')[1] || '')) });
    const scoped = [['messages', (b) => `messages?buildingId=${b}`]];
    const scopedWrites = [
      ['message', (b) => ({ id: 'd7000000-0000-4000-8000-000000000001', buildingId: b, body: 'Hello' })],
      ['messages-read', (b) => ({ buildingId: b })],
    ];
    for (const [name, mk] of scoped) {
      const mineR = await quiet(() => call(hub, { token: 'tok-client', query: queryOf(mk('cl_one')) }));
      ok(`🔴 D13 GET /api/hub/${name} answers the assigned building`, mineR.status === 200);
      const out = await quiet(() => call(hub, { token: 'tok-client', query: queryOf(mk('cl_two')) }));
      ok(`🔴 D14 GET /api/hub/${name} for a building this login was never given is a 404 that names nothing`, out.status === 404 && out.body?.code === 'not-found' && !/ZZPALMZZ|Palm Center/.test(JSON.stringify(out.body || {})));
      const staff = await quiet(() => call(hub, { token: 'tok-owner', query: queryOf(mk('cl_one')) }));
      ok(`🔴 D15 GET /api/hub/${name} refuses a STAFF login with no preview header (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login');
    }
    for (const [name, mk] of scopedWrites) {
      const out = await quiet(() => call(hub, { method: 'POST', token: 'tok-client', query: { subpath: name }, body: mk('cl_two') }));
      ok(`🔴 D16 POST /api/hub/${name} for a building this login was never given is a 404`, out.status === 404 && out.body?.code === 'not-found');
      const staff = await quiet(() => call(hub, { method: 'POST', token: 'tok-owner', query: { subpath: name }, body: mk('cl_one') }));
      ok(`🔴 D17 POST /api/hub/${name} refuses a STAFF login with no preview header (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login');
    }
    for (const name of ['updates', 'email-prefs']) {
      const mineR = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: name } }));
      ok(`🔴 D18 GET /api/hub/${name} answers the customer's own login`, mineR.status === 200);
      const staff = await quiet(() => call(hub, { token: 'tok-owner', query: { subpath: name } }));
      ok(`🔴 D19 GET /api/hub/${name} refuses a STAFF login with no preview header (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login');
    }
    const upd = await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'updates' } }));
    ok('🔴 D20 the bell carries only the assigned building\'s news, each item exactly its allowlist',
      upd.status === 200 && (upd.body?.updates || []).length > 0 && (upd.body.updates || []).every((u) => u.buildingId === 'cl_one')
        && !/ZZPALMZZ/.test(JSON.stringify(upd.body)) && !!hubMessages.HUB_UPDATE_FIELDS
        && (upd.body.updates || []).every((u) => Object.keys(u).sort().join(',') === [...hubMessages.HUB_UPDATE_FIELDS].sort().join(',')));
    for (const name of ['updates-seen', 'email-prefs']) {
      const staff = await quiet(() => call(hub, { method: 'POST', token: 'tok-owner', query: { subpath: name }, body: { messages: false } }));
      ok(`🔴 D21 POST /api/hub/${name} refuses a STAFF login with no preview header (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login');
    }
    ok('D22 the redesign sweep is not vacuous', scoped.length === 1 && scopedWrites.length === 2);
    reset();
  }

  // ── E. the OFFICE's customer-messages family refuses a CUSTOMER login ─────────────
  // /api/client-messages/* gates on hub.messages.view / .reply through requirePermission, which
  // runs requireAuthority — and that refuses role 'client' before any key is read. A customer
  // can read and write their building's thread only through /api/hub/*.
  {
    const cmPath = path.join(API, 'client-messages', '[...path].js');
    const cm = existsSync(cmPath) ? await load('api/client-messages/[...path].js') : null;
    ok('E0 the office family exists at app/api/client-messages/[...path].js', !!cm);
    if (cm) {
      const branches = [
        ['GET', { subpath: 'threads' }],
        ['GET', { subpath: 'thread', clientId: 'cl_one' }],
        ['POST', { subpath: 'send' }, { id: 'd8000000-0000-4000-8000-000000000001', clientId: 'cl_one', body: 'Hi' }],
        ['POST', { subpath: 'read' }, { clientId: 'cl_one' }],
      ];
      for (const [method, query, body] of branches) {
        for (const tok of ['tok-client', 'tok-client-oncrew', 'tok-client-orguser']) {
          const r = await quiet(() => call(cm, { token: tok, method, query, body }));
          ok(`🔴 E1 ${method} /api/client-messages/${query.subpath} refuses the customer login ${tok} (403 client-login)`, refusedClient(r));
        }
        const anon = await quiet(() => call(cm, { method, query, body }));
        ok(`E2 ${method} /api/client-messages/${query.subpath} with no login is a 401`, anon.status === 401);
      }
    }
  }
  // ── F. the client hub redesign: invoices + documents (Builder C) ────────────
  // The office's new family, /api/customer-documents/*, is an OFFICE surface: a client login is
  // refused there by the central rule (403 client-login), in each of the three configurations B
  // proved for the gates. The hub's four new branches follow D's rule: the assigned building
  // answers, the other one is a 404 that names nothing, a staff login is refused.
  {
    reset();
    const docsPath = path.join(API, 'customer-documents', '[...path].js');
    const docsRoute = existsSync(docsPath) ? await load('api/customer-documents/[...path].js') : null;
    ok('F0 the office documents family exists (app/api/customer-documents/[...path].js)', !!docsRoute);
    const officeBranches = [
      ['GET', 'list', { clientId: 'cl_one' }], ['GET', 'view-url', { id: R2.doc1 }],
      ['POST', 'upload-url'], ['POST', 'confirm'], ['POST', 'update'], ['POST', 'replace'], ['POST', 'delete'],
    ];
    for (const [method, sub, q = {}] of officeBranches) {
      for (const tok of ['tok-client', 'tok-client-oncrew', 'tok-client-orguser']) {
        const out = docsRoute
          ? await quiet(() => call(docsRoute, { token: tok, method, query: { subpath: sub, ...q }, body: { id: R2.doc1, clientId: 'cl_one' } }))
          : { status: 0 };
        ok(`🔴 F1 ${method} /api/customer-documents/${sub} refuses a client login (${tok}): 403 client-login`, refusedClient(out));
      }
    }
    const control = docsRoute ? await quiet(() => call(docsRoute, { token: 'tok-owner', query: { subpath: 'list', clientId: 'cl_one' } })) : { status: 0 };
    ok('F2 control: the owner reads the office list', control.status === 200 && Array.isArray(control.body?.documents));
    const hubReads = [
      ['invoices', (b) => ({ buildingId: b })],
      ['invoice-pdf', (b) => ({ buildingId: b, id: '1001' })],
      ['documents', (b) => ({ buildingId: b })],
      ['document-url', (b) => ({ buildingId: b, id: b === 'cl_one' ? R2.doc1 : R2.doc2 })],
    ];
    for (const [name, mk] of hubReads) {
      const out = hub ? await quiet(() => call(hub, { token: 'tok-client', query: { subpath: name, ...mk('cl_two') } })) : { status: 0 };
      ok(`🔴 F3 GET /api/hub/${name} for a building this login was never given is a 404 that names nothing`, out.status === 404 && out.body?.code === 'not-found' && !JSON.stringify(out.body || {}).includes('cl_two'));
      const staff = hub ? await quiet(() => call(hub, { token: 'tok-owner', query: { subpath: name, ...mk('cl_one') } })) : { status: 0 };
      ok(`🔴 F4 GET /api/hub/${name} refuses a STAFF login with no preview header (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login');
    }
    const crossed = hub ? await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'document-url', buildingId: 'cl_one', id: R2.doc2 } })) : { status: 0 };
    ok('🔴 F5 another building\'s document asked through MY building is a 404', crossed.status === 404 && crossed.body?.code === 'not-found');
    const mine = hub ? await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'documents', buildingId: 'cl_one' } })) : { status: 0 };
    ok('F6 my building\'s documents answer, and only its own', mine.status === 200 && (mine.body?.documents || []).map((d) => d.id).join() === R2.doc1);
    const bills = hub ? await quiet(() => call(hub, { token: 'tok-client', query: { subpath: 'invoices', buildingId: 'cl_one' } })) : { status: 0 };
    ok('F7 my building\'s invoices answer (QuickBooks not connected here: the state, no rows)', bills.status === 200 && bills.body?.state === 'not-connected' && (bills.body?.rows || []).length === 0);
    ok('F8 the sweep is not vacuous', officeBranches.length === 7 && hubReads.length === 4);
    reset();
  }
} finally {
  server.close();
}

console.log(`\nclient logins reach the hub and nothing else: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
