// The shared checklist counting rule — `src/lib/checklistCount.js` (CS-494).
//
// ONE rule for `completed_count` / `total_count`, used by the server store
// (`api/_lib/qc/store.js submitChecklist`), the demo stub (`lib/qcApi.js`) and the seeds
// (`data/demoStubs.js`, `scripts/seed-backend.mjs`), so those four can never drift into
// four different answers about whether a clean's checklist is finished.
//
// The route-level proof that the SERVER measures the right list lives in
// `test-checklist-submit-count-route.mjs`; this suite pins the rule itself — sections,
// duplicates, unknown keys, both item-key spellings, and the empty schema.
//
//   node app/scripts/test-checklist-count.mjs
import {
  countChecklistSubmission, checklistSchemaKeys, submittedItemKey,
  checklistSubmitRefusal, NOT_A_CHECKLIST_ERROR,
} from '../src/lib/checklistCount.js';
// The N/A half (CS-546) comes off the NAMESPACE on purpose: on the pre-fix tree these are
// simply `undefined` rather than a link error, so the red run reports the real failures
// below instead of refusing to load the suite. Their existence is asserted first.
import * as checklistCount from '../src/lib/checklistCount.js';
import { countSchemaItems } from '../src/lib/inspections.js';
import { isChecklistComplete } from '../src/lib/crewChecklist.js';

const itemAllowsNa = (...a) => (checklistCount.itemAllowsNa ? checklistCount.itemAllowsNa(...a) : undefined);
const defaultNaAllowed = (...a) => (checklistCount.defaultNaAllowed ? checklistCount.defaultNaAllowed(...a) : undefined);

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const counted = (schema, items) => {
  const c = countChecklistSubmission(schema, items);
  return `${c.completed_count}/${c.total_count}`;
};

const item = (id) => ({ id, label: id, photoRequired: false, naAllowed: true });
// Two sections, five items — the shape `InspectionTemplateEditor` writes.
const SCHEMA = {
  areas: [
    { id: 'a1', label: 'Close-Out', items: [item('i1'), item('i2'), item('i3')] },
    { id: 'a2', label: 'Cart', items: [item('i4'), item('i5')] },
  ],
};
// What ChecklistFill posts for a schema: one entry per item, keyed by the item's id.
const fill = (schema, checked) => schema.areas.flatMap((a) => a.items.map((i) => ({
  key: i.id, label: i.label, checked: checked === 'all' ? true : checked.includes(i.id), note: null,
})));

// ── the keys a schema offers ─────────────────────────────────────────────────
eq('every item across every section is countable, in schema order',
  checklistSchemaKeys(SCHEMA), ['i1', 'i2', 'i3', 'i4', 'i5']);
eq('an empty schema offers nothing', checklistSchemaKeys({ areas: [] }), []);
eq('a missing schema offers nothing', checklistSchemaKeys(null), []);
eq('a malformed schema offers nothing', checklistSchemaKeys({ areas: 'nope' }), []);
eq('a section with no items contributes nothing',
  checklistSchemaKeys({ areas: [{ id: 'a1', label: 'Empty' }, SCHEMA.areas[1]] }), ['i4', 'i5']);
eq('an item with no usable id is not countable',
  checklistSchemaKeys({ areas: [{ id: 'a1', items: [item('i1'), { label: 'no id' }, { id: '  ' }] }] }), ['i1']);
eq('a REPEATED id is one countable item',
  checklistSchemaKeys({ areas: [{ id: 'a1', items: [item('i1'), item('i1')] }] }), ['i1']);

// The publish gate and the counting rule agree on every schema the editor can produce.
ok('total agrees with lib/inspections countSchemaItems on an editor-shaped schema',
  countChecklistSubmission(SCHEMA, []).total_count === countSchemaItems(SCHEMA),
  `${countChecklistSubmission(SCHEMA, []).total_count} vs ${countSchemaItems(SCHEMA)}`);

// ── the key a submitted item names ───────────────────────────────────────────
eq('ChecklistFill spells it `key`', submittedItemKey({ key: 'i1', checked: true }), 'i1');
eq('the seeded + backend rows spell it `item_key`', submittedItemKey({ item_key: 'i1', checked: true }), 'i1');
eq('`key` wins when both are present', submittedItemKey({ key: 'i1', item_key: 'i2' }), 'i1');
eq('surrounding whitespace is not a different item', submittedItemKey({ key: ' i1 ' }), 'i1');
eq('an item with neither has no key', submittedItemKey({ checked: true }), null);
eq('a non-object has no key', submittedItemKey('i1'), null);

// ── counting a submission ────────────────────────────────────────────────────
eq('a full genuine submission is complete', counted(SCHEMA, fill(SCHEMA, 'all')), '5/5');
ok('…and isChecklistComplete agrees', isChecklistComplete(countChecklistSubmission(SCHEMA, fill(SCHEMA, 'all'))));
eq('a partial submission counts what was ticked', counted(SCHEMA, fill(SCHEMA, ['i1', 'i4'])), '2/5');
eq('a submission with nothing ticked is 0 of the total', counted(SCHEMA, fill(SCHEMA, [])), '0/5');
eq('an item_key-spelled submission counts the same',
  counted(SCHEMA, fill(SCHEMA, 'all').map(({ key, checked }) => ({ item_key: key, checked }))), '5/5');

