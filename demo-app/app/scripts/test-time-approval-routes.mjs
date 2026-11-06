// Manager-time-approval WRITE routes (wave W1-A), driven through the REAL handlers with
// fake-supabase.mjs — no network, no credentials. Covers approve (batch + legacy),
// correct, void, restore, manual and drive-override, per role: owner, admin, a manager IN
// scope, a manager OUT of scope, a manager acting on their OWN punch, and crew. Plus the
// version CAS (stale → 409), the ledger lock (paid-locked → 409), approving an open punch
// (not-closed → 409), the approval-reset-on-time-change history row, per-item batch
// independence, and the legacy reject → 400.
//
// It also pins two store-shape invariants the ledger depends on (spec §6.2): store.js
// routes EVERY time_entries UPDATE through one helper, and every insert/update stamps
// updated_at.
//
//   node scripts/test-time-approval-routes.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
// The sentence a clock-out leaves on a DELETED punch — read from the shared rule module
// the server and the demo stub both run, never restated here (THE LAW II.3).
import { VOIDED_CLOCK_OUT_REASON } from '../src/lib/timeRules.js';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

process.env.CRON_SECRET = 'cron-secret-for-the-fake';
const CRON = process.env.CRON_SECRET;

installFakeSupabase();
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── people ─────────────────────────────────────────────────────────────────
// A manager is claim-less, exactly as live (claims.js VALID_ROLES has no 'manager').
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true, pay: { type: 'none' } },
  admin: { id: 'u_admin', role: 'admin', claim: true, pay: { type: 'salary' } },
  mgr: { id: 'u_mgr', role: 'manager', claim: false, pay: { type: 'salary' } },
  crew: { id: 'u_crew', role: 'crew', claim: true, pay: { type: 'hourly', hourlyRate: 22 } },
  crew2: { id: 'u_crew2', role: 'crew', claim: true, pay: { type: 'hourly', hourlyRate: 20 } },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k, pay: p.pay }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const tok = (who) => `tok-${who}`;

// ── time ───────────────────────────────────────────────────────────────────
const NOW = Date.now();
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const recentIn = iso(NOW - 2 * 24 * H);       // open territory (after the June run)
const recentOut = iso(NOW - 2 * 24 * H + 2 * H);

// A June run: closed 2026-07-01, window ends 2026-06-30.
const RUN_JUNE = {
  organization_id: ORG, id: 'run_jun', period_key: '2026-06-01', cadence: 'weekly',
  from_key: '2026-06-01', to_key: '2026-06-30', from_iso: '2026-06-01T04:00:00Z', to_iso: '2026-07-01T03:59:59Z',
  status: 'closed', closed_at: '2026-07-01T14:00:00Z', closed_by: 'u_owner', pending_policy: 'rollForward',
  rolled_forward: {}, paid_weeks: [], held_ot: [], file: {},
};

// A punch row, defaulted to a closed, worked, pending crew punch at cl_ever (in mgr scope).
const punch = (o = {}) => ({
  id: 'te_x', organization_id: ORG, user_id: 'u_crew', client_id: 'cl_ever', site_id: 'st_ever', job_id: 'j_ever',
  user_name: 'crew', client_name: 'Las Olas', site_name: 'Main',
  clock_in_at: recentIn, clock_out_at: recentOut, duration_minutes: 120,
  status: 'completed', approval_status: 'pending', approved_by: null, approved_at: null,
  row_version: 0, edit_history: [], updated_at: recentOut, ...o,
});

const jobRow = (id, clientId, siteId, crewIds = ['u_crew']) => ({
  organization_id: ORG, id, site_id: siteId, status: 'upcoming', start_at: recentIn,
  data: { id, siteId, clientId, crewIds, startAt: recentIn, endAt: recentOut, status: 'upcoming' },
});

function buildWorld({ entries = [], runs = [], permissions = seedPermissions(), overrides = [] } = {}) {
  const state = {
    users: roster,
    permissions,
    userPermissionOverrides: overrides,
    clients: [
      { id: 'cl_ever', name: 'Las Olas', supervisorId: 'u_mgr' },
      { id: 'cl_coral', name: 'Coral Bay', supervisorId: 'u_mgr' },
      { id: 'cl_pac', name: 'Palmetto', supervisorId: 'u_admin' }, // NOT the manager's
    ],
    sites: [
      { id: 'st_ever', clientId: 'cl_ever', name: 'Main' },
      { id: 'st_pac', clientId: 'cl_pac', name: 'Ridge' },
    ],
    opsSettings: {},
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 3 }],
      time_entries: entries.map((e) => ({ ...e })),
      payroll_runs: runs.map((r) => ({ ...r })),
      jobs: [jobRow('j_ever', 'cl_ever', 'st_ever'), jobRow('j_pac', 'cl_pac', 'st_pac')],
    },
    logins,
  });
}

