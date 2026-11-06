// A ticket with no location can always be closed: a new one needs a location, and the office can
// give an old one its location (CS-697; CS-128's "require a site").
//
// WO-10 needs a completion photo to resolve a ticket, and a photo is filed under the ticket's
// building (`/api/account-media` refuses an upload with no site). A failed inspection started with
// "no specific location", or a work order logged with that default, opened a ticket with no site:
// the drawer said "a ticket cannot be resolved without one", Mark resolved stayed disabled, the
// server answered 409 photo-required, and the ticket sat in Client Requests overdue forever.
//
// Held here through the REAL api/qc handler over the loopback Supabase fake (fake-supabase.mjs —
// never production), and through the demo stub (lib/qcApi):
//   L1–L4  a work order and an inspection cannot be started without a location (400 location-required),
//          nor at a location that is not the company's; with one they are
//   L5–L9  the office sets a location on a ticket that has none — the building, its customer and
//          their names are filed on it — and the ticket can then carry its photo and be resolved
//   L10–L14 only the office; only a ticket with none (the predicate rides on the update: 409 when
//          it already has one, which never moves); only one of the ticket's own customer's
//          locations; another organization's ticket is a 404
//   L15–L18 the demo stub refuses and sets exactly the same way
//   L19–L21 the screens: Start and Log work order wait for a location; the drawer offers the
//          office the location picker on a ticket with none, and tells crew to ask the office
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`186fffb0`) L1–L3, L5–L9, L10–L13, L15–L18
// and L19–L21 fail: both creates take a missing location, and problems/update ignores `siteId`.
//
//   node app/scripts/test-ticket-location.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { installResolveShim } from './deletion-core.mjs';

const ORG = '00000000-0000-0000-0000-000000000017';
const OTHER_ORG = '00000000-0000-0000-0000-000000000099';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
installResolveShim(); // the stub (lib/qcApi) is written for Vite's extensionless imports

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const wo = await import('../src/lib/workOrders.js');
const core = await import('../src/i18n/core.js');
const qc = (await import('../api/qc/[...path].js')).default;
// The codes, read off the shared module (fallbacks only so the pre-fix run reports what it wanted).
const CODES = wo.LOCATION_CODES || { required: 'location-required', unknown: 'location-unknown', set: 'location-set', officeOnly: 'location-office-only', otherCustomer: 'location-other-customer' };

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

// ── the fixture ──────────────────────────────────────────────────────────────
const user = (id, role) => ({ id, role, status: 'active', name: `${id} name`, email: `${id}@example.test` });
const USERS = [user('u_o', 'owner'), user('u_m', 'manager'), user('u_c', 'crew')];
const login = (role, id) => ({ id: `auth-${id}`, email: `${id}@example.test`, app_metadata: { role, org_user_id: id, org_id: ORG } });
const LOGINS = { 'tok-owner': login('owner', 'u_o'), 'tok-mgr': login('manager', 'u_m'), 'tok-crew': login('crew', 'u_c') };
const CLIENTS = [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_m' }, { id: 'c2', name: 'Lakeside Towers', supervisorId: 'u_m' }];
const SITES = [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }, { id: 's2', clientId: 'c2', name: 'Tower A' }];
const SNAP_SCHEMA = { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Floor' }] }] };
const T_NOLOC = 'c0000000-0000-4000-8000-000000000001';   // a failed inspection's ticket, no location
const T_CUST = 'c0000000-0000-4000-8000-000000000002';    // a customer's ticket with no location (c1)
const T_OTHER = 'c0000000-0000-4000-8000-000000000003';   // another organization's ticket
const T_CREW = 'c0000000-0000-4000-8000-000000000004';    // a cleaner's own report, no location (in their scope)
const ticket = (id, o = {}) => ({
  id, organization_id: ORG, client_id: null, site_id: null, job_id: null, client_name: null, site_name: null,
  title: 'Failed inspection Oct 12', description: null, type: 'failed_inspection', origin: 'internal', category: null,
  priority: 'medium', status: 'open', assignee_user_id: null, reported_by_user_id: 'u_m', escalated_at: null,
  created_at: '2026-10-12T15:00:00.000Z', due_at: '2026-10-14T15:00:00.000Z', resolved_at: null, ...o,
});

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 58, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: USERS, clients: CLIENTS, sites: SITES, permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
        },
      }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      jobs: [],
      time_entries: [],
      inspection_templates: [{ id: 'it_i', organization_id: ORG, name: 'Nightly QC', kind: 'inspection', is_published: true, published_version_id: 'v_i', rating_scale: { type: 'passfail', passThreshold: 80 } }],
      inspection_template_versions: [{ id: 'v_i', template_id: 'it_i', version_number: 1, status: 'published', schema: SNAP_SCHEMA }],
      inspection_records: [],
      inspection_items: [],
      problem_reports: [ticket(T_NOLOC), ticket(T_CUST, { client_id: 'c1', client_name: 'Coral Bay HOA', type: 'issue', title: 'Leak' }), ticket(T_OTHER, { organization_id: OTHER_ORG }), ticket(T_CREW, { reported_by_user_id: 'u_c', type: 'issue', title: 'Spill' })],
      work_order_messages: [],
      account_media: [],
      activity_log: [],
      client_users: [],
    },
    logins: LOGINS,
  });
}

