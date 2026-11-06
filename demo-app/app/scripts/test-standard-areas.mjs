// QR-8 — the standard area list in a location's cleaning areas editor.
//
// Matt (2026-10-16), answering "When your team adds a building's areas, should they pick from a
// standard list?": "Yes: tick from a list (Lobby, Restrooms, Fitness center, Clubroom, Pool, Trash
// room, Mail room, Elevators, Hallways, Stairwells) and add your own." His team types in about 750
// buildings (kickoff §H); a list makes that faster and keeps the names the same everywhere — and
// the names are what each QR label prints and the public page reads (LANG-8), so they are stored
// in English exactly as written.
//
// WHAT IT HOLDS
//   §1  the list: Matt's ten names, in his order — read from his ANSWERED question in the Review
//       catalog (data/buildDecisions.js QR-8 (a)), the source of truth, never a restated literal
//   §2  an area the location already has is shown as added, matched without case or extra spaces
//   §3  ticking several adds them in ONE step: in the list's order, after the areas already there
//       (left exactly as they were), each a new area of the editor's own shape whose id is minted
//       ONCE, by the caller's minter; nothing twice, nothing off the list, nothing already there;
//       the ticks still waiting (pendingStandardAreas), what the card's Save Changes adds with the rest
//   §4  the editor's wiring (mechanical over the .jsx — plain node cannot import it): the tick
//       boxes from the one list, the one onChange, "Add your own" as before, catalog words (§140),
//       the ticks held by the caller when it holds them (CleaningInstructionsCard, UI_RULES §183)
//
// REGRESSION (THE LAW II.3): on 90d7ca9e lib/standardAreas.js does not exist and the editor has
// no list, so every check below reports what it wanted.
//
//   node app/scripts/test-standard-areas.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const imp = (rel) => import(pathToFileURL(path.join(APP, rel)).href).catch(() => ({}));

const lib = await imp('src/lib/standardAreas.js');
const { DECISION_BY_ID } = await imp('src/data/buildDecisions.js');

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — this repo's suites disagree, so it is stated.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (name) => (typeof lib[name] === 'function' ? lib[name] : () => undefined);

const NAMES = Array.isArray(lib.STANDARD_AREA_NAMES) ? lib.STANDARD_AREA_NAMES : [];
const choicesOf = fn('standardAreaChoices');
const addAreas = fn('addStandardAreas');
const keyOf = fn('areaNameKey');
const pendingOf = fn('pendingStandardAreas');
// 🔴 A negative check over a rule that does not exist passes for the wrong reason (an empty list
// "never repeats", `Object.isFrozen(undefined)` is true): every such check needs the rule first.
const HAS = NAMES.length === 10 && typeof lib.addStandardAreas === 'function' && typeof lib.areaNameKey === 'function';

// ── §1 the list ─────────────────────────────────────────────────────────────
// Matt's own words, from the question he answered: option (a)'s "(…)" is the list.
const qr8 = DECISION_BY_ID?.['QR-8'] || null;
const answered = (qr8?.options || []).find((o) => o.id === 'a')?.label || '';
const FROM_MATT = (/\(([^)]*)\)/.exec(answered)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
ok('§1 Matt\'s answered question (QR-8 a) is readable from the Review catalog', FROM_MATT.length === 10, JSON.stringify(FROM_MATT));
ok('§1 the standard list is exactly his ten names, in his order', NAMES.length === 10 && NAMES.join('|') === FROM_MATT.join('|'), NAMES.join('|'));
ok('§1 …stored in English exactly as he wrote them (they print on the labels, LANG-8)', HAS && NAMES.every((n) => FROM_MATT.includes(n)));
ok('§1 the list is ONE frozen constant (nothing can push a name onto it at run time)', HAS && Object.isFrozen(lib.STANDARD_AREA_NAMES));
ok('§1 no name on the list repeats, once spacing and case are ignored', HAS && new Set(NAMES.map((n) => keyOf(n))).size === NAMES.length);

