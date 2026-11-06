// CS-552 — READING a submitted checklist: the projection behind the Quality hub's result
// pop-up (`src/lib/checklistResultView.js`), run.
//
// THE DEFECT. Quality → Checklists listed one row per submission — location, checklist,
// "25/26", who, when — and NOTHING anywhere showed which items those were. A manager saw
// "25 of 26" and could not tell which item was missed, which was marked "does not apply",
// or read the note the cleaner left on it. `ChecklistFill` has stored `na` beside `checked`
// per item since CS-546 for exactly that reason, and no reader was ever built; CS-546
// making N/A real widened the gap, because "25 of 26" now hides a miss AND two items that
// never applied.
//
// WHAT THIS SUITE HOLDS. The whole rule is a pure module, so all of it runs here with no
// DOM: grouping, per-item state, the N/A gate, unknown and missing keys, both key
// spellings, notes, the exceptions list, the counts, stored-vs-derived, a repeated schema
// id, and the no-schema fallback. The pop-up's SHAPE — the markup, the chips, the badge,
// the keyboard and the accessible names — is `test-checklist-result-ui.mjs`.
//
// 🔴 THE COUNTS ARE ASSERTED AGAINST THE SOURCE OF TRUTH, NEVER A RESTATED LITERAL
// (THE LAW II.3). `lib/checklistCount.countChecklistSubmission` is the rule the SERVER
// stores a submission by and the clock-out gate reads; every fixture here is counted by it
// and the projection's own tallies are held to that answer. A projection that drifted from
// the counter would show a manager a breakdown that does not add up to the row's headline.
//
// Failing-first by construction: pre-fix `src/lib/checklistResultView.js` does not exist.
// The import is guarded so the suite still REPORTS rather than throwing — every assertion
// runs and fails with its got/want.
//
//   node app/scripts/test-checklist-result-view.mjs
import { countChecklistSubmission, itemAllowsNa } from '../src/lib/checklistCount.js';
import { isChecklistComplete } from '../src/lib/crewChecklist.js';

let mod = {};
try { mod = await import('../src/lib/checklistResultView.js'); } catch { /* pre-fix: no such module */ }
const { projectChecklistResult, filterResultItems, ITEM_STATE, RESULT_FILTERS } = mod;

// Wrappers so a missing module fails every check with a readable got/want instead of
// killing the run on the import line.
//
// 🔴 THE SENTINELS MATTER. Standing in for the absent module with `{}` / `[]` let a dozen
// assertions pass VACUOUSLY on the pre-fix tree — `undefined === undefined`, an empty list
// that is genuinely empty — and a check that cannot fail proves nothing (THE LAW II.3). So
// the stand-ins answer with values nothing can legitimately equal: every assertion below
// goes red when the module is missing, and the suite's pre-fix number is honest.
const MISSING = '‹lib/checklistResultView is missing›';
const S = ITEM_STATE || { DONE: `${MISSING}/done`, NA: `${MISSING}/na`, NOT_DONE: `${MISSING}/notdone` };
const MISSING_ITEM = { key: MISSING, label: MISSING, area: MISSING, state: MISSING, note: MISSING };
const MISSING_ITEMS = [MISSING_ITEM];
const MISSING_VIEW = {
  name: MISSING, hasSchema: MISSING, countsDisagree: MISSING, complete: MISSING,
  items: MISSING_ITEMS, exceptions: MISSING_ITEMS,
  areas: [{ id: MISSING, label: MISSING, items: MISSING_ITEMS, done: -1, total: -1, na: -1 }],
  counts: { total: -1, done: -1, ticked: -1, na: -1, notDone: -1 },
  stored: { done: -1, total: -1 },
};
const project = (row) => (typeof projectChecklistResult === 'function' ? projectChecklistResult(row) : MISSING_VIEW);
const filter = (items, f) => (typeof filterResultItems === 'function' ? filterResultItems(items, f) : MISSING_ITEMS);

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const states = (view) => (view.items || []).map((i) => `${i.key}:${i.state}`);

