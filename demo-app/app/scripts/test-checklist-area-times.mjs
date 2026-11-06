// QR-1 / HUB-15 — when each AREA of a building was last cleaned, what was done in it,
// and its newest photo.
//
// WHY THIS SUITE. Matt: "When should an area count as cleaned? — When the cleaner
// completes that area's part of the checklist." Round 2 hangs the public QR scan page and
// the client hub off ONE function, `api/_lib/qc/store.areaStatusForSite`, which is built
// on the pure `src/lib/checklistAreas`. Everything a scan will tell a client comes from
// here, so the rule is pinned before anything public reads it.
//
// Two halves, both proven:
//   §1-§3  the PURE rule — areaCompletionTimes (what gets stored) and siteAreaStatus (the
//          join a building is read through), run headlessly.
//   §4     the REAL `api/qc/[...path].js` handler over the loopback Supabase fake, for
//          EP-200's gate, its crew boundary and the shape Round 2 will consume.
//
// REGRESSION (THE LAW II.3): on the pre-fix tree `src/lib/checklistAreas.js` does not
// exist, so the import fails and the whole suite is red; EP-200 answers 404 Unknown route.
//
//   node app/scripts/test-checklist-area-times.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-00000000qr01'.replace(/qr01/, '0001');
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
// Imported DEFENSIVELY: on the pre-fix tree this module does not exist at all, and a hard
// import would end the run with a MODULE_NOT_FOUND instead of a failure report. The
// fallbacks answer "nothing", so every assertion below goes red and says what it wanted —
// the same shape test-checklist-submit-count-route takes for its own pre-fix run.
const areas = await import('../src/lib/checklistAreas.js').catch(() => ({}));
const areaCompletionTimes = areas.areaCompletionTimes || (() => ({}));
const siteAreaStatus = areas.siteAreaStatus || (() => []);
const siteAreaIdOf = areas.siteAreaIdOf || (() => null);
const MAX_ITEM_AGE_MS = areas.MAX_ITEM_AGE_MS ?? 86400000;
const { ITEM_STATE } = await import('../src/lib/checklistResultView.js');
const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the fixture ──────────────────────────────────────────────────────────────
// A two-section checklist. "Floors" is LINKED to the building's `area_floors`; "Cart" is
// not linked to anything, which is the ordinary state for a section with no QR code.
const item = (id, label, extra = {}) => ({ id, label, photoRequired: false, naAllowed: false, ...extra });
const SCHEMA = {
  areas: [
    { id: 'a_floors', label: 'Floors', siteAreaId: 'area_floors', items: [item('f_sweep', 'Swept'), item('f_mop', 'Mopped')] },
    { id: 'a_cart', label: 'Cart', items: [item('c_cart', 'Cart restocked', { naAllowed: true })] },
  ],
};
const PERFORMED = '2026-10-02T23:30:00.000Z';
const at = (minsBefore) => new Date(Date.parse(PERFORMED) - minsBefore * 60000).toISOString();

// ── 1. areaCompletionTimes — what the submission records ────────────────────
ok('the rule module exists and exports its three readers',
  typeof areas.areaCompletionTimes === 'function' && typeof areas.siteAreaStatus === 'function'
  && typeof areas.siteAreaIdOf === 'function');
ok('the link reader finds an explicit siteAreaId', siteAreaIdOf({ siteAreaId: 'area_floors' }) === 'area_floors');
ok('…and the snake_case twin', siteAreaIdOf({ site_area_id: 'area_rest' }) === 'area_rest');
ok('…and answers null for an unlinked section', siteAreaIdOf({ id: 'a1' }) === null);
ok('…and for nothing at all', siteAreaIdOf(null) === null);

