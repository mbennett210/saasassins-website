// THE TEAM'S PHOTOS IN THE CUSTOMER HUB (HUB-19; Matt's "Your Account Manager", 2026-11-02, the
// slim row Daniel picked) — the REAL /api/hub handler over fake-supabase.mjs, plus the pure shape
// both halves share (src/lib/hubFaces.js). No network, no credentials, no live project
// (BUILD_INTEGRITY §6b).
//
// What it holds, in the order it matters:
//   1. 🔴 A FACE IS ITS VERSION, NEVER AN ID, A PATH OR A LINK. A member's photo is a private
//      object filed under their member id (`<org>/_avatars/<userId>/<v>.jpg`), and the hub serves
//      no cleaner's id at all (hubVisit.js). So every answer names a photo as exactly { v }, only
//      for a person it already names (the manager, the cleaners on the visit or on site, a
//      checklist's cleaner), and no answer carries an id, the `_avatars` path or a signed link —
//      nor signs one (no Storage call while the answers are read).
//   2. 🔴 `GET face` answers the image of a CURRENT photo version, for a building in the login's
//      scope, and nothing else: a replaced photo's version, a version nobody holds, a malformed
//      one and a building outside the scope are the hub's 404 (the last two before Storage is
//      asked), and only bytes that are a JPEG or PNG are served (nosniff, private, kept a year).
//   3. Who may ask: the gate every branch has (no login 401, an office login without the preview
//      403, a cleaner with it 403) and the office's "Preview as customer", which sees the faces.
//   4. A login may ask 120 times in ten minutes; the next is 429.
//
// REGRESSION (THE LAW II.3): on the pre-change tree (c0ba7ce6) there is no lib/hubFaces.js, no
// `photo` / `photos` / `cleanerPhoto` in any allowlist or answer, and no `face` branch, so 30 of
// these 42 checks fail there: every one that expects a face or the image. The 12 that pass there
// are refusals and absences (a 401, 403 or 404, no id, no Storage call), which a tree with no faces
// gives too; they hold the new branch to the same answers.
//
//   node app/scripts/test-hub-faces.mjs

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
const faces = await tryImport('../src/lib/hubFaces.js');
const hubLib = await import('../src/lib/clientHub.js');
const view = await import('../src/lib/clientHubView.js');
const visitLib = await import('../src/lib/hubVisit.js');
const PREVIEW = await tryImport('../src/lib/hubPreview.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const hub = (await import('../api/hub/[...path].js')).default;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). The repo's suites disagree; read before adding.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const sameKeys = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).sort().join(',') === [...list].sort().join(',');
const isFace = (f, v) => sameKeys(f, ['v']) && f.v === v;
const show = (r) => `${r?.status} ${Buffer.isBuffer(r?.body) ? `<${r.body.length} bytes>` : JSON.stringify(r?.body)?.slice(0, 240)}`;

// ── the world ─────────────────────────────────────────────────────────────────
const H = 3600000;
const DAY = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Photo versions as the server mints them (25 base36 characters, lib/userPhoto.js).
const V_MGR = 'mgrphoto0000000000000000a';
const V_MGR2 = 'mgrphoto0000000000000000b';   // the manager's NEW photo (F4)
const V_CREW = 'crewphoto000000000000000a';
const V_OTHER = 'otherphoto00000000000000a';  // a member no answer names
const V_GONE = 'gonephoto000000000000000a';   // current, but Storage has no object (F8)
const V_JUNK = 'junkphoto000000000000000a';   // current, but the object is not a photo (F9)
const V_NOBODY = 'nobodyphoto0000000000000a'; // well-formed, nobody's

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const objectKey = (userId, v) => `ops-media/${ORG}/_avatars/${userId}/${v}.jpg`;

const CU1 = 'a0000000-0000-4000-8000-000000000001'; // Pat Manager: cl_a
const CU5 = 'a0000000-0000-4000-8000-000000000005'; // a second cl_a login, for the limit alone
const CU4 = 'a0000000-0000-4000-8000-000000000004'; // only cl_x
const CR1 = 'd0000000-0000-4000-8000-000000000001'; // cl_a, yesterday, by Tomas
const CR2 = 'd0000000-0000-4000-8000-000000000002'; // cl_a, two days ago, by a cleaner since removed

