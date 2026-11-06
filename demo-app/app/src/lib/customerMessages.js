// THE CUSTOMER MESSAGES — one catalog for every automated message to a customer or a prospect
// (Matt's approved messages, 2026-10-19; plan docs/plans/2026-10-19-approved-messages.md).
//
// Pure and import-free, so the browser (Settings → Customer Reminders, the Review "Drafts"
// preview, the seed), the reminders cron (api/reminders/run.js) and the release data-op
// (app/scripts/dataop-approved-messages.mjs) read the SAME list.
//
// 🔴 ONE SOURCE FOR THE WORDS. Each message's default subject and body is the wording Matt
// accepted in Review, written with `{tokens}` where his draft showed sample data. The Drafts
// preview (src/data/emailDrafts.js) renders THIS text with sample values, the seed's
// `reminderTemplates` are built from it, and the data-op adds it to production — so what Matt
// approved, what the office edits in Settings and what a customer receives cannot drift. The
// approved wording itself is held in app/scripts/fixtures/approved-messages.json, and
// app/scripts/test-customer-message-catalog.mjs renders every template against it.
//
// The office may edit a template's text (Settings → Customer Reminders); the stored template
// then wins, and "Reset to approved wording" puts this text back.
//
// TOKENS (filled by lib/reminderScheduler.js buildTokens, in the org's time zone):
//   {first_name} {client_contact} {customer} {site_name} {service} {schedule} {first_visit}
//   {date} {time} {crew_lead} {company} {company_phone} {invoice_number} {amount} {balance}
//   {pay_link} {survey_link} {change_summary} {effective_date}
// A token the message has no value for renders empty; a message whose words NEED a value it does
// not have (a pay link) is not sent at all (`needs`).

// ── when customer messages may go out ────────────────────────────────────────
// 09:00–19:00 on the ORG's clock (company.timezone), for every message not marked `immediate`
// (a receipt for something the customer just did, or the crew being on the way, goes at once).
// The cron runs every five minutes under TZ=UTC, so without the window a clean finishing at
// 2 a.m. would email the customer at 2 a.m. An overnight clean's summary therefore goes at 09:00.
export const CUSTOMER_SEND_HOURS = Object.freeze({ from: 9, until: 19 });

// ── the timings (the defaults Daniel accepted, 2026-10-19) ───────────────────
// How long after an EVENT (a clean finished, a ticket logged, a deal moved) its message may
// still go. Past it the event is old news, which is what keeps switching a template ON from
// ever sending about the past (no back-blast).
export const EVENT_MAX_AGE_HOURS = 48;
// A message tied to a DAY (a renewal 60 days out, a statement on the 1st) goes on that day or,
// if the window or the daily email ceiling held it, on one of the next DAY_GRACE_DAYS days.
export const DAY_GRACE_DAYS = 2;
export const UPCOMING_DUE_LEAD_DAYS = 7;          // the upcoming-due reminder: 7 days before
export const STATEMENT_DAY_OF_MONTH = 1;          // the monthly statement: the 1st
export const SURVEY_EVERY_DAYS = 91;              // the satisfaction survey: every three months
export const SURVEY_MIN_TENURE_DAYS = 30;         // …once a customer has been with us a month
export const SURVEY_LINK_DAYS = 30;               // the survey link works for 30 days
export const RENEWAL_NOTICE_LEAD_DAYS = 60;       // the renewal notice: 60 days before
export const RENEWAL_OFFER_LEAD_DAYS = 30;        // the renewal offer: 30 days before
export const PRICE_INCREASE_LEAD_DAYS = 30;       // the price-increase notice: 30 days before
export const UPSELL_AFTER_DAYS = 90;              // the upsell: 90 days after service starts
export const WIN_BACK_AFTER_DAYS = 60;            // the win-back: 60 days after service ends
export const LEAD_ACK_REPEAT_DAYS = 30;           // a lead re-submitting within this: no second ack

