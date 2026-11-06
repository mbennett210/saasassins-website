// Shared, JSX-free helpers for the Review section (hub + focus). Kept out of the JSX
// components so they can be reasoned about (and, if ever needed, tested) on their own.
import { DECISION_BY_ID, DECISION_SECTION_BY_ID } from '../../data/buildDecisions';
import { EMAIL_DRAFTS } from '../../data/emailDrafts';
import { isDecisionAnswered } from '../../lib/clientReview';

// draft id -> descriptor (the catalog is a stable module array).
export const DRAFT_BY_ID = Object.fromEntries(EMAIL_DRAFTS.map((d) => [d.id, d]));

// Resolve a review item id to the decision or draft it names (a mixed new/open list holds both).
export function findReviewItem(id) {
  if (DECISION_BY_ID[id]) return { type: 'decision', decision: DECISION_BY_ID[id] };
  if (DRAFT_BY_ID[id]) return { type: 'draft', draft: DRAFT_BY_ID[id] };
  return null;
}

// The focus header's area title. The three cross-cutting areas have fixed names; a section
// area is titled by its section.
export function areaTitle(area) {
  if (area === 'drafts') return 'Drafts to sign off';
  if (area === 'new') return 'New in the latest update';
  if (area === 'open') return 'Everything open';
  if (area === 'waiting') return 'Waiting on us';
  return DECISION_SECTION_BY_ID[area]?.title || 'Review';
}

// How many items of a walked list are still OPEN: a question with no answer, a draft that
// `isDraftOpen` (the provider's) says still owes a look. Finish uses it, so a walk that only
// pressed Next or Skip says what is left instead of "Done" (task #126).
export function countOpen(ids, review, isDraftOpen) {
  let n = 0;
  for (const id of ids || []) {
    const item = findReviewItem(id);
    if (item?.type === 'decision' && !isDecisionAnswered(review?.decisions?.[id])) n += 1;
    else if (item?.type === 'draft' && isDraftOpen(id)) n += 1;
  }
  return n;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format a DATE-ONLY 'YYYY-MM-DD' string as "Sep 25" — parsed by field, with NO Date object
// and so NO timezone shift (new Date('2026-09-25') is UTC midnight, which a US zone renders
// as the 24th). Answer TIMESTAMPS are instants and use the org-zone formatter (lib/dates)
// instead; this is only for the catalog's added-on dates.
export function fmtAddedShort(dateStr) {
  if (typeof dateStr !== 'string') return '';
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const month = MONTHS[Number(m[2]) - 1] || m[2];
  return `${month} ${Number(m[3])}`;
}

// The draft's channel word and its build-state tag label (mirrors the old Drafts page).
export const DRAFT_KIND_LABEL = { sms: 'Text', document: 'Document', email: 'Email' };
// `quickbooks`: QuickBooks sends it, not the app (Matt's notes on the invoice drafts, 2026-09-30).
export const DRAFT_STATE_LABEL = { live: 'Live', off: 'Built, off', draft: 'Draft', quickbooks: 'Sent by QuickBooks, not the app' };
