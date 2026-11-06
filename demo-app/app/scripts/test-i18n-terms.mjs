// CS-193 (S129), CS-851 — the term list holds the Spanish and Haitian Creole: the bundled
// catalogs AND every line the server machine-translates.
//
// The app's own words were machine-drafted by Google Cloud Translation, then held to a fixed term
// list (docs/i18n/term-list.md). Since CS-851 the SERVER translates every line added or reworded
// after that, with the same list applied by code (src/i18n/terms.js, read by the tools and by
// api/_lib/translateStore.js). This suite pins it against the constants in src/i18n/terms.js
// (never a restated literal):
//   1. LANG-8: what a CUSTOMER reads stays English — no publicQuote.*, publicReport.*,
//      resolveTime.hub.* or hubScan.* line in es.js or ht.js, and the import refuses one.
//   2. The pinned lines (TERM_LINES: Clock in, Clock out, Open checklist, My Day…) read
//      exactly as the term list fixes them.
//   3. No line uses a word the term list replaced (FORBIDDEN_TERMS: "fichar", "tripulación",
//      "rele antre", "kout pwen"…).
//   4. Every glossary term has its Spanish and Creole word, and the term-list page names each.
//   5. THE MACHINE'S OUTPUT, through the real translateAll and a FAKE Google that makes the known
//      machine mistakes: a protected noun reaches Google as a token and comes back as the agreed
//      word with its article put right; a mistake Google makes from a word that cannot be
//      protected (a verb, "you") is repaired; no line it answers uses a forbidden word.
//
// Offline. Run: node scripts/test-i18n-terms.mjs
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld } from './fake-supabase.mjs';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
delete process.env.GOOGLE_TRANSLATE_API_KEY;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const lib = await import('./i18n-lib.mjs');
let terms = null;
try { terms = await import('../src/i18n/terms.js'); } catch { /* the pre-CS-851 tree: reported below */ }
const { loadCatalogs, readCatalogNotes, GLOSSARY, TERM_LINES, FORBIDDEN_TERMS, ENGLISH_ONLY_PREFIXES, isEnglishOnly } = lib;
ok('0: the term list is ONE module the server reads too (src/i18n/terms.js), and the tools re-export it',
  !!terms && terms.GLOSSARY === GLOSSARY && terms.TERM_LINES === TERM_LINES && terms.FORBIDDEN_TERMS === FORBIDDEN_TERMS
  && terms.isEnglishOnly === isEnglishOnly);
const cats = await loadCatalogs();
const { en } = cats;
const LANGS = ['es', 'ht'];
const texts = (v) => (v && typeof v === 'object' ? Object.values(v) : [v]).filter((s) => typeof s === 'string');

// ── 1. LANG-8: customer-facing lines stay English ─────────────────────────────────────────
ok('1a: the English-only rule names the quote page, the report page, the hub tile and the hub scan page',
  ['publicQuote.', 'publicReport.', 'resolveTime.hub.', 'hubScan.'].every((p) => ENGLISH_ONLY_PREFIXES.includes(p)));
const englishOnly = Object.keys(en).filter(isEnglishOnly);
ok('1b: the English catalog has English-only lines to protect', englishOnly.length > 0);
for (const lang of LANGS) {
  const leaked = Object.keys(cats[lang]).filter(isEnglishOnly);
  ok(`1c: ${lang}.js holds no English-only line`, leaked.length === 0, leaked.join(', '));
}
const imp = await import('./i18n-import.mjs');
const sample = englishOnly[0];
const { report } = await imp.planImport({
  rows: [{ row: 2, key: sample, form: typeof en[sample] === 'object' ? 'other' : '', english: null, text: 'XX' }],
  lang: 'es', en, current: {}, notes: readCatalogNotes(),
});
ok('1d: the import refuses a translation of an English-only line', report.refused[0]?.reason === 'english-only',
  JSON.stringify(report.refused[0] || report.loaded[0] || null));

