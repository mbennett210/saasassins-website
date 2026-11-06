// npm --prefix app run i18n:import -- <returned-file.xlsx|.csv> [--lang es|ht] [--dry-run] [--allow-stale]
//
// Loads a filled-in translation sheet (CS-193) into the app: the Spanish column into
// src/i18n/catalog/es.js (`--lang es`, the default) or the Haitian Creole column into ht.js
// (`--lang ht`). The sheet is the one `npm --prefix app run i18n:export` wrote, or a CSV with
// its Key / Form / English / language columns (the S129 machine pass loaded Google Cloud
// Translation's drafts, after the term-list cleanup, that way).
//
// Every line is checked before anything is written, and a line that fails is REFUSED — the
// rest still load, and the refusals are listed so they can be fixed in the sheet and
// imported again:
//   • unknown-key       the key is not in the English catalog (renamed or never existed)
//   • english-only      a line a CUSTOMER reads (LANG-8: the quote and report pages, the hub
//                       tile — i18n-lib ENGLISH_ONLY_PREFIXES), which stays English
//   • bad-form          a plural form on a line that has none, or a form the language lacks
//   • placeholders      the translation does not keep EXACTLY the English placeholders and
//                       bold marks ({customer}, {start, time}, <b>…</b>) — the brief's rule
//   • english-changed   the English in the sheet is not today's English: the line was
//                       reworded after the sheet went out, so the translation is of old
//                       wording (re-export to get the new line; --allow-stale loads it anyway)
// A blank cell is "not translated yet" and changes nothing (the app keeps showing English).
// A line longer than its hard limit is loaded but WARNED about — the layout may not fit it.
//
// Writes the one catalog file and the source map beside it (unless --dry-run): every line loaded
// is stamped with the English it was translated from (src/i18n/catalog/sources.js, CS-851), so
// when that English later moves on the server translates the new English itself. A line loaded
// against OLD English (--allow-stale) is stamped as never matching, so the server re-translates
// it. Offline. Exit 0 = everything loaded; 1 = something was refused (the accepted lines are still
// written).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_DIR, TARGET_LANGUAGES, LANGUAGE_NAMES, loadCatalog, readCatalogNotes, isEnglishOnly } from './i18n-lib.mjs';
import { readXlsx, parseCsv } from './xlsx-lib.mjs';
import { writeSources } from './i18n-sources.mjs';
import { sourceHashOf, STALE_SOURCE } from '../api/_lib/i18nSource.js';

const CLDR = ['zero', 'one', 'two', 'few', 'many', 'other'];
const isPlural = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

export function parseArgs(argv) {
  const out = { file: null, lang: 'es', dryRun: false, allowStale: false, catalogDir: CATALOG_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lang') out.lang = argv[++i];
    else if (a.startsWith('--lang=')) out.lang = a.slice(7);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--allow-stale') out.allowStale = true;
    else if (a === '--catalog-dir') out.catalogDir = argv[++i];
    else if (a.startsWith('--catalog-dir=')) out.catalogDir = a.slice(14);
    else if (!a.startsWith('--')) out.file = a;
  }
  return out;
}

