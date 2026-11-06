// CS-676 / CS-677 — a launch reads the jobs WINDOW, never the whole history.
//
// THE BUG. public.jobs keeps every clean ever done (~16,000 a month at Matt's book, nothing
// pruned), and every office launch downloaded ALL of it: store/jobsSync.js fetchAllJobs paged
// the whole table by OFFSET (250 rows a page, a count first), because the jobs cache is always
// stamped `windowed` and bootFromCache then always ran the full backfill. At go-live that is
// ~48,000 rows; it grows by ~16,000 a month, and OFFSET makes each page re-read everything
// before it. A crew phone did the same under RLS — a scan of the whole table per launch,
// because nothing indexes a cleaner's cleans.
//
// THE FIX (src/store/sync.js, src/store/jobsSync.js, src/lib/jobsWindow.js):
//   · a launch loads the cleans that start inside the window (45 days back, 100 ahead) and
//     the office also loads each series' master (the template TOP_UP mints from) — nothing
//     else; pages are keyset (start_at, id), never OFFSET;
//   · anything else is fetched when a screen needs it: a date range (a past week on the
//     Schedule) or one series by its id (a whole-series edit needs every occurrence of THAT
//     series, not every job);
//   · a cleaner's phone takes its own window of cleans from GET /api/state/view?part=jobs,
//     which the server reads by an index on the crew list (service role), not under RLS.
//
// HOW. The REAL sync engine against the REAL save routes (scripts/sync-harness.mjs), over a
// table with 400 days of history. Every jobs read the browser makes is recorded: its rows,
// and any OFFSET it used.
//
//   node app/scripts/test-jobs-window-scale.mjs
import { createSyncHarness } from './sync-harness.mjs';
import { JOBS_WINDOW_BACK_DAYS, JOBS_WINDOW_FORWARD_DAYS } from '../src/lib/jobsWindow.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const watchdog = setTimeout(() => { console.error('test-jobs-window-scale: timed out'); process.exit(1); }, 120000);
watchdog.unref();

const h = await createSyncHarness();
const { seedPermissions } = await import('../src/lib/roles.js');
const { productionInitialState } = await import('../src/data/seed.js');
const { ACTIONS } = await import('../src/store/reducer.js');

const ORG = '00000000-0000-0000-0000-000000000001';
const DAY = 86400000;
const NOW = Date.now();
const WIN_FROM = NOW - JOBS_WINDOW_BACK_DAYS * DAY;
const WIN_TO = NOW + JOBS_WINDOW_FORWARD_DAYS * DAY;
const iso = (ms) => new Date(ms).toISOString();
const LOGINS = {
  'tok-mgr': { id: 'a-mgr', email: 'mgr@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
  'tok-crew': { id: 'a-crew', email: 'crew@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
};
const SERIES = 12;
const clients = Array.from({ length: SERIES }, (_, i) => ({ id: `c${i}`, name: `Building ${i}`, type: 'customer', standingCrewIds: [] }));
const sites = clients.map((c, i) => ({ id: `s${i}`, clientId: c.id, name: c.name, standingCrewIds: [] }));
const baseState = () => ({
  ...productionInitialState(),
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  users: [
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona Manager', email: 'mgr@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0002' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl Crew', email: 'crew@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0003' } },
    { id: 'u_other', role: 'crew', status: 'active', name: 'Olga Other', email: 'other@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0004' } },
  ],
  clients,
  sites,
  jobs: [],
});

// 12 never-ending weekly series, two cleans a week, from 400 days ago to the 90-day horizon;
// series 0 was once extended to +200 days (extend-on-navigate). Carl cleans series 0-2.
// Each series' first clean is its master (it carries `recurrence`).
const jobs = [];
for (let s = 0; s < SERIES; s += 1) {
  const until = NOW + (s === 0 ? 200 : 90) * DAY;
  let first = true;
  for (let t = NOW - 400 * DAY + s * 3600000; t < until; t += 3.5 * DAY) {
    const id = `j_${s}_${Math.round(t / 1000)}`;
    jobs.push({
      id, clientId: `c${s}`, siteId: `s${s}`, serviceId: 'svc', seriesId: `ser_${s}`,
      startAt: iso(t), endAt: iso(t + 3 * 3600000),
      status: t < NOW ? 'done' : 'upcoming',
      crewIds: [s < 3 ? 'u_crew' : 'u_other'], notes: '', tagIds: [],
      recurrence: first ? { frequency: 'weekly', interval: 1, endType: 'never', daysOfWeek: [1, 4] } : null,
    });
    first = false;
  }
}
const at = (j) => Date.parse(j.startAt);
const inWindow = (j) => at(j) >= WIN_FROM && at(j) < WIN_TO;
const windowIds = new Set(jobs.filter(inWindow).map((j) => j.id));
const masterIds = new Set(jobs.filter((j) => j.recurrence).map((j) => j.id));
const crewWindowIds = new Set(jobs.filter((j) => inWindow(j) && j.crewIds.includes('u_crew')).map((j) => j.id));
const history = jobs.filter((j) => at(j) < WIN_FROM).length;
ok(`fixture: most of the table is history (${history} of ${jobs.length} before the window)`, history > jobs.length / 2);

