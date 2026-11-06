// Pure supplies math + request shaping, node-testable headlessly (the lib/contracts.js
// precedent: its imports are lib/dates' ZONE-FREE label arithmetic and lib/clientHub's pure
// "First L." rule). The supplies route (api/_lib/supplies/store.js), its demo stub
// (lib/suppliesApi.js), the Supplies page and the ops-alert cron all read from here, so a
// request's total, who may decide it, and how far back its history reaches are computed one way
// everywhere.
//
// MONEY: the tables store INTEGER CENTS (II.8; migration 2026100512xxxx_supplies.sql) and the
// store converts at its boundary (`supplyToCents` / `supplyFromCents`), so every screen and
// every pure function here reads the app's shape — DOLLARS on `unitPrice`, null = no price
// entered (SUP-4). A line is settled to cents PER LINE then summed (per-item rounding), which
// is the same number the cents arithmetic gives.
//
// The approval state machine (SUP-1 b / SUP-9, Matt 2026-09-29) and WHO may move it (SUP-11,
// Matt 2026-10-05) live here too, as the SINGLE source of truth: `nextSupplyStatus`,
// `maySupplyDecide` and `maySupplyCancel` are read by the server route (the boundary), by the
// demo stub and by the queue's buttons, so a move the UI offers is never one the server refuses.
//
// 🔴 SUPPLY ORDERS (S131, 2026-10-14; plan docs/plans/2026-10-14-supply-orders.md, Matt's email and
// boards): a request is an ORDER with a number (SO-1001 on, `supplyOrderNo`). The building's account
// manager approves it (or their operations manager, the owner or an admin); the Supply Manager
// SUBMITS it to the supplier (the stored `sent`, which no longer records quantities); then each LINE
// is delivered — in parts or whole, by the Supply Manager or the driver — backordered with a supplier
// ETA, or cancelled with a reason, in the per-line record `fulfillment`; the order is marked
// COMPLETED only once every line is delivered or cancelled (`supplyOrderProgress`). Usage and spend
// count each DELIVERY in the month it happened. The cleaners' line and the driver's list are shaped
// here too (supplyCrewBuildings / supplyDeliveryList), with no money in either.
//
// Explicit .js on the imports — the serverless routes and the node suites load this file.
import { addDaysKey, addMonthsKey, diffDaysKey } from './dates.js';
import { hubPersonName } from './clientHub.js';
import { isActiveBuilding, CUSTOMER_STATUS } from './customerStatus.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── The request lifecycle (SUP-1 b + SUP-9) ───────────────────────────────────
// 🔴 `requested` IS THE STRING 'open'. The queue shipped with 'open' | 'completed'
// (S58), and renaming the value would TRANSFORM every committed request — a store
// version bump and a migration for nothing. 'open' already means exactly "submitted,
// not yet dealt with", which after SUP-1 is "waiting for the approver", so a request
// committed before this change reads correctly with no migration. Only the LABEL is new.
// 🔴 `sent` IS THE STORED "SUBMITTED TO SUPPLIER" STATE since the supply orders (S131) and
// `completed` the order closed once every line is resolved: neither value changed, so no row is
// transformed; their WORDS come from supplyOrderLabelKey below, per reader.
export const SUPPLY_STATUS = {
  requested: 'open',
  approved: 'approved',
  sent: 'sent',
  rejected: 'rejected',
  completed: 'completed',
};
// Every value a request's `status` may hold — the migration's check holds exactly these
// (20261012100000_supply_delivery_step.sql). A row with no status at all reads as requested
// (supplyStatusOf), never as an unknown state that no filter shows.
export const SUPPLY_STATUSES = [
  SUPPLY_STATUS.requested, SUPPLY_STATUS.approved, SUPPLY_STATUS.sent, SUPPLY_STATUS.rejected, SUPPLY_STATUS.completed,
];
export function supplyStatusOf(request) {
  const s = request && request.status;
  return SUPPLY_STATUSES.includes(s) ? s : SUPPLY_STATUS.requested;
}

// The decisions a caller may ask for, and the PERMISSION each one starts from. The route's door
// check reads it; WHO among those holders may actually make it on a given order is
// `maySupplyDecide` below (SUP-11, S131).
//   approve / reject   <- supplies.approve  (the building's account manager, their operations
//                                            manager, or the owner / an admin stepping in)
//   submit             <- supplies.manage   ("Submitted to supplier", the Supply Manager)
//   deliver            <- supplies.deliver  (one line delivered — the driver; the Supply Manager too)
//   backorder          <- supplies.manage   (a line on backorder, with the supplier's ETA)
//   cancelLine         <- supplies.manage   (a discontinued line, with a reason — Daniel's answer 4)
//   complete           <- supplies.manage   (Mark Completed, once every line is delivered or cancelled)
//   reopen             <- supplies.manage   (an office correction, back to waiting-for-approval)
export const SUPPLY_DECISION_PERMISSION = {
  approve: 'supplies.approve',
  reject: 'supplies.approve',
  submit: 'supplies.manage',
  deliver: 'supplies.deliver',
  backorder: 'supplies.manage',
  cancelLine: 'supplies.manage',
  complete: 'supplies.manage',
  reopen: 'supplies.manage',
};
export const SUPPLY_DECISIONS = ['approve', 'reject', 'submit', 'deliver', 'backorder', 'cancelLine', 'complete', 'reopen'];
// The moves POST /api/supplies/requests/decide takes. Submitting, the per-line acts and Mark
// Completed have their own doors (orders/submit, orders/fulfill, orders/complete, and the driver's
// requests/deliver) — and the decide door, approve OR manage, never admits the driver to anything.
export const SUPPLY_DECIDE_DECISIONS = ['approve', 'reject', 'reopen'];

// 🔴 "THE OFFICE" for a CANCEL (CS-596): the Super Admin (the recoverable top tier) and whoever holds
// `supplies.manage`. Since the supply orders (S131) it no longer decides an approval — that is the
// building's approver chain below, never `supplies.manage` alone — and since S131 Wave 2 it cancels
// only an APPROVED order (a waiting one is cancelled by whoever may decide it, maySupplyCancel).
export function isSupplyOffice({ role = null, holdsManage = false } = {}) {
  return role === 'owner' || !!holdsManage;
}

// 🔴 WHO MAY MOVE AN ORDER (SUP-11, Matt 2026-10-05; S131, plan §1 step 2 and Daniel's answer 3):
//   approve / reject — a `supplies.approve` holder who IS the building's resolved approver
//                      (`approverId`, lib/notifications resolveSupplyApprover: the building's account
//                      manager, else the one person named in Settings → Operations), or THAT
//                      approver's operations manager (`approverOpsManagerId`,
//                      supplyApproverOpsManagerId below), or the owner / an admin stepping in —
//                      each holding `supplies.approve`. NEVER on `supplies.manage` alone, so the
//                      Supply Manager is refused (Matt: only approved orders reach them).
//   submit · backorder · cancelLine · complete · reopen — `supplies.manage` (the Supply Manager).
//   deliver — `supplies.manage` or `supplies.deliver` (the driver, on any login, by a grant).
// The STATE MACHINE is a separate question (nextSupplyStatus and the patches in lib/supplyFlow);
// this answers only who. Takes only primitives (no state): the route, the stub and the screens
// all call it, so a button is never offered that the server refuses.
export function maySupplyDecide({
  request, decision = 'approve', selfId = null, role = null, approverId = null, approverOpsManagerId = null,
  holdsApprove = false, holdsManage = false, holdsDeliver = false,
} = {}) {
  if (!request || !SUPPLY_DECISIONS.includes(decision)) return false;
  if (decision === 'approve' || decision === 'reject') {
    if (!holdsApprove) return false;
    if (role === 'owner' || role === 'admin') return true;
    if (!selfId) return false;
    return (!!approverId && approverId === selfId) || (!!approverOpsManagerId && approverOpsManagerId === selfId);
  }
  if (decision === 'deliver') return !!(holdsManage || holdsDeliver);
  return !!holdsManage;
}

// The approver's OPERATIONS MANAGER (S131, the contract with Builder R: `users[].opsManagerId`), or
// null — valid only while that person is active and a manager. Pure: the route, the stub and the
// screens hand it the roster.
export function supplyApproverOpsManagerId(users, approverId) {
  if (!approverId) return null;
  const list = Array.isArray(users) ? users : [];
  const approver = list.find((u) => u && u.id === approverId);
  const omId = approver && typeof approver.opsManagerId === 'string' ? approver.opsManagerId : null;
  if (!omId || omId === approverId) return null;
  const om = list.find((u) => u && u.id === omId);
  return om && om.status === 'active' && om.role === 'manager' ? om.id : null;
}

// 🔴 WHEN A REQUEST MAY BE CANCELLED (CS-670, Daniel 2026-10-12: no cancels once an order has gone
// out). Only while it is REQUESTED or APPROVED. Once SENT it is on the van and the cleaners see it
// coming; DELIVERED it is usage, spend and the budget's history; REJECTED it is a settled record.
// Cancelling DELETES the request, so none of those may be — the correction for what went out is the
// office's Reopen, which keeps the row and is recorded (supply_request.status_changed). The route,
// the demo stub and the Cancel buttons all read this one list (through maySupplyCancel below).
export const SUPPLY_CANCELLABLE_STATUSES = [SUPPLY_STATUS.requested, SUPPLY_STATUS.approved];
export function isSupplyCancellable(request) {
  return !!request && SUPPLY_CANCELLABLE_STATUSES.includes(supplyStatusOf(request));
}

// 🔴 WHO MAY CANCEL a request (CS-596, Daniel 2026-09-30) — of those that may be cancelled at all
// (isSupplyCancellable, CS-670). One pure rule, so the server (which IS the boundary —
// api/supplies), its demo stub and every Cancel button cannot disagree about who gets the button.
// A cancel DELETES the order, so:
//   • the REQUESTER may cancel their OWN request while it is still requested. Once an approver
//     or the office has acted on it, withdrawing it is no longer theirs to do — the decision is
//     part of the record the monthly budget rests on.
//   • 🔴 WHILE IT WAITS FOR APPROVAL (S131 Wave 2, the gap Builder S found): only the people who may
//     DECIDE it — maySupplyDecide's approve rule, the building's approver, THAT approver's operations
//     manager, or the owner / an admin, each holding `supplies.approve`. Never `supplies.manage`
//     alone: that is the Supply Manager, and only approved orders reach them (Matt), so deleting a
//     waiting one is no more theirs than declining it.
//   • ONCE APPROVED: the building's approver or their operations manager (Daniel's answer 3: an OM
//     acts like their AMs), or the OFFICE (isSupplyOffice: the Super Admin, or `supplies.manage` —
//     the Supply Manager now processes it).
// `approverId` is the caller's `resolveSupplyApprover` answer (lib/notifications: the building's
// account manager, else the one person named in Settings → Operations) and `approverOpsManagerId`
// its supplyApproverOpsManagerId — the same two inputs maySupplyDecide takes.
// A CLEANER holds `supplies.request` since the Cleaner Hub (D4, 2026-10-13), so they reach only
// the own-request branch: their own request, while it waits. A cleaner switched off (a revoke)
// reaches none.
//
// Takes only primitives (no state).
export function maySupplyCancel({
  request, selfId = null, role = null, approverId = null, approverOpsManagerId = null,
  holdsRequest = false, holdsApprove = false, holdsManage = false,
} = {}) {
  if (!isSupplyCancellable(request)) return false;
  if (supplyStatusOf(request) === SUPPLY_STATUS.requested) {
    if (holdsRequest && selfId && request.requestedByUserId === selfId) return true;
    return maySupplyDecide({ request, decision: 'approve', selfId, role, approverId, approverOpsManagerId, holdsApprove });
  }
  if (isSupplyOffice({ role, holdsManage })) return true;
  return !!selfId && ((!!approverId && approverId === selfId) || (!!approverOpsManagerId && approverOpsManagerId === selfId));
}

