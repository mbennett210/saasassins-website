// Payroll / weekly-hours math — PURE (no React / store / browser deps), so the
// Variance approaching-OT strip, the Schedule by-cleaner badge, and the payroll
// CSV export all compute weekly hours and the regular/OT split IDENTICALLY.
//
// Overtime is a WEEKLY concept: hours over 40 (2400 min) IN A GIVEN WEEK are OT.
// A payroll range that spans multiple weeks splits each week independently — you
// can't sum a whole range and subtract 40 once (that would hide OT in a light
// week and fabricate it in a heavy one). Every rollup buckets by (user, week)
// first, splits reg/OT per bucket, THEN sums the buckets.
//
// Entries are the neutral (camelCase) shape produced by timeApi.rollup / the
// variance mapRow: { id, userId, userName, durationMinutes, clockInAt, clockOutAt,
// approvalStatus, status, siteName, clientName }. See CLEANSPACE_SWEPT.md §5.4 / §5.5.
//
// DRIVE TIME between jobs is PAID TIME and therefore counts toward the weekly 40h
// line (inter-site travel is hours worked). So drive minutes are added INTO the
// (user, week) bucket BEFORE the reg/OT split — never appended to a finished total,
// which would hide OT created by travel. `driveMinutes` is reported alongside as a
// SUBSET breakdown of the total, not an extra amount to pay on top. See lib/driveTime.js.

import { dayKey, dayOfWeekKey, addDaysKey, diffDaysKey, startOfDayKey, fmtDate } from './dates.js';
import { segmentPaidMinutes } from './driveTime.js';
import { rateCentsOf } from './payRates.js';

export const OT_WEEKLY_MINUTES = 40 * 60;          // 2400 — the weekly OT threshold
export const APPROACHING_OT_MINUTES = 36 * 60;     // 2160 — "approaching 40h" (>=90%)

// A bare 'YYYY-MM-DD' is a calendar LABEL and names that day — it is never an instant.
// dayKey() would parse it as UTC midnight, which in every US zone is the evening
// BEFORE: payWeekKeyOf('2026-11-15') (a Sunday) returned the week of Nov 8, so a
// semi-monthly run ending on a Sunday stopped fetching the evening before that Sunday,
// and the next run clips it out too — the Sunday's hours were paid in NEITHER period
// (found 2026-09-22; test-payroll-semimonthly.mjs pins it in a US zone).
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const calendarKey = (dateOrKey, tz) => (
  typeof dateOrKey === 'string' && DAY_KEY_RE.test(dateOrKey) ? dateOrKey : dayKey(dateOrKey, tz)
);

// The org-tz calendar day (YYYY-MM-DD) that STARTS the pay week containing `date`
// (an instant, or a day key). weekStartDay: 0 = Sunday (US payroll default). Anchored
// in the org's zone, not the viewer's: a clock-in near the week edge must bucket into
// the same week for the Manila VA and the Seattle office, or the reg/OT split (i.e.
// pay) diverges by who opened the report. `tz` defaults to the ambient org zone; tests
// pass it explicitly.
export function payWeekKeyOf(date, weekStartDay = 0, tz) {
  const k = calendarKey(date, tz);
  const diff = (dayOfWeekKey(k) - weekStartDay + 7) % 7;
  return addDaysKey(k, -diff);
}

// 🔴 THE WORKWEEK START, READ IN ONE PLACE (PAY-19; CS-659, CS-055). `opsSettings.payWeekStartDay`
// is 0 (Sunday) … 6 (Saturday) — production holds 1, Monday (Matt's PAY-19 b). Anything else
// (unset, a string, out of range) reads as Sunday, the US payroll default, so a missing setting
// never moves a week. The pay run, the approvals read, overtime approval, the Hours report and
// the two overtime watches all ask this — a surface left on its own reading (or on a literal 0)
// counts a different week from the run that pays it, which is how overtime approval came to
// refuse every Monday week (CS-659).
export function payWeekStartDayOf(opsSettings) {
  const d = opsSettings?.payWeekStartDay;
  return Number.isInteger(d) && d >= 0 && d <= 6 ? d : 0;
}

// Is `key` a real calendar day that STARTS a pay week under `weekStartDay`? The overtime unit's
// key (CS-659): the approvals read mints these from the org's week start, so a key that is
// malformed, names no real day ('2026-02-30' — day arithmetic would roll it into March) or
// falls on another weekday is not a unit anything computed, and approving it would pay nobody.
export function isPayWeekKey(key, weekStartDay = 0) {
  if (typeof key !== 'string' || !DAY_KEY_RE.test(key)) return false;
  if (addDaysKey(key, 0) !== key) return false;
  return dayOfWeekKey(key) === weekStartDay;
}

// The instant the pay week begins, in the org zone (for the .toISOString()/.getTime()
// the rollups need).
export function startOfPayWeek(date, weekStartDay = 0, tz) {
  return startOfDayKey(payWeekKeyOf(date, weekStartDay, tz), tz);
}

// A row counts toward paid hours only when it's a COMPLETED clean with a real
// duration. Rejected/voided rows never pay. approvedOnly (payroll) additionally
// requires the manager sign-off; the operational approaching-OT lens leaves it
// false (you owe OT for hours worked, approved or not).
export function isPayable(e, { approvedOnly = false } = {}) {
  if (!e || !e.clockOutAt) return false;
  if (!Number.isFinite(e.durationMinutes) || e.durationMinutes <= 0) return false;
  if (e.status === 'voided') return false;
  if (e.approvalStatus === 'rejected') return false;
  // Labor on a CANCELLED clean is held from pay until a manager AFFIRMATIVELY approves
  // it (gap #1, the affirmative-decision gate). Unlike ordinary pending labor, which the
  // operational lens pays whether approved or not, a cancelled-clean punch pays $0 until
  // approved (rejected is already excluded above), so nothing on a cancelled clean pays
  // by default. Approving it via the normal punch Approve action releases it into the run.
  if (e.jobCancelledAt && e.approvalStatus !== 'approved') return false;
  if (approvedOnly && e.approvalStatus !== 'approved') return false;
  return true;
}

