// PAY-6, THE MONEY HALF (Matt, 2026-09-29: "Should drive time between buildings be paid?
// — (b) No. we dont use this.").
//
// The defect this pins: `opsSettings.payDriveTime` was DISPLAY-ONLY. Nothing in the pay run
// read it, and `lib/driveTime.applyDriveOverrides` defaults a leg's `paidMinutes` to its
// `actualMinutes`, so with drive pay "off" those minutes were still folded into the weekly
// 40h walk and priced into Base pay. The office could turn drive pay off and keep paying it.
//
// The contract, one cleaner with one drive leg, priced BOTH ways:
//   payDriveTime FALSE → the leg pays $0 and adds 0 hours (regular, OT and total), and the
//                        row's reported driveMinutes is 0, so the drawer's "Includes N paid
//                        drive" line tells the truth by disappearing.
//   payDriveTime TRUE  → byte-identical to today (the setting's own default).
// The leg is still RECORDED either way: this is about pay, not about the drive report.
//
// Asserted against the SETTING'S SOURCE-OF-TRUTH DEFAULT (`OPS_SETTINGS_PAY_DRIVE_DEFAULT`
// from lib/driveTime, which the seed's own value must equal), never a restated `true`.
//
//   node app/scripts/test-drive-pay-off.mjs
import { readFileSync } from 'node:fs';
import { computePayRun } from '../src/lib/payRun.js';
import { payPeriodRange, payrollByUser, basePayForUser } from '../src/lib/payroll.js';
import {
  drivePayEnabled, payableDriveSegments, OPS_SETTINGS_PAY_DRIVE_DEFAULT, segmentPaidMinutes,
} from '../src/lib/driveTime.js';
import { computeWeekLedger } from '../src/lib/otLedger.js';
// seed.js carries Vite-style extensionless imports, so it loads through the shared resolve
// shim (the same one the reducer suites use).
import { installResolveShim } from './deletion-core.mjs';

installResolveShim();
const { INITIAL_STATE } = await import(new URL('../src/data/seed.js', import.meta.url).href);

const TZ = 'America/New_York';
let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the setting's own default, and the seed agreeing with it ──────────────────
eq('the default is a boolean', typeof OPS_SETTINGS_PAY_DRIVE_DEFAULT, 'boolean');
eq('the seed ships the same default', INITIAL_STATE.opsSettings.payDriveTime, OPS_SETTINGS_PAY_DRIVE_DEFAULT);
eq('an absent setting reads as the default', drivePayEnabled({}), OPS_SETTINGS_PAY_DRIVE_DEFAULT);
eq('no settings at all reads as the default', drivePayEnabled(), OPS_SETTINGS_PAY_DRIVE_DEFAULT);
eq('explicit true is on', drivePayEnabled({ payDriveTime: true }), true);
eq('explicit FALSE is off', drivePayEnabled({ payDriveTime: false }), false);
// Only a literal false turns it off — a truthy-but-wrong stored value fails to the paying
// side, which is the safe direction for a wage.
eq("the string 'false' is not off", drivePayEnabled({ payDriveTime: 'false' }), true);
eq('null is not off', drivePayEnabled({ payDriveTime: null }), true);

// ── the filter the pricer applies ────────────────────────────────────────────
const leg = (o = {}) => ({
  key: o.key || 'sA|sB',
  userId: o.userId || 'u_crew', userName: 'Crew',
  startAt: o.startAt || '2026-06-08T21:00:00Z',
  endAt: o.endAt || '2026-06-08T22:00:00Z',
  actualMinutes: o.actualMinutes ?? 60,
  paidMinutes: o.paidMinutes ?? (o.actualMinutes ?? 60),
  fromStatus: 'completed', toStatus: 'completed',
  fromApprovalStatus: 'approved', toApprovalStatus: 'approved',
  clientId: o.clientId ?? 'c1',
});
{
  const segs = [leg(), leg({ key: 'sB|sC' })];
  eq('with drive pay ON every leg is kept', payableDriveSegments(segs, { payDriveTime: true }).length, 2);
  eq('with drive pay OFF none is', payableDriveSegments(segs, { payDriveTime: false }).length, 0);
  eq('an absent setting keeps them (the default)', payableDriveSegments(segs, {}).length, 2);
  eq('no list is no legs', payableDriveSegments(undefined, {}).length, 0);
  // The leg is still a RECORDED leg with its own paid minutes — the drive REPORT is unchanged.
  eq('the drive report still values the leg', segmentPaidMinutes(segs[0]), 60);
}

