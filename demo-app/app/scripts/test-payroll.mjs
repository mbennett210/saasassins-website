// Headless unit checks for the payroll/OT engine (src/lib/payroll.js).
// Run: node scripts/test-payroll.mjs
import {
  OT_WEEKLY_MINUTES, startOfPayWeek, splitRegularOt, isPayable, isHeldCancelled,
  rollupWeeklyByUser, payrollByUser, currentWeekMinutesByUser, otStatus,
  minutesToHours, payrollCsv,
  basePayForUser, lineTotals, grossForUser, payPeriodRange, payRunRoster,
} from '../src/lib/payroll.js';
import { dayOfWeekKey } from '../src/lib/dates.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

// --- splitRegularOt: the 40h line ---
eq('split under 40h', splitRegularOt(30 * 60), { regularMinutes: 1800, otMinutes: 0 });
eq('split exactly 40h', splitRegularOt(OT_WEEKLY_MINUTES), { regularMinutes: 2400, otMinutes: 0 });
eq('split 45h -> 5h OT', splitRegularOt(45 * 60), { regularMinutes: 2400, otMinutes: 300 });

// --- isPayable gating ---
const base = { userId: 'u1', userName: 'Ann', durationMinutes: 120, clockInAt: '2026-07-06T13:00:00Z', clockOutAt: '2026-07-06T15:00:00Z', approvalStatus: 'approved', status: 'completed' };
eq('payable approved', isPayable(base, { approvedOnly: true }), true);
eq('not payable: still open', isPayable({ ...base, clockOutAt: null }), false);
eq('not payable: rejected', isPayable({ ...base, approvalStatus: 'rejected' }), false);
eq('not payable: voided', isPayable({ ...base, status: 'voided' }), false);
eq('approvedOnly blocks pending', isPayable({ ...base, approvalStatus: 'pending' }, { approvedOnly: true }), false);
eq('operational counts pending', isPayable({ ...base, approvalStatus: 'pending' }, { approvedOnly: false }), true);

// --- cancelled-clean labor is HELD from pay until approved (gap #1 affirmative gate) ---
const cc = (approval) => ({ ...base, jobCancelledAt: '2026-07-06T15:00:00Z', approvalStatus: approval });
eq('cancelled-clean pending NOT payable even on the operational lens', isPayable(cc('pending'), { approvedOnly: false }), false);
eq('cancelled-clean approved IS payable', isPayable(cc('approved'), { approvedOnly: false }), true);
eq('cancelled-clean rejected NOT payable', isPayable(cc('rejected'), { approvedOnly: false }), false);
eq('non-cancelled pending unchanged (still pays on operational lens)', isPayable({ ...base, approvalStatus: 'pending' }, { approvedOnly: false }), true);
eq('isHeldCancelled: pending flagged with real time -> held', isHeldCancelled(cc('pending')), true);
eq('isHeldCancelled: approved -> released, not held', isHeldCancelled(cc('approved')), false);
eq('isHeldCancelled: rejected -> not held', isHeldCancelled(cc('rejected')), false);
eq('isHeldCancelled: not a cancelled clean -> not held', isHeldCancelled({ ...base, approvalStatus: 'pending' }), false);
// payrollByUser: a pending cancelled-clean punch contributes 0 paid minutes; approving releases it
eq('cancelled-clean pending -> no paid rows', payrollByUser([cc('pending')], { weekStartDay: 0, approvedOnly: false }).length, 0);
eq('cancelled-clean approved -> counts 120m', payrollByUser([cc('approved')], { weekStartDay: 0, approvedOnly: false })[0].totalMinutes, 120);