// Split a single week's minutes into { regular, ot } at the 40h line.
export function splitRegularOt(weekMinutes, otWeeklyMinutes = OT_WEEKLY_MINUTES) {
  const total = Math.max(0, Math.round(weekMinutes || 0));
  const regular = Math.min(total, otWeeklyMinutes);
  return { regularMinutes: regular, otMinutes: Math.max(0, total - otWeeklyMinutes) };
}

// Bucket a flat entry list into (user, week) rows with per-week reg/OT split.
// driveSegments (optional, from lib/driveTime.js) fold their PAID minutes into the
// same buckets — bucketed by when the drive STARTED (the clock-out that began it),
// so a leg that crosses the pay-week boundary lands in the week it was worked.
export function rollupWeeklyByUser(entries, { approvedOnly = false, weekStartDay = 0, otWeeklyMinutes = OT_WEEKLY_MINUTES, tz, driveSegments } = {}) {
  const buckets = new Map(); // `${userId}|${weekKey}` -> acc
  const bucketFor = (userId, userName, whenIso) => {
    const wk = payWeekKeyOf(whenIso, weekStartDay, tz);
    const key = `${userId}|${wk}`;
    let acc = buckets.get(key);
    if (!acc) {
      acc = { userId, userName: userName || '—', weekKey: wk, weekStart: startOfDayKey(wk, tz).toISOString(), totalMinutes: 0, driveMinutes: 0, cleanCount: 0 };
      buckets.set(key, acc);
    }
    if (userName && acc.userName === '—') acc.userName = userName;
    return acc;
  };
  for (const e of entries || []) {
    if (!isPayable(e, { approvedOnly })) continue;
    const acc = bucketFor(e.userId, e.userName, e.clockInAt);
    acc.totalMinutes += e.durationMinutes;
    acc.cleanCount += 1;
  }
  for (const s of driveSegments || []) {
    const mins = segmentPaidMinutes(s, { approvedOnly });
    if (!mins) continue;
    const acc = bucketFor(s.userId, s.userName, s.startAt);
    acc.totalMinutes += mins;   // counts toward the 40h line — travel is hours worked
    acc.driveMinutes += mins;   // ...and is reported as a subset of that total
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, ...splitRegularOt(b.totalMinutes, otWeeklyMinutes) }))
    .sort((a, b) => (a.userName || '').localeCompare(b.userName || '') || a.weekKey.localeCompare(b.weekKey));
}

// Aggregate the weekly buckets up to one row per cleaner (reg/OT summed across
// weeks — each week already split at 40h, so the totals are correct).
export function payrollByUser(entries, opts = {}) {
  const weekly = rollupWeeklyByUser(entries, opts);
  const map = new Map();
  for (const w of weekly) {
    let acc = map.get(w.userId);
    if (!acc) {
      acc = { userId: w.userId, userName: w.userName, totalMinutes: 0, regularMinutes: 0, otMinutes: 0, driveMinutes: 0, cleanCount: 0, weeks: [] };
      map.set(w.userId, acc);
    }
    acc.totalMinutes += w.totalMinutes;
    acc.regularMinutes += w.regularMinutes;
    acc.otMinutes += w.otMinutes;
    acc.driveMinutes += w.driveMinutes || 0;
    acc.cleanCount += w.cleanCount;
    acc.weeks.push(w);
  }
  return [...map.values()].sort((a, b) => (a.userName || '').localeCompare(b.userName || ''));
}

