// The weekly overtime ledger (spec §4.2) — PURE (no React / store / browser globals),
// `.js` on every import, node-safe. The SAME module the server approvals read
// (api/time/[...path].js), the payroll ledger (api/_lib/payroll/ledger.js, wave W2-L) and
// the demo stub (lib/timeApi.js) all run, so a client and a server can never split the
// 40 h line or the OT allocation.
//
// INPUT SHAPE. `entries` is the NEUTRAL camelCase punch shape — exactly what
// `timeApi.rollup` (mapRollupRow) and the variance mapper produce: { id, userId, userName,
// clientId, siteId, durationMinutes, clockInAt, clockOutAt, approvalStatus, status,
// jobCancelledAt }. `driveSegments` is the neutral segment shape from lib/driveTime.js
// (deriveDriveSegments). The server holds snake_case rows, so `entryFromRow` /
// `otApprovalFromRow` below map a raw time_entries / time_ot_approvals row into these.
//
// WHAT IT DOES (spec §4.2):
//  1. Group WORKED labor punches + WORKED drive legs by (userId, weekKey). A labor punch
//     is worked per timeRules.isWorkedEntry (closed, duration > 0, not voided/no_show, not
//     rejected — NOTE a cancelled-clean punch is still "worked": it counts toward 40 h and
//     is APPROVED only once a manager signs it, exactly as isPayable gates pay). A drive
//     leg is worked when both bounding punches are (driveTime.isSegmentPayable, approvedOnly
//     false); it attributes to its DESTINATION customer (toClientId) and entry (toEntryId).
//  2. Sort each week (dayKey, at, id) and walk the 40 h line over WORKED minutes — the SAME
//     walk as lib/payroll.attributeWeeklyOt — so an unapproved punch still counts toward
//     40 h and approving it later never moves OT onto a punch already paid.
//  3. Allocate each OT unit's approved minutes (the time_ot_approvals TOTAL for
//     (userId, weekKey, clientId), default 0) to that unit's APPROVED OT items in walk
//     order: payableOtMinutes = min(item.otMinutes, remaining); the rest of an approved
//     item's OT is heldOtMinutes. An unapproved item pays nothing (it is pending, not held).
//
// Reuses lib/payroll.payWeekKeyOf and lib/driveTime.isSegmentPayable / segmentPaidMinutes;
// it never forks them.
import { payWeekKeyOf, OT_WEEKLY_MINUTES } from './payroll.js';
import { dayKey } from './dates.js';
import { isSegmentPayable, segmentPaidMinutes } from './driveTime.js';
import { isWorkedEntry, isApprovedEntry } from './timeRules.js';

const at = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
const clean = (id) => (id == null ? '' : String(id)); // a missing customer buckets to the '' unit

// snake_case time_entries row → the neutral punch shape computeWeekLedger reads.
export function entryFromRow(r) {
  return {
    id: r.id, userId: r.user_id, userName: r.user_name,
    clientId: r.client_id, siteId: r.site_id,
    durationMinutes: r.duration_minutes, clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at,
    approvalStatus: r.approval_status, status: r.status, jobCancelledAt: r.job_cancelled_at ?? null,
  };
}

// snake_case time_ot_approvals row → the neutral OT-approval shape.
export function otApprovalFromRow(r) {
  return {
    userId: r.user_id, weekKey: r.week_key, clientId: r.client_id ?? '',
    approvedOtMinutes: r.approved_ot_minutes, approvedBy: r.approved_by ?? null, approvedAt: r.approved_at ?? null,
  };
}

