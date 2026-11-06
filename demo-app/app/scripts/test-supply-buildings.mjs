// Supplies "By building" (the manager view redesign, Wave B, 2026-10-09; Matt's boards
// mobile-08 / web-08, built on SUP-14's recommended answer (a)).
//
// Matt's own supplies answer has no stock-on-hand and no delivery dates (Q5), so the board's
// Stocked / Low / Out / "arrives Oct 9" are mapped onto what the app keeps — the orders and the
// monthly budget — by ONE pure rule, lib/supplies supplyBuildingRows, which the route
// (GET /api/supplies/buildings), the demo stub and the page all run:
//   • Needs attention — over this month's budget (SUP-7's own rule: delivered spend strictly above
//     the budget, isOverSupplyBudget);
//   • Pending approval — an order waiting for approval (S131 Wave 2: its own state, Matt's 4th tile);
//   • Order placed — approved, with the Supply Manager or the supplier;
//   • All set — nothing in flight, within budget or no budget.
// The louder state wins, in that order.
// S131 Wave 2 (the AM Hub's board 8, brief A): each row carries its in-flight ORDERS — the number,
// the account manager's words (supplyOrderAmKeys), each line's short state from the per-line record,
// who asked and when — built field by field (no money); the "Awaiting your approval" cards are the
// waiting orders THIS viewer may decide (supplyAwaitingApproval over maySupplyDecide, the one rule);
// the only date a row carries is a backordered line's supplier ETA, the one the Supply Manager typed.
// What this pins: the four states at every edge, the items by name, who it waits on, which
// customers count as buildings, the order and the counts, the orders and the cards, and the wiring
// (the route branch, the stub, the adapter, the page's tab and its states). The route itself is
// driven end to end in test-supplies-route.mjs §12 and §28.
//
// Every function is read off the module at run time, so on a tree without them each check FAILS
// with a count instead of the file dying on a missing export.
//
//   node app/scripts/test-supply-buildings.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../src/lib/supplies.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const fails = [];
// ok(label, fn): fn returns truthy to pass; a throw is a fail carrying its message.
const ok = (label, fn, detail = () => '') => {
  let good = false;
  let why = '';
  try { good = !!fn(); } catch (e) { why = e.message; }
  if (good) pass += 1;
  else {
    let d = '';
    try { d = why ? '' : detail(); } catch { d = ''; }
    fails.push(`${label}${why ? `\n      threw: ${why}` : ''}${d ? `\n      ${d}` : ''}`);
  }
};
const need = (name) => { if (typeof S[name] !== 'function') throw new Error(`lib/supplies.js has no ${name}()`); return S[name]; };

const REQ = S.SUPPLY_STATUS.requested;
const APPR = S.SUPPLY_STATUS.approved;
const req = (id, clientId, status, lines, createdAt = '2026-10-0' + ((id.length % 8) + 1) + 'T12:00:00.000Z') => ({
  id, clientId, status, createdAt, lines: lines.map(([name, qty, unitPrice = 5]) => ({ itemId: `i_${name}`, name, qty, unitPrice })),
});
const CLIENTS = [
  { id: 'c_wait', name: 'Deerfield Logistics Park', supervisorId: 'u_dana' },
  { id: 'c_over', name: 'Coral Ridge', supervisorId: 'u_dana', supplyBudgetMonthly: 100 },
  { id: 'c_edge', name: 'Edge Plaza', supervisorId: 'u_dana', supplyBudgetMonthly: 100 },
  { id: 'c_placed', name: 'Oakridge Medical Plaza', supervisorId: 'u_luis' },
  { id: 'c_both', name: 'Bayside Tower', supervisorId: 'u_luis' },
  { id: 'c_set', name: 'Huizenga Park', supervisorId: 'u_dana', supplyBudgetMonthly: 400 },
  { id: 'c_nomgr', name: 'Gamma Court', supervisorId: null },                      // no manager, but a request
  { id: 'c_lead', name: 'Aventura Dental', supervisorId: null },                   // a prospect: no manager, nothing
  { id: 'c_vendor', name: 'Paper Supply Co', type: 'vendor', supervisorId: 'u_dana' },
  { id: 'c_gone', name: 'Old Building', supervisorId: 'u_dana', statusOverride: 'inactive' },
];
const REQUESTS = [
  req('r1', 'c_wait', REQ, [['Floor cleaner', 2]], '2026-10-02T10:00:00.000Z'),
  req('r2', 'c_placed', APPR, [['Paper towels', 4], ['trash liners', 2]], '2026-10-03T10:00:00.000Z'),
  req('r3', 'c_both', APPR, [['Glass cleaner', 1]], '2026-10-01T10:00:00.000Z'),
  req('r4', 'c_both', REQ, [['Paper towels', 1], ['glass cleaner', 2]], '2026-10-04T10:00:00.000Z'),
  req('r5', 'c_nomgr', REQ, [['Bulbs', 3]]),
  req('r6', 'c_set', S.SUPPLY_STATUS.completed, [['Soap', 9]]),   // delivered: not in flight
  req('r7', 'c_set', S.SUPPLY_STATUS.rejected, [['Soap', 9]]),    // rejected: not in flight
];
const SPEND = { c_over: 10001, c_edge: 10000, c_set: 5000 };      // cents this month
const APPROVERS = { c_wait: { id: 'u_dana', name: 'Dana Kim' }, c_both: { id: 'u_luis', name: 'Luis Ferrer' } };
const rows = () => need('supplyBuildingRows')({ clients: CLIENTS, requests: REQUESTS, spendCents: SPEND, approverOf: (id) => APPROVERS[id] || null });
const byId = () => new Map(rows().map((r) => [r.clientId, r]));
const ST = () => S.SUPPLY_BUILDING_STATE || {};

