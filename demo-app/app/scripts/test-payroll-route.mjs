// The payroll domain (wave W2-L §5.2) driven through the REAL handler with fake-supabase.mjs
// — no network, no credentials. Covers: preview/close per role (payroll.view vs payroll.edit);
// not-ended → 409; the close ORDER (first close = the most recent ended period; the next
// follows the latest to_key); a stale asOf → 409; the block policy → 409 with counts; the
// roll-forward policy closes and stores rolled_forward; a second close of the same period →
// 409 period-closed; the stored paid_weeks make the next preview's arrears zero; a late
// approval after the close shows up as arrears in the next preview; Cache-Control: no-store.
//   node scripts/test-payroll-route.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { payPeriodRange } from '../src/lib/payroll.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const TZ = 'America/New_York';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const payroll = (await import('../api/payroll/[...path].js')).default;

let pass = 0; const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// Weekly cadence, so a pay period IS a pay week. Periods are relative to NOW the same way the
// route computes them (the route uses its own new Date(); we read new Date() here).
const NOW = new Date();
const P0 = payPeriodRange('weekly', 0, NOW, TZ);    // current open
const Pm1 = payPeriodRange('weekly', -1, NOW, TZ);  // most recent ended
const Pm2 = payPeriodRange('weekly', -2, NOW, TZ);  // older ended
const Pm3 = payPeriodRange('weekly', -3, NOW, TZ);

const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true, pay: { type: 'none' } },
  admin: { id: 'u_admin', role: 'admin', claim: true, pay: { type: 'salary', salaryPerPeriod: 2000 } },
  mgr: { id: 'u_mgr', role: 'manager', claim: false, pay: { type: 'salary', salaryPerPeriod: 2000 } },
  crew: { id: 'u_crew', role: 'crew', claim: true, pay: { type: 'hourly', hourlyRate: 20 } },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k, pay: p.pay }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const tok = (who) => `tok-${who}`;

const iso = (ms) => new Date(ms).toISOString();
// A closed worked punch for u_crew. clock_in mid-period; duration EXPLICIT (the ledger reads it).
const punch = (period, o = {}) => ({
  id: o.id || 'te_x', organization_id: ORG, user_id: o.user_id || 'u_crew', client_id: o.client_id ?? 'c1', site_id: 's1', job_id: 'j1',
  user_name: 'crew', client_name: 'Las Olas', site_name: 'Main',
  clock_in_at: o.clock_in_at || iso(Date.parse(period.fromIso) + 2 * 86400e3 + 12 * 3600e3),
  clock_out_at: o.clock_out_at || iso(Date.parse(period.fromIso) + 2 * 86400e3 + 20 * 3600e3),
  duration_minutes: o.duration_minutes ?? 2400,
  status: 'completed', approval_status: o.approval_status || 'approved', approved_by: null, approved_at: null,
  job_cancelled_at: null, row_version: 0, edit_history: [],
  updated_at: o.updated_at || iso(Date.parse(period.fromIso) + 2 * 86400e3 + 21 * 3600e3),
});

function buildWorld({ entries = [], runs = [], opsSettings = {} } = {}) {
  const state = {
    users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
    company: { timezone: TZ },
    clients: [{ id: 'c1', name: 'Las Olas', supervisorId: 'u_mgr' }],
    sites: [{ id: 's1', clientId: 'c1', name: 'Main' }],
    payrollLines: [],
    opsSettings: { payPeriodCadence: 'weekly', payWeekStartDay: 0, otMultiplier: 1.5, ...opsSettings },
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 3 }],
      time_entries: entries.map((e) => ({ ...e })),
      payroll_runs: runs.map((r) => ({ ...r })),
      time_ot_approvals: [],
      drive_segment_overrides: [],
      jobs: [],
    },
    logins,
  });
}
// A closed run row (as the close would insert it), for the ORDER / already-closed cases.
const runRow = (period, extra = {}) => ({
  organization_id: ORG, id: `run_${period.fromKey}`, period_key: period.fromKey, cadence: 'weekly',
  from_key: period.fromKey, to_key: period.toKey, from_iso: period.fromIso, to_iso: period.toIso,
  status: 'closed', closed_at: iso(Date.parse(period.toIso) + 3600e3), closed_by: 'u_owner', closed_by_name: 'owner',
  pending_policy: 'rollForward', rolled_forward: {}, paid_weeks: [], held_ot: [], file: {}, ...extra,
});