// computeWeekLedger — see the file header. Returns { items, otUnits }.
//   items:  one per WORKED labor punch and WORKED drive leg —
//     { kind:'labor'|'drive', id, entryId, userId, userName, weekKey, dayKey, clientId,
//       minutes, approved, cancelled, regularMinutes, otMinutes,
//       payableRegularMinutes, payableOtMinutes, heldOtMinutes }
//   otUnits: one per (userId, weekKey, clientId) that has worked OT or an OT approval —
//     { userId, weekKey, clientId, dueMinutes, approvedMinutes, awaitingMinutes }
export function computeWeekLedger({ entries = [], driveSegments = [], otApprovals = [], tz, weekStartDay = 0, otWeeklyMinutes = OT_WEEKLY_MINUTES } = {}) {
  // The manager-approved OT TOTAL per unit (default 0).
  const approvedByUnit = new Map();
  for (const a of Array.isArray(otApprovals) ? otApprovals : []) {
    if (!a || !a.userId || !a.weekKey) continue;
    approvedByUnit.set(`${a.userId}|${a.weekKey}|${clean(a.clientId)}`, Math.max(0, Math.round(Number(a.approvedOtMinutes) || 0)));
  }

  // Group worked items by (userId, weekKey).
  const weeks = new Map(); // `${userId}|${weekKey}` -> item[]
  const add = (userId, weekKey, item) => {
    const key = `${userId}|${weekKey}`;
    let list = weeks.get(key);
    if (!list) { list = []; weeks.set(key, list); }
    list.push(item);
  };
  for (const e of entries || []) {
    if (!isWorkedEntry(e)) continue;
    const weekKey = payWeekKeyOf(e.clockInAt, weekStartDay, tz);
    add(e.userId, weekKey, {
      kind: 'labor', id: e.id, entryId: e.id, userId: e.userId, userName: e.userName || '—',
      weekKey, dayKey: dayKey(e.clockInAt, tz), clientId: clean(e.clientId),
      minutes: e.durationMinutes, approved: isApprovedEntry(e), cancelled: !!e.jobCancelledAt,
      at: at(e.clockInAt),
    });
  }
  for (const s of driveSegments || []) {
    if (!isSegmentPayable(s, { approvedOnly: false })) continue; // a worked leg (both ends worked)
    const weekKey = payWeekKeyOf(s.startAt, weekStartDay, tz);
    add(s.userId, weekKey, {
      kind: 'drive', id: s.key, entryId: s.toEntryId, userId: s.userId, userName: s.userName || '—',
      weekKey, dayKey: dayKey(s.startAt, tz), clientId: clean(s.toClientId),
      minutes: segmentPaidMinutes(s, { approvedOnly: false }),
      approved: isSegmentPayable(s, { approvedOnly: true }), cancelled: false,
      at: at(s.startAt),
    });
  }

  // Walk the 40 h line per week (identical to attributeWeeklyOt): earliest-first, regular
  // up to the line then OT. Flatten in walk order so OT allocation consumes earliest first.
  const items = [];
  for (const list of weeks.values()) {
    list.sort((a, b) => a.dayKey.localeCompare(b.dayKey) || (a.at - b.at) || String(a.id).localeCompare(String(b.id)));
    let cumulative = 0;
    for (const it of list) {
      const reg = Math.min(it.minutes, Math.max(0, otWeeklyMinutes - cumulative));
      cumulative += it.minutes;
      it.regularMinutes = reg;
      it.otMinutes = it.minutes - reg;
      items.push(it);
    }
  }

  // dueMinutes per unit = OT on WORKED items (approved or not); approvedMinutes = the total
  // manager-approved for the unit; awaitingMinutes = the OT still to approve.
  const units = new Map(); // unitKey -> { userId, weekKey, clientId, dueMinutes }
  const unit = (userId, weekKey, clientId) => {
    const key = `${userId}|${weekKey}|${clientId}`;
    let u = units.get(key);
    if (!u) { u = { userId, weekKey, clientId, dueMinutes: 0 }; units.set(key, u); }
    return u;
  };
  for (const it of items) unit(it.userId, it.weekKey, it.clientId).dueMinutes += it.otMinutes;
  // Surface units that carry an approval but no worked OT (e.g. an over-approval).
  for (const a of Array.isArray(otApprovals) ? otApprovals : []) {
    if (a && a.userId && a.weekKey) unit(a.userId, a.weekKey, clean(a.clientId));
  }

  // Allocate approved OT to approved items in walk order; hold the rest of an approved
  // item's OT; a pending item pays nothing.
  const remaining = new Map(approvedByUnit);
  for (const it of items) {
    it.payableRegularMinutes = it.approved ? it.regularMinutes : 0;
    it.payableOtMinutes = 0;
    it.heldOtMinutes = 0;
    if (it.approved && it.otMinutes > 0) {
      const key = `${it.userId}|${it.weekKey}|${it.clientId}`;
      const rem = remaining.has(key) ? remaining.get(key) : 0;
      const pay = Math.min(it.otMinutes, Math.max(0, rem));
      it.payableOtMinutes = pay;
      it.heldOtMinutes = it.otMinutes - pay;
      remaining.set(key, Math.max(0, rem - pay));
    }
    delete it.at; // internal sort key — not part of the item's contract
  }

  const otUnits = [...units.values()].map((u) => {
    const approvedMinutes = approvedByUnit.get(`${u.userId}|${u.weekKey}|${u.clientId}`) || 0;
    return { ...u, approvedMinutes, awaitingMinutes: Math.max(0, u.dueMinutes - approvedMinutes) };
  });

  return { items, otUnits };
}

// A Map entryId -> its walk OT minutes, for the Approvals "incl. Xh OT" punch flag.
export function entryOtMinutes(items) {
  const map = new Map();
  for (const it of items || []) if (it.kind === 'labor') map.set(it.entryId, it.otMinutes);
  return map;
}

// The approvable overtime units: keep the ones a manager should act on (gated person, in
// scope, still awaiting approval) and name them. `inScope(clientId)` and `isGated(userId)`
// are the caller's scope + gating; `usersById` / `clientsById` are Maps for the names.
export function overtimeUnitsForApproval(otUnits, { usersById, clientsById, inScope, isGated } = {}) {
  const userName = (id) => (usersById?.get ? usersById.get(id) : null)?.name || '—';
  const clientOf = (id) => (id && clientsById?.get ? clientsById.get(id) : null) || null;
  return (otUnits || [])
    .filter((u) => u.awaitingMinutes > 0
      && (typeof isGated !== 'function' || isGated(u.userId))
      && (typeof inScope !== 'function' || inScope(u.clientId)))
    .map((u) => {
      const c = clientOf(u.clientId);
      return {
        userId: u.userId, userName: userName(u.userId),
        weekKey: u.weekKey, clientId: u.clientId, clientName: c?.name || (u.clientId ? null : 'No customer'),
        supervisorId: c?.supervisorId || null,
        dueMinutes: u.dueMinutes, approvedMinutes: u.approvedMinutes, awaitingMinutes: u.awaitingMinutes,
      };
    })
    .sort((a, b) => a.weekKey.localeCompare(b.weekKey) || (a.userName || '').localeCompare(b.userName || '') || String(a.clientName || '').localeCompare(String(b.clientName || '')));
}
