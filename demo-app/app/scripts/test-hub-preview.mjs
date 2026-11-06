// PREVIEW AS CUSTOMER — the office opens the customer hub as one building's customers see it, with
// no customer login (the client hub redesign, plan 2026-10-08 §3.7, decision D2), and since
// 2026-10-09 ACTS as that building's customer (Daniel: "swapping the role should simulate being
// signed into that account for now"): every write works, as the building's STAND-IN customer login,
// and reaches the office exactly as a real customer's would. One switch,
// src/lib/hubPreview.js HUB_PREVIEW_ACTS_AS_CUSTOMER, brings back the read-only preview.
// The REAL /api/hub handler (and the office's /api/qc, /api/client-messages and /api/client-users)
// over fake-supabase.mjs: no network, no credentials, no live project (BUILD_INTEGRITY §6b).
//
// What it holds:
//   1. 🔴 THE GATE (api/_lib/authz.js requireHubCaller), unchanged: a STAFF login is admitted ONLY
//      with the preview header AND `hub.users.view` (claims-first; crew never; fail closed).
//   2. 🔴 ACTING AS THE CUSTOMER (the switch on, the default): every POST branch the route serves
//      works in preview and writes AS THE STAND-IN — the request, its reply, the reopen, the photo,
//      the building's message, the read marker, the bell's "seen", the email switches — and the
//      office sees it as a customer's: the Work orders queue, Messaging → Customers, the bells, the
//      activity log (actor role `client`, "Preview customer").
//   3. 🔴 THE STAND-IN RULE: ONE `client_users` row per building (status `preview`, "Preview
//      customer", `preview+<id>@preview.invalid`, no login), created on the first preview, however
//      many previews or parallel first calls; it can never sign in (requireClientUser refuses it);
//      it is never emailed (the office's reply, a request's stage, a new inspection); the office's
//      /api/client-users never lists it and every write there refuses it.
//   4. 🔴 THE SWITCH OFF: everything read-only again — every POST 403 `preview-read-only`, nothing
//      written, NO stand-in created, the bell / switches / "mine" nobody's.
//   5. EVERY GET BRANCH answers the previewed building (walked from the route's HUB_BRANCH_KEYS).
//   6. 🔴 SCOPE: exactly the previewed building (none outside the live book, no other building, no
//      other building's record) — and no stand-in for a building that isn't in the book.
//   7. 🔴 A CUSTOMER LOGIN GAINS NOTHING from the header (ignored, its own scope and writes).
//   8. 🔴 NEVER ANOTHER CUSTOMER'S DATA: acting as the stand-in shows the stand-in's own bell,
//      switches and "mine", never a real customer's.
//   9. The office's activity log records the preview (`hub.previewed`) on open.
//  10. The tab's flag, the switch and the banner's words; the screens read ONE derived flag
//      (`readOnly`) to disable writes (UI_RULES §151), read mechanically.
//
// REGRESSION (THE LAW II.3): on f5506fd8 (the read-only preview) every preview POST is a 403, no
// stand-in exists and the office's routes list whatever is in the table, so §2, §3 and §10's new
// rules fail; on the tree before the preview every section fails.
//
//   node app/scripts/test-hub-preview.mjs
const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const { seedPermissions } = await import('../src/lib/roles.js');
const hubLib = await import('../src/lib/clientHub.js');
const { resolveHubEmailPrefs } = await import('../src/lib/hubEmailPrefs.js');
// The preview's vocabulary (src/lib/hubPreview.js). Imported softly: on a tree without it P0 says so
// while every other check fails on its own.
const pv = await tryImport('../src/lib/hubPreview.js');
const authz = await import('../api/_lib/authz.js');
const notify = await import('../api/_lib/clientHub/notify.js');
const route = await import('../api/hub/[...path].js');
const hub = route.default;
const qc = (await import('../api/qc/[...path].js')).default;
const officeMessages = (await import('../api/client-messages/[...path].js')).default;
const clientUsers = (await import('../api/client-users/[...path].js')).default;

