// CS-674 / CS-721 — the date and time formatters reuse ONE Intl.DateTimeFormat per
// (locale, options, zone) and say exactly what they said before, byte for byte.
//
// `Date.prototype.toLocaleDateString(locale, options)` (and toLocaleTimeString) builds a NEW
// Intl.DateTimeFormat on every call, and building one is among the most expensive calls the
// engine has (~100 µs). lib/dates `fmtDate` / `fmtTime` / `fmtTimeRange` / `fmtDateLong` called
// them per value, so a screen that formats every visit paid it per visit: at Matt's size
// (49,883 visits) the first letter typed in global search spent 7.4 of its 8.4 s here, and the
// Schedule's Cleaner view about 1.6 of its ~2.8 s (S128 full-app pass, F11-04 / F11-05).
//
// Two halves:
//   1. THE CACHE: across thousands of calls the formatters never go through the per-call
//      toLocale*String path (spied), and build at most one formatter per distinct
//      (locale, options, zone) (spied on the Intl.DateTimeFormat constructor).
//   2. SAME WORDS: every output equals the platform's own toLocale*String with the options the
//      formatters always passed — the reference is the engine, not a restated literal — across
//      DST edges, midnights, bare day keys, falsy and foreign zones, the app's display locales,
//      every option shape the app passes, the defaults a date-only call fills in, the ambient
//      locale/zone switching under it, and the errors (an invalid zone, a time-only style).
//
// Offline. Run: node scripts/test-dates-formatter-cache.mjs
import { LANGUAGE_INFO } from '../src/i18n/languages.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const eq = (label, got, want) => ok(`${label}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`, got === want);

// ── spies, installed BEFORE lib/dates loads ─────────────────────────────────────
const REAL_DATE_STRING = Date.prototype.toLocaleDateString;
const REAL_TIME_STRING = Date.prototype.toLocaleTimeString;
const RealDTF = Intl.DateTimeFormat;
let perCall = 0;
let built = 0;
Date.prototype.toLocaleDateString = function spyDate(...a) { perCall += 1; return REAL_DATE_STRING.apply(this, a); };
Date.prototype.toLocaleTimeString = function spyTime(...a) { perCall += 1; return REAL_TIME_STRING.apply(this, a); };
Intl.DateTimeFormat = new Proxy(RealDTF, {
  construct(target, args) { built += 1; return new target(...args); },
  apply(target, thisArg, args) { built += 1; return target(...args); },
});

const {
  fmtDate, fmtTime, fmtTimeRange, fmtDateLong, dayKeyToInstant,
  setOrgTimezone, getOrgTimezone, setUiLocale, DEFAULT_ORG_TIMEZONE,
} = await import('../src/lib/dates.js');

// The reference: exactly what the formatters computed before the cache, through the engine.
const zoneOf = (tz) => tz || getOrgTimezone();
const refDate = (iso, opts, tz, locale) => (iso ? REAL_DATE_STRING.call(dayKeyToInstant(iso, tz), locale, { ...opts, timeZone: zoneOf(tz) }) : '');
const refLong = (iso, tz, locale) => (iso ? REAL_DATE_STRING.call(dayKeyToInstant(iso, tz), locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: zoneOf(tz) }) : '');
const refTime = (iso, tz, locale) => (iso ? REAL_TIME_STRING.call(new Date(iso), locale, { hour: 'numeric', minute: '2-digit', timeZone: zoneOf(tz) }) : '');
const attempt = (fn) => { try { return { v: fn() }; } catch (e) { return { err: e?.constructor?.name || 'Error' }; } };

// ── 1. THE CACHE ─────────────────────────────────────────────────────────────────
setOrgTimezone(DEFAULT_ORG_TIMEZONE);
setUiLocale(undefined);
{
  const N = 3000;
  const base = Date.parse('2026-10-12T22:00:00.000Z');
  perCall = 0;
  built = 0;
  for (let i = 0; i < N; i++) {
    const iso = new Date(base + i * 3600000).toISOString();
    fmtDate(iso, { weekday: 'short', month: 'short', day: 'numeric' });
    fmtDate(iso, { month: 'short', day: 'numeric' });
    fmtTime(iso);
    fmtTimeRange(iso, iso);
    fmtDateLong(iso);
  }
  eq(`${N * 6} formats never take the per-call toLocale*String path`, perCall, 0);
  ok(`${N * 6} formats build a handful of formatters, not one per call (built ${built})`, built <= 8);
  const before = built;
  for (let i = 0; i < 200; i++) fmtDate('2026-10-14T22:00:00.000Z', { month: 'short', day: 'numeric' });
  eq('a repeat of a known (locale, options, zone) builds nothing', built, before);
}