// ── how long the sent log keeps a row (customer_messages.keep_until) ──────────
// Long enough to outlive every window that reads it.
export const DEFAULT_KEEP_DAYS = 35;

// The template keys. Existing ones keep their names (production's stored templates use them).
export const MESSAGE_KEY = Object.freeze({
  leadAck: 'lead_ack',
  walkthroughConfirm: 'walkthrough_confirm',
  welcome: 'welcome_email',
  serviceSetup: 'service_setup',
  bookingConfirmation: 'booking_confirmation',
  reminder24h: 'reminder_24h',
  dayOfEta: 'day_of_eta',
  onTheWay: 'on_the_way',
  reschedule: 'reschedule',
  cancellation: 'cancellation',
  visitSummary: 'visit_summary',
  missedVisit: 'missed_visit',
  upcomingDue: 'upcoming_due',
  // (payment_reminder_sms, the past-due TEXT: removed 2026-10-28 — the texting campaign covers the
  // three visit texts, so billing goes by email. A stored template under that key sends nothing.)
  statement: 'statement',
  postService: 'post_service',
  complaintAck: 'complaint_ack',
  complaintResolution: 'complaint_resolution',
  satisfactionSurvey: 'satisfaction_survey',
  renewalNotice: 'renewal_notice',
  renewalOffer: 'renewal_offer',
  upsell: 'upsell',
  serviceChange: 'service_change',
  priceIncrease: 'price_increase',
  winBack: 'win_back',
  offboarding: 'offboarding',
});
const K = MESSAGE_KEY;

