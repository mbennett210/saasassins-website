// PSEUDO-LOCALIZATION — DEMO ONLY (CS-193). The real Spanish and Creole are in the catalogs
// (since S129: Google Cloud Translation's drafts after the term-list cleanup), but a line
// added after the last translation pass has none yet, and the login-free demo needs some way
// to SHOW it. Switching a cleaner to Spanish in the demo fills every line the catalog lacks
// with the English run through this: accented letters, about a third longer, in brackets —
// "[Ḿý Ḓáý ··]".
//   • a line in brackets is CONVERTED but not translated yet: it will show its Spanish once
//     the next pass loads it;
//   • a line still in plain English is NOT converted yet (or is the person's own content —
//     a customer's name, a note someone typed — which LANG-7 keeps as written);
//   • the extra length shows a layout surviving a longer language.
// It is NEVER Spanish and never reaches a catalog file or a production build: the runtime
// imports it only inside `import.meta.env.MODE === 'demo'` (dead code in `npm run build`,
// held there by check-bundle-stubs' `cs-stub:i18n-pseudo` sentinel).
import { entryTexts } from './core.js';

const ACCENTED = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ḿ',
  n: 'ñ', o: 'ó', p: 'ṕ', q: 'ʠ', r: 'ŕ', s: 'ŝ', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ḓ', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ḿ',
  N: 'Ñ', O: 'Ó', P: 'Ṕ', Q: 'Ǫ', R: 'Ŕ', S: 'Ŝ', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

// Placeholders and tags are kept byte-for-byte: they are code, not words.
const PROTECTED_RE = /(\{[^{}]*\}|<\/?[a-z][a-z0-9]*>)/g;

export function pseudoText(text) {
  const s = String(text ?? '');
  if (!s) return s;
  const out = s.split(PROTECTED_RE).map((part, i) => (i % 2 === 1 ? part : [...part].map((ch) => ACCENTED[ch] || ch).join('')));
  const letters = s.replace(PROTECTED_RE, '').replace(/[^A-Za-z]/g, '').length;
  const pad = letters > 3 ? ' ' + '·'.repeat(Math.max(1, Math.round(letters * 0.3))) : '';
  return `[${out.join('')}${pad}]`;
}

// Every English entry, pseudo'd — plural objects keep their categories.
export function pseudoCatalog(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'string') out[key] = pseudoText(value);
    else if (entryTexts(value).length) {
      out[key] = Object.fromEntries(Object.entries(value).map(([cat, s]) => [cat, pseudoText(s)]));
    }
  }
  return out;
}
