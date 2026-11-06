// PAY-12, the RECORDING half — THE GEOFENCE VERDICT AT CLOCK-OUT.
//
// Matt, 2026-09-29 (PAY-12 note): "There should be a toggle switch under that cleaner's profile
// to disable this functionality if needed, but all clock-ins and clock-outs need to be recorded
// at the actual site."
//
// The clock-IN has been server-authoritatively geofenced since the Swept build. The clock-OUT
// stored only raw `clock_out_lat/lng` — no verdict, no distance — so "did they leave the site
// before clocking out?" could not be asked of a punch, let alone flagged for the approver. The
// coords were already being sent; nothing measured them.
//
// WHAT THIS PINS. The same `geofenceVerdict` rule, run SERVER-side on the clock-out coords, for
// a live clock-out AND for an offline replay, with the per-cleaner off switch honoured — and
// NOTHING IS BLOCKED OR HELD (the approval FLOW is PAY-17, still unanswered). An off-site
// clock-out shows as a flag in the approval queue and on the punch.
//
// Driven through the REAL api/time/[...path].js handler and the REAL supabase-js client against
// scripts/fake-supabase-http.mjs on 127.0.0.1 (the offline-drive pattern; no sandbox project
// exists — CS-033). Nothing leaves this machine. Distances are computed with the shared
// `haversineMeters`, never restated.
//
//   node app/scripts/test-clock-out-geofence.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { startFakeSupabase } from './fake-supabase-http.mjs';

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ORG = '00000000-0000-0000-0000-000000000001';
const watchdog = setTimeout(() => { console.error('test-clock-out-geofence: timed out'); process.exit(1); }, 60000);

const TOKENS = {
  't-c1': { id: 'a-c1', email: 'c1@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
  't-owner': { id: 'a-ow', email: 'ow@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
};
const fake = await startFakeSupabase({ authUsers: TOKENS });
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, CRON_SECRET: 'cron-secret-for-the-fake',
});
delete process.env.ALERT_WEBHOOK_URL;
if (!String(process.env.SUPABASE_URL).startsWith('http://127.0.0.1:')) {
  console.error('refusing to run: SUPABASE_URL is not the local fake');
  process.exit(1);
}
const { default: handler } = await import('../api/time/[...path].js');
const { haversineMeters, DEFAULT_GEOFENCE_RADIUS_M } = await import('../src/lib/geo.js');
const { GEOFENCE_OFF_REASON, GEOFENCE_REASON_LABELS, CLOCK_RULE_KEYS } = await import('../src/lib/clockRules.js');
const { punchFlags } = await import('../src/lib/filters/timeApprovals.js');

// The site, and two devices: one on the doorstep, one down the road.
const SITE = { lat: 26.1224, lng: -80.1373 };
const NEAR = { lat: 26.12250, lng: -80.13735 };   // metres away
const FAR = { lat: 26.1300, lng: -80.1450 };      // ~1 km away
const NEAR_M = haversineMeters(SITE.lat, SITE.lng, NEAR.lat, NEAR.lng);
const FAR_M = haversineMeters(SITE.lat, SITE.lng, FAR.lat, FAR.lng);
ok('the fixture straddles the ring', NEAR_M <= DEFAULT_GEOFENCE_RADIUS_M && FAR_M > DEFAULT_GEOFENCE_RADIUS_M, `near ${NEAR_M}m far ${FAR_M}m, radius ${DEFAULT_GEOFENCE_RADIUS_M}m`);

const START = '2026-09-28T13:00:00.000Z';
const END = '2026-09-28T16:00:00.000Z';
const user = (id, role, extra = {}) => ({ id, role, status: 'active', name: id, email: `${id.slice(2)}@cs.co`, pay: { type: 'hourly', hourlyRate: 20 }, ...extra });

const baseState = ({ siteCoords = true, siteGeofence = true, cleanerGeofenceOff = false } = {}) => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [
    user('u_c1', 'crew', cleanerGeofenceOff ? { clockRules: { [CLOCK_RULE_KEYS.geofence]: true } } : {}),
    user('u_owner', 'owner'),
  ],
  clients: [{ id: 'c_bay', name: 'Coral Bay HOA', supervisorId: 'u_owner' }],
  sites: [{
    id: 's_bay', clientId: 'c_bay', name: 'Bay clubhouse', expectedCleanMins: 120,
    geofenceEnabled: siteGeofence,
    ...(siteCoords ? { lat: SITE.lat, lng: SITE.lng } : {}),
  }],
  permissions: [], userPermissionOverrides: [],
  opsSettings: { defaultGeofenceRadiusM: DEFAULT_GEOFENCE_RADIUS_M, offlineReplayWindowHours: 12, autoCloseGraceMins: 120 },
});