// Each message:
//   key, draftId (the Review "Drafts" id), group (Settings' section), label, when (Settings' line)
//   channel        'email' | 'sms'
//   transactional  false = a nudge, not a receipt: honours the marketing suppression list and
//                  carries an opt-out line (lib/contactConsent NON_TRANSACTIONAL_REMINDER_KEYS
//                  is DERIVED from this flag)
//   immediate      true = not held to CUSTOMER_SEND_HOURS
//   recipient      'visit' (the clean's site contact, else the customer's main contact) ·
//                  'customer' (the main contact) · 'billing' (the billing contact, else main) ·
//                  'prospect' (the lead or deal's own contact)
//   needs          tokens the words cannot go without; no value = not sent (recorded skipped)
//   built          false = no trigger yet: in the catalog for its words only, never switched on
//                  (welcome_email, which is kept as a template, off). The walkthrough
//                  confirmation became built on 2026-10-20, when deals began to record the
//                  walkthrough's date and time (lib/walkthrough).
//   enabledByDefault  the seed's switch (approved = on; welcome_email stays off, Matt left
//                  notes on its wording)
//   keepDays       the sent log's retention for it
export const CUSTOMER_MESSAGES = Object.freeze([
  // ── Sales (prospect) ──
  {
    key: K.leadAck, draftId: 'lead-ack', group: 'sales', label: 'New-lead acknowledgement',
    when: 'Emailed the moment a new lead arrives from your website form.',
    channel: 'email', transactional: true, immediate: true, recipient: 'prospect',
    subject: 'Thanks for reaching out to {company}',
    body: 'Hi {first_name},\n\nThanks for getting in touch with {company}. We have your request, and a member of our team will follow up within one business day to learn about your space and the right next step.\n\nIf it is easier to talk now, call us at {company_phone}.\n\nThe {company} team',
  },
  {
    // {site_name} is where we meet: the deal's "Where to meet", else the company's location, else its
    // name; {date} and {time} are the deal's walkthrough on the org's clock (lib/walkthrough).
    key: K.walkthroughConfirm, draftId: 'walkthrough-confirm', group: 'sales', label: 'Walkthrough confirmation',
    when: 'Emailed when a deal’s walkthrough date and time is set, and again if it changes.',
    channel: 'email', transactional: true, immediate: false, recipient: 'prospect',
    subject: 'Your walkthrough with {company} is set',
    body: 'Hi {first_name},\n\nYou are on the calendar. We will meet you at {site_name} on {date} at {time} to walk the space and put together the right cleaning plan.\n\nIt takes about 20 minutes. If anything changes, reply here or call {company_phone}.\n\nThe {company} team',
  },
  // ── Onboarding ──
  {
    key: K.welcome, draftId: 'reminder-welcome', group: 'onboarding', label: 'Welcome email',
    when: 'Has no automatic send trigger. Kept as a template only.',
    channel: 'email', transactional: false, immediate: false, recipient: 'customer', built: false, enabledByDefault: false,
    subject: 'Welcome to {company}',
    // Matt's own wording, from his note on this draft in Review (2026-09-30), the brand's phone and
    // name as tokens (2026-10-20). An UNEDITED stored template may still hold an earlier default; the
    // approved-messages data-op (app/scripts/dataop-approved-messages.mjs WELCOME_EARLIER_DEFAULTS)
    // moves one of those to this, and leaves words the office edited.
    body: 'Hi {client_contact},\n\nWelcome aboard. We will contact you with the next steps.\n\nQuestions? Reply to this email or call us at {company_phone}.\n\nThe {company} team',
  },
  {
    key: K.serviceSetup, draftId: 'service-setup', group: 'onboarding', label: 'Service setup confirmation',
    when: 'Emailed when a customer’s first recurring cleaning schedule is created.',
    channel: 'email', transactional: true, immediate: false, recipient: 'customer',
    subject: 'You are all set with {company}',
    body: 'Hi {first_name},\n\nWelcome aboard. Here is your setup at a glance:\n\nSite: {site_name}\nService: {service}, {schedule}\nFirst visit: {first_visit}\n\nYour crew lead is {crew_lead}. You will get a reminder before each visit and a quick check-in after. Questions any time at {company_phone}.\n\nThe {company} team',
  },
  // ── Scheduling & visits ──
  {
    key: K.bookingConfirmation, draftId: 'reminder-booking', group: 'visits', label: 'Booking confirmation',
    when: 'Emailed right after a cleaning is booked (once for a recurring schedule).',
    channel: 'email', transactional: true, immediate: true, recipient: 'visit',
    subject: 'Your cleaning is booked',
    body: 'Hi {client_contact}, your {service} at {site_name} is booked for {date} at {time}.\n\n{company}',
  },
  {
    key: K.reminder24h, draftId: 'sms-24h', group: 'visits', label: '24-hour reminder (text)',
    when: 'Texted the day before each cleaning.',
    channel: 'sms', transactional: true, immediate: false, recipient: 'visit',
    subject: '',
    body: 'Reminder: {company} will be at {site_name} tomorrow at {time} for {service}.',
  },
  {
    key: K.dayOfEta, draftId: 'sms-day-of', group: 'visits', label: 'Day-of reminder (text)',
    when: 'Texted the morning of each cleaning.',
    channel: 'sms', transactional: true, immediate: false, recipient: 'visit',
    subject: '',
    body: 'Reminder: {company} is scheduled at {site_name} today at {time} for your {service}.',
  },
  {
    key: K.onTheWay, draftId: 'on-the-way', group: 'visits', label: 'Crew on the way (text)',
    when: 'Texted when the cleaner taps “On my way” in the Cleaner Hub.',
    channel: 'sms', transactional: true, immediate: true, recipient: 'visit',
    subject: '',
    body: '{company}: your crew is on the way to {site_name} and will arrive around {time}. Reply here with any access notes.',
  },
  {
    key: K.reschedule, draftId: 'reschedule', group: 'visits', label: 'Reschedule notice',
    when: 'Emailed when a future cleaning’s date or time is changed.',
    channel: 'email', transactional: true, immediate: false, recipient: 'visit',
    subject: 'We have moved your cleaning',
    body: 'Hi {first_name},\n\nYour cleaning at {site_name} has been rescheduled to {date} at {time}. No action needed on your end.\n\nIf that time does not work, reply here or call {company_phone} and we will find a better window.\n\nThe {company} team',
  },
  {
    key: K.cancellation, draftId: 'cancellation', group: 'visits', label: 'Cancellation notice',
    when: 'Emailed when a future cleaning is cancelled.',
    channel: 'email', transactional: true, immediate: false, recipient: 'visit',
    subject: 'Your cleaning has been cancelled',
    body: 'Hi {first_name},\n\nWe have cancelled the cleaning scheduled for {site_name} on {date}. If this was a mistake or you would like to rebook, let us know and we will get it back on the calendar.\n\nThe {company} team',
  },
  {
    key: K.visitSummary, draftId: 'visit-summary', group: 'visits', label: 'Visit-completed summary',
    when: 'Emailed after each finished cleaning (an overnight one at 9 AM).',
    channel: 'email', transactional: true, immediate: false, recipient: 'visit',
    subject: 'Your space was cleaned today',
    body: "Hi {first_name},\n\nYour crew completed today's cleaning at {site_name}. Everything on the checklist was covered, and your crew lead noted the space is in good shape.\n\nIf anything needs a second look, reply here and we will take care of it right away.\n\nThe {company} team",
  },
  {
    key: K.missedVisit, draftId: 'missed-visit', group: 'visits', label: 'Missed-visit apology',
    when: 'Emailed when a cleaning’s time has passed with nobody clocked in.',
    channel: 'email', transactional: true, immediate: false, recipient: 'visit',
    subject: 'We missed today, and we are on it',
    body: "Hi {first_name},\n\nWe are sorry. Our crew was not able to complete today's scheduled cleaning at {site_name}. That is not our standard, and we want to make it right.\n\nWe would like to reschedule at the earliest time that works for you. Reply here or call {company_phone}.\n\nThe {company} team",
  },
  // ── Billing (from QuickBooks) ──
  {
    key: K.upcomingDue, draftId: 'upcoming-due', group: 'billing', label: 'Upcoming-due reminder',
    when: 'Emailed 7 days before a QuickBooks invoice is due.',
    channel: 'email', transactional: true, immediate: false, recipient: 'billing', needs: ['pay_link'],
    subject: 'Invoice {invoice_number} is due soon',
    body: 'Hi {first_name},\n\nA friendly reminder that invoice {invoice_number} for {amount} is due in 7 days under your Net-30 terms.\n\nYou can pay online here: {pay_link}. If you have already sent payment, thank you, and please disregard.\n\nThe {company} team',
  },
  {
    key: K.statement, draftId: 'statement', group: 'billing', label: 'Monthly statement',
    when: 'Emailed on the 1st of each month, with the statement attached.',
    channel: 'email', transactional: true, immediate: false, recipient: 'billing', keepDays: 70,
    subject: 'Your {company} statement',
    body: 'Hi {first_name},\n\nAttached is your monthly account statement for {customer}, covering all invoices and payments for the period.\n\nCurrent balance: {balance}. Let us know if anything looks off.\n\nThe {company} team',
  },
  // ── Quality & feedback ──
  {
    key: K.postService, draftId: 'reminder-post-service', group: 'quality', label: 'First-clean check-in',
    when: 'Emailed after a customer’s first cleaning.',
    channel: 'email', transactional: false, immediate: false, recipient: 'visit',
    subject: 'How did your first clean go?',
    body: "Hi {client_contact},\n\nThanks for letting {company} handle {site_name} today. We hope it went well! We always like to check in after a first visit. Reply with anything we should adjust for the next time, and we'll make sure your crew sees it.\n\nThe {company} team",
  },
  {
    key: K.complaintAck, draftId: 'complaint-ack', group: 'quality', label: 'Complaint acknowledgement',
    when: 'Emailed when a complaint is logged.',
    channel: 'email', transactional: true, immediate: false, recipient: 'customer',
    subject: 'We hear you, and we are on it',
    body: 'Hi {first_name},\n\nThank you for letting us know. We have logged your concern about {site_name}, and it is with our team now.\n\nWe will follow up shortly with next steps. If it is urgent, call us directly at {company_phone}.\n\nThe {company} team',
  },
  {
    key: K.complaintResolution, draftId: 'complaint-resolution', group: 'quality', label: 'Complaint resolution',
    when: 'Emailed when a complaint is resolved (not when the customer hub already told them).',
    channel: 'email', transactional: true, immediate: false, recipient: 'customer',
    subject: 'Here is how we resolved it',
    body: 'Hi {first_name},\n\nFollowing up on the concern you raised, here is what we did: our crew lead reviewed the area and corrected it on the next visit, and we have added a note so the team keeps an eye on it going forward.\n\nPlease let us know if it is fully resolved on your end. Thank you for giving us the chance to make it right.\n\nThe {company} team',
  },
  {
    key: K.satisfactionSurvey, draftId: 'satisfaction-survey', group: 'quality', label: 'Satisfaction survey',
    when: 'Emailed every three months, a short 1–5 rating and a comment.',
    channel: 'email', transactional: false, immediate: false, recipient: 'customer', keepDays: 120,
    subject: 'Two minutes to tell us how we are doing?',
    body: 'Hi {first_name},\n\nWe are always working to give {customer} real oversight, not constant follow-up. Would you take two minutes to tell us how we are doing?\n\nStart the short survey here: {survey_link}. Your feedback goes straight to our operations team.\n\nThe {company} team',
  },
  // ── Retention & account ──
  {
    key: K.renewalNotice, draftId: 'renewal-notice', group: 'account', label: 'Renewal notice',
    when: 'Emailed 60 days before an agreement renews.',
    channel: 'email', transactional: true, immediate: false, recipient: 'customer',
    subject: 'Your {company} agreement is up for renewal',
    body: 'Hi {first_name},\n\nYour service agreement for {customer} is coming up for renewal. We have valued keeping your space clean and would love to continue.\n\nNothing changes on your end unless you would like it to. We will reach out with renewal details shortly, or reply here any time.\n\nThe {company} team',
  },
  {
    key: K.renewalOffer, draftId: 'renewal-offer', group: 'account', label: 'Renewal offer',
    when: 'Emailed 30 days before an agreement renews.',
    channel: 'email', transactional: false, immediate: false, recipient: 'customer',
    subject: 'Let us keep your space covered',
    body: 'Hi {first_name},\n\nAs we renew your {company} agreement, we want to make sure the plan still fits. If your needs have changed, whether that is frequency, scope, or an added location, this is a great time to adjust.\n\nWant to hop on a quick call? Reply here or call {company_phone}.\n\nThe {company} team',
  },
  {
    key: K.upsell, draftId: 'upsell', group: 'account', label: 'Upsell / add services',
    when: 'Emailed once, 90 days after a customer’s service starts.',
    channel: 'email', transactional: false, immediate: false, recipient: 'customer',
    subject: 'A few ways we can do more for you',
    body: 'Hi {first_name},\n\nYour crew is already on site regularly, so a few extras are easy to add: floor stripping and waxing, carpet care, or restroom deep-cleans on a schedule.\n\nIf any of those would help, reply here and we will add them to your plan with clear pricing.\n\nThe {company} team',
  },
  {
    key: K.serviceChange, draftId: 'service-change', group: 'account', label: 'Service-change confirmation',
    when: 'Emailed when an agreement’s frequency, scope or price is changed.',
    channel: 'email', transactional: true, immediate: false, recipient: 'customer',
    subject: 'Your {company} service has been updated',
    body: 'Hi {first_name},\n\nThis confirms the change to your cleaning plan for {site_name}:\n\n{change_summary}\nEffective: {effective_date}\n\nEverything else stays the same. If this does not match what you expected, reply here right away.\n\nThe {company} team',
  },
  {
    key: K.priceIncrease, draftId: 'price-increase', group: 'account', label: 'Price-increase notice',
    when: 'Emailed 30 days before an agreement’s price goes up.',
    channel: 'email', transactional: true, immediate: false, recipient: 'customer',
    subject: 'An update to your {company} pricing',
    body: 'Hi {first_name},\n\nWe want to give you plenty of notice: starting next month, your monthly rate for {site_name} will adjust to reflect rising labor and supply costs. Your service and crew stay exactly the same.\n\nWe have worked to keep the change as small as possible. Happy to walk through the details, just reply or call {company_phone}.\n\nThe {company} team',
  },
  {
    key: K.winBack, draftId: 'win-back', group: 'account', label: 'Win-back',
    when: 'Emailed once, 60 days after a customer’s service ends.',
    channel: 'email', transactional: false, immediate: false, recipient: 'customer',
    subject: 'We would love to have you back',
    body: 'Hi {first_name},\n\nIt has been a while since {company} cleaned {site_name}, and we would love the chance to earn your business again. A lot of clients come back for the oversight. We do not just clean, we make sure it is done right.\n\nIf you are open to it, reply here and we will put together a fresh quote, no pressure.\n\nThe {company} team',
  },
  {
    key: K.offboarding, draftId: 'offboarding', group: 'account', label: 'Offboarding thank-you',
    when: 'Emailed when a customer’s service is ended (the customer is archived).',
    channel: 'email', transactional: true, immediate: false, recipient: 'customer',
    subject: 'Thank you from all of us at {company}',
    body: 'Hi {first_name},\n\nWe have processed the cancellation of your cleaning service for {customer}, effective at the end of your current term. It has been a pleasure keeping your space clean.\n\nIf we can ever help again, the door is always open. Reply here or call {company_phone}.\n\nThe {company} team',
  },
].map((m) => Object.freeze({ built: true, enabledByDefault: true, keepDays: DEFAULT_KEEP_DAYS, needs: [], ...m })));