// 🔴 THE APPROVAL STEP'S TEETH. Only an APPROVED order is submitted to the supplier — "requested →
// approved (or declined with a reason) → submitted → completed" (Matt, SUP-1 b and his 2026-10-13
// email) — and only a SUBMITTED one is completed (once every line is resolved: the gate is
// lib/supplyFlow's, which holds the lines). Returns the status the decision moves the order to, or
// NULL when the move is not legal from where it is (which both the UI and the server read as a
// refusal, so there is one rule and not two). A decision that would not move it (approve an
// approved order) is a no-op, not an error. What has gone to the supplier is never declined; a
// reopen is the office's correction until something is delivered (supplyFlow refuses it after).
// 🔴 COMPLETED IS FINAL (S131): its deliveries are usage, spend and the budget's history.
const SUPPLY_TRANSITIONS = {
  [SUPPLY_STATUS.requested]: { approve: SUPPLY_STATUS.approved, reject: SUPPLY_STATUS.rejected },
  [SUPPLY_STATUS.approved]: { submit: SUPPLY_STATUS.sent, reject: SUPPLY_STATUS.rejected, reopen: SUPPLY_STATUS.requested },
  [SUPPLY_STATUS.sent]: { complete: SUPPLY_STATUS.completed, reopen: SUPPLY_STATUS.requested },
  [SUPPLY_STATUS.rejected]: { reopen: SUPPLY_STATUS.requested },
  [SUPPLY_STATUS.completed]: {},
};
export function nextSupplyStatus(current, decision) {
  const from = SUPPLY_STATUSES.includes(current) ? current : SUPPLY_STATUS.requested;
  const to = (SUPPLY_TRANSITIONS[from] || {})[decision];
  return to || null;
}

// Estimated cost of one request = Σ round2(qty × unitPrice) over its snapshot lines.
// Rounded PER LINE (II.8: money rounds where it is charged), then summed and settled
// again so a float sum can never leave a third decimal. Missing/garbage qty or price
// reads as 0, and an item with NO price entered (SUP-4) contributes nothing.
export function supplyLineTotal(line) {
  return round2((Number(line && line.qty) || 0) * (Number(line && line.unitPrice) || 0));
}
export function supplyRequestTotal(request) {
  const lines = (request && request.lines) || [];
  return round2(lines.reduce((a, l) => a + supplyLineTotal(l), 0));
}

// Total item COUNT across a request's lines (Σ qty) — for "N items" glances.
export function supplyRequestItemCount(request) {
  const lines = (request && request.lines) || [];
  return lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
}

// ── The legacy "what went out" record (the delivery step, 2026-10-12) ─────────────────────────────
// Before the supply orders (S131) the office recorded how many of each line it SENT: `sentLines`, one
// entry per line ({ itemId, catalogItemId, qtySent }). Nothing writes it any more (the submit step
// records no quantities, plan §2); it is READ only for an order completed before the per-line record,
// which counts what went out at its `completedAt`. TODO(remove-by: 2026-11-30): the follow-up
// migration after the deploy (plan §7.7) drops sent_lines / sent_total_cents; before it runs, a
// one-time data-op moves any completed row's sent quantities into `fulfillment`, and then this
// reader and the legacy branch of supplyFulfillmentOf go (HANDOFF, S131).
// Each line with `qtyRequested` (what was asked) and `qty` = what went out (what was asked when no
// record exists, an order delivered before the delivery step).
export function supplySentLines(request) {
  const lines = Array.isArray(request && request.lines) ? request.lines : [];
  const sent = Array.isArray(request && request.sentLines) ? request.sentLines : null;
  return lines.map((l, i) => {
    const asked = Math.max(0, Math.floor(Number(l && l.qty) || 0));
    const rec = sent ? sent[i] : null;
    const went = sent ? Math.max(0, Math.floor(Number(rec && rec.qtySent) || 0)) : asked;
    return { ...l, qtyRequested: asked, qty: went };
  });
}

// ── 🔴 THE PER-LINE RECORD (S131, plan §2: `supply_requests.fulfillment`) ──────────────────────────
// One entry per line of `lines`, in the lines' order, written from the moment the order is submitted
// to the supplier:
//   { itemId, catalogItemId,
//     deliveries: [{ qty, at, byUserId, byName, via: 'office' | 'driver' }],
//     backorder:  { at, byUserId, byName, eta: 'YYYY-MM-DD' } | null,
//     cancelled:  { at, byUserId, byName, reason } | null }
// A line is DELIVERED once its deliveries reach its quantity, CANCELLED once the Supply Manager
// cancelled it (the rest never comes), BACKORDERED while it waits on the supplier's ETA, else PENDING.
// A line is RESOLVED when delivered in full or cancelled; the order may be completed when every line
// is. `fulfillment_state` (pending · partial · ready) is written beside it in the same update, so the
// queue's tabs filter in SQL.
export const SUPPLY_LINE_STATE = Object.freeze({ pending: 'pending', backordered: 'backordered', delivered: 'delivered', cancelled: 'cancelled' });
export const SUPPLY_FULFILLMENT_STATES = Object.freeze(['pending', 'partial', 'ready']);
// How a delivery was recorded: by the Supply Manager on the order page, or by the driver on /deliveries.
export const SUPPLY_DELIVERY_VIA = Object.freeze(['office', 'driver']);
// A cancelled line's reason (Daniel's answer 4: "with a reason"), trimmed.
export const SUPPLY_CANCEL_REASON_MIN = 3;
export const SUPPLY_CANCEL_REASON_MAX = 300;
// A DECLINED order's reason (SUP-1 b: "rejected with a reason"; S131 Wave 2: at least 3 characters —
// the person who asked is told it, so "x" or "no" is not one), trimmed and kept to the column's 1,000.
// ONE rule: the write point (lib/supplyFlow supplyDecisionPatch — the route and the demo stub) and
// the one decline dialog (components/SupplyDeclineModal) read both numbers.
export const SUPPLY_DECLINE_REASON_MIN = 3;
export const SUPPLY_DECLINE_REASON_MAX = 1000;
// A supplier ETA is a day in the org's calendar, today or later, and not past a year out (a typo).
export const SUPPLY_ETA_MAX_DAYS = 366;
// One fulfil call carries at most this many acts (a big order is a few dozen lines).
export const SUPPLY_FULFILL_MAX_ACTS = 200;

const wholeQty = (v) => Math.max(0, Math.floor(Number(v) || 0));
const textOrNull = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isoOrNull = (v) => (typeof v === 'string' && v ? v : null);
// An act's who-and-when, as stored.
const stampOf = (s) => ({ at: isoOrNull(s && s.at), byUserId: textOrNull(s && s.byUserId, 128), byName: textOrNull(s && s.byName, 200) });

// The empty record of one line, and of a whole order (what a submit writes).
function emptyEntry(line) {
  return { itemId: (line && line.itemId) || null, catalogItemId: (line && line.catalogItemId) || null, deliveries: [], backorder: null, cancelled: null };
}
export function supplyEmptyFulfillment(lines) {
  return (Array.isArray(lines) ? lines : []).map(emptyEntry);
}

// One stored entry made safe to read (whole quantities, short strings, the line's own ids): the
// store's toRequest and the demo stub read every row through it, so a hand-edited row can never
// poison a total.
function cleanEntry(e, line) {
  const src = e && typeof e === 'object' ? e : {};
  const deliveries = (Array.isArray(src.deliveries) ? src.deliveries : [])
    .map((d) => ({ qty: wholeQty(d && d.qty), ...stampOf(d), via: SUPPLY_DELIVERY_VIA.includes(d && d.via) ? d.via : null }))
    .filter((d) => d.qty > 0);
  const bo = src.backorder && typeof src.backorder === 'object' ? src.backorder : null;
  const cx = src.cancelled && typeof src.cancelled === 'object' ? src.cancelled : null;
  return {
    itemId: (line && line.itemId) || src.itemId || null,
    catalogItemId: (line && line.catalogItemId) || src.catalogItemId || null,
    deliveries,
    backorder: bo ? { ...stampOf(bo), eta: typeof bo.eta === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bo.eta) ? bo.eta : null } : null,
    cancelled: cx ? { ...stampOf(cx), reason: textOrNull(cx.reason, SUPPLY_CANCEL_REASON_MAX) } : null,
  };
}
// A stored `fulfillment` made safe, aligned to the lines (null stays null).
export function normalizeSupplyFulfillment(raw, lines) {
  if (!Array.isArray(raw)) return null;
  return (Array.isArray(lines) ? lines : []).map((l, i) => cleanEntry(raw[i], l));
}

// The per-line record of an order AS IT STANDS — what every reader below goes through:
//   · the stored record, once the order was submitted;
//   · a SUBMITTED order stored before this change (no record yet): every line pending, as asked;
//   · a COMPLETED order from before it: what went out (supplySentLines) delivered at `completedAt`,
//     and a line that went out short marked as never coming (no reason: the old step kept none);
//   · null before the order is submitted (nothing to fulfil yet).
export function supplyFulfillmentOf(request) {
  const lines = Array.isArray(request && request.lines) ? request.lines : [];
  if (Array.isArray(request && request.fulfillment)) return lines.map((l, i) => cleanEntry(request.fulfillment[i], l));
  const status = supplyStatusOf(request);
  if (status === SUPPLY_STATUS.sent) return lines.map(emptyEntry);
  if (status === SUPPLY_STATUS.completed) {
    const stamp = { at: (request && request.completedAt) || null, byUserId: (request && request.completedByUserId) || null, byName: (request && request.completedByName) || null };
    return supplySentLines(request).map((l) => {
      const e = emptyEntry(l);
      if (l.qty > 0) e.deliveries.push({ qty: l.qty, ...stamp, via: null });
      if (l.qty < l.qtyRequested) e.cancelled = { at: stamp.at, byUserId: null, byName: null, reason: null, legacy: true };
      return e;
    });
  }
  return null;
}

// ONE line's state: { state, delivered, remaining, eta }. Delivered in full wins over a backorder
// (the rest arrived after all); a cancelled line has nothing remaining, whatever came before.
export function supplyLineState(line, entry) {
  const qty = wholeQty(line && line.qty);
  const delivered = (entry && Array.isArray(entry.deliveries) ? entry.deliveries : []).reduce((a, d) => a + wholeQty(d && d.qty), 0);
  if (entry && entry.cancelled) return { state: SUPPLY_LINE_STATE.cancelled, delivered, remaining: 0, eta: null };
  if (delivered >= qty) return { state: SUPPLY_LINE_STATE.delivered, delivered, remaining: 0, eta: null };
  if (entry && entry.backorder) return { state: SUPPLY_LINE_STATE.backordered, delivered, remaining: qty - delivered, eta: entry.backorder.eta || null };
  return { state: SUPPLY_LINE_STATE.pending, delivered, remaining: qty - delivered, eta: null };
}
const isResolved = (s) => s.state === SUPPLY_LINE_STATE.delivered || s.state === SUPPLY_LINE_STATE.cancelled;

// The order's fulfilment state from its lines and record: READY when every line is resolved, PARTIAL
// once anything was delivered, else PENDING (a cancel alone is not fulfilment). Null with no record.
export function supplyFulfillmentStateOf(lines, fulfillment) {
  if (!Array.isArray(fulfillment)) return null;
  const list = Array.isArray(lines) ? lines : [];
  let resolved = 0;
  let any = false;
  list.forEach((l, i) => {
    const s = supplyLineState(l, fulfillment[i]);
    if (isResolved(s)) resolved += 1;
    if (s.delivered > 0) any = true;
  });
  if (resolved === list.length) return 'ready';
  return any ? 'partial' : 'pending';
}

