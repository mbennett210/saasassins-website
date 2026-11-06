// QR-16 — A CUSTOMER'S SCAN OPENS THAT AREA'S OWN PAGE (QR Wave 2, 2026-10-17; UI_RULES §173).
//
// Matt (2026-10-16): "That area's own page: when it was last cleaned, the photo, what was done, and a
// button to make a request about it." Until now a customer's scan opened the building's Checklists
// (provisional since Wave 1). This suite holds the replacement, through the REAL hub handler over
// fake-supabase.mjs (no network, no credentials, no live project — BUILD_INTEGRITY §6b):
//
//   A. the pure answer (lib/areaScan projectHubArea): EXACTLY the public page's allowlist projection
//      plus the photo's signed thumbnail, with every server secret fed in and looked for; no phone
//   B. 🔴 EP-421 GET /api/hub/area: the caller's scope (another customer's building refused, naming
//      nothing; an archived building gone; an area not on the location a 404), the office's preview
//      scoped to its one building, the signed photo only beside a recorded clean, the next clean and
//      the last inspection as dates, a failed extra left out
//   C. the request button: the form's prefill, `siteAreaId` sent, and the server today ignoring the
//      key it does not know (builder R stores it) — a request raised from the area is created
//   D. the wiring: the route (KeyedByParam), the scan's destination, ONE card for both homes, Back,
//      the preview's read-only button, the demo twin, the sweep's demo paths
//
// REGRESSION (THE LAW II.3): on 90d7ca9e the branch, the page, the projection and the route do not
// exist, so every check below reports what it wanted (§C's "the server ignores siteAreaId" passes
// there too: it is the guard the brief asked to check, not new behaviour).
//
//   node app/scripts/test-hub-area-page.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\{\/\*[\s\S]*?\*\/\}/g, ''))).join('\n');

const ORG = '00000000-0000-0000-0000-000000000016';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const { archiveCustomerPatch } = await import('../src/lib/customerStatus.js');
const { dayKey, startOfDayKey } = await import('../src/lib/dates.js');
const scan = await import('../src/lib/areaScan.js').catch(() => ({}));
const hubNav = await import('../src/pages/hub/hubNav.js').catch(() => ({}));
const PREVIEW = await import('../src/lib/hubPreview.js').catch(() => ({}));
const hubHandler = (await import('../api/hub/[...path].js').catch(() => ({}))).default || null;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.includes(x));
async function section(name, f) {
  try { await f(); } catch (e) { fails.push(`§${name} stopped: ${String((e && e.message) || e).split('\n')[0]}`); }
}

const HOUR = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const TZ = 'America/New_York';
const SECRETS = { user: 'u_crew', note: 'stall 3 SECRET-NOTE', result: 'r_tonight', submit: 'cs_tonight', name: 'Full Clean SECRET-NAME', caption: 'caption SECRET-CAP', media: 'am_secret_id' };