export const MESSAGE_BY_KEY = Object.freeze(Object.fromEntries(CUSTOMER_MESSAGES.map((m) => [m.key, m])));
export const MESSAGE_BY_DRAFT_ID = Object.freeze(Object.fromEntries(CUSTOMER_MESSAGES.map((m) => [m.draftId, m])));
export const messageOf = (key) => MESSAGE_BY_KEY[key] || null;

// The keys that are nudges, not receipts: they honour the marketing suppression list and carry an
// opt-out line. contactConsent's NON_TRANSACTIONAL_REMINDER_KEYS is built from this.
export const NON_TRANSACTIONAL_MESSAGE_KEYS = Object.freeze(CUSTOMER_MESSAGES.filter((m) => !m.transactional).map((m) => m.key));

// The Settings sections, in order.
export const MESSAGE_GROUPS = Object.freeze([
  { id: 'sales', label: 'Sales' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'visits', label: 'Scheduling & visits' },
  { id: 'billing', label: 'Billing (from QuickBooks)' },
  { id: 'quality', label: 'Quality & feedback' },
  { id: 'account', label: 'Retention & account' },
]);

// The id a template carries in `reminderTemplates`: the five that predate this catalog keep the
// seed's ids (production's stored rows use them); every other one is `rt_<key>`, the same in the
// seed and in the release data-op, so adding it twice is a no-op.
export const LEGACY_TEMPLATE_IDS = Object.freeze({
  welcome_email: 'rt_seed_we',
  booking_confirmation: 'rt_seed_bc',
  reminder_24h: 'rt_seed_r24',
  day_of_eta: 'rt_seed_doe',
  post_service: 'rt_seed_fcr',
});
export const templateIdFor = (key) => LEGACY_TEMPLATE_IDS[key] || `rt_${key}`;

