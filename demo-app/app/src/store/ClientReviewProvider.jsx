import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from './index';
import { ACTIONS } from './reducer';
import { selectClientReview } from './selectors';
import {
  isDecisionAnswered,
  isSignedOff,
  isLocked,
  reviewSummary,
  isDraftCurrent,
  isDraftResolved,
  readLegacyReview,
  clearLegacyReview,
  mergeReview,
  DRAFT_PENDING,
  DRAFT_ACCEPTED,
  DRAFT_CHANGES,
  PICK_PENDING,
  PICK_CHOSEN,
  PICK_CHANGES,
} from '../lib/clientReview';
import { EMAIL_DRAFT_IDS, EMAIL_DRAFT_ADDED, EMAIL_DRAFT_CHANGED } from '../data/emailDraftIds';
import { BUILD_DECISION_INDEX } from '../data/buildDecisionIds';
import { newId } from '../lib/ids';

// Provider for the client-review layer (see lib/clientReview.js). The state now lives
// in the shared org_state blob (state.clientReview) instead of a per-browser
// localStorage key, so CleanSpace's picks and notes are visible to every seat. This
// component keeps the SAME hook API it had before the move — reads go through
// useSelector(selectClientReview), writes dispatch through the store — so no consumer
// (Drafts, Dashboard, Payroll, Sidebar) changed.
const ReviewCtx = createContext(null);

