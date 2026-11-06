// SUPPLY ORDERS (S131, plan docs/plans/2026-10-14-supply-orders.md; brief S) — the PURE rules the
// route, its demo stub and the screens all run: order numbers, each line's state, the order's
// progress and the completion gate, who may decide what, the approver order, spend counted in the
// month each delivery happened, the crew cap, the per-line acts, the bells and the order's history.
// Offline; namespace imports, so a rule that is not built fails as its own named check.
//
//   node app/scripts/test-supply-orders.mjs
import assert from 'node:assert/strict';
import * as S from '../src/lib/supplies.js';
import * as F from '../src/lib/supplyFlow.js';
import * as N from '../src/lib/notifications.js';
import * as META from '../src/lib/notificationMeta.js';
import * as P from '../src/lib/crewPaths.js';
import { english, renderText } from '../src/i18n/core.js';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, fn) — fn throws (an assert) to fail; this file's own convention.
const ok = (label, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${String((e && e.message) || e).split('\n')[0]}`); }
};
const need = (mod, name) => {
  if (typeof mod[name] !== 'function') throw new Error(`${name} is not built`);
  return mod[name];
};

// ── the story ───────────────────────────────────────────────────────────────
const NOW = '2026-10-15T13:15:00.000Z';
const TODAY = '2026-10-15';
const L1 = { itemId: 'si_towel', catalogItemId: 'sc_towel', sku: 'PP-2001', name: 'Paper towels', qty: 3, unitPrice: 28.40 };
const L2 = { itemId: 'si_liner', catalogItemId: 'sc_liner', sku: 'PP-2003', name: 'Trash liners', qty: 2, unitPrice: 32.90 };
const empty = (l) => ({ itemId: l.itemId, catalogItemId: l.catalogItemId, deliveries: [], backorder: null, cancelled: null });
const order = (extra = {}) => ({
  id: 'sr_1047', number: 1047, clientId: 'cl_bay', status: 'sent', requestedByUserId: 'u_keisha',
  requestedByName: 'Keisha Bryant', createdAt: '2026-10-13T22:45:00.000Z',
  approvedAt: '2026-10-13T23:10:00.000Z', approvedByUserId: 'u_renata', approvedByName: 'Renata Cruz',
  sentAt: '2026-10-14T14:05:00.000Z', sentByUserId: 'u_sm', sentByName: 'Sam Supply',
  lines: [L1, L2], fulfillment: [empty(L1), empty(L2)], fulfillmentState: 'pending', version: 4,
  ...extra,
});

// ── A. order numbers ─────────────────────────────────────────────────────────
ok('A1 an order\'s number reads SO-<number> (supplyOrderNo)', () => {
  const no = need(S, 'supplyOrderNo');
  assert.equal(no({ number: 1047 }), 'SO-1047');
  assert.equal(no({ number: '1001' }), 'SO-1001');
  for (const bad of [{}, { number: null }, { number: 0 }, { number: -3 }, { number: 'x' }, { number: 1.5 }, null]) assert.equal(no(bad), null, JSON.stringify(bad));
});
ok('A2 a search term that names an order number reads as that number (#SO-1047, so1047, 1047)', () => {
  const of = need(S, 'supplyOrderNumberOf');
  for (const t of ['SO-1047', '#SO-1047', 'so-1047', 'so1047', '1047', '#1047']) assert.equal(of(t), 1047, t);
  for (const t of ['SO-', 'glass', '', null, 'SO-10x', '0', '1047.5']) assert.equal(of(t), null, String(t));
});

// ── B. each line's state ─────────────────────────────────────────────────────
ok('B1 a line is pending, backordered (with its ETA), delivered in full, or cancelled — with what is delivered and what remains', () => {
  const st = need(S, 'supplyLineState');
  assert.deepEqual(st(L1, empty(L1)), { state: 'pending', delivered: 0, remaining: 3, eta: null });
  assert.deepEqual(st(L1, { ...empty(L1), deliveries: [{ qty: 1, at: NOW }] }), { state: 'pending', delivered: 1, remaining: 2, eta: null });
  assert.deepEqual(st(L1, { ...empty(L1), deliveries: [{ qty: 1, at: NOW }], backorder: { at: NOW, eta: '2026-10-21' } }),
    { state: 'backordered', delivered: 1, remaining: 2, eta: '2026-10-21' });
  assert.deepEqual(st(L1, { ...empty(L1), deliveries: [{ qty: 1, at: NOW }, { qty: 2, at: NOW }], backorder: { at: NOW, eta: '2026-10-21' } }),
    { state: 'delivered', delivered: 3, remaining: 0, eta: null }, 'delivered in full wins over a backorder');
  assert.deepEqual(st(L1, { ...empty(L1), deliveries: [{ qty: 1, at: NOW }], cancelled: { at: NOW, reason: 'Discontinued' } }),
    { state: 'cancelled', delivered: 1, remaining: 0, eta: null });
  assert.deepEqual(st(L1, null), { state: 'pending', delivered: 0, remaining: 3, eta: null }, 'no entry yet: pending');
  assert.equal(S.SUPPLY_LINE_STATE?.backordered, 'backordered');
});

// ── C. the order's progress and the completion gate ──────────────────────────
ok('C1 progress: pending until something is delivered, partial after, ready once every line is delivered or cancelled', () => {
  const prog = need(S, 'supplyOrderProgress');
  const p0 = prog(order());
  assert.equal(p0.state, 'pending');
  assert.equal(p0.ready, false);
  assert.equal(p0.total, 2);
  const part = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), backorder: { at: NOW, eta: '2026-10-21' } }] });
  const p1 = prog(part);
  assert.equal(p1.state, 'partial');
  assert.deepEqual([p1.delivered, p1.resolved, p1.total, p1.backordered, p1.ready], [1, 1, 2, 1, false]);
  assert.deepEqual(p1.lines.map((l) => [l.name, l.state, l.remaining, l.eta]), [['Paper towels', 'delivered', 0, null], ['Trash liners', 'backordered', 2, '2026-10-21']]);
  const done = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), cancelled: { at: NOW, reason: 'Discontinued' } }] });
  const p2 = prog(done);
  assert.equal(p2.state, 'ready');
  assert.equal(p2.ready, true);
  const allCancelled = order({ fulfillment: [{ ...empty(L1), cancelled: { at: NOW, reason: 'Gone' } }, { ...empty(L2), cancelled: { at: NOW, reason: 'Gone' } }] });
  assert.equal(prog(allCancelled).state, 'ready', 'every line resolved by cancels is ready too');
  const oneCancelled = order({ fulfillment: [{ ...empty(L1), cancelled: { at: NOW, reason: 'Gone' } }, empty(L2)] });
  assert.equal(prog(oneCancelled).state, 'pending', 'a cancel is not fulfilment: nothing delivered yet');
  assert.equal(prog({ status: 'approved', lines: [L1] }).state, null, 'null before it is submitted');
});
ok('C2 a submitted order stored before this change (no fulfillment yet) reads as every line pending; an older completed one as what went out', () => {
  const prog = need(S, 'supplyOrderProgress');
  const legacySent = prog({ status: 'sent', lines: [L1, L2], sentAt: NOW });
  assert.equal(legacySent.state, 'pending');
  assert.deepEqual(legacySent.lines.map((l) => [l.state, l.remaining]), [['pending', 3], ['pending', 2]]);
  const legacyDone = prog({ status: 'completed', completedAt: NOW, lines: [L1, L2], sentLines: [{ qtySent: 3 }, { qtySent: 0 }] });
  assert.equal(legacyDone.state, 'ready');
  assert.deepEqual(legacyDone.lines.map((l) => [l.state, l.delivered]), [['delivered', 3], ['cancelled', 0]], 'a line sent as 0 never came');
});
ok('C3 🔴 the completion gate: Mark Completed is refused (lines_open) until every line is resolved; then it lands and keeps the record', () => {
  const patch = need(F, 'supplyDecisionPatch');
  assert.equal(patch(order(), 'complete', { now: NOW }).refused, 'lines_open');
  const part = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), backorder: { at: NOW, eta: '2026-10-21' } }], fulfillmentState: 'partial' });
  assert.equal(patch(part, 'complete', { now: NOW }).refused, 'lines_open');
  const ready = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), cancelled: { at: NOW, reason: 'Discontinued' } }], fulfillmentState: 'ready' });
  const done = patch(ready, 'complete', { byUserId: 'u_sm', byName: 'Sam Supply', now: NOW });
  assert.ok(done.patch, JSON.stringify(done));
  assert.equal(done.patch.status, 'completed');
  assert.equal(done.patch.completedByName, 'Sam Supply');
  assert.deepEqual(S.supplyOrderProgress({ ...ready, ...done.patch }).lines.map((l) => [l.state, l.delivered, l.cancelled && l.cancelled.reason]),
    [['delivered', 3, null], ['cancelled', 0, 'Discontinued']], 'completing keeps every line\'s record');
  assert.equal(done.patch.fulfillmentState, 'ready');
  assert.equal(done.patch.approvedByName, 'Renata Cruz');
  assert.equal(done.patch.sentByName, 'Sam Supply');
  assert.equal(patch({ ...ready, status: 'approved' }, 'complete', { now: NOW }).refused, 'illegal_move', 'only a submitted order completes');
});
ok('C4 completed is final: no reopen, no other move', () => {
  const n = S.nextSupplyStatus;
  for (const d of ['reopen', 'approve', 'reject', 'submit', 'complete']) assert.equal(n('completed', d), null, d);
});
ok('C5 reopen only while no delivery is recorded (has_deliveries), and it clears what the order leaves', () => {
  const patch = need(F, 'supplyDecisionPatch');
  const withDelivery = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 1, at: NOW }] }, empty(L2)], fulfillmentState: 'partial' });
  assert.equal(patch(withDelivery, 'reopen', { now: NOW }).refused, 'has_deliveries');
  const back = patch(order(), 'reopen', { now: NOW });
  assert.ok(back.patch, JSON.stringify(back));
  assert.equal(back.patch.status, 'open');
  for (const k of ['sentAt', 'sentByUserId', 'sentByName', 'fulfillment', 'fulfillmentState', 'approvedAt']) assert.equal(back.patch[k], null, k);
});

// ── D. submit: "Submitted to supplier" ───────────────────────────────────────
ok('D1 submit moves approved → sent, stamps who and when, starts every line pending — and writes no sent quantities', () => {
  const patch = need(F, 'supplyDecisionPatch');
  const approved = order({ status: 'approved', sentAt: null, sentByUserId: null, sentByName: null, fulfillment: null, fulfillmentState: null });
  const s = patch(approved, 'submit', { byUserId: 'u_sm', byName: 'Sam Supply', now: NOW });
  assert.ok(s.patch, JSON.stringify(s));
  assert.equal(s.patch.status, 'sent');
  assert.equal(s.patch.sentAt, NOW);
  assert.equal(s.patch.sentByName, 'Sam Supply');
  assert.deepEqual(s.patch.fulfillment, [empty(L1), empty(L2)]);
  assert.equal(s.patch.fulfillmentState, 'pending');
  assert.equal(s.patch.approvedByName, 'Renata Cruz', 'submitting keeps who approved the spend');
  assert.equal(s.patch.sentLines ?? null, null, 'no sent quantities are written');
  assert.equal(s.patch.sentTotalCents ?? null, null);
  assert.equal(patch(order({ status: 'open' }), 'submit', { now: NOW }).refused, 'illegal_move', 'nothing is submitted before it is approved');
  assert.equal(S.supplySentQuantities, undefined, 'the "how many went out" step is deleted (II.5)');
});

// ── E. 🔴 who may decide (maySupplyDecide) ───────────────────────────────────
ok('E1 approve / reject: the building\'s approver, THEIR operations manager, or owner / admin — each holding supplies.approve', () => {
  const may = (o) => S.maySupplyDecide({ request: { id: 'x' }, decision: 'approve', ...o });
  assert.equal(may({ selfId: 'u_am', role: 'manager', approverId: 'u_am', holdsApprove: true }), true, 'the AM');
  assert.equal(may({ selfId: 'u_om', role: 'manager', approverId: 'u_am', approverOpsManagerId: 'u_om', holdsApprove: true }), true, 'the AM\'s OM');
  assert.equal(may({ selfId: 'u_om2', role: 'manager', approverId: 'u_am', approverOpsManagerId: 'u_om', holdsApprove: true }), false, 'another OM');
  assert.equal(may({ selfId: 'u_own', role: 'owner', approverId: 'u_am', holdsApprove: true }), true, 'the owner steps in');
  assert.equal(may({ selfId: 'u_adm', role: 'admin', approverId: 'u_am', holdsApprove: true }), true, 'an admin steps in');
  assert.equal(may({ selfId: 'u_adm', role: 'admin', approverId: 'u_am', holdsApprove: false }), false, 'an admin pared off supplies.approve');
  assert.equal(may({ selfId: 'u_am', role: 'manager', approverId: 'u_am', holdsApprove: false }), false, 'the AM pared off supplies.approve');
  assert.equal(may({ selfId: 'u_other', role: 'manager', approverId: 'u_am', holdsApprove: true, holdsManage: true }), false, 'another manager, even holding supplies.manage');
  for (const d of ['approve', 'reject']) {
    assert.equal(S.maySupplyDecide({ request: { id: 'x' }, decision: d, selfId: 'u_sm', role: 'supply_manager', approverId: 'u_am', holdsManage: true, holdsDeliver: true, holdsApprove: false }), false, `🔴 the Supply Manager may not ${d}`);
  }
});
ok('E2 submit / complete / backorder / cancel a line / reopen: supplies.manage; deliver a line: manage OR deliver', () => {
  const may = (decision, o) => S.maySupplyDecide({ request: { id: 'x' }, decision, ...o });
  for (const d of ['submit', 'complete', 'backorder', 'cancelLine', 'reopen']) {
    assert.equal(may(d, { role: 'supply_manager', holdsManage: true }), true, `${d} by the SM`);
    assert.equal(may(d, { role: 'crew', holdsDeliver: true }), false, `${d} by the driver`);
    assert.equal(may(d, { role: 'manager', selfId: 'u_am', approverId: 'u_am', holdsApprove: true }), false, `${d} by the approver`);
  }
  assert.equal(may('deliver', { role: 'supply_manager', holdsManage: true }), true);
  assert.equal(may('deliver', { role: 'crew', holdsDeliver: true }), true, 'the driver delivers');
  assert.equal(may('deliver', { role: 'manager', holdsApprove: true }), false);
  assert.equal(may('nonsense', { holdsManage: true }), false);
  assert.equal(S.maySupplyDecide({ request: null, decision: 'submit', holdsManage: true }), false);
});
ok('E3 the approver\'s operations manager: their opsManagerId, only while that person is active and a manager', () => {
  const om = need(S, 'supplyApproverOpsManagerId');
  const users = [
    { id: 'u_am', role: 'manager', status: 'active', opsManagerId: 'u_om' },
    { id: 'u_om', role: 'manager', status: 'active', managerLevel: 'operations' },
    { id: 'u_am2', role: 'manager', status: 'active', opsManagerId: 'u_gone' },
    { id: 'u_gone', role: 'manager', status: 'disabled' },
    { id: 'u_am3', role: 'manager', status: 'active', opsManagerId: 'u_adm' },
    { id: 'u_adm', role: 'admin', status: 'active' },
  ];
  assert.equal(om(users, 'u_am'), 'u_om');
  assert.equal(om(users, 'u_am2'), null, 'an inactive OM is no OM');
  assert.equal(om(users, 'u_am3'), null, 'an OM must be a manager');
  assert.equal(om(users, 'u_nobody'), null);
  assert.equal(om(users, null), null);
});

// ── F. the approver order (resolveSupplyApprover) ────────────────────────────
ok('F1 🔴 the building\'s account manager approves first; the named approver only for a building with none; else nobody (the office)', () => {
  const users = [
    { id: 'u_am', role: 'manager', status: 'active' },
    { id: 'u_named', role: 'admin', status: 'active' },
    { id: 'u_left', role: 'manager', status: 'disabled' },
  ];
  const state = (clients, opsSettings = {}) => ({ users, clients, opsSettings });
  const clients = [{ id: 'cl_a', supervisorId: 'u_am' }, { id: 'cl_none', supervisorId: null }, { id: 'cl_left', supervisorId: 'u_left' }];
  assert.equal(N.resolveSupplyApprover(state(clients, { supplyApproverUserId: 'u_named' }), 'cl_a')?.id, 'u_am', 'the AM, even with a named approver');
  assert.equal(N.resolveSupplyApprover(state(clients, { supplyApproverUserId: 'u_named' }), 'cl_none')?.id, 'u_named', 'no AM: the named approver');
  assert.equal(N.resolveSupplyApprover(state(clients, { supplyApproverUserId: 'u_named' }), 'cl_left')?.id, 'u_named', 'an inactive AM is no AM');
  assert.equal(N.resolveSupplyApprover(state(clients), 'cl_none'), null, 'neither: the office decides');
  assert.equal(N.resolveSupplyApprover(state(clients, { supplyApproverUserId: 'u_left' }), 'cl_none'), null, 'a named approver who left is nobody');
});

// ── G. labels per reader, the queue's tabs ───────────────────────────────────
ok('G1 one label per reader and phase, every one a real catalog line', () => {
  const key = need(S, 'supplyOrderLabelKey');
  const phase = need(S, 'supplyOrderPhase');
  const at = (extra) => order(extra);
  const cases = [
    [{ status: 'open', fulfillment: null }, 'open'],
    [{ status: 'approved', fulfillment: null }, 'approved'],
    [{}, 'supplier'],
    [{ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 1, at: NOW }] }, empty(L2)] }, 'partial'],
    [{ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), cancelled: { at: NOW, reason: 'x' } }] }, 'ready'],
    [{ status: 'completed' }, 'completed'],
    [{ status: 'rejected', fulfillment: null }, 'rejected'],
  ];
  for (const [extra, want] of cases) assert.equal(phase(at(extra)), want, JSON.stringify(extra));
  for (const audience of ['office', 'am', 'crew']) {
    for (const [extra] of cases) {
      const k = key(at(extra), audience);
      assert.ok(typeof k === 'string' && english(k), `${audience}/${phase(at(extra))}: ${k}`);
    }
  }
  assert.equal(english(key(at({ status: 'approved', fulfillment: null }), 'office')), 'New');
  assert.equal(english(key(at({}), 'office')), 'Submitted to supplier');
  assert.equal(english(key(at({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 1, at: NOW }] }, empty(L2)] }), 'office')), 'Partially fulfilled');
  assert.equal(english(key(at({ status: 'approved', fulfillment: null }), 'am')), 'With Supply Manager');
  assert.equal(english(key(at({ status: 'open', fulfillment: null }), 'crew')), 'Waiting for approval');
  assert.equal(english(key(at({ status: 'rejected', fulfillment: null }), 'office')), 'Declined');
  assert.ok(typeof need(S, 'supplyOrderVariant')(at({})) === 'string');
});
ok('G2 the queue\'s tabs: Pending approval · New · With supplier · Partially fulfilled · Completed · Declined; the Supply Manager sees approved onward', () => {
  assert.deepEqual(S.SUPPLY_QUEUE_TABS, ['open', 'approved', 'sent', 'partial', 'completed', 'rejected']);
  assert.deepEqual(S.SUPPLY_QUEUE_TABS.map((t) => english(S.SUPPLY_QUEUE_TAB_KEYS[t])),
    ['Pending approval', 'New', 'With supplier', 'Partially fulfilled', 'Completed', 'Declined']);
  assert.deepEqual(S.SUPPLY_MANAGER_TABS, ['approved', 'sent', 'partial', 'completed']);
  const tabOf = need(S, 'supplyQueueTabOf');
  assert.equal(tabOf(order()), 'sent');
  assert.equal(tabOf(order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 1, at: NOW }] }, empty(L2)] })), 'partial');
  assert.equal(tabOf(order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), cancelled: { at: NOW, reason: 'x' } }] })), 'partial',
    'all in, not yet completed: still the Partially fulfilled tab');
  assert.equal(tabOf({ status: 'sent', fulfillmentState: 'partial' }), 'partial', 'a narrow read with only the stored state');
  assert.equal(tabOf(order({ status: 'completed' })), 'completed');
});

// ── H. 🔴 spend and usage count each delivery in its own month ────────────────
ok('H1 a delivery counts in the month it happened (qty × the line\'s price, in cents); an older completed order at completedAt as sent', () => {
  const spanning = order({
    status: 'completed', completedAt: '2026-10-02T15:00:00.000Z',
    fulfillment: [
      { ...empty(L1), deliveries: [{ qty: 2, at: '2026-09-29T15:00:00.000Z' }, { qty: 1, at: '2026-10-02T14:00:00.000Z' }] },
      { ...empty(L2), deliveries: [{ qty: 2, at: '2026-10-01T16:00:00.000Z' }] },
    ],
  });
  const legacy = { id: 'sr_old', clientId: 'cl_bay', status: 'completed', completedAt: '2026-09-20T12:00:00.000Z', lines: [L1, L2], sentLines: [{ qtySent: 1 }, { qtySent: 0 }] };
  const sept = { clientId: 'cl_bay', fromMs: Date.parse('2026-09-01T04:00:00Z'), toMs: Date.parse('2026-10-01T03:59:59.999Z') };
  const oct = { clientId: 'cl_bay', fromMs: Date.parse('2026-10-01T04:00:00Z'), toMs: Date.parse('2026-11-01T03:59:59.999Z') };
  assert.equal(S.supplySpendInWindow([spanning, legacy], sept), (2 * 2840 + 2840) / 100, 'September: two towels from the order, one from the older one');
  assert.equal(S.supplySpendInWindow([spanning, legacy], oct), (2840 + 2 * 3290) / 100, 'October: the third towel and the liners');
  const usage = S.supplyUsageByItem([spanning, legacy], oct);
  assert.deepEqual(usage.map((r) => [r.name, r.qty, r.requests]), [['Trash liners', 2, 1], ['Paper towels', 1, 1]]);
  const cents = need(S, 'supplyDeliveredCentsByClient')([spanning, legacy, { ...legacy, id: 'other', clientId: 'cl_x' }], { fromMs: sept.fromMs, toMs: sept.toMs });
  assert.deepEqual(cents, { cl_bay: 3 * 2840, cl_x: 2840 });
  const sentStill = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 1, at: '2026-10-05T12:00:00.000Z' }] }, empty(L2)] });
  assert.equal(S.supplySpendInWindow([sentStill], oct), 2840 / 100, 'a delivery counts while the order is still open');
});
ok('H2 "on order": requested and approved as asked; submitted at what is still to come (delivered and cancelled taken off)', () => {
  const reqs = [
    { status: 'approved', lines: [{ ...L1, qty: 2 }] },
    order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 1, at: NOW }] }, { ...empty(L2), cancelled: { at: NOW, reason: 'Discontinued' } }] }),
    order({ status: 'completed' }),
  ];
  assert.deepEqual(S.supplyOnOrderByItem(reqs), { sc_towel: { requested: 0, approved: 2, sent: 2 } });
  assert.equal(S.supplyOnOrderCents(reqs), 2 * 2840 + 2 * 2840);
});

// ── I. the crew cap is a rule the server holds ───────────────────────────────
ok('I1 a cleaner\'s line is 1–20: past it the snapshot is refused by name (the route holds non-office callers to it)', () => {
  const items = new Map([['si_towel', { id: 'si_towel', catalogItemId: 'sc_towel', sku: 'PP-2001', name: 'Paper towels', unitPrice: 28.4 }]]);
  const capped = S.snapshotSupplyLines([{ itemId: 'si_towel', qty: S.CREW_SUPPLY_MAX_QTY + 1 }], items, { maxQty: S.CREW_SUPPLY_MAX_QTY });
  assert.equal(capped.error, 'over_cap');
  assert.equal(capped.itemId, 'si_towel');
  assert.equal(capped.max, S.CREW_SUPPLY_MAX_QTY);
  const twice = S.snapshotSupplyLines([{ itemId: 'si_towel', qty: 12 }, { itemId: 'si_towel', qty: 12 }], items, { maxQty: S.CREW_SUPPLY_MAX_QTY });
  assert.equal(twice.error, 'over_cap', 'the same item twice is one line: its sum is held to the cap');
  assert.equal(S.snapshotSupplyLines([{ itemId: 'si_towel', qty: S.CREW_SUPPLY_MAX_QTY }], items, { maxQty: S.CREW_SUPPLY_MAX_QTY }).lines[0].qty, S.CREW_SUPPLY_MAX_QTY);
  assert.equal(S.snapshotSupplyLines([{ itemId: 'si_towel', qty: 400 }], items).lines[0].qty, 400, 'the office\'s order sheet keeps its own ceiling');
});

// ── J. the per-line acts (lib/supplyFlow supplyFulfillPatch) ─────────────────
ok('J1 deliver: the rest by default, any whole number 1..remaining; each delivery says who, when and how (office or driver)', () => {
  const fp = need(F, 'supplyFulfillPatch');
  const opts = { byUserId: 'u_sm', byName: 'Sam Supply', via: 'office', now: NOW, todayKey: TODAY };
  const all = fp(order(), [{ line: 0, act: 'deliver' }], opts);
  assert.ok(all.patch, JSON.stringify(all));
  assert.deepEqual(all.patch.fulfillment[0].deliveries, [{ qty: 3, at: NOW, byUserId: 'u_sm', byName: 'Sam Supply', via: 'office' }]);
  assert.equal(all.patch.fulfillmentState, 'partial');
  assert.deepEqual(all.applied, [{ line: 0, act: 'deliver', qty: 3 }]);
  const one = fp(order(), [{ line: 1, act: 'deliver', qty: 1 }], { ...opts, via: 'driver' });
  assert.equal(one.patch.fulfillment[1].deliveries[0].qty, 1);
  assert.equal(one.patch.fulfillment[1].deliveries[0].via, 'driver');
  for (const bad of [0, 3, -1, 1.5, 'x']) assert.equal(fp(order(), [{ line: 1, act: 'deliver', qty: bad }], opts).refused, 'bad_qty', String(bad));
  const both = fp(order(), [{ line: 0, act: 'deliver' }, { line: 1, act: 'deliver' }], opts);
  assert.equal(both.patch.fulfillmentState, 'ready');
});
ok('J2 backorder needs an ETA in the org\'s calendar, today or later; cancel needs a reason of 3–300 characters', () => {
  const fp = need(F, 'supplyFulfillPatch');
  const opts = { byUserId: 'u_sm', byName: 'Sam Supply', via: 'office', now: NOW, todayKey: TODAY };
  const bo = fp(order(), [{ line: 1, act: 'backorder', eta: '2026-10-21' }], opts);
  assert.ok(bo.patch, JSON.stringify(bo));
  assert.deepEqual(bo.patch.fulfillment[1].backorder, { at: NOW, byUserId: 'u_sm', byName: 'Sam Supply', eta: '2026-10-21' });
  assert.equal(bo.patch.fulfillmentState, 'pending');
  assert.ok(fp(order(), [{ line: 1, act: 'backorder', eta: TODAY }], opts).patch, 'today is allowed');
  for (const bad of ['2026-10-14', '2026-13-01', '21 Oct', '', null]) assert.equal(fp(order(), [{ line: 1, act: 'backorder', eta: bad }], opts).refused, 'bad_eta', String(bad));
  const cx = fp(order(), [{ line: 1, act: 'cancel', reason: '  Discontinued by the supplier  ' }], opts);
  assert.equal(cx.patch.fulfillment[1].cancelled.reason, 'Discontinued by the supplier');
  assert.equal(cx.patch.fulfillment[1].cancelled.byName, 'Sam Supply');
  for (const bad of ['', 'no', 'x'.repeat(S.SUPPLY_CANCEL_REASON_MAX + 1)]) assert.equal(fp(order(), [{ line: 1, act: 'cancel', reason: bad }], opts).refused, 'bad_reason', String(bad).slice(0, 8));
});
ok('J3 a resolved line takes no act; an order not submitted takes none; an unknown line or act is refused by name', () => {
  const fp = need(F, 'supplyFulfillPatch');
  const opts = { byUserId: 'u_sm', byName: 'Sam Supply', via: 'office', now: NOW, todayKey: TODAY };
  const done = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, empty(L2)] });
  for (const act of [{ act: 'deliver' }, { act: 'backorder', eta: '2026-10-21' }, { act: 'cancel', reason: 'Gone now' }]) {
    assert.equal(fp(done, [{ line: 0, ...act }], opts).refused, 'line_resolved', act.act);
  }
  assert.equal(fp(order({ status: 'approved' }), [{ line: 0, act: 'deliver' }], opts).refused, 'not_submitted');
  assert.equal(fp(order({ status: 'completed' }), [{ line: 0, act: 'deliver' }], opts).refused, 'not_submitted');
  assert.equal(fp(order(), [{ line: 7, act: 'deliver' }], opts).refused, 'bad_line');
  assert.equal(fp(order(), [{ line: 0, act: 'explode' }], opts).refused, 'bad_act');
  assert.equal(fp(order(), [], opts).refused, 'no_acts');
  const legacy = fp({ ...order(), fulfillment: null }, [{ line: 0, act: 'deliver', qty: 1 }], opts);
  assert.ok(legacy.patch && legacy.patch.fulfillment.length === 2, 'an order submitted before this change starts its record on the first act');
});

// ── K. 🔴 the bells (plan §3) ─────────────────────────────────────────────────
const E = N.SUPPLY_ORDER_EVENTS || {};
const user = (id, role, extra = {}) => ({ id, role, status: 'active', name: extra.name || id, notificationPrefs: {}, ...extra });
const world = (over = {}) => ({
  users: [
    user('u_own', 'owner'), user('u_adm', 'admin'), user('u_renata', 'manager', { name: 'Renata Cruz' }),
    user('u_keisha', 'crew', { name: 'Keisha Bryant' }), user('u_sm', 'supply_manager', { name: 'Sam Supply' }),
    user('u_drv', 'crew', { name: 'Alberto Reyes' }),
  ],
  clients: [{ id: 'cl_bay', name: 'Bayside Tower', supervisorId: 'u_renata' }],
  permissions: [
    { id: 'supplies.manage', roles: ['owner', 'admin', 'supply_manager'] },
    { id: 'supplies.approve', roles: ['owner', 'admin', 'manager'] },
    { id: 'supplies.view', roles: ['owner', 'admin', 'manager', 'supply_manager'] },
  ],
  userPermissionOverrides: [], opsSettings: {}, notifications: [], company: { timezone: 'America/New_York' },
  ...over,
});
const to = (rows, key) => (rows || []).filter((n) => n.eventKey === key).map((n) => n.userId).sort();
ok('K1 the six new events exist, each with a toggle and a look on the phone; the cleaner\'s carry no role allowlist', () => {
  const keys = ['approved', 'declined', 'delivered', 'backordered', 'cancelled', 'completed'].map((k) => E[k]);
  assert.deepEqual(keys, ['supplyOrderApproved', 'supplyOrderDeclined', 'supplyItemsDelivered', 'supplyItemBackordered', 'supplyItemCancelled', 'supplyOrderCompleted']);
  const items = N.NOTIFICATION_GROUPS.flatMap((g) => g.items);
  for (const k of keys) {
    const item = items.find((i) => i.key === k);
    assert.ok(item, `${k} in NOTIFICATION_GROUPS`);
    assert.equal(item.roleAllowlist, undefined, `${k}: no role allowlist (the cleaner must receive it)`);
    assert.ok(english(item.labelKey) && english(item.descKey), `${k}: its words`);
    assert.ok(META.EVENT_META[k], `${k} in EVENT_META`);
  }
  for (const gone of ['supplyRequestSent', 'supplyRequestDelivered', 'supplyRequestRejected', 'supplyRequestCompleted']) {
    assert.ok(!items.some((i) => i.key === gone), `${gone} is retired (replaced by the order events)`);
  }
});
ok('K2 approve: the cleaner who asked AND every Supply Manager — the office\'s fan-out only when there is none', () => {
  const s = world();
  const rows = need(F, 'supplyDecisionNotifications')(s, { request: order({ status: 'approved' }), decision: 'approve', actorUserId: 'u_renata' });
  assert.deepEqual(to(rows, E.approved), ['u_keisha']);
  assert.deepEqual(to(rows, 'supplyRequestApproved'), ['u_sm'], 'the new approved order goes to the Supply Manager');
  const noSm = world({ users: world().users.filter((u) => u.role !== 'supply_manager') });
  const rows2 = F.supplyDecisionNotifications(noSm, { request: order({ status: 'approved' }), decision: 'approve', actorUserId: 'u_renata' });
  assert.deepEqual(to(rows2, 'supplyRequestApproved'), ['u_adm', 'u_own'], 'no Supply Manager: whoever holds supplies.manage');
});
ok('K3 decline tells the cleaner, with the reason; submit tells nobody', () => {
  const rows = F.supplyDecisionNotifications(world(), { request: order({ status: 'rejected', rejectionReason: 'Ordered last week' }), decision: 'reject', actorUserId: 'u_renata' });
  assert.deepEqual(to(rows, E.declined), ['u_keisha']);
  assert.match(renderText(rows.find((n) => n.eventKey === E.declined).body, 'en'), /Ordered last week/);
  const s = world();
  assert.equal(F.supplyDecisionNotifications(s, { request: order(), decision: 'submit', actorUserId: 'u_sm' }), s.notifications);
});
ok('K4 🔴 each delivery tells the cleaner AND the account manager — one bell per person per act, naming what is still backordered and its ETA', () => {
  const fn = need(F, 'supplyFulfillNotifications');
  const after = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), backorder: { at: NOW, eta: '2026-10-21' } }] });
  const rows = fn(world(), { request: after, applied: [{ line: 0, act: 'deliver', qty: 3 }], actorUserId: 'u_drv' });
  assert.deepEqual(to(rows, E.delivered), ['u_keisha', 'u_renata']);
  assert.equal(rows.length, 2, 'one bell each');
  const text = (n) => `${renderText(n.title, 'en')} ${renderText(n.body, 'en')}`;
  const bell = rows.find((n) => n.userId === 'u_keisha');
  assert.match(text(bell), /Paper towels/);
  assert.match(text(bell), /Trash liners/);
  assert.match(text(bell), /Oct 21/);
  const many = fn(world(), { request: order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW }] }, { ...empty(L2), deliveries: [{ qty: 2, at: NOW }] }] }),
    applied: [{ line: 0, act: 'deliver', qty: 3 }, { line: 1, act: 'deliver', qty: 2 }], actorUserId: 'u_sm' });
  assert.equal(many.filter((n) => n.userId === 'u_keisha').length, 1, 'two lines delivered in one act: ONE bell, never one per line');
});
ok('K5 a backorder and a cancelled item tell the cleaner and the account manager; the actor is never told', () => {
  const after = order({ fulfillment: [empty(L1), { ...empty(L2), backorder: { at: NOW, eta: '2026-10-21' } }] });
  const bo = F.supplyFulfillNotifications(world(), { request: after, applied: [{ line: 1, act: 'backorder', eta: '2026-10-21' }], actorUserId: 'u_sm' });
  assert.deepEqual(to(bo, E.backordered), ['u_keisha', 'u_renata']);
  const cx = F.supplyFulfillNotifications(world(), { request: after, applied: [{ line: 1, act: 'cancel', reason: 'Discontinued' }], actorUserId: 'u_renata' });
  assert.deepEqual(to(cx, E.cancelled), ['u_keisha'], 'the AM cancelling is not told about it');
});
ok('K6 complete tells the cleaner and the account manager; a cleaner\'s link opens their order in the Cleaner Hub, an office link the order page', () => {
  const rows = F.supplyDecisionNotifications(world(), { request: order({ status: 'completed' }), decision: 'complete', actorUserId: 'u_sm' });
  assert.deepEqual(to(rows, E.completed), ['u_keisha', 'u_renata']);
  assert.equal(rows.find((n) => n.userId === 'u_keisha').url, P.crewPaths.supplyOrder('sr_1047'));
  assert.equal(rows.find((n) => n.userId === 'u_renata').url, '/supplies/orders/sr_1047');
  assert.equal(P.crewPaths.supplyOrder('sr_1047'), '/my-day/supplies/orders/sr_1047');
});

// ── L. the order's history ───────────────────────────────────────────────────
ok('L1 the history: every act with who and when, newest last, from the row, its lines, comments, photos and invoices', () => {
  const hist = need(S, 'supplyOrderHistory');
  const o = order({
    fulfillment: [
      { ...empty(L1), deliveries: [{ qty: 3, at: '2026-10-15T13:15:00.000Z', byName: 'Sam Supply', via: 'office' }] },
      { ...empty(L2), backorder: { at: '2026-10-15T13:20:00.000Z', byName: 'Sam Supply', eta: '2026-10-21' } },
    ],
  });
  const rows = hist(o, {
    comments: [{ id: 'src_1', body: 'Liners on backorder', authorName: 'Sam Supply', createdAt: '2026-10-15T13:21:00.000Z' }],
    photos: [{ id: 'am_1', createdAt: '2026-10-15T13:16:00.000Z', areaId: 'sc_towel', uploaderName: 'Sam Supply' }],
    invoices: [{ id: 'sod_1', fileName: 'inv-88.pdf', uploaderName: 'Sam Supply', createdAt: '2026-10-15T13:30:00.000Z' }],
  });
  assert.deepEqual(rows.map((r) => r.kind), ['requested', 'approved', 'submitted', 'delivered', 'photo', 'backordered', 'comment', 'invoice']);
  assert.deepEqual(rows.map((r) => r.at), [...rows.map((r) => r.at)].sort(), 'newest last');
  assert.equal(rows[0].byName, 'Keisha Bryant');
  assert.equal(rows[3].name, 'Paper towels');
  assert.equal(rows[5].eta, '2026-10-21');
});

// ── M. no money on the driver's list or the cleaner's line, per line ─────────
ok('M1 the driver\'s list per line: what is still to come on each submitted order, today\'s deliveries — no money', () => {
  const dayStartMs = Date.parse('2026-10-15T04:00:00Z');
  const o = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 1, at: NOW, byName: 'Alberto Reyes', via: 'driver' }] }, { ...empty(L2), cancelled: { at: NOW, reason: 'x' } }] });
  const out = S.supplyDeliveryList({ requests: [o], buildingOf: () => ({ name: 'Bayside Tower', address: '1 Bay St' }), dayStartMs });
  assert.deepEqual(out.toDeliver.map((r) => [r.id, r.version, r.items.map((i) => [i.line, i.name, i.qty])]), [['sr_1047', 4, [[0, 'Paper towels', 2]]]]);
  assert.deepEqual(out.deliveredToday.map((r) => [r.id, r.items, r.deliveredByName]), [['sr_1047', [{ name: 'Paper towels', qty: 1 }], 'Alberto Reyes']]);
  assert.doesNotMatch(JSON.stringify(out), /unitPrice|price|cents|total|budget/i);
});
ok('M2 the cleaner\'s line per line (Builder C): what came today, what is backordered, what is still on its way — names and quantities only', () => {
  const dayStartMs = Date.parse('2026-10-15T04:00:00Z');
  const o = order({ fulfillment: [{ ...empty(L1), deliveries: [{ qty: 3, at: NOW, byName: 'Alberto Reyes', via: 'driver' }] }, empty(L2)] });
  const out = S.supplyCrewBuildings({ requests: [o], clientIds: new Set(['cl_bay']), dayStartMs });
  assert.deepEqual(out, [{
    clientId: 'cl_bay',
    delivered: [{ name: 'Paper towels', qty: 3, at: NOW }],
    backordered: [],
    onTheWay: [{ name: 'Trash liners', qty: 2 }],
  }]);
  const back = order({ fulfillment: [empty(L1), { ...empty(L2), backorder: { at: NOW, eta: '2026-10-21' } }] });
  assert.deepEqual(S.supplyCrewBuildings({ requests: [back], clientIds: new Set(['cl_bay']), dayStartMs })[0].backordered,
    [{ name: 'Trash liners', qty: 2, eta: '2026-10-21' }], 'a backordered line carries its ETA, apart from what is on the way');
  assert.doesNotMatch(JSON.stringify(out), /unitPrice|price|cents|total|budget|Reyes/i);
});

console.log(`\ntest-supply-orders: ${pass}/${pass + fails.length} checks passed${fails.length ? '' : ' ✓'}\n`);
if (fails.length) {
  console.error(`✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
