// CS-055 (state changed 2026-10-12) — every surface that counts a cleaner's WEEK uses the ORG's
// workweek, the one the pay run pays on.
//
// Production's week starts on MONDAY (`opsSettings.payWeekStartDay = 1`, Matt's PAY-19 b) and the
// pay run and Hours Approval read it, but three surfaces hard-coded Sunday: Reports › Hours by
// cleaner (`WEEK_START_DAY = 0` — and its CSV is handed to payroll), the Variance overtime watch,
// and the Schedule's by-cleaner overtime lens. So "10 h of overtime" in the pay run read as none in
// the report the office exports, and a cleaner at 50 h showed no warning. Variance's WTD window
// started on a Monday whatever the setting.
//
// Pins:
//   1. One Monday week's hours and overtime agree between the Hours report's own computation
//      (lib/payroll hoursReportWindow / hoursReportRows — what the page runs) and the pay run
//      (lib/payRun computePayRun, what the server prices). A Sunday reading disagrees: proof the
//      check can tell.
//   2. The overtime watch over the same week counts all 50 h (over 40) where the run pays 10 h
//      of OT; a Sunday reading would have counted 10 h and warned nobody.
//   3. The "this week" window is the whole org-zone pay week, DST-safe (the fall-back week).
//   4. Each of the three pages (and Variance WTD) reads the week start through the ONE reader,
//      and no page or component hard-codes Sunday for a pay week (class guard).
//
//   node app/scripts/test-week-start-surfaces.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as payroll from '../src/lib/payroll.js';
import { computePayRun } from '../src/lib/payRun.js';
import { startOfDayKey, addDaysKey } from '../src/lib/dates.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const TZ = 'America/New_York';
const OPS = { payWeekStartDay: 1, payPeriodCadence: 'weekly', payDriveTime: false, otMultiplier: 1.5 };
const { payWeekStartDayOf, hoursReportWindow, hoursReportRows, currentPayWeekWindow, currentWeekMinutesByUser, otStatus, payPeriodRange } = payroll;
const have = [payWeekStartDayOf, hoursReportWindow, hoursReportRows, currentPayWeekWindow].every((f) => typeof f === 'function');
ok('lib/payroll exports payWeekStartDayOf, hoursReportWindow, hoursReportRows, currentPayWeekWindow', have);

// The Monday week of 14–20 Sep 2026: Mon–Fri 8 h a day (40 h) and SUNDAY 20 Sep 10 h → 50 h on
// the org's week. On a Sunday week the same punches split 40 h | 10 h — no overtime at all.
const at = (key, h) => new Date(startOfDayKey(key, TZ).getTime() + h * 3600e3).toISOString();
let seq = 0;
const punch = (key, startH, mins) => ({
  id: `e${seq++}`, userId: 'u1', userName: 'Ana', clientId: 'cA', siteId: 'sA',
  clockInAt: at(key, startH), clockOutAt: new Date(Date.parse(at(key, startH)) + mins * 60000).toISOString(),
  durationMinutes: mins, status: 'completed', approvalStatus: 'approved', jobCancelledAt: null,
});
const WEEK = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
const entries = [...WEEK.map((k) => punch(k, 18, 480)), punch('2026-09-20', 8, 600)];
const users = [{ id: 'u1', name: 'Ana', status: 'active', pay: { type: 'hourly', hourlyRate: 20 } }];
const FROM = '2026-09-14'; const TO = '2026-09-20';

// ═══ 1. the Hours report agrees with the pay run, on the org's week ═══════════════
if (have) {
  const weekStartDay = payWeekStartDayOf(OPS);
  const period = payPeriodRange('weekly', 0, FROM, TZ, weekStartDay);
  ok('the setting names a Monday week: the period is 14–20 Sep', period.fromKey === FROM && period.toKey === TO, `${period.fromKey}..${period.toKey}`);
  // The overtime the office approved for that week's unit (the run pays approved OT only).
  const otApprovals = [{ userId: 'u1', weekKey: FROM, clientId: 'cA', approvedOtMinutes: 600 }];
  const run = computePayRun({ period, tz: TZ, weekStartDay, entries, otApprovals, users, payDriveTime: false });
  const paid = run.rows.find((r) => r.userId === 'u1')?.current || {};
  ok('the pay run pays 40 h regular + 10 h OT for the Monday week', paid.regularMinutes === 2400 && paid.otMinutes === 600, JSON.stringify(paid));

  const win = hoursReportWindow(FROM, TO, { opsSettings: OPS, tz: TZ });
  const inWin = entries.filter((e) => e.clockInAt >= win.fromIso && e.clockInAt <= win.toIso);
  ok('the report fetches exactly the org\'s pay week', win.fromKey === FROM && win.toKey === TO && inWin.length === entries.length, JSON.stringify(win));
  const rows = hoursReportRows(inWin, { opsSettings: OPS, tz: TZ, fromKey: FROM, toKey: TO, approvedOnly: true });
  const rep = rows.find((r) => r.userId === 'u1') || {};
  ok('Hours by cleaner shows the SAME 40 h + 10 h OT as the pay run', rep.regularMinutes === paid.regularMinutes && rep.otMinutes === paid.otMinutes,
    `report ${rep.regularMinutes}/${rep.otMinutes} vs run ${paid.regularMinutes}/${paid.otMinutes}`);
  ok('…and the same total', rep.totalMinutes === 3000, `${rep.totalMinutes}`);
  const sunday = hoursReportRows(inWin, { opsSettings: { ...OPS, payWeekStartDay: 0 }, tz: TZ, fromKey: FROM, toKey: TO, approvedOnly: true }).find((r) => r.userId === 'u1') || {};
  ok('(a Sunday reading of the same punches shows NO overtime — the disagreement this pins)', sunday.otMinutes === 0, `${sunday.otMinutes}`);
}