// ── A. the pure answer ───────────────────────────────────────────────────────
await section('A', async () => {
  const project = fn(scan, 'projectHubArea');
  const K = scan.HUB_AREA_KEYS || [];
  const row = {
    areaId: 'area_rest', label: 'Restrooms', instructions: 'baby-change SECRET', lastCleanedAt: iso(NOW - 2 * HOUR), lastCleanedByUserId: SECRETS.user,
    resultId: SECRETS.result, checklistName: SECRETS.name,
    items: [{ key: 'fi_toilet', label: 'Toilets sanitized', state: 'done', note: SECRETS.note }, { key: 'fi_mop', label: 'Floors mopped', state: 'notdone' }],
    photo: { id: SECRETS.media, itemKey: 'fi_toilet', createdAt: iso(NOW - 2 * HOUR), kind: 'image', caption: SECRETS.caption, url: 'https://fake.storage/ops-media/full.jpg?ttl=600', thumbUrl: 'https://fake.storage/ops-media/thumb.jpg?ttl=600' },
  };
  const out = project({ building: 'Coral Bay HOA', location: 'Clubhouse', area: row, timeZone: TZ, nowMs: NOW, nextCleanOn: '2026-10-18', lastInspectionOn: '2026-10-14' }) || {};
  ok('A1 the hub\'s area answer is its allowlist: the public projection and the photo URL, nothing else', K.length === 2 && sameSet(Object.keys(out), K), JSON.stringify(Object.keys(out)));
  ok('A2 🔴 `scan` is EXACTLY the public page\'s projection (the same keys, the same rule)', sameSet(Object.keys(out.scan || {}), scan.PUBLIC_SCAN_KEYS || ['?']), JSON.stringify(Object.keys(out.scan || {})));
  ok('A2 …with what was done and nothing not done', (out.scan?.items || []).map((i) => i.label).join('|') === 'Toilets sanitized');
  eq('A3 the photo is the hub\'s signed THUMBNAIL', out.photoUrl, row.photo.thumbUrl);
  eq('A3 …or the signed original when there is no thumbnail', (project({ area: { ...row, photo: { ...row.photo, thumbUrl: null } }, nowMs: NOW }) || {}).photoUrl, row.photo.url);
  eq('A4 🔴 no photo beside a never-recorded clean (the public page\'s rule, scanShowsPhoto)', (project({ area: { ...row, lastCleanedAt: null }, nowMs: NOW }) || {}).photoUrl, null);
  eq('A4 …nor a video', (project({ area: { ...row, photo: { ...row.photo, kind: 'video' } }, nowMs: NOW }) || {}).photoUrl, null);
  eq('A5 the hub page carries no urgent line (its own Call is on Home)', out.scan?.urgentPhone, null);
  const wire = JSON.stringify(out);
  for (const [what, secret] of Object.entries(SECRETS)) ok(`A6 no ${what} on the wire`, !wire.includes(secret));
  ok('A6 …no instructions either', !wire.includes('baby-change'));

  const area = fn(hubNav, 'hubRequestArea');
  const prefill = fn(hubNav, 'hubAreaPrefill');
  const a = area({ from: '/hub/b/cl_coral/areas/area_rest', fromLabel: 'Restrooms', area: { id: 'area_rest', label: ' Restrooms ' } });
  ok('A7 the request form reads the area from the history state', a?.id === 'area_rest' && a?.label === 'Restrooms', JSON.stringify(a));
  eq('A7 …and starts its text with the area\'s name ("Restrooms: ")', prefill(a), 'Restrooms: ');
  ok('A7 …anything else is no area and no prefill', [null, undefined, {}, { area: null }, { area: { id: '', label: 'X' } }, { area: { id: 'a', label: '  ' } }, { area: 'area_rest' }]
    .every((st) => area(st) === null) && prefill(null) === '');
});

