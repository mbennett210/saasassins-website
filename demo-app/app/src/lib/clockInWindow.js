// WHEN a clean can be clocked into (CS-052). Pure and node-safe.
//
// The screen used to allow a clock-in only on the clean's org CALENDAR day (`dates.sameDay`), so
// a cleaner who reached an 11 PM clean at 00:30 found the button disabled ("available on the day
// of the clean"), the clean gone from My Day, and the night's hours unrecorded. A calendar day is
// the wrong unit for a shift that crosses midnight; the clean's own times are the right one.
//
// THE WINDOW: from CLOCK_IN_LEAD_MS before the scheduled start until the scheduled end plus the
// auto-close grace (`opsSettings.autoCloseGraceMins`, 120 minutes by default). The trailing edge
// is the auto-close cron's own: a punch opened after it would be closed by the next hourly run
// at once, so a clock-in there records nothing useful — the office adds that time instead.
// A clean with no start time is not gated (as before); one with no (or a backwards) end runs its
// window to start + grace.
//
// Readers: components/ClockControl (the clock-in button) and store/selectors
// selectTodayCleansForUser (My Day keeps a clean from an earlier day on "Today" while its window is
// open). The server's clock-in has no day rule and still has none: a punch is held for a
// manager's approval whatever the hour, and an offline replay is never refused (THE LAW II.8).
//
// `isOnTodayList` below is "today's cleans" itself — My Day's list and, since QR Wave 2
// (2026-10-17), the server's answer to "is there a clean here today?" for a cleaner's scan
// (src/lib/scanFillIn.js): ONE rule, so the phone and the server never disagree about which
// cleans are today's. Its one import is lib/dates, which is node-safe.
import { dayKey } from './dates.js';

export const CLOCK_IN_LEAD_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_AUTO_CLOSE_GRACE_MINS = 120;

const ms = (v) => {
  if (v == null || v === '') return NaN;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
};
const graceOf = (graceMins) => (Number.isFinite(graceMins) && graceMins >= 0 ? graceMins : DEFAULT_AUTO_CLOSE_GRACE_MINS);

// → { opensAt, closesAt } in ms, or null when the clean has no start time (ungated).
export function clockInWindow(job, { graceMins } = {}) {
  const start = ms(job?.startAt);
  if (!Number.isFinite(start)) return null;
  const endRaw = ms(job?.endAt);
  const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : start;
  return { opensAt: start - CLOCK_IN_LEAD_MS, closesAt: end + graceOf(graceMins) * 60000 };
}

// null = a clock-in is allowed now; 'early' = the window has not opened; 'late' = it has closed.
export function clockInRefusal(job, now = Date.now(), opts = {}) {
  const w = clockInWindow(job, opts);
  if (!w) return null;
  const t = ms(now instanceof Date ? now.getTime() : now);
  if (!Number.isFinite(t)) return null;
  if (t < w.opensAt) return 'early';
  if (t > w.closesAt) return 'late';
  return null;
}

// Is this clean on TODAY's list? "Today" is the ORG's calendar day (`todayK`, a dayKey in that
// zone), so an off-site VA or a cleaner who has travelled still sees the business's today. A
// cancelled clean never is. CS-052: a clean from an EARLIER day stays on today's list while it can
// still be clocked into (until its end plus the auto-close grace) and isn't done — the 11 PM clean
// a cleaner reaches at 00:30 used to vanish at midnight. `tz` is the org's zone: the browser's is
// ambient (lib/dates setOrgTimezone), so it passes none; the server passes the shared record's.
export function isOnTodayList(job, todayK, now = Date.now(), graceMins = undefined, tz = undefined) {
  if (!job || job.status === 'cancelled') return false;
  const dk = tz ? dayKey(job.startAt, tz) : dayKey(job.startAt);
  if (dk === todayK) return true;
  return !!dk && dk < todayK && job.status !== 'done' && clockInRefusal(job, now, { graceMins }) === null;
}