// The header and the refusal code come from the module the server reads them from; the fallbacks
// exist only so an older tree runs far enough to fail each check on its own.
const HEADER = pv.HUB_PREVIEW_HEADER || 'x-hub-preview';
const READ_ONLY = pv.HUB_PREVIEW_READ_ONLY || 'preview-read-only';
// The switch, as the server and the screens read it — set for a section through the module's test
// seam, and put back to the shipped constant after it.
const setActs = (v) => { if (typeof pv.__setHubPreviewActsForTests === 'function') pv.__setHubPreviewActsForTests(v); };
const CONSOLE = { log: console.log, warn: console.warn, error: console.error };

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). The repo's suites disagree; read before adding.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const sameKeys = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).sort().join(',') === [...list].sort().join(',');
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 240)}`;

ok('P0 the preview vocabulary exists (src/lib/hubPreview.js)', !pv.__error && typeof pv.HUB_PREVIEW_HEADER === 'string', pv.__error || '');
ok('P0b the route lists its branches (HUB_BRANCH_KEYS), so this suite can walk every one', Array.isArray(route.HUB_BRANCH_KEYS) && route.HUB_BRANCH_KEYS.length > 20);
ok('🔴 P0c ONE switch decides: HUB_PREVIEW_ACTS_AS_CUSTOMER ships true, and hubPreviewActsAsCustomer() reads it (a test seam moves it, nothing else)',
  pv.HUB_PREVIEW_ACTS_AS_CUSTOMER === true && typeof pv.hubPreviewActsAsCustomer === 'function' && pv.hubPreviewActsAsCustomer() === true
    && typeof pv.__setHubPreviewActsForTests === 'function');

// ── the world ─────────────────────────────────────────────────────────────────
const H = 3600000;
const DAY = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const CU1 = 'a0000000-0000-4000-8000-000000000001'; // Pat Manager: cl_a directly, cl_b through group G1
const CU4 = 'a0000000-0000-4000-8000-000000000004'; // only cl_x
const G1 = 'b0000000-0000-4000-8000-000000000001';
const I1 = 'c0000000-0000-4000-8000-000000000001';  // cl_a, submitted
const I4 = 'c0000000-0000-4000-8000-000000000004';  // cl_x
const I5 = 'c0000000-0000-4000-8000-000000000005';  // cl_a, a draft the office submits (the HUB-11 email)
const CR1 = 'd0000000-0000-4000-8000-000000000001'; // cl_a
const CR3 = 'd0000000-0000-4000-8000-000000000003'; // cl_x
const T1 = 'e0000000-0000-4000-8000-000000000001';  // cl_a portal, resolved 2 days ago (reopenable), raised by CU1
const T4 = 'e0000000-0000-4000-8000-000000000004';  // cl_x portal
const T5 = 'e0000000-0000-4000-8000-000000000005';  // cl_a portal, awaiting the client, raised by CU1
const DOC_A = 'f6000000-0000-4000-8000-000000000001'; // cl_a's certificate
const DOC_X = 'f6000000-0000-4000-8000-000000000002'; // cl_x's certificate
const MSG_CU1 = 'f7000000-0000-4000-8000-000000000001'; // CU1's own line in cl_a's thread
const MSG_STAFF = 'f7000000-0000-4000-8000-000000000002'; // the office's line in cl_a's thread
const NEW_TICKET = 'e0000000-0000-4000-8000-0000000000aa';
const SECRET_PREFS = { messages: false };
const STAND_IN_EMAIL = (id) => (typeof pv.hubPreviewStandInEmail === 'function' ? pv.hubPreviewStandInEmail(id) : `preview+${id}@preview.invalid`);

const user = (id, role, name, extra = {}) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {}, ...extra });
const CK_SCHEMA = { areas: [{ id: 'a1', label: 'Floors', items: [{ id: 'f_sweep', label: 'Swept' }] }] };
const IN_SNAP = { name: 'Restroom QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 85 }, schema: { areas: [
  { id: 'a_fix', label: 'Fixtures', items: [{ id: 'i1', label: 'Toilets' }] },
] } };
const insp = (id, client, site, performedAgo, status = 'submitted') => ({
  id, organization_id: ORG, public_token: `tok_pub_${id.slice(-2)}`, template_id: 'it_r', template_version_id: 'iv_r',
  template_snapshot: IN_SNAP, client_id: client, site_id: site, job_id: null, inspector_user_id: 'u_mgr',
  client_name: client, site_name: 'Clubhouse', inspector_name: 'Renata Cruz',
  status, overall_score: status === 'submitted' ? 90 : null, result: status === 'submitted' ? 'pass' : null, internal_note: 'ZZNOTEZZ', performed_at: ago(performedAgo),
});
const ticket = (id, client, site, status, createdAgo, extra = {}) => ({
  id, organization_id: ORG, client_id: client, site_id: site, job_id: null, reported_by_user_id: null, assignee_user_id: 'u_mgr',
  client_name: client, site_name: 'Clubhouse', title: `Ticket ${id.slice(-1)}`, description: 'Something to look at.',
  type: 'complaint', origin: 'portal', category: 'spill', priority: 'medium', status, created_at: ago(createdAgo), due_at: ago(createdAgo - DAY),
  resolved_at: null, escalated_at: null,
  raised_by_client_user_id: client === 'cl_a' ? CU1 : CU4, raised_by_client_name: client === 'cl_a' ? 'Pat Manager' : 'Harbor Person', ...extra,
});
const woMsg = (id, problemId, role, name, body, createdAgo) => ({
  id, organization_id: ORG, problem_id: problemId, author_user_id: role === 'client' ? null : 'u_mgr', author_role: role,
  author_name: name, author_client_user_id: role === 'client' ? CU1 : null, body, translated_body: null, from_lang: null,
  internal: false, created_at: ago(createdAgo),
});
const doc = (id, client) => ({
  id, organization_id: ORG, client_id: client, kind: 'coi', title: `Certificate ${client}`, valid_until: null, file_name: 'coi.pdf',
  file_size: 10, mime_type: 'application/pdf', visible_to_client: true, revision: 1, created_at: ago(DAY), updated_at: ago(DAY), created_by_user_id: 'u_owner',
});

function seed() {
  setActs(undefined); // the shipped constant, unless a section says otherwise
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [
            user('u_owner', 'owner', 'Dana Owner', { phone: '(754) 555-0101' }),
            user('u_admin', 'admin', 'Avery Admin'),
            user('u_mgr', 'manager', 'Renata Cruz', { phone: '(754) 555-0105' }),
            user('u_mgr2', 'manager', 'Mo Claimless'),
            user('u_mgr3', 'manager', 'Morgan Revoked'),
            user('u_crew', 'crew', 'Tomas Rivera'),
            user('u_crew2', 'crew', 'Keisha Granted'),
            user('u_gone', 'admin', 'Gone Admin', { status: 'disabled' }),
          ],
          clients: [
            { id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr', street: '120 Royal Palm Way', city: 'Boca Raton', state: 'FL', zip: '33432', revenue: 1100, notes: 'gate code 4455' },
            { id: 'cl_b', name: 'Bayshore Senior Living', supervisorId: 'u_owner' },
            { id: 'cl_x', name: 'Harbor Tower', supervisorId: 'u_mgr' },
          ],
          sites: [
            { id: 's_a', clientId: 'cl_a', name: 'Clubhouse', address: '120 Royal Palm Way, Boca Raton FL 33432' },
            { id: 's_b', clientId: 'cl_b', name: 'Main Residence' },
            { id: 's_x', clientId: 'cl_x', name: 'Tower' },
          ],
          permissions: seedPermissions(),
          // A manager pared off the key, and a cleaner GRANTED it (a role floor refuses them anyway).
          userPermissionOverrides: [
            { userId: 'u_mgr3', grants: [], revokes: ['hub.users.view'] },
            { userId: 'u_crew2', grants: ['hub.users.view'], revokes: [] },
          ],
          notifications: [],
        },
      }],
      crew_assignments: [],
      client_users: [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: '(754) 555-0300', status: 'active', auth_user_id: 'auth-c1', email_prefs: SECRET_PREFS, updates_seen_at: null, updated_at: ago(DAY) },
        { id: CU4, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c4', email_prefs: null, updates_seen_at: null, updated_at: ago(DAY) },
      ],
      client_user_groups: [{ id: G1, organization_id: ORG, name: 'Royal Palm Holdings', kind: 'management' }],
      client_user_group_members: [{ organization_id: ORG, group_id: G1, client_id: 'cl_b' }],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null },
        { id: 'as2', organization_id: ORG, client_user_id: CU1, client_id: null, group_id: G1 },
        { id: 'as5', organization_id: ORG, client_user_id: CU4, client_id: 'cl_x', group_id: null },
      ],
      jobs: [
        { id: 'j_a_next', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', status: 'upcoming', start_at: ago(-3 * DAY), data: { id: 'j_a_next', clientId: 'cl_a', startAt: ago(-3 * DAY), crewIds: ['u_crew'] } },
      ],
      time_entries: [
        { id: 'te1', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew', user_name: 'Tomas Rivera', clock_in_at: ago(30 * 60000), clock_out_at: null, status: 'in_progress', geofence_result: 'inside' },
      ],
      checklist_results: [
        { id: CR1, organization_id: ORG, template_id: 'it_f', template_version_id: 'iv_f', template_snapshot: { name: 'Floor Care', kind: 'checklist', schema: CK_SCHEMA }, client_id: 'cl_a', site_id: 's_a', job_id: null, completed_by_user_id: 'u_crew', items: [{ key: 'f_sweep', checked: true }], completed_count: 1, total_count: 1, client_submit_id: 'cs_cr1', area_completions: null, performed_at: ago(DAY) },
        { id: CR3, organization_id: ORG, template_id: 'it_f', template_version_id: 'iv_f', template_snapshot: { name: 'Harbor list', kind: 'checklist', schema: CK_SCHEMA }, client_id: 'cl_x', site_id: 's_x', job_id: null, completed_by_user_id: 'u_crew', items: [], completed_count: 0, total_count: 1, client_submit_id: 'cs_cr3', area_completions: null, performed_at: ago(DAY) },
      ],
      account_media: [],
      inspection_records: [insp(I1, 'cl_a', 's_a', 2 * DAY), insp(I4, 'cl_x', 's_x', DAY), insp(I5, 'cl_a', 's_a', H, 'draft')],
      inspection_items: [{ id: 'ii1', inspection_id: I1, item_key: 'i1', label: 'Fixtures. Toilets', rating: 'pass', comment: null, photo_count: 0 }],
      problem_reports: [
        ticket(T1, 'cl_a', 's_a', 'resolved', 3 * DAY, { resolved_at: ago(2 * DAY), title: 'Coffee stain' }),
        ticket(T4, 'cl_x', 's_x', 'open', DAY, { title: 'Harbor thing' }),
        ticket(T5, 'cl_a', 's_a', 'awaiting_client', 2 * DAY, { title: 'Scuff marks' }),
      ],
      work_order_messages: [
        woMsg('w1', T5, 'client', 'Pat Manager', 'It is by the mailroom.', 2 * DAY),
        woMsg('w2', T5, 'office', 'Renata Cruz', 'Which wall, the east or the west?', DAY),
      ],
      activity_log: [
        { id: 'al1', organization_id: ORG, occurred_at: ago(DAY), actor_user_id: 'u_mgr', actor_name: 'Renata Cruz', actor_role: 'manager', auto: false, action: 'ticket.status_changed', entity_type: 'work_order', entity_id: T5, client_id: 'cl_a', client_name: 'Coral Bay HOA', summary: 'x', before: { status: 'open' }, after: { status: 'awaiting_client' }, is_money: false },
      ],
      client_messages: [
        { id: MSG_CU1, organization_id: ORG, client_id: 'cl_a', author_role: 'client', author_client_user_id: CU1, author_user_id: null, author_name: 'Pat Manager', body: 'Can the lobby be done first?', created_at: ago(3 * H) },
        { id: MSG_STAFF, organization_id: ORG, client_id: 'cl_a', author_role: 'staff', author_client_user_id: null, author_user_id: 'u_mgr', author_name: 'Renata Cruz', body: 'Yes, tonight.', created_at: ago(2 * H) },
      ],
      client_message_threads: [],
      client_message_reads: [],
      customer_documents: [doc(DOC_A, 'cl_a'), doc(DOC_X, 'cl_x')],
      contracts: [],
      contract_buildings: [],
      qbo_connection: [],
      qbo_property_links: [],
      qbo_invoice_cache: [],
      inbox_accounts: [],
    },
    logins: {
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-admin': { id: 'auth-a', email: 'u_admin@example.test', app_metadata: { role: 'admin', org_user_id: 'u_admin', org_id: ORG } },
      'tok-mgr': { id: 'auth-m', email: 'u_mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      // A manager with no claims at all, resolved from the roster by email (the fallback contract).
      'tok-mgr-claimless': { id: 'auth-m2', email: 'u_mgr2@example.test', app_metadata: { org_id: ORG } },
      'tok-mgr-revoked': { id: 'auth-m3', email: 'u_mgr3@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr3', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
      'tok-crew-granted': { id: 'auth-crew2', email: 'u_crew2@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew2', org_id: ORG } },
      'tok-disabled': { id: 'auth-gone', email: 'u_gone@example.test', app_metadata: { role: 'admin', org_user_id: 'u_gone', org_id: ORG } },
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client4': { id: 'auth-c4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU4, org_id: ORG } },
    },
  });
  // The database's unique indexes on client_users (the primary key; lower(email) per org), which a
  // parallel first preview must meet: the fake answers a duplicate with 23505, as Postgres does.
  world.uniqueKeys = {
    client_users: [(r) => r.id || null, (r) => (r.email ? `${r.organization_id}|${String(r.email).toLowerCase()}` : null)],
  };
  // The view's next visits (hub_next_visits): the soonest upcoming job within 60 days, per id asked.
  world.rpc = (name, args) => {
    if (name !== 'hub_next_visits') return { data: null, error: { message: `no function ${name}`, code: 'PGRST202' } };
    const from = Date.parse(args?.p_from);
    const best = new Map();
    for (const j of world.tables.jobs || []) {
      const t = Date.parse(j.start_at);
      if (!(args?.p_client_ids || []).includes(j.client_id) || j.status !== 'upcoming' || !(t >= from && t < from + 60 * DAY)) continue;
      if (!best.has(j.client_id) || t < Date.parse(best.get(j.client_id).start_at)) best.set(j.client_id, { client_id: j.client_id, start_at: j.start_at });
    }
    return { data: [...best.values()], error: null };
  };
}

async function call(handler, { method = 'GET', path: p, token, body, preview, loud = false }) {
  const [sub, qs] = p.split('?');
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (preview !== undefined) headers[HEADER] = preview;
  const req = { method, headers, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body || {} };
  if (!loud) console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
      const out = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers: out }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { out[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { if (!loud) Object.assign(console, CONSOLE); }
}
// The office previewing Coral Bay HOA (cl_a).
const look = (p, token = 'tok-owner', building = 'cl_a') => call(hub, { path: p, token, preview: building });
const act = (p, body, token = 'tok-owner', building = 'cl_a') => call(hub, { method: 'POST', path: p, token, preview: building, body });
const office = (handler, p, body, token = 'tok-owner') => call(handler, { method: body ? 'POST' : 'GET', path: p, token, body });
const standIns = (clientId = null) => (world.tables.client_users || []).filter((u) => u.status === 'preview' && (!clientId || u.email === STAND_IN_EMAIL(clientId)));
const standIn = (clientId = 'cl_a') => standIns(clientId)[0] || null;

// ── 1. the gate (unchanged) ───────────────────────────────────────────────────
seed();
{
  for (const [who, token] of [['the owner', 'tok-owner'], ['an admin', 'tok-admin'], ['a manager holding hub.users.view', 'tok-mgr'], ['a claim-less manager (the roster places them)', 'tok-mgr-claimless']]) {
    const r = await look('view', token);
    ok(`🔴 G1 ${who} previews: the view answers ONLY the previewed building`,
      () => r.status === 200 && (r.body.buildings || []).map((b) => b.id).join() === 'cl_a', show(r));
  }
  const r = await look('view');
  ok('G2 …the view is EXACTLY its allowlist, the building row EXACTLY its own',
    () => sameKeys(r.body, hubLib.HUB_VIEW_FIELDS) && sameKeys(r.body.buildings?.[0], hubLib.HUB_VIEW_BUILDING_FIELDS), show(r));
  ok('🔴 G3 …the viewer is the preview\'s ("Preview customer"), no address or phone, no first name to greet, no group',
    () => sameKeys(r.body.viewer, hubLib.HUB_VIEWER_FIELDS) && r.body.viewer.name === pv.HUB_PREVIEW_VIEWER_NAME && r.body.viewer.name === 'Preview customer'
      && r.body.viewer.email === '' && r.body.viewer.phone === '' && r.body.viewer.firstName === '' && Array.isArray(r.body.groups) && r.body.groups.length === 0, JSON.stringify(r.body?.viewer));
  ok('G4 …private and never cached', () => /private/.test(r.headers?.['cache-control'] || '') && /no-store/.test(r.headers?.['cache-control'] || ''));
  const revoked = await look('view', 'tok-mgr-revoked');
  ok('🔴 G5 a manager whose hub.users.view was revoked is refused (403)', () => revoked.status === 403 && revoked.body?.code === pv.HUB_PREVIEW_FORBIDDEN, show(revoked));
  const crew = await look('view', 'tok-crew');
  ok('🔴 G6 a cleaner is refused (403)', () => crew.status === 403 && crew.body?.code === pv.HUB_PREVIEW_FORBIDDEN, show(crew));
  const granted = await look('view', 'tok-crew-granted');
  ok('🔴 G7 …even one GRANTED the key: crew never preview (a role floor no grant lifts)', () => granted.status === 403 && granted.body?.code === pv.HUB_PREVIEW_FORBIDDEN, show(granted));
  const gone = await look('view', 'tok-disabled');
  ok('🔴 G8 a disabled member is refused (403 account-disabled)', () => gone.status === 403 && gone.body?.code === 'account-disabled', show(gone));
  const anon = await call(hub, { path: 'view', preview: 'cl_a' });
  ok('G9 no login is a 401, header or not', () => anon.status === 401, show(anon));
  const noHeader = await call(hub, { path: 'view', token: 'tok-owner' });
  ok('🔴 G10 a staff login WITHOUT the header is still refused (403 office-login)', () => noHeader.status === 403 && noHeader.body?.code === 'office-login', show(noHeader));
  const empty = await call(hub, { path: 'view', token: 'tok-owner', preview: '' });
  ok('G11 …and an EMPTY header is no header', () => empty.status === 403 && empty.body?.code === 'office-login', show(empty));
  world.tables.org_state[0].state.permissions.find((p) => p.id === 'hub.users.view').roles = ['owner', 'manager'];
  const adminOff = await look('view', 'tok-admin');
  const ownerStill = await look('view', 'tok-owner');
  ok('🔴 G12 the committed matrix decides: with the key off the Admin column an admin is refused, the owner is not',
    () => adminOff.status === 403 && adminOff.body?.code === pv.HUB_PREVIEW_FORBIDDEN && ownerStill.status === 200, `${show(adminOff)} | ${show(ownerStill)}`);
  world.tables.org_state[0].state.permissions.find((p) => p.id === 'hub.users.view').roles = ['owner', 'admin', 'manager'];
  world.failWhen = (q) => q.table === 'org_state' && /userPermissionOverrides/.test(q.cols || '');
  const blind = await look('view', 'tok-admin');
  world.failWhen = null;
  ok('🔴 G13 a matrix that cannot be read refuses the preview (fail closed, a sentence and a code)',
    () => blind.status >= 500 && typeof blind.body?.code === 'string' && !(blind.body?.buildings), show(blind));
  const refusedWrite = await act('ticket-create', { id: NEW_TICKET, buildingId: 'cl_a', type: 'complaint', category: 'spill', description: 'x' }, 'tok-crew');
  ok('🔴 G14 a refused staff login writes nothing either (crew, header, a request)', () => refusedWrite.status === 403 && !world.tables.problem_reports.some((p) => p.id === NEW_TICKET), show(refusedWrite));
}

// ── 2. acting as the customer: every write works, as the stand-in ─────────────
seed();
{
  const keys = Array.isArray(route.HUB_BRANCH_KEYS) ? route.HUB_BRANCH_KEYS : [];
  const posts = keys.filter((k) => k.startsWith('POST ')).map((k) => k.slice(5));
  const named = ['ticket-create', 'ticket-message', 'ticket-reopen', 'ticket-photo-url', 'ticket-photo', 'message', 'messages-read', 'updates-seen', 'email-prefs', 'push', 'push-off'];
  ok(`A0 every POST branch the route serves is driven below (${posts.filter((p) => !named.includes(p)).join(', ') || 'all named'})`,
    posts.length === named.length && posts.every((p) => named.includes(p)));
  // Crew on the way (UI_RULES §187): the one exception — a preview NEVER signs a phone up, even acting
  // as the customer (the stand-in is nobody's; its alerts would ring the office person previewing).
  for (const [name, body] of [['push', { subscription: { endpoint: 'https://push.example.test/wp/preview', keys: { p256dh: 'BPreviewKey', auth: 'previewAuth' } } }], ['push-off', { endpoint: 'https://push.example.test/wp/preview' }]]) {
    const r = await act(name, body);
    ok(`🔴 A0b POST ${name} in preview acting as the customer is 403 preview-no-alerts, nothing written`, () => r.status === 403 && r.body?.code === 'preview-no-alerts' && !(world.tables.client_push_subscriptions || []).length, show(r));
  }
  const bellsBefore = world.tables.org_state[0].state.notifications.length;

  const created = await act('ticket-create', { id: NEW_TICKET, buildingId: 'cl_a', type: 'complaint', category: 'spill', description: 'Spill by the mailboxes.\nRaised in the preview.', urgent: true });
  const si = standIn('cl_a');
  ok('🔴 A1 POST ticket-create in preview raises the request', () => created.status === 200 && created.body?.ticket?.id === NEW_TICKET, show(created));
  const row = world.tables.problem_reports.find((p) => p.id === NEW_TICKET);
  ok('🔴 A2 …filed as a CUSTOMER\'s (origin portal) by the building\'s stand-in, "Preview customer" — never a real customer, never the staff member',
    () => !!si && row?.origin === 'portal' && row.client_id === 'cl_a' && row.raised_by_client_user_id === si.id && row.raised_by_client_name === 'Preview customer'
      && !row.reported_by_user_id && row.raised_by_client_user_id !== CU1, JSON.stringify(row));
  ok('🔴 A3 …and reads "You" back to the preview, as it would to the customer', () => created.body?.ticket?.raisedBy === 'You', show(created));
  const bells = world.tables.org_state[0].state.notifications.slice(0, world.tables.org_state[0].state.notifications.length - bellsBefore);
  ok('🔴 A4 …and the office hears it as a customer\'s new request: the supervisor-first bell to the building\'s manager',
    () => world.tables.org_state[0].state.notifications.length > bellsBefore && world.tables.org_state[0].state.notifications.some((n) => n.userId === 'u_mgr' && /workorders/.test(n.url || '')), JSON.stringify(bells));
  const again = await act('ticket-create', { id: NEW_TICKET, buildingId: 'cl_a', type: 'complaint', category: 'spill', description: 'Spill by the mailboxes.' });
  ok('A5 a double-tap is ONE request (the replay check works for the stand-in)', () => again.status === 200 && world.tables.problem_reports.filter((p) => p.id === NEW_TICKET).length === 1, show(again));
  const queue = await office(qc, 'problems/list');
  const seen = (queue.body?.problems || []).find((p) => p.id === NEW_TICKET);
  ok('🔴 A6 the office sees it in Quality → Work orders, raised by "Preview customer"', () => seen?.origin === 'portal' && seen.raised_by_client_name === 'Preview customer', show(queue));

  const reply = await act('ticket-message', { id: 'f0000000-0000-4000-8000-0000000000a1', buildingId: 'cl_a', ticketId: NEW_TICKET, body: 'Also the hallway.' });
  const wom = world.tables.work_order_messages.find((m) => m.id === 'f0000000-0000-4000-8000-0000000000a1');
  ok('🔴 A7 POST ticket-message: the stand-in\'s reply on its request, read back as "you"',
    () => reply.status === 200 && reply.body?.message?.from === 'you' && wom?.author_role === 'client' && wom.author_client_user_id === si?.id && wom.author_name === 'Preview customer', show(reply));
  const onReal = await act('ticket-message', { id: 'f0000000-0000-4000-8000-0000000000a2', buildingId: 'cl_a', ticketId: T5, body: 'The east wall.' });
  ok('A8 …and on another customer\'s request in the building, as a customer of the building may', () => onReal.status === 200 && onReal.body?.message?.from === 'you', show(onReal));

  const reopen = await act('ticket-reopen', { buildingId: 'cl_a', ticketId: T1 });
  ok('🔴 A9 POST ticket-reopen reopens a request completed two days ago', () => reopen.status === 200 && reopen.body?.ticket?.stage === 'received' && world.tables.problem_reports.find((p) => p.id === T1)?.status === 'open', show(reopen));

  const up = await act('ticket-photo-url', { buildingId: 'cl_a', ticketId: NEW_TICKET, mimeType: 'image/jpeg', sizeBytes: 2048 });
  ok('🔴 A10 POST ticket-photo-url: an upload address under the building\'s location', () => up.status === 200 && String(up.body?.path || '').startsWith(`${ORG}/s_a/`), show(up));
  const ph = await act('ticket-photo', { buildingId: 'cl_a', ticketId: NEW_TICKET, storagePath: up.body?.path, mimeType: 'image/jpeg', sizeBytes: 2048 });
  ok('🔴 A11 POST ticket-photo records the customer\'s photo on the request', () => ph.status === 200 && world.tables.account_media.some((m) => m.scope === 'client_ticket' && m.ref_id === NEW_TICKET), show(ph));

  const bellsBeforeMsg = world.tables.org_state[0].state.notifications.length;
  const msg = await act('message', { id: 'f7000000-0000-4000-8000-0000000000a1', buildingId: 'cl_a', body: 'Hello from the preview' });
  const line = world.tables.client_messages.find((m) => m.id === 'f7000000-0000-4000-8000-0000000000a1');
  ok('🔴 A12 POST message: a customer line in the building\'s thread, by the stand-in, "mine"',
    () => msg.status === 200 && msg.body?.message?.mine === true && line?.author_role === 'client' && line.author_client_user_id === si?.id && line.author_name === 'Preview customer', show(msg));
  ok('🔴 A13 …routed by Matt\'s rule: the building\'s manager hears it', () => world.tables.org_state[0].state.notifications.length > bellsBeforeMsg
    && world.tables.org_state[0].state.notifications.some((n) => n.userId === 'u_mgr' && /messaging/.test(n.url || '')), JSON.stringify(world.tables.org_state[0].state.notifications.slice(0, 2)));
  const thread = await office(officeMessages, 'thread?clientId=cl_a');
  ok('🔴 A14 …and the office reads it in Messaging → Customers as "Preview customer"', () => thread.status === 200 && (thread.body?.messages || []).some((m) => m.body === 'Hello from the preview' && /Preview customer/.test(JSON.stringify(m))), show(thread));

  const read = await act('messages-read', { buildingId: 'cl_a' });
  ok('🔴 A15 POST messages-read: the stand-in\'s own read marker', () => read.status === 200 && world.tables.client_message_reads.some((r) => r.reader_kind === 'client' && r.reader_id === si?.id && r.client_id === 'cl_a'), show(read));
  const seenR = await act('updates-seen', {});
  ok('🔴 A16 POST updates-seen stamps the STAND-IN\'s row, never a customer\'s', () => seenR.status === 200 && !!standIn('cl_a')?.updates_seen_at
    && world.tables.client_users.find((u) => u.id === CU1).updates_seen_at === null, show(seenR));
  const prefs = await act('email-prefs', { messages: false });
  ok('🔴 A17 POST email-prefs saves the stand-in\'s own switches; the customer\'s row is untouched',
    () => prefs.status === 200 && prefs.body?.prefs?.messages === false && standIn('cl_a')?.email_prefs?.messages === false
      && JSON.stringify(world.tables.client_users.find((u) => u.id === CU1).email_prefs) === JSON.stringify(SECRET_PREFS), show(prefs));
  const prefsBack = await look('email-prefs');
  ok('A18 …and reads them back', () => prefsBack.status === 200 && prefsBack.body?.prefs?.messages === false, show(prefsBack));

  const logged = world.tables.activity_log.filter((r) => ['ticket.replied', 'customer_message.received', 'ticket.status_changed'].includes(r.action) && r.actor_name === 'Preview customer');
  ok('🔴 A19 the activity log records each preview action as a CUSTOMER\'s, "Preview customer", no staff id',
    () => logged.length >= 3 && logged.every((r) => r.actor_role === 'client' && !r.actor_user_id), JSON.stringify(logged.map((r) => `${r.action}:${r.actor_role}`)));
  const bell = await look('updates');
  ok('A20 the bell is the stand-in\'s own (its shape, not an empty stand-in for nobody)', () => bell.status === 200 && Array.isArray(bell.body?.updates) && 'messagesUnread' in (bell.body || {}), show(bell));
}

// ── 3. the stand-in rule ──────────────────────────────────────────────────────
seed();
{
  ok('S0 nothing has previewed yet: no stand-in', () => standIns().length === 0);
  for (let i = 0; i < 5; i += 1) await look('view', i % 2 ? 'tok-admin' : 'tok-owner');
  await look('home?buildingId=cl_a', 'tok-mgr');
  const rows = standIns('cl_a');
  const s = rows[0];
  ok('🔴 S1 the first preview creates ONE stand-in for the building; six more previews by three people add none',
    () => rows.length === 1 && standIns().length === 1, JSON.stringify(standIns()));
  ok('🔴 S2 …status "preview", "Preview customer", an address at the reserved .invalid domain, and no login',
    () => s?.status === 'preview' && s.name === 'Preview customer' && s.email === STAND_IN_EMAIL('cl_a') && /@preview\.invalid$/.test(s.email) && !s.auth_user_id && s.organization_id === ORG, JSON.stringify(s));
  ok('🔴 S3 …and "preview" is not a status that holds access (nor one the office can set)',
    () => !hubLib.CLIENT_USER_ACCESS_STATUSES.includes('preview') && !hubLib.CLIENT_USER_STATUSES.includes('preview') && hubLib.clientUserHasAccess('preview') === false
      && hubLib.CLIENT_USER_PREVIEW_STATUS === 'preview');
  await look('view', 'tok-owner', 'cl_x');
  ok('S4 another building gets its own stand-in', () => standIns().length === 2 && standIns('cl_x').length === 1 && standIns('cl_x')[0].id !== s?.id);

  // Two FIRST previews of a building at once: both read "none", both insert; the database's unique
  // index refuses the second (23505), which reads the winner back. Held deterministic by a barrier:
  // neither insert runs until both have looked.
  let looks = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const timer = setTimeout(() => release(), 3000);
  world.beforeQuery = async (q) => {
    if (q.table === 'client_users' && q.op === 'select' && q.eq.id) { looks += 1; if (looks >= 2) release(); }
    if (q.table === 'client_users' && q.op === 'insert') await gate;
  };
  const inserts0 = world.log.filter((q) => q.table === 'client_users' && q.op === 'insert').length;
  const [p1, p2] = await Promise.all([look('view', 'tok-owner', 'cl_b'), look('view', 'tok-admin', 'cl_b')]);
  Object.assign(console, CONSOLE);
  clearTimeout(timer);
  world.beforeQuery = null;
  const inserts = world.log.filter((q) => q.table === 'client_users' && q.op === 'insert').length - inserts0;
  ok('🔴 S5 two parallel first previews of a building leave exactly ONE stand-in (the race happened: two inserts, one refused)',
    () => p1.status === 200 && p2.status === 200 && standIns('cl_b').length === 1 && inserts === 2, `${p1.status}/${p2.status} rows=${standIns('cl_b').length} inserts=${inserts}`);

  // It can never sign in: a login whose claim names it is refused by the customer gate.
  world.logins.set('tok-standin', { id: 'auth-si', email: s?.email, app_metadata: { role: 'client', client_user_id: s?.id, org_id: ORG } });
  const signIn = await call(hub, { path: 'view', token: 'tok-standin' });
  ok('🔴 S6 a login carrying the stand-in\'s id is refused at the hub (403 account-disabled)', () => signIn.status === 403 && signIn.body?.code === 'account-disabled', show(signIn));
  const sink = { status: 0, body: null };
  const res = { status(c) { sink.status = c; return this; }, setHeader() {}, json(b) { sink.body = b; return this; } };
  console.error = () => {};
  const direct = await authz.requireClientUser({ headers: { authorization: 'Bearer tok-standin' } }, res);
  Object.assign(console, CONSOLE);
  ok('🔴 S7 …by requireClientUser itself', () => direct === null && sink.status === 403);

  // It is never emailed: the office's reply in the building's thread, a stage change and a reply on
  // the stand-in's own request, a new inspection — while a real customer of the building is (the
  // controls prove each sender ran).
  world.tables.client_users.find((u) => u.id === CU1).email_prefs = null; // Pat takes every email
  const sent = [];
  notify.__setHubMailerForTests(async (m) => { sent.push(m); return { ok: true, id: `e${sent.length}` }; });
  const created = await act('ticket-create', { id: NEW_TICKET, buildingId: 'cl_a', type: 'request', category: 'other', description: 'Raised in the preview.' });
  await office(qc, 'problems/update', { id: NEW_TICKET, status: 'in_progress' });
  await office(qc, 'problems/message', { problemId: NEW_TICKET, body: 'On it.' });
  await office(qc, 'problems/update', { id: T5, status: 'in_progress' }); // control: Pat's own request
  await office(officeMessages, 'send', { id: 'f7000000-0000-4000-8000-0000000000b1', clientId: 'cl_a', body: 'We will be there at 7.' });
  await office(qc, 'inspections/submit', { id: I5, items: [{ item_key: 'i1', label: 'Fixtures. Toilets', rating: 'pass' }] });
  notify.__setHubMailerForTests(null);
  const to = sent.map((m) => String(m.to));
  ok('🔴 S8 the stand-in is NEVER emailed — its request\'s stage and reply, the office\'s message, a new inspection',
    () => created.status === 200 && !to.some((t) => /@preview\.invalid$/i.test(t)), JSON.stringify(to));
  ok('S9 …while the building\'s real customer is, by each sender (a stage change, the office\'s message, the inspection)',
    () => to.filter((t) => t === 'pat@coralbay.test').length >= 3, JSON.stringify(to));

  // The office's customer-login screens never see it, and no write there can touch it.
  const list = await office(clientUsers, 'list');
  ok('🔴 S10 /api/client-users/list never shows a stand-in (the list and its counts)', () => list.status === 200 && (list.body?.users || []).length === 2
    && !(list.body.users || []).some((u) => u.status === 'preview' || /@preview\.invalid$/.test(u.email)), show(list));
  const forClient = await office(clientUsers, 'for-client?clientId=cl_a');
  ok('S11 …nor "who can see this building"', () => forClient.status === 200 && !JSON.stringify(forClient.body).includes('preview.invalid'), show(forClient));
  const before = JSON.stringify(standIn('cl_a'));
  for (const [what, body] of [
    ['save', { id: s?.id, name: 'Renamed', phone: '555' }],
    ['assign', { id: s?.id, clientIds: ['cl_x'], groupIds: [] }],
    ['invite', { id: s?.id }],
    ['status', { id: s?.id, status: 'active' }],
  ]) {
    const r = await office(clientUsers, what, body);
    ok(`🔴 S12 POST /api/client-users/${what} on the stand-in is a 404, as if it isn't there`, () => r.status === 404, show(r));
  }
  const rm = await office(clientUsers, 'remove', { id: s?.id });
  ok('🔴 S13 …remove answers as for a contact that is gone, and removes nothing', () => rm.status === 200 && rm.body?.missing === true && !!standIn('cl_a'), show(rm));
  ok('🔴 S14 …so the stand-in is exactly as it was: no assignment, no login, no new status',
    () => JSON.stringify(standIn('cl_a')) === before && !world.tables.client_user_assignments.some((a) => a.client_user_id === s?.id));
  const squat = await office(clientUsers, 'save', { name: 'Squatter', email: STAND_IN_EMAIL('cl_x').toUpperCase(), phone: '' });
  ok('🔴 S15 the office cannot create a customer login at the reserved preview address', () => squat.status === 400 && !world.tables.client_users.some((u) => u.name === 'Squatter'), show(squat));
}

