// Step 4a, the server half (R4–R6) — the REAL api/time/[...path].js handler and the REAL
// supabase-js client against scripts/fake-supabase-http.mjs on 127.0.0.1 (GoTrue +
// PostgREST: org_state, public.jobs, time_entries, checklist_results). No sandbox project
// exists yet (CS-033), so this is how a per-role server claim is proven offline.
// Nothing leaves this machine: SUPABASE_URL points at the fake before the handler is
// imported, and the run refuses to go on otherwise.
//
// What it pins:
//   · POST /api/time/clock-out refuses the ENTRY OWNER's own clock-out with 409
//     checklist_incomplete (+ done/total) when their assigned checklist for that clean
//     isn't finished — every role, no exemption (plan §6).
//   · Done, no checklist, and the per-cleaner block switch all clock out normally.
//   · NEVER blocked: closing someone else's entry (the punch bypass), time/correct,
//     time/manual, and the auto-close cron.
//   · POST /api/time/replay NEVER refuses a buffered clock-out (THE LAW II.8 — fix
//     instead of reject); it accepts it and adds the flag note so it shows at approval.
//   · The 409 body stays plain (DEV_PLAYBOOK 3.4.12) and the gate costs ONE indexed
//     checklist_results read.
//
//   node app/scripts/test-clock-out-checklist-route.mjs
import { startFakeSupabase } from './fake-supabase-http.mjs';

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ORG = '00000000-0000-0000-0000-000000000001';
const CRON = 'cron-secret-for-the-fake';
const watchdog = setTimeout(() => { console.error('test-clock-out-checklist-route: timed out'); process.exit(1); }, 60000);

const TOKENS = {
  't-c1': { id: 'a-c1', email: 'c1@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
  't-c2': { id: 'a-c2', email: 'c2@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c2', org_id: ORG } },
  't-c3': { id: 'a-c3', email: 'c3@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c3', org_id: ORG } },
  't-c4': { id: 'a-c4', email: 'c4@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c4', org_id: ORG } },
  't-owner': { id: 'a-ow', email: 'ow@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  't-admin': { id: 'a-ad', email: 'ad@cs.co', app_metadata: { role: 'admin', org_user_id: 'u_admin', org_id: ORG } },
  't-mgr': { id: 'a-mg', email: 'mg@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
};

const fake = await startFakeSupabase({ authUsers: TOKENS });
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
const {
  CHECKLIST_INCOMPLETE_CODE, CHECKLIST_INCOMPLETE_ERROR,
  CHECKLIST_CHECK_FAILED_CODE, CHECKLIST_CHECK_FAILED_ERROR,
  checklistFlagNote, CHECKLIST_UNKNOWN_NOTE,
} = await import('../api/_lib/time/checklistGate.js');

const START = '2026-09-27T13:00:00.000Z';
const END = '2026-09-27T16:00:00.000Z';

const user = (id, role, extra = {}) => ({ id, role, status: 'active', name: id, email: `${id.slice(2)}@cs.co`, ...extra });
const baseState = () => ({
  version: 56,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [
    user('u_c1', 'crew'), user('u_c2', 'crew'),
    user('u_c3', 'crew', { clockRules: { checklistBlockOff: true } }),
    user('u_c4', 'crew'),
    user('u_owner', 'owner'), user('u_admin', 'admin'), user('u_mgr', 'manager'),
  ],
  // Per-cleaner checklists only; u_c4 holds none and the location has no default.
  clients: [{ id: 'c1', name: 'Coral Bay HOA', crewChecklists: { u_c1: 'it_a', u_c2: 'it_b', u_c3: 'it_a', u_mgr: 'it_a' } }],
  sites: [{ id: 's1', clientId: 'c1', name: 'Tower', expectedCleanMins: 120, lat: 26.1, lng: -80.1, geofenceEnabled: true }],
  permissions: [],
  userPermissionOverrides: [],
  opsSettings: { defaultGeofenceRadiusM: 150, offlineReplayWindowHours: 12 },
});

const openEntry = (id, userId) => ({
  id, organization_id: ORG, job_id: 'j1', client_id: 'c1', site_id: 's1', user_id: userId,
  clock_in_at: '2026-09-27T13:05:00.000Z', clock_out_at: null, status: 'in_progress',
  scheduled_start: START, scheduled_end: END, approval_status: 'pending', edit_history: [],
  client_punch_id: null, duration_minutes: null,
});
const result = (p = {}) => ({
  id: p.id || `cr_${Math.random().toString(36).slice(2, 8)}`,
  organization_id: ORG, job_id: 'j1', site_id: 's1', client_id: 'c1',
  template_id: 'it_a', completed_by_user_id: 'u_c1',
  completed_count: 3, total_count: 12, performed_at: '2026-09-27T13:30:00.000Z',
  ...p,
});

function reset({ results = [], entries = null } = {}) {
  fake.tables.org_state.splice(0, fake.tables.org_state.length,
    { organization_id: ORG, state: baseState(), version: 56, updated_at: '2026-09-27T12:00:00.000Z', protected_fingerprint: null });
  fake.tables.jobs = [{
    id: 'j1', organization_id: ORG, site_id: 's1', client_id: 'c1', start_at: START,
    data: { id: 'j1', clientId: 'c1', siteId: 's1', startAt: START, endAt: END, status: 'in_progress', crewIds: ['u_c1', 'u_c2', 'u_c3', 'u_c4', 'u_mgr'] },
  }];
  fake.tables.time_entries = entries || [
    openEntry('e_c1', 'u_c1'), openEntry('e_c2', 'u_c2'), openEntry('e_c3', 'u_c3'),
    openEntry('e_c4', 'u_c4'), openEntry('e_mgr', 'u_mgr'),
  ];
  fake.tables.checklist_results = results;
  fake.requests.length = 0;
}

async function call(action, { token = null, body = {}, method = 'POST', query = {}, headers = {} } = {}) {
  const req = {
    method,
    url: `/api/time/${action}`,
    query: { path: [action], ...query },
    body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  };
  const out = { status: 200, body: null, headers: {} };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader(k, v) { out.headers[k] = v; return res; },
    end() { return res; },
  };
  await handler(req, res);
  return out;
}
const clockOut = (token, entryId) => call('clock-out', { token, body: { entryId } });