// 🔴 THE ORDER'S PROGRESS — ONE reading for the route, the stub and every screen:
//   { state: pending | partial | ready | null, lines: [line + { index, state, delivered, remaining,
//     eta, deliveries, backorder, cancelled }], delivered, resolved, total, backordered, ready }
// `delivered` / `resolved` / `backordered` count LINES; `ready` = every line delivered or cancelled,
// the gate on Mark Completed.
export function supplyOrderProgress(request) {
  const lines = Array.isArray(request && request.lines) ? request.lines : [];
  const f = supplyFulfillmentOf(request);
  const out = lines.map((l, i) => {
    const e = f ? f[i] : null;
    return {
      ...l, index: i, ...supplyLineState(l, e),
      deliveries: e ? e.deliveries : [], backorder: e ? e.backorder : null, cancelled: e ? e.cancelled : null,
    };
  });
  const state = supplyFulfillmentStateOf(lines, f);
  return {
    state,
    lines: out,
    delivered: out.filter((l) => l.state === SUPPLY_LINE_STATE.delivered).length,
    resolved: out.filter(isResolved).length,
    total: out.length,
    backordered: out.filter((l) => l.state === SUPPLY_LINE_STATE.backordered).length,
    ready: state === 'ready',
  };
}

// Every DELIVERY an order holds: [{ index, line, qty, at, byUserId, byName, via }] — what usage,
// spend, the item history, the driver's "delivered today" and the cleaners' line all count.
export function supplyDeliveries(request) {
  const f = supplyFulfillmentOf(request);
  if (!f) return [];
  const lines = Array.isArray(request && request.lines) ? request.lines : [];
  const out = [];
  f.forEach((e, i) => {
    for (const d of e.deliveries) {
      if (d.qty > 0) out.push({ index: i, line: lines[i] || {}, qty: d.qty, at: d.at, byUserId: d.byUserId || null, byName: d.byName || null, via: d.via || null });
    }
  });
  return out;
}
// A delivery's money, in INTEGER CENTS (its line's frozen price × what came).
const deliveryCents = (d) => d.qty * (supplyToCents(d.line && d.line.unitPrice) || 0);
// What an order has delivered so far, in cents — the order page's "Delivered so far".
export function supplyOrderDeliveredCents(request) {
  return supplyDeliveries(request).reduce((a, d) => a + deliveryCents(d), 0);
}

