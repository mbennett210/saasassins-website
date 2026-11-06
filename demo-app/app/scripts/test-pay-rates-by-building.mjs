// PAY-7 / PAY-18 — PAY RATES BY BUILDING, AND THE WEEK'S BLENDED OVERTIME RATE.
//
// Matt, 2026-09-29 (PAY-7 note): "one cleaner might have two rate during the day gets $15 at
// abd building and at night gets $17 at yzd building." PAY-18 ★a: "Each cleaner has a main
// rate, and you can set a different rate for a building. Overtime then uses the week's blended
// rate, as the federal rule requires."
//
// WHAT THIS PINS. Before this wave `basePayForUser` multiplied the WHOLE period's regular and
// OT minutes by ONE number, `pay.hourlyRate`, so a cleaner earning $15 at one building and $17
// at another was paid $15 for every hour, and their overtime premium was half of $15 — wrong on
// both the straight time and the premium, in the employer's favour, every week.
//
// The rule (FLSA 29 CFR 778.115, "employees working at two or more rates"):
//   straight time = every hour worked at the rate for ITS building
//   regular rate  = that week's straight-time pay ÷ that week's hours   ("blended")
//   each OT hour  = its straight time (already counted) + 0.5 × the blended rate
// so the premium is the same for every OT hour in the week whichever building it was worked at,
// and a week with ONE rate collapses to exactly today's `reg × r + ot × r × 1.5`.
//
// EVERY NUMBER HERE IS DERIVED, never restated: the money checks compute their expectation from
// the rates and hours in the fixture, and "unchanged for one rate" is asserted against
// `basePayForUser`'s OWN legacy path (no rate buckets), so the test cannot drift from the
// function it is pinning.
//
//   node app/scripts/test-pay-rates-by-building.mjs
import { readFileSync } from 'node:fs';
import { computePayRun } from '../src/lib/payRun.js';
import { payPeriodRange, basePayForUser, minutesToHours } from '../src/lib/payroll.js';

// The field module is NEW, so a pre-fix tree has no such file: guard the import so its checks
// report as FAILURES (the point of a pre-fix run) instead of killing the whole suite.
let R = null;
try { R = await import('../src/lib/payRates.js'); } catch { /* pre-fix: reported below */ }

const TZ = 'America/New_York';
let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (n, got, want) => ok(n, Math.abs(Number(got) - Number(want)) < 0.005, `got ${got}, want ${want}`);

// 2026-06-07 is a SUNDAY, so this is one whole pay week (weekStartDay 0).
const WEEK = '2026-06-07';
const ABD = 'cl_abd';         // the day building — the MAIN rate
const YZD = 'cl_yzd';         // the night building — an override
const MAIN = 15;              // $/h
const NIGHT = 17;             // $/h
const OT_MULT = 1.5;

const payWith = (buildingRates) => ({ type: 'hourly', hourlyRate: MAIN, ...(buildingRates ? { buildingRates } : {}) });
const NIGHT_OVERRIDE = [{ clientId: YZD, hourlyRate: NIGHT }];

