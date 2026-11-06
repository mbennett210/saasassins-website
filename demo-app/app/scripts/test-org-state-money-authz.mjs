// The org_state save route end to end, offline, for the MONEY slices: the REAL handler
// (api/state/org-state.js) + the real Supabase client, against scripts/fake-supabase-http
// .mjs (GoTrue + PostgREST on 127.0.0.1, jsonb keys handed back shortest-first as
// Postgres does). It pins what the pure guard suite (test-org-state-guard.mjs) can't see:
//   · CS-002: a crew (non-office) login's crafted money save no longer 403s — the crew MERGE
//     commits (200) with the change DROPPED, so the money slice is unchanged (payroll line,
//     reimbursement, OT multiplier, own/other pay). The GUARD's 403 is still exercised by the
//     office (manager) cases below and unit-tested in test-org-state-guard.mjs;
//   · a payroll.edit / hr.edit / time.config holder's legitimate save still commits;
//   · approving your OWN reimbursement is refused for a manager but not the owner;
//   · a money change PAYS the protected read; a save touching no money slice does not;
//   · the first save after the fingerprint-format change raises exactly one
//     org_state.baseline_mismatch, then heals.
// The manager's login carries no claims, as in production (claims.js has no 'manager'),
// so the route resolves them by email from the blob.
//
//   node scripts/test-org-state-money-authz.mjs
import { readFileSync } from 'node:fs';
import { startFakeSupabase, jsonbOrder } from './fake-supabase-http.mjs';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { seedPermissions } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} (${detail})` : label); };

const ORG = '00000000-0000-0000-0000-000000000001';
const USERS = {
  't-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner' } },
  't-admin': { id: 'a-admin', email: 'admin@cs.co', app_metadata: { role: 'admin', org_user_id: 'u_admin' } },
  't-crew': { id: 'a-crew', email: 'crew@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_crew' } },
  't-mgr': { id: 'a-mgr', email: 'mgr@cs.co', app_metadata: {} }, // claim-less: resolves by email
};
const fake = await startFakeSupabase({ authUsers: USERS });
// Before the import: _lib/orgState.js reads the org id when it loads.
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
const alerts = [];
const consoleError = console.error;
console.error = (...args) => { if (args[0] === '[ALERT]') alerts.push(args[1]); else consoleError(...args); };
const { default: handler } = await import('../api/state/org-state.js');
// CS-002: a crew (non-office) save now routes through the crew MERGE, which reads the caller's
// jobs from public.jobs (getCrewJobs). Seed an empty jobs table so that read succeeds (these
// money cases don't depend on job-based scope).
fake.tables.jobs = [];
// W2-L: the guard reads payroll_runs when a pay line's money or the pay schedule moves
// (payrollLedgerFactNeeded). Seed it empty so the HTTP fake serves the table (unseeded → 404,
// which would fail the closed-period rule closed on every money save). Closed-period /
// cadence route cases below seed a run into it, then clear it.
fake.tables.payroll_runs = [];

const seedState = () => ({
  version: 56,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  timeOff: [],
  sites: [{ id: 's1', clientId: 'c1', name: 'HQ', standingCrewIds: [] }],
  // c2 is supervised by u_mgr2 (a manager) so a manager removing that manager exercises the
  // DELETE_USER supervisor cascade (MTA W1-G regression): the sweep nulls c2.supervisorId.
  clients: [{ id: 'c1', name: 'Acme', standingCrewIds: [] }, { id: 'c2', name: 'Beta', standingCrewIds: [], supervisorId: 'u_mgr2' }],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
    { id: 'u_admin', role: 'admin', status: 'active', name: 'Admin', email: 'admin@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0000' } },
    { id: 'u_mgr2', role: 'manager', status: 'active', name: 'Mgr2', email: 'mgr2@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0006' } },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mgr', email: 'mgr@cs.co', pay: { type: 'salary', salaryPerPeriod: 2800, otExempt: true },
      hr: { employeeId: 'EMP-0002', hireDate: '2025-09-19', employmentType: 'full_time', ptoAllowanceDays: 18 } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: 'crew@cs.co', phone: '555-0101', pay: { type: 'hourly', hourlyRate: 20 },
      hr: { employeeId: 'EMP-0003', ptoAllowanceDays: 10 }, notificationPrefs: { mobilePushEnabled: true, jobAssigned: true } },
    { id: 'u_member', role: 'crew', status: 'active', name: 'Member', email: 'member@cs.co', phone: '555-0100', pay: { type: 'hourly', hourlyRate: 20 },
      hr: { employeeId: 'EMP-0004', hireDate: '2025-01-02', ptoAllowanceDays: 10 } },
  ],
  payrollLines: [
    { id: 'pl_member', userId: 'u_member', periodKey: '2026-09-01', kind: 'earning', category: 'bonus', label: 'Perf', amount: 100, taxable: true, createdBy: 'u_owner' },
  ],
  reimbursements: [
    { id: 'rmb_member', userId: 'u_member', amount: 40, status: 'pending', periodKey: '2026-09-01', description: 'gas' },
    { id: 'rmb_mgr', userId: 'u_mgr', amount: 60, status: 'pending', periodKey: '2026-09-01', description: 'parking' },
    { id: 'rmb_adm', userId: 'u_admin', amount: 30, status: 'pending', periodKey: '2026-09-01', description: 'supplies' },
  ],
  opsSettings: { otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0, payDriveTime: true, defaultGeofenceRadiusM: 120 },
  notes: [],
});

// One POST, as store/sync.js sends it: the state serialized by canonicalJson.
async function save(token, state, baseVersion) {
  const text = `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":0,"tab":"tab-1"}`;
  const req = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
  await handler(req, res);
  return out;
}
const row = () => fake.tables.org_state[0];
const adopted = () => ({ state: JSON.parse(JSON.stringify(jsonbOrder(row().state))), version: row().version });
// A fresh org (the seed, optionally adjusted), then the owner's first save stores its digest.
async function freshOrg(adjust = () => {}) {
  const seed = seedState();
  adjust(seed);
  fake.tables.org_state.splice(0, fake.tables.org_state.length, {
    organization_id: ORG, state: seed, version: 1, protected_fingerprint: null, min_client_build: null,
  });
  const { state, version } = adopted();
  const r = await save('t-owner', state, version);
  if (r.status !== 200) throw new Error(`bootstrap save failed: ${r.status} ${JSON.stringify(r.body)}`);
}
// Run one save and report what it cost.
async function measure(token, edit, from = adopted()) {
  const reads0 = fake.reads(/users:state->users/);
  const alerts0 = alerts.length;
  const version0 = row().version;
  const state = JSON.parse(JSON.stringify(from.state));
  edit(state);
  const r = await save(token, state, from.version);
  // Every authenticated save now pays ONE mandatory `users` read for the roster-status
  // check in resolveAuthority (S93 — a disabled member is refused on any route). It is not
  // a money/authority-guard read, so subtract it: `reads` stays "protected reads ABOVE the
  // status baseline", which is what these caching-law assertions mean.
  return { ...r, reads: fake.reads(/users:state->users/) - reads0 - 1, alerts: alerts.slice(alerts0), wrote: row().version !== version0 };
}
const refused = (r, words) => r.status === 403 && (r.body?.violations || []).includes(words) && !r.wrote;
// CS-002: a crew (non-office) save no longer 403s on a disallowed change — the crew MERGE
// commits (200) with the change DROPPED, so the committed slice equals what it was before the
// save. The money GUARD's 403 is still route-tested via the office (t-mgr / t-owner) cases
// below and unit-tested in test-org-state-guard.mjs; the crew merge-drop is also covered by
// test-crew-merge-route.mjs. `before` is captured right before the save.
// Canonical (key-sorted) compare: readOrgState re-orders jsonb keys, so a plain stringify of
// the committed slice would differ from the pre-save capture in key order alone.
const canon = (slice) => canonicalJson(row().state[slice] ?? null);
const dropsChange = (r, slice, before) => r.status === 200 && canon(slice) === before;
const show = (r) => `${r.status} ${JSON.stringify(r.body)} reads=${r.reads} alerts=${r.alerts.join(',')}`;
const line = (o) => ({ periodKey: '2026-09-01', kind: 'earning', taxable: true, ...o });

