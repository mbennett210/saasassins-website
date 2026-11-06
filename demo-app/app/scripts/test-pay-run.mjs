// Headless unit checks for the pay run (src/lib/payRun.js, wave W2-L §4.3): approved-only
// pricing, OT capped per unit by approvals, held OT, arrears (late approval, late OT
// approval, a manual add / a void in a paid week), semi-monthly straddle, close→recompute
// idempotence, salaried-never-pending, per-visit clean counts, and — the money guarantee —
// the pay run equals TODAY's usePayrollRun pricing for an all-approved, no-runs period.
//   node scripts/test-pay-run.mjs
import { computePayRun } from '../src/lib/payRun.js';
import {
  payPeriodRange, payrollByUser, payrollByUserClipped, basePayForUser, grossForUser, payRunRoster,
} from '../src/lib/payroll.js';

const TZ = 'America/New_York';
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${name}\n      ${detail}` : name); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── builders (NEUTRAL camelCase — what computeWeekLedger consumes) ────────────
// durationMinutes is set EXPLICITLY so a 3000-min (50h) punch makes 10h weekly OT without a
// 50h wall-clock span. clockOutAt only needs to be after clockInAt to read as "closed".
let seq = 0;
const H = 3600e3;
const punch = (o = {}) => {
  const clockInAt = o.clockInAt || '2026-06-08T12:00:00Z';
  return {
    id: o.id || `te_${seq++}`, userId: o.userId || 'u_crew', userName: o.userName || 'Crew',
    clientId: o.clientId ?? 'c1', siteId: o.siteId ?? 's1',
    clockInAt, clockOutAt: o.clockOutAt || new Date(Date.parse(clockInAt) + (o.durationMinutes || 480) * 60000).toISOString(),
    durationMinutes: o.durationMinutes ?? 480,
    status: o.status || 'completed', approvalStatus: o.approvalStatus || 'approved', jobCancelledAt: o.jobCancelledAt ?? null,
  };
};
const otAppr = (userId, weekKey, clientId, minutes) => ({ userId, weekKey, clientId: clientId || '', approvedOtMinutes: minutes });
const hourly = (id, rate) => ({ id, name: id, status: 'active', pay: { type: 'hourly', hourlyRate: rate } });
const weeklyPeriod = (sundayKey) => payPeriodRange('weekly', 0, sundayKey, TZ);
const USERS = [hourly('u_crew', 20), { id: 'u_sal', name: 'Sal', status: 'active', pay: { type: 'salary', salaryPerPeriod: 2000 } }, { id: 'u_pv', name: 'Pv', status: 'active', pay: { type: 'per_visit', perVisitRate: 45 } }];
// Two Sundays in June 2026 (June 1 2026 is a Monday, so the 7th/14th/21st are Sundays).
const W1 = '2026-06-07'; const W3 = '2026-06-21';

// ═══ 1. approved-only pricing ════════════════════════════════════════════════
{
  const period = weeklyPeriod(W1);
  const approved = computePayRun({ period, tz: TZ, entries: [punch({ durationMinutes: 2400, clockInAt: '2026-06-08T12:00:00Z' })], users: USERS, otMultiplier: 1.5 });
  const r = approved.rows.find((x) => x.userId === 'u_crew');
  eq('approved 40h punch → 40h regular, base 800', [r.current.regularMinutes, r.current.otMinutes, r.base, r.gross], [2400, 0, 800, 800]);

  const pending = computePayRun({ period, tz: TZ, entries: [punch({ durationMinutes: 2400, approvalStatus: 'pending' })], users: USERS, otMultiplier: 1.5 });
  const rp = pending.rows.find((x) => x.userId === 'u_crew');
  eq('a PENDING punch pays nothing (approved-only)', [rp.current.regularMinutes, rp.base, rp.gross], [0, 0, 0]);
  ok('...and it is counted as pending (gated), with its minutes', pending.rolledForward.pendingCount === 1 && pending.rolledForward.pendingMinutes === 2400, JSON.stringify(pending.rolledForward));
}

// ═══ 2. OT capped by approvals PER UNIT; held OT ═════════════════════════════
{
  const period = weeklyPeriod(W1);
  // One 50h punch → 40h reg + 10h (600m) OT. Approve only 6h (360m) of the unit's OT.
  const entries = [punch({ id: 'te_ot', durationMinutes: 3000, clockInAt: '2026-06-08T12:00:00Z' })];
  const capped = computePayRun({ period, tz: TZ, entries, otApprovals: [otAppr('u_crew', W1, 'c1', 360)], users: USERS, otMultiplier: 1.5 });
  const r = capped.rows.find((x) => x.userId === 'u_crew');
  // base = 40h×20 + 6h×20×1.5 = 800 + 180 = 980. Held OT = 600−360 = 240m.
  eq('OT paid only up to the unit approval (6h of 10h)', [r.current.regularMinutes, r.current.otMinutes, r.base], [2400, 360, 980]);
  eq('the rest of the worked OT is HELD (240m)', capped.rolledForward.otHeldMinutes, 240);

  const none = computePayRun({ period, tz: TZ, entries, users: USERS, otMultiplier: 1.5 });
  const rn = none.rows.find((x) => x.userId === 'u_crew');
  eq('no OT approval → 0 OT paid, all 10h held', [rn.current.otMinutes, rn.base, none.rolledForward.otHeldMinutes], [0, 800, 600]);
}

// ═══ 3. per-visit clean counts; salaried never pending ═══════════════════════
{
  const period = weeklyPeriod(W1);
  const entries = [
    punch({ id: 'pv1', userId: 'u_pv', durationMinutes: 120, clockInAt: '2026-06-08T12:00:00Z' }),
    punch({ id: 'pv2', userId: 'u_pv', durationMinutes: 120, clockInAt: '2026-06-09T12:00:00Z' }),
    punch({ id: 'pvp', userId: 'u_pv', durationMinutes: 120, clockInAt: '2026-06-10T12:00:00Z', approvalStatus: 'pending' }),
    punch({ id: 'sal1', userId: 'u_sal', durationMinutes: 480, clockInAt: '2026-06-08T12:00:00Z', approvalStatus: 'pending' }),
  ];
  const res = computePayRun({ period, tz: TZ, entries, users: USERS, otMultiplier: 1.5 });
  const pv = res.rows.find((x) => x.userId === 'u_pv');
  eq('per-visit pays approved visits only (2 of 3), 2×$45 = 90', [pv.current.cleanCount, pv.base], [2, 90]);
  const sal = res.rows.find((x) => x.userId === 'u_sal');
  eq('salary is priced flat, ignoring hours', sal.base, 2000);
  ok('a salaried person\'s pending punch is NEVER counted as pending', res.rolledForward.pendingCount === 1, JSON.stringify(res.rolledForward));
}

// ── close a weekly period the honest way: run computePayRun, store its paid_weeks/held_ot ──
const closeWeek = (sundayKey, { entries = [], otApprovals = [], runs = [], arrearsWeeks = [], users = USERS } = {}) => {
  const period = weeklyPeriod(sundayKey);
  const res = computePayRun({ period, tz: TZ, entries, otApprovals, runs, arrearsWeeks, users, otMultiplier: 1.5 });
  const run = {
    period_key: period.fromKey, from_key: period.fromKey, to_key: period.toKey, from_iso: period.fromIso, to_iso: period.toIso,
    cadence: 'weekly', closed_at: new Date(Date.parse(period.toIso) + H).toISOString(),
    paid_weeks: res.paidWeeksOut, held_ot: res.heldOtOut,
  };
  return { run, res };
};

// ═══ 4. late approval → arrears in the NEXT run ══════════════════════════════
{
  // Close W1 with the 40h punch PENDING (paid nothing). Then it's approved; recompute for W3.
  const pendingPunch = punch({ id: 'te_late', durationMinutes: 2400, clockInAt: '2026-06-08T12:00:00Z', approvalStatus: 'pending' });
  const { run: run1 } = closeWeek(W1, { entries: [pendingPunch] });
  ok('the closed run paid the pending punch NOTHING', (run1.paid_weeks || []).every((p) => p.regularMinutes === 0), JSON.stringify(run1.paid_weeks));
  const approvedNow = { ...pendingPunch, approvalStatus: 'approved' };
  const next = computePayRun({ period: weeklyPeriod(W3), tz: TZ, entries: [approvedNow], runs: [run1], arrearsWeeks: [`u_crew|${W1}`], users: USERS, otMultiplier: 1.5 });
  const r = next.rows.find((x) => x.userId === 'u_crew');
  eq('the late approval pays as +40h arrears for W1', next.arrears.map((a) => [a.forPeriodKey, a.regularMinutes]), [[W1, 2400]]);
  eq('arrears pay = 40h×$20 = 800; gross = 0 current + 800 arrears', [r.arrearsPay, r.gross], [800, 800]);
}

// ═══ 5. OT approved AFTER the close → arrears ════════════════════════════════
{
  // W1: a 50h punch approved, but only 40h reg paid at close (no OT approval yet).
  const p = punch({ id: 'te_ot2', durationMinutes: 3000, clockInAt: '2026-06-08T12:00:00Z' });
  const { run: run1 } = closeWeek(W1, { entries: [p] });
  // Now approve 10h (600m) of that week's OT; recompute for W3.
  const next = computePayRun({ period: weeklyPeriod(W3), tz: TZ, entries: [p], otApprovals: [otAppr('u_crew', W1, 'c1', 600)], runs: [run1], arrearsWeeks: [`u_crew|${W1}`], users: USERS, otMultiplier: 1.5 });
  const r = next.rows.find((x) => x.userId === 'u_crew');
  eq('late OT approval pays as +10h OT arrears', next.arrears.map((a) => [a.forPeriodKey, a.regularMinutes, a.otMinutes]), [[W1, 0, 600]]);
  eq('arrears pay = 10h×$20×1.5 = 300', r.arrearsPay, 300);
}

// ═══ 6. a manual add EARLIER in a paid week → positive regular + OT deltas ════
{
  // W1 closed with one 30h approved punch (Wed) → 30h reg, 0 OT paid.
  const orig = punch({ id: 'te_orig', durationMinutes: 1800, clockInAt: '2026-06-10T12:00:00Z' });
  const { run: run1 } = closeWeek(W1, { entries: [orig], otApprovals: [] });
  // A manual 20h punch is added EARLIER (Mon) into the paid week, and its OT approved.
  const manual = punch({ id: 'te_manual', durationMinutes: 1200, clockInAt: '2026-06-08T12:00:00Z' });
  const next = computePayRun({ period: weeklyPeriod(W3), tz: TZ, entries: [orig, manual], otApprovals: [otAppr('u_crew', W1, 'c1', 600)], runs: [run1], arrearsWeeks: [`u_crew|${W1}`], users: USERS, otMultiplier: 1.5 });
  // Week now 50h → 40h reg + 10h OT. Paid was 30h reg. delta reg +10h (600m), OT +10h (600m).
  eq('a manual add into a paid week owes +regular and +OT', next.arrears.map((a) => [a.regularMinutes, a.otMinutes]), [[600, 600]]);
}

// ═══ 7. voiding an earlier (unpaid) punch → a NEGATIVE OT-premium delta ═══════
{
  // W1 closed: punch1 (Mon 10h, PENDING → paid 0) + punch2 (Wed 50h, approved). OT unit approved 1200 (20h).
  // Walk: p1 10h reg (worked, pending, paid 0); p2 30h reg + 20h OT, all payable. paid_weeks: reg 30h, OT 20h.
  const p1 = punch({ id: 'te_p1', durationMinutes: 600, clockInAt: '2026-06-08T12:00:00Z', approvalStatus: 'pending' });
  const p2 = punch({ id: 'te_p2', durationMinutes: 3000, clockInAt: '2026-06-10T12:00:00Z' });
  const otA = [otAppr('u_crew', W1, 'c1', 1200)];
  const { run: run1, res: close } = closeWeek(W1, { entries: [p1, p2], otApprovals: otA });
  const paid = (close.paidWeeksOut.find((x) => x.userId === 'u_crew') || {});
  eq('at close, punch2 alone paid 30h reg + 20h OT (the pending p1 paid 0)', [paid.regularMinutes, paid.otMinutes], [1800, 1200]);
  // VOID the earlier pending punch. Now p2 (50h) alone → 40h reg + 10h OT (payable, unit still 1200).
  const p1void = { ...p1, status: 'voided' };
  const next = computePayRun({ period: weeklyPeriod(W3), tz: TZ, entries: [p1void, p2], otApprovals: otA, runs: [run1], arrearsWeeks: [`u_crew|${W1}`], users: USERS, otMultiplier: 1.5 });
  const a = next.arrears[0];
  ok('voiding the earlier punch produces a NEGATIVE OT delta (−10h)', a && a.otMinutes === -600, JSON.stringify(next.arrears));
  // Net: was 30h reg + 20h OT paid; now 40h reg + 10h OT owed → reg +10h, OT −10h.
  eq('the signed week delta: +10h reg, −10h OT', [a.regularMinutes, a.otMinutes], [600, -600]);
}

// ═══ 8. close → recompute with NO change → ZERO arrears (idempotence) ═════════
{
  const p = punch({ id: 'te_idem', durationMinutes: 3000, clockInAt: '2026-06-08T12:00:00Z' });
  const otA = [otAppr('u_crew', W1, 'c1', 600)];
  const { run: run1 } = closeWeek(W1, { entries: [p], otApprovals: otA });
  const next = computePayRun({ period: weeklyPeriod(W3), tz: TZ, entries: [p], otApprovals: otA, runs: [run1], arrearsWeeks: [`u_crew|${W1}`], users: USERS, otMultiplier: 1.5 });
  eq('nothing changed since the close → zero arrears', next.arrears, []);
  const r = next.rows.find((x) => x.userId === 'u_crew');
  ok('...and no arrears pay', !r || r.arrearsPay === 0, JSON.stringify(r?.arrearsPay));
}

// ═══ 9. semi-monthly week straddling the 15th ════════════════════════════════
{
  // Sep 2026: the 1st–15th period. The pay week of Sun Sep 13 spans Sep 13–19, straddling
  // the 15th. A 50h punch that week has its OT day-attributed; only the days ≤15th pay here.
  const period = payPeriodRange('semimonthly', 0, '2026-09-10', TZ); // the 1st–15th half
  eq('semi-monthly first half is Sep 1–15', [period.fromKey, period.toKey], ['2026-09-01', '2026-09-15']);
  // Two 30h punches in the straddling week: Mon Sep 14 (in period) + Thu Sep 17 (out of period).
  const inP = punch({ id: 'sm_in', durationMinutes: 1800, clockInAt: '2026-09-14T12:00:00Z' });
  const outP = punch({ id: 'sm_out', durationMinutes: 1800, clockInAt: '2026-09-17T12:00:00Z' });
  const res = computePayRun({ period, tz: TZ, entries: [inP, outP], otApprovals: [otAppr('u_crew', payWeekOf('2026-09-14'), 'c1', 1200)], users: USERS, otMultiplier: 1.5 });
  const r = res.rows.find((x) => x.userId === 'u_crew');
  // Week total 60h → 40h reg + 20h OT. Walk in day order: Mon 30h → 30h reg; Thu 30h → 10h reg + 20h OT.
  // Only Mon (Sep 14 ≤ 15) is IN this half: 30h reg, 0 OT.
  eq('only the in-period days of a straddling week pay here (30h reg, 0 OT)', [r.current.regularMinutes, r.current.otMinutes], [1800, 0]);
}
function payWeekOf(key) { return payPeriodRange('weekly', 0, key, TZ).fromKey; }

// ═══ 10. the pay run EQUALS today's usePayrollRun pricing (all approved, no runs) ═══
// The money guarantee: for a period with every punch approved and every worked OT approved,
// computePayRun (approved-only) must price base + gross IDENTICALLY to the operational-lens
// pricing usePayrollRun uses today (payrollByUser/Clipped → basePayForUser → grossForUser).
function assertEqualsUsePayrollRun(label, { cadence, dateInPeriod, entries, drive = [] }) {
  const period = payPeriodRange(cadence, 0, dateInPeriod, TZ);
  // Approve every worked OT unit generously so the approved-only lens equals the operational
  // one, then price the period.
  const full = computePayRun({ period, tz: TZ, entries, driveSegments: drive, otApprovals: fullyApproveOt(entries, drive), users: USERS, otMultiplier: 1.5 });

  // Oracle: the pure functions usePayrollRun composes today.
  const rows = cadence === 'semimonthly'
    ? payrollByUserClipped(entries, { approvedOnly: false, weekStartDay: 0, tz: TZ, driveSegments: drive, clipFromKey: period.fromKey, clipToKey: period.toKey })
    : payrollByUser(entries, { approvedOnly: false, weekStartDay: 0, tz: TZ, driveSegments: drive });
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const roster = payRunRoster({ users: USERS, hoursRows: rows, lines: [], periodKey: period.fromKey, periodFromIso: period.fromIso });
  for (const u of roster.members) {
    const pay = u.pay || { type: null };
    const expBase = basePayForUser(byUser.get(u.id) || null, pay, { otMultiplier: 1.5 });
    const expGross = grossForUser(byUser.get(u.id) || null, pay, [], { otMultiplier: 1.5 });
    const got = full.rows.find((r) => r.userId === u.id);
    ok(`${label}: ${u.id} base matches usePayrollRun`, (got ? got.base : null) === expBase, `pay-run ${got?.base} vs oracle ${expBase}`);
    ok(`${label}: ${u.id} gross matches usePayrollRun`, (got ? got.gross : null) === expGross, `pay-run ${got?.gross} vs oracle ${expGross}`);
  }
}
// One OT approval per (user, week, client) with a huge total, so every worked OT item is
// fully payable — the lens under which approved-only pricing must equal the operational one.
function fullyApproveOt(entries, drive) {
  const units = new Map();
  for (const e of entries) units.set(`${e.userId}|${payWeekOf2(e.clockInAt)}|${e.clientId || ''}`, { userId: e.userId, weekKey: payWeekOf2(e.clockInAt), clientId: e.clientId || '', approvedOtMinutes: 100000 });
  for (const s of drive) units.set(`${s.userId}|${payWeekOf2(s.startAt)}|${s.toClientId || ''}`, { userId: s.userId, weekKey: payWeekOf2(s.startAt), clientId: s.toClientId || '', approvedOtMinutes: 100000 });
  return [...units.values()];
}
function payWeekOf2(iso) { return payPeriodRange('weekly', 0, iso, TZ).fromKey; }
{
  const biEntries = [
    punch({ id: 'e1', userId: 'u_crew', durationMinutes: 2700, clockInAt: '2026-06-08T12:00:00Z' }), // 45h wk1 → 5h OT
    punch({ id: 'e2', userId: 'u_crew', durationMinutes: 1200, clockInAt: '2026-06-16T12:00:00Z' }), // 20h wk2
    punch({ id: 'e3', userId: 'u_pv', durationMinutes: 120, clockInAt: '2026-06-09T12:00:00Z' }),
    punch({ id: 'e4', userId: 'u_sal', durationMinutes: 480, clockInAt: '2026-06-09T12:00:00Z' }),
  ];
  const drive = [{ key: 'd1', userId: 'u_crew', userName: 'Crew', startAt: '2026-06-08T21:00:00Z', toEntryId: 'e1b', toClientId: 'c1', paidMinutes: 60, actualMinutes: 60, fromStatus: 'completed', toStatus: 'completed', fromApprovalStatus: 'approved', toApprovalStatus: 'approved' }];
  assertEqualsUsePayrollRun('biweekly', { cadence: 'biweekly', dateInPeriod: '2026-06-10', entries: biEntries, drive });
  const smEntries = [
    punch({ id: 's1', userId: 'u_crew', durationMinutes: 3000, clockInAt: '2026-09-14T12:00:00Z' }), // straddles the 15th
    punch({ id: 's2', userId: 'u_crew', durationMinutes: 600, clockInAt: '2026-09-07T12:00:00Z' }),
  ];
  assertEqualsUsePayrollRun('semimonthly', { cadence: 'semimonthly', dateInPeriod: '2026-09-10', entries: smEntries, drive: [] });
}

console.log(`\npay-run: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL ${f}`); process.exit(1); }
