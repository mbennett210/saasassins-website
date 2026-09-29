// The client-review layer is ADDITIVE (CS-402, UI_RULES §130): a client sign-off can no
// longer be overwritten by a stray click. This proves the REDUCER enforcement — the real
// guarantee, not just the UI:
//   • a signed-off entry LOCKS: a later sitting's sign-off change is REFUSED without confirm;
//   • a confirmed change keeps the prior value in `history` (which only ever grows);
//   • a same-sitting edit (a misclick fix in one visit) needs no confirm and adds no history;
//   • notes are ADD-ONLY (ADD_CLIENT_REVIEW_NOTE); UPDATE can never write note/notes;
//   • a legacy `note` string still counts and still shows;
//   • SET_CLIENT_REVIEW is a UNION (current entries win, ids never dropped);
//   • the frozen manifest (reviewManifest.json) catches a dropped/renamed/retyped catalog id.
// Pure/offline — the real reducer via loadStore, the pure helpers via a guarded dynamic
// import, and the catalog + manifest read directly. FAILS on pre-CS-402 code (no lock, no
// history, no ADD action, SET replaces, no manifest). Assertions read source-of-truth
// constants (ACTIONS, the catalog, the manifest), never restated literals.
//   node app/scripts/test-review-additive.mjs
import { readFileSync } from 'node:fs';
import { loadStore, installResolveShim } from './deletion-core.mjs';
import { DECISIONS } from '../src/data/buildDecisions.js';
import { EMAIL_DRAFT_IDS } from '../src/data/emailDraftIds.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

installResolveShim();
// Dynamic import so a pre-fix tree (which lacks the new exports) yields clean per-assertion
// FAILs via the typeof guards below, not a module link crash.
const CR = await import('../src/lib/clientReview.js');
const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();

const {
  SECTION_APPROVED, SECTION_IN_REVIEW, DRAFT_ACCEPTED, DRAFT_CHANGES, PICK_CHOSEN,
} = CR;

// ── the new pure helpers exist ────────────────────────────────────────────────────
for (const name of ['isSignedOff', 'isLocked', 'sameSitting', 'newSitting', 'reviewFieldEq', 'hasAnyNote', 'reviewNotes']) {
  ok(typeof CR[name] === 'function', `clientReview exports ${name}()`);
}
ok(CR.SIGNOFF_FIELDS && typeof CR.SIGNOFF_FIELDS === 'object', 'clientReview exports SIGNOFF_FIELDS');
ok(ACTIONS.ADD_CLIENT_REVIEW_NOTE === 'ADD_CLIENT_REVIEW_NOTE', 'ACTIONS carries ADD_CLIENT_REVIEW_NOTE');

const up = (state, kind, id, patch, sitting, confirm) =>
  reducer(state, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind, id, patch, sitting, confirm });
const entryOf = (state, kind, id) => state.clientReview[kind][id];

// ── lock + confirm + history, PER KIND ─────────────────────────────────────────────
// Each kind: sign off in sitting S1, then a DIFFERENT sitting S2 (a) is refused without
// confirm (same state ref), (b) applies + appends history WITH confirm, and a SAME-sitting
// edit needs no confirm and adds no history.
const CASES = [
  { kind: 'sections', id: '/payroll', signoff: { status: SECTION_APPROVED }, change: { status: SECTION_IN_REVIEW }, field: 'status', prior: SECTION_APPROVED },
  { kind: 'drafts', id: 'quote-email', signoff: { status: DRAFT_ACCEPTED }, change: { status: DRAFT_CHANGES }, field: 'status', prior: DRAFT_ACCEPTED },
  { kind: 'picks', id: 'dashboard-layout', signoff: { choice: 'C', status: PICK_CHOSEN }, change: { choice: 'D', status: PICK_CHOSEN }, field: 'choice', prior: 'C' },
  { kind: 'decisions', id: 'HUB-1', signoff: { choice: 'a' }, change: { choice: 'b' }, field: 'choice', prior: 'a' },
];