// ── the free path: a save touching no money slice never pays a MONEY read ──────
// (it still pays the one mandatory roster-status read that measure() baselines out — S93)
await freshOrg();
{
  // An OFFICE role on the fast path: a save touching no money slice never pays a MONEY read
  // (the fingerprint is unchanged). Crew no longer exercise this path (they merge), so the
  // fast-path optimization is asserted with a manager here.
  const r = await measure('t-mgr', (s) => { s.notes.push({ id: 'n1', body: 'hi' }); });
  ok('a manager adds a note (no money slice): 200, no money-guard read beyond the mandatory status read', r.status === 200 && r.wrote && r.reads === 0, show(r));
}

// ── payroll lines ──────────────────────────────────────────────────────────
{
  const before = canon('payrollLines');
  const r = await measure('t-crew', (s) => s.payrollLines.push(line({ id: 'plX', userId: 'u_crew', category: 'bonus', amount: 5000 })));
  ok('crew CANNOT add a $5,000 self-bonus payroll line: merge DROPS it (200, not committed)', dropsChange(r, 'payrollLines', before), show(r));
}
{
  const before = canon('payrollLines');
  const r = await measure('t-crew', (s) => { s.payrollLines[0].amount = 9999; });
  ok('crew CANNOT edit a payroll line amount: merge DROPS it', dropsChange(r, 'payrollLines', before), show(r));
}
{
  const r = await measure('t-mgr', (s) => s.payrollLines.push(line({ id: 'plZ', userId: 'u_member', category: 'bonus', amount: 200 })));
  ok('a manager (payroll.edit) CAN add a payroll line: 200', r.status === 200 && r.wrote, show(r));
}
{
  // MTA W1-G: your OWN pay line is owner-only now (was a payroll.edit carve-out). RED pre-fix.
  const r = await measure('t-mgr', (s) => s.payrollLines.push(line({ id: 'plS', userId: 'u_mgr', category: 'bonus', amount: 200 })));
  ok('a manager CANNOT add their OWN payroll line (owner-only, MTA W1-G): 403', refused(r, 'add or change your own pay line'), show(r));
}
{
  const r = await measure('t-admin', (s) => s.payrollLines.push(line({ id: 'plAdOwn', userId: 'u_admin', category: 'bonus', amount: 200 })));
  ok('an admin CANNOT add their OWN payroll line (owner-only; was allowed by role): 403', refused(r, 'add or change your own pay line'), show(r));
}
{
  // CS-003 (2026-10-03): an Admin needs payroll.edit like everyone but the Super Admin — the
  // Payroll screen asks them for it and Q24 gives an Admin no payroll key. Was 200 by role.
  const r = await measure('t-admin', (s) => s.payrollLines.push(line({ id: 'plAdOther', userId: 'u_member', category: 'bonus', amount: 50 })));
  ok("CS-003: an admin WITHOUT payroll.edit CANNOT add ANOTHER member's payroll line: 403", refused(r, 'add or change a payroll line'), show(r));
  await freshOrg((s) => { s.userPermissionOverrides = [{ userId: 'u_admin', grants: ['payroll.edit'], revokes: [] }]; });
  const g = await measure('t-admin', (s) => s.payrollLines.push(line({ id: 'plAdOther2', userId: 'u_member', category: 'bonus', amount: 50 })));
  ok("  ...an admin GIVEN payroll.edit CAN: 200", g.status === 200 && g.wrote, show(g));
  await freshOrg();
}

