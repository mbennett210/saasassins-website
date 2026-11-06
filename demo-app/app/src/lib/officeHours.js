// Office hours — the org's working days + wall-clock window, in the ORG's timezone.
//
// 🔴 WO-7 (Matt, 2026-09-29): "Overnight, should ticket alerts wake people up? — (a) Urgent
// tickets alert any time; the rest wait until morning." So every non-urgent ticket alert is
// bounded by this window, and the urgent ones ignore it.
//
// 🔴 WO-17 is UNANSWERED (the follow-up asking for his hours and days). Until he answers, the
// default is Mon–Fri 08:00–17:00 — a setting, so his answer is a number to type, not a deploy
// (Settings → Operations → Office hours).
//
// PURE + node-safe (explicit `.js` on its one import) so the serverless cron
// (api/cron/ops-alerts) and the browser read the SAME window. Vercel crons run TZ=UTC, so
// "is it office hours" can never be asked of the process clock — every read here goes through
// the org zone (lib/dates), exactly as reminderScheduler's civil-hours gate does.
import { dayKey, dayOfWeekKey, minutesInZone } from './dates.js';

// Mon–Fri 08:00–17:00. The days are the JS weekday numbers dayOfWeekKey returns (0 = Sunday),
// so a saved list is comparable with what the walker computes, with no second vocabulary.
export const OFFICE_HOURS_DEFAULTS = {
  officeHoursDays: [1, 2, 3, 4, 5],
  officeHoursStart: '08:00',
  officeHoursEnd: '17:00',
};

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MINUTES_IN_DAY = 24 * 60;

// 'HH:MM' → minutes since midnight, or null when it is not a time. Accepts 'H:MM' and
// tolerates a seconds tail ('08:00:00') because an <input type="time"> emits one on some
// browsers. Anything out of range is null, never clamped: a bad value must fall back to the
// default rather than silently become midnight, which would read as "all night is office hours".
export function parseHhMm(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// minutes since midnight → 'HH:MM' (what an <input type="time"> wants).
export function fmtHhMm(minutes) {
  const total = ((Math.round(Number(minutes)) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// The effective window, with every field defaulted. ONE reader, so the walker, the push
// dispatcher and the settings form can never disagree about what the org's hours are.
//   • days  — de-duplicated, sorted, 0…6 only. An EMPTY or non-array list falls back to
//             Mon–Fri: a saved empty list would mean "no day is an office day", which would
//             silence every non-urgent ticket alert for ever.
//   • start/end — 'HH:MM'. A malformed value, or start === end, falls back to the default
//             pair, so a half-typed time cannot collapse the window to nothing.
export function officeHoursConfig(settings = {}) {
  const rawDays = settings?.officeHoursDays;
  const days = Array.isArray(rawDays)
    ? [...new Set(rawDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [];
  const startMins = parseHhMm(settings?.officeHoursStart);
  const endMins = parseHhMm(settings?.officeHoursEnd);
  const bad = startMins == null || endMins == null || startMins === endMins;
  return {
    days: days.length ? days : [...OFFICE_HOURS_DEFAULTS.officeHoursDays],
    startMins: bad ? parseHhMm(OFFICE_HOURS_DEFAULTS.officeHoursStart) : startMins,
    endMins: bad ? parseHhMm(OFFICE_HOURS_DEFAULTS.officeHoursEnd) : endMins,
  };
}

// Is `at` inside the org's office hours? `tz` is the blob's `company.timezone`, which may be
// null/'' — lib/dates resolves a falsy zone to the org default rather than the process zone
// (the cron's is UTC), so a missing zone is never an 8-hour shift in the answer.
//
// The window is [start, end): a ticket alert at exactly 17:00 has missed the day, which is the
// reading an operator expects of "we close at five".
//
// An OVERNIGHT window (end before start, e.g. 20:00–04:00) is supported: it spans midnight, so
// a day is an office day if the SHIFT STARTING on it is running — the day check is applied to
// the start side of the window, which is the day an operator means when they say "we work
// Friday nights".
export function isWithinOfficeHours(at = Date.now(), settings = {}, tz = null) {
  const { days, startMins, endMins } = officeHoursConfig(settings);
  const mins = minutesInZone(at, tz);
  const dow = dayOfWeekKey(dayKey(at, tz));
  if (endMins > startMins) {
    return days.includes(dow) && mins >= startMins && mins < endMins;
  }
  // Overnight: the evening part belongs to today's office day, the small hours to yesterday's.
  if (mins >= startMins) return days.includes(dow);
  if (mins < endMins) return days.includes((dow + 6) % 7);
  return false;
}

// "Mon–Fri 8:00 AM – 5:00 PM" style summary for the settings help text. Display only.
export function officeHoursSummary(settings = {}) {
  const { days, startMins, endMins } = officeHoursConfig(settings);
  const label = days.map((d) => WEEKDAY_SHORT[d]).join(', ');
  return `${label || 'No days'} ${fmtHhMm(startMins)}–${fmtHhMm(endMins)}`;
}