const user = (id, role, name, extra = {}) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {}, ...extra });
const CK_SCHEMA = { areas: [{ id: 'a1', label: 'Floors', items: [{ id: 'f_sweep', label: 'Swept' }, { id: 'f_mop', label: 'Mopped' }] }] };

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
            user('u_mgr', 'manager', 'Renata Cruz', { phone: '(754) 555-0105', photo: { v: V_MGR }, pay: { type: 'salary', salaryPerPeriod: 2800 } }),
            user('u_crew', 'crew', 'Tomas Rivera', { phone: '(754) 555-0122', photo: { v: V_CREW } }),
            user('u_crew2', 'crew', 'Keisha Bryant'),
            user('u_other', 'crew', 'Priya Nair', { photo: { v: V_OTHER } }),
            user('u_gone', 'crew', 'Omar Haddad', { photo: { v: V_GONE } }),
            user('u_junk', 'crew', 'Lena Park', { photo: { v: V_JUNK } }),
          ],
          clients: [
            { id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr', street: '120 Royal Palm Way', city: 'Boca Raton', state: 'FL', zip: '33432' },
            { id: 'cl_x', name: 'Harbor Tower', supervisorId: 'u_mgr' },
          ],
          sites: [
            { id: 's_a', clientId: 'cl_a', name: 'Clubhouse', address: '120 Royal Palm Way, Boca Raton FL 33432', lat: 26.3, lng: -80.08 },
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
        { id: CU4, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c4' },
        { id: CU5, organization_id: ORG, name: 'Sam Board', email: 'sam@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c5' },
      ],
      client_user_groups: [],
      client_user_group_members: [],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null },
        { id: 'as4', organization_id: ORG, client_user_id: CU4, client_id: 'cl_x', group_id: null },
        { id: 'as5', organization_id: ORG, client_user_id: CU5, client_id: 'cl_a', group_id: null },
      ],
      // Today's clean at cl_a: Tomas (with a photo) and Keisha (none) are on site now.
      jobs: [
        { id: 'j_a_today', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', status: 'in_progress', start_at: ago(68 * 60000), data: { id: 'j_a_today', clientId: 'cl_a', startAt: ago(68 * 60000), endAt: ago(-60 * 60000), crewIds: ['u_crew', 'u_crew2'] } },
      ],
      time_entries: [
        { id: 'te1', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew', user_name: 'Tomas Rivera', job_id: 'j_a_today', clock_in_at: ago(70 * 60000), clock_out_at: null, status: 'in_progress', geofence_result: 'inside' },
        { id: 'te2', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew2', user_name: 'Keisha Bryant', clock_in_at: ago(25 * 60000), clock_out_at: null, status: 'in_progress', geofence_result: 'unavailable' },
      ],
      checklist_results: [
        { id: CR1, organization_id: ORG, template_id: 'it_f', template_version_id: 'iv_f', template_snapshot: { name: 'Floor Care', kind: 'checklist', schema: CK_SCHEMA }, client_id: 'cl_a', site_id: 's_a', job_id: null, completed_by_user_id: 'u_crew', items: [{ key: 'f_sweep', checked: true }, { key: 'f_mop', checked: true }], completed_count: 2, total_count: 2, client_submit_id: 'cs_cr1', area_completions: null, performed_at: ago(DAY) },
        { id: CR2, organization_id: ORG, template_id: 'it_f', template_version_id: 'iv_f', template_snapshot: { name: 'Floor Care', kind: 'checklist', schema: CK_SCHEMA }, client_id: 'cl_a', site_id: 's_a', job_id: null, completed_by_user_id: 'u_removed', items: [], completed_count: 0, total_count: 2, client_submit_id: 'cs_cr2', area_completions: null, performed_at: ago(2 * DAY) },
      ],
      account_media: [],
      inspection_records: [],
      inspection_items: [],
      problem_reports: [],
      work_order_messages: [],
      activity_log: [],
      inbox_accounts: [],
    },
    objects: {
      [objectKey('u_mgr', V_MGR)]: JPEG,
      [objectKey('u_mgr', V_MGR2)]: JPEG,
      [objectKey('u_crew', V_CREW)]: PNG,
      [objectKey('u_other', V_OTHER)]: JPEG,
      [objectKey('u_junk', V_JUNK)]: HTML,
    },
    logins: {
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client4': { id: 'auth-c4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU4, org_id: ORG } },
      'tok-client5': { id: 'auth-c5', email: 'sam@coralbay.test', app_metadata: { role: 'client', client_user_id: CU5, org_id: ORG } },
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
    },
  });
  world.rpc = () => ({ data: [], error: null });
  __resetRateLimit();
}

