// The office's OWN checklist and inspection wording in Spanish and Creole (LANG-6; CS-193, CS-850).
// PURE and node-safe — the fill, the template editor's Translations view, the inspection fill, the
// server's template save, the fill cron and the demo stub all read it, so they cannot disagree.
//
// 🔴 THE SYSTEM TRANSLATES (Daniel, 2026-10-15; his standing rule of 2026-10-03: Google Cloud
// Translation, never a person in the loop). Every section and item is translated into Spanish and
// Haitian Creole by the SERVER when the template is saved (api/_lib/qc/store saveTemplate →
// fillSchemaTranslations → api/_lib/translateStore translateAll), and the ones saved before this
// rule are filled by the ops-alerts cron (api/_lib/translateFill). Nobody checks a line; the
// office MAY type its own wording for one, which then stays while the English it was written for
// stays. A translation lives BESIDE the label it translates, inside the schema (additive: a node
// without one is exactly as before, no migration):
//
//   { id, label: 'Mop the lobby floor', …,
//     i18n: { es: { label: 'Trapear el piso del vestíbulo', en: 'Mop the lobby floor', source: 'machine' },
//             ht: { label: '…', en: 'Mop the lobby floor', source: 'human' } } }
//
//   en      — the English the line was made from. When the office rewords the English, the old
//             line no longer matches it and stops showing; the next save translates the new English.
//   source  — 'machine' (written by the server's translation) or 'human' (the office's own words).
//             Only the server writes 'machine': a line the browser sends that is not exactly the one
//             the template already held is saved as 'human' (sanitizeSchemaTranslations).
//   v       — on a machine line, the TRANSLATOR_VERSION that made it; an older one is redone.
//
// THE NAME is translated the same way. Its lines ride in the version's schema as `nameI18n`
// (same entry shape, made from the name THIS version goes live with — so a draft that renames a
// live template carries the new name's line until Publish, CS-669), and the server copies the
// published version's onto the template row as `name_i18n` (at publish, at copy, by the fill) so
// every list a cleaner reads names it in their language without reading a schema
// (templateNameOf). The customer hub keeps the English (LANG-8).
//
// Rows saved before 2026-10-15 may carry `status` / `checkedBy` / `checkedAt` (the retired Checked
// tick, CS-850): they are read like any other line and dropped at the next save.
//
// 🔴 WHAT IS NEVER READ: the COUNT. lib/checklistCount counts item KEYS against the published schema
// and never reads a label in any language; a submission POSTS the office's English label
// (components/ChecklistFill, InspectionFill, pages/crew/CrewChecklist), so a stored record reads
// the same in the office whatever language it was filled in. test-i18n-template-labels.mjs.
export const TRANSLATED_LANGUAGES = Object.freeze(['es', 'ht']);
export const TRANSLATION_SOURCES = Object.freeze(['machine', 'human']);
// The version of the system's translation a machine line was made by, stamped on it as `v`. A machine
// line from an older version is due again (translationState 'pending'): the fill and the next save
// redo it, while readers keep seeing it until then; the office's own lines are never redone.
//   1 (no `v`) — 2026-10-15, the first fill: customer and building names went through Google.
//   2 — CS-856: names stay exactly as written (src/i18n/terms shapeProperNouns).
export const TRANSLATOR_VERSION = 2;
// The longest translation kept (a label is a line on a phone; the editor's own fields are far
// shorter). Anything longer is dropped rather than cut mid-word.
export const MAX_TRANSLATION_CHARS = 500;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const entryOf = (node, lang) => (isObj(node?.i18n) && isObj(node.i18n[lang]) ? node.i18n[lang] : null);
const current = (node, tr) => !!tr && !!text(tr.label) && tr.en === (node?.label ?? '');

// A node's line in one language, for the Translations view:
//   'machine'  translated by the server, for today's English     'human'  the office's own words
//   'pending'  nothing for today's English yet (none, or the English changed): the next save translates it
export function translationState(node, lang) {
  const tr = entryOf(node, lang);
  if (!current(node, tr)) return 'pending';
  if (tr.source === 'human') return 'human';
  return (Number.isInteger(tr.v) ? tr.v : 1) < TRANSLATOR_VERSION ? 'pending' : 'machine';
}

