// The pay run (spec §4.3) — PURE (no React / store / browser globals), `.js` on every
// import, node-safe. The SAME module the server pay-run route (api/_lib/payroll/compute.js,
// wave W2-L) and the demo stub (lib/payrollApi.js) run, so a preview, a close and a demo can
// never price a period differently.
//
// It turns APPROVED clocked hours + approved overtime + pay lines into money for ONE pay
// period, and — because pay in this build is APPROVAL-BASED IN ARREARS — the signed deltas
// owed for prior CLOSED periods that changed after they closed (a late approval, a manual
// entry into a paid week, a void). It sits on the weekly OT ledger (lib/otLedger
// computeWeekLedger) and prices through lib/payroll (basePayForUser / lineTotals /
// payRunRoster), never forking either.
//
// INPUT SHAPES are the NEUTRAL camelCase shapes computeWeekLedger consumes: `entries` as
// otLedger.entryFromRow / timeApi.rollup produce, `driveSegments` as driveTime derives,
// `otApprovals` as otLedger.otApprovalFromRow produces. The CALLER maps DB rows / stub rows
// into them (server via entryFromRow + runDriveReport; demo via the same) — this module is
// shape-agnostic and node-safe.
import { computeWeekLedger } from './otLedger.js';
import { isWorkedEntry, isGatedUser } from './timeRules.js';
import { basePayForUser, lineTotals, payRunRoster, minutesToHours, hourlyPayBreakdown, payDateKeyFor } from './payroll.js';
import { employeeIdOf } from './employeeId.js';
import { payableDriveSegments } from './driveTime.js';
import { rateCentsForBuilding, rateCentsOf } from './payRates.js';
import { dayKey, addDaysKey } from './dates.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The CSV pay-type labels (mirrors pages/payroll/shared.jsx PAY_TYPE — kept here because a
// closed run STORES its file rows, so the label must be node-computable, not a JSX import).
const PAY_TYPE_LABELS = { hourly: 'Hourly', salary: 'Salary', per_visit: 'Per-visit' };

// ── payable-minute totals (regular / OT / drive-subset / clean count) ──────────
// Every field is PAYABLE (approved) minutes: computeWeekLedger already zeroed an unapproved
// item's payable regular/OT and capped OT at the unit's approval, so summing payable* here
// IS the approved-only pay lens the pay run needs.
const emptyTotals = () => ({ regularMinutes: 0, otMinutes: 0, driveMinutes: 0, cleanCount: 0 });
function addItem(t, it) {
  t.regularMinutes += it.payableRegularMinutes;
  t.otMinutes += it.payableOtMinutes;
  const paid = it.payableRegularMinutes + it.payableOtMinutes;
  if (it.kind === 'drive') t.driveMinutes += paid;   // drive is a SUBSET of total (folded into reg/OT)
  else if (it.approved) t.cleanCount += 1;            // a paid visit (per_visit prices by this)
}
const addTotals = (a, b) => { a.regularMinutes += b.regularMinutes; a.otMinutes += b.otMinutes; a.driveMinutes += b.driveMinutes; a.cleanCount += b.cleanCount; };

// ── PAY RATES BY BUILDING (PAY-7 / PAY-18) ─────────────────────────────────────
// A cleaner may earn a different hourly rate at a given building, so payable minutes are
// bucketed by RATE as well as by (user, week). The rate is resolved here — this is the only
// place that knows which punch was at which customer — and the money is
// lib/payroll.basePayForUser's, which blends the week's overtime premium across those buckets.
// A bucket map is Map<rateCents, { rateCents, regularMinutes, otMinutes }>.
function addRateBucket(map, rateCents, regularMinutes, otMinutes) {
  if (!regularMinutes && !otMinutes) return;
  let b = map.get(rateCents);
  if (!b) { b = { rateCents, regularMinutes: 0, otMinutes: 0 }; map.set(rateCents, b); }
  b.regularMinutes += regularMinutes; b.otMinutes += otMinutes;
}
const addRateItem = (map, rateCents, it) => addRateBucket(map, rateCents, it.payableRegularMinutes, it.payableOtMinutes);
// The stored / priced form: the highest rate first (so a screen reads top-down), zero rows
// dropped — a bucket that nets to nothing is not a rate anybody was paid at.
const rateBuckets = (map) => [...(map ? map.values() : [])]
  .filter((b) => b.regularMinutes !== 0 || b.otMinutes !== 0)
  .sort((a, b) => b.rateCents - a.rateCents)
  .map((b) => ({ rateCents: b.rateCents, regularMinutes: b.regularMinutes, otMinutes: b.otMinutes }));