// S131 Wave 2: one building's in-flight ORDERS as the per-line record keeps them (Matt's board 8:
// "#SO-1047 · With Supply Manager · Partially fulfilled — Paper towels delivered · Trash liners
// backordered (ETA Oct 21)"), plus one waiting for approval and one approved.
const ETA_TYPED = '2026-10-21';
const DLV = (qty, at) => ({ qty, at, byUserId: 'u_sm', byName: 'Wes Carter', via: 'office' });
const LINES_PARTIAL = [
  { itemId: 'i_t', catalogItemId: 'sc_t', sku: 'PT-1', name: 'Paper towels', qty: 3, unitPrice: 18.5 },
  { itemId: 'i_l', catalogItemId: 'sc_l', sku: 'TL-2', name: 'Trash liners', qty: 2, unitPrice: 24 },
  { itemId: 'i_s', catalogItemId: 'sc_s', sku: 'HS-3', name: 'Hand soap', qty: 4, unitPrice: 6.75 },
  { itemId: 'i_g', catalogItemId: 'sc_g', sku: 'GC-4', name: 'Glass cleaner', qty: 2, unitPrice: 5.4 },
];
const ORDER_REQUESTS = [
  {
    id: 'o_partial', number: 1047, clientId: 'b_bay', status: 'sent', createdAt: '2026-10-13T22:45:00.000Z',
    requestedByUserId: 'u_carlos', requestedByName: 'Carlos Mendez', note: 'Restrooms are out.', lines: LINES_PARTIAL,
    approvedAt: '2026-10-13T23:10:00.000Z', sentAt: '2026-10-14T14:05:00.000Z',
    fulfillment: [
      { itemId: 'i_t', catalogItemId: 'sc_t', deliveries: [DLV(3, '2026-10-15T13:15:00.000Z')], backorder: null, cancelled: null },
      { itemId: 'i_l', catalogItemId: 'sc_l', deliveries: [], backorder: { at: '2026-10-15T13:20:00.000Z', byUserId: 'u_sm', byName: 'Wes Carter', eta: ETA_TYPED }, cancelled: null },
      { itemId: 'i_s', catalogItemId: 'sc_s', deliveries: [DLV(1, '2026-10-15T13:15:00.000Z')], backorder: null, cancelled: null },
      { itemId: 'i_g', catalogItemId: 'sc_g', deliveries: [], backorder: null, cancelled: { at: '2026-10-15T13:30:00.000Z', byUserId: 'u_sm', byName: 'Wes Carter', reason: 'Discontinued' } },
    ],
    fulfillmentState: 'partial',
  },
  {
    id: 'o_wait', number: 1049, clientId: 'b_bay', status: REQ, createdAt: '2026-10-14T19:15:00.000Z',
    requestedByUserId: 'u_maria', requestedByName: 'Maria Santos', note: 'Lobby is out of cloths.',
    lines: [{ itemId: 'i_a', name: 'All-purpose cleaner', qty: 2, unitPrice: 5 }, { itemId: 'i_m', name: 'Microfiber cloths', qty: 6, unitPrice: 1.25 }],
  },
  {
    id: 'o_appr', number: 1048, clientId: 'b_bay', status: APPR, createdAt: '2026-10-12T10:00:00.000Z',
    requestedByUserId: 'u_carlos', requestedByName: 'Carlos Mendez', note: 'Monthly restock.', approvedAt: '2026-10-12T11:00:00.000Z',
    lines: [{ itemId: 'i_g', name: 'Glass cleaner', qty: 4, unitPrice: 5.4 }],
  },
];
const orderRows = () => need('supplyBuildingRows')({
  clients: [{ id: 'b_bay', name: 'Bayside Tower, Suite 400', supervisorId: 'u_dana' }],
  requests: ORDER_REQUESTS, spendCents: {}, approverOf: () => ({ id: 'u_dana', name: 'Dana Kim' }),
});
const ordersOf = () => (orderRows()[0] || {}).orders || [];