// ── 1. the entry owner is refused while their checklist is unfinished ────────
reset({ results: [result()] }); // u_c1: 3/12 on it_a
let r = await clockOut('t-c1', 'e_c1');
eq('C own entry, checklist 3/12 → 409', r.status, 409);
eq('409 carries the code', r.body?.code, CHECKLIST_INCOMPLETE_CODE);
eq('409 carries the plain message', r.body?.error, CHECKLIST_INCOMPLETE_ERROR);
eq('409 carries done', r.body?.done, 3);
eq('409 carries total', r.body?.total, 12);
eq('409 body has no other keys (plain body, 3.4.12)', Object.keys(r.body).sort().join(','), 'code,done,error,total');
ok('the entry stays OPEN', fake.tables.time_entries.find((e) => e.id === 'e_c1').clock_out_at === null);

reset({ results: [] });
r = await clockOut('t-c1', 'e_c1');
eq('C own entry, nothing submitted → 409', r.status, 409);
eq('…with 0 done', r.body?.done, 0);
eq('…and 0 total (nothing to count yet)', r.body?.total, 0);

// ── 2. DONE clocks out ───────────────────────────────────────────────────────
reset({ results: [result({ completed_count: 12, total_count: 12 })] });
r = await clockOut('t-c1', 'e_c1');
eq('C own entry, checklist 12/12 → 200', r.status, 200);
ok('the entry is closed', !!fake.tables.time_entries.find((e) => e.id === 'e_c1').clock_out_at);

reset({ results: [
  result({ completed_count: 12, total_count: 12, performed_at: '2026-09-27T13:30:00.000Z' }),
  result({ completed_count: 4, total_count: 12, performed_at: '2026-09-27T14:30:00.000Z' }),
] });
r = await clockOut('t-c1', 'e_c1');
eq('a later PARTIAL re-submission never undoes a complete one → 200', r.status, 200);

reset({ results: [result({ completed_count: 12, total_count: 12, template_id: 'it_b' })] });
r = await clockOut('t-c1', 'e_c1');
eq('a complete submission of ANOTHER checklist does not unlock → 409', r.status, 409);

reset({ results: [result({ completed_count: 12, total_count: 12, completed_by_user_id: 'u_c2' })] });
r = await clockOut('t-c1', 'e_c1');
eq('ANOTHER cleaner’s complete submission does not unlock → 409', r.status, 409);

reset({ results: [result({ completed_count: 12, total_count: 12, job_id: 'j2' })] });
r = await clockOut('t-c1', 'e_c1');
eq('a complete submission on ANOTHER clean does not unlock → 409', r.status, 409);

