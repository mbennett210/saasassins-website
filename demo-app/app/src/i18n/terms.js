// THE TERM LIST, APPLIED BY CODE (CS-193, CS-851; docs/i18n/term-list.md). ONE module that the
// tooling (the export, the import, the catalog tests) and the SERVER (api/_lib/translateStore.js,
// which machine-translates every line the app adds or rewords) both read, so the words the
// bundled Spanish and Creole were held to are the words every machine line is held to.
// PURE and node-safe; the browser never imports it.
//
//   GLOSSARY          the app's own words, each with its ONE Spanish and ONE Creole word
//   TERM_LINES        whole lines pinned word for word: a machine pass never writes them
//   FORBIDDEN_TERMS   known machine mistakes no line may use
//   PROTECTED_TERMS   English NOUNS swapped for a token before Google and replaced by the agreed
//                     word after (prepareForMachine), so Google never gets to pick the word
//   TERM_FIXES        the mistakes Google still makes from words that cannot be protected (a
//                     verb like "clock in", the reader's "you"), repaired in what it wrote
//   ENGLISH_ONLY_PREFIXES / isEnglishOnly   what a customer reads stays English (LANG-8)
//
// WHY ONLY NOUNS ARE PROTECTED. A token is opaque: Google cannot conjugate it, so a verb ("You
// clocked in at 9") cannot be one, and a word that is also a verb or an adjective ("clean": "Clean
// the windows", "a clean floor") would be replaced where it is not the app's noun. Those words
// are repaired after the fact (TERM_FIXES) or left to Google. Around a protected noun the
// article is put right for the agreed word (Spanish gender and number; the Creole determiner
// after the noun), because Google chose it without knowing what the token stood for.

// The words the app uses for its own things, with the ONE Spanish and ONE Haitian Creole word
// fixed for each (the S129 term list, docs/i18n/term-list.md). The export's Glossary sheet shows
// them, and test-i18n-terms.mjs holds the catalogs, the machine output and the term-list page to
// them.   [term, what it means in this app, { es, ht }]
export const GLOSSARY = [
  ['clean', 'One scheduled cleaning visit at a building (a noun: "Today you have 3 cleans").', { es: 'limpieza', ht: 'netwayaj' }],
  ['cleaner', 'A member of the cleaning crew.', { es: 'limpiador', ht: 'anplwaye netwayaj' }],
  ['crew', 'The cleaners working a clean, together.', { es: 'equipo', ht: 'ekip' }],
  ['supervisor / manager', 'The person in charge of a group of buildings; approves time, gets alerts.', { es: 'supervisor', ht: 'sipèvizè' }],
  ['the office', 'The company’s office staff.', { es: 'la oficina', ht: 'biwo a' }],
  ['customer', 'A building or account the company cleans for.', { es: 'cliente', ht: 'kliyan' }],
  ['building / location', 'The physical place cleaned. One customer usually has one building.', { es: 'edificio / ubicación', ht: 'bilding / kote' }],
  ['area', 'A part of a building on a checklist (lobby, restrooms, kitchen…).', { es: 'área', ht: 'zòn' }],
  ['clock in / clock out', 'Starting and stopping your time at a clean, on the phone.', { es: 'marcar entrada / marcar salida', ht: 'make antre / make sòti' }],
  ['punch', 'One clock-in or clock-out record.', { es: 'marcación', ht: 'pwentaj' }],
  ['shift', 'The scheduled time of a clean.', { es: 'turno', ht: 'orè' }],
  ['checklist', 'The list of tasks a cleaner ticks off on a clean; it must be finished before clocking out.', { es: 'lista de verificación', ht: 'lis verifikasyon' }],
  ['N/A (not applicable)', 'Marks a checklist item that does not apply tonight; only on items the office allows.', { es: 'N/A', ht: 'N/A' }],
  ['inspection', 'A supervisor’s scored check of a building’s cleaning.', { es: 'inspección', ht: 'enspeksyon' }],
  ['ticket / work order', 'A request or complaint from a customer that the team has to deal with.', { es: 'solicitud / orden de trabajo', ht: 'demann / lòd travay' }],
  ['urgent', 'The highest ticket priority: alerts come at any hour and are also texted.', { es: 'urgente', ht: 'ijan' }],
  ['approval', 'A supervisor confirming a punch before it is paid.', { es: 'aprobación', ht: 'apwobasyon' }],
  ['off-site', 'A clock-in or clock-out recorded away from the building.', { es: 'fuera del sitio', ht: 'deyò sit la' }],
  ['covering for', 'Working someone else’s shift for one visit.', { es: 'cubriendo a', ht: 'ap ranplase' }],
  ['My Day', 'The OLD name of the cleaner’s home screen. Since the Cleaner Hub (2026-10-14) the screen is Home (Inicio / Akèy); only the crew nav model still carries the words.', { es: 'Mi día', ht: 'Jounen mwen' }],
  ['stop', 'One building on a cleaner’s day (Home, Today’s Stops).', { es: 'parada', ht: 'arè' }],
  ['account manager', 'The office person who looks after a customer’s buildings and approves a cleaner’s held time and supply requests.', { es: 'gerente de cuenta', ht: 'responsab kont' }],
  ['task (on a checklist)', 'One line of a checklist the cleaner ticks, flags or marks not completed.', { es: 'tarea', ht: 'travay' }],
  ['not completed', 'A task the cleaner could not do, with a short reason; it unlocks Clock Out but is not counted as cleaned.', { es: 'no completado', ht: 'pa fini' }],
  ['hours worked', 'The time on a cleaner’s punches (My Hours). Not a shift.', { es: 'horas', ht: 'lè travay' }],
  ['sync', 'Sending what was saved on the phone to the office once there is a signal.', { es: 'sincronizar', ht: 'senkwonize' }],
  // Settled for the machine pass on 2026-10-15 (the supply orders' lines; Builder C's renderings,
  // docs/i18n/term-list.md): "pedido pendiente" would read as an order still waiting for approval.
  ['backordered', 'A line of a supply order the supplier is out of for now, with a day it expects to deliver.', { es: 'pendiente del proveedor', ht: 'an reta nan men founisè a' }],
  ['ETA', 'The day the supplier expects to deliver a backordered line ("ETA Oct 21").', { es: 'fecha estimada', ht: 'dat prevwa' }],
];

