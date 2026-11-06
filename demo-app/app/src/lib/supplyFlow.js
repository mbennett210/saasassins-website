// Pure pieces of a supply ORDER's lifecycle: the PATCH one decision or one set of per-line acts
// writes, and the bell rows each raises. The supplies route (api/supplies + api/_lib/supplies/
// store.js) is the one writer; its demo stub (lib/suppliesApi.js) runs the same patches, so the
// demo's stamps are the real ones. Pure and node-importable, so the flow is tested by EXECUTION.
//
// 🔴 SUP-1 (b), Matt 2026-09-29: "Yes — someone approves, then the office fills."
// 🔴 THE SUPPLY ORDERS (S131, Matt's 2026-10-13 email and boards; plan
//    docs/plans/2026-10-14-supply-orders.md §1):
//    requested → approved (or declined, with a reason) → SUBMITTED TO SUPPLIER (the stored `sent`,
//    by the Supply Manager) → each line delivered (in parts or whole), backordered with the
//    supplier's ETA, or cancelled with a reason → COMPLETED, only once every line is delivered or
//    cancelled (never automatically: the Supply Manager marks it).
// 🔴 SUP-9 ★a / S131: the approver is the building's ACCOUNT MANAGER, else the one person named in
//    Settings → Operations (lib/notifications resolveSupplyApprover).
// 🔴 SUP-11 / S131: WHO may move an order is lib/supplies maySupplyDecide — the route asks it. This
//    module only refuses moves the STATE MACHINE forbids, because it is the write point.
//
// The bell rows are written into org_state by the route with the CAS loop every other server
// notifier uses (api/_lib/qc/store.js notifyTicketRaised).
import {
  nextSupplyStatus, supplyStatusOf, supplyRequestTotal, supplyRequestItemCount, SUPPLY_STATUS,
  supplyEmptyFulfillment, supplyFulfillmentOf, supplyFulfillmentStateOf, supplyLineState, supplyOrderProgress,
  supplyOrderNo, supplyEtaError, supplyEtaInstant, SUPPLY_LINE_STATE, SUPPLY_DELIVERY_VIA,
  SUPPLY_CANCEL_REASON_MIN, SUPPLY_CANCEL_REASON_MAX, SUPPLY_FULFILL_MAX_ACTS,
  SUPPLY_DECLINE_REASON_MIN, SUPPLY_DECLINE_REASON_MAX,
} from './supplies.js';
import { fanOutToUserIds, fanOutManagerAlert, resolveSupplyApprover, SUPPLY_ORDER_EVENTS } from './notifications.js';
import { crewPaths } from './crewPaths.js';
import { msg } from '../i18n/core.js';

// The fields each decision stamps. A decision CLEARS the stamps of the states it leaves, so a
// reopened order never shows a stale approver, submitter or decline reason it no longer carries —
// a kept name credits the wrong person for the next decision. The legacy sent record (the delivery
// step's `sentLines` / `sentTotalCents`) is never WRITTEN any more (plan §2); it is cleared with the
// rest, so a reopened order carries none.
const CLEARED = {
  approvedAt: null, approvedByUserId: null, approvedByName: null,
  rejectedAt: null, rejectedByUserId: null, rejectedByName: null, rejectionReason: null,
  sentAt: null, sentByUserId: null, sentByName: null, sentLines: null, sentTotalCents: null,
  fulfillment: null, fulfillmentState: null,
  completedAt: null, completedByUserId: null, completedByName: null,
};
const keep = (request, keys) => Object.fromEntries(keys.map((k) => [k, (request && request[k] !== undefined) ? request[k] : null]));
const APPROVAL = ['approvedAt', 'approvedByUserId', 'approvedByName'];
const SUBMITTED = ['sentAt', 'sentByUserId', 'sentByName'];

/**
 * The change ONE decision makes to ONE order, or a refusal.
 *
 * @param request   the order as stored (app shape)
 * @param decision  'approve' | 'reject' | 'submit' | 'complete' | 'reopen'
 * @param byUserId  who is deciding (the caller's verified claim, never a body field)
 * @param byName    their name NOW, snapshotted onto the row so a later delete needs no cascade
 * @param reason    the decline reason — REQUIRED for 'reject' (SUP-1 b: "rejected with a reason"),
 *                  at least SUPPLY_DECLINE_REASON_MIN characters once trimmed (S131 Wave 2)
 * @param now       the ISO instant to stamp
 * @returns { patch, from, to } — the fields to write (status + stamps) — or { refused } with a code:
 *          'not_found' · 'illegal_move' (not reachable from where it is, or no move at all) ·
 *          'reason_required' · 'lines_open' (complete before every line is delivered or cancelled) ·
 *          'has_deliveries' (reopen once something was delivered)
 */