// ═══ 1. the FIELD: shape, resolution, sparse editing ═════════════════════════════
{
  ok('lib/payRates.js exists', !!R, 'the module could not be imported');
  if (R) {
    eq('no field → no overrides', R.buildingRatesOf(payWith(null)), []);
    eq('null pay → no overrides', R.buildingRatesOf(null), []);
    eq('one override reads back normalized', R.buildingRatesOf(payWith(NIGHT_OVERRIDE)), [{ clientId: YZD, hourlyRate: NIGHT }]);
    eq('hasBuildingRates is false for one rate', R.hasBuildingRates(payWith(null)), false);
    eq('hasBuildingRates is true with an override', R.hasBuildingRates(payWith(NIGHT_OVERRIDE)), true);

    // A bad row must never price: it is dropped and the MAIN rate applies, which is the only
    // direction that cannot invent a wage out of a malformed document.
    eq('a blank rate is dropped', R.buildingRatesOf(payWith([{ clientId: YZD, hourlyRate: '' }])), []);
    eq('a non-numeric rate is dropped', R.buildingRatesOf(payWith([{ clientId: YZD, hourlyRate: 'seventeen' }])), []);
    eq('a NEGATIVE rate is dropped', R.buildingRatesOf(payWith([{ clientId: YZD, hourlyRate: -5 }])), []);
    eq('a row with no customer is dropped', R.buildingRatesOf(payWith([{ hourlyRate: 17 }])), []);
    eq('$0 at a building IS a rate', R.buildingRatesOf(payWith([{ clientId: YZD, hourlyRate: 0 }])), [{ clientId: YZD, hourlyRate: 0 }]);
    // A duplicated id must resolve the same way however the list was read.
    eq('a duplicated customer keeps the FIRST row', R.buildingRatesOf(payWith([{ clientId: YZD, hourlyRate: 17 }, { clientId: YZD, hourlyRate: 99 }])), [{ clientId: YZD, hourlyRate: 17 }]);

    eq('the override building resolves to its rate', R.rateForBuilding(payWith(NIGHT_OVERRIDE), YZD), NIGHT);
    eq('every other building resolves to the main rate', R.rateForBuilding(payWith(NIGHT_OVERRIDE), ABD), MAIN);
    eq('NO customer resolves to the main rate', R.rateForBuilding(payWith(NIGHT_OVERRIDE), null), MAIN);
    eq('an empty customer resolves to the main rate', R.rateForBuilding(payWith(NIGHT_OVERRIDE), ''), MAIN);
    eq('cents are integers', R.rateCentsForBuilding(payWith(NIGHT_OVERRIDE), YZD), NIGHT * 100);
    eq('a fractional rate rounds to whole cents', R.rateCentsOf(15.005), 1501);

    // The field stays SPARSE: back to null once nothing is overridden, so the org_state money
    // fingerprint returns to its previous value and an old reader still sees "one rate".
    eq('setting a rate adds a row', R.setBuildingRate(payWith(null), YZD, 17), [{ clientId: YZD, hourlyRate: 17 }]);
    eq('setting the same building replaces it', R.setBuildingRate(payWith(NIGHT_OVERRIDE), YZD, 19), [{ clientId: YZD, hourlyRate: 19 }]);
    eq('clearing the last row gives null, not []', R.setBuildingRate(payWith(NIGHT_OVERRIDE), YZD, null), null);
    eq('removeBuildingRate clears it too', R.removeBuildingRate(payWith(NIGHT_OVERRIDE), YZD), null);
    eq('an empty customer id changes nothing', R.setBuildingRate(payWith(NIGHT_OVERRIDE), '', 20), NIGHT_OVERRIDE);
    eq('a rate for a departed customer is reported as an orphan',
      R.orphanBuildingRates(payWith(NIGHT_OVERRIDE), [ABD]), [{ clientId: YZD, hourlyRate: NIGHT }]);
    eq('…and not while the customer is on file', R.orphanBuildingRates(payWith(NIGHT_OVERRIDE), [ABD, YZD]), []);
  }
}

// ═══ the pay-run fixture ════════════════════════════════════════════════════════
// One cleaner, one whole pay week, 44 hours split across two buildings. Every punch is
// APPROVED, and the week's OT is approved for the unit that carries it, so nothing is held and
// the run prices the whole 44 hours.
const PERIOD = payPeriodRange('weekly', 0, WEEK, TZ);

const punch = (id, dayKey, clientId, minutes) => ({
  id, userId: 'u_c', userName: 'Cleaner', clientId, siteId: `s_${clientId}`,
  durationMinutes: minutes,
  clockInAt: `${dayKey}T13:00:00.000Z`,   // 9am New York — the calendar day is unambiguous
  clockOutAt: `${dayKey}T${String(13 + Math.floor(minutes / 60)).padStart(2, '0')}:00:00.000Z`,
  approvalStatus: 'approved', status: 'completed', jobCancelledAt: null,
});