// ── reimbursements ─────────────────────────────────────────────────────────
{
  const beforeR = canon('reimbursements');
  const beforeP = canon('payrollLines');
  const r = await measure('t-crew', (s) => { s.reimbursements[0].status = 'approved'; s.payrollLines.push(line({ id: 'plC', userId: 'u_member', category: 'reimbursement', amount: 40, taxable: false })); });
  ok('crew CANNOT approve a reimbursement (crafted): merge DROPS it (reimbursements + pay line unchanged)',
    r.status === 200 && canon('reimbursements') === beforeR && canon('payrollLines') === beforeP, show(r));
}
{
  const r = await measure('t-mgr', (s) => { s.reimbursements.find((x) => x.userId === 'u_member').status = 'approved'; s.payrollLines.push(line({ id: 'plRb', userId: 'u_member', category: 'reimbursement', amount: 40, taxable: false })); });
  ok('a manager (hr.edit) CAN approve ANOTHER member\'s reimbursement + its pay line: 200', r.status === 200 && r.wrote, show(r));
}
{
  const r = await measure('t-mgr', (s) => { s.reimbursements.find((x) => x.userId === 'u_mgr').status = 'approved'; s.payrollLines.push(line({ id: 'plM', userId: 'u_mgr', category: 'reimbursement', amount: 60, taxable: false })); });
  ok('a manager CANNOT approve their OWN reimbursement: 403', refused(r, 'approve your own reimbursement'), show(r));
}
{
  const r = await measure('t-owner', (s) => { s.reimbursements.find((x) => x.userId === 'u_mgr').status = 'approved'; s.payrollLines.push(line({ id: 'plO', userId: 'u_mgr', category: 'reimbursement', amount: 60, taxable: false })); });
  ok('the owner CAN approve any reimbursement: 200', r.status === 200 && r.wrote, show(r));
}
{
  // MTA W1-G: approving your OWN reimbursement is owner-only now (was owner/admin). RED pre-fix.
  const r = await measure('t-admin', (s) => { s.reimbursements.find((x) => x.userId === 'u_admin').status = 'approved'; s.payrollLines.push(line({ id: 'plAdR', userId: 'u_admin', category: 'reimbursement', amount: 30, taxable: false })); });
  ok('an admin CANNOT approve their OWN reimbursement (owner-only now, MTA W1-G): 403', refused(r, 'approve your own reimbursement'), show(r));
}
{
  // CS-003 (2026-10-03): approving another member's reimbursement takes hr.edit for an Admin too
  // (the Reimbursements tab gates every role on it). Was 200 by role.
  const approveMember = (id) => (s) => { s.reimbursements.find((x) => x.userId === 'u_member').status = 'approved'; s.payrollLines.push(line({ id, userId: 'u_member', category: 'reimbursement', amount: 40, taxable: false })); };
  const r = await measure('t-admin', approveMember('plAdRo'));
  ok("CS-003: an admin WITHOUT hr.edit CANNOT approve ANOTHER member's reimbursement: 403", r.status === 403 && !r.wrote, show(r));
  await freshOrg((s) => { s.userPermissionOverrides = [{ userId: 'u_admin', grants: ['hr.edit'], revokes: [] }]; });
  const g = await measure('t-admin', approveMember('plAdRo2'));
  ok("  ...an admin GIVEN hr.edit CAN: 200", g.status === 200 && g.wrote, show(g));
  await freshOrg();
}

