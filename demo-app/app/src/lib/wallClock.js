// The REPEATED HOUR — a wall-clock time the org's zone shows twice (CS-668). Pure and node-safe,
// built only on lib/dates' exported org-zone primitives (composeIso / splitIso), so it inherits
// their zone contract (a falsy `tz` means the org zone).
//
// When the clocks go back (America/New_York: 2 AM EDT → 1 AM EST on the first Sunday of
// November), every wall time from 1:00 to 1:59 happens TWICE, an hour apart. A form that keeps
// a time as `YYYY-MM-DDTHH:MM` cannot say which one, and composeIso settles on one
// deterministically (the FIRST, EDT, in a zone west of UTC — the SECOND in one east of it). So
// the punch-edit form moved a second-1:xx punch an hour on any save, could not save a punch
// that crossed the fold at all, and Add time could not enter the second 1:xx. These helpers let
// the form know which 1 AM a punch is, offer the choice only where the hour really repeats, and
// compose the one chosen; `fmtPunchTime` lets the office SEE it (a history line that read
// "1:15 AM → 1:15 AM" hid an hour of pay).
import { composeIso, splitIso, fmtTime, getOrgTimezone, getUiLocale } from './dates.js';
import { intlLocale } from '../i18n/languages.js';

const MIN = 60000;
// How far a zone sets its clocks back: an hour almost everywhere; half an hour (Lord Howe) and
// two hours are covered too, so no shape of fold can hide a second occurrence.
const SHIFTS_MIN = [30, 60, 120];

// The instants at which `tz`'s wall clock reads `dateKey` + `hm` ('HH:MM'), oldest first: two in a
// repeated hour, one ordinarily, none for a time the zone skips (clocks going forward).
export function wallClockInstants(dateKey, hm, tz) {
  if (!dateKey || !hm) return [];
  const base = composeIso(dateKey, hm, tz);
  const t0 = Date.parse(base ?? '');
  if (!Number.isFinite(t0)) return [];
  const reads = (ms) => { const s = splitIso(new Date(ms).toISOString(), tz); return s.date === dateKey && s.time === hm; };
  const found = new Set();
  if (reads(t0)) found.add(t0);
  for (const m of SHIFTS_MIN) {
    for (const t of [t0 - m * MIN, t0 + m * MIN]) if (reads(t)) found.add(t);
  }
  return [...found].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

// The zone's UTC offset (minutes-precise ms) at an instant, read back through splitIso.
function offsetAt(ms, tz) {
  const { date, time } = splitIso(new Date(ms).toISOString(), tz);
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - Math.floor(ms / MIN) * MIN;
}
const FOLD_REACH_MS = Math.max(...SHIFTS_MIN) * MIN;

// Which occurrence of its wall time an instant is: 'first' / 'second' in a repeated hour, null
// for every ordinary instant. Seconds don't matter (a real clock-in carries them). Asked per
// cell on the office's punch lists, so the common case is two reads: an hour can only repeat
// where the zone's offset changes within reach of the instant.
export function foldOf(iso, tz) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  if (offsetAt(t - FOLD_REACH_MS, tz) === offsetAt(t + FOLD_REACH_MS, tz)) return null;
  const { date, time } = splitIso(iso, tz);
  const list = wallClockInstants(date, time, tz);
  if (list.length < 2) return null;
  return Math.floor(t / MIN) * MIN === Date.parse(list[0]) ? 'first' : 'second';
}

// A wall-clock date + time → the instant, taking the chosen occurrence where the hour repeats
// ('first' unless told otherwise); anything else is composeIso's own answer.
export function composeWallClock(dateKey, hm, { fold = 'first', tz } = {}) {
  const list = wallClockInstants(dateKey, hm, tz);
  if (list.length >= 2) return fold === 'second' ? list[list.length - 1] : list[0];
  return composeIso(dateKey, hm, tz);
}

// A time with its zone's short name ("1:30 AM EDT") — what tells the two 1 AMs apart.
export function fmtTimeWithZone(iso, tz, locale) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(intlLocale(locale ?? getUiLocale()), {
    hour: 'numeric', minute: '2-digit', timeZone: tz || getOrgTimezone(), timeZoneName: 'short',
  });
}

// A punch time for the office: as fmtTime always shows it, plus the zone's name when the wall
// time happened twice — so "1:15 AM EDT → 1:15 AM EST" is an hour, visibly.
export function fmtPunchTime(iso, tz) {
  if (!iso) return '';
  return foldOf(iso, tz) ? fmtTimeWithZone(iso, tz) : fmtTime(iso, tz || undefined);
}
