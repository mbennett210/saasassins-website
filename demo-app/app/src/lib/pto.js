// PTO helpers — days used from the time-off ledger. PURE (node-testable). Time-off
// entries are { userId, startDate, endDate } org-tz day-keys ('YYYY-MM-DD'), inclusive
// on both ends (see store/timeOffRules.js). v1 tracks against a fixed per-employee
// annual allowance (user.hr.ptoAllowanceDays); no accrual/carryover engine.
import { diffDaysKey } from './dates.js';

// Whole PTO days a user booked in calendar `year`, counting only the days that fall
// inside the year (ranges are clamped), inclusive of both endpoints.
export function ptoUsedDays(timeOff, userId, year) {
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  let days = 0;
  for (const t of timeOff || []) {
    if (t.userId !== userId || !t.startDate || !t.endDate) continue;
    const from = t.startDate > yStart ? t.startDate : yStart;
    const to = t.endDate < yEnd ? t.endDate : yEnd;
    if (from > to) continue; // range entirely outside the year
    days += diffDaysKey(from, to) + 1; // inclusive span
  }
  return days;
}

// { allowance, used, remaining } for a user in `year`. allowance defaults 0 (unset).
export function ptoBalance(user, timeOff, year) {
  const allowance = Number(user?.hr?.ptoAllowanceDays) || 0;
  const used = ptoUsedDays(timeOff, user?.id, year);
  return { allowance, used, remaining: Math.max(0, allowance - used) };
}