// ── fixtures ────────────────────────────────────────────────────────────────
// Two areas, and ONE item the office flagged "N/A ok" — the shape a published checklist
// has (`InspectionTemplateEditor` writes `naAllowed` on every item; the demo's Floor Care
// checklist flags exactly one, CS-546).
const SCHEMA = {
  areas: [
    { id: 'a_floor', label: 'Floor Care', items: [
      { id: 'f_sweep', label: 'Hard floors swept', naAllowed: false },
      { id: 'f_mop', label: 'Hard floors mopped', naAllowed: false },
      { id: 'f_spot', label: 'Spots spot-treated', naAllowed: true },
    ] },
    { id: 'a_rest', label: 'Restrooms', items: [
      { id: 'r_fix', label: 'Fixtures sanitized', naAllowed: false },
      { id: 'r_stock', label: 'Supplies restocked', naAllowed: false },
    ] },
  ],
};
const row = (items, extra = {}) => {
  const counted = countChecklistSubmission(extra.schema ?? SCHEMA, items);
  return {
    id: 'cr_1',
    template_snapshot: { name: 'Floor Care Checklist', kind: 'checklist', schema: extra.schema ?? SCHEMA },
    items,
    ...counted,
    ...extra,
  };
};

// ── 1. the schema is the structure: areas and items in ITS order ────────────
{
  const view = project(row([
    { key: 'f_sweep', label: 'Floor Care. Hard floors swept', checked: true },
    { key: 'f_mop', label: 'Floor Care. Hard floors mopped', checked: true },
    { key: 'f_spot', label: 'Floor Care. Spots spot-treated', checked: false, na: true },
    { key: 'r_fix', label: 'Restrooms. Fixtures sanitized', checked: true },
    { key: 'r_stock', label: 'Restrooms. Supplies restocked', checked: false, note: 'Out of paper towels.' },
  ]));
  eq('the areas come from the snapshot, in its order', (view.areas || []).map((a) => a.label), ['Floor Care', 'Restrooms']);
  eq('…and the items in each area keep the schema order',
    (view.areas || []).map((a) => a.items.map((i) => i.key)), [['f_sweep', 'f_mop', 'f_spot'], ['r_fix', 'r_stock']]);
  // The submission's own label is "<Area>. <Item>" (ChecklistFill), which stutters under
  // the area heading it repeats — so the SCHEMA's label is what a reader sees.
  eq('the label is the SCHEMA\'s own, not the submission\'s prefixed one',
    (view.items || []).map((i) => i.label),
    ['Hard floors swept', 'Hard floors mopped', 'Spots spot-treated', 'Fixtures sanitized', 'Supplies restocked']);
  eq('ticked reads done · an allowed N/A reads N/A · an untouched item reads not done',
    states(view), [`f_sweep:${S.DONE}`, `f_mop:${S.DONE}`, `f_spot:${S.NA}`, `r_fix:${S.DONE}`, `r_stock:${S.NOT_DONE}`]);
  eq('the cleaner\'s note rides its item', (view.items || []).find((i) => i.key === 'r_stock')?.note, 'Out of paper towels.');
  ok('an item with no note carries none', (view.items || []).find((i) => i.key === 'f_sweep')?.note === null);
  eq('the checklist name comes from the snapshot', view.name, 'Floor Care Checklist');
  ok('the snapshot was usable', view.hasSchema === true);

  // Per-area tallies: done counts a ticked item AND an allowed N/A, exactly as the row's
  // headline does, so an area's n/m and the summary can never tell different stories.
  eq('an area says how many of its items are done, and how many were N/A',
    (view.areas || []).map((a) => [a.label, a.done, a.total, a.na]),
    [['Floor Care', 3, 3, 1], ['Restrooms', 1, 2, 0]]);
}

// ── 2. N/A is the OFFICE's exception, and only theirs ───────────────────────
// The same submission with the N/A moved to an item the office never flagged. The count
// gives it nothing (CS-546), so the READER must not grant it either — it is an item that
// was not done, and a manager reading "N/A" there would be told an exception was allowed
// that the office never allowed.
{
  const allowed = project(row([{ key: 'f_spot', na: true }]));
  const notAllowed = project(row([{ key: 'f_mop', na: true }]));
  eq('an N/A on an item the office flagged reads N/A',
    (allowed.items || []).find((i) => i.key === 'f_spot')?.state, S.NA);
  eq('an N/A on an item the office did NOT flag reads NOT DONE',
    (notAllowed.items || []).find((i) => i.key === 'f_mop')?.state, S.NOT_DONE);
  ok('…and the rule read is the shared one, not a second copy',
    itemAllowsNa(SCHEMA.areas[0].items[2]) === true && itemAllowsNa(SCHEMA.areas[0].items[1]) === false);
  // Ticked and N/A on one item is ONE done item to the counter; the screen says the
  // stronger thing about the work — the cleaner ticked it.
  eq('ticked wins over N/A when a payload carries both',
    (project(row([{ key: 'f_spot', checked: true, na: true }])).items || []).find((i) => i.key === 'f_spot')?.state, S.DONE);
}

