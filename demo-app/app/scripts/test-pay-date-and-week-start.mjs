// PAY-2 — THE PAY DATE ON EACH RUN, and PAY-19 — THE WORKWEEK START DAY.
//
// PAY-2 (Matt, 2026-09-29): "semi monthly 1 to 15 on the 20th and 16 to 31 on the 5th of the new
// month." A pay PERIOD and its PAYDAY are different dates, and the payday is what the office and
// the payroll specialist work to. Nothing computed or showed it: the run said "Sep 1 – Sep 15 ·
// semi-monthly" and the exported file was named by the period, so "when does this go out?" had no
// answer anywhere in the product.
//
// PAY-19 (Matt ★a: Sunday). `opsSettings.payWeekStartDay` existed, the server already froze it
// once a run had closed, and the weekly OT ledger already honoured it — but it was settable
// NOWHERE, and `payPeriodRange` / `payPeriodStartKey` hardcoded Sunday and ignored it. Exposing
// the control without fixing that would have split the two: the 40-hour line walked on the org's
// week while the PERIOD (and, for semi-monthly, the whole-weeks ROLLUP WINDOW) stayed
// Sunday-aligned — a partial week at each edge, which under-counts overtime. So the calendar
// honours it, and Sunday stays byte-identical to what every surface computed before.
//
// Every expectation is derived from the source-of-truth constants (`PAY_DATE_DEFAULTS`, the seed
// itself, `payWeekKeyOf`), never a restated literal.
//
//   node app/scripts/test-pay-date-and-week-start.mjs
import { readFileSync } from 'node:fs';
import { computePayRun } from '../src/lib/payRun.js';
import { csvFileName } from '../src/pages/payroll/periodLock.js';
import { dayOfWeekKey } from '../src/lib/dates.js';
import { installResolveShim } from './deletion-core.mjs';

// The payday helpers are NEW, so a pre-fix tree exports none of them. Bound through a NAMESPACE
// import with fallbacks, so the pre-fix run reports each rule as a FAILURE (the point of running
// it) instead of dying on a missing export before a single check has run.
const P = await import('../src/lib/payroll.js');
const { payPeriodRange, payPeriodStartKey, payWeekKeyOf } = P;
const payDateKeyFor = P.payDateKeyFor || (() => undefined);
// An EMPTY object, not undefined, so a pre-fix run fails each assertion on its VALUE rather than
// throwing on the first property read and hiding every check behind it.
const payDateConfigOf = P.payDateConfigOf || (() => ({}));
const PAY_DATE_DEFAULTS = P.PAY_DATE_DEFAULTS || {};

installResolveShim();
const { INITIAL_STATE } = await import(new URL('../src/data/seed.js', import.meta.url).href);

const TZ = 'America/New_York';
let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ═══ 1 · the payday schedule and its defaults ═══════════════════════════════════
{
  const D = PAY_DATE_DEFAULTS;
  eq('the defaults are whole days', [Number.isInteger(D.semiFirstHalfDay), Number.isInteger(D.semiSecondHalfDay), Number.isInteger(D.daysAfterPeriodEnd)], [true, true, true]);
  // Matt's own schedule is what the SEED ships, and the code's defaults must equal it, or a blob
  // that predates these keys pays on a different day from a fresh one.
  eq('the seed ships the first-half payday', INITIAL_STATE.opsSettings.payDateSemiFirstHalfDay, D.semiFirstHalfDay);
  eq('the seed ships the second-half payday', INITIAL_STATE.opsSettings.payDateSemiSecondHalfDay, D.semiSecondHalfDay);
  eq('the seed ships the days-after payday', INITIAL_STATE.opsSettings.payDateDaysAfterPeriodEnd, D.daysAfterPeriodEnd);

  eq('no settings at all reads the defaults', payDateConfigOf(null), D);
  eq('an empty slice reads the defaults', payDateConfigOf({}), D);
  eq('a stored schedule reads back', payDateConfigOf({ payDateSemiFirstHalfDay: 18, payDateSemiSecondHalfDay: 3, payDateDaysAfterPeriodEnd: 7 }),
    { semiFirstHalfDay: 18, semiSecondHalfDay: 3, daysAfterPeriodEnd: 7 });
  // A nonsense value must fall back, never pay on "day 0" or "day 99".
  eq('day 0 is refused', payDateConfigOf({ payDateSemiFirstHalfDay: 0 }).semiFirstHalfDay, D.semiFirstHalfDay);
  eq('day 99 is refused', payDateConfigOf({ payDateSemiFirstHalfDay: 99 }).semiFirstHalfDay, D.semiFirstHalfDay);
  eq('a fractional day is refused', payDateConfigOf({ payDateSemiSecondHalfDay: 5.5 }).semiSecondHalfDay, D.semiSecondHalfDay);
  eq('a string day is refused', payDateConfigOf({ payDateDaysAfterPeriodEnd: '7' }).daysAfterPeriodEnd, D.daysAfterPeriodEnd);
  eq('0 days after IS allowed (paid on the period end)', payDateConfigOf({ payDateDaysAfterPeriodEnd: 0 }).daysAfterPeriodEnd, 0);
}