// ── every jobs read the BROWSER makes: the rows it carried, and any OFFSET ────────────────
let reads = [];
const realFrom = h.browserClient.from.bind(h.browserClient);
h.browserClient.from = (table) => {
  const q = realFrom(table);
  if (table !== 'jobs') return q;
  const rec = { offsets: [], ids: [] };
  const range = q.range.bind(q);
  q.range = (a, b) => { rec.offsets.push(a); return range(a, b); };
  const then = q.then.bind(q);
  q.then = (onOk, onErr) => then((res) => {
    rec.desc = q.descriptor();
    for (const r of res?.data || []) rec.ids.push(r?.data?.id || r?.id);
    reads.push(rec);
    return onOk ? onOk(res) : res;
  }, onErr);
  return q;
};
const downloaded = () => reads.flatMap((r) => r.ids).filter(Boolean);
const tableRow = (id) => h.world.tables.jobs.find((r) => r.id === id);
const callable = (fn) => typeof fn === 'function';

// ── 1. An office launch reads the window and the series masters, nothing else ───────────
h.seedOrg(baseState(), { logins: LOGINS, jobs });
reads = [];
const mgr = await h.bootTab('tok-mgr');
await h.advance(100);
{
  const held = new Set((mgr.state().jobs || []).map((j) => j.id));
  const got = downloaded();
  const outside = got.filter((id) => !windowIds.has(id) && !masterIds.has(id));
  ok('1.1 the launch holds every clean in the window', [...windowIds].every((id) => held.has(id)),
    `${[...windowIds].filter((id) => !held.has(id)).length} window cleans missing`);
  ok('1.2 and every series master (TOP_UP mints from it)', [...masterIds].every((id) => held.has(id)));
  ok(`1.3 🔴 nothing outside the window was downloaded but the masters (${outside.length} rows; the table holds ${history} of history)`,
    outside.length === 0, `e.g. ${outside.slice(0, 3).join(', ')}`);
  ok(`1.4 the launch downloaded about the window, not the table (${got.length} rows of ${jobs.length})`,
    got.length <= windowIds.size + masterIds.size + 10);
  const offsets = reads.flatMap((r) => r.offsets).filter((o) => o > 0);
  ok('1.5 🔴 no read pages by OFFSET (keyset only)', offsets.length === 0, `offsets used: ${offsets.slice(0, 5).join(', ')}`);
  ok('1.6 the save path is armed once the window landed (jobs ready)', mgr.jobsReady === true);
}

// ── 2. A save of a window clean still lands ───────────────────────────────────────────────
{
  const target = [...windowIds].find((id) => tableRow(id)?.data?.status === 'upcoming');
  mgr.dispatchLocal({ type: ACTIONS.UPDATE_JOB, id: target, patch: { notes: 'bring the ladder' } });
  await h.advance(700);
  ok('2.1 an edit to a window clean reaches the table', tableRow(target)?.data?.notes === 'bring the ladder');
}

// ── 3. A past week, on demand: that week and nothing else ─────────────────────────────────
{
  reads = [];
  const from = NOW - 200 * DAY;
  const to = from + 7 * DAY;
  const weekIds = jobs.filter((j) => at(j) >= from && at(j) < to).map((j) => j.id);
  let threw = null;
  try { await mgr.mgr.ensureJobsRange(from, to); } catch (e) { threw = e; }
  await h.advance(50);
  ok('3.0 the sync manager can fetch a date range on demand', callable(mgr.mgr.ensureJobsRange) && !threw, threw?.message);
  const held = new Set((mgr.state().jobs || []).map((j) => j.id));
  ok(`3.1 the tab now holds that week's cleans (${weekIds.length})`, weekIds.length > 0 && weekIds.every((id) => held.has(id)));
  const got = downloaded();
  ok(`3.2 🔴 the fetch carried only that week (${got.length} rows)`, got.length > 0 && got.every((id) => weekIds.includes(id) || masterIds.has(id)),
    `outside: ${got.filter((id) => !weekIds.includes(id)).slice(0, 3).join(', ')}`);
}