// ── the world (B, C) ─────────────────────────────────────────────────────────
const CU1 = 'c0000000-0000-4000-8000-000000000016'; // Coral Bay's property manager
const CU2 = 'c0000000-0000-4000-8000-000000000017'; // Harbor's
const T = (c) => c.repeat(32);
const SCHEMA = {
  areas: [
    { id: 'fa_rest', label: 'Restrooms', siteAreaId: 'area_rest', items: [{ id: 'fi_toilet', label: 'Toilets sanitized', naAllowed: false, photoRequired: false }] },
    { id: 'fa_floors', label: 'Floors', siteAreaId: 'area_floors', items: [{ id: 'fi_mop', label: 'Floors mopped', naAllowed: false, photoRequired: false }] },
  ],
};
const SITES = [
  { id: 's_club', clientId: 'cl_coral', name: 'Clubhouse', accessNotes: 'door code 4411 SECRET', cleaningAreas: [{ id: 'area_rest', label: 'Restrooms', instructions: 'baby-change SECRET' }, { id: 'area_floors', label: 'Hall & stair floors' }] },
  { id: 's_tower', clientId: 'cl_harbor', name: 'Harbor Tower', cleaningAreas: [{ id: 'area_hall', label: 'Hall' }] },
];
const jobRow = (id, siteId, clientId, startMs, status = 'upcoming') => ({
  id, organization_id: ORG, client_id: clientId, site_id: siteId, status, start_at: iso(startMs),
  data: { id, clientId, siteId, startAt: iso(startMs), endAt: iso(startMs + 2 * HOUR), status, crewIds: [SECRETS.user], notes: 'gate 9911 SECRET-JOB' },
});
function seed() {
  __resetRateLimit?.();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          company: { name: 'Clean Space', timezone: TZ, phone: '(555) 010-4477' },
          users: [
            { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'owner@example.test' },
            { id: 'u_crew', role: 'crew', status: 'active', name: 'Tomas Rivera', email: 'crew@example.test' },
          ],
          permissions: seedPermissions(), userPermissionOverrides: [],
          clients: [{ id: 'cl_coral', name: 'Coral Bay HOA' }, { id: 'cl_harbor', name: 'Harbor Tower' }],
          sites: SITES.map((x) => ({ ...x })),
          opsSettings: {}, notifications: [],
        },
      }],
      area_scan_codes: [{ id: 'c1', organization_id: ORG, site_id: 's_club', area_id: 'area_rest', token: T('R'), created_at: iso(NOW - 48 * HOUR), created_by: 'u_owner', revoked_at: null, revoked_by: null }],
      checklist_results: [{
        id: SECRETS.result, organization_id: ORG, site_id: 's_club', client_id: 'cl_coral', job_id: 'j_tonight', client_submit_id: SECRETS.submit,
        completed_by_user_id: SECRETS.user, completed_count: 2, total_count: 2, performed_at: iso(NOW - 2 * HOUR),
        area_completions: { fa_rest: iso(NOW - 2 * HOUR) },
        template_snapshot: { name: SECRETS.name, kind: 'checklist', schema: SCHEMA },
        items: [{ key: 'fi_toilet', checked: true, note: SECRETS.note }, { key: 'fi_mop', checked: false }],
      }],
      account_media: [{
        id: SECRETS.media, organization_id: ORG, scope: 'checklist', ref_id: SECRETS.submit, area_id: 'fi_toilet', site_id: 's_club', client_id: 'cl_coral',
        kind: 'image', mime_type: 'image/jpeg', caption: SECRETS.caption, storage_path: `${ORG}/s_club/aaaaaaaaaaaaaaaa.jpg`, thumb_path: `${ORG}/s_club/aaaaaaaaaaaaaaaa.thumb.jpg`, created_at: iso(NOW - 2 * HOUR),
      }],
      jobs: [jobRow('j_next', 's_club', 'cl_coral', NOW + 26 * HOUR), jobRow('j_harbor', 's_tower', 'cl_harbor', NOW + HOUR)],
      inspection_records: [
        { id: 'i_coral', organization_id: ORG, client_id: 'cl_coral', site_id: 's_club', status: 'submitted', performed_at: iso(NOW - 3 * 24 * HOUR), overall_score: 61, result: 'fail', inspector_name: 'Inspector SECRET', public_token: 'tok_SECRET_REPORT' },
        { id: 'i_draft', organization_id: ORG, client_id: 'cl_coral', site_id: 's_club', status: 'draft', performed_at: iso(NOW - HOUR) },
      ],
      problem_reports: [], work_order_messages: [], crew_assignments: [],
      client_users: [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1' },
        { id: CU2, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c2' },
      ],
      client_user_groups: [], client_user_group_members: [],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_coral', group_id: null },
        { id: 'as2', organization_id: ORG, client_user_id: CU2, client_id: 'cl_harbor', group_id: null },
      ],
      activity_log: [], activity_log_baseline: [],
    },
    logins: {
      'tok-owner': { id: 'auth-owner', email: 'owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client2': { id: 'auth-c2', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU2, org_id: ORG } },
    },
  });
  world.rpc = (name) => (name === 'hub_next_visits' ? { data: [], error: null } : { data: null, error: { code: 'PGRST202', message: `no function ${name}` } });
}
async function call({ method = 'GET', path: p, token, query = {}, body, headers: extra = {} }) {
  const req = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, query: { subpath: p, ...query }, body: body || {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null, headers: {} }), 10000);
      const headers = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(hubHandler ? hubHandler(req, res) : res.status(404).json({ error: 'no handler' })).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const area = (token, buildingId, areaId, headers = {}) => call({ path: 'area', token, query: { buildingId, areaId }, headers });
