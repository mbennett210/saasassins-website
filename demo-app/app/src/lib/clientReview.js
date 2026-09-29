// Client review layer — the client's sign-offs on the build.
//
// Three review surfaces the client uses to review the build and tell us what to
// change: per-nav-section "in review / approved" markers, the Drafts email review
// (accept / request-changes / note), and design-decision "picks" (choose one of N
// layout variants + note; Dashboard and Payroll today).
//
// STORAGE (changed 2026-09-23): this state now lives in the shared org_state blob
// (state.clientReview), NOT a per-browser localStorage key. CleanSpace's selections
// and notes must be visible to BOTH CleanSpace and us — under one shared login,
// per-browser storage left every pick/note trapped on whichever device made it. In
// org_state it rides the normal CAS sync (store/tableSlices toSharedBlob keeps every
// non-stripped slice) and every seat sees the same review. Additive + default-safe:
// readers go through selectClientReview, which defaults to EMPTY_REVIEW, so an older
// blob without the slice is safe with NO store-version bump. (This reverses the
// earlier "per-browser, no send-back" decision, by the owner's request.)
//
// A one-time migration (ClientReviewProvider) lifts any review still sitting in the
// old localStorage key into the blob so earlier sign-offs aren't lost.

// Section marker states (per nav route).
export const SECTION_IN_REVIEW = 'in-review';
export const SECTION_APPROVED = 'approved';

// Draft review states (per email-template id).
export const DRAFT_PENDING = 'pending';
export const DRAFT_ACCEPTED = 'accepted';
export const DRAFT_CHANGES = 'changes';

// Design-decision "pick" states (per pick id, e.g. 'dashboard-layout'). A pick is a
// choose-one-of-N variant decision — generic on purpose so future variant picks reuse
// the slice.
export const PICK_PENDING = 'pending';
export const PICK_CHOSEN = 'chosen';
export const PICK_CHANGES = 'changes';

// The review buckets, one map each. A NEW bucket must be added HERE, in emptyReview(), in
// mergeReview()'s loop and in the reducer's UPDATE_CLIENT_REVIEW kind guard, or it won't
// merge or migrate. 'decisions' (Matt's build-decision answers) was added 2026-09-26.
export const REVIEW_KINDS = ['sections', 'drafts', 'picks', 'decisions'];

// The empty review shape (one map per REVIEW_KIND). No `version` field — the store version
// governs now that this rides the org_state blob.
export function emptyReview() {
  return { sections: {}, drafts: {}, picks: {}, decisions: {} };
}

// ── The ADDITIVE model (CS-402, UI_RULES §130) ───────────────────────────────────
// A client sign-off must never be overwritten by a stray click. Every review WRITE
// carries a `sitting` id (one uninterrupted edit visit, see newSitting): the reducer
// stamps it on the entry next to `at`. An entry is SIGNED OFF per kind (below); once
// signed off, a later sitting can only CHANGE a sign-off field behind an explicit
// confirm, and the reducer keeps the prior value in the entry's `history` array (only
// grows). A misclick fix WITHIN the same sitting needs no confirm and adds no history.
// Notes are ADD-ONLY (ADD_CLIENT_REVIEW_NOTE); UPDATE never writes note/notes.

// The sign-off fields per kind — the fields the reducer protects (and snapshots into
// history on a confirmed change). A note is never a sign-off field.
export const SIGNOFF_FIELDS = {
  sections: ['status'],
  drafts: ['status'],
  picks: ['status', 'choice'],
  decisions: ['choice', 'text'],
};

// Is this entry SIGNED OFF for its kind? A section approved; a draft accepted or
// changes-requested; a pick chosen or changes-requested; a question answered (a real
// choice/text — a note alone never answers). Default-safe on an absent/older entry.
export function isSignedOff(kind, entry) {
  if (!entry) return false;
  if (kind === 'sections') return entry.status === SECTION_APPROVED;
  if (kind === 'drafts') return entry.status === DRAFT_ACCEPTED || entry.status === DRAFT_CHANGES;
  if (kind === 'picks') return entry.status === PICK_CHOSEN || entry.status === PICK_CHANGES;
  if (kind === 'decisions') return isDecisionAnswered(entry);
  return false;
}

