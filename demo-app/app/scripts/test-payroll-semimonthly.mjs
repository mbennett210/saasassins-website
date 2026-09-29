// Headless checks for SEMI-MONTHLY payroll (src/lib/payroll.js): the 1st–15th /
// 16th–end period calendar (Feb / leap-year / 31-day / year-rollover edges) and
// day-attributed weekly (40h) OT across the mid-month split (payPeriodRange +
// payrollByUserClipped). Both functions are NEW, so this suite CANNOT pass against
// pre-fix code (unresolved import / biweekly range) — the II.3 "a regression test
// must fail pre-fix" gate is satisfied by construction.
// Run: node scripts/test-payroll-semimonthly.mjs
import { payPeriodRange, payrollByUserClipped, payrollByUser } from '../src/lib/payroll.js';
import { dayKey, dayOfWeekKey } from '../src/lib/dates.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } };

// UTC everywhere so the calendar math is deterministic regardless of the machine zone.
const TZ = 'UTC';
const range = (offset, when) => payPeriodRange('semimonthly', offset, when, TZ);

// ── period calendar ──
const feb2 = range(0, '2026-02-20T12:00:00Z');           // 2nd half of Feb 2026 (non-leap)
eq('feb 2nd half from/to', [feb2.fromKey, feb2.toKey], ['2026-02-16', '2026-02-28']);
eq('feb 2nd half span (28-day month)', feb2.span, 13);
eq('feb 1st half (offset -1)', [range(-1, '2026-02-20T12:00:00Z').fromKey, range(-1, '2026-02-20T12:00:00Z').toKey], ['2026-02-01', '2026-02-15']);
eq('feb -> mar rollover (offset +1)', [range(1, '2026-02-20T12:00:00Z').fromKey, range(1, '2026-02-20T12:00:00Z').toKey], ['2026-03-01', '2026-03-15']);
eq('leap Feb ends on the 29th', range(0, '2028-02-20T12:00:00Z').toKey, '2028-02-29');
eq('31-day month 2nd half ends on 31', [range(0, '2026-01-20T12:00:00Z').fromKey, range(0, '2026-01-20T12:00:00Z').toKey], ['2026-01-16', '2026-01-31']);
eq('31-day 2nd half span', range(0, '2026-01-20T12:00:00Z').span, 16);
eq('year rollover Dec -> Jan (offset +1)', [range(1, '2026-12-20T12:00:00Z').fromKey, range(1, '2026-12-20T12:00:00Z').toKey], ['2027-01-01', '2027-01-15']);
eq('the 15th is the LAST day of the 1st half', range(0, '2026-09-15T12:00:00Z').fromKey, '2026-09-01');
eq('the 16th is the FIRST day of the 2nd half', range(0, '2026-09-16T12:00:00Z').fromKey, '2026-09-16');

// rollup window = the whole Sun..Sat pay-weeks overlapping the calendar period
ok('rollup window starts on a Sunday', dayOfWeekKey(dayKey(feb2.rollupFromIso, TZ)) === 0);
ok('rollup window ends on a Saturday', dayOfWeekKey(dayKey(feb2.rollupToIso, TZ)) === 6);
ok('rollup window fully covers the period', feb2.rollupFromIso <= feb2.fromIso && feb2.rollupToIso >= feb2.toIso);

// ── day-attributed OT across the split ──
// Feb 1 2026 is a Sunday, so Sun Feb 15 .. Sat Feb 21 is ONE pay-week that straddles
// the 15th→16th boundary. A cleaner works 8h/day Sun Feb 15 .. Fri Feb 20 = 48h → 8h
// weekly OT. The over-40h hours are worked on Feb 20, which sits in the 16th–end half,
// so ALL 8h of OT must be paid in the 2nd half, none in the 1st.
ok('Feb 15 2026 is a Sunday (the week straddles the boundary)', dayOfWeekKey('2026-02-15') === 0);
const mk = (dayIso, hours) => ({
  id: `${dayIso}-${hours}`, userId: 'u1', userName: 'Ann',
  durationMinutes: hours * 60, clockInAt: `${dayIso}T14:00:00Z`, clockOutAt: `${dayIso}T${14 + hours}:00:00Z`,
  approvalStatus: 'approved', status: 'completed',
});
const straddleWeek = ['2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20'].map((d) => mk(d, 8));

