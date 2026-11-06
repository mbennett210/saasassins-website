// Matt's time-clock rules of 2026-09-29, driven through the REAL api/time/[...path].js
// handler and the REAL supabase-js client against scripts/fake-supabase-http.mjs on
// 127.0.0.1 (the offline-drive pattern; no sandbox project exists — CS-033). Nothing leaves
// this machine: SUPABASE_URL points at the fake before the handler is imported, and the run
// refuses to go on otherwise.
//
// What it pins:
//   · PAY-11 — a reason is REQUIRED on every manager edit of a punch: time/correct and
//     time/manual, as time/void always was. 400 `reason-required`, nothing written, and
//     whitespace is not a reason. Restore stays reason-optional (it asserts no times).
//   · PAY-13 / CS-318 — a cleaner cannot be clocked in to two cleans at once. A LIVE
//     clock-in while an open punch exists at ANOTHER clean is 409, naming that clean; a
//     punch with a NULL job_id counts (the shape the old index missed entirely); a manager
//     (the punch bypass) may override and the punch they open is FLAGGED; and an offline
//     REPLAY is NEVER refused — it is accepted and flagged (THE LAW II.8).
//   · PAY-10 — a shift the auto-close cron closed carries the marker the approval queue
//     shows ('auto_closed' + an edit_history line).
//
//   node app/scripts/test-time-rules-pay.mjs
import { startFakeSupabase } from './fake-supabase-http.mjs';

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ORG = '00000000-0000-0000-0000-000000000001';
const CRON = 'cron-secret-for-the-fake';
const watchdog = setTimeout(() => { console.error('test-time-rules-pay: timed out'); process.exit(1); }, 60000);

const TOKENS = {
  't-c1': { id: 'a-c1', email: 'c1@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
  't-c2': { id: 'a-c2', email: 'c2@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_c2', org_id: ORG } },
  't-owner': { id: 'a-ow', email: 'ow@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
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
// Asserted against the SHARED rule modules themselves, never a restated sentence (II.3).
const { TIME_REFUSALS } = await import('../src/lib/timeRules.js');
const {
  DOUBLE_PUNCH_CODE, doublePunchMessage, overlapFlagNote, overlapFlagOf, overlapFlagChip,
  blockingOpenPunch, openPunchLabel,
} = await import('../src/lib/openPunchRule.js');
const { punchFlags } = await import('../src/lib/filters/timeApprovals.js');

const START_A = '2026-09-28T13:00:00.000Z';
const END_A = '2026-09-28T16:00:00.000Z';
const START_B = '2026-09-28T17:00:00.000Z';
const END_B = '2026-09-28T20:00:00.000Z';

const user = (id, role, extra = {}) => ({ id, role, status: 'active', name: id, email: `${id.slice(2)}@cs.co`, pay: { type: 'hourly', hourlyRate: 20 }, ...extra });
const baseState = () => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [user('u_c1', 'crew'), user('u_c2', 'crew'), user('u_owner', 'owner'), user('u_mgr', 'manager')],
  // u_mgr supervises both customers, so the manager-write scope rule never masks what this
  // suite is about. No crewChecklists anywhere: the clock-out block is a different rule.
  clients: [
    { id: 'c_bay', name: 'Coral Bay HOA', supervisorId: 'u_mgr' },
    { id: 'c_pac', name: 'Pacific Tower', supervisorId: 'u_mgr' },
  ],
  sites: [
    { id: 's_bay', clientId: 'c_bay', name: 'Bay clubhouse', expectedCleanMins: 120, geofenceEnabled: false },
    { id: 's_pac', clientId: 'c_pac', name: 'Pacific lobby', expectedCleanMins: 120, geofenceEnabled: false },
  ],
  permissions: [],
  userPermissionOverrides: [],
  opsSettings: { defaultGeofenceRadiusM: 150, offlineReplayWindowHours: 12, autoCloseGraceMins: 120 },
});

// row_version is NOT NULL DEFAULT 0 and every punch UPDATE is a CAS on it, so a fixture
// without one is not a row this schema can produce.
const openEntry = (id, userId, over = {}) => ({
  id, organization_id: ORG, job_id: 'j_bay', client_id: 'c_bay', site_id: 's_bay', user_id: userId,
  client_name: 'Coral Bay HOA', site_name: 'Bay clubhouse', user_name: userId,
  clock_in_at: '2026-09-28T13:05:00.000Z', clock_out_at: null, status: 'in_progress',
  scheduled_start: START_A, scheduled_end: END_A, approval_status: 'pending', edit_history: [],
  client_punch_id: null, duration_minutes: null, row_version: 0, ...over,
});
const closedEntry = (id, userId, over = {}) => openEntry(id, userId, {
  clock_out_at: '2026-09-28T15:00:00.000Z', duration_minutes: 115, status: 'completed', ...over,
});

