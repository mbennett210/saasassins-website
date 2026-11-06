// NOTIF-05 regression, a supervisor-only UPDATE_CLIENT_OPS must NOT ping crew, but a
// real ops-field change MUST. The reducer gates fanOutOpsNotification on
// opsPatchTouchesCrew, a value-diff over non-supervisor fields (ServiceSetupCard
// resends the whole form, so key-presence is not enough). Tests that pure predicate
// (the reducer itself uses Vite extensionless imports, so it is not node-importable).
// Usage: node scripts/test-notif-ops-supervisor-gate.mjs
import assert from 'node:assert/strict';
import { opsPatchTouchesCrew, opsPatchAudience } from '../src/lib/notifications.js';

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

// ── Step 6, L3 S5: an assignment change reaches only the cleaners it changed ──
// The Assignments screen commits on EVERY click, and the ops fan-out pings EVERY cleaner
// on that customer's upcoming cleans. Five reassignments used to mean five bell rows for
// everyone there, each about a checklist that was never theirs. A crewChecklists-ONLY
// patch now names its own audience: whoever gained, lost or moved a pick. Any other ops
// field keeps the whole-crew fan-out, because a door code or an access note IS everyone's.
console.log('\nopsPatchAudience (step 6 L3, S5):');

const withPicks = { id: 'cl1', supervisorId: 'u_a', crewChecklists: { u1: 'k1', u2: 'k2' } };
const aud = (patch, prevClient = withPicks) => opsPatchAudience(prevClient, patch);

ok('a cleaner GAINS a checklist → only them', () => {
  assert.deepEqual(aud({ crewChecklists: { u1: 'k1', u2: 'k2', u3: 'k3' } }), ['u3']);
});
ok('a cleaner LOSES one → only them', () => {
  assert.deepEqual(aud({ crewChecklists: { u1: 'k1' } }), ['u2']);
});
ok('a cleaner MOVES to another checklist → only them', () => {
  assert.deepEqual(aud({ crewChecklists: { u1: 'k9', u2: 'k2' } }), ['u1']);
});
ok('a REASSIGN (off one cleaner, onto another) → exactly those two', () => {
  assert.deepEqual(aud({ crewChecklists: { u2: 'k2', u3: 'k1' } }).sort(), ['u1', 'u3']);
});
ok('the untouched cleaners are never in it', () => {
  assert.ok(!aud({ crewChecklists: { u1: 'k9', u2: 'k2' } }).includes('u2'));
});
ok('a no-op save reaches nobody', () => {
  assert.deepEqual(aud({ crewChecklists: { u1: 'k1', u2: 'k2' } }), []);
});
ok('a crewChecklists change ALONGSIDE another ops field keeps the whole-crew fan-out', () => {
  assert.equal(aud({ crewChecklists: { u1: 'k9' }, security: { code: '2' } }), null);
});
ok('a patch with no crewChecklists at all is whole-crew, as before', () => {
  assert.equal(aud({ security: { code: '2' } }), null);
  assert.equal(aud({ supervisorId: 'u_b' }), null);
});
ok('a customer that held nothing, gaining its first pick → only that cleaner', () => {
  assert.deepEqual(opsPatchAudience({ id: 'cl2' }, { crewChecklists: { u7: 'k1' } }), ['u7']);
});
ok('never throws on nothing', () => {
  assert.equal(opsPatchAudience(null, null), null);
});

console.log(`\nAll ${pass} assertions passed.`);
