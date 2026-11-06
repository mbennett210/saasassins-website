// CS-193 — the translation layer's RULES (src/i18n/languages.js + core.js), driven for real.
//
//   L. WHICH language a person gets: their saved choice, else their phone's (first of the
//      phone's languages we speak), else English (Matt's LANG-3, LANG-11). The strict check
//      the two write points use refuses anything that is not exactly a choice.
//   F. FALLBACK: a line missing (or blank, or lacking a plural form) in Spanish shows the
//      ENGLISH line, formatted the English way; a key missing everywhere shows nothing,
//      never its own dotted name.
//   P. PLACEHOLDERS: named and typed (`{start, time}` in the org's zone and the reader's
//      locale, `{areas, list}` with the language's own "and", plurals by CLDR); a missing
//      value is empty, never "undefined" or "{start}"; a message inside a message renders in
//      the same language.
//   M. MESSAGES travel: msg() is rendered later by renderText for each reader; a plain string
//      passes through untouched (every caller still handing over English keeps working).
//   R. "How long ago" reads the catalog.
//
// Every expectation is computed from the source of truth (the English catalog module, lib/
// dates' own formatter) rather than restated. A Spanish catalog is registered IN MEMORY with
// test lines — this file never invents a translation for the app.
//
// Offline. Run: node scripts/test-i18n-core.mjs
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// Dynamic, so the pre-change tree (no src/i18n) reports every check as failed instead of
// dying on the first import.
let L = null; let core = null; let en = null; let dates = null; let relative = null;
try { L = await import('../src/i18n/languages.js'); } catch { /* pre-change tree */ }
try { core = await import('../src/i18n/core.js'); } catch { /* pre-change tree */ }
try { en = (await import('../src/i18n/catalog/en.js')).default; } catch { /* pre-change tree */ }
try { dates = await import('../src/lib/dates.js'); } catch { /* always there */ }
try { relative = await import('../src/i18n/relative.js'); } catch { /* pre-change tree */ }
const have = !!(L && core && en);
const safe = (fn) => { try { return fn(); } catch { return Symbol('threw'); } };

// ── L. which language ─────────────────────────────────────────────────────────────────────
const resolve = (a) => safe(() => L.resolveLanguage(a));
ok('L1: the languages are English, Spanish and Haitian Creole, in that order',
  have && JSON.stringify(L.LANGUAGES) === JSON.stringify(['en', 'es', 'ht']));
ok('L2: a saved choice wins over the phone (LANG-11)', have && resolve({ choice: 'es', phone: 'ht' }) === 'es');
ok('L3: "auto" follows the phone (LANG-3)', have && resolve({ choice: 'auto', phone: 'es-MX' }) === 'es');
ok('L4: no saved choice follows the phone too (absent = auto, additive)', have && resolve({ phone: 'ht-HT' }) === 'ht');
ok('L5: a phone in a language we do not speak reads English', have && resolve({ choice: 'auto', phone: 'fr-FR' }) === 'en');
ok('L6: nothing at all reads English', have && resolve({}) === 'en' && resolve() === 'en');
ok('L7: a junk saved value is treated as auto, not trusted', have && resolve({ choice: 'fr', phone: 'es' }) === 'es'
  && resolve({ choice: { evil: true }, phone: null }) === 'en');
ok('L8: the phone list is read in order, first language we speak wins',
  have && L.phoneLanguageFrom(['fr-CA', 'es-US', 'en-US']) === 'es' && L.phoneLanguageFrom(['de']) === null
  && L.phoneLanguageFrom('ht') === 'ht' && L.phoneLanguageFrom(undefined) === null);
ok('L9: the WRITE check is strict: exactly auto/en/es/ht, no case-folding or region',
  have && ['auto', 'en', 'es', 'ht'].every((c) => L.isLanguageChoice(c))
  && ['ES', 'es-MX', 'fr', '', null, undefined, 1, { es: 1 }].every((c) => !L.isLanguageChoice(c)));
ok('L10: a READ is default-safe: anything else reads as auto', have && L.normalizeLanguageChoice('xx') === 'auto'
  && L.normalizeLanguageChoice(undefined) === 'auto' && L.normalizeLanguageChoice('ht') === 'ht');