// 40 h Mon–Fri at one building + 4 h on Saturday at the other. The 40 h line is walked in day
// order, so the Saturday punch is entirely OVERTIME — which is the interesting case: its
// premium must be half the WEEK's blended rate, not half its own building's rate.
const fortyThenFour = (fortyAt, fourAt) => [
  punch('e1', '2026-06-08', fortyAt, 480),
  punch('e2', '2026-06-09', fortyAt, 480),
  punch('e3', '2026-06-10', fortyAt, 480),
  punch('e4', '2026-06-11', fortyAt, 480),
  punch('e5', '2026-06-12', fortyAt, 480),
  punch('e6', '2026-06-13', fourAt, 240),
];
const otApproved = (clientId, minutes) => [{ userId: 'u_c', weekKey: WEEK, clientId, approvedOtMinutes: minutes }];

const runFor = ({ pay, entries, otApprovals = [], period = PERIOD, runs = [], arrearsWeeks = [] }) => computePayRun({
  period, tz: TZ, weekStartDay: 0,
  entries, driveSegments: [], otApprovals, runs, arrearsWeeks,
  users: [{ id: 'u_c', name: 'Cleaner', status: 'active', pay }],
  lines: [], otMultiplier: OT_MULT, payDriveTime: false,
});
const rowOf = (r) => r.rows.find((x) => x.userId === 'u_c');

// The rule, computed here from the fixture's own rates and hours — never a pasted figure.
// straight = Σ hours_at_a_rate × that rate (per-bucket cents, THE LAW II.8)
// premium  = OT hours × (multiplier − 1) × (straight ÷ hours)
const blendedDollars = (buckets, otHours, { otMultiplier = OT_MULT } = {}) => {
  let straightCents = 0; let hours = 0;
  for (const [h, rate] of buckets) { straightCents += Math.round(h * Math.round(rate * 100)); hours += h; }
  const premium = hours > 0 ? Math.round(otHours * (otMultiplier - 1) * (straightCents / hours)) : 0;
  return (straightCents + premium) / 100;
};

// ═══ 2. THE REQUIRED CASE: $15 and $17 across a 44-hour week, to the cent ════════
{
  const run = runFor({
    pay: payWith(NIGHT_OVERRIDE),
    entries: fortyThenFour(ABD, YZD),
    otApprovals: otApproved(YZD, 240),
  });
  const row = rowOf(run);
  eq('44 h are all paid: 40 regular + 4 OT', [row.current.regularMinutes, row.current.otMinutes], [2400, 240]);

  const want = blendedDollars([[40, MAIN], [4, NIGHT]], 4);
  near('40 h @ $15 + 4 h OT @ $17 prices at the blended premium', row.base, want);
  // The straight time is real money at each building's own rate; the premium is half the
  // BLENDED rate. Stated apart so a failure says which half broke.
  near('…straight time is 40×$15 + 4×$17', row.base - (4 * 0.5 * ((40 * MAIN + 4 * NIGHT) / 44)), 40 * MAIN + 4 * NIGHT);
  // The defect, in money: one rate for everything paid 40×15 + 4×15×1.5.
  ok('…and it is NOT the old single-rate figure', Math.abs(row.base - (40 * MAIN + 4 * MAIN * OT_MULT)) > 0.005,
    `base ${row.base} still equals the main-rate-only figure`);
  eq('gross is the base (no lines)', row.gross, row.base);
  eq('the run summary agrees with the row', run.summary.base, row.base);
  eq("the CSV source row carries the same base", run.file.rows[0].base, row.base);
  eq('…and the same gross', run.file.rows[0].gross, row.gross);
}