// ── pay + HR record on a user row (money / PII, 2026-09-23 — HANDOFF S79 FOUND 2) ──
{
  const before = canon('users');
  const r = await measure('t-crew', (s) => { s.users.find((u) => u.id === 'u_crew').pay = { type: 'hourly', hourlyRate: 999 }; });
  ok('crew CANNOT raise their OWN pay: merge DROPS it (users unchanged)', dropsChange(r, 'users', before), show(r));
}
{
  const before = canon('users');
  const r = await measure('t-crew', (s) => { s.users.find((u) => u.id === 'u_member').pay = { type: 'hourly', hourlyRate: 999 }; });
  ok("crew CANNOT change ANOTHER member's pay: merge DROPS it (users unchanged)", dropsChange(r, 'users', before), show(r));
}
{
  const before = canon('users');
  const r = await measure('t-crew', (s) => { s.users.find((u) => u.id === 'u_crew').hr = { employeeId: 'EMP-0003', ptoAllowanceDays: 99 }; });
  ok('crew CANNOT change their OWN HR record: merge DROPS it (users unchanged)', dropsChange(r, 'users', before), show(r));
}
{
  const r = await measure('t-mgr', (s) => { s.users.find((u) => u.id === 'u_mgr').pay = { type: 'salary', salaryPerPeriod: 9999, otExempt: true }; });
  ok('a manager CANNOT raise their OWN pay (owner/admin only): 403', refused(r, 'change your own pay'), show(r));
}
{
  const r = await measure('t-owner', (s) => { s.users.find((u) => u.id === 'u_crew').pay = { type: 'hourly', hourlyRate: 25 }; });
  ok("the owner CAN change a member's pay: 200", r.status === 200 && r.wrote, show(r));
}
{
  const r = await measure('t-crew', (s) => { s.users.find((u) => u.id === 'u_crew').name = 'Renamed Self'; });
  ok('crew CAN edit their own name — cosmetic, free (no deep read): 200', r.status === 200 && r.wrote && r.reads === 0, show(r));
}

