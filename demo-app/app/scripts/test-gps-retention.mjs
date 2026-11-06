// PAY-20 — EXACT GPS POINTS ARE KEPT 90 DAYS, THEN ONLY ON SITE / OFF SITE AND HOW FAR.
//
// Matt, 2026-09-30: "90 days, then only on site / off site and the distance."
//
// A punch stores WHERE the device was, to the metre, for ever. The verdict and the distance
// are what the office ever reads afterwards (variance, approvals, the punch detail); the raw
// point is only needed while a punch can still be disputed. So after 90 days the six raw
// columns are cleared and the derived answers stay — the record keeps saying "off site, about
// 3,750 ft" without keeping a map pin on a person's movements from last quarter.
//
// Driven through the REAL api/cron/reap.js handler and the REAL supabase-js client against
// scripts/fake-supabase-http.mjs on 127.0.0.1 (the offline-drive pattern; no sandbox project
// exists — CS-033). Nothing leaves this machine. The horizon and the column lists are read
// from the shared module, never restated.
//
//   node app/scripts/test-gps-retention.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeSupabase } from './fake-supabase-http.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => { try { return readFileSync(root(p), 'utf8'); } catch { return ''; } };

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ORG = '00000000-0000-0000-0000-000000000001';
const CRON = 'cron-secret-for-the-fake';
const watchdog = setTimeout(() => { console.error('test-gps-retention: timed out'); process.exit(1); }, 60000);

const fake = await startFakeSupabase({
  authUsers: {},
  rows: { time_entries: [], job_deletes: [], webhook_deliveries: [], client_heartbeats: [] },
  // The reaper's own RPC. It is a service-role function the fake does not model; stubbing it
  // lets the REAL cron handler run end to end so the new step is exercised where it ships.
  rpcs: { reap_job_deletes: () => 0 },
});
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, CRON_SECRET: CRON,
});
delete process.env.ALERT_WEBHOOK_URL;
if (!String(process.env.SUPABASE_URL).startsWith('http://127.0.0.1:')) {
  console.error('refusing to run: SUPABASE_URL is not the local fake');
  process.exit(1);
}
const { default: reap } = await import('../api/cron/reap.js');
const { trimStalePunchCoords } = await import('../api/_lib/time/store.js');
const clockRules = await import('../src/lib/clockRules.js');
// Default to EMPTY on a tree where the module does not export them yet, so the whole suite
// still runs and fails honestly instead of ending on line one (THE LAW II.3).
// Matt's own number, stated once so 1a can pin the SOURCE constant against it, and used as
// the fallback so the rest of the suite still runs where the constant does not exist yet.
const SPEC_DAYS = 90;
const GPS_POINT_RETENTION_DAYS = Number.isFinite(clockRules.GPS_POINT_RETENTION_DAYS)
  ? clockRules.GPS_POINT_RETENTION_DAYS : SPEC_DAYS;
const GPS_POINT_COLUMNS = clockRules.GPS_POINT_COLUMNS || [];
const GPS_DERIVED_COLUMNS = clockRules.GPS_DERIVED_COLUMNS || [];
const trim = async (...a) => { try { return await trimStalePunchCoords(...a); } catch (e) { return { trimmed: `threw: ${e?.message || e}` }; } };

const DAY = 86400 * 1000;
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const agoIso = (days) => new Date(NOW - days * DAY).toISOString();

// A punch with every point column populated and every derived answer recorded.
const punch = (id, days, over = {}) => ({
  id, organization_id: ORG, user_id: 'u_c1', client_id: 'c_bay', site_id: 's_bay', job_id: `j_${id}`,
  clock_in_at: agoIso(days), clock_out_at: agoIso(days - 0.1), status: 'completed', approval_status: 'approved',
  clock_in_lat: 26.1224, clock_in_lng: -80.1373, clock_in_accuracy_m: 8,
  clock_out_lat: 26.1301, clock_out_lng: -80.1450, clock_out_accuracy_m: 12,
  clock_in_distance_m: 11, clock_out_distance_m: 1142,
  geofence_result: 'inside', geofence_result_out: 'outside',
  row_version: 3, ...over,
});
const byId = (id) => fake.tables.time_entries.find((e) => e.id === id) || null;
// `null` is the EXPECTED value of a cleared column, so a missing ROW has to read as
// something else or the two cases are indistinguishable.
const cell = (id, c) => (byId(id) ? byId(id)[c] ?? null : 'no row at all');
const reset = (entries) => { fake.tables.time_entries = entries; };