const H = PREVIEW.HUB_PREVIEW_HEADER || 'x-hub-preview';

// ── B. EP-421 GET /api/hub/area, through the real handler ─────────────────────
await section('B', async () => {
  seed();
  eq('B1 no login → 401', (await area(undefined, 'cl_coral', 'area_rest')).status, 401);
  const r = await area('tok-client', 'cl_coral', 'area_rest');
  eq('B2 🔴 the customer opens an area of their own building: 200', r.status, 200);
  ok('B2 …with exactly the allowlisted keys, and the public projection inside', sameSet(Object.keys(r.body || {}), scan.HUB_AREA_KEYS || ['?'])
    && sameSet(Object.keys(r.body?.scan || {}), scan.PUBLIC_SCAN_KEYS || ['?']), show(r));
  eq('B2 …the building', r.body?.scan?.building, 'Coral Bay HOA');
  eq('B2 …the area', r.body?.scan?.area, 'Restrooms');
  eq('B2 …when it was last cleaned (the office\'s own rule)', r.body?.scan?.lastCleanedAt, iso(NOW - 2 * HOUR));
  ok('B2 …what was done there (and nothing not done)', (r.body?.scan?.items || []).map((i) => i.label).join('|') === 'Toilets sanitized', show(r));
  eq('B3 🔴 the next clean: a DATE in the org\'s zone', r.body?.scan?.nextCleanOn, dayKey(new Date(NOW + 26 * HOUR), TZ));
  eq('B3 🔴 the last inspection: the newest SUBMITTED one\'s day (the newer draft ignored)', r.body?.scan?.lastInspectionOn, dayKey(new Date(NOW - 3 * 24 * HOUR), TZ));
  ok('B4 the photo: a short-lived signed THUMBNAIL of the winning photo', /^https:\/\/fake\.storage\/ops-media\/.*\.thumb\.jpg\?ttl=\d+$/.test(r.body?.photoUrl || ''), show(r));
  eq('B4 …and no urgent line on the hub page', r.body?.scan?.urgentPhone, null);
  // The photo's signed URL carries its storage path, as every photo the hub signs does (its checklist
  // pages hand the same); everything else is the public page's allowlist.
  const wire = JSON.stringify({ ...(r.body || {}), photoUrl: null });
  for (const secret of [...Object.values(SECRETS), 'door code', '4411', 'baby-change', 's_club', 'gate 9911', 'j_next', 'Inspector SECRET', 'tok_SECRET_REPORT', 'Tomas', CU1]) {
    ok(`B5 no "${secret}" on the wire`, !wire.includes(secret));
  }
  ok('B5 …and the photo URL names only the winning photo\'s thumbnail, no caption or id', !/SECRET|am_secret_id/.test(r.body?.photoUrl || '') && /aaaaaaaaaaaaaaaa\.thumb\.jpg/.test(r.body?.photoUrl || ''), r.body?.photoUrl);
  eq('B5 …private, never cached', r.headers['cache-control'], 'private, no-store');
  const floors = await area('tok-client', 'cl_coral', 'area_floors');
  ok('B6 an area never finished reads the never state, with NO photo', floors.status === 200 && floors.body?.scan?.lastCleanedAt === null && floors.body?.photoUrl === null, show(floors));

  const other = await area('tok-client', 'cl_harbor', 'area_hall');
  ok('B7 🔴 ANOTHER customer\'s building (a real area of it) → the hub\'s 404 that names nothing', other.status === 404 && other.body?.code === 'not-found'
    && !/Harbor|Hall|s_tower/.test(JSON.stringify(other.body)), show(other));
  const theirs = await area('tok-client2', 'cl_harbor', 'area_hall');
  eq('B7 …while that building\'s own customer opens it', theirs.status, 200);
  const crossArea = await area('tok-client', 'cl_coral', 'area_hall');
  ok('B8 an area that is not on the building\'s location (another building\'s) → 404', crossArea.status === 404 && crossArea.body?.code === 'not-found', show(crossArea));
  for (const bad of ['', 'area_gone', '../etc', ['area_rest', 'x']]) {
    const x = await area('tok-client', 'cl_coral', bad);
    eq(`B8 a missing or malformed area (${JSON.stringify(bad)}) → 404, never a crash`, x.status, 404);
  }
  const before = world.log.length;
  await area('tok-client', 'cl_harbor', 'area_hall');
  ok('B8 …and a refused building costs no checklist, job or inspection read', !world.log.slice(before).some((q) => ['checklist_results', 'jobs', 'inspection_records'].includes(q.table)), JSON.stringify(world.log.slice(before).map((q) => q.table)));

  const staff = await area('tok-owner', 'cl_coral', 'area_rest');
  ok('B9 a staff login without the preview header is refused (403 office-login)', staff.status === 403 && staff.body?.code === 'office-login', show(staff));
  const preview = await area('tok-owner', 'cl_coral', 'area_rest', { [H]: 'cl_coral' });
  ok('B9 the office\'s preview of the building reads its area (a read: any preview, §151)', preview.status === 200 && preview.body?.scan?.area === 'Restrooms', show(preview));
  const previewOut = await area('tok-owner', 'cl_harbor', 'area_hall', { [H]: 'cl_coral' });
  ok('B9 🔴 …and nothing outside the one building it previews', previewOut.status === 404, show(previewOut));
  const crewPreview = await area('tok-crew', 'cl_coral', 'area_rest', { [H]: 'cl_coral' });
  ok('B9 🔴 a cleaner sending the preview header is refused', crewPreview.status === 403, show(crewPreview));

  seed();
  Object.assign(world.tables.org_state[0].state.clients[0], archiveCustomerPatch(world.tables.org_state[0].state.clients[0], { at: iso(NOW), by: 'u_owner' }));
  const archived = await area('tok-client', 'cl_coral', 'area_rest');
  ok('B10 🔴 an ARCHIVED building is gone from its customer\'s hub (QR-27, CS-663): 404', archived.status === 404 && archived.body?.code === 'not-found', show(archived));

  seed();
  world.failWhen = (q) => q.table === 'jobs' || q.table === 'inspection_records';
  world.failMessage = 'relation PROVIDER-SECRET';
  const extras = await area('tok-client', 'cl_coral', 'area_rest');
  ok('B11 the next clean and the last inspection are display extras: failed reads leave their lines out, never the page', extras.status === 200
    && extras.body?.scan?.lastCleanedAt === iso(NOW - 2 * HOUR) && extras.body?.scan?.nextCleanOn === null && extras.body?.scan?.lastInspectionOn === null
    && !JSON.stringify(extras.body).includes('PROVIDER-SECRET'), show(extras));
  world.failWhen = (q) => q.table === 'checklist_results';
  const down = await area('tok-client', 'cl_coral', 'area_rest');
  ok('B11 …while a failed area status is the hub\'s "try again" (503), a sentence and a code', down.status === 503 && down.body?.code === 'read-failed'
    && !JSON.stringify(down.body).includes('PROVIDER-SECRET'), show(down));
  world.failWhen = null;

  // The orchestrator's ruling (2026-10-17): the visit that already did this area (it STARTED at or
  // before the area's last clean) is not its next clean — on the hub's page as on the wall's.
  seed();
  const t0 = startOfDayKey(dayKey(new Date(NOW), TZ), TZ).getTime();
  world.tables.jobs = [jobRow('j_did', 's_club', 'cl_coral', t0 + 60 * 1000, 'in_progress'), jobRow('j_next', 's_club', 'cl_coral', NOW + 26 * HOUR)];
  Object.assign(world.tables.checklist_results[0], { performed_at: iso(t0 + 3 * 60 * 1000), area_completions: { fa_rest: iso(t0 + 2 * 60 * 1000) } });
  const after = await area('tok-client', 'cl_coral', 'area_rest');
  eq('B13 🔴 the restrooms, done by tonight\'s visit, show the visit after it as their next clean', after.body?.scan?.nextCleanOn, dayKey(new Date(NOW + 26 * HOUR), TZ));
  const notYet = await area('tok-client', 'cl_coral', 'area_floors');
  eq('B13 …the floors, which that visit has not done, still show it (today)', notYet.body?.scan?.nextCleanOn, dayKey(new Date(t0 + 60 * 1000), TZ));

  seed();
  const scanned = await call({ path: 'scan', token: 'tok-client', query: { token: T('R') } });
  ok('B12 the scan answers the area to open (EP-387 + areaId) — the page\'s address', scanned.status === 200 && scanned.body?.buildingId === 'cl_coral' && scanned.body?.areaId === 'area_rest', show(scanned));
  const opened = await area('tok-client', scanned.body?.buildingId, scanned.body?.areaId);
  eq('B12 …which opens that area\'s page', opened.body?.scan?.area, 'Restrooms');
});

