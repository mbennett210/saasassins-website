// CS-051 — on a clean with two cleaners, the FIRST clock-out must not mark the clean done.
//
// THE BUG (re-verified at 6e61596c). `components/ClockControl` dispatched
// SET_JOB_STATUS 'done' on EVERY successful clock-out ("NOTE: on a multi-cleaner job the
// first clock-out marks it done … tracked as a follow-up"). Ana clocks out at 11:40 while
// Ben is still cleaning: the Schedule says Done, the office stops looking, and Ben's half of
// the clean reads as finished work nobody is doing. Only the server sees every open punch on
// a clean, and the server never decided.
//
// THE FIX. The clean is DONE when a punch on it closes and NOBODY is still on the clock there
// (`lib/jobStatus.jobDoneAfterPunches`, one pure rule). The server asks it after every
// clock-out — the live route, a replayed buffered clock-out, a manager closing or deleting an
// open punch, the auto-close cron — and writes the status itself (`jobsTable.markJobDone`, a
// compare-and-swap on the row's version), answering `jobDone`. The screen marks the clean
// done only when the server said so. Two phones clocking out at once cannot both miss: each
// closes its own punch BEFORE it looks, so the later look sees both closed.
//
// The REAL api/time handler + the REAL supabase-js against scripts/fake-supabase-http.mjs on
// 127.0.0.1 (nothing leaves this machine).
//
//   node app/scripts/test-job-done-last-clockout.mjs
import { readFileSync } from 'node:fs';
import { startFakeSupabase } from './fake-supabase-http.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const ORG = '00000000-0000-0000-0000-000000000001';
const CRON = 'cron-secret-for-the-fake';
const watchdog = setTimeout(() => { console.error('test-job-done-last-clockout: timed out'); process.exit(1); }, 60000);
watchdog.unref();

const TOKENS = {
  't-c1': { id: 'a-c1', email: 'c1@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
  't-c2': { id: 'a-c2', email: 'c2@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c2', org_id: ORG } },
  't-owner': { id: 'a-ow', email: 'ow@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
};

// `stampRowVersion` makes the fake behave like the real table's trigger (every insert or
// update restamps `jobs.row_version` from a sequence), so the server's compare-and-swap is
// tested against a version that really moves. A fake without the option ignores it.
const fake = await startFakeSupabase({ authUsers: TOKENS, stampRowVersion: ['jobs'] });
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG,
  CRON_SECRET: CRON,
});
delete process.env.ALERT_WEBHOOK_URL;
if (!String(process.env.SUPABASE_URL).startsWith('http://127.0.0.1:')) {
  console.error('refusing to run: SUPABASE_URL is not the local fake');
  process.exit(1);
}
const { default: handler } = await import('../api/time/[...path].js');
const jobStatus = await import('../src/lib/jobStatus.js');
const { JOB_STATUS } = jobStatus;

const START = '2026-09-27T02:00:00.000Z';   // 10 PM – midnight, New York
const END = '2026-09-27T04:00:00.000Z';
const SITE = { lat: 26.1, lng: -80.1 };

const user = (id, role) => ({ id, role, status: 'active', name: id.slice(2).toUpperCase(), email: `${id.slice(2)}@cs.co` });
const baseState = () => ({
  version: 56,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [user('u_c1', 'crew'), user('u_c2', 'crew'), user('u_owner', 'owner')],
  clients: [{ id: 'c1', name: 'Coral Bay HOA' }],
  sites: [{ id: 's1', clientId: 'c1', name: 'Tower', expectedCleanMins: 120, lat: SITE.lat, lng: SITE.lng, geofenceEnabled: true }],
  permissions: [],
  userPermissionOverrides: [],
  opsSettings: { defaultGeofenceRadiusM: 150, offlineReplayWindowHours: 12, autoCloseGraceMins: 120 },
});

// The row as public.jobs holds it. `updated_by_tab` is the LAST writer's tab (Ana's phone,
// when she clocked in): a server write that left it in place would be dropped by her phone
// as its own echo (store/sync.js subscribeJobsRealtime).
const jobRow = (id, { status = JOB_STATUS.IN_PROGRESS, crewIds = ['u_c1', 'u_c2'] } = {}) => ({
  id, organization_id: ORG, site_id: 's1', client_id: 'c1', start_at: START, status,
  row_version: 7, updated_by: 'a-c1', updated_by_tab: 't_ana_phone', updated_via: 'server', updated_by_build: 120,
  data: { id, clientId: 'c1', siteId: 's1', startAt: START, endAt: END, status, crewIds, notes: 'Lobby first' },
});
const openEntry = (id, userId, jobId = 'j1', extra = {}) => ({
  id, organization_id: ORG, job_id: jobId, client_id: 'c1', site_id: 's1', user_id: userId,
  clock_in_at: '2026-09-27T02:05:00.000Z', clock_out_at: null, status: 'in_progress',
  scheduled_start: START, scheduled_end: END, approval_status: 'pending', edit_history: [],
  client_punch_id: null, duration_minutes: null, row_version: 0, ...extra,
});