const firstHalf = payrollByUserClipped(straddleWeek, { weekStartDay: 0, tz: TZ, clipFromKey: '2026-02-01', clipToKey: '2026-02-15' });
const secondHalf = payrollByUserClipped(straddleWeek, { weekStartDay: 0, tz: TZ, clipFromKey: '2026-02-16', clipToKey: '2026-02-28' });
eq('1st half: only Feb 15, 8h all regular', firstHalf.map((u) => [u.regularMinutes, u.otMinutes, u.totalMinutes]), [[480, 0, 480]]);
eq('2nd half: 32h reg + 8h OT (the over-40h lands here)', secondHalf.map((u) => [u.regularMinutes, u.otMinutes, u.totalMinutes]), [[1920, 480, 2400]]);

// Conservation: the two halves reconstruct the full week's 40h reg / 8h OT.
const f = firstHalf[0]; const s = secondHalf[0];
eq('regular minutes conserved across the split', f.regularMinutes + s.regularMinutes, 2400);
eq('OT minutes conserved across the split', f.otMinutes + s.otMinutes, 480);

// A clip that spans the WHOLE week reproduces the plain weekly split (48h -> 40 reg / 8 OT),
// and equals payrollByUser on the same entries — the clipped path is a superset, not a fork.
const whole = payrollByUserClipped(straddleWeek, { weekStartDay: 0, tz: TZ, clipFromKey: '2026-02-01', clipToKey: '2026-02-28' });
eq('whole-week clip == weekly split', whole.map((u) => [u.regularMinutes, u.otMinutes, u.totalMinutes]), [[2400, 480, 2880]]);
const plain = payrollByUser(straddleWeek, { weekStartDay: 0, tz: TZ });
eq('clipped(whole) matches payrollByUser', plain.map((u) => [u.regularMinutes, u.otMinutes, u.totalMinutes]), [[2400, 480, 2880]]);

// A cleaner whose only week falls entirely in the OTHER half yields NO row here.
const otherHalfOnly = payrollByUserClipped(straddleWeek, { weekStartDay: 0, tz: TZ, clipFromKey: '2026-03-01', clipToKey: '2026-03-15' });
eq('week entirely outside the clip -> no rows', otherHalfOnly.length, 0);

// ── A period that ENDS ON A SUNDAY, in a US zone (found 2026-09-22) ────────────────
// Everything above runs in UTC, which is exactly why this hid: payWeekKeyOf() handed a
// bare day key to dayKey(), which parses it as UTC midnight — the evening BEFORE in
// every US zone — so the Sunday 15th landed in the previous pay week, the Nov 1–15 run's
// fetch window stopped at Sat 11:59pm, and the Nov 16–30 run clips the 15th out too: a
// Sunday-15th shift was paid in NEITHER period.
{
  const NY = 'America/New_York';
  const when = '2026-11-10T17:00:00Z';
  const first = payPeriodRange('semimonthly', 0, when, NY);   // Nov 1–15 (the 15th is a Sunday)
  const second = payPeriodRange('semimonthly', 1, when, NY);  // Nov 16–30
  eq('NY: first half is Nov 1–15', [first.fromKey, first.toKey], ['2026-11-01', '2026-11-15']);
  const sundayShift = {
    id: 'sun15', userId: 'u1', userName: 'Sunday Cleaner', durationMinutes: 240, status: 'completed', approvalStatus: 'pending',
    clockInAt: '2026-11-15T21:00:00Z', clockOutAt: '2026-11-16T01:00:00Z', // Sun 4pm–8pm in New York
  };
  const inWindow = (p) => Date.parse(sundayShift.clockInAt) >= Date.parse(p.rollupFromIso) && Date.parse(sundayShift.clockInAt) <= Date.parse(p.rollupToIso);
  ok('NY: the Nov 1–15 run FETCHES the Sunday-15th shift', inWindow(first));
  const paid = (p) => (inWindow(p)
    ? payrollByUserClipped([sundayShift], { weekStartDay: 0, tz: NY, clipFromKey: p.fromKey, clipToKey: p.toKey })
    : []).reduce((m, u) => m + u.totalMinutes, 0);
  eq('NY: …and pays its 4h in the Nov 1–15 run', paid(first), 240);
  eq('NY: the Nov 16–30 run does not pay it again', paid(second), 0);
  eq('NY: a Sunday day key names that Sunday', dayOfWeekKey(first.toKey), 0);
  // The same edge on a month-end Sunday: 2026-05-31 is a Sunday.
  const may = payPeriodRange('semimonthly', 0, '2026-05-20T17:00:00Z', NY);
  ok('NY: May 16–31 (ends Sun 31st) fetches through the 31st', Date.parse(may.rollupToIso) >= Date.parse('2026-06-01T03:00:00Z'));
}

console.log(`\npayroll-semimonthly: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