for (const c of CASES) {
  const base = { ...INITIAL_STATE };
  const s1 = up(base, c.kind, c.id, c.signoff, 'S1');              // first sign-off (not locked)
  ok(entryOf(s1, c.kind, c.id)?.[c.field] === c.signoff[c.field], `${c.kind}: first sign-off applies (sitting S1)`);
  ok(entryOf(s1, c.kind, c.id)?.sitting === 'S1', `${c.kind}: the sitting is stamped on the entry`);

  // (a) locked: a DIFFERENT sitting's sign-off change without confirm is refused (same ref)
  const s2 = up(s1, c.kind, c.id, c.change, 'S2', false);
  ok(s2 === s1, `${c.kind}: a locked sign-off change WITHOUT confirm is refused (state unchanged)`);

  // (b) confirmed: applies AND keeps the prior value in history (prior, at, sitting)
  const s3 = up(s1, c.kind, c.id, c.change, 'S2', true);
  const e3 = entryOf(s3, c.kind, c.id);
  ok(e3?.[c.field] === c.change[c.field], `${c.kind}: a CONFIRMED change applies the new value`);
  ok(e3?.sitting === 'S2', `${c.kind}: a confirmed change stamps the new sitting`);
  ok(Array.isArray(e3?.history) && e3.history.length === 1, `${c.kind}: a confirmed change appends ONE history entry`);
  ok(e3?.history?.[0]?.[c.field] === c.prior, `${c.kind}: history keeps the PRIOR sign-off value`);
  ok(e3?.history?.[0]?.sitting === 'S1' && typeof e3?.history?.[0]?.at === 'string', `${c.kind}: history entry carries the prior at + sitting`);

  // same-sitting edit: no confirm needed, no history
  const sSame = up(s1, c.kind, c.id, c.change, 'S1', false);
  ok(entryOf(sSame, c.kind, c.id)?.[c.field] === c.change[c.field], `${c.kind}: a SAME-sitting change applies without confirm`);
  ok(!Array.isArray(entryOf(sSame, c.kind, c.id)?.history) || entryOf(sSame, c.kind, c.id).history.length === 0, `${c.kind}: a same-sitting change adds NO history`);
}

// history only GROWS and NEVER shrinks — a draft across three sittings (accepted → changes →
// accepted), each verdict a sign-off, so each confirmed change appends the prior one.
{
  let s = { ...INITIAL_STATE };
  s = up(s, 'drafts', 'sign-request', { status: DRAFT_ACCEPTED }, 'T1', false);   // sign off
  s = up(s, 'drafts', 'sign-request', { status: DRAFT_CHANGES }, 'T2', true);      // confirmed change
  ok(entryOf(s, 'drafts', 'sign-request')?.history?.length === 1, 'history: one entry after the first confirmed change');
  s = up(s, 'drafts', 'sign-request', { status: DRAFT_ACCEPTED }, 'T3', true);     // confirmed change again
  const h = entryOf(s, 'drafts', 'sign-request')?.history;
  ok(Array.isArray(h) && h.length === 2, 'history: grows to 2 after a second confirmed change');
  ok(h?.[0]?.status === DRAFT_ACCEPTED && h?.[1]?.status === DRAFT_CHANGES, 'history: never shrinks — earlier entries kept in order');
}

// an UNSIGNED entry is never locked: a first answer needs no confirm
{
  const s = up({ ...INITIAL_STATE }, 'decisions', 'HUB-2', { choice: 'a' }, 'X1', false);
  ok(entryOf(s, 'decisions', 'HUB-2')?.choice === 'a', 'an unsigned entry accepts a first answer with no confirm');
  ok(!Array.isArray(entryOf(s, 'decisions', 'HUB-2')?.history) || entryOf(s, 'decisions', 'HUB-2').history.length === 0, 'a first answer adds no history');
}