// ── operations settings (pay-run config + geofence/variance, whole slice) ─────
{
  const before = canon('opsSettings');
  const r = await measure('t-crew', (s) => { s.opsSettings.otMultiplier = 5; });
  ok('crew CANNOT set the OT multiplier to 5: merge DROPS it (opsSettings unchanged)', dropsChange(r, 'opsSettings', before), show(r));
}
{
  const r = await measure('t-mgr', (s) => { s.opsSettings.otMultiplier = 2; });
  ok('a manager (time.config) CAN change the OT multiplier: 200', r.status === 200 && r.wrote, show(r));
}
{
  const before = canon('opsSettings');
  const r = await measure('t-crew', (s) => { s.opsSettings.defaultGeofenceRadiusM = 5000; });
  ok('crew CANNOT widen the geofence radius: merge DROPS it (whole opsSettings never merged for crew)', dropsChange(r, 'opsSettings', before), show(r));
}

// ── a member removal keeps + userName-stamps their pay records: not refused ────
await freshOrg((seed) => { seed.userPermissionOverrides = [{ userId: 'u_crew', grants: ['settings.team.edit'], revokes: ['payroll.edit', 'hr.edit'] }]; });
{
  const r = await measure('t-crew', (s) => {
    s.users = s.users.filter((u) => u.id !== 'u_member');
    for (const l of s.payrollLines) if (l.userId === 'u_member') l.userName = 'Member (removed)';
    for (const x of s.reimbursements) if (x.userId === 'u_member') x.userName = 'Member (removed)';
  });
  // The point is my MONEY rules must not treat the userName stamp on a removed member's
  // kept lines/reimbursements as a money change. The removal itself may be refused by
  // S80's separate "may still be owed pay" rule (which fails closed offline), so assert
  // only that NO money violation fired — not that the whole save committed.
  ok('a member removal raises NO money violation from the userName stamp on their kept pay records',
    !(r.body?.violations || []).some((x) => /payroll line|reimbursement|pay-run config/.test(x)), show(r));
}

// ── MTA W1-G: DELETE_USER's supervisor cascade is authority-neutral (regression) ─────
// sweepUserOrphans nulls a removed member's supervised customers. A manager may remove
// another manager (teamLimits), so that removal save carries a supervisorId -> null cascade;
// clearing a supervisor GONE from next.users is not an assignment, so the guard must not 403
// it (a 403 drops the whole pending batch while Team still offers Remove). u_mgr2 (hourly,
// nothing owed) supervises c2. RED pre-fix (403 'assign a location's manager'); GREEN after.
await freshOrg();
{
  // The removal itself may still 403 on the "may still be owed pay" rule, which fails closed
  // offline (no real time ledger) — the same caveat as the userName-stamp removal test above.
  // So assert only that NO supervisor violation fired: RED pre-fix (it did), GREEN after.
  const r = await measure('t-mgr', (s) => { s.users = s.users.filter((u) => u.id !== 'u_mgr2'); const c = s.clients.find((x) => x.id === 'c2'); if (c) c.supervisorId = null; });
  ok("a manager removing a supervising MANAGER (cascade-clear) raises NO 'assign a location's manager' violation",
    !(r.body?.violations || []).includes("assign a location's manager"), show(r));
}

// ── the first save after a fingerprint-format change: exactly one alarm ────────
await freshOrg();
row().protected_fingerprint = 'stale-pre-deploy-digest-0000000000000000000000000000000000000000';
{
  const r = await measure('t-mgr', (s) => s.payrollLines.push(line({ id: 'plHeal', userId: 'u_member', category: 'bonus', amount: 10 })));
  ok('a stale stored digest raises exactly one baseline_mismatch on the first judged save, then commits',
    r.status === 200 && r.wrote && r.alerts.filter((a) => a === 'org_state.baseline_mismatch').length === 1, show(r));
  const r2 = await measure('t-mgr', (s) => s.payrollLines.push(line({ id: 'plHeal2', userId: 'u_member', category: 'bonus', amount: 11 })));
  ok('the next save no longer alarms (the digest healed)', r2.status === 200 && r2.alerts.length === 0, show(r2));
}