// paid − recomputed, per rate, for an arrears delta. Signed: a void comes back negative.
function subRateBuckets(rec, paid) {
  const out = new Map();
  for (const b of rec.values()) addRateBucket(out, b.rateCents, b.regularMinutes, b.otMinutes);
  for (const b of paid.values()) addRateBucket(out, b.rateCents, -b.regularMinutes, -b.otMinutes);
  return out;
}
const subTotals = (a, b) => ({ regularMinutes: a.regularMinutes - b.regularMinutes, otMinutes: a.otMinutes - b.otMinutes, driveMinutes: a.driveMinutes - b.driveMinutes, cleanCount: a.cleanCount - b.cleanCount });
const nonZeroTotals = (t) => t.regularMinutes !== 0 || t.otMinutes !== 0 || t.driveMinutes !== 0 || t.cleanCount !== 0;
const getInit = (map, key, make) => { let v = map.get(key); if (!v) { v = make(); map.set(key, v); } return v; };

// Does a pay week (weekKey .. weekKey+6) intersect the run's [from_key, to_key]? Day keys
// are labels, so a lexical compare IS a chronological one (matches ledger.weekMeetsClosedTerritory).
function weekMeetsRun(weekKey, run) {
  if (!run || !run.from_key || !run.to_key) return false;
  return weekKey <= run.to_key && addDaysKey(weekKey, 6) >= run.from_key;
}

// The TOTAL already paid for (period P, user u, week w): summed over EVERY run's paid_weeks —
// a run may carry arrears rows for an earlier period, so paid = the original close + every
// later arrears top-up, which is exactly what "already paid" means for a signed delta.
//
// It also sums the per-RATE split a close stores (PAY-7 / PAY-18), so an arrears delta knows
// which of the week's paid hours were at which building's rate. A row written BEFORE that
// column existed carries none: its minutes fall back to `fallbackRateCents` — the member's MAIN
// rate, which is exactly what the pricer charged them at when that run closed — so an old run's
// arrears are unchanged rather than silently re-priced at today's building rates.
function paidSum(runs, forPeriodKey, userId, weekKey, fallbackRateCents = 0) {
  const t = emptyTotals();
  const rates = new Map();
  for (const run of runs) {
    for (const pw of Array.isArray(run.paid_weeks) ? run.paid_weeks : []) {
      if (pw && pw.forPeriodKey === forPeriodKey && pw.userId === userId && pw.weekKey === weekKey) {
        t.regularMinutes += pw.regularMinutes || 0;
        t.otMinutes += pw.otMinutes || 0;
        t.driveMinutes += pw.driveMinutes || 0;
        t.cleanCount += pw.cleanCount || 0;
        if (Array.isArray(pw.rates) && pw.rates.length) {
          for (const r of pw.rates) {
            if (r && Number.isFinite(Number(r.rateCents))) {
              addRateBucket(rates, Math.round(Number(r.rateCents)), Number(r.regularMinutes) || 0, Number(r.otMinutes) || 0);
            }
          }
        } else {
          addRateBucket(rates, fallbackRateCents, pw.regularMinutes || 0, pw.otMinutes || 0);
        }
      }
    }
  }
  return { totals: t, rates };
}