// a legacy signed-off entry with NO stored sitting reads as LOCKED (never overwritable)
{
  const legacy = { ...INITIAL_STATE, clientReview: { sections: {}, drafts: { 'lead-ack': { status: DRAFT_ACCEPTED } }, picks: {}, decisions: {} } };
  const refused = up(legacy, 'drafts', 'lead-ack', { status: DRAFT_CHANGES }, 'S9', false);
  ok(refused === legacy, 'a legacy signed-off entry (no stored sitting) is LOCKED without confirm');
  const changed = up(legacy, 'drafts', 'lead-ack', { status: DRAFT_CHANGES }, 'S9', true);
  ok(entryOf(changed, 'drafts', 'lead-ack')?.history?.length === 1, 'a confirmed change to a legacy entry keeps its prior value in history');
}

// ── notes are ADD-ONLY ──────────────────────────────────────────────────────────────
{
  let s = { ...INITIAL_STATE };
  const addNote = (st, kind, id, text) => reducer(st, { type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind, id, text, sitting: 'N1' });
  s = addNote(s, 'decisions', 'HUB-3', 'first note');
  ok(entryOf(s, 'decisions', 'HUB-3')?.notes?.length === 1 && entryOf(s, 'decisions', 'HUB-3').notes[0].text === 'first note',
    'ADD_CLIENT_REVIEW_NOTE appends { text, at } to notes');
  ok(typeof entryOf(s, 'decisions', 'HUB-3')?.notes?.[0]?.at === 'string', 'a note carries an at timestamp');
  const before = s;
  s = addNote(s, 'decisions', 'HUB-3', '   ');
  ok(s === before, 'ADD ignores whitespace-only text (state unchanged)');
  s = addNote(s, 'decisions', 'HUB-3', '');
  ok(s === before, 'ADD ignores empty text (state unchanged)');
  s = addNote(s, 'decisions', 'HUB-3', 'second note');
  ok(entryOf(s, 'decisions', 'HUB-3')?.notes?.length === 2, 'a second note appends (notes grow)');
  // adding a note NEVER changes a sign-off field or the entry sitting (can't unlock)
  ok(!('status' in (entryOf(s, 'decisions', 'HUB-3') || {})) && !('choice' in (entryOf(s, 'decisions', 'HUB-3') || {})),
    'a note adds no sign-off field');

  // IDEMPOTENT UNDER REPLAY (DATA_AND_SYNC §5 rule 3): a note carries a caller-minted id, and
  // replaying the SAME action (adoptRemote after a 12 s abort / 409 that the server already
  // committed — CS-026/CS-009) finds the id and no-ops. Same action object twice → ONE note.
  const noteAction = { type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind: 'decisions', id: 'HUB-5', text: 'once', noteId: 'note-fixed-x' };
  let r = reducer({ ...INITIAL_STATE }, noteAction);
  r = reducer(r, noteAction); // the replay
  ok(entryOf(r, 'decisions', 'HUB-5')?.notes?.length === 1, 'ADD note is idempotent under replay: the same noteId twice yields ONE note');
  ok(entryOf(r, 'decisions', 'HUB-5')?.notes?.[0]?.id === 'note-fixed-x', 'the stored note carries its caller-minted id');
  // a DIFFERENT note id still appends (two real notes, not a dedupe false-positive)
  const r2 = reducer(r, { type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind: 'decisions', id: 'HUB-5', text: 'twice', noteId: 'note-fixed-y' });
  ok(entryOf(r2, 'decisions', 'HUB-5')?.notes?.length === 2, 'a distinct noteId appends a second note');
}