export function supplyDecisionPatch(request, decision, { byUserId = null, byName = null, reason = '', now } = {}) {
  if (!request) return { refused: 'not_found' };
  const from = supplyStatusOf(request);
  const to = nextSupplyStatus(from, decision);
  if (!to || to === from) return { refused: 'illegal_move' };
  const trimmedReason = typeof reason === 'string' ? reason.trim().slice(0, SUPPLY_DECLINE_REASON_MAX) : '';
  if (decision === 'reject' && trimmedReason.length < SUPPLY_DECLINE_REASON_MIN) return { refused: 'reason_required' };
  const progress = from === SUPPLY_STATUS.sent ? supplyOrderProgress(request) : null;
  // 🔴 THE COMPLETION GATE (Matt's board: "1 item backordered — complete delivery to unlock").
  if (decision === 'complete' && !(progress && progress.ready)) return { refused: 'lines_open' };
  // A reopen is the office's correction until something arrives; a delivery is usage and spend.
  if (decision === 'reopen' && progress && progress.lines.some((l) => l.delivered > 0)) return { refused: 'has_deliveries' };

  const stamp = now || new Date().toISOString();
  const patch = { ...CLEARED, status: to };
  if (decision === 'approve') { patch.approvedAt = stamp; patch.approvedByUserId = byUserId; patch.approvedByName = byName; }
  if (decision === 'reject') {
    patch.rejectedAt = stamp; patch.rejectedByUserId = byUserId; patch.rejectedByName = byName;
    patch.rejectionReason = trimmedReason;
  }
  if (decision === 'submit') {
    // "Submitted to supplier": who and when, and every line pending — no quantities (plan §2). The
    // approval stamps stay: "who approved this spend" is the audit trail the budget rests on.
    Object.assign(patch, keep(request, APPROVAL));
    patch.sentAt = stamp; patch.sentByUserId = byUserId; patch.sentByName = byName;
    patch.fulfillment = supplyEmptyFulfillment(request.lines);
    patch.fulfillmentState = 'pending';
  }
  if (decision === 'complete') {
    // COMPLETED keeps who approved it, who submitted it and every line's record — the history.
    Object.assign(patch, keep(request, APPROVAL), keep(request, SUBMITTED));
    patch.fulfillment = supplyFulfillmentOf(request);
    patch.fulfillmentState = 'ready';
    patch.completedAt = stamp; patch.completedByUserId = byUserId; patch.completedByName = byName;
  }
  return { patch, from, to };
}

/**
 * 🔴 THE PER-LINE ACTS on a SUBMITTED order (plan §1 step 4): each act names a line by its index in
 * `lines` and is one of
 *   deliver   — `qty` 1..remaining (default: the rest), stamped with who, when and `via` (office |
 *               driver);
 *   backorder — `eta`, a day in the org's calendar from `todayKey` on (the supplier's ETA; a new
 *               backorder replaces the last, so an ETA can move);
 *   cancel    — `reason`, 3–300 characters (a discontinued item — Daniel's answer 4).
 * Acts run in order against the record as it changes, and ALL land or NONE does: the first refusal
 * returns { refused, line } and nothing is written. A resolved line (delivered in full or cancelled)
 * takes no act. An order submitted before the per-line record starts its record here.
 *
 * @returns { patch: { fulfillment, fulfillmentState }, applied: [{ line, act, qty? | eta? | reason? }] }
 *          or { refused: 'not_found' | 'not_submitted' | 'no_acts' | 'too_many' | 'bad_line' |
 *          'bad_act' | 'line_resolved' | 'bad_qty' | 'bad_eta' | 'bad_reason', line? }
 */
