// READING a submitted checklist — the projection behind the Quality hub's result pop-up
// (components/ChecklistResultModal). PURE, so the whole rule runs in a node suite without
// a DOM: one stored `checklist_results` row in, one read-only view out.
//
// WHY IT EXISTS (CS-552). Quality → Checklists has always listed one row per submission —
// location, checklist, "25/26", who, when — and NOTHING anywhere showed which items those
// were. A manager saw "25 of 26" and could not tell which item was missed, which was
// marked "does not apply", or read the note the cleaner left on it. `ChecklistFill` has
// stored `na` beside `checked` per item since CS-546 for exactly this reason ("the stored
// record says which of the two it was — a manager reading it sees 'did not apply', not
// 'missed'"), and no reader was ever built. CS-546 making N/A real widened the gap: "25 of
// 26" now hides a miss AND two items that never applied.
//
// WHAT IT READS. Everything is already on the row — `checklists/list` is `select('*')` and
// the route hands the rows over as they are — so this reads the row the tab already holds
// and fetches nothing:
//   template_snapshot = { name, kind, schema }   the PUBLISHED schema frozen at submit
//   items             = [{ key | item_key, label, checked, na?, note? }]  the submission
//   completed_count / total_count                the counts the row was STORED with
//
// 🔴 THE SNAPSHOT IS THE STRUCTURE AND THE N/A TRUTH, never the live template. The template
// may have been renamed, republished or deleted since; the snapshot is what the cleaner
// actually filled, and `naAllowed` on ITS items is the office switch that applied that
// night. The same reason `submitChecklist` snapshots it in the first place.
//
// 🔴 THE COUNTING RULE LIVES IN `lib/checklistCount`, AND ONLY THERE. This module reads the
// two primitives that decide a row — `submittedItemKey` (both spellings: `ChecklistFill`
// posts `key`, the seeds and the backend seed write `item_key`) and `itemAllowsNa` (the
// office's strict `naAllowed`/`na_allowed` switch) — so a state shown here and a count
// stored by the server cannot come from two different rules. What this module adds is the
// per-item STATE the counter has no room to return, and `counts.done` is defined to be the
// counter's `completed_count`: a DONE plus an N/A the office allowed. The suite proves that
// on every fixture by running `countChecklistSubmission` beside it
// (`scripts/test-checklist-result-view.mjs`) — it is asserted, not assumed.
//
// 🔴 IT IS READ-ONLY AND IT NEVER GATES ANYTHING. The clock-out block reads the STORED
// counts through `crewChecklist.isChecklistComplete`, never this projection, so nothing
// here can loosen or tighten a cleaner's clock-out. That is also why the no-schema fallback
// below is allowed to be generous.
//
// 🔴 PHOTOS (CS-547). An item the office marked "photo required" is DONE only once a photo
// exists for it — the same rule `countChecklistSubmission` counts by — so `photoKeys` (the
// item keys that actually HAVE one, read from `account_media`, never claimed by the
// submission) is passed in and the state follows it. Without it every photo-required item
// reads NOT DONE, which is the same fail-closed default the counter takes: a reader that
// did not look photos up must not report proof it never saw. Each item also says
// `needsPhoto` / `hasPhoto` so the pop-up can show the photo, or say which one is missing,
// instead of a bare "Not done" on an item the cleaner swears they ticked.
//
// 🔴 NOT COMPLETED (Matt, 2026-10-13). A task the cleaner marked "not completed" with a reason
// is its own fourth state: it counts toward the stored `completed_count` (it unlocked the
// clock-out — `checklistCount.itemNotCompleted`, read here and nowhere else), so it is part of
// `counts.done` ("resolved"), but it was NOT cleaned, so the office reads it as "Not completed —
// <reason>" in "Needs a look", under its own filter chip and in the summary, and
// `lib/checklistAreas` never stamps an area that holds one. A flag with no usable reason counts
// nothing and reads NOT DONE, exactly as the counter counts it.
import { submittedItemKey, itemAllowsNa, itemRequiresPhoto, notCompletedReasonOf } from './checklistCount.js';
import { isChecklistComplete } from './crewChecklist.js';

