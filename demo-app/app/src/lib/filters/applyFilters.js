// Reusable, URL-persisted faceted filter engine.
//
// A FilterSpec declares ONE facet — how it reads the URL, what control renders,
// and how it matches a row. Specs are plain config (see scheduleFilters.js); the
// engine + the useUrlFilters hook + <FilterBar> are generic, so Scheduling, the
// Variance report, and QC all reuse the SAME filter system. See CLEANSPACE_SWEPT.md §2.6.
//
//   spec = {
//     key,                       // URL param name (namespace per page if keys could collide)
//     label,                     // control label
//     kind: 'multi' | 'single' | 'dateRange' | 'toggle',
//     options?(ctx) => [{ value, label, group? }],   // lazy option provider (multi/single/toggle)
//     match(item, value, ctx) => boolean,            // per-facet predicate (skipped when value is empty)
//     defaultValue?,             // value meaning "no constraint" (URL param dropped when equal)
//     encode?(v) => string, decode?(str) => v,       // optional codec overrides
//   }
import { startOfWeek, startOfMonth, startOfDayKey, startOfQuarterKey, startOfYearKey, dayKey, addDaysKey, addMonthsKey } from '../dates';

// Shared period vocabulary — the date-range presets used by the schedule views
// AND the variance report, so the two surfaces speak the same language.
// FORWARD preset vocabulary for the Schedule: a calendar is about what's
// coming, and every retrospective preset below ends at `now` — selecting one
// on /schedule hid the ENTIRE future schedule (2026-07-30 report: "custom date
// range is not working"). Variance keeps the retrospective list; the schedule
// range spec declares this one via `spec.presets`.
export const SCHEDULE_DATE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'next7', label: 'Next 7 days' },
  { value: 'next30', label: 'Next 30 days' },
  { value: 'weekAll', label: 'This week' },
  { value: 'monthAll', label: 'This month' },
];

export const DATE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year', label: 'This year' },
];

// Per-kind serialization to/from the URL + the "empty" test.
export function codecFor(kind) {
  switch (kind) {
    case 'multi':
      return {
        default: [],
        encode: (v) => (Array.isArray(v) && v.length ? v.join(',') : ''),
        decode: (s) => (s ? String(s).split(',').filter(Boolean) : []),
        empty: (v) => !Array.isArray(v) || v.length === 0,
      };
    case 'dateRange':
      return {
        default: null,
        encode: (v) => {
          if (!v) return '';
          // '__custom' encodes as 'from~to' EVEN WHEN BOTH ARE EMPTY ('~'):
          // encoding it to '' made useUrlFilters DELETE the param, which
          // snapped the select back to "Any time" before the date inputs ever
          // rendered — Custom was 100% unreachable (2026-07-30 report).
          if (v.preset === '__custom' || v.from || v.to) return `${v.from || ''}~${v.to || ''}`;
          if (v.preset) return v.preset;
          return '';
        },
        decode: (s) => {
          if (!s) return null;
          if (s.includes('~')) {
            const [from, to] = s.split('~');
            return { preset: '__custom', from: from || '', to: to || '' };
          }
          return { preset: s };
        },
        empty: (v) => !v || (!v.preset && !v.from && !v.to),
      };
    default: // 'single' | 'toggle'
      return {
        default: '',
        encode: (v) => (v == null ? '' : String(v)),
        decode: (s) => (s == null ? '' : String(s)),
        empty: (v) => v == null || v === '',
      };
  }
}

// Is this facet effectively unset (imposes no constraint; its URL param should be
// dropped)? True when the codec considers it empty OR it equals the declared
// "no constraint" defaultValue (e.g. a single-select 'all').
export function isEmptyValue(spec, v) {
  const codec = spec.codec || codecFor(spec.kind);
  if (codec.empty(v)) return true;
  if (spec.defaultValue !== undefined && v === spec.defaultValue) return true;
  return false;
}

// Apply every facet (AND across facets). An empty facet is skipped, never matched.
export function applyFilters(items, values, specs, ctx) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => specs.every((spec) => {
    const v = values[spec.key];
    if (isEmptyValue(spec, v)) return true;
    return spec.match ? spec.match(item, v, ctx) : true;
  }));
}

// A calendar-day key ('YYYY-MM-DD') naming a real day. A custom range is read from the
// URL, where a truncated or hand-edited link can hold anything: a partial key ('2026-01')
// made the day math throw mid-render, and an impossible one ('2026-02-31') rolls into March.
export function isDayKey(k) {
  return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && addDaysKey(k, 0) === k;
}

// The last instant of an org-zone day: the next day's start, less 1 ms. (It was 23:59:00,
// which left out anything stamped in the day's last minute; an inspection's performed_at
// or a punch carries seconds.)
const endOfDayK = (k) => new Date(startOfDayKey(addDaysKey(k, 1)).getTime() - 1);

// Resolve a dateRange facet value ({preset} | {from,to}) into concrete Date bounds
// for matching. Open-ended on either side. Uses the app's Monday-start week. A custom
// bound that isn't a real day (isDayKey) is left open rather than crashing the page;
// a caller that must not widen (a server read) checks isDayKey first.
export function rangeBounds(value, now = new Date()) {
  if (!value) return { from: null, to: null };
  // Custom from/to are calendar days chosen by the user; anchor them at the org's
  // day boundaries so the same range means the same window regardless of viewer zone.
  if (value.from || value.to) {
    return {
      from: isDayKey(value.from) ? startOfDayKey(value.from) : null,
      to: isDayKey(value.to) ? endOfDayK(value.to) : null,
    };
  }
  const end = new Date(now);
  const back = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d; }; // rolling N×24h — zone-independent
  const todayK = dayKey(now);
  switch (value.preset) {
    // Forward presets (SCHEDULE_DATE_PRESETS) — full calendar spans, because a
    // schedule range that ends at `now` hides the entire future schedule.
    case 'next7': return { from: startOfDayKey(todayK), to: endOfDayK(addDaysKey(todayK, 7)) };
    case 'next30': return { from: startOfDayKey(todayK), to: endOfDayK(addDaysKey(todayK, 30)) };
    case 'weekAll': return { from: startOfWeek(now), to: endOfDayK(addDaysKey(dayKey(startOfWeek(now)), 6)) };
    case 'monthAll': return { from: startOfMonth(now), to: new Date(startOfDayKey(addMonthsKey(`${todayK.slice(0, 7)}-01`, 1)).getTime() - 1) };
    case 'today': return { from: startOfDayKey(todayK), to: endOfDayK(todayK) };
    case '7d': return { from: back(7), to: end };
    case '30d': return { from: back(30), to: end };
    case '90d': return { from: back(90), to: end };
    case 'week': return { from: startOfWeek(now), to: end };
    case 'month': return { from: startOfMonth(now), to: end };
    case 'quarter': return { from: startOfDayKey(startOfQuarterKey(todayK)), to: end };
    case 'year': return { from: startOfDayKey(startOfYearKey(todayK)), to: end };
    default: return { from: null, to: null };
  }
}