ok('L11: a recipient is resolved from their roster row alone (choice, then recorded phone)',
  have && L.userLanguage({ language: 'auto', phoneLanguage: 'es' }) === 'es'
  && L.userLanguage({ language: 'ht', phoneLanguage: 'es' }) === 'ht'
  && L.userLanguage({}) === 'en' && L.userLanguage(null) === 'en');

// ── a test Spanish catalog (in memory only) ───────────────────────────────────────────────
const ES = {
  'common.cancel': 'Cancelar',
  'common.listAnd': '{first} y {last}',
  'alerts.shiftReminder.title': 'Tu turno empieza {start, time}',
  'crewHome.stopsToday': { one: '{count} parada hoy', other: '{count} paradas hoy' },
  'alerts.redo.title': 'Por favor, rehaga: {areas, list}',
  // A blank line is "not translated yet": English shows.
  'common.save': '   ',
  // A plural with only its `other`: Spanish `other` covers every count.
  'notif.bellAriaUnread': { other: '{count} sin leer' },
};
ok('registerCatalog refuses to replace English, or a language we do not speak',
  have && core.registerCatalog('en', { 'common.cancel': 'X' }) === false && core.registerCatalog('fr', {}) === false);
ok('registerCatalog takes a language we speak', have && core.registerCatalog('es', ES) === true);
const tr = (lang, key, params, tz) => safe(() => core.translate(lang, key, params, tz));

// ── F. fallback ───────────────────────────────────────────────────────────────────────────
ok('F1: a translated line shows in Spanish', have && tr('es', 'common.cancel') === 'Cancelar');
ok('F2: English shows the English source', have && tr('en', 'common.cancel') === en['common.cancel']);
ok('F3: a line Spanish lacks shows its ENGLISH', have && tr('es', 'common.close') === en['common.close']);
ok('F4: a BLANK Spanish line shows its English', have && tr('es', 'common.save') === en['common.save']);
ok('F5: Creole with no catalog at all shows English', have && tr('ht', 'common.cancel') === en['common.cancel']);
ok('F6: a key missing from every catalog shows NOTHING, never its name',
  have && tr('es', 'no.such.key') === '' && tr('en', 'no.such.key') === '');
ok('F7: an unknown language reads as English', have && tr('fr', 'common.cancel') === en['common.cancel']);

// ── P. placeholders ───────────────────────────────────────────────────────────────────────
const START = '2026-10-04T13:30:00Z';
const NY = 'America/New_York';
const CHI = 'America/Chicago';
const enTime = (tz) => dates.fmtTime(START, tz, 'en-US');
const esTime = (tz) => dates.fmtTime(START, tz, 'es-US');
const enReminder = (tz) => en['alerts.shiftReminder.title'].replace('{start, time}', enTime(tz));
ok('P1: {start, time} renders in the zone passed (an alert renders in the ORG zone)',
  have && tr('en', 'alerts.shiftReminder.title', { start: START }, NY) === enReminder(NY)
  && tr('en', 'alerts.shiftReminder.title', { start: START }, CHI) === enReminder(CHI)
  && enReminder(NY) !== enReminder(CHI));
ok('P2: …and in the READER\'s locale: Spanish formats the time the Spanish way',
  have && tr('es', 'alerts.shiftReminder.title', { start: START }, NY) === `Tu turno empieza ${esTime(NY)}`
  && esTime(NY) !== enTime(NY));
ok('P3: a fallback line formats the ENGLISH way, never a Spanish time inside an English sentence',
  have && tr('es', 'alerts.checklistDue.body', { start: START }, NY)
    === en['alerts.checklistDue.body'].replace('{start, time}', enTime(NY)));
ok('P4: a missing value is empty: never "undefined", never the placeholder',
  have && (() => { const s = tr('en', 'alerts.shiftReminder.title', {}, NY); return typeof s === 'string' && !/undefined|\{|\}/.test(s); })());
ok('P5: plurals pick the CLDR form for the language and count',
  have && tr('en', 'crewHome.stopsToday', { count: 1 }) === en['crewHome.stopsToday'].one.replace('{count}', '1')
  && tr('en', 'crewHome.stopsToday', { count: 3 }) === en['crewHome.stopsToday'].other.replace('{count}', '3')
  && tr('es', 'crewHome.stopsToday', { count: 1 }) === '1 parada hoy'
  && tr('es', 'crewHome.stopsToday', { count: 0 }) === '0 paradas hoy');