// The forgery the rule exists to stop: the payload's own length is never the total.
eq('an invented ticked key counts nothing and never sets the total',
  counted(SCHEMA, [{ key: 'ghost', checked: true }]), '0/5');
ok('…so it is not complete', !isChecklistComplete(countChecklistSubmission(SCHEMA, [{ key: 'ghost', checked: true }])));
eq('unknown keys never inflate a real submission',
  counted(SCHEMA, [...fill(SCHEMA, ['i1']), { key: 'g1', checked: true }, { key: 'g2', checked: true }]), '1/5');
eq('a repeated ticked key counts once',
  counted(SCHEMA, [{ key: 'i1', checked: true }, { key: 'i1', checked: true }, { key: 'i1', checked: true }]), '1/5');
eq('a key ticked in ANY entry counts as done (a duplicate is a client bug, not intent)',
  counted(SCHEMA, [{ key: 'i1', checked: false }, { key: 'i1', checked: true }]), '1/5');
eq('items the payload omits still count toward the total',
  counted(SCHEMA, [{ key: 'i1', checked: true }]), '1/5');
eq('completed can never exceed total',
  counted({ areas: [{ id: 'a1', items: [item('i1')] }] }, [{ key: 'i1', checked: true }, { key: 'i1', checked: true }, { key: 'x', checked: true }]), '1/1');

// ── shapes that must not throw ───────────────────────────────────────────────
eq('an empty schema is 0/0', counted({ areas: [] }, [{ key: 'i1', checked: true }]), '0/0');
ok('…and 0/0 is never complete', !isChecklistComplete(countChecklistSubmission({ areas: [] }, [])));
eq('a missing schema is 0/0', counted(null, fill(SCHEMA, 'all')), '0/0');
eq('missing items are 0 of the total', counted(SCHEMA, null), '0/5');
eq('junk entries are skipped, not counted', counted(SCHEMA, [null, 'i1', 42, { checked: true }]), '0/5');
eq('a truthy non-boolean `checked` still counts', counted(SCHEMA, [{ key: 'i1', checked: 1 }]), '1/5');

// ── N/A: the office's per-item exception (CS-546) ────────────────────────────
// Matt's rule is that the whole checklist is done before clock-out with NO way around it
// on the cleaner's side. The office's per-item "N/A ok" flag is the one sanctioned
// exception, so it is counted HERE — against the published schema — and nowhere else: a
// `na` on an item the schema does not allow is worth exactly as much as a ticked key the
// schema never heard of, which is nothing.
ok('checklistCount exports itemAllowsNa', typeof checklistCount.itemAllowsNa === 'function');
ok('checklistCount exports defaultNaAllowed', typeof checklistCount.defaultNaAllowed === 'function');

eq('an item the office flagged allows N/A', itemAllowsNa({ id: 'i1', naAllowed: true }), true);
eq('the snake spelling the migration documents is the same flag', itemAllowsNa({ id: 'i1', na_allowed: true }), true);
eq('an item without the flag does not', itemAllowsNa({ id: 'i1' }), false);
eq('an item flagged false does not', itemAllowsNa({ id: 'i1', naAllowed: false }), false);
// Strict, unlike a cleaner's own `na`: this is the OFFICE's switch, `InspectionTemplateEditor`
// only ever writes a real boolean, and a stray truthy value must not open the escape hatch.
eq('a truthy non-boolean is not the switch', itemAllowsNa({ id: 'i1', naAllowed: 'yes' }), false);
eq('…nor is 1', itemAllowsNa({ id: 'i1', naAllowed: 1 }), false);
eq('a non-object allows nothing', itemAllowsNa('i1'), false);
eq('nothing allows nothing', itemAllowsNa(null), false);

// A new CHECKLIST item starts with the exception OFF — the office opts in per item.
eq('a new checklist item does NOT allow N/A', defaultNaAllowed('checklist'), false);
eq('a new inspection item still does', defaultNaAllowed('inspection'), true);
eq('an unknown kind follows the inspection default', defaultNaAllowed('audit'), true);
eq('no kind follows the inspection default', defaultNaAllowed(undefined), true);
eq('a padded kind is still the kind it names', defaultNaAllowed(' checklist '), false);

// One section, two items: `n_ok` the office allowed, `n_must` it did not.
const NA_SCHEMA = {
  areas: [{
    id: 'a1',
    label: 'Close-Out',
    items: [
      { id: 'n_ok', label: 'Exterior bins wheeled out', photoRequired: false, naAllowed: true },
      { id: 'n_must', label: 'Alarm set', photoRequired: false, naAllowed: false },
    ],
  }],
};
const naFill = (marks) => NA_SCHEMA.areas[0].items.map((i) => ({
  key: i.id, label: i.label, checked: !!(marks[i.id] === 'checked'), na: marks[i.id] === 'na', note: null,
}));