{
  // Every item done: each area gets its LAST item's stamp.
  const items = [
    { key: 'f_sweep', checked: true, completedAt: at(90) },
    { key: 'f_mop', checked: true, completedAt: at(40) },
    { key: 'c_cart', checked: true, completedAt: at(5) },
  ];
  const out = areaCompletionTimes(SCHEMA, items, { performedAt: PERFORMED });
  eq('a finished area records its LAST item\'s stamp', out.a_floors, at(40));
  eq('…and so does the other one', out.a_cart, at(5));
  eq('…and nothing else is recorded', Object.keys(out).sort().join(','), 'a_cart,a_floors');
}
{
  // One item short: the area makes NO claim. A wall that says "cleaned 9:40pm" for work
  // nobody did is the one wrong answer a QR code must never give.
  const items = [
    { key: 'f_sweep', checked: true, completedAt: at(90) },
    { key: 'f_mop', checked: false },
    { key: 'c_cart', checked: true, completedAt: at(5) },
  ];
  const out = areaCompletionTimes(SCHEMA, items, { performedAt: PERFORMED });
  ok('an area with an item still owed records NOTHING', !('a_floors' in out), JSON.stringify(out));
  eq('…while the finished area is unaffected', out.a_cart, at(5));
}
{
  // The office's N/A counts as done here exactly as it counts in the stored totals.
  const items = [
    { key: 'f_sweep', checked: true, completedAt: at(50) },
    { key: 'f_mop', checked: true, completedAt: at(20) },
    { key: 'c_cart', na: true, completedAt: at(10) },
  ];
  const out = areaCompletionTimes(SCHEMA, items, { performedAt: PERFORMED });
  eq('an N/A the office allowed finishes its area', out.a_cart, at(10));
}
{
  // …and an N/A the office did NOT allow does not, because it counts nothing.
  const items = [
    { key: 'f_sweep', na: true, completedAt: at(50) },
    { key: 'f_mop', checked: true, completedAt: at(20) },
  ];
  const out = areaCompletionTimes(SCHEMA, items, { performedAt: PERFORMED });
  ok('an N/A on an unflagged item leaves the area unfinished', !('a_floors' in out), JSON.stringify(out));
}
{
  // CS-547: a photo-required item with no photo is not done, so its area is not finished.
  const schema = { areas: [{ id: 'a1', label: 'A', siteAreaId: 'x', items: [item('p', 'Mopped', { photoRequired: true })] }] };
  const items = [{ key: 'p', checked: true, completedAt: at(10) }];
  ok('a photo-required item with no photo leaves its area unfinished',
    !('a1' in areaCompletionTimes(schema, items, { performedAt: PERFORMED })));
  eq('…and WITH the photo it finishes', areaCompletionTimes(schema, items, { performedAt: PERFORMED, photoKeys: ['p'] }).a1, at(10));
}
{
  // THE CLAMP. The stamp is the phone's clock; a wrong one must not put a clean in the
  // future or last year. Both fall back to the submission's own instant, which the
  // server writes.
  const mk = (stamp) => areaCompletionTimes(
    { areas: [{ id: 'a1', label: 'A', items: [item('i1', 'One')] }] },
    [{ key: 'i1', checked: true, completedAt: stamp }],
    { performedAt: PERFORMED },
  ).a1;
  eq('a stamp AFTER the submission is clamped to it', mk('2027-01-01T00:00:00.000Z'), PERFORMED);
  eq('a stamp older than the window falls back to it', mk('2020-01-01T00:00:00.000Z'), PERFORMED);
  eq('an unparseable stamp falls back to it', mk('not a date'), PERFORMED);
  eq('a missing stamp falls back to it', mk(undefined), PERFORMED);
  const inside = new Date(Date.parse(PERFORMED) - MAX_ITEM_AGE_MS + 60000).toISOString();
  eq('a stamp just inside the window is kept', mk(inside), inside);
}
{
  eq('a schema with no usable items records nothing', JSON.stringify(areaCompletionTimes({ areas: [] }, [], { performedAt: PERFORMED })), '{}');
  eq('…and so does a missing schema', JSON.stringify(areaCompletionTimes(null, null, { performedAt: PERFORMED })), '{}');
}

// ── 2. siteAreaStatus — the building's answer ───────────────────────────────
const CLEANING_AREAS = [
  { id: 'area_lobby', label: 'Lobby', instructions: 'Glass and mats' },
  { id: 'area_floors', label: 'Hall floors', instructions: 'Sweep and mop' },
];
const result = (id, { submitId, completions, performedAt, by = 'u_c1', items }) => ({
  id, client_submit_id: submitId, completed_by_user_id: by,
  performed_at: performedAt, area_completions: completions,
  completed_count: 3, total_count: 3,
  template_snapshot: { name: 'Nightly', kind: 'checklist', schema: SCHEMA },
  items,
});
const DONE_ITEMS = [
  { key: 'f_sweep', checked: true, completedAt: at(90) },
  { key: 'f_mop', checked: true, completedAt: at(40) },
  { key: 'c_cart', checked: true, completedAt: at(5) },
];

