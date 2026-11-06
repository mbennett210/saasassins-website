// Pure unit suite for src/lib/timeRules.js — the shared manager-time-approval rules
// (scope, own, gating, worked/approved, the paid-lock predicate, punch-time validation,
// the refusal vocabulary). No React / store / browser deps: it runs headless and is the
// SAME module the server route and the demo stubs run, so a client refusal and a server
// refusal can never disagree (spec §4.1 / §11).
//
//   node scripts/test-time-rules.mjs
import {
  UNSCOPED_ROLES, timeScopeFor, inTimeScope, isOwn, refusesOwn, isGatedUser,
  isWorkedEntry, isApprovedEntry, needsApproval, isPaidLocked, isInClosedTerritory,
  validatePunchTimes, TIME_REFUSALS, effectiveTimeFilter,
} from '../src/lib/timeRules.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── fixtures ──────────────────────────────────────────────────────────────────
// Renata Cruz (mgr1) supervises two customers; another admin supervises one.
const CLIENTS = [
  { id: 'cl_ever', supervisorId: 'u_mgr', name: 'Las Olas Medical' },
  { id: 'cl_coral', supervisorId: 'u_mgr', name: 'Coral Bay HOA' },
  { id: 'cl_pac', supervisorId: 'u_admin2', name: 'Palmetto Ridge' },
  { id: 'cl_none', supervisorId: null, name: 'Unassigned' },
];
const owner = { id: 'u_owner', role: 'owner' };
const admin = { id: 'u_admin', role: 'admin' };
const mgr = { id: 'u_mgr', role: 'manager' };
const mgrEmpty = { id: 'u_mgr_x', role: 'manager' };

const USERS_BY_ID = new Map([
  ['u_owner', { id: 'u_owner', role: 'owner', pay: { type: 'none' } }],
  ['u_admin', { id: 'u_admin', role: 'admin', pay: { type: 'salary' } }],
  ['u_mgr', { id: 'u_mgr', role: 'manager', pay: { type: 'salary' } }],
  ['u_crew', { id: 'u_crew', role: 'crew', pay: { type: 'hourly', hourlyRate: 22 } }],
  ['u_visit', { id: 'u_visit', role: 'crew', pay: { type: 'per_visit', perVisitRate: 45 } }],
  ['u_nopay', { id: 'u_nopay', role: 'crew' }],
]);

// ── 1. scope ────────────────────────────────────────────────────────────────
eq('UNSCOPED_ROLES is owner + admin', JSON.stringify(UNSCOPED_ROLES), JSON.stringify(['owner', 'admin']));
eq('timeScopeFor(owner) is null (everything)', timeScopeFor(owner, CLIENTS), null);
eq('timeScopeFor(admin) is null (everything)', timeScopeFor(admin, CLIENTS), null);
{
  const s = timeScopeFor(mgr, CLIENTS);
  ok('timeScopeFor(manager) is a Set', s instanceof Set, String(s));
  ok('  manager scope = the two customers they supervise', s.has('cl_ever') && s.has('cl_coral') && !s.has('cl_pac') && !s.has('cl_none'), [...s].join(','));
  eq('  and nothing else', s.size, 2);
}
{
  const s = timeScopeFor(mgrEmpty, CLIENTS);
  ok('timeScopeFor(manager who supervises nobody) is an empty Set', s instanceof Set && s.size === 0, String([...s]));
}
// S131: an Operations Manager (the Manager role at the operations level, lib/teamScope) supervises
// their TEAM — their own customers and their account managers'. The level is the committed roster's
// (the third argument), the role the caller's; an account manager is unchanged.
{
  const ROSTER = [
    { id: 'u_om', role: 'manager', managerLevel: 'operations', status: 'active' },
    { id: 'u_mgr', role: 'manager', status: 'active', opsManagerId: 'u_om' },
    { id: 'u_admin2', role: 'admin', status: 'active' },
  ];
  const s = timeScopeFor({ id: 'u_om', role: 'manager' }, CLIENTS, ROSTER);
  ok("timeScopeFor(an Operations Manager) is their team's customers", s instanceof Set && s.has('cl_ever') && s.has('cl_coral') && !s.has('cl_pac') && s.size === 2, String([...s]));
  eq('  an account manager on that team still reads only their own', timeScopeFor(mgr, CLIENTS, ROSTER).size, 2);
  ok('  a supply manager (a 5th, non-supervising role) is scoped, never unscoped: their own (none)', timeScopeFor({ id: 'u_sm', role: 'supply_manager' }, CLIENTS, ROSTER).size === 0);
}
// inTimeScope: null scope waves everything through; a manager's Set gates by membership;
// a punch with no client_id is in scope only for the unscoped (null).
ok('inTimeScope(null, anything) true', inTimeScope(null, 'cl_ever') && inTimeScope(null, null));
ok('inTimeScope(Set, in-set) true', inTimeScope(timeScopeFor(mgr, CLIENTS), 'cl_ever'));
ok('inTimeScope(Set, not-in-set) false', !inTimeScope(timeScopeFor(mgr, CLIENTS), 'cl_pac'));
ok('inTimeScope(Set, null client) false — a siteless punch is off-scope for a manager', !inTimeScope(timeScopeFor(mgr, CLIENTS), null));
ok('inTimeScope(null, null client) true — a siteless punch is in scope for owner/admin', inTimeScope(null, null));

