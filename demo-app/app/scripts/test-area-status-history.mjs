// CS-701 — an area's LAST CLEAN, however old: the QR code on a wall (and the office's
// Cleaning instructions card) must never say "never cleaned" about an area that was.
//
// THE DEFECT. `api/_lib/qc/store.areaStatusForSite` looked for each area's last clean only in
// the building's newest AREA_STATUS_RESULT_SCAN (25) checklist submissions, across every
// checklist and cleaner. At a busy building an area that only a weekly or monthly checklist
// covers falls out of that window within days, and the public page (EP-263) and the office's
// card (EP-200) both said it was never cleaned.
//
// WHAT THIS HOLDS, through the REAL handlers over fake-supabase.mjs (no network, no
// credentials, no live project — BUILD_INTEGRITY §6b):
//   H1  the bug: 36 newer submissions that never cover the carpets, and an older monthly one
//       that cleaned them → the carpets still answer that monthly clean, on the public page
//       AND on EP-200 (the office and a cleaner of the building alike)
//   H2  no regression: an area the newest page answers keeps that answer
//   H3  an older submission that covered the area but left it UNFINISHED is passed over for
//       the one before it that finished it
//   H4  the newest COMPLETION, not the newest submission: a page whose only finish of an area
//       is stamped hours before its submission does not hide a later finish just past the page
//   H5  bounded: the search stops at its page cap for an area nothing ever finishes, every
//       deeper read carries the area's containment filter, the crew scope and an order, and
//       the ONE media read names only the first page's submissions plus the winners'
//
// REGRESSION (THE LAW II.3): on the pre-fix tree the deep search does not exist, so H1, H3,
// H4 and the H5 shape checks fail; H2 and the H5 read bound pass (they guard the fix).
//
//   node app/scripts/test-area-status-history.mjs
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-000000000701';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const scan = await import('../src/lib/areaScan.js');
const store = await import('../api/_lib/qc/store.js');
const qcHandler = (await import('../api/qc/[...path].js')).default;
const publicHandler = (await import('../api/public/scan/[...path].js')).default;

// The source of truth for the bounds: the store's own constants (pre-fix the deep ones do
// not exist yet — the fallbacks only keep the fixture shaped, the checks still go red).
const PAGE = store.AREA_STATUS_RESULT_SCAN ?? 25;
const DEEP_PAGE = store.AREA_STATUS_DEEP_PAGE ?? 10;
const DEEP_PAGES = store.AREA_STATUS_DEEP_PAGES ?? 10;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const T = (c) => c.repeat(32);

// ── the fixture ─────────────────────────────────────────────────────────────
const item = (id, label) => ({ id, label, photoRequired: false, naAllowed: false });
// The nightly checklist covers the lobby (finished every night) and the fitness center
// (never finished: its section is always left open).
const NIGHTLY = {
  areas: [
    { id: 'na_lobby', label: 'Lobby', siteAreaId: 'area_lobby', items: [item('n_glass', 'Glass doors cleaned'), item('n_floor', 'Lobby floor mopped')] },
    { id: 'na_gym', label: 'Gym', siteAreaId: 'area_gym', items: [item('n_gym', 'Machines wiped down')] },
  ],
};
// The monthly deep clean is the ONLY checklist that covers the carpets.
const MONTHLY = {
  areas: [{ id: 'ma_carpet', label: 'Carpets', siteAreaId: 'area_carpet', items: [item('m_shampoo', 'Carpets shampooed'), item('m_edges', 'Edges vacuumed')] }],
};
// A checklist whose one section is the trash room (H4).
const TRASH = { areas: [{ id: 'ta_trash', label: 'Trash room', siteAreaId: 'area_trash', items: [item('t_bins', 'Bins emptied')] }] };