// ── 3. no checklist, and the per-cleaner block switch ───────────────────────
reset({ results: [] });
r = await clockOut('t-c4', 'e_c4');
eq('C with NO checklist → 200 (R1: no checklist is a normal state)', r.status, 200);

reset({ results: [] });
r = await clockOut('t-c3', 'e_c3');
eq('C with clockRules.checklistBlockOff → 200 (R6)', r.status, 200);

// ── 4. every role, on their OWN entry (plan §6: no exemption) ───────────────
for (const [label, token, entryId] of [['M', 't-mgr', 'e_mgr']]) {
  reset({ results: [result({ completed_by_user_id: 'u_mgr', completed_count: 1, total_count: 12 })] });
  r = await clockOut(token, entryId);
  eq(`${label} own entry, checklist unfinished → 409`, r.status, 409);
  eq(`${label} 409 progress`, `${r.body?.done}/${r.body?.total}`, '1/12');
}

// ── 5. NEVER blocked: someone else's entry (the punch bypass) ───────────────
for (const [label, token] of [['O', 't-owner'], ['A', 't-admin'], ['M', 't-mgr']]) {
  reset({ results: [result()] }); // u_c1 still at 3/12
  r = await clockOut(token, 'e_c1');
  eq(`${label} closes C’s unfinished entry → 200 (the office closes the entry)`, r.status, 200);
  ok(`${label} left the correction trail`, fake.tables.time_entries.find((e) => e.id === 'e_c1')?.edited === true);
}
reset({ results: [result()] });
r = await clockOut('t-c2', 'e_c1');
eq('C cannot close another cleaner’s entry (unchanged) → 403', r.status, 403);
reset({ results: [result()] });
r = await clockOut(null, 'e_c1');
eq('no session → 401', r.status, 401);

// ── 6. NEVER blocked: correct / manual / auto-close ─────────────────────────
reset({ results: [result()] });
r = await call('correct', { token: 't-owner', body: { entryId: 'e_c1', patch: { clock_out_at: END }, reason: 'crew phone died' } });
eq('time/correct is never blocked → 200', r.status, 200);

reset({ results: [result()] });
r = await call('manual', { token: 't-owner', body: { userId: 'u_c1', jobId: 'j1', clockInAt: START, clockOutAt: END, reason: 'paper timesheet' } });
eq('time/manual is never blocked → 200', r.status, 200);

reset({ results: [result()] });
r = await call('auto-close', { method: 'POST', headers: { authorization: `Bearer ${CRON}` }, query: {}, body: {} });
eq('the auto-close cron is never blocked → 200', r.status, 200);
ok('auto-close closed the unfinished-checklist entry', (r.body?.closed || 0) >= 1);

// ── 7. replay NEVER refuses; it flags (THE LAW II.8) ───────────────────────
reset({ results: [result()] }); // u_c1 at 3/12
r = await call('replay', { token: 't-c1', body: { clientPunchId: 'op_1', entryId: 'e_c1', assertedOutAt: '2026-09-27T15:00:00.000Z' } });
eq('replay of a buffered clock-out is ACCEPTED → 200', r.status, 200);
const replayed = fake.tables.time_entries.find((e) => e.id === 'e_c1');
ok('replay recorded the clock-out', !!replayed?.clock_out_at);
const flag = checklistFlagNote(3, 12);
ok('replay note carries the checklist flag', String(replayed?.note || '').includes(flag), `note=${replayed?.note}`);
ok('replay edit_history names it too, so it shows at approval',
  (replayed?.edit_history || []).some((h) => String(h.reason || '').includes(flag)));
eq('replay leaves approval pending', replayed?.approval_status, 'pending');

reset({ results: [result({ completed_count: 12, total_count: 12 })] });
r = await call('replay', { token: 't-c1', body: { clientPunchId: 'op_2', entryId: 'e_c1', assertedOutAt: '2026-09-27T15:00:00.000Z' } });
eq('replay with the checklist DONE → 200', r.status, 200);
const clean = fake.tables.time_entries.find((e) => e.id === 'e_c1');
ok('…and no checklist flag', !String(clean?.note || '').includes('checklist not finished'));