// ── 4. A whole-series edit reads ITS series by id and reaches every future occurrence ──────
{
  reads = [];
  const sid = 'ser_0';
  const seriesIds = jobs.filter((j) => j.seriesId === sid).map((j) => j.id);
  let threw = null;
  try { await mgr.mgr.ensureSeries(sid); } catch (e) { threw = e; }
  await h.advance(50);
  ok('4.0 the sync manager can fetch one series on demand', callable(mgr.mgr.ensureSeries) && !threw, threw?.message);
  const got = downloaded();
  ok(`4.1 🔴 the fetch carried only that series (${got.length} rows, never the table)`,
    got.length > 0 && got.every((id) => seriesIds.includes(id)), `others: ${got.filter((id) => !seriesIds.includes(id)).slice(0, 3).join(', ')}`);
  ok('4.2 it asked by series id', reads.some((r) => r.desc?.eq?.series_id === sid));
  const held = new Set((mgr.state().jobs || []).map((j) => j.id));
  ok('4.3 the tab holds every occurrence of the series, the +200-day tail included', seriesIds.every((id) => held.has(id)));
  const anchor = jobs.find((j) => j.seriesId === sid && j.status === 'upcoming');
  mgr.dispatchLocal({ type: ACTIONS.UPDATE_JOB_SERIES, seriesId: sid, fromDate: anchor.startAt, anchorId: anchor.id, patch: { notes: 'new gate code' } });
  await h.advance(700);
  await h.advance(700);
  const future = h.world.tables.jobs.filter((r) => r.data?.seriesId === sid && r.data?.status === 'upcoming');
  const beyond = future.filter((r) => Date.parse(r.data.startAt) >= WIN_TO);
  ok(`4.4 🔴 every future occurrence took the edit, ${beyond.length} beyond the window included`,
    beyond.length > 0 && future.every((r) => r.data.notes === 'new gate code'),
    `${future.filter((r) => r.data.notes !== 'new gate code').length} of ${future.length} missed`);
  ok('4.5 no other series changed', h.world.tables.jobs.filter((r) => r.data?.seriesId !== sid).every((r) => r.data.notes === '' || r.data.notes === 'bring the ladder'));
}

// ── 5. TOP_UP after a windowed launch mints no duplicates ─────────────────────────────────
{
  const horizonTo = NOW + 140 * DAY;
  try { await mgr.mgr.ensureJobsRange(NOW, horizonTo); } catch { /* counted by 3.0 */ }
  mgr.dispatchLocal({ type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: NOW + 120 * DAY });
  await h.advance(700);
  await h.advance(700);
  const slots = new Map();
  for (const r of h.world.tables.jobs) {
    if (!r.data?.seriesId) continue;
    const k = `${r.data.seriesId}|${r.data.startAt}`;
    slots.set(k, (slots.get(k) || 0) + 1);
  }
  ok('5.1 every (series, start) slot holds one clean', [...slots.values()].every((n) => n === 1),
    `${[...slots.values()].filter((n) => n > 1).length} duplicated slots`);
  const minted = h.world.tables.jobs.filter((r) => r.data?.seriesId === 'ser_5' && Date.parse(r.data.startAt) > NOW + 90 * DAY);
  ok('5.2 TOP_UP still extends a series whose master is a year old', minted.length > 0);
}
mgr.stop();
h.clearTimers();

// ── 6. A cleaner's launch: its own window, from the server, nothing read under RLS ────────
h.seedOrg(baseState(), { logins: LOGINS, jobs });
reads = [];
const crew = await h.bootTab('tok-crew');
await h.advance(100);
{
  const held = new Set((crew.state().jobs || []).map((j) => j.id));
  ok(`6.1 the cleaner holds their own window cleans (${crewWindowIds.size})`, [...crewWindowIds].every((id) => held.has(id)),
    `${[...crewWindowIds].filter((id) => !held.has(id)).length} missing`);
  ok('6.2 and nobody else\'s', [...held].every((id) => crewWindowIds.has(id)), `${[...held].filter((id) => !crewWindowIds.has(id)).length} extra`);
  ok(`6.3 🔴 the launch read no jobs rows through the browser client (an RLS scan of the table): ${downloaded().length}`, downloaded().length === 0);
  ok('6.4 it asked the server for its cleans', h.requests.some((r) => r.path === '/api/state/view'));
  ok('6.5 the cleaner\'s phone is ready', crew.jobsReady === true);
}
crew.stop();
h.clearTimers();

// console.log, not console.error: the harness keeps console.error for the server's alerts.
console.log(`\njobs window at scale: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exitCode = 1; }