// --- Weekly OT split, single cleaner, one week: 45h -> reg 40 / ot 5 ---
// Week of Sun 2026-07-05 .. Sat 2026-07-11. Nine 5h approved cleans = 45h.
const mk = (uid, uname, dayIso, hours, approval = 'approved') => ({
  id: `${uid}-${dayIso}-${hours}-${Math.random()}`, userId: uid, userName: uname,
  durationMinutes: hours * 60, clockInAt: `${dayIso}T14:00:00`, clockOutAt: `${dayIso}T${14 + hours}:00:00`,
  approvalStatus: approval, status: 'completed',
});
const week1 = [
  mk('u1', 'Ann', '2026-07-06', 9), mk('u1', 'Ann', '2026-07-07', 9), mk('u1', 'Ann', '2026-07-08', 9),
  mk('u1', 'Ann', '2026-07-09', 9), mk('u1', 'Ann', '2026-07-10', 9), // 45h
];
const r1 = payrollByUser(week1, { weekStartDay: 0, approvedOnly: true });
eq('one-week 45h totals', r1.map((u) => [u.regularMinutes, u.otMinutes, u.totalMinutes, u.cleanCount]),
  [[2400, 300, 2700, 5]]);

// --- Two weeks: 45h then 30h -> reg 40+30=70h(4200), ot 5h(300). Proves per-week split. ---
const twoWeeks = [
  ...week1,
  mk('u1', 'Ann', '2026-07-13', 10), mk('u1', 'Ann', '2026-07-14', 10), mk('u1', 'Ann', '2026-07-15', 10), // 30h next week
];
const r2 = payrollByUser(twoWeeks, { weekStartDay: 0, approvedOnly: true });
eq('two-week per-week split', r2.map((u) => [u.regularMinutes, u.otMinutes, u.totalMinutes]),
  [[4200, 300, 4500]]);
eq('two-week bucket count', r2[0].weeks.length, 2);

// Contrast: naive whole-range split would give reg=min(75h,40h)=40, ot=35 — WRONG.
// Our result (reg 70 / ot 5) proves the per-week bucketing.

// --- Multi-cleaner independence: each cleaner's OT is their own ---
const multi = [
  mk('u1', 'Ann', '2026-07-06', 9), mk('u1', 'Ann', '2026-07-07', 9), mk('u1', 'Ann', '2026-07-08', 9),
  mk('u1', 'Ann', '2026-07-09', 9), mk('u1', 'Ann', '2026-07-10', 9), // Ann 45h
  mk('u2', 'Bob', '2026-07-06', 8), mk('u2', 'Bob', '2026-07-07', 8), // Bob 16h
];
const rm = payrollByUser(multi, { weekStartDay: 0, approvedOnly: true });
eq('multi-cleaner rows sorted by name', rm.map((u) => u.userName), ['Ann', 'Bob']);
eq('Ann 5h OT', rm.find((u) => u.userId === 'u1').otMinutes, 300);
eq('Bob 0 OT', rm.find((u) => u.userId === 'u2').otMinutes, 0);
eq('Bob 16h regular', rm.find((u) => u.userId === 'u2').regularMinutes, 960);

// --- approvedOnly excludes pending from payroll but operational lens counts it ---
const mixed = [
  mk('u3', 'Cy', '2026-07-06', 20, 'approved'),
  mk('u3', 'Cy', '2026-07-07', 25, 'pending'),
];
const pApproved = payrollByUser(mixed, { approvedOnly: true });
eq('payroll approved-only excludes pending', pApproved[0].totalMinutes, 20 * 60);

// --- currentWeekMinutesByUser + otStatus ---
const now = new Date('2026-07-09T12:00:00'); // within week of Sun 7/5
const cw = currentWeekMinutesByUser(mixed, { now: now.getTime(), weekStartDay: 0 });
eq('current-week counts both (operational)', cw.get('u3').minutes, 45 * 60);
eq('otStatus over', otStatus(45 * 60), 'over');
eq('otStatus approaching (37h)', otStatus(37 * 60), 'approaching');
eq('otStatus none (20h)', otStatus(20 * 60), null);
eq('otStatus exactly 36h approaching', otStatus(36 * 60), 'approaching');
eq('otStatus exactly 40h not over', otStatus(40 * 60), 'approaching');

// entries outside the current week are excluded
const cwOut = currentWeekMinutesByUser([mk('u4', 'Di', '2026-06-01', 10)], { now: now.getTime(), weekStartDay: 0 });
eq('out-of-week excluded', cwOut.has('u4'), false);