// ── the weekly ledger, which is where the hours come from ─────────────────────
{
  const punch = {
    id: 'te_1', userId: 'u_crew', userName: 'Crew', clientId: 'c1', siteId: 's1',
    clockInAt: '2026-06-08T12:00:00Z', clockOutAt: '2026-06-08T20:00:00Z', durationMinutes: 480,
    status: 'completed', approvalStatus: 'approved', jobCancelledAt: null,
  };
  const on = computeWeekLedger({ entries: [punch], driveSegments: payableDriveSegments([leg()], { payDriveTime: true }), tz: TZ });
  const off = computeWeekLedger({ entries: [punch], driveSegments: payableDriveSegments([leg()], { payDriveTime: false }), tz: TZ });
  const drive = (r) => r.items.filter((i) => i.kind === 'drive').length;
  eq('ON: the ledger carries the drive item', drive(on), 1);
  eq('OFF: it carries none', drive(off), 0);
  const mins = (r) => r.items.reduce((s, i) => s + (i.regularMinutes || 0) + (i.otMinutes || 0), 0);
  eq('ON: 8h of labour + 1h of drive = 540 payable minutes', mins(on), 540);
  eq('OFF: the labour alone', mins(off), 480);
}

// ══════════════ THE MONEY: one cleaner, one drive leg, priced both ways ═══════
// 38 hours of cleans in one week + a 1-hour drive leg, at $20/h. With drive paid that is
// 39 h; with drive off it is 38 h — and the hour must not be paid, at any rate, in any bucket.
const USERS = [{ id: 'u_crew', name: 'Crew', status: 'active', pay: { type: 'hourly', hourlyRate: 20 } }];
const W1 = '2026-06-07';
const punchOf = (mins, at) => ({
  id: `te_${at}`, userId: 'u_crew', userName: 'Crew', clientId: 'c1', siteId: 's1',
  clockInAt: at, clockOutAt: new Date(Date.parse(at) + mins * 60000).toISOString(), durationMinutes: mins,
  status: 'completed', approvalStatus: 'approved', jobCancelledAt: null,
});
const ENTRIES = [
  punchOf(480, '2026-06-08T12:00:00Z'),
  punchOf(480, '2026-06-09T12:00:00Z'),
  punchOf(480, '2026-06-10T12:00:00Z'),
  punchOf(480, '2026-06-11T12:00:00Z'),
  punchOf(360, '2026-06-12T12:00:00Z'),
];
const DRIVE = [leg({ startAt: '2026-06-08T20:00:00Z', endAt: '2026-06-08T21:00:00Z' })];
// Approve the OT generously so nothing is HELD and the two runs differ only by the drive.
const OT = [{ userId: 'u_crew', weekKey: W1, clientId: 'c1', approvedOtMinutes: 600 }];
const period = payPeriodRange('weekly', 0, W1, TZ);
const run = (payDriveTime) => computePayRun({
  period, tz: TZ, entries: ENTRIES, driveSegments: DRIVE, otApprovals: OT,
  users: USERS, otMultiplier: 1.5, payDriveTime,
});