function reset({ jobs = [jobRow('j1')], entries = [openEntry('e_c1', 'u_c1'), openEntry('e_c2', 'u_c2')] } = {}) {
  fake.tables.org_state.splice(0, fake.tables.org_state.length,
    { organization_id: ORG, state: baseState(), version: 56, updated_at: '2026-09-27T01:00:00.000Z', protected_fingerprint: null });
  fake.tables.jobs = jobs;
  fake.tables.time_entries = entries;
  fake.tables.checklist_results = [];
  fake.tables.payroll_runs = [];
  fake.clearFailures?.();
  fake.clearWriteFailures?.();
  fake.requests.length = 0;
}
const job = (id = 'j1') => fake.tables.jobs.find((j) => j.id === id);
const entry = (id) => fake.tables.time_entries.find((e) => e.id === id);

async function call(action, { token = null, body = {}, method = 'POST', headers = {} } = {}) {
  const req = {
    method, url: `/api/time/${action}`, query: { path: [action] }, body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  };
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  await handler(req, res);
  return out;
}
const clockOut = (token, entryId) => call('clock-out', { token, body: { entryId, ...SITE, accuracyM: 5 } });
const jobWrites = () => fake.requests.filter((r) => r.path === '/rest/v1/jobs' && r.method !== 'GET' && r.method !== 'HEAD').length;

// ── 1. Two cleaners: the first clock-out leaves the clean in progress ────────────────────
reset();
let r = await clockOut('t-c1', 'e_c1');
eq('1.1 Ana clocks out → 200', r.status, 200);
ok('1.2 her punch is closed', !!entry('e_c1')?.clock_out_at);
eq('1.3 the server answers that the clean is NOT done (Ben is still on the clock)', r.body?.jobDone, false);
eq('1.4 …and the clean stays in progress (status column)', job().status, JOB_STATUS.IN_PROGRESS);
eq('1.5 …and in the payload', job().data.status, JOB_STATUS.IN_PROGRESS);
eq('1.6 nothing was written to the clean', jobWrites(), 0);

r = await clockOut('t-c2', 'e_c2');
eq('1.7 Ben clocks out → 200', r.status, 200);
eq('1.8 the LAST clock-out: the server answers jobDone', r.body?.jobDone, true);
eq('1.9 the clean is done (status column)', job().status, JOB_STATUS.DONE);
eq('1.10 …and in the payload the app reads', job().data.status, JOB_STATUS.DONE);
ok('1.11 the rest of the clean is untouched', job().data.notes === 'Lobby first' && job().data.crewIds.join() === 'u_c1,u_c2'
  && job().data.startAt === START, JSON.stringify(job().data));
eq('1.12 stamped as a SERVER write', job().updated_via, 'server');
ok('1.13 …with no human author', job().updated_by == null, String(job().updated_by));
ok('1.14 …and NOT Ana\'s tab, or her phone drops the change as its own echo',
  !!job().updated_by_tab && job().updated_by_tab !== 't_ana_phone' && !/^t_/.test(job().updated_by_tab), String(job().updated_by_tab));
ok('1.15 the row version moved (the realtime order guard sees a newer row)', Number(job().row_version) > 7, String(job().row_version));

// ── 2. One cleaner: their clock-out finishes the clean, as before ───────────────────────
reset({ entries: [openEntry('e_c1', 'u_c1')], jobs: [jobRow('j1', { crewIds: ['u_c1'] })] });
r = await clockOut('t-c1', 'e_c1');
ok('2.1 a one-cleaner clean is done at its clock-out', r.status === 200 && r.body?.jobDone === true && job().status === JOB_STATUS.DONE,
  `status=${r.status} jobDone=${r.body?.jobDone} job=${job().status}`);