// ── 2. the pinned lines ────────────────────────────────────────────────────────────────
for (const lang of LANGS) {
  for (const [key, want] of Object.entries(TERM_LINES[lang])) {
    ok(`2: ${lang} ${key} reads “${want}”`, cats[lang][key] === want, `it reads ${JSON.stringify(cats[lang][key])}`);
  }
}
ok('2b: the pinned lines are real keys', LANGS.every((l) => Object.keys(TERM_LINES[l]).every((k) => k in en)));

// ── 3. no replaced word comes back ─────────────────────────────────────────────────────
for (const lang of LANGS) {
  for (const [re, why] of FORBIDDEN_TERMS[lang]) {
    const hits = Object.entries(cats[lang]).filter(([, v]) => texts(v).some((s) => re.test(s))).map(([k]) => k);
    ok(`3: no ${lang} line uses ${re.source} (${why})`, hits.length === 0, hits.slice(0, 8).join(', '));
  }
}

// ── 4. the glossary and the term-list page agree ────────────────────────────────────────
ok('4a: every glossary term has a Spanish and a Creole word',
  GLOSSARY.every(([, , t]) => t && typeof t.es === 'string' && t.es && typeof t.ht === 'string' && t.ht));
let page = '';
try { page = readFileSync(new URL('../../docs/i18n/term-list.md', import.meta.url), 'utf8'); } catch { /* reported below */ }
ok('4b: the term-list page exists (docs/i18n/term-list.md)', page.length > 0);
const missing = GLOSSARY.flatMap(([term, , t]) => [t?.es, t?.ht].filter((w) => w && !page.includes(w)).map((w) => `${term}: ${w}`));
ok('4c: the term-list page names every fixed word', missing.length === 0, missing.join('; '));
const pinnedMissing = LANGS.flatMap((l) => Object.values(TERM_LINES[l]).filter((w) => !page.includes(w)));
ok('4d: the term-list page names every pinned line', pinnedMissing.length === 0, pinnedMissing.join('; '));