{
  const on = run(true);
  const off = run(false);
  const rowOf = (r) => r.rows.find((x) => x.userId === 'u_crew');
  const onRow = rowOf(on);
  const offRow = rowOf(off);

  // 38 h of cleans: 2280 minutes, all regular (under the 40 h line).
  eq('OFF: regular minutes are the cleans alone', offRow.current.regularMinutes, 2280);
  eq('OFF: no OT', offRow.current.otMinutes, 0);
  eq('OFF: driveMinutes is 0, so the drawer line tells the truth', offRow.current.driveMinutes, 0);
  eq('OFF: base pay is 38 h × $20', offRow.base, 760);
  eq('OFF: gross is the same', offRow.gross, 760);

  // ON: the drive hour pushes the week to 39 h — still under 40, so it is regular pay.
  eq('ON: the drive hour is in the regular minutes', onRow.current.regularMinutes, 2340);
  eq('ON: driveMinutes reports the leg', onRow.current.driveMinutes, 60);
  eq('ON: base pay is 39 h × $20', onRow.base, 780);
  ok('OFF pays LESS than ON, by exactly the drive hour', onRow.base - offRow.base === 20,
    `${onRow.base} vs ${offRow.base}`);

  // …and the summary + the CSV file rows the close stores agree.
  eq('OFF: the run summary gross excludes the drive', off.summary.gross, 760);
  eq('ON: it includes it', on.summary.gross, 780);
  const fileOf = (r) => r.file.rows.find((x) => x.userName === 'Crew');
  eq("OFF: the close file's regular hours are the cleans alone", fileOf(off).regularMinutes, 2280);
  eq('ON: the close file carries the drive hour', fileOf(on).regularMinutes, 2340);
  eq('OFF: the close file gross', fileOf(off).gross, 760);

  // The DEFAULT must behave as ON — turning nothing on must not change anyone's pay.
  const byDefault = computePayRun({
    period, tz: TZ, entries: ENTRIES, driveSegments: DRIVE, otApprovals: OT, users: USERS, otMultiplier: 1.5,
  });
  eq('omitting the flag prices exactly as ON (today, unchanged)',
    JSON.stringify(rowOf(byDefault).current), JSON.stringify(onRow.current));
  eq('…and to the same money', rowOf(byDefault).base, onRow.base);
}

// ── drive that would have CREATED overtime pays nothing when it is off ────────
// 39 h of cleans + 2 h of drive = 41 h, so with drive paid the leg buys an hour of OT at 1.5×.
{
  const entries = [
    punchOf(480, '2026-06-08T12:00:00Z'), punchOf(480, '2026-06-09T12:00:00Z'),
    punchOf(480, '2026-06-10T12:00:00Z'), punchOf(480, '2026-06-11T12:00:00Z'),
    punchOf(420, '2026-06-12T12:00:00Z'),
  ];
  const drive = [
    leg({ key: 'a|b', startAt: '2026-06-08T20:00:00Z', endAt: '2026-06-08T21:00:00Z' }),
    leg({ key: 'b|c', startAt: '2026-06-09T20:00:00Z', endAt: '2026-06-09T21:00:00Z' }),
  ];
  const mk = (payDriveTime) => computePayRun({
    period, tz: TZ, entries, driveSegments: drive, otApprovals: OT, users: USERS, otMultiplier: 1.5, payDriveTime,
  }).rows.find((r) => r.userId === 'u_crew');
  const on = mk(true);
  const off = mk(false);
  eq('ON: the drive legs create 1 h of OT', on.current.otMinutes, 60);
  eq('OFF: there is no OT at all', off.current.otMinutes, 0);
  eq('OFF: 39 h straight', off.current.regularMinutes, 2340);
  eq('ON: 40 h regular + 1 h OT', [on.current.regularMinutes, on.current.otMinutes], [2400, 60]);
  eq('ON: base is 40×20 + 1×30', on.base, 830);
  eq('OFF: base is 39×20', off.base, 780);
}

