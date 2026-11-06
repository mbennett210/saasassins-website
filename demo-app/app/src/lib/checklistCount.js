// The rules a checklist submission is judged by — what its `completed_count` /
// `total_count` MEAN, and which templates may be submitted as a checklist at all. PURE /
// node-safe (no imports, no browser globals), so the server store, the demo stub and the
// seeds all answer the same way.
//
// WHY IT EXISTS (CS-494). The counts used to be taken from the CALLER's own list:
// `completed_count: items.filter((i) => i.checked).length, total_count: items.length`.
// The server had already read the published version to snapshot it, and still counted the
// payload against itself. `qc.checklist.perform` is a crew default, so a cleaner who
// POSTed `items: [{ key: 'x', checked: true }]` for their own checklist stored 1/1 — which
// `isChecklistComplete` (`lib/crewChecklist.js`: `total_count > 0 && completed_count >=
// total_count`) reads as finished, and the clock-out block (R4, `api/_lib/time/
// checklistGate.js`) then let them clock out with the real checklist untouched. The block
// the client asked for with "no way around it on the cleaner's side" was bypassable with
// one request.
//
// THE RULE. A submission is measured against the PUBLISHED SCHEMA it was filled from,
// never against its own length:
//     total_count     = how many DISTINCT countable items that schema holds
//     completed_count = how many of THOSE the payload TICKED, plus the ones it marked
//                       N/A that the SCHEMA allows to be marked N/A, plus the ones it
//                       marked NOT COMPLETED with a reason (Matt, 2026-10-13 — below)
// so `completed_count` can never exceed `total_count`, and a complete submission is one
// that accounted for every item the office actually published: ticked, N/A where the office
// allowed it, or "not completed" with the cleaner's reason. (Read "completed" here as
// "resolved": the office sees each not-completed one, and it never counts as cleaned.)
//
// WHY N/A IS COUNTED HERE AND NOWHERE ELSE (CS-546). The client's rule is that the whole
// checklist is done before clock-out, with NO way around it on the cleaner's side; the
// office's per-item "N/A ok" flag is the ONE sanctioned exception. `InspectionTemplateEditor`
// has written that flag since the templates shipped and `ChecklistFill` rendered no control
// for it, so an item that does not apply tonight — the exterior bins on a night with no
// collection — had to be ticked anyway or the cleaner could not clock out. Honouring it is
// therefore a fix, not a loophole, PROVIDED it is judged against the published schema like
// every tick: `qc.checklist.perform` is a crew default, so a submission that marks an item
// N/A the office never flagged counts exactly as much as a ticked key the schema never
// heard of — nothing. The payload's own list never decides anything.
//
// WHAT IT NEVER DOES: refuse. A payload carrying keys the schema doesn't name, or missing
// ones it does, is stored and counted honestly (THE LAW II.8 — fix instead of reject: the
// clean already happened and the submission is the only record of it). Unknown keys are
// ignored, absent keys count as not done, and a repeated key counts once.
//
// WHICH schema the caller passes is documented where it is read
// (`api/_lib/qc/store.js submitChecklist`): always the template's CURRENT published
// version. The submission does not get to name one.
//
// WHY A PHOTO IS COUNTED HERE TOO (MISC-5 / CS-547). Matt: "Should a cleaner have to attach
// a photo? — Yes, on the items the office marks." The office's per-item `photoRequired` flag
// is the second thing this editor has always written and nothing has ever read. It is
// honoured by the SAME principle as the tick and the N/A: an item the office marked
// photo-required counts as done only when a real `account_media` row exists for it, and the
// caller's own list never decides that — `submitChecklist` reads the rows. A ticked claim
// with no photo is worth what a ticked key the schema never heard of is worth: nothing.
// It is NOT a refusal. The submission is stored exactly as the cleaner sent it (II.8 — the
// clean already happened and this row is its only record); what the missing photo costs is
// the COUNT, which is what the clock-out block actually reads. Refusing would be strictly
// worse: an offline fill whose photo is still in the media queue would be destroyed, while
// a forger would simply drop the item and store n-1/n, which clears nothing anyway.

// A schema item is countable when it carries a usable id — that id is the key a genuine
// submission sends back for it (`components/ChecklistFill.jsx` renders one checkbox per
// `area.items[]` entry and posts `{ key: it.id, … }`). An entry without one cannot be
// ticked distinguishably, so it is not countable; `InspectionTemplateEditor` mints an id
// for every item, so this only ever drops corrupt schema rows.
const idOf = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// The key a SUBMITTED item names its schema entry by. Two spellings are in the wild and
// both are genuine: `ChecklistFill` posts `key`, while the seeded rows and the backend
// seed write `item_key` (the column name the inspection side uses). Reading both can only
// ever help a real submission — an unrecognized key is ignored, and the schema still caps
// the count.
export function submittedItemKey(item) {
  if (!item || typeof item !== 'object') return null;
  return idOf(item.key) || idOf(item.item_key);
}