// ── C. the request button ────────────────────────────────────────────────────
await section('C', async () => {
  seed();
  const id = 'f0000000-0000-4000-8000-000000000016';
  const created = await call({
    method: 'POST', path: 'ticket-create', token: 'tok-client',
    body: { id, buildingId: 'cl_coral', type: 'request', category: 'restock', description: 'Restrooms: out of paper towels', siteAreaId: 'area_rest' },
  });
  ok('C1 🔴 a request raised from the area page, carrying siteAreaId, is created (the server ignores the key it does not know yet)', created.status === 200
    && created.body?.ticket?.id === id && (world.tables.problem_reports || []).some((p) => p.id === id && p.client_id === 'cl_coral' && p.origin === 'portal'), show(created));
  ok('C1 …with the text the form started for it', (world.tables.problem_reports || []).find((p) => p.id === id)?.description === 'Restrooms: out of paper towels');
  const api = strip(read('src/lib/clientHubApi.js'));
  ok('C2 createHubTicket sends siteAreaId only when there is one', /siteAreaId = null/.test(api) && /typeof siteAreaId === 'string' && siteAreaId \? \{ siteAreaId \} : \{\}/.test(api));
  const form = strip(read('src/pages/hub/HubNewTicket.jsx'));
  ok('C3 the New request form reads the area from the history state, starts its text with it and sends its id', /hubRequestArea\(location\.state\)/.test(form)
    && /description: hubAreaPrefill\(area\)/.test(form) && /siteAreaId: area\?\.id \|\| null/.test(form));
  const demo = strip(read('src/lib/hubDemo.js'));
  ok('C4 the demo\'s request ignores the key the same way (it reads its fields by name through hubTicketInput)', /export async function createTicket\(body = \{\}\)/.test(demo) && /hubTicketInput\(body\)/.test(demo));
});

