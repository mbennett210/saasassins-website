// The languages the app speaks, and WHICH one a person gets (CS-193; Matt's LANG-2, LANG-3,
// LANG-11). PURE and node-safe: the browser resolves the signed-in person's own language with
// it, and the server resolves an alert's RECIPIENT with the very same rule (LANG-4), so the
// screen a cleaner reads and the push that wakes them can never disagree about the language.
//
//   saved choice ('en' | 'es' | 'ht')  →  that language, whatever the phone says (LANG-11)
//   'auto' / absent / anything else    →  the phone's language, when it is one we speak (LANG-3)
//   otherwise                          →  English
//
// "The phone's language" is the first of the phone's preferred languages that is one of ours
// (navigator.languages, primary subtag only: 'es-MX' is Spanish). A phone set to French and
// then English reads as English; a phone set to French only reads as nothing, so English.
//
// The SERVER cannot ask a phone anything, so the browser records what it found on the
// person's own row (`users[].phoneLanguage`, written only when it changes) and the server
// reads that — see `userLanguage` below and components/LanguageSync.

// Display order everywhere a language is offered.
export const LANGUAGES = Object.freeze(['en', 'es', 'ht']);
export const SOURCE_LANGUAGE = 'en';

// What a person may SAVE (`users[].language`). 'auto' is "follow my phone", and it is also
// what an absent value means, so the field is additive and default-safe (no store bump).
export const AUTO_LANGUAGE = 'auto';
export const LANGUAGE_CHOICES = Object.freeze([AUTO_LANGUAGE, ...LANGUAGES]);

// `native`   — how the language names itself; what the switch shows, so a Spanish speaker
//              finds "Español" whatever language the screen is in at the time.
// `dateLocale` — the locale dates, times, numbers and plural rules are formatted with. Spanish
//              uses US Spanish (12-hour times with "p.m.", the way Clean Space's schedules read).
//              Phones and browsers carry no Haitian Creole date data at all (ICU has none —
//              measured: Intl falls back to English for 'ht'), so Creole is `en-US-x-ht`: US
//              English for numbers, plurals and 12-hour times, and the tag tells lib/dates to
//              write the month and weekday names in Creole, in Creole order — "madi 13 oktòb
//              2026" (CALENDAR_NAMES below; CS-851).
// 🔴 INTL IS NEVER HANDED A `dateLocale` AS IT IS: pass `intlLocale(dateLocale)`, the locale with
//              its private-use part removed. A private-use tag is not something to trust every
//              runtime with, and runtimes already disagree on these very strings: Node 24's V8 (ICU
//              78.3) puts a narrow no-break space (U+202F) before AM/PM in formatToParts() while
//              its format() writes a plain space, where Node 26 writes a plain space in both (main's
//              CI, 2026-10-15; lib/dates' Creole formatter therefore takes its spacing from
//              format()). The tag only chooses the Creole names; Intl always formats the base
//              locale, so Creole's times, numbers and plurals are byte for byte US English on every
//              runtime.
export const LANGUAGE_INFO = Object.freeze({
  en: Object.freeze({ code: 'en', name: 'English', native: 'English', dateLocale: 'en-US' }),
  es: Object.freeze({ code: 'es', name: 'Spanish', native: 'Español', dateLocale: 'es-US' }),
  ht: Object.freeze({ code: 'ht', name: 'Haitian Creole', native: 'Kreyòl ayisyen', dateLocale: 'en-US-x-ht' }),
});

// What Intl may be handed for a locale: the locale without its private-use part (`-x-…`), so
// 'en-US-x-ht' → 'en-US'. Anything that is not a string passes through (undefined = the runtime's).
export function intlLocale(locale) {
  if (typeof locale !== 'string') return locale;
  return locale.replace(/-x(?:-[A-Za-z0-9]{1,8})+$/i, '') || undefined;
}

// The names a language's dates need that no phone or browser carries: Haitian Creole's months
// (January first) and weekdays (Sunday first, as Date#getDay counts), lower case as Creole writes
// them. Read by lib/dates for any date formatted in a locale tagged `-x-ht`.
export const CALENDAR_NAMES = Object.freeze({
  ht: Object.freeze({
    months: Object.freeze(['janvye', 'fevriye', 'mas', 'avril', 'me', 'jen', 'jiyè', 'out', 'septanm', 'oktòb', 'novanm', 'desanm']),
    weekdays: Object.freeze(['dimanch', 'lendi', 'madi', 'mèkredi', 'jedi', 'vandredi', 'samdi']),
  }),
});

const SUPPORTED = new Set(LANGUAGES);

// 'es', 'ES', 'es-MX', 'es_419' → 'es'; anything we do not speak → null. Never throws.
export function normalizeLanguage(code) {
  if (typeof code !== 'string') return null;
  const primary = code.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.has(primary) ? primary : null;
}

// The STRICT check the two write points run (the reducer and the server's crew merge):
// exactly one of the four saved values, nothing else, no normalizing. A crafted 'fr' or
// { evil: true } is refused there rather than repaired into something the person never chose.
export function isLanguageChoice(value) {
  return typeof value === 'string' && LANGUAGE_CHOICES.includes(value);
}

// A saved value READ back: anything that is not exactly a choice reads as 'auto'. Readers
// are default-safe so a hand-edited or legacy row can never break anyone's screen.
export function normalizeLanguageChoice(value) {
  return isLanguageChoice(value) ? value : AUTO_LANGUAGE;
}

// The phone's language from its preference list (navigator.languages, or [navigator.language]).
export function phoneLanguageFrom(languages) {
  const list = Array.isArray(languages) ? languages : (typeof languages === 'string' ? [languages] : []);
  for (const code of list) {
    const lang = normalizeLanguage(code);
    if (lang) return lang;
  }
  return null;
}

// THE RULE. `choice` is the saved value, `phone` the phone's language (already normalized or
// a raw code — both work). Always answers one of LANGUAGES.
export function resolveLanguage({ choice = null, phone = null } = {}) {
  const saved = normalizeLanguageChoice(choice);
  if (saved !== AUTO_LANGUAGE) return saved;
  return normalizeLanguage(phone) || SOURCE_LANGUAGE;
}

// A RECIPIENT's language, from their roster row alone — what the server (and an office tab
// writing a bell row for a cleaner) can know about someone who is not the one looking.
export function userLanguage(user) {
  return resolveLanguage({ choice: user?.language, phone: user?.phoneLanguage });
}

export function languageInfo(lang) {
  return LANGUAGE_INFO[normalizeLanguage(lang) || SOURCE_LANGUAGE];
}