// Whole lines the term list pins: the buttons and titles a cleaner reads most, where a machine
// draft read a verb as a noun ("Clock in" → "Reloj de entrada", "Rele antre"). The catalogs must
// say exactly this (test-i18n-terms.mjs), and the machine pass returns it without asking Google.
export const TERM_LINES = {
  es: {
    'clock.in': 'Marcar entrada',
    'clock.out': 'Marcar salida',
    'visit.step.clockOut': 'Marcar salida',
    'clock.openChecklist': 'Abrir lista de verificación',
    'clock.locating': 'Localizando…',
    'nav.myDay': 'Mi día',
    'checklist.fill.checklist': 'Lista de verificación',
    'common.save': 'Guardar',
  },
  ht: {
    'clock.in': 'Make antre',
    'clock.out': 'Make sòti',
    'visit.step.clockOut': 'Make sòti',
    'clock.openChecklist': 'Louvri lis verifikasyon',
    'nav.myDay': 'Jounen m', // the bottom tab: "Jounen mwen" is cut off on a phone (LANG-9)
    'checklist.fill.checklist': 'Lis verifikasyon',
    'common.save': 'Anrejistre',
  },
};

// Words the term list replaced and no line may use again (each a known machine mistake, with
// the reason).
export const FORBIDDEN_TERMS = {
  es: [
    [/(?<![\p{L}])fich(ar|aje|ado|ada|aste|aron|e)(?![\p{L}])/iu, 'clock in/out = marcar entrada / salida'],
    [/reloj de entrada/iu, 'clock in = marcar entrada (a verb, not a clock)'],
    [/tripulaci[oó]n/iu, 'crew = equipo'],
    [/(?<![\p{L}])boleto/iu, 'ticket = solicitud'],
    [/lista de tareas/iu, 'checklist = lista de verificación'],
    [/(?<![\p{L}])(golpes?|puñetazos?|perforaci[oó]n|perforador)(?![\p{L}])/iu, 'punch = marcación'],
    [/(?<![\p{L}])usted(?![\p{L}])/u, 'the reader is “tú”'],
  ],
  ht: [
    [/(?<![\p{L}])rele (pou )?antre/iu, 'clock in = make antre (rele is to call)'],
    [/(?<![\p{L}])revèy pou s[oò]ti/iu, 'clock out = make sòti (revèy is an alarm clock)'],
    [/(?<![\p{L}])kout pwen/iu, 'punch = pwentaj (kout pwen is a punch with a fist)'],
    [/(?<![\p{L}])ekipaj(?![\p{L}])/iu, 'crew = ekip'],
    [/(?<![\p{L}])tikè(?![\p{L}])/iu, 'ticket = demann'],
  ],
};

