// QR-8 — the standard area list. Matt (2026-10-16): "Yes: tick from a list (Lobby, Restrooms,
// Fitness center, Clubroom, Pool, Trash room, Mail room, Elevators, Hallways, Stairwells) and add
// your own." His team types in about 750 buildings (kickoff §H); a list makes that faster and keeps
// the names the same everywhere. The names are what each building's QR labels print and what the
// public scan page reads, so they are stored in English exactly as written (LANG-8) — they are
// data, not catalog lines; the editor's own words around them are (UI_RULES §140).
//
// PURE and node-safe (one import, explicit `.js`): the location's cleaning areas editor
// (components/CleaningAreasEditor) reads it, and app/scripts/test-standard-areas.mjs holds it.
import { newId } from './ids.js';

// Matt's ten, in his order.
export const STANDARD_AREA_NAMES = Object.freeze([
  'Lobby', 'Restrooms', 'Fitness center', 'Clubroom', 'Pool',
  'Trash room', 'Mail room', 'Elevators', 'Hallways', 'Stairwells',
]);

// How two area names are compared: without case, and with the ends and any run of spaces ignored —
// "  lobby " is the Lobby a location already has; "Restroom" is not "Restrooms".
export function areaNameKey(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

const keysOf = (areas) => new Set((Array.isArray(areas) ? areas : []).map((a) => areaNameKey(a?.label)).filter(Boolean));

// The list as the editor shows it: every standard name, in the list's order, and whether the
// location already has an area by that name (`areas` = the editor's current areas, saved or not).
export function standardAreaChoices(areas = []) {
  const have = keysOf(areas);
  return STANDARD_AREA_NAMES.map((name) => ({ name, added: have.has(areaNameKey(name)) }));
}

// The ticked names the location doesn't have yet, in the list's order: what the editor's "Add N areas"
// counts, and what the card's Save Changes adds with the rest (UI_RULES §183). A tick waiting there is a
// change, so the QR codes page asks before a pop-up closes on one. `picked` is any list of names (a Set).
export function pendingStandardAreas(areas = [], picked = []) {
  const want = new Set([...(picked || [])].map(areaNameKey));
  return standardAreaChoices(areas).filter((c) => !c.added && want.has(areaNameKey(c.name))).map((c) => c.name);
}

// The ticked names, added in ONE step: a new area for each ticked standard name the location does
// not have yet, in the LIST's order (not the order they were ticked), after the areas already there,
// which are left exactly as they were. Each new area has the editor's own shape and an id minted
// ONCE, here, by `mintId` (the app's `newId('area')` unless a caller passes its own). A name that is
// off the list, already on the location, or ticked twice adds nothing; nothing to add hands back the
// SAME array, so the editor has no change to save.
export function addStandardAreas(areas = [], picked = [], mintId = () => newId('area')) {
  const list = Array.isArray(areas) ? areas : [];
  const want = new Set((Array.isArray(picked) ? picked : []).map(areaNameKey));
  const have = keysOf(list);
  const added = [];
  for (const name of STANDARD_AREA_NAMES) {
    const k = areaNameKey(name);
    if (!want.has(k) || have.has(k)) continue;
    have.add(k);
    added.push({ id: mintId(), label: name, instructions: '', mediaRefs: [] });
  }
  return added.length ? [...list, ...added] : list;
}