// A buffered clock-IN carrying its clock-OUT (one completed row on replay).
reset({ results: [result({ job_id: 'jX' })], entries: [] });
r = await call('replay', {
  token: 't-c1',
  body: { clientPunchId: 'op_3', jobId: 'j1', assertedInAt: '2026-09-27T13:05:00.000Z', assertedOutAt: '2026-09-27T15:00:00.000Z' },
});
eq('replay of a buffered clock-in+out is ACCEPTED → 200', r.status, 200);
const fresh = fake.tables.time_entries.find((e) => e.client_punch_id === 'op_3');
ok('the replayed row exists', !!fresh);
ok('…and carries the checklist flag in its offline note', String(fresh?.note || '').includes(checklistFlagNote(0, 0)), `note=${fresh?.note}`);

reset({ results: [], entries: [] });
r = await call('replay', {
  token: 't-c4',
  body: { clientPunchId: 'op_4', jobId: 'j1', assertedInAt: '2026-09-27T13:05:00.000Z', assertedOutAt: '2026-09-27T15:00:00.000Z' },
});
const noList = fake.tables.time_entries.find((e) => e.client_punch_id === 'op_4');
ok('a cleaner with NO checklist gets no flag', !String(noList?.note || '').includes('checklist not finished'));

// A buffered clock-IN alone is not a clock-out: no checklist flag.
reset({ results: [], entries: [] });
await call('replay', { token: 't-c1', body: { clientPunchId: 'op_5', jobId: 'j1', assertedInAt: '2026-09-27T13:05:00.000Z' } });
const inOnly = fake.tables.time_entries.find((e) => e.client_punch_id === 'op_5');
ok('a clock-IN-only replay carries no checklist flag', !String(inOnly?.note || '').includes('checklist not finished'));

// -- S5. every role, on their OWN entry --------------------------------------
// R4 has no role exemption (plan section 6): the office closes the ENTRY, it does not
// clock ITSELF out of an unfinished clean. And a role that holds no checklist there is
// not gated at all - the rule is per assignment, never per role.
for (const [label, token, uid, entryId] of [['O', 't-owner', 'u_owner', 'e_own'], ['A', 't-admin', 'u_admin', 'e_adm']]) {
  reset({ results: [result({ completed_by_user_id: uid, completed_count: 2, total_count: 12 })],
    entries: [openEntry(entryId, uid)] });
  fake.tables.org_state[0].state.clients[0].crewChecklists[uid] = 'it_a';
  fake.tables.jobs[0].data.crewIds.push(uid);
  r = await clockOut(token, entryId);
  eq(`${label} own entry, their own checklist unfinished -> 409`, r.status, 409);
  eq(`${label} 409 progress`, `${r.body?.done}/${r.body?.total}`, '2/12');

  reset({ results: [], entries: [openEntry(entryId, uid)] });   // no assignment for them
  r = await clockOut(token, entryId);
  eq(`${label} own entry with NO checklist -> 200`, r.status, 200);
}

// An entry with no clean (a manual row, or a job since deleted): no clean means no
// checklist, so it closes with no gate at all.
reset({ results: [], entries: [{ ...openEntry('e_nojob', 'u_c1'), job_id: null }] });
r = await clockOut('t-c1', 'e_nojob');
eq('an entry with job_id null closes, ungated', r.status, 200);
eq('...and costs no checklist_results read',
  fake.requests.filter((q) => q.path === '/rest/v1/checklist_results').length, 0);

// -- S2. the LIVE clock-out fails CLOSED, retryably, and leaks nothing --------
for (const table of ['checklist_results', 'org_state', 'jobs']) {
  reset({ results: [result()] });
  fake.fail(table, `permission denied for relation ${table}`);
  r = await clockOut('t-c1', 'e_c1');
  eq(`a ${table} read failure -> 503, never 200`, r.status, 503);
  eq(`${table}: the retryable code`, r.body?.code, CHECKLIST_CHECK_FAILED_CODE);
  eq(`${table}: the plain message`, r.body?.error, CHECKLIST_CHECK_FAILED_ERROR);
  eq(`${table}: no other keys`, Object.keys(r.body || {}).sort().join(','), 'code,error');
  ok(`${table}: no provider text leaks`, !JSON.stringify(r.body).includes('permission denied'), JSON.stringify(r.body));
  ok(`${table}: the entry stays OPEN (failed closed)`, fake.tables.time_entries.find((e) => e.id === 'e_c1')?.clock_out_at === null);
  fake.clearFailures();
}