// ── 3. keys: both spellings, unknown ignored, missing not done, repeats once ─
{
  // The seeded rows and scripts/seed-backend.mjs write `item_key`; ChecklistFill posts
  // `key`. Production's rows are the `item_key` spelling, so a reader that knew only one
  // would render every live result as untouched.
  const view = project(row([
    { item_key: 'f_sweep', label: 'Hard floors swept', checked: true },
    { item_key: 'ghost_item', label: 'A key this schema never named', checked: true },
  ]));
  eq('an `item_key` submission is read (the spelling every production row uses)',
    (view.items || []).find((i) => i.key === 'f_sweep')?.state, S.DONE);
  eq('a key the schema never named is ignored — it is not a row anyone can act on',
    (view.items || []).map((i) => i.key), ['f_sweep', 'f_mop', 'f_spot', 'r_fix', 'r_stock']);
  eq('an item the submission never mentions is not done',
    (view.items || []).find((i) => i.key === 'r_fix')?.state, S.NOT_DONE);
  eq('…and the totals still come from the schema', [view.counts?.total, view.counts?.done], [5, 1]);
}
{
  // A schema that repeats an id renders two checkboxes bound to ONE piece of state, so a
  // genuine full submission can only ever tick it once — `checklistSchemaKeys` counts it
  // once, and the reader must list it once or the manager sees a phantom missed item.
  const dupe = { areas: [
    { id: 'a1', label: 'One', items: [{ id: 'x', label: 'First' }] },
    { id: 'a2', label: 'Two', items: [{ id: 'x', label: 'Second, same id' }, { id: 'y', label: 'Other' }] },
  ] };
  const view = project(row([{ key: 'x', checked: true }, { key: 'y', checked: true }], { schema: dupe }));
  eq('a repeated schema id is ONE item, its first definition winning',
    (view.items || []).map((i) => [i.key, i.label, i.area]), [['x', 'First', 'One'], ['y', 'Other', 'Two']]);
  eq('…so the derived total matches the counter\'s', view.counts?.total, countChecklistSubmission(dupe, []).total_count);
}
{
  // Two rows for one key (a hand-made payload, a replayed queue item): the counter ORs the
  // marks, so the reader must too, or a state could contradict the count it sits under.
  const view = project(row([{ key: 'f_mop' }, { key: 'f_mop', checked: true, note: 'Second pass.' }]));
  eq('a key submitted twice folds into one item, its marks OR-ed like the counter\'s',
    (view.items || []).filter((i) => i.key === 'f_mop').map((i) => [i.state, i.note]), [[S.DONE, 'Second pass.']]);
}
{
  // An area the schema declares with no usable items has nothing to show; showing an empty
  // accordion is a row a manager opens for nothing.
  const view = project(row([], { schema: { areas: [
    { id: 'a_empty', label: 'Nothing here', items: [] },
    { id: 'a_real', label: 'Real', items: [{ id: 'k', label: 'An item' }] },
  ] } }));
  eq('an area with no countable items is left out', (view.areas || []).map((a) => a.label), ['Real']);
}

// ── 4. the exceptions list — what a manager opened this to find ─────────────
{
  const view = project(row([
    { key: 'f_sweep', checked: true },
    { key: 'f_mop', checked: true, note: 'Machine was down, did it by hand.' },
    { key: 'f_spot', na: true, note: 'Nothing to treat.' },
    { key: 'r_fix', checked: true },
    { key: 'r_stock', checked: false },
  ]));
  eq('not done, N/A, or carrying a note — in schema order',
    (view.exceptions || []).map((i) => [i.key, i.state]),
    [['f_mop', S.DONE], ['f_spot', S.NA], ['r_stock', S.NOT_DONE]]);
  eq('…and each one says which area it is in', (view.exceptions || []).map((i) => i.area),
    ['Floor Care', 'Floor Care', 'Restrooms']);
  const clean = project(row(['f_sweep', 'f_mop', 'f_spot', 'r_fix', 'r_stock'].map((key) => ({ key, checked: true }))));
  eq('a checklist with nothing to flag has an EMPTY exceptions list, so the block can go',
    (clean.exceptions || []).length, 0);
}

