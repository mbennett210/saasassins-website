// EVERY customer surface reads a "not completed" task as NOT DONE — the list, the Home tile, the
// visit page and the history agree with the checklist's own page (Matt, 2026-10-13, D2 of
// docs/plans/2026-10-13-cleaner-hub.md; UI_RULES §166).
//
// WHY. A task the cleaner marks "not completed" with a reason counts toward the STORED
// `completed_count` — it is what unlocks their clock-out — so a checklist with one such task is
// stored 9/9. The customer's checklist page already reads it as 8/9 and not complete
// (clientHubView.projectHubChecklist), but the hub's LIST row, its Home tile, its visit timeline
// and its history read only the stored counts, so the same clean said "9 of 9 · complete" one tap
// away from "8 of 9 done · 1 not done". This holds every one of them to the page, and holds that
// neither the reason (the cleaner's note to the office) nor the items ever leave in any of them.
//
// Proven twice: the pure projections (the demo's hub runs the same functions over rows that
// carry their items), and the REAL /api/hub handler over fake-supabase.mjs (no network, no
// credentials): checklists, home, visit, history and the checklist page itself.
//
// REGRESSION (THE LAW II.3): on e648f93c (before the fix) the list row, the tile, the visit step
// and the history line all read 9/9 — see the builder's report for the failing count.
//
//   node app/scripts/test-hub-not-completed.mjs
const ORG = '00000000-0000-0000-0000-00000000d2a1';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

// 🔴 THE SUITE'S CLOCK IS THE ROUTE'S CLOCK, PINNED AT MIDDAY ON THE ORG'S (CS-859). "Today's
// tally" is the org's day (the company's zone below) as the route reads it from `new Date()`, and the
// fixture's checklist was saved 20 minutes before now — so for the first 20 minutes after midnight
// Eastern it was yesterday's, and P9 / R11 went red every night, on any machine and in CI. The whole
// run reads 2 PM Eastern today: `new Date()` / `Date.now()` are frozen there; an explicit date
// (`new Date(x)`, `Date.parse`, `Date.UTC`) is unchanged.
{
  const { composeIso, dayKey } = await import('../src/lib/dates.js');
  const SUITE_TZ = 'America/New_York'; // state.company.timezone in seed() below
  const NOW = Date.parse(composeIso(dayKey(new Date(), SUITE_TZ), '14:00', SUITE_TZ));
  const RealDate = Date;
  globalThis.Date = class SuiteDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
  };
}

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const cc = await import('../src/lib/checklistCount.js');
const view = await import('../src/lib/clientHubView.js');
const home = await import('../src/lib/hubHome.js');
const visit = await import('../src/lib/hubVisit.js');
const act = await import('../src/lib/activityLog.js');
const reads = await import('../api/_lib/clientHub/reads.js');
const hub = (await import('../api/hub/[...path].js')).default;

let pass = 0;
const fails = [];
// ok(label, cond, detail) — cond may be a function; a throw is a failure, never a crash.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const sameKeys = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).sort().join(',') === [...list].sort().join(',');

// ── the fixture: a nine-task checklist, eight ticked, one "not completed" with a reason ──────
const H = 3600000;
const DAY = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const REASON = 'ZZREASONZZ supply closet locked, no key';
const KEYS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
const SCHEMA = { areas: [
  { id: 'a_lobby', label: 'Lobby', items: KEYS.slice(0, 5).map((id) => ({ id, label: `Task ${id}` })) },
  { id: 'a_rest', label: 'Restrooms', items: KEYS.slice(5).map((id) => ({ id, label: `Task ${id}` })) },
] };
const NC_KEY = 't9';
const ITEMS = KEYS.map((key) => (key === NC_KEY
  ? { key, label: key, checked: false, na: false, note: null, notCompleted: true, notCompletedReason: REASON }
  : { key, label: key, checked: true, na: false, note: null }));
const STORED = cc.countChecklistSubmission(SCHEMA, ITEMS);
ok('the fixture is STORED 9/9 (the not-completed task unlocked the clock-out)', STORED.completed_count === 9 && STORED.total_count === 9, JSON.stringify(STORED));
const TICKED = KEYS.map((key) => ({ key, label: key, checked: true, na: false, note: null }));