// The rows of the returned file as { key, form, english, text } for the chosen language.
export function readReturnedRows(file, lang) {
  const sheets = /\.csv$/i.test(file)
    ? [{ name: 'Translate', rows: parseCsv(readFileSync(file, 'utf8')) }]
    : readXlsx(file);
  const header = (rows) => (rows[0] || []).map((h) => String(h || '').trim().toLowerCase());
  const sheet = sheets.find((s) => s.name.toLowerCase() === 'translate')
    || sheets.find((s) => header(s.rows).some((h) => h.startsWith('key')));
  if (!sheet) throw new Error('no "Translate" sheet (or any sheet with a Key column) in the file');
  const h = header(sheet.rows);
  const col = (pred) => h.findIndex(pred);
  const keyCol = col((x) => x.startsWith('key'));
  const formCol = col((x) => x === 'form');
  const enCol = col((x) => x === 'english');
  const name = LANGUAGE_NAMES[lang].toLowerCase();
  const langCol = col((x) => x === lang || x.startsWith(name) || (lang === 'ht' && (x.startsWith('creole') || x.startsWith('kreyòl'))) || (lang === 'es' && x.startsWith('español')));
  if (keyCol < 0) throw new Error('the sheet has no Key column');
  if (langCol < 0) throw new Error(`the sheet has no ${LANGUAGE_NAMES[lang]} column`);
  return sheet.rows.slice(1)
    .map((r, i) => ({
      row: i + 2,
      key: String(r[keyCol] ?? '').trim(),
      form: formCol >= 0 ? String(r[formCol] ?? '').trim().toLowerCase() : '',
      english: enCol >= 0 ? r[enCol] : null,
      text: r[langCol] ?? '',
    }))
    .filter((r) => r.key);
}

// The decision for every row, pure: what loads, what is refused and why, what is warned.
export async function planImport({ rows, lang, en, current, notes, allowStale = false }) {
  const { placeholdersOf } = await import('../src/i18n/core.js');
  const next = JSON.parse(JSON.stringify(current || {}));
  const report = { loaded: [], unchanged: 0, empty: 0, refused: [], warnings: [] };
  for (const r of rows) {
    const text = norm(r.text);
    if (!text) { report.empty += 1; continue; }
    const source = en[r.key];
    if (source == null) { report.refused.push({ ...r, reason: 'unknown-key' }); continue; }
    if (isEnglishOnly(r.key)) { report.refused.push({ ...r, reason: 'english-only' }); continue; }
    if (isPlural(source) ? !CLDR.includes(r.form || 'other') : !!r.form) {
      report.refused.push({ ...r, reason: 'bad-form', detail: r.form || '(none)' });
      continue;
    }
    const form = isPlural(source) ? (r.form || 'other') : '';
    const english = isPlural(source) ? (source[form] ?? source.other) : source;
    const stale = r.english != null && !!norm(r.english) && norm(r.english) !== norm(english);
    if (stale && !allowStale) {
      report.refused.push({ ...r, reason: 'english-changed', detail: `the sheet says "${norm(r.english)}", the app now says "${english}"` });
      continue;
    }
    const want = placeholdersOf(english);
    const got = placeholdersOf(text);
    if (want.length !== got.length || want.some((p, i) => p !== got[i])) {
      report.refused.push({ ...r, reason: 'placeholders', detail: `needs ${want.join(' ') || '(none)'}, has ${got.join(' ') || '(none)'}` });
      continue;
    }
    const max = notes.get(r.key)?.max;
    if (max) {
      const shown = text.replace(/<\/?[a-z]+>/g, '').replace(/\{[^}]*\}/g, '0000');
      if (shown.length > max) report.warnings.push({ ...r, detail: `${shown.length} characters, the space holds ${max}` });
    }
    const before = form ? next[r.key]?.[form] : next[r.key];
    if (before === text) { report.unchanged += 1; continue; }
    if (form) next[r.key] = { ...(isPlural(next[r.key]) ? next[r.key] : {}), [form]: text };
    else next[r.key] = text;
    report.loaded.push({ key: r.key, form, text, ...(stale ? { stale: true } : {}) });
  }
  return { next, report };
}

// The source each loaded key is stamped with: the English it was checked against today, or — when
// any of its rows was loaded against older English (--allow-stale) — a stamp that never matches.
export function sourceStamps(lang, loaded, en) {
  const stale = new Set(loaded.filter((l) => l.stale).map((l) => l.key));
  return new Map([...new Set(loaded.map((l) => l.key))].map((key) => [`${lang}:${key}`, stale.has(key) ? STALE_SOURCE : sourceHashOf(en[key])]));
}