// ── 3. Never rewritten: a cancelled or already-done clean ───────────────────────────────
reset({ entries: [openEntry('e_c1', 'u_c1')], jobs: [jobRow('j1', { status: JOB_STATUS.CANCELLED })] });
r = await clockOut('t-c1', 'e_c1');
ok('3.1 a CANCELLED clean stays cancelled at the last clock-out', r.status === 200 && job().status === JOB_STATUS.CANCELLED
  && job().data.status === JOB_STATUS.CANCELLED && r.body?.jobDone === false, `jobDone=${r.body?.jobDone} job=${job().status}`);
reset({ entries: [openEntry('e_c1', 'u_c1')], jobs: [jobRow('j1', { status: JOB_STATUS.DONE })] });
r = await clockOut('t-c1', 'e_c1');
ok('3.2 an already-done clean is not written again', r.status === 200 && r.body?.jobDone === true && jobWrites() === 0,
  `jobDone=${r.body?.jobDone} writes=${jobWrites()}`);

// ── 4. A deleted punch holds nobody on the clock ────────────────────────────────────────
reset({ entries: [openEntry('e_c1', 'u_c1'), openEntry('e_c2', 'u_c2', 'j1', { status: 'voided' })] });
r = await clockOut('t-c1', 'e_c1');
ok('4.1 Ben\'s punch was deleted (voided) while open → Ana\'s clock-out finishes the clean',
  r.body?.jobDone === true && job().status === JOB_STATUS.DONE, `jobDone=${r.body?.jobDone} job=${job().status}`);

// ── 5. Two phones at once: the clean ends done, never stuck in progress ─────────────────
reset();
const [ra, rb] = await Promise.all([clockOut('t-c1', 'e_c1'), clockOut('t-c2', 'e_c2')]);
ok('5.1 both simultaneous clock-outs land', ra.status === 200 && rb.status === 200, `${ra.status}/${rb.status}`);
eq('5.2 …and the clean is done', job().status, JOB_STATUS.DONE);
ok('5.3 …at least one of them was told so', ra.body?.jobDone === true || rb.body?.jobDone === true,
  `${ra.body?.jobDone}/${rb.body?.jobDone}`);

// ── 6. The offline twin: a replayed clock-out decides the same way ──────────────────────
reset();
const outAt = new Date(Date.now() - 60000).toISOString();
r = await call('replay', { token: 't-c1', body: { clientPunchId: 'op_ana', entryId: 'e_c1', assertedOutAt: outAt, outLat: SITE.lat, outLng: SITE.lng, userId: 'u_c1' } });
ok('6.1 Ana\'s buffered clock-out replays while Ben is on → clean still in progress',
  r.status === 200 && !!entry('e_c1')?.clock_out_at && r.body?.jobDone === false && job().status === JOB_STATUS.IN_PROGRESS,
  `status=${r.status} jobDone=${r.body?.jobDone} job=${job().status}`);
r = await call('replay', { token: 't-c2', body: { clientPunchId: 'op_ben', entryId: 'e_c2', assertedOutAt: outAt, outLat: SITE.lat, outLng: SITE.lng, userId: 'u_c2' } });
ok('6.2 Ben\'s replay closes the last punch → the clean is done',
  r.status === 200 && r.body?.jobDone === true && job().status === JOB_STATUS.DONE, `status=${r.status} jobDone=${r.body?.jobDone} job=${job().status}`);

// ── 7. Every other way the last punch closes ───────────────────────────────────────────
reset({ entries: [openEntry('e_c1', 'u_c1', 'j1', { clock_out_at: '2026-09-27T03:30:00.000Z', status: 'completed', duration_minutes: 85 }), openEntry('e_c2', 'u_c2')] });
r = await call('auto-close', { headers: { authorization: `Bearer ${CRON}` } });
ok('7.1 Ben forgot to clock out: the auto-close cron closes his punch and the clean is done',
  r.status === 200 && entry('e_c2')?.status === 'auto_closed' && job().status === JOB_STATUS.DONE,
  `status=${r.status} punch=${entry('e_c2')?.status} job=${job().status} body=${JSON.stringify(r.body)}`);

reset({ entries: [openEntry('e_c1', 'u_c1', 'j1', { clock_out_at: '2026-09-27T03:30:00.000Z', status: 'completed', duration_minutes: 85 }), openEntry('e_c2', 'u_c2')] });
r = await call('correct', { token: 't-owner', body: { entryId: 'e_c2', version: 0, patch: { clock_out_at: '2026-09-27T03:50:00.000Z' }, reason: 'forgot to clock out' } });
ok('7.2 the office enters Ben\'s clock-out by hand → the clean is done',
  r.status === 200 && !!entry('e_c2')?.clock_out_at && job().status === JOB_STATUS.DONE, `status=${r.status} job=${job().status}`);