async function call({ method = 'POST', path, token, body }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 5000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(time(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;

// request builders
const approveBatch = (who, items) => call({ path: 'approve', token: tok(who), body: { items } });
const approveLegacy = (who, entryId, approval) => call({ path: 'approve', token: tok(who), body: { entryId, approval } });
const correct = (who, body) => call({ path: 'correct', token: tok(who), body });
const voidPunch = (who, body) => call({ path: 'void', token: tok(who), body });
const restorePunch = (who, body) => call({ path: 'restore', token: tok(who), body });
const manual = (who, body) => call({ path: 'manual', token: tok(who), body });
const driveOverride = (who, body) => call({ path: 'drive-override', token: tok(who), body });

// ═══ 1. approve (batch): role × scope × own ══════════════════════════════════
for (const who of ['owner', 'admin', 'mgr']) {
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  const r = await approveBatch(who, [{ entryId: 'te_ever', version: 0 }]);
  ok(`approve (in scope): ${who} → 200 ok`, r.status === 200 && r.body?.results?.[0]?.ok === true, show(r));
  const row = world.tables.time_entries[0];
  ok(`  ${who}: the punch is now approved, row_version bumped`, row.approval_status === 'approved' && row.row_version === 1, JSON.stringify(row).slice(0, 120));
}
{
  buildWorld({ entries: [punch({ id: 'te_pac', client_id: 'cl_pac', site_id: 'st_pac' })] });
  const r = await approveBatch('mgr', [{ entryId: 'te_pac', version: 0 }]);
  ok('approve: a manager OUT of scope → item out-of-scope, punch untouched', r.status === 200 && r.body?.results?.[0]?.ok === false && r.body?.results?.[0]?.code === 'out-of-scope' && world.tables.time_entries[0].approval_status === 'pending', show(r));
}
{
  buildWorld({ entries: [punch({ id: 'te_own', user_id: 'u_mgr' })] });
  const r = await approveBatch('mgr', [{ entryId: 'te_own', version: 0 }]);
  ok("approve: a manager on their OWN punch → own-entry", r.status === 200 && r.body?.results?.[0]?.code === 'own-entry', show(r));
  const r2 = await (async () => { buildWorld({ entries: [punch({ id: 'te_own', user_id: 'u_owner' })] }); return approveBatch('owner', [{ entryId: 'te_own', version: 0 }]); })();
  ok('approve: an OWNER on their own punch → ok', r2.status === 200 && r2.body?.results?.[0]?.ok === true, show(r2));
}
{
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  const r = await approveBatch('crew', [{ entryId: 'te_ever', version: 0 }]);
  ok('approve: crew → 403 (no time.approve)', r.status === 403, show(r));
}
{ // idempotent: approving an already-approved punch is ok
  buildWorld({ entries: [punch({ id: 'te_ever', approval_status: 'approved', approved_at: recentOut, row_version: 2 })] });
  const r = await approveBatch('owner', [{ entryId: 'te_ever', version: 2 }]);
  ok('approve: already approved → ok (idempotent)', r.status === 200 && r.body?.results?.[0]?.ok === true, show(r));
}
{ // approving an OPEN punch → not-closed
  buildWorld({ entries: [punch({ id: 'te_open', clock_out_at: null, duration_minutes: null, status: 'in_progress' })] });
  const r = await approveBatch('owner', [{ entryId: 'te_open', version: 0 }]);
  ok('approve: an open punch → not-closed', r.status === 200 && r.body?.results?.[0]?.code === 'not-closed', show(r));
}
{ // stale version in a batch → per-item stale; per-item independence
  buildWorld({ entries: [punch({ id: 'te_a', row_version: 5 }), punch({ id: 'te_b', row_version: 0, user_id: 'u_crew2' })] });
  const r = await approveBatch('owner', [{ entryId: 'te_a', version: 2 }, { entryId: 'te_b', version: 0 }]);
  const byId = Object.fromEntries((r.body?.results || []).map((x) => [x.entryId, x]));
  ok('approve batch: the stale item fails alone (code stale), the good item still approves', r.status === 200 && byId.te_a?.code === 'stale' && byId.te_b?.ok === true, show(r));
  const a = world.tables.time_entries.find((e) => e.id === 'te_a');
  const b = world.tables.time_entries.find((e) => e.id === 'te_b');
  ok('  the stale punch was NOT written; the good one was', a.approval_status === 'pending' && b.approval_status === 'approved', `a=${a.approval_status} b=${b.approval_status}`);
}
{ // batch cap
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  const items = Array.from({ length: 201 }, (_, i) => ({ entryId: `x${i}`, version: 0 }));
  const r = await approveBatch('owner', items);
  ok('approve batch: more than 200 items → 400', r.status === 400, show(r));
}

// ═══ 2. approve (legacy body, cached bundles) ════════════════════════════════
{
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  const r = await approveLegacy('owner', 'te_ever', 'rejected');
  ok('approve legacy: reject → 400 reject-removed', r.status === 400 && r.body?.code === 'reject-removed', show(r));
}
{
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  const r = await approveLegacy('owner', 'te_ever', 'approved');
  ok('approve legacy: approved → ok (one unversioned item)', r.status === 200 && (r.body?.results?.[0]?.ok === true || r.body?.entry?.approval_status === 'approved'), show(r));
  ok('  and the punch is approved', world.tables.time_entries[0].approval_status === 'approved', show(r));
}

// ═══ 3. correct: version, approval-reset, lock, scope, own ═══════════════════
{
  buildWorld({ entries: [punch({ id: 'te_ever', approval_status: 'approved', approved_by: 'u_owner', approved_at: recentOut, row_version: 1 })] });
  const newOut = iso(NOW - 2 * 24 * H + 3 * H);
  const r = await correct('owner', { entryId: 'te_ever', version: 1, patch: { clock_out_at: newOut }, reason: 'fix' });
  const row = world.tables.time_entries[0];
  ok('correct: a time change on an APPROVED punch → back to pending', r.status === 200 && row.approval_status === 'pending' && row.approved_by === null && row.approved_at === null, show(r));
  const h = (row.edit_history || []).find((x) => x.field === 'approval');
  ok('  ...with an approval history row (from approved, to pending, reason "times changed")', !!h && h.from === 'approved' && h.to === 'pending' && /times changed/i.test(h.reason || ''), JSON.stringify(row.edit_history));
  ok('  ...and row_version bumped to 2', row.row_version === 2, `row_version=${row.row_version}`);
}
{ // stale version → 409 stale
  buildWorld({ entries: [punch({ id: 'te_ever', row_version: 5 })] });
  const r = await correct('owner', { entryId: 'te_ever', version: 2, patch: { note: 'x' }, reason: 'r' });
  ok('correct: stale version → 409 stale', r.status === 409 && r.body?.code === 'stale', show(r));
}
{ // clearing a closed punch's clock-out → missing-out (400)
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  const r = await correct('owner', { entryId: 'te_ever', version: 0, patch: { clock_out_at: null }, reason: 'r' });
  ok("correct: clearing a closed punch's clock-out → 400 (missing-out)", r.status === 400 && r.body?.code === 'missing-out', show(r));
}
{ // clock-out on an open punch closes it
  buildWorld({ entries: [punch({ id: 'te_open', clock_out_at: null, duration_minutes: null, status: 'in_progress' })] });
  const newOut = iso(NOW - 2 * 24 * H + 1 * H);
  const r = await correct('owner', { entryId: 'te_open', version: 0, patch: { clock_out_at: newOut }, reason: 'closing' });
  const row = world.tables.time_entries[0];
  ok('correct: a clock-out set on an OPEN punch closes it (status completed)', r.status === 200 && row.status === 'completed' && row.clock_out_at === newOut, show(r));
}
{ // paid-locked → 409
  buildWorld({
    entries: [punch({ id: 'te_paid', approval_status: 'approved', approved_by: 'u_owner', approved_at: '2026-06-20T14:00:00Z', clock_in_at: '2026-06-20T13:00:00Z', clock_out_at: '2026-06-20T15:00:00Z', row_version: 1 })],
    runs: [RUN_JUNE],
  });
  const r = await correct('owner', { entryId: 'te_paid', version: 1, patch: { note: 'x' }, reason: 'r' });
  ok('correct: a paid (locked) punch → 409 paid-locked', r.status === 409 && r.body?.code === 'paid-locked', show(r));
}
{ // scope + own
  buildWorld({ entries: [punch({ id: 'te_pac', client_id: 'cl_pac', site_id: 'st_pac' })] });
  const r = await correct('mgr', { entryId: 'te_pac', version: 0, patch: { note: 'x' }, reason: 'r' });
  ok('correct: manager OUT of scope → 403 out-of-scope', r.status === 403 && r.body?.code === 'out-of-scope', show(r));
  buildWorld({ entries: [punch({ id: 'te_own', user_id: 'u_mgr' })] });
  const r2 = await correct('mgr', { entryId: 'te_own', version: 0, patch: { note: 'x' }, reason: 'r' });
  ok("correct: manager on their OWN punch → 403 own-entry", r2.status === 403 && r2.body?.code === 'own-entry', show(r2));
}
{ // patch.status is no longer accepted
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  await correct('owner', { entryId: 'te_ever', version: 0, patch: { status: 'voided' }, reason: 'r' });
  ok('correct: patch.status is ignored (Void owns status)', world.tables.time_entries[0].status === 'completed', JSON.stringify(world.tables.time_entries[0]).slice(0, 120));
}

// ═══ 4. void + restore ═══════════════════════════════════════════════════════
{
  buildWorld({ entries: [punch({ id: 'te_ever', approval_status: 'approved', approved_by: 'u_owner', approved_at: recentOut, row_version: 1 })] });
  const r = await voidPunch('owner', { entryId: 'te_ever', version: 1, reason: 'wrong job' });
  const row = world.tables.time_entries[0];
  ok('void: status → voided, approval cleared to pending, approved fields cleared', r.status === 200 && row.status === 'voided' && row.approval_status === 'pending' && row.approved_by === null, show(r));
  const h = (row.edit_history || []).at(-1);
  ok('  ...with a status history row carrying the reason', h?.field === 'status' && h?.to === 'voided' && h?.reason === 'wrong job', JSON.stringify(row.edit_history));
  ok('  ...row_version bumped', row.row_version === 2, `row_version=${row.row_version}`);
}
{ // void requires a reason
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  const r = await voidPunch('owner', { entryId: 'te_ever', version: 0 });
  ok('void: a reason is required → 400 reason-required', r.status === 400 && r.body?.code === 'reason-required', show(r));
}
{ // restore returns to the pre-void status
  buildWorld({ entries: [punch({ id: 'te_ever', status: 'voided', approval_status: 'pending', row_version: 2, edit_history: [{ at: recentOut, byUserId: 'u_owner', field: 'status', from: 'completed', to: 'voided', reason: 'oops' }] })] });
  const r = await restorePunch('owner', { entryId: 'te_ever', version: 2 });
  const row = world.tables.time_entries[0];
  ok('restore: status back to the value before the void (completed), approval stays pending', r.status === 200 && row.status === 'completed' && row.approval_status === 'pending', show(r));
}
{ // void: role/scope/own/stale/lock
  buildWorld({ entries: [punch({ id: 'te_ever' })] });
  ok('void: crew → 403', (await voidPunch('crew', { entryId: 'te_ever', version: 0, reason: 'r' })).status === 403);
  buildWorld({ entries: [punch({ id: 'te_pac', client_id: 'cl_pac', site_id: 'st_pac' })] });
  ok('void: manager OUT of scope → 403 out-of-scope', (await voidPunch('mgr', { entryId: 'te_pac', version: 0, reason: 'r' })).body?.code === 'out-of-scope');
  buildWorld({ entries: [punch({ id: 'te_ever', row_version: 4 })] });
  ok('void: stale version → 409 stale', (await voidPunch('owner', { entryId: 'te_ever', version: 1, reason: 'r' })).body?.code === 'stale');
  buildWorld({ entries: [punch({ id: 'te_paid', approval_status: 'approved', approved_at: '2026-06-20T14:00:00Z', clock_in_at: '2026-06-20T13:00:00Z', clock_out_at: '2026-06-20T15:00:00Z', row_version: 1 })], runs: [RUN_JUNE] });
  ok('void: a paid (locked) punch → 409 paid-locked', (await voidPunch('owner', { entryId: 'te_paid', version: 1, reason: 'r' })).body?.code === 'paid-locked');
}

// ═══ 5. manual ═══════════════════════════════════════════════════════════════
{
  buildWorld();
  const r = await manual('mgr', { jobId: 'j_ever', userId: 'u_crew', clockInAt: recentIn, clockOutAt: recentOut, reason: 'forgot' });
  ok('manual: manager IN scope adds a punch → 200, lands pending', r.status === 200 && r.body?.entry?.approval_status === 'pending', show(r));
}
{
  buildWorld();
  const r = await manual('mgr', { jobId: 'j_pac', userId: 'u_crew', clockInAt: recentIn, clockOutAt: recentOut, reason: 'x' });
  ok('manual: manager OUT of scope (the clean is at cl_pac) → 403 out-of-scope', r.status === 403 && r.body?.code === 'out-of-scope', show(r));
}
{
  buildWorld();
  const r = await manual('mgr', { jobId: 'j_ever', userId: 'u_mgr', clockInAt: recentIn, clockOutAt: recentOut, reason: 'x' });
  ok('manual: manager adding time for THEMSELVES → 403 own-entry', r.status === 403 && r.body?.code === 'own-entry', show(r));
}
{
  buildWorld();
  const r = await manual('owner', { jobId: 'j_ever', userId: 'u_crew', clockInAt: iso(NOW + 30 * 60e3), clockOutAt: null, reason: 'x' });
  ok('manual: a clock-in in the future → 400 (in-future)', r.status === 400 && r.body?.code === 'in-future', show(r));
}
{
  buildWorld();
  ok('manual: crew → 403 (no time.edit.all)', (await manual('crew', { jobId: 'j_ever', userId: 'u_crew', clockInAt: recentIn, clockOutAt: recentOut, reason: 'x' })).status === 403);
}

// ═══ 6. drive-override: scope, own, closed-territory ════════════════════════
const legFrom = (o = {}) => punch({ id: 'te_from', ...o });
const legTo = (o = {}) => punch({ id: 'te_to', ...o });
{
  buildWorld({ entries: [legFrom(), legTo()] });
  const r = await driveOverride('mgr', { fromEntryId: 'te_from', toEntryId: 'te_to', paidMinutes: 15, reason: 'traffic' });
  ok('drive-override: manager IN scope (open territory) → 200', r.status === 200, show(r));
}
{
  buildWorld({ entries: [legFrom(), legTo({ client_id: 'cl_pac', site_id: 'st_pac' })] });
  const r = await driveOverride('mgr', { fromEntryId: 'te_from', toEntryId: 'te_to', paidMinutes: 15, reason: 'x' });
  ok('drive-override: destination OUT of scope → 403 out-of-scope', r.status === 403 && r.body?.code === 'out-of-scope', show(r));
}
{
  buildWorld({ entries: [legFrom(), legTo({ user_id: 'u_mgr' })] });
  const r = await driveOverride('mgr', { fromEntryId: 'te_from', toEntryId: 'te_to', paidMinutes: 15, reason: 'x' });
  ok('drive-override: destination is the manager\'s OWN punch → 403 own-entry', r.status === 403 && r.body?.code === 'own-entry', show(r));
}
{
  buildWorld({
    entries: [legFrom({ clock_in_at: '2026-06-20T12:00:00Z', clock_out_at: '2026-06-20T12:30:00Z' }), legTo({ clock_in_at: '2026-06-20T13:00:00Z', clock_out_at: '2026-06-20T15:00:00Z' })],
    runs: [RUN_JUNE],
  });
  const r = await driveOverride('owner', { fromEntryId: 'te_from', toEntryId: 'te_to', paidMinutes: 15, reason: 'x' });
  ok('drive-override: destination in CLOSED territory → 409 paid-locked', r.status === 409 && r.body?.code === 'paid-locked', show(r));
}
{
  buildWorld({ entries: [legFrom(), legTo()] });
  ok('drive-override: crew → 403 (no time.edit.all)', (await driveOverride('crew', { fromEntryId: 'te_from', toEntryId: 'te_to', paidMinutes: 15, reason: 'x' })).status === 403);
}

// ═══ 6b. clock-out of SOMEONE ELSE'S punch follows the manager's locations ═══
// The punch bypass (owner/admin by role, or time.edit.all) let a manager close a punch at
// a location that is not theirs, while correct/manual refused the same manager out-of-scope
// — the same write, two answers. Closing someone else's punch is a manager time write, so
// it takes the SAME scope rule. The paid lock and the own-time rule do not apply (closing an
// open punch is not an edit of paid time), and the ENTRY OWNER's own clock-out is never
// scope-checked — a cleaner has no scope at all.
const openPunch = (o = {}) => punch({ clock_out_at: null, duration_minutes: null, status: 'in_progress', ...o });
const clockOutCall = (who, body) => call({ path: 'clock-out', token: tok(who), body });
const replayCall = (who, body) => call({ path: 'replay', token: tok(who), body });
{
  buildWorld({ entries: [openPunch({ id: 'te_ever' })] });
  const r = await clockOutCall('mgr', { entryId: 'te_ever' });
  const row = world.tables.time_entries[0];
  ok('clock-out (bypass): manager IN scope closes the cleaner\'s punch → 200', r.status === 200 && !!row.clock_out_at && row.status === 'completed', show(r));
  ok('  ...and the trail says who closed it', row.edited === true && row.edited_by === 'u_mgr', JSON.stringify(row.edit_history).slice(0, 160));
}
{
  buildWorld({ entries: [openPunch({ id: 'te_pac', client_id: 'cl_pac', site_id: 'st_pac', job_id: 'j_pac' })] });
  const r = await clockOutCall('mgr', { entryId: 'te_pac' });
  const row = world.tables.time_entries[0];
  ok('clock-out (bypass): manager OUT of scope → 403 out-of-scope', r.status === 403 && r.body?.code === 'out-of-scope', show(r));
  ok('  ...and NOTHING was written — the punch is still on the clock', row.clock_out_at === null && row.status === 'in_progress' && row.row_version === 0, JSON.stringify(row).slice(0, 160));
}
for (const who of ['owner', 'admin']) {
  buildWorld({ entries: [openPunch({ id: 'te_pac', client_id: 'cl_pac', site_id: 'st_pac', job_id: 'j_pac' })] });
  const r = await clockOutCall(who, { entryId: 'te_pac' });
  ok(`clock-out (bypass): ${who} is unscoped → 200 at any location`, r.status === 200 && !!world.tables.time_entries[0].clock_out_at, show(r));
}
{
  // The cleaner's OWN clock-out: a crew member's scope is EMPTY, so a scope check applied
  // to the owner would refuse every ordinary punch. It must not be asked at all.
  buildWorld({ entries: [openPunch({ id: 'te_ever' })] });
  const r = await clockOutCall('crew', { entryId: 'te_ever' });
  ok('clock-out: the entry OWNER is never scope-checked → 200', r.status === 200 && !!world.tables.time_entries[0].clock_out_at, show(r));
}
{
  // THE LAW II.8: a buffered punch is never refused. A replay carries labor that already
  // happened, so scope never turns it into a 4xx that drops the crew's record.
  buildWorld({ entries: [openPunch({ id: 'te_pac', client_id: 'cl_pac', site_id: 'st_pac', job_id: 'j_pac' })] });
  const r = await replayCall('mgr', { clientPunchId: 'op_scope', entryId: 'te_pac', assertedOutAt: recentOut });
  ok('replay: a buffered clock-out is NEVER scope-refused (II.8) → 200', r.status === 200 && !!world.tables.time_entries[0].clock_out_at, show(r));
}

// ═══ 6c. a clock-out never brings a DELETED punch back ═══════════════════════
// clockOut and the replay wrote `status: 'completed'` unconditionally, so a punch a manager
// Deleted (voided) while it was still open was silently un-deleted by the cleaner's next
// clock-out — and walked back into the approval queue and into pay. The clock-out is still
// RECORDED (the labor happened and the punch is its only record, II.8); the deletion stands
// until a manager restores it.
const autoCloseCall = () => call({ path: 'auto-close', token: CRON });   // the cron's bearer IS the secret
const lastHistory = (row) => (row.edit_history || []).at(-1);
ok('store.js exports the reason a clock-out leaves on a deleted punch', typeof VOIDED_CLOCK_OUT_REASON === 'string' && VOIDED_CLOCK_OUT_REASON.length > 0, `got ${VOIDED_CLOCK_OUT_REASON}`);
{
  buildWorld({ entries: [openPunch({ id: 'te_ever' })] });
  await voidPunch('owner', { entryId: 'te_ever', version: 0, reason: 'clocked in at the wrong site' });
  const r = await clockOutCall('crew', { entryId: 'te_ever' });
  const row = world.tables.time_entries[0];
  ok('deleted punch: the cleaner\'s live clock-out is accepted → 200', r.status === 200, show(r));
  ok('  ...the clock-out IS recorded (time + duration)', !!row.clock_out_at && row.duration_minutes === Math.round((Date.parse(row.clock_out_at) - Date.parse(row.clock_in_at)) / 60000), JSON.stringify(row).slice(0, 180));
  ok('  ...and the punch is STILL deleted', row.status === 'voided', `status=${row.status}`);
  ok('  ...the history says it was clocked out after the deletion', lastHistory(row)?.reason === VOIDED_CLOCK_OUT_REASON, JSON.stringify(row.edit_history).slice(0, 240));
  ok('  ...approval is left exactly as the delete left it', row.approval_status === 'pending' && row.approved_by === null, `approval=${row.approval_status}`);
  // It must not reach the queue, and it must not be approvable.
  const q = await call({ method: 'GET', path: 'approvals', token: tok('owner') });
  ok('  ...it is NOT in the To approve queue', q.status === 200 && !(q.body?.pending || []).some((p) => p.id === 'te_ever'), show(q));
  const ap = await approveBatch('owner', [{ entryId: 'te_ever', version: row.row_version }]);
  ok('  ...and it cannot be approved (code voided)', ap.body?.results?.[0]?.code === 'voided', show(ap));
  // Restore closes it properly: the pre-void status was in_progress, but it has a clock-out
  // now, so an in_progress row with a clock-out must never be what comes back.
  const re = await restorePunch('owner', { entryId: 'te_ever', version: row.row_version });
  const back = world.tables.time_entries[0];
  ok('  ...restore brings it back as COMPLETED, not in_progress-with-a-clock-out', re.status === 200 && back.status === 'completed' && !!back.clock_out_at, show(re));
}
{
  buildWorld({ entries: [openPunch({ id: 'te_ever' })] });
  await voidPunch('owner', { entryId: 'te_ever', version: 0, reason: 'clocked in at the wrong site' });
  const r = await replayCall('crew', { clientPunchId: 'op_void', entryId: 'te_ever', assertedOutAt: recentOut });
  const row = world.tables.time_entries[0];
  ok('deleted punch: a REPLAYED clock-out is accepted too (II.8) → 200', r.status === 200, show(r));
  ok('  ...recorded, and still deleted', !!row.clock_out_at && row.status === 'voided', `status=${row.status} out=${row.clock_out_at}`);
  ok('  ...the history says it was clocked out after the deletion', (row.edit_history || []).some((h) => h.reason === VOIDED_CLOCK_OUT_REASON), JSON.stringify(row.edit_history).slice(0, 240));
}
{
  buildWorld({ entries: [openPunch({ id: 'te_ever', scheduled_end: recentOut })] });
  await voidPunch('owner', { entryId: 'te_ever', version: 0, reason: 'wrong clean' });
  const r = await autoCloseCall();
  ok('deleted punch: the auto-close cron leaves it alone', r.status === 200 && r.body?.closed === 0 && world.tables.time_entries[0].status === 'voided', show(r));
}
{
  buildWorld({ entries: [openPunch({ id: 'te_ever' })] });
  await voidPunch('owner', { entryId: 'te_ever', version: 0, reason: 'wrong clean' });
  const r = await call({ path: 'job-cancelled', token: tok('owner'), body: { jobId: 'j_ever' } });
  const row = world.tables.time_entries[0];
  ok('deleted punch: cancelling the clean flags it without un-deleting it', r.status === 200 && row.status === 'voided' && !!row.job_cancelled_at, `status=${row.status} cancelled=${row.job_cancelled_at}`);
}
{
  buildWorld({ entries: [openPunch({ id: 'te_ever' })] });
  await voidPunch('owner', { entryId: 'te_ever', version: 0, reason: 'wrong clean' });
  const r = await correct('owner', { entryId: 'te_ever', version: 1, patch: { clock_out_at: recentOut }, reason: 'closing the record' });
  const row = world.tables.time_entries[0];
  ok('deleted punch: a manager setting its clock-out does not un-delete it either', r.status === 200 && row.status === 'voided' && row.clock_out_at === recentOut, `status=${row.status}`);
}

// ═══ 7. store shape: one UPDATE path + updated_at stamped on every write ══════
{
  // CRLF normalized: on a Windows checkout the sweep's "\n}\n" pin would never match.
  const src = readFileSync(new URL('../api/_lib/time/store.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const noComments = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const updateCalls = (noComments.match(/\.update\(/g) || []).length;
  // TWO, and the second is named: `updateEntry`, the one CAS'd write path for a punch's
  // CONTENT, and PAY-20's retention sweep, which writes nothing but nulls into the six raw
  // GPS point columns. The sweep is deliberately NOT routed through updateEntry: that helper
  // stamps `updated_at`, which arrears detection reads (spec §6.2), so trimming a 90-day-old
  // punch through it would make a long-closed week look changed. The carve-out is bounded
  // mechanically below — it may clear those six columns and touch nothing else — so "no punch
  // UPDATE bypasses the CAS" still holds for every write that changes what a punch SAYS.
  ok('store.js: exactly TWO .update( on time_entries — the CAS helper and the GPS retention sweep', updateCalls === 2, `${updateCalls} .update( calls`);
  {
    const sweep = /export async function trimStalePunchCoords\([\s\S]*?\n\}\n/.exec(noComments)?.[0] || '';
    ok('store.js: the retention sweep exists and is the second writer', !!sweep);
    ok('store.js: …and it writes ONLY the cleared point columns',
      /\.update\(cleared\)/.test(sweep) && /const cleared = Object\.fromEntries\(GPS_POINT_COLUMNS\.map\(\(c\) => \[c, null\]\)\);/.test(sweep),
      sweep.slice(0, 200));
    ok('store.js: …never a verdict, a distance, a time or a status',
      !/(geofence_result|_distance_m|clock_in_at|clock_out_at|status|approval_status|row_version|updated_at)\s*:/.test(sweep.split('.update(')[1] || ''),
      (sweep.split('.update(')[1] || '').slice(0, 200));
    ok('store.js: …and it is bounded (a page of ids at a time, a capped number of pages)',
      /\.limit\(batchSize\)/.test(sweep) && /for \(let i = 0; i < maxBatches/.test(sweep));
  }
  // …and that ONE helper ALWAYS swaps on the version. It used to take `{ cas }` and ride
  // the filter only for a manager write, which left every internal writer last-write-wins
  // (W5-M F1). A conditional swap is the defect, so the option itself is pinned out here;
  // that the filter is on the statement is pinned in 7b, over the whole tree.
  ok('store.js: no `cas` opt-out survives (II.5 — replace means delete)', !/\bcas\b/.test(noComments), 'a `cas` token is still in store.js');
  // Every insert into time_entries stamps updated_at (spec §6.2: arrears detection reads it).
  const inserts = [...noComments.matchAll(/const\s+row\s*=\s*\{[\s\S]*?\};/g)].map((m) => m[0]);
  ok('store.js: found the insert row literals', inserts.length >= 3, `${inserts.length} row literals`);
  ok('store.js: every insert row literal stamps updated_at', inserts.every((r) => /updated_at\s*:/.test(r)), inserts.map((r, i) => `#${i} ${/updated_at\s*:/.test(r)}`).join(' '));
  // The one helper stamps updated_at.
  ok('store.js: the update helper stamps updated_at', /updated_at\s*:\s*nowIso\(\)/.test(noComments), 'no updated_at: nowIso() found');
}

// ═══ 7b. EVERY file under api/ — no time_entries write outside that one helper ═
// The pin above only reads store.js, so a write added anywhere else under api/ would slip
// past it entirely. This walks the whole tree, resolves each file's own alias for the table
// (`const TABLE = 'time_entries'`, `const ENTRIES_TABLE = …`) and reports any
// .update( / .upsert( / .delete( chained off a `from(<that table>)`. Exactly one may exist:
// updateEntry's, and it must carry the row_version swap.
{
  const apiDir = new URL('../api/', import.meta.url);
  const files = [];
  (function walk(dir, rel = '') {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      if (ent.isDirectory()) walk(new URL(`${ent.name}/`, dir), `${rel}${ent.name}/`);
      else if (ent.name.endsWith('.js')) files.push({ rel: `${rel}${ent.name}`, url: new URL(ent.name, dir) });
    }
  }(apiDir));
  ok('api/: the sweep found the tree', files.length > 20, `${files.length} .js files`);

  const writes = [];
  for (const f of files) {
    const body = readFileSync(f.url, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const names = new Set(["'time_entries'", '"time_entries"']);
    for (const m of body.matchAll(/const\s+(\w+)\s*=\s*['"]time_entries['"]/g)) names.add(m[1]);
    for (const name of names) {
      const re = new RegExp(`\\.from\\(\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)([\\s\\S]{0,400}?);`, 'g');
      for (const m of body.matchAll(re)) {
        const chain = m[1];
        const verb = /\.update\(/.test(chain) ? 'update' : /\.upsert\(/.test(chain) ? 'upsert' : /\.delete\(/.test(chain) ? 'delete' : null;
        if (verb) writes.push({ file: f.rel, verb, chain: chain.slice(0, 160) });
      }
    }
  }
  // Both write chains live in the store, and nowhere else in api/ writes a punch.
  ok('api/: the ONLY time_entries write chains are in _lib/time/store.js',
    writes.length === 2 && writes.every((w) => w.file === '_lib/time/store.js' && w.verb === 'update'),
    writes.map((w) => `${w.file} .${w.verb}(`).join(' · ') || 'none found');
  // The one that changes what a punch SAYS rides the swap; PAY-20's retention sweep is the
  // other, and it only ever clears the raw GPS point columns (pinned in §7 above).
  const content = writes.filter((w) => !/\.update\(cleared\)/.test(w.chain));
  ok('api/: the punch-CONTENT write chain rides .eq(row_version, …)',
    content.length === 1 && /\.eq\('row_version',/.test(content[0].chain),
    content[0]?.chain || 'no chain');
  ok('api/: the other chain is the GPS retention sweep, writing only cleared columns',
    writes.length - content.length === 1,
    writes.map((w) => w.chain.slice(0, 60)).join(' | '));
}

console.log(`\ntime-approval routes: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