// The catalog file, written in the English catalog's key order so a diff reads line by line.
export function renderCatalog(lang, dict, enOrder) {
  const order = [...enOrder.filter((k) => k in dict), ...Object.keys(dict).filter((k) => !enOrder.includes(k)).sort()];
  const q = (s) => JSON.stringify(s);
  const lines = order.map((k) => {
    const v = dict[k];
    if (isPlural(v)) {
      const forms = CLDR.filter((c) => typeof v[c] === 'string').map((c) => `${c}: ${q(v[c])}`).join(', ');
      return `  ${q(k)}: { ${forms} },`;
    }
    return `  ${q(k)}: ${q(v)},`;
  });
  const machinePass = `// Google Cloud Translation's lines, held to the term list (docs/i18n/term-list.md, applied by
// src/i18n/terms.js; scripts/test-i18n-terms.mjs holds it). No person checks them (CS-851): a
// line added or reworded in en.js after this file was written is translated by the server itself
// (api/_lib/translateStore.js, GET /api/i18n/lines) until an import brings it here, and the
// source map beside this file (sources.js) records the English each line here was made from.
// Every key missing here shows the server's line, else its English; the lines a customer reads
// (LANG-8) are never here. Keyed exactly like catalog/en.js. Do not hand-edit: a line goes
// through \`i18n:import\`, so every line is checked the same way.`;
  const head = lang === 'es'
    ? `// SPANISH — written by \`npm --prefix app run i18n:import -- <file> --lang es\`.
${machinePass}
//
// The HR warning form's lines (hrWarn.form.*, hrWarn.reason.*) are MATT'S OWN SPANISH, from
// Clean Space's "Formulario de advertencia" (2026-10-05): the client's wording, copied word
// for word, which the export shows already filled in. scripts/test-hr-warnings.mjs holds them
// to his form (scripts/fixtures/hr-warning-form.json).`
    : `// HAITIAN CREOLE — written by \`npm --prefix app run i18n:import -- <file> --lang ht\`
// (LANG-9: short labels, with the icon beside them carrying the meaning).
${machinePass}`;
  return `${head}\nexport default {\n${lines.join('\n')}${lines.length ? '\n' : ''}};\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('usage: npm --prefix app run i18n:import -- <file.xlsx|file.csv> [--lang es|ht] [--dry-run] [--allow-stale]');
    return 2;
  }
  if (!TARGET_LANGUAGES.includes(args.lang)) {
    console.error(`--lang must be one of ${TARGET_LANGUAGES.join(', ')}`);
    return 2;
  }
  const en = await loadCatalog('en', args.catalogDir);
  const current = await loadCatalog(args.lang, args.catalogDir);
  const notes = readCatalogNotes(args.catalogDir);
  const rows = readReturnedRows(path.resolve(args.file), args.lang);
  const { next, report } = await planImport({ rows, lang: args.lang, en, current, notes, allowStale: args.allowStale });
  const target = path.join(args.catalogDir, `${args.lang}.js`);
  if (!args.dryRun && report.loaded.length) {
    writeFileSync(target, renderCatalog(args.lang, next, Object.keys(en)));
    await writeSources(args.catalogDir, { restamp: sourceStamps(args.lang, report.loaded, en) });
  }
  console.log(`i18n:import ${LANGUAGE_NAMES[args.lang]} ← ${args.file}${args.dryRun ? ' (dry run — nothing written)' : ''}`);
  console.log(`  loaded ${report.loaded.length} · unchanged ${report.unchanged} · blank ${report.empty} · refused ${report.refused.length} · warnings ${report.warnings.length}`);
  if (report.loaded.length && !args.dryRun) console.log(`  wrote ${path.relative(process.cwd(), target)}`);
  for (const r of report.refused) console.log(`  ✖ row ${r.row} ${r.key}${r.form ? ` [${r.form}]` : ''}: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
  for (const w of report.warnings) console.log(`  ⚠ row ${w.row} ${w.key}${w.form ? ` [${w.form}]` : ''}: too long — ${w.detail}`);
  return report.refused.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`i18n:import failed: ${e.message}`); process.exitCode = 2; });
}
