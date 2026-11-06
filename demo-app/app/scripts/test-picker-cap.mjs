// A picker never renders its whole book (UI_RULES §127).
//
// `FilterSelect` filters its options as you type but rendered EVERY match on open. At this
// build's stated scale — 1,500 cleaners and 750 customers (plan §7) — opening a cleaner
// picker painted 1,500 menu rows before a single keystroke, and the Assignments screen has
// three such pickers per customer card. The cap is ONE pure rule, `lib/pickerOptions
// capOptions`, so the kit component, its design-system card and this suite all read the
// same numbers and the same sentence.
//
// The rule: with no cap, nothing changes. With one, the first N matches render, and a
// plain (non-selectable) row says how many of how many are shown and what to do about it.
// Typing narrows the list BEFORE the cap, so every option stays reachable.
//
// Run: node app/scripts/test-picker-cap.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { capOptions, cappedNote, PICKER_MAX_VISIBLE } from '../src/lib/pickerOptions.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

const opts = (n, prefix = 'Cleaner') => Array.from({ length: n }, (_, i) => ({ value: `u${i}`, label: `${prefix} ${i}` }));

// ── no cap: exactly today's behaviour ────────────────────────────────────────
{
  const rows = opts(1500);
  const r = capOptions(rows, 0);
  eq('no cap: every option renders', r.shown.length, 1500);
  eq('no cap: the same array, not a copy', r.shown === rows, true);
  eq('no cap: nothing hidden', r.hidden, 0);
  eq('no cap: no note', r.note, null);
  eq('undefined cap behaves as no cap', capOptions(rows).shown.length, 1500);
  eq('a negative cap is no cap (never renders nothing)', capOptions(rows, -5).shown.length, 1500);
}

// ── the scale the plan names: 1,500 cleaners ────────────────────────────────
{
  const rows = opts(1500);
  const r = capOptions(rows, PICKER_MAX_VISIBLE);
  eq('1,500 cleaners render at most the cap', r.shown.length, PICKER_MAX_VISIBLE);
  eq('…and the cap is well under the book', PICKER_MAX_VISIBLE < 1500, true);
  eq('the rest are counted, not dropped silently', r.hidden, 1500 - PICKER_MAX_VISIBLE);
  eq('the note says how many of how many, and what to do', r.note, cappedNote(PICKER_MAX_VISIBLE, 1500));
  eq('the note is one plain sentence pair', /^Showing \d+ of [\d,]+\. Type to narrow\.$/.test(r.note), true);
  eq('the FIRST matches are the ones kept, in order', [r.shown[0].value, r.shown[r.shown.length - 1].value],
    ['u0', `u${PICKER_MAX_VISIBLE - 1}`]);
}

// ── the default row (index 0) is never capped away ──────────────────────────
{
  // FilterSelect pins option 0 (the "All …" / prompt row) while filtering, so resetting is
  // always one click away. A cap that could drop it would take that away.
  const rows = [{ value: '', label: '＋ Assign a cleaner' }, ...opts(1500)];
  const r = capOptions(rows, 3);
  eq('the prompt row survives the cap', r.shown[0].value, '');
  eq('the cap counts it like any other row', r.shown.length, 3);
}

// ── under the cap, nothing is said ──────────────────────────────────────────
{
  const rows = opts(12);
  const r = capOptions(rows, PICKER_MAX_VISIBLE);
  eq('a short list is untouched', r.shown === rows, true);
  eq('…and carries no note', r.note, null);
  const exact = capOptions(opts(PICKER_MAX_VISIBLE), PICKER_MAX_VISIBLE);
  eq('exactly the cap is not "capped"', [exact.hidden, exact.note], [0, null]);
  const one = capOptions(opts(PICKER_MAX_VISIBLE + 1), PICKER_MAX_VISIBLE);
  eq('one over the cap is', one.hidden, 1);
}

// ── typing narrows BEFORE the cap, so every option stays reachable ──────────
{
  // The component filters, then caps. Simulated here on the same rule: a query that
  // matches one deep row reaches it even though the cap would never have shown it.
  const rows = opts(1500);
  const matched = rows.filter((o) => o.label.toLowerCase().includes('cleaner 1499'));
  const r = capOptions(matched, PICKER_MAX_VISIBLE);
  eq('a narrowed search reaches the 1,500th option', r.shown.map((o) => o.value), ['u1499']);
  eq('…with no note, because nothing is hidden', r.note, null);
}

// ── it never throws on nothing ──────────────────────────────────────────────
{
  eq('no options at all', capOptions(null, 10), { shown: [], hidden: 0, note: null, noteMsg: null });
  eq('an empty list', capOptions([], 10).shown, []);
}