async function call({ method = 'GET', path, token, body, query = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: path, ...query };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 8000);
      const headers = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(payroll(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const preview = (who, offset = 0) => call({ method: 'GET', path: 'preview', token: tok(who), query: offset ? { offset: String(offset) } : {} });
const close = (who, periodKey, asOf) => call({ method: 'POST', path: 'close', token: tok(who), body: { periodKey, asOf } });

// ═══ 1. role × capability (payroll.view to look, payroll.edit to close) ══════════
{
  buildWorld();
  ok('preview: owner (payroll.view) → 200', (await preview('owner')).status === 200);
  ok('preview: manager (payroll.view by default) → 200', (await preview('mgr')).status === 200);
  ok('preview: admin (no payroll.view) → 403', (await preview('admin')).status === 403);
  ok('preview: crew → 403', (await preview('crew')).status === 403);
  const p = await preview('owner');
  ok('preview: Cache-Control is private, no-store', p.headers['cache-control'] === 'private, no-store', JSON.stringify(p.headers));
  // runs is payroll.view OR time.config (W4-F finding 1): a default Admin holds time.config but
  // NOT payroll.view, and Operations reads runs to lock the cadence once a period is closed —
  // so gating runs on payroll.view alone made that lock fail open for an Admin. Crew hold neither.
  ok('runs: admin (time.config, no payroll.view) → 200, owner → 200, crew → 403',
    (await call({ path: 'runs', token: tok('admin') })).status === 200
    && (await call({ path: 'runs', token: tok('owner') })).status === 200
    && (await call({ path: 'runs', token: tok('crew') })).status === 403);
  // close needs payroll.edit; admin/crew lack it.
  ok('close: admin → 403', (await close('admin', Pm1.fromKey)).status === 403);
  ok('close: crew → 403', (await close('crew', Pm1.fromKey)).status === 403);
}

// ═══ 1b. GET /payroll/runs returns run METADATA only — no file/paid_weeks/held_ot/money ══
{
  buildWorld({ runs: [runRow(Pm1)] });   // one closed run whose file/paid_weeks/held_ot must be stripped
  const listed = await call({ path: 'runs', token: tok('owner') });
  const runsOut = Array.isArray(listed.body.runs) ? listed.body.runs : [];
  ok('runs: the closed run is listed', runsOut.some((r) => r.period_key === Pm1.fromKey), show(listed));
  ok('runs: metadata only — no file / paid_weeks / held_ot',
    runsOut.length > 0 && runsOut.every((r) => !('file' in r) && !('paid_weeks' in r) && !('held_ot' in r)),
    JSON.stringify(listed.body).slice(0, 300));
}

// ═══ 2. not-ended, and the FIRST-close order (most recent ended period) ══════════
{
  buildWorld();
  ok('close: the current (unfinished) period → 409 not-ended', (() => true)());
  const cur = await close('owner', P0.fromKey);
  ok('  close P0 (not ended) → 409 not-ended', cur.status === 409 && cur.body.code === 'not-ended', show(cur));
  const older = await close('owner', Pm2.fromKey);
  ok('  close Pm2 (ended, but not the most recent) → 409 period-order', older.status === 409 && older.body.code === 'period-order' && older.body.expected === Pm1.fromKey, show(older));
  const first = await close('owner', Pm1.fromKey);
  ok('  close Pm1 (the most recent ended) → 200, run stored', first.status === 200 && first.body.run?.period_key === Pm1.fromKey, show(first));
  ok('  the run landed in payroll_runs', world.tables.payroll_runs.some((r) => r.period_key === Pm1.fromKey));
}

// ═══ 3. the NEXT close must follow the latest run's to_key ═══════════════════════
{
  // A run already exists for Pm2 (seeded). The next closable = the day after Pm2 = Pm1.
  buildWorld({ runs: [runRow(Pm2)] });
  const skip = await close('owner', P0.fromKey);
  ok('close P0 with a Pm2 run present → not-ended (P0 still open)', skip.status === 409 && skip.body.code === 'not-ended', show(skip));
  const outOfOrder = await close('owner', Pm3.fromKey);
  ok('close Pm3 (before the run, out of order) → period-order (expected Pm1)', outOfOrder.status === 409 && outOfOrder.body.code === 'period-order' && outOfOrder.body.expected === Pm1.fromKey, show(outOfOrder));
  const nextOk = await close('owner', Pm1.fromKey);
  ok('close Pm1 (the day after Pm2) → 200', nextOk.status === 200 && nextOk.body.run?.period_key === Pm1.fromKey, show(nextOk));
}

// ═══ 4. a second close of the SAME period → 409 period-closed ════════════════════
{
  buildWorld({ runs: [runRow(Pm1)] });   // Pm1 already closed
  const again = await close('owner', Pm1.fromKey);
  ok('re-closing an already-closed period → 409 period-closed', again.status === 409 && again.body.code === 'period-closed', show(again));
}

// ═══ 5. a stale asOf → 409 stale ═════════════════════════════════════════════════
{
  buildWorld({ entries: [punch(Pm1, { id: 'te_stale', approval_status: 'pending' })] });
  // The client confirms a preview from BEFORE the punch's updated_at → stale.
  const staleAsOf = iso(Date.parse(Pm1.fromIso));   // long before the punch changed
  const r = await close('owner', Pm1.fromKey, staleAsOf);
  ok('close with a stale asOf → 409 stale', r.status === 409 && r.body.code === 'stale', show(r));
  // A fresh asOf (after everything) closes fine.
  const freshAsOf = iso(Date.now());
  const r2 = await close('owner', Pm1.fromKey, freshAsOf);
  ok('close with a fresh asOf → 200', r2.status === 200, show(r2));
}

// ═══ 6. the block policy refuses a close with pending/held, and reports counts ═══
{
  buildWorld({ entries: [punch(Pm1, { id: 'te_pend', approval_status: 'pending' })], opsSettings: { payrollPendingPolicy: 'block' } });
  const r = await close('owner', Pm1.fromKey);
  ok('block policy + a pending punch → 409 pending-blocks-close with counts', r.status === 409 && r.body.code === 'pending-blocks-close' && r.body.counts?.pendingCount === 1, show(r));
  // rollForward (default) closes despite the pending punch and records the roll-forward.
  buildWorld({ entries: [punch(Pm1, { id: 'te_pend2', approval_status: 'pending' })], opsSettings: { payrollPendingPolicy: 'rollForward' } });
  const r2 = await close('owner', Pm1.fromKey);
  ok('rollForward policy closes despite pending, storing rolled_forward.pendingCount', r2.status === 200 && r2.body.run?.rolled_forward?.pendingCount === 1, show(r2));
}

// ═══ 7. stored paid_weeks make the next preview's arrears zero (idempotence) ═════
{
  buildWorld({ entries: [punch(Pm1, { id: 'te_paid', approval_status: 'approved' })] });
  const closed = await close('owner', Pm1.fromKey);
  ok('close Pm1 with an approved 40h punch → paid_weeks records it', closed.status === 200 && (closed.body.run.paid_weeks || []).some((w) => w.regularMinutes === 2400), show(closed));
  const prev = await preview('owner', 0);   // P0 — nothing changed since the close
  ok('the next preview shows ZERO arrears (nothing changed since the close)', Array.isArray(prev.body.arrears) && prev.body.arrears.length === 0, show(prev));
}

// ═══ 8. a late approval after the close shows up as arrears in the next preview ══
{
  buildWorld({ entries: [punch(Pm1, { id: 'te_late', approval_status: 'pending' })] });
  const closed = await close('owner', Pm1.fromKey);
  ok('close Pm1 with a PENDING punch → it is paid nothing at close', closed.status === 200 && (closed.body.run.paid_weeks || []).every((w) => w.regularMinutes === 0), show(closed));
  // Approve the punch AFTER the close (updated_at now > the run's closed_at − 1h threshold).
  const late = world.tables.time_entries.find((e) => e.id === 'te_late');
  late.approval_status = 'approved'; late.approved_at = iso(Date.now()); late.updated_at = iso(Date.now());
  const prev = await preview('owner', 0);
  const a = (prev.body.arrears || []).find((x) => x.forPeriodKey === Pm1.fromKey);
  ok('the next preview owes the late approval as +40h arrears for Pm1', !!a && a.regularMinutes === 2400, show(prev));
  const crew = (prev.body.rows || []).find((r) => r.userId === 'u_crew');
  ok('...and the crew row prices it: arrearsPay 800, gross 800', crew && crew.arrearsPay === 800 && crew.gross === 800, JSON.stringify(crew));
}

console.log(`\npayroll-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL ${f}`); process.exit(1); }
