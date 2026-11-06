// How many options a picker may RENDER at once — PURE / node-safe, so the kit component,
// its design-system card and the suite read one rule and one sentence (UI_RULES §127).
//
// 🔴 WHY. `FilterSelect` filters as you type but rendered EVERY match on open. At this
// build's stated scale — 1,500 cleaners and 750 customers, and ~3,750 checklists across
// them (plan §7) — a cleaner picker painted 1,500 menu rows before a single keystroke, and
// the Assignments screen puts three such pickers on one customer card. Nothing failed and
// nothing warned; the menu just got slower as the book grew, which a seeded demo hides
// completely — the same shape as the un-paged tables UI_RULES §72 was written for.
//
// The rule is a CAP ON RENDERING, never on reach: the component filters FIRST and caps
// SECOND, so typing gets to the 1,500th option exactly as before. What is hidden is
// counted and said, never dropped silently.

import { english, msg } from '../i18n/core.js';
import { compareUsersByName } from './roles.js';

// The default cap. One number, so a caller never retypes it and a retune is one edit.
// 50 rows is about two screens of a desktop menu and well past what anyone scans before
// they start typing.
export const PICKER_MAX_VISIBLE = 50;

// The one sentence a capped list says. Plain, not a tooltip (a tooltip never shows on a
// phone), and it names the action that reaches the rest. A catalog line (CS-193): `note` is
// its English, `noteMsg` the message a screen renders in the reader's language.
export function cappedNote(shown, total) {
  return english('common.cappedNote', { shown, total });
}

// `options` are the ALREADY-FILTERED rows, in the order they should render (the caller's
// pinned default row first). `maxVisible` of 0, undefined or a negative number means no
// cap — then the input array is returned by reference and nothing is said, which is
// exactly the behaviour before this existed.
export function capOptions(options, maxVisible = 0) {
  const rows = options || [];
  if (!(maxVisible > 0) || rows.length <= maxVisible) {
    return { shown: rows, hidden: 0, note: null, noteMsg: null };
  }
  const shown = rows.slice(0, maxVisible);
  return {
    shown, hidden: rows.length - shown.length,
    note: cappedNote(shown.length, rows.length),
    noteMsg: msg('common.cappedNote', { shown: shown.length, total: rows.length }),
  };
}

// The people a picker offers (CS-713, CS-724, 2026-10-13): the ACTIVE members, alphabetical by name
// (UI_RULES §51), optionally only `roles` (the office: SUPERVISOR_ROLES), as { value: id, label }.
// Keys' "Who is taking the key?" listed every login in the order added; the Inspections list's
// follow-up offered all 1,541 people, cleaners included. A picker over these still caps (FilterSelect).
export function personOptions(users, { roles = null } = {}) {
  return (Array.isArray(users) ? users : [])
    .filter((u) => u && u.id && u.status === 'active' && (!roles || roles.includes(u.role)))
    .slice().sort(compareUsersByName)
    .map((u) => ({ value: u.id, label: u.name || u.email || u.id }));
}

// The crew picker's rows (components/CrewPicker; CS-673 — a clean's Crew field drew one chip
// per active person, 1,544 at Matt's size). Typing narrows by name FIRST; then whoever was
// already picked when the menu opened (`leadIds`, a snapshot, so a toggle never moves a row
// under the cursor) leads, in roster order, so the cap can never hide the people on the clean;
// then the cap. `matches` is every match (Enter picks the one match). After the people picked,
// the cleaners who work at the clean's customer (`preferIds`, lib/worksAt linkedCleanerIds; the
// Team import's Account column) come next, in roster order, ahead of everyone else.
export function crewPickerRows(pool, { query = '', leadIds = [], preferIds = [], maxVisible = PICKER_MAX_VISIBLE } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const lead = new Set(leadIds || []);
  const prefer = new Set(preferIds || []);
  const first = [];
  const next = [];
  const rest = [];
  for (const u of pool || []) {
    if (q && !String(u?.name || '').toLowerCase().includes(q)) continue;
    (lead.has(u.id) ? first : prefer.has(u.id) ? next : rest).push(u);
  }
  const matches = first.concat(next, rest);
  return { matches, ...capOptions(matches, maxVisible) };
}