// The label a reader in `lang` sees: the line for TODAY's English, machine or typed, else the
// office's own label. No other condition.
export function checklistLabel(node, lang) {
  const base = typeof node?.label === 'string' ? node.label : '';
  if (!lang || lang === 'en' || !TRANSLATED_LANGUAGES.includes(lang)) return base;
  const tr = entryOf(node, lang);
  return current(node, tr) ? tr.label : base;
}

// The NAME a reader in `lang` sees: its line for today's name, else the name itself. `i18n` is a
// version's `schema.nameI18n` or a row's `name_i18n` (same shape).
export function templateNameLabel(name, i18n, lang) {
  return checklistLabel({ label: typeof name === 'string' ? name : '', i18n: isObj(i18n) ? i18n : undefined }, lang);
}
// …from a template ROW (templates/list, templates/get): `name` + the denormalized `name_i18n`.
export function templateNameOf(template, lang) {
  return templateNameLabel(template?.name, template?.name_i18n, lang);
}
// The name as a node, for the rules below (its English is the name the version goes live with).
const nameNode = (schema, name) => ({ label: typeof name === 'string' ? name : '', i18n: isObj(schema?.nameI18n) ? schema.nameI18n : undefined });

// Every section and item with English to translate, in order.
export function translatableNodes(areas) {
  const out = [];
  for (const a of Array.isArray(areas) ? areas : []) {
    if (text(a?.label)) out.push({ kind: 'area', areaId: a.id, id: a.id, node: a });
    for (const i of Array.isArray(a?.items) ? a.items : []) {
      if (text(i?.label)) out.push({ kind: 'item', areaId: a.id, id: i.id, node: i });
    }
  }
  return out;
}

// The office types (or clears) its own wording for one node, in the Translations view. Clearing it
// leaves the line to the server's translation at the next save.
export function withTranslation(node, lang, label) {
  const i18n = { ...(isObj(node?.i18n) ? node.i18n : {}) };
  const clean = typeof label === 'string' ? label : '';
  if (!clean.trim()) delete i18n[lang];
  else i18n[lang] = { label: clean, en: node?.label ?? '', source: 'human' };
  const next = { ...node, i18n };
  if (!Object.keys(i18n).length) delete next.i18n;
  return next;
}

// ── the SAVE-side rule (server route + demo stub) ─────────────────────────────────────────
// One entry, cleaned: a known language, a real label within the limit, the English it was made
// from. Its source is kept only when it is EXACTLY the line the version being replaced held (the
// office left it alone); any other line from the browser is the office's own ('human').
function cleanEntry(entry, prevEntry, englishNow) {
  if (!isObj(entry)) return null;
  const label = typeof entry.label === 'string' ? entry.label.trim() : '';
  if (!label || label.length > MAX_TRANSLATION_CHARS) return null;
  const en = typeof entry.en === 'string' ? entry.en : englishNow;
  const same = isObj(prevEntry) && text(prevEntry.label) === label && prevEntry.en === en;
  const source = same && TRANSLATION_SOURCES.includes(prevEntry.source) ? prevEntry.source : 'human';
  // A machine line the office left alone keeps the version it was made by.
  const keepV = same && source === 'machine' && Number.isInteger(prevEntry.v);
  return keepV ? { label, en, source, v: prevEntry.v } : { label, en, source };
}
function cleanNode(node, prevNode) {
  if (!isObj(node)) return node;
  const next = { ...node };
  delete next.i18n;
  if (!isObj(node.i18n)) return next;
  const i18n = {};
  for (const lang of TRANSLATED_LANGUAGES) {
    const e = cleanEntry(node.i18n[lang], entryOf(prevNode, lang), node.label ?? '');
    if (e) i18n[lang] = e;
  }
  if (Object.keys(i18n).length) next.i18n = i18n;
  return next;
}
const mapNodes = (schema, fn) => ({
  ...schema,
  areas: schema.areas.map((a) => {
    if (!isObj(a)) return a;
    const next = fn(a, 'area', null);
    if (Array.isArray(a.items)) next.items = a.items.map((i) => (isObj(i) ? fn(i, 'item', a) : i));
    return next;
  }),
});
// The schema as it may be SAVED: every translation cleaned (above) — the name's (`nameI18n`, made
// from `name`, the name this version goes live with) as well — nothing else touched. `prevSchema`
// is the version being replaced. A schema without translations comes back equal.
export function sanitizeSchemaTranslations(prevSchema, schema, { name } = {}) {
  if (!isObj(schema) || !Array.isArray(schema.areas)) return schema;
  const prevAreas = new Map((Array.isArray(prevSchema?.areas) ? prevSchema.areas : []).filter(isObj).map((a) => [a.id, a]));
  const next = mapNodes(schema, (node, kind, area) => {
    if (kind === 'area') return cleanNode(node, prevAreas.get(node.id) || null);
    const prevItems = new Map((Array.isArray(prevAreas.get(area.id)?.items) ? prevAreas.get(area.id).items : []).filter(isObj).map((i) => [i.id, i]));
    return cleanNode(node, prevItems.get(node.id) || null);
  });
  if (!('nameI18n' in schema)) return next;
  const cleaned = cleanNode({ label: typeof name === 'string' ? name : '', i18n: schema.nameI18n }, { i18n: prevSchema?.nameI18n });
  const { nameI18n: _drop, ...rest } = next;
  return cleaned.i18n ? { ...rest, nameI18n: cleaned.i18n } : rest;
}