// One stored template, as the seed and the data-op write it.
export function defaultTemplate(m) {
  return {
    id: templateIdFor(m.key),
    key: m.key,
    channel: m.channel,
    subject: m.subject,
    body: m.body,
    enabled: m.enabledByDefault !== false,
  };
}
// Every template a fresh install carries: the messages with a trigger, plus the welcome email
// (kept as text only, off).
export const DEFAULT_REMINDER_TEMPLATES = Object.freeze(
  CUSTOMER_MESSAGES.filter((m) => m.built || m.key === MESSAGE_KEY.welcome).map((m) => Object.freeze(defaultTemplate(m))),
);

// ── the words, filled in ─────────────────────────────────────────────────────
export function interpolate(template, tokens) {
  if (!template) return '';
  return Object.entries(tokens || {}).reduce(
    (out, [k, v]) => out.replaceAll(`{${k}}`, v ?? ''),
    template,
  );
}

// 🔴 THE STOP LINE every text to a customer ends with (Daniel, 2026-10-28: "Yes, add the Reply
// STOP functionality."): the approved A2P campaign's own words, from its sample messages. The one
// send step (api/_lib/customerMessages/send.js) appends it to EVERY customer text at the moment it
// leaves (the three campaign texts and the office's answers texted back), so a template the
// office edits can never lose it and no text can carry it twice. Customer messages are written
// in English (LANG-8), and so is this line; STOP and HELP are the keywords in any language
// (src/lib/texting.js smsKeyword), which is what Twilio's own replies name.
export const SMS_STOP_LINE = 'Reply STOP to opt out or HELP for assistance. Msg & data rates may apply.';
// The app's older one-line opt-out (a non-transactional text's, before 2026-10-28): it gives way
// to the campaign's line, so a stored body that kept it does not carry STOP twice.
const OLD_SMS_STOP_LINE = 'Reply STOP to opt out.';
const squash = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
// A text's body with the STOP line at its end, once. Idempotent: a body that already carries the
// line (however it is spaced) comes back as it was.
export function withSmsStopLine(body) {
  let text = String(body ?? '').replace(/\s+$/, '');
  if (squash(text).includes(squash(SMS_STOP_LINE))) return text;
  if (text.endsWith(OLD_SMS_STOP_LINE)) text = text.slice(0, -OLD_SMS_STOP_LINE.length).replace(/\s+$/, '');
  return text ? `${text}\n${SMS_STOP_LINE}` : SMS_STOP_LINE;
}

