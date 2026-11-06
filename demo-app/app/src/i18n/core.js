// The translation layer's core (CS-193). PURE and node-safe — no React, no DOM, no env — so
// the browser renders its screens with it and the server renders an alert for its RECIPIENT
// with the very same catalogs and the very same rules (LANG-4).
//
// ── THE RULES ────────────────────────────────────────────────────────────────────────────
//   • English (catalog/en.js) is the SOURCE and is always loaded. Every other language is a
//     catalog keyed the same way (catalog/es.js, catalog/ht.js), registered when it loads.
//   • A key missing from a language falls back to the ENGLISH text — never to the key name.
//     (A key missing from English too is a bug the catalog test fails the build on; at run
//     time it renders nothing rather than a dotted name.)
//   • `{name}` is a placeholder; `{name, time}` formats it (see FORMATS). A translation must
//     keep exactly the English placeholders — the import refuses a line that doesn't, and
//     test-i18n-catalog.mjs fails the build on one that slipped in.
//   • A PLURAL is an object of CLDR categories — { one: '{count} clean', other: '{count}
//     cleans' } — picked with Intl.PluralRules for the language and `params.count`. A
//     category a translation lacks falls back to its `other`, then to English.
//   • `<b>…</b>`-style tags mark a stretch of text a screen renders specially (bold, a link);
//     only `tRich` (src/i18n/react.jsx) gives them meaning, and translations keep them too.
//
// ── MESSAGES THAT TRAVEL ─────────────────────────────────────────────────────────────────
// Code that WRITES text for someone else — a bell row, a push, a text — does not know the
// reader's language when it builds the words, so it builds a MESSAGE instead: `msg(key,
// params)`. The fan-out renders it per recipient (`renderText(message, lang)`), and a message
// may sit inside another's params (a reason inside a ticket alert), rendered in the same
// language. A plain string passes through `renderText` untouched, so every caller that still
// hands over English keeps working exactly as before.
import en from './catalog/en.js';
import { LANGUAGE_INFO, SOURCE_LANGUAGE, normalizeLanguage, intlLocale } from './languages.js';
import { fmtTime, fmtDate, fmtDateTime, fmtDuration, getOrgTimezone } from '../lib/dates.js';

const catalogs = new Map([[SOURCE_LANGUAGE, en]]);
let catalogVersion = 0;
const listeners = new Set();

// Register (or replace) a language's catalog. The browser calls this when a lazy catalog
// arrives; the server registers every catalog at load (api/_lib/i18n.js). Bumps a version
// so screens subscribed through the runtime re-render in the newly-available language.
export function registerCatalog(lang, dict) {
  const code = normalizeLanguage(lang);
  if (!code || code === SOURCE_LANGUAGE || !dict || typeof dict !== 'object') return false;
  catalogs.set(code, dict);
  catalogVersion += 1;
  for (const fn of listeners) { try { fn(); } catch { /* a listener never breaks a load */ } }
  return true;
}
export function hasCatalog(lang) { return catalogs.has(normalizeLanguage(lang)); }
// The catalog registered for a language right now (null when none) — what a merge of extra lines
// goes on top of (the server's own lines, CS-851), so a merge never drops what is already there.
export function catalogOf(lang) { return catalogs.get(normalizeLanguage(lang)) || null; }
export function getCatalogVersion() { return catalogVersion; }
export function onCatalogChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// The English source, for the tools (export, tests) — the same object the app renders from.
export const SOURCE_CATALOG = en;

// ── lookups ──────────────────────────────────────────────────────────────────────────────
const isPlural = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The entry for `key` in `lang`, else English. { value, lang } of the text actually used, so a
// fallback formats its dates and plurals the English way — an English sentence with Spanish
// month names would be neither.
function lookup(lang, key) {
  const code = normalizeLanguage(lang) || SOURCE_LANGUAGE;
  if (code !== SOURCE_LANGUAGE) {
    const dict = catalogs.get(code);
    if (dict && own(dict, key) && usable(dict[key])) return { value: dict[key], lang: code };
  }
  if (own(en, key)) return { value: en[key], lang: SOURCE_LANGUAGE };
  return null;
}
// A blank translation (the translator left the cell empty) is "not translated yet".
function usable(v) {
  if (typeof v === 'string') return v.trim().length > 0;
  return isPlural(v) && Object.values(v).some((s) => typeof s === 'string' && s.trim());
}

