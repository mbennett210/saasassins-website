// THE CLIENT HUB'S ROUTES, END TO END — the REAL /api/hub handler (and the office's /api/qc one,
// where the office half of a hub ticket lives) over fake-supabase.mjs. No network, no credentials,
// no live project (BUILD_INTEGRITY §6b: a server claim is never proved against production).
//
// What it holds, in the order it matters:
//   1. 🔴 SCOPE. Every route answers a client login only for a building it was assigned (directly
//      or through a group); a building, checklist, inspection or ticket outside that is a 404 that
//      never confirms the record exists. A staff login is refused without the preview header AND
//      hub.users.view (403 office-login with no header, 403 preview-forbidden for a cleaner sending
//      it; the preview itself is test-hub-preview.mjs's) and no login is a 401 — on every branch,
//      including an unknown one (authenticate before 404).
//   2. 🔴 ALLOWLISTS. Every served object's keys are exactly its constant in src/lib/clientHubView.js.
//   3. 🔴 NEVER INTERNAL. An inspection's internal_note (HUB-16) and an internal ticket note (WO-9)
//      are never served — and the internal note is excluded IN THE QUERY, not filtered after it.
//   4. The rules: first name + last initial (HUB-5), a year back and no further (HUB-9), the four
//      stages (WO-8), reopen for seven days and not after (WO-11), urgent (WO-4).
//   5. A hub ticket goes through the SAME store path the office uses — origin 'portal', the
//      supervisor-first bell (notifyTicketRaised) fires unchanged, and the office sees it in its
//      queue with the client's name. A double-tap is ONE ticket (the caller mints the id).
//   6. The emails (HUB-11) over a fake sender: who gets one and what it says — and with no sender
//      connected the office's action still succeeds (the send is skipped, never an error).
//   7. Error bodies are a sentence and a code, never the provider's text (CS-077 class).
//
// REGRESSION (THE LAW II.3): on the pre-change tree /api/hub answers only `view`, so every other
// branch below is a 404 and fails its check.
//
//   node app/scripts/test-client-hub-routes.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const { seedPermissions } = await import('../src/lib/roles.js');
const view = await tryImport('../src/lib/clientHubView.js');
const { HUB_BUILDING_FIELDS } = await import('../src/lib/clientHub.js');
const { IDENTITY } = await import('../src/brand/identity.generated.js');
const { ticketRaisedEventKey } = await import('../src/lib/ticketAlerts.js');
const { ALWAYS_PUSH_EVENT_KEYS, OFFICE_HOURS_EVENT_KEYS } = await import('../src/lib/alertDelivery.js');
const hub = (await import('../api/hub/[...path].js')).default;
const qc = (await import('../api/qc/[...path].js')).default;
const store = await import('../api/_lib/qc/store.js');
const notify = await tryImport('../api/_lib/clientHub/notify.js');
const reads = await import('../api/_lib/clientHub/reads.js');
// The redesign's projections (2026-10-08): the view, Home's tiles, the crew status and the visit.
const hubLib = await import('../src/lib/clientHub.js');
const homeLib = await tryImport('../src/lib/hubHome.js');
const visitLib = await tryImport('../src/lib/hubVisit.js');
// The office's "Preview as customer" vocabulary (plan §3.7): the header and the refusal code.
const PREVIEW = await tryImport('../src/lib/hubPreview.js');

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

// ── the world ─────────────────────────────────────────────────────────────────
const H = 3600000;
const DAY = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const SECRET_NOTE = 'ZZINSPNOTEZZ the supervisor covered for a late crew';
const SECRET_MSG = 'ZZINTERNALMSGZZ quote it as an add-on before promising';
const PROVIDER_TEXT = 'relation "zz_secret_internal_table" does not exist';

const CU1 = 'a0000000-0000-4000-8000-000000000001'; // Pat Manager: cl_a directly, cl_b through group G1
const CU2 = 'a0000000-0000-4000-8000-000000000002'; // disabled, was given cl_a
const CU3 = 'a0000000-0000-4000-8000-000000000003'; // through group G2, which holds cl_a
const CU4 = 'a0000000-0000-4000-8000-000000000004'; // only cl_x
const G1 = 'b0000000-0000-4000-8000-000000000001';
const G2 = 'b0000000-0000-4000-8000-000000000002';
const I1 = 'c0000000-0000-4000-8000-000000000001';   // cl_a, submitted, fail, carries the internal note
const I2 = 'c0000000-0000-4000-8000-000000000002';   // cl_a, a DRAFT
const I3 = 'c0000000-0000-4000-8000-000000000003';   // cl_a, 400 days old
const I4 = 'c0000000-0000-4000-8000-000000000004';   // cl_x
const I5 = 'c0000000-0000-4000-8000-000000000005';   // cl_a draft the office submits (the email trigger)
const CR1 = 'd0000000-0000-4000-8000-000000000001';  // cl_a, yesterday, notes + photo
const CR2 = 'd0000000-0000-4000-8000-000000000002';  // cl_a, 400 days old
const CR3 = 'd0000000-0000-4000-8000-000000000003';  // cl_x
const T1 = 'e0000000-0000-4000-8000-000000000001';   // cl_a portal, resolved 2 days ago (reopenable)
const T2 = 'e0000000-0000-4000-8000-000000000002';   // cl_a portal, resolved 10 days ago (not)
const T3 = 'e0000000-0000-4000-8000-000000000003';   // cl_a INTERNAL origin — never a client's
const T4 = 'e0000000-0000-4000-8000-000000000004';   // cl_x portal
const T5 = 'e0000000-0000-4000-8000-000000000005';   // cl_a portal, awaiting the client
const NEW_TICKET = 'e0000000-0000-4000-8000-0000000000aa';
const NEW_MSG = 'f0000000-0000-4000-8000-0000000000aa';