// SEMI-MONTHLY payroll — day-attributed reg/OT so a workweek that STRADDLES the
// pay-period boundary (the 15th→16th, or month-end→1st) pays correctly. Buckets
// entries into (user, week, DAY), then within each FULL workweek walks the days in
// chronological order placing the weekly 40h (2400 min) line, and sums reg/OT ONLY
// for the days inside [clipFromKey, clipToKey]. The line is set on the COMPLETE week
// but the over-40h minutes are attributed to the day — hence the half-month — they
// were actually worked, so no OT is lost or fabricated at the split (the core reason
// semi-monthly needs its own path; a plain window sum would compute 40h on a partial
// week). Callers MUST pass entries/driveSegments covering the whole overlapping weeks
// (payPeriodRange's rollupFromIso/rollupToIso), not just the calendar period.
// Returns the SAME per-user row shape as payrollByUser (incl. a clipped `weeks` list).
export function payrollByUserClipped(entries, { approvedOnly = false, weekStartDay = 0, otWeeklyMinutes = OT_WEEKLY_MINUTES, tz, driveSegments, clipFromKey, clipToKey } = {}) {
  // `${userId}|${weekKey}` -> { userId, userName, weekKey, days: Map<dayKey,{labor,drive,cleans}> }
  const weeks = new Map();
  const weekFor = (userId, userName, whenIso) => {
    const wk = payWeekKeyOf(whenIso, weekStartDay, tz);
    const key = `${userId}|${wk}`;
    let acc = weeks.get(key);
    if (!acc) { acc = { userId, userName: userName || '—', weekKey: wk, days: new Map() }; weeks.set(key, acc); }
    if (userName && acc.userName === '—') acc.userName = userName;
    return acc;
  };
  const dayCell = (acc, whenIso) => {
    const dk = dayKey(whenIso, tz);
    let cell = acc.days.get(dk);
    if (!cell) { cell = { dayKey: dk, labor: 0, drive: 0, cleans: 0 }; acc.days.set(dk, cell); }
    return cell;
  };
  for (const e of entries || []) {
    if (!isPayable(e, { approvedOnly })) continue;
    const cell = dayCell(weekFor(e.userId, e.userName, e.clockInAt), e.clockInAt);
    cell.labor += e.durationMinutes; cell.cleans += 1;
  }
  for (const s of driveSegments || []) {
    const mins = segmentPaidMinutes(s, { approvedOnly });
    if (!mins) continue;
    const cell = dayCell(weekFor(s.userId, s.userName, s.startAt), s.startAt);
    cell.labor += mins;   // travel is hours worked → feeds the 40h line
    cell.drive += mins;   // ...and is reported as a subset of the total
  }
  const inClip = (dk) => (!clipFromKey || dk >= clipFromKey) && (!clipToKey || dk <= clipToKey);
  const users = new Map();
  for (const acc of weeks.values()) {
    const days = [...acc.days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
    let cumulative = 0; // minutes earlier in the SAME week (every day, clipped or not — the line spans the whole week)
    const wk = { weekKey: acc.weekKey, weekStart: startOfDayKey(acc.weekKey, tz).toISOString(), totalMinutes: 0, regularMinutes: 0, otMinutes: 0, driveMinutes: 0, cleanCount: 0 };
    for (const cell of days) {
      const remainingReg = Math.max(0, otWeeklyMinutes - cumulative);
      const reg = Math.min(cell.labor, remainingReg);
      const ot = cell.labor - reg;
      cumulative += cell.labor;
      if (!inClip(cell.dayKey)) continue; // advanced the line, but paid in the OTHER half
      wk.totalMinutes += cell.labor; wk.regularMinutes += reg; wk.otMinutes += ot;
      wk.driveMinutes += cell.drive; wk.cleanCount += cell.cleans;
    }
    if (wk.totalMinutes <= 0 && wk.cleanCount <= 0) continue; // nothing paid in THIS half — skip
    let u = users.get(acc.userId);
    if (!u) { u = { userId: acc.userId, userName: acc.userName, totalMinutes: 0, regularMinutes: 0, otMinutes: 0, driveMinutes: 0, cleanCount: 0, weeks: [] }; users.set(acc.userId, u); }
    if (acc.userName && u.userName === '—') u.userName = acc.userName;
    u.totalMinutes += wk.totalMinutes; u.regularMinutes += wk.regularMinutes; u.otMinutes += wk.otMinutes;
    u.driveMinutes += wk.driveMinutes; u.cleanCount += wk.cleanCount; u.weeks.push(wk);
  }
  return [...users.values()].sort((a, b) => (a.userName || '').localeCompare(b.userName || ''));
}

// ── Hours for ANY date range, scoped any way, matching the pay run ─────────────
// Reports › Hours by cleaner used to run payrollByUser over just the punches inside the
// chosen range — a plain window sum, which places the 40h line on a PARTIAL week at each
// edge (a Mon–Fri 10h/day cleaner viewed from Wednesday: 30h regular, 0 OT, where the
// pay run pays 20h + 10h OT for the same days) — and filtered by customer BEFORE the
// split, so hours worked elsewhere never pushed anyone over 40. It also left out paid
// drive, which the pay run counts toward the 40h line.
//
// attributeWeeklyOt() places the line the way the pay run does: per (cleaner, pay week),
// walking that week's payable labor (by clock-in) and paid drive (by the leg's start) in
// time order across the FULL week, and gives every punch / leg its own regular + OT
// minutes. Summed per day it equals payrollByUserClipped exactly (test-hours-report.mjs
// proves it on random data), so any slice of days — and any customer scope — carved out
// of the items agrees with the Payroll run for those days. Callers pass entries + drive
// covering the WHOLE pay weeks they will slice (payWeeksWindow).
//   → [{ kind: 'labor'|'drive', id, userId, userName, dayKey, clientId, minutes,
//        regularMinutes, otMinutes }]   (drive's clientId = the customer driven TO)
export function attributeWeeklyOt(entries, { approvedOnly = false, weekStartDay = 0, otWeeklyMinutes = OT_WEEKLY_MINUTES, tz, driveSegments } = {}) {
  const weeks = new Map(); // `${userId}|${weekKey}` -> { userId, userName, items }
  const add = (userId, userName, whenIso, item) => {
    const key = `${userId}|${payWeekKeyOf(whenIso, weekStartDay, tz)}`;
    let wk = weeks.get(key);
    if (!wk) { wk = { userId, userName: userName || '—', items: [] }; weeks.set(key, wk); }
    if (userName && wk.userName === '—') wk.userName = userName;
    wk.items.push(item);
  };
  for (const e of entries || []) {
    if (!isPayable(e, { approvedOnly })) continue;
    add(e.userId, e.userName, e.clockInAt, {
      kind: 'labor', id: e.id, clientId: e.clientId || null, minutes: e.durationMinutes,
      at: new Date(e.clockInAt).getTime(), dayKey: dayKey(e.clockInAt, tz),
    });
  }
  for (const s of driveSegments || []) {
    const mins = segmentPaidMinutes(s, { approvedOnly });
    if (!mins) continue;
    add(s.userId, s.userName, s.startAt, {
      kind: 'drive', id: s.key || `${s.fromEntryId}>${s.toEntryId}`, clientId: s.toClientId || null, minutes: mins,
      at: new Date(s.startAt).getTime(), dayKey: dayKey(s.startAt, tz),
    });
  }
  const out = [];
  for (const wk of weeks.values()) {
    wk.items.sort((a, b) => a.dayKey.localeCompare(b.dayKey) || (a.at - b.at) || String(a.id).localeCompare(String(b.id)));
    let cumulative = 0; // minutes earlier in the SAME week — the line spans the whole week
    for (const it of wk.items) {
      const reg = Math.min(it.minutes, Math.max(0, otWeeklyMinutes - cumulative));
      cumulative += it.minutes;
      out.push({
        kind: it.kind, id: it.id, userId: wk.userId, userName: wk.userName, dayKey: it.dayKey,
        clientId: it.clientId, minutes: it.minutes, regularMinutes: reg, otMinutes: it.minutes - reg,
      });
    }
  }
  return out;
}

// Sum attributeWeeklyOt items per cleaner over the days [fromKey, toKey], optionally
// scoped to a set of customers (labor by its clean's customer; drive by the customer
// driven TO). Unscoped, a pay-period range equals the pay run's hours for that period.
//   → [{ userId, userName, totalMinutes, regularMinutes, otMinutes, driveMinutes, cleanCount }]
export function hoursByUserForRange(items, { fromKey = null, toKey = null, clientIds = null } = {}) {
  const want = clientIds ? new Set(clientIds) : null;
  const users = new Map();
  for (const it of items || []) {
    if (fromKey && it.dayKey < fromKey) continue;
    if (toKey && it.dayKey > toKey) continue;
    if (want && !want.has(it.clientId)) continue;
    let u = users.get(it.userId);
    if (!u) {
      u = { userId: it.userId, userName: it.userName, totalMinutes: 0, regularMinutes: 0, otMinutes: 0, driveMinutes: 0, cleanCount: 0 };
      users.set(it.userId, u);
    }
    // A week whose punches carried no name reads '—'; a later week's real name wins.
    if (it.userName && it.userName !== '—' && (!u.userName || u.userName === '—')) u.userName = it.userName;
    u.totalMinutes += it.minutes; u.regularMinutes += it.regularMinutes; u.otMinutes += it.otMinutes;
    if (it.kind === 'drive') u.driveMinutes += it.minutes; else u.cleanCount += 1;
  }
  return [...users.values()].sort((a, b) => (a.userName || '').localeCompare(b.userName || ''));
}

// The whole pay weeks overlapping the days [fromKey, toKey] — the window a range slice
// must FETCH so the 40h line lands on complete weeks (the same idea as payPeriodRange's
// rollup window). → { fromKey, toKey, fromIso, toIso } (toIso = the last instant).
export function payWeeksWindow(fromKey, toKey, { weekStartDay = 0, tz } = {}) {
  const wFrom = payWeekKeyOf(fromKey, weekStartDay, tz);
  const wTo = addDaysKey(payWeekKeyOf(toKey, weekStartDay, tz), 6);
  return {
    fromKey: wFrom,
    toKey: wTo,
    fromIso: startOfDayKey(wFrom, tz).toISOString(),
    toIso: new Date(startOfDayKey(addDaysKey(wTo, 1), tz).getTime() - 1).toISOString(),
  };
}

// ── Reports › Hours by cleaner, on the ORG's workweek (CS-055) ───────────────────
// The report used to place the 40 h line on a hard-coded SUNDAY week while the pay run walks the
// org's (`payWeekStartDayOf` — Monday in production), so a week's overtime in the run read as
// none in the report whose CSV goes to payroll. The page fetches `hoursReportWindow` and renders
// `hoursReportRows`; both read the week start from `opsSettings` here, never their own constant.
//   hoursReportWindow → the whole org pay weeks around [fromKey, toKey] (payWeeksWindow's shape)
//   hoursReportRows   → hoursByUserForRange's rows over the attributeWeeklyOt walk
export function hoursReportWindow(fromKey, toKey, { opsSettings, tz } = {}) {
  return payWeeksWindow(fromKey, toKey, { weekStartDay: payWeekStartDayOf(opsSettings), tz });
}
export function hoursReportRows(entries, { opsSettings, tz, fromKey, toKey, approvedOnly = false, clientIds = null, driveSegments } = {}) {
  const items = attributeWeeklyOt(entries, { approvedOnly, weekStartDay: payWeekStartDayOf(opsSettings), tz, driveSegments });
  return hoursByUserForRange(items, { fromKey, toKey, clientIds });
}

// The ORG pay week holding `now` (an instant), as the window a "this week" read fetches — whole
// org-zone days, so a week across a DST change is 167 or 169 hours, not a device-local +7 days
// (CS-055: the overtime watches built it with setDate(+7) on a Sunday they hard-coded).
// → payWeeksWindow's { fromKey, toKey, fromIso, toIso } (toIso = the week's last instant).
export function currentPayWeekWindow(now = new Date(), { weekStartDay = 0, tz } = {}) {
  const k = dayKey(now instanceof Date ? now : new Date(now), tz);
  return payWeeksWindow(k, k, { weekStartDay, tz });
}

// Minutes worked in the week containing `now`, per user (operational lens — all
// completed rows, approved or not). Feeds the approaching-OT badge/strip.
export function currentWeekMinutesByUser(entries, { now = Date.now(), weekStartDay = 0, tz, driveSegments } = {}) {
  const wsKey = payWeekKeyOf(now, weekStartDay, tz);
  const ws = startOfDayKey(wsKey, tz).getTime();
  const we = startOfDayKey(addDaysKey(wsKey, 7), tz).getTime(); // +7 org-days, DST-safe
  const map = new Map();
  const add = (userId, userName, minutes, key) => {
    let acc = map.get(userId);
    if (!acc) { acc = { userId, userName: userName || '—', minutes: 0, driveMinutes: 0 }; map.set(userId, acc); }
    acc.minutes += minutes;
    if (key === 'drive') acc.driveMinutes += minutes;
    if (userName && acc.userName === '—') acc.userName = userName;
  };
  const inWeek = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) && t >= ws && t < we; };
  for (const e of entries || []) {
    if (!isPayable(e, { approvedOnly: false })) continue;
    if (!inWeek(e.clockInAt)) continue;
    add(e.userId, e.userName, e.durationMinutes, 'labor');
  }
  // Paid drive time is hours worked, so the approaching-40h watch has to see it or
  // it under-reports exactly the people driving the most between sites.
  for (const s of driveSegments || []) {
    const mins = segmentPaidMinutes(s, { approvedOnly: false });
    if (!mins || !inWeek(s.startAt)) continue;
    add(s.userId, s.userName, mins, 'drive');
  }
  return map;
}

