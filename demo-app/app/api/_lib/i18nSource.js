// WHAT THE DEPLOYED BUNDLE LACKS (CS-851). Node-only and pure (no database): the server and the
// tools (scripts/i18n-sources.mjs, i18n-import) share it, so they agree on which Spanish and
// Creole lines are missing or out of date.
//
//   missing  an English key with no usable line in that language
//   changed  the English moved on after that line was written: the source map
//            (src/i18n/catalog/sources.js, key → the hash of the English each line was
//            translated from) no longer matches the English the bundle carries
//
// English-only keys (what a customer reads, LANG-8: terms.isEnglishOnly) never count. A pending
// line is what the server translates itself (api/_lib/i18n.js translatePendingLines) and serves to
// the app (GET /api/i18n/lines, EP-411) and to its own alerts.
import { createHash } from 'node:crypto';
import { isEnglishOnly } from '../../src/i18n/terms.js';

export const SOURCE_LANGUAGES = Object.freeze(['es', 'ht']);
export const SOURCE_HASH_CHARS = 12;
// What i18n:import stamps for a line it loaded against OLD English (--allow-stale): it never
// matches a real hash, so the server translates that key's current English.
export const STALE_SOURCE = '0'.repeat(SOURCE_HASH_CHARS);
const CLDR = ['zero', 'one', 'two', 'few', 'many', 'other'];
const isPlural = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// One English entry as text, the same however its object was written (plural forms in CLDR order).
export function canonicalEntry(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (isPlural(value)) return JSON.stringify(Object.fromEntries(CLDR.filter((c) => typeof value[c] === 'string').map((c) => [c, value[c]])));
  return '';
}
export function sourceHashOf(value) {
  return createHash('sha256').update(canonicalEntry(value), 'utf8').digest('hex').slice(0, SOURCE_HASH_CHARS);
}
// The recorded source of `key` in `lang` (a string shared by both languages, or { es, ht }).
export function sourceOf(sources, lang, key) {
  const v = sources?.[key];
  if (typeof v === 'string') return v;
  return isPlural(v) && typeof v[lang] === 'string' ? v[lang] : null;
}
// A line a language may show (core.js's own test: blank cells are "not translated yet").
export function usableLine(v) {
  if (typeof v === 'string') return v.trim().length > 0;
  return isPlural(v) && Object.values(v).some((s) => typeof s === 'string' && s.trim());
}
// The strings of an entry, as [form, text] (form null for a plain line).
export function entryForms(value) {
  if (typeof value === 'string') return [[null, value]];
  if (isPlural(value)) return CLDR.filter((c) => typeof value[c] === 'string').map((c) => [c, value[c]]);
  return [];
}

// Every key `lang` needs from the server: [{ key, value (the English entry), reason }].
export function pendingLines({ en, bundled, sources, lang }) {
  const dict = bundled || {};
  const out = [];
  for (const [key, value] of Object.entries(en || {})) {
    if (isEnglishOnly(key) || !entryForms(value).length) continue;
    if (!Object.prototype.hasOwnProperty.call(dict, key) || !usableLine(dict[key])) { out.push({ key, value, reason: 'missing' }); continue; }
    if (sourceOf(sources, lang, key) !== sourceHashOf(value)) out.push({ key, value, reason: 'changed' });
  }
  return out;
}

// The source map for the catalogs as they stand. For every key a language holds: the source
// `restamp` names for it (i18n:import, for the lines it just loaded: `${lang}:${key}` → hash),
// else the source it had (`previous`), else today's English (a line with no record — the seed,
// or a line added by hand — is taken to be of the English beside it). Keys no language holds
// leave. When both languages' sources are equal the entry is one string.
export function buildSources({ en, catalogs, previous = {}, restamp = null }) {
  const out = {};
  for (const key of Object.keys(en || {})) {
    const per = {};
    for (const lang of SOURCE_LANGUAGES) {
      if (!Object.prototype.hasOwnProperty.call(catalogs?.[lang] || {}, key)) continue;
      per[lang] = restamp?.get(`${lang}:${key}`) || sourceOf(previous, lang, key) || sourceHashOf(en[key]);
    }
    const langs = Object.keys(per);
    if (!langs.length) continue;
    out[key] = langs.length === SOURCE_LANGUAGES.length && per.es === per.ht ? per.es : per;
  }
  return out;
}

export function renderSources(map) {
  const q = (s) => JSON.stringify(s);
  const lines = Object.entries(map).map(([k, v]) => (typeof v === 'string'
    ? `  ${q(k)}: ${q(v)},`
    : `  ${q(k)}: { ${SOURCE_LANGUAGES.filter((l) => v[l]).map((l) => `${l}: ${q(v[l])}`).join(', ')} },`));
  return `// GENERATED — do not hand-edit. Written by \`npm --prefix app run i18n:sources\` and by
// \`i18n:import\` (CS-851). For every Spanish and Creole line in es.js / ht.js: the first
// ${SOURCE_HASH_CHARS} hex characters of the sha256 of the ENGLISH it was translated from (one value when
// both languages were translated from the same English, else { es, ht }). When the English in
// en.js moves on, the hash no longer matches, and the server translates the new English itself
// (api/_lib/i18nSource.js pendingLines, GET /api/i18n/lines). Never imported by the browser.
export default {
${lines.join('\n')}${lines.length ? '\n' : ''}};
`;
}