// ── W2-L: closed payroll periods + the pay schedule are frozen (route end-to-end) ──
// A closed run is seeded for '2026-09-01' (the seed's pay lines live there). The guard reads
// payroll_runs because a pay line's money / the schedule moves (payrollLedgerFactNeeded) and
// refuses the change for the office roles that reach it (owner AND manager). RED pre-fix: the
// guard had no closed-period rule, so both committed.
await freshOrg();
fake.tables.payroll_runs.splice(0, fake.tables.payroll_runs.length, {
  organization_id: ORG, id: 'run_sep1', period_key: '2026-09-01', cadence: 'biweekly',
  from_key: '2026-09-01', to_key: '2026-09-14', from_iso: '2026-09-01T04:00:00Z', to_iso: '2026-09-15T03:59:59Z',
  closed_at: '2026-09-16T14:00:00Z', held_ot: [],
});
{
  const mgrClosed = await measure('t-mgr', (s) => s.payrollLines.push(line({ id: 'plClosed', userId: 'u_member', category: 'bonus', amount: 100 })));
  ok('W2-L route: a MANAGER cannot add a pay line in a CLOSED period → 403', refused(mgrClosed, 'change pay in a closed payroll period'), show(mgrClosed));
  const ownerClosed = await measure('t-owner', (s) => s.payrollLines.push(line({ id: 'plClosedO', userId: 'u_member', category: 'bonus', amount: 100 })));
  ok('W2-L route: the OWNER cannot add a pay line in a CLOSED period → 403 (frozen for everyone)', refused(ownerClosed, 'change pay in a closed payroll period'), show(ownerClosed));
  const editClosed = await measure('t-owner', (s) => { s.payrollLines.find((l) => l.id === 'pl_member').amount = 9999; });
  ok('W2-L route: editing an existing CLOSED-period line is refused (owner) → 403', refused(editClosed, 'change pay in a closed payroll period'), show(editClosed));
  const openOk = await measure('t-owner', (s) => s.payrollLines.push(line({ id: 'plOpen', userId: 'u_member', category: 'bonus', amount: 100, periodKey: '2026-09-16' })));
  ok('W2-L route: a pay line in an OPEN period still commits (owner) → 200', openOk.status === 200 && openOk.wrote, show(openOk));
  const cadence = await measure('t-owner', (s) => { s.opsSettings.payPeriodCadence = 'weekly'; });
  ok('W2-L route: the OWNER cannot change the pay cadence once a run exists → 403', refused(cadence, 'change the pay schedule after a payroll is closed'), show(cadence));
}
fake.tables.payroll_runs.splice(0, fake.tables.payroll_runs.length);

await fake.close();

// ── UI wiring: ReimbursementsTab hides Approve on the caller's OWN row ─────────
// A source-shape check (the JSX gate isn't rendered offline): approving your own is
// owner/admin only on the server, and a refused save drops the whole pending batch
// (store/sync.js), so the button must not offer it. FALSE against the pre-fix source.
{
  const src = readFileSync(new URL('../src/pages/hr/ReimbursementsTab.jsx', import.meta.url), 'utf8');
  const has = (n) => src.replace(/\s+/g, ' ').includes(n.replace(/\s+/g, ' '));
  ok('UI: canApproveOwn is owner only (MTA W1-G; was owner/admin)', has("const canApproveOwn = myRole === 'owner';"));
  ok('UI: mayApprove blocks your own row unless canApproveOwn', has('const mayApprove = (r) => canEdit && (r.userId !== currentUserId || canApproveOwn);'));
  ok('UI: the Approve button sits behind mayApprove(r)', has('{mayApprove(r)') && has('onClick={() => approve(r)}'));
  ok('UI: approve() defends against own-approval (stale UI state)', has('if (r.userId === currentUserId && !canApproveOwn)'));
}

