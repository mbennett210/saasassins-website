// "How long ago", in the reader's language (CS-193). PURE: takes the screen's `t`.
//   timeAgo   — "just now" · "5m ago" · "2h ago" · "3d ago" · then the date (the bell)
//   timeShort — "just now" · "5m" · "2h" · "3d" · then the date (message lists)
// A week or more shows the org-calendar date in the reader's locale (lib/dates), not the
// device's — the zone every other date in the app is in.
import { fmtDate } from '../lib/dates.js';

function parts(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < 60_000) return { unit: 'now' };
  const m = Math.floor(ms / 60_000);
  if (m < 60) return { unit: 'm', n: m };
  const h = Math.floor(m / 60);
  if (h < 24) return { unit: 'h', n: h };
  const d = Math.floor(h / 24);
  if (d < 7) return { unit: 'd', n: d };
  return { unit: 'date' };
}

export function timeAgo(t, iso) {
  const p = parts(iso);
  if (!p) return '';
  if (p.unit === 'now') return t('ago.justNow');
  if (p.unit === 'm') return t('ago.minutesAgo', { count: p.n });
  if (p.unit === 'h') return t('ago.hoursAgo', { count: p.n });
  if (p.unit === 'd') return t('ago.daysAgo', { count: p.n });
  return fmtDate(iso, { month: 'numeric', day: 'numeric', year: 'numeric' });
}

// No date fallback: minutes, hours, days up to a year, then years — for a line that already
// shows the date beside it (a key's custody history).
export function timeAgoLong(t, iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return t('ago.justNow');
  if (m < 60) return t('ago.minutesAgo', { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('ago.hoursAgo', { count: h });
  const d = Math.floor(h / 24);
  if (d < 365) return t('ago.daysAgo', { count: d });
  return t('ago.yearsAgo', { count: Math.floor(d / 365) });
}

export function timeShort(t, iso) {
  const p = parts(iso);
  if (!p) return '';
  if (p.unit === 'now') return t('ago.justNow');
  if (p.unit === 'm') return t('ago.minutesShort', { count: p.n });
  if (p.unit === 'h') return t('ago.hoursShort', { count: p.n });
  if (p.unit === 'd') return t('ago.daysShort', { count: p.n });
  return fmtDate(iso);
}