// ── 5. the counts, held to `lib/checklistCount` on every fixture ────────────
{
  const cases = [
    [],
    [{ key: 'f_sweep', checked: true }],
    [{ key: 'f_spot', na: true }],
    [{ key: 'f_mop', na: true }],                                   // N/A the office never allowed
    [{ key: 'f_spot', checked: true, na: true }],
    [{ key: 'ghost', checked: true }],
    [{ item_key: 'r_fix', checked: true }, { item_key: 'r_stock', checked: true }],
    ['f_sweep', 'f_mop', 'f_spot', 'r_fix', 'r_stock'].map((key) => ({ key, checked: true })),
  ];
  let agree = 0;
  for (const items of cases) {
    const truth = countChecklistSubmission(SCHEMA, items);
    const view = project(row(items));
    if (view.counts?.done === truth.completed_count && view.counts?.total === truth.total_count) agree += 1;
  }
  eq('the derived done/total equal checklistCount\'s on every fixture — ONE counting rule', agree, cases.length);

  const view = project(row([
    { key: 'f_sweep', checked: true }, { key: 'f_spot', na: true }, { key: 'r_stock', checked: false },
  ]));
  eq('the breakdown adds up: ticked + N/A = done, and done + not done = total',
    [view.counts?.ticked, view.counts?.na, view.counts?.done, view.counts?.notDone, view.counts?.total],
    [1, 1, 2, 3, 5]);
}

// ── 6. the STORED counts are the headline; a disagreement is said out loud ──
{
  const items = [{ key: 'f_sweep', checked: true }];
  const honest = project(row(items));
  ok('a row counted by the current rule reports no disagreement', honest.countsDisagree === false);
  eq('the headline is the row\'s OWN counts', [honest.stored?.done, honest.stored?.total], [1, 5]);

  // An older row — counted before CS-494 against its own payload, or hand-edited since.
  const stale = project({ ...row(items), completed_count: 5, total_count: 5 });
  ok('a row whose stored counts disagree with its items is flagged, not silently overruled',
    stale.countsDisagree === true);
  eq('…and the stored counts stay the headline', [stale.stored?.done, stale.stored?.total], [5, 5]);
  eq('…while the derived ones stay available to say so', [stale.counts?.done, stale.counts?.total], [1, 5]);

  // The badge must reach the SAME verdict the clock-out gate reached, which reads the
  // stored counts through `crewChecklist.isChecklistComplete` — never a re-derivation.
  const all = ['f_sweep', 'f_mop', 'f_spot', 'r_fix', 'r_stock'].map((key) => ({ key, checked: true }));
  ok('"finished" is isChecklistComplete over the STORED counts, the clock-out gate\'s own rule',
    project(row(all)).complete === isChecklistComplete(row(all))
    && project(row(all)).complete === true
    && project(row(items)).complete === isChecklistComplete(row(items))
    && project(row(items)).complete === false);
  ok('…and an empty checklist (0/0) is never "finished"',
    project({ ...row([]), completed_count: 0, total_count: 0 }).complete === false);
}