async function call({ method = 'GET', path: p, token, headers: extra = {} }) {
  const [sub, qs] = p.split('?');
  const req = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: {} };
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
      Promise.resolve(hub(req, res)).catch((e) => done('threw', { error: e?.message }, headers));
    });
  } finally { Object.assign(console, quiet); }
}
const get = (p, token = 'tok-client', headers = {}) => call({ path: p, token, headers });
const faceAt = (buildingId, v, token = 'tok-client', headers = {}) => get(`face?buildingId=${buildingId}&v=${encodeURIComponent(v)}`, token, headers);
const avatarReads = () => world.storage.filter((s) => /_avatars/.test(s.path || ''));

// ── 1. the shape (lib/hubFaces.js) and the allowlists that carry it ─────────
{
  ok('P0 lib/hubFaces.js loads', () => !faces.__error, faces.__error);
  ok('P1 a face is EXACTLY { v }: HUB_FACE_FIELDS is ["v"], frozen', () => faces.HUB_FACE_FIELDS?.join() === 'v' && Object.isFrozen(faces.HUB_FACE_FIELDS));
  const row = user('u_x', 'crew', 'Ana Lopez', { phone: '555', pay: { hourlyRate: 22 }, photo: { v: V_CREW } });
  ok('P2 hubFaceOf reads the roster row\'s photo version and nothing else of it', () => isFace(faces.hubFaceOf(row), V_CREW), JSON.stringify(faces.hubFaceOf?.(row)));
  ok('P3 …and is null for no photo, null, a malformed version or a value that is not exactly { v }',
    () => [user('a', 'crew', 'A'), { ...row, photo: null }, { ...row, photo: { v: 'Not-A-Version' } }, { ...row, photo: { v: V_CREW, url: 'https://x' } }, null, undefined]
      .every((u) => faces.hubFaceOf(u) === null));
  ok('🔴 P4 projectHubFace keeps the version and drops everything else handed with it (a link, an id)',
    () => isFace(faces.projectHubFace({ v: V_MGR, url: `https://fake.storage/ops-media/${ORG}/_avatars/u_mgr/${V_MGR}.jpg`, userId: 'u_mgr' }), V_MGR));
  ok('P5 …and is null for a bad version or a value that is not an object',
    () => [null, undefined, 'abc', 7, { v: '../u_mgr' }, { v: 'SHOUTING00000000000000000' }, { v: 'short' }, {}].every((f) => faces.projectHubFace(f) === null));
  ok('P6 the letters under a face come from the PROJECTED name: "Renata C." → RC, "Cher" → C, blank → nothing',
    () => faces.hubInitials('Renata C.') === 'RC' && faces.hubInitials('Cher') === 'C' && faces.hubInitials('') === '' && faces.hubInitials('  tomas   r. ') === 'TR');
  ok('P7 the visit band keeps its initials rule (hubCrewInitials is the same rule)', () => visitLib.hubCrewInitials === faces.hubInitials);
  ok('P8 the allowlists name the face where a person is named: the manager, the on-site row, the checklist rows, the crew band',
    () => hubLib.HUB_SUPERVISOR_FIELDS.includes('photo') && view.HUB_ON_SITE_FIELDS.includes('photo')
      && view.HUB_CHECKLIST_ROW_FIELDS.includes('cleanerPhoto') && view.HUB_CHECKLIST_FIELDS.includes('cleanerPhoto')
      && visitLib.HUB_CREW_PEOPLE_FIELDS.includes('photos') && visitLib.HUB_MANAGER_FIELDS.includes('photo'));
  ok('P9 a checklist row with no cleaner named carries no face, even if one is handed in',
    () => view.projectHubChecklistRow({ id: 'r', items: [] }, { cleanerName: null, cleanerPhoto: { v: V_CREW } }).cleanerPhoto === null);
  const onSite = view.hubOnSiteList([
    { id: 'p1', user_id: 'u_1', user_name: 'Ana Lopez', clock_in_at: ago(10 * 60000), clock_out_at: null, status: 'in_progress' },
  ], Date.now(), { photoOf: () => ({ v: V_CREW, url: 'https://leak', userId: 'u_1' }) });
  ok('🔴 P10 an on-site row\'s face is EXACTLY { v } whatever `photoOf` hands back, and the row still carries no id',
    () => onSite.length === 1 && isFace(onSite[0].photo, V_CREW) && sameKeys(onSite[0], view.HUB_ON_SITE_FIELDS) && !JSON.stringify(onSite).includes('u_1'), JSON.stringify(onSite));
}