// ── 5. the machine's output holds the term list ───────────────────────────────────────────
// A fake Google that writes what Google is known to write: a verb read as a noun ("Clock in" →
// "Reloj de entrada"), the wrong word ("crew" → "tripulación", "ticket" → "boleto", "punch" →
// "golpe", "checklist" → "lista de tareas"), "usted" for "you", and a masculine article in front of
// a token it cannot read. Tokens it leaves alone, as the real one does.
const NAIVE = {
  es: [[/\bOpen the\b/g, 'Abre el'], [/\bAsk the\b/g, 'Pregunta a el'], [/\bSaved\b/g, 'Guardado'], [/\bClock in\b/g, 'Reloj de entrada'],
    [/\bclock in\b/g, 'fichar'], [/\bYou\b/g, 'Usted'], [/\byou\b/g, 'usted'], [/\bcrew\b/gi, 'tripulación'], [/\btickets?\b/gi, 'boleto'],
    [/\bchecklists?\b/gi, 'lista de tareas'], [/\bpunch(es)?\b/gi, 'golpe'], [/\bbefore\b/g, 'antes de'], [/\bfor\b/g, 'para'],
    [/\bnew\b/g, 'nuevo'], [/\bthe\b/g, 'el'], [/\bcan\b/g, 'puede'], [/\bnow\b/g, 'ahora'], [/\bstart\b/g, 'empezar']],
  ht: [[/\bOpen the (\{\d+\})/g, 'Louvri $1 la'], [/\bclock in\b/gi, 'rele antre'], [/\bcrew\b/gi, 'ekipaj'], [/\btickets?\b/gi, 'tikè'],
    [/\bpunch(es)?\b/gi, 'kout pwen'], [/\bYou can\b/g, 'Ou ka'], [/\bnow\b/g, 'kounye a']],
};
const google = { sent: [] };
globalThis.fetch = async (_url, init) => {
  const req = JSON.parse(init.body);
  google.sent.push(...req.q);
  const say = (q) => NAIVE[req.target].reduce((t, [re, to]) => t.replace(re, to), q);
  return { ok: true, status: 200, json: async () => ({ data: { translations: req.q.map((q) => ({ translatedText: say(q) })) } }) };
};
let store = null;
try { store = await import('../api/_lib/translateStore.js'); } catch { /* the pre-CS-851 tree: reported below */ }
ok('5: the server\'s translation function loads (api/_lib/translateStore.js)', !!store);
if (store && terms) {
  process.env.GOOGLE_TRANSLATE_API_KEY = 'AIzaFAKE-terms-0123456789';
  resetWorld({ tables: { machine_translations: [] } });
  const say = async (lang, line) => (await store.translateAll(lang, [line], { report: () => {} }))[0];
  const word = (en, lang) => terms.PROTECTED_TERMS.find((x) => x.en === en)[lang];
  google.sent = [];
  const open = await say('es', 'Open the checklist');
  ok('5a: a protected noun reaches Google as a token, never as the English word',
    google.sent.length === 1 && !/checklist/i.test(google.sent[0]) && /\{0\}/.test(google.sent[0]), JSON.stringify(google.sent));
  ok('5b: …and comes back as the agreed word, the article put right for it (Abre LA lista)',
    open === `Abre la ${word('checklist', 'es')}`, open);
  const crew = await say('es', 'Ask the crew');
  ok('5c: crew is the term list\'s word, never "tripulación" (and "a el" stays as Google wrote it, the noun is right)',
    crew?.includes(word('crew', 'es')) && !/tripulaci/i.test(crew), crew);
  const many = await say('es', 'Saved: tickets and punches for the crew');
  ok('5d: every protected noun in a line is its agreed word', [word('tickets', 'es'), word('punches', 'es'), word('crew', 'es')].every((w) => many?.includes(w))
    && !/boleto|golpe|tripulaci/i.test(many), many);
  const verb = await say('es', 'You can clock in now');
  ok('5e: a verb Google got wrong ("fichar") and the reader\'s "usted" are repaired', /marcar/.test(verb || '') && !/fich|usted/i.test(verb || ''), verb);
  const button = await say('es', 'Clock in before you start');
  ok('5f: "Reloj de entrada" is repaired to the verb', /^Marcar entrada/.test(button || '') && !/reloj/i.test(button || ''), button);
  const htOpen = await say('ht', 'Open the checklist');
  ok('5g: Creole — the agreed noun with its own determiner after it (lis verifikasyon AN)', htOpen === `Louvri ${word('checklist', 'ht')} an`, htOpen);
  const htVerb = await say('ht', 'You can clock in now');
  ok('5h: Creole — "rele antre" (rele is to call) is repaired to make antre', /make antre/.test(htVerb || '') && !/rele/.test(htVerb || ''), htVerb);
  const htMany = await say('ht', 'tickets and punches for the crew');
  ok('5i: Creole — every protected noun is its agreed word', [word('tickets', 'ht'), word('punches', 'ht'), word('crew', 'ht')].every((w) => htMany?.includes(w))
    && !/tikè|kout pwen|ekipaj/.test(htMany || ''), htMany);
  const outs = [open, crew, many, verb, button, htOpen, htVerb, htMany];
  const leaks = outs.flatMap((o, i) => terms.forbiddenHits(i < 5 ? 'es' : 'ht', o || '').map((r) => `${o} [rule ${r}]`));
  ok('5j: no line the machine answers uses a word the term list forbids', leaks.length === 0, leaks.join('; '));
  for (const lang of LANGS) {
    ok(`5k: a pinned line (${lang}) is the term list's, whatever Google would say`,
      (await say(lang, en['clock.out'])) === TERM_LINES[lang]['clock.out']);
  }
  const notOurs = await say('es', 'Clean the windows');
  ok('5l: a word that is also a verb is never protected ("Clean the windows" goes to Google as written)',
    google.sent.includes('Clean the windows') && !!notOurs, JSON.stringify(google.sent.slice(-2)));
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
}
const protectedWords = (terms?.PROTECTED_TERMS || []).flatMap((x) => [x.es, x.ht]);
const unlisted = protectedWords.filter((w) => !page.includes(w));
ok('5m: every protected noun\'s Spanish and Creole word is on the term-list page', protectedWords.length > 0 && unlisted.length === 0, unlisted.join('; '));

console.log(`\ntest-i18n-terms: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
