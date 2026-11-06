// npm --prefix app run i18n:export [-- --out <file.xlsx>]
//
// The REVIEW SPREADSHEET (CS-193): every line of the app's own wording beside its Spanish and
// Haitian Creole — Google Cloud Translation's lines, held to the term list. OPTIONAL (CS-851): the
// system translates every line itself, including any added or reworded later
// (api/_lib/translateStore.js), and nothing waits for this sheet; it is for anyone who wants to read
// the wording or correct a line. ONE .xlsx, three sheets:
//
//   Read me     — how to fill it in, in plain words (what a placeholder is, what a hard limit
//                 means, that Creole should be short because an icon carries the meaning).
//   Translate   — one line per piece of wording the app shows: the key (leave it alone), the
//                 English, where it shows, its length limit, its placeholders and what each
//                 stands for, notes — and a Spanish and a Haitian Creole column to fill in,
//                 already holding whatever is translated. A plural is one line per form.
//   Glossary    — the app's own words (clean, checklist, clock in, supervisor, …) with the ONE
//                 Spanish and ONE Creole word the term list fixes for each (i18n-lib GLOSSARY).
//
// The corrected file goes back in with `npm --prefix app run i18n:import -- <file> --lang es`,
// which writes the Spanish into src/i18n/catalog/es.js (and `--lang ht` the Creole), refusing
// any line whose placeholders do not match the English, or that a customer reads (LANG-8).
//
// Offline and read-only apart from the one file it writes (default: translations-<date>.xlsx
// in the current directory). Never writes a catalog.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITY } from '../src/brand/identity.generated.js';
import {
  loadCatalogs, readCatalogNotes, scanKeyUses, screenOf, lengthGuide, placeholderMeaning,
  formatMeaning, GLOSSARY, LANGUAGE_NAMES, isEnglishOnly,
} from './i18n-lib.mjs';
import { writeXlsx } from './xlsx-lib.mjs';

const PLURAL_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
const FORM_NAMES = {
  one: 'the number is 1', other: 'any other number', zero: 'the number is 0',
  two: 'the number is 2', few: 'a few', many: 'many',
};

function parseArgs(argv) {
  const out = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[i + 1];
    else if (argv[i].startsWith('--out=')) out.out = argv[i].slice(6);
  }
  return out;
}

const isPlural = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The rows of the Translate sheet, as plain data (the round-trip test reads them too).
export async function buildRows({ catalogs = null, dir } = {}) {
  const cats = catalogs || await loadCatalogs(dir);
  const { en } = cats;
  const notes = readCatalogNotes(dir);
  const { uses } = await scanKeyUses(new Set(Object.keys(en)));
  const { placeholdersOf } = await import('../src/i18n/core.js');
  const rows = [];
  for (const [key, value] of Object.entries(en)) {
    const n = notes.get(key) || { max: null, ph: {}, note: [], icon: false, section: '' };
    const where = [...new Set([...(uses.get(key) || [])].map(screenOf))].join('; ') || n.section;
    const forms = isPlural(value)
      ? PLURAL_ORDER.filter((cat) => typeof value[cat] === 'string').map((cat) => [cat, value[cat]])
      : [['', value]];
    for (const [form, english] of forms) {
      const phs = placeholdersOf(english);
      const phText = phs.map((ph) => {
        if (ph.startsWith('<')) return `${ph}…</${ph.slice(1)} — keep these marks around the same words (they make them bold)`;
        const [name, type] = ph.split(',');
        const meaning = placeholderMeaning(name, n) || '';
        const fmt = type ? formatMeaning(type) : null;
        return `{${type ? `${name}, ${type}` : name}} — ${[meaning, fmt].filter(Boolean).join('; ')}`;
      }).join('\n');
      const notesOut = [...n.note];
      if (form) notesOut.unshift(`Plural form: used when ${FORM_NAMES[form] || form}.`);
      if (isEnglishOnly(key)) notesOut.unshift('Stays English: a customer reads it (LANG-8). Leave the Spanish and Creole blank; the import refuses them.');
      const creole = [];
      if (n.icon) creole.push('An icon sits beside this text: keep it as short as possible — the icon carries the meaning (LANG-9).');
      if (n.max && n.max <= 16) creole.push('Very little room: one or two short words.');
      // What is already translated for this line, so a re-export shows the wording the app
      // uses today (and a half-checked sheet can go back out).
      const translated = (lang) => {
        const t = cats[lang]?.[key];
        if (t == null) return '';
        if (isPlural(t)) return typeof t[form || 'other'] === 'string' ? t[form || 'other'] : '';
        return typeof t === 'string' ? t : '';
      };
      rows.push({
        key, form, english, where,
        limit: lengthGuide(english, n.max),
        placeholders: phText,
        notes: notesOut.join('\n'),
        creoleNotes: creole.join('\n'),
        es: translated('es'),
        ht: translated('ht'),
      });
    }
  }
  return rows;
}