// Normalize arrearsWeeks (a Set/array of "userId|weekKey", or of { userId, weekKey }) to a
// Set of "userId|weekKey". Empty when no run exists (no closed territory to owe arrears in).
function normalizeArrearsWeeks(arrearsWeeks) {
  const out = new Set();
  const src = arrearsWeeks instanceof Set ? [...arrearsWeeks] : (Array.isArray(arrearsWeeks) ? arrearsWeeks : []);
  for (const x of src) {
    if (typeof x === 'string') out.add(x);
    else if (x && x.userId && x.weekKey) out.add(`${x.userId}|${x.weekKey}`);
  }
  return out;
}

/**
 * computePayRun — spec §4.3. Returns the priced run for `period`, its arrears, its
 * readiness/held/pending counts, the paid_weeks + held_ot a close must store, and the CSV
 * source rows. See the file header for the input shapes.
 *
 * @param period       a lib/payroll.payPeriodRange result (fromKey/toKey/fromIso/toIso/label/cadence)
 * @param tz           the ORG timezone, ALWAYS passed explicitly (no ambient zone on the server)
 * @param weekStartDay 0 = Sunday (US payroll default)
 * @param entries      neutral punches covering [rollupFromIso, rollupToIso] ∪ the arrears weeks
 * @param driveSegments neutral drive legs over the same window
 * @param otApprovals  neutral OT approvals over the same weeks
 * @param runs         the CLOSED runs (each with period_key/from_key/to_key/paid_weeks/held_ot)
 * @param arrearsWeeks the (user, week) pairs changed in closed territory since the latest close
 * @param users        the roster
 * @param lines        payrollLines
 * @param otMultiplier the OT premium (default 1.5)
 * @param payDriveTime  opsSettings.payDriveTime — FALSE drops every drive leg before pricing
 *                      (PAY-6: drive time pays $0 and adds 0 hours). Defaults to the paying
 *                      side, so a caller that omits it prices exactly as before.
 * @param openEntries  open punches (no clock-out) in the period; derived from `entries` when null
 * @param clientsById  Map<clientId, client> for grouping readiness by the customer's supervisor
 */