export const SUPPLY_LINE_ACTS = Object.freeze(['deliver', 'backorder', 'cancel']);
export function supplyFulfillPatch(request, acts, { byUserId = null, byName = null, via = 'office', now, todayKey = null } = {}) {
  if (!request) return { refused: 'not_found' };
  if (supplyStatusOf(request) !== SUPPLY_STATUS.sent) return { refused: 'not_submitted' };
  const list = Array.isArray(acts) ? acts : [];
  if (!list.length) return { refused: 'no_acts' };
  if (list.length > SUPPLY_FULFILL_MAX_ACTS) return { refused: 'too_many' };
  const lines = Array.isArray(request.lines) ? request.lines : [];
  const f = (supplyFulfillmentOf(request) || supplyEmptyFulfillment(lines)).map((e) => ({ ...e, deliveries: [...e.deliveries] }));
  const stamp = now || new Date().toISOString();
  const who = { byUserId: byUserId || null, byName: byName || null };
  const how = SUPPLY_DELIVERY_VIA.includes(via) ? via : 'office';
  const applied = [];
  for (const a of list) {
    const i = a && Number.isInteger(a.line) ? a.line : Number.NaN;
    if (!Number.isInteger(i) || i < 0 || i >= lines.length) return { refused: 'bad_line', line: a && a.line !== undefined ? a.line : null };
    if (!SUPPLY_LINE_ACTS.includes(a.act)) return { refused: 'bad_act', line: i };
    const st = supplyLineState(lines[i], f[i]);
    if (st.state === SUPPLY_LINE_STATE.delivered || st.state === SUPPLY_LINE_STATE.cancelled) return { refused: 'line_resolved', line: i };
    if (a.act === 'deliver') {
      const raw = a.qty;
      const qty = raw === undefined || raw === null ? st.remaining
        : typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN);
      if (!Number.isInteger(qty) || qty < 1 || qty > st.remaining) return { refused: 'bad_qty', line: i };
      f[i].deliveries.push({ qty, at: stamp, ...who, via: how });
      applied.push({ line: i, act: 'deliver', qty });
    } else if (a.act === 'backorder') {
      const err = supplyEtaError(a.eta, todayKey);
      if (err) return { refused: err, line: i };
      f[i].backorder = { at: stamp, ...who, eta: a.eta };
      applied.push({ line: i, act: 'backorder', eta: a.eta });
    } else {
      const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
      if (reason.length < SUPPLY_CANCEL_REASON_MIN || reason.length > SUPPLY_CANCEL_REASON_MAX) return { refused: 'bad_reason', line: i };
      f[i].cancelled = { at: stamp, ...who, reason };
      applied.push({ line: i, act: 'cancel', reason });
    }
  }
  return { patch: { fulfillment: f, fulfillmentState: supplyFulfillmentStateOf(lines, f) }, applied };
}

// ── who hears about it ─────────────────────────────────────────────────────────
// The link a bell opens, per reader: a cleaner's own order screen in the Cleaner Hub, the office's
// order page for everyone else (the crew shell draws no office route).
export function supplyOrderLinkFor(user, requestId) {
  return user && user.role === 'crew' ? crewPaths.supplyOrder(requestId) : `/supplies/orders/${encodeURIComponent(requestId)}`;
}
const linkTo = (request) => (user) => supplyOrderLinkFor(user, request.id);
// The order's number for a bell ("SO-1047"), or the word "Order" for one without.
const orderNo = (request) => supplyOrderNo(request) || msg('alerts.supply.orderWord');
const placeOf = (state, request) => {
  const client = (state.clients || []).find((c) => c.id === request.clientId) || null;
  return client && client.name ? client.name : msg('alerts.supply.aLocation');
};
// The people an order's news goes to: the cleaner (or whoever) who asked, and the building's account
// manager (its resolved approver) — never twice, the actor never (the fan-out skips them).
const askerAndManager = (state, request) => {
  const approver = resolveSupplyApprover(state, request.clientId);
  return [...new Set([request.requestedByUserId, approver && approver.id].filter(Boolean))];
};
// One line as a bell names it: "Paper towels ×3", and a backordered one with its ETA.
const itemQty = (name, qty) => msg('alerts.supply.itemQty', { item: name || msg('alerts.supply.anItem'), qty });
const itemStillToCome = (l) => (l.state === SUPPLY_LINE_STATE.backordered && l.eta
  ? msg('alerts.supply.itemEta', { item: l.name || msg('alerts.supply.anItem'), eta: supplyEtaInstant(l.eta) })
  : msg('alerts.supply.itemQty', { item: l.name || msg('alerts.supply.anItem'), qty: l.remaining }));

/**
 * The notifications ONE applied decision raises, onto a store snapshot (the org_state the route
 * just read):
 *   approve  → the person who ASKED (`supplyOrderApproved`) and every SUPPLY MANAGER
 *              (`supplyRequestApproved`: "a new approved order") — or, with no Supply Manager on the
 *              team, whoever holds supplies.manage, as before (plan §3)
 *   reject   → the person who asked (`supplyOrderDeclined`), with the reason
 *   complete → the person who asked AND the building's account manager (`supplyOrderCompleted`)
 *   submit · reopen → nobody (both screens show a submit; a reopen is an office correction).
 * Every row is gated on the event's catalog visibility and the recipient's own pref inside the
 * fan-out helpers, and the ACTOR is always skipped (a self-decision needs no bell). The cleaner's
 * events carry no role allowlist (Matt: "very important"); a cleaner's link opens their own order
 * screen (supplyOrderLinkFor).
 *
 * @param state     { users, clients, permissions, userPermissionOverrides, opsSettings, notifications }
 * @param request   the order AFTER the decision (app shape)
 * @returns the next notifications array (the same array when nobody is to be told)
 */