// ── 2. the answers name faces by version only ───────────────────────────────
seed();
{
  const v = await get('view');
  const a = (v.body?.buildings || []).find((b) => b.id === 'cl_a');
  ok('R1 the view: the manager carries their photo\'s version, exactly the supervisor allowlist',
    () => v.status === 200 && sameKeys(a?.supervisor, hubLib.HUB_SUPERVISOR_FIELDS) && isFace(a.supervisor.photo, V_MGR) && a.supervisor.name === 'Renata C.', show(v));

  const home = await get('home?buildingId=cl_a');
  const people = home.body?.crew?.crew;
  ok('R2 Home: the manager\'s face rides with the building', () => home.status === 200 && isFace(home.body.building?.supervisor?.photo, V_MGR), show(home));
  ok('R3 Home: the crew band\'s faces line up with its initials (Tomas has a photo, Keisha none)',
    () => sameKeys(people, visitLib.HUB_CREW_PEOPLE_FIELDS) && people.initials.join() === 'TR,KB'
      && people.photos.length === 2 && isFace(people.photos[0], V_CREW) && people.photos[1] === null, JSON.stringify(people));

  const visit = await get('visit?buildingId=cl_a');
  const rows = visit.body?.onSite || [];
  ok('R4 Today\'s Visit: each person on site carries their face, exactly the on-site allowlist',
    () => visit.status === 200 && rows.length === 2 && rows.every((r) => sameKeys(r, view.HUB_ON_SITE_FIELDS))
      && rows[0].name === 'Tomas R.' && isFace(rows[0].photo, V_CREW) && rows[1].name === 'Keisha B.' && rows[1].photo === null, JSON.stringify(rows));
  ok('R5 Today\'s Visit: the manager line carries the manager\'s face, exactly the manager allowlist',
    () => sameKeys(visit.body?.manager, visitLib.HUB_MANAGER_FIELDS) && isFace(visit.body.manager.photo, V_MGR), JSON.stringify(visit.body?.manager));
  ok('R6 …and the visit\'s crew band lines up the same faces', () => isFace(visit.body?.crew?.crew?.photos?.[0], V_CREW) && visit.body.crew.crew.photos[1] === null, JSON.stringify(visit.body?.crew?.crew));

  const lists = await get('checklists?buildingId=cl_a');
  const r1 = (lists.body?.rows || []).find((r) => r.id === CR1);
  const r2 = (lists.body?.rows || []).find((r) => r.id === CR2);
  ok('R7 the checklists list: the cleaner\'s face beside their name, exactly the row allowlist',
    () => lists.status === 200 && sameKeys(r1, view.HUB_CHECKLIST_ROW_FIELDS) && r1.cleaner === 'Tomas R.' && isFace(r1.cleanerPhoto, V_CREW), show(lists));
  ok('R8 …and a checklist whose cleaner has left the team names nobody and carries no face',
    () => r2 && r2.cleaner === null && r2.cleanerPhoto === null, JSON.stringify(r2));

  const one = await get(`checklist?buildingId=cl_a&id=${CR1}`);
  ok('R9 the checklist page: the cleaner\'s face beside their name, exactly its allowlist',
    () => one.status === 200 && sameKeys(one.body?.checklist, view.HUB_CHECKLIST_FIELDS) && isFace(one.body.checklist.cleanerPhoto, V_CREW), show(one));

  const blob = JSON.stringify([v.body, home.body, visit.body, lists.body, one.body]);
  // The building's manager row has carried their member id since Round 1 (`supervisor.id`,
  // clientHub.js, 2026-10-03); that one field is the only id an answer may hold, and it is not
  // where a photo travels. Every other id, and every path or link to a photo, is absent.
  const withoutManagerId = JSON.stringify([v.body, home.body, visit.body, lists.body, one.body], (k, x) => (k === 'supervisor' && x && typeof x === 'object' ? { ...x, id: undefined } : x));
  ok('🔴 R10 no answer carries a cleaner\'s id, the photo\'s path or a link to it (the manager\'s id only in its Round 1 field)',
    () => !/u_mgr|u_crew|u_owner|u_removed|_avatars|ops-media|fake\.storage/.test(withoutManagerId), withoutManagerId.match(/u_mgr|u_crew|u_owner|u_removed|_avatars|ops-media|fake\.storage/)?.[0]);
  ok('🔴 R11 …nor the face of a member none of them names (Priya, Omar, Lena)', () => ![V_OTHER, V_GONE, V_JUNK].some((x) => blob.includes(x)));
  ok('🔴 R12 …and reading them signs nothing: no Storage call touches a photo', () => avatarReads().length === 0, JSON.stringify(avatarReads()));

  // A roster photo value that is not exactly { v } (the shared record is browser-writable) is no face.
  world.tables.org_state[0].state.users.find((u) => u.id === 'u_crew').photo = { v: V_CREW, url: 'https://leak.example/x.jpg' };
  const visit2 = await get('visit?buildingId=cl_a');
  ok('R13 a roster photo that is not exactly { v } is served as no face, and its extra never reaches the page',
    () => visit2.status === 200 && visit2.body.onSite[0].photo === null && !JSON.stringify(visit2.body).includes('leak.example'), JSON.stringify(visit2.body?.onSite));
}

