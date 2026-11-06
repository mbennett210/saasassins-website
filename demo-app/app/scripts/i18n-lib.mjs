// The translation layer's TOOLING half (CS-193): what the translator's spreadsheet is built
// from, and what the catalog tests read. Node only — nothing here ships.
//
//   loadCatalogs()            { en, es, ht } — the very modules the app renders from
//   readCatalogNotes()        key → { max, ph, note, icon, section } from en.js's `// @` comments
//   scanKeyUses()             key → the files that use it, + any dynamic (non-literal) key use
//   placeholderMeaning()      what `{name}` stands for (the key's @ph, else the glossary)
//   GLOSSARY / screenOf / lengthGuide — what the export puts in front of the translator
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOG_DIR = path.join(APP, 'src', 'i18n', 'catalog');
export const TARGET_LANGUAGES = ['es', 'ht'];
export const LANGUAGE_NAMES = { es: 'Spanish', ht: 'Haitian Creole' };

// A fresh import every call (a query string defeats the module cache), so a test that just
// wrote a catalog reads what it wrote.
export async function loadCatalog(lang, dir = CATALOG_DIR) {
  const url = pathToFileURL(path.join(dir, `${lang}.js`)).href + `?t=${Date.now()}-${Math.random()}`;
  return (await import(url)).default;
}
export async function loadCatalogs(dir = CATALOG_DIR) {
  const out = {};
  for (const lang of ['en', ...TARGET_LANGUAGES]) out[lang] = await loadCatalog(lang, dir);
  return out;
}

// ── the translator notes in en.js ───────────────────────────────────────────────────────
// A key line is one that STARTS with `'key':` (two-space indent in the file). Every `// @…`
// comment directly above it (no blank line between) belongs to it; a `// ──` line names the
// section that follows. The catalog test proves every key in the module was found here, so
// a formatting slip cannot silently drop a key's notes.
const KEY_LINE = /^\s*'([^']+)'\s*:/;
export function parseCatalogNotes(text) {
  const notes = new Map();
  let pending = [];
  let section = '';
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\/\/\s*──\s*(.+?)\s*─*$/);
    if (sec) { section = sec[1]; pending = []; continue; }
    if (line.startsWith('// @')) { pending.push(line.slice(3).trim()); continue; }
    const key = raw.match(KEY_LINE);
    if (key) {
      const n = { max: null, ph: {}, note: [], icon: false, section };
      for (const tag of pending) {
        const m = tag.match(/^@(\w+)\s*([\s\S]*)$/);
        if (!m) continue;
        const [, kind, body] = m;
        if (kind === 'max') n.max = Number(body) || null;
        else if (kind === 'icon') n.icon = true;
        else if (kind === 'note') n.note.push(body);
        else if (kind === 'ph') {
          for (const part of body.split(';')) {
            const pm = part.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*([\s\S]+?)\s*$/);
            if (pm) n.ph[pm[1]] = pm[2];
          }
        }
      }
      notes.set(key[1], n);
      pending = [];
      continue;
    }
    if (line && !line.startsWith('//')) pending = [];
  }
  return notes;
}
export function readCatalogNotes(dir = CATALOG_DIR) {
  return parseCatalogNotes(readFileSync(path.join(dir, 'en.js'), 'utf8'));
}

