// Ops-alert marker retention (RAISE_OPS_ALERT). Regression for the old .slice(-500)
// cap: at high alert volume (many late/missed/checklist alerts inside one lookback
// window) it evicted a still-eligible marker by ARRAY POSITION, so the walker re-
// emitted it and fanned out a DUPLICATE bell/push across reloads and other devices.
// Retention is now TIME-based: keep every marker fired within 2x the lookback
// (min 48h), plus a 5000 absolute backstop. Inspection reminders (one per overdue
// episode) keep their marker for the latest-inspection look-back, newest per account,
// outside the backstop. Pure reducer, offline.
//
// reducer.js uses extensionless relative imports; register the .js resolve hook first
// (same trick the other store-module suites use).
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import assert from 'node:assert/strict';
const { reducer, ACTIONS } = await import('../src/store/reducer.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

const HOUR = 3600000;
const baseState = (markers) => ({
  jobs: [], users: [], sites: [], clients: [], notifications: [],
  permissions: {}, userPermissionOverrides: {},
  opsSettings: { shiftAlertLookbackHours: 24 },
  opsAlertEvents: markers || [],
});
// Crew scope + empty crewIds keeps the fan-out trivial so the test isolates the
// marker-retention logic (which runs before the fan-out, regardless of scope).
const raise = (state, id) => reducer(state, {
  type: ACTIONS.RAISE_OPS_ALERT,
  alert: { id, kind: 'shiftLate', recipientScope: 'crew', crewIds: [], title: 't', body: 'b', url: '/x' },
});
const ids = (s) => new Set((s.opsAlertEvents || []).map((e) => e.id));

console.log('ops-alert marker retention:');

// ── the core regression: 500 RECENT markers + 1 more must NOT evict a still-eligible one ──
ok('501 markers all within the lookback window are all retained (no still-eligible eviction)', () => {
  const now = Date.now();
  const recent = Array.from({ length: 500 }, (_, i) => ({
    id: `oa_pre_${i}`, kind: 'shiftLate', clientId: null, jobId: `j${i}`,
    firedAt: new Date(now - i * 1000).toISOString(), // all within the last ~500s, well inside 48h
  }));
  const next = raise(baseState(recent), 'oa_new');
  const set = ids(next);
  assert.equal(next.opsAlertEvents.length, 501, `expected all 501 retained, got ${next.opsAlertEvents.length}`);
  assert.ok(set.has('oa_pre_0'), 'the first-inserted still-eligible marker must survive (pre-fix .slice(-500) evicted it by position)');
  assert.ok(set.has('oa_new'), 'the new marker must be present');
});

// ── time-based pruning DOES drop markers older than the retention window ──
ok('markers older than 2x lookback (min 48h) are pruned', () => {
  const now = Date.now();
  const stale = [
    { id: 'oa_stale', kind: 'shiftMissed', clientId: null, jobId: 'jz', firedAt: new Date(now - 100 * HOUR).toISOString() },
    { id: 'oa_fresh', kind: 'shiftLate', clientId: null, jobId: 'jy', firedAt: new Date(now - 1 * HOUR).toISOString() },
  ];
  const next = raise(baseState(stale), 'oa_new2');
  const set = ids(next);
  assert.ok(!set.has('oa_stale'), 'a 100h-old marker (> 48h retention) must be pruned');
  assert.ok(set.has('oa_fresh'), 'a 1h-old marker must be kept');
  assert.ok(set.has('oa_new2'), 'the new marker must be present');
});

// ── retention scales with a larger configured lookback ──
ok('a larger shiftAlertLookbackHours widens retention (72h marker kept at 48h lookback)', () => {
  const now = Date.now();
  const s = baseState([{ id: 'oa_72h', kind: 'shiftLate', clientId: null, jobId: 'jw', firedAt: new Date(now - 72 * HOUR).toISOString() }]);
  s.opsSettings = { shiftAlertLookbackHours: 48 }; // retention = max(96, 48) = 96h -> 72h kept
  const next = raise(s, 'oa_new3');
  assert.ok(ids(next).has('oa_72h'), '72h marker must be kept when lookback is 48h (96h retention)');
});

// ── undated (legacy) markers are kept, never pruned by the time filter ──
ok('legacy markers without firedAt are retained', () => {
  const next = raise(baseState([{ id: 'oa_legacy', kind: 'shiftLate', clientId: null, jobId: 'jl' }]), 'oa_new4');
  assert.ok(ids(next).has('oa_legacy'), 'an undated marker must not be pruned');
});

// ── idempotent: re-raising the same id is a no-op (unchanged behavior) ──
ok('re-raising the same alert id returns the same state (idempotent)', () => {
  const once = raise(baseState([]), 'oa_dup');
  const twice = raise(once, 'oa_dup');
  assert.equal(twice, once);
});

// ── inspection reminders: one per overdue EPISODE (review finding, 2026-09-22) ──
// The walker's id carries the account's last-inspection day, so an account overdue for
// weeks re-emits the SAME id every tick. Pruned at the 48h shift horizon, the marker
// vanished and the supervisor got the same reminder every two days.
const DAY = 24 * HOUR;
const raiseInsp = (state, id, clientId) => reducer(state, {
  type: ACTIONS.RAISE_OPS_ALERT,
  alert: { id, kind: 'inspectionDue', recipientScope: 'crew', crewIds: [], clientId, title: 't', body: 'b', url: '/x' },
});
const inspMarker = (id, clientId, ageMs) => ({ id, kind: 'inspectionDue', clientId, jobId: null, firedAt: new Date(Date.now() - ageMs).toISOString() });

ok('an inspection-reminder marker fired 100h ago is kept past the 48h shift horizon', () => {
  const next = raise(baseState([inspMarker('oa_inspectionDue_cl1_2026-08-01', 'cl1', 100 * HOUR)]), 'oa_other');
  assert.ok(ids(next).has('oa_inspectionDue_cl1_2026-08-01'), 'the episode marker must survive the shift prune');
  // … so the walker re-emitting the same episode id is a no-op, not a second reminder
  assert.equal(raiseInsp(next, 'oa_inspectionDue_cl1_2026-08-01', 'cl1'), next);
});

ok('an inspection-reminder marker past the latest-inspection look-back is pruned', () => {
  const next = raise(baseState([inspMarker('oa_inspectionDue_cl1_old', 'cl1', 400 * DAY)]), 'oa_other2');
  assert.ok(!ids(next).has('oa_inspectionDue_cl1_old'));
});

ok('a newer episode for the same account supersedes its older marker (one per customer)', () => {
  const s = baseState([inspMarker('oa_inspectionDue_cl1_a', 'cl1', 30 * DAY), inspMarker('oa_inspectionDue_cl2_a', 'cl2', 30 * DAY)]);
  const set = ids(raiseInsp(s, 'oa_inspectionDue_cl1_b', 'cl1'));
  assert.ok(!set.has('oa_inspectionDue_cl1_a'), 'the superseded episode is dropped');
  assert.ok(set.has('oa_inspectionDue_cl1_b') && set.has('oa_inspectionDue_cl2_a'), 'the new episode + other accounts are kept');
});

ok('the 5000 backstop trims shift markers only, oldest first — never an inspection marker', () => {
  const now = Date.now();
  const shifts = Array.from({ length: 5000 }, (_, i) => ({ id: `oa_s_${i}`, kind: 'shiftLate', clientId: null, jobId: `j${i}`, firedAt: new Date(now - 1000).toISOString() }));
  const next = raise(baseState([inspMarker('oa_inspectionDue_cl9_x', 'cl9', 10 * DAY), ...shifts]), 'oa_new5');
  const set = ids(next);
  assert.ok(set.has('oa_inspectionDue_cl9_x'), 'the inspection marker survives the backstop');
  assert.equal(next.opsAlertEvents.filter((e) => e.kind !== 'inspectionDue').length, 5000, 'shift markers are held at the backstop');
  assert.ok(set.has('oa_new5') && !set.has('oa_s_0') && set.has('oa_s_1'), 'the oldest shift marker goes first');
});

console.log(`\nops-alert marker retention: ${pass} passed`);
