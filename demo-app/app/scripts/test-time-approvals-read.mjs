// Manager OVERTIME approval + the Approvals READ (wave W1-B), driven through the REAL
// handler with fake-supabase.mjs — no network, no credentials. Covers:
//   POST /time/ot-approve  — role × scope × own, clamp, bad week key, per-item independence
//   GET  /time/approvals   — a manager sees only their customers' pending + overtime;
//                            salaried people are never listed; pre-ledger punches drop once
//                            a run exists; supervisorId is ignored for a scoped caller and
//                            honoured (incl. `none`) for an owner; overtime surfaces for a
//                            week changed since the latest close and for a held_ot week; the
//                            1-hour threshold picks up a change 30 min before close, not 2 h.
//
//   node scripts/test-time-approvals-read.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { payWeekKeyOf } from '../src/lib/payroll.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const TZ = 'America/New_York';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── people (a manager is claim-less, exactly as live) ────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true, pay: { type: 'none' } },
  admin: { id: 'u_admin', role: 'admin', claim: true, pay: { type: 'salary' } },
  mgr: { id: 'u_mgr', role: 'manager', claim: false, pay: { type: 'salary' } },
  crew: { id: 'u_crew', role: 'crew', claim: true, pay: { type: 'hourly', hourlyRate: 22 } },
  crew2: { id: 'u_crew2', role: 'crew', claim: true, pay: { type: 'hourly', hourlyRate: 20 } },
  sal: { id: 'u_sal', role: 'crew', claim: true, pay: { type: 'salary' } }, // a salaried cleaner — never gated
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k, pay: p.pay }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const tok = (who) => `tok-${who}`;

const NOW = Date.now();
const H = 3600e3; const DAY = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const recentIn = iso(NOW - 2 * DAY);
const recentWeek = payWeekKeyOf(recentIn, 0, TZ);

// A closed, worked punch. duration_minutes is set EXPLICITLY (the ledger reads it), so a
// 3000-min (50 h) punch makes 10 h of weekly OT without a 50-h wall-clock span.
const punch = (o = {}) => ({
  id: 'te_x', organization_id: ORG, user_id: 'u_crew', client_id: 'cl_ever', site_id: 'st_ever', job_id: 'j_ever',
  user_name: 'crew', client_name: 'Las Olas', site_name: 'Main',
  clock_in_at: recentIn, clock_out_at: iso(NOW - 2 * DAY + 8 * H), duration_minutes: 3000,
  status: 'completed', approval_status: 'pending', approved_by: null, approved_at: null,
  geofence_result: 'inside', source: 'crew_mobile', edited: false, job_cancelled_at: null,
  note: null, override_reason: null, expected_minutes_snapshot: 120,
  row_version: 0, edit_history: [], updated_at: recentIn, ...o,
});

function buildWorld({ entries = [], runs = [], otApprovals = [], permissions = seedPermissions() } = {}) {
  const state = {
    users: roster,
    permissions,
    userPermissionOverrides: [],
    company: { timezone: TZ },
    clients: [
      { id: 'cl_ever', name: 'Las Olas', supervisorId: 'u_mgr' },
      { id: 'cl_coral', name: 'Coral Bay', supervisorId: 'u_mgr' },
      { id: 'cl_pac', name: 'Palmetto', supervisorId: 'u_admin' },   // NOT the manager's
      { id: 'cl_orphan', name: 'Unassigned', supervisorId: null },   // no manager (the `none` bucket)
    ],
    sites: [
      { id: 'st_ever', clientId: 'cl_ever', name: 'Main' },
      { id: 'st_pac', clientId: 'cl_pac', name: 'Ridge' },
    ],
    opsSettings: { payPeriodCadence: 'weekly', payWeekStartDay: 0 },
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 3 }],
      time_entries: entries.map((e) => ({ ...e })),
      payroll_runs: runs.map((r) => ({ ...r })),
      time_ot_approvals: otApprovals.map((a) => ({ ...a })),
    },
    logins,
  });
}

