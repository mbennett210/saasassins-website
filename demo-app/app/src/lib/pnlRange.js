// The profit & loss PERIOD a dashboard asks for, as ONE string key — PURE (node-loadable, no
// React, no store), shared by the server (api/_lib/qbo/ranges.js re-exports it) and the screen,
// so a period the dashboard offers is exactly a period the server answers.
//
// A key is one of:
//   • a rolling preset ending today — the drill-in's "Revenue by range" bars (Matt's kickoff D3:
//     today / 10 / 15 / 30 days / all-time) and the dashboards' windows (30 / 60 / 90 days,
//     12 months — S111 ②, QB-10): RANGE_KEYS;
//   • 'mtd' — this calendar month so far;
//   • a calendar month, 'YYYY-MM' (Matt, 2026-10-04: "from August, from September, from July");
//   • a span of the caller's own dates, 'YYYY-MM-DD_YYYY-MM-DD' ("I want to be able to edit the
//     dates").
// resolveRange turns any of them into a { start, end } pair of ORG-timezone day labels, which
// become the P&L report's start_date / end_date. Nothing runs past today: a month or span that
// reaches into the future ends today, and one that starts after today is refused. Calendar math
// goes through dates.js (THE LAW II.8), imported with the .js extension so this loads in Node.
import { dayKey, addDaysKey, addMonthsKey, diffDaysKey, startOfMonthKey } from './dates.js';

// Every rolling preset, shortest first. test-qbo-report.mjs / test-qbo-window.mjs hold this to
// exactly the bars (RANGES) plus the windows (WINDOWS) in data/dashboardLayoutPreview.js.
export const RANGE_KEYS = Object.freeze(['day', 'd10', 'd15', 'd30', 'd60', 'd90', 'm12', 'all']);
export const MONTH_TO_DATE = 'mtd';

// Inclusive calendar-day counts ending today. 'm12' and 'all' are special-cased below.
const RANGE_DAYS = Object.freeze({ day: 1, d10: 10, d15: 15, d30: 30, d60: 60, d90: 90 });

// 'all-time' always starts here, and no period may start earlier: a fixed early date that
// predates Clean Space itself (est. 2011, brain/CLIENT.md), so an early bound simply means
// "everything". NOT CompanyInfo.CompanyStartDate: the sandbox probe (2026-09-28) showed that is
// the day the QuickBooks company was created, and a real company imports older history.
export const ALL_TIME_START = '2000-01-01';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SPAN_RE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

// A real calendar day label (rejects 2026-02-30, which addDaysKey would roll into March).
export function isDayKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysKey(s, 0) === s;
}

// What kind of key this is, by its shape alone: 'preset' | 'mtd' | 'month' | 'span' | null.
export function rangeKind(key) {
  if (typeof key !== 'string') return null;
  if (RANGE_KEYS.includes(key)) return 'preset';
  if (key === MONTH_TO_DATE) return 'mtd';
  if (MONTH_RE.test(key)) return 'month';
  const m = SPAN_RE.exec(key);
  if (m && isDayKey(m[1]) && isDayKey(m[2])) return 'span';
  return null;
}

// The last day of a 'YYYY-MM' month.
export function lastDayOfMonth(monthKey) {
  return addDaysKey(addMonthsKey(`${monthKey}-01`, 1), -1);
}

// The key for two dates the caller picked. A whole calendar month reads as that month, so
// picking Aug 1 – Aug 31 by hand shows "August 2026", the same as choosing it from the list.
export function spanKey(from, to) {
  if (from.endsWith('-01') && to === lastDayOfMonth(from.slice(0, 7))) return from.slice(0, 7);
  return `${from}_${to}`;
}

// key + { now, tz } → { start, end } day labels in the org zone. An unknown or impossible key
// throws; the route turns that into a 400.
export function resolveRange(rangeKey, { now = new Date(), tz } = {}) {
  const today = dayKey(now, tz);
  const kind = rangeKind(rangeKey);
  if (kind === 'preset') {
    if (rangeKey === 'all') return { start: ALL_TIME_START, end: today };
    // 'm12' is the twelve CALENDAR months ending today (QB-10): the day after today's date a
    // year ago, through today — month lengths and leap days honoured by addMonthsKey's clamp.
    if (rangeKey === 'm12') return { start: addDaysKey(addMonthsKey(today, -12), 1), end: today };
    return { start: addDaysKey(today, -(RANGE_DAYS[rangeKey] - 1)), end: today };
  }
  if (kind === 'mtd') return { start: startOfMonthKey(today), end: today };
  let start;
  let end;
  if (kind === 'month') {
    start = `${rangeKey}-01`;
    end = lastDayOfMonth(rangeKey);
  } else if (kind === 'span') {
    [start, end] = rangeKey.split('_');
    if (end < start) throw new Error(`qbo: period "${rangeKey}" ends before it starts`);
  } else {
    throw new Error(`qbo: unknown range "${rangeKey}"`);
  }
  if (start < ALL_TIME_START) throw new Error(`qbo: period "${rangeKey}" starts before ${ALL_TIME_START}`);
  if (start > today) throw new Error(`qbo: period "${rangeKey}" starts after today`);
  return { start, end: end > today ? today : end };
}

export function isRangeKey(key, opts) {
  try { resolveRange(key, opts); return true; } catch { return false; }
}

// How many calendar days a key covers today (inclusive).
export function rangeDays(key, opts) {
  const { start, end } = resolveRange(key, opts);
  return diffDaysKey(start, end) + 1;
}

// The twelve calendar months before this one, newest first ('YYYY-MM'): the dashboard's month
// list (QB-10 loads twelve months of history). Older periods are a span of the caller's dates.
export function recentMonths(count = 12, { now = new Date(), tz } = {}) {
  const first = startOfMonthKey(dayKey(now, tz));
  return Array.from({ length: count }, (_, i) => addMonthsKey(first, -(i + 1)).slice(0, 7));
}