// ── 3. GET face: the image of a current version, in scope, and nothing else ─
seed();
{
  const r = await faceAt('cl_a', V_MGR);
  ok('F1 the manager\'s photo: 200, the stored bytes, image/jpeg', () => r.status === 200 && Buffer.isBuffer(r.body) && r.body.equals(JPEG) && r.headers?.['content-type'] === 'image/jpeg', show(r));
  ok('🔴 F2 …kept privately by the browser for a year (the object never changes for its version), and never sniffed as anything else',
    () => r.headers?.['cache-control'] === 'private, max-age=31536000, immutable' && r.headers?.['x-content-type-options'] === 'nosniff', JSON.stringify(r.headers));
  ok('F3 …read from the one place a photo is filed: ops-media, <org>/_avatars/<member>/<v>.jpg',
    () => avatarReads().length === 1 && avatarReads()[0].bucket === 'ops-media' && avatarReads()[0].op === 'download' && avatarReads()[0].path === `${ORG}/_avatars/u_mgr/${V_MGR}.jpg`, JSON.stringify(avatarReads()));
  const png = await faceAt('cl_a', V_CREW);
  ok('F4 a cleaner\'s photo stored as a PNG is served as one', () => png.status === 200 && png.body.equals(PNG) && png.headers?.['content-type'] === 'image/png', show(png));

  const nobody = await faceAt('cl_a', V_NOBODY);
  ok('🔴 F5 a well-formed version nobody holds is the hub\'s 404, a sentence and a code',
    () => nobody.status === 404 && nobody.body?.code === 'not-found' && !Buffer.isBuffer(nobody.body), show(nobody));

  // The manager changes their photo: the old version stops answering the moment the roster moves.
  world.tables.org_state[0].state.users.find((u) => u.id === 'u_mgr').photo = { v: V_MGR2 };
  const old = await faceAt('cl_a', V_MGR);
  const fresh = await faceAt('cl_a', V_MGR2);
  ok('🔴 F6 a REPLACED photo\'s version is a 404 (its object may still be in Storage), the new one answers',
    () => old.status === 404 && fresh.status === 200 && fresh.body.equals(JPEG), `${show(old)} / ${show(fresh)}`);
  world.tables.org_state[0].state.users.find((u) => u.id === 'u_mgr').photo = { v: V_MGR };

  const before = avatarReads().length;
  const bad = [];
  for (const v of ['', 'Not-A-Version', '../u_mgr', `${V_MGR}.jpg`, `../../${ORG}/_avatars/u_mgr/${V_MGR}`, 'short', V_MGR.toUpperCase()]) {
    const x = await faceAt('cl_a', v);
    if (x.status !== 404 || x.body?.code !== 'not-found') bad.push(`${v}: ${show(x)}`);
  }
  const missingV = await get('face?buildingId=cl_a');
  if (missingV.status !== 404) bad.push(`no v: ${show(missingV)}`);
  ok('🔴 F7 a malformed version (a path, a file name, the wrong case, none) is a 404 and Storage is never asked',
    () => bad.length === 0 && avatarReads().length === before, `${bad.join(' | ')} reads ${avatarReads().length - before}`);

  const out = await faceAt('cl_x', V_MGR);
  const unknown = await faceAt('cl_nope', V_MGR);
  const noBuilding = await get(`face?v=${V_MGR}`);
  ok('🔴 F8 a building outside the login\'s scope, an unknown one or none is a 404, and Storage is never asked',
    () => [out, unknown, noBuilding].every((x) => x.status === 404 && x.body?.code === 'not-found') && avatarReads().length === before,
    `${show(out)} / ${show(unknown)} / ${show(noBuilding)}`);
  const harbor = await faceAt('cl_x', V_MGR, 'tok-client4');
  ok('F9 …while that building\'s own customer is served the same manager\'s face', () => harbor.status === 200 && harbor.body.equals(JPEG), show(harbor));

  const gone = await faceAt('cl_a', V_GONE);
  ok('F10 a current version whose object Storage cannot find is a 404 (the page keeps the initials)', () => gone.status === 404 && gone.body?.code === 'not-found', show(gone));
  const junk = await faceAt('cl_a', V_JUNK);
  ok('🔴 F11 an object whose bytes are not a JPEG or PNG is never served (404), whatever it claims to be',
    () => junk.status === 404 && !Buffer.isBuffer(junk.body) && !JSON.stringify(junk.body).includes('script'), show(junk));
}