// ── ORDERS: the number, the words per reader, the queue's tabs, the history (S131) ────────────────
// Every order has a NUMBER from a Postgres sequence (SO-1001 on; migration 20261014120000): the
// screens, the bells and the search read it as "SO-1047". Null when a row has none (never in the
// tables; a hand-made fixture).
export function supplyOrderNo(request) {
  const n = request ? Number(request.number) : NaN;
  return Number.isInteger(n) && n > 0 ? `SO-${n}` : null;
}
// A search term that names an order number — "SO-1047", "#SO-1047", "so1047", "1047" — as the number,
// else null (the queue's search matches it on the indexed column beside the words).
export function supplyOrderNumberOf(term) {
  const m = /^#?(?:so-?)?(\d{1,12})$/i.exec(String(term ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// THE PHASE an order is in — the stored status, with a SUBMITTED order split by its per-line record:
// open (pending approval) · approved (new) · supplier (submitted, nothing delivered) · partial ·
// ready (every line resolved, not marked completed yet) · completed · rejected (declined).
export const SUPPLY_ORDER_PHASES = Object.freeze(['open', 'approved', 'supplier', 'partial', 'ready', 'completed', 'rejected']);
// The record's state as stored or as computed: computed from `fulfillment` when the read carries it,
// else the stored `fulfillmentState` (a narrow read), else computed (an order with neither).
function fulfillmentStateFor(request) {
  if (!Array.isArray(request && request.fulfillment) && SUPPLY_FULFILLMENT_STATES.includes(request && request.fulfillmentState)) return request.fulfillmentState;
  return supplyOrderProgress(request).state;
}
export function supplyOrderPhase(request) {
  const s = supplyStatusOf(request);
  if (s !== SUPPLY_STATUS.sent) return s;
  const st = fulfillmentStateFor(request);
  return st === 'ready' ? 'ready' : st === 'partial' ? 'partial' : 'supplier';
}
// 🔴 THE WORDS, PER READER (the plan's §1 table): the office and the Supply Manager, the account
// manager, the cleaner. ONE map, so a screen never words a status of its own; every value a catalog
// line (UI_RULES §140).
export const SUPPLY_ORDER_LABEL_KEYS = Object.freeze({
  office: Object.freeze({
    open: 'supplyPage.label.pending', approved: 'supplyPage.label.new', supplier: 'supplyPage.label.supplier',
    partial: 'supplyPage.label.partial', ready: 'supplyPage.label.ready', completed: 'supplyPage.label.completed',
    rejected: 'supplyPage.label.declined',
  }),
  am: Object.freeze({
    open: 'supplyPage.label.pending', approved: 'supplyPage.label.withSm', supplier: 'supplyPage.label.withSupplier',
    partial: 'supplyPage.label.partial', ready: 'supplyPage.label.allDelivered', completed: 'supplyPage.label.completed',
    rejected: 'supplyPage.label.declined',
  }),
  crew: Object.freeze({
    open: 'supplyPage.label.waiting', approved: 'supplyPage.label.approved', supplier: 'supplyPage.label.ordered',
    partial: 'supplyPage.label.partial', ready: 'supplyPage.label.allDelivered', completed: 'supplyPage.label.delivered',
    rejected: 'supplyPage.label.declined',
  }),
});
export function supplyOrderLabelKey(request, audience = 'office') {
  const map = SUPPLY_ORDER_LABEL_KEYS[audience] || SUPPLY_ORDER_LABEL_KEYS.office;
  return map[supplyOrderPhase(request)];
}
// THE ACCOUNT MANAGER'S WORDS for one order on By building (S131 Wave 2; the AM Hub's board 8:
// "#SO-1047 · With Supply Manager · Partially fulfilled"): their label from the map above, and before
// a word that says how far an order has come but not whose move it is — partially fulfilled, all
// delivered — "With Supply Manager" (the am map's own words for an order the Supply Manager holds),
// who is chasing the rest or closing it. Never twice (an approved order reads "With Supply Manager"
// alone) and never before "With supplier", which already says where it is. → the label keys, in order,
// for the screen to word and join.
export const SUPPLY_AM_HOLDER_PHASES = Object.freeze(['partial', 'ready']);
export function supplyOrderAmKeys(request) {
  const phase = supplyOrderPhase(request);
  const am = SUPPLY_ORDER_LABEL_KEYS.am;
  return SUPPLY_AM_HOLDER_PHASES.includes(phase) ? [am.approved, am[phase]] : [am[phase]];
}
// The badge colour per phase (Badge variants), so the queue, the order page and the customer tab agree.
const PHASE_VARIANT = Object.freeze({ open: 'purple', approved: 'slate', supplier: 'blue', partial: 'amber', ready: 'green', completed: 'green', rejected: 'red' });
export function supplyOrderVariant(request) {
  return PHASE_VARIANT[supplyOrderPhase(request)] || 'slate';
}

// THE QUEUE'S TABS (Pending approval · New · With supplier · Partially fulfilled · Completed ·
// Declined), keyed by the `?status=` value — the stored status, so an old link still lands, plus
// `partial` for a submitted order with something delivered (or everything in, waiting to be marked
// completed). The Supply Manager's own view starts at New (Matt: only approved orders reach them).
export const SUPPLY_QUEUE_TABS = Object.freeze(['open', 'approved', 'sent', 'partial', 'completed', 'rejected']);
export const SUPPLY_QUEUE_TAB_KEYS = Object.freeze({
  open: 'supplyPage.queue.tab.pending', approved: 'supplyPage.queue.tab.new', sent: 'supplyPage.queue.tab.supplier',
  partial: 'supplyPage.queue.tab.partial', completed: 'supplyPage.queue.tab.completed', rejected: 'supplyPage.queue.tab.declined',
});
export const SUPPLY_MANAGER_TABS = Object.freeze(['approved', 'sent', 'partial', 'completed']);
// Which tab an order is listed under (the route's SQL filter, in words).
export function supplyQueueTabOf(request) {
  const s = supplyStatusOf(request);
  if (s !== SUPPLY_STATUS.sent) return s;
  const st = fulfillmentStateFor(request);
  return st === 'partial' || st === 'ready' ? 'partial' : 'sent';
}

// A supplier ETA, as a backorder takes it: a real day 'YYYY-MM-DD' in the org's calendar, from
// `todayKey` (the org-zone today) up to SUPPLY_ETA_MAX_DAYS ahead. → null when fine, else 'bad_eta'.
export function supplyEtaError(eta, todayKey) {
  if (typeof eta !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(eta)) return 'bad_eta';
  const d = new Date(`${eta}T12:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== eta) return 'bad_eta';
  if (todayKey && eta < todayKey) return 'bad_eta';
  if (todayKey && diffDaysKey(todayKey, eta) > SUPPLY_ETA_MAX_DAYS) return 'bad_eta';
  return null;
}
// A day key as an instant to WORD (a date format reads it in the org's zone): noon UTC is the same
// calendar day in every US zone, where midnight UTC is the evening before.
export function supplyEtaInstant(eta) {
  return typeof eta === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(eta) ? `${eta}T12:00:00.000Z` : null;
}

// A COMMENT on an order (S131: the office's notes, append-only, `supply_request_comments`): 1 to
// SUPPLY_COMMENT_MAX characters, trimmed. → { body } or { error: 'body_required' | 'body_too_long' }.
export const SUPPLY_COMMENT_MAX = 1000;
export function supplyCommentBody(raw) {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body) return { error: 'body_required' };
  if (body.length > SUPPLY_COMMENT_MAX) return { error: 'body_too_long' };
  return { body };
}

// The supplier's INVOICE kept with an order (`supply_order_documents`, the private `supply-documents`
// bucket): PDF, JPEG or PNG up to 10 MB — the migration's own checks.
export const SUPPLY_INVOICE_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPLY_INVOICE_MIME = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);
// A PRODUCT IMAGE (`supply_catalog.image_v`): the device shrinks it to a JPEG about this wide
// (lib/imageCanvas shrinkPhoto), the server takes a data URL of at most SUPPLY_IMAGE_MAX_BYTES.
export const SUPPLY_IMAGE_EDGE = 640;
export const SUPPLY_IMAGE_MAX_BYTES = 1024 * 1024;

// 🔴 THE ORDER'S HISTORY — ONE timeline built from what is STORED, never a second copy (plan §1): the
// row's stamps (requested, approved or declined, submitted, completed), each line's deliveries,
// backorder and cancel, the comments, the photos and the invoices — each { kind, at, byName, … },
// oldest first (newest last). An order completed before the per-line record shows its deliveries at
// `completedAt`; its synthetic "never came" marks are not acts and are left out.
export function supplyOrderHistory(order, { comments = [], photos = [], invoices = [] } = {}) {
  if (!order) return [];
  const rows = [];
  const push = (kind, at, extra = {}) => { if (at) rows.push({ kind, at, ...extra }); };
  push('requested', order.createdAt, { byName: order.requestedByName || null, byUserId: order.requestedByUserId || null });
  push('approved', order.approvedAt, { byName: order.approvedByName || null, byUserId: order.approvedByUserId || null });
  push('declined', order.rejectedAt, { byName: order.rejectedByName || null, byUserId: order.rejectedByUserId || null, reason: order.rejectionReason || null });
  push('submitted', order.sentAt, { byName: order.sentByName || null, byUserId: order.sentByUserId || null });
  for (const l of supplyOrderProgress(order).lines) {
    for (const d of l.deliveries) push('delivered', d.at, { byName: d.byName || null, byUserId: d.byUserId || null, line: l.index, name: l.name || '', qty: d.qty, via: d.via || null });
    if (l.backorder) push('backordered', l.backorder.at, { byName: l.backorder.byName || null, byUserId: l.backorder.byUserId || null, line: l.index, name: l.name || '', eta: l.backorder.eta || null });
    if (l.cancelled && !l.cancelled.legacy) push('lineCancelled', l.cancelled.at, { byName: l.cancelled.byName || null, byUserId: l.cancelled.byUserId || null, line: l.index, name: l.name || '', reason: l.cancelled.reason || null });
  }
  for (const c of Array.isArray(comments) ? comments : []) if (c) push('comment', c.createdAt, { byName: c.authorName || null, id: c.id, body: c.body || '' });
  for (const p of Array.isArray(photos) ? photos : []) if (p) push('photo', p.createdAt, { byName: p.uploaderName || null, id: p.id, areaId: p.areaId || null });
  for (const inv of Array.isArray(invoices) ? invoices : []) if (inv) push('invoice', inv.createdAt, { byName: inv.uploaderName || null, id: inv.id, fileName: inv.fileName || '' });
  push('completed', order.completedAt, { byName: order.completedByName || null, byUserId: order.completedByUserId || null });
  return rows.map((r, i) => ({ r, i, t: new Date(r.at).getTime() }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map(({ r }) => r);
}

// ── SUP-5 / CS-191: usage per building, counted AT EACH DELIVERY ──────────────
// Matt (SUP-5 a): an item counts when it is delivered. Since the supply orders (S131) an order is
// delivered line by line, so every tally here reads each DELIVERY's own time (supplyDeliveries) — a
// line delivered in September and the rest in October count in their own months, which is also what
// the budget spends against (SUP-7). An order completed before the per-line record counts what went
// out at its `completedAt`.
//
// `fromMs` / `toMs` are an inclusive window in epoch ms; the CALLER builds it in the ORG's zone
// (lib/dates startOfDayKey / startOfMonthKey — II.8), because this module stays zone-free. Lines are
// grouped by the snapshot NAME, not itemId: a catalog item deleted or re-added still tallies as the
// same supply, which is the question "how many boxes of toilet paper in 30 days" actually asks.
const inWindow = (iso, fromMs, toMs) => {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) && t >= fromMs && t <= toMs;
};
// Every delivery in a window (and optionally one building), newest first, with its order.
function deliveriesInWindow(requests, { clientId = null, fromMs = -Infinity, toMs = Infinity } = {}) {
  const hits = [];
  for (const r of Array.isArray(requests) ? requests : []) {
    if (!r || (clientId && r.clientId !== clientId)) continue;
    for (const d of supplyDeliveries(r)) if (inWindow(d.at, fromMs, toMs)) hits.push({ r, d });
  }
  return hits.sort((a, b) => new Date(b.d.at || 0) - new Date(a.d.at || 0));
}
// Quantities per item over the window: [{ name, unitPrice, qty, total, requests }], the biggest
// spend first then the biggest quantity. `unitPrice` is the price on the LATEST delivered line for
// that name (prices change; the per-order snapshots keep history), null when none carried one;
// `requests` how many orders delivered it in the window. Money summed in cents (II.8).
export function supplyUsageByItem(requests, window = {}) {
  const byName = new Map();
  for (const { r, d } of deliveriesInWindow(requests, window)) {
    const name = (d.line && d.line.name) || 'Item';
    let row = byName.get(name);
    if (!row) { row = { name, unitPrice: null, qty: 0, cents: 0, orders: new Set() }; byName.set(name, row); }
    if (row.unitPrice == null && Number(d.line && d.line.unitPrice) > 0) row.unitPrice = round2(d.line.unitPrice);
    row.qty += d.qty;
    row.cents += deliveryCents(d);
    row.orders.add(r.id ?? r);
  }
  return [...byName.values()]
    .map((x) => ({ name: x.name, unitPrice: x.unitPrice, qty: x.qty, total: x.cents / 100, requests: x.orders.size }))
    .sort((a, b) => b.total - a.total || b.qty - a.qty || a.name.localeCompare(b.name));
}
// The window's delivered money per building, in CENTS: { clientId → cents } (buildings with none left
// out) — the monthly budget read (GET /api/supplies/budgets) and By building's spend, route and stub.
export function supplyDeliveredCentsByClient(requests, window = {}) {
  const out = {};
  for (const { r, d } of deliveriesInWindow(requests, window)) {
    const cents = deliveryCents(d);
    if (cents > 0 && r.clientId) out[r.clientId] = (out[r.clientId] || 0) + cents;
  }
  return out;
}

// ── SUP-7 / SUP-10: the monthly supply budget per building ────────────────────
// Matt (SUP-7 b): "a field where we can enter the estimated budget for the building. As we
// order the items which have prices, it goes against the budget. If it goes over the budget
// over a monthly period, the account is flagged as over budget for supplies." SUP-10 ★a
// settles the period as the CALENDAR month (the caller passes that window).
//
// A budget of null / 0 / blank means NO budget is set for that building — never a budget of
// zero, which would flag every account that ever ordered anything.
export const MAX_SUPPLY_BUDGET = 1000000;
export function supplyBudgetFor(client) {
  const v = Number(client && client.supplyBudgetMonthly);
  if (!Number.isFinite(v) || v <= 0) return null;
  return round2(Math.min(MAX_SUPPLY_BUDGET, v));
}
// Spend = Σ each DELIVERY in the window at its line's SNAPSHOTTED price (S131: in the month it
// happened), so a catalog price change never rewrites what a past month cost. Cents inside (II.8).
export function supplySpendInWindow(requests, window = {}) {
  return deliveriesInWindow(requests, window).reduce((a, { d }) => a + deliveryCents(d), 0) / 100;
}
// "Over budget" reads as spend STRICTLY ABOVE the budget: landing exactly on it is on
// budget, not over.
export function isOverSupplyBudget(spend, budget) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return false;
  return round2(spend) > round2(b);
}
// One budget answer for a building and a window: { budget, spend, over, remaining, pct }.
// budget null → over false and pct null (nothing to be over).
export function supplyBudgetStatus(client, requests, window = {}) {
  const budget = supplyBudgetFor(client);
  const spend = supplySpendInWindow(requests, { ...window, clientId: client && client.id });
  return {
    budget,
    spend,
    over: isOverSupplyBudget(spend, budget),
    remaining: budget == null ? null : round2(budget - spend),
    pct: budget == null ? null : Math.round((spend / budget) * 100),
  };
}

// ── SUP-8 / CS-380: the monthly order reminder day ────────────────────────────
// Matt (SUP-8 a): "monthly on a set day, adjustable per building". The org default lives in
// opsSettings.supplyOrderDayOfMonth; a building may carry its own `supplyOrderDayOfMonth`.
// Capped at 28 so EVERY month actually has the day — a 30th would never come round in
// February, and the building would never be reminded.
export const DEFAULT_SUPPLY_ORDER_DAY = 1;
export const MAX_SUPPLY_ORDER_DAY = 28;
const clampOrderDay = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(MAX_SUPPLY_ORDER_DAY, Math.floor(n));
};
export function orgSupplyOrderDay(settings = {}) {
  return clampOrderDay(settings && settings.supplyOrderDayOfMonth) || DEFAULT_SUPPLY_ORDER_DAY;
}
// THIS building's order day: its own when set, else the org default. A blank / zero /
// non-numeric per-building value falls back rather than disabling the reminder for it.
export function supplyOrderDayFor(client, settings = {}) {
  return clampOrderDay(client && client.supplyOrderDayOfMonth) || orgSupplyOrderDay(settings);
}

// A request row's one-line summary, as PARTS: the first item as written, its quantity and how
// many more lines follow — `{ name, qty, more }`, or null when there are no lines. The screen
// words it from the catalog ("Glass cleaner ×4 +2 more", UI_RULES §140), so this module never
// builds an English sentence (it replaced `summarizeLines`, 2026-10-04).
export function supplyLinesSummary(lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return null;
  const first = list[0] || {};
  return { name: first.name || '', qty: Number(first.qty) || 0, more: list.length - 1 };
}

// ── The queue's filters (2026-10-04) ───────────────────────────────────────────
// ONE rule for the Requests table: the status tab, the Manager, the Customer. The Manager is the
// BUILDING's supervisor (`client.supervisorId`, read through the caller's `supervisorOf`), the
// same scope the Customer options, the Usage view and Reports use — it filtered by the person
// who ASKED before, so a picked manager listed customers whose requests the table then hid.
export function filterSupplyRequests(requests, { status = null, managerId = '', clientId = '', supervisorOf = () => null } = {}) {
  return (Array.isArray(requests) ? requests : []).filter((r) => {
    if (!r) return false;
    if (status && supplyStatusOf(r) !== status) return false;
    if (managerId && supervisorOf(r.clientId) !== managerId) return false;
    if (clientId && r.clientId !== clientId) return false;
    return true;
  });
}

// ── The request form's quantity (typed or stepped) ─────────────────────────────
// A whole number from 0 (not ordered) to SUPPLY_MAX_QTY; a blank or a typo reads as 0 rather than
// NaN, which would poison the line total. 999 of one supply on one monthly request is already
// far past any real order, and the cap keeps a slipped finger from ordering 40,000 liners.
export const SUPPLY_MAX_QTY = 999;
export function clampSupplyQty(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(SUPPLY_MAX_QTY, n);
}


// ── SUP-13 (Matt, 2026-10-05): usage and spend go back 12 MONTHS ─────────────────
// The history the supplies tables KEEP, and therefore the furthest any usage or spend figure may
// reach. A settled request (completed or rejected) older than this is deleted at the WRITE point
// by the route (api/_lib/supplies/store.js pruneSettledRequests); a request still in flight is
// never dropped — the office still owes the building an order. The old newest-300 cap is GONE:
// it would have dropped most of a month within days at 750 buildings.
//
// The window is CALENDAR months in the org's zone: today and back to the same day 12 months ago,
// exclusive (2026-10-05 keeps 2025-10-06 onward). Zone-free label arithmetic, so the browser,
// the stub, the route and the node suites agree to the day.
export const SUPPLY_HISTORY_MONTHS = 12;
export function supplyHistoryStartKey(todayKey) {
  return addDaysKey(addMonthsKey(todayKey, -SUPPLY_HISTORY_MONTHS), 1);
}
// How many calendar days that window holds (365 or 366), for a custom range's length check.
export function supplyHistoryDays(todayKey) {
  return diffDaysKey(supplyHistoryStartKey(todayKey), todayKey) + 1;
}
// Does a range starting on `fromKey` (YYYY-MM-DD) begin before the kept history? Day keys compare
// as strings. 🔴 A range that does would read SHORT, and a partial tally presented as a whole one
// is worse than no report, so every reader refuses it and names the first allowed day.
export function supplyRangeBeforeHistory(fromKey, todayKey) {
  return !!fromKey && fromKey < supplyHistoryStartKey(todayKey);
}

// The states a request is FINISHED in, and the timestamp each is dated by. `rejected` (SUP-1 b)
// joins `completed`: a rejection is terminal and is never completed, so a tail bounded on
// `completed` alone would keep every rejection for ever.
export const SUPPLY_SETTLED_STATUSES = [SUPPLY_STATUS.completed, SUPPLY_STATUS.rejected];
export const isSupplySettled = (r) => SUPPLY_SETTLED_STATUSES.includes(supplyStatusOf(r));
export function supplySettledAt(r) {
  const s = supplyStatusOf(r);
  if (s === SUPPLY_STATUS.completed) return (r && r.completedAt) || null;
  if (s === SUPPLY_STATUS.rejected) return (r && r.rejectedAt) || null;
  return null;
}

// The usage report's periods (Supplies → Usage and Reports → Supply usage, ONE implementation).
// SUP-13 adds 6 and 12 months; '12m' IS the kept history. Every preset is a run of org-zone
// calendar days ending today.
export const SUPPLY_USAGE_PERIODS = ['7d', '30d', '90d', 'mtd', '6m', '12m', 'custom'];
export function supplyUsageWindowKeys(period, { todayKey, from = null, to = null } = {}) {
  const start = supplyHistoryStartKey(todayKey);
  switch (period) {
    case '7d': return { fromKey: addDaysKey(todayKey, -6), toKey: todayKey };
    case '90d': return { fromKey: addDaysKey(todayKey, -89), toKey: todayKey };
    case 'mtd': return { fromKey: `${todayKey.slice(0, 8)}01`, toKey: todayKey };
    case '6m': return { fromKey: addDaysKey(addMonthsKey(todayKey, -6), 1), toKey: todayKey };
    case '12m': return { fromKey: start, toKey: todayKey };
    case 'custom': {
      if (!from || !to) return { error: 'pick_both' };
      if (to < from) return { error: 'end_before_start' };
      if (from < start) return { error: 'before_history', firstKey: start };
      return { fromKey: from, toKey: to > todayKey ? todayKey : to };
    }
    case '30d':
    default: return { fromKey: addDaysKey(todayKey, -29), toKey: todayKey };
  }
}

// ── money at the storage boundary (II.8: the tables hold INTEGER CENTS) ──────────
// A price of null / blank / 0 / garbage means NO PRICE ENTERED (SUP-4), never $0.00.
export function supplyToCents(dollars) {
  if (dollars === null || dollars === undefined || dollars === '') return null;
  const n = Number(dollars);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n + Number.EPSILON) * 100);
}
export function supplyFromCents(cents) {
  if (cents === null || cents === undefined) return null;
  const n = Number(cents);
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}
// A request's total in cents, from its snapshot lines (cents arithmetic, so no float sum).
export function supplyLinesTotalCents(lines) {
  return (Array.isArray(lines) ? lines : [])
    .reduce((a, l) => a + (Math.max(0, Math.floor(Number(l && l.qty) || 0)) * (Number(l && l.unitPriceCents) || 0)), 0);
}

// ── a submitted request's lines, snapshotted from the building's OWN list ─────────
// The client sends `{ itemId, qty }` (or `{ catalogItemId, qty }`); the name, SKU and price come
// from the building's list on the server's side (or the stub's) — read through the master list
// since 2026-10-11 — never from the body: a posted price would let any requester order at a price
// they typed. Quantities are clamped (clampSupplyQty); a line of 0 is "not ordered" and is
// dropped; the same item twice is ONE line with the summed quantity. Each line freezes the
// CATALOG item it is (`catalogItemId`), which the building's history and its on-order key on
// (D6), and the SKU beside the name. A line naming the catalog item finds the building's row for
// it, so an order sheet opened before an item was switched off and back on still sends.
// 🔴 THE CREW CAP (S131): `maxQty` below SUPPLY_MAX_QTY holds every line — the same item twice
// summed — to that ceiling and REFUSES past it by name ('over_cap'), never clamps: the route passes
// CREW_SUPPLY_MAX_QTY for a caller who is not an office role, so the cleaner's 1–20 is the server's
// rule and not only the screen's. The office's order sheet keeps its own ceiling.
// Returns { lines } or { error: 'no_lines' | 'unknown_item' | 'too_many_lines' | 'over_cap', itemId?, max? }.
export const SUPPLY_MAX_LINES = 100;
export function snapshotSupplyLines(posted, itemsById, { maxQty = SUPPLY_MAX_QTY } = {}) {
  const items = itemsById instanceof Map ? itemsById : new Map();
  const byCatalog = new Map();
  for (const it of items.values()) if (it && it.catalogItemId) byCatalog.set(it.catalogItemId, it);
  const cap = Number.isInteger(maxQty) && maxQty > 0 ? Math.min(maxQty, SUPPLY_MAX_QTY) : SUPPLY_MAX_QTY;
  const qtyById = new Map();
  for (const l of Array.isArray(posted) ? posted : []) {
    if (!l) continue;
    const named = typeof l.itemId === 'string' && l.itemId ? l.itemId
      : typeof l.catalogItemId === 'string' && l.catalogItemId ? l.catalogItemId : null;
    if (!named) continue;
    const q = clampSupplyQty(l.qty);
    if (q <= 0) continue;
    // The building's row this line names — by its own id, else by its catalog item; an id that
    // names neither stays as written so the refusal below can name it.
    const row = items.get(l.itemId) || (l.catalogItemId ? byCatalog.get(l.catalogItemId) : null);
    const key = row ? row.id : named;
    const sum = (qtyById.get(key) || 0) + q;
    if (cap < SUPPLY_MAX_QTY && sum > cap) return { error: 'over_cap', itemId: key, max: cap };
    qtyById.set(key, Math.min(SUPPLY_MAX_QTY, sum));
  }
  if (!qtyById.size) return { error: 'no_lines' };
  if (qtyById.size > SUPPLY_MAX_LINES) return { error: 'too_many_lines' };
  const lines = [];
  for (const [itemId, qty] of qtyById) {
    const item = items.get(itemId);
    if (!item) return { error: 'unknown_item', itemId };
    lines.push({
      itemId,
      catalogItemId: item.catalogItemId || null,
      sku: item.sku || null,
      name: item.name || '',
      qty,
      unitPrice: Number(item.unitPrice) > 0 ? round2(item.unitPrice) : null,
    });
  }
  return { lines };
}

// ── THE MASTER SUPPLY LIST (Matt, the Oct 6 call; plan 2026-10-11 §2, D1–D6) ──────────────────
// "We can have a master template. And then for a customer, we can assign which supplies they can
// order or see on their end." One catalog per org (`supply_catalog`): SKU · name · category · how
// it comes · price (D2). A building's list is its SWITCHES over it (`supply_items`, one row per
// building and catalog item, D4), and the row reads its name, SKU, unit and price FROM the
// catalog (D5: one source of truth). The route, the demo stub and the screens read these rules.

// The limits a catalog item's fields keep (the migration's checks, 20261011100000).
export const SUPPLY_NAME_MAX = 200;
export const SUPPLY_SKU_MAX = 40;
export const SUPPLY_CATEGORY_MAX = 60;
export const SUPPLY_UNIT_MAX = 80;
// A price above this is a typo, not a supply ($100,000 a unit).
export const SUPPLY_MAX_PRICE_CENTS = 10000000;
// The category filter's "no category" choice (a value no label can be: labels are trimmed text).
export const SUPPLY_NO_CATEGORY = '__none__';

// One line of text: control characters and line breaks read as a space, runs of spaces as one,
// the ends trimmed — so what is stored is what a table cell shows, and the SKU's key below is the
// database's lower(btrim(sku)).
function oneLine(v) {
  if (v === null || v === undefined) return '';
  let out = '';
  for (const ch of String(v)) out += ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch;
  return out.replace(/\s+/g, ' ').trim();
}

// D2: a SKU is optional and, when given, unique in the org — case-insensitively and around its
// spaces ("cl-1001 " is "CL-1001"). The key both the check and the database's unique index use;
// a blank SKU has none, so blanks never clash.
export function supplySkuKey(sku) {
  const s = oneLine(sku);
  return s ? s.toLowerCase() : null;
}
// The catalog item already holding `sku`, other than item `id` (an edit keeps its own) — or null.
export function findSupplySkuClash(catalog, { id = null, sku } = {}) {
  const key = supplySkuKey(sku);
  if (!key) return null;
  return (Array.isArray(catalog) ? catalog : []).find((c) => c && c.id !== id && supplySkuKey(c.sku) === key) || null;
}

// A catalog item's fields from a request body, as the route and the demo stub both store them:
//   { fields: { sku, name, category, unit, unitPriceCents } }  (blank = null, never '' or $0)
//   { error: 'name_required' | 'name_too_long' | 'sku_too_long' | 'category_too_long'
//            | 'unit_too_long' | 'bad_price' }
export function supplyCatalogFields(body = {}) {
  const b = body || {};
  const name = oneLine(b.name);
  if (!name) return { error: 'name_required' };
  if (name.length > SUPPLY_NAME_MAX) return { error: 'name_too_long' };
  const sku = oneLine(b.sku);
  if (sku.length > SUPPLY_SKU_MAX) return { error: 'sku_too_long' };
  const category = oneLine(b.category);
  if (category.length > SUPPLY_CATEGORY_MAX) return { error: 'category_too_long' };
  const unit = oneLine(b.unit);
  if (unit.length > SUPPLY_UNIT_MAX) return { error: 'unit_too_long' };
  const raw = b.unitPrice;
  const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
  const unitPriceCents = blank ? null : supplyToCents(raw);
  if (!blank && (unitPriceCents === null || unitPriceCents > SUPPLY_MAX_PRICE_CENTS)) return { error: 'bad_price' };
  return { fields: { sku: sku || null, name, category: category || null, unit: unit || null, unitPriceCents } };
}

// D3: the category is a free label. The labels in use, one spelling each (the first seen;
// "liquids " is "Liquids"), A to Z — the add form's suggestions and the category filter's options.
const categoryKey = (c) => oneLine(c).toLowerCase();
export function supplyCategories(catalog) {
  const seen = new Map();
  for (const c of Array.isArray(catalog) ? catalog : []) {
    const k = c ? categoryKey(c.category) : '';
    if (k && !seen.has(k)) seen.set(k, oneLine(c.category));
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
// The label a save STORES: when another item already uses this label in another case or with
// other spaces, its spelling — so the category filter (an exact match) and the groups never split
// one label in two. A new label is kept as typed; an item that is the only holder of its label may
// re-case it. Null stays null.
export function supplyCategoryAsUsed(catalog, { id = null, category } = {}) {
  const k = categoryKey(category);
  if (!k) return category == null ? null : (oneLine(category) || null);
  const other = (Array.isArray(catalog) ? catalog : []).find((c) => c && c.id !== id && categoryKey(c.category) === k);
  return other ? oneLine(other.category) : oneLine(category);
}
// Items grouped by category for a building's switches and the order sheet: named groups A to Z
// (one spelling per label, as above), then the unlabelled ones (`category: null`); items by name
// within a group. [{ key, category, items }].
export function groupSupplyByCategory(items) {
  const groups = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    const k = categoryKey(it.category);
    if (!groups.has(k)) groups.set(k, { key: k || SUPPLY_NO_CATEGORY, category: k ? oneLine(it.category) : null, items: [] });
    groups.get(k).items.push(it);
  }
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.sku || '').localeCompare(String(b.sku || '')) || String(a.id).localeCompare(String(b.id));
  return [...groups.values()]
    .map((g) => ({ ...g, items: g.items.slice().sort(byName) }))
    .sort((a, b) => (a.category === null) - (b.category === null) || String(a.category || '').localeCompare(String(b.category || '')));
}

// D4 / D6: a building's switches. ONE call carries what to switch on and off, at most
// SUPPLY_ASSIGN_MAX ids (a bigger one is refused by name, never cut short), and every asked id is
// answered: 'ok' (switched) · 'already' (it was) · 'not_found' (no such catalog item to switch
// on) · 'conflict' (asked on AND off at once — nothing is done to it). `current` is the
// catalog items the building has on, `known` the catalog items that exist. Pure: the route reads
// both and writes `add` / `remove`; the demo stub does the same.
export const SUPPLY_ASSIGN_MAX = 200;
export function planSupplyAssign({ on = [], off = [], current = [], known = [] } = {}) {
  const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x))];
  const onIds = uniq(on);
  const offIds = uniq(off);
  if (onIds.length + offIds.length > SUPPLY_ASSIGN_MAX) return { error: 'too_many', max: SUPPLY_ASSIGN_MAX };
  const cur = new Set(current);
  const kn = new Set(known);
  const both = new Set(onIds.filter((id) => offIds.includes(id)));
  const add = [];
  const remove = [];
  const results = [];
  const answer = (catalogItemId, isOn, code) => results.push({ catalogItemId, on: isOn, ok: code === 'ok' || code === 'already', code });
  for (const id of onIds) {
    if (both.has(id)) answer(id, true, 'conflict');
    else if (!kn.has(id)) answer(id, true, 'not_found');
    else if (cur.has(id)) answer(id, true, 'already');
    else { add.push(id); answer(id, true, 'ok'); }
  }
  for (const id of offIds) {
    if (both.has(id)) answer(id, false, 'conflict');
    else if (!cur.has(id)) answer(id, false, 'already');
    else { remove.push(id); answer(id, false, 'ok'); }
  }
  return { add, remove, results };
}

// The CATALOG item a request line is (D6): its own `catalogItemId` (every line since the master
// list, and the old ones the migration's backfill reached), else the catalog item of the
// building's row it names, through `itemCatalog` (row id → catalog id: an object or a Map, from
// the building's list) — for a line written in the minutes between the migration and the deploy.
// Null = the line is no catalog item's.
export function supplyLineCatalogId(line, itemCatalog = null) {
  if (!line) return null;
  if (typeof line.catalogItemId === 'string' && line.catalogItemId) return line.catalogItemId;
  const id = line.itemId;
  if (!id || !itemCatalog) return null;
  return (itemCatalog instanceof Map ? itemCatalog.get(id) : itemCatalog[id]) || null;
}
// A building's list as { rowId: catalogItemId } — the `itemCatalog` the two keyed rules take.
export function supplyItemCatalogMap(items) {
  const out = {};
  for (const it of Array.isArray(items) ? items : []) if (it && it.id && it.catalogItemId) out[it.id] = it.catalogItemId;
  return out;
}

// ── a decision over many requests: bounded batches, every id answered ─────────────
// One decide call carries at most SUPPLY_DECIDE_MAX requests: the route refuses a bigger one by
// name ('too_many') rather than cutting it short, and the client splits a selection into
// batches of it. 750 buildings each waiting on one order is a single "Select all", and the
// first version of the store answered only the first 500 of those and said nothing about the
// rest. `call(batch)` sends one batch and resolves to `{ results }`. Results come back in the
// order sent. A batch that fails AFTER another has landed names each of its ids 'failed', so
// the toast can say what did not happen; a failure before anything landed throws.
export const SUPPLY_DECIDE_MAX = 200;
export async function runSupplyDecideBatches(ids, call, max = SUPPLY_DECIDE_MAX) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  const results = [];
  for (let i = 0; i < list.length; i += max) {
    const batch = list.slice(i, i + max);
    try {
      const r = await call(batch);
      results.push(...((r && Array.isArray(r.results)) ? r.results : []));
    } catch (e) {
      if (!results.length) throw e;
      for (const id of list.slice(i)) results.push({ id, ok: false, code: 'failed' });
      break;
    }
  }
  const counts = results.reduce((a, x) => ({ ...a, [x.code]: (a[x.code] || 0) + 1 }), {});
  return { results, counts };
}

// ── Round 3 (Daniel, 2026-10-06): the order sheet, and the building's own Supplies tab ────────
// "Go with A; but the separate supply tab in the customer view that B has. Wire it up."

// What is ALREADY ON ORDER for a building, per CATALOG ITEM: { [catalogItemId]: { requested,
// approved, sent } }. The order sheet writes it out under each row ("4 already on order · waiting
// for Renata to approve", "2 on the way") instead of the old "pending ×N" chip, which matched
// lines by NAME — two items can share a name, and a renamed item is still the same item. Keyed on
// the catalog item (supplyLineCatalogId), not the building's row, so an item switched off and
// back on still counts what was ordered before (D6). Only the in-flight states count — waiting and
// approved at what was asked, a SUBMITTED order at what is still to come (S131: each line's
// remaining — delivered and cancelled taken off); a line that is no catalog item's belongs to no
// item on the list.
const IN_FLIGHT_KEY = { [SUPPLY_STATUS.requested]: 'requested', [SUPPLY_STATUS.approved]: 'approved', [SUPPLY_STATUS.sent]: 'sent' };
// An in-flight order's lines with what is still to come: [{ line, qty }].
function stillToCome(r) {
  if (supplyStatusOf(r) === SUPPLY_STATUS.sent) return supplyOrderProgress(r).lines.map((l) => ({ line: l, qty: l.remaining }));
  return (Array.isArray(r && r.lines) ? r.lines : []).map((l) => ({ line: l, qty: wholeQty(l && l.qty) }));
}
export function supplyOnOrderByItem(requests, { itemCatalog = null } = {}) {
  const out = {};
  for (const r of Array.isArray(requests) ? requests : []) {
    const key = IN_FLIGHT_KEY[supplyStatusOf(r)];
    if (!key) continue;
    for (const { line, qty } of stillToCome(r)) {
      const id = supplyLineCatalogId(line, itemCatalog);
      if (!id || !qty) continue;
      const row = out[id] || (out[id] = { requested: 0, approved: 0, sent: 0 });
      row[key] += qty;
    }
  }
  return out;
}
// The money still ON ORDER for a building (waiting, approved and submitted — everything not yet
// delivered), in CENTS, from the orders' own snapshot lines — what the budget line counts beside the
// delivered spend.
export function supplyOnOrderCents(requests) {
  let cents = 0;
  for (const r of Array.isArray(requests) ? requests : []) {
    if (!IN_FLIGHT_KEY[supplyStatusOf(r)]) continue;
    for (const { line, qty } of stillToCome(r)) cents += qty * (supplyToCents(line && line.unitPrice) || 0);
  }
  return cents;
}

// The budget line under the order sheet's total, as PARTS the screen words (UI_RULES §140):
//   { kind: 'none' }                                  no budget set for the building
//   { kind: 'unknown' }                               the delivered spend has not loaded (not $0)
//   { kind: 'month', budget, delivered, onOrder }     nothing picked yet
//   { kind: 'with', budget, withThis, onOrder }       picked, within the budget
//   { kind: 'over', budget, over, onOrder }           picked, past it — a WARNING, never a block
// Worked in INTEGER CENTS (II.8), so the sentence never disagrees with its own figures at the
// edge; landing exactly on the budget is on budget (isOverSupplyBudget's rule). Dollars out.
export function supplyBudgetLine({ budget, deliveredCents, onOrderCents = 0, thisCents = 0 } = {}) {
  const b = supplyToCents(budget);
  if (b == null) return { kind: 'none' };
  if (deliveredCents === null || deliveredCents === undefined || !Number.isFinite(Number(deliveredCents))) return { kind: 'unknown' };
  const whole = (v) => Math.max(0, Math.round(Number(v) || 0));
  const d = whole(deliveredCents);
  const o = whole(onOrderCents);
  const n = whole(thisCents);
  const dollars = b / 100;
  if (!n) return { kind: 'month', budget: dollars, delivered: d / 100, onOrder: o / 100 };
  const withThis = d + o + n;
  if (withThis > b) return { kind: 'over', budget: dollars, over: (withThis - b) / 100, onOrder: o / 100 };
  return { kind: 'with', budget: dollars, withThis: withThis / 100, onOrder: o / 100 };
}

// The customer tab's history columns, per CATALOG ITEM, from a building's DELIVERIES (S131: each one,
// whether its order is still open or completed): { [catalogItemId]: { lastDeliveredAt,
// lastDeliveredQty, qty90d } }. Deliveries of one item at one instant (two lines, one act) are one
// delivery of their sum; a line that is no catalog item's (supplyLineCatalogId, through the
// building's list for an older line) is not any item's. Keyed on the catalog item so an item
// switched off and back on keeps its history (D6). `recentFromMs` is the start of the "last 3
// months" window, which the CALLER builds in the ORG's zone
// (startOfDayKey(supplyRecentStartKey(today), tz)) — this module stays zone-free.
export const SUPPLY_RECENT_DAYS = 90;
export function supplyRecentStartKey(todayKey) {
  return addDaysKey(todayKey, -(SUPPLY_RECENT_DAYS - 1));
}
export function supplyItemHistory(requests, { recentFromMs = -Infinity, itemCatalog = null } = {}) {
  const out = {};
  for (const { d } of deliveriesInWindow(requests)) { // newest first
    const id = supplyLineCatalogId(d.line, itemCatalog);
    if (!id) continue;
    const t = new Date(d.at || 0).getTime();
    const row = out[id] || (out[id] = { lastDeliveredAt: null, lastDeliveredQty: 0, qty90d: 0 });
    if (!row.lastDeliveredAt) { row.lastDeliveredAt = d.at; row.lastDeliveredQty = d.qty; }
    else if (new Date(row.lastDeliveredAt).getTime() === t) row.lastDeliveredQty += d.qty; // one instant, one delivery
    if (t >= recentFromMs) row.qty90d += d.qty;
  }
  return out;
}
// The list's items with their history beside them, matched by each row's CATALOG item (D6) — an
// item never delivered reads "not yet" (null, 0, 0), never a borrowed number.
export function withSupplyHistory(items, history = {}) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const h = (history && it && it.catalogItemId && history[it.catalogItemId]) || null;
    return { ...it, lastDeliveredAt: h ? h.lastDeliveredAt : null, lastDeliveredQty: h ? h.lastDeliveredQty : 0, qty90d: h ? h.qty90d : 0 };
  });
}

// The customer tab's "Next order" tile: the building's order day on or after today, as a day
// key in the org's calendar (zone-free label arithmetic; the caller passes today's org-zone key).
export function nextSupplyOrderKey(todayKey, orderDay) {
  const day = clampOrderDay(orderDay) || DEFAULT_SUPPLY_ORDER_DAY;
  const thisMonth = `${todayKey.slice(0, 8)}${String(day).padStart(2, '0')}`;
  return thisMonth >= todayKey ? thisMonth : addMonthsKey(thisMonth, 1);
}

// The words a request is searched by on the server (and the stub): its lines, the note, the
// rejection reason and the names stamped on it — lower-cased once at the write point, so the
// queue's search is one indexed-text match rather than a walk of every row's JSON.
export function supplySearchText(r) {
  return [
    ...(Array.isArray(r && r.lines) ? r.lines.flatMap((l) => [l && l.name, l && l.sku]) : []),
    r && r.note, r && r.rejectionReason,
    r && r.requestedByName, r && r.approvedByName, r && r.rejectedByName, r && r.sentByName, r && r.completedByName,
  ].filter(Boolean).join(' ').toLowerCase().slice(0, 4000);
}

// ── Supplies BY BUILDING (the manager view redesign, Wave B, 2026-10-09; S131 Wave 2) ─────────────
// Matt's boards draw supplies as stock per building (Stocked / Low / Out, "arrives Oct 9",
// Reorder). His own supplies answer keeps no stock-on-hand and no delivery dates (Q5), so SUP-14's
// recommended answer (a) maps the board onto what the app does keep — the orders and the monthly
// budget — and this is that mapping, ONE rule for the route (GET /api/supplies/buildings), its demo
// stub and the page:
//   attention — over this month's budget (SUP-7's own rule: the DELIVERED spend strictly above the
//               budget, isOverSupplyBudget — the same flag the customers list and a customer's page
//               show);
//   pending   — an order waiting for approval (S131 Wave 2: its own state, the board's 4th tile —
//               it was `attention` before);
//   placed    — an approved order with the Supply Manager, or one submitted to the supplier and not
//               yet completed (counted apart as `sent`);
//   allSet    — nothing in flight, and within budget or no budget.
// The louder state wins, in that order: over budget and an order waiting is Needs attention (the
// order still counted as waiting, and still a card), one waiting and one approved is Pending approval.
// "Need attention" in the header's and the manager Home's sense is attention + pending
// (supplyBuildingCounts needAttention).
export const SUPPLY_BUILDING_STATE = Object.freeze({ attention: 'attention', pending: 'pending', placed: 'placed', allSet: 'allSet' });
// The list's order: what needs someone first.
const BUILDING_STATE_ORDER = { attention: 0, pending: 1, placed: 2, allSet: 3 };

// One in-flight ORDER as By building shows it (S131 Wave 2; the AM Hub's board 8), built FIELD BY
// FIELD — never a spread of the order, so no price, total or budget rides along: its number, its phase
// and the account manager's words for it (supplyOrderAmKeys); each line's name and quantity, and once
// it is with the supplier its state from the per-line record, what of it came and a backordered line's
// supplier ETA — the one the Supply Manager typed, the only date a row ever carries; who asked and when;
// and, while it waits for approval, the asker's note (what the approver reads on the card).
export const SUPPLY_BUILDING_ORDER_KEYS = Object.freeze([
  'id', 'number', 'no', 'clientId', 'status', 'phase', 'labelKeys', 'lines', 'requestedByUserId', 'requestedByName', 'createdAt', 'note',
]);
export const SUPPLY_BUILDING_LINE_KEYS = Object.freeze(['name', 'qty', 'state', 'delivered', 'eta']);
function buildingOrderOf(r) {
  const status = supplyStatusOf(r);
  const progress = status === SUPPLY_STATUS.sent ? supplyOrderProgress(r) : null;
  const lines = (Array.isArray(r.lines) ? r.lines : []).map((l, i) => {
    const p = progress ? progress.lines[i] : null;
    return {
      name: String((l && l.name) || ''),
      qty: wholeQty(l && l.qty),
      state: p ? p.state : null,
      delivered: p ? p.delivered : 0,
      eta: p && p.state === SUPPLY_LINE_STATE.backordered ? (p.eta || null) : null,
    };
  });
  const n = Number(r.number);
  return {
    id: r.id,
    number: Number.isInteger(n) && n > 0 ? n : null,
    no: supplyOrderNo(r),
    clientId: r.clientId || null,
    status,
    phase: supplyOrderPhase(r),
    labelKeys: supplyOrderAmKeys(r),
    lines,
    requestedByUserId: r.requestedByUserId || null,
    requestedByName: r.requestedByName || null,
    createdAt: r.createdAt || null,
    note: status === SUPPLY_STATUS.requested ? textOrNull(r.note, 2000) : null,
  };
}

// Which customers are BUILDINGS here: a building we clean now (lib/customerStatus
// isActiveBuilding — no vendor, nothing Inactive or Archived; CS-683), not a lead, and one that
// someone looks after — a manager, a budget, or a request in flight (so nothing waits unseen on a
// building nobody manages). A prospect from the pipeline has none of these and stays out. The
// monthly supply-order reminders read this same rule (lib/opsAlerts getDueSupplyAlerts).
export function isSupplyBuilding(client, { hasOpen = false } = {}) {
  if (!isActiveBuilding(client)) return false;
  if (client.statusOverride === CUSTOMER_STATUS.lead) return false;
  return !!client.supervisorId || supplyBudgetFor(client) != null || !!hasOpen;
}

// Every building in `clients` (the caller's scope) with its one state:
//   { clientId, name, supervisorId, state, waiting, placed, sent, items, approverId, approverName,
//     over, budget, spend, orders }
// `requests` — the IN-FLIGHT requests (anything else is ignored), a COMPLETE read; `spendCents` —
// { clientId → cents } DELIVERED this calendar month in the org's zone (the budgets read);
// `approverOf(clientId)` — lib/notifications resolveSupplyApprover, looked up only for a building
// with something waiting. `items` are the open requests' item names as written, each once
// (case-insensitive), the waiting ones first, then the approved, then the sent, oldest request
// first. `orders` (S131 Wave 2) are the same orders in the same order, each as buildingOrderOf
// shapes it. No row carries a delivery date of its own: the only date on one is a backordered
// line's supplier ETA, the one the Supply Manager typed.
export function supplyBuildingRows({ clients = [], requests = [], spendCents = {}, approverOf = () => null } = {}) {
  const open = new Map(); // clientId → in-flight requests
  for (const r of Array.isArray(requests) ? requests : []) {
    if (!r || !r.clientId || !IN_FLIGHT_KEY[supplyStatusOf(r)]) continue;
    if (!open.has(r.clientId)) open.set(r.clientId, []);
    open.get(r.clientId).push(r);
  }
  const oldestFirst = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id));
  const rows = [];
  for (const c of Array.isArray(clients) ? clients : []) {
    const mine = (c && open.get(c.id)) || [];
    if (!isSupplyBuilding(c, { hasOpen: mine.length > 0 })) continue;
    const waiting = mine.filter((r) => supplyStatusOf(r) === SUPPLY_STATUS.requested).sort(oldestFirst);
    const placed = mine.filter((r) => supplyStatusOf(r) === SUPPLY_STATUS.approved).sort(oldestFirst);
    const sent = mine.filter((r) => supplyStatusOf(r) === SUPPLY_STATUS.sent).sort(oldestFirst);
    const budget = supplyBudgetFor(c);
    const spend = round2(Math.max(0, Math.round(Number(spendCents && spendCents[c.id]) || 0)) / 100);
    const over = isOverSupplyBudget(spend, budget);
    const state = over ? SUPPLY_BUILDING_STATE.attention
      : waiting.length ? SUPPLY_BUILDING_STATE.pending
        : placed.length || sent.length ? SUPPLY_BUILDING_STATE.placed : SUPPLY_BUILDING_STATE.allSet;
    const seen = new Set();
    const items = [];
    for (const r of [...waiting, ...placed, ...sent]) {
      for (const l of r.lines || []) {
        const name = String((l && l.name) || '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        items.push(name);
      }
    }
    const approver = waiting.length ? approverOf(c.id) : null;
    rows.push({
      clientId: c.id, name: c.name || '', supervisorId: c.supervisorId || null, state,
      waiting: waiting.length, placed: placed.length, sent: sent.length, items,
      approverId: (approver && approver.id) || null, approverName: (approver && approver.name) || null,
      over, budget, spend,
      orders: [...waiting, ...placed, ...sent].map(buildingOrderOf),
    });
  }
  return rows.sort((a, b) => BUILDING_STATE_ORDER[a.state] - BUILDING_STATE_ORDER[b.state]
    || a.name.localeCompare(b.name) || String(a.clientId).localeCompare(String(b.clientId)));
}

// ── The driver's list and the cleaners' line, PER LINE (S131; the delivery step's readers) ────────
// ONE shape each for the route (GET /api/supplies/deliveries and /onsite) and its demo stub, so a
// field that must never reach a driver or a cleaner cannot be added in one place and not the
// other. Both build NEW objects field by field — never a spread of an order — so a price, a total,
// a budget, a note or a full name has no way through.
const byTime = (key, dir = 1) => (a, b) => dir * String(a[key] || '').localeCompare(String(b[key] || '')) || String(a.id).localeCompare(String(b.id));

// An order's deliveries since `dayStartMs`, per line summed, with the latest act's time and who:
// { items: [{ line, name, sku, qty }], at, byName } — or null when nothing came today.
function deliveredSince(r, dayStartMs) {
  const today = supplyDeliveries(r).filter((d) => new Date(d.at || 0).getTime() >= dayStartMs);
  if (!today.length) return null;
  const byLine = new Map();
  for (const d of today) {
    const row = byLine.get(d.index) || { line: d.index, name: (d.line && d.line.name) || '', sku: (d.line && d.line.sku) || null, qty: 0 };
    row.qty += d.qty;
    byLine.set(d.index, row);
  }
  const latest = today.slice().sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))[0];
  return { items: [...byLine.values()].sort((a, b) => a.line - b.line), at: latest.at || null, byName: latest.byName || null };
}

// THE DRIVER'S LIST (supplies.deliver, the delivery step's S4, per line since S131). `requests` — the
// SUBMITTED orders and any with a delivery since `dayStartMs` (the org-zone start of today), any
// others are ignored; `buildingOf(clientId)` — { name, address } of the building (the route's, from
// the shared record). Every submitted order with something still to come, oldest submitted first
// (the van is loaded in that order): its number, its building, each line still to come with how
// many and whether it is backordered (and its ETA), who submitted it and when, and its `version`
// (the per-line Delivered is a compare-and-swap); then what was delivered today, newest first, with
// who delivered it. No money anywhere (S3: "Holding it reveals no prices and no budgets").
export function supplyDeliveryList({ requests = [], buildingOf = () => null, dayStartMs = -Infinity } = {}) {
  const building = (id) => {
    const b = buildingOf(id) || {};
    return { name: b.name || '', address: b.address || '' };
  };
  const list = Array.isArray(requests) ? requests.filter(Boolean) : [];
  const toDeliver = list.filter((r) => supplyStatusOf(r) === SUPPLY_STATUS.sent)
    .map((r) => {
      const items = supplyOrderProgress(r).lines.filter((l) => l.remaining > 0)
        .map((l) => ({ line: l.index, name: l.name || '', sku: l.sku || null, qty: l.remaining, state: l.state, eta: l.eta || null }));
      return {
        id: r.id, no: supplyOrderNo(r), version: r.version ?? 1, clientId: r.clientId || null, building: building(r.clientId), items,
        itemCount: items.reduce((a, l) => a + l.qty, 0), sentAt: r.sentAt || null, sentByName: r.sentByName || null,
      };
    })
    .filter((r) => r.items.length)
    .sort(byTime('sentAt'));
  const deliveredToday = list.map((r) => {
    const today = deliveredSince(r, dayStartMs);
    if (!today) return null;
    const items = today.items.map((l) => ({ name: l.name, qty: l.qty }));
    return {
      id: r.id, no: supplyOrderNo(r), clientId: r.clientId || null, building: building(r.clientId), items,
      itemCount: items.reduce((a, l) => a + l.qty, 0), deliveredAt: today.at, deliveredByName: today.byName,
    };
  }).filter(Boolean).sort(byTime('deliveredAt', -1));
  return { toDeliver, deliveredToday };
}

// THE CLEANERS' LINE (the delivery step's S6; PER LINE since S131 Builder C — Matt's board: "Paper
// towels delivered today at 9:15 AM · Trash liners backordered, ETA Oct 21"), for the buildings
// `clientIds` (a Set: the ones the cleaner cleans today, lib/crewScope crewTodayClientIds). Per
// building, the line every cleaner there reads:
//   delivered   — each LINE delivered TODAY (since `dayStartMs`, the org-zone start of today): its
//                 name, how many came today and when the last of it came; newest first;
//   backordered — each submitted line still to come that the supplier has on backorder: its name,
//                 how many are still to come and the supplier's day (`eta`, a day key); soonest first;
//   onTheWay    — every other submitted line still to come (not backordered, not cancelled), one per
//                 item name with its quantities summed, by name.
// Item names and quantities only: never a price, a budget, a SKU, a note, a reason or a person's name.
// Only buildings with something to say.
export function supplyCrewBuildings({ requests = [], clientIds = new Set(), dayStartMs = -Infinity } = {}) {
  const ids = clientIds instanceof Set ? clientIds : new Set(Array.isArray(clientIds) ? clientIds : []);
  const byClient = new Map();
  const row = (id) => {
    if (!byClient.has(id)) byClient.set(id, { clientId: id, delivered: [], backordered: new Map(), onTheWay: new Map() });
    return byClient.get(id);
  };
  for (const r of Array.isArray(requests) ? requests : []) {
    if (!r || !ids.has(r.clientId)) continue;
    const sent = supplyStatusOf(r) === SUPPLY_STATUS.sent;
    for (const l of supplyOrderProgress(r).lines) {
      const name = l.name || '';
      const today = l.deliveries.filter((d) => new Date(d.at || 0).getTime() >= dayStartMs);
      if (today.length) {
        const at = today.map((d) => d.at).sort().pop();
        row(r.clientId).delivered.push({ name, qty: today.reduce((a, d) => a + d.qty, 0), at });
      }
      if (!sent || l.remaining <= 0) continue;
      if (l.state === SUPPLY_LINE_STATE.backordered) {
        const key = `${name.toLowerCase()}|${l.eta || ''}`;
        const b = row(r.clientId).backordered;
        const was = b.get(key);
        b.set(key, { name, qty: (was ? was.qty : 0) + l.remaining, eta: l.eta || null });
      } else {
        const w = row(r.clientId).onTheWay;
        const was = w.get(name.toLowerCase());
        w.set(name.toLowerCase(), { name: was ? was.name : name, qty: (was ? was.qty : 0) + l.remaining });
      }
    }
  }
  const etaOrder = (a, b) => (a.eta === b.eta ? 0 : !a.eta ? 1 : !b.eta ? -1 : a.eta.localeCompare(b.eta));
  return [...byClient.values()]
    .map((b) => ({
      clientId: b.clientId,
      delivered: b.delivered.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')) || x.name.localeCompare(y.name)),
      backordered: [...b.backordered.values()].sort((x, y) => etaOrder(x, y) || x.name.localeCompare(y.name)),
      onTheWay: [...b.onTheWay.values()].sort((x, y) => x.name.localeCompare(y.name)),
    }))
    .filter((b) => b.delivered.length || b.backordered.length || b.onTheWay.length)
    .sort((a, b) => String(a.clientId).localeCompare(String(b.clientId)));
}

// ── THE CLEANER ORDERS SUPPLIES (the Cleaner Hub, D4, 2026-10-13; rebuilt to Matt's RequestSupplies
// board by S131 Builder C, 2026-10-14 — plan docs/plans/2026-10-14-supply-orders.md §4) ──────────
// A cleaner holds `supplies.request` (lib/roles) and orders by QUANTITY from ONE building's switched-on
// list ("Only products approved for this property are shown" — no "Other", SUP-3 a); the account
// manager approves. They read back their OWN orders there (GET /api/supplies/crew-list), one of them
// (GET crew-order, EP-400) and their newest ones for Home's tile (GET crew-orders, EP-401), and the
// demo stub reads the same. 🔴 EVERY SHAPE BELOW IS BUILT FIELD BY FIELD, never by spreading a row: a
// price, a total, a budget, a note, a comment, an invoice, a photo, a SKU on a line or a full name
// has no way through (Daniel, 2026-10-14: cleaners never see prices).

// What the cleaner's page needs of an item: its row id (what an order names), its catalog item, its
// words, and the product's PHOTO LINK (S131: the route signs it — api/_lib/supplies/catalogImage
// withCatalogImageUrls; null with none). NO price.
export const SUPPLY_CREW_ITEM_KEYS = Object.freeze(['id', 'catalogItemId', 'name', 'unit', 'category', 'sku', 'imageUrl']);

// One of the cleaner's orders, and each of its lines, as the cleaner reads them — exactly these keys:
//   id · no ("SO-1047") · clientId · status (the stored one) · fulfillmentState (the per-line record's
//   state, COMPUTED — pending | partial | ready | null — so supplyOrderLabelKey(order, 'crew') reads the
//   same words from this shape as from the full row) · lines · who asked, approved or declined it
//   ("First L.") and when · the decline's reason (the same words the cleaner's bell carried).
// A line: its name, the quantity asked, its state (lib/supplies supplyLineState: pending ·
// backordered · delivered · cancelled), how many came, the supplier's ETA only while backordered, and
// when the last of it came — and, for a line the office could not get, the office's reason (S131
// integration: the cleaner's supplyItemCancelled bell already says it, so the order says it too).
export const SUPPLY_CREW_ORDER_KEYS = Object.freeze([
  'id', 'no', 'clientId', 'status', 'fulfillmentState', 'lines',
  'requestedAt', 'requestedBy', 'approvedAt', 'approvedBy', 'declinedAt', 'declinedBy', 'declineReason',
]);
export const SUPPLY_CREW_LINE_KEYS = Object.freeze(['name', 'qty', 'state', 'delivered', 'eta', 'deliveredAt', 'reason']);
// The history the cleaner's page shows for a building, and the most any crew read answers.
export const CREW_SUPPLY_HISTORY_MAX = 10;

// The latest of a line's deliveries (ISO strings of one format compare as time), or null.
const lastDeliveryAt = (deliveries) => (Array.isArray(deliveries) ? deliveries : [])
  .reduce((m, d) => (d && d.at && (!m || d.at > m) ? d.at : m), null);

export function supplyCrewOrder(r) {
  if (!r) return null;
  const progress = supplyOrderProgress(r);
  const status = supplyStatusOf(r);
  return {
    id: r.id,
    no: supplyOrderNo(r),
    clientId: r.clientId || null,
    status,
    fulfillmentState: progress.state,
    lines: progress.lines.map((l) => ({
      name: l.name || '',
      qty: wholeQty(l.qty),
      state: l.state,
      delivered: l.delivered,
      eta: l.state === SUPPLY_LINE_STATE.backordered ? (l.eta || null) : null,
      deliveredAt: lastDeliveryAt(l.deliveries),
      reason: l.state === SUPPLY_LINE_STATE.cancelled ? ((l.cancelled && l.cancelled.reason) || null) : null,
    })),
    requestedAt: r.createdAt || null,
    requestedBy: hubPersonName(r.requestedByName) || null,
    approvedAt: r.approvedAt || null,
    approvedBy: hubPersonName(r.approvedByName) || null,
    declinedAt: r.rejectedAt || null,
    declinedBy: hubPersonName(r.rejectedByName) || null,
    declineReason: status === SUPPLY_STATUS.rejected ? (r.rejectionReason || null) : null,
  };
}

// The orders `userId` asked for, among `requests`, newest first, at most `max` — each field by field.
// No person, no orders: the reader's identity is the caller's to give (the route reads the claim).
export function supplyCrewOrders(requests, { userId = null, max = CREW_SUPPLY_HISTORY_MAX } = {}) {
  if (!userId) return [];
  const cap = Number.isInteger(max) && max > 0 ? Math.min(max, CREW_SUPPLY_HISTORY_MAX) : CREW_SUPPLY_HISTORY_MAX;
  return (Array.isArray(requests) ? requests : [])
    .filter((r) => r && r.requestedByUserId === userId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.id).localeCompare(String(b.id)))
    .slice(0, cap)
    .map(supplyCrewOrder);
}

// 🔴 WHO MAY READ ONE ORDER through the crew's door (EP-400; the route and the demo stub read this ONE
// rule): an OFFICE caller any (the owner's View-as a cleaner reads through it); anyone else only their
// OWN order (`requestedByUserId`, from the login's claim) at a building they clean today or upcoming
// (`buildingIds`: lib/crewScope crewUpcomingClientIds, EP-385's building rule). Everything else is the
// same "not found", naming nothing.
export function crewMayReadOrder({ order = null, selfId = null, office = false, buildingIds = new Set() } = {}) {
  if (!order) return false;
  if (office) return true;
  if (!selfId || order.requestedByUserId !== selfId) return false;
  const ids = buildingIds instanceof Set ? buildingIds : new Set(Array.isArray(buildingIds) ? buildingIds : []);
  return ids.has(order.clientId);
}

// One building, for the cleaner: `items` (its switched-on list, each with its photo link), `approverName`
// (who approves its orders, "First L." — the success line's "{name} approves it next") and `orders`
// (the cleaner's OWN orders there, newest first, at most CREW_SUPPLY_HISTORY_MAX: the "Your last order"
// card and the Order History).
export function supplyCrewList({ items = [], requests = [], userId = null, approverName = null } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean).map((it) => ({
    id: it.id, catalogItemId: it.catalogItemId || null, name: it.name || '', unit: it.unit || '',
    category: it.category || null, sku: it.sku || null, imageUrl: typeof it.imageUrl === 'string' && it.imageUrl ? it.imageUrl : null,
  }));
  return { items: list, approverName: approverName || null, orders: supplyCrewOrders(requests, { userId }) };
}

// An order's items as a cleaner reads them in the answer to their own create: names and quantities —
// what is STILL TO COME once it is submitted, what was DELIVERED once it is completed, else what was
// asked for.
const crewItemsOf = (r) => {
  const s = supplyStatusOf(r);
  if (s === SUPPLY_STATUS.sent) {
    return supplyOrderProgress(r).lines.filter((l) => l.remaining > 0).map((l) => ({ name: l.name || '', qty: l.remaining }));
  }
  if (s === SUPPLY_STATUS.completed) {
    return supplyOrderProgress(r).lines.filter((l) => l.delivered > 0).map((l) => ({ name: l.name || '', qty: l.delivered }));
  }
  return (Array.isArray(r && r.lines) ? r.lines : [])
    .filter((l) => l && Number(l.qty) > 0).map((l) => ({ name: l.name || '', qty: Math.floor(Number(l.qty)) }));
};

// The answer to a cleaner's own request (requests/create, for a caller WITHOUT supplies.view): its
// id, building, state, when, and its items as names and quantities. No money.
export function supplyCrewRequest(r) {
  if (!r) return null;
  return { id: r.id, clientId: r.clientId || null, status: supplyStatusOf(r), items: crewItemsOf(r), createdAt: r.createdAt || null };
}

// The cleaner's page: a − n + stepper per item, 0 (not ordered) to CREW_SUPPLY_MAX_QTY — the SERVER's
// cap too (S131: a line past it is refused `over_cap` by snapshotSupplyLines, never clamped); the
// office's order sheet keeps SUPPLY_MAX_QTY. 0 by default.
export const CREW_SUPPLY_MAX_QTY = 20;
export function crewSupplyQty(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(CREW_SUPPLY_MAX_QTY, n);
}

// Why Submit for Approval is off, or null when it may go: an order is items from the building's list
// at a quantity above 0 (no open-ended request, SUP-3 a).
//   nothing_picked   no item above 0
export function crewSupplySendBlock({ lines = [] } = {}) {
  const picked = (Array.isArray(lines) ? lines : []).filter((l) => l && l.itemId && Number(l.qty) > 0);
  return picked.length ? null : 'nothing_picked';
}

// By building's counts: the buildings in each state, how many there are, and `needAttention` — the
// ones over budget AND the ones with an order waiting for approval (S131 Wave 2), the header's
// "N need attention" and the manager Home's Supplies tile and nav pill (lib/managerHome
// suppliesFigures), so the tile and the page it opens say the same number.
export function supplyBuildingCounts(rows) {
  const out = { attention: 0, pending: 0, placed: 0, allSet: 0, total: 0, needAttention: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !(r.state in BUILDING_STATE_ORDER)) continue;
    out[r.state] += 1;
    out.total += 1;
  }
  out.needAttention = out.attention + out.pending;
  return out;
}

// 🔴 "AWAITING YOUR APPROVAL" (S131 Wave 2; the AM Hub's board 8): every WAITING order in By
// building's rows that THIS viewer may decide — `mayDecide(order)` is the caller's maySupplyDecide
// (approve) with the building's approver and their operations manager (hooks/useSupplyRules), the one
// rule the route and the queue's bulk bar read — oldest first (the longest waiting), each with its
// building's id and name. Its length is the page's 4th tile, "Pending approval". Pure.
export function supplyAwaitingApproval(rows, mayDecide = () => false) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const o of (r && Array.isArray(r.orders) ? r.orders : [])) {
      if (o && o.status === SUPPLY_STATUS.requested && mayDecide(o)) out.push({ ...o, clientId: o.clientId || r.clientId, buildingName: r.name || '' });
    }
  }
  return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
}