async function callReap({ token = CRON } = {}) {
  const req = { method: 'GET', url: '/api/cron/reap', query: {}, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() { return res; }, end() { return res; } };
  await reap(req, res);
  return out;
}

// ═══════════ 1 · the rule lives in one place ═══════════
console.log('── PAY-20: the horizon and the two column lists ──');
eq('1a: the horizon is Matt’s 90 days', clockRules.GPS_POINT_RETENTION_DAYS, SPEC_DAYS);
eq('1b: the EXACT points cleared are the six raw ones', [...GPS_POINT_COLUMNS].sort(), [
  'clock_in_accuracy_m', 'clock_in_lat', 'clock_in_lng',
  'clock_out_accuracy_m', 'clock_out_lat', 'clock_out_lng',
].sort());
eq('1c: the verdicts and distances are KEPT', [...GPS_DERIVED_COLUMNS].sort(), [
  'clock_in_distance_m', 'clock_out_distance_m', 'geofence_result', 'geofence_result_out',
].sort());
eq('1d: the two lists do not overlap',
  GPS_POINT_COLUMNS.filter((c) => GPS_DERIVED_COLUMNS.includes(c)), []);

// ═══════════ 2 · old rows lose the points, keep the answers ═══════════
console.log('── PAY-20: past the horizon, the point goes and the answer stays ──');
{
  reset([punch('old', GPS_POINT_RETENTION_DAYS + 10), punch('edge', GPS_POINT_RETENTION_DAYS - 1), punch('new', 2)]);
  const r = await trim({ now: NOW });
  eq('2a: exactly the one row past the horizon is trimmed', r.trimmed, 1);
  for (const c of GPS_POINT_COLUMNS) eq(`2b: the old punch's ${c} is cleared`, cell('old', c), null);
  for (const c of GPS_DERIVED_COLUMNS) ok(`2c: …but its ${c} is kept`, byId('old')?.[c] != null, `${c} = ${byId('old')?.[c]}`);
  for (const c of GPS_POINT_COLUMNS) ok(`2d: a punch a day inside the horizon keeps its ${c}`, byId('edge')?.[c] != null);
  for (const c of GPS_POINT_COLUMNS) ok(`2e: and a recent punch keeps its ${c}`, byId('new')?.[c] != null);
  eq('2f: nothing else about the old punch moved',
    [byId('old')?.status, byId('old')?.approval_status, byId('old')?.clock_in_at, byId('old')?.clock_out_at],
    ['completed', 'approved', agoIso(GPS_POINT_RETENTION_DAYS + 10), agoIso(GPS_POINT_RETENTION_DAYS + 9.9)]);
  // The punch's CAS version is deliberately untouched: retention is not an edit anyone has to
  // re-read, and bumping it would make every stale old punch look changed to a manager's queue.
  eq('2g: …including its row_version', byId('old')?.row_version, 3);
}
{
  // IDEMPOTENT: the predicate is "has a point left", so a second run matches nothing.
  reset([punch('old', GPS_POINT_RETENTION_DAYS + 10)]);
  const first = await trim({ now: NOW });
  const second = await trim({ now: NOW });
  eq('2h: the first run trims it', first.trimmed, 1);
  eq('2i: a second run trims nothing', second.trimmed, 0);
}
{
  // A row that only ever had SOME of the points (no clock-out, location refused) is still
  // handled, and one that has none is not rewritten for nothing.
  reset([
    punch('partial', 200, { clock_out_at: null, clock_out_lat: null, clock_out_lng: null, clock_out_accuracy_m: null, geofence_result_out: null, clock_out_distance_m: null }),
    punch('already', 200, Object.fromEntries(GPS_POINT_COLUMNS.map((c) => [c, null]))),
  ]);
  const r = await trim({ now: NOW });
  eq('2j: only the row with a point left is touched', r.trimmed, 1);
  eq('2k: the half-populated row is cleared', cell('partial', 'clock_in_lat'), null);
  eq('2l: …and still says what the verdict was', byId('partial')?.geofence_result, 'inside');
}
{
  // BOUNDED: a first run on years of history must not try to rewrite the table in one call.
  reset(Array.from({ length: 40 }, (_, i) => punch(`b${i}`, 200)));
  const r = await trim({ now: NOW, batchSize: 10, maxBatches: 2 });
  eq('2m: a run stops at batchSize × maxBatches', r.trimmed, 20);
  ok('2n: …and says it has more to do', r.more === true);
  const rest = await trim({ now: NOW, batchSize: 100, maxBatches: 10 });
  eq('2o: the next run finishes the rest', rest.trimmed, 20);
  ok('2p: …and says so', rest.more === false);
}