const pluralRulesByLocale = new Map();
function pluralCategory(locale, count) {
  let pr = pluralRulesByLocale.get(locale);
  if (!pr) {
    try { pr = new Intl.PluralRules(intlLocale(locale)); } catch { pr = new Intl.PluralRules('en-US'); }
    pluralRulesByLocale.set(locale, pr);
  }
  const n = Number(count);
  return pr.select(Number.isFinite(n) ? n : 0);
}

function pickPlural(value, lang, count) {
  const cat = pluralCategory(LANGUAGE_INFO[lang].dateLocale, count);
  const text = value[cat] ?? value.other;
  return typeof text === 'string' && text.trim() ? text : null;
}

// ── formatting ───────────────────────────────────────────────────────────────────────────
// `{name, type}`. Dates and times render in the ORG's zone (lib/dates' ambient zone, which
// the store sets on the client and the cron sets from company.timezone) and in the locale of
// the language the sentence came from.
const FORMATS = {
  time: (v, ctx) => fmtTime(v, ctx.tz, ctx.locale),
  date: (v, ctx) => fmtDate(v, { month: 'short', day: 'numeric' }, ctx.tz, ctx.locale),
  weekday: (v, ctx) => fmtDate(v, { weekday: 'short', month: 'short', day: 'numeric' }, ctx.tz, ctx.locale),
  dateLong: (v, ctx) => fmtDate(v, { weekday: 'long', month: 'long', day: 'numeric' }, ctx.tz, ctx.locale),
  // A date and a time together, e.g. "Oct 3, 2026, 9:30 PM" — a shift on someone's phone (through
  // lib/dates, so Creole gets its own month names: "3 oktòb 2026, 9:30 PM").
  dateTime: (v, ctx) => fmtDateTime(v, ctx.tz, ctx.locale),
  number: (v, ctx) => {
    const n = Number(v);
    return Number.isFinite(n) ? new Intl.NumberFormat(intlLocale(ctx.locale)).format(n) : '';
  },
  duration: (v) => fmtDuration(v),
  // Dollars, with cents, in the reader's locale — the app's one money format (lib/dates money).
  money: (v, ctx) => {
    const n = Number(v);
    return new Intl.NumberFormat(intlLocale(ctx.locale), { style: 'currency', currency: 'USD' }).format(Number.isFinite(n) ? n : 0);
  },
  // A day of the month as a date: "1st", "22nd" in English; elsewhere the plain number, which
  // the sentence around it frames ("el día {orderDay, ordinal}").
  ordinal: (v, ctx) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    if (ctx.lang !== SOURCE_LANGUAGE) return String(n);
    const suffix = { one: 'st', two: 'nd', few: 'rd', other: 'th' }[new Intl.PluralRules('en-US', { type: 'ordinal' }).select(n)];
    return `${n}${suffix}`;
  },
  // "A, B and C": commas, then the language's own "and" from the catalog (`common.listAnd`) —
  // not Intl.ListFormat, which has no Creole and would put an English "and" in a Creole line.
  list: (v, ctx) => {
    const items = (Array.isArray(v) ? v : [v]).map((x) => renderValue(x, ctx)).filter(Boolean);
    if (items.length <= 1) return items[0] || '';
    return translate(ctx.lang, 'common.listAnd', { first: items.slice(0, -1).join(', '), last: items[items.length - 1] }, ctx.tz);
  },
};
export const PLACEHOLDER_FORMATS = Object.freeze(Object.keys(FORMATS));

