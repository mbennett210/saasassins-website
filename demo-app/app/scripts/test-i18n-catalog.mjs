// CS-193 — the translation CATALOGS hold together (the run-tests check the brief asks for).
//
//   A. every catalog key the code names exists in English, and no code builds a key at run
//      time (a built key cannot be checked, exported to the translator or found again);
//   B. every English key is used somewhere (replace means delete, THE LAW II.5);
//   C. the English is well-formed: text or a plural with an `other`, and every placeholder
//      says what it stands for (the key's own @ph, else the shared glossary), every format
//      is one the renderer knows, and a hard @max fits its own English;
//   D. the translator notes in en.js are READ for every key (the export relies on it);
//   E. every Spanish and Creole line is for a real key and keeps EXACTLY the English
//      placeholders and tags — the import refuses a line that doesn't, and this fails the
//      build on one that slipped in by hand.
//
// Offline. Run: node scripts/test-i18n-catalog.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// Imported dynamically, so the pre-change tree (no src/i18n) reports each check as failed
// rather than dying on the first import.
let lib = null; let core = null; let cats = null;
try { lib = await import('./i18n-lib.mjs'); } catch { /* pre-change tree */ }
try { core = await import('../src/i18n/core.js'); } catch { /* pre-change tree */ }
try { cats = lib ? await lib.loadCatalogs() : null; } catch { /* pre-change tree */ }
ok('the i18n tooling loads (scripts/i18n-lib.mjs)', !!lib);
ok('the i18n core loads (src/i18n/core.js)', !!core);
ok('the three catalogs load (en, es, ht)', !!cats && !!cats.en && !!cats.es && !!cats.ht);

const en = cats?.en || {};
const enKeys = new Set(Object.keys(en));
const CLDR = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const isPlural = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ── A. every key the code names exists; no built keys ──────────────────────────────────
const scan = lib ? await lib.scanKeyUses(enKeys) : { uses: new Map(), unknown: [{ key: '(no tooling)' }], dynamic: [], unparsed: [] };
ok(`A0: every app/src and app/api file tokenizes, so the scan saw all of it (unparsed: ${scan.unparsed.join(', ') || 'none'})`,
  scan.unparsed.length === 0);
ok(`A1: every catalog key the code names exists in English (unknown: ${scan.unknown.map((u) => `${u.key} in ${u.file}`).join(', ') || 'none'})`,
  scan.unknown.length === 0);
ok(`A2: no t() / msg() / english() call builds its key at run time (${scan.dynamic.map((d) => `${d.file}: ${d.at}`).join(' | ') || 'none'})`,
  scan.dynamic.length === 0);
ok('A3: the English catalog is not empty', enKeys.size > 50);

// ── B. no orphan English ────────────────────────────────────────────────────────────────
const unused = [...enKeys].filter((k) => !scan.uses.has(k));
ok(`B1: every English key is used by the app (unused: ${unused.join(', ') || 'none'})`, unused.length === 0);