// The opt-out line a non-transactional message carries (CAN-SPAM; TCPA for a text). An email's
// names the unsubscribe link (the same signed link and suppression list the marketing emails
// use, api/unsubscribe.js); a text's is the campaign's STOP line (which the send step then keeps
// to one).
export function optOutLine(channel, unsubscribeUrl) {
  if (channel === 'sms') return SMS_STOP_LINE;
  return unsubscribeUrl
    ? `To stop these emails, unsubscribe here: ${unsubscribeUrl}`
    : 'To stop these emails, reply "unsubscribe".';
}

// THE ONE COMPOSER: what a customer receives for a stored template and its tokens. The cron and
// the Drafts preview both call it, so the preview is the message.
//   → { subject, body, missing } — `missing` lists `needs` tokens that came out empty (the caller
//     does not send then).
export function composeMessage(message, template, tokens, { unsubscribeUrl = null } = {}) {
  const m = message || {};
  const subject = interpolate(template?.subject ?? m.subject ?? '', tokens);
  let body = interpolate(template?.body ?? m.body ?? '', tokens);
  if (m.transactional === false) body = `${body}${m.channel === 'sms' ? ' ' : '\n\n'}${optOutLine(m.channel, unsubscribeUrl)}`;
  const missing = (m.needs || []).filter((k) => !String(tokens?.[k] ?? '').trim());
  return { subject, body, missing };
}