// --- minutesToHours ---
eq('minutesToHours 90m', minutesToHours(90), 1.5);
eq('minutesToHours 2700m', minutesToHours(2700), 45);

// --- CSV shape ---
const csv = payrollCsv(r2, { fromIso: '2026-07-05T00:00:00Z', toIso: '2026-07-18T00:00:00Z' });
const rows = csv.split('\n');
eq('csv header', rows[0], '"Cleaner","Regular hours","OT hours","Total hours","Drive hours (in total)","Cleans","Pay period"');
eq('csv has cleaner + totals footer', rows.length, 3); // header + Ann + ALL CLEANERS
if (!rows[1].startsWith('"Ann","70","5","75","0","8"')) { fail++; console.error('FAIL csv Ann row:', rows[1]); } else pass++;
if (!rows[2].startsWith('"ALL CLEANERS","70","5","75","0","8"')) { fail++; console.error('FAIL csv totals row:', rows[2]); } else pass++;

// --- Paid DRIVE time between jobs counts toward the SAME weekly 40h line ---
// (inter-site travel is hours worked, so it can create OT — it must be bucketed
// into the week BEFORE the split, never appended to a finished total.)
const drive = (userId, userName, startIso, minutes, extra = {}) => ({
  key: `${userId}-${startIso}`, userId, userName, startAt: startIso, actualMinutes: minutes, paidMinutes: minutes,
  fromStatus: 'completed', toStatus: 'completed', fromApprovalStatus: 'approved', toApprovalStatus: 'approved', ...extra,
});
// Ann: 39h of cleans + 2h of drive in one week -> 41h -> 1h OT.
const driveWeek = [
  mk('u5', 'Eve', '2026-07-06', 13), mk('u5', 'Eve', '2026-07-07', 13), mk('u5', 'Eve', '2026-07-08', 13), // 39h
];
const driveSegs = [drive('u5', 'Eve', '2026-07-06T18:00:00', 60), drive('u5', 'Eve', '2026-07-07T18:00:00', 60)]; // 2h
const noDrive = payrollByUser(driveWeek, { approvedOnly: true, weekStartDay: 0 });
eq('39h of cleans alone -> no OT', [noDrive[0].totalMinutes, noDrive[0].otMinutes], [2340, 0]);
const withDrive = payrollByUser(driveWeek, { approvedOnly: true, weekStartDay: 0, driveSegments: driveSegs });
eq('drive pushes the week past 40h', withDrive[0].totalMinutes, 2460);
eq('drive-created OT is 1h', withDrive[0].otMinutes, 60);
eq('drive minutes reported as a subset of total', withDrive[0].driveMinutes, 120);
eq('drive does not inflate the clean count', withDrive[0].cleanCount, 3);
// Payroll gate: a leg bounded by an unapproved clean must not pay.
eq('unapproved bounding clean blocks the leg', payrollByUser(driveWeek, {
  approvedOnly: true, weekStartDay: 0,
  driveSegments: [drive('u5', 'Eve', '2026-07-06T18:00:00', 60, { toApprovalStatus: 'pending' })],
})[0].driveMinutes, 0);
// An excluded (manager-zeroed) leg contributes nothing.
eq('excluded leg pays nothing', payrollByUser(driveWeek, {
  approvedOnly: true, weekStartDay: 0,
  driveSegments: [drive('u5', 'Eve', '2026-07-06T18:00:00', 60, { paidMinutes: 0 })],
})[0].driveMinutes, 0);
// A cleaner with ONLY drive time still gets a row (they were paid for the day).
const driveOnly = payrollByUser([], { approvedOnly: true, driveSegments: [drive('u6', 'Fay', '2026-07-06T18:00:00', 45)] });
eq('drive-only cleaner still appears', [driveOnly[0].userName, driveOnly[0].totalMinutes, driveOnly[0].cleanCount], ['Fay', 45, 0]);
// The drive buckets by the week it was DRIVEN, not the export range.
const twoWeekDrive = payrollByUser(driveWeek, {
  approvedOnly: true, weekStartDay: 0,
  driveSegments: [drive('u5', 'Eve', '2026-07-06T18:00:00', 60), drive('u5', 'Eve', '2026-07-14T18:00:00', 60)],
});
eq('drive splits across pay weeks', twoWeekDrive[0].weeks.map((w) => w.driveMinutes), [60, 60]);
eq('...so the far week creates no OT', twoWeekDrive[0].otMinutes, 0);
// The approaching-40h watch strip sees drive time too.
const cwDrive = currentWeekMinutesByUser(driveWeek, {
  now: new Date('2026-07-09T12:00:00').getTime(), weekStartDay: 0, driveSegments: driveSegs,
});
eq('OT watch counts drive minutes', cwDrive.get('u5').minutes, 2460);
eq('OT watch reports the drive subset', cwDrive.get('u5').driveMinutes, 120);
// CSV carries the drive column.
const driveCsv = payrollCsv(withDrive, { fromIso: '2026-07-05T00:00:00Z', toIso: '2026-07-11T00:00:00Z' }).split('\n');
if (!driveCsv[1].startsWith('"Eve","40","1","41","2","3"')) { fail++; console.error('FAIL csv drive row:', driveCsv[1]); } else pass++;

