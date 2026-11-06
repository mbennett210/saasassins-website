// CS-677 — a cleaner's cleans are read through an index, over the jobs window, never all history.
//
// THE BUG. Nothing indexed a cleaner's cleans. api/_lib/jobsTable getCrewJobs filtered
// `data @> {"crewIds":[id]}` over EVERY clean ever (its own comment said "a sequential scan"),
// and it runs on every crew state refresh (/api/state/view at boot, on each org_state signal,
// refocus, reconnect, the backstop), on every crew save (the merge's scope) and in the QC and
// supplies routes. At Matt's size that is thousands of full-table scans at shift start on a
// 60-connection database with an 8 s statement timeout.
//
// THE FIX. getCrewJobRows filters the EXPRESSION `data->'crewIds'` (`@>` a one-element array),
// which the GIN index jobs_crew_ids_gin serves (migration 20261013120000, proved by EXPLAIN),
// over the jobs WINDOW only (src/lib/jobsWindow.js: a cleaner needs their recent and upcoming
// cleans, not all history) — keyset pages, never OFFSET. GET /api/state/view?part=jobs hands a
// crew phone its own window of cleans and the table's high-water row version (its poll's floor),
// so the phone never reads the window under RLS.
//
// HOW. The real api/_lib/jobsTable.js and api/state/view.js through scripts/fake-supabase.mjs.
//
//   node app/scripts/test-crew-jobs-window.mjs
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { JOBS_WINDOW_BACK_DAYS, JOBS_WINDOW_FORWARD_DAYS } from '../src/lib/jobsWindow.js';