const user = (id, role, name, extra = {}) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {}, ...extra });
const CK_SCHEMA = { areas: [{ id: 'a1', label: 'Floors', items: [
  { id: 'f_sweep', label: 'Swept' }, { id: 'f_mop', label: 'Mopped', photoRequired: true }, { id: 'f_spot', label: 'Spots', naAllowed: true },
] }] };
const IN_SNAP = { name: 'Restroom QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 85 }, schema: { areas: [
  { id: 'a_fix', label: 'Fixtures', items: [{ id: 'i1', label: 'Toilets' }, { id: 'i2', label: 'Sinks' }] },
  { id: 'a_sup', label: 'Supplies', items: [{ id: 'i3', label: 'Soap' }] },
] } };
const insp = (id, client, site, status, performedAgo, extra = {}) => ({
  id, organization_id: ORG, public_token: `tok_pub_${id.slice(-2)}`, template_id: 'it_r', template_version_id: 'iv_r',
  template_snapshot: IN_SNAP, client_id: client, site_id: site, job_id: null, inspector_user_id: 'u_mgr',
  client_name: client === 'cl_a' ? 'Coral Bay HOA' : 'Harbor Tower', site_name: 'Clubhouse', inspector_name: 'Renata Cruz',
  status, overall_score: status === 'submitted' ? 33 : null, result: status === 'submitted' ? 'fail' : null, internal_note: null,
  performed_at: ago(performedAgo), ...extra,
});
const ticket = (id, client, site, origin, status, createdAgo, extra = {}) => ({
  id, organization_id: ORG, client_id: client, site_id: site, job_id: null, reported_by_user_id: null, assignee_user_id: 'u_mgr',
  client_name: client === 'cl_a' ? 'Coral Bay HOA' : 'Harbor Tower', site_name: 'Clubhouse', title: `Ticket ${id.slice(-1)}`, description: 'Something to look at.',
  type: 'complaint', origin, category: 'spill', priority: 'medium', status, created_at: ago(createdAgo), due_at: ago(createdAgo - DAY),
  resolved_at: null, escalated_at: null, raised_by_client_user_id: origin === 'portal' && client === 'cl_a' ? CU1 : null,
  raised_by_client_name: origin === 'portal' && client === 'cl_a' ? 'Pat Manager' : null, ...extra,
});
const msg = (id, problemId, role, name, body, createdAgo, extra = {}) => ({
  id, organization_id: ORG, problem_id: problemId, author_user_id: role === 'client' ? null : 'u_mgr', author_role: role,
  author_name: name, author_client_user_id: role === 'client' ? CU1 : null, body, translated_body: null, from_lang: null,
  internal: false, created_at: ago(createdAgo), ...extra,
});
const media = (id, scope, ref, area, site, extra = {}) => ({
  id, organization_id: ORG, scope, ref_id: ref, area_id: area, site_id: site, client_id: 'cl_a', kind: 'image', mime_type: 'image/jpeg',
  storage_path: `${ORG}/${site}/${id}x.jpg`, thumb_path: null, caption: null, uploaded_by_user_id: 'u_crew', created_at: ago(DAY), ...extra,
});

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [
            user('u_owner', 'owner', 'Dana Owner', { phone: '(754) 555-0101' }),
            user('u_mgr', 'manager', 'Renata Cruz', { phone: '(754) 555-0105', pay: { type: 'salary', salaryPerPeriod: 2800 } }),
            user('u_crew', 'crew', 'Tomas Rivera', { phone: '(754) 555-0122' }),
            user('u_crew2', 'crew', 'Keisha Bryant'),
          ],
          clients: [
            { id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr', street: '120 Royal Palm Way', city: 'Boca Raton', state: 'FL', zip: '33432', revenue: 1100, notes: 'gate code 4455' },
            { id: 'cl_b', name: 'Bayshore Senior Living', supervisorId: 'u_owner', street: '1515 S Flagler Dr', city: 'West Palm Beach', state: 'FL', zip: '33401' },
            { id: 'cl_x', name: 'Harbor Tower', supervisorId: 'u_mgr' },
          ],
          sites: [
            { id: 's_a', clientId: 'cl_a', name: 'Clubhouse', address: '120 Royal Palm Way, Boca Raton FL 33432', lat: 26.3, lng: -80.08 },
            { id: 's_b', clientId: 'cl_b', name: 'Main Residence', address: '1515 S Flagler Dr, West Palm Beach FL 33401' },
            { id: 's_x', clientId: 'cl_x', name: 'Tower', address: '1 Harbor Way' },
          ],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          notifications: [],
        },
      }],
      crew_assignments: [],
      client_users: [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1' },
        { id: CU2, organization_id: ORG, name: 'Old Contact', email: 'old@coralbay.test', phone: null, status: 'disabled', auth_user_id: 'auth-c2' },
        { id: CU3, organization_id: ORG, name: 'Jordan Wells', email: 'jordan@royalpalm.test', phone: null, status: 'invited', auth_user_id: 'auth-c3' },
        { id: CU4, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c4' },
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
      // The redesign's visits (2026-10-08): today's clean at cl_a began 68 minutes ago (Tomas
      // punched in 70 minutes ago, two minutes early, naming it), the next one is in three days, one is cancelled;
      // cl_x has its own clean today. `data` carries a note the hub must never read.
      jobs: [
        { id: 'j_a_today', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', status: 'in_progress', start_at: ago(68 * 60000), data: { id: 'j_a_today', clientId: 'cl_a', startAt: ago(68 * 60000), endAt: ago(-60 * 60000), crewIds: ['u_crew', 'u_crew2'], notes: 'ZZJOBNOTEZZ alarm 4455' } },
        { id: 'j_a_next', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', status: 'upcoming', start_at: ago(-3 * DAY), data: { id: 'j_a_next', clientId: 'cl_a', startAt: ago(-3 * DAY), crewIds: ['u_crew'] } },
        { id: 'j_a_cancel', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', status: 'cancelled', start_at: ago(-DAY), data: { id: 'j_a_cancel', clientId: 'cl_a', startAt: ago(-DAY), crewIds: [] } },
        { id: 'j_x_today', organization_id: ORG, client_id: 'cl_x', site_id: 's_x', status: 'in_progress', start_at: ago(15 * 60000), data: { id: 'j_x_today', clientId: 'cl_x', startAt: ago(15 * 60000), crewIds: ['u_crew'] } },
        { id: 'j_x_next', organization_id: ORG, client_id: 'cl_x', site_id: 's_x', status: 'upcoming', start_at: ago(-2 * DAY), data: { id: 'j_x_next', clientId: 'cl_x', startAt: ago(-2 * DAY), crewIds: [] } },
      ],
      time_entries: [
        { id: 'te1', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew', user_name: 'Tomas Rivera', job_id: 'j_a_today', clock_in_at: ago(70 * 60000), clock_out_at: null, status: 'in_progress', geofence_result: 'inside', clock_in_distance_m: 9, clock_in_lat: 26.3, clock_in_lng: -80.08 },
        { id: 'te2', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew2', user_name: 'Keisha Bryant', clock_in_at: ago(25 * 60000), clock_out_at: null, status: 'in_progress', geofence_result: 'unavailable' },
        { id: 'te3', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew', user_name: 'Tomas Rivera', clock_in_at: ago(DAY + 3 * H), clock_out_at: ago(DAY + H), status: 'completed', geofence_result: 'inside' },
        { id: 'te4', organization_id: ORG, client_id: 'cl_x', site_id: 's_x', user_id: 'u_crew', user_name: 'Tomas Rivera', clock_in_at: ago(10 * 60000), clock_out_at: null, status: 'in_progress', geofence_result: 'inside' },
        { id: 'te5', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew', user_name: 'Tomas Rivera', clock_in_at: ago(400 * DAY), clock_out_at: ago(400 * DAY - H), status: 'completed', geofence_result: 'inside' },
      ],
      checklist_results: [
        { id: CR1, organization_id: ORG, template_id: 'it_f', template_version_id: 'iv_f', template_snapshot: { name: 'Floor Care', kind: 'checklist', schema: CK_SCHEMA }, client_id: 'cl_a', site_id: 's_a', job_id: null, completed_by_user_id: 'u_crew', items: [{ key: 'f_sweep', checked: true, note: 'Swept twice, muddy boots.' }, { key: 'f_mop', checked: true }, { key: 'f_spot', na: true }], completed_count: 3, total_count: 3, client_submit_id: 'cs_cr1', area_completions: null, performed_at: ago(DAY) },
        { id: CR2, organization_id: ORG, template_id: 'it_f', template_version_id: 'iv_f', template_snapshot: { name: 'Floor Care', kind: 'checklist', schema: CK_SCHEMA }, client_id: 'cl_a', site_id: 's_a', job_id: null, completed_by_user_id: 'u_crew', items: [], completed_count: 0, total_count: 3, client_submit_id: 'cs_cr2', area_completions: null, performed_at: ago(400 * DAY) },
        { id: CR3, organization_id: ORG, template_id: 'it_f', template_version_id: 'iv_f', template_snapshot: { name: 'Harbor list', kind: 'checklist', schema: CK_SCHEMA }, client_id: 'cl_x', site_id: 's_x', job_id: null, completed_by_user_id: 'u_crew', items: [], completed_count: 0, total_count: 3, client_submit_id: 'cs_cr3', area_completions: null, performed_at: ago(DAY) },
      ],
      account_media: [
        media('m_ck', 'checklist', 'cs_cr1', 'f_mop', 's_a'),
        media('m_cp', 'problem_report', T1, null, 's_a'),
        media('m_in', 'inspection', I1, 'a_fix', 's_a'),
        // Today's visits' own before/after photos (the cleaner's guided visit: scope 'clean', the
        // job, area before/after) — cl_a's, and cl_x's, which cl_a's visit must never show.
        media('m_vb', 'clean', 'j_a_today', 'before', 's_a'),
        media('m_va', 'clean', 'j_a_today', 'after', 's_a'),
        media('m_vv', 'clean', 'j_a_today', 'before', 's_a', { kind: 'video', mime_type: 'video/mp4' }),
        media('m_vx', 'clean', 'j_x_today', 'before', 's_x', { client_id: 'cl_x' }),
      ],
      inspection_records: [
        insp(I1, 'cl_a', 's_a', 'submitted', 2 * DAY, { internal_note: SECRET_NOTE }),
        insp(I2, 'cl_a', 's_a', 'draft', DAY),
        insp(I3, 'cl_a', 's_a', 'submitted', 400 * DAY),
        insp(I4, 'cl_x', 's_x', 'submitted', DAY),
        insp(I5, 'cl_a', 's_a', 'draft', H),
      ],
      inspection_items: [
        { id: 'ii1', inspection_id: I1, item_key: 'i1', label: 'Fixtures. Toilets', rating: 'fail', comment: 'Scale under the rims.', photo_count: 0 },
        { id: 'ii2', inspection_id: I1, item_key: 'i2', label: 'Fixtures. Sinks', rating: 'pass', comment: null, photo_count: 0 },
        { id: 'ii3', inspection_id: I1, item_key: 'i3', label: 'Supplies. Soap', rating: 'fail', comment: 'Two dispensers empty.', photo_count: 0 },
      ],
      problem_reports: [
        ticket(T1, 'cl_a', 's_a', 'portal', 'resolved', 3 * DAY, { resolved_at: ago(2 * DAY), title: 'Coffee stain' }),
        ticket(T2, 'cl_a', 's_a', 'portal', 'resolved', 12 * DAY, { resolved_at: ago(10 * DAY), title: 'Pool deck' }),
        ticket(T3, 'cl_a', 's_a', 'internal', 'open', DAY, { title: 'Office-only scrub list' }),
        ticket(T4, 'cl_x', 's_x', 'portal', 'open', DAY, { title: 'Harbor thing' }),
        ticket(T5, 'cl_a', 's_a', 'portal', 'awaiting_client', 2 * DAY, { title: 'Scuff marks' }),
      ],
      work_order_messages: [
        msg('w1', T1, 'client', 'Pat Manager', 'Can the stain be treated?', 3 * DAY),
        msg('w2', T1, 'office', 'Renata Cruz', SECRET_MSG, 3 * DAY - 60000, { internal: true }),
        msg('w3', T1, 'crew', 'Priya Nair', 'Treated and extracted.', 2 * DAY + H),
        msg('w4', T5, 'office', 'Renata Cruz', 'Which wall, the east or the west?', DAY),
      ],
      activity_log: [
        { id: 'al1', organization_id: ORG, occurred_at: ago(2 * DAY), actor_user_id: 'u_mgr', actor_name: 'Renata Cruz', actor_role: 'manager', auto: false, action: 'ticket.status_changed', entity_type: 'work_order', entity_id: T1, client_id: 'cl_a', client_name: 'Coral Bay HOA', summary: 'x', before: { status: 'in_progress' }, after: { status: 'resolved' }, is_money: false },
        { id: 'al2', organization_id: ORG, occurred_at: ago(DAY), actor_user_id: 'u_mgr', actor_name: 'Renata Cruz', actor_role: 'manager', auto: false, action: 'ticket.status_changed', entity_type: 'work_order', entity_id: T3, client_id: 'cl_a', client_name: 'Coral Bay HOA', summary: 'internal', before: { status: 'open' }, after: { status: 'in_progress' }, is_money: false },
        { id: 'al3', organization_id: ORG, occurred_at: ago(DAY), actor_user_id: 'u_owner', actor_name: 'Dana Owner', actor_role: 'owner', auto: false, action: 'pay.rate_changed', entity_type: 'user', entity_id: 'u_crew', client_id: 'cl_a', client_name: 'Coral Bay HOA', summary: 'ZZPAYZZ hourly $20 → $22', before: null, after: { pay: { hourlyRate: 22 } }, is_money: true },
      ],
      inbox_accounts: [],
    },
    logins: {
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client2': { id: 'auth-c2', email: 'old@coralbay.test', app_metadata: { role: 'client', client_user_id: CU2, org_id: ORG } },
      'tok-client4': { id: 'auth-c4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU4, org_id: ORG } },
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
    },
  });
  // The view's next visits (migration 20261008100000 hub_next_visits): the function's own rule —
  // `distinct on (client_id)` the soonest upcoming job from p_from within 60 days, for the ids
  // passed. Every set of ids asked is kept, so the suite sees the view asks only for its scope.
  world.rpc = (name, args) => {
    if (name !== 'hub_next_visits') return { data: null, error: { message: `no function ${name}`, code: 'PGRST202' } };
    nextVisitAsks.push([...(args?.p_client_ids || [])]);
    const from = Date.parse(args?.p_from);
    const best = new Map();
    for (const j of world.tables.jobs || []) {
      const t = Date.parse(j.start_at);
      if (j.organization_id !== args?.p_org || !(args?.p_client_ids || []).includes(j.client_id) || j.status !== 'upcoming') continue;
      if (!(t >= from && t < from + 60 * DAY)) continue;
      if (!best.has(j.client_id) || t < Date.parse(best.get(j.client_id).start_at)) best.set(j.client_id, { client_id: j.client_id, start_at: j.start_at });
    }
    return { data: [...best.values()], error: null };
  };
}
const nextVisitAsks = [];

async function call(handler, { method = 'GET', path: p, token, body, headers: extra = {} }) {
  const [sub, qs] = p.split('?');
  const req = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body || {} };
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
const office = (p, body) => call(qc, { method: body ? 'POST' : 'GET', path: p, token: 'tok-owner', body });

// Every branch the hub serves, with one in-scope request each — the auth sweep runs all of them.
const ROUTES = [
  ['GET', 'view'],
  ['GET', 'home?buildingId=cl_a'],
  ['GET', 'visit?buildingId=cl_a'],
  ['GET', 'checklists?buildingId=cl_a'],
  ['GET', `checklist?buildingId=cl_a&id=${CR1}`],
  ['GET', 'inspections?buildingId=cl_a'],
  ['GET', `inspection?buildingId=cl_a&id=${I1}`],
  ['GET', `inspection-pdf?buildingId=cl_a&id=${I1}`],
  ['GET', 'tickets?buildingId=cl_a'],
  ['GET', `ticket?buildingId=cl_a&id=${T1}`],
  ['POST', 'ticket-create', { id: NEW_TICKET, buildingId: 'cl_a', type: 'complaint', category: 'spill', description: 'Spill by the mailboxes.' }],
  ['POST', 'ticket-message', { id: NEW_MSG, buildingId: 'cl_a', ticketId: T5, body: 'The east wall.' }],
  ['POST', 'ticket-reopen', { buildingId: 'cl_a', ticketId: T1 }],
  ['POST', 'ticket-photo-url', { buildingId: 'cl_a', ticketId: T5, mimeType: 'image/jpeg', sizeBytes: 1000 }],
  ['POST', 'ticket-photo', { buildingId: 'cl_a', ticketId: T5, storagePath: `${ORG}/s_a/abcdef0123456789.jpg`, mimeType: 'image/jpeg', sizeBytes: 1000 }],
  ['GET', 'history?buildingId=cl_a'],
  // A team member's photo by its version (HUB-19): the rest of it is test-hub-faces.mjs's.
  ['GET', 'face?buildingId=cl_a&v=0123456789abcdefghijklmno'],
];

// ── 1. authentication and audience, on EVERY branch ─────────────────────────
// A2 / A2b, deliberately (the client hub redesign, plan §3.7 "Preview as customer", 2026-10-08): a
// STAFF login is refused WITHOUT the preview header AND hub.users.view. With no header it is the
// old answer (403 office-login); with the header but without the key — a cleaner — it is refused
// as a preview (403 preview-forbidden). What a staff login WITH both may do is
// test-hub-preview.mjs's (reads only; every write 403 preview-read-only).
seed();
for (const [method, p, body] of ROUTES) {
  const anon = await call(hub, { method, path: p, body });
  ok(`A1 ${method} ${p.split('?')[0]}: no login is a 401`, () => anon.status === 401, show(anon));
  const staff = await call(hub, { method, path: p, token: 'tok-owner', body });
  ok(`🔴 A2 ${method} ${p.split('?')[0]}: a STAFF login with no preview header is refused (403 office-login)`, () => staff.status === 403 && staff.body?.code === 'office-login', show(staff));
  const crewPreview = await call(hub, { method, path: p, token: 'tok-crew', body, headers: { [PREVIEW.HUB_PREVIEW_HEADER || 'x-hub-preview']: 'cl_a' } });
  ok(`🔴 A2b ${method} ${p.split('?')[0]}: …and WITH the header but without hub.users.view (a cleaner) it is refused too (403 preview-forbidden)`,
    () => crewPreview.status === 403 && !!PREVIEW.HUB_PREVIEW_FORBIDDEN && crewPreview.body?.code === PREVIEW.HUB_PREVIEW_FORBIDDEN, show(crewPreview));
  const disabled = await call(hub, { method, path: p, token: 'tok-client2', body });
  ok(`🔴 A3 ${method} ${p.split('?')[0]}: a DISABLED client user is refused`, () => disabled.status === 403 && disabled.body?.code === 'account-disabled', show(disabled));
}
{
  const anon = await call(hub, { path: 'no-such-branch' });
  ok('A4 an unknown branch authenticates FIRST: no login is a 401, not a 404', () => anon.status === 401, show(anon));
  const client = await get('no-such-branch');
  ok('A5 …and a client login on an unknown branch is a 404 with a code', () => client.status === 404 && client.body?.code === 'not-found', show(client));
  // A6, deliberately (2026-10-09, Daniel: the office's preview "should simulate being signed into
  // that account"): a staff login WITH the header and hub.users.view is no longer refused a write —
  // it ACTS as the building's STAND-IN customer, never as a real one. test-hub-preview.mjs holds
  // every write, the stand-in rule and the switch back to read-only.
  const ownerPreview = await call(hub, { method: 'POST', path: 'ticket-create', token: 'tok-owner', headers: { [PREVIEW.HUB_PREVIEW_HEADER || 'x-hub-preview']: 'cl_a' }, body: { id: 'e0000000-0000-4000-8000-0000000000dd', buildingId: 'cl_a', type: 'request', category: 'other', description: 'Raised in the office\'s preview.' } });
  const raisedBy = world.tables.client_users.find((u) => u.id === world.tables.problem_reports.find((p) => p.id === 'e0000000-0000-4000-8000-0000000000dd')?.raised_by_client_user_id);
  ok('🔴 A6 an owner WITH the preview header raises a request AS the building\'s stand-in (status preview, "Preview customer"), never as a real customer',
    () => ownerPreview.status === 200 && raisedBy?.status === 'preview' && raisedBy.name === 'Preview customer' && raisedBy.id !== CU1, show(ownerPreview));
}

// ── 2. the redesign (2026-10-08): the view, Home and Today's Visit ───────────
// HUB-5 (who is on site), HUB-12 / HUB-18 (the manager's own phone), D4 (the manager only while
// they are one), the crew status rule (src/lib/hubVisit.js), the tiles (src/lib/hubHome.js).
seed();
{
  nextVisitAsks.length = 0;
  const v = await get('view');
  ok('V1 the view answers the client, EXACTLY its allowlist', () => v.status === 200 && sameKeys(v.body, hubLib.HUB_VIEW_FIELDS), show(v));
  ok('🔴 V2 …each building EXACTLY the view row allowlist (the building projection + its next visit)',
    () => (v.body.buildings || []).length === 2 && v.body.buildings.every((b) => sameKeys(b, hubLib.HUB_VIEW_BUILDING_FIELDS)));
  const a = (v.body.buildings || []).find((b) => b.id === 'cl_a');
  const bb = (v.body.buildings || []).find((b) => b.id === 'cl_b');
  ok('V3 …each building\'s next visit from the one bounded function, only for the buildings in scope',
    () => a?.nextVisit === new Date(world.tables.jobs.find((j) => j.id === 'j_a_next').start_at).toISOString() && bb?.nextVisit === null
      && nextVisitAsks.length === 1 && nextVisitAsks[0].slice().sort().join() === 'cl_a,cl_b', JSON.stringify({ a: a?.nextVisit, asks: nextVisitAsks }));
  ok('V4 the viewer: their own name, first name, email and phone — EXACTLY that', () => sameKeys(v.body.viewer, hubLib.HUB_VIEWER_FIELDS) && v.body.viewer.firstName === 'Pat');
  ok('🔴 V5 the groups this login is ASSIGNED (Royal Palm, holding cl_b), never one it only shares a building with (Boca Raton)',
    () => (v.body.groups || []).length === 1 && v.body.groups[0].id === G1 && v.body.groups[0].buildingIds.join() === 'cl_b'
      && sameKeys(v.body.groups[0], hubLib.HUB_GROUP_FIELDS) && !JSON.stringify(v.body).includes(G2), JSON.stringify(v.body.groups));
  ok('V6 the org\'s zone rides along (company.timezone)', () => v.body.timezone === 'America/New_York');
  ok('🔴 V7 the manager is first name + last initial with their own phone (HUB-18)', () => a?.supervisor?.name === 'Renata C.' && a.supervisor.phone === '(754) 555-0105' && bb?.supervisor?.name === 'Dana O.');
  ok('🔴 V8 no full staff name, pay, revenue or note reaches the view', () => !/Renata Cruz|Dana Owner|2800|1100|gate code|ZZJOBNOTEZZ/.test(JSON.stringify(v.body)));
  // D4: a supervisor demoted to crew is no longer the building's manager.
  world.tables.org_state[0].state.clients.find((x) => x.id === 'cl_b').supervisorId = 'u_crew';
  const v2 = await get('view');
  ok('V9 a supervisor no longer an office tier is nobody\'s manager (the hub says "your account team")',
    () => v2.status === 200 && v2.body.buildings.find((b) => b.id === 'cl_b')?.supervisor === null, show(v2));
  world.tables.org_state[0].state.clients.find((x) => x.id === 'cl_b').supervisorId = 'u_owner';
  // The next visits are display extras: a function that is not there yet leaves them empty.
  world.rpc = () => ({ data: null, error: { message: PROVIDER_TEXT, code: 'PGRST202' } });
  const v3 = await get('view');
  ok('V10 with hub_next_visits missing the view still opens, with no next visits and no provider text',
    () => v3.status === 200 && v3.body.buildings.every((b) => b.nextVisit === null) && !JSON.stringify(v3.body).includes('zz_secret'), show(v3));
}
seed();
{
  const r = await get('home?buildingId=cl_a');
  ok('B1 Home: a client reads their own building\'s Home, EXACTLY its allowlist', () => r.status === 200 && sameKeys(r.body, homeLib.HUB_HOME_FIELDS), show(r));
  ok('🔴 B2 …the building is EXACTLY the building allowlist (the Round 1 projection, not widened)', () => sameKeys(r.body.building, HUB_BUILDING_FIELDS));
  ok('B3 …the manager\'s own phone for the Call button (HUB-18)', () => r.body.building.supervisor?.phone === '(754) 555-0105');
  const crew = r.body.crew || {};
  ok('B4 the crew band: on site now, EXACTLY its allowlist (no timeline on Home)', () => crew.state === 'on_site' && sameKeys(crew, visitLib.HUB_CREW_FIELDS), JSON.stringify(crew));
  ok('B5 …arrived at the first clock-in, two minutes early against the job it names, "Tomas R. + 1"',
    () => crew.arrivedAt === world.tables.time_entries.find((e) => e.id === 'te1').clock_in_at
      && crew.timeliness?.kind === 'early' && crew.timeliness.minutes === 2 && crew.crew?.lead === 'Tomas R.' && crew.crew.others === 1, JSON.stringify(crew));
  ok('B6 the Requests tile: 0 new, 0 in progress, 1 needs the customer — the client tickets only',
    () => sameKeys(r.body.requests, homeLib.HUB_REQUEST_COUNT_FIELDS) && r.body.requests.received === 0 && r.body.requests.working === 0 && r.body.requests.needsInfo === 1, JSON.stringify(r.body.requests));
  ok('B7 the Checklists tile: none today, the last one (yesterday\'s 3 of 3)',
    () => r.body.checklists.today.count === 0 && r.body.checklists.last?.done === 3 && r.body.checklists.last.total === 3, JSON.stringify(r.body.checklists));
  ok('B8 the Inspections tile: the last SUBMITTED report in the year (not the draft, not the 400-day one), its trend and its photo',
    () => r.body.inspections.last?.id === I1 && r.body.inspections.last.score === 33 && r.body.inspections.trend.length === 1
      && r.body.inspections.photos.length === 1 && /fake\.storage/.test(r.body.inspections.photos[0].url || '')
      && sameKeys(r.body.inspections.last, homeLib.HUB_INSPECTION_LAST_FIELDS), JSON.stringify(r.body.inspections));
  const blob = JSON.stringify(r.body);
  ok('🔴 B9 nothing else from the records: no revenue, notes, pay, full names, distance, coordinates, ids or a job note',
    () => r.status === 200 && !/1100|gate code|2800|Rivera|Bryant|Renata Cruz|clock_in_distance|26\.3|555-0122|u_crew|j_a_today|ZZJOBNOTEZZ|crewIds/.test(blob), blob.slice(0, 300));
  const jobRead = world.log.filter((q) => q.table === 'jobs');
  ok('🔴 B10 the jobs are read by declared columns and the building, never the whole payload',
    () => jobRead.length > 0 && jobRead.every((q) => q.cols !== '*' && !/(^|,)data(,|$)/.test(q.cols) && q.eq.client_id === 'cl_a'), JSON.stringify(jobRead.slice(0, 2)));
  const grp = await get('home?buildingId=cl_b');
  ok('B11 a building granted through a GROUP opens (HUB-17), with no visit today', () => grp.status === 200 && grp.body?.building?.id === 'cl_b' && grp.body.crew.state === 'none', show(grp));
  for (const id of ['cl_x', 'cl_nope', '../etc', '']) {
    for (const branch of ['home', 'visit']) {
      const x = await get(`${branch}?buildingId=${encodeURIComponent(id)}`);
      ok(`🔴 B12 ${branch} for a building outside the login's scope (${id || 'none'}) is a 404 that confirms nothing`, () => x.status === 404 && x.body?.code === 'not-found' && !JSON.stringify(x.body).includes('Harbor'), show(x));
    }
  }
  ok('B13 the answer is private and never cached', () => /no-store/.test(r.headers?.['cache-control'] || '') && /private/.test(r.headers?.['cache-control'] || ''));
}
{
  const r = await get('visit?buildingId=cl_a');
  ok('W1 Today\'s Visit: EXACTLY its allowlist', () => r.status === 200 && sameKeys(r.body, visitLib.HUB_VISIT_FIELDS), show(r));
  const onSite = r.body.onSite || [];
  ok('W2 who is on site now: the two open punches here, first name + last initial (HUB-5)',
    () => onSite.map((p) => p.name).join('|') === 'Tomas R.|Keisha B.', JSON.stringify(onSite));
  ok('🔴 W3 …each EXACTLY the on-site allowlist', () => onSite.length === 2 && onSite.every((p) => sameKeys(p, view.HUB_ON_SITE_FIELDS)));
  ok('W4 …location verified only for an inside punch', () => onSite[0]?.locationVerified === true && onSite[1]?.locationVerified === false);
  ok('W5 the timeline: scheduled, checked in, checked out pending — no checklist steps when none is expected',
    () => (r.body.timeline || []).map((s) => s.key).join() === 'scheduled,checked_in,checked_out' && r.body.timeline.every((s) => sameKeys(s, visitLib.HUB_TIMELINE_FIELDS)), JSON.stringify(r.body.timeline));
  ok('W6 the visit\'s own before/after photos, images only, signed for this read',
    () => r.body.photos.before.map((p) => p.id).join() === 'm_vb' && r.body.photos.after.map((p) => p.id).join() === 'm_va'
      && r.body.photos.more === 0 && /fake\.storage/.test(r.body.photos.before[0].url || '') && r.body.photos.before.every((p) => sameKeys(p, view.HUB_PHOTO_FIELDS)), JSON.stringify(r.body.photos));
  ok('W7 the next visits: upcoming only (never the cancelled one or today\'s)', () => r.body.upcoming.length === 1 && sameKeys(r.body.upcoming[0], visitLib.HUB_UPCOMING_FIELDS)
    && r.body.upcoming[0].startAt === new Date(world.tables.jobs.find((j) => j.id === 'j_a_next').start_at).toISOString(), JSON.stringify(r.body.upcoming));
  ok('W8 the account manager: first name + last initial and their own phone', () => sameKeys(r.body.manager, visitLib.HUB_MANAGER_FIELDS) && r.body.manager.name === 'Renata C.' && r.body.manager.phone === '(754) 555-0105');
  const blob = JSON.stringify(r.body);
  ok('🔴 W9 never another building\'s photo, a storage key, a staff id or full name, or a job note',
    () => r.status === 200 && !/m_vx|m_vv|storage_path|u_crew|Rivera|Bryant|Renata Cruz|ZZJOBNOTEZZ|j_a_today|j_x_today/.test(blob), blob.slice(0, 300));
  // 🔴 THE PHOTO READ IS SCOPED BY THE BUILDING, IN THE QUERY: asked for cl_a with another
  // building's job id, it comes back empty though a 'clean' photo filed under that job exists.
  const foreign = typeof reads.visitPhotos === 'function'
    ? await reads.visitPhotos({ clientId: 'cl_a', jobIds: ['j_x_today'] })
    : { total: -1, photos: [] };
  ok('🔴 W10 another building\'s job id returns nothing from the visit photo read (the building is in the query)',
    () => foreign.total === 0 && foreign.photos.length === 0 && world.tables.account_media.some((m) => m.ref_id === 'j_x_today'), JSON.stringify(foreign));
  const photoQ = world.log.filter((q) => q.table === 'account_media' && q.eq.scope === 'clean');
  ok('🔴 W11 …every visit photo read names the building and the scope', () => photoQ.length > 0 && photoQ.every((q) => q.eq.client_id && q.eq.scope === 'clean' && q.cols !== '*'), JSON.stringify(photoQ.slice(0, 2)));
}

// ── 3. checklists (HUB-8, HUB-15) and the 365-day bound (HUB-9) ──────────────
{
  const r = await get('checklists?buildingId=cl_a');
  ok('K1 the building\'s checklists', () => r.status === 200 && sameKeys(r.body, ['rows', 'total', 'offset', 'limit']), show(r));
  ok('🔴 K2 …a year back and no further (the 400-day-old one is not served)', () => r.body.rows.map((x) => x.id).join() === CR1 && r.body.total === 1, show(r));
  ok('🔴 K3 …each row EXACTLY the row allowlist', () => r.body.rows.every((x) => sameKeys(x, view.HUB_CHECKLIST_ROW_FIELDS)));
  ok('K4 …the cleaner as first name + last initial', () => r.body.rows[0]?.cleaner === 'Tomas R.');
  const d = await get(`checklist?buildingId=cl_a&id=${CR1}`);
  ok('K5 one checklist opens item by item', () => d.status === 200 && sameKeys(d.body?.checklist, view.HUB_CHECKLIST_FIELDS), show(d));
  const items = (d.body?.checklist?.areas || []).flatMap((a) => a.items);
  ok('K6 …every item with its state and the cleaner\'s note', () => items.length === 3 && items[0].note === 'Swept twice, muddy boots.' && items[2].state === 'na');
  ok('K7 …and the item photo, signed for this request (HUB-15)', () => /fake\.storage/.test(items[1]?.photos?.[0]?.url || ''), JSON.stringify(items[1]));
  ok('K8 …and nothing internal: no submission ref, user id or storage key', () => d.status === 200 && !/cs_cr1|u_crew|"storage_path"|template_version/.test(JSON.stringify(d.body)));
  for (const [label, q] of [['another building\'s', `buildingId=cl_x&id=${CR3}`], ['out-of-scope building via this one', `buildingId=cl_a&id=${CR3}`], ['400 days old', `buildingId=cl_a&id=${CR2}`], ['not a uuid', 'buildingId=cl_a&id=nope']]) {
    const x = await get(`checklist?${q}`);
    ok(`🔴 K9 a checklist that is ${label} is a 404`, () => x.status === 404 && x.body?.code === 'not-found', show(x));
  }
  const paged = await get('checklists?buildingId=cl_a&limit=500&offset=-3');
  ok('K10 a page size past the max is held to it, a negative offset to zero', () => paged.status === 200 && paged.body.limit === view.HUB_PAGE_MAX && paged.body.offset === 0, show(paged));
}

// ── 4. inspections (HUB-6, HUB-7, HUB-10, HUB-16) ────────────────────────────
{
  const r = await get('inspections?buildingId=cl_a');
  ok('I1 the building\'s SUBMITTED inspections within a year (no draft, no 400-day-old one)', () => r.status === 200 && r.body.rows.map((x) => x.id).join() === I1, show(r));
  ok('🔴 I2 …each row EXACTLY the row allowlist', () => r.body.rows.every((x) => sameKeys(x, view.HUB_INSPECTION_ROW_FIELDS)));
  const d = await get(`inspection?buildingId=cl_a&id=${I1}`);
  ok('I3 one inspection opens as the full report', () => d.status === 200 && sameKeys(d.body?.inspection, view.HUB_INSPECTION_FIELDS), show(d));
  ok('I4 …item comments included (HUB-6)', () => d.body.inspection.report.items.some((i) => i.comment === 'Scale under the rims.'));
  ok('I5 …with what we are doing about it: the redo the cleaners were sent (HUB-7)', () => d.body.inspection.redo?.sentence === 'Fixtures and Supplies', JSON.stringify(d.body?.inspection?.redo));
  const blob = JSON.stringify(d.body);
  ok('🔴 I6 …and NEVER the internal note (HUB-16) or the share token', () => d.status === 200 && !blob.includes(SECRET_NOTE) && !blob.includes('tok_pub'), blob.slice(0, 300));
  const noteRead = world.log.filter((q) => q.table === 'inspection_records' && /internal_note/.test(q.cols || ''));
  ok('🔴 I7 …the hub never even SELECTS the internal note (excluded in the query)', () => world.log.some((q) => q.table === 'inspection_records') && noteRead.length === 0, JSON.stringify(noteRead.slice(0, 2)));
  ok('🔴 I8 …no hub read used select(*) on inspections', () => world.log.some((q) => q.table === 'inspection_items') && !world.log.some((q) => q.table === 'inspection_records' && q.cols === '*'));
  for (const [label, q] of [['another building\'s', `buildingId=cl_x&id=${I4}`], ['a draft', `buildingId=cl_a&id=${I2}`], ['400 days old', `buildingId=cl_a&id=${I3}`]]) {
    const x = await get(`inspection?${q}`);
    ok(`🔴 I9 an inspection that is ${label} is a 404`, () => x.status === 404 && x.body?.code === 'not-found', show(x));
    const pdf = await get(`inspection-pdf?${q}`);
    ok(`🔴 I10 …and so is its PDF`, () => pdf.status === 404 && pdf.body?.code === 'not-found', show(pdf));
  }
}

// ── 5. tickets: list, detail, internal notes (WO-9), stages (WO-8) ───────────
{
  const r = await get('tickets?buildingId=cl_a');
  ok('T1 the building\'s CLIENT tickets — never one the office raised internally', () => r.status === 200 && r.body.rows.map((x) => x.id).sort().join() === [T1, T2, T5].sort().join(), show(r));
  ok('🔴 T2 …each row EXACTLY the row allowlist', () => r.body.rows.every((x) => sameKeys(x, view.HUB_TICKET_ROW_FIELDS)));
  world.log = [];
  const d = await get(`ticket?buildingId=cl_a&id=${T1}`);
  ok('T3 one ticket opens with its conversation', () => d.status === 200 && sameKeys(d.body?.ticket, view.HUB_TICKET_FIELDS), show(d));
  ok('🔴 T4 …an INTERNAL note is never served (WO-9)', () => !JSON.stringify(d.body).includes(SECRET_MSG) && d.body.ticket.messages.length === 2);
  const msgRead = world.log.find((q) => q.table === 'work_order_messages' && q.op === 'select');
  ok('🔴 T5 …excluded IN THE QUERY: the thread read filters internal = false', () => msgRead && msgRead.eq.internal === false, JSON.stringify(msgRead));
  ok('🔴 T6 …and the thread read is bounded, ordered, never select(*)', () => msgRead && msgRead.cols !== '*');
  ok('T7 completed, with the completion photo (WO-8, WO-10)', () => d.body.ticket.stage === 'completed' && /fake\.storage/.test(d.body.ticket.completionPhotos?.[0]?.url || ''));
  ok('T8 completed two days ago: it can be reopened (WO-11)', () => d.body.ticket.canReopen === true);
  const old = await get(`ticket?buildingId=cl_a&id=${T2}`);
  ok('T9 completed ten days ago: it cannot', () => old.status === 200 && old.body.ticket.canReopen === false);
  for (const [label, q] of [['the office\'s internal ticket', `buildingId=cl_a&id=${T3}`], ['another building\'s', `buildingId=cl_x&id=${T4}`], ['another building\'s, asked through this one', `buildingId=cl_a&id=${T4}`]]) {
    const x = await get(`ticket?${q}`);
    ok(`🔴 T10 ${label} ticket is a 404`, () => x.status === 404 && x.body?.code === 'not-found', show(x));
  }
}

// ── 6. raising a ticket through the office's own store path (HUB-13, WO-4) ───
{
  const bad = await post('ticket-create', { id: NEW_TICKET, buildingId: 'cl_a', type: 'complaint', description: 'x' });
  ok('N1 a ticket with no category is refused with a code and a sentence', () => bad.status === 400 && bad.body?.code === 'ticket-category' && typeof bad.body?.error === 'string', show(bad));
  const outside = await post('ticket-create', { id: NEW_TICKET, buildingId: 'cl_x', type: 'complaint', category: 'spill', description: 'x' });
  ok('🔴 N2 a ticket for a building outside the scope is a 404', () => outside.status === 404 && outside.body?.code === 'not-found', show(outside));
  const before = world.tables.org_state[0].state.notifications.length;
  const body = { id: NEW_TICKET, buildingId: 'cl_a', type: 'complaint', category: 'spill', description: 'Spill by the mailboxes.\nPlease send someone.', urgent: true, origin: 'internal', reportedByUserId: 'u_owner' };
  const r = await post('ticket-create', body);
  ok('N3 a client raises a ticket', () => r.status === 200 && sameKeys(r.body?.ticket, view.HUB_TICKET_FIELDS), show(r));
  const row = world.tables.problem_reports.find((p) => p.id === NEW_TICKET);
  ok('N4 …stored as the office stores one: origin portal, the building and its location', () => row?.origin === 'portal' && row.client_id === 'cl_a' && row.site_id === 's_a', JSON.stringify(row));
  ok('N5 …urgent when the client said so (WO-4), with the category (WO-12)', () => row?.priority === 'urgent' && row.category === 'spill' && row.type === 'complaint');
  ok('N6 …recording WHICH client user raised it, never a staff reporter from the body', () => row?.raised_by_client_user_id === CU1 && row.raised_by_client_name === 'Pat Manager' && !row.reported_by_user_id);
  ok('N7 …titled from the first line', () => row?.title === 'Spill by the mailboxes.');
  const bells = world.tables.org_state[0].state.notifications.slice(before);
  ok('🔴 N8 …and the supervisor-first bell fired unchanged (notifyTicketRaised)', () => bells.length === 1 && bells[0].userId === 'u_mgr' && bells[0].url === '/inspections?tab=workorders', JSON.stringify(bells));
  const again = await post('ticket-create', body);
  ok('🔴 N9 a double-tap is ONE ticket (the caller-minted id)', () => again.status === 200 && world.tables.problem_reports.filter((p) => p.id === NEW_TICKET).length === 1, show(again));
  const queue = await office('problems/list');
  const seen = (queue.body?.problems || []).find((p) => p.id === NEW_TICKET);
  ok('N10 the office sees it in Quality → Work orders with the client\'s name', () => seen?.origin === 'portal' && seen.raised_by_client_name === 'Pat Manager', show(queue));
}

// ── 7. the client's messages, and the office's internal notes (HUB-13, WO-9) ──
{
  const r = await post('ticket-message', { id: NEW_MSG, buildingId: 'cl_a', ticketId: T5, body: '  The east wall, by the mailroom.  ' });
  ok('M1 a client replies on their ticket', () => r.status === 200 && sameKeys(r.body?.message, view.HUB_MESSAGE_FIELDS) && r.body.message.from === 'you', show(r));
  const stored = world.tables.work_order_messages.find((m) => m.id === NEW_MSG);
  ok('M2 …stored as a CLIENT message by WHICH client user', () => stored?.author_role === 'client' && stored.author_client_user_id === CU1 && stored.author_name === 'Pat Manager' && !stored.author_user_id && stored.internal !== true, JSON.stringify(stored));
  ok('M3 …answering "we need more information" puts the ticket back to "working on it"', () => world.tables.problem_reports.find((p) => p.id === T5)?.status === 'in_progress');
  await post('ticket-message', { id: NEW_MSG, buildingId: 'cl_a', ticketId: T5, body: 'The east wall, by the mailroom.' });
  ok('M4 a double-tap is ONE message', () => world.tables.work_order_messages.filter((m) => m.id === NEW_MSG).length === 1);
  for (const [label, t] of [['the office\'s internal', T3], ['another building\'s', T4]]) {
    const x = await post('ticket-message', { id: 'f0000000-0000-4000-8000-0000000000bb', buildingId: 'cl_a', ticketId: t, body: 'hi' });
    ok(`🔴 M5 a message on ${label} ticket is a 404`, () => x.status === 404 && x.body?.code === 'not-found', show(x));
  }
  const empty = await post('ticket-message', { id: 'f0000000-0000-4000-8000-0000000000cc', buildingId: 'cl_a', ticketId: T5, body: '   ' });
  ok('M6 an empty message is a 400 with a code', () => empty.status === 400 && empty.body?.code === 'message-empty', show(empty));

  // The office, on a FRESH client ticket: an internal note stays internal and advances nothing.
  const note = await office('problems/message', { problemId: NEW_TICKET, body: SECRET_MSG, internal: true });
  ok('M7 the office can add an internal note', () => note.status === 200, show(note));
  const nrow = world.tables.work_order_messages.find((m) => m.problem_id === NEW_TICKET && m.body === SECRET_MSG);
  ok('M8 …stored internal', () => nrow?.internal === true);
  ok('M9 …and an internal note is not a reply: the open ticket stays open', () => world.tables.problem_reports.find((p) => p.id === NEW_TICKET)?.status === 'open');
  const replied = await store.firstStaffReplyByProblem?.([NEW_TICKET, T5]);
  ok('🔴 M10 …nor does it stop the repeat alerts (WO-2: only a reply to the client does)', () => nrow?.internal === true && replied instanceof Map && !replied.has(NEW_TICKET) && replied.has(T5));
  const hubRead = await get(`ticket?buildingId=cl_a&id=${NEW_TICKET}`);
  ok('🔴 M11 …and the client never sees it', () => hubRead.status === 200 && !JSON.stringify(hubRead.body).includes(SECRET_MSG), show(hubRead));
  const officeRead = await office(`problems/messages?problemId=${NEW_TICKET}`);
  ok('M12 the office still reads its own note, flagged internal', () => (officeRead.body?.messages || []).some((m) => m.body === SECRET_MSG && m.internal === true), show(officeRead));
}

// ── 8. reopening (WO-11) ─────────────────────────────────────────────────────
{
  const late = await post('ticket-reopen', { buildingId: 'cl_a', ticketId: T2 });
  ok('🔴 R1 a ticket completed ten days ago cannot be reopened (409, its own code)', () => late.status === 409 && late.body?.code === 'reopen-window-closed', show(late));
  const open = await post('ticket-reopen', { buildingId: 'cl_a', ticketId: T5 });
  ok('R2 one that is not completed is not "reopened"', () => open.status === 409 && open.body?.code === 'not-completed', show(open));
  const r = await post('ticket-reopen', { buildingId: 'cl_a', ticketId: T1 });
  ok('R3 one completed two days ago reopens', () => r.status === 200 && r.body?.ticket?.stage === 'received', show(r));
  const row = world.tables.problem_reports.find((p) => p.id === T1);
  ok('R4 …back to open with its completion time cleared', () => row?.status === 'open' && row.resolved_at == null);
  const x = await post('ticket-reopen', { buildingId: 'cl_a', ticketId: T4 });
  ok('🔴 R5 another building\'s ticket is a 404', () => x.status === 404 && x.body?.code === 'not-found', show(x));
}

// ── 9. the client's photo on a ticket ────────────────────────────────────────
{
  const u = await post('ticket-photo-url', { buildingId: 'cl_a', ticketId: T5, mimeType: 'image/jpeg', sizeBytes: 2048 });
  ok('F1 an upload address for the ticket\'s own location, minted server-side', () => u.status === 200 && String(u.body?.path || '').startsWith(`${ORG}/s_a/`), show(u));
  const vid = await post('ticket-photo-url', { buildingId: 'cl_a', ticketId: T5, mimeType: 'text/html', sizeBytes: 10 });
  ok('F2 …only for a photo', () => vid.status === 400, show(vid));
  const c = await post('ticket-photo', { buildingId: 'cl_a', ticketId: T5, storagePath: u.body?.path, mimeType: 'image/jpeg', sizeBytes: 2048 });
  ok('F3 the photo is recorded on the ticket as the CLIENT\'s photo', () => c.status === 200 && sameKeys(c.body?.photo, view.HUB_PHOTO_FIELDS), show(c));
  const m = world.tables.account_media.find((r) => r.ref_id === T5);
  ok('🔴 F4 …at its own scope, never as a completion photo (WO-10 must still need the office\'s)', () => m?.scope === 'client_ticket' && m.site_id === 's_a' && m.client_id === 'cl_a', JSON.stringify(m));
  const foreign = await post('ticket-photo', { buildingId: 'cl_a', ticketId: T5, storagePath: `${ORG}/s_x/abcdef0123456789.jpg`, mimeType: 'image/jpeg', sizeBytes: 10 });
  ok('🔴 F5 bytes filed under another location are refused', () => foreign.status === 400, show(foreign));
  const x = await post('ticket-photo-url', { buildingId: 'cl_a', ticketId: T4, mimeType: 'image/jpeg', sizeBytes: 10 });
  ok('🔴 F6 another building\'s ticket is a 404', () => x.status === 404 && x.body?.code === 'not-found', show(x));
}

// ── 10. history (HUB-9, LOG-1, LOG-9) ────────────────────────────────────────
{
  const r = await get('history?buildingId=cl_a');
  ok('Y1 a year of service events', () => r.status === 200 && sameKeys(r.body, ['events', 'total', 'offset', 'limit']), show(r));
  const ev = r.body?.events || [];
  ok('🔴 Y2 …each EXACTLY the event allowlist', () => ev.length && ev.every((e) => sameKeys(e, view.HUB_EVENT_FIELDS)));
  const blob = JSON.stringify(r.body);
  ok('🔴 Y3 …no pay, no money, no office-only ticket, no full name', () => r.status === 200 && ev.length > 0 && !/ZZPAYZZ|hourlyRate|Rivera|Bryant|internal/.test(blob), blob.slice(0, 300));
  ok('Y4 …nothing older than a year', () => ev.length > 0 && ev.every((e) => Date.parse(e.at) >= Date.now() - view.HUB_HISTORY_DAYS * DAY));
  ok('Y5 …arrivals, a checklist, an inspection and the client ticket\'s progress', () => ['arrival', 'checklist', 'inspection', 'ticket'].every((k) => ev.some((e) => e.kind === k)), ev.map((e) => e.kind).join());
  const p2 = await get('history?buildingId=cl_a&limit=2&offset=2');
  ok('Y6 …paged on the server with the full total', () => p2.body?.events?.length === 2 && p2.body.total === r.body.total);
  const x = await get('history?buildingId=cl_x');
  ok('🔴 Y7 another building\'s history is a 404', () => x.status === 404 && x.body?.code === 'not-found', show(x));
}

// ── 11. emails (HUB-11) over a fake sender ───────────────────────────────────
{
  seed();
  const sent = [];
  ok('E0 the notifier exposes a test seam for its sender', () => typeof notify.__setHubMailerForTests === 'function', notify.__error || '');
  notify.__setHubMailerForTests?.(async (m) => { sent.push(m); return { ok: true, id: `e${sent.length}` }; });
  process.env.APP_PUBLIC_URL = 'https://hub.example.test/';

  await office('problems/update', { id: T5, status: 'in_progress' });
  ok('E1 a status change on a client ticket emails the client who raised it', () => sent.length === 1 && sent[0].to === 'pat@coralbay.test', JSON.stringify(sent));
  ok('E2 …in the client\'s stage words, with a link to the ticket', () => /working on it/i.test(sent[0]?.body || '') && (sent[0]?.body || '').includes(`https://hub.example.test/hub/b/cl_a/tickets/${T5}`));
  await office('problems/message', { problemId: T5, body: 'We will be there at 7.' });
  ok('E3 a staff reply emails them too, with the reply', () => sent.length === 2 && (sent[1]?.body || '').includes('We will be there at 7.'));
  await office('problems/message', { problemId: T5, body: SECRET_MSG, internal: true });
  ok('🔴 E4 an internal note emails nobody', () => sent.length === 2 && !sent.some((m) => JSON.stringify(m).includes(SECRET_MSG)));
  await office('problems/update', { id: T3, status: 'in_progress' });
  ok('E5 the office\'s own internal ticket emails nobody', () => sent.length === 2);

  await office('inspections/submit', { id: I5, items: [{ item_key: 'i1', label: 'Fixtures. Toilets', rating: 'pass' }], internalNote: SECRET_NOTE });
  const insp = sent.slice(2);
  ok('E6 a NEW inspection emails every client user who can see the building (direct and through a group)',
    () => insp.map((m) => m.to).sort().join() === ['jordan@royalpalm.test', 'pat@coralbay.test'].sort().join(), JSON.stringify(insp.map((m) => m.to)));
  ok('🔴 E7 …never a disabled one, never another building\'s', () => insp.length > 0 && !insp.some((m) => /old@|h@harbor/.test(m.to)));
  ok('🔴 E8 …and never the internal note', () => insp.length > 0 && !insp.some((m) => JSON.stringify(m).includes(SECRET_NOTE)));
  ok('E9 …one email per person, each linking to the report', () => insp.length === 2 && insp.every((m) => !Array.isArray(m.to) && (m.body || '').includes(`/hub/b/cl_a/inspections/${I5}`)));
  const count = sent.length;
  await office('inspections/submit', { id: I5, items: [{ item_key: 'i1', label: 'Fixtures. Toilets', rating: 'fail' }] });
  ok('E10 re-submitting (an edit) is not a new inspection: no second email', () => count >= 4 && sent.length === count);

  // No APP_PUBLIC_URL → the link comes from the brand pack's own configured app address
  // (IDENTITY.appUrl) — configuration either way, never a request's Host header.
  delete process.env.APP_PUBLIC_URL;
  await office('problems/update', { id: T5, status: 'awaiting_client' });
  ok('E11 with no APP_PUBLIC_URL the link is the brand pack\'s configured app address, never a request\'s host',
    () => sent.length === count + 1 && (sent[sent.length - 1]?.body || '').includes(`${IDENTITY.appUrl}/hub/b/cl_a/tickets/${T5}`), sent[sent.length - 1]?.body);

  // No system sender connected: the office's action succeeds and nothing throws.
  notify.__setHubMailerForTests?.(null);
  const r = await office('problems/update', { id: T5, status: 'in_progress' });
  ok('🔴 E12 with NO sender connected the office\'s change still succeeds (the send is skipped, fail-closed)', () => r.status === 200, show(r));
  const m = await office('problems/message', { problemId: T5, body: 'Another reply.' });
  ok('E13 …and so does a reply', () => m.status === 200, show(m));
}

// ── 12. error bodies never carry the provider's text (CS-077 class) ──────────
{
  seed();
  world.failWhen = (q) => q.table === 'checklist_results';
  world.failMessage = PROVIDER_TEXT;
  const r = await get('checklists?buildingId=cl_a');
  ok('🔴 X1 a failed read answers a sentence and a code, never the provider\'s text', () => r.status >= 500 && typeof r.body?.code === 'string' && !JSON.stringify(r.body).includes('zz_secret_internal_table'), show(r));
  world.failWhen = (q) => q.table === 'org_state';
  const v = await get('view');
  ok('🔴 X2 …including the Round 1 view (it used to return the detail)', () => v.status >= 500 && !JSON.stringify(v.body).includes('zz_secret_internal_table') && !('detail' in (v.body || {})), show(v));
  world.failWhen = null; world.failMessage = null;
}

// ── 13. the office's drawer offers the internal note (WO-9), mechanically ────
{
  // The drawer is its own component since the manager view redesign (2026-10-09): Client
  // Requests opens the same one. The ?wo= deep link stays with the queue that opens it.
  const src = readFileSync(path.join(APP, 'src/components/WorkOrderDrawer.jsx'), 'utf8').replace(/\r\n/g, '\n');
  const panel = readFileSync(path.join(APP, 'src/components/WorkOrdersPanel.jsx'), 'utf8').replace(/\r\n/g, '\n');
  ok('O1 the work-order drawer\'s composer has the internal-note toggle', () => /Internal note: not shown to the client/.test(src) && /internal:/.test(src));
  ok('O2 …and marks an internal note in the thread', () => /m\.internal/.test(src));
  ok('O3 …and names the client who raised a portal ticket', () => /raised_by_client_name/.test(src));
  ok('O4 …and opens the very ticket a bell links to (?wo=<ticket>)', () => /searchParams\.get\('wo'\)/.test(panel));
}

// ── 14. a client's reply reaches the office (HUB-13 follow-up; WO-6, WO-7) ────
// The conversation must not dead-end: a CLIENT's message rings the ticket's assignee, else the
// account's supervisor, else the office bench — the route a new ticket takes — under the new
// ticket's own event key (so the push dispatcher holds a non-urgent one for office hours and
// lets an urgent one through at any hour), linking straight to the ticket. An internal note or
// a staff reply rings nobody, a client message is still not a staff reply for the repeat
// walker, and a bell that cannot be written never fails the client's post.
{
  seed();
  // A new bell row is put FIRST in its recipient's list (lib/notifications capInsert), so new
  // rows are told apart by id, never by position.
  const bells = () => world.tables.org_state[0].state.notifications || [];
  const snap = () => new Set(bells().map((r) => r.id));
  const since = (seen) => bells().filter((r) => !seen.has(r.id));
  const ticketRow = (id) => world.tables.problem_reports.find((p) => p.id === id);
  const clientRow = (id) => world.tables.org_state[0].state.clients.find((c) => c.id === id);
  const T6 = 'e0000000-0000-4000-8000-0000000000bb';
  let n = 0;
  const reply = (ticketId, text, buildingId = 'cl_a') => {
    n += 1;
    return post('ticket-message', { id: `f0000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, buildingId, ticketId, body: text });
  };
  const deepLink = (id) => `/inspections?tab=workorders&wo=${id}`;

  // (a) the ticket's ASSIGNEE (an office tier) hears it — and not the supervisor.
  ticketRow(T5).assignee_user_id = 'u_owner';
  let before = snap();
  const r1 = await reply(T5, 'The east wall, by the mailroom.');
  let rows = since(before);
  const rang = rows.length === 1;
  ok('C1 a client reply on an assigned ticket is accepted', () => r1.status === 200, show(r1));
  ok('🔴 C2 …and rings the ticket\'s ASSIGNEE, and only them', () => rows.length === 1 && rows[0].userId === 'u_owner', JSON.stringify(rows));
  ok('C3 …under the new ticket\'s event key, which the dispatcher holds for office hours when not urgent (WO-7)',
    () => rows[0]?.eventKey === ticketRaisedEventKey('medium') && OFFICE_HOURS_EVENT_KEYS.has(rows[0]?.eventKey), rows[0]?.eventKey);
  ok('C4 …linking straight to the ticket in Quality › Work orders', () => rows[0]?.url === deepLink(T5), rows[0]?.url);
  ok('C5 …naming the building, the ticket and what the client said', () => /Coral Bay HOA/.test(rows[0]?.title || '') && /Scuff marks/.test(rows[0]?.body || '') && /east wall/.test(rows[0]?.body || ''), JSON.stringify(rows[0]));

  // (b) no assignee → the account's supervisor (WO-6).
  ticketRow(T5).assignee_user_id = null;
  before = snap();
  await reply(T5, 'Also the hallway by the gym.');
  rows = since(before);
  ok('🔴 C6 no assignee: the account\'s SUPERVISOR hears it', () => rows.length === 1 && rows[0].userId === 'u_mgr', JSON.stringify(rows));

  // (c) an assignee who cannot take a ticket alert (a cleaner — the events are office-only) →
  //     the supervisor, never nobody.
  ticketRow(T5).assignee_user_id = 'u_crew';
  before = snap();
  await reply(T5, 'Thanks.');
  rows = since(before);
  ok('C7 a cleaner assigned: the supervisor hears it instead', () => rows.length === 1 && rows[0].userId === 'u_mgr', JSON.stringify(rows));

  // (d) no assignee and no supervisor → HUB-21 (Matt, (a)): the Admins, as for a customer's
  //     message; this team has no Admin, so the Super Admin (never the whole office bench).
  clientRow('cl_b').supervisorId = null;
  const created = await post('ticket-create', { id: T6, buildingId: 'cl_b', type: 'request', category: 'other', description: 'Can the lobby plants be watered?' });
  before = snap();
  await reply(T6, 'Only the ones by the door.', 'cl_b');
  rows = since(before);
  ok('C8 no assignee and no supervisor: the Admins hear it (HUB-21) — with none on the team, the Super Admin, not the managers',
    () => created.status === 200 && rows.map((x) => x.userId).sort().join() === 'u_owner', JSON.stringify(rows.map((x) => x.userId)));

  // (e) an URGENT ticket's reply breaks through at any hour, as an urgent new ticket does.
  ticketRow(T5).priority = 'urgent';
  ticketRow(T5).assignee_user_id = null;
  before = snap();
  await reply(T5, 'Water is coming through the ceiling now.');
  rows = since(before);
  ok('C9 an URGENT ticket\'s reply uses the loud key (any hour, WO-7)',
    () => rows.length === 1 && rows[0].eventKey === ticketRaisedEventKey('urgent') && ALWAYS_PUSH_EVENT_KEYS.has(rows[0].eventKey), JSON.stringify(rows));
  ticketRow(T5).priority = 'medium';

  // (f) the office writing on the thread rings nobody.
  before = snap();
  await office('problems/message', { problemId: T5, body: 'Quote the gym hallway separately.', internal: true });
  ok('🔴 C10 an INTERNAL note rings nobody', () => rang && since(before).length === 0, `${since(before).length} row(s)`);
  before = snap();
  await office('problems/message', { problemId: T5, body: 'We will do both tonight.' });
  ok('🔴 C11 a STAFF reply rings nobody', () => rang && since(before).length === 0, `${since(before).length} row(s)`);

  // (g) a client's message is still not a staff reply for the repeat walker (WO-2).
  const replied = await store.firstStaffReplyByProblem([T6]);
  ok('🔴 C12 a client\'s message never counts as the reply that stops the repeats', () => rang && replied instanceof Map && !replied.has(T6));

  // (h) best-effort: the bell is written after the message, and its failure is swallowed.
  world.failWhen = (q) => q.table === 'org_state' && q.op === 'update';
  const r2 = await reply(T5, 'Did you get this?');
  world.failWhen = null;
  ok('C13 a bell that cannot be written never fails the client\'s message',
    () => rang && r2.status === 200 && world.tables.work_order_messages.some((m) => m.body === 'Did you get this?'), show(r2));
}

// ── 15. a draft with SAVED ticks never reaches the hub (finish-later, plan 2026-10-11 §3, D8) ──
// Since 2026-10-11 an inspection can be left open and finished later: the office's save-draft
// writes its ticks, comments and note to the record while it is still a DRAFT. I2 is a draft at
// cl_a. With ticks saved into it, every hub branch still leaves it out, and the save emails
// nobody (HUB-11's email is Submit's). REGRESSION: on the pre-change tree there is no save-draft
// branch (404), so F1 and F2 go red.
{
  seed();
  const sent = [];
  notify.__setHubMailerForTests?.(async (m) => { sent.push(m); return { ok: true, id: `e${sent.length}` }; });
  process.env.APP_PUBLIC_URL = 'https://hub.example.test/';
  const before = {
    list: await get('inspections?buildingId=cl_a'),
    home: await get('home?buildingId=cl_a'),
    history: await get('history?buildingId=cl_a'),
    updates: await get('updates'),
  };
  const saved = await office('inspections/save-draft', {
    id: I2,
    items: [{ item_key: 'i1', label: 'Fixtures. Toilets', rating: 'pass' }, { item_key: 'i3', label: 'Supplies. Soap', rating: null, comment: 'ZZDRAFTCOMMENTZZ soap low' }],
    internalNote: SECRET_NOTE,
  });
  ok('🔴 F1 the office saves ticks into a draft (save-draft)', () => saved.status === 200 && world.tables.inspection_items.filter((i) => i.inspection_id === I2).length === 2, show(saved));
  ok('🔴 F2 …and the save emails no client (HUB-11 is Submit\'s)', () => saved.status === 200 && sent.length === 0, JSON.stringify(sent.map((m) => m.to)));
  const list = await get('inspections?buildingId=cl_a');
  ok('🔴 F3 the hub\'s Inspections list still holds no draft', () => list.status === 200 && !list.body.rows.some((x) => x.id === I2) && JSON.stringify(list.body) === JSON.stringify(before.list.body), show(list));
  for (const p of [`inspection?buildingId=cl_a&id=${I2}`, `inspection-pdf?buildingId=cl_a&id=${I2}`]) {
    const x = await get(p);
    ok(`🔴 F4 …${p.split('?')[0]} of the draft is a 404`, () => x.status === 404 && x.body?.code === 'not-found', show(x));
  }
  const home = await get('home?buildingId=cl_a');
  ok('🔴 F5 …Home\'s inspection tile is unchanged by it', () => home.status === 200 && JSON.stringify(home.body?.inspections) === JSON.stringify(before.home.body?.inspections) && !JSON.stringify(home.body).includes(I2), show(home));
  const history = await get('history?buildingId=cl_a');
  ok('🔴 F6 …the history shows no event for it', () => history.status === 200 && JSON.stringify(history.body) === JSON.stringify(before.history.body), show(history));
  const updates = await get('updates');
  ok('🔴 F7 …nor do the customer\'s updates', () => updates.status === 200 && JSON.stringify(updates.body) === JSON.stringify(before.updates.body) && !JSON.stringify(updates.body).includes(I2), show(updates));
  ok('🔴 F8 …and its saved comment and note appear nowhere the customer reads', () => ![list, home, history, updates].some((r) => /ZZDRAFTCOMMENTZZ|ZZINSPNOTEZZ/.test(JSON.stringify(r.body))));
  notify.__setHubMailerForTests?.(null);
  delete process.env.APP_PUBLIC_URL;
}

// ── 16. CS-652: another organization's ticket is a 404 everywhere ────────────
// The work-order reads and writes found a ticket by id alone (getProblem, updateProblem's
// pre-read, the resolve and the update, the message's auto-advance), so a ticket of ANOTHER
// organization sharing the database could be read, edited, resolved, messaged and reopened by
// id from here — and a cleaner whose customer id happens to match its (`cl_a`, a text id the
// two books can share) passed the crew check too. Every one is now pinned to the organization;
// the hub's own ticket reads always were (they are the controls here).
// REGRESSION: on the tree before the fix the office routes answer 200 (or 409) and write.
{
  seed();
  const OTHER_ORG = '00000000-0000-0000-0000-0000000000ee';
  const TO1 = 'e0000000-0000-4000-8000-0000000000e1';   // another org's OPEN ticket, its customer id 'cl_a' like ours
  const TO2 = 'e0000000-0000-4000-8000-0000000000e2';   // …and one it resolved yesterday
  world.tables.problem_reports.push(
    ticket(TO1, 'cl_a', 's_a', 'portal', 'open', DAY, { organization_id: OTHER_ORG, title: 'ZZOTHERORGZZ ticket', priority: 'low', assignee_user_id: null }),
    ticket(TO2, 'cl_a', 's_a', 'portal', 'resolved', 2 * DAY, { organization_id: OTHER_ORG, title: 'ZZOTHERORGZZ resolved', resolved_at: ago(DAY) }),
  );
  world.tables.work_order_messages.push(msg('wo1', TO1, 'client', 'Their customer', 'ZZOTHERORGZZ message', DAY - H, { organization_id: OTHER_ORG }));
  world.tables.account_media.push(media('m_o1', 'problem_report', TO1, null, 's_a', { organization_id: OTHER_ORG }));
  const theirs = () => JSON.stringify([
    world.tables.problem_reports.filter((p) => p.organization_id === OTHER_ORG),
    world.tables.work_order_messages.filter((m) => m.problem_id === TO1 || m.problem_id === TO2),
  ]);
  const before = theirs();
  const asCrew = (p, b) => call(qc, { method: b ? 'POST' : 'GET', path: p, token: 'tok-crew', body: b });
  const checks = [
    ['get its thread (office)', () => office(`problems/messages?problemId=${TO1}`)],
    ['get its thread (a cleaner of a customer with the same id)', () => asCrew(`problems/messages?problemId=${TO1}`)],
    ['update it (office)', () => office('problems/update', { id: TO1, priority: 'urgent', title: 'renamed from here' })],
    ['update it (a cleaner)', () => asCrew('problems/update', { id: TO1, priority: 'urgent' })],
    ['resolve it (office)', () => office('problems/update', { id: TO1, status: 'resolved' })],
    ['message it (office)', () => office('problems/message', { problemId: TO1, body: 'a reply from the wrong org' })],
    ['message it (a cleaner)', () => asCrew('problems/message', { problemId: TO1, body: 'a crew note' })],
    ['reopen it (office)', () => office('problems/update', { id: TO2, status: 'open' })],
    ['reopen it (its building\'s client, from the hub)', () => post('ticket-reopen', { buildingId: 'cl_a', ticketId: TO2 })],
    ['message it (the client, from the hub)', () => post('ticket-message', { id: 'f0000000-0000-4000-8000-0000000000e9', buildingId: 'cl_a', ticketId: TO1, body: 'hello' })],
    ['open it (the client, from the hub)', () => get(`ticket?buildingId=cl_a&id=${TO1}`)],
  ];
  let n = 0;
  for (const [label, run] of checks) {
    n += 1;
    const r = await run();
    ok(`🔴 W${n} ${label}: another organization's ticket is a 404`, () => r.status === 404, show(r));
    ok(`W${n}b …and the answer carries nothing of it`, () => !/ZZOTHERORGZZ/.test(JSON.stringify(r.body || '')));
  }
  ok('🔴 W12 nothing of theirs changed: tickets, statuses and thread', () => theirs() === before);
  ok('🔴 W13 and no message was filed here against their ticket', () => !world.tables.work_order_messages.some((m) => m.problem_id === TO1 && m.organization_id === ORG));
  const own = await office('problems/update', { id: T5, priority: 'urgent' });
  ok('W14 our own ticket still updates (the pin narrows to the org, nothing more)', () => own.status === 200 && own.body?.problem?.id === T5 && own.body.problem.priority === 'urgent', show(own));
  const ownThread = await office(`problems/messages?problemId=${T5}`);
  ok('W15 …and its thread still reads', () => ownThread.status === 200 && (ownThread.body?.messages || []).length > 0, show(ownThread));
}

console.log(`\nclient hub routes: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