const openEntry = (id, userId, over = {}) => ({
  id, organization_id: ORG, job_id: 'j_bay', client_id: 'c_bay', site_id: 's_bay', user_id: userId,
  client_name: 'Coral Bay HOA', site_name: 'Bay clubhouse', user_name: userId,
  clock_in_at: '2026-09-28T13:05:00.000Z', clock_out_at: null, status: 'in_progress',
  scheduled_start: START, scheduled_end: END, approval_status: 'pending', edit_history: [],
  client_punch_id: null, duration_minutes: null, row_version: 0,
  clock_in_lat: NEAR.lat, clock_in_lng: NEAR.lng, clock_in_distance_m: NEAR_M, geofence_result: 'inside',
  ...over,
});

function reset({ entries = [], state = {} } = {}) {
  fake.tables.org_state.splice(0, fake.tables.org_state.length,
    { organization_id: ORG, state: baseState(state), version: 57, updated_at: '2026-09-28T12:00:00.000Z', protected_fingerprint: null });
  fake.tables.jobs = [{
    id: 'j_bay', organization_id: ORG, site_id: 's_bay', client_id: 'c_bay', start_at: START,
    data: { id: 'j_bay', clientId: 'c_bay', siteId: 's_bay', startAt: START, endAt: END, status: 'in_progress', crewIds: ['u_c1'] },
  }];
  fake.tables.time_entries = entries;
  fake.tables.checklist_results = [];
  fake.tables.payroll_runs = [];
  fake.requests.length = 0;
}

async function call(action, { token = null, body = {}, method = 'POST' } = {}) {
  const req = { method, url: `/api/time/${action}`, query: { path: [action] }, body, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; },
    setHeader() { return res; }, end() { return res; },
  };
  await handler(req, res);
  return out;
}
const byId = (id) => fake.tables.time_entries.find((e) => e.id === id) || null;

// ════════════════════ 1 · a LIVE clock-out is measured ════════════════════════════
{
  reset({ entries: [openEntry('e1', 'u_c1')] });
  let r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: NEAR.lat, lng: NEAR.lng, accuracyM: 5 } });
  eq('clocking out ON SITE → 200', r.status, 200);
  eq('…the verdict is recorded as inside', byId('e1').geofence_result_out, 'inside');
  eq('…with the server-computed distance', byId('e1').clock_out_distance_m, NEAR_M);
  eq('…and the device accuracy', byId('e1').clock_out_accuracy_m, 5);
  eq('…the clock-IN verdict is untouched', byId('e1').geofence_result, 'inside');
  eq('…and the punch closed', byId('e1').status, 'completed');

  reset({ entries: [openEntry('e1', 'u_c1')] });
  r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: FAR.lat, lng: FAR.lng, accuracyM: 8 } });
  // 🔴 NOTHING IS BLOCKED OR HELD YET (the approval flow is PAY-17, unanswered). The work
  // happened and the punch is its only record — refusing it would lose the clock-out (II.8).
  eq('clocking out OFF SITE → still 200', r.status, 200);
  eq('…recorded as outside', byId('e1').geofence_result_out, 'outside');
  eq('…with the real distance', byId('e1').clock_out_distance_m, FAR_M);
  eq('…the punch still closed', byId('e1').status, 'completed');
  ok('…and has a duration', Number.isFinite(byId('e1').duration_minutes) && byId('e1').duration_minutes > 0);
  eq('…and is NOT held: the approval is the ordinary pending', byId('e1').approval_status, 'pending');

  // NO device coords (GPS refused / momentary miss): allowed, and recorded as such — never
  // silently as "on site".
  reset({ entries: [openEntry('e1', 'u_c1')] });
  r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1' } });
  eq('no device coords → 200', r.status, 200);
  eq('…recorded as unavailable', byId('e1').geofence_result_out, 'unavailable');
  eq('…with no distance', byId('e1').clock_out_distance_m, null);

  // The ring widens by the reported GPS accuracy, exactly as clock-in does, so a poor fix on
  // the doorstep is not recorded as off-site.
  reset({ entries: [openEntry('e1', 'u_c1')] });
  const justOut = Math.round(DEFAULT_GEOFENCE_RADIUS_M + 30);
  ok('the far point is outside even widened by 30 m', FAR_M > justOut);
  r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: FAR.lat, lng: FAR.lng, accuracyM: 100 } });
  eq('a poor fix does not make a 1 km walk "inside"', byId('e1').geofence_result_out, 'outside');
}

// ════════════════════ 2 · the site has no centre ══════════════════════════════════
// With GOOGLE_MAPS_API_KEY unset in production most locations have no coordinates (CS-036), and
// a location whose address stopped resolving has them CLEARED on purpose. That is a legitimate
// state, not an off-site clock-out.
{
  reset({ entries: [openEntry('e1', 'u_c1')], state: { siteCoords: false } });
  const r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: FAR.lat, lng: FAR.lng } });
  eq('an un-geocoded location → 200', r.status, 200);
  eq('…recorded as no_site_coords', byId('e1').geofence_result_out, 'no_site_coords');
  eq('…and never as outside', byId('e1').clock_out_distance_m, null);
}