const row = (id, siteId, performedMs, schema, completions, { name = 'Nightly', by = 'u_crew', items = [] } = {}) => ({
  id, organization_id: ORG, site_id: siteId, client_id: siteId === 'st_hq' ? 'cl_hq' : `cl_${siteId}`, job_id: null,
  client_submit_id: `cs_${id}`, completed_by_user_id: by, completed_count: 1, total_count: 1,
  performed_at: iso(performedMs), area_completions: completions,
  template_snapshot: { name, kind: 'checklist', schema }, items,
});
const nightlyItems = [{ key: 'n_glass', checked: true }, { key: 'n_floor', checked: true }, { key: 'n_gym', checked: false }];
const monthlyItems = [{ key: 'm_shampoo', checked: true }, { key: 'm_edges', checked: true }];

// THE CS-701 BUILDING: three cleaners each file the nightly checklist (it is assigned per
// cleaner), so its newest 36 submissions span twelve days and not one covers the carpets;
// the monthly deep clean that did was 20 days ago.
const NIGHTLY_COUNT = 36;
const NIGHTLY_EVERY = 8 * HOUR;
const MONTHLY_AT = NOW - 20 * DAY;
const MONTHLY_DONE = MONTHLY_AT - 5 * MIN;
const nightlyRows = Array.from({ length: NIGHTLY_COUNT }, (_, i) => {
  const at = NOW - HOUR - i * NIGHTLY_EVERY;
  return row(`r_night_${String(i).padStart(2, '0')}`, 'st_hq', at, NIGHTLY, { na_lobby: iso(at - 10 * MIN) }, { items: nightlyItems });
});
const monthlyRow = row('r_monthly', 'st_hq', MONTHLY_AT, MONTHLY, { ma_carpet: iso(MONTHLY_DONE) }, { name: 'Monthly deep clean', items: monthlyItems });

// H3's building: the same nightly stream; past it, the carpets covered 15 days ago but left
// UNFINISHED, and finished 40 days ago.
const OLD_DONE_AT = NOW - 40 * DAY;
const twoRows = [
  ...Array.from({ length: NIGHTLY_COUNT }, (_, i) => row(`r_two_night_${i}`, 'st_two', NOW - HOUR - i * NIGHTLY_EVERY, NIGHTLY, { na_lobby: iso(NOW - HOUR - i * NIGHTLY_EVERY) })),
  row('r_two_unfinished', 'st_two', NOW - 15 * DAY, MONTHLY, {}, { name: 'Monthly deep clean' }),
  row('r_two_done', 'st_two', OLD_DONE_AT, MONTHLY, { ma_carpet: iso(OLD_DONE_AT) }, { name: 'Monthly deep clean', items: monthlyItems }),
];

// H4's building: a full first page inside the last hour. Its newest submission finished the
// trash room with stamps 23 hours before it was submitted (a phone that kept the checklist
// open overnight — areaCompletionTimes allows a day); none of the rest of the page finished
// it; the submission just past the page finished it two hours ago, which is the LATER finish.
const EDGE_ROWS = [
  row('r_edge_00', 'st_edge', NOW - MIN, TRASH, { ta_trash: iso(NOW - MIN - 23 * HOUR) }),
  ...Array.from({ length: PAGE - 1 }, (_, i) => row(`r_edge_${String(i + 1).padStart(2, '0')}`, 'st_edge', NOW - (i + 2) * 2 * MIN, TRASH, {})),
  row('r_edge_past', 'st_edge', NOW - 2 * HOUR, TRASH, { ta_trash: iso(NOW - 2 * HOUR) }),
];

// H5's building: far more submissions covering the gym than the search may read, none
// finishing it, and one finish beyond the cap.
const CAP_COVER = PAGE + DEEP_PAGES * DEEP_PAGE + 5;
const capRows = [
  ...Array.from({ length: CAP_COVER }, (_, i) => row(`r_cap_${String(i).padStart(3, '0')}`, 'st_cap', NOW - HOUR - i * HOUR, NIGHTLY, {})),
  row('r_cap_ancient', 'st_cap', NOW - HOUR - CAP_COVER * HOUR, NIGHTLY, { na_gym: iso(NOW - HOUR - CAP_COVER * HOUR) }),
];