// Matches `{name}` and `{name, type}`. Names are identifiers; anything else in braces is text.
const PLACEHOLDER_RE = /\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:,\s*([A-Za-z]+)\s*)?\}/g;
const TAG_RE = /<\/?([a-z][a-z0-9]*)>/g;

// A param value as text: a nested message renders in the same language; null/undefined is
// empty (a missing value must never print "undefined" or the placeholder's name).
function renderValue(v, ctx) {
  if (v == null) return '';
  if (isMsg(v)) return translate(ctx.lang, v.$t, v.p, ctx.tz);
  if (Array.isArray(v)) return FORMATS.list(v, ctx);
  return String(v);
}

function interpolate(text, params, ctx) {
  if (!text.includes('{')) return text;
  return text.replace(PLACEHOLDER_RE, (whole, name, type) => {
    const v = params ? params[name] : undefined;
    if (v == null || v === '') return '';
    if (type && FORMATS[type]) {
      try { return FORMATS[type](v, ctx); } catch { return ''; }
    }
    return renderValue(v, ctx);
  });
}

// ── the API ──────────────────────────────────────────────────────────────────────────────
// translate(lang, key, params, tz?) → the text. `key` may also be a message (msg(...)), in
// which case its own params are used. `tz` overrides the org zone for a render on the server.
export function translate(lang, key, params, tz) {
  if (isMsg(key)) return translate(lang, key.$t, key.p, tz);
  if (typeof key !== 'string' || !key) return '';
  const entry = lookup(lang, key);
  if (!entry) {
    warnMissing(key);
    return '';
  }
  let { value, lang: from } = entry;
  let text;
  if (typeof value === 'string') text = value;
  else if (isPlural(value)) {
    text = pickPlural(value, from, params?.count);
    if (text == null && from !== SOURCE_LANGUAGE && isPlural(en[key])) {
      from = SOURCE_LANGUAGE;
      text = pickPlural(en[key], from, params?.count);
    }
  }
  if (text == null) { warnMissing(key); return ''; }
  const ctx = { lang: from, locale: LANGUAGE_INFO[from].dateLocale, tz: tz || getOrgTimezone() };
  return interpolate(text, params, ctx);
}

// The English text of a key — what the activity log, an API error body and a test read.
export function english(key, params) { return translate(SOURCE_LANGUAGE, key, params); }

// A message: words to be rendered later, in the reader's language.
export function msg(key, params) {
  return params && Object.keys(params).length ? { $t: key, p: params } : { $t: key };
}
export function isMsg(x) { return !!x && typeof x === 'object' && typeof x.$t === 'string'; }

// Text for a reader in `lang`: a message is rendered, a string passes through unchanged.
export function renderText(x, lang, tz) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (isMsg(x)) return translate(lang, x.$t, x.p, tz);
  return String(x);
}

// The placeholders a text carries, as sorted `name` or `name,type` strings, plus its tags —
// what a translation must keep. Used by the import, the catalog test and the export.
export function placeholdersOf(text) {
  const out = new Set();
  const s = typeof text === 'string' ? text : '';
  for (const m of s.matchAll(PLACEHOLDER_RE)) out.add(m[2] ? `${m[1]},${m[2]}` : m[1]);
  for (const m of s.matchAll(TAG_RE)) out.add(`<${m[1]}>`);
  return [...out].sort();
}
export function placeholderNamesOf(text) {
  return [...new Set([...String(text || '').matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort();
}

// Every string of an entry (a plain string, or each plural form).
export function entryTexts(value) {
  if (typeof value === 'string') return [value];
  if (isPlural(value)) return Object.values(value).filter((s) => typeof s === 'string');
  return [];
}

// Missing keys warn once each, and only where a console exists to read it.
const warned = new Set();
function warnMissing(key) {
  if (warned.has(key)) return;
  warned.add(key);
  try { if (typeof console !== 'undefined') console.warn(`[i18n] missing English text for "${key}"`); } catch { /* noop */ }
}