// Lines that stay English in every language (LANG-8: what a CUSTOMER reads — the quote and
// inspection-report pages a customer opens from a link, the customer hub's time-to-resolve tile
// and its QR scan page). They are rendered with english(); the import refuses a translation for
// them and the server never sends them to Google (api/_lib/i18nSource pendingLines).
export const ENGLISH_ONLY_PREFIXES = ['publicQuote.', 'publicReport.', 'publicSurvey.', 'resolveTime.hub.', 'hubScan.'];
export const isEnglishOnly = (key) => ENGLISH_ONLY_PREFIXES.some((p) => String(key).startsWith(p));

// ── protected nouns ──────────────────────────────────────────────────────────────────────
// Each is an English surface form (whole words, any case) that is always the app's noun, with the
// agreed word in each language. `g` is the Spanish gender and `pl` whether the form is plural (what
// the article in front of it must agree with); `ht` is the Creole word and `det` its singular
// determiner after it (la after a consonant, a after a vowel, an after a nasal vowel, nan after a
// nasal consonant — a plural takes yo). `fixed` words keep their case (a name, an abbreviation).
// Plural forms come first so "checklists" is never read as "checklist" + "s".
export const PROTECTED_TERMS = [
  { en: 'checklists', es: 'listas de verificación', g: 'f', pl: true, ht: 'lis verifikasyon', det: 'an' },
  { en: 'checklist', es: 'lista de verificación', g: 'f', pl: false, ht: 'lis verifikasyon', det: 'an' },
  { en: 'work orders', es: 'órdenes de trabajo', g: 'f', pl: true, ht: 'lòd travay', det: 'la' },
  { en: 'work order', es: 'orden de trabajo', g: 'f', pl: false, ht: 'lòd travay', det: 'la' },
  { en: 'tickets', es: 'solicitudes', g: 'f', pl: true, ht: 'demann', det: 'nan' },
  { en: 'ticket', es: 'solicitud', g: 'f', pl: false, ht: 'demann', det: 'nan' },
  { en: 'clock-ins', es: 'entradas', g: 'f', pl: true, ht: 'antre', det: 'a' },
  { en: 'clock-in', es: 'entrada', g: 'f', pl: false, ht: 'antre', det: 'a' },
  { en: 'clock-outs', es: 'salidas', g: 'f', pl: true, ht: 'sòti', det: 'a' },
  { en: 'clock-out', es: 'salida', g: 'f', pl: false, ht: 'sòti', det: 'a' },
  { en: 'punches', es: 'marcaciones', g: 'f', pl: true, ht: 'pwentaj', det: 'la' },
  { en: 'punch', es: 'marcación', g: 'f', pl: false, ht: 'pwentaj', det: 'la' },
  { en: 'crew', es: 'equipo', g: 'm', pl: false, ht: 'ekip', det: 'la' },
  { en: 'account managers', es: 'gerentes de cuenta', g: 'm', pl: true, ht: 'responsab kont', det: 'la' },
  { en: 'account manager', es: 'gerente de cuenta', g: 'm', pl: false, ht: 'responsab kont', det: 'la' },
  { en: 'off-site', es: 'fuera del sitio', ht: 'deyò sit la', adverb: true },
  { en: 'covering for', es: 'cubriendo a', ht: 'ap ranplase', adverb: true },
  { en: 'backordered', es: 'pendiente del proveedor', ht: 'an reta nan men founisè a', adverb: true },
  { en: 'My Day', es: 'Mi día', ht: 'Jounen mwen', fixed: true },
  { en: 'N/A', es: 'N/A', ht: 'N/A', fixed: true },
  { en: 'ETA', es: 'fecha estimada', ht: 'dat prevwa', caseSensitive: true },
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const PROTECTED_RES = PROTECTED_TERMS.map((term) => ({
  term,
  re: new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRe(term.en)}(?![\\p{L}\\p{N}-])`, term.caseSensitive || term.fixed ? 'gu' : 'giu'),
}));

// ── the repairs (what Google still writes from words that cannot be protected) ────────────
// Each: [pattern, replacement]. Applied in order to the finished line; the first letter's case is
// kept. The two Spanish nouns that change gender (tripulación → equipo, boleto → solicitud) put the
// article in front right too.
const keepCase = (from, to) => (from && from[0] === from[0].toUpperCase() && from[0] !== from[0].toLowerCase()
  ? to.charAt(0).toUpperCase() + to.slice(1) : to);
const FICHAR = { ar: 'ar', aje: 'ación', ado: 'ado', ada: 'ada', aste: 'aste', aron: 'aron', e: 'que' };
const USTED_AFTER = { a: 'a ti', para: 'para ti', de: 'de ti', con: 'contigo', por: 'por ti', sin: 'sin ti' };
export const TERM_FIXES = {
  es: [
    [/(?<![\p{L}])reloj de (entrada|salida)(?![\p{L}])/giu, (m, which) => keepCase(m, `marcar ${which.toLowerCase()}`)],
    [/(?<![\p{L}])fich(ar|aje|ado|ada|aste|aron|e)(?![\p{L}])/giu, (m, end) => keepCase(m, `marc${FICHAR[end.toLowerCase()]}`)],
    [/(?<![\p{L}])(?:(la|una|esta|esa)\s+)?tripulaci[oó]n(es)?(?![\p{L}])/giu, (m, art, pl) => {
      const noun = pl ? 'equipos' : 'equipo';
      if (!art) return keepCase(m, noun);
      const map = { la: pl ? 'los' : 'el', una: pl ? 'unos' : 'un', esta: pl ? 'estos' : 'este', esa: pl ? 'esos' : 'ese' };
      return `${keepCase(art, map[art.toLowerCase()])} ${noun}`;
    }],
    [/(?<![\p{L}])(?:(el|un|este|ese|los|unos|estos|esos)\s+)?boleto(s)?(?![\p{L}])/giu, (m, art, pl) => {
      const noun = pl ? 'solicitudes' : 'solicitud';
      if (!art) return keepCase(m, noun);
      const map = { el: 'la', un: 'una', este: 'esta', ese: 'esa', los: 'las', unos: 'unas', estos: 'estas', esos: 'esas' };
      return `${keepCase(art, map[art.toLowerCase()])} ${noun}`;
    }],
    [/(?<![\p{L}])lista(s)? de tareas(?![\p{L}])/giu, (m, pl) => keepCase(m, pl ? 'listas de verificación' : 'lista de verificación')],
    [/(?<![\p{L}])(?:(el|un|este|ese)\s+)?(golpe|puñetazo|perforador)(s|es)?(?![\p{L}])/giu, (m, art, _w, pl) => {
      const noun = pl ? 'marcaciones' : 'marcación';
      if (!art) return keepCase(m, noun);
      const map = { el: pl ? 'las' : 'la', un: pl ? 'unas' : 'una', este: pl ? 'estas' : 'esta', ese: pl ? 'esas' : 'esa' };
      return `${keepCase(art, map[art.toLowerCase()])} ${noun}`;
    }],
    [/(?<![\p{L}])perforaci[oó]n(es)?(?![\p{L}])/giu, (m, pl) => keepCase(m, pl ? 'marcaciones' : 'marcación')],
    // The reader is "tú". The pronoun after a preposition takes its "tú" form; as a subject it is
    // dropped (Spanish leaves it out), the next word keeping a capital the sentence gave it.
    [/(?<![\p{L}])(a|para|de|con|por|sin) usted(?![\p{L}])/giu, (m, prep) => keepCase(m, USTED_AFTER[prep.toLowerCase()])],
    [/(?<![\p{L}])usted\s+(\p{L})/gu, (_m, next) => next],
    [/(?<![\p{L}])Usted\s+(\p{L})/gu, (_m, next) => next.toUpperCase()],
    [/,?\s*(?<![\p{L}])usted(?![\p{L}])/giu, ''],
  ],
  ht: [
    [/(?<![\p{L}])rele (?:pou )?antre/giu, (m) => keepCase(m, 'make antre')],
    [/(?<![\p{L}])revèy pou s[oò]ti/giu, (m) => keepCase(m, 'make sòti')],
    [/(?<![\p{L}])kout pwen/giu, (m) => keepCase(m, 'pwentaj')],
    [/(?<![\p{L}])ekipaj(?![\p{L}])/giu, (m) => keepCase(m, 'ekip')],
    [/(?<![\p{L}])tikè(?![\p{L}])/giu, (m) => keepCase(m, 'demann')],
  ],
};

// The repaired line, and which FORBIDDEN_TERMS rules (by index) it still breaks — none, after the
// repairs above; a hit is reported by the caller, never shown as English instead.
export function repairTerms(lang, text) {
  let out = String(text ?? '');
  for (const [re, to] of TERM_FIXES[lang] || []) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, ' ').trim();
}
export function forbiddenHits(lang, text) {
  return (FORBIDDEN_TERMS[lang] || []).map(([re], i) => (re.test(String(text ?? '')) ? i : -1)).filter((i) => i >= 0);
}

// ── a line through the machine ───────────────────────────────────────────────────────────
// The catalog's placeholders and tags ({customer}, {start, time}, <b>, </b>) and the protected
// nouns each become a numbered token, `{0}`, `{1}` …, which Google keeps as it is (the S129 pass:
// 2,632 sentences, every token kept). `text` is what is sent; `restore(translated)` puts each one
// back — the placeholder verbatim, the noun as the agreed word with its article put right — and
// answers null when a token was lost, doubled or mangled, or a tag came back out of order, so a
// broken sentence is never stored (the line stays English and the caller reports it).
const SLOT_RE = /\{\s*[A-Za-z][A-Za-z0-9_]*\s*(?:,\s*[A-Za-z]+\s*)?\}|<\/?[a-z][a-z0-9]*>/g;
const TOKEN_RE = /\{\s*(\d+)\s*\}/g;
export function prepareForMachine(lang, english) {
  const slots = [];
  const token = (slot) => { slots.push(slot); return `{${slots.length - 1}}`; };
  let text = String(english ?? '').replace(SLOT_RE, (m) => token({ kind: 'slot', text: m }));
  for (const { term, re } of PROTECTED_RES) {
    text = text.replace(re, (m) => token({ kind: 'term', term, capital: /^\p{Lu}/u.test(m) }));
  }
  return {
    text,
    slots,
    // Nothing for Google to read: only tokens, digits, spaces and punctuation.
    bare: !/\p{L}/u.test(text.replace(TOKEN_RE, '')),
    restore: (translated) => restoreTokens(lang, translated, slots),
  };
}

const ES_DETERMINERS = [
  ['el', 'la', 'los', 'las'], ['un', 'una', 'unos', 'unas'], ['este', 'esta', 'estos', 'estas'],
  ['ese', 'esa', 'esos', 'esas'], ['aquel', 'aquella', 'aquellos', 'aquellas'], ['del', 'de la', 'de los', 'de las'],
  ['al', 'a la', 'a los', 'a las'], ['tu', 'tu', 'tus', 'tus'], ['su', 'su', 'sus', 'sus'], ['mi', 'mi', 'mis', 'mis'],
  ['nuestro', 'nuestra', 'nuestros', 'nuestras'], ['nuevo', 'nueva', 'nuevos', 'nuevas'], ['otro', 'otra', 'otros', 'otras'],
  ['ningún', 'ninguna', 'ningunos', 'ningunas'], ['primer', 'primera', 'primeros', 'primeras'], ['último', 'última', 'últimos', 'últimas'],
];
const ES_DET_INDEX = new Map(ES_DETERMINERS.flatMap((row, r) => row.map((w) => [w, r])));
const HT_DETERMINERS = new Set(['la', 'a', 'an', 'lan', 'nan', 'yo']);

function restoreTokens(lang, translated, slots) {
  if (typeof translated !== 'string') return null;
  let text = translated.replace(TOKEN_RE, (_m, n) => `{${Number(n)}}`);
  // Every token exactly once, and none Google invented.
  const seen = new Map();
  for (const m of text.matchAll(/\{(\d+)\}/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  if (seen.size !== slots.length || slots.some((_s, i) => seen.get(String(i)) !== 1)) return null;
  slots.forEach((slot, i) => {
    if (slot.kind !== 'term' || slot.term.fixed || slot.term.adverb) return;
    text = lang === 'es' ? fixSpanishArticle(text, i, slot.term) : fixCreoleDeterminer(text, i, slot.term);
  });
  text = text.replace(/\{(\d+)\}/g, (_m, n, at) => {
    const slot = slots[Number(n)];
    if (slot.kind === 'slot') return slot.text;
    const word = slot.term[lang] ?? slot.term.en;
    if (slot.term.fixed) return word;
    // A capital only where the sentence starts with the word (Spanish and Creole do not
    // capitalize a noun mid-sentence the way an English title does).
    const before = text.slice(0, at);
    const starts = slot.capital && (/^\s*["'«¿¡(]?\s*$/u.test(before) || /[.!?:]\s+["'«¿¡(]?$/u.test(before));
    return starts ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  });
  // A tag must still open before it closes.
  for (const m of text.matchAll(/<([a-z][a-z0-9]*)>/g)) {
    const close = text.indexOf(`</${m[1]}>`, m.index);
    if (text.includes(`</${m[1]}>`) && close < 0) return null;
  }
  return text;
}

// The word in front of token `i` agrees with the agreed Spanish noun: gender `g`, number `pl`.
function fixSpanishArticle(text, i, term) {
  const col = (term.pl ? 2 : 0) + (term.g === 'f' ? 1 : 0);
  return text.replace(new RegExp(`(?<![\\p{L}])((?:de|a)\\s+)?(\\p{L}+)(\\s+)\\{${i}\\}`, 'u'), (whole, prep, word, space) => {
    const lower = word.toLowerCase();
    // "de la" / "a la" / "de los" … written as two words: read them as the contraction's row.
    if (prep && ['la', 'las', 'los', 'el'].includes(lower)) {
      const row = prep.trim().toLowerCase() === 'de' ? ES_DETERMINERS[5] : ES_DETERMINERS[6];
      return `${keepCase(prep, row[col])}${space}{${i}}`;
    }
    const r = ES_DET_INDEX.get(lower);
    if (r === undefined) return whole;
    return `${prep || ''}${keepCase(word, ES_DETERMINERS[r][col])}${space}{${i}}`;
  });
}

// The determiner after token `i` is the agreed Creole noun's own: its singular form, or yo.
function fixCreoleDeterminer(text, i, term) {
  return text.replace(new RegExp(`\\{${i}\\}(\\s+)(\\p{L}+)(?![\\p{L}])`, 'u'), (whole, space, word) => {
    const lower = word.toLowerCase();
    if (!HT_DETERMINERS.has(lower)) return whole;
    if (lower === 'yo') return whole;
    return `{${i}}${space}${term.pl ? 'yo' : term.det}`;
  });
}

// ── names stay as written (CS-856) ────────────────────────────────────────────────────────
// A customer's or a building's name is never translated: production's first fill turned "Nightly
// Close-Out — Bayshore Senior Living" into "… Residencia para personas mayores Bayshore". Before a
// line is hashed and sent, every name the org holds (its customers' and its buildings' names, read
// by the server from the shared record) that appears in it, as written and as a whole word, becomes
// a `{noun0}`, `{noun1}` … placeholder; the line is stored and translated in that shape — so every
// "Nightly Close-Out — <customer>" shares ONE stored translation and reads alike — and each name is
// put back exactly as the line had it. The placeholder travels as a token like any other, so a
// lost one means no line (null), never a broken one.
export const PROPER_NOUN_RE = /\{noun(\d+)\}/g;
// The org's names as one matcher (longest first, so "Bayshore Senior Living" wins over "Bayshore"),
// or null when there are none. Names shorter than 2 characters are not names.
export function properNounMatcher(names) {
  const list = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string').map((n) => n.trim()).filter((n) => n.length >= 2))]
    .sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}
// → { shape, found }: the line with each name as `{nounK}` (a repeated name keeps its index) and
// the names in index order. No matcher, or no name in the line: the line itself.
export function shapeProperNouns(text, matcher) {
  const found = [];
  if (!matcher || typeof text !== 'string') return { shape: text, found };
  const shape = text.replace(matcher, (m) => {
    let i = found.indexOf(m);
    if (i < 0) { found.push(m); i = found.length - 1; }
    return `{noun${i}}`;
  });
  return { shape, found };
}
// The org's names, from the shared record: every customer's and every building's (`clients[].name`,
// `sites[].name`). What the server hands translateAll for anything an office wrote.
export function orgProperNouns(state) {
  return [...(Array.isArray(state?.clients) ? state.clients : []), ...(Array.isArray(state?.sites) ? state.sites : [])]
    .map((x) => x?.name).filter((n) => typeof n === 'string' && n.trim());
}
// Each `{nounK}` back to its name, exactly as written.
export function fillProperNouns(text, found) {
  if (typeof text !== 'string' || !found?.length) return text;
  return text.replace(PROPER_NOUN_RE, (whole, i) => (found[Number(i)] ?? whole));
}

// The pinned whole line for this English, in `lang`, or null: TERM_LINES keyed by the English
// catalog's text, so "Clock in" — wherever it comes from — is the term list's own line.
export function pinnedLineFor(lang, english, en) {
  const lines = TERM_LINES[lang];
  if (!lines || typeof english !== 'string') return null;
  for (const [key, text] of Object.entries(lines)) if (en?.[key] === english) return text;
  return null;
}