const ORG = '00000000-0000-0000-0000-000000000677';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const jobsTable = await import('../api/_lib/jobsTable.js');
const view = (await import('../api/state/view.js')).default;
const { seedPermissions } = await import('../src/lib/roles.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const DAY = 86400000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();
const job = (id, days, crewIds, rv) => ({
  id, organization_id: ORG, start_at: at(days), row_version: rv, client_id: 'c1', site_id: 's1',
  data: { id, clientId: 'c1', siteId: 's1', startAt: at(days), crewIds, status: days < 0 ? 'done' : 'upcoming' },
});
const rows = [
  job('j_old', -(JOBS_WINDOW_BACK_DAYS + 30), ['u_crew'], 10),   // history: outside the window
  job('j_recent', -3, ['u_crew'], 11),                          // inside
  job('j_next', 5, ['u_crew', 'u_other'], 12),                  // inside, shared
  job('j_far', JOBS_WINDOW_FORWARD_DAYS + 20, ['u_crew'], 13),  // beyond the window ahead
  job('j_theirs', 2, ['u_other'], 14),                          // someone else's
  job('j_newest', 1, ['u_other'], 99),                          // the table's high-water
];
const state = {
  version: 3, company: { id: 'co', timezone: 'America/New_York' },
  users: [
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl Crew', email: 'crew@example.test' },
    { id: 'u_other', role: 'crew', status: 'active', name: 'Olga', email: 'other@example.test' },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona', email: 'mgr@example.test' },
  ],
  clients: [{ id: 'c1', name: 'Acme' }], sites: [{ id: 's1', clientId: 'c1', name: 'Acme' }],
  permissions: seedPermissions(), userPermissionOverrides: [],
};
const logins = {
  'tok-crew': { id: 'a-crew', email: 'crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
  'tok-mgr': { id: 'a-mgr', email: 'mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
};
const seed = () => resetWorld({
  tables: { org_state: [{ organization_id: ORG, version: 3, state, min_client_build: null, freeze_strip: [] }], jobs: rows, crew_assignments: [] },
  logins,
});

// ── 1. getCrewJobs: the window, by the indexed expression ─────────────────────────────────
seed();
{
  const got = (await jobsTable.getCrewJobs('u_crew')).map((j) => j.id).sort();
  ok(`1.1 🔴 a cleaner's cleans are the ones in the jobs window: ${got.join(',')}`, got.join(',') === 'j_next,j_recent');
  ok('1.2 🔴 never their history (45+ days back) or the far tail', !got.includes('j_old') && !got.includes('j_far'));
  ok('1.3 and never someone else\'s', !got.includes('j_theirs'));
  const reads = world.log.filter((q) => q.table === 'jobs' && q.op === 'select');
  const filtersSeen = reads.flatMap((q) => q.ops || []);
  const offsetsSeen = reads.map((q) => q.offset || 0);
  ok('1.4 🔴 it filters the crew list as the expression `data->crewIds` (what jobs_crew_ids_gin indexes), not `data`',
    callable(jobsTable.getCrewJobRows) && filtersSeen.some((f) => f.op === 'contains' && f.col === 'data->crewIds'), JSON.stringify(filtersSeen));
  ok('1.5 and bounds start_at to the window', filtersSeen.some((f) => f.op === 'gte' && f.col === 'start_at') && filtersSeen.some((f) => f.op === 'lt' && f.col === 'start_at'));
  ok('1.6 🔴 keyset, never OFFSET', offsetsSeen.every((o) => o === 0), `offsets ${offsetsSeen.join(',')}`);
  ok(`1.7 one read for a cleaner's ~handful of cleans (${reads.length})`, reads.length === 1);
}

// ── 2. the high-water mark: the newest row_version, NULLs ignored ─────────────────────────
seed();
{
  world.tables.jobs.push({ ...job('j_null', 3, ['u_x'], null), row_version: null });
  ok('2.1 the table\'s high-water row version', callable(jobsTable.getJobsHighWater) && (await jobsTable.getJobsHighWater()) === 99);
}

// ── 3. GET /api/state/view?part=jobs: the caller's own window, for a crew launch ──────────
const call = async (token, query = {}) => {
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; },
    setHeader() { return res; }, end() { return res; },
  };
  await view({ method: 'GET', headers: { authorization: `Bearer ${token}` }, query }, res);
  return out;
};
seed();
{
  const r = await call('tok-crew', { part: 'jobs' });
  const ids = (r.body?.jobs || []).map((x) => x?.data?.id).sort();
  ok(`3.1 🔴 a cleaner gets their own window of cleans: ${ids.join(',')}`, r.status === 200 && ids.join(',') === 'j_next,j_recent', `status ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`);
  ok('3.2 each with its row version (the phone\'s order guard)', (r.body?.jobs || []).every((x) => Number.isFinite(x?.row_version)));
  ok('3.3 the table\'s high-water (the phone\'s poll floor) — read across every row, not only theirs', r.body?.highWater === 99);
  ok('3.4 and the window it read', Number.isFinite(Date.parse(r.body?.from)) && Number.isFinite(Date.parse(r.body?.to))
    && Math.abs(Date.parse(r.body.to) - Date.parse(r.body.from) - (JOBS_WINDOW_BACK_DAYS + JOBS_WINDOW_FORWARD_DAYS) * DAY) < 60000);
  ok('3.5 no projection rides along (only the cleans)', r.body && !('state' in r.body));
  const m = await call('tok-mgr', { part: 'jobs' });
  ok('3.6 an office login gets only its OWN cleans too (none here) — never more than RLS shows it', m.status === 200 && (m.body?.jobs || []).length === 0);
  const plain = await call('tok-crew');
  ok('3.7 the plain view (the projection) is unchanged', plain.status === 200 && plain.body?.projection === 'crew' && plain.body?.state);
  const anon = await call('nope', { part: 'jobs' });
  ok('3.8 no session: 401', anon.status === 401, `status ${anon.status}`);
}

console.log(`\ncrew jobs window: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exitCode = 1; }

// ── helpers (hoisted) ────────────────────────────────────────────────────────────────────
function callable(fn) { return typeof fn === 'function'; }