export const COLUMNS = [
  { id: 'key', header: 'Key (do not change)', width: 34, muted: true },
  { id: 'form', header: 'Form', width: 8, muted: true },
  { id: 'english', header: 'English', width: 48 },
  { id: 'es', header: `${LANGUAGE_NAMES.es} (fill in)`, width: 48, fill: true },
  { id: 'ht', header: `${LANGUAGE_NAMES.ht} (fill in)`, width: 48, fill: true },
  { id: 'where', header: 'Where it shows', width: 30 },
  { id: 'limit', header: 'Length limit', width: 26 },
  { id: 'placeholders', header: 'Placeholders — keep exactly as written', width: 44 },
  { id: 'notes', header: 'Notes', width: 40 },
  { id: 'creoleNotes', header: 'Notes for Creole', width: 36 },
];

const README = [
  ['OPTIONAL', 'The app translates its own wording itself — Google Cloud Translation, held to the term list on the "Glossary" sheet — every line, and any line added or changed later, without anyone filling in this sheet. The Spanish and Haitian Creole columns show the wording the app uses today. Use this sheet only to read it, or to correct a line that reads wrong.'],
  ['ONE LINE = ONE PIECE OF WORDING', 'The English column is what the app shows today. Write the translation in the yellow column on the same line. Leave a cell empty if you are not sure — the app shows the English there until it is filled in.'],
  ['DO NOT CHANGE', 'The "Key" column. It is how the app finds the line. Do not add, delete or reorder lines.'],
  ['PLACEHOLDERS', 'Words in curly brackets, like {customer} or {start, time}, are filled in by the app (a customer’s name, a time). Copy them into your translation EXACTLY as written — same spelling, same brackets, same comma and word after the comma — and move them to wherever they belong in your sentence. A line whose placeholders do not match the English is refused when it is loaded back.'],
  ['BOLD MARKS', 'Some lines carry <b> and </b> around a few words: those words are shown in bold. Keep the two marks around the same words in your translation.'],
  ['PLURALS', 'Some wording comes in two forms, one per line, with "one" or "other" in the Form column: "one" is used when the number is 1, "other" for any other number. Translate both.'],
  ['LENGTH', 'The "Length limit" column says how much room there is. "N characters at most" is a hard limit: a button or tab that cannot grow — please stay within it. Everything else wraps onto a second line, and the number is only a guide.'],
  ['TONE', 'Short, plain and friendly. Most readers are cleaners on a phone, often outdoors or in a hurry. Use "you" (tú / ou), not formal address, unless the English is addressed to the office.'],
  ['CREOLE (LANG-9)', 'For Haitian Creole especially: short labels. Where the "Notes for Creole" column says an icon sits beside the text, the icon carries the meaning — one or two words is best.'],
  ['GLOSSARY', 'The "Glossary" sheet lists the app’s own words (a "clean", "clock in", "checklist", …) with the ONE Spanish and ONE Creole word fixed for each. Use that word everywhere, so the app is consistent; to change one, change it on every line.'],
  ['NAMES STAY AS WRITTEN', 'Customer names, people’s names, building and area names, and anything a person typed are never translated; they reach the app as they are.'],
  ['SEND IT BACK', `Save as .xlsx (or CSV) and send it back. ${IDENTITY.name} loads it into the app with one command.`],
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = await buildRows();
  const out = path.resolve(args.out || `translations-${new Date().toISOString().slice(0, 10)}.xlsx`);
  writeXlsx(out, [
    { name: 'Read me', columns: [{ header: 'What', width: 34 }, { header: 'How', width: 110 }], rows: README },
    { name: 'Translate', columns: COLUMNS, rows: rows.map((r) => COLUMNS.map((c) => r[c.id] ?? '')) },
    {
      name: 'Glossary',
      columns: [
        { header: 'Term (English)', width: 26 }, { header: 'What it means in this app', width: 70 },
        { header: `${LANGUAGE_NAMES.es} (term list)`, width: 28 }, { header: `${LANGUAGE_NAMES.ht} (term list)`, width: 28 },
      ],
      rows: GLOSSARY.map(([term, meaning, words]) => [term, meaning, words?.es || '', words?.ht || '']),
    },
  ]);
  const keys = new Set(rows.map((r) => r.key)).size;
  const done = (lang) => rows.filter((r) => r[lang]).length;
  console.log(`i18n:export → ${out}`);
  console.log(`  ${keys} keys, ${rows.length} lines (plurals are one line per form)`);
  console.log(`  already translated: Spanish ${done('es')}/${rows.length} · Creole ${done('ht')}/${rows.length}`);
  return 0;
}

// Run as a command; imported (the round-trip test), it only exports.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
