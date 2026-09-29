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

const seedState = () => ({
  version: 56,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  timeOff: [],
  sites: [{ id: 's1', clientId: 'c1', name: 'HQ', standingCrewIds: [] }],
  clients: [{ id: 'c1', name: 'Acme', standingCrewIds: [] }],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
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
  const r = await measure('t-mgr', (s) => s.payrollLines.push(line({ id: 'plS', userId: 'u_mgr', category: 'bonus', amount: 200 })));
  ok('a manager MAY add their OWN payroll line (no self-line carve-out): 200', r.status === 200 && r.wrote, show(r));
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

await fake.close();

// ── UI wiring: ReimbursementsTab hides Approve on the caller's OWN row ─────────
// A source-shape check (the JSX gate isn't rendered offline): approving your own is
// owner/admin only on the server, and a refused save drops the whole pending batch
// (store/sync.js), so the button must not offer it. FALSE against the pre-fix source.
{
  const src = readFileSync(new URL('../src/pages/hr/ReimbursementsTab.jsx', import.meta.url), 'utf8');
  const has = (n) => src.replace(/\s+/g, ' ').includes(n.replace(/\s+/g, ' '));
  ok('UI: canApproveOwn is owner/admin only', has("const canApproveOwn = myRole === 'owner' || myRole === 'admin';"));
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

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