{
  const rows = siteAreaStatus({
    cleaningAreas: CLEANING_AREAS,
    results: [result('r1', { submitId: 'cl_1', completions: { a_floors: at(40) }, performedAt: PERFORMED, items: DONE_ITEMS })],
    media: [],
  });
  eq('one row per cleaning area, in the office\'s order', rows.map((r) => r.areaId).join(','), 'area_lobby,area_floors');
  eq('an area nothing is linked to says so rather than vanishing', rows[0]?.lastCleanedAt, null);
  eq('…and carries its label and instructions', `${rows[0]?.label}|${rows[0]?.instructions}`, 'Lobby|Glass and mats');
  eq('the linked area reports when it finished', rows[1]?.lastCleanedAt, at(40));
  eq('…who finished it', rows[1]?.lastCleanedByUserId, 'u_c1');
  eq('…which submission said so', rows[1]?.resultId, 'r1');
  eq('…the checklist it came from', rows[1]?.checklistName, 'Nightly');
  eq('…and the items of THAT section, not the whole checklist', rows[1]?.items.map((i) => i.key).join(','), 'f_sweep,f_mop');
  eq('…each with its state', rows[1]?.items.every((i) => i.state === ITEM_STATE.DONE), true);
  eq('…with no photo yet', rows[1]?.photo, null);
}
{
  // NEWEST wins, whatever order the rows arrive in.
  const older = result('r_old', { submitId: 'cl_old', completions: { a_floors: at(5000) }, performedAt: at(4800), items: DONE_ITEMS });
  const newer = result('r_new', { submitId: 'cl_new', completions: { a_floors: at(40) }, performedAt: PERFORMED, by: 'u_c2', items: DONE_ITEMS });
  const rows = siteAreaStatus({ cleaningAreas: CLEANING_AREAS, results: [older, newer], media: [] });
  eq('the NEWEST recorded clean of an area wins', rows[1]?.lastCleanedAt, at(40));
  eq('…and the items shown are that clean\'s', rows[1]?.resultId, 'r_new');
  const flipped = siteAreaStatus({ cleaningAreas: CLEANING_AREAS, results: [newer, older], media: [] });
  eq('…whatever order the rows arrive in', flipped[1]?.lastCleanedAt, at(40));
}
{
  // An area left unfinished by the newest clean falls back to the last one that finished
  // it — which is what "last cleaned" means.
  const partial = result('r_part', { submitId: 'cl_part', completions: {}, performedAt: PERFORMED, items: DONE_ITEMS });
  const done = result('r_done', { submitId: 'cl_done', completions: { a_floors: at(2000) }, performedAt: at(1900), items: DONE_ITEMS });
  const rows = siteAreaStatus({ cleaningAreas: CLEANING_AREAS, results: [partial, done], media: [] });
  eq('a newer clean that did not finish the area does not overwrite the older one that did', rows[1]?.lastCleanedAt, at(2000));
}
{
  // The newest PHOTO of an area, across every submission — a photo is current evidence of
  // the place, so it is not pinned to whichever clean happens to hold the newest time.
  const rows = siteAreaStatus({
    cleaningAreas: CLEANING_AREAS,
    results: [result('r1', { submitId: 'cl_1', completions: { a_floors: at(40) }, performedAt: PERFORMED, items: DONE_ITEMS })],
    media: [
      { id: 'm_old', ref_id: 'cl_1', area_id: 'f_mop', created_at: at(300), url: 'u-old' },
      { id: 'm_new', ref_id: 'cl_1', area_id: 'f_sweep', created_at: at(10), url: 'u-new' },
      { id: 'm_other', ref_id: 'cl_1', area_id: 'c_cart', created_at: at(1), url: 'u-cart' },
    ],
  });
  eq('the newest photo on ANY item of the area wins', rows[1]?.photo?.id, 'm_new');
  eq('…and says which item it was taken on', rows[1]?.photo?.itemKey, 'f_sweep');
  eq('a photo on an UNLINKED section reaches no area', rows[0]?.photo, null);
}
{
  // The photos also decide the per-item state, so a marked item with no photo reads as
  // not done here too — the same answer the stored count reached.
  const schema = { areas: [{ id: 'a1', label: 'A', siteAreaId: 'area_floors', items: [item('p', 'Mopped', { photoRequired: true })] }] };
  const row = {
    id: 'r1', client_submit_id: 'cl_1', completed_by_user_id: 'u_c1', performed_at: PERFORMED,
    area_completions: { a1: at(5) }, template_snapshot: { name: 'N', kind: 'checklist', schema },
    items: [{ key: 'p', checked: true, completedAt: at(5) }],
  };
  const without = siteAreaStatus({ cleaningAreas: CLEANING_AREAS, results: [row], media: [] });
  eq('a photo-required item with no photo reads NOT DONE in the area view', without[1]?.items[0].state, ITEM_STATE.NOT_DONE);
  ok('…and says the photo is what is missing', without[1]?.items[0].needsPhoto === true && without[1]?.items[0].hasPhoto === false);
  const withPhoto = siteAreaStatus({
    cleaningAreas: CLEANING_AREAS, results: [row],
    media: [{ id: 'm1', ref_id: 'cl_1', area_id: 'p', created_at: at(4) }],
  });
  eq('…and DONE once the photo is there', withPhoto[1]?.items[0].state, ITEM_STATE.DONE);
}
{
  eq('a building with no areas answers with no rows', siteAreaStatus({ cleaningAreas: [], results: [], media: [] }).length, 0);
  eq('…and nothing at all does not throw', siteAreaStatus().length, 0);
}