async function call({ method = 'POST', path, token, body, query = {} }) {
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
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(time(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
const otApprove = (who, items) => call({ path: 'ot-approve', token: tok(who), body: { items } });
const approvals = (who, supervisorId) => call({ method: 'GET', path: 'approvals', token: tok(who), query: supervisorId === undefined ? {} : { supervisorId } });
const otRow = (userId, weekKey, clientId, minutes, updatedAt = recentIn) => ({ organization_id: ORG, id: `ot_${userId}_${weekKey}_${clientId || 'none'}`, user_id: userId, week_key: weekKey, client_id: clientId || '', approved_ot_minutes: minutes, approved_by: null, approved_at: updatedAt, updated_at: updatedAt });

// ═══ 1. ot-approve: role × scope × own, clamp, bad week, independence ═════════════
{
  buildWorld();
  const r = await otApprove('owner', [{ userId: 'u_crew', weekKey: recentWeek, clientId: 'cl_ever', minutes: 600 }]);
  ok('ot-approve: owner → 200, ok, approvedMinutes 600', r.status === 200 && r.body?.results?.[0]?.ok === true && r.body.results[0].approvedMinutes === 600, show(r));
  const stored = world.tables.time_ot_approvals.find((a) => a.user_id === 'u_crew' && a.week_key === recentWeek && a.client_id === 'cl_ever');
  ok('  the unit total is stored, stamped approved_by', stored && stored.approved_ot_minutes === 600 && stored.approved_by === 'u_owner', JSON.stringify(stored));
}
{
  buildWorld();
  const r = await otApprove('mgr', [{ userId: 'u_crew', weekKey: recentWeek, clientId: 'cl_ever', minutes: 300 }]);
  ok('ot-approve: manager IN scope (cl_ever) → ok', r.status === 200 && r.body?.results?.[0]?.ok === true, show(r));
}
{
  buildWorld();
  const r = await otApprove('mgr', [{ userId: 'u_crew', weekKey: recentWeek, clientId: 'cl_pac', minutes: 300 }]);
  ok('ot-approve: manager OUT of scope (cl_pac) → out-of-scope, nothing written', r.status === 200 && r.body?.results?.[0]?.code === 'out-of-scope' && !world.tables.time_ot_approvals.length, show(r));
}
{
  buildWorld();
  const r = await otApprove('mgr', [{ userId: 'u_mgr', weekKey: recentWeek, clientId: 'cl_ever', minutes: 300 }]);
  ok('ot-approve: manager on their OWN overtime → own-entry', r.status === 200 && r.body?.results?.[0]?.code === 'own-entry', show(r));
  buildWorld();
  const r2 = await otApprove('owner', [{ userId: 'u_owner', weekKey: recentWeek, clientId: 'cl_ever', minutes: 60 }]);
  ok('ot-approve: an OWNER on their own overtime → ok', r2.status === 200 && r2.body?.results?.[0]?.ok === true, show(r2));
}
{
  buildWorld();
  const r = await otApprove('crew', [{ userId: 'u_crew', weekKey: recentWeek, clientId: 'cl_ever', minutes: 60 }]);
  ok('ot-approve: crew → 403 (no time.approve)', r.status === 403, show(r));
}
{
  buildWorld();
  const r = await otApprove('owner', [
    { userId: 'u_crew', weekKey: recentWeek, clientId: 'cl_ever', minutes: 99999 },
    { userId: 'u_crew2', weekKey: recentWeek, clientId: 'cl_ever', minutes: -5 },
  ]);
  ok('ot-approve: minutes clamp to 0..10080', r.body?.results?.[0]?.approvedMinutes === 10080 && r.body?.results?.[1]?.approvedMinutes === 0, show(r));
}
{
  buildWorld();
  // This world's workweek starts on Sunday (opsSettings.payWeekStartDay 0), so a Tuesday key
  // starts no pay week. The org's week start is the rule, not Sunday — a Monday-week org is
  // pinned in test-ot-approve-week-start.mjs (CS-659).
  const r = await otApprove('owner', [{ userId: 'u_crew', weekKey: '2026-06-09', clientId: 'cl_ever', minutes: 60 }]); // a Tuesday
  ok('ot-approve: a week key that does not start the org\'s pay week → invalid-week, nothing written', r.body?.results?.[0]?.ok === false && r.body.results[0].code === 'invalid-week' && !world.tables.time_ot_approvals.length, show(r));
}
{
  buildWorld();
  const r = await otApprove('mgr', [
    { userId: 'u_crew', weekKey: recentWeek, clientId: 'cl_ever', minutes: 120 },   // in scope → ok
    { userId: 'u_crew', weekKey: recentWeek, clientId: 'cl_pac', minutes: 120 },    // out of scope → refused, alone
  ]);
  const codes = (r.body?.results || []).map((x) => x.ok ? 'ok' : x.code);
  ok('ot-approve: per-item independence (ok + out-of-scope side by side)', codes[0] === 'ok' && codes[1] === 'out-of-scope' && world.tables.time_ot_approvals.length === 1, show(r));
}
{
  buildWorld();
  const items = Array.from({ length: 201 }, (_, i) => ({ userId: 'u_crew', weekKey: recentWeek, clientId: `cl_${i}`, minutes: 1 }));
  const r = await otApprove('owner', items);
  ok('ot-approve: more than 200 items → 400', r.status === 400, show(r));
}

// ═══ 2. approvals read: scope, gating, ot_minutes ════════════════════════════════
{
  buildWorld({ entries: [
    punch({ id: 'te_crew_ever', user_id: 'u_crew', client_id: 'cl_ever' }),      // mgr scope, gated → listed
    punch({ id: 'te_crew2_pac', user_id: 'u_crew2', client_id: 'cl_pac', user_name: 'crew2' }), // admin's customer
    punch({ id: 'te_sal_ever', user_id: 'u_sal', client_id: 'cl_ever', user_name: 'sal' }),      // salaried → never listed
  ] });
  const own = await approvals('owner');
  ok('approvals: crew → 403 (checked first)', (await approvals('crew')).status === 403);
  ok('approvals: owner sees BOTH cleaners\' pending, but never the salaried one', own.status === 200
    && (own.body.pending||[]).some((p) => p.id === 'te_crew_ever')
    && (own.body.pending||[]).some((p) => p.id === 'te_crew2_pac')
    && !(own.body.pending||[]).some((p) => p.id === 'te_sal_ever'), show(own));
  const pe = (own.body.pending||[]).find((p) => p.id === 'te_crew_ever');
  ok('approvals: a pending punch carries its attributed OT (ot_minutes = 600) and row_version', pe && pe.ot_minutes === 600 && pe.row_version === 0, JSON.stringify(pe || null).slice(0, 200));
  ok('approvals: owner overtime lists both cleaners\' units (awaiting = due)', (own.body.overtime||[]).some((u) => u.userId === 'u_crew' && u.clientId === 'cl_ever' && u.awaitingMinutes === 600)
    && (own.body.overtime||[]).some((u) => u.userId === 'u_crew2' && u.clientId === 'cl_pac'), JSON.stringify(own.body.overtime||null));

  const mgr = await approvals('mgr');
  ok('approvals: a manager sees ONLY their customers\' pending (cl_ever, not cl_pac)', (mgr.body.pending||[]).some((p) => p.id === 'te_crew_ever') && !(mgr.body.pending||[]).some((p) => p.id === 'te_crew2_pac'), show(mgr));
  ok('approvals: a manager\'s overtime is only their customers', (mgr.body.overtime||[]).every((u) => u.clientId === 'cl_ever' || u.clientId === 'cl_coral') && (mgr.body.overtime||[]).some((u) => u.clientId === 'cl_ever'), JSON.stringify(mgr.body.overtime||null));
  ok('approvals: scope block reports the manager\'s customer ids', mgr.body.scope && mgr.body.scope.unscoped === false && mgr.body.scope.clientIds.includes('cl_ever'), JSON.stringify(mgr.body.scope));

  // supervisorId is IGNORED for a scoped caller.
  const mgrFiltered = await approvals('mgr', 'u_admin');
  ok('approvals: supervisorId ignored for a scoped manager (still only their own)', (mgrFiltered.body.pending||[]).some((p) => p.id === 'te_crew_ever') && !(mgrFiltered.body.pending||[]).some((p) => p.id === 'te_crew2_pac'), show(mgrFiltered));
}

// ═══ 3. approvals: supervisorId honoured for an owner (incl. `none`) ═════════════
{
  buildWorld({ entries: [
    punch({ id: 'te_ever', user_id: 'u_crew', client_id: 'cl_ever' }),           // u_mgr's
    punch({ id: 'te_pac', user_id: 'u_crew2', client_id: 'cl_pac', user_name: 'crew2' }), // u_admin's
    punch({ id: 'te_orphan', user_id: 'u_crew', client_id: 'cl_orphan' }),        // no manager
    punch({ id: 'te_nocust', user_id: 'u_crew', client_id: null, site_id: null, job_id: null }), // no customer
  ] });
  const byMgr = await approvals('owner', 'u_mgr');
  ok('approvals ?supervisorId=u_mgr: owner sees u_mgr\'s customer only', (byMgr.body.pending||[]).some((p) => p.id === 'te_ever') && !(byMgr.body.pending||[]).some((p) => p.id === 'te_pac') && !(byMgr.body.pending||[]).some((p) => p.id === 'te_orphan'), show(byMgr));
  const none = await approvals('owner', 'none');
  ok('approvals ?supervisorId=none: owner sees no-manager customers + no-customer punches', (none.body.pending||[]).some((p) => p.id === 'te_orphan') && (none.body.pending||[]).some((p) => p.id === 'te_nocust') && !(none.body.pending||[]).some((p) => p.id === 'te_ever'), show(none));
  // S131 Wave 2 (the owner's Operations view's Hours Approval tile): `supervisorId=team` is the
  // CALLER's team, and an owner or an admin may name WHOSE (`om`, an active Operations Manager —
  // lib/teamScope teamLeadFor). u_mgr leads a team of one here (its own two customers).
  world.tables.org_state[0].state.users = world.tables.org_state[0].state.users.map((u) => (u.id === 'u_mgr' ? { ...u, managerLevel: 'operations' } : u));
  const teamOf = (who, om) => call({ method: 'GET', path: 'approvals', token: tok(who), query: { supervisorId: 'team', ...(om ? { om } : {}) } });
  const ids = (r) => (r.body.pending || []).map((p) => p.id).sort().join();
  const ownerOm = await teamOf('owner', 'u_mgr');
  ok('🔴 approvals ?supervisorId=team&om=<an OM>: the owner sees that Operations Manager\'s team only (no other customer, no no-customer punch)', ownerOm.status === 200 && ids(ownerOm) === 'te_ever', show(ownerOm));
  const adminOm = await teamOf('admin', 'u_mgr');
  ok('… an admin too', adminOm.status === 200 && ids(adminOm) === 'te_ever', show(adminOm));
  const ownerNotOm = await teamOf('owner', 'u_admin');
  ok('… an `om` that is not an active Operations Manager names no team (the owner\'s own: nothing)', ownerNotOm.status === 200 && ids(ownerNotOm) === '', show(ownerNotOm));
}

// ═══ 4. pre-ledger punches drop once a run exists ════════════════════════════════
{
  const RUN = {
    organization_id: ORG, id: 'run_jun', period_key: '2026-06-01', cadence: 'weekly',
    from_key: '2026-06-01', to_key: '2026-06-30', from_iso: '2026-06-01T04:00:00Z', to_iso: '2026-07-01T03:59:59Z',
    status: 'closed', closed_at: '2026-07-01T14:00:00Z', closed_by: 'u_owner', pending_policy: 'rollForward',
    rolled_forward: {}, paid_weeks: [], held_ot: [], file: {},
  };
  buildWorld({ runs: [RUN], entries: [
    punch({ id: 'te_preledger', user_id: 'u_crew', client_id: 'cl_ever', clock_in_at: '2026-05-10T12:00:00Z', clock_out_at: '2026-05-10T20:00:00Z', duration_minutes: 480, updated_at: '2026-05-10T20:00:00Z' }),
    punch({ id: 'te_open', user_id: 'u_crew', client_id: 'cl_ever' }), // recent (open territory)
  ] });
  const own = await approvals('owner');
  ok('approvals: a pre-ledger punch (before the first run) is NOT listed; the open-territory one is', !(own.body.pending||[]).some((p) => p.id === 'te_preledger') && (own.body.pending||[]).some((p) => p.id === 'te_open'), show(own));
  ok('approvals: ledger bounds reported', own.body.ledger && own.body.ledger.firstFromKey === '2026-06-01' && own.body.ledger.latestToKey === '2026-06-30' && !!own.body.asOf, JSON.stringify(own.body.ledger));
}

// ═══ 5. overtime for a CHANGED week (the 1-hour threshold) ═══════════════════════
// A June run closed 2026-07-01T14:00Z → threshold 13:00Z. An APPROVED 50 h punch in the
// week of 2026-06-07 changed at 13:30Z (> threshold) → its week is recomputed and its
// unapproved OT surfaces. An identical punch in the week of 2026-06-14 changed at 12:00Z
// (< threshold) → that week is NOT reconsidered, so its OT does not surface.
{
  const RUN = {
    organization_id: ORG, id: 'run_jun', period_key: '2026-06-01', cadence: 'weekly',
    from_key: '2026-05-24', to_key: '2026-06-30', from_iso: '2026-05-24T04:00:00Z', to_iso: '2026-07-01T03:59:59Z',
    status: 'closed', closed_at: '2026-07-01T14:00:00Z', closed_by: 'u_owner', pending_policy: 'rollForward',
    rolled_forward: {}, paid_weeks: [], held_ot: [], file: {},
  };
  const approvedPunch = (o) => punch({ approval_status: 'approved', approved_by: 'u_owner', approved_at: '2026-06-20T00:00:00Z', ...o });
  buildWorld({ runs: [RUN], entries: [
    approvedPunch({ id: 'te_changed', user_id: 'u_crew', client_id: 'cl_ever', clock_in_at: '2026-06-08T08:00:00-04:00', clock_out_at: '2026-06-08T16:00:00-04:00', duration_minutes: 3000, updated_at: '2026-07-01T13:30:00Z' }),
    approvedPunch({ id: 'te_unchanged', user_id: 'u_crew', client_id: 'cl_coral', clock_in_at: '2026-06-15T08:00:00-04:00', clock_out_at: '2026-06-15T16:00:00-04:00', duration_minutes: 3000, updated_at: '2026-07-01T12:00:00Z' }),
  ] });
  const own = await approvals('owner');
  const changedWeek = payWeekKeyOf('2026-06-08T08:00:00-04:00', 0, TZ);
  const unchangedWeek = payWeekKeyOf('2026-06-15T08:00:00-04:00', 0, TZ);
  ok('approvals: OT of the week CHANGED 30 min before close surfaces', (own.body.overtime||[]).some((u) => u.weekKey === changedWeek && u.clientId === 'cl_ever' && u.awaitingMinutes === 600), JSON.stringify(own.body.overtime||null));
  ok('approvals: OT of the week changed 2 h before close (below threshold) does NOT surface', !(own.body.overtime||[]).some((u) => u.weekKey === unchangedWeek), `unchangedWeek=${unchangedWeek} ${JSON.stringify(own.body.overtime||null)}`);
}

// ═══ 6. overtime for a HELD_OT week (carried forward) ════════════════════════════
// The latest run carries a held_ot entry for the week of 2026-05-31. An APPROVED 50 h punch
// that week (in closed territory, unchanged) surfaces its unapproved OT ONLY because the
// held_ot week is reconsidered; drop the held_ot entry and it does not.
{
  const heldWeek = payWeekKeyOf('2026-06-01T08:00:00-04:00', 0, TZ); // 2026-05-31
  const runWith = (held) => ({
    organization_id: ORG, id: 'run_jun', period_key: '2026-06-01', cadence: 'weekly',
    from_key: '2026-05-24', to_key: '2026-06-30', from_iso: '2026-05-24T04:00:00Z', to_iso: '2026-07-01T03:59:59Z',
    status: 'closed', closed_at: '2026-07-01T14:00:00Z', closed_by: 'u_owner', pending_policy: 'rollForward',
    rolled_forward: {}, paid_weeks: [], held_ot: held, file: {},
  });
  const heldPunch = punch({ id: 'te_held', user_id: 'u_crew', client_id: 'cl_ever', approval_status: 'approved', approved_by: 'u_owner', approved_at: '2026-06-05T00:00:00Z', clock_in_at: '2026-06-01T08:00:00-04:00', clock_out_at: '2026-06-01T16:00:00-04:00', duration_minutes: 3000, updated_at: '2026-06-01T20:00:00Z' });
  buildWorld({ runs: [runWith([{ userId: 'u_crew', weekKey: heldWeek, clientId: 'cl_ever', dueMinutes: 600, approvedMinutes: 0, heldMinutes: 600 }])], entries: [heldPunch] });
  const withHeld = await approvals('owner');
  ok('approvals: a held_ot week is reconsidered → its awaiting OT surfaces', (withHeld.body.overtime||[]).some((u) => u.weekKey === heldWeek && u.clientId === 'cl_ever' && u.awaitingMinutes === 600), JSON.stringify(withHeld.body.overtime||null));
  buildWorld({ runs: [runWith([])], entries: [heldPunch] });
  const noHeld = await approvals('owner');
  ok('approvals: without the held_ot entry that closed-territory week is NOT reconsidered', !(noHeld.body.overtime||[]).some((u) => u.weekKey === heldWeek), JSON.stringify(noHeld.body.overtime||null));
}

console.log(`\ntime-approvals-read: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