// ── 7. the fallback: a record with no usable schema still renders ───────────
// The row is the only account of a clean that happened. It renders as it was submitted —
// stored order, stored labels — and the pop-up says so in words (the UI suite holds that
// sentence). Never a crash and never a blank pop-up.
{
  const submitted = [
    { item_key: 'c_lights', label: 'Close-Out. Lights off', checked: true },
    { item_key: 'c_lock', label: 'Close-Out. All doors locked', checked: false, note: 'Back door sticks.' },
    { item_key: 'c_alarm', label: 'Close-Out. Alarm set', na: true },
  ];
  for (const [what, snapshot] of [
    ['no snapshot at all', null],
    ['a snapshot with no schema', { name: 'Nightly Close-Out', kind: 'checklist' }],
    ['a schema with no areas', { name: 'Nightly Close-Out', kind: 'checklist', schema: {} }],
    ['areas with no usable item ids', { name: 'Nightly Close-Out', kind: 'checklist', schema: { areas: [{ id: 'a', label: 'A', items: [{ label: 'no id' }] }] } }],
  ]) {
    // Stored 2 of 3 = what the items themselves add up to (a tick plus an N/A), so this
    // record has nothing to reconcile; the disagreeing twin is asserted below.
    const view = project({ id: 'cr_x', template_snapshot: snapshot, items: submitted, completed_count: 2, total_count: 3 });
    ok(`${what}: it still renders`, view.hasSchema === false && (view.items || []).length === 3);
    eq(`${what}: the items keep their stored order and their stored labels`,
      (view.items || []).map((i) => i.label),
      ['Close-Out. Lights off', 'Close-Out. All doors locked', 'Close-Out. Alarm set']);
    // With no schema there is no office switch to ask, so the cleaner's own mark stands.
    // It gates nothing — the clock-out block reads the stored counts — and calling their
    // "does not apply" a miss would misreport their work for no gain.
    eq(`${what}: the submitted marks are read at face value`,
      (view.items || []).map((i) => i.state), [S.DONE, S.NOT_DONE, S.NA]);
    ok(`${what}: counts that match the items claim no disagreement`, view.countsDisagree === false);
    eq(`${what}: the note still rides its item`, (view.items || [])[1]?.note, 'Back door sticks.');
  }
  // 🔴 AND THE DISAGREEMENT IS STILL ASKED WITHOUT A SCHEMA. It used to be guarded on
  // `hasSchema`, which suppressed the notice in the one case most likely to need it: when
  // the snapshot is gone, the office's N/A flag went with it, so the stored count and a
  // recount of the items come apart precisely there. Showing two numbers and explaining
  // neither is the thing this field exists to prevent.
  {
    const lost = project({ id: 'cr_z', template_snapshot: { name: 'Nightly Close-Out', kind: 'checklist' },
      items: submitted, completed_count: 1, total_count: 3 });
    ok('a snapshot-less record whose stored counts differ from its items SAYS SO',
      lost.countsDisagree === true);
    eq('…with the stored counts still the headline', [lost.stored?.done, lost.stored?.total], [1, 3]);
    eq('…and the derived ones available to name beside them', [lost.counts?.done, lost.counts?.total], [2, 3]);
  }
  const empty = project({ id: 'cr_y', template_snapshot: null, items: [], completed_count: 0, total_count: 0 });
  eq('a record with no schema AND no items is an empty view, not a crash',
    [(empty.areas || []).length, (empty.items || []).length], [0, 0]);
  eq('a null row projects to nothing rather than throwing', (project(null).items || []).length, 0);
}

// ── 8. the filters ──────────────────────────────────────────────────────────
// "Only what wasn't done" is STRICTLY not done and "N/A only" strictly N/A, so a chip can
// never show a count the summary line calls something else. (The mockup folded N/A into
// the not-done chip; that made "1 not done" in the summary open a list of three.)
{
  const view = project(row([
    { key: 'f_sweep', checked: true }, { key: 'f_mop', checked: true },
    { key: 'f_spot', na: true }, { key: 'r_fix', checked: true }, { key: 'r_stock' },
  ]));
  // "Not completed" (Matt, 2026-10-13) is a state and a chip of its own, between the misses and
  // the N/As — test-checklist-not-completed.mjs holds what it shows.
  eq('the filter vocabulary is declared once, in order', RESULT_FILTERS, ['all', S.NOT_DONE, S.NOT_COMPLETED, S.NA]);
  eq('Everything shows every item', filter(view.items, 'all').length, 5);
  eq('Only what wasn\'t done shows the misses and nothing else',
    filter(view.items, S.NOT_DONE).map((i) => i.key), ['r_stock']);
  eq('N/A only shows the N/As and nothing else',
    filter(view.items, S.NA).map((i) => i.key), ['f_spot']);
  eq('the two exception filters are disjoint, and neither is the other\'s superset',
    filter(view.items, S.NOT_DONE).filter((i) => filter(view.items, S.NA).includes(i)).length, 0);
  eq('an unknown filter falls back to everything, never to nothing', filter(view.items, 'nonsense').length, 5);
}

if (fails.length) { console.error('\nchecklist-result-view FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-result-view: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
