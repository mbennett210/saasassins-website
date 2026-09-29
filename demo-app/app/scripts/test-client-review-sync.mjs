// Client review layer moved from a per-browser localStorage key into the shared
// org_state blob (2026-09-23), so CleanSpace's Drafts reviews, Dashboard/Payroll
// layout picks and per-nav approvals (and their notes) are visible to every seat.
// This proves: the slice seeds empty, the reducer merges one entry / UNIONS the whole
// slice (CS-402: current wins, ids never dropped) / no-ops an unknown kind, notes are
// add-only, the selector is default-safe, the blob serializer KEEPS the slice (so it
// actually syncs to the shared backend), and the one-time localStorage migration merges
// without clobbering. Pure/offline — real reducer via loadStore. Fails on pre-fix code
// (no slice, action, or selector existed).
//   node app/scripts/test-client-review-sync.mjs
import { loadStore, installResolveShim } from './deletion-core.mjs';
import { toSharedBlob } from '../src/store/tableSlices.js';
import {
  mergeReview, emptyReview, SECTION_APPROVED, DRAFT_ACCEPTED, DRAFT_CHANGES,
  REVIEW_KINDS, isDecisionAnswered, reviewSummary,
} from '../src/lib/clientReview.js';
import { isDraftResolved } from '../src/lib/clientReview.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

// selectors.js uses Vite-style extensionless imports; the shim lets node resolve them.
// It must run BEFORE the (dynamic) import of selectors, so this can't be a static import.
installResolveShim();
const { selectClientReview, EMPTY_REVIEW } = await import('../src/store/selectors.js');
const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();

// ── the slice ships empty on a fresh state ──────────────────────────────────────
const cr0 = INITIAL_STATE.clientReview;
ok(cr0 && typeof cr0 === 'object', 'INITIAL_STATE has a clientReview slice');
ok(cr0 && !Object.keys(cr0.sections).length && !Object.keys(cr0.drafts).length && !Object.keys(cr0.picks).length,
  'the seeded clientReview is empty (sections/drafts/picks)');

// ── the decisions bucket exists everywhere the empty shape is declared ───────────
ok(REVIEW_KINDS.includes('decisions'), 'REVIEW_KINDS includes the decisions bucket');
ok(cr0.decisions && Object.keys(cr0.decisions).length === 0, 'seed clientReview carries an empty decisions bucket');
ok(emptyReview().decisions && Object.keys(emptyReview().decisions).length === 0, 'emptyReview() carries an empty decisions bucket');
ok('decisions' in EMPTY_REVIEW, 'EMPTY_REVIEW carries a decisions bucket');
ok(REVIEW_KINDS.every((k) => k in emptyReview()), 'emptyReview() has a map for every REVIEW_KIND');

let s = { ...INITIAL_STATE };

// ── UPDATE_CLIENT_REVIEW: sections / drafts / picks each merge by id ─────────────
s = reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'sections', id: '/payroll', patch: { status: SECTION_APPROVED } });
ok(s.clientReview.sections['/payroll']?.status === SECTION_APPROVED, 'sections: a route approval is stored');
ok(typeof s.clientReview.sections['/payroll']?.at === 'string', 'sections: a timestamp is stamped');

s = reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'drafts', id: 'quote-email', patch: { status: DRAFT_ACCEPTED } });
ok(s.clientReview.drafts['quote-email']?.status === DRAFT_ACCEPTED, 'drafts: an acceptance is stored');
// Notes are ADD-ONLY (CS-402): UPDATE never writes a note; ADD_CLIENT_REVIEW_NOTE appends it.
s = reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'drafts', id: 'quote-email', patch: { note: 'ignored by UPDATE' } });
ok(!('note' in s.clientReview.drafts['quote-email']), 'drafts: UPDATE cannot write a note (add-only)');
s = reducer(s, { type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind: 'drafts', id: 'quote-email', text: 'looks good' });
ok(s.clientReview.drafts['quote-email']?.status === DRAFT_ACCEPTED && s.clientReview.drafts['quote-email']?.notes?.[0]?.text === 'looks good',
  'drafts: an acceptance + an add-only note coexist');

s = reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'picks', id: 'payroll-layout', patch: { choice: 'C', status: 'chosen' } });
s = reducer(s, { type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind: 'picks', id: 'payroll-layout', text: 'go with C' });
ok(s.clientReview.picks['payroll-layout']?.choice === 'C' && s.clientReview.picks['payroll-layout']?.notes?.[0]?.text === 'go with C',
  'picks: choice + an add-only note coexist');

// ── decisions: the reducer accepts the kind, merges, and stamps `at` ─────────────
s = reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'decisions', id: 'HUB-1', patch: { choice: 'a' } });
ok(s.clientReview.decisions['HUB-1']?.choice === 'a', 'decisions: the reducer accepts kind "decisions" and stores the choice');
ok(typeof s.clientReview.decisions['HUB-1']?.at === 'string', 'decisions: the reducer stamps `at`');
s = reducer(s, { type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind: 'decisions', id: 'HUB-1', text: 'context' });
ok(s.clientReview.decisions['HUB-1']?.choice === 'a' && s.clientReview.decisions['HUB-1']?.notes?.[0]?.text === 'context',
  'decisions: a choice + an add-only note coexist');