export function supplyDecisionNotifications(state, { request, decision, actorUserId = null }) {
  const base = state.notifications || [];
  if (!request) return base;
  const place = placeOf(state, request);
  const no = orderNo(request);
  const url = linkTo(request);
  const count = supplyRequestItemCount(request);
  if (decision === 'approve') {
    const actor = (state.users || []).find((u) => u.id === actorUserId) || null;
    const toAsker = fanOutToUserIds(state, {
      userIds: [request.requestedByUserId].filter(Boolean), eventKey: SUPPLY_ORDER_EVENTS.approved,
      title: msg('alerts.supply.orderApprovedTitle', { no, place }), body: msg('alerts.supply.orderItems', { count }),
      url, actorUserId,
    });
    // "New approved order": the Supply Managers, else the supplies.manage fan-out.
    const copy = {
      eventKey: 'supplyRequestApproved',
      title: msg('alerts.supply.approvedTitle', { place }),
      body: actor
        ? msg('alerts.supply.approvedBodyBy', { count, amount: supplyRequestTotal(request), name: actor.name })
        : msg('alerts.supply.approvedBody', { count, amount: supplyRequestTotal(request) }),
      url: `/supplies/orders/${encodeURIComponent(request.id)}`,
      actorUserId,
    };
    const next = { ...state, notifications: toAsker };
    const supplyManagers = (state.users || []).filter((u) => u && u.status === 'active' && u.role === 'supply_manager').map((u) => u.id);
    return supplyManagers.length
      ? fanOutToUserIds(next, { ...copy, userIds: supplyManagers })
      : fanOutManagerAlert(next, copy);
  }
  if (decision === 'reject') {
    const reason = request.rejectionReason || '';
    return fanOutToUserIds(state, {
      userIds: [request.requestedByUserId].filter(Boolean), eventKey: SUPPLY_ORDER_EVENTS.declined,
      title: msg('alerts.supply.orderDeclinedTitle', { no, place }),
      body: reason ? msg('alerts.supply.orderDeclinedBody', { reason }) : msg('alerts.supply.orderItems', { count }),
      url, actorUserId,
    });
  }
  if (decision === 'complete') {
    return fanOutToUserIds(state, {
      userIds: askerAndManager(state, request), eventKey: SUPPLY_ORDER_EVENTS.completed,
      title: msg('alerts.supply.orderCompletedTitle', { no, place }), body: msg('alerts.supply.orderCompletedBody'),
      url, actorUserId,
    });
  }
  return base; // submit and reopen tell nobody
}

/**
 * The notifications ONE set of per-line acts raises (supplyFulfillPatch's `applied`), onto a store
 * snapshot: the person who asked AND the building's account manager, ONE bell each per kind of act —
 * never one per line (plan §3):
 *   deliveries → `supplyItemsDelivered` — what came ("Delivered to Bayside Tower: Paper towels ×3"),
 *                and what is still to come, a backordered line with its ETA;
 *   backorders → `supplyItemBackordered` — which lines, each with its ETA;
 *   cancels    → `supplyItemCancelled` — which lines, and the reason.
 * The actor is skipped (the Supply Manager or the driver who did it).
 *
 * @param request   the order AFTER the acts (app shape)
 */