// ═══ 2 · Matt's semi-monthly schedule, to the day ═══════════════════════════════
{
  const cfg = payDateConfigOf(INITIAL_STATE.opsSettings);
  const first = payPeriodRange('semimonthly', 0, '2026-09-10', TZ);
  eq('the first half is the 1st–15th', [first.fromKey, first.toKey], ['2026-09-01', '2026-09-15']);
  eq('…and pays on the 20th of the SAME month', payDateKeyFor(first, cfg), `2026-09-${String(cfg.semiFirstHalfDay).padStart(2, '0')}`);

  const second = payPeriodRange('semimonthly', 0, '2026-09-20', TZ);
  eq('the second half is the 16th–end', [second.fromKey, second.toKey], ['2026-09-16', '2026-09-30']);
  eq('…and pays on the 5th of the NEXT month', payDateKeyFor(second, cfg), `2026-10-${String(cfg.semiSecondHalfDay).padStart(2, '0')}`);

  // December's second half pays in JANUARY of the next year — the one boundary a naive
  // month+1 gets wrong.
  const dec = payPeriodRange('semimonthly', 0, '2026-12-20', TZ);
  eq('December 16–31 pays in the NEXT YEAR', payDateKeyFor(dec, cfg), `2027-01-${String(cfg.semiSecondHalfDay).padStart(2, '0')}`);

  // A payday past the end of a short month CLAMPS, so "the 31st" is a usable setting.
  const janFirst = payPeriodRange('semimonthly', 0, '2027-01-10', TZ);
  eq('a 31st payday clamps to February\'s last day', payDateKeyFor(janFirst, { ...cfg, semiFirstHalfDay: 31 }), '2027-01-31');
  const dec2 = payPeriodRange('semimonthly', 0, '2026-12-20', TZ);
  eq('…and the 30th of February becomes the 28th', payDateKeyFor(dec2, { ...cfg, semiSecondHalfDay: 30 }), '2027-01-30');
  const jan2 = payPeriodRange('semimonthly', 0, '2028-01-20', TZ);   // 2028 is a leap year
  eq('…February 2028 clamps to the 29th', payDateKeyFor(jan2, { ...cfg, semiSecondHalfDay: 31 }), '2028-02-29');

  // Weekly / biweekly: a set number of days after the period ends.
  const wk = payPeriodRange('weekly', 0, '2026-09-10', TZ);
  eq('weekly pays N days after the period ends', payDateKeyFor(wk, { ...cfg, daysAfterPeriodEnd: 5 }),
    payPeriodRange('weekly', 1, '2026-09-10', TZ).fromKey.replace(/^(\d{4}-\d{2}-)(\d{2})$/, (_m, p, d) => p + String(Number(d) + 4).padStart(2, '0')));
  eq('…0 days pays on the period end itself', payDateKeyFor(wk, { ...cfg, daysAfterPeriodEnd: 0 }), wk.toKey);

  eq('no config at all still gives Matt\'s schedule, never null', payDateKeyFor(first, null), payDateKeyFor(first, cfg));
  eq('a period-less call is null, not a crash', payDateKeyFor(null, cfg), null);
}

// ═══ 3 · the payday travels with the run, and is STORED on the file ═════════════
{
  const period = payPeriodRange('semimonthly', 0, '2026-09-10', TZ);
  const cfg = payDateConfigOf(INITIAL_STATE.opsSettings);
  const run = computePayRun({
    period, tz: TZ, weekStartDay: 0, entries: [], driveSegments: [], otApprovals: [],
    users: [{ id: 'u1', name: 'A', status: 'active', pay: { type: 'hourly', hourlyRate: 20 } }],
    lines: [], otMultiplier: 1.5, payDriveTime: false, payDate: cfg,
  });
  eq('the run carries the payday', run.payDateKey, payDateKeyFor(period, cfg));
  // A CLOSED run STORES it, so a download months later still says when that run paid — even if
  // the setting has since changed.
  eq('…and the stored file keeps it', run.file.payDateKey, run.payDateKey);
  // Omitting the config must not produce null: the run would then name no payday at all.
  const noCfg = computePayRun({
    period, tz: TZ, weekStartDay: 0, entries: [], driveSegments: [], otApprovals: [],
    users: [], lines: [], payDriveTime: false,
  });
  eq('a caller that omits the schedule still gets the default payday', noCfg.payDateKey, payDateKeyFor(period, null));

  // The file NAME carries it — the specialist files by the date the money goes out. The CSV's own
  // Paychex columns are deliberately untouched (PAY-1 waits for Matt's sample file).
  const name = csvFileName(period, { payDateKey: run.payDateKey });
  ok('the CSV file name carries the payday', name.includes(`-pay-${run.payDateKey}`), name);
  ok('…and still the period', name.includes(period.fromKey) && name.includes(period.toKey), name);
  ok('a DRAFT is still marked', csvFileName(period, { draft: true, payDateKey: run.payDateKey }).endsWith('-DRAFT.csv'));
  eq('no payday → exactly the old name', csvFileName(period, {}), `payroll-${period.fromKey}_to_${period.toKey}.csv`);
}