// ── 4. the switch off: read-only, as before ───────────────────────────────────
seed();
setActs(false);
{
  ok('R00 the seam turns the switch off for this section', () => typeof pv.hubPreviewActsAsCustomer === 'function' && pv.hubPreviewActsAsCustomer() === false);
  const keys = Array.isArray(route.HUB_BRANCH_KEYS) ? route.HUB_BRANCH_KEYS : [];
  const posts = keys.filter((k) => k.startsWith('POST ')).map((k) => k.slice(5));
  const BODIES = {
    'ticket-create': { id: NEW_TICKET, buildingId: 'cl_a', type: 'complaint', category: 'spill', description: 'Spill by the mailboxes.' },
    'ticket-message': { id: 'f0000000-0000-4000-8000-0000000000aa', buildingId: 'cl_a', ticketId: T5, body: 'The east wall.' },
    'ticket-reopen': { buildingId: 'cl_a', ticketId: T1 },
    'ticket-photo-url': { buildingId: 'cl_a', ticketId: T5, mimeType: 'image/jpeg', sizeBytes: 1000 },
    'ticket-photo': { buildingId: 'cl_a', ticketId: T5, storagePath: `${ORG}/s_a/abcdef0123456789.jpg`, mimeType: 'image/jpeg', sizeBytes: 1000 },
    message: { id: 'f7000000-0000-4000-8000-0000000000aa', buildingId: 'cl_a', body: 'Hello from the preview' },
    'messages-read': { buildingId: 'cl_a' },
    'updates-seen': {},
    'email-prefs': { messages: true },
    push: { subscription: { endpoint: 'https://push.example.test/wp/preview', keys: { p256dh: 'BPreviewKey', auth: 'previewAuth' } } },
    'push-off': { endpoint: 'https://push.example.test/wp/preview' },
  };
  ok(`R0 every POST branch the route serves is named here (${posts.filter((p) => !(p in BODIES)).join(', ') || 'all named'})`, posts.length >= 9 && posts.every((p) => p in BODIES));
  await look('view');
  const tablesBefore = JSON.stringify(world.tables);
  const logFrom = world.log.length;
  for (const name of posts) {
    const r = await act(name, BODIES[name] || {});
    ok(`🔴 R1 switch off: POST ${name} in preview is 403 ${READ_ONLY}, with a sentence`, () => r.status === 403 && r.body?.code === READ_ONLY && typeof r.body?.error === 'string', show(r));
  }
  const odd = await act('no-such-branch', {});
  ok('R2 …and so is a POST to a branch that does not exist', () => odd.status === 403 && odd.body?.code === READ_ONLY, show(odd));
  const writes = world.log.slice(logFrom).filter((q) => q.op !== 'select' && q.op !== 'rpc');
  ok('🔴 R3 switch off: nothing written — no insert, update, upsert or delete, every table as it was', () => writes.length === 0 && JSON.stringify(world.tables) === tablesBefore, JSON.stringify(writes.slice(0, 3)));
  ok('🔴 R4 switch off: no stand-in is created, however many previews', () => standIns().length === 0, JSON.stringify(standIns()));
  const bell = await look('updates');
  ok('🔴 R5 switch off: the bell is nobody\'s (empty, nothing unseen)', () => bell.status === 200 && bell.body?.updates?.length === 0 && !bell.body.unseen && bell.body.seenAt === null && bell.body.messagesUnread?.length === 0, show(bell));
  const prefs = await look('email-prefs');
  ok('🔴 R6 switch off: the email switches are the defaults, nobody\'s', () => prefs.status === 200 && JSON.stringify(prefs.body?.prefs) === JSON.stringify(resolveHubEmailPrefs(null)), show(prefs));
  const thread = await look('messages?buildingId=cl_a');
  ok('🔴 R7 switch off: no line is "mine"', () => thread.status === 200 && thread.body.messages.length === 2 && thread.body.messages.every((m) => m.mine === false), show(thread));
  const req = await look(`ticket?buildingId=cl_a&id=${T5}`);
  ok('R8 switch off: no request reads "You"', () => req.status === 200 && req.body.ticket?.raisedBy !== 'You', show(req));
  ok('R9 switch off: the banner says nothing is sent', () => typeof pv.hubPreviewBanner === 'function' && /Nothing here is sent\./.test(pv.hubPreviewBanner('Coral Bay HOA')));
}
setActs(undefined);

