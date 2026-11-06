// QuickBooks P&L date windows, for the server. The period grammar (rolling presets, this month,
// a calendar month, a span of the caller's own dates) and its org-zone resolution live in ONE
// pure module the dashboard shares, app/src/lib/pnlRange.js, so the screen can never offer a
// period the route refuses, or the reverse. See that file for every rule.
export {
  RANGE_KEYS, MONTH_TO_DATE, ALL_TIME_START, rangeKind, resolveRange, isRangeKey, rangeDays, spanKey, isDayKey,
} from '../../../src/lib/pnlRange.js';