export function ClientReviewProvider({ children }) {
  const review = useSelector(selectClientReview);
  const dispatch = useDispatch();

  // One-time migration: lift any review still in the old per-browser localStorage key
  // into the shared blob so earlier sign-offs aren't lost, then retire the key. Merge,
  // never clobber (only ids the blob lacks are carried over). The provider mounts
  // inside an already-hydrated StoreProvider, so `review` here is the shared slice.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;
    const legacy = readLegacyReview();
    if (legacy) {
      const merged = mergeReview(review, legacy);
      if (merged) dispatch({ type: ACTIONS.SET_CLIENT_REVIEW, review: merged });
      clearLegacyReview();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge one entry into a review bucket. Every write carries its SITTING (one edit visit)
  // and, when a sign-off is being changed after that sitting closed, a CONFIRM flag — the
  // reducer refuses a locked sign-off change without it and keeps the prior value in history
  // (CS-402, §130). Notes never come through here (they are add-only, below).
  const updateEntry = useCallback(
    (kind, id, patch, opts = {}) => dispatch({
      type: ACTIONS.UPDATE_CLIENT_REVIEW, kind, id, patch,
      sitting: opts.sitting ?? null,
      confirm: opts.confirm === true,
      recheck: opts.recheck ?? null,
    }),
    [dispatch],
  );
  // Add-only note: appends { id, text, at } to the entry's notes; the reducer ignores empty
  // text and never rewrites the legacy `note` string or a sign-off field. The note id is
  // MINTED HERE (the dispatch site) so a replay of an already-committed note no-ops in the
  // reducer (DATA_AND_SYNC §5 — caller-minted id + reducer dedupe, both halves).
  const addNote = useCallback(
    (kind, id, text, sitting = null) => dispatch({ type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind, id, text, sitting, noteId: newId('note') }),
    [dispatch],
  );

  const api = useMemo(() => {
    // One shared summary drives the hub hero, the section tiles and the nav count. It counts
    // from the heavy-import-free indexes (BUILD_DECISION_INDEX / EMAIL_DRAFT_IDS + _ADDED +
    // _CHANGED), so the full question and template text never enters the common chunk.
    const summary = reviewSummary(review, BUILD_DECISION_INDEX, EMAIL_DRAFT_IDS, EMAIL_DRAFT_ADDED, EMAIL_DRAFT_CHANGED);
    const newDecisionSet = new Set(summary.newDecisionIds);
    const newDraftSet = new Set(summary.newDraftIds);
    const waitingDraftSet = new Set(summary.waitingDraftIds);

    return {
      review,
      updateEntry,
      addNote,

      // ---- Shared summary (one login → shared counts + shared "new") ----
      pendingDrafts: summary.pendingDrafts,
      openDecisions: summary.openDecisions,
      reviewAttention: summary.attention,        // open questions + pending drafts
      waitingDrafts: summary.waitingDrafts,       // sent back to us; never in reviewAttention (CS-864)
      waitingDraftIds: summary.waitingDraftIds,
      reviewNewCount: summary.newCount,           // new from the latest update, still open
      latestUpdate: summary.latestUpdate,         // 'YYYY-MM-DD' or null
      isNewDecision: (id) => newDecisionSet.has(id),
      isNewDraft: (id) => newDraftSet.has(id),
      // A draft still owes a look: unresolved, or answered before it last changed (its answer
      // stays attached). The hub's count and the open list ask this, never isDraftResolved alone.
      isDraftOpen: (id) => !isDraftCurrent(review.drafts[id], EMAIL_DRAFT_CHANGED[id] || null),
      draftChangedOn: (id) => EMAIL_DRAFT_CHANGED[id] || null,
      // Sent back with a note on its current words, not accepted: waiting on us to change them.
      isDraftWaiting: (id) => waitingDraftSet.has(id),
    };
  }, [review, updateEntry, addNote]);

  return <ReviewCtx.Provider value={api}>{children}</ReviewCtx.Provider>;
}

export function useClientReview() {
  const ctx = useContext(ReviewCtx);
  if (!ctx) throw new Error('useClientReview must be used inside <ClientReviewProvider>');
  return ctx;
}

// Convenience hook for a single draft's review controls (§98). `sitting` is created by the
// focus card on mount. Accept / Request changes NO LONGER toggle back to pending — a verdict
// once given is a sign-off; changing it from a later sitting needs `{ confirm: true }` and the
// reducer keeps the prior verdict in `history`. Notes are add-only.
export function useDraftReview(draftId, sitting) {
  const { review, updateEntry, addNote, isNewDraft, isDraftOpen, isDraftWaiting, draftChangedOn } = useClientReview();
  const entry = review.drafts[draftId] || {};
  // Answered before the draft last changed: the answer stays, and the card says it changed since
  // ('YYYY-MM-DD', else null). A verdict with no note counts as an answer here too.
  const changedSince = (isDraftResolved(entry) || isSignedOff('drafts', entry)) && isDraftOpen(draftId)
    ? draftChangedOn(draftId) : null;
  return {
    entry,
    status: entry.status || DRAFT_PENDING,
    note: entry.note || '',                                   // legacy single string (first note)
    notes: Array.isArray(entry.notes) ? entry.notes : [],
    at: entry.at || null,
    history: Array.isArray(entry.history) ? entry.history : [],
    signedOff: isSignedOff('drafts', entry),
    locked: isLocked('drafts', entry, sitting),
    isNew: isNewDraft(draftId),
    waiting: isDraftWaiting(draftId),
    changedSince,
    // On an UPDATED draft the old verdict was on the old words, so a fresh one needs no confirm
    // (task #126): it is sent confirmed, with the change day as `recheck` so the reducer records
    // it even when the status is the same, and keeps the old verdict in history.
    accept: (opts = {}) => updateEntry('drafts', draftId, { status: DRAFT_ACCEPTED }, { sitting, confirm: opts.confirm === true || !!changedSince, recheck: changedSince }),
    requestChanges: (opts = {}) => updateEntry('drafts', draftId, { status: DRAFT_CHANGES }, { sitting, confirm: opts.confirm === true || !!changedSince }),
    addNote: (text) => addNote('drafts', draftId, text, sitting),
  };
}

// Convenience hook for a single design-decision pick (choose-one-of-N variant). `sitting` is
// created when the picker opens. `choose`/`requestChanges` record the winner (carrying the
// variant so the report reads "chose C" / "changes on B"); a locked pick from an earlier
// sitting needs `{ confirm: true }` and its prior value is kept in `history`. Notes add-only.
export function usePickReview(pickId, sitting) {
  const { review, updateEntry, addNote } = useClientReview();
  const entry = review.picks[pickId] || {};
  return {
    entry,
    choice: entry.choice ?? null,
    status: entry.status || PICK_PENDING,
    note: entry.note || '',                                   // legacy single string (first note)
    notes: Array.isArray(entry.notes) ? entry.notes : [],
    at: entry.at || null,
    history: Array.isArray(entry.history) ? entry.history : [],
    signedOff: isSignedOff('picks', entry),
    locked: isLocked('picks', entry, sitting),
    choose: (variant, opts = {}) => updateEntry('picks', pickId, { choice: variant, status: PICK_CHOSEN }, { sitting, confirm: opts.confirm }),
    requestChanges: (variant, opts = {}) => updateEntry('picks', pickId, { choice: variant, status: PICK_CHANGES }, { sitting, confirm: opts.confirm }),
    reset: (opts = {}) => updateEntry('picks', pickId, { choice: null, status: PICK_PENDING }, { sitting, confirm: opts.confirm }),
    addNote: (text) => addNote('picks', pickId, text, sitting),
  };
}

// Convenience hook for a single build-decision (Review focus card). `sitting` is created by
// the card on mount. `choice` is the option id (single), an array of ids (multi), or null;
// `text` is the answer for a text question. `note`/`notes` are context, add-only, and NEVER
// count as an answer. `locked` = answered in an EARLIER sitting: the card disables the inputs
// and offers "Change answer" behind a confirm; the first confirmed save keeps the prior
// answer in `history`. `at`, `answered` and `isNew` come from the shared state/summary.
export function useDecisionReview(id, sitting) {
  const { review, updateEntry, addNote, isNewDecision } = useClientReview();
  const entry = review.decisions[id] || {};
  const answered = isDecisionAnswered(entry);
  return {
    entry,
    choice: entry.choice ?? null,
    text: entry.text || '',
    note: entry.note || '',                                   // legacy single string (first note)
    notes: Array.isArray(entry.notes) ? entry.notes : [],
    at: entry.at || null,
    history: Array.isArray(entry.history) ? entry.history : [],
    answered,
    signedOff: answered,
    locked: isLocked('decisions', entry, sitting),
    isNew: isNewDecision(id),
    setChoice: (choice, opts = {}) => updateEntry('decisions', id, { choice }, { sitting, confirm: opts.confirm }),
    setText: (text, opts = {}) => updateEntry('decisions', id, { text }, { sitting, confirm: opts.confirm }),
    // Clear an answer: reset choice + text, KEEP the notes (context outlives the answer).
    clear: (opts = {}) => updateEntry('decisions', id, { choice: null, text: '' }, { sitting, confirm: opts.confirm }),
    addNote: (text) => addNote('decisions', id, text, sitting),
  };
}