// ═══ 3. THE PREMIUM IS THE WEEK'S, NOT THE PUNCH'S ══════════════════════════════
// Same week, buildings swapped: the 40 h are the EXPENSIVE ones and the OT is at the cheap
// building. Half of the blended rate is now MORE than half of the OT punch's own rate, so a
// "price each punch at its own rate × 1.5" shortcut underpays here — the opposite direction
// from case 2, which is how we know the blend is real and not a coincidence.
{
  const run = runFor({
    pay: payWith(NIGHT_OVERRIDE),
    entries: fortyThenFour(YZD, ABD),
    otApprovals: otApproved(ABD, 240),
  });
  const row = rowOf(run);
  const want = blendedDollars([[40, NIGHT], [4, MAIN]], 4);
  near('40 h @ $17 + 4 h OT @ $15 prices at the blended premium', row.base, want);
  ok('…which is more than the OT punch\'s own rate would give',
    row.base > 40 * NIGHT + 4 * MAIN * OT_MULT + 0.005,
    `base ${row.base} vs per-punch-rate ${40 * NIGHT + 4 * MAIN * OT_MULT}`);
}

// ═══ 4. A ONE-RATE WEEK PRICES EXACTLY AS TODAY ═════════════════════════════════
// Asserted against basePayForUser's OWN legacy path — the function with no rate buckets at
// all — so this cannot drift from the code it protects.
{
  const legacy = (reg, ot, rate) => basePayForUser({ regularMinutes: reg, otMinutes: ot }, { type: 'hourly', hourlyRate: rate }, { otMultiplier: OT_MULT });

  const noOverride = rowOf(runFor({ pay: payWith(null), entries: fortyThenFour(ABD, YZD), otApprovals: otApproved(YZD, 240) }));
  eq('no building rates at all → the legacy figure, to the cent', noOverride.base, legacy(2400, 240, MAIN));

  // A cleaner who HAS an override but worked only at buildings on the main rate is still a
  // one-rate week, so it must take the same untouched path.
  const onlyMain = rowOf(runFor({ pay: payWith(NIGHT_OVERRIDE), entries: fortyThenFour(ABD, ABD), otApprovals: otApproved(ABD, 240) }));
  eq('an override that never applies → the legacy figure', onlyMain.base, legacy(2400, 240, MAIN));

  // …and one who worked ONLY at the override building is a one-rate week at THAT rate.
  const onlyNight = rowOf(runFor({ pay: payWith(NIGHT_OVERRIDE), entries: fortyThenFour(YZD, YZD), otApprovals: otApproved(YZD, 240) }));
  eq('only the override building → the legacy figure at that rate', onlyNight.base, legacy(2400, 240, NIGHT));

  // No OT at all, two rates: straight time only, so there is no premium to blend.
  const noOt = rowOf(runFor({
    pay: payWith(NIGHT_OVERRIDE),
    entries: [punch('a', '2026-06-08', ABD, 480), punch('b', '2026-06-09', YZD, 480)],
  }));
  eq('two rates, under 40 h → straight time at each rate', noOt.base, 8 * MAIN + 8 * NIGHT);
  eq('…and no OT minutes', noOt.current.otMinutes, 0);
}

// ═══ 5. otExempt earns no premium, at either rate ════════════════════════════════
{
  const row = rowOf(runFor({
    pay: { ...payWith(NIGHT_OVERRIDE), otExempt: true },
    entries: fortyThenFour(ABD, YZD),
    otApprovals: otApproved(YZD, 240),
  }));
  eq('otExempt pays straight time at each building and no premium', row.base, 40 * MAIN + 4 * NIGHT);
}

// ═══ 6. THE OT MULTIPLIER IS THE ORG'S, APPLIED TO THE BLEND ════════════════════
{
  const run = computePayRun({
    period: PERIOD, tz: TZ, weekStartDay: 0,
    entries: fortyThenFour(ABD, YZD), driveSegments: [], otApprovals: otApproved(YZD, 240),
    users: [{ id: 'u_c', name: 'Cleaner', status: 'active', pay: payWith(NIGHT_OVERRIDE) }],
    lines: [], otMultiplier: 2, payDriveTime: false,
  });
  near('a 2× org pays double time on the blended rate', rowOf(run).base, blendedDollars([[40, MAIN], [4, NIGHT]], 4, { otMultiplier: 2 }));
}