// LOCKED for a write from `sitting`: signed off AND not the SAME sitting that signed it.
// "Same sitting" needs BOTH the stored and the write sitting present and equal, so an
// older signed-off entry with no stored sitting (a legacy or pre-CS-402 blob) reads as
// LOCKED — never silently overwritable. Changing a locked entry's sign-off field needs
// `confirm: true` at the reducer.
export function sameSitting(entrySitting, sitting) {
  return entrySitting != null && sitting != null && entrySitting === sitting;
}
export function isLocked(kind, entry, sitting) {
  return isSignedOff(kind, entry) && !sameSitting(entry && entry.sitting, sitting);
}

// A random id for one edit sitting. NOT a security token (never a capability), so a
// UUID or a cheap random suffix both do — prefer crypto.randomUUID where present.
export function newSitting() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* no global crypto */ }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Value equality for a sign-off field: arrays (a multi choice) compare by member, else
// strict. Used by the reducer to tell a real sign-off change from an idempotent re-write.
export function reviewFieldEq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

// Does the entry carry ANY note? A legacy single `note` string (older entries, the demo,
// legacy migrations) OR a non-empty add-only `notes` array. Both count as a note.
export function hasAnyNote(entry) {
  if (!entry) return false;
  if (typeof entry.note === 'string' && entry.note.trim()) return true;
  return Array.isArray(entry.notes) && entry.notes.some((n) => n && typeof n.text === 'string' && n.text.trim());
}

// The entry's notes for display, OLDEST FIRST: the legacy single `note` string first
// (shown once, never rewritten, no timestamp of its own), then the add-only `notes`
// array in append order. Each is `{ text, at, legacy? }`.
export function reviewNotes(entry) {
  const out = [];
  if (entry && typeof entry.note === 'string' && entry.note.trim()) out.push({ text: entry.note, at: null, legacy: true });
  if (entry && Array.isArray(entry.notes)) {
    for (const n of entry.notes) if (n && typeof n.text === 'string' && n.text.trim()) out.push({ text: n.text, at: n.at || null });
  }
  return out;
}

// A draft is RESOLVED once the client has given it an acceptance OR any note (legacy or
// add-only). The red count is "pending either a NOTE or an ACCEPTANCE"; requesting
// changes flips the dot to amber but still owes a note to clear the pending count.
export function isDraftResolved(entry) {
  if (!entry) return false;
  return entry.status === DRAFT_ACCEPTED || hasAnyNote(entry);
}

// A pick is RESOLVED once the client has chosen a variant OR left any note (mirrors the
// draft rule) — an unmade pick is what a "layout in review" banner surfaces.
export function isPickResolved(entry) {
  if (!entry) return false;
  return entry.status === PICK_CHOSEN || hasAnyNote(entry);
}

// A build-decision (state.clientReview.decisions[id]) is ANSWERED once it carries a real
// answer: a non-empty single choice (option id string), a non-empty multi choice (array of
// option ids), or non-empty free `text` (the text-type questions). A NOTE ALONE never
// answers — a note is context, not a decision — so an item with only a note stays open
// (and stays "new"). Mirrors the questionnaire's own isAnswered.
export function isDecisionAnswered(entry) {
  if (!entry) return false;
  const { choice, text } = entry;
  if (typeof choice === 'string' && choice) return true;
  if (Array.isArray(choice) && choice.length > 0) return true;
  if (typeof text === 'string' && text.trim().length > 0) return true;
  return false;
}

