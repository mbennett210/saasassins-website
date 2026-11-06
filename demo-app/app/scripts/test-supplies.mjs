// Supplies — the PURE rules the route, its demo stub and the screens all run (lib/supplies,
// lib/supplyFlow). Each assertion pins a behaviour that would break silently. Offline.
//
// SUP-13 (2026-10-05): the queue and the approved lists left the shared record for their own
// tables, so the reducer half of this suite went with the reducer cases (II.5). What a request
// does end to end — the route per role, the CAS, retention, the bell rows, the move — is
// test-supplies-route.mjs; the state machine's table and the budget / reminder walkers are
// test-supplies-approval.mjs. This file holds the arithmetic and the rules both of those call.
//   SUP-11 (2026-10-05): maySupplyDecide — who may approve or reject.
//   SUP-13: the 12-month window, the usage periods, cents at the storage boundary, the snapshot.
//   The master supply list (Matt, the Oct 6 call; plan 2026-10-11 §2): the catalog's rules (a
//   SKU unique in the org, case-insensitive, blank allowed many times), a building's switches
//   (every asked id answered by name), and what is on order and delivered keyed on the CATALOG
//   item, so switching an item off and back on keeps its history (D6).
//   THE SUPPLY ORDERS (S131, plan 2026-10-14; the delivery step of 2026-10-12 before it): an order
//   is SUBMITTED to the supplier by the Supply Manager, delivered LINE BY LINE (the driver too) and
//   completed once every line is resolved; usage and spend count each delivery in its month; the
//   cleaner IS told about their order now; the cleaner's line and the driver's list carry no money
//   and no full names. The full rule set is test-supply-orders.mjs.
// Run: node scripts/test-supplies.mjs
import assert from 'node:assert/strict';
const S = await import('../src/lib/supplies.js');
const F = await import('../src/lib/supplyFlow.js');
const CS = await import('../src/lib/crewScope.js');
const { english, renderText } = await import('../src/i18n/core.js');
const { addDaysKey, addMonthsKey, startOfDayKey } = await import('../src/lib/dates.js');
const {
  supplyRequestTotal, supplyRequestItemCount, supplyLinesSummary, filterSupplyRequests,
  clampSupplyQty, SUPPLY_MAX_QTY, SUPPLY_STATUS,
} = S;

