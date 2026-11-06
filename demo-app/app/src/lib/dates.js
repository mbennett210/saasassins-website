// Date helpers. Keep the app on ISO strings internally; format only at the edges.
//
// TIMEZONE CONTRACT — read before touching anything here.
//
// Every calendar-facing helper resolves in the ORG's timezone (company.timezone),
// never the device's. A 9:00 AM job in Seattle is 9:00 AM for the Seattle admin AND
// for the Manila VA who booked it: the crew turns up at the site's wall clock, so
// the site's zone is the only one that means anything. Before this contract existed,
// `todayIso().slice(0,10)` read the UTC day off a LOCAL midnight — which is the
// previous calendar day for every zone east of Greenwich, so a VA in Manila (UTC+8)
// booked every job one day early while Seattle (UTC-8) never saw it.
//
// Instants (job.startAt, timestamps) stay absolute ISO/UTC — that model is correct
// and unchanged. Only the edges move: parsing wall-clock input, and rendering.
//
// The org zone is ambient rather than an argument to all ~56 call sites because a
// missed call site must still be RIGHT. An explicit-arg design fails open: forget
// one and it silently reverts to device-local, i.e. straight back to the bug.
// setOrgTimezone() is called by the store before any component renders; lib/dates
// cannot read store state directly (store/reducer.js already imports this module,
// so the dependency would be circular).

// The canonical default org timezone — the single source of truth for "what zone
// does scheduling resolve in when nothing else says otherwise". Clean Space is an
// East-coast business (Daniel's call, CS-029: "This is an East coast company"), so the
// default is Eastern. Production's LIVE org_state carries an explicit company.timezone
// (read 2026-09-27), which only a Super Admin changes in Settings → Company — so
// changing THIS default does not move a configured org; it governs a fresh clone, a
// blank zone, and the login-free demo. Keep the seed's company.timezone in sync with this.
// The Creole month and weekday names (CS-851): no phone or browser carries them (see creoleFormatter).
import { CALENDAR_NAMES, intlLocale } from '../i18n/languages.js';

export const DEFAULT_ORG_TIMEZONE = 'America/New_York';

let ORG_TZ = DEFAULT_ORG_TIMEZONE;

// Called by StoreProvider from company.timezone. A blank/unknown zone falls back to
// the Eastern default rather than the device zone: an operator in another timezone must
// still see the business's Eastern schedule, not their own. (A client on a different
// shell simply saves their own zone; the default only decides the pre-configuration
// state.)
export function setOrgTimezone(tz) { ORG_TZ = tz || DEFAULT_ORG_TIMEZONE; }
export function getOrgTimezone() { return ORG_TZ; }

// THE DISPLAY LOCALE (CS-193). Ambient for the same reason the zone is: a missed call site
// must still be right. The i18n runtime (src/i18n/runtime.js) sets it from the language the
// signed-in person reads the app in, so "Oct 3" becomes "3 oct" on a Spanish screen without
// touching the ~60 formatter call sites. Unset (the server, a test, the login screen before
// any choice) it is `undefined`, which is exactly what these formatters passed before: the
// device / process default. A formatter that renders for SOMEONE ELSE (an alert written for
// its recipient, src/i18n/core.js) passes that person's locale explicitly instead.
let UI_LOCALE;
export function setUiLocale(locale) { UI_LOCALE = locale || undefined; }
export function getUiLocale() { return UI_LOCALE; }

const pad = (n) => String(n).padStart(2, '0');

// Constructing an Intl.DateTimeFormat is one of the most expensive calls in the JS
// engine (hundreds of µs each). partsInZone is THE hot primitive — every org-zone
// date resolution flows through it, so a Schedule/Dashboard that touches thousands
// of job occurrences was building tens of thousands of identical formatters and
// jamming the main thread (the "Page Unresponsive" freeze on mobile). The zone set
// is tiny (usually just the org zone), so cache one formatter per zone forever.
// A zone that Intl rejects is never cached — partsInZone's catch falls back to
// device-local, exactly as before, just without ever memoizing the bad zone.
const _dtfByZone = new Map();
function dtfForZone(tz) {
  let dtf = _dtfByZone.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    _dtfByZone.set(tz, dtf);
  }
  return dtf;
}