// What one item ended the night as. Four states, and every item is exactly one of them.
// NOT_COMPLETED = the cleaner said it could not be done, and why (it counts toward the
// clock-out; it was not cleaned).
export const ITEM_STATE = Object.freeze({ DONE: 'done', NA: 'na', NOT_COMPLETED: 'notcompleted', NOT_DONE: 'notdone' });

// The pop-up's filter chips. `all` is every item; `notdone` is STRICTLY not done,
// `notcompleted` strictly the ones the cleaner marked not completed, and `na` strictly the
// ones marked "does not apply" — all three disjoint, so the chip labelled "Only what wasn't
// done" can never show a count the summary line calls N/A or not completed.
export const RESULT_FILTERS = Object.freeze(['all', ITEM_STATE.NOT_DONE, ITEM_STATE.NOT_COMPLETED, ITEM_STATE.NA]);

// A RESOLVED item: what `countChecklistSubmission` counts as completed (and so what the
// clock-out read). Everything but NOT_DONE.
export const isResolvedState = (state) => state !== ITEM_STATE.NOT_DONE;
// A CLEANED item: the work happened (done, or did not apply). Not-completed is resolved but
// never cleaned — the area times and the customer's hub read this one.
export const isCleanedState = (state) => state === ITEM_STATE.DONE || state === ITEM_STATE.NA;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (Number.isFinite(v) ? v : 0);

// Every submitted entry for a key, folded into the two marks. A key can legitimately
// appear more than once (a hand-written payload, a replayed queue item): the marks are
// OR-ed exactly as `countChecklistSubmission` OR-s them, so the state and the count read
// the same submission the same way. The note is the first non-empty one.
function foldSubmission(items) {
  const by = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const key = submittedItemKey(it);
    if (!key) continue;
    const at = by.get(key) || { checked: false, na: false, note: null, label: null, reason: null };
    if (it.checked) at.checked = true;
    if (it.na) at.na = true;
    if (!at.reason) at.reason = notCompletedReasonOf(it);
    if (!at.note) at.note = str(it.note);
    if (!at.label) at.label = str(it.label);
    by.set(key, at);
  }
  return by;
}

// Ticked wins over N/A when a payload carries both. The count already treats the pair as
// ONE done item, so this only decides what the manager reads — and "done" is the stronger
// claim about the work: the cleaner ticked it. `ChecklistFill` makes the two exclusive, so
// this only ever fires on a hand-made payload.
// `mayBeNa` is the ANSWER `itemAllowsNa` gave for this item, never the flag itself — this
// module does not read `naAllowed`/`na_allowed` anywhere, and a suite enumerates that
// (test-checklist-submit-count-route.mjs): a second reader of the office's switch is a
// second rule waiting to disagree with the count the server stored.
// `needsPhoto` / `hasPhoto` are likewise the ANSWERS `itemRequiresPhoto` and the caller's
// photo set gave, and the order matters: a ticked-but-unproven item that was ALSO marked
// N/A reads N/A, exactly as the counter counts it (the N/A branch does not ask for a
// photo — there is nothing to photograph on a night the item did not apply).
// A not-completed mark WITH a reason comes after both: the cleaner's tick or a sanctioned N/A is
// the stronger statement about the work (the page makes them exclusive anyway), and it needs
// no photo, as the counter counts it.
function stateOf(mark, mayBeNa, needsPhoto = false, hasPhoto = false) {
  if (!mark) return ITEM_STATE.NOT_DONE;
  if (mark.checked && (!needsPhoto || hasPhoto)) return ITEM_STATE.DONE;
  if (mark.na && mayBeNa) return ITEM_STATE.NA;
  if (mark.reason) return ITEM_STATE.NOT_COMPLETED;
  // An N/A on an item the office never flagged counts nothing (checklistCount's rule), so
  // it must not READ as an exception granted either — it is an item that was not done.
  // Same for a tick with the office's photo still missing.
  return ITEM_STATE.NOT_DONE;
}

