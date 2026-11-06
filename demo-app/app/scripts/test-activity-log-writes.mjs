// CS-379 — the activity log's WRITE POINTS, driven through the real handlers.
//
// test-activity-log.mjs proves the vocabulary, the visibility, retention and the exports, and
// checks by source that each route reaches the writer. This suite proves the rows are actually
// WRITTEN, and written right: one row per action, the actor from the verified JWT claim, the
// before/after LOG-3 asks for, and nothing logged for an action that was refused or was a
// no-op. Every handler is the real one, driven through scripts/fake-supabase.mjs — no network,
// no credentials, no live project.
//
//   time    correct / add by hand / delete / restore / approve / approve overtime   (LOG-2)
//   qc      inspection submitted, inspection edited, ticket status, ticket reply
//   jobs    created / moved / crew changed / cancelled / deleted                    (LOG-2)
//   codes   the door / alarm reveal that used to reach only the console             (CS-081)
//   crons   the alerts and escalations a cron raised with nobody watching           (LOG-7)
//
//   node app/scripts/test-activity-log-writes.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { actorLabel as pureActorLabel } from '../src/lib/activityLog.js';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.OPS_CODE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.CRON_SECRET = 'cron-test-secret';
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const { encrypt } = await import('../api/_lib/crypto.js');
const timeRoute = (await import('../api/time/[...path].js')).default;
const qcRoute = (await import('../api/qc/[...path].js')).default;
const siteSecurity = (await import('../api/site-security/[...path].js')).default;
const jobsDelta = (await import('../api/state/jobs-delta.js')).default;
const opsAlerts = await import('../api/cron/ops-alerts.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── the people ───────────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false }, // claim-less, exactly as live
  crew: { id: 'u_crew', role: 'crew', claim: true },
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: 'active', name: `${k} person`,
}));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k),
  app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));

const H = 3600e3;
const NOW = Date.parse('2026-09-29T18:00:00.000Z');
const iso = (ms) => new Date(NOW + ms).toISOString();

const SITE = { id: 'st_1', clientId: 'cl_1', name: 'Acme HQ', lat: 26.1, lng: -80.1, geofenceRadiusM: 150 };
const stateFor = () => ({
  users: roster.map((u) => ({ ...u })),
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  clients: [{ id: 'cl_1', name: 'Acme Tower', supervisorId: 'u_mgr', standingCrewIds: [] }],
  sites: [{ ...SITE, security: { doorCodeCipher: encrypt('4321', 'OPS_CODE_ENCRYPTION_KEY'), alarmCodeCipher: encrypt('9876', 'OPS_CODE_ENCRYPTION_KEY') } }],
  opsSettings: { defaultGeofenceRadiusM: 150, offlineReplayWindowHours: 12 },
  company: { timezone: 'America/New_York' },
});

// `row_version` is NOT NULL DEFAULT 0 on the real table and every punch UPDATE is a CAS on
// it, so a fixture without one is not a row this schema can produce.
const punch = (p = {}) => ({
  id: 'te_1', organization_id: ORG, job_id: 'j1', client_id: 'cl_1', client_name: 'Acme Tower',
  site_id: 'st_1', user_id: 'u_crew', user_name: 'crew person',
  clock_in_at: iso(-4 * H), clock_out_at: iso(-2 * H), status: 'completed',
  scheduled_start: iso(-4 * H), scheduled_end: iso(-2 * H), approval_status: 'pending',
  edit_history: [], client_punch_id: null, duration_minutes: 120, row_version: 0, ...p,
});

function buildWorld(tables = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: stateFor(), protected_fingerprint: null, updated_at: '2026-09-29T00:00:00.000Z' }],
      activity_log: [],
      activity_log_baseline: [],
      time_entries: [],
      problem_reports: [],
      inspection_records: [],
      inspection_items: [],
      work_order_messages: [],
      jobs: [],
      payroll_runs: [],
      ot_approvals: [],
      crew_assignments: [],
      account_media: [],
      ...tables,
    },
    logins,
  });
}

async function call(handler, { method = 'POST', path, token, query = {}, body } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  if (token === 'cron') req.headers = { authorization: `Bearer ${process.env.CRON_SECRET}` };
  req.query = { ...query, ...(path ? { subpath: path } : {}) };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}