ok('P6: a Spanish plural with only `other` uses it for every count',
  have && tr('es', 'notif.bellAriaUnread', { count: 1 }) === '1 sin leer' && tr('es', 'notif.bellAriaUnread', { count: 7 }) === '7 sin leer');
ok('P7: {areas, list} joins with the language\'s own "and" (from the catalog)',
  have && tr('en', 'alerts.redo.title', { areas: ['Lobby', 'Kitchen', 'Restrooms'] })
    === en['alerts.redo.title'].replace('{areas, list}', en['common.listAnd'].replace('{first}', 'Lobby, Kitchen').replace('{last}', 'Restrooms'))
  && tr('es', 'alerts.redo.title', { areas: ['Lobby', 'Kitchen', 'Restrooms'] }) === 'Por favor, rehaga: Lobby, Kitchen y Restrooms'
  && tr('es', 'alerts.redo.title', { areas: ['Lobby'] }) === 'Por favor, rehaga: Lobby');
ok('P8: a message INSIDE a message renders in the same language',
  have && tr('es', 'alerts.redo.title', { areas: [core.msg('common.cancel'), 'Lobby'] }) === 'Por favor, rehaga: Cancelar y Lobby'
  && tr('en', 'alerts.redo.title', { areas: [core.msg('common.cancel'), 'Lobby'] }).includes(en['common.cancel']));
ok('P9: placeholdersOf lists names, formats and tags — what a translation must keep',
  have && JSON.stringify(core.placeholdersOf('{a} at {start, time} <b>{n}</b>')) === JSON.stringify(['<b>', 'a', 'n', 'start,time']));
ok('P10: every format the renderer knows is listed for the tools',
  have && ['time', 'date', 'weekday', 'dateLong', 'dateTime', 'number', 'duration', 'money', 'ordinal', 'list']
    .every((f) => core.PLACEHOLDER_FORMATS.includes(f)));

// ── M. messages ───────────────────────────────────────────────────────────────────────────
ok('M1: msg() is words to render later, and is recognisable as one',
  have && core.isMsg(core.msg('common.cancel')) && !core.isMsg('Cancel') && !core.isMsg(null)
  && JSON.stringify(core.msg('common.cancel')) === JSON.stringify({ $t: 'common.cancel' }));
ok('M2: renderText renders a message for the reader\'s language',
  have && core.renderText(core.msg('common.cancel'), 'es') === 'Cancelar'
  && core.renderText(core.msg('common.cancel'), 'en') === en['common.cancel']);
ok('M3: renderText passes a plain string through untouched (existing English callers)',
  have && core.renderText('Already English', 'es') === 'Already English');
ok('M4: renderText of nothing is empty, never "null"', have && core.renderText(null, 'es') === '' && core.renderText(undefined, 'en') === '');
ok('M5: a message carries its params to the reader\'s render, in the zone given',
  have && core.renderText(core.msg('alerts.shiftReminder.title', { start: START }), 'es', NY) === `Tu turno empieza ${esTime(NY)}`);
ok('M6: english() is the English of a key (the activity log, API errors)',
  have && core.english('common.cancel') === en['common.cancel']);

// ── R. how long ago ───────────────────────────────────────────────────────────────────────
if (have && relative) {
  const tEs = (k, p) => core.translate('es', k, p);
  const tEn = (k, p) => core.translate('en', k, p);
  const fiveMin = new Date(Date.now() - 5 * 60_000).toISOString();
  ok('R1: "5m ago" is the catalog\'s line', relative.timeAgo(tEn, fiveMin) === en['ago.minutesAgo'].other.replace('{count}', '5'));
  ok('R2: …and the short form', relative.timeShort(tEn, fiveMin) === en['ago.minutesShort'].other.replace('{count}', '5'));
  ok('R3: under a minute is "just now"', relative.timeAgo(tEs, new Date().toISOString()) === en['ago.justNow']);
  ok('R4: no time is empty', relative.timeAgo(tEn, null) === '' && relative.timeShort(tEn, 'not a date') === '');
} else {
  ok('R: src/i18n/relative.js exists', false);
}

console.log(`\ntest-i18n-core: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
