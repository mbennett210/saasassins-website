// CS-851 — Haitian Creole month and weekday names come from the SYSTEM (nothing owed by anyone):
// no phone, browser or Node carries Creole date data, so the Creole locale is `en-US-x-ht`
// (src/i18n/languages.js) and lib/dates writes the names (CALENDAR_NAMES) in Creole order
// wherever a date is formatted for a Creole reader — the screens (the ambient locale) and the
// alerts the server writes for one (core.js's {x, date} / {x, weekday} / {x, dateTime}).
// Numbers, plurals and times stay US English; Spanish and English are unchanged.
//
// 🔴 Intl is NEVER handed the private-use tag (K16): runtimes disagree on it — Node 24 (ICU 78.3)
// formats `en-US-x-ht` with a narrow no-break space (U+202F) before AM/PM where `en-US` has a plain
// space (U+0020), Node 26 does not — so every Intl call takes `intlLocale(dateLocale)`, the base
// locale, and the tag only chooses the Creole names. A spy installed BEFORE the modules load records
// every locale handed to Intl while Creole dates, times, numbers, plurals and money are formatted.
//
// Offline. Run: node scripts/test-i18n-creole-dates.mjs (CI runs Node 24; check both).
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// ── the spy: every locale any Intl constructor or toLocale*String is handed ─────────────────
const handed = [];
const record = (loc) => { handed.push(Array.isArray(loc) ? loc.join(',') : String(loc)); };
for (const name of ['DateTimeFormat', 'NumberFormat', 'PluralRules']) {
  const Real = Intl[name];
  Intl[name] = new Proxy(Real, {
    construct(target, args, newTarget) { record(args[0]); return Reflect.construct(target, args, newTarget); },
    apply(target, thisArg, args) { record(args[0]); return Reflect.apply(target, thisArg, args); },
  });
}
for (const [proto, methods] of [[Date.prototype, ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']], [Number.prototype, ['toLocaleString']]]) {
  for (const m of methods) {
    const real = proto[m];
    proto[m] = function spied(loc, opts) { record(loc); return real.call(this, loc, opts); };
  }
}

const langs = await import('../src/i18n/languages.js');
const dates = await import('../src/lib/dates.js');
const core = await import('../src/i18n/core.js');
const N = langs.CALENDAR_NAMES?.ht;
const HT = langs.LANGUAGE_INFO.ht.dateLocale;
const TZ = 'America/New_York';
ok('K0: the Creole names exist (src/i18n/languages.js CALENDAR_NAMES.ht)', !!N && Array.isArray(N.months) && Array.isArray(N.weekdays));

// The names, as the system settles them (the brief, 2026-10-15): the one place they are spelled.
ok('K1: the months, January first', JSON.stringify(N?.months) === JSON.stringify(['janvye', 'fevriye', 'mas', 'avril', 'me', 'jen', 'jiyè', 'out', 'septanm', 'oktòb', 'novanm', 'desanm']));
ok('K2: the weekdays, Sunday first', JSON.stringify(N?.weekdays) === JSON.stringify(['dimanch', 'lendi', 'madi', 'mèkredi', 'jedi', 'vandredi', 'samdi']));
ok('K3: a Creole screen formats with the Creole-tagged locale (numbers stay US English)', /^en-US-x-ht$/.test(HT));

if (N) {
  // Noon in New York on the 15th of each month, 2026.
  const noon = (m, d = 15) => new Date(Date.UTC(2026, m, d, 16, 0)).toISOString();
  const months = Array.from({ length: 12 }, (_, m) => dates.fmtDate(noon(m), { month: 'short', day: 'numeric' }, TZ, HT));
  ok('K4: every month has its Creole name, day first ("15 oktòb")', months.every((s, m) => s === `15 ${N.months[m]}`), months.join(' · '));
  const longMonths = Array.from({ length: 12 }, (_, m) => dates.fmtDate(noon(m), { month: 'long', day: 'numeric', year: 'numeric' }, TZ, HT));
  ok('K5: …long or short', longMonths.every((s, m) => s === `15 ${N.months[m]} 2026`), longMonths.join(' · '));
  // 2026-10-11 is a Sunday.
  const days = Array.from({ length: 7 }, (_, i) => dates.fmtDate(noon(9, 11 + i), { weekday: 'long' }, TZ, HT));
  ok('K6: every weekday has its Creole name', days.every((s, i) => s === N.weekdays[i]), days.join(' · '));
  const t = noon(9, 13);   // Tuesday 13 October 2026
  ok('K7: weekday, day and month in Creole order', dates.fmtDate(t, { weekday: 'short', month: 'short', day: 'numeric' }, TZ, HT) === `${N.weekdays[2]} 13 ${N.months[9]}`);
  ok('K8: the long date (fmtDateLong)', dates.fmtDateLong(t, TZ, HT) === `${N.weekdays[2]} 13 ${N.months[9]} 2026`, dates.fmtDateLong(t, TZ, HT));
  ok('K9: a date and a time (fmtDateTime): the time as US English writes it', dates.fmtDateTime(t, TZ, HT) === `13 ${N.months[9]} 2026, ${dates.fmtTime(t, TZ, 'en-US')}`, dates.fmtDateTime(t, TZ, HT));
  ok('K10: a date in numbers keeps its numbers', dates.fmtDate(t, { month: 'numeric', day: 'numeric', year: 'numeric' }, TZ, HT) === dates.fmtDate(t, { month: 'numeric', day: 'numeric', year: 'numeric' }, TZ, 'en-US'));
  ok('K11: times, numbers and plurals read the US way', dates.fmtTime(t, TZ, HT) === dates.fmtTime(t, TZ, 'en-US')
    && new Intl.NumberFormat(HT).format(1234.5) === new Intl.NumberFormat('en-US').format(1234.5)
    && new Intl.PluralRules(HT).select(1) === 'one' && new Intl.PluralRules(HT).select(2) === 'other');
  const late = '2026-10-14T02:30:00Z';   // 10:30 PM on the 13th in New York
  ok('K12: the org\'s zone still decides the day', dates.fmtDate(late, { month: 'short', day: 'numeric' }, TZ, HT) === `13 ${N.months[9]}`);

  // The alerts the server writes for a Creole reader (core.js renders with the reader's locale).
  const ht = (await import('../src/i18n/catalog/ht.js')).default;
  core.registerCatalog('ht', ht);
  const due = core.translate('ht', 'alerts.inspectionDue.body', { date: t }, TZ);
  const when = core.translate('ht', 'alerts.job.when', { when: t }, TZ);
  const englishMonths = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/;
  ok('K13: a Creole alert\'s {date, date} reads the Creole month', due.includes(`13 ${N.months[9]}`) && !englishMonths.test(due), due);
  ok('K14: …and its {when, dateTime} too', when.startsWith(`13 ${N.months[9]} 2026, `) && !englishMonths.test(when), when);
  // Spanish and English are unchanged.
  ok('K15: Spanish and English dates are exactly what Intl writes for them', dates.fmtDate(t, { month: 'short', day: 'numeric' }, TZ, 'es-US') === new Intl.DateTimeFormat('es-US', { month: 'short', day: 'numeric', timeZone: TZ }).format(new Date(t))
    && dates.fmtDateTime(t, TZ, 'en-US') === new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date(t)));
}

// ── K16. Intl never sees the private-use tag ──────────────────────────────────────────────
{
  const wall = await import('../src/lib/wallClock.js');
  const htCat = (await import('../src/i18n/catalog/ht.js')).default;
  core.registerCatalog('ht', { ...htCat, 'k16.number': '{n, number}', 'k16.money': '{m, money}', 'k16.plural': { one: '{count} fwa', other: '{count} fwa' } });
  const t = '2026-10-13T16:00:00Z';
  handed.length = 0;
  // Every Creole path: the ambient screen locale, an explicit one, the catalog's formats.
  dates.setUiLocale(HT);
  dates.fmtDate(t); dates.fmtDate(t, { weekday: 'short' }, TZ); dates.fmtTime(t); dates.fmtDateLong(t); dates.fmtDateTime(t); dates.fmtTimeRange(t, t);
  try { dates.fmtDate(t, { timeStyle: 'short' }, TZ, HT); } catch { /* the engine refuses a time-only style on a date — fine */ }
  wall.fmtTimeWithZone(t, TZ); wall.fmtTimeWithZone(t, TZ, HT);
  dates.setUiLocale(undefined);
  core.translate('ht', 'k16.number', { n: 1234.5 }, TZ); core.translate('ht', 'k16.money', { m: 12.5 }, TZ);
  core.translate('ht', 'k16.plural', { count: 3 }, TZ); core.translate('ht', 'alerts.job.when', { when: t }, TZ);
  core.translate('ht', 'alerts.inspectionDue.body', { date: t }, TZ);
  const tagged = [...new Set(handed.filter((l) => /-x-/i.test(l)))];
  ok('K16: Intl is never handed the private-use tag (dates, times, numbers, plurals, money; the screen\'s locale and an alert\'s)',
    handed.length > 0 && tagged.length === 0, `handed ${tagged.join(', ')}`);
  ok('K17: …and a Creole time is byte for byte the US English one, whatever the runtime', dates.fmtTime(t, TZ, HT) === dates.fmtTime(t, TZ, 'en-US')
    && wall.fmtTimeWithZone(t, TZ, HT) === wall.fmtTimeWithZone(t, TZ, 'en-US'));
  // The callers node cannot load (a React hook, a page, the warning document) take the same rule.
  const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8'); } catch { return ''; } };
  ok('K18: My Hours, Approvals and the warning document hand Intl the base locale (intlLocale)',
    /new Intl\.NumberFormat\(intlLocale\(/.test(read('../src/hooks/useMyHours.js')) && /new Intl\.NumberFormat\(intlLocale\(/.test(read('../src/pages/Approvals.jsx'))
    && /intlLocale\(/.test(read('../src/lib/hrWarningDocument.js')));
}

// ── K19. spacing comes from the engine's format(), never from formatToParts() ───────────────
// Node 24's V8 (ICU 78.3) gives formatToParts() a narrow no-break space (U+202F) before AM/PM where
// its format() writes a plain space. Played out here on any runtime: the parts get U+202F, format()
// keeps what it writes — and Creole must still read exactly as US English's format() does.
{
  const proto = Intl.DateTimeFormat.prototype;
  const realParts = proto.formatToParts;
  proto.formatToParts = function node24(d) {
    return realParts.call(this, d).map((p) => (p.type === 'literal' && p.value === ' ' ? { ...p, value: ' ' } : p));
  };
  try {
    const t = '2026-10-13T16:00:00Z';
    const usTime = dates.fmtTime(t, TZ, 'en-US');
    const creoleTime = dates.fmtTime(t, TZ, HT);
    const creoleWhen = dates.fmtDateTime(t, TZ, HT);
    const creoleDay = dates.fmtDate(t, { weekday: 'short', month: 'numeric', day: 'numeric' }, TZ, HT);
    ok('K19: with parts that carry U+202F (Node 24\'s V8), a Creole time and date-time still read exactly as US English\'s format() writes them',
      creoleTime === usTime && !creoleTime.includes(' ') && creoleWhen.endsWith(`, ${usTime}`) && !creoleWhen.includes(' ')
      && !creoleDay.includes(' ') && creoleDay.startsWith(N.weekdays[2]), JSON.stringify({ creoleTime, usTime, creoleWhen, creoleDay }));
  } finally {
    proto.formatToParts = realParts;
  }
}

console.log(`\ntest-i18n-creole-dates: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