// The whole view of one `checklist_results` row.
//
//   name            the snapshot's checklist name
//   hasSchema       false when the snapshot carried no usable schema (see the fallback)
//   areas           [{ id, label, items, done, total, na }] in SCHEMA order; an area with
//                   no countable items is left out (there is nothing to show)
//   items           every item, flat, in the same order — what the filters and the
//                   exceptions read
//   exceptions      the ones that need a look: not done, N/A, or carrying a note
//   counts          DERIVED from the snapshot: { total, done, ticked, na, notCompleted, notDone }
//                   where done = ticked + na + notCompleted = checklistCount's
//                   `completed_count` (resolved), and notDone the strictly unresolved
//   stored          the row's OWN { done, total } — the headline the pop-up shows
//   countsDisagree  the derived total/done differ from the stored ones (an old row, a
//                   hand-edited one). The stored counts stay the headline; the pop-up says
//                   so quietly rather than showing two numbers and explaining neither.
//   complete        isChecklistComplete over the STORED counts — the same verdict the
//                   clock-out gate reached, so the badge here cannot contradict it.
//   photoKeys       (CS-547) the item keys that HAVE a photo — a Set/array the caller read
//                   from `account_media`. Absent = none seen, and every photo-required item
//                   reads NOT DONE, the counter's own fail-closed default.
export function projectChecklistResult(row, { photoKeys = null } = {}) {
  const snapshot = row && typeof row.template_snapshot === 'object' ? row.template_snapshot : null;
  const schema = snapshot && typeof snapshot.schema === 'object' ? snapshot.schema : null;
  const rawAreas = schema && Array.isArray(schema.areas) ? schema.areas : [];
  const submitted = Array.isArray(row?.items) ? row.items : [];
  const marks = foldSubmission(submitted);
  const shot = photoKeys instanceof Set ? photoKeys : new Set(photoKeys || []);
  const stored = { done: num(row?.completed_count), total: num(row?.total_count) };
  const name = str(snapshot?.name) || 'Checklist';

  const hasSchema = rawAreas.some((a) => Array.isArray(a?.items) && a.items.some((i) => str(i?.id)));
  const areas = hasSchema
    ? fromSchema(rawAreas, marks, shot)
    : fromSubmissionOnly(submitted);

  const items = areas.flatMap((a) => a.items);
  const counts = {
    total: items.length,
    done: items.filter((i) => isResolvedState(i.state)).length,
    ticked: items.filter((i) => i.state === ITEM_STATE.DONE).length,
    na: items.filter((i) => i.state === ITEM_STATE.NA).length,
    notCompleted: items.filter((i) => i.state === ITEM_STATE.NOT_COMPLETED).length,
    notDone: items.filter((i) => i.state === ITEM_STATE.NOT_DONE).length,
  };

  return {
    name,
    hasSchema,
    areas,
    items,
    exceptions: items.filter((i) => i.state !== ITEM_STATE.DONE || i.note),
    counts,
    stored,
    // 🔴 ASKED OF EVERY RECORD, SCHEMA OR NOT. This was `hasSchema && (…)`, on the reasoning
    // that without a schema there is nothing authoritative to disagree with — which
    // suppressed the notice in precisely the case that needs it. A record whose snapshot was
    // lost is exactly where stored and derived come apart (stored 1 of 3 against items that
    // read 2 of 3, because the office's N/A flag went with the schema), and the whole point
    // of this field is that two numbers are never shown silently. The no-schema callout says
    // why they can differ; this says that they do.
    countsDisagree: counts.total !== stored.total || counts.done !== stored.done,
    // The ROW itself, not a rebuilt pair: this is the very call the clock-out gate and the
    // reminder walker make, so the badge cannot reach a different verdict than the block a
    // cleaner met — and nothing here spells the two columns out by hand (the enumeration in
    // test-checklist-submit-count-route.mjs holds that line).
    complete: isChecklistComplete(row),
  };
}

// The normal path: the snapshot's areas, in order, with the submission read onto them.
// An item in the submission whose key the schema does not name is IGNORED — the count
// ignores it too, and a row the manager cannot act on is worse than no row. An item in the
// schema with no submission row is NOT DONE. A repeated id is ONE item, its first
// definition winning, because that is what `checklistSchemaKeys` counts and what the fill
// renders (two checkboxes bound to one piece of state).
const areaKey = (area, i) => str(area?.id) || `area-${i}`;