// ── N/A: the office's per-item exception (CS-546) ────────────────────────────

// May THIS schema item be marked N/A? Two spellings, both genuine: `InspectionTemplateEditor`
// writes `naAllowed`, and the migration's own schema comment documents `na_allowed`
// (20260614120000) — read both, exactly as `submittedItemKey` reads both key spellings.
//
// STRICTLY `true`, unlike a submitted item's own `na`. This is the OFFICE's switch and the
// editor only ever writes a real boolean (`naAllowed: !!i.naAllowed`), so nothing legitimate
// is lost by refusing a truthy string or a 1 — while a stray truthy value in a hand-edited
// schema must not quietly open the one escape hatch the clock-out block has.
export function itemAllowsNa(item) {
  if (!item || typeof item !== 'object') return false;
  return item.naAllowed === true || item.na_allowed === true;
}

// ── Photos: the office's per-item proof (MISC-5 / CS-547) ───────────────────

// Must THIS schema item carry a photo before it counts as done? STRICTLY `true`, and both
// spellings, for exactly the reasons `itemAllowsNa` gives: the editor writes a real boolean
// (`photoRequired: !!i.photoRequired`), the migration's own schema comment documents the
// snake_case twin (20260614120000), and a stray truthy value in a hand-edited schema must
// not quietly start demanding proof that no cleaner was ever shown a control for.
//
// This is the OPPOSITE direction to `itemAllowsNa` — that one hands out an exception, this
// one adds a requirement — so "strict" fails safe in both: an unreadable flag means the
// office asked for nothing.
export function itemRequiresPhoto(item) {
  if (!item || typeof item !== 'object') return false;
  return item.photoRequired === true || item.photo_required === true;
}

// ── "Mark as not completed": the cleaner's own account of a task (Matt, 2026-10-13) ──
//
// Matt's rule (D2 of docs/plans/2026-10-13-cleaner-hub.md): the crew "can't clock out until
// the day's checklist is complete or every remaining task has been accounted for". A task the
// cleaner marks NOT COMPLETED with a short reason ("supply closet locked, no key") counts
// toward unlocking clock-out — on ANY task, with no office flag, and it needs no photo (there
// is nothing to photograph when the work could not be done, the N/A reasoning). It replaced
// "every item ticked" from 2026-09-27; the office still sees every one of them, with its
// reason, and it never counts as CLEANED (lib/checklistAreas: an area holding one records no
// last-cleaned time, and the customer's hub reads it as not done).
//
// 🔴 THE REASON IS THE WHOLE EXCEPTION. A `notCompleted` with a blank reason — or one shorter
// than NOT_COMPLETED_REASON_MIN once trimmed — counts as NOT done, exactly like an N/A on an
// item the office never flagged: the payload's flag alone decides nothing. The reason is
// read the way it is STORED (`normalizeNotCompletedReason`: one line, trimmed, capped), so
// the server's count, the demo stub's, the phone's queued gate (crewChecklist.queuedAsRows)
// and the page's Save button can never disagree about whether a reason is a reason.
// Nothing is ever refused for it (THE LAW II.8): an over-long reason is capped, not rejected.
export const NOT_COMPLETED_REASON_MIN = 3;
export const NOT_COMPLETED_REASON_MAX = 300;
// The cleaner's comment on a task (stored as the item's `note`), capped at the write point
// so one pasted wall of text cannot swell every row that carries it.
export const CHECKLIST_NOTE_MAX = 1000;

const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();

// The reason as it is stored: one line, trimmed, at most NOT_COMPLETED_REASON_MAX
// characters. Anything that is not a string is no reason at all ('').
export function normalizeNotCompletedReason(v) {
  if (typeof v !== 'string') return '';
  return oneLine(v).slice(0, NOT_COMPLETED_REASON_MAX).trim();
}

// Is this text a reason the count will accept? ONE answer for the page's Save button and the
// server's count.
export function notCompletedReasonOk(text) {
  return normalizeNotCompletedReason(text).length >= NOT_COMPLETED_REASON_MIN;
}

// The reason a submitted item was marked not completed for, or null when it was not marked
// (or was marked with no usable reason — which counts as not done).
export function notCompletedReasonOf(item) {
  if (!item || typeof item !== 'object' || !item.notCompleted) return null;
  const reason = normalizeNotCompletedReason(item.notCompletedReason);
  return reason.length >= NOT_COMPLETED_REASON_MIN ? reason : null;
}