// ── 5. EVERY GET branch answers the previewed building (the switch on) ────────
seed();
{
  const keys = Array.isArray(route.HUB_BRANCH_KEYS) ? route.HUB_BRANCH_KEYS : [];
  const gets = keys.filter((k) => k.startsWith('GET ')).map((k) => k.slice(4));
  // The two PDFs reach their branch without rendering anything here: the inspection's item read
  // fails AFTER the rate limit (503, its items read in the log); QuickBooks is not connected, so the
  // invoice is not found (404, after the limit — V3 shows the preview's own limit counting).
  const GETS = {
    view: { q: 'view', expect: 200 },
    home: { q: 'home?buildingId=cl_a', expect: 200 },
    visit: { q: 'visit?buildingId=cl_a', expect: 200 },
    checklists: { q: 'checklists?buildingId=cl_a', expect: 200 },
    checklist: { q: `checklist?buildingId=cl_a&id=${CR1}`, expect: 200 },
    inspections: { q: 'inspections?buildingId=cl_a', expect: 200 },
    inspection: { q: `inspection?buildingId=cl_a&id=${I1}`, expect: 200 },
    'inspection-pdf': { q: `inspection-pdf?buildingId=cl_a&id=${I1}`, expect: 503, fail: (q) => q.table === 'inspection_items', reached: (log) => log.some((q) => q.table === 'inspection_items') },
    tickets: { q: 'tickets?buildingId=cl_a', expect: 200 },
    ticket: { q: `ticket?buildingId=cl_a&id=${T5}`, expect: 200 },
    history: { q: 'history?buildingId=cl_a', expect: 200 },
    messages: { q: 'messages?buildingId=cl_a', expect: 200 },
    updates: { q: 'updates', expect: 200 },
    'email-prefs': { q: 'email-prefs', expect: 200 },
    invoices: { q: 'invoices?buildingId=cl_a', expect: 200 },
    'invoice-pdf': { q: 'invoice-pdf?buildingId=cl_a&id=1001', expect: 404 },
    documents: { q: 'documents?buildingId=cl_a', expect: 200 },
    'document-url': { q: `document-url?buildingId=cl_a&id=${DOC_A}`, expect: 200 },
    // The QR scan (the Cleaner Hub, D5): a read the preview may make; a malformed code is the public
    // page's 404 before anything is read (the preview's scope over a live code: test-qr-scan-resolve D9–D10).
    scan: { q: 'scan?token=nope', expect: 404 },
    // One area's page (QR-16, QR Wave 2): a read the preview may make; an area the building does not
    // have is the hub's 404 that names nothing (the page over a real area: test-hub-area-page.mjs).
    area: { q: 'area?buildingId=cl_a&areaId=area_none', expect: 404 },
    // A team member's photo (HUB-19): a read the preview may make; a version nobody's current photo
    // has is the hub's 404 that names nothing (the photo itself: test-hub-faces.mjs).
    face: { q: 'face?buildingId=cl_a&v=0123456789abcdefghijklmno', expect: 404 },
    // Crew on the way's sign-up (UI_RULES §187): a preview's read answers off and reads nothing.
    push: { q: 'push?endpoint=https%3A%2F%2Fpush.example.test%2Fwp%2Fpreview', expect: 200 },
  };
  ok(`V0 every GET branch the route serves is named here (${gets.filter((g) => !(g in GETS)).join(', ') || 'all named'})`, gets.length >= 18 && gets.every((g) => g in GETS));
  for (const name of gets) {
    const spec = GETS[name];
    if (!spec) continue;
    const from = world.log.length;
    world.failWhen = spec.fail || null;
    const r = await look(spec.q);
    world.failWhen = null;
    const log = world.log.slice(from);
    ok(`🔴 V1 GET ${name} in preview answers (${spec.expect})`, () => r.status === spec.expect && (!spec.reached || spec.reached(log)), show(r));
  }
  const url = await look(`document-url?buildingId=cl_a&id=${DOC_A}`);
  ok('V2 the document link is a signed link to the previewed building\'s own file', () => url.status === 200 && /fake\.storage/.test(url.body?.url || ''), show(url));
  let last = null;
  for (let i = 0; i < 21; i += 1) last = await look('invoice-pdf?buildingId=cl_a&id=1001');
  ok('V3 the invoice PDF reaches its rate limit in a preview, keyed to the person previewing (21st in 10 min is a 429)',
    () => last?.status === 429 && last.body?.code === 'too-many-requests', show(last));
}