// ── 2. SAME WORDS ────────────────────────────────────────────────────────────────
// Haitian Creole (`en-US-x-ht`, CS-851) differs from the engine ON PURPOSE wherever a month or a
// weekday is named — no engine carries Creole names, so lib/dates writes them (held by
// test-i18n-creole-dates.mjs). It is held to the engine's US English below wherever nothing is named.
const isCreole = (l) => /-x-ht$/.test(String(l || ''));
const CREOLE = Object.values(LANGUAGE_INFO).map((l) => l.dateLocale).find(isCreole);
const LOCALES = [undefined, 'en-US', ...new Set(Object.values(LANGUAGE_INFO).map((l) => l.dateLocale).filter((l) => l && !isCreole(l))), 'es', 'fr-FR'];
const ZONES = [DEFAULT_ORG_TIMEZONE, 'America/Los_Angeles', 'Asia/Manila', 'UTC', 'Pacific/Kiritimati', null, ''];
const VALUES = [
  '2026-10-12T22:00:00.000Z', '2026-10-13T03:59:59.000Z', '2026-10-13T04:00:00.000Z',
  '2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z', // the spring-forward hour (New York)
  '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z', // the repeated hour, both sides
  '2026-12-31T23:30:00.000Z', '2027-01-01T00:30:00+00:00',
  '2026-03-04', '2026-11-01', // bare day keys (CS-145: anchored at the org's noon)
  Date.parse('2026-07-17T16:00:00.000Z'), new Date('2026-07-17T16:00:00.000Z'),
  'not a date', // → "Invalid Date", as the engine says it
];
// Every option shape the app passes (the literal shapes at the call sites), plus the edges the
// engine's date-only defaults decide: no date field at all, time fields only, a style, eras.
const OPTIONS = [
  undefined,
  { month: 'short', day: 'numeric', year: 'numeric' },
  { month: 'short', day: 'numeric' },
  { weekday: 'short', month: 'short', day: 'numeric' },
  { year: 'numeric', month: 'numeric', day: 'numeric' },
  { weekday: 'long', month: 'long', day: 'numeric' },
  { month: 'numeric', day: 'numeric', year: 'numeric' },
  { month: 'long', year: 'numeric' },
  { month: 'long', day: 'numeric', year: 'numeric' },
  { day: 'numeric' },
  { weekday: 'short' },
  {},
  null,
  { hour: 'numeric', minute: '2-digit' },
  { timeZoneName: 'short' },
  { era: 'short' },
  { month: undefined, hour12: false },
  { dateStyle: 'medium' },
  { dateStyle: 'full' },
  { timeStyle: 'short' }, // the engine refuses this for a date string: both must throw alike
];

let compared = 0;
for (const locale of LOCALES) {
  for (const tz of ZONES) {
    for (const v of VALUES) {
      for (const opts of OPTIONS) {
        const got = attempt(() => (opts === undefined ? fmtDate(v, undefined, tz, locale) : fmtDate(v, opts, tz, locale)));
        const want = attempt(() => refDate(v, opts === undefined ? { month: 'short', day: 'numeric' } : opts, tz, locale));
        compared += 1;
        eq(`fmtDate(${JSON.stringify(v)}, ${JSON.stringify(opts)}, ${JSON.stringify(tz)}, ${JSON.stringify(locale)})`, JSON.stringify(got), JSON.stringify(want));
      }
      if (typeof v === 'string') {
        eq(`fmtTime(${v}, ${tz}, ${locale})`, JSON.stringify(attempt(() => fmtTime(v, tz, locale))), JSON.stringify(attempt(() => refTime(v, tz, locale))));
        eq(`fmtDateLong(${v}, ${tz}, ${locale})`, JSON.stringify(attempt(() => fmtDateLong(v, tz, locale))), JSON.stringify(attempt(() => refLong(v, tz, locale))));
        compared += 2;
      }
    }
  }
}
ok(`compared ${compared} outputs`, compared > 5000);

// Creole where nothing is named: exactly the engine's US English (numbers-only dates, times).
if (CREOLE) {
  const NAMELESS = [{ year: 'numeric', month: 'numeric', day: 'numeric' }, { month: 'numeric', day: 'numeric', year: 'numeric' }, { day: 'numeric' },
    { hour: 'numeric', minute: '2-digit' }, { timeZoneName: 'short' }, {}, null];
  let creole = 0;
  for (const tz of ZONES) {
    for (const v of VALUES) {
      for (const opts of NAMELESS) {
        eq(`Creole, nothing named: fmtDate(${JSON.stringify(v)}, ${JSON.stringify(opts)}, ${JSON.stringify(tz)})`,
          JSON.stringify(attempt(() => fmtDate(v, opts, tz, CREOLE))), JSON.stringify(attempt(() => refDate(v, opts, tz, 'en-US'))));
        creole += 1;
      }
      if (typeof v === 'string') {
        eq(`Creole time: fmtTime(${v}, ${tz})`, JSON.stringify(attempt(() => fmtTime(v, tz, CREOLE))), JSON.stringify(attempt(() => refTime(v, tz, 'en-US'))));
        creole += 1;
      }
    }
  }
  ok(`compared ${creole} Creole outputs where nothing is named`, creole > 500);
}

// Blank in, blank out — no formatter consulted.
eq('fmtDate of nothing', fmtDate(''), '');
eq('fmtDate of null', fmtDate(null), '');
eq('fmtTime of nothing', fmtTime(undefined), '');
eq('fmtDateLong of nothing', fmtDateLong(''), '');