// ── §2 shown as added ───────────────────────────────────────────────────────
ok('§2 names compare without case', HAS && keyOf('LOBBY') === 'lobby' && keyOf('Lobby') === 'lobby', JSON.stringify(keyOf('LOBBY')));
ok('§2 …and without extra spaces, inside or at the ends', HAS && keyOf('  Mail    room ') === keyOf('Mail room') && keyOf('Mail room') === 'mail room', JSON.stringify(keyOf('  Mail    room ')));
ok('§2 …but a different word is a different area ("Restroom" is not "Restrooms")', keyOf('Restroom') !== keyOf('Restrooms'));
eq('§2 a missing or non-text name compares as nothing', keyOf(undefined), '');
{
  const areas = [
    { id: 'a1', label: '  lobby ' },
    { id: 'a2', label: 'MAIL   ROOM' },
    { id: 'a3', label: 'Restroom' },
    { id: 'a4', label: '' },
    null,
  ];
  const choices = choicesOf(areas) || [];
  ok('§2 the choices are the whole list, in its order', choices.length === 10 && choices.map((c) => c.name).join('|') === NAMES.join('|'), JSON.stringify(choices));
  const added = choices.filter((c) => c.added).map((c) => c.name);
  ok('§2 an area the location has is shown as added — "  lobby " is the Lobby, "MAIL   ROOM" the Mail room', added.length === 2 && added.includes(NAMES[0]) && added.includes(NAMES[6]), JSON.stringify(added));
  ok('§2 …"Restroom" does not make "Restrooms" added', choices.find((c) => c.name === 'Restrooms')?.added === false);
  ok('§2 a location with no areas has nothing added', (choicesOf([]) || []).length === 10 && (choicesOf([]) || []).every((c) => c.added === false));
  ok('§2 no areas at all (undefined) reads as none', (choicesOf(undefined) || []).length === 10);
}

// ── §3 several at once, ids minted once ─────────────────────────────────────
{
  let minted = 0;
  const mint = () => { minted += 1; return `area_test_${minted}`; };
  const before = [{ id: 'a_own', label: 'Second floor', instructions: 'Vacuum', mediaRefs: [] }, { id: 'a_lob', label: 'lobby', instructions: '', mediaRefs: [] }];
  // Ticked out of order, one twice, one already there, one off the list.
  const after = addAreas(before, ['Pool', 'Clubroom', 'Lobby', 'Pool', 'Boiler room'], mint) || [];
  ok('§3 the areas already there are left exactly as they were, first, in their order',
    after.length >= 2 && after[0] === before[0] && after[1] === before[1], JSON.stringify(after));
  const fresh = after.slice(before.length);
  ok('§3 the ticked names are added in ONE step, in the LIST\'s order (Clubroom before Pool), not the order ticked',
    fresh.map((a) => a.label).join('|') === 'Clubroom|Pool', JSON.stringify(fresh.map((a) => a.label)));
  eq('§3 an id is minted ONCE per new area (two new areas, two mints)', minted, 2);
  ok('§3 …each new area carries the id its mint returned, all distinct', fresh.length === 2 && fresh[0].id === 'area_test_1' && fresh[1].id === 'area_test_2');
  ok('§3 a new area has the editor\'s own shape: { id, label, instructions: "", mediaRefs: [] }',
    fresh.length === 2 && fresh.every((a) => Object.keys(a).sort().join(',') === 'id,instructions,label,mediaRefs' && a.instructions === '' && Array.isArray(a.mediaRefs) && a.mediaRefs.length === 0), JSON.stringify(fresh));
  ok('§3 a name already on the location ("lobby") is not added again', HAS && after.filter((a) => keyOf(a.label) === keyOf('Lobby')).length === 1);
  ok('§3 a name off the list ("Boiler room") is not added through it (that is "Add your own")', HAS && after.length === 4 && !after.some((a) => a.label === 'Boiler room'));
  ok('§3 the input list is not changed in place', HAS && after !== before && before.length === 2);
  const again = addAreas(after, ['Pool', 'Clubroom'], mint) || [];
  ok('§3 adding the same ticks again adds nothing and mints nothing (idempotent)', again.length === after.length && minted === 2);
  ok('§3 …and hands back the SAME list, so the editor has no change to save', again === after);
  const none = addAreas(before, [], mint);
  ok('§3 nothing ticked is no change at all', none === before && minted === 2);
  const all = addAreas([], NAMES, mint) || [];
  ok('§3 all ten into an empty location: ten areas, in the list\'s order, ten mints', all.length === 10 && all.map((a) => a.label).join('|') === NAMES.join('|') && minted === 12);
  const spaced = addAreas([{ id: 'x', label: '  POOL  ' }], ['  pool', 'fitness CENTER '], mint) || [];
  ok('§3 a tick is matched like a name: spacing and case ignored, the list\'s own spelling stored',
    spaced.length === 2 && spaced[1].label === 'Fitness center' && minted === 13, JSON.stringify(spaced));
  // The ticks still waiting (2026-10-30, UI_RULES §183): what "Add N areas" counts and what the card's
  // Save Changes adds with the rest. Ticked, then Save Changes, used to save nothing under an "updated"
  // toast, and the QR codes page's pop-up closed on ticks without asking.
  const waiting = pendingOf([], new Set(['Pool', 'Lobby']));
  ok('§3 the ticks still waiting are named in the list\'s order, from a Set of ticks as the card holds them',
    JSON.stringify(waiting) === JSON.stringify(['Lobby', 'Pool']), JSON.stringify(waiting));
  const had = pendingOf([{ id: 'x', label: '  lobby ' }], ['Lobby', ' pool ', 'Boiler room']);
  ok('§3 …a tick the location already has, or one off the list, is not waiting; spacing and case ignored',
    JSON.stringify(had) === JSON.stringify(['Pool']), JSON.stringify(had));
  ok('§3 …nothing ticked (or no ticks at all) is nothing waiting',
    JSON.stringify(pendingOf([], new Set())) === '[]' && JSON.stringify(pendingOf([], null)) === '[]');
  ok('§3 …and what waits is exactly what one add puts in (the card saves them through addStandardAreas)',
    HAS && (addAreas([], [...new Set(['Pool', 'Lobby'])], mint) || []).map((a) => a.label).join('|') === (waiting || []).join('|'));
  const viaDefault = addAreas([], ['Pool']) || [];
  ok('§3 with no minter given it mints with the app\'s own id helper (an "area_" id)', viaDefault.length === 1 && /^area_/.test(viaDefault[0]?.id || ''), JSON.stringify(viaDefault));
}