function fromSchema(rawAreas, marks, shot) {
  const seen = new Set();
  const out = [];
  for (const area of rawAreas) {
    const areaLabel = str(area?.label);
    const rows = [];
    for (const item of Array.isArray(area?.items) ? area.items : []) {
      const key = str(item?.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const mark = marks.get(key) || null;
      const needsPhoto = itemRequiresPhoto(item);
      const hasPhoto = shot.has(key);
      rows.push({
        key,
        // The SCHEMA's own label, never the submission's: `ChecklistFill` posts the label
        // as "<Area>. <Item>", which reads as a stutter under the area heading it repeats.
        label: str(item?.label) || 'Item',
        area: areaLabel,
        state: stateOf(mark, itemAllowsNa(item), needsPhoto, hasPhoto),
        note: mark?.note || null,
        // The cleaner's reason, only where the state is NOT_COMPLETED (a ticked item that also
        // carried a stale reason reads as done, and says nothing about it).
        reason: null,
        needsPhoto,
        hasPhoto,
      });
    }
    if (!rows.length) continue;
    for (const r of rows) if (r.state === ITEM_STATE.NOT_COMPLETED) r.reason = marks.get(r.key)?.reason || null;
    out.push({
      id: areaKey(area, out.length),
      label: areaLabel,
      items: rows,
      total: rows.length,
      done: rows.filter((i) => isResolvedState(i.state)).length,
      na: rows.filter((i) => i.state === ITEM_STATE.NA).length,
      notCompleted: rows.filter((i) => i.state === ITEM_STATE.NOT_COMPLETED).length,
    });
  }
  return out;
}

// 🔴 THE FALLBACK: a record whose snapshot carried no usable schema still renders. The row
// is the only account of a clean that happened, so it is shown as it was submitted — the
// stored order, the stored labels — and the pop-up says in visible text that the
// checklist's structure was not recorded with it. Never a crash and never a blank pop-up.
//
// With no schema there is no office switch to ask, so a submitted `na` is read at face
// value rather than demoted to "not done": the cleaner's own mark is the only record of
// what they meant, and this view gates nothing (the clock-out block reads the stored
// counts). Calling their "does not apply" a miss would misreport their work for no gain.
function fromSubmissionOnly(submitted) {
  const rows = submitted.map((it, i) => ({
    key: submittedItemKey(it) || `row-${i}`,
    label: str(it?.label) || 'Item',
    area: null,
    state: it?.checked ? ITEM_STATE.DONE
      : (it?.na ? ITEM_STATE.NA : (notCompletedReasonOf(it) ? ITEM_STATE.NOT_COMPLETED : ITEM_STATE.NOT_DONE)),
    note: str(it?.note),
    reason: !it?.checked && !it?.na ? notCompletedReasonOf(it) : null,
    // No schema means no office flags to read, so nothing here is owed a photo either —
    // the same reason a submitted `na` is taken at face value above.
    needsPhoto: false,
    hasPhoto: false,
  }));
  if (!rows.length) return [];
  return [{
    id: 'submitted',
    label: null,
    items: rows,
    total: rows.length,
    done: rows.filter((i) => isResolvedState(i.state)).length,
    na: rows.filter((i) => i.state === ITEM_STATE.NA).length,
    notCompleted: rows.filter((i) => i.state === ITEM_STATE.NOT_COMPLETED).length,
  }];
}

// The items one filter chip shows. `all` is everything; the others are their own state and
// nothing else, so what the chip promises is what the list holds.
export function filterResultItems(items, filter) {
  const list = Array.isArray(items) ? items : [];
  if (filter === 'all' || !RESULT_FILTERS.includes(filter)) return list;
  return list.filter((i) => i.state === filter);
}

// How many tasks of a stored row the cleaner marked not completed — for a LIST row that
// carries its items (the Quality hub's Checklists tab reads `select('*')`). Null when the row
// carries no items (a narrow read): "not known" is never shown as zero.
export function notCompletedCountOf(row) {
  if (!row || !Array.isArray(row.items)) return null;
  return projectChecklistResult(row).counts.notCompleted;
}