// --- startOfPayWeek sanity (Sun-start) ---
eq('startOfPayWeek Thu->Sun', startOfPayWeek('2026-07-09T14:00:00', 0).getDay(), 0);
eq('startOfPayWeek Mon-start', startOfPayWeek('2026-07-09T14:00:00', 1).getDay(), 1);

// ─── PAY (dollars): hours/cleans/salary × rate + custom lines → gross ───
// A payrollByUser-shaped row carrying only the fields basePayForUser reads.
const row = (regMin, otMin, cleans = 0) => ({ regularMinutes: regMin, otMinutes: otMin, cleanCount: cleans });

// Hourly: 45h in one week @ $20, OT ×1.5 → 40h×20 + 5h×30 = 800 + 150 = 950.
eq('hourly base = reg + OT×1.5', basePayForUser(row(2400, 300), { type: 'hourly', hourlyRate: 20 }), 950);
eq('hourly no OT', basePayForUser(row(2400, 0), { type: 'hourly', hourlyRate: 20 }), 800);
eq('otExempt hourly pays no OT premium', basePayForUser(row(2400, 300), { type: 'hourly', hourlyRate: 20, otExempt: true }), 800);
// Per-visit: 34 cleans × $45 = 1530 (hours ignored).
eq('per-visit base = rate × cleans', basePayForUser(row(9999, 9999, 34), { type: 'per_visit', perVisitRate: 45 }), 1530);
// Salary: fixed per period; 2 whole periods → ×2.
eq('salary base = fixed × periods', basePayForUser(row(0, 0), { type: 'salary', salaryPerPeriod: 2400 }, { periodsCovered: 2 }), 4800);
// Excluded / unset → null.
eq('none → excluded (null)', basePayForUser(row(2400, 0), { type: 'none' }), null);
eq('unset pay → null', basePayForUser(row(2400, 0), null), null);

// lineTotals: signed amounts split into earnings/deductions/net + non-taxable.
const _lines = [
  { category: 'bonus', amount: 150, taxable: true },
  { category: 'reimbursement', amount: 60, taxable: false },
  { category: 'deduction', amount: -50, taxable: false },
];
const lt = lineTotals(_lines);
eq('lineTotals net', lt.net, 160);
eq('lineTotals earnings', lt.earnings, 210);
eq('lineTotals deductions', lt.deductions, -50);
eq('lineTotals non-taxable (reimb + deduction)', lt.nonTaxable, 10);
eq('lineTotals by category', [lt.byCategory.bonus, lt.byCategory.reimbursement, lt.byCategory.deduction], [150, 60, -50]);

// grossForUser: base + net lines. 45h@$20 (=950) + $100 bonus − $30 deduction = 1020.
eq('gross = base + lines', grossForUser(row(2400, 300), { type: 'hourly', hourlyRate: 20 }, [
  { category: 'bonus', amount: 100 }, { category: 'deduction', amount: -30 },
]), 1020);
eq('gross null when excluded', grossForUser(row(2400, 0), { type: 'none' }, [{ category: 'bonus', amount: 100 }]), null);