// ═══ 7. HELD OT IS STILL HELD ═══════════════════════════════════════════════════
// Only the manager-approved OT minutes are paid. With none approved the 4 OT hours pay
// nothing, so straight time is the 40 h at their own building — the blend must not sneak
// unapproved overtime into the premium.
{
  const row = rowOf(runFor({ pay: payWith(NIGHT_OVERRIDE), entries: fortyThenFour(ABD, YZD) }));
  eq('unapproved OT pays 0 minutes', row.current.otMinutes, 0);
  eq('…and the base is the 40 approved regular hours at their own rate', row.base, 40 * MAIN);
}

// ═══ 8. PER-VISIT AND SALARY ARE UNTOUCHED ══════════════════════════════════════
{
  const perVisit = rowOf(runFor({
    pay: { type: 'per_visit', perVisitRate: 45, buildingRates: NIGHT_OVERRIDE },
    entries: fortyThenFour(ABD, YZD), otApprovals: otApproved(YZD, 240),
  }));
  eq('per-visit prices by cleans, whatever building rates say', perVisit.base, 6 * 45);
  const salary = rowOf(runFor({
    pay: { type: 'salary', salaryPerPeriod: 2400, otExempt: true, buildingRates: NIGHT_OVERRIDE },
    entries: fortyThenFour(ABD, YZD), otApprovals: otApproved(YZD, 240),
  }));
  eq('salary is unchanged by building rates', salary.base, 2400);
}

// ═══ 9. EACH WEEK BLENDS ON ITS OWN ═════════════════════════════════════════════
// A biweekly period holding two weeks: week 1 mixed, week 2 single-rate. The blended rate is a
// WEEKLY figure (the federal rule), so week 2's premium must be half of ITS own rate — a
// period-wide blend would leak week 1's cheaper hours into week 2's premium.
{
  const period = payPeriodRange('biweekly', 0, WEEK, TZ);
  ok('the biweekly period covers both weeks', period.fromKey <= WEEK && period.toKey >= '2026-06-20', `${period.fromKey}..${period.toKey}`);
  const wk2 = '2026-06-14'; // the next Sunday
  const entries = [
    ...fortyThenFour(ABD, YZD),                                    // week 1: 40 @ $15 + 4 OT
    punch('f1', '2026-06-15', YZD, 480), punch('f2', '2026-06-16', YZD, 480),
    punch('f3', '2026-06-17', YZD, 480), punch('f4', '2026-06-18', YZD, 480),
    punch('f5', '2026-06-19', YZD, 480), punch('f6', '2026-06-20', YZD, 120), // week 2: 42 h, all @ $17
  ];
  const row = rowOf(runFor({
    pay: payWith(NIGHT_OVERRIDE), entries, period,
    otApprovals: [...otApproved(YZD, 240), { userId: 'u_c', weekKey: wk2, clientId: YZD, approvedOtMinutes: 120 }],
  }));
  eq('both weeks are paid', [row.current.regularMinutes, row.current.otMinutes], [4800, 360]);
  const want = blendedDollars([[40, MAIN], [4, NIGHT]], 4) + blendedDollars([[42, NIGHT]], 2);
  near('each week blends on its own', row.base, want);
}