// Normalize a caller-supplied zone. A default parameter (`tz = ORG_TZ`) only fires
// on `undefined`, so an explicit `null` or `''` slipped past every one of them and
// fell through to the DEVICE/PROCESS zone — which on the Vercel cron is UTC. The
// blob's `company.timezone` is exactly that shape when unset, and reminderScheduler
// passes it straight through, so a customer-facing "your clean is at {time}" could
// render 7 hours off. Falsy now means "the org zone", identical to omitting it.
const zoneOr = (tz) => tz || ORG_TZ;

// Wall-clock fields of an instant as seen in `tz`. The primitive everything else is
// built on. Invalid/blank tz degrades to device-local fields rather than throwing.
function partsInZone(date, rawTz) {
  const tz = zoneOr(rawTz);
  if (tz) {
    try {
      const dtf = dtfForZone(tz);
      const o = {};
      for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
      if (o.hour === 24) o.hour = 0; // some ICU builds render midnight as 24 under h23
      return o;
    } catch { /* unknown zone → device-local */ }
  }
  return {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(),
  };
}

// The zone's UTC offset (ms) at a given instant: read the instant's wall clock in
// `tz`, then re-read those same fields as if they were UTC — the difference IS the
// offset. Evaluated per-instant, so DST is handled without a zone database.
function offsetMsAt(date, tz) {
  const p = partsInZone(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, date.getUTCMilliseconds());
  return asUtc - date.getTime();
}