const CR_NC = 'd0000000-0000-4000-8000-0000000000d1';    // today, on the visit, one not completed
const CR_OK = 'd0000000-0000-4000-8000-0000000000d2';    // three days ago, every task ticked
const row = (id, items, performedAgo, extra = {}) => ({
  id, organization_id: ORG, template_id: 'it_n', template_version_id: 'iv_n',
  template_snapshot: { name: 'Nightly', kind: 'checklist', schema: SCHEMA }, client_id: 'cl_a', site_id: 's_a',
  job_id: 'j_a_today', completed_by_user_id: 'u_crew', items, ...cc.countChecklistSubmission(SCHEMA, items),
  client_submit_id: `cs_${id.slice(-2)}`, area_completions: null, performed_at: ago(performedAgo), ...extra,
});
const NC_ROW = row(CR_NC, ITEMS, 20 * 60000);
const OK_ROW = row(CR_OK, TICKED, 3 * DAY, { job_id: null });
const noLeak = (label, obj) => {
  const blob = JSON.stringify(obj ?? null);
  ok(`🔴 ${label}: neither the reason nor the items leave`, () => !blob.includes('ZZREASONZZ') && !/notCompleted|"items"\s*:\s*\[\s*\{\s*"key"/i.test(blob), blob.slice(0, 200));
};

// ── 1. the pure projections (the demo's hub runs these over rows that carry their items) ──────
{
  const r = view.projectHubChecklistRow(NC_ROW, { cleanerName: 'Tomas Rivera' });
  ok('P1 the LIST row reads 8 of 9, not 9 of 9', () => r.done === 8 && r.total === 9, JSON.stringify(r));
  ok('P2 …and not complete', () => r.complete === false, JSON.stringify(r));
  ok('P3 …with exactly the row allowlist', () => sameKeys(r, view.HUB_CHECKLIST_ROW_FIELDS), JSON.stringify(r && Object.keys(r)));
  noLeak('P4 the list row', r);
  const page = view.projectHubChecklist(NC_ROW, { cleanerName: 'Tomas Rivera' });
  ok('P5 the list row agrees with the checklist\'s own page', () => page.done === r.done && page.total === r.total && page.complete === r.complete, `${page.done}/${page.total} ${page.complete}`);
  const all = view.projectHubChecklistRow(OK_ROW, { cleanerName: 'Tomas Rivera' });
  ok('P6 a checklist with every task ticked still reads 9 of 9, complete (control)', () => all.done === 9 && all.total === 9 && all.complete === true, JSON.stringify(all));
  const narrow = { ...NC_ROW }; delete narrow.items;
  const n = view.projectHubChecklistRow(narrow, {});
  ok('P7 a row that carries no items is read at its stored counts (nothing to subtract, nothing invented)', () => n.done === 9 && n.total === 9, JSON.stringify(n));

  const tile = home.hubChecklistTile([NC_ROW, OK_ROW], { now: Date.now(), tz: 'America/New_York' });
  ok('P8 the Home tile\'s last checklist reads 8 of 9', () => tile.last?.done === 8 && tile.last?.total === 9, JSON.stringify(tile));
  ok('P9 …and today\'s tally too', () => tile.today?.done === 8 && tile.today?.total === 9, JSON.stringify(tile));
  noLeak('P10 the Home tile', tile);

  const startAt = ago(70 * 60000);
  const status = visit.hubVisitStatus({
    jobs: [{ id: 'j_a_today', start_at: startAt, status: 'in_progress', client_id: 'cl_a', end_at: ago(-60 * 60000), crew_ids: ['u_crew'] }],
    punches: [{ id: 'te1', user_id: 'u_crew', user_name: 'Tomas Rivera', clock_in_at: ago(68 * 60000), clock_out_at: null, status: 'in_progress', job_id: 'j_a_today' }],
    checklists: [NC_ROW], client: { id: 'cl_a', crewChecklists: { u_crew: 'it_n' } }, now: Date.now(), tz: 'America/New_York',
  });
  const step = (status.timeline || []).find((s) => s.key === 'checklist_complete');
  ok('P11 the visit\'s checklist step reads 8 of 9', () => step && step.done === 8 && step.total === 9, JSON.stringify(status.timeline));
  noLeak('P12 the visit status', status);

  const events = act.selectServiceEvents({ checklists: [NC_ROW] });
  const ev = events.find((e) => e.kind === 'checklist');
  ok('P13 the history line reads "8/9 items"', () => ev?.detail === '8/9 items', JSON.stringify(ev));
  noLeak('P14 the history event, as served', view.projectHubEvent(ev));
}

// ── 2. the REAL /api/hub handler ─────────────────────────────────────────────
const CU1 = 'a0000000-0000-4000-8000-0000000000d1';
function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [
            { id: 'u_mgr', role: 'manager', name: 'Renata Cruz', status: 'active', email: 'u_mgr@example.test' },
            { id: 'u_crew', role: 'crew', name: 'Tomas Rivera', status: 'active', email: 'u_crew@example.test' },
          ],
          clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr', crewChecklists: { u_crew: 'it_n' } }],
          sites: [{ id: 's_a', clientId: 'cl_a', name: 'Clubhouse', address: '120 Royal Palm Way' }],
          permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
        },
      }],
      crew_assignments: [],
      client_users: [{ id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1' }],
      client_user_groups: [],
      client_user_group_members: [],
      client_user_assignments: [{ id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null }],
      jobs: [{ id: 'j_a_today', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', status: 'in_progress', start_at: ago(70 * 60000),
        data: { id: 'j_a_today', clientId: 'cl_a', startAt: ago(70 * 60000), endAt: ago(-60 * 60000), crewIds: ['u_crew'] } }],
      time_entries: [{ id: 'te1', organization_id: ORG, client_id: 'cl_a', site_id: 's_a', user_id: 'u_crew', user_name: 'Tomas Rivera', job_id: 'j_a_today',
        clock_in_at: ago(68 * 60000), clock_out_at: null, status: 'in_progress', geofence_result: 'inside' }],
      checklist_results: [NC_ROW, OK_ROW],
      account_media: [],
      inspection_records: [],
      inspection_items: [],
      problem_reports: [],
      work_order_messages: [],
      activity_log: [],
      inbox_accounts: [],
    },
    logins: { 'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } } },
  });
  world.rpc = (name) => (name === 'hub_next_visits' ? { data: [], error: null } : { data: null, error: { message: `no function ${name}`, code: 'PGRST202' } });
}
async function get(p) {
  const [sub, qs] = p.split('?');
  const req = { method: 'GET', headers: { authorization: 'Bearer tok-client' }, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(hub(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}

seed();
{
  const r = await get('checklists?buildingId=cl_a');
  const nc = (r.body?.rows || []).find((x) => x.id === CR_NC);
  const all = (r.body?.rows || []).find((x) => x.id === CR_OK);
  ok('R1 the list answers', () => r.status === 200, `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  ok('R2 🔴 the LIST row of a 9/9 stored checklist with one not-completed task reads 8/9', () => nc?.done === 8 && nc?.total === 9, JSON.stringify(nc));
  ok('R3 …and not complete', () => nc?.complete === false, JSON.stringify(nc));
  ok('R4 …while the all-ticked one still reads 9/9, complete', () => all?.done === 9 && all?.complete === true, JSON.stringify(all));
  ok('R5 every row is exactly the row allowlist', () => (r.body?.rows || []).every((x) => sameKeys(x, view.HUB_CHECKLIST_ROW_FIELDS)));
  noLeak('R6 the list', r.body);
  const d = await get(`checklist?buildingId=cl_a&id=${CR_NC}`);
  ok('R7 the list row agrees with the checklist\'s own page', () => d.body?.checklist?.done === nc?.done && d.body?.checklist?.complete === nc?.complete, JSON.stringify(d.body?.checklist && { done: d.body.checklist.done, complete: d.body.checklist.complete }));
  ok('R8 🔴 the page never carries the reason', () => !JSON.stringify(d.body).includes('ZZREASONZZ'));
}
{
  const r = await get('home?buildingId=cl_a');
  const t = r.body?.checklists;
  ok('R9 the Home tile answers', () => r.status === 200, `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  ok('R10 🔴 the Home tile\'s last checklist reads 8/9', () => t?.last?.done === 8 && t?.last?.total === 9, JSON.stringify(t));
  ok('R11 …and today\'s tally 8/9', () => t?.today?.done === 8 && t?.today?.total === 9, JSON.stringify(t));
  noLeak('R12 Home', r.body);
}
{
  const r = await get('visit?buildingId=cl_a');
  const step = (r.body?.timeline || r.body?.status?.timeline || []).find((s) => s.key === 'checklist_complete');
  ok('R13 the visit answers', () => r.status === 200, `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  ok('R14 🔴 the visit\'s checklist step reads 8/9', () => step?.done === 8 && step?.total === 9, JSON.stringify(r.body)?.slice(0, 600));
  noLeak('R15 the visit', r.body);
}
{
  const r = await get('history?buildingId=cl_a');
  const lines = (r.body?.events || []).filter((e) => e.kind === 'checklist').map((e) => e.detail);
  ok('R16 the history answers', () => r.status === 200, `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  ok('R17 🔴 the history line for it reads "8/9 items" (and the all-ticked one "9/9 items")', () => lines.includes('8/9 items') && lines.includes('9/9 items'), JSON.stringify(lines));
  ok('R18 every event is exactly the event allowlist', () => (r.body?.events || []).every((e) => sameKeys(e, view.HUB_EVENT_FIELDS)), JSON.stringify(r.body?.events?.[0]));
  noLeak('R19 the history', r.body);
}

// ── 3. the reads that feed them are bounded ──────────────────────────────────
{
  ok('B1 the list, visit and Home reads carry the items (each is a bounded read)',
    () => [reads.HUB_CHECKLIST_ROW_COLUMNS, reads.HUB_VISIT_CHECKLIST_COLUMNS, reads.HUB_TILE_CHECKLIST_COLUMNS].every((c) => String(c).split(',').includes('items')));
  ok('B2 the history reads items ONLY for the checklists on the page it serves, by id',
    () => typeof reads.checklistItemsByIds === 'function');
  seed();
  world.log.length = 0;
  await get('history?buildingId=cl_a&limit=1');
  const byId = world.log.filter((q) => q.table === 'checklist_results' && q.in && q.in.id);
  ok('B3 …a page of one asks for at most one checklist\'s items', () => byId.length <= 1 && byId.every((q) => (q.in.id || []).length <= 1), JSON.stringify(byId.map((q) => q.in)));
}

if (fails.length) { console.error('\nhub-not-completed FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nhub-not-completed: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