// ── UPDATE can NEVER write note/notes (notes are add-only) ───────────────────────────
{
  const s = up({ ...INITIAL_STATE }, 'decisions', 'HUB-4', { choice: 'a', note: 'sneaky', notes: [{ text: 'x' }] }, 'S1', false);
  const e = entryOf(s, 'decisions', 'HUB-4');
  ok(e?.choice === 'a', 'UPDATE still applies the real sign-off field');
  ok(!('note' in e), 'UPDATE strips a note field from the patch');
  ok(!('notes' in e), 'UPDATE strips a notes field from the patch');
  // a notes-only UPDATE is a no-op (stripped to nothing → same state ref)
  const base = up({ ...INITIAL_STATE }, 'decisions', 'HUB-4', { choice: 'a' }, 'S1', false);
  const after = up(base, 'decisions', 'HUB-4', { note: 'still no', notes: [{ text: 'y' }] }, 'S1', false);
  ok(after === base, 'a notes-only UPDATE patch is a no-op (state unchanged)');
}

// ── a legacy `note` string still counts and still shows ──────────────────────────────
ok(CR.isDraftResolved({ note: 'legacy' }) === true, 'a legacy note resolves a draft (counts as a note)');
ok(CR.isPickResolved({ note: 'legacy' }) === true, 'a legacy note resolves a pick');
ok(CR.isDraftResolved({ notes: [{ text: 'x' }] }) === true, 'a notes-array note resolves a draft');
ok(CR.isPickResolved({ notes: [{ text: 'x' }] }) === true, 'a notes-array note resolves a pick');
ok(CR.isDraftResolved({ status: DRAFT_CHANGES }) === false, 'request-changes with no note is still unresolved');
if (typeof CR.hasAnyNote === 'function') {
  ok(CR.hasAnyNote({ note: 'L' }) === true && CR.hasAnyNote({ notes: [{ text: 'A' }] }) === true && CR.hasAnyNote({}) === false,
    'hasAnyNote sees a legacy note OR a notes-array note');
}
if (typeof CR.reviewNotes === 'function') {
  const list = CR.reviewNotes({ note: 'L', notes: [{ text: 'A', at: 't1' }, { text: 'B', at: 't2' }] });
  ok(list.length === 3 && list[0].text === 'L' && list[0].legacy === true && list[1].text === 'A' && list[2].text === 'B',
    'reviewNotes lists the legacy note FIRST, then the notes array oldest→newest');
}
// isDecisionAnswered still ignores a note (a note alone never answers)
ok(CR.isDecisionAnswered({ notes: [{ text: 'thinking' }] }) === false, 'a note alone never answers a decision');

// ── SET_CLIENT_REVIEW is a UNION: current wins, ids never dropped, add-only ───────────
{
  let s = { ...INITIAL_STATE };
  s = up(s, 'sections', '/a', { status: SECTION_APPROVED }, 'S1', false);
  s = up(s, 'decisions', 'HUB-1', { choice: 'a' }, 'S1', false);
  const incoming = {
    sections: { '/a': { status: SECTION_IN_REVIEW }, '/b': { status: SECTION_APPROVED } },
    drafts: {}, picks: {},
    decisions: { 'HUB-9': { choice: 'z' } },
  };
  const s2 = reducer(s, { type: ACTIONS.SET_CLIENT_REVIEW, review: incoming });
  ok(s2.clientReview.sections['/a']?.status === SECTION_APPROVED, 'SET union: a current entry WINS over the incoming one (/a stays approved)');
  ok(s2.clientReview.sections['/b']?.status === SECTION_APPROVED, 'SET union: an incoming id missing from current is ADDED (/b)');
  ok(s2.clientReview.decisions['HUB-1']?.choice === 'a', 'SET union: a current id is NEVER dropped (HUB-1 survives)');
  ok(s2.clientReview.decisions['HUB-9']?.choice === 'z', 'SET union: a new incoming id is added (HUB-9)');
}