// ── the kit and its callers actually use it ─────────────────────────────────
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(HERE, '../src');
  // A missing file reads as empty, so its checks fail by name instead of the suite crashing.
  const read = (p) => { try { return readFileSync(path.join(SRC, p), 'utf8'); } catch { return ''; } };

  const fs = read('components/FilterSelect.jsx');
  eq('FilterSelect reads the ONE rule instead of slicing its own', /capOptions/.test(fs), true);
  eq('FilterSelect takes the cap as a prop', /maxVisible/.test(fs), true);
  eq('FilterSelect does not restate the note', /Showing .* of .* Type to narrow/.test(fs), false);
  // The footnote is ONE component (CS-673/CS-723): a plain paragraph, never an option.
  const note = read('components/PickerCapNote.jsx');
  eq('the capped row is not selectable (a <p>, no role="option", no click)',
    /<p className="select-search-more">/.test(note) && !/role=|onClick/.test(note), true);
  eq('FilterSelect draws the footnote through it', /<PickerCapNote note=\{noteMsg\} \/>/.test(fs), true);

  // The three pickers that can reach the plan's scale: assigning a cleaner (1,500),
  // reassigning one (1,500) and "Start from…" (every checklist in the org, ~3,750).
  const panel = read('components/checklists/CustomerChecklistPanel.jsx');
  const screen = read('components/checklists/ChecklistAssignments.jsx');
  const caps = (s) => (s.match(/maxVisible=/g) || []).length;
  eq('the customer panel caps its big pickers', caps(panel) >= 3, true);
  eq('the worklist row\'s assign picker is capped too', caps(screen) >= 1, true);
  eq('neither retypes the cap number', /maxVisible=\{\s*\d/.test(panel + screen), false);

  // Nobody else hand-rolls a cap on a menu list.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]
  ));
  const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
  const jsx = walk(SRC).filter((p) => /\.jsx$/.test(p));
  const rogue = jsx
    .filter((p) => !p.endsWith('PickerCapNote.jsx'))
    .filter((p) => /select-search-more/.test(readFileSync(p, 'utf8')))
    .map(rel);
  eq('only the footnote component draws the capped row', rogue, []);

  // ── the pickers that reach the book never cut names in silence (CS-723) ──────────────
  // SearchSelect sliced to 50, ContactPicker to 30, ClientNamePicker to 25 a section, and said
  // nothing: a manager scrolling for their building decided it was missing.
  const PICKERS = ['components/SearchSelect.jsx', 'components/CrewPicker.jsx', 'components/ContactPicker.jsx', 'components/ClientNamePicker.jsx'];
  for (const f of PICKERS) {
    const s = read(f);
    eq(`${f} caps through the ONE rule at the ONE number`, /(capOptions|crewPickerRows)\(/.test(s) && /PICKER_MAX_VISIBLE/.test(s) && !/maxVisible[=:]\s*\{?\s*\d|capOptions\([^)]*,\s*\d/.test(s), true);
    eq(`${f} says what it hides (the footnote)`, /<PickerCapNote note=\{noteMsg\} \/>/.test(s), true);
  }
  // Mechanically: no picker or select in the kit slices its options by a number of its own.
  const silent = jsx
    .filter((p) => /(Picker|Select)\.jsx$/.test(p))
    .filter((p) => /\.slice\(0,\s*\d{2,}\)/.test(readFileSync(p, 'utf8')))
    .map(rel);
  eq('no picker slices its options to a number of its own (a silent cap)', silent, []);

  // ── a crew field is the capped, searchable CrewPicker, never a chip per person (CS-673) ──
  // Editing a clean drew one chip per active user: 1,544 chips, a 19,336 px wall, no search.
  const job = read('pages/JobDetail.jsx');
  eq('the clean edit form\'s Crew field is the CrewPicker', /<CrewPicker\s[\s\S]{0,300}pool=\{activeCrew\}/.test(job), true);
  const walls = jsx.filter((p) => {
    const s = readFileSync(p, 'utf8');
    // a chip grid whose rows come from the team roster
    return [...s.matchAll(/className="chip-picker"[\s\S]{0,400}?\.map\(/g)]
      .some((m) => /\busers\b|selectActiveUsers|crewPool|activeCrew|\.users\b/.test(m[0]));
  }).map(rel);
  eq('no chip grid lists the team roster', walls, []);
}

// ── the crew picker's rows: who is on the clean leads, typing narrows, then the cap ─────
{
  const { crewPickerRows: rows } = await import('../src/lib/pickerOptions.js');
  eq('lib/pickerOptions builds the crew picker\'s rows', typeof rows, 'function');
  const crewPickerRows = typeof rows === 'function' ? rows : () => ({ shown: [], matches: [], note: 'missing' });
  const pool = Array.from({ length: 1540 }, (_, i) => ({ id: `u${i}`, name: `Cleaner ${String(i).padStart(4, '0')}` }));
  const open = crewPickerRows(pool, { leadIds: ['u1200', 'u7'] });
  eq('1,540 cleaners render at most the cap', open.shown.length, PICKER_MAX_VISIBLE);
  eq('…and say how many of how many', open.note, cappedNote(PICKER_MAX_VISIBLE, 1540));
  eq('the people already on the clean lead the list, in roster order (a cap never hides them)', open.shown.slice(0, 2).map((u) => u.id), ['u7', 'u1200']);
  eq('…and are not listed twice', open.shown.filter((u) => u.id === 'u1200').length, 1);
  const typed = crewPickerRows(pool, { query: '  cleaner 1499 ', leadIds: ['u7'] });
  eq('typing narrows BEFORE the cap, reaching the 1,500th person', typed.shown.map((u) => u.id), ['u1499']);
  eq('…with no footnote, because nothing is hidden', typed.note, null);
  eq('the matches are every match (Enter toggles the one match)', typed.matches.length, 1);
  eq('a person with no name never throws', crewPickerRows([{ id: 'x' }], { query: 'a' }).shown.length, 0);
  eq('a short crew is untouched', crewPickerRows(pool.slice(0, 12)).note, null);
}

// ── CS-722 / CS-713 / CS-724: NO picker lists the whole team or book (2026-10-13) ──────────────
// The S128 audit at Matt's size: a customer picker drew 768 rows, the Schedule's and the reports'
// facets 1,540 cleaners, New DM 1,541, View as 1,544, a channel's "add participant" and New
// channel's member list every login, Keys' "Who is taking the key?" every login unsorted, and the
// Inspections list a 1,541-option select on EVERY failed row (28,427 nodes for 20 rows) — while the
// checks above held only FilterSelect and two of its callers.
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(HERE, '../src');
  const read = (p) => { try { return readFileSync(path.join(SRC, p), 'utf8'); } catch { return ''; } };
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
  const jsx = walk(SRC).filter((p) => /\.jsx$/.test(p));
  const lib = await import('../src/lib/pickerOptions.js');

  // 1. FilterSelect caps BY DEFAULT, at the one number, and no call site turns it off.
  const fsSrc = read('components/FilterSelect.jsx');
  eq('🔴 FilterSelect caps by default (maxVisible = PICKER_MAX_VISIBLE): a new filter needs no prop to be safe',
    /maxVisible = PICKER_MAX_VISIBLE/.test(fsSrc) && /import \{[^}]*PICKER_MAX_VISIBLE[^}]*\} from '\.\.\/lib\/pickerOptions'/.test(fsSrc), true);
  const offs = jsx.flatMap((p) => {
    const s = readFileSync(p, 'utf8');
    return [...s.matchAll(/<FilterSelect\b[^>]*?maxVisible=\{\s*([^}]+?)\s*\}/g)].map((m) => m[1]).filter((v) => v !== 'PICKER_MAX_VISIBLE').map((v) => `${rel(p)}: maxVisible={${v}}`);
  });
  eq('🔴 no FilterSelect call site switches the cap off or retypes the number', offs, []);

  // 2. The people a picker offers: active, alphabetical, optionally only some roles (one rule).
  const people = typeof lib.personOptions === 'function' ? lib.personOptions : null;
  eq('🔴 lib/pickerOptions builds a picker\'s people (personOptions)', typeof people, 'function');
  if (people) {
    const roster = [
      { id: 'u3', name: 'Zoe Ward', role: 'crew', status: 'active' }, { id: 'u1', name: 'adam Price', role: 'manager', status: 'active' },
      { id: 'u2', name: 'Bea Cole', role: 'crew', status: 'inactive' }, { id: 'u4', name: 'Matt Giunco', role: 'owner', status: 'active' },
      { id: 'u5', name: 'Dana Cole', role: 'admin', status: 'active' },
    ];
    eq('…active people only, sorted by name (any case)', people(roster).map((o) => o.value), ['u1', 'u5', 'u4', 'u3']);
    eq('…each { value: id, label: name }', people(roster)[0], { value: 'u1', label: 'adam Price' });
    eq('…narrowed to the roles asked for (the office)', people(roster, { roles: ['owner', 'admin', 'manager'] }).map((o) => o.value), ['u1', 'u5', 'u4']);
  }

  // 3. Each picker the audit named caps through the ONE rule and says what it hides.
  const CAPPING = {
    'components/ClientPicker.jsx': 'the job form\'s customer picker (768 rows)',
    'components/filters/MultiFacet.jsx': 'the Schedule, Variance, Drive time and Inspections facets (1,540 cleaners, 767 locations)',
    'components/NewDmModal.jsx': 'New DM (1,541 rows)',
    'components/NewInternalThreadModal.jsx': 'New channel\'s members',
    'components/ConversationContextPanel.jsx': 'a channel\'s "Add participant"',
    'components/UserSwitcher.jsx': 'View as (1,544 rows)',
    'components/HubPreviewPicker.jsx': 'Preview as customer\'s buildings',
    'components/AddContactModal.jsx': 'a contact\'s company picker (768 customers)',
    'components/AddUserModal.jsx': 'Add Team Member\'s "Give another permission" (UI_RULES §189: the permissions Crew lacks, 73 in the demo)',
  };
  for (const [f, what] of Object.entries(CAPPING)) {
    const s = read(f);
    eq(`🔴 ${f} — ${what} — filters first, then caps through the ONE rule and says what it hides`,
      /(capOptions|crewPickerRows)\(/.test(s) && /PICKER_MAX_VISIBLE/.test(s) && /<PickerCapNote note=\{noteMsg\} \/>/.test(s) && !/capOptions\([^)]*,\s*\d/.test(s), true);
  }
  // 4. Keys: "Who is taking the key?" is the searchable, capped picker over the team, by name.
  const keys = read('pages/Keys.jsx');
  eq('🔴 Keys\' holder picker is the searchable, capped FilterSelect over personOptions (alphabetical), never a select of every login',
    /<FilterSelect\b[\s\S]{0,400}keyPage\.whoTakes/.test(keys) && /personOptions\(/.test(keys) && !/label=\{t\('keyPage\.whoTakes'\)\} as="select"/.test(keys), true);
  // 5. Inspections: the follow-up assignee is the office's, in the capped picker — no select per row.
  const insp = read('pages/Inspections.jsx');
  eq('🔴 the Inspections list draws no native <select> of people on a row (it drew 1,541 options on each failed row)',
    /followUpUsers\.map\(\(u\) => <option/.test(insp), false);
  eq('🔴 …the follow-up picker is the capped FilterSelect over the office (personOptions with SUPERVISOR_ROLES)',
    /personOptions\([^)]*SUPERVISOR_ROLES/.test(insp) && /<FilterSelect\b[\s\S]{0,300}inspections\.followUp\./.test(insp), true);
  // …and its menu FLOATS: the list's table scrolls sideways (.table-wrap: overflow-x auto, which
  // makes overflow-y hidden), so a menu hung below a bottom row's picker would be cut off.
  const followUpPicker = (insp.match(/<FilterSelect\b[\s\S]*?\/>/g) || []).find((b) => /inspections\.followUp\./.test(b)) || '';
  eq('🔴 …and its menu floats out of the table (FilterSelect float), so a bottom row\'s menu is never cut off',
    /\sfloat(?:\s|\/>|=\{true\})/.test(followUpPicker), true);
  const pm = read('components/PopMenu.jsx');
  eq('🔴 PopMenu float: drawn through a portal at the trigger, placed by lib/floatPlacement, spared by the click-outside',
    /createPortal\(/.test(pm) && /floatPlacement\(/.test(pm) && /ref2:\s*floating \? menuRef/.test(pm), true);
  const css = readFileSync(path.resolve(HERE, '../src/index.css'), 'utf8');
  eq('🔴 …a floating menu is fixed to the screen (.select-menu.is-float), and the open trigger keeps its corners when its menu floats',
    /\.select-menu\.is-float\s*\{[^}]*position:\s*fixed/.test(css) && /\.select-shell\.is-open:not\(\.is-float\) \.select-trigger\s*\{/.test(css), true);
  const fp = await import('../src/lib/floatPlacement.js').catch(() => null);
  eq('🔴 lib/floatPlacement decides where a floating menu goes', typeof fp?.floatPlacement, 'function');
  if (fp?.floatPlacement) {
    const vp = { width: 1024, height: 768 };
    const mid = fp.floatPlacement({ top: 300, bottom: 332, left: 800, width: 130 }, vp);
    eq('…below the trigger, the whole menu, when it fits there', { up: mid.up, top: mid.top, maxHeight: mid.maxHeight }, { up: false, top: 336, maxHeight: fp.FLOAT_MENU_MAX });
    const low = fp.floatPlacement({ top: 700, bottom: 732, left: 800, width: 130 }, vp);
    eq('…above it on a row at the screen\'s foot (more room above), held by its bottom edge', { up: low.up, top: low.top, bottom: low.bottom }, { up: true, top: null, bottom: 768 - 700 + fp.FLOAT_GAP });
    eq('…at least FLOAT_MIN_WIDTH wide, and never past the screen\'s right edge', { width: low.width, inside: low.left + low.width <= vp.width - fp.FLOAT_GAP }, { width: fp.FLOAT_MIN_WIDTH, inside: true });
    const tight = fp.floatPlacement({ top: 120, bottom: 152, left: 10, width: 300 }, { width: 1024, height: 300 });
    eq('…shrunk to the room it has when neither side holds the whole menu', { up: tight.up, maxHeight: tight.maxHeight }, { up: false, maxHeight: 300 - 152 - 2 * fp.FLOAT_GAP });
    const menuMax = Number((css.match(/\n\.select-menu \{[^}]*?max-height:\s*(\d+)px/) || [])[1]);
    eq('…FLOAT_MENU_MAX is .select-menu\'s own max-height (index.css)', fp.FLOAT_MENU_MAX, menuMax);
  }

  // 6. The ledger: every .jsx that renders CHOOSABLE ROWS (a menu option, an option, a picker row)
  // and reads the team or the book is either capping (above, and the kit pickers), or BOUNDED —
  // its own rows are a short vocabulary and its book lists go to a capping kit picker — with its
  // row markers COUNTED, so a new list added to one fails until it is looked at. A new file that
  // lists the team or the book fails until it caps or is classified here.
  const BOOK = /selectActiveUsers\(|selectUsers\(|state\.users\b|\(users \|\| \[\]\)|selectClients\(|state\.clients\b|selectSites\(|state\.sites\b|selectActiveClients\(|selectVisibleSitesFor\(|selectContacts\(|state\.contacts\b/;
  const ROWS = /<option\b|role="option"|menu-option|-picker-row|-add-row|contact-picker-option/g;
  const KIT_CAPPING = new Set(['components/FilterSelect.jsx', 'components/SearchSelect.jsx', 'components/CrewPicker.jsx', 'components/ContactPicker.jsx', 'components/ClientNamePicker.jsx']);
  const BOUNDED = {
    'components/InspectionFill.jsx': { rows: 3, why: 'its one select is a 1–5 rating (no rating, 1–5, N/A); buildings and templates go to SearchSelect' },
    'components/WorkOrderDrawer.jsx': { rows: 3, why: 'its two selects are the category and priority vocabularies; assignee and location go to SearchSelect' },
    'components/WorkOrdersPanel.jsx': { rows: 5, why: 'its queue select lists the account managers who supervise a building (tens) and, for an Operations Manager, one fixed "My team" row (S131); and the category vocabulary' },
    'pages/Keys.jsx': { rows: 4, why: 'its menu rows are the four key statuses; the holder goes to FilterSelect, the company to ClientNamePicker' },
    'components/SupplyCatalog.jsx': { rows: 1, why: 'its one list of rows is the category datalist (the office\'s short vocabulary); the building picker (S131) is FilterSelect' },
    'components/SpecialServiceModal.jsx': { rows: 1, why: 'its one list of rows is the service-type datalist, the types already used across the book, capped at SPECIAL_SERVICE_SUGGESTIONS_MAX (task 507, UI_RULES §192); it lists no customers or people' },
  };
  const universe = jsx.filter((p) => { const s = readFileSync(p, 'utf8'); return BOOK.test(s) && (s.match(ROWS) || []).length > 0; }).map(rel).sort();
  const unclassified = universe.filter((f) => !CAPPING[f] && !KIT_CAPPING.has(f) && !BOUNDED[f]);
  eq('🔴 every file that lists the team or the book caps or is classified (a new uncapped picker fails here)', unclassified, []);
  const drift = Object.entries(BOUNDED).map(([f, b]) => {
    const n = (read(f).match(ROWS) || []).length;
    return n === b.rows ? null : `${f}: ${n} row markers, classified ${b.rows} (${b.why})`;
  }).filter(Boolean);
  eq('…and a BOUNDED file grows no new list unseen (its row markers are counted)', drift, []);
  eq('…and the ledger names no file that has left the universe', Object.keys(BOUNDED).filter((f) => !universe.includes(f)), []);
}

console.log(`\npicker-cap: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