const logRows = () => world.tables.activity_log || [];
const rowFor = (action) => logRows().filter((r) => r.action === action);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 180)}`;

console.log('CS-379 activity log — the write points, through the real handlers:\n');

// ── TIME: the five manager edits and the two approvals (LOG-2) ───────────────
{
  buildWorld({ time_entries: [punch()] });
  const r = await call(timeRoute, {
    path: 'correct', token: 'tok-owner',
    body: { entryId: 'te_1', version: 0, reason: 'clock-in was 15 minutes early', patch: { clock_in_at: iso(-3.75 * H) } },
  });
  ok('time/correct succeeds', r.status === 200, show(r));
  const rows = rowFor('time.corrected');
  ok('… and writes exactly ONE time.corrected row', rows.length === 1, `${rows.length} rows: ${JSON.stringify(logRows().map((x) => x.action))}`);
  ok('… naming the cleaner and the reason the manager had to give (PAY-11)',
    /crew person/.test(rows[0]?.summary || '') && /15 minutes early/.test(rows[0]?.summary || ''), rows[0]?.summary);
  ok('… with the clock times BEFORE and AFTER (LOG-3)',
    rows[0]?.before?.startAt === iso(-4 * H) && rows[0]?.after?.startAt === iso(-3.75 * H),
    JSON.stringify({ before: rows[0]?.before, after: rows[0]?.after }));
  ok('… the actor is the login\'s claim, not the body', rows[0]?.actor_user_id === 'u_owner' && rows[0]?.actor_role === 'owner');
  ok('… the actor NAME is denormalized, so a rename can\'t rewrite history', rows[0]?.actor_name === 'owner person');
  ok('… the customer rides the row, so it reaches that customer\'s tab', rows[0]?.client_id === 'cl_1');
  ok('… and it is not a money row (an hours edit is not a pay change)', rows[0]?.is_money === false);
}
{
  // A REFUSED edit logs nothing: PAY-11 refuses a correction with no reason.
  buildWorld({ time_entries: [punch()] });
  const r = await call(timeRoute, { path: 'correct', token: 'tok-owner', body: { entryId: 'te_1', version: 0, patch: { clock_in_at: iso(-3 * H) } } });
  ok('🔴 a REFUSED time edit (no reason given) writes nothing to the log', r.status === 400 && logRows().length === 0, show(r));
}
{
  buildWorld({ jobs: [] });
  const r = await call(timeRoute, {
    path: 'manual', token: 'tok-owner',
    body: { userId: 'u_crew', clockInAt: iso(-6 * H), clockOutAt: iso(-5 * H), reason: 'forgot to clock in' },
  });
  ok('time/manual succeeds', r.status === 200, show(r));
  ok('… and writes ONE time.added row with the reason', rowFor('time.added').length === 1 && /forgot to clock in/.test(rowFor('time.added')[0]?.summary || ''));
}
{
  buildWorld({ time_entries: [punch()] });
  const r = await call(timeRoute, { path: 'void', token: 'tok-owner', body: { entryId: 'te_1', version: 0, reason: 'duplicate punch' } });
  ok('time/void succeeds', r.status === 200, show(r));
  const row = rowFor('time.deleted')[0];
  ok('… and writes ONE time.deleted row, with the status before and after',
    rowFor('time.deleted').length === 1 && row?.before?.status === 'completed' && row?.after?.status === 'voided',
    JSON.stringify({ before: row?.before, after: row?.after }));
}
{
  buildWorld({ time_entries: [punch({ status: 'voided' })] });
  const r = await call(timeRoute, { path: 'restore', token: 'tok-owner', body: { entryId: 'te_1', version: 0, reason: 'voided by mistake' } });
  ok('time/restore succeeds', r.status === 200, show(r));
  ok('… and writes ONE time.restored row', rowFor('time.restored').length === 1, JSON.stringify(logRows().map((x) => x.action)));
}
{
  buildWorld({ time_entries: [punch(), punch({ id: 'te_2', approval_status: 'approved' })] });
  const r = await call(timeRoute, { path: 'approve', token: 'tok-owner', body: { items: [{ entryId: 'te_1', version: 0 }, { entryId: 'te_2', version: 0 }] } });
  ok('time/approve succeeds for both items', r.status === 200 && r.body.results.every((x) => x.ok), show(r));
  ok('🔴 … and logs ONE row — only the punch that actually moved to approved (the other was already approved)',
    rowFor('time.approved').length === 1 && rowFor('time.approved')[0]?.entity_id === 'te_1',
    JSON.stringify(logRows().map((x) => [x.action, x.entity_id])));
  ok('… with the approval status before and after',
    rowFor('time.approved')[0]?.before?.status === 'pending' && rowFor('time.approved')[0]?.after?.status === 'approved');
}
{
  buildWorld();
  const r = await call(timeRoute, {
    path: 'ot-approve', token: 'tok-owner',
    body: { items: [{ userId: 'u_crew', weekKey: '2026-09-27', clientId: 'cl_1', minutes: 300 }] },
  });
  ok('time/ot-approve succeeds', r.status === 200 && r.body.results?.[0]?.ok === true, show(r));
  const row = rowFor('time.overtime_approved')[0];
  ok('… and writes ONE time.overtime_approved row with the week and the TOTAL approved hours',
    rowFor('time.overtime_approved').length === 1 && /2026-09-27/.test(row?.summary || '') && /5\.00 h/.test(row?.summary || ''),
    row?.summary);
  ok('… carrying the customer whose overtime it is', row?.client_id === 'cl_1' && row?.client_name === 'Acme Tower');
}

// ── QC: inspections and tickets ──────────────────────────────────────────────
const inspection = (p = {}) => ({
  id: 'ir_1', organization_id: ORG, client_id: 'cl_1', client_name: 'Acme Tower', site_id: 'st_1', site_name: 'Acme HQ',
  inspector_user_id: 'u_mgr', template_id: 'it_1', template_name: 'Monthly walk',
  template_snapshot: { name: 'Monthly walk', rating_scale: { type: 'passfail', passThreshold: 80 } },
  status: 'draft', overall_score: null, result: null, performed_at: null, ...p,
});
{
  buildWorld({ inspection_records: [inspection()] });
  const items = [{ item_key: 'a', label: 'Lobby', rating: 'pass' }, { item_key: 'b', label: 'Restrooms', rating: 'pass' }];
  const r = await call(qcRoute, { path: 'inspections/submit', token: 'tok-owner', body: { id: 'ir_1', items } });
  ok('qc/inspections/submit succeeds', r.status === 200, show(r));
  const row = rowFor('inspection.submitted')[0];
  ok('… and writes ONE inspection.submitted row', rowFor('inspection.submitted').length === 1, JSON.stringify(logRows().map((x) => x.action)));
  ok('… naming the site and the result, with the score after (LOG-3)',
    /Acme HQ/.test(row?.summary || '') && row?.after?.status === 'submitted' && row?.after?.score === 100,
    JSON.stringify({ summary: row?.summary, after: row?.after }));

  // A RE-submit of an already-submitted inspection is an EDIT, with the score before and after.
  const r2 = await call(qcRoute, { path: 'inspections/submit', token: 'tok-owner', body: { id: 'ir_1', items: [items[0], { item_key: 'b', label: 'Restrooms', rating: 'fail' }] } });
  ok('a re-submit succeeds', r2.status === 200, show(r2));
  const edit = rowFor('inspection.edited')[0];
  ok('🔴 … and is logged as inspection.EDITED, not a second submission',
    rowFor('inspection.edited').length === 1 && rowFor('inspection.submitted').length === 1);
  ok('… with the score before and after', edit?.before?.score === 100 && edit?.after?.score === 50,
    JSON.stringify({ before: edit?.before, after: edit?.after }));
}
const ticket = (p = {}) => ({
  id: 'pr_1', organization_id: ORG, client_id: 'cl_1', client_name: 'Acme Tower', site_id: 'st_1',
  title: 'Spill in the lobby', description: '', type: 'issue', origin: 'internal', category: null,
  priority: 'normal', status: 'open', created_at: iso(-5 * H), reported_by_user_id: 'u_crew', ...p,
});
{
  buildWorld({ problem_reports: [ticket()] });
  const r = await call(qcRoute, { path: 'problems/update', token: 'tok-owner', body: { id: 'pr_1', status: 'in_progress' } });
  ok('qc/problems/update succeeds', r.status === 200, show(r));
  const row = rowFor('ticket.status_changed')[0];
  ok('… and writes ONE ticket.status_changed row with the status before and after',
    rowFor('ticket.status_changed').length === 1 && row?.before?.status === 'open' && row?.after?.status === 'in_progress',
    JSON.stringify({ before: row?.before, after: row?.after }));
  ok('… naming the ticket', /Spill in the lobby/.test(row?.summary || ''), row?.summary);
}
{
  // A priority-only edit is NOT on the set list, so it logs nothing.
  buildWorld({ problem_reports: [ticket()] });
  const r = await call(qcRoute, { path: 'problems/update', token: 'tok-owner', body: { id: 'pr_1', priority: 'urgent' } });
  ok('🔴 a priority-only ticket edit logs nothing (LOG-2 lists status changes, not every field)',
    r.status === 200 && logRows().length === 0, show(r));
}
{
  buildWorld({ problem_reports: [ticket()] });
  const r = await call(qcRoute, { path: 'problems/message', token: 'tok-owner', body: { problemId: 'pr_1', body: 'Called the customer back.' } });
  ok('qc/problems/message succeeds', r.status === 200, show(r));
  const row = rowFor('ticket.replied')[0];
  ok('… and writes ONE ticket.replied row', rowFor('ticket.replied').length === 1);
  ok('🔴 … and the reply TEXT is not copied into the log (the thread is the record)',
    !/Called the customer back/.test(JSON.stringify(row || {})), JSON.stringify(row?.summary));
}

// ── CODES: the reveal that used to reach only the console (CS-081) ───────────
{
  buildWorld();
  const r = await call(siteSecurity, { path: 'reveal', token: 'tok-owner', body: { siteId: 'st_1', which: 'door' } });
  ok('site-security/reveal still answers the code', r.status === 200 && r.body.code === '4321', show(r));
  const row = rowFor('code.revealed')[0];
  ok('🔴 … and now writes a code.revealed row (it used to log ONLY to the console)', rowFor('code.revealed').length === 1);
  ok('… naming WHICH code and which site, with the customer', /Door code/.test(row?.summary || '') && /Acme HQ/.test(row?.summary || '') && row?.client_id === 'cl_1', row?.summary);
  ok('🔴 … and the plaintext CODE is never stored in the log', !String(JSON.stringify(row)).includes('4321'), JSON.stringify(row));
  const r2 = await call(siteSecurity, { path: 'reveal', token: 'tok-owner', body: { siteId: 'st_1', which: 'alarm' } });
  ok('an alarm reveal is logged as its own row', r2.status === 200 && rowFor('code.revealed').length === 2 && /Alarm code/.test(rowFor('code.revealed')[1]?.summary || ''));
}
{
  buildWorld();
  const r = await call(siteSecurity, { path: 'reveal', token: 'tok-crew', body: { siteId: 'st_1', which: 'door' } });
  ok('🔴 a REFUSED reveal logs nothing (an unassigned cleaner never saw a code)',
    r.status === 403 && logRows().length === 0, show(r));
}

// ── JOBS: the schedule changes (LOG-2) ──────────────────────────────────────
const jobPayload = (p = {}) => ({
  id: 'j_1', siteId: 'st_1', clientId: 'cl_1', crewIds: ['u_crew'],
  startAt: iso(24 * H), endAt: iso(26 * H), status: 'upcoming', ...p,
});
const jobRow = (payload) => ({
  organization_id: ORG, id: payload.id, site_id: payload.siteId, status: payload.status,
  start_at: payload.startAt, data: payload,
});
{
  buildWorld();
  const r = await call(jobsDelta, { token: 'tok-owner', body: { changed: [jobPayload()], removed: [], build: 1, tab: 't' } });
  ok('jobs-delta creates the clean', r.status === 200 && r.body.ok === true, show(r));
  ok('… and writes ONE job.created row for the right customer',
    rowFor('job.created').length === 1 && rowFor('job.created')[0]?.client_id === 'cl_1',
    JSON.stringify(logRows().map((x) => x.action)));
  // 🔴 The jobs path is the app's hottest write path, so it does NOT resolve the actor's NAME
  // (that would add an org_state read to every drag — test-jobs-delta-authz pins the budget).
  // The row keeps the id, which is the record, and the READER resolves the name from the
  // roster it already holds.
  ok('🔴 … with the actor id but no denormalized name (the hot path pays no name lookup)',
    rowFor('job.created')[0]?.actor_user_id === 'u_owner' && rowFor('job.created')[0]?.actor_name === null,
    JSON.stringify({ id: rowFor('job.created')[0]?.actor_user_id, name: rowFor('job.created')[0]?.actor_name }));
  ok('… and the reader names them from the roster', pureActorLabel(
    { actorUserId: 'u_owner', auto: false }, new Map(roster.map((u) => [u.id, u])),
  ) === 'owner person');
}
{
  const before = jobPayload();
  buildWorld({ jobs: [jobRow(before)] });
  const moved = { ...before, startAt: iso(48 * H), endAt: iso(50 * H) };
  const r = await call(jobsDelta, { token: 'tok-owner', body: { changed: [moved], removed: [], build: 1, tab: 't' } });
  ok('jobs-delta moves the clean', r.status === 200, show(r));
  const row = rowFor('job.moved')[0];
  ok('… and writes ONE job.moved row with the two times (LOG-3)',
    rowFor('job.moved').length === 1 && row?.before?.startAt === before.startAt && row?.after?.startAt === moved.startAt,
    JSON.stringify({ before: row?.before, after: row?.after }));
  ok('🔴 … and NO timestamp is baked into the sentence — the reader re-zones the pair (II.8)',
    !/\d{4}-\d{2}-\d{2}T/.test(row?.summary || ''), row?.summary);
}
{
  const before = jobPayload();
  buildWorld({ jobs: [jobRow(before)] });
  const r = await call(jobsDelta, { token: 'tok-owner', body: { changed: [{ ...before, crewIds: ['u_crew', 'u_mgr'] }], removed: [], build: 1, tab: 't' } });
  ok('jobs-delta re-crews the clean', r.status === 200, show(r));
  ok('… and writes ONE job.crew_changed row with both crews',
    rowFor('job.crew_changed').length === 1
    && rowFor('job.crew_changed')[0]?.before?.crewIds?.length === 1
    && rowFor('job.crew_changed')[0]?.after?.crewIds?.length === 2);
}
{
  const before = jobPayload();
  buildWorld({ jobs: [jobRow(before)] });
  const r = await call(jobsDelta, { token: 'tok-owner', body: { changed: [{ ...before, status: 'cancelled' }], removed: [], build: 1, tab: 't' } });
  ok('jobs-delta cancels the clean', r.status === 200, show(r));
  ok('… and writes ONE job.cancelled row — "who cancelled this clean?" is answerable',
    rowFor('job.cancelled').length === 1 && rowFor('job.cancelled')[0]?.actor_user_id === 'u_owner');
}
{
  const before = jobPayload();
  buildWorld({ jobs: [jobRow(before)] });
  // The delete goes through the `delete_jobs` RPC (it stamps the tombstone's actor) and falls
  // back to a plain delete when that migration isn't deployed. Answer PGRST202 so this drives
  // the fallback path, which is what a project without 20260903120000 applied really does.
  world.rpc = async (name) => ({ data: null, error: { code: 'PGRST202', message: `${name} not deployed` } });
  const r = await call(jobsDelta, { token: 'tok-owner', body: { changed: [], removed: ['j_1'], build: 1, tab: 't' } });
  ok('jobs-delta deletes the clean', r.status === 200, show(r));
  ok('… and writes ONE job.deleted row that still remembers when the clean was',
    rowFor('job.deleted').length === 1 && rowFor('job.deleted')[0]?.before?.startAt === before.startAt,
    JSON.stringify(rowFor('job.deleted')[0]?.before));
}
{
  // An ECHO — a stale tab re-posting a row it already saw — must add nothing to the trail.
  const before = jobPayload();
  buildWorld({ jobs: [jobRow(before)] });
  const r = await call(jobsDelta, { token: 'tok-owner', body: { changed: [before], removed: [], build: 1, tab: 't' } });
  ok('🔴 an unchanged re-post (the ping-pong echo) logs NOTHING',
    r.status === 200 && logRows().length === 0, `${show(r)} rows=${JSON.stringify(logRows().map((x) => x.action))}`);
}
{
  // A CREW write is sanitized, not refused (jobsGuard). Only what LANDED is logged.
  const before = jobPayload();
  buildWorld({ jobs: [jobRow(before)] });
  const r = await call(jobsDelta, { token: 'tok-crew', body: { changed: [{ ...before, crewIds: ['u_crew', 'u_mgr'] }], removed: [], build: 1, tab: 't' } });
  ok('a crew re-crew attempt answers 200 (sanitize-over-reject)', r.status === 200, show(r));
  ok('🔴 … and logs NOTHING, because the guard put the crew back — the log records what happened, not what was asked',
    rowFor('job.crew_changed').length === 0, JSON.stringify(logRows().map((x) => x.action)));
}

// ── CRONS: the automatic actions (LOG-7) ────────────────────────────────────
{
  // The raise→log orchestration, with the cron's own dependency injection: a late shift goes
  // out as alert.sent, and the checklist reminder that reached the SUPERVISOR (the cleaner was
  // reminded first) as alert.escalated.
  buildWorld();
  const logged = [];
  const due = [
    { id: 'a1', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_1', jobId: 'j_1', crewIds: ['u_crew'] },
    { id: 'a2', kind: 'checklistDue', recipientScope: 'crew', clientId: 'cl_1', jobId: 'j_1', crewIds: ['u_crew'], userId: 'u_crew' },
    { id: 'a3', kind: 'checklistDue', recipientScope: 'supervisor', clientId: 'cl_1', jobId: 'j_1', crewIds: ['u_crew'], missingUserIds: ['u_crew'] },
  ];
  const out = await opsAlerts.run(false, {
    now: NOW,
    readState: async () => ({ state: stateFor(), version: 3 }),
    writeState: async () => true,
    compute: async () => due,
    dispatch: async () => ({ sent: 0 }),
    pushReady: () => false,
    report: () => {},
    logAuto: async (rows) => { logged.push(...rows); return rows; },
  });
  ok('the ops-alert cron raised all three alerts', out.raised === 3, JSON.stringify(out));
  ok('… and logged one activity row per raised alert', logged.length === 3, JSON.stringify(logged.map((r) => r.action)));
  ok('🔴 a checklist reminder that reached the SUPERVISOR is logged as an ESCALATION',
    logged.filter((r) => r.action === 'alert.escalated').length === 1
    && logged.filter((r) => r.action === 'alert.sent').length === 2,
    JSON.stringify(logged.map((r) => [r.action, r.after?.to])));
  ok('… every automatic row carries no actor (a cron blames nobody)', logged.every((r) => r.auto === true));
  ok('… and carries the customer, so it reaches that customer\'s tab', logged.every((r) => r.clientId === 'cl_1'));
  ok('… with the bell\'s own words as the summary', logged.every((r) => typeof r.summary === 'string' && r.summary.length > 0),
    JSON.stringify(logged.map((r) => r.summary)));
}
{
  // dryRun writes nothing and must log nothing either.
  const logged = [];
  await opsAlerts.run(true, {
    now: NOW,
    readState: async () => ({ state: stateFor(), version: 3 }),
    writeState: async () => { throw new Error('dryRun must not write'); },
    compute: async () => ([{ id: 'a1', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_1', jobId: 'j_1', crewIds: [] }]),
    dispatch: async () => ({}), pushReady: () => false, report: () => {},
    logAuto: async (rows) => { logged.push(...rows); return rows; },
  });
  ok('🔴 a dryRun run logs nothing (it records nothing either)', logged.length === 0);
}
{
  // A CAS miss that never commits must not log an alert it did not record.
  const logged = [];
  let writes = 0;
  const out = await opsAlerts.run(false, {
    now: NOW,
    readState: async () => ({ state: stateFor(), version: 3 }),
    writeState: async () => { writes += 1; return false; }, // every attempt loses the CAS
    compute: async () => ([{ id: 'a1', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_1', jobId: 'j_1', crewIds: [] }]),
    dispatch: async () => ({}), pushReady: () => false, report: () => {},
    logAuto: async (rows) => { logged.push(...rows); return rows; },
  }).catch((e) => ({ threw: e.message }));
  ok('a run whose CAS never lands throws, as before', !!out.threw && writes > 1, JSON.stringify(out));
  ok('🔴 … and logged nothing — the log records what was recorded, not what was attempted', logged.length === 0);
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\nactivity log write points: ${pass}/${pass} passed`);
}