// ── the SYSTEM's translation of a schema ──────────────────────────────────────────────────
// Every section and item whose line is not for today's English (none, or the English changed) is
// translated by `translate(lang, english[]) → (string | null)[]` (the server: translateAll) and set
// as a 'machine' line; the office's own line for today's English stays, and so does a machine line
// already current (never re-sent). A line that could not be had stays as it was (the English shows).
// → { schema, translated, missing } (missing = nodes still without a line for today's English).
export async function fillSchemaTranslations(schema, translate, { name } = {}) {
  if (!isObj(schema) || !Array.isArray(schema.areas) || typeof translate !== 'function') return { schema, translated: 0, missing: 0 };
  const named = typeof name === 'string' && name.trim() ? nameNode(schema, name.trim()) : null;
  const nodes = [...translatableNodes(schema.areas), ...(named ? [{ kind: 'name', node: named }] : [])];
  const lines = {};
  for (const lang of TRANSLATED_LANGUAGES) {
    const want = [...new Set(nodes.filter(({ node }) => translationState(node, lang) === 'pending').map(({ node }) => node.label))];
    if (!want.length) { lines[lang] = new Map(); continue; }
    let got = [];
    try { got = await translate(lang, want); } catch { got = []; }
    lines[lang] = new Map(want.map((en, i) => [en, typeof got?.[i] === 'string' ? got[i].trim() : '']));
  }
  let translated = 0;
  let missing = 0;
  const fillNode = (node) => {
    if (!text(node.label)) return { ...node };
    let i18n = isObj(node.i18n) ? { ...node.i18n } : null;
    for (const lang of TRANSLATED_LANGUAGES) {
      if (translationState(node, lang) !== 'pending') continue;
      const line = lines[lang].get(node.label) || '';
      if (line && line.length <= MAX_TRANSLATION_CHARS) {
        i18n = { ...(i18n || {}), [lang]: { label: line, en: node.label, source: 'machine', v: TRANSLATOR_VERSION } };
        translated += 1;
      } else missing += 1;
    }
    return i18n ? { ...node, i18n } : { ...node };
  };
  const next = mapNodes(schema, fillNode);
  if (named) {
    const filled = fillNode(named);
    if (filled.i18n) next.nameI18n = filled.i18n;
  }
  return { schema: next, translated, missing };
}

// Whether any section or item of `schema` lacks a line for today's English in a language (what the
// fill cron looks for in the templates saved before the rule).
export function schemaNeedsTranslation(schema, { name } = {}) {
  const nodes = translatableNodes(schema?.areas);
  if (typeof name === 'string' && name.trim()) nodes.push({ node: nameNode(schema, name.trim()) });
  return nodes.some(({ node }) => TRANSLATED_LANGUAGES.some((lang) => translationState(node, lang) === 'pending'));
}

// How a template's lines stand, per language: { total, machine, human, pending }.
export function translationProgress(areas, lang) {
  const nodes = translatableNodes(areas);
  const tally = { total: nodes.length, machine: 0, human: 0, pending: 0 };
  for (const { node } of nodes) tally[translationState(node, lang)] += 1;
  return tally;
}