// ═══ 4 · PAY-19 · SUNDAY IS BYTE-IDENTICAL ═════════════════════════════════════
// The whole safety of this change. Every existing caller omits `weekStartDay`, so it must default
// to Sunday and compute exactly what it computed before.
{
  eq('the seed ships Sunday', INITIAL_STATE.opsSettings.payWeekStartDay, 0);
  let same = 0; let diff = 0;
  for (const cadence of ['weekly', 'biweekly', 'semimonthly']) {
    for (let d = 1; d <= 60; d += 1) {
      const key = `2026-${String(1 + (d % 12)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`;
      for (const offset of [-2, -1, 0, 1]) {
        const implicit = payPeriodRange(cadence, offset, key, TZ);
        const explicit = payPeriodRange(cadence, offset, key, TZ, 0);
        // `weekStartDay` is new ON the result, so compare everything else.
        const strip = (p) => { const { weekStartDay, ...rest } = p; return rest; };
        if (JSON.stringify(strip(implicit)) === JSON.stringify(strip(explicit))) same += 1; else diff += 1;
      }
    }
  }
  ok('omitting the week start === passing Sunday, over every cadence and offset', diff === 0, `${same} same, ${diff} different`);
  eq('a Sunday weekly period still starts on a Sunday', dayOfWeekKey(payPeriodRange('weekly', 0, '2026-09-10', TZ).fromKey), 0);
  eq('the biweekly anchor is unmoved for Sunday', payPeriodStartKey('biweekly', '2026-09-10', TZ, 0), payPeriodStartKey('biweekly', '2026-09-10', TZ));
}

// ═══ 5 · PAY-19 · a NON-Sunday org is coherent ═════════════════════════════════
{
  for (const wsd of [1, 3, 6]) {
    const wk = payPeriodRange('weekly', 0, '2026-09-10', TZ, wsd);
    eq(`weekStartDay ${wsd}: a weekly period starts on that day`, dayOfWeekKey(wk.fromKey), wsd);
    eq(`weekStartDay ${wsd}: …and still spans 7 days`, wk.span, 7);
    eq(`weekStartDay ${wsd}: …and the period IS its own rollup window`, [wk.rollupFromIso, wk.rollupToIso], [wk.fromIso, wk.toIso]);

    const bi = payPeriodRange('biweekly', 0, '2026-09-10', TZ, wsd);
    eq(`weekStartDay ${wsd}: a biweekly period starts on that day`, dayOfWeekKey(bi.fromKey), wsd);
    eq(`weekStartDay ${wsd}: …and spans 14 days`, bi.span, 14);
    // Consecutive periods must abut exactly — a gap or an overlap is a day paid twice or never.
    const next = payPeriodRange('biweekly', 1, '2026-09-10', TZ, wsd);
    eq(`weekStartDay ${wsd}: consecutive biweekly periods abut`, next.fromKey, payPeriodRange('biweekly', 0, next.fromKey, TZ, wsd).fromKey);

    // 🔴 THE ONE THAT MATTERS FOR CLEAN SPACE (semi-monthly): the rollup window must be the whole
    // pay weeks of the ORG's week, or the 40-hour line lands on a PARTIAL week at each edge and
    // overtime is under-counted (the reason payrollByUserClipped exists).
    const sm = payPeriodRange('semimonthly', 0, '2026-09-10', TZ, wsd);
    eq(`weekStartDay ${wsd}: the semi-monthly rollup starts on that weekday`, dayOfWeekKey(sm.rollupFromIso.slice(0, 10)), wsd);
    const wantFrom = payWeekKeyOf(sm.fromKey, wsd, TZ);
    eq(`weekStartDay ${wsd}: …at the week containing the period start`, sm.rollupFromIso.slice(0, 10), wantFrom);
    ok(`weekStartDay ${wsd}: …and the window covers the whole period`,
      sm.rollupFromIso <= sm.fromIso && sm.rollupToIso >= sm.toIso,
      `${sm.rollupFromIso}..${sm.rollupToIso} vs ${sm.fromIso}..${sm.toIso}`);
    // The period itself is a CALENDAR half-month and must not move with the week start.
    eq(`weekStartDay ${wsd}: the semi-monthly period is still calendar-bounded`, [sm.fromKey, sm.toKey], ['2026-09-01', '2026-09-15']);
  }
  eq('the result reports the week start it used', payPeriodRange('weekly', 0, '2026-09-10', TZ, 3).weekStartDay, 3);
}

