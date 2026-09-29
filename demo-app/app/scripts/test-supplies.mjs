// Supplies module (S58) regression suite — pure math + the reducer's request
// lifecycle: dedupe (replay-idempotency), the submit→office / complete→requester
// fan-out routing, self-complete silence, and the completed-tail retention prune.
// Each assertion pins a behavior that would break silently. Offline: pure reducer.
// Run: node scripts/test-supplies.mjs
//
// reducer.js uses Vite-style extensionless relative imports, so register a resolve
// hook (append .js on ERR_MODULE_NOT_FOUND) before importing it — same trick raw
// Node needs for any store-module import (cf. test-replay-idempotence.mjs).
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import assert from 'node:assert/strict';
const { reducer, ACTIONS } = await import('../src/store/reducer.js');
const {
  supplyRequestTotal, supplyRequestItemCount, summarizeLines,
  pruneSupplyRequests, SUPPLY_COMPLETED_CAP,
} = await import('../src/lib/supplies.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };
const DAY = 86400000;

// ── Pure math ────────────────────────────────────────────────────────────────
const req = (lines, extra = {}) => ({ id: 'r', clientId: 'cl1', status: 'open', lines, ...extra });

ok('supplyRequestTotal sums qty×price, cents', () => {
  // 4×6.80 + 2×32.90 = 27.20 + 65.80 = 93.00
  assert.equal(supplyRequestTotal(req([{ name: 'A', qty: 4, unitPrice: 6.80 }, { name: 'B', qty: 2, unitPrice: 32.90 }])), 93.00);
});
ok('supplyRequestTotal handles empty / garbage', () => {
  assert.equal(supplyRequestTotal(req([])), 0);
  assert.equal(supplyRequestTotal({}), 0);
  assert.equal(supplyRequestTotal(req([{ name: 'x', qty: 'z', unitPrice: null }])), 0);
});
ok('supplyRequestItemCount sums qty', () => {
  assert.equal(supplyRequestItemCount(req([{ qty: 4 }, { qty: 2 }, { qty: 1 }])), 7);
});
ok('summarizeLines: single vs many vs empty', () => {
  assert.equal(summarizeLines([{ name: 'Glass cleaner', qty: 4 }]), 'Glass cleaner ×4');
  assert.equal(summarizeLines([{ name: 'Glass cleaner', qty: 4 }, { name: 'Liners', qty: 2 }, { name: 'Towels', qty: 1 }]), 'Glass cleaner ×4 +2 more');
  assert.equal(summarizeLines([]), '');
});

// ── Retention prune (pure) ───────────────────────────────────────────────────
ok('pruneSupplyRequests drops completed past 90d, keeps open + fresh', () => {
  const now = Date.now();
  const list = [
    { id: 'open', status: 'open', completedAt: null },
    { id: 'old', status: 'completed', completedAt: new Date(now - 91 * DAY).toISOString() },
    { id: 'fresh', status: 'completed', completedAt: new Date(now - 2 * DAY).toISOString() },
  ];
  const out = pruneSupplyRequests(list, now);
  const ids = out.map((r) => r.id).sort();
  assert.deepEqual(ids, ['fresh', 'open']);
});
ok('pruneSupplyRequests caps the completed tail at SUPPLY_COMPLETED_CAP', () => {
  const now = Date.now();
  const many = Array.from({ length: SUPPLY_COMPLETED_CAP + 25 }, (_, i) => ({
    id: `c${i}`, status: 'completed', completedAt: new Date(now - i * 1000).toISOString(),
  }));
  const out = pruneSupplyRequests(many, now);
  assert.equal(out.filter((r) => r.status === 'completed').length, SUPPLY_COMPLETED_CAP);
});
ok('pruneSupplyRequests returns SAME ref when nothing drops', () => {
  const list = [{ id: 'open', status: 'open', completedAt: null }];
  assert.ok(Object.is(pruneSupplyRequests(list, Date.now()), list));
});

// ── Reducer fixtures ─────────────────────────────────────────────────────────
// Owner + admin + manager all default-hold supplies.manage (roles.js); crew never.
const mkUser = (id, role, prefs = {}) => ({ id, role, status: 'active', name: id, notificationPrefs: prefs });
const baseState = (over = {}) => ({
  users: [mkUser('u_o', 'owner'), mkUser('u_a', 'admin'), mkUser('u_m', 'manager'), mkUser('u_c', 'crew')],
  clients: [{ id: 'cl1', name: 'Las Olas', supervisorId: 'u_m' }],
  permissions: [], userPermissionOverrides: [], notifications: [],
  supplyItems: [], supplyRequests: [], currentUserId: 'u_m', ...over,
});
const submittedTo = (s) => s.notifications.filter((n) => n.eventKey === 'supplyRequestSubmitted').map((n) => n.userId).sort();
const completedTo = (s) => s.notifications.filter((n) => n.eventKey === 'supplyRequestCompleted').map((n) => n.userId).sort();
const addReq = (id = 'sr_1', extra = {}) => ({
  type: ACTIONS.ADD_SUPPLY_REQUEST,
  request: { id, clientId: 'cl1', requestedByUserId: 'u_m', lines: [{ itemId: 'i1', name: 'Glass cleaner', qty: 4, unitPrice: 6.80 }], ...extra },
});

// ── ADD_SUPPLY_REQUEST — routing + dedupe ────────────────────────────────────
ok('submit routes to fulfillers (owner+admin), skips the actor + crew', () => {
  const s = reducer(baseState(), addReq());
  assert.equal(s.supplyRequests.length, 1);
  assert.deepEqual(submittedTo(s), ['u_a', 'u_o']); // NOT u_m (actor/requester), NOT u_c (crew)
});
ok('submit skips a fulfiller who muted the event', () => {
  const s = reducer(baseState({ users: [mkUser('u_o', 'owner', { supplyRequestSubmitted: false }), mkUser('u_a', 'admin'), mkUser('u_m', 'manager'), mkUser('u_c', 'crew')] }), addReq());
  assert.deepEqual(submittedTo(s), ['u_a']); // owner muted → only admin
});
ok('ADD_SUPPLY_REQUEST replay with same id is a no-op (dedupe)', () => {
  const s1 = reducer(baseState(), addReq('sr_dupe'));
  const s2 = reducer(s1, addReq('sr_dupe'));
  assert.ok(Object.is(s2, s1)); // identical action object replay → unchanged state ref
  assert.equal(s2.supplyRequests.length, 1);
});
ok('submit snapshots + rounds the line price to cents', () => {
  const s = reducer(baseState(), addReq('sr_r', { lines: [{ itemId: 'i9', name: 'Soap', qty: 3, unitPrice: 6.789 }] }));
  assert.equal(s.supplyRequests[0].lines[0].unitPrice, 6.79);
});

// ── COMPLETE_SUPPLY_REQUEST — flip + notify requester ────────────────────────
ok('complete flips status/stamps and notifies ONLY the requester', () => {
  const s1 = reducer(baseState(), addReq());
  const s2 = reducer(s1, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_1', byUserId: 'u_o' });
  const done = s2.supplyRequests.find((r) => r.id === 'sr_1');
  assert.equal(done.status, 'completed');
  assert.equal(done.completedByUserId, 'u_o');
  assert.ok(done.completedAt);
  assert.deepEqual(completedTo(s2), ['u_m']); // the requester alone
});
ok('self-complete (requester fulfills own) sends no completion ping', () => {
  const s1 = reducer(baseState(), addReq());
  const s2 = reducer(s1, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_1', byUserId: 'u_m' });
  assert.deepEqual(completedTo(s2), []); // actor === requester → skipped
});
ok('completing an already-completed request is a no-op', () => {
  const s1 = reducer(baseState(), addReq());
  const s2 = reducer(s1, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_1', byUserId: 'u_o' });
  const s3 = reducer(s2, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_1', byUserId: 'u_a' });
  assert.ok(Object.is(s3, s2)); // unchanged ref, no second notification
});

// ── REOPEN clears the completion stamps ──────────────────────────────────────
ok('reopen clears status + completion stamps', () => {
  const s1 = reducer(baseState(), addReq());
  const s2 = reducer(s1, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_1', byUserId: 'u_o' });
  const s3 = reducer(s2, { type: ACTIONS.REOPEN_SUPPLY_REQUEST, id: 'sr_1' });
  const r = s3.supplyRequests.find((x) => x.id === 'sr_1');
  assert.equal(r.status, 'open');
  assert.equal(r.completedAt, null);
  assert.equal(r.completedByUserId, null);
});

// ── A deleted person keeps their name on the request; reopen clears it ───────
// DELETE_USER nulls the requester/completer ids and keeps the names (requestedByName /
// completedByName), so Supplies shows who asked and who fulfilled instead of "—".
// Reopening must clear the completer's name with the id, or a LATER completer's
// deletion would leave the first person credited.
ok('a deleted requester/completer keeps their name; reopen clears it for the next completer', () => {
  const users = [
    mkUser('u_o', 'owner'),
    { ...mkUser('u_a', 'admin'), name: 'Ada Admin' },
    { ...mkUser('u_b', 'admin'), name: 'Ben Admin' },
    { ...mkUser('u_m', 'manager'), name: 'Mia Manager' },
  ];
  let s = reducer(baseState({ users, jobs: [], conversations: [], messages: [] }), addReq());
  s = reducer(s, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_1', byUserId: 'u_a' });
  s = reducer(s, { type: ACTIONS.DELETE_USER, id: 'u_a' });
  s = reducer(s, { type: ACTIONS.DELETE_USER, id: 'u_m' });
  let r = s.supplyRequests.find((x) => x.id === 'sr_1');
  assert.equal(r.completedByUserId, null);
  assert.equal(r.completedByName, 'Ada Admin');
  assert.equal(r.requestedByUserId, null);
  assert.equal(r.requestedByName, 'Mia Manager');
  s = reducer(s, { type: ACTIONS.REOPEN_SUPPLY_REQUEST, id: 'sr_1' });
  assert.equal(s.supplyRequests.find((x) => x.id === 'sr_1').completedByName, null);
  s = reducer(s, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_1', byUserId: 'u_b' });
  s = reducer(s, { type: ACTIONS.DELETE_USER, id: 'u_b' });
  r = s.supplyRequests.find((x) => x.id === 'sr_1');
  assert.equal(r.completedByName, 'Ben Admin'); // the second completer, not the first
  assert.equal(r.requestedByName, 'Mia Manager');
});

// ── Retention fires at the COMPLETE write point ──────────────────────────────
ok('completing prunes a 91-day-old completed request but keeps open ones', () => {
  const old = { id: 'sr_old', clientId: 'cl1', requestedByUserId: 'u_m', status: 'completed', lines: [], createdAt: new Date(Date.now() - 100 * DAY).toISOString(), completedAt: new Date(Date.now() - 91 * DAY).toISOString(), completedByUserId: 'u_o' };
  const s0 = baseState({ supplyRequests: [old] });
  const s1 = reducer(s0, addReq('sr_new'));
  const s2 = reducer(s1, { type: ACTIONS.COMPLETE_SUPPLY_REQUEST, id: 'sr_new', byUserId: 'u_o' });
  const ids = s2.supplyRequests.map((r) => r.id).sort();
  assert.deepEqual(ids, ['sr_new']); // old completed pruned; sr_new (fresh) kept
});

// ── ADD_SUPPLY_ITEM dedupe ───────────────────────────────────────────────────
ok('ADD_SUPPLY_ITEM replay with same id is a no-op', () => {
  const s1 = reducer(baseState(), { type: ACTIONS.ADD_SUPPLY_ITEM, item: { id: 'si_1', clientId: 'cl1', name: 'Glass cleaner', unitPrice: 6.80 } });
  const s2 = reducer(s1, { type: ACTIONS.ADD_SUPPLY_ITEM, item: { id: 'si_1', clientId: 'cl1', name: 'Glass cleaner', unitPrice: 6.80 } });
  assert.ok(Object.is(s2, s1));
  assert.equal(s2.supplyItems.length, 1);
});
ok('ADD_SUPPLY_ITEM rounds unitPrice to cents', () => {
  const s = reducer(baseState(), { type: ACTIONS.ADD_SUPPLY_ITEM, item: { clientId: 'cl1', name: 'Odd', unitPrice: 12.342 } });
  assert.equal(s.supplyItems[0].unitPrice, 12.34);
});

console.log(`\ntest-supplies: ${pass}/${pass} assertions passed ✓\n`);