// ── the FROZEN manifest freezes the catalog's ids/types/options ──────────────────────
// checkReviewManifest(manifest, decisions, draftIds) → violation strings. It fails when the
// catalog drops a manifest id, changes a type or option ids, loses an option, or has an id
// NOT in the manifest (a new unpublished question/draft). Proven by mutating scratch copies.
function checkReviewManifest(manifest, decisions, draftIds) {
  const v = [];
  if (!manifest || typeof manifest !== 'object') { v.push('manifest missing/unreadable'); return v; }
  const mq = manifest.questions || {};
  const md = Array.isArray(manifest.drafts) ? manifest.drafts : [];
  const byId = new Map(decisions.map((q) => [q.id, q]));
  for (const [id, spec] of Object.entries(mq)) {
    const q = byId.get(id);
    if (!q) { v.push(`question ${id} in manifest but MISSING from catalog`); continue; }
    if (q.type !== spec.type) v.push(`question ${id} type changed ${spec.type} -> ${q.type}`);
    const now = new Set((q.options || []).map((o) => o.id));
    const then = new Set(spec.options || []);
    for (const o of then) if (!now.has(o)) v.push(`question ${id} lost/renamed option ${o}`);
    for (const o of now) if (!then.has(o)) v.push(`question ${id} has an option ${o} not in the manifest`);
  }
  for (const q of decisions) if (!(q.id in mq)) v.push(`question ${q.id} not yet in the manifest`);
  const mdSet = new Set(md), catSet = new Set(draftIds);
  for (const id of md) if (!catSet.has(id)) v.push(`draft ${id} in manifest but MISSING from catalog`);
  for (const id of draftIds) if (!mdSet.has(id)) v.push(`draft ${id} not yet in the manifest`);
  return v;
}

let manifest = null;
try { manifest = JSON.parse(readFileSync(new URL('../src/data/reviewManifest.json', import.meta.url), 'utf8')); }
catch { manifest = null; }

ok(manifest && manifest.questions && Array.isArray(manifest.drafts), 'reviewManifest.json exists and is well-formed');
ok(checkReviewManifest(manifest, DECISIONS, EMAIL_DRAFT_IDS).length === 0, 'the manifest matches the catalog at HEAD (no violations)');

// deep-ish clone for mutation
const cloneDecisions = () => DECISIONS.map((q) => ({ ...q, options: q.options ? q.options.map((o) => ({ ...o })) : q.options }));

// a removed question → violation
ok(checkReviewManifest(manifest, cloneDecisions().filter((q) => q.id !== 'HUB-1'), EMAIL_DRAFT_IDS).some((x) => x.includes('HUB-1') && x.includes('MISSING')),
  'manifest check fails when a published question is removed');
// a renamed option id → violation
{
  const d = cloneDecisions();
  const q = d.find((x) => x.id === 'HUB-1');
  q.options[0].id = 'renamed';
  ok(checkReviewManifest(manifest, d, EMAIL_DRAFT_IDS).some((x) => x.includes('HUB-1') && x.includes('option')),
    'manifest check fails when an option id is renamed');
}
// a changed type → violation
{
  const d = cloneDecisions();
  d.find((x) => x.id === 'HUB-1').type = 'multi';
  ok(checkReviewManifest(manifest, d, EMAIL_DRAFT_IDS).some((x) => x.includes('HUB-1') && x.includes('type')),
    'manifest check fails when a question type changes');
}
// a removed draft → violation
ok(checkReviewManifest(manifest, DECISIONS, EMAIL_DRAFT_IDS.filter((id) => id !== 'lead-ack')).some((x) => x.includes('lead-ack') && x.includes('MISSING')),
  'manifest check fails when a published draft is removed');
// an unpublished NEW question id → violation
{
  const d = cloneDecisions();
  d.push({ id: 'NEW-999', type: 'single', added: '2026-10-01', q: 'x', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  ok(checkReviewManifest(manifest, d, EMAIL_DRAFT_IDS).some((x) => x.includes('NEW-999') && x.includes('not yet in the manifest')),
    'manifest check fails when the catalog adds an id not yet in the manifest');
}

console.log(`review additive: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
