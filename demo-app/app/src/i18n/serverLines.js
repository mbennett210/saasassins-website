// The server's lines for what this build's bundle lacks, on the BROWSER side (CS-851). The server
// translates every Spanish and Creole line added or reworded since es.js / ht.js were written
// (GET /api/i18n/lines, EP-411); the runtime (src/i18n/runtime.js) merges them over the bundled
// catalog. This module is the pure half — storage, the build id and the fetch are handed in, so a
// node suite drives it (test-i18n-client-lines.mjs):
//
//   • ON THE DEVICE, per language and BUILD: `cleanspace_i18n_lines_v1:<lang>` holds
//     { build, lines, at }. A copy from another build is never used (its English may have moved
//     on) and is cleared; a phone that lost its signal still shows yesterday's lines (II.7: the
//     device cache paints first, online too).
//   • FETCHED ONCE PER SESSION AND BUILD: a session that already fetched this language for this
//     build (sessionStorage) and still has the copy does not ask again. English shows only until
//     that first fetch lands.
//   • Only keys the English catalog has, each shaped like its English, are ever taken.
//   • No server (the demo) or no answer: nothing happens, quietly.
export const LINES_CACHE_KEY = 'cleanspace_i18n_lines_v1';
export const LINES_SESSION_KEY = 'cleanspace_i18n_lines_fetched_v1';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cacheKey = (lang) => `${LINES_CACHE_KEY}:${lang}`;
const sessionKey = (lang) => `${LINES_SESSION_KEY}:${lang}`;
const buildOf = (build) => String(build ?? '');

// The lines worth keeping: a key the English catalog has, a non-blank line where the English is a
// line, and every form the English has where it is a plural.
export function cleanLines(lines, en) {
  const out = {};
  if (!isObj(lines)) return out;
  for (const [key, v] of Object.entries(lines)) {
    const source = en?.[key];
    if (source == null) continue;
    if (typeof source === 'string') {
      if (typeof v === 'string' && v.trim()) out[key] = v;
    } else if (isObj(source) && isObj(v)) {
      const forms = Object.keys(source);
      if (forms.every((f) => typeof v[f] === 'string' && v[f].trim())) out[key] = Object.fromEntries(forms.map((f) => [f, v[f]]));
    }
  }
  return out;
}

export function readCachedLines(storage, lang, build) {
  try {
    const raw = storage?.getItem(cacheKey(lang));
    if (!raw) return null;
    const got = JSON.parse(raw);
    if (!isObj(got) || got.build !== buildOf(build) || !isObj(got.lines)) {
      storage.removeItem(cacheKey(lang));   // another build's copy is never shown
      return null;
    }
    return got.lines;
  } catch { return null; }
}

export function writeCachedLines(storage, lang, build, lines, now = Date.now()) {
  try {
    storage?.setItem(cacheKey(lang), JSON.stringify({ build: buildOf(build), lines, at: now }));
    return true;
  } catch { return false; }   // full or blocked storage: the lines still show this session
}

// Ask the server once per session and build; hand what came back to `onLines`. Answers the lines
// taken (or null when nothing was asked or nothing came).
export async function refreshServerLines({ lang, build, fetchLines, storage, session, en, onLines } = {}) {
  if (!lang || lang === 'en' || typeof fetchLines !== 'function') return null;
  const asked = (() => { try { return session?.getItem(sessionKey(lang)) === buildOf(build); } catch { return false; } })();
  if (asked && readCachedLines(storage, lang, build)) return null;
  let lines;
  try {
    const answer = await fetchLines(lang);
    if (!answer || !isObj(answer.lines)) return null;   // no server (the demo), or nothing usable
    lines = cleanLines(answer.lines, en);
  } catch { return null; }   // offline, signed out, rate-limited: the device's copy stays
  writeCachedLines(storage, lang, build, lines);
  try { session?.setItem(sessionKey(lang), buildOf(build)); } catch { /* noop */ }
  if (typeof onLines === 'function') onLines(lines);
  return lines;
}