// A PURE summary of the whole review layer, for the hub hero, the tiles and the nav count.
// `decisionIndex` is BUILD_DECISION_INDEX ([{ id, added }]) and `draftAdded` is
// EMAIL_DRAFT_ADDED (draftId -> 'YYYY-MM-DD'); both are the heavy-import-free indexes, so the
// full question/template text never enters the common chunk. `draftIds` is EMAIL_DRAFT_IDS.
//
// "New" is SHARED (one login) and date-driven: an item is new iff its `added` equals the
// LATEST `added` across BOTH catalogs AND it is still OPEN (a question unanswered, a draft
// unresolved). So "new" clears by answering or resolving, never by viewing, and an item with
// no `added` is never new. Returns counts plus the exact new-id lists (order = catalog order).
export function reviewSummary(review, decisionIndex, draftIds, draftAdded) {
  const r = review || emptyReview();
  const decisions = normalizeMap(r.decisions);
  const drafts = normalizeMap(r.drafts);
  const idx = Array.isArray(decisionIndex) ? decisionIndex : [];
  const ids = Array.isArray(draftIds) ? draftIds : [];
  const added = draftAdded && typeof draftAdded === 'object' ? draftAdded : {};

  const openDecisions = idx.reduce((n, d) => n + (isDecisionAnswered(decisions[d.id]) ? 0 : 1), 0);
  const pendingDrafts = ids.reduce((n, id) => n + (isDraftResolved(drafts[id]) ? 0 : 1), 0);

  // The latest update: the max `added` date across BOTH catalogs. Date-only 'YYYY-MM-DD'
  // strings compare correctly lexicographically. Items with no `added` never move it.
  let latestUpdate = null;
  for (const d of idx) if (d.added && (!latestUpdate || d.added > latestUpdate)) latestUpdate = d.added;
  for (const id of ids) { const a = added[id]; if (a && (!latestUpdate || a > latestUpdate)) latestUpdate = a; }

  const newDecisionIds = latestUpdate
    ? idx.filter((d) => d.added === latestUpdate && !isDecisionAnswered(decisions[d.id])).map((d) => d.id)
    : [];
  const newDraftIds = latestUpdate
    ? ids.filter((id) => added[id] === latestUpdate && !isDraftResolved(drafts[id]))
    : [];

  return {
    openDecisions,
    pendingDrafts,
    attention: openDecisions + pendingDrafts,
    latestUpdate,
    newDecisionIds,
    newDraftIds,
    newCount: newDecisionIds.length + newDraftIds.length,
  };
}

// ── one-time migration off the legacy per-browser key ───────────────────────────
// Pre-2026-09-23 builds stored review under this localStorage key. We read it ONCE
// and merge it into the shared blob, then retire the key. Never throws (private mode
// / cleared storage / bad JSON → null).
const LEGACY_STORAGE_KEY = 'cleanspace_client_review_v1';

function normalizeMap(m) {
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// Read the legacy localStorage review, or null when there's nothing usable to migrate.
export function readLegacyReview() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const legacy = {
      sections: normalizeMap(parsed.sections),
      drafts: normalizeMap(parsed.drafts),
      picks: normalizeMap(parsed.picks),
    };
    const empty =
      !Object.keys(legacy.sections).length &&
      !Object.keys(legacy.drafts).length &&
      !Object.keys(legacy.picks).length;
    return empty ? null : legacy;
  } catch {
    return null;
  }
}

// Remove the legacy key so the migration can't re-apply on a later load.
export function clearLegacyReview() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

// Merge a legacy review INTO the current shared review, additively: an id already
// present in the shared slice always wins (never clobber a sign-off made on another
// seat); only ids missing from the shared slice are carried over. Returns the merged
// review, or null when there's nothing new to add (so the caller can skip the write).
export function mergeReview(current, legacy) {
  if (!legacy) return null;
  // Start from EVERY bucket already on `current`, so a bucket the legacy per-browser blob
  // never had — `decisions`, or any bucket added later — is PRESERVED. The migration writes
  // this result through SET_CLIENT_REVIEW (a whole-slice replace), so dropping a bucket here
  // would wipe it for every seat. Then ensure the canonical buckets exist and additively
  // merge legacy: an id already in the shared slice always WINS (never clobber a sign-off
  // made on another seat); only ids the shared slice lacks are carried over.
  const out = {};
  const cur = current && typeof current === 'object' ? current : {};
  for (const [kind, map] of Object.entries(cur)) out[kind] = { ...normalizeMap(map) };
  for (const kind of REVIEW_KINDS) if (!out[kind]) out[kind] = {};
  let changed = false;
  for (const kind of REVIEW_KINDS) {
    for (const [id, entry] of Object.entries(normalizeMap(legacy[kind]))) {
      if (!(id in out[kind])) {
        out[kind][id] = entry;
        changed = true;
      }
    }
  }
  return changed ? out : null;
}