// 'over' (past 40h) | 'approaching' (>=36h, not yet over) | null.
export function otStatus(minutes, { otWeeklyMinutes = OT_WEEKLY_MINUTES, approachingAt = APPROACHING_OT_MINUTES } = {}) {
  const m = Math.max(0, Math.round(minutes || 0));
  if (m > otWeeklyMinutes) return 'over';
  if (m >= approachingAt) return 'approaching';
  return null;
}

// Minutes -> decimal hours, 2dp (payroll-friendly).
export const minutesToHours = (m) => Math.round(((m || 0) / 60) * 100) / 100;

// One CSV cell, RFC-4180 quoted. A finite NUMBER is written as a number (a negative deduction
// or arrears MUST import as money, not text — quoting it as text broke sums in the payroll
// company's import). Only a TEXT cell whose value starts with = + - @, a TAB, CR or LF is
// formula-neutralized with a leading single quote so a spreadsheet treats it as text, never a
// formula — a payroll export is opened in Excel/Sheets, so a cleaner name like "=cmd|…" is an
// injection sink. Same split as reports/reportKit.jsx `csvCell`. One escaper for BOTH payroll
// CSVs below; the repo's other duplicated quote-only escapers (CS-079) are out of this wave's scope.
export const csvCell = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return `"${v}"`;
  const s = String(v ?? '');
  const neutral = /^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s;
  return `"${neutral.replace(/"/g, '""')}"`;
};