// ── 4. who may ask ──────────────────────────────────────────────────────────
seed();
{
  const HDR = PREVIEW.HUB_PREVIEW_HEADER || 'x-hub-preview';
  const anon = await call({ path: `face?buildingId=cl_a&v=${V_MGR}` });
  ok('A1 no login is a 401', () => anon.status === 401, show(anon));
  const staff = await faceAt('cl_a', V_MGR, 'tok-owner');
  ok('🔴 A2 an office login with no preview header is refused (403 office-login)', () => staff.status === 403 && staff.body?.code === 'office-login', show(staff));
  const crew = await faceAt('cl_a', V_MGR, 'tok-crew', { [HDR]: 'cl_a' });
  ok('🔴 A3 a cleaner sending the preview header is refused (403 preview-forbidden)',
    () => crew.status === 403 && !!PREVIEW.HUB_PREVIEW_FORBIDDEN && crew.body?.code === PREVIEW.HUB_PREVIEW_FORBIDDEN, show(crew));
  const preview = await faceAt('cl_a', V_MGR, 'tok-owner', { [HDR]: 'cl_a' });
  ok('A4 the office\'s "Preview as customer" sees the faces its building shows', () => preview.status === 200 && preview.body.equals(JPEG), show(preview));
  const previewOut = await faceAt('cl_x', V_MGR, 'tok-owner', { [HDR]: 'cl_a' });
  ok('🔴 A5 …and only that building: another building in the same preview is a 404', () => previewOut.status === 404, show(previewOut));
}

// ── 5. the limit ────────────────────────────────────────────────────────────
seed();
{
  let served = 0;
  let first429 = null;
  for (let i = 0; i < 125 && !first429; i += 1) {
    const x = await faceAt('cl_a', V_MGR, 'tok-client5');
    if (x.status === 200) served += 1;
    else if (x.status === 429) first429 = x;
  }
  ok('L1 a login is served 120 photos in ten minutes; the next ask is 429 with a Retry-After',
    () => served === 120 && first429?.body?.code === 'too-many-requests' && Number(first429.headers?.['retry-after']) > 0, `served ${served} ${show(first429)}`);
  const other = await faceAt('cl_a', V_MGR, 'tok-client');
  ok('L2 …counted per login: another customer of the same building is still served', () => other.status === 200, show(other));
}

console.log(`\ntest-hub-faces: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✖ ${f}`);
  process.exitCode = 1;
}