reset({ entries: [openEntry('e_c1', 'u_c1', 'j1', { clock_out_at: '2026-09-27T03:30:00.000Z', status: 'completed', duration_minutes: 85 }), openEntry('e_c2', 'u_c2')] });
r = await call('void', { token: 't-owner', body: { entryId: 'e_c2', version: 0, reason: 'clocked into the wrong clean' } });
ok('7.3 the office deletes Ben\'s stray open punch → nobody is on the clock, and Ana finished: done',
  r.status === 200 && entry('e_c2')?.status === 'voided' && job().status === JOB_STATUS.DONE, `status=${r.status} job=${job().status}`);

reset({ entries: [openEntry('e_c1', 'u_c1')] });
r = await call('void', { token: 't-owner', body: { entryId: 'e_c1', version: 0, reason: 'clocked into the wrong clean' } });
ok('7.4 …but deleting the ONLY punch on a clean finishes nothing (nobody clocked out)',
  r.status === 200 && job().status === JOB_STATUS.IN_PROGRESS, `status=${r.status} job=${job().status}`);

// ── 8. A failed status write never costs the cleaner their clock-out ────────────────────
reset({ entries: [openEntry('e_c1', 'u_c1')], jobs: [jobRow('j1', { crewIds: ['u_c1'] })] });
if (typeof fake.failWrites === 'function') fake.failWrites('jobs');
r = await clockOut('t-c1', 'e_c1');
ok('8.1 the jobs write fails: the clock-out still lands (200, punch closed)',
  r.status === 200 && !!entry('e_c1')?.clock_out_at, `status=${r.status}`);
ok('8.2 …and the server does not claim the clean is done', r.body?.jobDone === false && job().status === JOB_STATUS.IN_PROGRESS,
  `jobDone=${r.body?.jobDone} job=${job().status}`);

// ── 9. The rule, pure ───────────────────────────────────────────────────────────────────
{
  const rule = typeof jobStatus.jobDoneAfterPunches === 'function' ? jobStatus.jobDoneAfterPunches : () => 'missing';
  const open = { clock_out_at: null, status: 'in_progress' };
  const closed = { clock_out_at: '2026-09-27T03:30:00.000Z', status: 'completed' };
  ok('9.1 the rule lives beside the status vocabulary (lib/jobStatus.jobDoneAfterPunches)', typeof jobStatus.jobDoneAfterPunches === 'function');
  ok('9.2 nobody clocked in → not done', rule([]) === false);
  ok('9.3 someone still on the clock → not done', rule([closed, open]) === false);
  ok('9.4 everyone clocked out → done', rule([closed, { ...closed, status: 'auto_closed' }]) === true);
  ok('9.5 a deleted or no-show punch counts for neither side', rule([closed, { ...open, status: 'voided' }, { ...open, status: 'no_show' }]) === true
    && rule([{ ...closed, status: 'voided' }]) === false);
}

// ── 10. The screen follows the server ──────────────────────────────────────────────────
{
  // The ONE clock (the Cleaner Hub, brief A): what a punch does lives in hooks/useClockActions; ClockControl draws it.
  const cc = `${read('../src/components/ClockControl.jsx')}\n${read('../src/hooks/useClockActions.js')}`;
  ok('10.1 ClockControl marks the clean done only when the server said jobDone',
    /jobDone && job && job\.status !== 'done' && job\.status !== 'cancelled'\) \{\s*dispatch\(\{ type: ACTIONS\.SET_JOB_STATUS, id: job\.id, status: 'done' \}\)/.test(cc));
  ok('10.2 …and never on every clock-out (the unconditional dispatch is gone)',
    !/if \(job && job\.status !== 'done' && job\.status !== 'cancelled'\) \{\s*dispatch\(\{ type: ACTIONS\.SET_JOB_STATUS, id: job\.id, status: 'done' \}\)/.test(cc));
  ok('10.3 …and the "first clock-out marks it done" note is gone with it', !/first clock-out marks it done/.test(cc));
  const api = read('../src/lib/timeApi.js');
  ok('10.4 the client passes the server\'s answer through', /jobDone: r\.jobDone === true/.test(api));
  ok('10.5 the demo stub decides with the same rule', /jobDoneAfterPunches\(/.test(api));
}

clearTimeout(watchdog);
await fake.close();
console.log(`\ntest-job-done-last-clockout: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