// ═══ A. the four states ═══════════════════════════════════════════════════════════
ok('A0 the four states are named once (SUPPLY_BUILDING_STATE: S131 Wave 2 adds Pending approval)', () => ST().attention && ST().pending && ST().placed && ST().allSet
  && JSON.stringify(Object.keys(ST())) === JSON.stringify(['attention', 'pending', 'placed', 'allSet']));
ok('A1 an order waiting for approval → Pending approval (its own state now, Matt\'s 4th tile)', () => byId().get('c_wait').state === ST().pending);
ok('A2 approved and waiting for the office → Order placed', () => byId().get('c_placed').state === ST().placed);
ok('A3 waiting AND approved → Pending approval (the louder one)', () => byId().get('c_both').state === ST().pending);
ok('A4 over this month\'s budget with nothing in flight → Needs attention', () => byId().get('c_over').state === ST().attention && byId().get('c_over').over === true);
ok('A10 over budget AND an order waiting → Needs attention (the louder one), the order still counted as waiting', () => {
  const one = need('supplyBuildingRows')({
    clients: [{ id: 'x', name: 'X', supervisorId: 'u', supplyBudgetMonthly: 10 }],
    requests: [req('rx', 'x', REQ, [['Soap', 1]])], spendCents: { x: 1001 },
  });
  return one.length === 1 && one[0].state === ST().attention && one[0].waiting === 1 && one[0].over === true;
}, () => JSON.stringify(need('supplyBuildingRows')({ clients: [{ id: 'x', name: 'X', supervisorId: 'u', supplyBudgetMonthly: 10 }], requests: [req('rx', 'x', REQ, [['Soap', 1]])], spendCents: { x: 1001 } })));
ok('A5 landing exactly ON the budget is not over (SUP-7: strictly above)', () => byId().get('c_edge').state === ST().allSet && byId().get('c_edge').over === false);
ok('A6 delivered and rejected requests are not in flight: within budget → All set', () => byId().get('c_set').state === ST().allSet);
ok('A7 "over" is isOverSupplyBudget on the delivered spend (one rule with the Clients badge)', () => {
  const r = byId().get('c_over');
  return r.over === S.isOverSupplyBudget(SPEND.c_over / 100, S.supplyBudgetFor(CLIENTS[1])) && r.spend === 100.01 && r.budget === 100;
});
// The delivery step (plan 2026-10-12 §2): a request the office SENT is still an order placed until
// the driver marks it delivered — counted apart, so the row can say "On the way".
ok('A9 sent and not yet delivered → Order placed, its items named, counted apart from the approved', () => {
  const one = need('supplyBuildingRows')({
    clients: [{ id: 's', name: 'S', supervisorId: 'u' }],
    requests: [req('rs', 's', S.SUPPLY_STATUS.sent || 'sent', [['Glass cleaner', 3]], '2026-10-05T10:00:00.000Z')],
    spendCents: {},
  });
  return one.length === 1 && one[0].state === ST().placed && one[0].sent === 1 && one[0].placed === 0
    && JSON.stringify(one[0].items) === JSON.stringify(['Glass cleaner']);
}, () => JSON.stringify(need('supplyBuildingRows')({ clients: [{ id: 's', name: 'S', supervisorId: 'u' }], requests: [req('rs', 's', 'sent', [['Glass cleaner', 3]])], spendCents: {} })));
ok('A8 no budget → never over, whatever was spent', () => {
  const one = need('supplyBuildingRows')({ clients: [{ id: 'x', name: 'X', supervisorId: 'u' }], requests: [], spendCents: { x: 999999 } });
  return one[0].state === ST().allSet && one[0].over === false && one[0].budget === null;
});