function reset({ entries = [] } = {}) {
  fake.tables.org_state.splice(0, fake.tables.org_state.length,
    { organization_id: ORG, state: baseState(), version: 57, updated_at: '2026-09-28T12:00:00.000Z', protected_fingerprint: null });
  fake.tables.jobs = [
    { id: 'j_bay', organization_id: ORG, site_id: 's_bay', client_id: 'c_bay', start_at: START_A,
      data: { id: 'j_bay', clientId: 'c_bay', siteId: 's_bay', startAt: START_A, endAt: END_A, status: 'in_progress', crewIds: ['u_c1', 'u_c2', 'u_mgr'] } },
    { id: 'j_pac', organization_id: ORG, site_id: 's_pac', client_id: 'c_pac', start_at: START_B,
      data: { id: 'j_pac', clientId: 'c_pac', siteId: 's_pac', startAt: START_B, endAt: END_B, status: 'upcoming', crewIds: ['u_c1', 'u_c2', 'u_mgr'] } },
  ];
  fake.tables.time_entries = entries;
  fake.tables.checklist_results = [];
  fake.tables.payroll_runs = [];
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
const rowsIn = () => fake.tables.time_entries;
const byId = (id) => rowsIn().find((e) => e.id === id) || null;
// The COMMITTED row for a clean — these assertions are about what was written, and the fake's
// insert().select().single() hands back an array rather than the object supabase-js returns.
const rowForJob = (jobId) => rowsIn().filter((e) => e.job_id === jobId).slice(-1)[0] || null;

// ════════════════════ PAY-11 · a reason on every manager edit ════════════════════
{
  // ── correct ──
  reset({ entries: [closedEntry('e1', 'u_c1')] });
  let r = await call('correct', { token: 't-owner', body: { entryId: 'e1', version: 0, patch: { clock_out_at: '2026-09-28T15:30:00.000Z' } } });
  eq('PAY-11 correct with NO reason → 400', r.status, 400);
  eq('…with the shared code', r.body?.code, 'reason-required');
  eq('…and the shared sentence', r.body?.error, TIME_REFUSALS['reason-required']);
  eq('…and NOTHING was written', byId('e1').clock_out_at, '2026-09-28T15:00:00.000Z');
  eq('…the version did not move either', byId('e1').row_version, 0);

  reset({ entries: [closedEntry('e1', 'u_c1')] });
  r = await call('correct', { token: 't-owner', body: { entryId: 'e1', version: 0, reason: '   ', patch: { clock_out_at: '2026-09-28T15:30:00.000Z' } } });
  eq('PAY-11 whitespace is not a reason → 400', r.status, 400);
  eq('…nothing written', byId('e1').clock_out_at, '2026-09-28T15:00:00.000Z');

  reset({ entries: [closedEntry('e1', 'u_c1')] });
  r = await call('correct', { token: 't-owner', body: { entryId: 'e1', version: 0, reason: '  left at 3:30, confirmed with the supervisor  ', patch: { clock_out_at: '2026-09-28T15:30:00.000Z' } } });
  eq('PAY-11 correct WITH a reason → 200', r.status, 200);
  eq('…the correction landed', byId('e1').clock_out_at, '2026-09-28T15:30:00.000Z');
  ok('…and the TRIMMED reason is in the history',
    (byId('e1').edit_history || []).some((h) => h.reason === 'left at 3:30, confirmed with the supervisor'),
    JSON.stringify(byId('e1').edit_history));

  // ── manual (Add time) ──
  reset({ entries: [] });
  r = await call('manual', { token: 't-owner', body: { userId: 'u_c1', jobId: 'j_bay', clockInAt: '2026-09-28T13:00:00.000Z', clockOutAt: '2026-09-28T15:00:00.000Z' } });
  eq('PAY-11 manual with NO reason → 400', r.status, 400);
  eq('…with the shared code', r.body?.code, 'reason-required');
  eq('…and no row was created', rowsIn().length, 0);

  r = await call('manual', { token: 't-owner', body: { userId: 'u_c1', jobId: 'j_bay', clockInAt: '2026-09-28T13:00:00.000Z', clockOutAt: '2026-09-28T15:00:00.000Z', reason: 'forgot to clock in' } });
  eq('PAY-11 manual WITH a reason → 200', r.status, 200);
  eq('…the row exists', rowsIn().length, 1);

  // ── void (Delete) was always gated; it now runs the SAME shared rule ──
  reset({ entries: [closedEntry('e1', 'u_c1')] });
  r = await call('void', { token: 't-owner', body: { entryId: 'e1', version: 0 } });
  eq('PAY-11 delete with no reason is still 400', r.status, 400);
  eq('…same code', r.body?.code, 'reason-required');
  r = await call('void', { token: 't-owner', body: { entryId: 'e1', version: 0, reason: 'duplicate punch' } });
  eq('PAY-11 delete WITH a reason → 200', r.status, 200);
  eq('…it is voided', byId('e1').status, 'voided');

  // ── restore is NOT an edit of the times: reason stays optional ──
  r = await call('restore', { token: 't-owner', body: { entryId: 'e1', version: byId('e1').row_version } });
  eq('PAY-11 restore with NO reason still succeeds (it asserts no times)', r.status, 200);
  eq('…restored as completed', byId('e1').status, 'completed');
}

// ════════════════ PAY-13 / CS-318 · one clean at a time ═════════════════════════
{
  // The pure rule first: which open punch blocks a new one.
  const open = [
    { id: 'o_same', job_id: 'j_bay', clock_in_at: '2026-09-28T13:00:00.000Z', clock_out_at: null },
    { id: 'o_other', job_id: 'j_pac', clock_in_at: '2026-09-28T12:00:00.000Z', clock_out_at: null, client_name: 'Pacific Tower' },
    { id: 'o_nojob', job_id: null, clock_in_at: '2026-09-28T11:00:00.000Z', clock_out_at: null },
  ];
  eq('rule: a punch on the SAME clean never blocks', blockingOpenPunch([open[0]], 'j_bay'), null);
  eq('rule: a punch on ANOTHER clean blocks', blockingOpenPunch([open[0], open[1]], 'j_bay')?.id, 'o_other');
  // CS-318's exact gap: job_id is nullable, so `time_entries_one_open_per_user_job`
  // constrained those rows by nothing at all.
  eq('rule: a punch with NO clean blocks too (the index missed these)', blockingOpenPunch([open[2]], 'j_bay')?.id, 'o_nojob');
  eq('rule: the EARLIEST open punch is the one reported', blockingOpenPunch(open, 'j_bay')?.id, 'o_nojob');
  eq('rule: a CLOSED punch never blocks', blockingOpenPunch([{ id: 'x', job_id: 'j_pac', clock_out_at: '2026-09-28T12:30:00.000Z' }], 'j_bay'), null);
  eq('rule: no rows → nothing blocks', blockingOpenPunch([], 'j_bay'), null);
  eq('rule: the clean is NAMED by its customer', openPunchLabel(open[1]), 'Pacific Tower');
  eq('rule: no name recorded → null, never an id', openPunchLabel(open[2]), null);

  // ── the LIVE refusal ──
  reset({ entries: [openEntry('e_open', 'u_c1')] });   // u_c1 is on the clock at Coral Bay
  let r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_pac' } });
  eq('LIVE clock-in at a second clean → 409', r.status, 409);
  eq('…with its own code, not the one-open-per-job duplicate', r.body?.code, DOUBLE_PUNCH_CODE);
  eq('…and the message NAMES the clean they are still on', r.body?.error, doublePunchMessage('Coral Bay HOA'));
  eq('…which the body also carries for the UI', r.body?.openCleanName, 'Coral Bay HOA');
  eq('…no second punch was created', rowsIn().length, 1);

  // Closing the first punch frees the second clock-in.
  reset({ entries: [closedEntry('e_done', 'u_c1')] });
  r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_pac' } });
  eq('once the first punch is CLOSED the next clock-in is allowed', r.status, 200);
  eq('…two rows now', rowsIn().length, 2);
  eq('…and the new punch carries no overlap flag', overlapFlagOf(rowForJob('j_pac')), null);

  // An open punch with NO clean blocks as well (CS-318's un-constrained shape).
  reset({ entries: [openEntry('e_nojob', 'u_c1', { job_id: null, client_id: null, client_name: null, site_name: null })] });
  r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_bay' } });
  eq('an open punch with NO clean blocks too → 409', r.status, 409);
  eq('…and says "another clean" when it has no name', r.body?.error, doublePunchMessage(null));

  // Another cleaner's open punch is irrelevant.
  reset({ entries: [openEntry('e_other_person', 'u_c2')] });
  r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_pac' } });
  eq("ANOTHER cleaner's open punch does not block this one", r.status, 200);

  // Re-tapping the SAME clean must NOT hit this rule — it is the pre-existing
  // one-open-per-(user, job) duplicate, which the real table enforces with the partial unique
  // index `time_entries_one_open_per_user_job` (migration 20260614100000). The fake PostgREST
  // does not emulate partial unique indexes, so what is asserted here is the half this change
  // owns: the double-punch refusal never fires for the cleaner's own open punch on THIS clean.
  reset({ entries: [openEntry('e_open', 'u_c1')] });
  r = await call('clock-in', { token: 't-c1', body: { jobId: 'j_bay' } });
  ok('re-tapping the SAME clean is NOT the double-punch refusal', r.body?.code !== DOUBLE_PUNCH_CODE, JSON.stringify(r.body));

  // ── the MANAGER override ──
  reset({ entries: [openEntry('e_open_mgr', 'u_mgr')] });
  r = await call('clock-in', { token: 't-mgr', body: { jobId: 'j_pac' } });
  eq('a manager (the punch bypass) may OVERRIDE the refusal', r.status, 200);
  const flagged = rowForJob('j_pac');
  ok('…and the punch they open is FLAGGED', !!overlapFlagOf(flagged), JSON.stringify(flagged?.note));
  eq('…naming the clean they were still on', overlapFlagOf(flagged)?.clean, 'Coral Bay HOA');
  ok('…which the approval queue shows as a chip',
    punchFlags(flagged).includes(overlapFlagChip(flagged)), JSON.stringify(punchFlags(flagged)));
  eq('…the chip wording', overlapFlagChip(flagged), 'Two cleans at once');
  // `approval_status` is `not null default 'pending'` on the table (20260614100000) and the
  // insert never names it, so the fake — which applies no column defaults — leaves it unset.
  // What matters is that nothing on this path pre-approves an overlapping punch.
  ok('…and it is not pre-approved', flagged.approval_status !== 'approved', String(flagged.approval_status));

  // ── the offline REPLAY is NEVER refused (THE LAW II.8) ──
  reset({ entries: [openEntry('e_open', 'u_c1')] });
  const assertedIn = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const assertedOut = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  r = await call('replay', { token: 't-c1', body: { clientPunchId: 'op_overlap_1', jobId: 'j_pac', assertedInAt: assertedIn, assertedOutAt: assertedOut } });
  eq('a buffered punch overlapping another open clean is ACCEPTED', r.status, 200);
  const replayed = rowForJob('j_pac');
  ok('…and FLAGGED so it shows at approval', !!overlapFlagOf(replayed), JSON.stringify(replayed?.note));
  eq('…naming the open clean', overlapFlagOf(replayed)?.clean, 'Coral Bay HOA');
  eq('…the recorded flag is the builder\'s own sentence', overlapFlagOf(replayed)?.clean
    && replayed.note.includes(overlapFlagNote('Coral Bay HOA')), true);
  eq('…awaiting approval', replayed.approval_status, 'pending');
  ok('…and the punch it overlapped is untouched', byId('e_open').clock_out_at === null);

  // A replay with nothing else open carries no flag.
  reset({ entries: [] });
  r = await call('replay', { token: 't-c1', body: { clientPunchId: 'op_clean_1', jobId: 'j_pac', assertedInAt: assertedIn, assertedOutAt: assertedOut } });
  eq('an ordinary replay is unflagged', overlapFlagOf(rowForJob('j_pac')), null);
}

// ═════════════════ PAY-10 · an auto-closed shift says so ════════════════════════
{
  // The cron closes a punch left open past its scheduled end + grace, AT the scheduled end
  // (Matt's note: "the system will clock them out at 4 pm and ask for approval").
  reset({ entries: [openEntry('e_forgot', 'u_c1', { scheduled_end: '2020-01-01T16:00:00.000Z', scheduled_start: '2020-01-01T13:00:00.000Z', clock_in_at: '2020-01-01T13:05:00.000Z' })] });
  const r = await call('auto-close', { method: 'POST', headers: { authorization: `Bearer ${CRON}` } });
  eq('the auto-close cron ran', r.status, 200);
  const closed = byId('e_forgot');
  eq('PAY-10 it is closed at the SCHEDULED end, not now', closed.clock_out_at, '2020-01-01T16:00:00.000Z');
  eq('PAY-10 the marker is on the row', closed.status, 'auto_closed');
  ok('PAY-10 the history records it',
    (closed.edit_history || []).some((h) => h.to === 'auto_closed'), JSON.stringify(closed.edit_history));
  eq('PAY-10 it still needs approval', closed.approval_status, 'pending');
  // 🔴 The flag the approver actually sees.
  ok('PAY-10 the approval queue shows an "Auto-closed" chip',
    punchFlags(closed).includes('Auto-closed'), JSON.stringify(punchFlags(closed)));
}

clearTimeout(watchdog);
await fake.close();
console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