// ── UI wiring: your OWN pay + HR record are read-only unless owner/admin (2026-09-23) ──
{
  const td = readFileSync(new URL('../src/pages/settings/TeamDetail.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const hr = readFileSync(new URL('../src/components/EmployeeHrFieldsCard.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const hasT = (n) => td.includes(n.replace(/\s+/g, ' '));
  const hasH = (n) => hr.includes(n.replace(/\s+/g, ' '));
  ok('UI: TeamDetail computes canEditThisPay = canEditRates && (not own OR owner/admin)',
    hasT("const canEditThisPay = canEditRates && (!ownRow || currentUser?.role === 'owner' || currentUser?.role === 'admin');"));
  ok('UI: the Pay save threads canEditThisPay (not canEditRates)', hasT("if (canEditThisPay && 'pay' in edits) patch.pay = current.pay;"));
  ok('UI: the Pay fields + Save button gate on canEditThisPay', hasT('disabled={!canEditThisPay}') && hasT('{canEditThisPay && ('));
  ok('UI: HR card computes ownRecordLocked (own row, not owner/admin)',
    hasH("const ownRecordLocked = !!currentUser && user.id === currentUser.id && !(currentUser.role === 'owner' || currentUser.role === 'admin');"));
  ok('UI: HR card gates fields + Save on canEditThis and save() defends', hasH('disabled={!canEditThis}') && hasH('{canEditThis && (') && hasH('if (!canEditThis) return;'));
}

// ── UI wiring: the W1-G separation-of-duties mirrors (MTA §8.6) ────────────────
// The server (orgStateGuard) is the boundary; each card must offer only what it accepts,
// with the reason in visible text. Source-shape checks (the JSX gate isn't rendered offline);
// FALSE against the pre-fix sources. Role is resolved claims-first (currentUser?.role from
// selectCurrentUser / the auth hooks), never a new source.
{
  const svc = readFileSync(new URL('../src/components/ServiceSetupCard.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const sup = readFileSync(new URL('../src/components/SupervisedCustomersCard.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const drw = readFileSync(new URL('../src/pages/payroll/PayrollLineDrawer.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const spc = readFileSync(new URL('../src/pages/hr/SpecialServicesTab.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const inc = (src, n) => src.includes(n.replace(/\s+/g, ' '));
  // ServiceSetupCard: the supervisor select is owner/admin only, with the reason.
  ok('UI: ServiceSetupCard computes canAssignManager = owner/admin', inc(svc, "const canAssignManager = currentUser?.role === 'owner' || currentUser?.role === 'admin';"));
  ok('UI: ServiceSetupCard supervisor Select is gated on canAssignManager', inc(svc, 'disabled={!canEdit || !canAssignManager}'));
  ok('UI: ServiceSetupCard shows the reason for a non-owner/admin', inc(svc, 'Only a Super Admin or Admin assigns a location'));
  // SupervisedCustomersCard: the bulk mover is owner/admin only, with the reason.
  ok('UI: SupervisedCustomersCard computes canAssignManager = owner/admin', inc(sup, "const canAssignManager = currentUser?.role === 'owner' || currentUser?.role === 'admin';"));
  ok('UI: SupervisedCustomersCard gates edits on canAssign', inc(sup, 'const canAssign = canEdit && canAssignManager;'));
  ok('UI: SupervisedCustomersCard shows the reason', inc(sup, 'Only a Super Admin or Admin assigns a location'));
  // PayrollLineDrawer: your own row is read-only unless owner, with the reason.
  ok('UI: PayrollLineDrawer locks your own row unless owner', inc(drw, "user.id === currentUserId && me?.role !== 'owner'"));
  // W3-P §8.5 extended mayEditLines to ALSO lock a closed pay period (read-only; a correction
  // is paid as arrears). This asserts the stronger rule, not a looser one.
  ok('UI: PayrollLineDrawer gates line edits on mayEditLines (incl. closed period)', inc(drw, 'const mayEditLines = canEdit && !ownLineLocked && !periodClosed;'));
  ok('UI: PayrollLineDrawer shows the reason', inc(drw, 'Only a Super Admin can add or change your own pay lines'));
  ok('UI: PayrollLineDrawer locks a closed pay period', inc(drw, 'This pay period is closed. Lines can'));
  // SpecialServicesTab: a non-owner can't pick themselves as the employee.
  ok('UI: SpecialServicesTab drops self from the employee options for a non-owner', inc(spc, 'payableUsers.filter((u) => u.id !== currentUserId)'));
  ok('UI: SpecialServicesTab defends add() against picking yourself', inc(spc, 'if (!isOwner && form.userId === currentUserId)'));
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