ok(s.users === INITIAL_STATE.users, 'UPDATE_CLIENT_REVIEW leaves unrelated slices by reference');

// ── guard: unknown kind or missing id is a no-op (same ref) ──────────────────────
ok(reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'bogus', id: 'x', patch: { a: 1 } }) === s, 'unknown kind → no-op (same state ref)');
ok(reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'drafts', patch: { a: 1 } }) === s, 'missing id → no-op (same state ref)');

// ── SET_CLIENT_REVIEW is a UNION (CS-402): current wins, ids never dropped, add-only ──
s = reducer(s, { type: ACTIONS.UPDATE_CLIENT_REVIEW, kind: 'sections', id: '/payroll', patch: { status: SECTION_APPROVED } });
const unioned = reducer(s, {
  type: ACTIONS.SET_CLIENT_REVIEW,
  review: { sections: { '/x': { status: 'approved' }, '/payroll': { status: 'in-review' } }, drafts: {}, picks: {}, decisions: {} },
});
ok(unioned.clientReview.sections['/x']?.status === 'approved', 'SET union: an incoming id missing from current is ADDED (/x)');
ok(unioned.clientReview.sections['/payroll']?.status === SECTION_APPROVED, 'SET union: a current entry WINS (/payroll stays approved, not clobbered)');
ok(unioned.clientReview.drafts['quote-email']?.status === DRAFT_ACCEPTED, 'SET union: a current id in another bucket is NEVER dropped (quote-email)');
ok(reducer(s, { type: ACTIONS.SET_CLIENT_REVIEW }) === s, 'SET_CLIENT_REVIEW with no review → no-op (union adds nothing)');

// ── the selector is default-safe on an older blob missing the key ────────────────
const { clientReview: _drop, ...noReview } = INITIAL_STATE;
ok(selectClientReview(noReview) === EMPTY_REVIEW, 'selectClientReview → the frozen EMPTY_REVIEW when the slice is absent (reference-stable)');
ok(selectClientReview(s) === s.clientReview, 'selectClientReview returns the slice by reference when present (already complete)');

// ── PRODUCTION SHAPE: a live org_state blob's clientReview predates `decisions` ────
// The live blob is {sections, drafts, picks} with NO `decisions` key until the first
// answer is saved. selectClientReview MUST default every REVIEW_KIND bucket, or a
// component read like review.decisions[id] throws a TypeError the moment /review opens.
// FAILS pre-fix (the raw slice was returned as-is).
const legacyBlob = { ...INITIAL_STATE, clientReview: { sections: {}, drafts: {}, picks: {} } };
const legacySel = selectClientReview(legacyBlob);
ok(legacySel.decisions && typeof legacySel.decisions === 'object', 'selectClientReview defaults a missing `decisions` bucket to an object');
ok(REVIEW_KINDS.every((k) => legacySel[k] && typeof legacySel[k] === 'object'), 'selectClientReview returns every REVIEW_KIND bucket as an object');
ok((() => { try { return legacySel.decisions['nope'] === undefined; } catch { return false; } })(),
  'reading review.decisions[id] on a normalized legacy slice does NOT throw (the production crash)');
ok(selectClientReview(legacyBlob) === selectClientReview(legacyBlob),
  'selectClientReview is reference-stable for the same incomplete slice (memoized per slice ref)');
ok(typeof reviewSummary(legacySel, [{ id: 'X', added: '2026-09-25' }], [], {}).openDecisions === 'number',
  'reviewSummary works on the normalized legacy slice');

// ── the blob serializer KEEPS clientReview (so it syncs to every seat) ───────────
const blob = toSharedBlob({ ...s, jobs: [{ id: 'j1' }], currentUserId: 'u1' }, []);
ok(blob.clientReview && blob.clientReview.drafts['quote-email']?.status === DRAFT_ACCEPTED,
  'toSharedBlob KEEPS clientReview in the shared blob (syncs to every seat)');
ok(Array.isArray(blob.jobs) && blob.jobs.length === 0, 'control: jobs are still stripped from the blob');
ok(!('currentUserId' in blob), 'control: currentUserId is still stripped');

// ── the one-time localStorage migration merges, never clobbers ───────────────────
// `current` carries a DECISIONS bucket that the legacy per-browser blob never had. mergeReview
// must preserve it: the migration writes the result through SET_CLIENT_REVIEW (whole-slice
// replace), so a mergeReview that rebuilt only sections/drafts/picks would WIPE every answered
// build-decision fleet-wide. This is the landmine the card warns about — it FAILS on the
// pre-fix mergeReview (merged.decisions === undefined).
const current = { sections: { '/payroll': { status: 'approved' } }, drafts: {}, picks: {}, decisions: { 'HUB-1': { choice: 'a', at: 't0' } } };
const legacy = { sections: { '/payroll': { status: 'in-review' }, '/dashboard': { status: 'approved' } }, drafts: { 'lead-ack': { note: 'tweak' } }, picks: {} };
const merged = mergeReview(current, legacy);
ok(merged.sections['/payroll'].status === 'approved', 'migration: an id already in the blob WINS (no clobber)');
ok(merged.sections['/dashboard'].status === 'approved' && merged.drafts['lead-ack'].note === 'tweak', 'migration: ids missing from the blob are carried over');
ok(merged.decisions && merged.decisions['HUB-1']?.choice === 'a',
  'migration: mergeReview PRESERVES current.decisions (legacy has no decisions bucket) — SET_CLIENT_REVIEW must not wipe answered decisions');