// ════════════════════ 3 · the off switches, and which one ═════════════════════════
// The enum has no 'disabled', so a config-skipped ring is 'override' and the REASON says which
// config — the same rule and the same two reasons the clock-in records.
{
  reset({ entries: [openEntry('e1', 'u_c1')], state: { cleanerGeofenceOff: true } });
  let r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: FAR.lat, lng: FAR.lng } });
  eq('the cleaner is exempt → 200', r.status, 200);
  eq('…recorded as override', byId('e1').geofence_result_out, 'override');
  eq('…naming the PER-CLEANER rule', byId('e1').override_reason_out, GEOFENCE_OFF_REASON);
  // Turning the ring off stops it judging, not measuring: the office still sees where the
  // punch happened.
  eq('…and the distance is still measured', byId('e1').clock_out_distance_m, FAR_M);

  reset({ entries: [openEntry('e1', 'u_c1')], state: { siteGeofence: false } });
  r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: FAR.lat, lng: FAR.lng } });
  eq('the LOCATION has the ring off → override', byId('e1').geofence_result_out, 'override');
  eq('…naming the location rule', byId('e1').override_reason_out, 'geofence_disabled');

  // The per-cleaner reason WINS when both apply, so a cleaner's punches read the same way
  // wherever they work — the same precedence the clock-in uses.
  reset({ entries: [openEntry('e1', 'u_c1')], state: { siteGeofence: false, cleanerGeofenceOff: true } });
  await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: FAR.lat, lng: FAR.lng } });
  eq('both off → the per-cleaner reason wins', byId('e1').override_reason_out, GEOFENCE_OFF_REASON);
}

// ════════════════════ 4 · the verdict is the SERVER'S ═════════════════════════════
// A client-side geofence is trivially spoofed, so a body that asserts a verdict, a reason or a
// distance must change nothing.
{
  reset({ entries: [openEntry('e1', 'u_c1')] });
  await call('clock-out', {
    token: 't-c1',
    body: {
      entryId: 'e1', lat: FAR.lat, lng: FAR.lng,
      geofenceResultOut: 'inside', geofence_result_out: 'inside',
      overrideReason: GEOFENCE_OFF_REASON, override_reason_out: GEOFENCE_OFF_REASON,
      clock_out_distance_m: 1, distanceM: 1,
    },
  });
  eq('a claimed "inside" is ignored', byId('e1').geofence_result_out, 'outside');
  eq('a claimed exemption reason is ignored', byId('e1').override_reason_out, null);
  eq('a claimed distance is ignored', byId('e1').clock_out_distance_m, FAR_M);
}

// ════════════════════ 5 · an offline REPLAY re-runs it ════════════════════════════
{
  // (a) a buffered clock-OUT of an already-synced punch.
  const recent = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();
  reset({ entries: [openEntry('e1', 'u_c1')] });
  let r = await call('replay', {
    token: 't-c1',
    body: { clientPunchId: 'op_1', entryId: 'e1', assertedOutAt: recent(), outLat: FAR.lat, outLng: FAR.lng, outAccuracyM: 12 },
  });
  eq('a replayed clock-out → 200', r.status, 200);
  eq('…the verdict was re-run server-side', byId('e1').geofence_result_out, 'outside');
  eq('…with the server-computed distance', byId('e1').clock_out_distance_m, FAR_M);
  eq('…and the buffered accuracy', byId('e1').clock_out_accuracy_m, 12);
  eq('…the replay is never refused', byId('e1').clock_out_at !== null, true);

  // (b) a buffered clock-IN carrying its clock-OUT — one completed row, both ends measured.
  reset({ entries: [] });
  r = await call('replay', {
    token: 't-c1',
    body: {
      clientPunchId: 'op_2', jobId: 'j_bay',
      assertedInAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(), assertedOutAt: recent(),
      inLat: NEAR.lat, inLng: NEAR.lng, inAccuracyM: 6, outLat: FAR.lat, outLng: FAR.lng, outAccuracyM: 9,
    },
  });
  eq('a buffered in+out replay → 200', r.status, 200);
  const row = fake.tables.time_entries[0];
  eq('…the clock-IN verdict is inside', row.geofence_result, 'inside');
  eq('…and the clock-OUT verdict is outside', row.geofence_result_out, 'outside');
  eq('…with each end\'s own distance', `${row.clock_in_distance_m}|${row.clock_out_distance_m}`, `${NEAR_M}|${FAR_M}`);

  // (c) a clock-IN-only replay closes nothing, so it records no out verdict.
  reset({ entries: [] });
  await call('replay', {
    token: 't-c1',
    body: { clientPunchId: 'op_3', jobId: 'j_bay', assertedInAt: recent(), inLat: NEAR.lat, inLng: NEAR.lng },
  });
  eq('a clock-in-only replay leaves the out verdict unset', fake.tables.time_entries[0].geofence_result_out ?? null, null);
}