// Does this submitted item count as accounted for by "not completed"? A cleaner's own mark,
// read as truthy like `checked` and `na`; the REASON is what makes it count.
export function itemNotCompleted(item) {
  return notCompletedReasonOf(item) !== null;
}

// What a stored `checklist_results.items` entry may carry, repaired rather than refused
// (THE LAW II.8 — sanitize over reject): every writer (the server's submit, the demo stub)
// stores through this. Non-object entries are dropped; `notCompleted` becomes a real boolean
// and `notCompletedReason` the stored form of the text (or null) — only on an item that named
// either field, so an older fill's rows keep their shape; a comment (`note`) is trimmed and
// capped. Every other field rides through untouched: the count reads keys and marks, never
// anything else, and the result view and the hub read the snapshot for structure.
export function sanitizeChecklistItems(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const row = { ...it };
    if ('notCompleted' in it || 'notCompletedReason' in it) {
      row.notCompleted = !!it.notCompleted;
      const reason = normalizeNotCompletedReason(it.notCompletedReason);
      row.notCompletedReason = reason || null;
    }
    if (typeof it.note === 'string') row.note = it.note.trim().slice(0, CHECKLIST_NOTE_MAX) || null;
    out.push(row);
  }
  return out;
}

// ── What a CUSTOMER reads as done (the client hub, D2) ───────────────────────
// The stored `completed_count` is RESOLVED (it unlocked the clock-out), so it counts the tasks the
// cleaner marked "not completed"; the customer's hub reads those as NOT done. The checklist's own
// hub page counts them off its snapshot (clientHubView.projectHubChecklist); every OTHER hub
// surface — the list row, the Home tile, the visit's timeline, the history — reads a row with no
// schema, so it counts them here, off the row's own `items`: the distinct keys carrying a counted
// "not completed" (a reason, `itemNotCompleted`) and neither a tick nor an N/A among their entries.
// The page makes the three exclusive, so on anything the app writes this equals the page's count.
// A row with no `items` (a narrow read) has nothing to subtract and reads its stored counts.
export function notCompletedItemKeys(items) {
  const marks = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const key = submittedItemKey(it);
    if (!key) continue;
    const m = marks.get(key) || { nc: false, other: false };
    if (it.checked || it.na) m.other = true;
    if (itemNotCompleted(it)) m.nc = true;
    marks.set(key, m);
  }
  const out = new Set();
  for (const [key, m] of marks) if (m.nc && !m.other) out.add(key);
  return out;
}

// { done, total, notCompleted } as a customer reads a stored row: `done` = the stored count less
// the tasks not completed (never below 0), `total` the stored total. Never the reason.
export function cleanedCountsOf(row) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const completed = num(row?.completed_count);
  const total = num(row?.total_count);
  const notCompleted = Array.isArray(row?.items) ? Math.min(completed, notCompletedItemKeys(row.items).size) : 0;
  return { done: Math.max(0, completed - notCompleted), total, notCompleted };
}

// The countable item keys of a schema that the office marked photo-required, in schema
// order. The server reads this FIRST and only looks up media when it is non-empty, so a
// checklist with no marked item costs exactly what it costs today.
export function checklistPhotoRequiredKeys(schema) {
  return schemaIndex(schema).photoKeys;
}

// Does a NEW item of this kind start out allowing N/A? A CHECKLIST item does NOT: the
// office opts in per item, because a checklist is ticked and gates a clock-out, so an
// exception that arrives switched on is an exception nobody chose. An INSPECTION item keeps
// the long-standing default — a scored inspection's N/A is a RATING ("this area does not
// apply"), read by `InspectionFill`, and it blocks nothing.
//
// One rule, so the editor cannot restate it and drift (it is read for the first blank item,
// for "Add item", for "Add area", and when the type is switched before anything is saved).
export function defaultNaAllowed(kind) {
  const k = typeof kind === 'string' ? kind.trim() : '';
  return k !== 'checklist';
}

// The DISTINCT countable item keys of a checklist schema, in schema order. Distinct, not
// the array length: a schema that repeated an id would render two checkboxes bound to the
// same state, so a genuine full submission can only ever tick it once — counting the
// repeat would make a finished checklist read as unfinished and lock the cleaner out.
// (`lib/inspections.countSchemaItems`, which gates PUBLISHING an item-less checklist,
// counts the raw array; the two agree on every schema the editor can produce.)
export function checklistSchemaKeys(schema) {
  return schemaIndex(schema).keys;
}