// ═══ B. what the row says ═════════════════════════════════════════════════════════
ok('B1 the items of the open requests, by name, each once (case-insensitive), waiting first', () => {
  const both = byId().get('c_both').items;
  return JSON.stringify(both) === JSON.stringify(['Paper towels', 'glass cleaner']);
}, () => JSON.stringify(byId().get('c_both').items));
ok('B2 an order placed names its items', () => JSON.stringify(byId().get('c_placed').items) === JSON.stringify(['Paper towels', 'trash liners']));
ok('B3 an all-set building names none', () => byId().get('c_set').items.length === 0);
ok('B4 how many wait for approval and how many wait for the office', () => {
  const b = byId().get('c_both');
  return b.waiting === 1 && b.placed === 1 && byId().get('c_placed').waiting === 0 && byId().get('c_placed').placed === 1;
});
ok('B5 the approver it waits on is resolveSupplyApprover\'s (passed in), named', () => {
  const w = byId().get('c_wait');
  return w.approverId === 'u_dana' && w.approverName === 'Dana Kim';
});
ok('B6 nobody to approve → no name (the screen says "No approver set")', () => byId().get('c_nomgr').approverId === null && byId().get('c_nomgr').state === ST().pending);
ok('B7 no approver is looked up for a building with nothing waiting', () => byId().get('c_placed').approverId === null);
// B8 (re-worded for S131 Wave 2: the supplier's ETA is shown now). The app keeps no delivery date of
// its own and never invents one: a row carries none, and the ONLY date on it is a backordered line's
// ETA — exactly the one the Supply Manager typed into the per-line record, and on no other line.
ok('B8 no delivery date is invented: a row carries none of its own; the only date on it is a backordered line\'s ETA, the one the Supply Manager typed', () => {
  const all = [...rows(), ...orderRows()];
  const own = all.every((r) => !('arrivesAt' in r) && !('deliveryDate' in r) && !('eta' in r));
  const typed = new Map(ORDER_REQUESTS.map((o) => [o.id, (o.fulfillment || []).map((e) => (e && e.backorder ? e.backorder.eta : null))]));
  const lines = all.flatMap((r) => (r.orders || []).flatMap((o) => (o.lines || []).map((l, i) => ({ o, l, i }))));
  return own && lines.length > 0 && lines.every(({ o, l, i }) => (l.eta === null
    ? true : l.state === S.SUPPLY_LINE_STATE.backordered && l.eta === (typed.get(o.id) || [])[i]))
    && lines.some(({ l }) => l.eta === ETA_TYPED);
}, () => JSON.stringify(orderRows().map((r) => r.orders)));

// ═══ C. which customers are buildings ═════════════════════════════════════════════
ok('C1 a vendor is not a building', () => !byId().has('c_vendor'));
ok('C2 a customer marked inactive is not a building', () => !byId().has('c_gone'));
ok('C3 a prospect with no manager, no budget and nothing ordered is not a building', () => !byId().has('c_lead'));
ok('C4 a customer with no manager but a request in flight IS one (nothing waits unseen)', () => byId().has('c_nomgr'));
ok('C5 isSupplyBuilding is the one rule', () => {
  const f = need('isSupplyBuilding');
  return f(CLIENTS[0]) && !f(CLIENTS[8]) && !f(CLIENTS[9]) && !f(CLIENTS[7]) && f(CLIENTS[7], { hasOpen: true }) && f({ id: 'b', supplyBudgetMonthly: 50 });
});

// ═══ D. order and counts ══════════════════════════════════════════════════════════
ok('D1 Needs attention first, then Pending approval, then Order placed, then All set; by name inside each', () => rows().map((r) => r.clientId).join() === 'c_over,c_both,c_wait,c_nomgr,c_placed,c_edge,c_set',
  () => rows().map((r) => `${r.state}:${r.name}`).join(' | '));
ok('D2 counts: 1 needs attention, 3 pending approval, 1 order placed, 2 all set, 7 buildings — and 4 NEED ATTENTION in the header\'s sense (pending approvals inside it, the Home\'s figure)', () => {
  const c = need('supplyBuildingCounts')(rows());
  return c.attention === 1 && c.pending === 3 && c.placed === 1 && c.allSet === 2 && c.total === 7 && c.needAttention === 4;
}, () => JSON.stringify(need('supplyBuildingCounts')(rows())));
ok('D3 nothing at all → no rows, zero counts', () => {
  const c = need('supplyBuildingCounts')(need('supplyBuildingRows')({ clients: [], requests: [], spendCents: {} }));
  return c.total === 0 && c.attention === 0 && c.pending === 0 && c.needAttention === 0;
});
ok('D4 a request for a building outside the clients given is ignored (scope is the caller\'s)', () => {
  const r = need('supplyBuildingRows')({ clients: [CLIENTS[3]], requests: REQUESTS, spendCents: {} });
  return r.length === 1 && r[0].clientId === 'c_placed';
});

