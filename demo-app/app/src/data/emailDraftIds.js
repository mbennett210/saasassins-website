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
  'quote-doc',
  'quote-email',
  'sign-request',
  'quote-signed-copy',
  'quote-nudge',
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
  'payment-reminder-sms',
  'failed-payment',
  'statement',
  // Quality & feedback (customer)
  'inspection-report',
  'reminder-post-service',
  'review-request',
  'review-request-sms',
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
  // Staff
  'team-invite',
];

// First-seen date per draft id (draftId -> 'YYYY-MM-DD'), the draft twin of
// BUILD_DECISION_INDEX's `added`. EMPTY today: every draft in the catalog above shipped
// before the Review section existed, so none is "new". When a NEW draft is added later,
// give it an entry here with that update's date and it surfaces as New for everyone (the
// shared latest-update rule, reviewSummary in lib/clientReview.js). A draft with no entry
// here is never new. Heavy-import-free, like EMAIL_DRAFT_IDS: the sidebar + provider read it.
export const EMAIL_DRAFT_ADDED = {};
