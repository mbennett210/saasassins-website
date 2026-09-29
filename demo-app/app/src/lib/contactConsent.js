// ─────────────────────────────────────────────────────────────────────────────
// Contact communication-consent helpers — pure, node-safe (no browser globals,
// no relative imports) so both the SPA (reducer/selectors/pages) and the
// tab-less Vercel crons (api/reminders/run, api/marketing/run) share ONE
// definition of "may we contact this person?".
//
// Two per-contact sparse flags (additive, default-safe — absence = may contact):
//   contact.doNotContact  — hard Do-Not-Contact. Blocks ALL unattended
//                           automated email/SMS (reminders, marketing, quote
//                           send). Manual Messaging only WARNS (see UI_RULES §47).
//   contact.reminderOptOut — softer, reminders-only opt-out (marketing still
//                            governed by the email-keyed suppression list).
//
// The email-keyed marketing suppression list (state.marketingSuppressions,
// CAN-SPAM, auto-populated from replies / unsubscribe links / manual adds) is
// keyed by EMAIL, not contact id — one opted-out address suppresses every
// contact that shares it. buildSuppressedEmailSet() is the single builder the
// four gates (reducer ENROLL_CONTACTS, marketingScheduler getDueSends +
// getDueEnrollments, engine applyEnroll) resolve membership against.
//
// NON_TRANSACTIONAL_REMINDER_KEYS — reminder templates that are marketing-like
// (a nudge, not a receipt) and therefore ALSO honor the marketing suppression
// list. booking_confirmation is transactional (a receipt for an action the
// customer just took) so it is EXEMPT from the marketing list — but it still
// honors DNC and reminderOptOut like every reminder.
//
// Deliberate exclusions (customer-INITIATED receipts — never gated here, by
// design; suppressing them would break a flow the customer themselves started):
//   • Quote signed-copy email — api/public/pay/[...path].js:116-121 (the copy of
//     the quote a customer receives right after THEY sign/pay it).
//   • Forms resume-link + respondent-copy emails — sent because the respondent
//     asked for them.
//
// SMS reality: there is NO inbound STOP/unsubscribe webhook wired yet, so the
// marketing suppression list is email-only and cannot capture an SMS opt-out.
// Per-contact doNotContact is currently the ONLY suppression an SMS send honors.
// ─────────────────────────────────────────────────────────────────────────────

// Hard Do-Not-Contact flag — blocks all unattended automated communication.
export function isDoNotContact(contact) {
  return contact?.doNotContact === true;
}

// Reminders-only opt-out (stored as the opt-OUT, so a sparse/absent flag means
// the contact still receives reminders — matching the opt-out consent model).
export function isReminderOptOut(contact) {
  return contact?.reminderOptOut === true;
}

// The one lowercase Set of suppressed marketing emails, built from
// state.marketingSuppressions. Blank/missing emails are dropped. Membership is
// checked case-insensitively (callers lowercase the email they test).
export function buildSuppressedEmailSet(state) {
  return new Set(
    ((state && state.marketingSuppressions) || [])
      .map((s) => (s.email || '').toLowerCase())
      .filter(Boolean)
  );
}

// Reminder templates that behave like marketing (a nudge, not a transactional
// receipt) and therefore ALSO honor the email-keyed marketing suppression list.
// booking_confirmation is intentionally NOT here — it's a transactional receipt,
// exempt from the marketing list, but still gated by DNC + reminderOptOut.
export const NON_TRANSACTIONAL_REMINDER_KEYS = new Set(['post_service', 'welcome_email']);