// Every check runs and is counted, so a run on an older tree says how many fail rather than
// stopping at the first (an assertion's message is kept with its label).
let pass = 0;
const fails = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${label}`); }
  catch (e) { fails.push(`${label}\n      ${String(e && e.message || e).split('\n')[0]}`); console.log(`  ✗ ${label}`); }
};

// ── Pure math ────────────────────────────────────────────────────────────────
const req = (lines, extra = {}) => ({ id: 'r', clientId: 'cl1', status: 'open', lines, ...extra });

ok('supplyRequestTotal sums qty×price, cents', () => {
  // 4×6.80 + 2×32.90 = 27.20 + 65.80 = 93.00
  assert.equal(supplyRequestTotal(req([{ name: 'A', qty: 4, unitPrice: 6.80 }, { name: 'B', qty: 2, unitPrice: 32.90 }])), 93.00);
});
ok('supplyRequestTotal handles empty / garbage / a priceless item (SUP-4)', () => {
  assert.equal(supplyRequestTotal(req([])), 0);
  assert.equal(supplyRequestTotal({}), 0);
  assert.equal(supplyRequestTotal(req([{ name: 'x', qty: 'z', unitPrice: null }])), 0);
  assert.equal(supplyRequestTotal(req([{ name: 'x', qty: 3, unitPrice: null }])), 0);
});
ok('supplyRequestItemCount sums qty', () => {
  assert.equal(supplyRequestItemCount(req([{ qty: 4 }, { qty: 2 }, { qty: 1 }])), 7);
});
// The row's summary is a catalog sentence (UI_RULES §140), so the lib hands back its PARTS.
ok('supplyLinesSummary: single vs many vs empty', () => {
  assert.deepEqual(supplyLinesSummary([{ name: 'Glass cleaner', qty: 4 }]), { name: 'Glass cleaner', qty: 4, more: 0 });
  assert.deepEqual(supplyLinesSummary([{ name: 'Glass cleaner', qty: 4 }, { name: 'Liners', qty: 2 }, { name: 'Towels', qty: 1 }]), { name: 'Glass cleaner', qty: 4, more: 2 });
  assert.equal(supplyLinesSummary([]), null);
  assert.equal(supplyLinesSummary(undefined), null);
  assert.deepEqual(supplyLinesSummary([{ qty: 'x' }]), { name: '', qty: 0, more: 0 });
});

// ── The queue's Manager filter reads the BUILDING's supervisor (2026-10-04) ──────
ok('filterSupplyRequests: Manager = the building supervisor, not the requester', () => {
  const supervisorOf = (clientId) => ({ cl1: 'u_m', cl2: 'u_x' })[clientId] || null;
  const list = [
    { id: 'a', clientId: 'cl1', requestedByUserId: 'u_a', status: 'open' },
    { id: 'b', clientId: 'cl2', requestedByUserId: 'u_m', status: 'open' },
    { id: 'c', clientId: 'cl1', requestedByUserId: 'u_m', status: 'approved' },
    { id: 'd', clientId: 'cl3', requestedByUserId: 'u_m' }, // no status: reads as requested
  ];
  const ids = (f) => filterSupplyRequests(list, { supervisorOf, ...f }).map((r) => r.id);
  assert.deepEqual(ids({ status: 'open', managerId: 'u_m' }), ['a']);
  assert.deepEqual(ids({ status: 'open', managerId: 'u_x' }), ['b']);
  assert.deepEqual(ids({ status: 'open' }), ['a', 'b', 'd']);
  assert.deepEqual(ids({ status: 'approved', managerId: 'u_m' }), ['c']);
  assert.deepEqual(ids({ status: 'open', clientId: 'cl2' }), ['b']);
  assert.deepEqual(ids({ status: 'open', managerId: 'u_m', clientId: 'cl2' }), []);
  assert.deepEqual(ids({ status: 'open', managerId: 'u_nobody' }), []);
});

ok('clampSupplyQty: a whole number from 0 to SUPPLY_MAX_QTY, anything else reads as 0', () => {
  assert.equal(clampSupplyQty('4'), 4);
  assert.equal(clampSupplyQty(3.7), 3);
  assert.equal(clampSupplyQty(-2), 0);
  assert.equal(clampSupplyQty(''), 0);
  assert.equal(clampSupplyQty('abc'), 0);
  assert.equal(clampSupplyQty(SUPPLY_MAX_QTY + 50), SUPPLY_MAX_QTY);
  assert.ok(SUPPLY_MAX_QTY >= 100 && SUPPLY_MAX_QTY <= 9999, 'a sane cap');
});

// ── 🔴 SUP-11 (Matt, 2026-10-05) + S131: who may approve or decline ─────────────────────
// "The building's supervisor, and the office can step in." The approver is resolved by the
// caller (resolveSupplyApprover: the building's account manager, else the named approver), so
// `approverId` is that answer. S131: their operations manager, the owner or an admin may step in —
// each with supplies.approve — and supplies.manage alone decides NO approval (the Supply Manager).
ok('SUP-11 / S131: maySupplyDecide — the approver, their OM, the owner or an admin; never supplies.manage alone', () => {
  const r = { id: 'sr', clientId: 'A' };
  const may = (o) => S.maySupplyDecide({ request: r, decision: 'approve', ...o });
  // supervisor of A, deciding A's request (A's approver is them)
  assert.equal(may({ selfId: 'u_supA', role: 'manager', approverId: 'u_supA', holdsApprove: true }), true);
  // supervisor of A, deciding B's request (B's approver is someone else)
  assert.equal(may({ selfId: 'u_supA', role: 'manager', approverId: 'u_supB', holdsApprove: true }), false);
  // the owner and an admin step in, on any building — holding supplies.approve
  assert.equal(may({ selfId: 'u_off', role: 'admin', approverId: 'u_supB', holdsApprove: true }), true);
  assert.equal(may({ selfId: 'u_own', role: 'owner', approverId: 'u_supB', holdsApprove: true }), true);
  // 🔴 supplies.manage alone decides no approval (S131: the Supply Manager is refused)
  assert.equal(may({ selfId: 'u_off', role: 'admin', approverId: 'u_supB', holdsApprove: false, holdsManage: true }), false);
  assert.equal(may({ selfId: 'u_sm', role: 'supply_manager', approverId: 'u_supB', holdsManage: true }), false);
  // B's approver's operations manager may
  assert.equal(may({ selfId: 'u_om', role: 'manager', approverId: 'u_supB', approverOpsManagerId: 'u_om', holdsApprove: true }), true);
  // a named org approver (SUP-9) IS the resolved approver for a building with no manager
  assert.equal(may({ selfId: 'u_named', role: 'manager', approverId: 'u_named', holdsApprove: true }), true);
  // the approver, pared off supplies.approve in Settings → Roles, may not
  assert.equal(may({ selfId: 'u_supA', role: 'manager', approverId: 'u_supA', holdsApprove: false }), false);
  // a building with no approver at all: only the owner or an admin
  assert.equal(may({ selfId: 'u_supA', role: 'manager', approverId: null, holdsApprove: true }), false);
  // reject follows approve; submit / complete / reopen are the Supply Manager's (supplies.manage)
  assert.equal(S.maySupplyDecide({ request: r, decision: 'reject', selfId: 'u_supA', approverId: 'u_supA', holdsApprove: true }), true);
  for (const d of ['submit', 'complete', 'reopen', 'backorder', 'cancelLine']) {
    assert.equal(S.maySupplyDecide({ request: r, decision: d, selfId: 'u_supA', approverId: 'u_supA', holdsApprove: true }), false, d);
    assert.equal(S.maySupplyDecide({ request: r, decision: d, holdsManage: true }), true, d);
  }
  assert.equal(S.maySupplyDecide({ request: r, decision: 'nonsense', holdsManage: true }), false);
  assert.equal(S.maySupplyDecide({ request: null, decision: 'approve', holdsApprove: true, role: 'owner' }), false);
});
ok('CS-596: "the office" for a cancel is the owner or a supplies.manage holder (isSupplyOffice)', () => {
  for (const o of [{ role: 'owner' }, { holdsManage: true }, { role: 'manager' }, { role: 'admin', holdsManage: false }]) {
    const office = S.isSupplyOffice(o);
    const cancelAny = S.maySupplyCancel({ request: { id: 'x', status: 'approved', requestedByUserId: 'someone' }, ...o });
    assert.equal(cancelAny, office, JSON.stringify(o));
  }
});

// ── 🔴 SUP-13: the kept history is 12 calendar months ──────────────────────────
ok('SUP-13: the history starts the day after the same date 12 months ago, and is derived', () => {
  assert.equal(S.SUPPLY_HISTORY_MONTHS, 12);
  assert.equal(S.supplyHistoryStartKey('2026-10-05'), addDaysKey(addMonthsKey('2026-10-05', -12), 1));
  assert.equal(S.supplyHistoryStartKey('2026-10-05'), '2025-10-06');
  assert.equal(S.supplyHistoryDays('2026-10-05'), 365);
  assert.equal(S.supplyHistoryDays('2024-03-01'), 366); // the window holds 29 Feb 2024
  assert.equal(S.supplyRangeBeforeHistory('2025-10-06', '2026-10-05'), false);
  assert.equal(S.supplyRangeBeforeHistory('2025-10-05', '2026-10-05'), true);
  assert.equal(S.supplyRangeBeforeHistory('', '2026-10-05'), false);
  // the 90-day / newest-300 bounds are gone, not shadowed
  assert.equal(S.SUPPLY_COMPLETED_CAP, undefined);
  assert.equal(S.pruneSupplyRequests, undefined);
});
ok('SUP-13: usage periods — 6 and 12 months join the presets, a custom range is held to the history', () => {
  const today = '2026-10-05';
  const w = (p, o = {}) => S.supplyUsageWindowKeys(p, { todayKey: today, ...o });
  assert.deepEqual(w('7d'), { fromKey: '2026-09-29', toKey: today });
  assert.deepEqual(w('30d'), { fromKey: '2026-09-06', toKey: today });
  assert.deepEqual(w('mtd'), { fromKey: '2026-10-01', toKey: today });
  assert.deepEqual(w('6m'), { fromKey: '2026-04-06', toKey: today });
  assert.deepEqual(w('12m'), { fromKey: S.supplyHistoryStartKey(today), toKey: today });
  assert.deepEqual(w('custom', { from: '2026-01-01', to: '2026-02-01' }), { fromKey: '2026-01-01', toKey: '2026-02-01' });
  assert.equal(w('custom', { from: '2026-01-01' }).error, 'pick_both');
  assert.equal(w('custom', { from: '2026-02-01', to: '2026-01-01' }).error, 'end_before_start');
  const old = w('custom', { from: '2025-01-01', to: '2025-12-01' });
  assert.equal(old.error, 'before_history');
  assert.equal(old.firstKey, S.supplyHistoryStartKey(today));
  assert.deepEqual(w('custom', { from: '2026-09-01', to: '2027-01-01' }), { fromKey: '2026-09-01', toKey: today }); // no future
  assert.ok(S.SUPPLY_USAGE_PERIODS.includes('6m') && S.SUPPLY_USAGE_PERIODS.includes('12m'));
});

// ── SUP-13: money at the storage boundary is INTEGER CENTS (II.8) ──────────────
ok('SUP-13: dollars ↔ cents round-trip, and "no price" is null on both sides (SUP-4)', () => {
  for (const d of [6.8, 6.79, 28.4, 0.01, 1.005, 1234.56]) {
    const c = S.supplyToCents(d);
    assert.ok(Number.isInteger(c), `${d} → ${c}`);
    assert.equal(S.supplyFromCents(c), Math.round((d + Number.EPSILON) * 100) / 100);
  }
  assert.equal(S.supplyToCents(1.005), 101);
  for (const none of [null, undefined, '', 0, -3, 'abc']) assert.equal(S.supplyToCents(none), null, String(none));
  assert.equal(S.supplyFromCents(null), null);
  assert.equal(S.supplyFromCents(0), null);
  assert.equal(S.supplyLinesTotalCents([{ qty: 4, unitPriceCents: 680 }, { qty: 2, unitPriceCents: 3290 }, { qty: 9, unitPriceCents: null }]), 9300);
});

// ── SUP-13: a submitted request's lines come from the building's OWN list ───────
// Since the master list (D5) a building's item is read THROUGH the catalog, so the snapshot also
// freezes the item's SKU and the CATALOG item it is (what history and on-order key on, D6).
ok('snapshotSupplyLines: names, SKUs and prices from the list, never the body; duplicates merge; 0 is dropped', () => {
  const items = new Map([
    ['i1', { id: 'i1', catalogItemId: 'sc_glass', sku: 'CL-1001', name: 'Glass cleaner', unitPrice: 6.789 }],
    ['i2', { id: 'i2', catalogItemId: 'sc_bulb', sku: null, name: 'Bulbs', unitPrice: null }],
  ]);
  const r = S.snapshotSupplyLines([
    { itemId: 'i1', qty: 2, unitPrice: 0.01, name: 'FREE STUFF', sku: 'HACK' },
    { itemId: 'i1', qty: 3 },
    { itemId: 'i2', qty: 1 },
    { itemId: 'i2', qty: 0 },
  ], items);
  assert.deepEqual(r.lines, [
    { itemId: 'i1', catalogItemId: 'sc_glass', sku: 'CL-1001', name: 'Glass cleaner', qty: 5, unitPrice: 6.79 },
    { itemId: 'i2', catalogItemId: 'sc_bulb', sku: null, name: 'Bulbs', qty: 1, unitPrice: null },
  ]);
  assert.equal(S.snapshotSupplyLines([{ itemId: 'i1', qty: 0 }], items).error, 'no_lines');
  assert.deepEqual(S.snapshotSupplyLines([{ itemId: 'gone', qty: 1 }], items), { error: 'unknown_item', itemId: 'gone' });
  // An order sheet opened before an item was switched off and back on names the CATALOG item:
  // the building's new row for it answers, merged with a line naming the row itself.
  const viaCatalog = S.snapshotSupplyLines([{ catalogItemId: 'sc_glass', qty: 1 }, { itemId: 'i1', qty: 1 }], items);
  assert.deepEqual(viaCatalog.lines, [{ itemId: 'i1', catalogItemId: 'sc_glass', sku: 'CL-1001', name: 'Glass cleaner', qty: 2, unitPrice: 6.79 }]);
  assert.deepEqual(S.snapshotSupplyLines([{ catalogItemId: 'sc_other', qty: 1 }], items), { error: 'unknown_item', itemId: 'sc_other' });
});

// ── the decision's PATCH (lib/supplyFlow) ──────────────────────────────────────
ok('supplyDecisionPatch: the state machine, the reason, the stamps and the name snapshots', () => {
  const NOW = '2026-10-05T15:00:00.000Z';
  const open = { id: 'sr', status: SUPPLY_STATUS.requested, lines: [{ itemId: 'i1', catalogItemId: 'sc_1', qty: 2, unitPrice: 5 }] };
  assert.equal(F.supplyDecisionPatch(open, 'complete', { now: NOW }).refused, 'illegal_move'); // fill unapproved
  assert.equal(F.supplyDecisionPatch(open, 'reject', { now: NOW, reason: '   ' }).refused, 'reason_required');
  assert.equal(F.supplyDecisionPatch(null, 'approve').refused, 'not_found');
  const a = F.supplyDecisionPatch(open, 'approve', { byUserId: 'u_m', byName: 'Renata', now: NOW });
  assert.equal(a.patch.status, SUPPLY_STATUS.approved);
  assert.equal(a.patch.approvedAt, NOW);
  assert.equal(a.patch.approvedByName, 'Renata');
  const approved = { ...open, ...a.patch };
  assert.equal(F.supplyDecisionPatch(approved, 'approve', { now: NOW }).refused, 'illegal_move'); // no move
  // S131: what is approved is SUBMITTED to the supplier, and only a submitted order is completed —
  // once every line is delivered or cancelled.
  assert.equal(F.supplyDecisionPatch(approved, 'complete', { now: NOW }).refused, 'illegal_move');
  const sent = { ...approved, ...F.supplyDecisionPatch(approved, 'submit', { byUserId: 'u_o', byName: 'Kyler', now: NOW }).patch };
  assert.equal(F.supplyDecisionPatch(sent, 'complete', { now: NOW }).refused, 'lines_open');
  const delivered = { ...sent, ...F.supplyFulfillPatch(sent, [{ line: 0, act: 'deliver' }], { byUserId: 'u_d', byName: 'Alberto', via: 'driver', now: NOW, todayKey: '2026-10-05' }).patch };
  const c = F.supplyDecisionPatch(delivered, 'complete', { byUserId: 'u_o', byName: 'Kyler', now: NOW });
  assert.equal(c.patch.status, SUPPLY_STATUS.completed);
  assert.equal(c.patch.approvedByName, 'Renata', 'completing keeps who approved the spend');
  assert.equal(c.patch.completedByName, 'Kyler');
  assert.equal(F.supplyDecisionPatch({ ...delivered, ...c.patch }, 'reopen', { now: NOW }).refused, 'illegal_move', 'a completed order is final');
  assert.equal(F.supplyDecisionPatch(delivered, 'reopen', { now: NOW }).refused, 'has_deliveries', 'nor reopened once something arrived');
  const back = F.supplyDecisionPatch(sent, 'reopen', { now: NOW });
  assert.equal(back.patch.status, SUPPLY_STATUS.requested);
  assert.equal(back.patch.sentAt, null);
  assert.equal(back.patch.fulfillment, null, 'a reopen clears the per-line record with the submit');
  const rej = F.supplyDecisionPatch(open, 'reject', { byUserId: 'u_m', byName: 'Renata', reason: '  Ordered last week ', now: NOW });
  assert.equal(rej.patch.rejectionReason, 'Ordered last week');
  assert.equal(rej.patch.rejectedByName, 'Renata');
});
// 🔴 S131 Wave 2 (brief A): a decline asks for a REASON of at least SUPPLY_DECLINE_REASON_MIN
// characters — the cleaner is told it, so "x" or "no" is not one. ONE rule: the write point (here,
// the route and the demo stub) and the dialog (components/SupplyDeclineModal) read the same number.
ok('S131: a decline needs a reason of at least SUPPLY_DECLINE_REASON_MIN (3) characters, trimmed — at the write point', () => {
  const NOW = '2026-10-14T15:00:00.000Z';
  const open = { id: 'sr', status: SUPPLY_STATUS.requested, lines: [{ itemId: 'i1', qty: 1, unitPrice: 5 }] };
  assert.equal(S.SUPPLY_DECLINE_REASON_MIN, 3);
  assert.equal(S.SUPPLY_DECLINE_REASON_MAX, 1000);
  for (const reason of ['', '   ', 'x', 'no', '  ok  ']) {
    assert.equal(F.supplyDecisionPatch(open, 'reject', { now: NOW, reason }).refused, 'reason_required', JSON.stringify(reason));
  }
  assert.equal(F.supplyDecisionPatch(open, 'reject', { now: NOW, reason: ' Not now ' }).patch.rejectionReason, 'Not now');
  assert.equal(F.supplyDecisionPatch(open, 'reject', { now: NOW, reason: 'Too' }).patch.status, SUPPLY_STATUS.rejected, 'exactly the minimum is enough');
  assert.equal(F.supplyDecisionPatch(open, 'reject', { now: NOW, reason: 'y'.repeat(1200) }).patch.rejectionReason.length, S.SUPPLY_DECLINE_REASON_MAX, 'a long one is kept to the column');
});

// ── who hears about it (lib/supplyFlow), on a store snapshot ────────────────────
const mkUser = (id, role, prefs = {}) => ({ id, role, status: 'active', name: id, notificationPrefs: prefs });
const baseState = (over = {}) => ({
  users: [mkUser('u_o', 'owner'), mkUser('u_a', 'admin'), mkUser('u_m', 'manager'), mkUser('u_c', 'crew')],
  clients: [{ id: 'cl1', name: 'Las Olas', supervisorId: 'u_m' }],
  permissions: [], userPermissionOverrides: [], notifications: [], opsSettings: {}, ...over,
});
const to = (rows, key) => rows.filter((n) => n.eventKey === key).map((n) => n.userId).sort();
const request = (extra = {}) => ({
  id: 'sr_1', clientId: 'cl1', requestedByUserId: 'u_a', status: 'open',
  lines: [{ itemId: 'i1', name: 'Glass cleaner', qty: 4, unitPrice: 6.80 }], ...extra,
});

ok('SUP-9: a submission rings the building APPROVER alone, not the whole office', () => {
  assert.deepEqual(to(F.supplySubmitNotifications(baseState(), request(), { actorUserId: 'u_a' }), 'supplyRequestSubmitted'), ['u_m']);
});
ok('a submission skips an approver who muted it, and one who is the requester', () => {
  const muted = baseState({ users: [mkUser('u_o', 'owner'), mkUser('u_a', 'admin'), mkUser('u_m', 'manager', { supplyRequestSubmitted: false })] });
  assert.deepEqual(to(F.supplySubmitNotifications(muted, request(), { actorUserId: 'u_a' }), 'supplyRequestSubmitted'), []);
  assert.deepEqual(to(F.supplySubmitNotifications(baseState(), request({ requestedByUserId: 'u_m' }), { actorUserId: 'u_m' }), 'supplyRequestSubmitted'), []);
});
ok('SUP-1: an approval rings the OFFICE (the fill tier; with no Supply Manager on the team), skipping the approver', () => {
  const rows = F.supplyDecisionNotifications(baseState(), { request: request({ status: 'approved' }), decision: 'approve', actorUserId: 'u_m' });
  assert.deepEqual(to(rows, 'supplyRequestApproved'), ['u_a', 'u_o']);
});
ok('S131: a decline rings the REQUESTER; completing the requester and the account manager; a reopen nobody; a self-decision is silent', () => {
  const s = baseState();
  assert.deepEqual(to(F.supplyDecisionNotifications(s, { request: request({ status: 'rejected', rejectionReason: 'no' }), decision: 'reject', actorUserId: 'u_m' }), 'supplyOrderDeclined'), ['u_a']);
  assert.deepEqual(to(F.supplyDecisionNotifications(s, { request: request({ status: 'completed' }), decision: 'complete', actorUserId: 'u_o' }), 'supplyOrderCompleted'), ['u_a', 'u_m']);
  assert.equal(F.supplyDecisionNotifications(s, { request: request(), decision: 'reopen', actorUserId: 'u_o' }), s.notifications);
  assert.deepEqual(to(F.supplyDecisionNotifications(s, { request: request({ status: 'completed' }), decision: 'complete', actorUserId: 'u_a' }), 'supplyOrderCompleted'), ['u_m']);
  assert.equal(F.applySupplyDecision, undefined, 'the blob applier is gone (II.5)');
});

// ── 🔴 a big "Select all" is decided in BOUNDED batches, never truncated ─────
// 750 buildings each with a request waiting is one Select all of 750 ids. One request per id
// used to be capped at 500 in the store by slice() — the rest got no answer at all, and the
// toast counted only what came back. Now the route refuses a batch over SUPPLY_DECIDE_MAX by
// name and the client splits a selection into batches of it, merging the answers.
const okAsync = async (label, fn) => { await fn(); pass += 1; console.log(`  ✓ ${label}`); };
await okAsync('SUPPLY_DECIDE_MAX bounds one decide call; a selection is split into batches of it, answers merged in order', async () => {
  assert.equal(typeof S.SUPPLY_DECIDE_MAX, 'number');
  assert.ok(S.SUPPLY_DECIDE_MAX >= 50 && S.SUPPLY_DECIDE_MAX <= 500);
  const ids = Array.from({ length: S.SUPPLY_DECIDE_MAX * 2 + 50 }, (_, i) => `sr_${i}`);
  const sizes = [];
  const out = await S.runSupplyDecideBatches([...ids, ids[0]], async (batch) => {
    sizes.push(batch.length);
    return { results: batch.map((id) => ({ id, ok: true, code: 'ok' })) };
  });
  assert.deepEqual(sizes, [S.SUPPLY_DECIDE_MAX, S.SUPPLY_DECIDE_MAX, 50], 'a duplicate id is sent once');
  assert.equal(out.results.length, ids.length);
  assert.deepEqual(out.results.map((x) => x.id), ids);
  assert.deepEqual(out.counts, { ok: ids.length });
});
await okAsync('a batch that fails after another landed names the rest as failed (nothing is silently dropped); a first failure throws', async () => {
  const ids = Array.from({ length: S.SUPPLY_DECIDE_MAX + 10 }, (_, i) => `sr_${i}`);
  let n = 0;
  const out = await S.runSupplyDecideBatches(ids, async (batch) => {
    n += 1;
    if (n === 2) throw new Error('offline');
    return { results: batch.map((id) => ({ id, ok: true, code: 'ok' })) };
  });
  assert.equal(out.results.length, ids.length);
  assert.deepEqual(out.counts, { ok: S.SUPPLY_DECIDE_MAX, failed: 10 });
  assert.ok(out.results.slice(S.SUPPLY_DECIDE_MAX).every((x) => x.ok === false && x.code === 'failed'));
  await assert.rejects(S.runSupplyDecideBatches(['sr_a'], async () => { throw new Error('offline'); }));
});

// ── Round 3 (Daniel, 2026-10-06: the order sheet + the building's own Supplies tab) ──────────
// What is already on order, by CATALOG ITEM (never by name: two items may share a name, and a
// renamed item is still the same item; never by the building's row id, which a switch off and on
// replaces — D6). A line written before the master list names only the building's row: the
// caller's `itemCatalog` (row id → catalog id, from the building's list) resolves it. Only
// requested + approved count; a line that resolves to no catalog item is not any item's.
ok('supplyOnOrderByItem: requested and approved apart, keyed on the catalog item, nothing else counted', () => {
  const list = [
    { id: 'a', status: 'open', lines: [{ itemId: 'si_1', catalogItemId: 'glass', name: 'Glass', qty: 4 }, { itemId: 'si_2', catalogItemId: 'tp', name: 'TP', qty: 1 }] },
    { id: 'b', status: 'approved', lines: [{ itemId: 'si_old', catalogItemId: 'glass', name: 'Glass cleaner (renamed)', qty: 1 }, { itemId: 'si_3', catalogItemId: 'liner', name: 'Liners', qty: 2 }] },
    { id: 'c', status: 'open', lines: [{ itemId: 'si_1', catalogItemId: 'glass', name: 'Glass', qty: 2 }, { name: 'Glass', qty: 9 }] }, // no id at all: not counted
    { id: 'd', status: 'completed', lines: [{ itemId: 'si_1', catalogItemId: 'glass', qty: 50 }] },
    { id: 'e', status: 'rejected', lines: [{ itemId: 'si_2', catalogItemId: 'tp', qty: 50 }] },
    { id: 'f', lines: [{ itemId: 'si_2', catalogItemId: 'tp', qty: 3 }] }, // no status reads as requested
    { id: 'g', status: 'open', lines: [{ itemId: 'si_2', catalogItemId: 'tp', qty: 0 }, { itemId: 'si_2', catalogItemId: 'tp', qty: 'x' }] },
    // written before the master list: the row id only, resolved through the building's list
    { id: 'h', status: 'open', lines: [{ itemId: 'si_legacy', name: 'Liners', qty: 5 }, { itemId: 'si_unknown', name: 'X', qty: 7 }] },
  ];
  assert.deepEqual(S.supplyOnOrderByItem(list, { itemCatalog: { si_legacy: 'liner' } }), {
    glass: { requested: 6, approved: 1, sent: 0 },
    tp: { requested: 4, approved: 0, sent: 0 },
    liner: { requested: 5, approved: 2, sent: 0 },
  });
  assert.deepEqual(S.supplyOnOrderByItem([]), {});
  assert.deepEqual(S.supplyOnOrderByItem(null), {});
  assert.equal(S.supplyLineCatalogId({ itemId: 'si_x', catalogItemId: 'sc_a' }, { si_x: 'sc_b' }), 'sc_a', 'the line\'s own catalog id wins');
  assert.equal(S.supplyLineCatalogId({ itemId: 'si_x' }, new Map([['si_x', 'sc_b']])), 'sc_b', 'a Map resolves too');
  assert.equal(S.supplyLineCatalogId({ itemId: 'si_x' }), null);
  assert.deepEqual(S.supplyItemCatalogMap([{ id: 'si_1', catalogItemId: 'sc_1' }, { id: 'si_2' }, null]), { si_1: 'sc_1' });
});
ok('supplyOnOrderCents: the money still on order (requested + approved), in cents, priceless lines nothing', () => {
  const list = [
    { status: 'open', lines: [{ itemId: 'a', qty: 4, unitPrice: 6.8 }, { itemId: 'b', qty: 2, unitPrice: null }] },
    { status: 'approved', lines: [{ itemId: 'c', qty: 1, unitPrice: 28.4 }, { itemId: 'd', qty: 2, unitPrice: 32.9 }] },
    { status: 'completed', lines: [{ itemId: 'a', qty: 100, unitPrice: 6.8 }] },
  ];
  assert.equal(S.supplyOnOrderCents(list), 2720 + 2840 + 6580);
  assert.equal(S.supplyOnOrderCents([]), 0);
});

// The budget line under the order sheet's total: one rule, worked in CENTS, so the sentence the
// form shows can never disagree with the figures it is built from. A warning, never a block.
ok('supplyBudgetLine: no budget · nothing picked · picked under · picked over (cents inside)', () => {
  const line = (o) => S.supplyBudgetLine({ budget: 400, deliveredCents: 5000, onOrderCents: 12140, thisCents: 0, ...o });
  assert.deepEqual(S.supplyBudgetLine({ budget: null, deliveredCents: 5000, onOrderCents: 0, thisCents: 999 }), { kind: 'none' });
  assert.deepEqual(S.supplyBudgetLine({ budget: 0, deliveredCents: 0, onOrderCents: 0, thisCents: 0 }), { kind: 'none' });
  assert.deepEqual(line({}), { kind: 'month', budget: 400, delivered: 50, onOrder: 121.4 });
  assert.deepEqual(line({ thisCents: 10610 }), { kind: 'with', budget: 400, withThis: 277.5, onOrder: 121.4 });
  // exactly on the budget is ON budget (isOverSupplyBudget's rule)
  assert.deepEqual(line({ thisCents: 40000 - 5000 - 12140 }), { kind: 'with', budget: 400, withThis: 400, onOrder: 121.4 });
  assert.deepEqual(line({ thisCents: 40000 - 5000 - 12140 + 1 }), { kind: 'over', budget: 400, over: 0.01, onOrder: 121.4 });
  assert.deepEqual(line({ thisCents: 30000 }), { kind: 'over', budget: 400, over: 71.4, onOrder: 121.4 });
  // a float sum would read 0.1 + 0.2 ≠ 0.3: cents keep the edge exact
  assert.deepEqual(S.supplyBudgetLine({ budget: 0.3, deliveredCents: 10, onOrderCents: 0, thisCents: 20 }), { kind: 'with', budget: 0.3, withThis: 0.3, onOrder: 0 });
  // a delivered spend not loaded yet is not zero: the line says nothing it cannot back
  assert.deepEqual(S.supplyBudgetLine({ budget: 400, deliveredCents: null, onOrderCents: 0, thisCents: 0 }), { kind: 'unknown' });
});

// The customer tab's history columns: per CATALOG ITEM, from this building's DELIVERED requests
// — when it last came and how many, and how many in the last 90 days of the ORG's calendar.
// Keyed on the catalog item, so a building's row that was switched off and back on (a NEW row
// id) still shows what was delivered before (D6).
ok('supplyItemHistory: last delivery, its quantity, and the last 90 org-zone days, by catalog item', () => {
  const TZ = 'America/New_York';
  const today = '2026-10-06';
  const startKey = S.supplyRecentStartKey(today);
  assert.equal(startKey, addDaysKey(today, -(S.SUPPLY_RECENT_DAYS - 1)));
  assert.equal(S.SUPPLY_RECENT_DAYS, 90);
  const edge = startOfDayKey(startKey, TZ).getTime();
  const at = (ms) => new Date(ms).toISOString();
  const L = (catalogItemId, qty, itemId = `si_${catalogItemId}`) => ({ itemId, catalogItemId, qty });
  const list = [
    // newest: two lines of the same item in one delivery sum to ONE delivery of 5
    { id: 'n', status: 'completed', completedAt: at(edge + 50 * 86400000), lines: [L('glass', 2), L('glass', 3), { name: 'no id', qty: 7 }] },
    // inside, by a minute — one line written before the master list (the row id only)
    { id: 'm', status: 'completed', completedAt: at(edge + 60000), lines: [{ itemId: 'si_legacy_glass', qty: 4 }, L('tp', 1)] },
    { id: 'o', status: 'completed', completedAt: at(edge - 60000), lines: [L('glass', 100), L('liner', 6)] }, // a minute before the window
    { id: 'p', status: 'approved', completedAt: null, lines: [L('glass', 9)] },  // not delivered
    { id: 'q', status: 'rejected', lines: [L('tp', 9)] },
  ];
  const h = S.supplyItemHistory(list, { recentFromMs: edge, itemCatalog: { si_legacy_glass: 'glass' } });
  assert.deepEqual(h.glass, { lastDeliveredAt: at(edge + 50 * 86400000), lastDeliveredQty: 5, qty90d: 9 });
  assert.deepEqual(h.tp, { lastDeliveredAt: at(edge + 60000), lastDeliveredQty: 1, qty90d: 1 });
  assert.deepEqual(h.liner, { lastDeliveredAt: at(edge - 60000), lastDeliveredQty: 6, qty90d: 0 });
  assert.equal(h['no id'], undefined);
  assert.equal(Object.keys(h).length, 3);
  // 🔴 D6: the merge matches a building's row by its CATALOG item, so a row minted when the
  // item was switched back on reads the history of the one it replaced. An item never delivered
  // gets the empty answer, and the merge never invents a number.
  const merged = S.withSupplyHistory([
    { id: 'si_back_on', catalogItemId: 'glass', name: 'Glass' },
    { id: 'si_new', catalogItemId: 'new', name: 'New' },
  ], h);
  assert.deepEqual(merged[1], { id: 'si_new', catalogItemId: 'new', name: 'New', lastDeliveredAt: null, lastDeliveredQty: 0, qty90d: 0 });
  assert.equal(merged[0].qty90d, 9);
  assert.equal(merged[0].lastDeliveredQty, 5);
});

// ── The master supply list (Matt, the Oct 6 call: "We can have a master template. And then for
//    a customer, we can assign which supplies they can order") ────────────────────────────────
// D2: a SKU is optional and, when given, unique in the org — CASE-INSENSITIVE and around its
// spaces (the database's unique index is on lower(btrim(sku))), so "cl-1001 " and "CL-1001" are
// one SKU; a blank SKU is no SKU and may repeat as often as the office likes.
ok('supplySkuKey / findSupplySkuClash: unique case-insensitively, blank allowed many times', () => {
  assert.equal(S.supplySkuKey('  CL-1001 '), 'cl-1001');
  assert.equal(S.supplySkuKey('CL  1001'), 'cl 1001', 'inner runs of spaces read as one, as the save stores them');
  for (const blank of ['', '   ', null, undefined]) assert.equal(S.supplySkuKey(blank), null, String(blank));
  const catalog = [
    { id: 'sc_a', name: 'Glass cleaner', sku: 'CL-1001' },
    { id: 'sc_b', name: 'Bulbs', sku: null },
    { id: 'sc_c', name: 'Mop heads', sku: '' },
  ];
  assert.equal(S.findSupplySkuClash(catalog, { id: 'sc_new', sku: 'cl-1001 ' })?.id, 'sc_a', 'another item holding it, whatever the case');
  assert.equal(S.findSupplySkuClash(catalog, { id: 'sc_a', sku: 'CL-1001' }), null, 'an item keeps its own SKU on an edit');
  assert.equal(S.findSupplySkuClash(catalog, { id: 'sc_new', sku: '' }), null, 'a blank SKU never clashes');
  assert.equal(S.findSupplySkuClash(catalog, { id: 'sc_new', sku: null }), null);
  assert.equal(S.findSupplySkuClash(catalog, { id: 'sc_new', sku: 'PP-2001' }), null);
});

// One sanitizer for the route and the demo stub: what a catalog item may hold, and the refusal
// for what it may not (each a named code the screen words).
ok('supplyCatalogFields: one line each, SKU / category / unit optional, price above zero or blank, every limit named', () => {
  const f = S.supplyCatalogFields({ sku: ' CL-1001 ', name: '  Glass   cleaner 32 oz ', category: ' Liquids ', unit: ' each ', unitPrice: '6.80' });
  assert.deepEqual(f, { fields: { sku: 'CL-1001', name: 'Glass cleaner 32 oz', category: 'Liquids', unit: 'each', unitPriceCents: 680 } });
  assert.deepEqual(S.supplyCatalogFields({ name: 'Bulbs', sku: '', category: '', unit: '', unitPrice: '' }),
    { fields: { sku: null, name: 'Bulbs', category: null, unit: null, unitPriceCents: null } }, 'blank is none, never an empty string or $0');
  assert.equal(S.supplyCatalogFields({ name: 'a\tb\nc' }).fields.name, 'a b c', 'control characters and line breaks read as one line');
  assert.equal(S.supplyCatalogFields({ name: '   ' }).error, 'name_required');
  assert.equal(S.supplyCatalogFields({}).error, 'name_required');
  assert.equal(S.supplyCatalogFields({ name: 'x', unitPrice: 0 }).error, 'bad_price');
  assert.equal(S.supplyCatalogFields({ name: 'x', unitPrice: -2 }).error, 'bad_price');
  assert.equal(S.supplyCatalogFields({ name: 'x', unitPrice: 'abc' }).error, 'bad_price');
  assert.equal(S.supplyCatalogFields({ name: 'x', unitPrice: S.SUPPLY_MAX_PRICE_CENTS / 100 + 1 }).error, 'bad_price');
  assert.equal(S.supplyCatalogFields({ name: 'x'.repeat(S.SUPPLY_NAME_MAX + 1) }).error, 'name_too_long');
  assert.equal(S.supplyCatalogFields({ name: 'x', sku: 'S'.repeat(S.SUPPLY_SKU_MAX + 1) }).error, 'sku_too_long');
  assert.equal(S.supplyCatalogFields({ name: 'x', category: 'C'.repeat(S.SUPPLY_CATEGORY_MAX + 1) }).error, 'category_too_long');
  assert.equal(S.supplyCatalogFields({ name: 'x', unit: 'U'.repeat(S.SUPPLY_UNIT_MAX + 1) }).error, 'unit_too_long');
});

// D3: the category is a free label; the screens suggest the ones already used, and a building's
// switches and the order sheet group by it — named groups A to Z, the unlabelled ones last.
ok('supplyCategories / groupSupplyByCategory: one spelling per label, A to Z, the unlabelled last', () => {
  const items = [
    { id: '1', name: 'Toilet paper', category: 'Paper, plastic & soap' },
    { id: '2', name: 'Glass cleaner', category: 'Liquids' },
    { id: '3', name: 'Bulbs', category: null },
    { id: '4', name: 'Disinfectant', category: 'liquids ' },
    { id: '5', name: 'Hand soap', category: 'Paper, plastic & soap' },
  ];
  assert.deepEqual(S.supplyCategories(items), ['Liquids', 'Paper, plastic & soap']);
  const groups = S.groupSupplyByCategory(items);
  assert.deepEqual(groups.map((g) => g.category), ['Liquids', 'Paper, plastic & soap', null]);
  assert.deepEqual(groups.map((g) => g.items.map((x) => x.id)), [['4', '2'], ['5', '1'], ['3']]);
  assert.deepEqual(S.groupSupplyByCategory([]), []);
  // A label typed in another case or with spaces is SAVED as the spelling already in use, so the
  // category filter (an exact match) and the groups never split one label in two. An item that is
  // the only one with its label may change that label's case.
  const used = [{ id: 'a', category: 'Liquids' }, { id: 'b', category: 'Paper, plastic & soap' }, { id: 'c', category: null }];
  assert.equal(S.supplyCategoryAsUsed(used, { id: 'new', category: ' liquids ' }), 'Liquids');
  assert.equal(S.supplyCategoryAsUsed(used, { id: 'new', category: 'PAPER, PLASTIC & SOAP' }), 'Paper, plastic & soap');
  assert.equal(S.supplyCategoryAsUsed(used, { id: 'new', category: 'Chemicals' }), 'Chemicals', 'a new label is kept as typed');
  assert.equal(S.supplyCategoryAsUsed(used, { id: 'a', category: 'LIQUIDS' }), 'LIQUIDS', 'the only holder may re-case its own label');
  assert.equal(S.supplyCategoryAsUsed(used, { id: 'new', category: null }), null);
});

// A building's switches (D4, D6): ONE call carries what to switch on and off, bounded, and every
// asked id is answered by name — never a silent partial.
ok('planSupplyAssign: on and off answered per id (ok · already · not_found · conflict), bounded', () => {
  const plan = S.planSupplyAssign({
    on: ['sc_a', 'sc_b', 'sc_gone', 'sc_both', 'sc_a'],
    off: ['sc_c', 'sc_d', 'sc_both'],
    current: ['sc_b', 'sc_c'],
    known: ['sc_a', 'sc_b', 'sc_c', 'sc_d', 'sc_both'],
  });
  assert.deepEqual(plan.add, ['sc_a']);
  assert.deepEqual(plan.remove, ['sc_c']);
  assert.deepEqual(plan.results, [
    { catalogItemId: 'sc_a', on: true, ok: true, code: 'ok' },
    { catalogItemId: 'sc_b', on: true, ok: true, code: 'already' },
    { catalogItemId: 'sc_gone', on: true, ok: false, code: 'not_found' },
    { catalogItemId: 'sc_both', on: true, ok: false, code: 'conflict' },
    { catalogItemId: 'sc_c', on: false, ok: true, code: 'ok' },
    { catalogItemId: 'sc_d', on: false, ok: true, code: 'already' },
    { catalogItemId: 'sc_both', on: false, ok: false, code: 'conflict' },
  ]);
  const max = S.SUPPLY_ASSIGN_MAX;
  assert.ok(Number.isInteger(max) && max >= 50 && max <= 500);
  const big = Array.from({ length: max + 1 }, (_, i) => `sc_${i}`);
  assert.deepEqual(S.planSupplyAssign({ on: big, off: [], current: [], known: big }), { error: 'too_many', max });
  assert.deepEqual(S.planSupplyAssign({ on: big.slice(0, max), off: [], current: [], known: big }).add.length, max);
  assert.deepEqual(S.planSupplyAssign({}), { add: [], remove: [], results: [] });
});

// The customer tab's "Next order" tile: the next order day on or after today, in the org's
// calendar (a label date, zone-free).
ok('nextSupplyOrderKey: this month while the day is ahead or today, else next month', () => {
  assert.equal(S.nextSupplyOrderKey('2026-10-06', 1), '2026-11-01');
  assert.equal(S.nextSupplyOrderKey('2026-10-06', 6), '2026-10-06');
  assert.equal(S.nextSupplyOrderKey('2026-10-06', 15), '2026-10-15');
  assert.equal(S.nextSupplyOrderKey('2026-12-20', 5), '2027-01-05');
  assert.equal(S.nextSupplyOrderKey('2026-01-31', 28), '2026-02-28');
  assert.equal(S.nextSupplyOrderKey('2026-10-06', 31), '2026-10-28'); // capped at 28 (every month has it)
  assert.equal(S.nextSupplyOrderKey('2026-10-06', null), '2026-11-01'); // the default, the 1st
});

// ── 🔴 THE SUPPLY ORDERS (S131, Matt's 2026-10-13 email and boards; plan 2026-10-14 §1–§3) ─────────
// The delivery step (SUP-16 a + SUP-17 a, 2026-10-12) became an ORDER's lifecycle: the Supply Manager
// SUBMITS an approved order to the supplier (the stored `sent`, no quantities); each line is delivered
// (by the Supply Manager or the driver), backordered or cancelled; the order is COMPLETED once every
// line is resolved. The full rule set is test-supply-orders.mjs; here, the delivery step's own checks
// as they now read.
ok('S131: the stored values never changed (`sent` = submitted to supplier, `completed` = closed); the words are per reader', () => {
  assert.equal(S.SUPPLY_STATUS.sent, 'sent');
  assert.ok(S.SUPPLY_STATUSES.includes('sent'));
  assert.equal(S.SUPPLY_STATUS.completed, 'completed', 'the stored value is unchanged, so no row is transformed');
  assert.equal(S.SUPPLY_STATUS_LABEL_KEYS, undefined, 'the one-word-per-status map is replaced by supplyOrderLabelKey (II.5)');
  assert.equal(english(S.supplyOrderLabelKey({ status: 'sent', lines: [{ qty: 1 }], fulfillment: [{ deliveries: [] }] }, 'office')), 'Submitted to supplier');
  assert.equal(english(S.supplyOrderLabelKey({ status: 'completed' }, 'crew')), 'Delivered');
});
ok('S131: approved → submit → sent → complete → completed, and nothing skips a step', () => {
  const n = S.nextSupplyStatus;
  assert.equal(n('approved', 'submit'), 'sent');
  assert.equal(n('sent', 'complete'), 'completed');
  assert.equal(n('approved', 'complete'), null, 'only a submitted order is completed');
  assert.equal(n('open', 'submit'), null, 'nothing goes to the supplier before it is approved');
  assert.equal(n('sent', 'reject'), null, 'what has gone to the supplier is not declined');
  assert.equal(n('sent', 'approve'), null);
  assert.equal(n('sent', 'submit'), null, 'submitted once');
  assert.equal(n('sent', 'reopen'), 'open', 'an office correction (supplyFlow refuses it once something arrived)');
  assert.equal(n('completed', 'submit'), null);
  assert.equal(n('rejected', 'submit'), null);
});
ok('S131: the Supply Manager submits and closes; a Deliveries holder delivers a line; the grant decides nothing else', () => {
  const r = { id: 'sr', clientId: 'A', status: 'approved' };
  const may = (decision, o) => S.maySupplyDecide({ request: r, decision, ...o });
  assert.equal(S.SUPPLY_DECISION_PERMISSION.submit, 'supplies.manage');
  assert.equal(S.SUPPLY_DECISION_PERMISSION.deliver, 'supplies.deliver');
  assert.equal(may('submit', { holdsManage: true, role: 'supply_manager' }), true);
  assert.equal(may('submit', { selfId: 'u_supA', approverId: 'u_supA', holdsApprove: true, role: 'manager' }), false, 'the approver approves; the Supply Manager submits');
  assert.equal(may('submit', { holdsDeliver: true, role: 'crew' }), false);
  assert.equal(may('deliver', { holdsDeliver: true, role: 'crew' }), true, 'Alberto, on a crew login with the grant');
  assert.equal(may('deliver', { holdsManage: true, role: 'supply_manager' }), true, 'the Supply Manager delivers too');
  for (const d of ['approve', 'reject', 'reopen', 'complete', 'backorder', 'cancelLine']) assert.equal(may(d, { holdsDeliver: true, role: 'crew' }), false, d);
  assert.ok(Array.isArray(S.SUPPLY_DECIDE_DECISIONS) && S.SUPPLY_DECIDE_DECISIONS.join() === 'approve,reject,reopen',
    'the decide call takes approve / reject / reopen; submit, the line acts and complete have their own calls');
  assert.equal(S.supplySentQuantities, undefined, 'the "how many went out" step is deleted (II.5)');
});
ok('S131: an order completed before the per-line record reads its old sent record — what went out, at completedAt', () => {
  const lines = [{ itemId: 'i1', name: 'Glass', qty: 4, unitPrice: 6.8 }, { itemId: 'i2', name: 'Liners', qty: 2, unitPrice: 32.9 }];
  const r = { status: 'completed', completedAt: '2026-10-05T12:00:00Z', lines, sentLines: [{ itemId: 'i1', qtySent: 3 }, { itemId: 'i2', qtySent: 0 }] };
  assert.deepEqual(S.supplySentLines(r).map((l) => [l.name, l.qtyRequested, l.qty]), [['Glass', 4, 3], ['Liners', 2, 0]]);
  assert.equal(S.supplyOrderDeliveredCents(r), 3 * 680);
  assert.deepEqual(S.supplyDeliveries(r).map((d) => [d.line.name, d.qty, d.at]), [['Glass', 3, '2026-10-05T12:00:00Z']]);
  assert.equal(S.supplyRequestTotal(r), 93, 'the requested money stays what was asked');
  assert.equal(S.supplyDeliveredTotal, undefined, 'replaced by the per-delivery money (II.5)');
});
ok('S131: usage and spend count each DELIVERY in its own month; an open order\'s deliveries count too', () => {
  const win = { fromMs: Date.parse('2026-10-01T04:00:00Z'), toMs: Date.parse('2026-10-31T23:59:59Z') };
  const L = (name, qty, unitPrice) => ({ itemId: `i_${name}`, name, qty, unitPrice });
  const reqs = [
    { id: 'a', clientId: 'c', status: 'completed', completedAt: '2026-10-05T12:00:00Z',
      lines: [L('Glass', 4, 6.8), L('Liners', 2, 32.9)], sentLines: [{ qtySent: 3 }, { qtySent: 0 }] },
    { id: 'b', clientId: 'c', status: 'sent', sentAt: '2026-10-06T12:00:00Z', lines: [L('Glass', 9, 6.8)],
      fulfillment: [{ deliveries: [{ qty: 2, at: '2026-10-07T12:00:00Z' }, { qty: 1, at: '2026-09-30T12:00:00Z' }], backorder: null, cancelled: null }] },
  ];
  assert.deepEqual(S.supplyUsageByItem(reqs, win).map((x) => [x.name, x.qty, x.requests, x.total]), [['Glass', 5, 2, 34]],
    'the liners never went out; the September delivery is September\'s');
  assert.equal(S.supplySpendInWindow(reqs, win), 34);
  const h = S.supplyItemHistory([{ ...reqs[0], lines: reqs[0].lines.map((l) => ({ ...l, catalogItemId: l.itemId })) }]);
  assert.equal(h.i_Glass.lastDeliveredQty, 3);
  assert.equal(h.i_Liners, undefined, 'an item sent as 0 was not delivered');
});
ok('S131: on order — waiting and approved as asked, a submitted order at what is still to come', () => {
  const reqs = [
    { status: 'approved', lines: [{ itemId: 'i1', catalogItemId: 'g', qty: 2, unitPrice: 10 }] },
    { status: 'sent', lines: [{ itemId: 'i1', catalogItemId: 'g', qty: 4, unitPrice: 10 }, { itemId: 'i2', catalogItemId: 'l', qty: 1, unitPrice: 5 }],
      fulfillment: [{ deliveries: [{ qty: 1, at: '2026-10-07T12:00:00Z' }], backorder: null, cancelled: null }, { deliveries: [], backorder: null, cancelled: { at: '2026-10-07T12:00:00Z', reason: 'Gone' } }] },
    { status: 'completed', lines: [{ itemId: 'i1', catalogItemId: 'g', qty: 50, unitPrice: 10 }] },
  ];
  assert.deepEqual(S.supplyOnOrderByItem(reqs), { g: { requested: 0, approved: 2, sent: 3 } });
  assert.equal(S.supplyOnOrderCents(reqs), 2000 + 3000);
});
ok('By building: a submitted order is an order placed, its items named', () => {
  const rows = S.supplyBuildingRows({
    clients: [{ id: 'c', name: 'Alpha', supervisorId: 'u_m' }],
    requests: [{ id: 's', clientId: 'c', status: 'sent', lines: [{ name: 'Glass', qty: 2 }], createdAt: '2026-10-01T00:00:00Z' }],
  });
  assert.equal(rows[0].state, S.SUPPLY_BUILDING_STATE.placed);
  assert.equal(rows[0].sent, 1);
  assert.deepEqual(rows[0].items, ['Glass']);
});
ok('the submit and complete patches: who and when, the per-line record kept through completion, cleared by a reopen', () => {
  const NOW = '2026-10-12T14:00:00.000Z';
  const approved = {
    id: 'sr', status: 'approved', approvedAt: '2026-10-12T09:00:00.000Z', approvedByUserId: 'u_m', approvedByName: 'Renata Cruz',
    lines: [{ itemId: 'i1', catalogItemId: 'g', qty: 4, unitPrice: 6.8 }, { itemId: 'i2', catalogItemId: 'l', qty: 2, unitPrice: 32.9 }],
  };
  const s = F.supplyDecisionPatch(approved, 'submit', { byUserId: 'u_s', byName: 'Sandra Rossi', now: NOW });
  assert.equal(s.patch.status, 'sent');
  assert.equal(s.patch.sentAt, NOW);
  assert.equal(s.patch.sentByUserId, 'u_s');
  assert.equal(s.patch.sentByName, 'Sandra Rossi');
  assert.deepEqual(s.patch.fulfillment.map((e) => [e.itemId, e.catalogItemId, e.deliveries.length]), [['i1', 'g', 0], ['i2', 'l', 0]]);
  assert.equal(s.patch.sentLines, null, 'no sent quantities are written');
  assert.equal(s.patch.sentTotalCents, null);
  assert.equal(s.patch.approvedByName, 'Renata Cruz', 'submitting keeps who approved the spend');
  const sent = { ...approved, ...s.patch };
  const acts = F.supplyFulfillPatch(sent, [{ line: 0, act: 'deliver' }, { line: 1, act: 'cancel', reason: 'Discontinued' }],
    { byUserId: 'u_drv', byName: 'Alberto Reyes', via: 'driver', now: NOW, todayKey: '2026-10-12' });
  const ready = { ...sent, ...acts.patch };
  assert.equal(ready.fulfillmentState, 'ready');
  const d = F.supplyDecisionPatch(ready, 'complete', { byUserId: 'u_s', byName: 'Sandra Rossi', now: NOW });
  assert.equal(d.patch.status, 'completed');
  assert.equal(d.patch.completedAt, NOW);
  assert.equal(d.patch.sentByName, 'Sandra Rossi', 'completing keeps who submitted it');
  assert.equal(d.patch.fulfillment[0].deliveries[0].byName, 'Alberto Reyes', '… and every line\'s record');
  assert.equal(d.patch.approvedByName, 'Renata Cruz');
  const back = F.supplyDecisionPatch(sent, 'reopen', { now: NOW });
  assert.equal(back.patch.status, 'open');
  for (const k of ['sentAt', 'sentByUserId', 'sentByName', 'sentLines', 'sentTotalCents', 'fulfillment', 'fulfillmentState']) assert.equal(back.patch[k], null, k);
});
ok('S131: an approval rings the Supply Manager and the cleaner who asked; a delivery the cleaner and the account manager — never the driver', () => {
  const s = baseState({
    users: [mkUser('u_o', 'owner'), mkUser('u_a', 'admin'), mkUser('u_m', 'manager'), mkUser('u_r', 'crew'), mkUser('u_sm', 'supply_manager'),
      { id: 'u_drv', role: 'crew', status: 'active', name: 'Alberto Reyes', notificationPrefs: {} }],
    permissions: [{ id: 'supplies.manage', roles: ['owner', 'admin', 'supply_manager'] }],
  });
  const approvedRows = F.supplyDecisionNotifications(s, { request: request({ requestedByUserId: 'u_r', status: 'approved' }), decision: 'approve', actorUserId: 'u_m' });
  assert.deepEqual(to(approvedRows, 'supplyRequestApproved'), ['u_sm'], 'the Supply Manager hears of a new approved order');
  assert.deepEqual(to(approvedRows, 'supplyOrderApproved'), ['u_r'], 'the cleaner hears theirs was approved');
  const order = request({ requestedByUserId: 'u_r', status: 'sent', fulfillment: [{ deliveries: [{ qty: 4, at: '2026-10-12T14:00:00Z', byName: 'Alberto Reyes' }], backorder: null, cancelled: null }] });
  const dRows = F.supplyFulfillNotifications(s, { request: order, applied: [{ line: 0, act: 'deliver', qty: 4 }], actorUserId: 'u_drv' });
  assert.deepEqual(to(dRows, 'supplyItemsDelivered'), ['u_m', 'u_r'], 'the cleaner who asked and the building\'s account manager');
  assert.ok(!dRows.some((n) => n.userId === 'u_drv'), 'never the driver who did it');
  assert.match(renderText(dRows.find((n) => n.userId === 'u_r').title, 'en'), /Delivered to Las Olas/);
});
ok('S6 / S131: the buildings a cleaner cleans TODAY — their own cleans starting today in the org zone, none cancelled', () => {
  const jobs = [
    { id: 'j1', clientId: 'A', crewIds: ['u_c'], startAt: '2026-10-12T14:00:00Z', status: 'scheduled' },
    { id: 'j2', siteId: 's_B', crewIds: ['u_c'], startAt: '2026-10-12T20:00:00Z', status: 'scheduled' },
    { id: 'j3', clientId: 'C', crewIds: ['u_c'], startAt: '2026-10-13T14:00:00Z' },
    { id: 'j4', clientId: 'D', crewIds: ['u_other'], startAt: '2026-10-12T14:00:00Z' },
    { id: 'j5', clientId: 'E', crewIds: ['u_c'], startAt: '2026-10-12T14:00:00Z', status: 'cancelled' },
  ];
  const ids = CS.crewTodayClientIds({ jobs, sites: [{ id: 's_B', clientId: 'B' }], userId: 'u_c', todayKey: '2026-10-12', dayKeyOf: (iso) => String(iso).slice(0, 10) });
  assert.deepEqual([...ids].sort(), ['A', 'B']);
  assert.equal(CS.crewTodayClientIds({ jobs, sites: [], userId: null, todayKey: '2026-10-12', dayKeyOf: (iso) => iso.slice(0, 10) }).size, 0);
});
ok('S6 / S131: the cleaner\'s line, PER LINE (Builder C) — what came today, what is backordered, what is still on its way; names and quantities only', () => {
  const dayStartMs = Date.parse('2026-10-12T04:00:00Z');
  const reqs = [
    { id: 's1', clientId: 'A', status: 'sent', sentAt: '2026-10-12T13:00:00Z', sentByName: 'Sandra Rossi', note: 'call me',
      lines: [{ itemId: 'i1', name: 'Glass cleaner', sku: 'CL-1', qty: 4, unitPrice: 6.8 }, { itemId: 'i2', name: 'Liners', qty: 2, unitPrice: 32.9 }],
      fulfillment: [{ deliveries: [], backorder: null, cancelled: null }, { deliveries: [], backorder: null, cancelled: { at: '2026-10-12T13:30:00Z', reason: 'Gone' } }] },
    { id: 'd1', clientId: 'A', status: 'completed', completedAt: '2026-10-12T19:10:00Z', completedByName: 'Alberto Reyes',
      lines: [{ itemId: 'i3', name: 'Towels', qty: 2, unitPrice: 28.4 }], sentLines: [{ qtySent: 2 }] },
    { id: 'd0', clientId: 'A', status: 'completed', completedAt: '2026-10-12T03:00:00Z', completedByName: 'Alberto Reyes', lines: [{ itemId: 'i3', name: 'Towels', qty: 9 }] },
    { id: 's2', clientId: 'B', status: 'sent', sentAt: '2026-10-12T13:00:00Z', lines: [{ itemId: 'i1', name: 'Glass cleaner', qty: 1 }] },
    { id: 'a1', clientId: 'A', status: 'approved', lines: [{ itemId: 'i1', name: 'Glass cleaner', qty: 1 }] },
  ];
  const out = S.supplyCrewBuildings({ requests: reqs, clientIds: new Set(['A']), dayStartMs });
  assert.deepEqual(out, [{
    clientId: 'A',
    delivered: [{ name: 'Towels', qty: 2, at: '2026-10-12T19:10:00Z' }],
    backordered: [],
    onTheWay: [{ name: 'Glass cleaner', qty: 4 }],
  }]);
  assert.doesNotMatch(JSON.stringify(out), /unitPrice|price|cents|total|budget|Rossi|Reyes|note|sku/i);
  assert.deepEqual(S.supplyCrewBuildings({ requests: reqs, clientIds: new Set(), dayStartMs }), []);
});
ok('S4 / S131: the driver\'s list — every submitted order\'s lines still to come, with the building, address, number and version; no money', () => {
  const dayStartMs = Date.parse('2026-10-12T04:00:00Z');
  const buildingOf = (id) => ({ A: { name: 'Alpha Tower', address: '1 Main St' }, B: { name: 'Beta Plaza', address: '' } })[id] || null;
  const L = (name, qty, unitPrice = 5) => ({ itemId: `i_${name}`, catalogItemId: `sc_${name}`, sku: `S-${name}`, name, qty, unitPrice });
  const E = (extra = {}) => ({ deliveries: [], backorder: null, cancelled: null, ...extra });
  const reqs = [
    { id: 's_late', number: 1042, version: 3, clientId: 'B', status: 'sent', sentAt: '2026-10-12T15:00:00Z', sentByName: 'Sandra Rossi', lines: [L('Glass', 2)], fulfillment: [E()], totalCents: 1000 },
    { id: 's_early', number: 1041, version: 5, clientId: 'A', status: 'sent', sentAt: '2026-10-12T09:00:00Z', sentByName: 'Sandra Rossi',
      lines: [L('Glass', 4), L('Liners', 3)], fulfillment: [E({ deliveries: [{ qty: 1, at: '2026-10-12T10:00:00Z', byName: 'Alberto Reyes' }] }), E({ backorder: { at: '2026-10-12T09:30:00Z', eta: '2026-10-19' } })], totalCents: 3500 },
    { id: 'd_today', clientId: 'A', status: 'completed', completedAt: '2026-10-12T16:00:00Z', completedByName: 'Alberto Reyes', sentAt: '2026-10-12T08:00:00Z', sentByName: 'Sandra Rossi', lines: [L('Towels', 2)], sentLines: [{ qtySent: 2 }] },
    { id: 'd_old', clientId: 'A', status: 'completed', completedAt: '2026-10-11T16:00:00Z', lines: [L('Towels', 2)] },
    { id: 'a_appr', clientId: 'A', status: 'approved', lines: [L('Glass', 1)] },
  ];
  const out = S.supplyDeliveryList({ requests: reqs, buildingOf, dayStartMs });
  assert.deepEqual(out.toDeliver.map((r) => r.id), ['s_early', 's_late'], 'every submitted order with something to come, oldest first');
  assert.deepEqual(out.toDeliver[0], {
    id: 's_early', no: 'SO-1041', version: 5, clientId: 'A', building: { name: 'Alpha Tower', address: '1 Main St' },
    items: [
      { line: 0, name: 'Glass', sku: 'S-Glass', qty: 3, state: 'pending', eta: null },
      { line: 1, name: 'Liners', sku: 'S-Liners', qty: 3, state: 'backordered', eta: '2026-10-19' },
    ],
    itemCount: 6, sentAt: '2026-10-12T09:00:00Z', sentByName: 'Sandra Rossi',
  });
  assert.deepEqual(out.deliveredToday.map((r) => [r.id, r.deliveredAt, r.deliveredByName, r.itemCount]),
    [['d_today', '2026-10-12T16:00:00Z', 'Alberto Reyes', 2], ['s_early', '2026-10-12T10:00:00Z', 'Alberto Reyes', 1]]);
  assert.doesNotMatch(JSON.stringify(out), /unitPrice|price|cents|total|budget/i);
});

console.log(`\ntest-supplies: ${pass}/${pass + fails.length} checks passed${fails.length ? '' : ' ✓'}\n`);
if (fails.length) {
  console.error(`✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