// ── D. the wiring ────────────────────────────────────────────────────────────
await section('D', async () => {
  const app = read('src/App.jsx');
  ok('D1 the route: /hub/b/:buildingId/areas/:areaId, remounted per area (KeyedByParam)', /<Route path="\/hub\/b\/:buildingId\/areas\/:areaId" element=\{<KeyedByParam name="areaId"><HubArea \/><\/KeyedByParam>\} \/>/.test(app)
    && /const HubArea = lazyRoute\(\(\) => import\('\.\/pages\/hub\/HubArea'\)\)/.test(app));
  const nav = await import('../src/pages/hub/hubNav.js');
  eq('D2 the area page\'s path is one helper', typeof nav.areaPath === 'function' ? nav.areaPath('cl 1', 'a/b') : null, '/hub/b/cl%201/areas/a%2Fb');
  const hubScan = strip(read('src/pages/hub/HubScan.jsx'));
  ok('D3 🔴 the scan (camera and ?code=) opens that area\'s page, no longer the building\'s Checklists (II.5)', /areaPath\(r\.buildingId, r\.areaId\)/.test(hubScan) && !/'checklists'/.test(hubScan));
  const page = strip(read('src/pages/hub/HubArea.jsx'));
  ok('D4 🔴 ONE card for both homes: the hub page draws the public page\'s AreaScanCard', /import AreaScanCard from '\.\.\/\.\.\/components\/AreaScanCard'/.test(page) && /<AreaScanCard scan=\{scan\} photoUrl=\{photoUrl\}>/.test(page)
    && /<AreaScanCard scan=\{scan\} photoUrl=\{photoUrl\}>/.test(strip(read('src/pages/PublicAreaScan.jsx'))));
  ok('D5 it reads its answer through the adapter, keyed by building and area', /fetchHubArea\(buildingId, areaId\)/.test(page) && /useHubRead\(/.test(page) && /export async function fetchHubArea\(buildingId, areaId\)/.test(read('src/lib/clientHubApi.js')));
  ok('D6 its own back arrow (a BackLink; Back returns where the customer came from)', /<BackLink to=\{buildingPath\(buildingId\)\} label="Back to Dashboard" \/>/.test(page));
  ok('D7 🔴 "Make a request about this area" opens this building\'s New request with the area and a referrer', /Make a request about this area/.test(page)
    && /to=\{sectionPath\(buildingId, 'tickets\/new'\)\} state=\{requestState\}/.test(page) && /area: \{ id: areaId, label: scan\.area \}/.test(page) && /fromLabel: scan\.area/.test(page));
  ok('D8 the office\'s read-only preview draws the button disabled with the preview\'s words (§151)', /readOnly \? \(/.test(page) && /disabled title=\{HUB_PREVIEW_NOTE\}/.test(page));
  ok('D9 a missing area says "Area not found" (the sweep\'s not-found test reads it)', /title="Area not found"/.test(page));
  ok('D10 English only (LANG-8): no catalog lines on the customer\'s page', !/useT\(|t\('/.test(page));
  const demo = strip(read('src/lib/hubDemo.js'));
  ok('D11 the demo twin answers the same projection (projectHubArea) over the demo\'s data', /export async function area\(buildingId, areaId\)/.test(demo) && /projectHubArea\(\{/.test(demo) && /demoScanExtras\(/.test(demo));
  ok('D12 the camera\'s Back from an area names the scan page', /HUB_SCAN_PATH\) return 'Scan site QR code'/.test(read('src/hooks/useFromHere.js')));
  const routes = read('scripts/app-routes.mjs');
  ok('D13 the browser sweeps have demo paths for the page (a recent clean and a never one)', /'\/hub\/b\/:buildingId\/areas\/:areaId': \['\/hub\/b\/cl_seed_mtbaker\/areas\/area_lobby', '\/hub\/b\/cl_seed_mtbaker\/areas\/area_floors'\]/.test(routes));
  const route = strip(read('api/hub/[...path].js'));
  ok('D14 the branch gates on the caller\'s scope first, then the area on the location', /'GET area': async \(\{ res, ctx, q, now \}\) => \{\s*const b = buildingIn\(ctx, q\.buildingId\);\s*if \(!b\) return notFound\(res\);/.test(route)
    && /scanAreasOf\(site\)\.find\(\(a\) => a\.id === areaId\)/.test(route));
});

console.log(`\nhub area page: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✖ ${f}`);
  process.exitCode = 1;
}