// ── 2. own ──────────────────────────────────────────────────────────────────
ok('isOwn true for the caller on their own id', isOwn(mgr, 'u_mgr'));
ok('isOwn false for someone else', !isOwn(mgr, 'u_crew'));
ok('refusesOwn: a manager on their OWN time is refused', refusesOwn(mgr, 'u_mgr'));
ok('refusesOwn: an admin on their OWN time is refused', refusesOwn(admin, 'u_admin'));
ok('refusesOwn: an OWNER on their own time is allowed', !refusesOwn(owner, 'u_owner'));
ok('refusesOwn: a manager on someone else is allowed', !refusesOwn(mgr, 'u_crew'));

// ── 3. gating ────────────────────────────────────────────────────────────────
ok('isGatedUser hourly → gated', isGatedUser(USERS_BY_ID.get('u_crew')));
ok('isGatedUser per_visit → gated', isGatedUser(USERS_BY_ID.get('u_visit')));
ok('isGatedUser salary → NOT gated', !isGatedUser(USERS_BY_ID.get('u_admin')));
ok('isGatedUser none → NOT gated', !isGatedUser(USERS_BY_ID.get('u_owner')));
ok('isGatedUser missing pay → gated (conservative: their punches still need approval)', isGatedUser(USERS_BY_ID.get('u_nopay')));
ok('isGatedUser null user → NOT gated (no punch to gate)', !isGatedUser(null));

// ── 4. worked / approved (both row shapes) ───────────────────────────────────
const snakeWorked = { clock_in_at: '2026-06-10T13:00:00Z', clock_out_at: '2026-06-10T15:00:00Z', duration_minutes: 120, status: 'completed', approval_status: 'pending', user_id: 'u_crew', client_id: 'cl_ever' };
const camelWorked = { clockInAt: '2026-06-10T13:00:00Z', clockOutAt: '2026-06-10T15:00:00Z', durationMinutes: 120, status: 'completed', approvalStatus: 'pending', userId: 'u_crew', clientId: 'cl_ever' };
ok('isWorkedEntry — snake_case worked punch', isWorkedEntry(snakeWorked));
ok('isWorkedEntry — camelCase worked punch', isWorkedEntry(camelWorked));
ok('isWorkedEntry false — still open (no clock-out)', !isWorkedEntry({ ...snakeWorked, clock_out_at: null }));
ok('isWorkedEntry false — zero duration', !isWorkedEntry({ ...snakeWorked, duration_minutes: 0 }));
ok('isWorkedEntry false — voided', !isWorkedEntry({ ...snakeWorked, status: 'voided' }));
ok('isWorkedEntry false — no_show', !isWorkedEntry({ ...snakeWorked, status: 'no_show' }));
ok('isWorkedEntry false — rejected (legacy)', !isWorkedEntry({ ...snakeWorked, approval_status: 'rejected' }));
ok('isApprovedEntry false when pending', !isApprovedEntry(snakeWorked));
ok('isApprovedEntry true when worked + approved (snake)', isApprovedEntry({ ...snakeWorked, approval_status: 'approved' }));
ok('isApprovedEntry true when worked + approved (camel)', isApprovedEntry({ ...camelWorked, approvalStatus: 'approved' }));
ok('isApprovedEntry false — approved but voided (not worked)', !isApprovedEntry({ ...snakeWorked, approval_status: 'approved', status: 'voided' }));

