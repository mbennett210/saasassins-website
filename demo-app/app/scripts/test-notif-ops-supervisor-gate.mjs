// NOTIF-05 regression, a supervisor-only UPDATE_CLIENT_OPS must NOT ping crew, but a
// real ops-field change MUST. The reducer gates fanOutOpsNotification on
// opsPatchTouchesCrew, a value-diff over non-supervisor fields (ServiceSetupCard
// resends the whole form, so key-presence is not enough). Tests that pure predicate
// (the reducer itself uses Vite extensionless imports, so it is not node-importable).
// Usage: node scripts/test-notif-ops-supervisor-gate.mjs
import assert from 'node:assert/strict';
import { opsPatchTouchesCrew } from '../src/lib/notifications.js';

let pass = 0;
function ok(label, fn) { fn(); pass += 1; console.log(`  ✓ ${label}`); }

const prev = { id: 'cl1', supervisorId: 'u_a', opsNotes: 'old', security: { code: '1' } };

console.log('opsPatchTouchesCrew (NOTIF-05 gate):');

ok('supervisor-only patch → false (no crew ping)', () => {
  assert.equal(opsPatchTouchesCrew(prev, { supervisorId: 'u_b' }), false);
});
ok('full-form patch that only CHANGES the supervisor (ops fields unchanged) → false', () => {
  assert.equal(opsPatchTouchesCrew(prev, { supervisorId: 'u_b', opsNotes: 'old', security: { code: '1' } }), false);
});
ok('a real ops change (opsNotes) → true (crew pinged)', () => {
  assert.equal(opsPatchTouchesCrew(prev, { opsNotes: 'new' }), true);
});
ok('a security change alongside a supervisor change → true', () => {
  assert.equal(opsPatchTouchesCrew(prev, { supervisorId: 'u_b', security: { code: '2' } }), true);
});
ok('empty / null patch → false', () => {
  assert.equal(opsPatchTouchesCrew(prev, {}), false);
  assert.equal(opsPatchTouchesCrew(prev, null), false);
});

console.log(`\nAll ${pass} assertions passed.`);