// ── 6. scope: exactly the previewed building ──────────────────────────────────
seed();
{
  const nope = await look('view', 'tok-owner', 'cl_nope');
  ok('🔴 C1 previewing a building that is not in the live customer book is a 404', () => nope.status === 404 && nope.body?.code === 'not-found', show(nope));
  const nopeWrite = await act('ticket-create', { id: NEW_TICKET, buildingId: 'cl_nope', type: 'complaint', category: 'spill', description: 'x' }, 'tok-owner', 'cl_nope');
  ok('🔴 C2 …on every branch, a write included — and NO stand-in is made for it', () => nopeWrite.status === 404 && standIns().length === 0, `${show(nopeWrite)} standIns=${standIns().length}`);
  for (const junk of ['../etc', 'cl_a, cl_x', ' ']) {
    const r = await look('view', 'tok-owner', junk);
    ok(`C3 a header that names no building (${JSON.stringify(junk)}) is never a preview`, () => r.status !== 200 && !(r.body?.buildings), show(r));
  }
  ok('C3b …and makes no stand-in', () => standIns().length === 0, JSON.stringify(standIns()));
  for (const other of ['cl_b', 'cl_x']) {
    const r = await look(`home?buildingId=${other}`);
    ok(`🔴 C4 previewing cl_a, another building (${other}) is a 404 that names nothing`, () => r.status === 404 && r.body?.code === 'not-found' && !/Harbor|Bayshore/.test(JSON.stringify(r.body)), show(r));
  }
  const crossCreate = await act('ticket-create', { id: NEW_TICKET, buildingId: 'cl_x', type: 'complaint', category: 'spill', description: 'x' });
  ok('🔴 C5 previewing cl_a, a request raised for another building is a 404 and writes nothing', () => crossCreate.status === 404 && !world.tables.problem_reports.some((p) => p.id === NEW_TICKET), show(crossCreate));
  for (const [label, q] of [
    ['ticket', `ticket?buildingId=cl_a&id=${T4}`],
    ['checklist', `checklist?buildingId=cl_a&id=${CR3}`],
    ['inspection', `inspection?buildingId=cl_a&id=${I4}`],
    ['document link', `document-url?buildingId=cl_a&id=${DOC_X}`],
  ]) {
    const r = await look(q);
    ok(`🔴 C6 another building's ${label}, asked through the previewed building, is a 404`, () => r.status === 404 && r.body?.code === 'not-found', show(r));
  }
  const crossReply = await act('ticket-message', { id: 'f0000000-0000-4000-8000-0000000000c1', buildingId: 'cl_a', ticketId: T4, body: 'hi' });
  ok('🔴 C7 …and so is a reply on it', () => crossReply.status === 404, show(crossReply));
}