// ═══ 6 · mechanical: every period-key surface follows the ORG, not Sunday ═══════
// A surface that computes a period key on Sunday while the run computes it on Monday produces a
// key the run never matches, and an HR pay line at that key silently drops from payroll — the
// landmine the payroll card already names for the CADENCE. Arithmetic cannot catch a caller that
// forgets, so the sources are checked.
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const cases = [
    ['the server pay-run config', '../api/_lib/payroll/compute.js', /weekStartDay/],
    ['the payroll route', '../api/payroll/[...path].js', /payPeriodRange\(cadence, offset, now, tz, weekStartDay\)/],
    ['…and its close', '../api/payroll/[...path].js', /payPeriodRange\(cadence, 0, periodKey, tz, weekStartDay\)/],
    ['the payroll ledger floor', '../api/_lib/payroll/ledger.js', /payPeriodRange\(cadence, -1, now, tz, weekStartDay\)/],
    ['the demo stub', '../src/lib/payrollApi.js', /payPeriodRange\(cadence, offset, now, tz, weekStartDay\)/],
    ['the pay-run hook', '../src/pages/payroll/usePayrollRun.js', /payPeriodRange\(cadence, periodOffset, new Date\(\), tz, weekStartDay\)/],
    ['the open-period helpers', '../src/pages/payroll/periodLock.js', /weekStartDay = 0/],
    ['the pay cutoff', '../src/lib/deleteCascade.js', /weekStartOf\(state\)/],
    ["HR's reimbursement periods", '../src/pages/hr/ReimbursementsTab.jsx', /\{ tz, weekStartDay \}/],
    ["HR's special-service periods", '../src/pages/hr/SpecialServicesTab.jsx', /\{ tz, weekStartDay \}/],
  ];
  for (const [label, rel, re] of cases) ok(`${label} passes the org's week start`, re.test(read(rel)), rel);

  // No Sunday hardcode left in the pay-period calendar itself.
  const payroll = read('../src/lib/payroll.js');
  ok('payPeriodStartKey takes the week start', /payPeriodStartKey\(cadence = 'biweekly', dateOrKey = new Date\(\), tz, weekStartDay = 0\)/.test(payroll));
  ok('…and no `payWeekKeyOf(.., 0, ..)` hardcode is left in it', !/payWeekKeyOf\([^)]*,\s*0\s*,\s*tz\)/.test(payroll), 'a hardcoded Sunday remains');

  // The office can set both, and both are frozen once a run exists.
  const ops = read('../src/pages/settings/Operations.jsx');
  ok('Operations offers the workweek start', /payWeekStartDay/.test(ops) && /Workweek starts on/.test(ops));
  ok('…locked with the cadence once a run exists', /payWeekStartDay: weekStartToSave/.test(ops) && /scheduleLocked \? weekStartOf\(ops\.payWeekStartDay\)/.test(ops));
  ok('Operations offers the payday', /payDateSemiFirstHalfDay/.test(ops) && /payDateSemiSecondHalfDay/.test(ops) && /payDateDaysAfterPeriodEnd/.test(ops));
  // The server already freezes the pay SCHEDULE for everyone once a run exists — the UI lock
  // mirrors a real rule, it is not the rule.
  const guard = read('../api/_lib/orgStateGuard.js');
  ok("the server's frozen-schedule list holds the week start", /PAY_SCHEDULE_FIELDS = \['payPeriodCadence', 'payWeekStartDay'\]/.test(guard));
  // …and the payday is NOT frozen, because each run stores the date it paid on.
  ok('the payday is NOT in the frozen list', !/payDateSemi|payDateDays/.test(guard));

  // The payday reaches the screens.
  const page = read('../src/pages/Payroll.jsx');
  ok('the pay run shows the payday', /payDateKey/.test(page) && /pays /.test(page));
  ok('…and names the file by it', /csvFileName\(period, \{ draft, payDateKey \}\)/.test(page));
  const dlg = read('../src/pages/payroll/ClosePeriodDialog.jsx');
  ok('the close dialog states the payday', /payDateKey/.test(dlg) && /Paid on/.test(dlg));
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`test-pay-date-and-week-start: ${pass}/${total} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-pay-date-and-week-start: ${total}/${total} passed`);
}