const AREAS_HQ = [
  { id: 'area_lobby', label: 'Lobby' },
  { id: 'area_carpet', label: 'Carpets' },
  { id: 'area_gym', label: 'Fitness center' },
];
const TOK = { lobby: T('L'), carpet: T('C'), gym: T('G'), twoCarpet: T('W'), trash: T('E') };
const code = (id, siteId, areaId, token) => ({
  id, organization_id: ORG, site_id: siteId, area_id: areaId, token, created_at: iso(NOW - 30 * DAY), created_by: 'u_owner', revoked_at: null, revoked_by: null,
});
const roster = [
  { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mgr', email: 'mgr@example.test' },
  { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: 'crew@example.test' },
];
const logins = {
  'tok-mgr': { id: 'auth-mgr', email: 'mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
  'tok-crew': { id: 'auth-crew', email: 'crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
};

function seed() {
  const state = {
    company: { name: 'Clean Space', timezone: 'America/New_York' },
    users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
    clients: [{ id: 'cl_hq', name: 'Harbor Point HOA' }, { id: 'cl_st_two', name: 'Two' }, { id: 'cl_st_edge', name: 'Edge' }, { id: 'cl_st_cap', name: 'Cap' }],
    sites: [
      { id: 'st_hq', clientId: 'cl_hq', name: 'Clubhouse', cleaningAreas: AREAS_HQ },
      { id: 'st_two', clientId: 'cl_st_two', name: 'Two', cleaningAreas: [{ id: 'area_carpet', label: 'Carpets' }] },
      { id: 'st_edge', clientId: 'cl_st_edge', name: 'Edge', cleaningAreas: [{ id: 'area_trash', label: 'Trash room' }] },
      { id: 'st_cap', clientId: 'cl_st_cap', name: 'Cap', cleaningAreas: [{ id: 'area_gym', label: 'Fitness center' }] },
    ],
    opsSettings: {},
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 3 }],
      checklist_results: [...nightlyRows, monthlyRow, ...twoRows, ...EDGE_ROWS, ...capRows].map((r) => structuredClone(r)),
      account_media: [
        // the monthly clean's photo of the carpets
        { id: 'am_carpet', organization_id: ORG, scope: 'checklist', ref_id: 'cs_r_monthly', area_id: 'm_shampoo', site_id: 'st_hq', client_id: 'cl_hq', kind: 'image', mime_type: 'image/jpeg', storage_path: `${ORG}/st_hq/cccccccccccccccc.jpg`, thumb_path: `${ORG}/st_hq/cccccccccccccccc.thumb.jpg`, created_at: iso(MONTHLY_DONE - MIN) },
      ],
      area_scan_codes: [
        code('c_lobby', 'st_hq', 'area_lobby', TOK.lobby),
        code('c_carpet', 'st_hq', 'area_carpet', TOK.carpet),
        code('c_gym', 'st_hq', 'area_gym', TOK.gym),
        code('c_two', 'st_two', 'area_carpet', TOK.twoCarpet),
        code('c_trash', 'st_edge', 'area_trash', TOK.trash),
      ],
      crew_assignments: [
        { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_crew', site_id: null, client_id: 'cl_hq', source: 'standing_client' },
      ],
      jobs: [],
    },
    logins,
  });
  world.objects = {};
  // The JS twin of area_scan_site (migration 20261004110100): one site's name, its customer's
  // name, its areas' ids and labels, and the org's zone.
  world.rpc = (name, args) => {
    if (name !== 'area_scan_site') return { data: null, error: { code: 'PGRST202', message: `no function ${name}` } };
    const site = (world.tables.org_state[0].state.sites || []).find((s) => s.id === args.p_site_id);
    if (!site) return { data: null, error: null };
    const client = world.tables.org_state[0].state.clients.find((c) => c.id === site.clientId);
    return { data: { siteName: site.name, clientName: client?.name ?? null, areas: site.cleaningAreas.map((a) => ({ id: a.id, label: a.label })), timeZone: 'America/New_York' }, error: null };
  };
  __resetRateLimit();
}