// ═══ F. S131 Wave 2: each row's ORDERS, and the "Awaiting your approval" cards ═══════════════
const AM = () => (S.SUPPLY_ORDER_LABEL_KEYS || {}).am || {};
ok('F1 a row carries its in-flight orders: waiting first, then approved, then with the supplier (oldest first in each)', () => JSON.stringify(ordersOf().map((o) => o.id)) === JSON.stringify(['o_wait', 'o_appr', 'o_partial']),
  () => JSON.stringify(ordersOf().map((o) => o.id)));
ok('F2 each order is built FIELD BY FIELD (SUPPLY_BUILDING_ORDER_KEYS), each line too (SUPPLY_BUILDING_LINE_KEYS) — never a spread order', () => {
  const OK = S.SUPPLY_BUILDING_ORDER_KEYS;
  const LK = S.SUPPLY_BUILDING_LINE_KEYS;
  return Array.isArray(OK) && Array.isArray(LK) && ordersOf().length === 3
    && ordersOf().every((o) => JSON.stringify(Object.keys(o)) === JSON.stringify(OK) && o.lines.every((l) => JSON.stringify(Object.keys(l)) === JSON.stringify(LK)));
}, () => JSON.stringify(ordersOf()[2]));
ok('F3 no money in an order: no price, cents, total, budget or spend', () => ordersOf().length === 3 && !/unitPrice|price|cents|total|budget|spend/i.test(JSON.stringify(ordersOf())));
ok('F4 a submitted order\'s lines carry their state from the per-line record: delivered · backordered with the Supply Manager\'s ETA · partly delivered · cancelled', () => {
  const o = ordersOf().find((x) => x.id === 'o_partial');
  const LS = S.SUPPLY_LINE_STATE;
  return !!o && JSON.stringify(o.lines) === JSON.stringify([
    { name: 'Paper towels', qty: 3, state: LS.delivered, delivered: 3, eta: null },
    { name: 'Trash liners', qty: 2, state: LS.backordered, delivered: 0, eta: ETA_TYPED },
    { name: 'Hand soap', qty: 4, state: LS.pending, delivered: 1, eta: null },
    { name: 'Glass cleaner', qty: 2, state: LS.cancelled, delivered: 0, eta: null },
  ]) && o.number === 1047 && o.no === 'SO-1047' && o.phase === 'partial';
}, () => JSON.stringify(ordersOf().find((x) => x.id === 'o_partial')));
ok('F5 an order not yet with the supplier names its lines and quantities, with no state (nothing to fulfil yet)', () => {
  const o = ordersOf().find((x) => x.id === 'o_wait');
  return !!o && JSON.stringify(o.lines) === JSON.stringify([
    { name: 'All-purpose cleaner', qty: 2, state: null, delivered: 0, eta: null },
    { name: 'Microfiber cloths', qty: 6, state: null, delivered: 0, eta: null },
  ]) && o.phase === 'open' && o.status === REQ;
});
ok('F6 the account manager\'s words per order come from the ONE map (supplyOrderAmKeys over SUPPLY_ORDER_LABEL_KEYS.am)', () => {
  const by = new Map(ordersOf().map((o) => [o.id, o.labelKeys]));
  return JSON.stringify(by.get('o_wait')) === JSON.stringify([AM().open])
    && JSON.stringify(by.get('o_appr')) === JSON.stringify([AM().approved])
    && JSON.stringify(by.get('o_partial')) === JSON.stringify([AM().approved, AM().partial]);
}, () => JSON.stringify(ordersOf().map((o) => [o.id, o.labelKeys])));
ok('F7 supplyOrderAmKeys: "With Supply Manager" goes before a word that says how far but not whose move (partial, all delivered) — never twice, never before "With supplier"', () => {
  const f = need('supplyOrderAmKeys');
  const at = (extra) => ({ id: 'x', status: 'sent', lines: [{ name: 'A', qty: 2 }, { name: 'B', qty: 1 }], ...extra });
  const e = (i, extra = {}) => ({ itemId: `i${i}`, catalogItemId: null, deliveries: [], backorder: null, cancelled: null, ...extra });
  const D = (qty) => [{ qty, at: '2026-10-15T13:00:00.000Z' }];
  return JSON.stringify(f(at({ status: REQ }))) === JSON.stringify([AM().open])
    && JSON.stringify(f(at({ status: APPR }))) === JSON.stringify([AM().approved])
    && JSON.stringify(f(at({ fulfillment: [e(0), e(1)] }))) === JSON.stringify([AM().supplier])
    && JSON.stringify(f(at({ fulfillment: [e(0, { deliveries: D(1) }), e(1)] }))) === JSON.stringify([AM().approved, AM().partial])
    && JSON.stringify(f(at({ fulfillment: [e(0, { deliveries: D(2) }), e(1, { deliveries: D(1) })] }))) === JSON.stringify([AM().approved, AM().ready]);
});
ok('F8 who asked and when ride with every order; the asker\'s NOTE only with one waiting for approval (what the approver reads)', () => {
  const by = new Map(ordersOf().map((o) => [o.id, o]));
  return by.get('o_wait')?.requestedByName === 'Maria Santos' && by.get('o_wait')?.requestedByUserId === 'u_maria'
    && by.get('o_wait')?.createdAt === '2026-10-14T19:15:00.000Z' && by.get('o_wait')?.note === 'Lobby is out of cloths.'
    && by.get('o_appr')?.note === null && by.get('o_partial')?.note === null && by.get('o_partial')?.requestedByName === 'Carlos Mendez';
});
ok('F9 an all-set building carries no orders; a settled order is never one of them', () => byId().get('c_set')?.orders?.length === 0
  && byId().get('c_both')?.orders?.map((o) => o.id).join() === 'r4,r3');