// ═══ 10. ARREARS PAY AT THE BUILDING'S RATE ═════════════════════════════════════
// A closed run paid this week's 8 h at the main-rate building. A late approval then adds 2 h at
// the override building, in the SAME (closed) week — the delta must be paid at $17, not at the
// cleaner's main $15, and not at all if the paid split is forgotten.
{
  const closed = {
    period_key: PERIOD.fromKey, from_key: PERIOD.fromKey, to_key: PERIOD.toKey,
    from_iso: PERIOD.fromIso, to_iso: PERIOD.toIso, closed_at: '2026-06-15T12:00:00.000Z',
    paid_weeks: [{
      forPeriodKey: PERIOD.fromKey, userId: 'u_c', weekKey: WEEK,
      regularMinutes: 480, otMinutes: 0, driveMinutes: 0, cleanCount: 1,
      rates: [{ rateCents: MAIN * 100, regularMinutes: 480, otMinutes: 0 }],
    }],
    held_ot: [],
  };
  // The NEXT period is the open one being priced; the changed week sits in closed territory.
  const next = payPeriodRange('weekly', 1, WEEK, TZ);
  const run = runFor({
    pay: payWith(NIGHT_OVERRIDE),
    entries: [punch('p1', '2026-06-08', ABD, 480), punch('p2', '2026-06-09', YZD, 120)],
    period: next, runs: [closed], arrearsWeeks: [`u_c|${WEEK}`],
  });
  const row = rowOf(run);
  eq('the late 2 h show as arrears regular minutes', row.arrears.regularMinutes, 120);
  eq('…priced at the override building\'s rate', row.arrearsPay, 2 * NIGHT);
  ok('…not at the main rate', Math.abs(row.arrearsPay - 2 * MAIN) > 0.005, `arrearsPay ${row.arrearsPay}`);
  eq('gross is base + arrears (base is 0 — nothing in this period)', row.gross, row.arrearsPay);
  // A legacy paid_weeks row (closed before this column shipped) has no `rates`: the paid
  // minutes fall back to the MAIN rate, which is exactly what the old pricer charged them at,
  // so an old run's arrears are unchanged rather than silently re-priced.
  const legacyClosed = { ...closed, paid_weeks: [{ ...closed.paid_weeks[0], rates: undefined }] };
  const legacyRun = runFor({
    pay: payWith(NIGHT_OVERRIDE),
    entries: [punch('p1', '2026-06-08', ABD, 480), punch('p2', '2026-06-09', YZD, 120)],
    period: next, runs: [legacyClosed], arrearsWeeks: [`u_c|${WEEK}`],
  });
  eq('a paid_weeks row with no rate split still pays the new hours at their own rate',
    rowOf(legacyRun).arrearsPay, 2 * NIGHT);
}

// ═══ 11. A CLOSE STORES THE RATE SPLIT ══════════════════════════════════════════
// Without it, a later arrears delta cannot tell which of the week's paid hours were at which
// rate, and would re-price them all at whatever rate the member carries then.
{
  const run = runFor({ pay: payWith(NIGHT_OVERRIDE), entries: fortyThenFour(ABD, YZD), otApprovals: otApproved(YZD, 240) });
  const pw = run.paidWeeksOut.find((w) => w.userId === 'u_c' && w.weekKey === WEEK);
  ok('the close stores a paid_weeks row for the week', !!pw);
  ok('…carrying the per-rate split', !!pw && Array.isArray(pw.rates) && pw.rates.length === 2, JSON.stringify(pw && pw.rates));
  if (pw && Array.isArray(pw.rates)) {
    const total = pw.rates.reduce((a, r) => a + r.regularMinutes + r.otMinutes, 0);
    eq('…whose minutes sum to the row\'s', total, pw.regularMinutes + pw.otMinutes);
    eq('…in whole cents', pw.rates.every((r) => Number.isInteger(r.rateCents)), true);
  }
}