async function call(handler, { path, token, query = {}, ip = '203.0.113.9' }) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-vercel-forwarded-for': ip };
  req.query = { ...query, subpath: path };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path}: no response`)), 10000);
      const headers = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200,
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const publicScan = (token) => call(publicHandler, { path: 'area', query: { token } });
const areaStatus = (siteId, who = 'mgr') => call(qcHandler, { path: 'areas/status', token: `tok-${who}`, query: { siteId } });
const rowFor = (r, areaId) => (r.body?.areas || []).find((a) => a.areaId === areaId) || null;
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

// ── P. the pure halves (src/lib/checklistAreas) ─────────────────────────────
{
  const areasLib = await import('../src/lib/checklistAreas.js');
  const completions = typeof areasLib.siteAreaCompletions === 'function' ? areasLib.siteAreaCompletions : () => new Map();
  const past = typeof areasLib.areasPastThePage === 'function' ? areasLib.areasPastThePage : () => null;
  const two = {
    area_completions: { s1: iso(NOW - 3 * HOUR), s2: iso(NOW - 2 * HOUR), s3: 'not a time' },
    template_snapshot: { schema: { areas: [
      { id: 's1', siteAreaId: 'area_x', items: [] }, { id: 's2', siteAreaId: 'area_x', items: [] },
      { id: 's3', siteAreaId: 'area_y', items: [] }, { id: 's4', items: [] },
    ] } },
  };
  const got = completions(two);
  eq('P1 a submission finished an area at its LATEST linked section\'s stamp', got.get('area_x')?.at, NOW - 2 * HOUR);
  eq('P1 …naming that section', got.get('area_x')?.sectionId, 's2');
  ok('P1 an unreadable stamp finishes nothing, and an unlinked section names no area', !got.has('area_y') && got.size === 1, JSON.stringify([...got]));
  eq('P1 nothing in, nothing out', completions(null).size, 0);
  const page = [
    { performed_at: iso(NOW - HOUR), ...two },
    { performed_at: iso(NOW - 5 * HOUR), area_completions: {}, template_snapshot: { schema: { areas: [] } } },
  ];
  eq('P2 a page shorter than asked has read everything: nothing to search', JSON.stringify(past({ areaIds: ['area_x', 'area_z'], results: page, full: false })), '[]');
  const pending = past({ areaIds: ['area_x', 'area_z', 'area_x', ''], results: page, full: true }) || [];
  ok('P2 a full page settles an area it finished after its oldest submission', !pending.some((p) => p.areaId === 'area_x'), JSON.stringify(pending));
  ok('P2 …and searches one it never finished, once, from the page\'s oldest instant (plus a millisecond)', pending.length === 1 && pending[0].areaId === 'area_z'
    && pending[0].bestAt === null && pending[0].before === iso(NOW - 5 * HOUR + 1), JSON.stringify(pending));
  const early = past({ areaIds: ['area_x'], results: [{ performed_at: iso(NOW - HOUR), ...two }, { performed_at: iso(NOW - 90 * MIN), area_completions: {}, template_snapshot: { schema: { areas: [] } } }], full: true }) || [];
  ok('P2 a finish stamped before the page\'s oldest submission is not settled: an older row could hold a later finish', early.length === 1 && early[0].bestAt === NOW - 2 * HOUR, JSON.stringify(early));
}

// ── H1. the bug ─────────────────────────────────────────────────────────────
{
  seed();
  const r = await publicScan(TOK.carpet);
  eq('H1 the carpets\' code answers 200', r.status, 200);
  eq(`H1 🔴 the public page finds the monthly clean 20 days back, past ${NIGHTLY_COUNT} newer checklists that never covered it`, r.body?.lastCleanedAt, iso(MONTHLY_DONE));
  // QR-28 (2026-10-17): no warning any more — a clean of any age reads "Cleaned"; never the never state.
  eq('H1 …so it reads as a recorded clean, never "Cleaning records start soon"', scan.scanStatusCopy(r.body?.lastCleanedAt)?.badge, 'Cleaned');
  ok('H1 …listing what that clean did', (r.body?.items || []).map((i) => i.label).join('|') === 'Carpets shampooed|Edges vacuumed', show(r));
  eq('H1 …with that clean\'s photo (HUB-15)', r.body?.photo?.takenAt, iso(MONTHLY_DONE - MIN));
  ok('H1 …and still nothing private on the wire', !/r_monthly|cs_r_monthly|u_crew|Monthly deep clean|am_carpet/.test(JSON.stringify(r.body || {})), show(r));
}
{
  seed();
  const r = await areaStatus('st_hq');
  eq('H1 EP-200 answers the office', r.status, 200);
  const carpet = rowFor(r, 'area_carpet');
  eq('H1 🔴 the office card finds the same clean', carpet?.lastCleanedAt, iso(MONTHLY_DONE));
  eq('H1 …from the monthly checklist', carpet?.checklistName, 'Monthly deep clean');
  eq('H1 …its submission', carpet?.resultId, 'r_monthly');
  eq('H1 …and its photo', carpet?.photo?.id, 'am_carpet');
  const crew = await areaStatus('st_hq', 'crew');
  eq('H1 a cleaner of the building reads it too (crew scope kept)', rowFor(crew, 'area_carpet')?.lastCleanedAt, iso(MONTHLY_DONE));
}

// ── H2. no regression ───────────────────────────────────────────────────────
{
  seed();
  const r = await areaStatus('st_hq');
  eq('H2 the lobby keeps the newest page\'s answer (last night)', rowFor(r, 'area_lobby')?.lastCleanedAt, iso(NOW - HOUR - 10 * MIN));
  eq('H2 …from last night\'s submission', rowFor(r, 'area_lobby')?.resultId, 'r_night_00');
  eq('H2 the fitness center, never finished by anyone, still says so', rowFor(r, 'area_gym')?.lastCleanedAt, null);
  const lobby = await publicScan(TOK.lobby);
  eq('H2 the lobby\'s public page reads its clean', scan.scanStatusCopy(lobby.body?.lastCleanedAt)?.badge, 'Cleaned');
  const gym = await publicScan(TOK.gym);
  eq('H2 the fitness center\'s public page says no cleaning is recorded yet', scan.scanStatusCopy(gym.body?.lastCleanedAt)?.badge, 'Cleaning records start soon');
}

// ── H3. an unfinished cover is passed over ──────────────────────────────────
{
  seed();
  const r = await publicScan(TOK.twoCarpet);
  eq('H3 🔴 the carpets answer the clean that FINISHED them (40 days back)', r.body?.lastCleanedAt, iso(OLD_DONE_AT));
  const media = world.log.filter((q) => q.table === 'account_media');
  eq('H3 one media read', media.length, 1);
  const refs = media[0]?.in?.ref_id || [];
  ok('H3 …naming the winner\'s photos', refs.includes('cs_r_two_done'), JSON.stringify(refs));
  ok('H3 …but not the unfinished submission\'s (only the first page and the winners are read for photos)', !refs.includes('cs_r_two_unfinished'), JSON.stringify(refs));
  ok('H3 …and no more refs than the first page plus one winner', refs.length <= PAGE + 1, `${refs.length} refs`);
}

// ── H4. the newest completion, not the newest submission ────────────────────
{
  seed();
  const r = await publicScan(TOK.trash);
  eq('H4 🔴 the trash room answers its LATER finish, two hours ago, just past the first page', r.body?.lastCleanedAt, iso(NOW - 2 * HOUR));
  eq('H4 …so it reads as cleaned', scan.scanStatusCopy(r.body?.lastCleanedAt)?.badge, 'Cleaned');
}

// ── H5. bounded, and shaped ─────────────────────────────────────────────────
{
  seed();
  const r = await areaStatus('st_cap');
  eq('H5 a building whose fitness center nothing finished answers 200', r.status, 200);
  eq('H5 …"not recorded" (its only finish is past the search\'s cap)', rowFor(r, 'area_gym')?.lastCleanedAt, null);
  const reads = world.log.filter((q) => q.table === 'checklist_results');
  ok(`H5 the search stops at its cap: at most 1 + ${DEEP_PAGES} checklist reads for the one area`, reads.length >= 1 && reads.length <= 1 + DEEP_PAGES, `${reads.length} reads`);
  const deep = reads.slice(1);
  const searched = (q) => (q.ops || []).find((o) => o.op === 'contains' && /^template_snapshot->schema->areas$/.test(o.col));
  ok('H5 🔴 the deeper reads exist and each carries the area\'s containment filter', deep.length > 0
    && deep.every((q) => /"siteAreaId":"area_gym"/.test(String(searched(q)?.value || ''))), JSON.stringify(reads.map((q) => q.ops)));
  ok('H5 …newest first with the id as the tie-break, before its page', deep.length > 0 && deep.every((q) => JSON.stringify(q.orders) === JSON.stringify([{ c: 'performed_at', asc: false }, { c: 'id', asc: false }])
    && typeof q.offset === 'number'), JSON.stringify(deep.map((q) => [q.orders, q.offset])));
  ok(`H5 …never more than ${DEEP_PAGE} rows a page`, deep.length > 0 && deep.every((q) => q.limit != null && q.limit <= DEEP_PAGE), JSON.stringify(deep.map((q) => q.limit)));
  ok('H5 …and only below the first page (no row of it is read twice but its last instant)', deep.length > 0 && deep.every((q) => (q.ops || []).some((o) => o.op === 'lte' && o.col === 'performed_at')), JSON.stringify(deep.map((q) => q.ops)));
}
{
  seed();
  await areaStatus('st_hq', 'crew');
  const reads = world.log.filter((q) => q.table === 'checklist_results');
  ok('H5 🔴 a cleaner\'s deeper reads carry their crew scope (applyCrewScope\'s or-filter) like the first page', reads.length > 1
    && reads.every((q) => (q.ops || []).some((o) => o.op === 'or')), JSON.stringify(reads.map((q) => (q.ops || []).map((o) => o.op))));
  const searchedAreas = reads.slice(1).map((q) => String((q.ops || []).find((o) => o.op === 'contains')?.value || ''));
  ok('H5 …and only the areas the first page could not answer are searched: the carpets and the fitness center, never the lobby',
    searchedAreas.length > 0 && searchedAreas.some((v) => v.includes('area_carpet')) && searchedAreas.some((v) => v.includes('area_gym'))
    && !searchedAreas.some((v) => v.includes('area_lobby')), JSON.stringify(searchedAreas));
  const media = world.log.filter((q) => q.table === 'account_media');
  eq('H5 ONE media read across the first page and the winners', media.length, 1);
}
{
  // A building with fewer submissions than a page has nothing past the page: one read, as before.
  seed();
  world.tables.checklist_results = [structuredClone(monthlyRow)];
  const r = await areaStatus('st_hq');
  eq('H5 a short history is one checklist read', world.log.filter((q) => q.table === 'checklist_results').length, 1);
  eq('H5 …and still answers', rowFor(r, 'area_carpet')?.lastCleanedAt, iso(MONTHLY_DONE));
}

if (fails.length) { console.error('\narea-status-history FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\narea-status-history: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
