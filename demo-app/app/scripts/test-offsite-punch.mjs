// PAY-17 — AN OFF-SITE PUNCH IS ALLOWED, HELD FOR THE SUPERVISOR, AND ALERTED AT ONCE.
//
// Matt, 2026-09-30: "The cleaner can clock in or out; the time is held until the supervisor
// approves it, and the supervisor is alerted right away."
//
// Before this, a clock-in outside the ring was REFUSED (403) unless the cleaner tapped
// "Clock in anyway", which recorded the punch as an `override` with a crew-asserted reason —
// so the honest fact ("this punch happened 1 km from the building") was overwritten by a
// confession, and a cleaner with no signal could be stranded at the door. Now nothing is
// blocked: the verdict is recorded as it is, the punch is approval-gated like every punch,
// and the account's supervisor hears about it immediately on push, bell and text.
//
// Driven through the REAL api/time/[...path].js handler and the REAL supabase-js client
// against scripts/fake-supabase-http.mjs on 127.0.0.1 (the offline-drive pattern; no sandbox
// project exists — CS-033). Nothing leaves this machine. Distances come from the shared
// `haversineMeters`, never restated.
//
//   node app/scripts/test-offsite-punch.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeSupabase } from './fake-supabase-http.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
// Line endings normalized: a Windows checkout (core.autocrlf) holds these files with CRLF, and the
// source pins below match a function's closing "\n}\n", so without this they fail there and pass on CI.
const read = (p) => { try { return readFileSync(root(p), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
// A check whose subject may not exist on the pre-change tree must still read as ONE failed
// check, not end the run — THE LAW II.3 wants the whole pre-fix failure list.
const call0 = (fn, ...a) => { try { return fn(...a); } catch (e) { return `threw: ${e?.message || e}`; } };

const ORG = '00000000-0000-0000-0000-000000000001';
const watchdog = setTimeout(() => { console.error('test-offsite-punch: timed out'); process.exit(1); }, 60000);

const TOKENS = {
  't-c1': { id: 'a-c1', email: 'c1@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
  't-c2': { id: 'a-c2', email: 'c2@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c2', org_id: ORG } },
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
const { haversineMeters, DEFAULT_GEOFENCE_RADIUS_M, isOffSiteVerdict } = await import('../src/lib/geo.js');
const {
  GEOFENCE_OFF_REASON, CLOCK_RULE_KEYS, OFF_SITE_PUNCH_EVENT, offSitePunchSides,
  GEOFENCE_REASON_LABELS, LEGACY_CREW_OFFSITE_REASON,
} = await import('../src/lib/clockRules.js');
const { punchFlags } = await import('../src/lib/filters/timeApprovals.js');
const { ALWAYS_PUSH_EVENT_KEYS, SMS_ALERT_EVENT_KEYS } = await import('../src/lib/alertDelivery.js');
const { metersToFeet } = await import('../src/lib/geo.js');

// The site, and two devices: one on the doorstep, one down the road.
const SITE = { lat: 26.1224, lng: -80.1373 };
const NEAR = { lat: 26.12250, lng: -80.13735 };   // metres away
const FAR = { lat: 26.1300, lng: -80.1450 };      // ~1 km away
const NEAR_M = haversineMeters(SITE.lat, SITE.lng, NEAR.lat, NEAR.lng);
const FAR_M = haversineMeters(SITE.lat, SITE.lng, FAR.lat, FAR.lng);
ok('the fixture straddles the ring', NEAR_M <= DEFAULT_GEOFENCE_RADIUS_M && FAR_M > DEFAULT_GEOFENCE_RADIUS_M, `near ${NEAR_M}m far ${FAR_M}m, radius ${DEFAULT_GEOFENCE_RADIUS_M}m`);

const START = '2026-09-28T13:00:00.000Z';
const END = '2026-09-28T16:00:00.000Z';
const user = (id, role, extra = {}) => ({ id, role, status: 'active', name: id, email: `${id.slice(2)}@cs.co`, phone: '754-555-0101', pay: { type: 'hourly', hourlyRate: 20 }, ...extra });

const baseState = ({ cleanerGeofenceOff = false } = {}) => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [
    user('u_c1', 'crew'),
    user('u_c2', 'crew', cleanerGeofenceOff ? { clockRules: { [CLOCK_RULE_KEYS.geofence]: true } } : {}),
    user('u_owner', 'owner'),
    user('u_sup', 'manager'),
  ],
  clients: [{ id: 'c_bay', name: 'Coral Bay HOA', supervisorId: 'u_sup' }],
  sites: [{
    id: 's_bay', clientId: 'c_bay', name: 'Bay clubhouse', expectedCleanMins: 120,
    geofenceEnabled: true, lat: SITE.lat, lng: SITE.lng,
  }],
  permissions: [], userPermissionOverrides: [], notifications: [],
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
    data: { id: 'j_bay', clientId: 'c_bay', siteId: 's_bay', startAt: START, endAt: END, status: 'upcoming', crewIds: ['u_c1', 'u_c2'] },
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
// The punch this call wrote, read back off the table. By POSITION rather than by the
// response's id, because the local fake's `.single()` hands back an array where PostgREST
// hands back the object — and on a tree where the punch was REFUSED there is no row at all,
// so the checks that read it fail honestly instead of ending the run.
const written = () => fake.tables.time_entries[fake.tables.time_entries.length - 1] || {};
const row = () => written();
const notifications = () => (fake.tables.org_state[0]?.state?.notifications || []);
const offSiteRows = () => notifications().filter((n) => n.eventKey === OFF_SITE_PUNCH_EVENT);

// ═══════════ 1 · the shared predicate: what counts as off-site ═══════════
console.log('── PAY-17: what counts as off-site ──');
eq('1a: outside the ring is off-site', call0(isOffSiteVerdict, 'outside'), true);
eq('1b: no device location is off-site too (location off / denied)', call0(isOffSiteVerdict, 'unavailable'), true);
eq('1c: on site is not', call0(isOffSiteVerdict, 'inside'), false);
eq('1d: a ring switched off by CONFIG is not', call0(isOffSiteVerdict, 'override'), false);
// An un-geocoded LOCATION is our data gap, not the cleaner's whereabouts — and production has
// almost none geocoded (GOOGLE_MAPS_API_KEY unset, CS-036), so counting it would flag and
// alert on nearly every punch in the book.
eq('1e: a location we never geocoded is NOT the cleaner being off-site', call0(isOffSiteVerdict, 'no_site_coords'), false);
// CS-193: the crew-facing sentence is ONE catalog line (`clock.offSite`), shown in the
// cleaner's language — the shared module it lives in is the catalog.
const { english } = await import('../src/i18n/core.js');
ok('1f: the crew-facing sentence lives in the shared module', /outside/i.test(english('clock.offSite') || ''));

// ═══════════ 2 · clocking IN off-site is never blocked ═══════════
console.log('── PAY-17: the clock-in is allowed and recorded honestly ──');
{
  reset();
  const r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_bay', lat: FAR.lat, lng: FAR.lng, accuracyM: 8 } });
  eq('2a: clocking in OFF SITE → 200, never a 403', r.status, 200);
  const e = r.body?.entry;
  ok('2b: …a punch exists', fake.tables.time_entries.length === 1);
  const got = row();
  eq('2c: …recorded as outside, not as an override', got.geofence_result, 'outside');
  eq('2d: …with the server-computed distance', got.clock_in_distance_m, FAR_M);
  eq('2e: …nobody is recorded as having overridden anything', got.override_by_user_id ?? null, null);
  // HELD: the insert asserts NO approval at all, so the column's own `not null default
  // 'pending'` binds (the local fake applies no DB defaults, so the schema is checked below).
  eq('2f: …and it is HELD: the insert claims no approval of its own', 'approval_status' in got, false);
  eq('2g: …the punch is open and attributable', [got.status, got.user_id], ['in_progress', 'u_c1']);
}
{
  // Location off / denied: no coords at all. Allowed, and recorded as such — never silently
  // as "on site", and it counts as off-site for the flag and the alert.
  reset();
  const r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_bay' } });
  eq('2h: clocking in with NO location → 200', r.status, 200);
  const e = row();
  eq('2i: …recorded as unavailable', e.geofence_result, 'unavailable');
  eq('2j: …held for approval', 'approval_status' in e, false);
  eq('2k: …and the supervisor is told', offSiteRows().length > 0, true);
}
{
  reset();
  const r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_bay', lat: NEAR.lat, lng: NEAR.lng, accuracyM: 5 } });
  eq('2l: an ON-SITE clock-in is unchanged', row().geofence_result, 'inside');
  eq('2m: …and raises nothing', offSiteRows().length, 0);
}

// ═══════════ 3 · the supervisor is alerted right away ═══════════
console.log('── PAY-17: the account supervisor hears about it immediately ──');
{
  reset();
  await call('clock-in', { token: 't-c1', body: { jobId: 'j_bay', lat: FAR.lat, lng: FAR.lng, accuracyM: 8 } });
  const rows = offSiteRows();
  eq('3a: exactly one alert for the punch', rows.length, 1);
  eq('3b: …addressed to the account supervisor', rows[0]?.userId, 'u_sup');
  ok('3c: …naming the customer', /Coral Bay/.test(`${rows[0]?.title} ${rows[0]?.body}`));
  ok('3d: …and the cleaner', /u_c1/.test(`${rows[0]?.title} ${rows[0]?.body}`));
  ok('3e: …deep-linking to the approvals queue', String(rows[0]?.url || '').startsWith('/approvals'));
  eq('3f: the event breaks through quiet hours', ALWAYS_PUSH_EVENT_KEYS.has(OFF_SITE_PUNCH_EVENT ?? '?'), true);
  eq('3g: …and goes out as a text as well', SMS_ALERT_EVENT_KEYS.has(OFF_SITE_PUNCH_EVENT ?? '?'), true);
}
{
  // The clock-OUT end alerts on its own terms: the cleaner was on site when they arrived and
  // somewhere else when they left, which is exactly the question an approver has to answer.
  reset({ entries: [openEntry('e1', 'u_c1')] });
  const r = await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: FAR.lat, lng: FAR.lng, accuracyM: 8 } });
  eq('3h: an off-site clock-out is still 200', r.status, 200);
  eq('3i: …recorded as outside', byId('e1').geofence_result_out, 'outside');
  eq('3j: …the punch stays pending', byId('e1').approval_status, 'pending');
  eq('3k: …and alerts the supervisor', offSiteRows().length, 1);
  eq('3l: …once, to the supervisor', offSiteRows()[0]?.userId, 'u_sup');
}
{
  reset({ entries: [openEntry('e1', 'u_c1')] });
  await call('clock-out', { token: 't-c1', body: { entryId: 'e1', lat: NEAR.lat, lng: NEAR.lng, accuracyM: 5 } });
  eq('3m: an ON-SITE clock-out raises nothing', offSiteRows().length, 0);
}

// ═══════════ 4 · the per-cleaner exemption still exempts ═══════════
console.log('── PAY-17: user.clockRules.geofenceOff — no flag, no alert ──');
{
  reset({ state: { cleanerGeofenceOff: true } });
  const r = await call('clock-in', { token: 't-c2', body: { jobId: 'j_bay', lat: FAR.lat, lng: FAR.lng, accuracyM: 8 } });
  const e = row();
  eq('4a: the exempt cleaner clocks in a thousand metres away', r.status, 200);
  eq('4b: …recorded as an override by CONFIG', e.geofence_result, 'override');
  eq('4c: …naming which config', e.override_reason, GEOFENCE_OFF_REASON);
  eq('4d: …the distance is still measured', e.clock_in_distance_m, FAR_M);
  eq('4e: …and NOBODY is alerted', offSiteRows().length, 0);
  eq('4f: …nor is the punch flagged off-site', punchFlags(e).some((f) => /off-site/i.test(f)), false);
}

// ═══════════ 5 · the Approvals queue shows the flag AND the distance ═══════════
console.log('── PAY-17: the approver sees the flag and how far, for both ends ──');
{
  const row = {
    geofence_result: 'outside', clock_in_distance_m: FAR_M,
    geofence_result_out: 'outside', clock_out_distance_m: NEAR_M + 500,
    approval_status: 'pending',
  };
  const flags = punchFlags(row);
  const inFlag = flags.find((f) => /clock-in/i.test(f));
  const outFlag = flags.find((f) => /clock-out/i.test(f));
  ok('5a: the clock-IN end is flagged', !!inFlag, JSON.stringify(flags));
  ok('5b: …with the distance in feet', !!inFlag && inFlag.includes(metersToFeet(FAR_M).toLocaleString('en-US')), inFlag);
  ok('5c: the clock-OUT end is flagged', !!outFlag, JSON.stringify(flags));
  ok('5d: …with its own distance', !!outFlag && outFlag.includes(metersToFeet(NEAR_M + 500).toLocaleString('en-US')), outFlag);
  ok('5e: the two are distinguishable', !!inFlag && !!outFlag && inFlag !== outFlag);
}
{
  // No location at all says so, and does not claim a distance it does not have.
  const flags = punchFlags({ geofence_result: 'unavailable', clock_in_distance_m: null });
  ok('5f: a punch with no location is flagged', flags.some((f) => /no location/i.test(f)), JSON.stringify(flags));
  ok('5g: …without inventing a distance', !flags.some((f) => /\bft\b/.test(f)));
}
{
  eq('5h: offSitePunchSides reads both ends off the row',
    call0(offSitePunchSides, { geofence_result: 'outside', geofence_result_out: 'inside' }), { in: true, out: false });
  eq('5i: …and neither on a clean punch',
    call0(offSitePunchSides, { geofence_result: 'inside', geofence_result_out: 'inside' }), { in: false, out: false });
}

// ═══════════ 6 · the crew UI no longer blocks, and says what happens next ═══════════
console.log('── PAY-17: the cleaner sees a plain warning, not a wall ──');
{
  // The ONE clock (the Cleaner Hub, brief A): what a punch does lives in hooks/useClockActions; ClockControl draws it.
  const cc = `${read('src/components/ClockControl.jsx')}\n${read('src/hooks/useClockActions.js')}`;
  ok('6a: there is no off-site override button left', !/>\s*Clock in anyway/i.test(cc));
  ok('6b: …no off-site BLOCK markup', !/clock-offsite/.test(cc));
  ok('6c: …and the server is never asked to override', !/override:\s*true|override\)/.test(cc));
  // Through lib/geo's map since CS-689, which gives "no location" its own sentence.
  ok('6d: the warning comes from the shared module', /OFF_SITE_SENTENCE_KEYS/.test(cc) && /outside: 'clock\.offSite'/.test(read('src/lib/geo.js')));
  const api = read('src/lib/timeApi.js');
  ok('6e: the demo stub refuses nothing either', !/Outside the geofence/.test(api));
  const stubSig = /function stubClockIn\(([^)]*)\)/.exec(api)?.[1] || '(not found)';
  ok('6f: …and the demo clock-in takes no override argument', !/\boverride\b/.test(stubSig), stubSig);
  const route = read('../app/api/time/[...path].js');
  ok('6g: the route no longer answers 403 with a geofence payload', !/r\.blocked/.test(route));

  // ⚠️ The reason is no longer MINTED, but every punch written before this change still
  // carries it — a stored value outlives its writer, so the LABEL has to stay or those rows
  // show the office a raw code.
  for (const f of ['api/_lib/time/store.js', 'src/lib/timeApi.js', 'src/data/demoTimeLedger.js', 'scripts/seed-backend.mjs']) {
    ok(`6h: ${f} no longer mints the legacy off-site reason`, !read(f).includes(LEGACY_CREW_OFFSITE_REASON), f);
  }
  eq('6i: …but a legacy punch still reads as a sentence',
    GEOFENCE_REASON_LABELS[LEGACY_CREW_OFFSITE_REASON], 'Clocked in off-site');
  eq('6j: …and the approval chip uses it',
    punchFlags({ geofence_result: 'override', override_reason: LEGACY_CREW_OFFSITE_REASON })[0],
    'Clocked in off-site');
}