async function call(method, subpath, { token = 'tok-owner', body = null, query = {} } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { authorization: `Bearer ${token}` };
  req.query = { subpath, ...query };
  req.body = body || {};
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
      Promise.resolve(qc(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const post = (sub, body, token) => call('POST', sub, { body, token });
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 200)}`;
const row = (id) => (world.tables.problem_reports || []).find((p) => p.id === id) || {};
const tickets = () => world.tables.problem_reports || [];

// ── L1–L4: nothing starts without a location ─────────────────────────────────
{
  seed();
  const before = tickets().length;
  const a = await post('problems/create', { title: 'Broken dispenser', type: 'issue' });
  ok('🔴 L1 a work order with no location is refused (400 location-required), and nothing is written',
    a.status === 400 && a.body?.code === CODES.required && tickets().length === before, show(a));
  const b = await post('problems/create', { title: 'Broken dispenser', siteId: 's_nowhere' });
  ok('🔴 L2 …and one at a location that is not the company\'s (400 location-unknown)', b.status === 400 && b.body?.code === CODES.unknown, show(b));
  const c = await post('problems/create', { title: 'Broken dispenser', siteId: 's2' });
  ok('L3 with a location it is logged there, its customer taken from the location', c.status === 200 && c.body?.problem?.site_id === 's2' && c.body?.problem?.client_id === 'c2', show(c));
  const d = await post('inspections/create', { templateId: 'it_i' });
  ok('🔴 L4a an inspection cannot be started with no location (400 location-required), and no record is made',
    d.status === 400 && d.body?.code === CODES.required && (world.tables.inspection_records || []).length === 0, show(d));
  const e = await post('inspections/create', { templateId: 'it_i', siteId: 's1', clientId: 'c1' });
  ok('L4b …with one it starts', e.status === 200 && e.body?.inspection?.site_id === 's1', show(e));
}

// ── L5–L9: the office gives a ticket with none its location; then it can be closed ──
{
  seed();
  const blocked = await post('problems/update', { id: T_NOLOC, status: 'resolved' });
  ok('L5 a ticket with no location cannot be resolved (no photo can be filed): 409 photo-required', blocked.status === 409 && blocked.body?.code === wo.RESOLVE_PHOTO_CODE, show(blocked));
  const r = await post('problems/update', { id: T_NOLOC, siteId: 's1' });
  ok('🔴 L6 the office sets its location', r.status === 200 && row(T_NOLOC).site_id === 's1', `${show(r)} → ${row(T_NOLOC).site_id}`);
  ok('🔴 L7 …the location\'s customer and both names are filed with it', row(T_NOLOC).client_id === 'c1' && row(T_NOLOC).site_name === 'Clubhouse' && row(T_NOLOC).client_name === 'Coral Bay HOA',
    JSON.stringify(row(T_NOLOC)));
  ok('🔴 L8 …and the route answers the ticket as it now is', r.body?.problem?.site_id === 's1' && r.body?.problem?.id === T_NOLOC, show(r));
  // the completion photo the drawer's gallery can now file (an account_media row at the ticket's site)
  world.tables.account_media.push({ id: 'am1', organization_id: ORG, scope: 'problem_report', ref_id: T_NOLOC, site_id: 's1', client_id: 'c1', kind: 'image', mime_type: 'image/jpeg', storage_path: `${ORG}/s1/am1.jpg`, created_at: '2026-10-13T12:00:00.000Z' });
  const done = await post('problems/update', { id: T_NOLOC, status: 'resolved' });
  ok('🔴 L9 …so with its photo it can be resolved at last', done.status === 200 && row(T_NOLOC).status === 'resolved', show(done));
}

// ── L10–L14: who, which ticket, which location ──────────────────────────────
{
  seed();
  const crew = await post('problems/update', { id: T_CREW, siteId: 's1' }, 'tok-crew');
  ok('🔴 L10 a cleaner cannot set a ticket\'s location (403 location-office-only)', crew.status === 403 && crew.body?.code === CODES.officeOnly && row(T_CREW).site_id === null, show(crew));
  await post('problems/update', { id: T_NOLOC, siteId: 's1' }, 'tok-mgr');
  const again = await post('problems/update', { id: T_NOLOC, siteId: 's2' }, 'tok-owner');
  ok('🔴 L11 a ticket that has a location keeps it: a second set is 409 location-set, and nothing moves',
    again.status === 409 && again.body?.code === CODES.set && row(T_NOLOC).site_id === 's1' && row(T_NOLOC).client_id === 'c1', `${show(again)} → ${row(T_NOLOC).site_id}`);
  const other = await post('problems/update', { id: T_CUST, siteId: 's2' });
  ok('🔴 L12 a customer\'s ticket takes only that customer\'s location (400 location-other-customer)', other.status === 400 && other.body?.code === CODES.otherCustomer && row(T_CUST).site_id === null, show(other));
  const unknown = await post('problems/update', { id: T_CUST, siteId: 's_nowhere' });
  ok('🔴 L13 a location that is not the company\'s is refused (400 location-unknown)', unknown.status === 400 && unknown.body?.code === CODES.unknown, show(unknown));
  const foreign = await post('problems/update', { id: T_OTHER, siteId: 's1' });
  ok('L14 another organization\'s ticket is a 404, and is not touched', foreign.status === 404 && row(T_OTHER).site_id === null, show(foreign));
}

// ── L15–L18: the demo stub, the same rules ───────────────────────────────────
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
  globalThis.window = { __ppGetState: () => ({ company: { timezone: 'America/New_York' }, users: USERS, clients: CLIENTS, sites: SITES, jobs: [] }) };
  const { QC_PROBLEMS_STUB_KEY, QC_TEMPLATES_STUB_KEY } = await import('../src/data/stubKeys.js');
  mem.set(QC_PROBLEMS_STUB_KEY, JSON.stringify({ problems: [{ ...ticket(T_NOLOC), messages: [] }] }));
  mem.set(QC_TEMPLATES_STUB_KEY, JSON.stringify({ templates: [{ id: 'it_i', name: 'Nightly QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, is_published: true, published_version_id: 'v_i', versions: [{ id: 'v_i', version_number: 1, schema: SNAP_SCHEMA, status: 'published' }] }] }));
  let qcApi = {};
  try { qcApi = await import('../src/lib/qcApi.js'); } catch (e) { fails.push(`the stub loads (${e.message})`); }
  const run = async (name, ...args) => { try { return await qcApi[name](...args); } catch (e) { return { __error: e }; } };
  const stubRow = (id) => (JSON.parse(mem.get(QC_PROBLEMS_STUB_KEY) || '{"problems":[]}').problems || []).find((p) => p.id === id) || {};
  const a = await run('createProblem', { title: 'No place', type: 'issue' });
  ok('🔴 L15 the stub refuses a work order with no location, with the server\'s code', a?.__error?.code === CODES.required && a.__error.status === 400, String(a?.__error?.message || JSON.stringify(a)));
  const b = await run('createInspection', { templateId: 'it_i' });
  ok('🔴 L16 …and an inspection with none', b?.__error?.code === CODES.required, String(b?.__error?.message || JSON.stringify(b)));
  const c = await run('updateProblem', { id: T_NOLOC, siteId: 's1' });
  ok('🔴 L17 the stub sets a location on a ticket with none, with its customer and names', c?.site_id === 's1' && stubRow(T_NOLOC).client_id === 'c1' && stubRow(T_NOLOC).site_name === 'Clubhouse',
    JSON.stringify(c?.__error?.message || stubRow(T_NOLOC)));
  const d = await run('updateProblem', { id: T_NOLOC, siteId: 's2' });
  ok('🔴 L18 …and refuses to move it once set (409 location-set)', d?.__error?.status === 409 && d.__error.code === CODES.set && stubRow(T_NOLOC).site_id === 's1', String(d?.__error?.message));
}

// ── L19–L21: the screens ─────────────────────────────────────────────────────
{
  const fill = read('src/components/InspectionFill.jsx');
  const modal = read('src/components/WorkOrderModal.jsx');
  const drawer = read('src/components/WorkOrderDrawer.jsx');
  const has = (k) => typeof core.SOURCE_CATALOG[k] === 'string' && core.SOURCE_CATALOG[k].length > 0;
  ok('🔴 L19 New inspection: Start waits for a location, and the field asks for one (no "no specific location")',
    /disabled=\{[^}]*!siteId[^}]*\}[^>]*onClick=\{\(\) => start\(templateId\)\}/.test(fill) && /t\('inspectionFill\.pickLocation'\)/.test(fill) && has('inspectionFill.pickLocation')
    && !/inspectionFill\.noLocation/.test(fill) && !has('inspectionFill.noLocation'));
  ok('🔴 L20 New work order: Log work order waits for a location, asked for in the catalog\'s words',
    /disabled=\{[^}]*!form\.siteId[^}]*\}/.test(modal) && /t\('workOrders\.modal\.pickLocation'\)/.test(modal) && !/no specific location/.test(modal) && has('workOrders.modal.pickLocation'));
  ok('🔴 L21 the drawer offers the office the location picker on a ticket with none (onUpdate siteId), and tells a cleaner to ask the office',
    /onUpdate\(wo\.id, \{ siteId/.test(drawer) && /t\('workOrders\.drawer\.setLocation'\)/.test(drawer) && /t\('workOrders\.drawer\.askOffice'\)/.test(drawer)
    && has('workOrders.drawer.setLocation') && has('workOrders.drawer.askOffice') && !/No location set, so photos can’t be attached — and a ticket cannot be resolved without one\./.test(drawer));
}

console.log(`\ntest-ticket-location: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