export function supplyFulfillNotifications(state, { request, applied = [], actorUserId = null }) {
  let notifications = state.notifications || [];
  if (!request || !Array.isArray(applied) || !applied.length) return notifications;
  const place = placeOf(state, request);
  const no = orderNo(request);
  const url = linkTo(request);
  const userIds = askerAndManager(state, request);
  const progress = supplyOrderProgress(request);
  const lineOf = (i) => progress.lines[i] || {};
  const send = (eventKey, title, body) => {
    notifications = fanOutToUserIds({ ...state, notifications }, { userIds, eventKey, title, body, url, actorUserId });
  };
  const delivered = applied.filter((a) => a.act === 'deliver');
  if (delivered.length) {
    const byLine = new Map();
    for (const a of delivered) byLine.set(a.line, (byLine.get(a.line) || 0) + a.qty);
    const items = [...byLine.entries()].map(([i, qty]) => itemQty(lineOf(i).name, qty));
    const rest = progress.lines.filter((l) => l.remaining > 0);
    send(SUPPLY_ORDER_EVENTS.delivered,
      msg('alerts.supply.deliveredItemsTitle', { place, items }),
      rest.length ? msg('alerts.supply.deliveredRest', { no, items: rest.map(itemStillToCome) }) : msg('alerts.supply.deliveredAllIn', { no }));
  }
  const backordered = applied.filter((a) => a.act === 'backorder');
  if (backordered.length) {
    const items = [...new Set(backordered.map((a) => a.line))].map((i) => {
      const l = lineOf(i);
      return msg('alerts.supply.itemEta', { item: l.name || msg('alerts.supply.anItem'), eta: supplyEtaInstant(l.eta) });
    });
    send(SUPPLY_ORDER_EVENTS.backordered, msg('alerts.supply.backorderedTitle', { place, items }), msg('alerts.supply.orderRef', { no }));
  }
  const cancelled = applied.filter((a) => a.act === 'cancel');
  if (cancelled.length) {
    const items = [...new Set(cancelled.map((a) => a.line))].map((i) => lineOf(i).name || msg('alerts.supply.anItem'));
    send(SUPPLY_ORDER_EVENTS.cancelled, msg('alerts.supply.itemCancelledTitle', { place, items }),
      msg('alerts.supply.itemCancelledBody', { no, reason: cancelled[0].reason || '' }));
  }
  return notifications;
}

/**
 * The notifications a CANCEL raises (CS-670, Daniel 2026-10-12): the REQUESTER, and the building's
 * APPROVER (resolveSupplyApprover) — the canceller is skipped, so a requester withdrawing their own
 * request tells the approver, an approver cancelling tells the requester, and the office cancelling
 * tells both. Nobody else: a cancel only happens before the order goes out (lib/supplies
 * isSupplyCancellable), so no driver or cleaner was ever waiting on it. Before, a cancel told nobody.
 *
 * @param state     { users, clients, permissions, userPermissionOverrides, opsSettings, notifications }
 * @param request   the request as it was before the cancel (app shape) — it is gone after it
 * @returns the next notifications array (the same array when nobody is to be told)
 */
export function supplyCancelNotifications(state, { request, actorUserId = null } = {}) {
  if (!request) return state.notifications || [];
  const client = (state.clients || []).find((c) => c.id === request.clientId) || null;
  const actor = (state.users || []).find((u) => u.id === actorUserId) || null;
  const approver = resolveSupplyApprover(state, request.clientId);
  const count = supplyRequestItemCount(request);
  return fanOutToUserIds(state, {
    userIds: [request.requestedByUserId, approver && approver.id].filter(Boolean),
    eventKey: 'supplyRequestCancelled',
    title: msg('alerts.supply.cancelledTitle', { place: client ? client.name : msg('alerts.supply.aLocation') }),
    body: actor
      ? msg('alerts.supply.cancelledBodyBy', { count, name: actor.name })
      : msg('alerts.supply.cancelledBody', { count }),
    url: '/supplies',
    actorUserId: actorUserId || null,
  });
}

/**
 * The notifications a NEW order should raise: one bell row for the building's APPROVER
 * (SUP-1 b / SUP-9 ★a; S131: its account manager, else the named approver) — not the whole office.
 * The Supply Manager hears once it is approved. The link opens the order page.
 *
 * Returns the next notifications array, unchanged when there is no valid approver or the
 * approver is the requester.
 */
export function supplySubmitNotifications(state, request, { actorUserId } = {}) {
  const approver = resolveSupplyApprover(state, request?.clientId);
  if (!approver) return state.notifications || [];
  const client = (state.clients || []).find((c) => c.id === request.clientId) || null;
  const requester = (state.users || []).find((u) => u.id === request.requestedByUserId) || null;
  const count = supplyRequestItemCount(request);
  return fanOutToUserIds(state, {
    userIds: [approver.id],
    eventKey: 'supplyRequestSubmitted',
    title: msg('alerts.supply.toApproveTitle', { place: client ? client.name : msg('alerts.supply.aLocation') }),
    body: requester
      ? msg('alerts.supply.toApproveBodyBy', { count, amount: supplyRequestTotal(request), name: requester.name })
      : msg('alerts.supply.toApproveBody', { count, amount: supplyRequestTotal(request) }),
    url: `/supplies/orders/${encodeURIComponent(request.id)}`,
    actorUserId: actorUserId || null,
  });
}