// The cards: every WAITING order in the rows this viewer may decide — maySupplyDecide, the one rule
// the route and the queue's bulk bar read — oldest first, each with its building.
{
  const T_CLIENTS = [
    { id: 'b_a', name: 'Alpha Tower', supervisorId: 'u_dana' },
    { id: 'b_b', name: 'Beta Plaza', supervisorId: 'u_luis' },
  ];
  const T_REQ = [
    req('wa2', 'b_a', REQ, [['Soap', 1]], '2026-10-14T12:00:00.000Z'),
    req('wa1', 'b_a', REQ, [['Towels', 2]], '2026-10-13T12:00:00.000Z'),
    req('wb1', 'b_b', REQ, [['Liners', 3]], '2026-10-13T18:00:00.000Z'),
    req('oa', 'b_a', APPR, [['Glass', 1]], '2026-10-12T12:00:00.000Z'),
  ];
  const approver = { b_a: { id: 'u_dana', name: 'Dana Kim' }, b_b: { id: 'u_luis', name: 'Luis Ferrer' } };
  const USERS = [
    { id: 'u_dana', role: 'manager', status: 'active', opsManagerId: 'u_ops' },
    { id: 'u_luis', role: 'manager', status: 'active' },
    { id: 'u_ops', role: 'manager', status: 'active', managerLevel: 'operations' },
  ];
  const tRows = () => need('supplyBuildingRows')({ clients: T_CLIENTS, requests: T_REQ, spendCents: {}, approverOf: (id) => approver[id] || null });
  // The caller's rule, exactly as the screen builds it (hooks/useSupplyRules).
  const viewer = (o) => (order) => {
    const approverId = approver[order.clientId]?.id || null;
    return S.maySupplyDecide({
      request: order, decision: 'approve', selfId: o.id, role: o.role, approverId,
      approverOpsManagerId: S.supplyApproverOpsManagerId(USERS, approverId), holdsApprove: !!o.approve, holdsManage: !!o.manage,
    });
  };
  const cards = (o) => need('supplyAwaitingApproval')(tRows(), viewer(o)).map((c) => c.id).join();
  ok('F10 🔴 the cards are only the waiting orders this viewer may DECIDE: the account manager gets their building\'s, oldest first', () => cards({ id: 'u_dana', role: 'manager', approve: true }) === 'wa1,wa2',
    () => cards({ id: 'u_dana', role: 'manager', approve: true }));
  ok('F11 🔴 the Supply Manager (supplies.manage, no supplies.approve) gets NONE — only approved orders reach them', () => cards({ id: 'u_sm', role: 'supply_manager', manage: true }) === '');
  ok('F12 the account manager\'s operations manager gets their team\'s; another AM\'s building is not theirs', () => cards({ id: 'u_ops', role: 'manager', approve: true }) === 'wa1,wa2'
    && cards({ id: 'u_luis', role: 'manager', approve: true }) === 'wb1');
  ok('F13 the owner (holding supplies.approve) gets every waiting order, oldest first across buildings; without the key, none', () => cards({ id: 'u_o', role: 'owner', approve: true }) === 'wa1,wb1,wa2'
    && cards({ id: 'u_o', role: 'owner' }) === '');
  ok('F14 each card carries its building (id and name) and the order\'s own fields; an approved order is never a card', () => {
    const c = need('supplyAwaitingApproval')(tRows(), viewer({ id: 'u_o', role: 'owner', approve: true }));
    return c.length === 3 && c.every((x) => x.status === REQ && typeof x.buildingName === 'string' && x.clientId)
      && c[0].buildingName === 'Alpha Tower' && c[1].buildingName === 'Beta Plaza' && !c.some((x) => x.id === 'oa');
  });
}

