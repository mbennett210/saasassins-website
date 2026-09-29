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
// does scheduling resolve in when nothing else says otherwise". The live org_state
// blob predates company.timezone (the field was never written), so this is what
// production actually runs on until a Super Admin saves an explicit zone. Keep the
// seed's company.timezone in sync with this.
export const DEFAULT_ORG_TIMEZONE = 'America/Los_Angeles';

let ORG_TZ = DEFAULT_ORG_TIMEZONE;

// Called by StoreProvider from company.timezone. A blank/unknown zone falls back to
// the LA default rather than the device zone: an operator in Manila must still see
// the business's Los-Angeles schedule, not their own. (A client on a different shell
// simply saves their own zone; the default only decides the pre-configuration state.)
export function setOrgTimezone(tz) { ORG_TZ = tz || DEFAULT_ORG_TIMEZONE; }
export function getOrgTimezone() { return ORG_TZ; }

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

// The three customer-facing formatters. Each used `tz ? {...timeZone} : opts`, so a
// null/'' zone DROPPED timeZone entirely and formatted in the process zone — UTC on
// the cron. See zoneOr: falsy now resolves to the org zone.
export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }, tz = ORG_TZ) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { ...opts, timeZone: zoneOr(tz) });
}

export function fmtDateLong(iso, tz = ORG_TZ) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: zoneOr(tz),
  });
}

export function fmtTime(iso, tz = ORG_TZ) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
    timeZone: zoneOr(tz),
  });
}

export function fmtTimeRange(startIso, endIso) {
  return `${fmtTime(startIso)} – ${fmtTime(endIso)}`;
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return fmtDate(iso);
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
  const p = partsInZone(new Date(iso), tz);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
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