// ── 7. a customer login gains nothing from the header ─────────────────────────
seed();
{
  const r = await call(hub, { path: 'view', token: 'tok-client4', preview: 'cl_a' });
  ok('🔴 K1 a customer login sending the header keeps ITS OWN scope (only cl_x), as itself',
    () => r.status === 200 && (r.body.buildings || []).map((b) => b.id).join() === 'cl_x' && r.body.viewer?.name === 'Harbor Person', show(r));
  const peek = await call(hub, { path: 'home?buildingId=cl_a', token: 'tok-client4', preview: 'cl_a' });
  ok('🔴 K2 …and the header opens nothing it did not have (cl_a is a 404)', () => peek.status === 404 && peek.body?.code === 'not-found', show(peek));
  const pat = await call(hub, { path: 'view', token: 'tok-client', preview: 'cl_x' });
  ok('K3 a customer naming another building in the header still sees exactly their own (cl_a, cl_b)',
    () => pat.status === 200 && (pat.body.buildings || []).map((b) => b.id).sort().join() === 'cl_a,cl_b' && pat.body.groups?.length === 1, show(pat));
  const w = await call(hub, { method: 'POST', path: 'ticket-message', token: 'tok-client', preview: 'cl_a', body: { id: 'f0000000-0000-4000-8000-0000000000cc', buildingId: 'cl_a', ticketId: T5, body: 'The east wall.' } });
  const m = world.tables.work_order_messages.find((x) => x.id === 'f0000000-0000-4000-8000-0000000000cc');
  ok('🔴 K4 …and its writes are its OWN, never the stand-in\'s', () => w.status === 200 && m?.author_client_user_id === CU1 && standIns().length === 0, show(w));
}