// (The hours-only `payrollCsv` was DELETED 2026-09-29, II.5: it was the retired
// components/PayrollExportModal's builder and had no caller left in the app — only its own
// test — so PAY-9's employee-ID column would have gone onto dead code. The two payroll files
// the office actually hands over are `payrollPayCsv` below (the pay run) and Reports > Hours
// by cleaner, and both carry the id.)

// ─────────────────────────────────────────────────────────────────────────────
// PAY (dollars) — turn the weekly hours/OT rollup into money: hours/cleans/salary
// × rate → base, plus one-off custom lines. Pure like the rest of this file. Money
// is dollars rounded to cents (round2 — the SAME formula as lib/money.js; the
// ledger and any formatter must round identically, BUILD_INTEGRITY §5 / playbook
// II.8). Base is rounded per component then summed, and every custom line is
// rounded, so no two surfaces can disagree by a rounding path.
// ─────────────────────────────────────────────────────────────────────────────

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Pay-period calendar. Weekly and biweekly are WEEK-ALIGNED (each period is a whole
// number of pay weeks anchored on weekStartDay=0/Sunday), so summing the per-week
// reg/OT buckets over the period is exact — no split-week OT. Biweekly blocks are
// anchored to a fixed epoch Sunday so every surface (and the seed) agrees on which
// two weeks form a period, regardless of who opens the report or when.
export const PAY_PERIOD_ANCHOR = '2024-01-07'; // a Sunday

const pad2 = (n) => String(n).padStart(2, '0');
const ymdKey = (y, m1, d) => `${y}-${pad2(m1)}-${pad2(d)}`;
// Calendar days in a 1-based month — a timezone-independent calendar fact, so the
// 16th→end semi-monthly period ends on 28/29/30/31 automatically (Feb leap years
// included: new Date(Date.UTC(y, m1, 0)) is the last day of month m1).
const daysInMonth = (year, month1) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
// Semi-monthly halves indexed globally as year*24 + month0*2 + half (half 0 = 1st–15th,
// 1 = 16th–end), so a pay-period `offset` steps by whole halves across month/year edges.
const semiMonthlyIndexOf = (dateOrKey, tz) => {
  const [y, m, d] = calendarKey(dateOrKey, tz).split('-').map(Number); // ORG-zone calendar date
  return y * 24 + (m - 1) * 2 + (d <= 15 ? 0 : 1);
};
const semiMonthlyBounds = (index) => {
  const half = ((index % 2) + 2) % 2;
  const monthsFromZero = (index - half) / 2;
  const year = Math.floor(monthsFromZero / 12);
  const month1 = (monthsFromZero - year * 12) + 1;
  return half === 0
    ? { fromKey: ymdKey(year, month1, 1),  toKey: ymdKey(year, month1, 15) }
    : { fromKey: ymdKey(year, month1, 16), toKey: ymdKey(year, month1, daysInMonth(year, month1)) };
};

// The org-tz day-key (YYYY-MM-DD) that STARTS the pay period containing dateOrKey.
// `weekStartDay` is the org's workweek start (PAY-19; 0 = Sunday, the US payroll default and
// the value Matt confirmed). It DEFAULTS to 0, so every caller that does not pass it computes
// exactly what it computed before. It has to be honoured here as well as in the OT ledger: with
// the two disagreeing, a weekly/biweekly period would run Sunday-to-Saturday while the 40 h line
// was walked Monday-to-Sunday, and the semi-monthly rollup window would fetch a PARTIAL week at
// each edge — which under-counts overtime, the exact failure payrollByUserClipped exists to avoid.
export function payPeriodStartKey(cadence = 'biweekly', dateOrKey = new Date(), tz, weekStartDay = 0) {
  if (cadence === 'semimonthly') return semiMonthlyBounds(semiMonthlyIndexOf(dateOrKey, tz)).fromKey;
  const wk = payWeekKeyOf(dateOrKey, weekStartDay, tz);   // the start of this pay week
  if (cadence === 'weekly') return wk;
  // The biweekly blocks are anchored to a fixed epoch week so every surface agrees which two
  // weeks form a period. The anchor follows the org's week start; it is already a SUNDAY, so
  // weekStartDay 0 leaves it exactly where it was.
  const anchor = payWeekKeyOf(PAY_PERIOD_ANCHOR, weekStartDay, tz);
  const weeks = Math.round(diffDaysKey(anchor, wk) / 7);
  const blocks = Math.floor(weeks / 2);                 // even-week alignment to the anchor
  return addDaysKey(anchor, blocks * 14);
}

// ── PAY-2: the PAY DATE — when the money actually lands ───────────────────────
// Matt, 2026-09-29: "semi monthly 1 to 15 on the 20th and 16 to 31 on the 5th of the new month."
// A pay period and its PAYDAY are different dates, and the payroll specialist works to the
// payday: it is what the run, its close dialog and the file handed to Paychex have to say.
//
// Semi-monthly pays on a set day AFTER each half (the first half in the SAME month, the second
// half in the NEXT one). Weekly and biweekly pay a set number of days after the period ends.
// A day past the end of a short month CLAMPS to that month's last day, so "the 31st" is a valid
// setting that pays on 28/29/30 in February. Day keys are calendar LABELS, so this is pure
// calendar arithmetic with no zone in it.
export const PAY_DATE_DEFAULTS = { semiFirstHalfDay: 20, semiSecondHalfDay: 5, daysAfterPeriodEnd: 5 };
const clampDayOfMonth = (v, fallback) => (Number.isInteger(v) && v >= 1 && v <= 31 ? v : fallback);
// The ONE reader of the stored field names, so a surface never reads them itself.
export function payDateConfigOf(opsSettings) {
  const o = opsSettings || {};
  const after = o.payDateDaysAfterPeriodEnd;
  return {
    semiFirstHalfDay: clampDayOfMonth(o.payDateSemiFirstHalfDay, PAY_DATE_DEFAULTS.semiFirstHalfDay),
    semiSecondHalfDay: clampDayOfMonth(o.payDateSemiSecondHalfDay, PAY_DATE_DEFAULTS.semiSecondHalfDay),
    daysAfterPeriodEnd: (Number.isInteger(after) && after >= 0 && after <= 60)
      ? after : PAY_DATE_DEFAULTS.daysAfterPeriodEnd,
  };
}
// The payday for one period, as a day key. `config` is payDateConfigOf's output (or null → the
// defaults, so a caller that has not read the settings still gets Matt's schedule, never null).
export function payDateKeyFor(period, config = null) {
  if (!period || !period.fromKey || !period.toKey) return null;
  const cfg = config && Number.isInteger(config.semiFirstHalfDay) ? config : payDateConfigOf(null);
  if (period.cadence === 'semimonthly') {
    const [y, m, d] = String(period.fromKey).split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
    if (d <= 15) return ymdKey(y, m, Math.min(cfg.semiFirstHalfDay, daysInMonth(y, m)));
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return ymdKey(ny, nm, Math.min(cfg.semiSecondHalfDay, daysInMonth(ny, nm)));
  }
  return addDaysKey(period.toKey, cfg.daysAfterPeriodEnd);
}

// The pay period `offset` steps (± whole periods) from the one containing dateOrKey.
// Returns day-keys, ISO bounds (for timeApi.rollup), and a display label.
// SEMI-MONTHLY (1st–15th / 16th–end) does NOT fall on week edges, so it ALSO returns
// rollupFromIso/rollupToIso — the whole pay-weeks overlapping the period — which the
// payroll run fetches so weekly (40h) OT is computed on complete workweeks and then
// day-attributed back into the calendar period (payrollByUserClipped). For the
// week-aligned cadences the rollup window equals the period itself.
export function payPeriodRange(cadence = 'biweekly', offset = 0, dateOrKey = new Date(), tz, weekStartDay = 0) {
  const opt = { year: 'numeric', month: 'short', day: 'numeric' };
  let fromKey; let toKey; let span;
  if (cadence === 'semimonthly') {
    const b = semiMonthlyBounds(semiMonthlyIndexOf(dateOrKey, tz) + offset);
    fromKey = b.fromKey; toKey = b.toKey;
    span = diffDaysKey(fromKey, toKey) + 1; // 13–16 days — variable, unlike the fixed cadences
  } else {
    span = cadence === 'weekly' ? 7 : 14;
    const base = payPeriodStartKey(cadence, dateOrKey, tz, weekStartDay);
    fromKey = addDaysKey(base, offset * span);
    toKey = addDaysKey(fromKey, span - 1);
  }
  const fromDate = startOfDayKey(fromKey, tz);
  const dayAfter = startOfDayKey(addDaysKey(toKey, 1), tz); // exclusive end (next day 00:00)
  // Rollup window = the whole pay-weeks overlapping the period, anchored on the ORG's workweek
  // start (PAY-19; Sunday by default, which is what this always did). Equal to the period for
  // the week-aligned cadences.
  const rollupFromKey = cadence === 'semimonthly' ? payWeekKeyOf(fromKey, weekStartDay, tz) : fromKey;
  const rollupToKey = cadence === 'semimonthly' ? addDaysKey(payWeekKeyOf(toKey, weekStartDay, tz), 6) : toKey;
  const rollupDayAfter = startOfDayKey(addDaysKey(rollupToKey, 1), tz);
  return {
    cadence, span, weekStartDay, fromKey, toKey,
    fromIso: fromDate.toISOString(),
    toIso: new Date(dayAfter.getTime() - 1).toISOString(), // last instant of the period
    rollupFromIso: startOfDayKey(rollupFromKey, tz).toISOString(),
    rollupToIso: new Date(rollupDayAfter.getTime() - 1).toISOString(),
    label: `${fmtDate(fromDate.toISOString(), opt, tz)} – ${fmtDate(startOfDayKey(toKey, tz).toISOString(), opt, tz)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAY RATES BY BUILDING — the week's BLENDED overtime rate (PAY-7 / PAY-18, Matt
// 2026-09-29: "one cleaner might have two rate during the day gets $15 at abd building and at
// night gets $17 at yzd building"). The FIELD lives in lib/payRates.js; the MONEY lives here,
// beside `basePayForUser`, because that is the one pricer every caller comes through.
//
// THE FEDERAL RULE (FLSA 29 CFR 778.115, "employees working at two or more rates"):
//   straight time = every hour worked × the rate for ITS building
//   regular rate  = that WEEK's straight-time pay ÷ that WEEK's hours    ("blended")
//   each OT hour  = its straight time (already counted above) + 0.5 × the blended rate
// so the premium is identical for every OT hour in the week whichever building it fell at —
// which is the whole point: otherwise the order the 40 h line happened to be walked in would
// decide the wage. With ONE rate it collapses to exactly `reg × r + ot × r × mult`, and
// `basePayForUser` takes that untouched path so a one-rate week is byte-identical to before.
//
// INPUT — `rateWeeks`, built by the caller that knows which punch was at which building
// (lib/payRun.computePayRun, from the weekly ledger's items):
//   [{ weekKey,
//      paid:  [{ rateCents, regularMinutes, otMinutes }],   // what THIS period pays for
//      basis: [{ rateCents, regularMinutes, otMinutes }] }] // the WHOLE week, for the blend
// `basis` defaults to `paid`, and matters when a period cuts through a week (semi-monthly) or
// when an arrears delta is priced: the blended rate is a property of the WEEK, so the two halves
// of a straddling week must blend over the same full week or their premiums disagree.
// Minutes may be NEGATIVE (an arrears delta after a void) — the money then comes back signed.
const normBuckets = (list) => (Array.isArray(list) ? list : [])
  .filter((b) => b && Number.isFinite(Number(b.rateCents)))
  .map((b) => ({
    rateCents: Math.round(Number(b.rateCents)),
    regularMinutes: Math.round(Number(b.regularMinutes) || 0),
    otMinutes: Math.round(Number(b.otMinutes) || 0),
  }));

// The ONE rate every bucket in every week shares (paid AND basis), or null when there is none
// (no buckets at all) or more than one. `null` is what sends `basePayForUser` down its original
// path, so "nobody has building rates" costs nothing and changes nothing.
function singleRateCents(rateWeeks) {
  let only = null;
  for (const wk of rateWeeks || []) {
    for (const b of [...normBuckets(wk && wk.paid), ...normBuckets(wk && wk.basis)]) {
      if (only === null) only = b.rateCents;
      else if (only !== b.rateCents) return null;
    }
  }
  return only;
}

// The money AND the parts a screen renders, so the drawer can never re-derive a different
// figure from `pay.hourlyRate` (it used to, and that was the display half of this defect).
// Cents per component, summed — the same per-item rounding the rest of this file uses.
export function hourlyPayBreakdown(rateWeeks, { otMultiplier = 1.5, otExempt = false } = {}) {
  const byRate = new Map();
  let straightCents = 0; let premiumCents = 0; let otMinutes = 0;
  let basisStraightCents = 0; let basisHours = 0;
  for (const wk of rateWeeks || []) {
    const paid = normBuckets(wk && wk.paid);
    const declared = normBuckets(wk && wk.basis);
    let wkStraight = 0; let wkOt = 0;
    for (const b of paid) {
      const minutes = b.regularMinutes + b.otMinutes;
      const cents = Math.round(minutesToHours(minutes) * b.rateCents);
      wkStraight += cents; wkOt += b.otMinutes;
      const acc = byRate.get(b.rateCents) || { rateCents: b.rateCents, minutes: 0, payCents: 0 };
      acc.minutes += minutes; acc.payCents += cents;
      byRate.set(b.rateCents, acc);
    }
    // The blend's denominator is the WEEK. When the caller declares no basis it is this
    // period's own hours; when the week recomputed to NOTHING (every punch voided) fall back to
    // the MAGNITUDES of what is being reversed, so a premium already paid is clawed back at the
    // rate it was paid at instead of silently kept.
    let basis = declared.length ? declared : paid;
    let bStraight = 0; let bHours = 0;
    const measure = (list, abs) => {
      let s = 0; let h = 0;
      for (const b of list) {
        const mins = abs ? Math.abs(b.regularMinutes) + Math.abs(b.otMinutes) : b.regularMinutes + b.otMinutes;
        const hours = minutesToHours(mins);
        s += Math.round(hours * b.rateCents); h += hours;
      }
      return [s, h];
    };
    [bStraight, bHours] = measure(basis, false);
    if (bHours === 0) { basis = paid; [bStraight, bHours] = measure(basis, true); }
    const blendedCents = bHours !== 0 ? bStraight / bHours : 0;
    const prem = otExempt ? 0 : Math.round(minutesToHours(wkOt) * (otMultiplier - 1) * blendedCents);
    straightCents += wkStraight; premiumCents += prem; otMinutes += wkOt;
    basisStraightCents += bStraight; basisHours += bHours;
  }
  const rates = [...byRate.values()]
    .sort((a, b) => b.rateCents - a.rateCents)
    .map((r) => ({ rateCents: r.rateCents, rate: r.rateCents / 100, minutes: r.minutes, pay: round2(r.payCents / 100) }));
  return {
    payCents: straightCents + premiumCents,
    straightCents, premiumCents, otMinutes,
    multiRate: byRate.size > 1,
    rates,
    otPremium: round2(premiumCents / 100),
    // A DISPLAY figure across the whole row: exact for a single week, and the hours-weighted
    // average of each week's blend over several (each week's own premium was already computed
    // from its own blend above — this line only labels it).
    blendedRate: basisHours !== 0 ? (basisStraightCents / basisHours) / 100 : 0,
  };
}

// Base pay for one payrollByUser/weekly row given the user's pay config:
//   hourly    → regular hours × rate + OT hours × rate × otMultiplier (otExempt: no OT premium),
//               or — when `rateWeeks` carries more than one rate — straight time at each
//               building's rate plus the week's BLENDED overtime premium (see above)
//   per_visit → perVisitRate × cleanCount
//   salary    → salaryPerPeriod × periodsCovered (whole periods in the range)
//   none/unset → null (excluded from payroll)
export function basePayForUser(row, pay, { otMultiplier = 1.5, periodsCovered = 1, rateWeeks = null } = {}) {
  if (!pay || !pay.type || pay.type === 'none') return null;
  if (pay.type === 'hourly') {
    const single = singleRateCents(rateWeeks);
    // MORE THAN ONE RATE in the row → the blended path. Otherwise the original formula, with
    // the one rate the buckets agree on (which is `pay.hourlyRate` unless every hour was worked
    // at one override building), so nothing about a one-rate week moves by a cent.
    if (single === null && rateWeeks && rateWeeks.length) {
      return round2(hourlyPayBreakdown(rateWeeks, { otMultiplier, otExempt: pay.otExempt }).payCents / 100);
    }
    const mainRate = Number(pay.hourlyRate) || 0;
    const rate = (single === null || single === rateCentsOf(mainRate)) ? mainRate : single / 100;
    const regPay = round2(minutesToHours(row ? row.regularMinutes : 0) * rate);
    const otHours = pay.otExempt ? 0 : minutesToHours(row ? row.otMinutes : 0);
    const otPay = round2(otHours * rate * otMultiplier);
    return round2(regPay + otPay);
  }
  if (pay.type === 'per_visit') {
    return round2((Number(pay.perVisitRate) || 0) * (row ? (row.cleanCount || 0) : 0));
  }
  if (pay.type === 'salary') {
    return round2((Number(pay.salaryPerPeriod) || 0) * (periodsCovered || 1));
  }
  return null;
}

// Sum custom lines into earnings (+), deductions (−), net, taxable/non-taxable, and
// per-category totals. A line amount is SIGNED dollars (deductions negative).
// Reimbursements carry taxable:false and are tallied apart so they stay out of tax bases.
export function lineTotals(lines) {
  const acc = { earnings: 0, deductions: 0, net: 0, taxable: 0, nonTaxable: 0, byCategory: {} };
  for (const l of lines || []) {
    const amt = round2(l.amount);
    acc.net = round2(acc.net + amt);
    if (amt < 0) acc.deductions = round2(acc.deductions + amt);
    else acc.earnings = round2(acc.earnings + amt);
    if (l.taxable === false) acc.nonTaxable = round2(acc.nonTaxable + amt);
    else acc.taxable = round2(acc.taxable + amt);
    acc.byCategory[l.category] = round2((acc.byCategory[l.category] || 0) + amt);
  }
  return acc;
}

// Gross for one user = base (hours/cleans/salary) + net custom lines. null when excluded.
export function grossForUser(row, pay, lines, opts = {}) {
  const base = basePayForUser(row, pay, opts);
  if (base == null) return null;
  return round2(base + lineTotals(lines).net);
}

// Who belongs on a pay run. Every ACTIVE member, plus anyone still on file who earned
// pay in THIS period whatever their status now: payable hours or a pay line in the
// period, or disabled after it began (a salaried member has no punches to show it, so
// `disabledAt` is the proof they were still employed). Disabling someone mid-period
// must never drop pay they already earned. People NO LONGER on file can't be priced —
// their pay rate left with them — so their hours/lines in the period come back apart
// in `removed` ({ userId, name, minutes, cleans, lineNet }) for a visible notice.
export function payRunRoster({ users = [], hoursRows = [], lines = [], periodKey, periodFromIso } = {}) {
  const withHours = new Set(hoursRows.map((r) => r.userId));
  const periodLines = lines.filter((l) => l.periodKey === periodKey);
  const withLines = new Set(periodLines.map((l) => l.userId));
  const from = periodFromIso ? Date.parse(periodFromIso) : NaN;
  const activeDuring = (u) => !!u.disabledAt && Number.isFinite(from) && Date.parse(u.disabledAt) > from;
  const members = users.filter((u) => u.status === 'active' || withHours.has(u.id) || withLines.has(u.id) || activeDuring(u));

  const onFile = new Set(users.map((u) => u.id));
  const removed = new Map();
  const entry = (userId) => {
    if (!removed.has(userId)) removed.set(userId, { userId, name: null, minutes: 0, cleans: 0, lineNet: 0 });
    return removed.get(userId);
  };
  const realName = (n) => (typeof n === 'string' && n.trim() && n !== '—' ? n : null);
  for (const r of hoursRows) {
    if (onFile.has(r.userId)) continue;
    const e = entry(r.userId);
    e.name = e.name || realName(r.userName);
    e.minutes += r.totalMinutes || 0;
    e.cleans += r.cleanCount || 0;
  }
  for (const l of periodLines) {
    if (onFile.has(l.userId)) continue;
    const e = entry(l.userId);
    e.name = e.name || realName(l.userName);
    e.lineNet = round2(e.lineNet + (Number(l.amount) || 0));
  }
  return { members, removed: [...removed.values()] };
}

// Richer payroll CSV: the hours columns PLUS the per-cleaner dollar breakdown, PLUS the
// arrears owed for prior closed periods paid on this run (W2-L). The caller pre-computes each
// row {userName, payTypeLabel, regularMinutes, otMinutes, base, gross, byCategory,
// arrearsRegularMinutes, arrearsOtMinutes, arrearsPay} — GROSS already INCLUDES arrearsPay
// (base + arrears + custom lines), so the arrears columns are a breakdown, never a second
// amount to pay. Reimbursements are labeled non-tax so nobody taxes them. Every cell is
// formula-neutralized (csvCell) — a negative deduction or a crafted name can't run in a sheet.
export function payrollPayCsv(rows, { fromIso, toIso, tz } = {}) {
  const period = `${fromIso ? fmtDate(fromIso, { year: 'numeric', month: 'numeric', day: 'numeric' }, tz) : '—'} – ${toIso ? fmtDate(toIso, { year: 'numeric', month: 'numeric', day: 'numeric' }, tz) : '—'}`;
  // PAY-9 / CS-382 (Matt, 2026-09-29): the EMPLOYEE ID the payroll company matches on, right
  // beside the name it identifies. Without it they matched people by NAME, so one collision
  // or spelling difference mis-pays someone. Blank for a member who has none — a normal
  // state, and for a CLOSED run whose stored file rows predate this column.
  const head = ['Cleaner', 'Employee ID', 'Pay type', 'Regular hours', 'OT hours', 'Base pay', 'Bonus', 'Special service', 'Reimbursement (non-tax)', 'Tip', 'Deduction', 'Arrears regular hours', 'Arrears OT hours', 'Arrears pay', 'Gross', 'Pay period'];
  const out = [head.map(csvCell).join(',')];
  for (const r of rows || []) {
    const c = r.byCategory || {};
    out.push([
      r.userName, r.employeeId || '', r.payTypeLabel || '',
      r.regularMinutes != null ? minutesToHours(r.regularMinutes) : '',
      r.otMinutes != null ? minutesToHours(r.otMinutes) : '',
      r.base != null ? r.base : '',
      c.bonus || 0, c.special || 0, c.reimbursement || 0, c.tip || 0, c.deduction || 0,
      r.arrearsRegularMinutes != null ? minutesToHours(r.arrearsRegularMinutes) : '',
      r.arrearsOtMinutes != null ? minutesToHours(r.arrearsOtMinutes) : '',
      r.arrearsPay != null ? r.arrearsPay : '',
      r.gross != null ? r.gross : '',
      period,
    ].map(csvCell).join(','));
  }
  return out.join('\n');
}