// ═══════════ 7 · the data law: nothing auto-approves an off-site punch ═══════════
{
  reset();
  await call('clock-in', { token: 't-c1', body: { jobId: 'j_bay', lat: FAR.lat, lng: FAR.lng, accuracyM: 8 } });
  eq('7a: no punch is written with an approval of its own',
    fake.tables.time_entries.filter((e) => 'approval_status' in e).length, 0);
  const schema = read('../supabase/migrations/20260614100000_time_tracking_backend.sql');
  ok('7a2: …so the column default decides, and it is pending',
    /approval_status\s+text not null default 'pending'/.test(schema));
  const store = read('../app/api/_lib/time/store.js');
  // Only a MANAGER's sign-off writes an approval. A punch is never born approved.
  const approvers = store.split('\n').filter((l) => /approval_status:\s*'approved'/.test(l));
  eq('7b: exactly one writer sets a punch approved', approvers.length, 1);
  ok('7b2: …and it is approveEntryRow, the manager sign-off',
    /export async function approveEntryRow[\s\S]*?approval_status: 'approved'/.test(store));
  ok('7b3: …never the clock-in insert',
    !/approval_status/.test(/export async function clockIn\(([\s\S]*?)\n}\n/.exec(store)?.[1] || 'approval_status'));
}

clearTimeout(watchdog);
await fake.close();
const total = pass + fails.length;
if (fails.length) {
  console.error(`test-offsite-punch: ${pass}/${total} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-offsite-punch: ${total}/${total} passed`);
}