// The countable keys plus WHICH of them the office allowed to be marked N/A and WHICH it
// requires a photo on, read in one pass so the three can never be read off different
// schemas. First definition of a repeated id wins, matching `checklistSchemaKeys`' "a
// repeat is one item".
function schemaIndex(schema) {
  const keys = [];
  const naOk = new Set();
  const photoKeys = [];
  const seen = new Set();
  const areas = schema && Array.isArray(schema.areas) ? schema.areas : [];
  for (const area of areas) {
    const items = area && Array.isArray(area.items) ? area.items : [];
    for (const item of items) {
      const key = idOf(item && item.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (itemAllowsNa(item)) naOk.add(key);
      if (itemRequiresPhoto(item)) photoKeys.push(key);
    }
  }
  return { keys, naOk, photoKeys };
}

// { completed_count, total_count } for one submission against one schema — the shape the
// `checklist_results` row stores, so a writer spreads it. An empty schema is 0/0, which
// `isChecklistComplete` pins as NOT complete (and publishing one is refused upstream by
// `lib/inspections.publishRefusal`).
//
// `photoKeys` (CS-547) is WHICH item keys actually have a photo — an iterable of keys the
// caller READ, never anything the submission claimed. It defaults to EMPTY, which is
// fail-closed: a writer that does not look photos up counts every photo-required item as
// not done, rather than silently granting what the office asked proof for. Every writer
// passes it: the server from `account_media`, the fill and the demo stub from the device's
// own uploads (including the ones still queued offline, which is the cleaner's honest
// position — the server re-counts the replay).
export function countChecklistSubmission(schema, items, { photoKeys = null } = {}) {
  const { keys, naOk, photoKeys: needPhoto } = schemaIndex(schema);
  const countable = new Set(keys);
  const needsPhoto = new Set(needPhoto);
  const hasPhoto = new Set(photoKeys || []);
  const done = new Set();
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    const key = submittedItemKey(item);
    if (!key || !countable.has(key)) continue;
    // Ticked, or marked N/A on an item the office allowed to be. `na` is read as TRUTHY
    // (like `checked`) because it is the CLEANER's own mark on their own work; what it may
    // not do is widen the exception, which is why `naOk` — the schema's — is the gate. A
    // key marked both ways is still one item: the Set counts it once.
    //
    // A photo-required item needs its photo to count as TICKED. Marking it N/A does not:
    // the office said that item may not apply tonight, and there is nothing to photograph
    // when it didn't happen — asking for a picture of an absence is how a sanctioned
    // exception turns back into a trap (CS-546's whole point).
    //
    // A task marked NOT COMPLETED with a reason (Matt, 2026-10-13) counts too, on any item and
    // with no photo — the reason, read as it is stored, is the whole exception; a bare flag
    // counts nothing (`itemNotCompleted`).
    const ticked = !!item.checked && (!needsPhoto.has(key) || hasPhoto.has(key));
    if (ticked || (item.na && naOk.has(key)) || itemNotCompleted(item)) done.add(key);
  }
  return { completed_count: done.size, total_count: keys.length };
}

// ── Which templates may be submitted as a checklist ──────────────────────────
// `submitChecklist` never looked at the template's KIND, so a crew token could name an
// INSPECTION template, get a 200, and write a `checklist_results` row whose
// `template_snapshot.kind` said 'inspection'. That row then counted as a checklist in the
// Quality hub's Checklists table and in Reports › Checklists per site. A scored inspection
// is a different surface with a different permission (`qc.inspect`, manager-only, vs
// `qc.checklist.perform`, a crew default), so it can never become a checklist row.
//
// This is NOT the II.8 case. II.8 says a cleaner's completed work is stored and counted
// honestly rather than rejected; here there is no checklist work — the caller named the
// wrong kind of template, exactly as an unknown or unpublished template id is already
// refused. Nothing is stored.
//
// It refuses only a KNOWN non-checklist kind. An absent/blank kind is left alone: on the
// real table `kind` is `not null default 'inspection' check (kind in
// ('inspection','checklist'))` (migration 20260614120000) and both writers — `createTemplate`
// and `scripts/seed-backend.mjs` — set it explicitly, so a kind-less row cannot exist; if
// one ever did, by hand, refusing it would lock its holders out of their clock-out for a
// field they never chose.
export const NOT_A_CHECKLIST_CODE = 'not_a_checklist';
export const NOT_A_CHECKLIST_ERROR = 'That template is not a checklist';

// Why this template may NOT be submitted as a checklist, or null. ONE rule, shared by the
// server store and the demo stub, so the demo can never accept what the server refuses.
export function checklistSubmitRefusal(kind) {
  const k = typeof kind === 'string' ? kind.trim() : '';
  return k && k !== 'checklist' ? NOT_A_CHECKLIST_ERROR : null;
}