// ═══ 12. THE BREAKDOWN THE DRAWER RENDERS ═══════════════════════════════════════
// The per-person drawer used to re-derive "Regular Xh × $rate" from `pay.hourlyRate`, which is
// a different number from what the run paid as soon as two rates are involved. The run now
// hands it the real lines, so the screen cannot disagree with the money.
{
  const row = rowOf(runFor({ pay: payWith(NIGHT_OVERRIDE), entries: fortyThenFour(ABD, YZD), otApprovals: otApproved(YZD, 240) }));
  const b = row.rateBreakdown;
  ok('the row carries a rate breakdown', !!b);
  if (b) {
    eq('it is marked multi-rate', b.multiRate, true);
    eq('one line per rate', b.rates.length, 2);
    const sum = b.rates.reduce((a, r) => a + r.pay, 0);
    near('the lines plus the premium equal the base', sum + b.otPremium, row.base);
    near('the blended rate is straight time ÷ hours', b.blendedRate, (40 * MAIN + 4 * NIGHT) / 44);
    eq('the OT minutes shown are the paid ones', b.otMinutes, row.current.otMinutes);
  }
  const single = rowOf(runFor({ pay: payWith(null), entries: fortyThenFour(ABD, ABD), otApprovals: otApproved(ABD, 240) }));
  eq('a one-rate row is not marked multi-rate', single.rateBreakdown && single.rateBreakdown.multiRate, false);
  eq('…and shows the one rate', single.rateBreakdown && single.rateBreakdown.rates.length, 1);
  near('…at the main rate', single.rateBreakdown && single.rateBreakdown.rates[0].rate, MAIN);
}

// ═══ 13. MECHANICAL: ONE PRICER, AND THE SCREENS READ IT ════════════════════════
// The defect class here is a SECOND place that multiplies hours by `pay.hourlyRate`. Arithmetic
// cannot catch that from outside, so the source is checked directly — the same shape
// test-drive-pay-off.mjs uses for the drive-pay reader.
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  const payroll = read('../src/lib/payroll.js');
  ok('payroll.js resolves a rate through lib/payRates', /from '\.\/payRates\.js'/.test(payroll));
  ok('…and basePayForUser takes the rate buckets', /rateWeeks/.test(payroll));

  const payRun = read('../src/lib/payRun.js');
  ok('the pay run buckets payable minutes by rate', /rateCentsForBuilding/.test(payRun));
  ok('…and prices the current period through basePayForUser with them', /basePayForUser\(current, pay, \{ otMultiplier, rateWeeks/.test(payRun));
  ok('…and the arrears delta too', /basePayForUser\(arr, pay, \{ otMultiplier, rateWeeks/.test(payRun));

  // The drawer must NOT re-derive the rate: `const rate = Number(pay && pay.hourlyRate)` there,
  // times a hardcoded 1.5, was the display half of the defect. Comment lines are stripped, so
  // the rule can still be NAMED in prose without the check reading its own documentation.
  const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const drawer = code(read('../src/pages/payroll/PayrollLineDrawer.jsx'));
  ok('the drawer no longer derives a rate from pay.hourlyRate', !/pay\.hourlyRate/.test(drawer), 'PayrollLineDrawer still reads pay.hourlyRate');
  ok('…nor multiplies by a hardcoded 1.5', !/\*\s*1\.5/.test(drawer));
  ok('…it renders the run\'s own breakdown', /rateBreakdown/.test(drawer));

  // The office needs somewhere to set it: a dedicated editor, rendered by TeamDetail's pay card
  // behind the SAME gate the main rate uses, writing through lib/payRates' one setter.
  const editor = code(read('../src/pages/settings/BuildingRatesEditor.jsx'));
  ok('the editor writes through lib/payRates', /setBuildingRate/.test(editor) && /from '\.\.\/\.\.\/lib\/payRates'/.test(editor));
  const teamDetail = code(read('../src/pages/settings/TeamDetail.jsx'));
  ok('TeamDetail renders it', /<BuildingRatesEditor/.test(teamDetail));
  ok('…gated on the pay-rate permission the main rate uses', /canEdit=\{canEditThisPay\}/.test(teamDetail));
  ok('…and it rides the SAME pay patch, so the whitelist can\'t drop it', /setPay\(\{ buildingRates/.test(teamDetail));
}

// ── report ───────────────────────────────────────────────────────────────────
const total = pass + fails.length;
if (fails.length) {
  console.error(`test-pay-rates-by-building: ${pass}/${total} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-pay-rates-by-building: ${total}/${total} passed`);
}