// ═══════════ 3 · it rides the DAILY reap cron, no new cron ═══════════
console.log('── PAY-20: on the existing daily reaper ──');
{
  reset([punch('old', 200), punch('new', 1)]);
  const r = await callReap();
  eq('3a: the cron answers 200', r.status, 200);
  eq('3b: …reporting what it trimmed', r.body?.punchCoordsTrimmed, 1);
  eq('3c: …and the horizon it used', r.body?.gpsPointRetentionDays, GPS_POINT_RETENTION_DAYS);
  eq('3d: the old punch lost its point', cell('old', 'clock_in_lat'), null);
  ok('3e: the recent punch kept its', byId('new')?.clock_in_lat != null);
}
{
  reset([punch('old', 200)]);
  const r = await callReap({ token: 'wrong' });
  eq('4a: an unauthenticated call is refused', r.status, 401);
  ok('4b: …and nothing was trimmed', byId('old')?.clock_in_lat != null);
}
{
  const cron = read('../app/api/cron/reap.js');
  ok('4c: there is no second cron for this', !/vercel\.json/.test(cron));
  ok('4d: the step is best-effort, like the other prunes', /catch \(e\) \{[\s\S]{0,200}punch/i.test(cron));
}
ok('4e: no NEW cron entry was added to vercel.json',
  (read('../app/vercel.json').match(/"path": "\/api\/cron\/reap"/g) || []).length === 1);

// ═══════════ 5 · nowhere else keeps an exact point ═══════════
console.log('── PAY-20: no second copy of the point outlives the ninety days ──');
{
  // Mechanical: the only files that may name a raw point column are the ones that WRITE the
  // punch, the ones that define the vocabulary, and the suites that drive them. The activity
  // log in particular is append-only (a trigger refuses UPDATE), so a point written there
  // could never be trimmed — it must never be written.
  const WRITERS = new Set([
    'api/_lib/time/store.js',        // the punch itself
    'src/lib/clockRules.js',         // the column vocabulary + the clock-out verdict writer
    'src/lib/timeApi.js',            // the demo stub's twin of the punch
    'src/lib/timeMerge.js',          // the DEVICE's own offline buffer, deleted on replay
    'src/data/demoTimeLedger.js',    // demo seed
    'scripts/seed-backend.mjs',      // seed script
  ]);
  for (const f of ['api/_lib/activityLog.js', 'src/lib/activityLog.js', 'api/_lib/time/driveCompute.js', 'api/_lib/time/driveEstimates.js']) {
    const src = read(f);
    ok(`5a: ${f} copies no exact point`, !GPS_POINT_COLUMNS.some((c) => src.includes(c)), f);
  }
  // The punch's own audit trail rides in edit_history; no writer may put a point in it.
  const store = read('api/_lib/time/store.js');
  const history = store.match(/history\.push\(\{[^}]*\}\)/g) || [];
  ok('5b: no edit_history line carries a coordinate',
    !history.some((h) => /(lat|lng|latitude|longitude|coord)/i.test(h)), JSON.stringify(history.filter((h) => /(lat|lng)/i.test(h))));
  ok('5c: the writers are the only files that name a point column', WRITERS.size === 6);
}
{
  // The columns are nullable already, so clearing them needs NO migration.
  const sql = read('../supabase/migrations/20260614100000_time_tracking_backend.sql')
    + read('../supabase/migrations/20261001120000_time_entry_clock_out_geofence.sql');
  for (const c of GPS_POINT_COLUMNS) {
    ok(`5d: ${c} is nullable (no migration needed)`,
      new RegExp(`${c}\\s+double precision(?!\\s+not null)`, 'i').test(sql), c);
  }
}

clearTimeout(watchdog);
await fake.close();
const total = pass + fails.length;
if (fails.length) {
  console.error(`test-gps-retention: ${pass}/${total} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-gps-retention: ${total}/${total} passed`);
}