// ── 5. needsApproval (gated owner of the punch) ──────────────────────────────
ok('needsApproval — a gated cleaner\'s closed, pending punch', needsApproval(snakeWorked, USERS_BY_ID));
ok('needsApproval false — punch belongs to a salaried person', !needsApproval({ ...snakeWorked, user_id: 'u_admin' }, USERS_BY_ID));
ok('needsApproval false — already approved', !needsApproval({ ...snakeWorked, approval_status: 'approved' }, USERS_BY_ID));
ok('needsApproval false — still open', !needsApproval({ ...snakeWorked, clock_out_at: null }, USERS_BY_ID));

// ── 6. the paid-lock predicate ───────────────────────────────────────────────
// A run closed 2026-07-01 covering the June period; its window ends 2026-06-30.
const firstRun = { from_key: '2026-06-01', to_key: '2026-06-30', from_iso: '2026-06-01T04:00:00Z', to_iso: '2026-07-01T03:59:59Z', closed_at: '2026-07-01T14:00:00Z' };
const latestRun = firstRun;
const paid = { ...snakeWorked, approval_status: 'approved', approved_at: '2026-06-20T10:00:00Z', clock_in_at: '2026-06-20T13:00:00Z', clock_out_at: '2026-06-20T15:00:00Z' };
ok('isPaidLocked — approved, approved_at ≤ closed_at, clock_in ≤ to_iso → LOCKED', isPaidLocked(paid, latestRun, firstRun));
ok('isPaidLocked false — no run exists (nothing paid yet)', !isPaidLocked(paid, null, null));
ok('isPaidLocked false — pending (never paid)', !isPaidLocked({ ...paid, approval_status: 'pending', approved_at: null }, latestRun, firstRun));
ok('isPaidLocked false — approved AFTER the close (arrears, editable until next run)', !isPaidLocked({ ...paid, approved_at: '2026-07-05T10:00:00Z' }, latestRun, firstRun));
ok('isPaidLocked false — clock-in AFTER the run window (open territory)', !isPaidLocked({ ...paid, clock_in_at: '2026-07-10T13:00:00Z', clock_out_at: '2026-07-10T15:00:00Z' }, latestRun, firstRun));
ok('isPaidLocked false — PRE-LEDGER (clock-in before the first run\'s window is never locked)', !isPaidLocked({ ...paid, clock_in_at: '2026-05-15T13:00:00Z', clock_out_at: '2026-05-15T15:00:00Z', approved_at: '2026-05-20T10:00:00Z' }, latestRun, firstRun));

// closed territory (drive-override refusal): any punch whose clock-in is in [first.from, latest.to]
ok('isInClosedTerritory — a punch inside the closed window', isInClosedTerritory('2026-06-20T13:00:00Z', firstRun, latestRun));
ok('isInClosedTerritory false — pre-ledger', !isInClosedTerritory('2026-05-15T13:00:00Z', firstRun, latestRun));
ok('isInClosedTerritory false — open territory (after the latest window)', !isInClosedTerritory('2026-07-10T13:00:00Z', firstRun, latestRun));
ok('isInClosedTerritory false — no runs', !isInClosedTerritory('2026-06-20T13:00:00Z', null, null));

// ── 7. validatePunchTimes ────────────────────────────────────────────────────
const NOW = Date.parse('2026-06-10T18:00:00Z');
const at = (h) => new Date(Date.parse('2026-06-10T00:00:00Z') + h * 3600e3).toISOString();
eq('validate: a good closed punch → null', validatePunchTimes({ clockInAt: at(9), clockOutAt: at(11), now: NOW, requireOut: true }), null);
eq('validate: a good OPEN punch (out not required) → null', validatePunchTimes({ clockInAt: at(9), clockOutAt: null, now: NOW, requireOut: false }), null);
eq('validate: missing clock-in → missing-in', validatePunchTimes({ clockInAt: null, clockOutAt: at(11), now: NOW }), 'missing-in');
eq('validate: clock-in > 5 min in the future → in-future', validatePunchTimes({ clockInAt: new Date(NOW + 10 * 60e3).toISOString(), clockOutAt: null, now: NOW }), 'in-future');
eq('validate: clock-in within 5 min of now → allowed', validatePunchTimes({ clockInAt: new Date(NOW + 3 * 60e3).toISOString(), clockOutAt: null, now: NOW }), null);
eq('validate: out before in → out-before-in', validatePunchTimes({ clockInAt: at(11), clockOutAt: at(9), now: NOW }), 'out-before-in');
eq('validate: out == in → out-before-in', validatePunchTimes({ clockInAt: at(9), clockOutAt: at(9), now: NOW }), 'out-before-in');
eq('validate: more than 24h → too-long', validatePunchTimes({ clockInAt: at(-20), clockOutAt: at(9), now: NOW }), 'too-long');
eq('validate: a closed punch whose clock-out was cleared → missing-out', validatePunchTimes({ clockInAt: at(9), clockOutAt: null, now: NOW, requireOut: true }), 'missing-out');