// The instant at which `tz`'s wall clock reads the given fields — the inverse of
// partsInZone. Two passes: the offset at the GUESSED instant can differ from the
// offset at the true one across a DST boundary, so re-resolve once against the
// first answer. (During a spring-forward gap or a fall-back repeat the wall clock
// is genuinely ambiguous; this settles on one deterministically.)
function zonedFieldsToInstant(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  let ts = guess - offsetMsAt(new Date(guess), tz);
  ts = guess - offsetMsAt(new Date(ts), tz);
  return new Date(ts);
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Calendar days are STRINGS ('YYYY-MM-DD'), not Dates.
//
// A Date pinned to local midnight is not a calendar day — it's an instant that
// merely looks like one on the device that made it, and it shifts the moment it
// crosses a zone. Day keys are labels: exact, comparable with ===, zone-proof.
// ---------------------------------------------------------------------------

// The calendar day an instant falls on, in the org's timezone.
// dayKey RESULTS are cached, not just the formatter: formatToParts costs ~1-15µs
// per call and the Schedule paths ask "which day is this instant" for the same
// ISO strings and cell dates over and over across renders (a measured ~500k
// calls per toggle pre-bucketing — the 4s freeze). Keyed by (zone, input) so
// setOrgTimezone naturally misses to fresh entries; bounded by wholesale clear —
// the map only holds short strings, and one cold pass beats LRU bookkeeping.
const _dayKeyCache = new Map();
const DAY_KEY_CACHE_MAX = 50000;
export function dayKey(value = new Date(), tz = ORG_TZ) {
  const z = zoneOr(tz);
  const raw = typeof value === 'string' ? value : (value instanceof Date ? value.getTime() : value);
  const ck = `${z}|${raw}`;
  const hit = _dayKeyCache.get(ck);
  if (hit !== undefined) return hit;
  const d = value instanceof Date ? value : new Date(value);
  const p = partsInZone(d, z);
  const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (_dayKeyCache.size >= DAY_KEY_CACHE_MAX) _dayKeyCache.clear();
  _dayKeyCache.set(ck, key);
  return key;
}

// Today, in the org's timezone. THIS is what a date <input> wants. Never
// `todayIso().slice(0, 10)` — see the header; that is the off-by-one itself.
export function todayKey(tz = ORG_TZ) { return dayKey(new Date(), tz); }

// The hour (0-23) an instant falls on in the org's timezone. Exists so server code
// can ask "is it a reasonable hour for the CUSTOMER right now?" without reaching for
// the process clock — Vercel crons run TZ=UTC, so `new Date().getHours()` on the
// server is 7-8 hours off the business it is emailing on behalf of.
export function hourInZone(value = new Date(), tz = ORG_TZ) {
  const d = value instanceof Date ? value : new Date(value);
  return partsInZone(d, tz).hour;
}

// Minutes since midnight (0…1439) in the org's timezone. Same reason as hourInZone, one
// resolution finer: office hours are a wall-clock RANGE the office types ("08:00–17:00",
// WO-17), so an hour-only read could not express 8:30 and would round a boundary the wrong
// way. Built on the same cached partsInZone, so it costs no extra formatter.
export function minutesInZone(value = new Date(), tz = ORG_TZ) {
  const d = value instanceof Date ? value : new Date(value);
  const p = partsInZone(d, tz);
  return p.hour * 60 + p.minute;
}

// Day-key arithmetic. UTC is used purely as a calendar here — these are labels,
// not instants, so no zone (device or org) can perturb the result.
export function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function dayOfWeekKey(key) { // 0 = Sun
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Whole-day delta between two day-keys (toKey − fromKey). Labels, not instants, so
// no zone can perturb it — the inverse of addDaysKey. Used to turn a reschedule /
// drag from one calendar day to another into a `dayShift` for a whole series.
export function diffDaysKey(fromKey, toKey) {
  const [y1, m1, d1] = fromKey.split('-').map(Number);
  const [y2, m2, d2] = toKey.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function startOfWeekKey(key) { // Monday-start
  const dow = dayOfWeekKey(key);
  return addDaysKey(key, (dow === 0 ? -6 : 1) - dow);
}

export function startOfMonthKey(key) { return `${key.slice(0, 8)}01`; }
export function monthOfKey(key) { return Number(key.slice(5, 7)); }
export function startOfYearKey(key) { return `${key.slice(0, 4)}-01-01`; }

// First day of the calendar quarter containing `key` (Jan/Apr/Jul/Oct).
export function startOfQuarterKey(key) {
  const m = monthOfKey(key);
  const qStart = m - ((m - 1) % 3); // 1,4,7,10
  return `${key.slice(0, 4)}-${pad(qStart)}-01`;
}
export function dayOfMonthKey(key) { return Number(key.slice(8, 10)); }

// Whole-month steps, clamped into the target month. Date's setMonth() OVERFLOWS
// instead of clamping — Jan 31 + 1 month lands in March — so month stepping has to
// resolve the target month first and clamp the day into it. `n` may be negative
// (e.g. "last calendar month"), so the modulo is normalized to stay in 0–11.
export function addMonthsKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ty = Math.floor(total / 12);
  const tm = (((total % 12) + 12) % 12) + 1; // 1–12, safe for negative n
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${pad(tm)}-${pad(Math.min(d, lastDay))}`;
}

// Day-of-week of an INSTANT, in the org's timezone. Recurrence crew lookups key off
// this: read device-local instead and a Manila-booked Friday series resolves to
// Thursday in Seattle, missing dayOverrides[dow] and silently flipping crews.
export function dayOfWeekIso(iso, tz = ORG_TZ) { return dayOfWeekKey(dayKey(iso, tz)); }

// The instant a calendar day begins in the org's timezone.
export function startOfDayKey(key, tz = ORG_TZ) {
  const [y, m, d] = key.split('-').map(Number);
  return zonedFieldsToInstant(y, m, d, 0, 0, tz);
}

// ---------------------------------------------------------------------------

export function todayIso(tz = ORG_TZ) { return startOfDayKey(todayKey(tz), tz).toISOString(); }

export function startOfDay(value = new Date(), tz = ORG_TZ) {
  return startOfDayKey(dayKey(value, tz), tz);
}

export function startOfWeek(date = new Date(), tz = ORG_TZ) {
  return startOfDayKey(startOfWeekKey(dayKey(date, tz)), tz);
}

export function startOfMonth(date = new Date(), tz = ORG_TZ) {
  return startOfDayKey(startOfMonthKey(dayKey(date, tz)), tz);
}

// Calendar-day arithmetic on an instant, anchored in the org's zone — so crossing a
// DST boundary still lands on the same wall-clock time, not an hour either side.
export function addDays(date, n, tz = ORG_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  const p = partsInZone(d, tz);
  const key = addDaysKey(`${p.year}-${pad(p.month)}-${pad(p.day)}`, n);
  const [y, m, dd] = key.split('-').map(Number);
  return zonedFieldsToInstant(y, m, dd, p.hour, p.minute, tz);
}

export function sameDay(a, b, tz = ORG_TZ) {
  return dayKey(a, tz) === dayKey(b, tz);
}

// 🔴 A BARE DAY KEY IS NOT AN INSTANT (CS-145). `new Date('2026-03-04')` is UTC
// midnight by spec, so rendering it in a NEGATIVE-offset org zone (America/New_York, the
// default) prints March 3 — the day BEFORE the one that was stored. Payment dates were
// written both ways (InvoiceDetail stored a day key, LogPaymentModal an ISO instant), so
// the same payment read as two different days depending on which screen wrote it.
//
// Both write points now store org-zone ISO, but a day key stays readable FOREVER — the
// live blob holds rows written the old way, and `<input type="date">` hands one back on
// every edit — so the formatters anchor a bare key at the org's NOON before formatting.
// Noon is chosen because it is inside the same calendar day for every real UTC offset.
// Fixed here, at the one render boundary, rather than at each of the ~40 call sites.
export function dayKeyToInstant(value, tz = ORG_TZ) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return zonedFieldsToInstant(y, m, d, 12, 0, zoneOr(tz));
  }
  return new Date(value);
}

// ── ONE FORMATTER PER (locale, options, zone) (CS-674, CS-721) ─────────────────
// `toLocaleDateString(locale, options)` / `toLocaleTimeString` build a NEW Intl.DateTimeFormat
// on EVERY call — the same ~100 µs construction `dtfForZone` above caches for partsInZone. The
// formatters below called them once per value, so a screen formatting every visit paid it per
// visit: at Matt's size (49,883 visits) the first letter typed in global search spent 7.4 of
// its 8.4 s here, and the Schedule's Cleaner view about 1.6 of its ~2.8 s (S128, F11-04/05).
// They now keep one formatter per (kind, locale, options, zone) and say EXACTLY what the
// per-call path said (`test-dates-formatter-cache.mjs` compares them byte for byte against the
// engine's own toLocale*String):
//   • a DATE string fills year/month/day ('numeric') when the options name no date field and no
//     style — the engine's own default for toLocaleDateString (ECMA-402 CreateDateTimeFormat,
//     required "date", defaults "date"); the copy, never the caller's object, takes them;
//   • a date string refuses `timeStyle` — that rare call keeps the engine's per-call path, so it
//     throws the same TypeError;
//   • an invalid instant reads "Invalid Date" BEFORE any option is looked at (toLocale*String
//     check the time value first; format() would throw instead);
//   • an unknown zone throws the engine's RangeError on construction and is never cached.
// Bounded by a wholesale clear: the set is a handful of call-site option shapes × the display
// locales × the org zone, so the cap only guards against a caller minting options per value.
const _fmtCache = new Map();
const FMT_CACHE_MAX = 400;
const DATE_FIELDS = ['weekday', 'year', 'month', 'day'];
const localeKey = (locale) => (locale === undefined || typeof locale === 'string' ? String(locale) : JSON.stringify(locale));
function cachedFormatter(kind, locale, options) {
  const key = `${kind}|${localeKey(locale)}|${JSON.stringify(options)}`;
  let f = _fmtCache.get(key);
  if (!f) {
    // Intl gets the base locale, never the private-use tag (i18n/languages intlLocale); the tag
    // only chooses the Creole names.
    f = new Intl.DateTimeFormat(intlLocale(locale), options);
    if (CREOLE_TAG.test(String(locale ?? ''))) f = creoleFormatter(f);
    if (_fmtCache.size >= FMT_CACHE_MAX) _fmtCache.clear();
    _fmtCache.set(key, f);
  }
  return f;
}

// ── HAITIAN CREOLE NAMES (CS-851) ─────────────────────────────────────────────────────────
// No phone, browser or Node carries Creole date data, so the Creole locale is `en-US-x-ht`
// (i18n/languages.js): Intl formats its base locale, US English (never the tag itself: runtimes
// disagree on a private-use tag — see languages.js), and here the month and weekday names become
// Creole (CALENDAR_NAMES) and a date with a month name is put in Creole order — weekday, day,
// month, year, then any time: "madi 13 oktòb 2026, 9:30 PM". A date written in numbers only
// ("10/13/2026") keeps its numbers; a weekday on its own is just renamed ("madi").
const CREOLE_TAG = /-x-ht$/i;
let _enNames = null;
function englishNames() {
  if (_enNames) return _enNames;
  const month = new Map();
  const weekday = new Map();
  for (const style of ['short', 'long']) {
    const m = new Intl.DateTimeFormat('en-US', { month: style, timeZone: 'UTC' });
    for (let i = 0; i < 12; i += 1) month.set(m.format(new Date(Date.UTC(2026, i, 15))), i);
    const w = new Intl.DateTimeFormat('en-US', { weekday: style, timeZone: 'UTC' });
    for (let i = 0; i < 7; i += 1) weekday.set(w.format(new Date(Date.UTC(2026, 9, 11 + i))), i);   // 2026-10-11 is a Sunday
  }
  _enNames = { month, weekday };
  return _enNames;
}
// 🔴 THE ENGINE'S OWN format() IS THE REFERENCE FOR SPACING, NEVER formatToParts(): Node 24's V8
// (ICU 78.3) puts a narrow no-break space (U+202F) before AM/PM in formatToParts() while its
// format() and toLocale*String() write a plain space (measured: main's CI, 2026-10-15; Node 26
// writes a plain space in all three). So a date with nothing to rename IS format(), a weekday is
// renamed inside format()'s own text, and a rebuilt Creole date takes its time's spaces from it.
const NNBSP = /\u202f/g;
function creoleFormatter(base) {
  const names = CALENDAR_NAMES.ht;
  return {
    format(date) {
      const whole = base.format(date);
      const parts = base.formatToParts(date);
      const en = englishNames();
      const out = { weekday: null, day: null, month: null, year: null };
      let named = false;
      let weekdayEn = null;
      for (const p of parts) {
        if (p.type === 'month' && en.month.has(p.value)) { out.month = names.months[en.month.get(p.value)]; named = true; } else if (p.type === 'weekday') {
          weekdayEn = p.value;
          out.weekday = en.weekday.has(p.value) ? names.weekdays[en.weekday.get(p.value)] : p.value;
        } else if (p.type === 'day' || p.type === 'year') out[p.type] = p.value;
      }
      if (!named) return weekdayEn && out.weekday ? whole.replace(weekdayEn, out.weekday) : whole;
      const day = [out.weekday, out.day, out.month, out.year].filter(Boolean).join(' ');
      const at = parts.findIndex((p) => p.type === 'hour');
      let time = at >= 0 ? parts.slice(at).map((p) => p.value).join('').trim() : '';
      if (time && !whole.includes('\u202f')) time = time.replace(NNBSP, ' ');
      return time ? `${day}, ${time}` : day;
    },
    formatToParts: (date) => base.formatToParts(date),
    resolvedOptions: () => base.resolvedOptions(),
  };
}
const INVALID_DATE = 'Invalid Date';
function formatDatePart(date, locale, opts, timeZone) {
  if (Number.isNaN(date.getTime())) return INVALID_DATE;
  const o = { ...opts, timeZone };
  if (o.timeStyle !== undefined) return date.toLocaleDateString(intlLocale(locale), o); // the engine's refusal, verbatim
  if (o.dateStyle === undefined && DATE_FIELDS.every((k) => o[k] === undefined)) {
    o.year = 'numeric'; o.month = 'numeric'; o.day = 'numeric';
  }
  return cachedFormatter('date', locale, o).format(date);
}

// The three customer-facing formatters. Each used `tz ? {...timeZone} : opts`, so a
// null/'' zone DROPPED timeZone entirely and formatted in the process zone — UTC on
// the cron. See zoneOr: falsy now resolves to the org zone.
// `locale` defaults to the ambient display locale (setUiLocale above); an explicit one is for
// rendering in someone else's language.
export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }, tz = ORG_TZ, locale = UI_LOCALE) {
  if (!iso) return '';
  return formatDatePart(dayKeyToInstant(iso, tz), locale, opts, zoneOr(tz));
}

const LONG_DATE = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
export function fmtDateLong(iso, tz = ORG_TZ, locale = UI_LOCALE) {
  if (!iso) return '';
  return formatDatePart(dayKeyToInstant(iso, tz), locale, LONG_DATE, zoneOr(tz));
}

export function fmtTime(iso, tz = ORG_TZ, locale = UI_LOCALE) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return INVALID_DATE;
  return cachedFormatter('time', locale, { hour: 'numeric', minute: '2-digit', timeZone: zoneOr(tz) }).format(d);
}

// A date and a time together, e.g. "Oct 3, 2026, 9:30 PM" (Creole: "3 oktòb 2026, 9:30 PM") — what
// a catalog line's `{x, dateTime}` shows (src/i18n/core.js).
export function fmtDateTime(iso, tz = ORG_TZ, locale = UI_LOCALE) {
  if (iso == null || iso === '') return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return cachedFormatter('dateTime', locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: zoneOr(tz) }).format(d);
}

export function fmtTimeRange(startIso, endIso, locale = UI_LOCALE) {
  return `${fmtTime(startIso, ORG_TZ, locale)} – ${fmtTime(endIso, ORG_TZ, locale)}`;
}

// Build ISO from a date (YYYY-MM-DD) + time (HH:MM) pair for form inputs.
// The pair is the ORG's wall clock: "Jul 17, 9:00 AM" means 9 AM at the site, so it
// resolves to the same instant no matter where the person filling the form sits.
// (`new Date('2026-07-17T09:00')` — no Z, no offset — parses in the BROWSER's zone,
// which is what made the same form produce different instants for Marcus and the VA.)
export function composeIso(dateStr, timeStr, tz = ORG_TZ) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  return zonedFieldsToInstant(y, m, d, h || 0, mi || 0, tz).toISOString();
}

// Normalize a human-typed time into the app's internal "HH:MM" 24-hour form, or
// null when it can't be read as a time at all. A native <input type="time">
// only ever yields "" or valid "HH:MM" — this exists for browsers WITHOUT
// type=time support, where the field degrades to free text and a scheduler can
// type military ("1800", "800"), 12-hour ("6:00 PM", "6pm"), or garbage.
// composeIso above deliberately never throws — it swallows NaN and lets hour
// overflow roll the date — so an unnormalized string composes to a VALID ISO at
// the WRONG instant ("1800" → hour 1800 → +75 days). Callers normalize on blur
// and hard-reject anything non-normalizable at validate time, so a wrong
// instant can never reach composeIso from a time field.
export function normalizeHm(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const pad2 = (n) => String(n).padStart(2, '0');
  // 12-hour: "6pm", "6 pm", "6:30pm", "12:05 am"
  let m = s.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return `${pad2(h)}:${pad2(mi)}`;
  }
  // Colon form: "8:30", "18:00", "08:00"
  m = s.match(/^(\d{1,2}):([0-5]\d)$/);
  if (m) {
    const h = Number(m[1]);
    if (h > 23) return null;
    return `${pad2(h)}:${m[2]}`;
  }
  // Military digits: "800" → 08:00, "1800" → 18:00
  m = s.match(/^(\d{3,4})$/);
  if (m) {
    const digits = m[1].padStart(4, '0');
    const h = Number(digits.slice(0, 2));
    const mi = Number(digits.slice(2));
    if (h > 23 || mi > 59) return null;
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  }
  return null;
}

// True when `t` is already the internal "HH:MM" 24-hour form — the ONLY shape
// composeIso may be handed from a time field (see normalizeHm).
export function isStrictHm(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

// The END instant of a shift that starts on `dateStr` at `startTime` and ends
// at `endTime` — ROLLING TO THE NEXT DAY when the end wall-clock is at or
// before the start (a 10 PM–2 AM overnight clean). Every composition site that
// pairs a start and end time MUST use this: composing both onto the same day
// stored `endAt < startAt`, which silently inverted conflict detection and
// zeroed duration math while rendering "10:00 PM – 2:00 AM" correctly
// (2026-07-30 findings — most of Clean Space's cleans are overnight).
export function composeEndIso(dateStr, startTime, endTime, tz = ORG_TZ) {
  if (!dateStr) return null;
  const start = composeIso(dateStr, startTime, tz);
  const sameDayEnd = composeIso(dateStr, endTime, tz);
  return sameDayEnd > start ? sameDayEnd : composeIso(addDaysKey(dateStr, 1), endTime, tz);
}

// Split ISO into date/time strings for form inputs — the exact inverse of
// composeIso, so an edit round-trip is lossless. Reading these fields device-local
// meant opening a Manila-booked job in Seattle and pressing Save rewrote it a day
// earlier: splitIso handed the form the wrong day, composeIso stored it back.
export function splitIso(iso, tz = ORG_TZ) {
  if (!iso) return { date: '', time: '' };
  // dayKeyToInstant, not `new Date(iso)`: a BARE day key is UTC midnight by spec, so
  // reading one back in a negative-offset org zone returned the day BEFORE — and since
  // the editors compose the value straight back with composeIso, opening and saving a
  // legacy day-key row rewrote it one day earlier (CS-145, the same round-trip this
  // function's own header describes for jobs).
  const p = partsInZone(dayKeyToInstant(iso, tz), tz);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

// Whole minutes from an instant to `now`: never negative; null when the instant cannot be read.
// An age or a wait (how long a customer's message has waited for a reply — lib/hubMessages), not a
// calendar figure, so no zone is involved.
export function minutesSince(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : null;
}

// Minutes -> "4h 12m" / "45m" / "—". Labor + expected-time display.
export function fmtDuration(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return '—';
  const sign = mins < 0 ? '−' : '';
  const m = Math.abs(Math.round(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${sign}${h}h ${r}m`;
  if (h) return `${sign}${h}h`;
  return `${sign}${r}m`;
}

// Signed variance delta: "+18m" / "−1h 2m" / "0m" / "—".
export function fmtDelta(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return '—';
  const r = Math.round(mins);
  if (r === 0) return '0m';
  return `${r > 0 ? '+' : '−'}${fmtDuration(Math.abs(r))}`;
}

// 🔴 CENTS ARE NOT OPTIONAL. This carried `maximumFractionDigits: 0`, which silently
// rounds to whole dollars — money(1250.75) → "$1,251", money(0.20) → "$0".
//
// That is not a display preference, it is wrong numbers in front of people making
// decisions with them:
//   · InvoiceDetail composes the customer-facing past-due message as
//     "Invoice X — amount due {money(balance)}", so a client with a $1,250.75 balance
//     received a written demand for $1,251.
//   · The invoice line-item table disagrees with ITS OWN FOOTER: rows render via
//     moneyPrecise ($1,250.75) and the Total directly beneath via money ($1,251).
//   · The payment-amount field uses money(balance) as its PLACEHOLDER, so a clerk is
//     prompted with $1,251 for a $1,250.75 balance. Accepting it makes the balance
//     −0.25, which deriveInvoiceStatus reads as paid and clientBalance then nets
//     against the account's OTHER open invoices — a display bug seeding a real ledger
//     error.
//   · A residual balance under 50c renders as "$0" while the invoice stays Overdue
//     forever, because the status is balance-derived and the balance is not actually 0.
//
// money.js itself was always correct: round2 preserves cents through every total,
// balance and aging computation. The loss happened only at this render boundary, which
// is why nothing in the stored ledger is wrong — but everything a human READS was.
//
// Now identical to moneyPrecise. Kept as a separate export because ~40 call sites use
// it and the two names document intent ("a money figure" vs "a figure that must show
// cents"); if a compact whole-dollar form is ever wanted for the Dashboard stat cards,
// add moneyCompact() and use it THERE ONLY — never on a total, a balance, or any string
// that reaches a customer. No project doc sanctioned whole-dollar display (checked
// UI_RULES.md and STYLING.md).
export function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function moneyPrecise(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