// ═══ 2. the overtime watch counts the org's week ════════════════════════════════════
if (have) {
  const now = Date.parse(at('2026-09-20', 20));                      // Sunday evening, last day of the Monday week
  const weekStartDay = payWeekStartDayOf(OPS);
  const byUser = currentWeekMinutesByUser(entries, { now, weekStartDay, tz: TZ });
  const mins = byUser.get('u1')?.minutes;
  ok('the overtime watch counts all 50 h of the Monday week', mins === 3000, `${mins}`);
  ok('…so it flags the cleaner as over 40', otStatus(mins) === 'over', otStatus(mins));
  const sundayMins = currentWeekMinutesByUser(entries, { now, weekStartDay: 0, tz: TZ }).get('u1')?.minutes;
  ok('(a Sunday reading counted only Sunday\'s 10 h and flagged nobody)', sundayMins === 600 && otStatus(sundayMins) === null, `${sundayMins}`);
}

// ═══ 3. "this week" is the whole pay week, DST-safe ═════════════════════════════
if (have) {
  // The Monday week holding 1 Nov 2026 runs Mon 26 Oct 00:00 EDT (04:00Z) to Sun 1 Nov 23:59:59.999 EST.
  const w = currentPayWeekWindow(Date.parse('2026-10-29T15:00:00Z'), { weekStartDay: 1, tz: TZ });
  ok('the fall-back week starts Monday 00:00 EDT', w.fromIso === '2026-10-26T04:00:00.000Z', w.fromIso);
  ok('…and ends the instant before Monday 00:00 EST (a 169-hour week)', w.toIso === '2026-11-02T04:59:59.999Z', w.toIso);
  const s = currentPayWeekWindow(Date.parse('2026-10-29T15:00:00Z'), { weekStartDay: 0, tz: TZ });
  ok('a Sunday week holding the same day starts Sunday 25 Oct', s.fromIso === startOfDayKey('2026-10-25', TZ).toISOString() && s.toIso === new Date(startOfDayKey(addDaysKey('2026-10-25', 7), TZ).getTime() - 1).toISOString(), JSON.stringify(s));
}

// ═══ 4. the pages read it through the one reader; nothing hard-codes Sunday ═══════════
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const hours = read('../src/pages/reports/HoursReport.jsx');
  const variance = read('../src/pages/Variance.jsx');
  const schedule = read('../src/pages/Schedule.jsx');
  ok('Hours by cleaner computes through hoursReportWindow / hoursReportRows with the org\'s settings',
    /hoursReportWindow\([^)]*opsSettings/.test(hours) && /hoursReportRows\([\s\S]{0,80}opsSettings/.test(hours) && !/WEEK_START_DAY/.test(hours));
  const otWatch = (() => { const i = variance.indexOf('const loadOt'); return i < 0 ? '' : variance.slice(i, i + 2400); })();
  ok('the Variance overtime watch reads the org\'s week start and fetches its pay week',
    /payWeekStartDayOf\(/.test(otWatch) && /currentPayWeekWindow\(/.test(otWatch) && !/weekStartDay:\s*0\b/.test(otWatch) && !/startOfPayWeek\([^)]*,\s*0\)/.test(otWatch), otWatch.slice(0, 300));
  ok('Variance WTD starts on the org\'s week start', /case 'wtd':[^\n]*startOfPayWeek\(now,\s*weekStartDay\)/.test(variance));
  const lens = (() => { const i = schedule.indexOf('const [weekClocked, setWeekClocked]'); return i < 0 ? '' : schedule.slice(i, i + 1200); })();
  ok('the Schedule\'s cleaner overtime lens reads the org\'s week start and fetches its pay week',
    /payWeekStartDayOf\(/.test(schedule) && /currentPayWeekWindow\(/.test(lens) && !/weekStartDay:\s*0\b/.test(lens) && !/startOfPayWeek\([^)]*,\s*0\)/.test(lens), lens.slice(0, 300));

  // Class guard: no screen passes a literal Sunday as a PAY week start.
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(n)) files.push(p); } };
  walk(join(root, 'pages')); walk(join(root, 'components'));
  const SUNDAY = /weekStartDay:\s*0\b|WEEK_START_DAY\s*=\s*0\b|startOfPayWeek\([^)]*,\s*0\)|payWeekKeyOf\([^)]*,\s*0[,)]|payWeeksWindow\([^)]*weekStartDay:\s*0/;
  const offenders = files.filter((f) => SUNDAY.test(strip(readFileSync(f, 'utf8')))).map((f) => f.slice(root.length));
  ok('no page or component hard-codes a Sunday pay week', offenders.length === 0, offenders.join(', '));
}

console.log(`\nweek-start-surfaces: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