// ════════════════════ 6 · a still-OPEN punch has no out verdict ═══════════════════
{
  reset({ entries: [openEntry('e1', 'u_c1')] });
  eq('an open punch carries no out verdict', byId('e1').geofence_result_out ?? null, null);
}

// ════════════════════ 7 · the flag reaches the approver ═══════════════════════════
// A verdict written by one module and read by none is not a flag (the lesson of the checklist
// note, W5-M F4). `punchFlags` is what the /approvals queue renders.
{
  const flagsFor = (over) => punchFlags({ id: 'x', geofence_result: 'inside', ...over });
  ok('an OFF-SITE clock-out is flagged', flagsFor({ geofence_result_out: 'outside' }).some((f) => /off-site clock-out/i.test(f)),
    JSON.stringify(flagsFor({ geofence_result_out: 'outside' })));
  ok('…distinctly from an off-site clock-IN',
    flagsFor({ geofence_result: 'outside' }).join('|') !== flagsFor({ geofence_result_out: 'outside' }).join('|'));
  ok('an on-site clock-out adds no noise', flagsFor({ geofence_result_out: 'inside' }).every((f) => !/clock-out/i.test(f)),
    JSON.stringify(flagsFor({ geofence_result_out: 'inside' })));
  ok('an exempt cleaner is not flagged as off-site',
    flagsFor({ geofence_result_out: 'override', override_reason_out: GEOFENCE_OFF_REASON }).every((f) => !/off-site clock-out/i.test(f)));
  ok('…the reason is NAMED from the shared label map',
    flagsFor({ geofence_result_out: 'override', override_reason_out: GEOFENCE_OFF_REASON })
      .some((f) => f.includes(GEOFENCE_REASON_LABELS[GEOFENCE_OFF_REASON])));
  ok('an unavailable fix at clock-out is surfaced too',
    flagsFor({ geofence_result_out: 'unavailable' }).some((f) => /clock-out/i.test(f)),
    JSON.stringify(flagsFor({ geofence_result_out: 'unavailable' })));
  ok('no_site_coords at clock-out is NOT a flag (most locations have no centre — CS-036)',
    flagsFor({ geofence_result_out: 'no_site_coords' }).every((f) => !/clock-out/i.test(f)));

  // The queue can only flag what its SELECT reads.
  const store = readFileSync(new URL('../api/_lib/time/store.js', import.meta.url), 'utf8');
  const cols = /APPROVALS_PENDING_COLUMNS = '([^']+)'/.exec(store)?.[1] || '';
  for (const c of ['geofence_result_out', 'override_reason_out', 'clock_out_distance_m']) {
    ok(`the approvals read selects ${c}`, cols.split(',').includes(c), cols);
  }
}

// ════════════════════ 8 · one rule, and a migration for the columns ══════════════
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const store = read('../api/_lib/time/store.js');
  ok('the store builds the out fields through the shared helper', /clockOutGeofenceFields/.test(store));
  ok('…the live clock-out uses it', /clockOutGeofenceFields\(/.test(store));
  // The demo stub must reach the same verdict, or a demo punch reads differently from prod.
  const timeApi = read('../src/lib/timeApi.js');
  ok('the demo stub computes an out verdict too', /clockOutGeofenceFields/.test(timeApi));
  // The punch detail is where the office looks at one punch.
  const history = read('../src/components/TimeClockHistory.jsx');
  ok('the punch detail shows the clock-out verdict', /geofence_result_out/.test(history));

  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const mig = readdirSync(dir).filter((f) => /clock_out_geofence/.test(f));
  ok('a migration adds the columns', mig.length === 1, JSON.stringify(mig));
  if (mig.length === 1) {
    const sql = readFileSync(new URL(mig[0], dir), 'utf8');
    for (const c of ['geofence_result_out', 'override_reason_out', 'clock_out_distance_m', 'clock_out_accuracy_m']) {
      ok(`…${c}`, new RegExp(`add column if not exists\\s+${c}`, 'i').test(sql), 'not added idempotently');
    }
    ok('…additive and nullable (no NOT NULL, no default)', !/not null/i.test(sql));
    ok('…and it does not touch RLS or policies', !/row level security|create policy|drop policy/i.test(sql));
  }
}

clearTimeout(watchdog);
await fake.close();
const total = pass + fails.length;
if (fails.length) {
  console.error(`test-clock-out-geofence: ${pass}/${total} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-clock-out-geofence: ${total}/${total} passed`);
}