// ═══ E. wired end to end ══════════════════════════════════════════════════════════
{
  const route = read('api/supplies/[...path].js');
  const store = read('api/_lib/supplies/store.js');
  const adapter = read('src/lib/suppliesApi.js');
  const page = read('src/pages/Supplies.jsx');
  const en = read('src/i18n/catalog/en.js');
  const matrix = read('../docs/playbook/ENDPOINT_AUTHZ_MATRIX.md');
  const sweep = read('scripts/responsive-sweep.mjs');
  // (S131: the route names each door by its exact segments — `door('buildings')`.)
  ok('E1 the route answers GET buildings behind the supplies.view door, with the one rule', () => /door\('buildings'\)/.test(route) && /supplyBuildingRows\(/.test(route)
    && route.indexOf("requirePermission(req, res, 'supplies.view')") < route.indexOf("door('buildings')"));
  ok('E2 its two reads are COMPLETE: every in-flight request + the month\'s delivered spend', () => /export async function inFlightRequests/.test(store) && /allRows\(T_REQUESTS/.test(store.slice(store.indexOf('export async function inFlightRequests')))
    && /inFlightRequests\(\)/.test(route) && /deliveredCentsByClient\(/.test(route.slice(route.indexOf("door('buildings')"))));
  ok('E3 the demo stub runs the same rule', () => /supplyBuildingRows\(/.test(adapter) && /export async function buildings\(/.test(adapter));
  ok('E4 the page has a By building tab (?tab=buildings) on the adapter\'s read', () => /key: 'buildings'/.test(page) && /suppliesApi\.buildings\(/.test(page));
  ok('E5 Reorder opens the existing order sheet for that building, for supplies.request holders', () => /presetClientId=\{reorderFor/.test(page) && /canRequest && /.test(page.slice(page.indexOf('function BuildingsView'))));
  ok('E6 the four tiles (All set · Order placed · Needs attention · Pending approval) and the phone\'s "all set" line are catalog words the page names', () => ['supplyPage.bld.state.attention', 'supplyPage.bld.state.pending', 'supplyPage.bld.state.placed', 'supplyPage.bld.state.allSet', 'supplyPage.bld.allSetLine']
    .every((k) => en.includes(`'${k}':`) && page.includes(`'${k}'`)));
  // E7 (re-worded for S131 Wave 2: a backordered line now shows the supplier's ETA). Still no stock
  // word and no invented arrival: the only dates By building words are that ETA — the one the Supply
  // Manager typed, on a backordered line only — and when an order was asked for.
  ok('E7 never a stock word or an invented arrival: the only dates By building words are a backordered line\'s supplier ETA and when an order was asked for', () => {
    const lines = en.split('\n').filter((l) => l.includes("'supplyPage.bld."));
    const text = lines.join('\n');
    const dates = [...text.matchAll(/\{(\w+),\s*(date|dateTime|weekday|dateLong|time)\}/g)].map((m) => m[1]);
    return !/arrives|in stock|out of stock|stocked/i.test(text) && dates.length > 0 && dates.every((n) => n === 'eta' || n === 'when')
      && dates.includes('eta') && lines.filter((l) => /\{eta,/.test(l)).every((l) => /backordered/i.test(l));
  });
  ok('E8 loading, error with Try again, empty and offline on the tab', () => {
    const v = page.slice(page.indexOf('function BuildingsView'));
    return /common\.loading/.test(v) && /supplyPage\.bld\.loadFailed/.test(v) && /supplyPage\.tryAgain/.test(v) && /supplyPage\.bld\.empty/.test(v) && /!online/.test(v);
  });
  ok('E9 the endpoint has its row in the authorization matrix (§2.22, EP-299)', () => /\| EP-299 \| GET \/api\/supplies\/buildings \|/.test(matrix));
  ok('E10 the responsive sweep covers /supplies?tab=buildings', () => /\/supplies\?tab=buildings/.test(sweep));

  // ── S131 Wave 2 (brief A): the cards, the 4th tile, the orders, the office gate, the team ──
  const view = page.slice(page.indexOf('function BuildingsView'));
  const cardsSrc = (() => { try { return read('src/components/SupplyApprovalCards.jsx'); } catch { return ''; } })();
  const queue = read('src/components/SupplyQueue.jsx');
  const rulesHook = (() => { try { return read('src/hooks/useSupplyRules.js'); } catch { return ''; } })();
  ok('E11 🔴 the cards and the 4th tile are the waiting orders THIS viewer may decide: supplyAwaitingApproval over the ONE rule hook the queue\'s bulk bar reads too (useSupplyRules → maySupplyDecide)', () => /supplyAwaitingApproval\(/.test(view) && /useSupplyRules\(\)/.test(view)
    && /useSupplyRules\(\)/.test(queue) && /maySupplyDecide\(/.test(rulesHook) && /supplyApproverOpsManagerId\(/.test(rulesHook)
    && /<StatCard label=\{t\('supplyPage\.bld\.state\.pending'\)\} value=\{awaiting\.length\}/.test(view) && /<SupplyApprovalCards\b/.test(view));
  ok('E12 🔴 Decline asks for a reason in the kit dialog (SupplyDeclineModal), Approve is one tap — both the existing decide door through useSupplyMoves, never a call of their own', () => /<SupplyDeclineModal\b/.test(cardsSrc)
    && /moves\.run\(\[o\], 'approve'\)/.test(cardsSrc) && /moves\.run\(\[declining\], 'reject', reason\)/.test(cardsSrc)
    && /useSupplyMoves\(\{/.test(cardsSrc) && !/decideRequests\(/.test(cardsSrc + view));
  ok('E13 every order in a row opens its own page (/supplies/orders/:id) with the referrer', () => /to=\{`\/supplies\/orders\/\$\{encodeURIComponent\(o\.id\)\}`\} state=\{nav\}/.test(view));
  ok('E14 🔴 GET buildings carries order details, so it takes the queue\'s gate: an OFFICE role (route and stub)', () => {
    const door = route.slice(route.indexOf("door('buildings')"), route.indexOf('supplyBuildingRows(', route.indexOf("door('buildings')")));
    const stub = adapter.slice(adapter.indexOf('function stubBuildings'));
    return /if \(!isOfficeCaller\(g\)\) return officeOnly\(res\);/.test(door) && /officeGate\(ctx\);/.test(stub.slice(0, 400));
  });
  ok('E15 the header\'s "N need attention" is the counts\' needAttention (pending approvals inside it — the Home\'s figure)', () => /supplyPage\.bld\.needAttention', \{ count: bld\.counts\.needAttention \}/.test(page));
  ok('E16 🔴 `mgr=team` is resolved from the CALLER, never the request: the route from the claim, the stub from the viewer (lib/teamScope teamClientIds)', () => {
    const scope = route.slice(route.indexOf('function scopeIds'), route.indexOf('function termClientIdsFor'));
    const stubScope = adapter.slice(adapter.indexOf('const scopeOf'), adapter.indexOf('const countsOf'));
    // (the owner's Operations view's tiles: an owner or an admin may name whose team with `om` — the one
    // rule, lib/teamScope teamLeadFor — and a manager never widens theirs.)
    return /mgr === TEAM/.test(scope) && /teamLeadFor\(\{ role: g && g\.role, selfId: g && g\.orgUserId, users: s\.users, om \}\)/.test(scope)
      && /mgr === TEAM/.test(stubScope) && /teamClientIds\(/.test(stubScope) && /teamLeadFor\(/.test(stubScope)
      && (route.match(/scopeIds\(s, \{ mgr: qs\('mgr'\), cust: qs\('cust'\), om: qs\('om'\) \}, g\)/g) || []).length === 3;
  });
}

if (fails.length) {
  console.error(`\n✖ test-supply-buildings: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`   ✖ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-supply-buildings: ${pass} passed`);
}