// ── 3. EP-200 — the office read, over the real handler ──────────────────────
const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const logins = {
  'tok-mgr': { id: 'auth-m', email: 'm@example.test', app_metadata: { role: 'manager', org_user_id: 'u_m', org_id: ORG } },
  'tok-crew': { id: 'auth-c', email: 'c@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
  'tok-crew2': { id: 'auth-c2', email: 'c2@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c2', org_id: ORG } },
};
function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 57,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_m', 'manager'), user('u_c1', 'crew'), user('u_c2', 'crew')],
          clients: [{ id: 'c1', name: 'Coral Bay HOA' }, { id: 'c2', name: 'Elsewhere' }],
          sites: [
            { id: 's1', clientId: 'c1', name: 'Clubhouse', cleaningAreas: CLEANING_AREAS },
            { id: 's2', clientId: 'c2', name: 'Other building', cleaningAreas: [] },
          ],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
        },
      }],
      crew_assignments: [
        { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_c1', site_id: null, client_id: 'c1', source: 'standing_client' },
        { organization_id: ORG, user_id: 'u_c2', site_id: null, client_id: 'c2', source: 'standing_client' },
      ],
      checklist_results: [{
        id: 'r1', organization_id: ORG, site_id: 's1', client_id: 'c1', job_id: null,
        client_submit_id: 'cl_1', completed_by_user_id: 'u_c1',
        completed_count: 3, total_count: 3, performed_at: PERFORMED,
        area_completions: { a_floors: at(40) },
        template_snapshot: { name: 'Nightly', kind: 'checklist', schema: SCHEMA },
        items: DONE_ITEMS,
      }],
      account_media: [{
        id: 'm1', organization_id: ORG, scope: 'checklist', ref_id: 'cl_1', area_id: 'f_mop',
        site_id: 's1', client_id: 'c1', kind: 'image', mime_type: 'image/jpeg',
        storage_path: `${ORG}/s1/aaaaaaaaaaaaaaaa.jpg`, thumb_path: null, created_at: at(30),
      }],
    },
    logins,
  });
}
async function get(p, token) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  const [sub, qs] = p.split('?');
  req.query = { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${p}: no response`)), 10000);
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

{
  seed();
  const r = await get('areas/status?siteId=s1', 'tok-mgr');
  eq('EP-200 answers the office', r.status, 200);
  eq('…naming the building', r.body?.siteName, 'Clubhouse');
  eq('…with one row per cleaning area', (r.body?.areas || []).map((a) => a.areaId).join(','), 'area_lobby,area_floors');
  eq('…the linked one carrying its last clean', r.body?.areas?.[1]?.lastCleanedAt, at(40));
  eq('…and its newest photo', r.body?.areas?.[1]?.photo?.id, 'm1');
  ok('…signed for playback', typeof r.body?.areas?.[1]?.photo?.url === 'string' && !!r.body.areas[1]?.photo.url);
  eq('…while the unlinked area says nothing rather than guessing', r.body?.areas?.[0]?.lastCleanedAt, null);
}
{
  seed();
  eq('a crew member at that building may read it', (await get('areas/status?siteId=s1', 'tok-crew')).status, 200);
  eq('a crew member somewhere else is REFUSED, not answered emptily', (await get('areas/status?siteId=s1', 'tok-crew2')).status, 403);
}
{
  seed();
  eq('no token is 401', (await get('areas/status?siteId=s1', null)).status, 401);
  eq('a missing siteId is a 400', (await get('areas/status', 'tok-mgr')).status, 400);
  eq('a malformed siteId is a 400, never raw text to PostgREST', (await get('areas/status?siteId=s1),client_id.eq.c2', 'tok-mgr')).status, 400);
  eq('a site the blob does not know is a 404', (await get('areas/status?siteId=s_nope', 'tok-mgr')).status, 404);
}
{
  seed();
  const r = await get('areas/status?siteId=s2', 'tok-mgr');
  eq('a building with no areas set up answers 200 with no rows', r.status, 200);
  eq('…and an empty list', (r.body?.areas || []).length, 0);
}
{
  // A short history (fewer submissions than a page) is three reads, never one per submission:
  // the blob, one page of results, one media query. A longer one may search further back for
  // an area the page cannot settle, within its bound (CS-701, test-area-status-history.mjs).
  seed();
  await get('areas/status?siteId=s1', 'tok-mgr');
  const results = world.log.filter((q) => q.table === 'checklist_results');
  const media = world.log.filter((q) => q.table === 'account_media');
  eq('ONE checklist read', results.length, 1);
  eq('ONE media read across every submission', media.length, 1);
}

if (fails.length) { console.error('\nchecklist-area-times FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-area-times: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