// ── what a placeholder stands for ──────────────────────────────────────────────────────
// The common names, said once. A key's own `@ph` wins. The catalog test fails a placeholder
// that has neither, so a translator is never handed a bare `{x}`.
export const PLACEHOLDER_MEANINGS = {
  count: 'a number',
  name: 'a person’s name',
  place: 'a customer or building name',
  customer: 'a customer (building) name',
  time: 'a time of day, e.g. 9:30 PM',
  date: 'a date, e.g. Oct 3',
  day: 'a day, e.g. Fri, Oct 2',
  duration: 'hours and minutes, e.g. 1h 20m',
  distance: 'a distance, e.g. 340 ft',
  item: 'a checklist item’s wording, as the office wrote it',
  done: 'how many are finished',
  total: 'how many there are in all',
  label: 'a name shown above it',
  n: 'a position, e.g. the 2nd',
  days: 'a number of days',
  address: 'a street address',
  error: 'the reason it failed, in English, from the server',
  language: 'a language name, written in that language',
  ticket: 'a ticket’s title, as written by whoever raised it',
  when: 'a time of day, e.g. 9:30 PM',
  who: 'one or more people’s names',
  areas: 'the names of areas in a building, as the office wrote them',
  amount: 'an amount of money, e.g. $1,250.00',
  budget: 'an amount of money, e.g. $1,250.00',
  priority: 'a ticket priority (Low, Medium or Urgent)',
  reason: 'the reason, already in the reader’s language',
  orderDay: 'a day of the month, e.g. 1st or 15th',
  file: 'a file name',
  minutes: 'a number of minutes',
  hours: 'a number of hours',
  checklist: 'a checklist’s name, as the office wrote it',
  title: 'a title, as written by whoever wrote it',
  body: 'a message’s text, as written by whoever wrote it',
};
const FORMAT_MEANINGS = {
  time: 'shown as a time of day, e.g. 9:30 PM',
  date: 'shown as a short date, e.g. Oct 3',
  weekday: 'shown as a short day and date, e.g. Fri, Oct 2',
  dateLong: 'shown as a long date, e.g. Friday, October 2',
  number: 'shown as a number',
  duration: 'shown as hours and minutes, e.g. 1h 20m',
  list: 'shown as a list, e.g. "Ana, Luis and Rosa"',
};
export function placeholderMeaning(name, keyNotes) {
  return keyNotes?.ph?.[name] || PLACEHOLDER_MEANINGS[name] || null;
}
export function formatMeaning(type) { return FORMAT_MEANINGS[type] || null; }

// ── where a key is used ─────────────────────────────────────────────────────────────────
// Every string literal in app/src and app/api that IS a catalog key (a dotted name whose
// first segment is one of the catalog's namespaces), and every call that hands t() / msg()
// / english() a key it builds at run time (a template literal or a `+`) — which the tests
// refuse, because a built key cannot be checked, exported or found.
const SCAN_ROOTS = ['src', 'api'];
const SCAN_EXT = /\.(jsx?|mjs)$/;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.test(name)) out.push(p);
  }
  return out;
}
export function sourceFiles() {
  return SCAN_ROOTS.flatMap((r) => walk(path.join(APP, r)))
    .filter((p) => !p.startsWith(CATALOG_DIR + path.sep));
}
// The file's TOKENS, from a real JavaScript/JSX tokenizer (espree, eslint's own parser), so
// a key named in a comment is not a use and a `//` or `/*` inside a string or a regex cannot
// swallow the code after it — which a regex over the text did.
export async function tokensOf(src) {
  const espree = await import('espree');
  try {
    return espree.tokenize(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } });
  } catch {
    return null;
  }
}
const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+$/;
const KEY_CALLS = new Set(['t', 'msg', 'english', 'translate', 'rich']);
export async function scanKeyUses(enKeys) {
  const namespaces = new Set([...enKeys].map((k) => k.split('.')[0]));
  const uses = new Map();
  const unknown = [];
  const dynamic = [];
  const unparsed = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(APP, file).split(path.sep).join('/');
    const tokens = await tokensOf(readFileSync(file, 'utf8'));
    if (!tokens) { unparsed.push(rel); continue; }
    tokens.forEach((tok, i) => {
      if (tok.type === 'String' || tok.type === 'JSXText') {
        const key = tok.type === 'String' ? tok.value.slice(1, -1) : tok.value.trim();
        if (!KEY_SHAPE.test(key) || !namespaces.has(key.split('.')[0])) return;
        if (/\.(jsx?|mjs|css|json|md|html|png|svg|sql)$/.test(key)) return; // a file name, not a key
        if (!enKeys.has(key)) { unknown.push({ file: rel, key }); return; }
        if (!uses.has(key)) uses.set(key, new Set());
        uses.get(key).add(rel);
        return;
      }
      // A key BUILT at run time: `t(` / `msg(` / `english(` / `translate(lang, ` / `.rich(`
      // followed by a template literal, or by a string that is then concatenated.
      if (tok.type === 'Identifier' && KEY_CALLS.has(tok.value) && tokens[i + 1]?.value === '(') {
        let j = i + 2;
        if (tok.value === 'translate' && tokens[j]?.type === 'Identifier' && tokens[j + 1]?.value === ',') j += 2;
        const arg = tokens[j];
        const built = arg && ((arg.type === 'Template' && arg.value.includes('${'))
          || (arg.type === 'String' && tokens[j + 1]?.value === '+'));
        if (built) dynamic.push({ file: rel, at: `${tok.value}(${arg.value.slice(0, 40)}` });
      }
    });
  }
  return { uses, unknown, dynamic, unparsed };
}