ok(REVIEW_KINDS.every((k) => k in merged), 'migration: the merged review carries every REVIEW_KIND bucket');
ok(mergeReview(current, current) === null, 'migration: nothing new to add → null (caller skips the write)');
ok(mergeReview(emptyReview(), null) === null, 'migration: no legacy review → null');

// ── isDecisionAnswered edge cases ────────────────────────────────────────────────
ok(isDecisionAnswered({ choice: 'b' }) === true, 'answered: a non-empty single choice');
ok(isDecisionAnswered({ choice: ['a', 'c'] }) === true, 'answered: a non-empty multi choice array');
ok(isDecisionAnswered({ text: '  hi  ' }) === true, 'answered: non-empty free text');
ok(isDecisionAnswered({ choice: '' }) === false, 'unanswered: empty-string choice');
ok(isDecisionAnswered({ choice: [] }) === false, 'unanswered: empty multi array');
ok(isDecisionAnswered({ choice: null }) === false, 'unanswered: null choice');
ok(isDecisionAnswered({ text: '   ' }) === false, 'unanswered: whitespace-only text');
ok(isDecisionAnswered({ note: 'a note but no answer' }) === false, 'unanswered: a NOTE ALONE never answers');
ok(isDecisionAnswered(undefined) === false, 'unanswered: no entry at all');

// ── reviewSummary semantics (pure; synthetic index so the update dates are controlled) ──
const IDX = [
  { id: 'OLD-1', added: '2026-09-25' },
  { id: 'OLD-2', added: '2026-09-25' },
  { id: 'NEW-1', added: '2026-10-01' },   // the latest update
  { id: 'NOADD', added: null },            // no added date — never "new"
];
const DRAFT_IDS = ['dr-old', 'dr-new'];
const DRAFT_ADDED = { 'dr-new': '2026-10-01' };  // dr-old has no entry → never new

// nothing answered/resolved yet
let sum = reviewSummary({ decisions: {}, drafts: {} }, IDX, DRAFT_IDS, DRAFT_ADDED);
ok(sum.openDecisions === 4, 'summary: all 4 decisions open');
ok(sum.pendingDrafts === 2, 'summary: both drafts pending');
ok(sum.attention === 6, 'summary: attention = open decisions + pending drafts');
ok(sum.latestUpdate === '2026-10-01', 'summary: latestUpdate is the max added across BOTH catalogs');
ok(sum.newDecisionIds.join(',') === 'NEW-1', 'summary: only the latest-update decision is new (NOADD, with no added, is never new)');
ok(sum.newDraftIds.join(',') === 'dr-new', 'summary: only the latest-update draft is new (dr-old, no added, never new)');
ok(sum.newCount === 2, 'summary: newCount = new decisions + new drafts');

// answering the NEW decision clears it from "new" and from open — without a view
sum = reviewSummary({ decisions: { 'NEW-1': { choice: 'a', at: 't' } }, drafts: {} }, IDX, DRAFT_IDS, DRAFT_ADDED);
ok(sum.newDecisionIds.length === 0, 'summary: answering the new decision clears it from new (clears by answering, not viewing)');
ok(sum.openDecisions === 3, 'summary: the answered decision is no longer open');

// a NOTE ALONE on the new decision neither answers nor clears "new"
sum = reviewSummary({ decisions: { 'NEW-1': { note: 'thinking about it' } }, drafts: {} }, IDX, DRAFT_IDS, DRAFT_ADDED);
ok(sum.newDecisionIds.join(',') === 'NEW-1' && sum.openDecisions === 4, 'summary: a note alone leaves the decision open and still new');

// resolving the new draft (accept) clears it from new; older-update items are never new
sum = reviewSummary({ decisions: {}, drafts: { 'dr-new': { status: DRAFT_ACCEPTED } } }, IDX, DRAFT_IDS, DRAFT_ADDED);
ok(sum.newDraftIds.length === 0 && sum.pendingDrafts === 1, 'summary: accepting the new draft clears it from new and pending');
ok(reviewSummary({ decisions: {}, drafts: { 'dr-new': { note: 'x' } } }, IDX, DRAFT_IDS, DRAFT_ADDED).newDraftIds.length === 0,
  'summary: a draft note resolves it (isDraftResolved) and clears new');
ok(isDraftResolved({ status: DRAFT_CHANGES }) === false, 'control: request-changes without a note is still unresolved');

console.log(`client review sync: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