// ── 8. never another customer's data ─────────────────────────────────────────
seed();
{
  const mine = await call(hub, { path: 'updates', token: 'tok-client' });
  const look1 = await look('updates');
  ok('N1 control: the customer\'s own bell has news about their own requests', () => mine.status === 200 && (mine.body.updates || []).some((u) => /tickets\//.test(u.url || '')), show(mine));
  ok('🔴 N2 the preview\'s bell is the stand-in\'s: none of the customer\'s own requests\' news',
    () => look1.status === 200 && Array.isArray(look1.body.updates) && !(look1.body.updates || []).some((u) => u.url?.includes(T5) || u.url?.includes(T1))
      && sameKeys(look1.body, Object.keys(mine.body || {})), show(look1));
  const prefs = await call(hub, { path: 'email-prefs', token: 'tok-client' });
  const look2 = await look('email-prefs');
  ok('N3 control: the customer turned "Replies from the office" off', () => prefs.status === 200 && prefs.body?.prefs?.messages === false, show(prefs));
  ok('🔴 N4 the preview\'s switches are the stand-in\'s own (the defaults), never the customer\'s',
    () => look2.status === 200 && JSON.stringify(look2.body?.prefs) === JSON.stringify(resolveHubEmailPrefs(null)), show(look2));
  const thread = await call(hub, { path: 'messages?buildingId=cl_a', token: 'tok-client' });
  const look3 = await look('messages?buildingId=cl_a');
  ok('N5 control: the customer sees their own line as "mine"', () => thread.status === 200 && (thread.body.messages || []).some((m) => m.mine === true), show(thread));
  ok('🔴 N6 in the preview the customer\'s line is not "mine"', () => look3.status === 200 && look3.body.messages.length === 2 && look3.body.messages.every((m) => m.mine === false), show(look3));
  const req = await call(hub, { path: `ticket?buildingId=cl_a&id=${T5}`, token: 'tok-client' });
  const look4 = await look(`ticket?buildingId=cl_a&id=${T5}`);
  ok('N7 control: the customer\'s own request reads "You"', () => req.status === 200 && req.body.ticket?.raisedBy === 'You', show(req));
  ok('🔴 N8 in the preview another customer\'s request never reads "You"',
    () => look4.status === 200 && look4.body.ticket?.raisedBy !== 'You' && look4.body.ticket.messages.every((m) => m.from !== 'you'), show(look4));
  const v = await look('view');
  ok('🔴 N9 the preview\'s view carries no customer\'s name, email, phone or group',
    () => v.status === 200 && !/Pat Manager|pat@coralbay|555-0300|Royal Palm Holdings|Harbor Person|preview\.invalid/.test(JSON.stringify(v.body)) && !JSON.stringify(v.body).includes(G1), JSON.stringify(v.body).slice(0, 240));
  const row = world.tables.client_users.find((u) => u.id === CU1);
  ok('N10 …and nothing the preview read stamped the customer\'s row', () => row.updates_seen_at === null && JSON.stringify(row.email_prefs) === JSON.stringify(SECRET_PREFS));
}

// ── 9. the office's activity log records the preview ──────────────────────────
seed();
{
  await call(hub, { path: 'view', token: 'tok-client' });
  ok('L1 a customer opening their hub logs no preview', () => !world.tables.activity_log.some((r) => r.action === 'hub.previewed'));
  await look('view', 'tok-mgr');
  const rows = world.tables.activity_log.filter((r) => r.action === 'hub.previewed');
  ok('L2 a preview is logged once, as the staff member who opened it, against the building',
    () => rows.length === 1 && rows[0].actor_user_id === 'u_mgr' && rows[0].actor_role === 'manager' && rows[0].client_id === 'cl_a' && rows[0].entity_id === 'cl_a', JSON.stringify(rows));
  await look('home?buildingId=cl_a', 'tok-mgr');
  ok('L3 …on opening (the view), not on every read', () => world.tables.activity_log.filter((r) => r.action === 'hub.previewed').length === 1);
}

// ── 10. the tab's flag, the switch's words, and the screens ──────────────────
{
  const store = new Map();
  const realSession = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const fns = ['startHubPreview', 'readHubPreview', 'clearHubPreview'].every((f) => typeof pv[f] === 'function');
  ok('F1 the flag has its three helpers', fns);
  if (fns) {
    ok('F2 no flag, no preview', pv.readHubPreview() === null);
    ok('F3 a building with no id is refused', pv.startHubPreview({ buildingId: '  ' }) === false && pv.readHubPreview() === null);
    pv.startHubPreview({ buildingId: 'cl_a', name: 'Coral Bay HOA' });
    ok('F4 started, it reads back the building and its name, from this tab\'s sessionStorage',
      JSON.stringify(pv.readHubPreview()) === JSON.stringify({ buildingId: 'cl_a', name: 'Coral Bay HOA' }) && store.has(pv.HUB_PREVIEW_STORAGE_KEY));
    pv.clearHubPreview();
    ok('F5 Exit preview clears it', pv.readHubPreview() === null && !store.has(pv.HUB_PREVIEW_STORAGE_KEY));
    globalThis.sessionStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const started = pv.startHubPreview({ buildingId: 'cl_b', name: 'Bayshore' });
    ok('F6 with storage blocked, the preview is kept in memory and nothing throws', started === true && pv.readHubPreview()?.buildingId === 'cl_b');
    pv.clearHubPreview();
    ok('F7 …and clears the same way', pv.readHubPreview() === null);
    ok('F8 Exit preview returns to the building\'s customer page', pv.hubPreviewExitPath('cl_a') === '/clients/cl_a' && pv.hubPreviewExitPath(null) === '/');
  }
  globalThis.sessionStorage = realSession;
  const acting = typeof pv.hubPreviewBanner === 'function' ? pv.hubPreviewBanner('Coral Bay HOA') : '';
  ok('🔴 F9 acting as the customer, the banner says what is true: the customer\'s hub, and what is sent is real',
    /Coral Bay HOA's customer/.test(acting) && /real/.test(acting) && !/Nothing here is sent/.test(acting), acting);
  ok('F10 the stand-in\'s address is at the reserved .invalid domain, one per building',
    typeof pv.hubPreviewStandInEmail === 'function' && pv.hubPreviewStandInEmail('cl_A') === 'preview+cl_a@preview.invalid' && pv.isHubPreviewEmail?.('PREVIEW+x@Preview.Invalid') === true && pv.isHubPreviewEmail?.('pat@coralbay.test') === false);

  const { readFileSync } = await import('node:fs');
  const APP = new URL('../', import.meta.url);
  const code = (rel) => { try { return readFileSync(new URL(rel, APP), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); } catch { return ''; } };
  const root = code('src/pages/hub/HubRoot.jsx');
  ok('U1 HubRoot admits a staff session ONLY while previewing; otherwise the redirect to the office stands',
    /!isClientSession\(session\)\s*&&\s*!preview\)\s*return\s*<Navigate to="\/" replace \/>/.test(root) && /readHubPreview\(\)/.test(root));
  ok('U2 …and a customer session never previews (a stale flag is dropped)', /customer\s*&&\s*flag\)\s*clearHubPreview\(\)/.test(root));
  const api = code('src/lib/clientHubApi.js');
  ok('U3 every hub call names the previewed building in the header (and the two PDF fetches too)',
    /api\(path,\s*\{\s*\.\.\.opts,\s*headers:\s*previewHeaders\(\)\s*\}\)/.test(api) && (api.match(/\.\.\.previewHeaders\(\)/g) || []).length >= 2);
  ok('🔴 U3b …and the demo refuses a preview\'s writes only when the switch is off', /readHubPreview\(\)\s*&&\s*!hubPreviewActsAsCustomer\(\)/.test(api));
  const layout = code('src/layouts/HubLayout.jsx');
  ok('🔴 U4 the layout derives ONE flag, readOnly = preview && !the switch, puts it in the outlet context, and draws the banner + Exit preview',
    /const readOnly = previewing && !hubPreviewActsAsCustomer\(\)/.test(layout) && /readOnly,/.test(layout)
      && /hubPreviewBanner\(previewName\)/.test(layout) && /onClick=\{onExitPreview\}/.test(layout));
  const pages = ['HubTicket.jsx', 'HubNewTicket.jsx', 'HubRequests.jsx', 'HubHome.jsx', 'HubAccount.jsx', 'HubMessages.jsx', 'HubBell.jsx', 'HubEmailsCard.jsx'];
  for (const f of pages) {
    const src = code(`src/pages/hub/${f}`);
    ok(`🔴 U5 ${f} decides its writes on readOnly, never on preview`, src.length > 0 && /readOnly/.test(src) && !/disabled=\{[^}]*\bpreview\b/.test(src) && !/if \([^)]*\bpreview\b[^)]*\) return/.test(src),
      (src.match(/disabled=\{[^}]*\bpreview\b[^}]*\}/g) || []).join(' '));
  }
  const account = code('src/pages/hub/HubAccount.jsx');
  ok('U6 Change password stays off in any preview (there is no login to change), and Sign out stays Exit preview',
    /const nobody = preview \|\| demo/.test(account) && /<ChangePasswordCard noLogin=\{nobody\}/.test(account) && /disabled=\{noLogin \|\| busy\}/.test(account) && /onClick=\{exitPreview\}/.test(account));
  const sw = code('src/components/UserSwitcher.jsx');
  ok('U7 the user menu offers the live app\'s entry to holders of hub.users.view, opening the building picker',
    /usePermission\('hub\.users\.view'\)/.test(sw) && /setPickerOpen\(true\)/.test(sw) && /<HubPreviewPicker /.test(sw));
  const detail = code('src/pages/ClientDetail.jsx');
  ok('U8 the customer page offers "Preview customer hub" to holders of hub.users.view',
    /const canPreviewHub = usePermission\('hub\.users\.view'\)/.test(detail) && /startPreviewOf\(navigate, client\)/.test(detail));
  const demo = code('src/lib/hubDemo.js');
  ok('🔴 U9 the demo answers a preview as the server does: acting as the building\'s stand-in, or (switch off) nobody',
    /readHubPreview\(\)\?\.buildingId/.test(demo) && /hubPreviewActsAsCustomer\(\)/.test(demo) && /HUB_PREVIEW_VIEWER_NAME/.test(demo) && /viewerClientUserId: viewerId\(\)/.test(demo));
}

setActs(undefined);
console.log(`\nhub preview as customer: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