export function computePayRun({
  period, tz, weekStartDay = 0,
  entries = [], driveSegments = [], otApprovals = [], runs = [], arrearsWeeks = [],
  users = [], lines = [], otMultiplier = 1.5, openEntries = null, clientsById = null,
  payDriveTime = true, payDate = null,
} = {}) {
  if (!period || !period.fromKey || !period.toKey) throw new Error('computePayRun: a period with fromKey/toKey is required');
  // 🔴 PAY-6 (Matt, 2026-09-29): with drive pay OFF a leg pays $0 and adds 0 hours. This is THE
  // boundary — every pricing caller (the server preview, the close-period file, the demo stub)
  // comes through here, so none of them can forget. Dropping the legs BEFORE the weekly ledger
  // is what makes it 0 HOURS and not merely $0: a leg left in the walk would still push the
  // week past 40 h and buy someone else's minutes an OT premium. The rule is lib/driveTime's
  // (`payableDriveSegments`), beside the `paidMinutes` it governs; the drive REPORT is untouched.
  const payableDrive = payableDriveSegments(driveSegments, { payDriveTime });
  const sortedRuns = [...(Array.isArray(runs) ? runs : [])].sort((a, b) => String(a?.period_key).localeCompare(String(b?.period_key)));
  const latestRun = sortedRuns.length ? sortedRuns[sortedRuns.length - 1] : null;
  const usersById = new Map((Array.isArray(users) ? users : []).map((u) => [u.id, u]));
  const isGated = (userId) => isGatedUser(usersById.get(userId));
  const supOf = (clientId) => (clientsById && typeof clientsById.get === 'function' ? (clientsById.get(clientId || '')?.supervisorId || null) : null);
  const inPeriod = (k) => k >= period.fromKey && k <= period.toKey;

  // The hourly rate a punch prices at: its building's override, else the member's main rate
  // (PAY-7 / PAY-18; lib/payRates is the one reader of the field).
  const rateCentsFor = (userId, clientId) => rateCentsForBuilding(usersById.get(userId)?.pay, clientId);
  const mainRateCentsOf = (userId) => rateCentsOf(usersById.get(userId)?.pay?.hourlyRate);

  // 1. the weekly OT ledger over everything provided (payable regular/OT/held per item).
  const { items, otUnits } = computeWeekLedger({ entries, driveSegments: payableDrive, otApprovals, tz, weekStartDay });
  const itemsByUserWeek = new Map();
  // Every week's FULL rate split, whatever period its days fall in — the denominator of the
  // week's blended overtime rate, which is a property of the WEEK (so a semi-monthly period
  // cutting through a week, and an arrears delta inside one, blend over the same hours).
  const weekRateByUserWeek = new Map();
  for (const it of items) {
    const uw = `${it.userId}|${it.weekKey}`;
    getInit(itemsByUserWeek, uw, () => []).push(it);
    addRateItem(getInit(weekRateByUserWeek, uw, () => new Map()), rateCentsFor(it.userId, it.clientId), it);
  }

  // 2. CURRENT period — payable totals per user (and per user+week, for paid_weeks) for items
  //    whose dayKey falls inside [fromKey, toKey], plus the per-rate split of those minutes.
  const currentByUser = new Map();
  const currentByUserWeek = new Map();
  const currentRateByUserWeek = new Map();
  for (const it of items) {
    if (!inPeriod(it.dayKey)) continue;
    addItem(getInit(currentByUser, it.userId, emptyTotals), it);
    addItem(getInit(currentByUserWeek, `${it.userId}|${it.weekKey}`, emptyTotals), it);
    addRateItem(getInit(currentRateByUserWeek, `${it.userId}|${it.weekKey}`, () => new Map()), rateCentsFor(it.userId, it.clientId), it);
  }
  // Per user, the `rateWeeks` basePayForUser prices from: each week's own paid buckets, with the
  // whole week as the blend's basis.
  const rateWeeksByUser = new Map();
  for (const [uw, paid] of currentRateByUserWeek) {
    const sep = uw.indexOf('|');
    getInit(rateWeeksByUser, uw.slice(0, sep), () => []).push({
      weekKey: uw.slice(sep + 1), paid: rateBuckets(paid), basis: rateBuckets(weekRateByUserWeek.get(uw)),
    });
  }

  // 3. ARREARS — for each changed (user, week) in closed territory and each closed run P the
  //    week meets: delta = recomputed(P,u,w) − paid(P,u,w), signed, per field.
  const arrearsWeekSet = normalizeArrearsWeeks(arrearsWeeks);
  const arrearsRows = [];
  const arrearsByUser = new Map();
  const arrearsRowsByUser = new Map();
  // The delta's per-RATE split, accumulated per (user, week) across every closed run the week
  // meets, so the premium owed for a week is computed once from that week's blend (PAY-7/18).
  const arrearsRateByUserWeek = new Map();
  for (const uw of arrearsWeekSet) {
    const sep = uw.indexOf('|');
    const u = uw.slice(0, sep);
    const w = uw.slice(sep + 1);
    const weekItems = itemsByUserWeek.get(uw) || [];
    for (const run of sortedRuns) {
      if (!weekMeetsRun(w, run)) continue;
      const rec = emptyTotals();
      const recRates = new Map();
      for (const it of weekItems) {
        if (it.dayKey < run.from_key || it.dayKey > run.to_key) continue;
        addItem(rec, it);
        addRateItem(recRates, rateCentsFor(u, it.clientId), it);
      }
      const paid = paidSum(sortedRuns, run.period_key, u, w, mainRateCentsOf(u));
      const delta = subTotals(rec, paid.totals);
      if (!nonZeroTotals(delta)) continue;
      const deltaRates = subRateBuckets(recRates, paid.rates);
      const rowOut = { forPeriodKey: run.period_key, weekKey: w, userId: u, ...delta, rates: rateBuckets(deltaRates) };
      arrearsRows.push(rowOut);
      addTotals(getInit(arrearsByUser, u, emptyTotals), delta);
      getInit(arrearsRowsByUser, u, () => []).push(rowOut);
      const acc = getInit(arrearsRateByUserWeek, uw, () => new Map());
      for (const b of deltaRates.values()) addRateBucket(acc, b.rateCents, b.regularMinutes, b.otMinutes);
    }
  }
  // The arrears `rateWeeks`: each changed week's signed delta buckets, blended against the week
  // as it now stands (the recomputed full week) — the rate the hours are owed at today.
  const arrearsRateWeeksByUser = new Map();
  for (const [uw, paid] of arrearsRateByUserWeek) {
    const sep = uw.indexOf('|');
    getInit(arrearsRateWeeksByUser, uw.slice(0, sep), () => []).push({
      weekKey: uw.slice(sep + 1), paid: rateBuckets(paid), basis: rateBuckets(weekRateByUserWeek.get(uw)),
    });
  }

  // 4. HELD / PENDING / OPEN (gated people only), in the period.
  const openList = Array.isArray(openEntries) ? openEntries : entries.filter((e) => !e.clockOutAt);
  const readiness = new Map(); // supervisorId|null -> counts
  const readinessOf = (sup) => getInit(readiness, sup === null ? '\u0000none' : sup, () => ({ supervisorId: sup, pendingCount: 0, pendingMinutes: 0, openCount: 0, otHeldMinutes: 0 }));
  let pendingCount = 0; let pendingMinutes = 0; let openCount = 0; let otHeldMinutes = 0;
  for (const e of entries) {
    if (!isWorkedEntry(e) || e.approvalStatus !== 'pending') continue;
    if (!isGated(e.userId) || !inPeriod(dayKey(e.clockInAt, tz))) continue;
    const mins = e.durationMinutes || 0;
    pendingCount += 1; pendingMinutes += mins;
    const r = readinessOf(supOf(e.clientId)); r.pendingCount += 1; r.pendingMinutes += mins;
  }
  for (const e of openList) {
    if (e.clockOutAt || !isGated(e.userId) || !inPeriod(dayKey(e.clockInAt, tz))) continue;
    openCount += 1; readinessOf(supOf(e.clientId)).openCount += 1;
  }
  for (const it of items) {
    if (it.heldOtMinutes <= 0 || !isGated(it.userId) || !inPeriod(it.dayKey)) continue;
    otHeldMinutes += it.heldOtMinutes; readinessOf(supOf(it.clientId)).otHeldMinutes += it.heldOtMinutes;
  }
  const rolledForward = { pendingCount, pendingMinutes, openCount, otHeldMinutes };

  // 5. PRICING — the roster (payRunRoster: active + anyone who earned pay this period),
  //    priced through lib/payroll. Gross = base + arrearsPay + custom lines' net.
  const hoursRows = [...currentByUser.entries()].map(([userId, t]) => ({
    userId, userName: usersById.get(userId)?.name || '—',
    totalMinutes: t.regularMinutes + t.otMinutes, regularMinutes: t.regularMinutes, otMinutes: t.otMinutes,
    driveMinutes: t.driveMinutes, cleanCount: t.cleanCount,
  }));
  const { members, removed } = payRunRoster({ users, hoursRows, lines, periodKey: period.fromKey, periodFromIso: period.fromIso });
  const rows = members.slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '') || String(a.id).localeCompare(String(b.id)))
    .map((u) => {
      const pay = u.pay || { type: null };
      const current = currentByUser.get(u.id) || emptyTotals();
      const arr = arrearsByUser.get(u.id) || emptyTotals();
      const userLines = lines.filter((l) => l.userId === u.id && l.periodKey === period.fromKey);
      const totals = lineTotals(userLines);
      // PAY-7 / PAY-18: the per-rate buckets ride in, so a cleaner with two building rates is
      // priced at each rate for its straight time and at the week's BLENDED rate for the
      // overtime premium. With one rate (the common case) basePayForUser takes its original path.
      const rateWeeks = rateWeeksByUser.get(u.id) || null;
      const arrearsRateWeeks = arrearsRateWeeksByUser.get(u.id) || null;
      const base = basePayForUser(current, pay, { otMultiplier, rateWeeks });
      // Salary never earns arrears (their pay doesn't move with hours, §4.3); hourly / per-visit
      // arrears are priced from the signed delta totals (can be negative — a void).
      const arrearsPay = pay.type === 'salary' ? 0 : (basePayForUser(arr, pay, { otMultiplier, rateWeeks: arrearsRateWeeks }) ?? 0);
      const gross = base == null ? null : round2(base + arrearsPay + totals.net);
      // The hours→base lines the drawer RENDERS. It used to re-derive them from
      // `pay.hourlyRate`, which is a different number from what was paid the moment two rates
      // are involved, so the run hands over its own breakdown and the screen cannot disagree
      // with the money. Hourly only — salary and per-visit have no rate lines.
      const rateBreakdown = pay.type === 'hourly'
        ? (() => {
          const b = hourlyPayBreakdown(
            rateWeeks && rateWeeks.length ? rateWeeks : [{ paid: [{ rateCents: rateCentsOf(pay.hourlyRate), regularMinutes: current.regularMinutes, otMinutes: current.otMinutes }] }],
            { otMultiplier, otExempt: pay.otExempt },
          );
          return {
            multiRate: b.multiRate, rates: b.rates, otMinutes: b.otMinutes,
            otPremium: b.otPremium, blendedRate: b.blendedRate,
            // The org's multiplier travels with the lines: the drawer printed a hardcoded
            // "×1.5", which is a lie on an org that set anything else.
            otMultiplier, otExempt: !!pay.otExempt,
          };
        })()
        : null;
      return {
        userId: u.id, userName: u.name, pay, payType: pay.type || null,
        current, arrears: { ...arr, rows: arrearsRowsByUser.get(u.id) || [] },
        base, arrearsPay, lines: userLines, totals, gross, rateBreakdown,
        excluded: pay.type === 'none', unset: !pay.type, inactive: u.status !== 'active',
      };
    });

  const summary = { base: 0, arrears: 0, adjustments: 0, gross: 0, regMinutes: 0, otMinutes: 0, arrearsRegMinutes: 0, arrearsOtMinutes: 0, onPayroll: 0, byCategory: {} };
  for (const r of rows) {
    if (r.gross == null) continue;
    summary.onPayroll += 1;
    summary.base = round2(summary.base + (r.base || 0));
    summary.arrears = round2(summary.arrears + (r.arrearsPay || 0));
    summary.adjustments = round2(summary.adjustments + r.totals.net);
    summary.gross = round2(summary.gross + r.gross);
    summary.regMinutes += r.current.regularMinutes; summary.otMinutes += r.current.otMinutes;
    summary.arrearsRegMinutes += r.arrears.regularMinutes; summary.arrearsOtMinutes += r.arrears.otMinutes;
    for (const [k, v] of Object.entries(r.totals.byCategory)) summary.byCategory[k] = round2((summary.byCategory[k] || 0) + v);
  }

  // 6. paid_weeks a CLOSE stores: the current period per (user, week), plus every arrears delta
  //    row (so after this run, paid == recomputed for everything considered — idempotence).
  //    Each row also carries its per-RATE split (`rates`, PAY-7 / PAY-18): without it a later
  //    arrears delta could not tell which of the week's paid hours were at which building's
  //    rate, and would re-price them all at whatever the member's main rate is by then.
  //    Additive — a row from before this column reads as "all at the main rate" (paidSum).
  const paidWeeksOut = [];
  for (const [uw, t] of currentByUserWeek) {
    if (!nonZeroTotals(t)) continue;
    const sep = uw.indexOf('|');
    paidWeeksOut.push({
      forPeriodKey: period.fromKey, userId: uw.slice(0, sep), weekKey: uw.slice(sep + 1), ...t,
      rates: rateBuckets(currentRateByUserWeek.get(uw)),
    });
  }
  for (const ar of arrearsRows) {
    paidWeeksOut.push({ forPeriodKey: ar.forPeriodKey, userId: ar.userId, weekKey: ar.weekKey, regularMinutes: ar.regularMinutes, otMinutes: ar.otMinutes, driveMinutes: ar.driveMinutes, cleanCount: ar.cleanCount, rates: ar.rates });
  }

  // 7. held_ot a CLOSE stores: recomputed held OT per unit for the CONSIDERED weeks (current
  //    period ∪ arrears weeks — all closed after this close), plus the latest run's held_ot for
  //    weeks NOT reconsidered (carried forward), so the newest run's list stays complete.
  const consideredWeeks = new Set();
  for (const it of items) if (inPeriod(it.dayKey)) consideredWeeks.add(it.weekKey);
  for (const uw of arrearsWeekSet) consideredWeeks.add(uw.slice(uw.indexOf('|') + 1));
  const unitByKey = new Map(otUnits.map((u) => [`${u.userId}|${u.weekKey}|${u.clientId}`, u]));
  const heldByUnit = new Map();
  for (const it of items) {
    if (!consideredWeeks.has(it.weekKey) || it.heldOtMinutes <= 0) continue;
    getInit(heldByUnit, `${it.userId}|${it.weekKey}|${it.clientId}`, () => ({ userId: it.userId, weekKey: it.weekKey, clientId: it.clientId, heldMinutes: 0 })).heldMinutes += it.heldOtMinutes;
  }
  const heldOtOut = [];
  for (const [key, h] of heldByUnit) {
    const unit = unitByKey.get(key);
    heldOtOut.push({ userId: h.userId, weekKey: h.weekKey, clientId: h.clientId, dueMinutes: unit?.dueMinutes || 0, approvedMinutes: unit?.approvedMinutes || 0, heldMinutes: h.heldMinutes });
  }
  for (const h of Array.isArray(latestRun?.held_ot) ? latestRun.held_ot : []) {
    if (h && h.weekKey && !consideredWeeks.has(h.weekKey)) heldOtOut.push(h);
  }

  // 8. the CSV source rows (payrollPayCsv shape). Gross already includes arrears.
  const fileRows = rows.filter((r) => r.gross != null).map((r) => ({
    // PAY-9 / CS-382: the payroll company's own employee id travels with the row, so the
    // CSV can carry it and a CLOSED run's stored file keeps it for every later download.
    userName: r.userName, employeeId: employeeIdOf(usersById.get(r.userId)), payTypeLabel: PAY_TYPE_LABELS[r.payType] || '',
    regularMinutes: r.current.regularMinutes, otMinutes: r.current.otMinutes,
    base: r.base, byCategory: r.totals.byCategory,
    arrearsRegularMinutes: r.arrears.regularMinutes || 0, arrearsOtMinutes: r.arrears.otMinutes || 0, arrearsPay: r.arrearsPay || 0,
    gross: r.gross,
  }));

  // PAY-2: the PAYDAY for this period (Matt: semi-monthly pays the 1st–15th on the 20th and the
  // 16th–end on the 5th of the next month). Computed HERE so the preview, the close dialog and
  // the file all name the same date, and stored INSIDE `file` so a closed run's later download
  // still says when that run paid, whatever the setting is by then.
  const payDateKey = payDateKeyFor(period, payDate);

  return {
    period, cadence: period.cadence, otMultiplier, tz, payDateKey,
    rows, removed,
    summary,
    arrears: arrearsRows,
    rolledForward,
    readiness: [...readiness.values()],
    paidWeeksOut, heldOtOut,
    file: {
      label: period.label, fromIso: period.fromIso, toIso: period.toIso, payDateKey,
      rows: fileRows,
      summary: { gross: summary.gross, base: summary.base, arrears: summary.arrears, adjustments: summary.adjustments, onPayroll: summary.onPayroll, regMinutes: summary.regMinutes, otMinutes: summary.otMinutes },
    },
  };
}

// Minutes → hours, re-exported so a caller (route / stub) can shape numbers the same way.
export { minutesToHours };