// ── C. well-formed English ──────────────────────────────────────────────────────────────
const notes = lib ? lib.readCatalogNotes() : new Map();
const formats = new Set(core?.PLACEHOLDER_FORMATS || []);
const badShape = [];
const noMeaning = [];
const badFormat = [];
const overMax = [];
for (const [key, value] of Object.entries(en)) {
  if (typeof value === 'string') { if (!value.trim()) badShape.push(key); }
  else if (isPlural(value)) {
    if (typeof value.other !== 'string' || !value.other.trim()) badShape.push(key);
    for (const [cat, s] of Object.entries(value)) if (!CLDR.has(cat) || typeof s !== 'string') badShape.push(`${key}[${cat}]`);
  } else badShape.push(key);
  for (const text of core ? core.entryTexts(value) : []) {
    for (const ph of core.placeholdersOf(text)) {
      if (ph.startsWith('<')) continue;
      const [name, type] = ph.split(',');
      if (!lib?.placeholderMeaning(name, notes.get(key))) noMeaning.push(`${key} {${name}}`);
      if (type && !formats.has(type)) badFormat.push(`${key} {${ph}}`);
    }
    const max = notes.get(key)?.max;
    if (max) {
      // A hard limit is measured on what is SHOWN: placeholders count as their typical width.
      const shown = text.replace(/<\/?[a-z]+>/g, '').replace(/\{[^}]*\}/g, '0000');
      if (shown.length > max) overMax.push(`${key} (${shown.length} > ${max})`);
    }
  }
}
ok(`C1: every English entry is text, or a plural with an "other" (bad: ${badShape.join(', ') || 'none'})`, badShape.length === 0);
ok(`C2: every English placeholder says what it stands for (missing: ${[...new Set(noMeaning)].join(', ') || 'none'})`, noMeaning.length === 0);
ok(`C3: every {name, format} is a format the renderer knows (bad: ${badFormat.join(', ') || 'none'})`, badFormat.length === 0);
ok(`C4: an English line fits its own hard @max (over: ${overMax.join(', ') || 'none'})`, overMax.length === 0);

// ── D. the notes parse for every key ────────────────────────────────────────────────────
const noteKeys = new Set(notes.keys());
const unparsed = [...enKeys].filter((k) => !noteKeys.has(k));
const phantom = [...noteKeys].filter((k) => !enKeys.has(k));
ok(`D1: every English key is found as a key line in en.js (unparsed: ${unparsed.join(', ') || 'none'})`, unparsed.length === 0);
ok(`D2: the parser finds no key the module lacks (phantom: ${phantom.join(', ') || 'none'})`, phantom.length === 0);
// A source pin on the format the parser and the export rely on.
let enSrc = '';
try { enSrc = readFileSync(path.join(lib?.CATALOG_DIR || '.', 'en.js'), 'utf8').replace(/\r\n/g, '\n'); } catch { /* pre-change tree: D3 reports it */ }
ok('D3: en.js documents its own format and note tags', /@max/.test(enSrc) && /@ph/.test(enSrc) && /@note/.test(enSrc) && /@icon/.test(enSrc));

// ── E. translations keep the English shape ──────────────────────────────────────────────
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
for (const lang of ['es', 'ht']) {
  const dict = cats?.[lang] || {};
  const orphans = Object.keys(dict).filter((k) => !enKeys.has(k));
  ok(`E1 ${lang}: every line is for a real English key (orphans: ${orphans.join(', ') || 'none'})`, orphans.length === 0);
  const mismatch = [];
  for (const [key, value] of Object.entries(dict)) {
    const source = en[key];
    if (source == null) continue;
    if (isPlural(source) !== isPlural(value)) { mismatch.push(`${key} (plural vs text)`); continue; }
    const pairs = isPlural(value)
      ? Object.entries(value).map(([cat, s]) => [s, source[cat] ?? source.other, `${key}[${cat}]`])
      : [[value, source, key]];
    for (const [tr, src, label] of pairs) {
      if (typeof tr !== 'string') { mismatch.push(`${label} (not text)`); continue; }
      if (!tr.trim()) continue; // a blank line is "not translated yet" and falls back to English
      if (!sameSet(core.placeholdersOf(tr), core.placeholdersOf(src))) mismatch.push(label);
    }
  }
  ok(`E2 ${lang}: every translation keeps the English placeholders and tags (mismatched: ${mismatch.join(', ') || 'none'})`, mismatch.length === 0);
}

// ── the renderer itself, on the real catalog ────────────────────────────────────────────
if (core) {
  ok('R1: a key renders its English', core.english('common.cancel') === en['common.cancel']);
  ok('R2: an unknown key renders nothing — never its own name', core.translate('es', 'no.such.key') === '');
}

console.log(`\ntest-i18n-catalog: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