// The AMBIENT locale and zone (setUiLocale / setOrgTimezone) move under a warm cache.
{
  const iso = '2026-10-13T02:30:00.000Z'; // the 12th in New York, the 13th in Manila
  setOrgTimezone('America/New_York'); setUiLocale(undefined);
  const enNy = fmtDate(iso);
  eq('ambient: default locale, New York', enNy, refDate(iso, { month: 'short', day: 'numeric' }, null, undefined));
  setOrgTimezone('Asia/Manila');
  eq('ambient: the org zone moved → Manila\'s day', fmtDate(iso), refDate(iso, { month: 'short', day: 'numeric' }, null, undefined));
  ok('ambient: Manila is a different day than New York here', fmtDate(iso) !== enNy);
  setUiLocale('es-US');
  eq('ambient: Spanish date', fmtDate(iso), refDate(iso, { month: 'short', day: 'numeric' }, null, 'es-US'));
  eq('ambient: Spanish time', fmtTime(iso), refTime(iso, null, 'es-US'));
  eq('ambient: Spanish range', fmtTimeRange(iso, '2026-10-13T04:00:00.000Z'), `${refTime(iso, null, 'es-US')} – ${refTime('2026-10-13T04:00:00.000Z', null, 'es-US')}`);
  setUiLocale(undefined); setOrgTimezone('America/New_York');
  eq('ambient: back to the default locale and New York', fmtDate(iso), enNy);
}

// An unknown zone throws exactly as the engine does — and is never cached as if it worked.
{
  const a = attempt(() => fmtDate('2026-10-12T22:00:00.000Z', { month: 'short' }, 'Not/AZone'));
  const b = attempt(() => REAL_DATE_STRING.call(new Date('2026-10-12T22:00:00.000Z'), undefined, { month: 'short', timeZone: 'Not/AZone' }));
  eq('an unknown zone throws the engine\'s error', JSON.stringify(a), JSON.stringify(b));
  eq('…and so does it the second time (nothing cached)', JSON.stringify(attempt(() => fmtDate('2026-10-12T22:00:00.000Z', { month: 'short' }, 'Not/AZone'))), JSON.stringify(b));
  eq('a good zone still formats after the bad one', fmtDate('2026-10-12T22:00:00.000Z', { month: 'short' }, 'UTC'), refDate('2026-10-12T22:00:00.000Z', { month: 'short' }, 'UTC', undefined));
  // The engine reads the time value BEFORE the options: an invalid instant is "Invalid Date"
  // even under a zone it would refuse.
  eq('an invalid instant under an unknown zone', JSON.stringify(attempt(() => fmtDate('nope', { month: 'short' }, 'Not/AZone'))),
    JSON.stringify(attempt(() => REAL_DATE_STRING.call(new Date('nope'), undefined, { month: 'short', timeZone: 'Not/AZone' }))));
  eq('an invalid instant as a time under an unknown zone', JSON.stringify(attempt(() => fmtTime('nope', 'Not/AZone'))),
    JSON.stringify(attempt(() => REAL_TIME_STRING.call(new Date('nope'), undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'Not/AZone' }))));
  eq('a time under an unknown zone throws alike', JSON.stringify(attempt(() => fmtTime('2026-10-12T22:00:00.000Z', 'Not/AZone'))),
    JSON.stringify(attempt(() => REAL_TIME_STRING.call(new Date('2026-10-12T22:00:00.000Z'), undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'Not/AZone' }))));
}

// A caller's options object is never written to (the defaults are filled on a copy).
{
  const opts = Object.freeze({ hour: 'numeric' });
  eq('frozen options survive', fmtDate('2026-10-12T22:00:00.000Z', opts), refDate('2026-10-12T22:00:00.000Z', opts, null, undefined));
}

// Speed, for the record (not asserted: machines differ).
{
  Date.prototype.toLocaleDateString = REAL_DATE_STRING;
  const N = 20000;
  const isoAt = (i) => new Date(Date.parse('2026-10-12T22:00:00.000Z') + i * 60000).toISOString();
  let t = performance.now();
  for (let i = 0; i < N; i++) REAL_DATE_STRING.call(new Date(isoAt(i)), undefined, { month: 'short', day: 'numeric', timeZone: DEFAULT_ORG_TIMEZONE });
  const perCallMs = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < N; i++) fmtDate(isoAt(i));
  const cachedMs = performance.now() - t;
  console.log(`  ${N} dates: per-call formatter ${perCallMs.toFixed(0)} ms · cached ${cachedMs.toFixed(0)} ms`);
}

Date.prototype.toLocaleDateString = REAL_DATE_STRING;
Date.prototype.toLocaleTimeString = REAL_TIME_STRING;
Intl.DateTimeFormat = RealDTF;

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails.slice(0, 25)) console.error(`  FAIL ${f}`);
  if (fails.length > 25) console.error(`  … and ${fails.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log(`\ndates formatter cache: ${pass}/${pass} passed`);
}