// ── 8. the refusal vocabulary ────────────────────────────────────────────────
for (const code of ['stale', 'paid-locked', 'out-of-scope', 'own-entry', 'invalid-times', 'reason-required', 'not-closed', 'voided', 'reject-removed']) {
  ok(`TIME_REFUSALS['${code}'] is a plain sentence`, typeof TIME_REFUSALS[code] === 'string' && TIME_REFUSALS[code].length > 0, JSON.stringify(TIME_REFUSALS[code]));
}
ok('TIME_REFUSALS reject-removed names Delete', /delete/i.test(TIME_REFUSALS['reject-removed'] || ''), TIME_REFUSALS['reject-removed']);
ok('TIME_REFUSALS not-closed says still on the clock', /clock/i.test(TIME_REFUSALS['not-closed'] || ''), TIME_REFUSALS['not-closed']);

// ── 9. effectiveTimeFilter — the TimeClockHistory read scope (W4-F finding 3) ──
// A scoped manager's read is constrained to their customers; an empty scope or a customer that
// isn't theirs shows the scope message and sends NO fetch — never an empty id list (the server
// and the demo stub DROP an empty clientIds and answer company-wide, which was the leak).
const efJSON = (o) => JSON.stringify(effectiveTimeFilter(o));
// unscoped (owner/admin): always fetch; no explicit filter → company-wide (clientIds null).
eq('effFilter: unscoped, no explicit → fetch all (clientIds null)', efJSON({ unscoped: true }), JSON.stringify({ fetch: true, clientIds: null, reason: null }));
eq('effFilter: unscoped + a facet → that customer', efJSON({ unscoped: true, explicitClientIds: ['cl_ever'] }), JSON.stringify({ fetch: true, clientIds: ['cl_ever'], reason: null }));
// scoped manager, empty scope → NO fetch (no-locations state).
eq('effFilter: scoped + EMPTY scope → no fetch (no-scope)', efJSON({ unscoped: false, scopeClientIds: [] }), JSON.stringify({ fetch: false, clientIds: null, reason: 'no-scope' }));
// scoped manager, an explicit out-of-scope id → NO fetch (not-your-location state), never [].
eq('effFilter: scoped + explicit OUT-of-scope id → no fetch (out-of-scope)', efJSON({ unscoped: false, scopeClientIds: ['cl_ever'], explicitClientIds: ['cl_pac'] }), JSON.stringify({ fetch: false, clientIds: null, reason: 'out-of-scope' }));
// scoped manager, an in-scope explicit id → fetch that customer only.
eq('effFilter: scoped + explicit IN-scope id → filtered to it', efJSON({ unscoped: false, scopeClientIds: ['cl_ever', 'cl_coral'], explicitClientIds: ['cl_ever'] }), JSON.stringify({ fetch: true, clientIds: ['cl_ever'], reason: null }));
// scoped manager, no explicit filter (a person/job page, or /time with no facet) → the whole scope.
eq('effFilter: scoped + no explicit → the whole scope', efJSON({ unscoped: false, scopeClientIds: ['cl_ever', 'cl_coral'] }), JSON.stringify({ fetch: true, clientIds: ['cl_ever', 'cl_coral'], reason: null }));
// mixed explicit (one in, one out of scope) → the intersection only.
eq('effFilter: scoped + mixed explicit → intersection', efJSON({ unscoped: false, scopeClientIds: ['cl_ever'], explicitClientIds: ['cl_ever', 'cl_pac'] }), JSON.stringify({ fetch: true, clientIds: ['cl_ever'], reason: null }));
// INVARIANT: fetch === true never carries an empty clientIds array (that is the leak).
for (const inp of [{ unscoped: true }, { unscoped: false, scopeClientIds: ['cl_ever'] }, { unscoped: false, scopeClientIds: ['cl_ever'], explicitClientIds: ['cl_ever'] }]) {
  const r = effectiveTimeFilter(inp);
  ok(`effFilter: fetch never sends an empty id list (${JSON.stringify(inp)})`, !r.fetch || r.clientIds === null || (Array.isArray(r.clientIds) && r.clientIds.length > 0), JSON.stringify(r));
}

console.log(`\ntime-rules: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