eq('an N/A-allowed item marked N/A counts as done',
  counted(NA_SCHEMA, naFill({ n_ok: 'na', n_must: 'checked' })), '2/2');
ok('…so the checklist is COMPLETE and the clock-out unlocks',
  isChecklistComplete(countChecklistSubmission(NA_SCHEMA, naFill({ n_ok: 'na', n_must: 'checked' }))));
eq('an item WITHOUT the flag marked N/A does not count',
  counted(NA_SCHEMA, naFill({ n_ok: 'checked', n_must: 'na' })), '1/2');
ok('…so the checklist is NOT complete',
  !isChecklistComplete(countChecklistSubmission(NA_SCHEMA, naFill({ n_ok: 'checked', n_must: 'na' }))));
eq('marking EVERYTHING N/A only counts what the office allowed',
  counted(NA_SCHEMA, naFill({ n_ok: 'na', n_must: 'na' })), '1/2');
eq('ticked AND N/A on the same item counts once',
  counted(NA_SCHEMA, [{ key: 'n_ok', checked: true, na: true }, { key: 'n_must', checked: true }]), '2/2');
eq('na: false is not a mark at all', counted(NA_SCHEMA, [{ key: 'n_ok', na: false }, { key: 'n_must', checked: true }]), '1/2');
eq('a truthy non-boolean `na` still counts — it is the CLEANER\'s own mark (II.8)',
  counted(NA_SCHEMA, [{ key: 'n_ok', na: 1 }, { key: 'n_must', checked: true }]), '2/2');
eq('an N/A on a key the schema never heard of counts nothing',
  counted(NA_SCHEMA, [...naFill({ n_ok: 'checked', n_must: 'checked' }), { key: 'ghost', na: true }]), '2/2');
eq('…and cannot stand in for a real item', counted(NA_SCHEMA, [{ key: 'ghost', na: true }]), '0/2');
eq('the snake-spelled flag is honoured when counting too',
  counted({ areas: [{ id: 'a1', items: [{ id: 'n_ok', na_allowed: true }, { id: 'n_must' }] }] },
    [{ key: 'n_ok', na: true }, { key: 'n_must', checked: true }]), '2/2');
eq('an item_key-spelled N/A counts the same',
  counted(NA_SCHEMA, [{ item_key: 'n_ok', na: true }, { item_key: 'n_must', checked: true }]), '2/2');
eq('a repeated N/A counts once',
  counted(NA_SCHEMA, [{ key: 'n_ok', na: true }, { key: 'n_ok', na: true }, { key: 'n_ok', checked: true }]), '1/2');
eq('completed can never exceed total, N/A included',
  counted({ areas: [{ id: 'a1', items: [{ id: 'n_ok', naAllowed: true }] }] },
    [{ key: 'n_ok', na: true }, { key: 'n_ok', checked: true }, { key: 'ghost', na: true }]), '1/1');
// Production's only checklist template carries NO flag on any item (measured read-only on
// 2026-09-28), so a schema like it must be untouched by this: every item is still owed.
const NO_FLAGS = { areas: [{ id: 'a1', items: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] }] };
eq('a schema with no flags anywhere gives N/A to nobody',
  counted(NO_FLAGS, [{ key: 'p1', checked: true }, { key: 'p2', na: true }, { key: 'p3', na: true }]), '1/3');
ok('…so it can only be finished by ticking every item',
  isChecklistComplete(countChecklistSubmission(NO_FLAGS, [{ key: 'p1', checked: true }, { key: 'p2', checked: true }, { key: 'p3', checked: true }])));

// ── which templates may be submitted as a checklist ──────────────────────────
// Refuse a KNOWN non-checklist kind only. `inspection_templates.kind` is
// `not null default 'inspection' check (kind in ('inspection','checklist'))`, so a blank
// one cannot exist — but if a hand-inserted row ever had none, refusing it would lock its
// holders out of their clock-out over a field they never chose.
eq('a checklist template may be submitted', checklistSubmitRefusal('checklist'), null);
eq('an INSPECTION template may not', checklistSubmitRefusal('inspection'), NOT_A_CHECKLIST_ERROR);
eq('any other known kind may not', checklistSubmitRefusal('audit'), NOT_A_CHECKLIST_ERROR);
eq('a padded kind is still the kind it names', checklistSubmitRefusal('  checklist '), null);
eq('a padded non-checklist kind is still refused', checklistSubmitRefusal(' inspection '), NOT_A_CHECKLIST_ERROR);
eq('an ABSENT kind is not refused', checklistSubmitRefusal(undefined), null);
eq('a null kind is not refused', checklistSubmitRefusal(null), null);
eq('a blank kind is not refused', checklistSubmitRefusal('   '), null);
eq('a non-string kind is not refused', checklistSubmitRefusal(7), null);
ok('the refusal message is plain — no ids, no SQL, no env (DEV_PLAYBOOK 3.4.12)',
  /^[A-Za-z ']+$/.test(NOT_A_CHECKLIST_ERROR), NOT_A_CHECKLIST_ERROR);

if (fails.length) { console.error('\nchecklist-count FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-count: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