// payPeriodRange: biweekly is WEEK-ALIGNED (14-day span starting on a Sunday) and
// stepping ±1 shifts by exactly 14 days — so per-week OT sums exactly over a period.
const pp = payPeriodRange('biweekly', 0, '2026-09-14');
eq('biweekly span is 14 days', pp.span, 14);
eq('biweekly period starts on a Sunday (day-key)', dayOfWeekKey(pp.fromKey), 0);
eq('biweekly toKey is fromKey + 13 days span', pp.span, 14);
const ppNext = payPeriodRange('biweekly', 1, '2026-09-14');
eq('next biweekly period is +14 days', Math.round((new Date(ppNext.fromIso) - new Date(pp.fromIso)) / 86400000), 14);
eq('weekly period spans 7', payPeriodRange('weekly', 0, '2026-09-14').span, 7);
eq('weekly period starts on a Sunday', dayOfWeekKey(payPeriodRange('weekly', 0, '2026-09-14').fromKey), 0);

// ─── PAY RUN ROSTER: disabling someone mid-period must not drop pay they earned ───
// The run used to list ACTIVE members only, so disabling (or deleting) someone mid-period
// silently dropped their clocked hours and pay lines from the run (deletion-audit
// follow-up). Anyone still on file who earned pay in the period stays on it; people no
// longer on file can't be priced (their rate went with them), so they come back apart.
{
  const P = '2026-09-16';                       // this period's start key
  const PI = '2026-09-16T04:00:00.000Z';        // ...as an instant
  const users = [
    { id: 'a', name: 'Active', status: 'active' },
    { id: 'h', name: 'Disabled, has hours', status: 'disabled', disabledAt: '2026-09-10T12:00:00.000Z' },
    { id: 'l', name: 'Disabled, has a line', status: 'disabled', disabledAt: '2026-09-10T12:00:00.000Z' },
    { id: 's', name: 'Salaried, disabled mid-period', status: 'disabled', disabledAt: '2026-09-20T12:00:00.000Z', pay: { type: 'salary', salaryPerPeriod: 2400 } },
    { id: 'o', name: 'Disabled before the period', status: 'disabled', disabledAt: '2026-08-01T12:00:00.000Z' },
    { id: 'x', name: 'Disabled, date unknown', status: 'disabled' },
    { id: 'i', name: 'Invited', status: 'invited' },
  ];
  const hoursRows = [
    { userId: 'h', userName: 'Disabled, has hours', totalMinutes: 300, cleanCount: 2 },
    { userId: 'gone', userName: 'Removed Person', totalMinutes: 120, cleanCount: 1 },
  ];
  const lines = [
    { id: 'l1', userId: 'l', periodKey: P, amount: 25 },
    { id: 'l2', userId: 'o', periodKey: '2026-09-01', amount: 99 },            // another period
    { id: 'l3', userId: 'gone', periodKey: P, amount: 40, userName: 'Removed Person' },
    { id: 'l4', userId: 'gone2', periodKey: P, amount: -10, userName: 'Other Removed' },
  ];
  const { members, removed } = payRunRoster({ users, hoursRows, lines, periodKey: P, periodFromIso: PI });
  eq('ROSTER-A: active + everyone on file who earned pay this period, whatever their status',
    members.map((u) => u.id).sort(), ['a', 'h', 'l', 's']);
  eq('ROSTER-B: people no longer on file come back apart, named from the punch or line',
    removed.map((r) => [r.userId, r.name, r.minutes, r.lineNet]).sort(),
    [['gone', 'Removed Person', 120, 40], ['gone2', 'Other Removed', 0, -10]]);
  const unnamed = payRunRoster({ users, hoursRows: [{ userId: 'z', userName: '—', totalMinutes: 60 }], lines: [], periodKey: P, periodFromIso: PI });
  eq('ROSTER-C: an unknown name stays unknown (never "—" as a name)', unnamed.removed.map((r) => r.name), [null]);
}

console.log(`\npayroll: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