// ── the Hours report's attribution agrees with the pay run, both ways ─────────
// Reports › Hours is payroll-equivalent (MISC-3), so it must not show hours the run refuses
// to pay. It gates its own read on the setting; this asserts the two land on the same number.
{
  const hoursRowsFor = (payDriveTime) => payrollByUser(ENTRIES, {
    approvedOnly: false, weekStartDay: 0, tz: TZ,
    driveSegments: payableDriveSegments(DRIVE, { payDriveTime }),
  }).find((r) => r.userId === 'u_crew');
  for (const payDriveTime of [true, false]) {
    const report = hoursRowsFor(payDriveTime);
    const payRow = run(payDriveTime).rows.find((r) => r.userId === 'u_crew');
    eq(`drive pay ${payDriveTime ? 'ON' : 'OFF'}: the report's total minutes equal the run's`,
      report.regularMinutes + report.otMinutes,
      payRow.current.regularMinutes + payRow.current.otMinutes);
    eq(`drive pay ${payDriveTime ? 'ON' : 'OFF'}: …and its drive subset does`,
      report.driveMinutes, payRow.current.driveMinutes);
    eq(`drive pay ${payDriveTime ? 'ON' : 'OFF'}: …and the pay priced off it`,
      basePayForUser(report, USERS[0].pay, { otMultiplier: 1.5 }), payRow.base);
  }
}

// ── every PAY path reads the ONE rule, and the drive REPORT does not ─────────
// Mechanical, because the defect was a missing reader: a new pricing caller that forgets the
// setting would pay drive again, and there is no arithmetic that can catch that from outside.
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  const payRun = read('../src/lib/payRun.js');
  ok('the pricer takes the setting', /payDriveTime = true,/.test(payRun));
  ok('…and filters the legs through the shared rule before the ledger',
    /const payableDrive = payableDriveSegments\(driveSegments, \{ payDriveTime \}\);/.test(payRun));
  ok('…and the weekly ledger sees ONLY the filtered legs',
    /computeWeekLedger\(\{ entries, driveSegments: payableDrive,/.test(payRun));
  ok('…with no unfiltered use left', !/driveSegments,\s*otApprovals, tz, weekStartDay \}\)/.test(payRun));

  for (const [label, rel] of [['the server pay run', '../api/_lib/payroll/compute.js'], ['the demo stub', '../src/lib/payrollApi.js']]) {
    const src = read(rel);
    ok(`${label} reads the setting through the one reader`, /drivePayEnabled\(/.test(src));
    ok(`${label} hands it to the pricer`, /payDriveTime,/.test(src));
    ok(`${label} skips the drive read when it is off`, /if \(payDriveTime\) \{/.test(src));
  }

  // The two screens that price hours themselves read the same rule, not their own copy.
  const hours = read('../src/pages/reports/HoursReport.jsx');
  ok('Reports › Hours reads the one rule', /drivePayEnabled\(state\.opsSettings/.test(hours));
  ok('…and filters its legs through the shared rule', /payableDriveSegments\(drive\?\.rows/.test(hours));
  const variance = read('../src/pages/Variance.jsx');
  ok('Variance reads the one rule twice over, not a restated test', !/payDriveTime !== false/.test(variance));
  ok('…for the tab and for the OT watch', (variance.match(/drivePayEnabled\(/g) || []).length >= 2);

  // 🔴 The drive REPORT is deliberately untouched: it is about travel, not pay.
  const drive = read('../src/lib/driveTime.js');
  const gateInReport = /export function (isSegmentPayable|segmentPaidMinutes)[\s\S]{0,420}?drivePayEnabled/.test(drive);
  ok('the gate is NOT inside isSegmentPayable / segmentPaidMinutes', !gateInReport);
  const driveCompute = read('../api/_lib/time/driveCompute.js');
  ok('…and the drive report route does not read the pay setting', !/payDriveTime|drivePayEnabled/.test(driveCompute));

  // The drawer shows the row's figure, never the setting.
  const drawer = read('../src/pages/payroll/PayrollLineDrawer.jsx');
  ok('the drawer still prints the paid-drive figure', /Includes \{fmtHours\(current\.driveMinutes\)\} paid drive/.test(drawer));
  ok('…and gates on the row, not on the setting', !/payDriveTime/.test(drawer.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')));
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