// ── what the translator sees about WHERE a line shows ───────────────────────────────────
const SCREENS = [
  [/pages\/MyDay\.jsx$/, 'My Day — the cleaner’s Home screen (the Cleaner Hub)'],
  [/pages\/crew\/CrewStops\.jsx$/, 'My Stops Today (cleaner)'],
  [/pages\/crew\/CrewClock\.jsx$|hooks\/useClockActions\.js$/, 'The Clock in / Clock out screen (cleaner)'],
  [/components\/CrewChrome\.jsx$/, 'The cleaner app’s frame (back button, preview line)'],
  [/components\/ClockControl\.jsx$|lib\/clockOutBlock\.js$|lib\/openPunchRule\.js$/, 'The clock-in / clock-out button'],
  [/components\/CrewJobVisit\.jsx$/, 'A clean’s visit steps (cleaner)'],
  [/components\/ChecklistFill\.jsx$/, 'Filling in a checklist (pop-up)'],
  [/components\/ChecklistItemPhoto\.jsx$/, 'A checklist item’s camera button'],
  [/components\/CleanChecklist\.jsx$/, 'A clean’s checklist card'],
  [/components\/OfflineQueueFailures\.jsx$/, 'Items that could not sync (card)'],
  [/components\/MediaGallery\.jsx$/, 'Photos and video'],
  [/components\/AccountNotesPanel\.jsx$/, 'Account notes on a clean'],
  [/components\/StubRecoveryBanner\.jsx$/, 'One-time recovery banner (My Day)'],
  [/components\/(MobileNotificationList|NotificationsBell)\.jsx$/, 'The notifications list (bell)'],
  [/pages\/settings\/Account\.jsx$|components\/LanguageCard\.jsx$/, 'Settings → Your account'],
  [/lib\/notifications\.js$/, 'Notifications: settings list, and alerts as received'],
  [/lib\/(opsAlertCopy|ticketAlerts|preShiftReminders|alertDelivery)\.js$|api\//, 'Alerts: phone notification, bell and text message'],
  [/components\/(Sidebar|FloatingNav|UserSwitcher)\.jsx$|lib\/navData\.js$/, 'Navigation (menu and bottom tabs)'],
  [/pages\/Messaging\.jsx$|components\/(Conversation|Messag|NewDm|NewInternal)/, 'Messages'],
  [/pages\/Approvals\.jsx$/, 'Approvals — the supervisor’s time desk'],
  [/components\/InspectionFill\.jsx$/, 'Filling in an inspection (supervisor)'],
  [/pages\/TimeClock\.jsx$|components\/(TimeClockHistory|TimeEntryModal)\.jsx$/, 'Time clock (supervisor)'],
  [/components\/checklists\//, 'Checklist assignments (supervisor)'],
  [/components\/InspectionTemplateEditor\.jsx$|components\/TemplateTranslations\.jsx$/, 'Checklist editor: translations (office)'],
  [/components\/(Modal|ConfirmDialog|Toast|Select|SearchSelect|PopMenu|MobileSheet)\.jsx$/, 'Shared pop-ups and controls (everywhere)'],
  [/App\.jsx$/, 'Loading screen'],
];
export function screenOf(file) {
  for (const [re, label] of SCREENS) if (re.test(file)) return label;
  return file;
}

// The length guide in the sheet. A hard `@max` is a layout that cannot grow (a bottom tab,
// a chip, a button in a row on a phone); everything else wraps, so the guide is soft —
// about a third longer than the English, which is what Spanish usually needs.
export function lengthGuide(english, max) {
  if (max) return `${max} characters at most (the space cannot grow)`;
  const n = String(english || '').length;
  return `wraps — aim for about ${Math.max(n + 8, Math.ceil(n * 1.35))}`;
}

// The term list (GLOSSARY, TERM_LINES, FORBIDDEN_TERMS) and the English-only rule live in ONE
// module the server reads too (src/i18n/terms.js, CS-851): the machine pass holds every new line to
// the same words the bundled catalogs were held to. Re-exported so the tools read them from here.
export { GLOSSARY, TERM_LINES, FORBIDDEN_TERMS, ENGLISH_ONLY_PREFIXES, isEnglishOnly } from '../src/i18n/terms.js';