// ── §4 the editor's wiring ──────────────────────────────────────────────────
{
  const EDITOR = code('src/components/CleaningAreasEditor.jsx');
  const LIB = code('src/lib/standardAreas.js');
  ok('§4 the editor reads the ONE list and its two rules from lib/standardAreas',
    /from '\.\.\/lib\/standardAreas'/.test(EDITOR) && /standardAreaChoices\(/.test(EDITOR) && /addStandardAreas\(/.test(EDITOR));
  ok('§4 …and spells no standard name itself', /from '\.\.\/lib\/standardAreas'/.test(EDITOR)
    && !NAMES.some((n) => EDITOR.includes(`'${n}'`)) && !/Fitness center|Trash room|Stairwells/.test(EDITOR));
  ok('§4 each name is a tick box, an added one ticked and switched off',
    /type="checkbox"/.test(EDITOR) && /checked=\{c\.added \|\| picked\.has\(c\.name\)\}/.test(EDITOR) && /disabled=\{c\.added\}/.test(EDITOR));
  ok('§4 …and an added one says so in words, not only by being off (UI_RULES §118)', /c\.added && <span[^>]*>\{t\('areaEditor\.stdAdded'\)\}/.test(EDITOR));
  ok('§4 the ticked names go in with ONE onChange through the rule (the same write as "Add your own")',
    /onChange\(addStandardAreas\(areas, \[\.\.\.picked\]\)\)/.test(EDITOR.replace(/\s+/g, ' ')) || /const next = addStandardAreas\(areas, \[\.\.\.picked\]\);/.test(EDITOR));
  ok('§4 the list is a labelled group of tick boxes', /role="group"/.test(EDITOR) && /aria-labelledby=\{/.test(EDITOR));
  ok('§4 the ticks can be held by the caller (picked / onPickedChange), and are held here when they aren\'t',
    /picked: pickedHeld = null, onPickedChange = null/.test(EDITOR) && /const picked = pickedHeld instanceof Set \? pickedHeld : pickedOwn;/.test(EDITOR)
    && /onPickedChange \? onPickedChange\(next\) : setPickedOwn\(next\)/.test(EDITOR));
  ok('§4 the add button counts the ticks still waiting through the rule', /const count = pendingStandardAreas\(areas, picked\)\.length;/.test(EDITOR));
  ok('§4 "Add your own" still adds one blank area with a minted id', /newId\('area'\)/.test(EDITOR) && /t\('areaEditor\.addOwn'\)/.test(EDITOR));
  ok('§4 the add button is off with nothing ticked, its reason in visible words', /disabled=\{count === 0\}/.test(EDITOR) && /areaEditor\.stdHint/.test(EDITOR) && /areaEditor\.stdAllAdded/.test(EDITOR));
  ok('§4 the rule module stays pure: its one import is the id helper', (LIB.match(/^import /gm) || []).length === 1 && /from '\.\/ids\.js'/.test(LIB));
  // The editor's own words are catalog lines (§140): the coverage suite holds the whole file.
  const CONVERTED = read('scripts/test-i18n-coverage.mjs');
  ok('§4 the editor is on the translation coverage list (no English a reader sees)', /'src\/components\/CleaningAreasEditor\.jsx'/.test(CONVERTED));
  const EN = read('src/i18n/catalog/en.js');
  for (const k of ['areaEditor.stdLegend', 'areaEditor.stdHint', 'areaEditor.stdAdded', 'areaEditor.stdAdd', 'areaEditor.stdAddNone', 'areaEditor.stdAllAdded', 'areaEditor.addOwn']) {
    ok(`§4 the catalog has ${k}`, EN.includes(`'${k}':`));
  }
  const CSS = read('src/index.css');
  ok('§4 a phone gets two names a row at the 44px tap floor', /\.cleaning-area-std-pick \{[^}]*min-height: var\(--control-height-lg\)/.test(CSS));
}

if (fails.length) { console.error('\nstandard-areas FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nstandard-areas: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