// -- S1. a buffered REPLAY is never refused by a failed check -----------------
// THE LAW II.8: the work already happened and the punch is its only record. An
// unreadable gate must not turn a replay into a 500 that records nothing.
for (const table of ['checklist_results', 'org_state', 'jobs']) {
  reset({ results: [result()] });
  fake.fail(table, `permission denied for relation ${table}`);
  r = await call('replay', { token: 't-c1', body: { clientPunchId: `op_f_${table}`, entryId: 'e_c1', assertedOutAt: '2026-09-27T15:00:00.000Z' } });
  eq(`replay with ${table} unreadable -> 200, never 500`, r.status, 200);
  const row = fake.tables.time_entries.find((e) => e.id === 'e_c1');
  ok(`${table}: the clock-out IS recorded`, !!row?.clock_out_at, String(row?.clock_out_at));
  ok(`${table}: flagged unknown`, String(row?.note || '').includes(CHECKLIST_UNKNOWN_NOTE), `note=${row?.note}`);
  eq(`${table}: approval stays pending`, row?.approval_status, 'pending');
  ok(`${table}: no provider text in the note`, !String(row?.note || '').includes('permission denied'), String(row?.note));
  fake.clearFailures();
}
reset({ results: [], entries: [] });
fake.fail('checklist_results', 'boom');
r = await call('replay', { token: 't-c1', body: { clientPunchId: 'op_f_in', jobId: 'j1', assertedInAt: '2026-09-27T13:05:00.000Z', assertedOutAt: '2026-09-27T15:00:00.000Z' } });
eq('a buffered clock-in+out with the gate unreadable -> 200', r.status, 200);
ok('...and it carries the unknown flag',
  String(fake.tables.time_entries.find((e) => e.client_punch_id === 'op_f_in')?.note || '').includes(CHECKLIST_UNKNOWN_NOTE));
fake.clearFailures();

// -- S3. the gate's read is COMPLETE, not the newest N -----------------------
// A cleaner who re-opens their checklist to add notes makes a row each time. With a
// newest-50 cap, a COMPLETE submission buried under 51 later partials read as unfinished
// and the cleaner was refused over a checklist they had actually finished.
{
  const many = [result({ id: 'cr_done', completed_count: 12, total_count: 12, performed_at: '2026-09-27T13:00:00.000Z' })];
  for (let i = 0; i < 60; i += 1) {
    many.push(result({ id: `cr_p${String(i).padStart(3, '0')}`, completed_count: 1, total_count: 12,
      performed_at: new Date(Date.parse('2026-09-27T14:00:00.000Z') + i * 60000).toISOString() }));
  }
  reset({ results: many });
  r = await clockOut('t-c1', 'e_c1');
  eq('a complete submission under 60 later partials still unlocks', r.status, 200);
}

// -- 8. the gate's cost -------------------------------------------------------
reset({ results: [result()] });
await clockOut('t-c1', 'e_c1');
const clRequests = fake.requests.filter((q) => q.path === '/rest/v1/checklist_results');
// A COMPLETE read is count-first then one page (pagedSelect): a couple of requests for a
// handful of rows, not a scan and not a newest-N guess.
ok('the gate reads checklist_results in a bounded complete read', clRequests.length >= 2 && clRequests.length <= 3, `${clRequests.length} requests`);
eq('...one HEAD count', clRequests.filter((q) => q.method === 'HEAD').length, 1);
ok('...the rest are paged GETs', clRequests.slice(1).every((q) => q.method === 'GET'));
ok('...narrow columns, never select *', clRequests.every((q) => q.select && q.select !== '*'), clRequests.map((q) => q.select).join('|'));

// S4 - what the gate ACTUALLY costs. It resolves the clean's context exactly as clock-in
// does, so the blob and the job ARE read on every crew clock-out; only the
// checklist_results read is skipped when there is nothing to check.
reset({ results: [] });
await clockOut('t-c4', 'e_c4');
eq('a cleaner with no checklist costs no checklist_results read at all',
  fake.requests.filter((q) => q.path === '/rest/v1/checklist_results').length, 0);
ok('...but the blob and the job are still read (as clock-in does)',
  fake.requests.some((q) => q.path === '/rest/v1/org_state') && fake.requests.some((q) => q.path === '/rest/v1/jobs'));
reset({ results: [] });
await clockOut('t-c3', 'e_c3');
eq('the block switch short-circuits before the read too',
  fake.requests.filter((q) => q.path === '/rest/v1/checklist_results').length, 0);

ok('the fake saw no unexpected route', fake.unknown.length === 0, fake.unknown.join(' · '));

clearTimeout(watchdog);
await fake.close();
for (const f of fails) console.error(`✖ ${f}`);
console.log(`\n${pass}/${pass + fails.length} clock-out checklist-gate route cases green`);
process.exit(fails.length ? 1 : 0);
