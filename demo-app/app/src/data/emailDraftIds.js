// Stable ids for the client-review "Drafts" catalog.
//
// Kept in a heavy-import-free module ON PURPOSE: the Sidebar (and the review
// provider) count pending drafts from this list, and must NOT pull the email
// template builders (large data-URI logos) into the common chunk just to know
// how many drafts exist. The full descriptors (copy + render + buildState) live
// in ./emailDrafts.js and reuse these same ids, so the id universe has one
// source of truth. Order below follows the customer-journey grouping on the page.
//
// The original 10 ids are unchanged so any existing review state (accept/note)
// keyed by them survives this expansion. The marketing sequence is deliberately
// excluded (the client edits those in the Marketing UI).
export const EMAIL_DRAFT_IDS = [
  // Sales & quotes (prospect)
  'lead-ack',
  'walkthrough-confirm',
  // (quote-email: RETIRED 2026-10-20 — nothing sends it; reviewManifest.json retiredDrafts)
  // (quote-doc, sign-request, quote-signed-copy, quote-nudge: RETIRED 2026-10-23 — Matt does
  // quotes in PandaDoc and the Quotes page is hidden, lib/features.js QUOTES_ENABLED)
  // Onboarding (customer)
  'reminder-welcome',
  'service-setup',
  // Scheduling & visits (customer)
  'reminder-booking',
  'sms-24h',
  'sms-day-of',
  'on-the-way',
  'reschedule',
  'cancellation',
  'visit-summary',
  'missed-visit',
  // Billing & payments (customer)
  'invoice-sent',
  'upcoming-due',
  'payment-receipt',
  'past-due',
  // (payment-reminder-sms: RETIRED 2026-10-28 — billing is email only; reviewManifest.json
  // retiredDrafts; its id is never reused)
  'failed-payment',
  'statement',
  // Quality & feedback (customer)
  'inspection-report',
  'reminder-post-service',
  // (review-request, review-request-sms: RETIRED 2026-10-20 with Google reviews — reviewManifest.json
  // retiredDrafts; their ids are never reused)
  'complaint-ack',
  'complaint-resolution',
  'satisfaction-survey',
  // Retention & account (customer)
  'renewal-notice',
  'renewal-offer',
  'upsell',
  'service-change',
  'price-increase',
  'win-back',
  'offboarding',
  // Customer hub (a customer's hub login; added 2026-10-20 — emails that already go out)
  'hub-request-update',
  'hub-request-reply',
  'hub-inspection-posted',
  'hub-office-message',
  // Staff and sign-in (the software's own sign-in emails). The account-setup email takes the place
  // of team-invite (RETIRED 2026-10-20: the demo-only invite staff never get) under a NEW id, so
  // the acceptance given to the old words cannot carry over to the real email.
  'account-setup',
  'password-reset',
];

// First-seen date per draft id (draftId -> 'YYYY-MM-DD'), the draft twin of
// BUILD_DECISION_INDEX's `added`. A NEW draft gets an entry with its update's date and surfaces
// as New for everyone (the shared latest-update rule, reviewSummary in lib/clientReview.js). A
// draft with no entry here is never new. Heavy-import-free, like EMAIL_DRAFT_IDS: the sidebar +
// provider read it. Every draft before 2026-10-20 shipped before the Review section existed.
export const EMAIL_DRAFT_ADDED = Object.freeze({
  'hub-request-update': '2026-10-20',
  'hub-request-reply': '2026-10-20',
  'hub-inspection-posted': '2026-10-20',
  'hub-office-message': '2026-10-20',
  'account-setup': '2026-10-20',
  'password-reset': '2026-10-20',
});

// The day a PUBLISHED draft's words or state last CHANGED (draftId -> 'YYYY-MM-DD'). Its id, and
// so Matt's answer keyed by it, stay; an answer (a verdict or a note) given BEFORE that day no
// longer counts as reviewing it: the draft is open again and, on the latest update, New — the
// answer stays attached and shown (lib/clientReview isDraftCurrent). Changing a draft's words
// so much that an earlier ACCEPTANCE must never carry over is a retirement and a new id instead
// (team-invite → account-setup, 2026-10-20).
export const EMAIL_DRAFT_CHANGED = Object.freeze({
  // Matt's own wording from his note
  'reminder-welcome': '2026-10-20',
  // "Sent by QuickBooks, not the app"
  'invoice-sent': '2026-10-20',
  'payment-receipt': '2026-10-20',
  'past-due': '2026-10-20',
  // sample photos, under each area and in Additional photos ("Where will the pictures go?")
  'inspection-report': '2026-10-20',
});
