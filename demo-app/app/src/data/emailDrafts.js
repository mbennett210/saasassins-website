// The "Drafts" review catalog, every customer- and prospect-facing outbound
// communication, plus the staff invite, for the client to review/approve/note.
// The marketing sequence is deliberately excluded (edited in the Marketing UI).
//
// Each descriptor renders either a REAL template builder (for comms that exist)
// or proposed placeholder copy (for comms not yet wired to send). `buildState`
// tells the client which is which:
//   'live', sends today with this content
//   'off', a real template that is built but currently turned off
//   'draft', proposed copy, not yet wired to send (review the wording now,
//             we build the sending afterward)
// Stable ids come from ./emailDraftIds.js so review state survives catalog edits.
import { buildQuoteEmail, buildSignRequestEmail, buildInviteEmail } from '../lib/email';
import { buildQuoteHtml } from '../lib/quoteTemplate';
import { buildInspectionReportHtml } from '../lib/inspectionReportTemplate';
import { interpolate } from '../lib/reminderScheduler';
import { INITIAL_STATE } from './seed';
import { EMAIL_DRAFT_IDS } from './emailDraftIds';
import { IDENTITY } from '../brand/identity.generated.js';

// ── Representative sample data (illustrative, not a real customer) ──────────
const NAME = IDENTITY.name;
const OWNER = IDENTITY.company.signatory.name;
const SAMPLE = {
  first: 'Jordan',
  contactName: 'Jordan Ellis',
  company: 'Bayside Property Group',
  site: 'Bayside Tower, Suite 400',
  date: 'Friday, Sep 12',
  time: '6:00 PM',
  amount: '$1,160.00',
  invoiceNo: `${IDENTITY.monogram}-1042`,
  phone: IDENTITY.company.phone,
  link: `${IDENTITY.appUrl}/quote/SAMPLE`,
};
const SAMPLE_TOKENS = {
  client_contact: SAMPLE.contactName,
  company: NAME,
  service: 'Janitorial cleaning',
  site_name: SAMPLE.site,
  date: SAMPLE.date,
  time: SAMPLE.time,
};
const SAMPLE_PERFORMED_AT = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
const SAMPLE_INVITE_EXPIRES = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

// Reminder copy comes straight from the seed so the client reviews the real text.
const REMINDERS = Object.fromEntries(
  (INITIAL_STATE.reminderTemplates || []).map((t) => [t.key, t]),
);
const reminder = (key) => () => {
  const t = REMINDERS[key] || { subject: '', body: '' };
  return { subject: interpolate(t.subject, SAMPLE_TOKENS), body: interpolate(t.body, SAMPLE_TOKENS) };
};

// Inline-copy helpers (render fns) for placeholder comms.
const emailRender = (subject, body) => () => ({ subject, body });
const smsRender = (body) => () => ({ body });

const SAMPLE_QUOTE_FIELDS = {
  clientName: SAMPLE.contactName,
  companyName: SAMPLE.company,
  date: '09/12/26',
  amount: '$1,160 / month',
  frequency: 'Weekly',
  dayOfWeek: 'Wednesday',
  restrooms: '4',
};

const SAMPLE_INSPECTION_REPORT = {
  inspection: {
    templateName: 'Monthly Quality Inspection',
    ratingScale: null,
    siteName: SAMPLE.site,
    clientName: SAMPLE.company,
    inspectorName: OWNER,
    overallScore: 92,
    result: 'pass',
    performedAt: SAMPLE_PERFORMED_AT,
    schema: {
      areas: [
        { id: 'a1', label: 'Restrooms', items: [
          { id: 'i1', label: 'Toilets and urinals sanitized' },
          { id: 'i2', label: 'Floors mopped and dry' },
          { id: 'i3', label: 'Supplies restocked' },
        ] },
        { id: 'a2', label: 'Common areas', items: [
          { id: 'i4', label: 'Floors vacuumed' },
          { id: 'i5', label: 'Trash emptied, liners replaced' },
          { id: 'i6', label: 'Entry glass and doors' },
        ] },
        { id: 'a3', label: 'Break room', items: [
          { id: 'i7', label: 'Counters and sink wiped' },
          { id: 'i8', label: 'Appliance exteriors' },
        ] },
      ],
    },
  },
  items: [
    { itemKey: 'i1', rating: 'pass' },
    { itemKey: 'i2', rating: 'pass' },
    { itemKey: 'i3', rating: 'fail', comment: 'Paper towels were low; restocked on site.' },
    { itemKey: 'i4', rating: 'pass' },
    { itemKey: 'i5', rating: 'pass' },
    { itemKey: 'i6', rating: 'pass' },
    { itemKey: 'i7', rating: 'pass' },
    { itemKey: 'i8', rating: 'na' },
  ],
  photos: [],
};

// ── The catalog ─────────────────────────────────────────────────────────────
// kind: 'document' (branded HTML) | 'email' (plain text) | 'sms' (phone bubble).
export const EMAIL_DRAFTS = [
  // ---------- Sales & quotes (prospect) ----------
  {
    id: 'lead-ack', category: 'Sales & quotes', name: 'New-lead acknowledgement', recipient: 'Prospect', kind: 'email', buildState: 'draft',
    trigger: 'Auto-reply the moment a new lead comes in from your website or a webhook.',
    render: emailRender(`Thanks for reaching out to ${NAME}`,
`Hi ${SAMPLE.first},

Thanks for getting in touch with ${NAME}. We have your request, and a member of our team will follow up within one business day to learn about your space and the right next step.

If it is easier to talk now, call us at ${SAMPLE.phone}.

The ${NAME} team`),
  },
  {
    id: 'walkthrough-confirm', category: 'Sales & quotes', name: 'Walkthrough confirmation', recipient: 'Prospect', kind: 'email', buildState: 'draft',
    trigger: 'Sent when a walkthrough is booked with a prospect.',
    render: emailRender(`Your walkthrough with ${NAME} is set`,
`Hi ${SAMPLE.first},

You are on the calendar. We will meet you at ${SAMPLE.site} on ${SAMPLE.date} at ${SAMPLE.time} to walk the space and put together the right cleaning plan.

It takes about 20 minutes. If anything changes, reply here or call ${SAMPLE.phone}.

The ${NAME} team`),
  },
  {
    id: 'quote-doc', category: 'Sales & quotes', name: 'Quote proposal & service agreement', recipient: 'Prospect', kind: 'document', buildState: 'live',
    trigger: 'The proposal and service agreement a prospect opens from their quote link.',
    render: () => ({ subject: `Your ${NAME} cleaning proposal`, html: buildQuoteHtml(SAMPLE_QUOTE_FIELDS, { locked: true }) }),
  },
  {
    id: 'quote-email', category: 'Sales & quotes', name: 'Quote email', recipient: 'Prospect', kind: 'email', buildState: 'live',
    trigger: 'Sent to a prospect with the link to view and pay their quote.',
    render: () => buildQuoteEmail({ title: 'weekly janitorial service', amount: 1160, link: SAMPLE.link, contactName: SAMPLE.contactName }),
  },
  {
    id: 'sign-request', category: 'Sales & quotes', name: 'E-signature request', recipient: 'Prospect', kind: 'email', buildState: 'live',
    trigger: 'Asks a prospect to review and e-sign their service agreement.',
    render: () => buildSignRequestEmail({ contactName: SAMPLE.contactName, companyName: SAMPLE.company, link: SAMPLE.link }),
  },
  {
    id: 'quote-signed-copy', category: 'Sales & quotes', name: 'Signed-agreement copy', recipient: 'Prospect', kind: 'email', buildState: 'draft',
    trigger: 'Sent to the customer right after they e-sign, with a copy for their records.',
    render: emailRender(`Your signed ${NAME} agreement`,
`Hi ${SAMPLE.first},

Thank you. Your service agreement is signed, and a copy is attached for your records.

We will be in touch shortly to schedule your first cleaning and introduce your crew.

The ${NAME} team`),
  },
  {
    id: 'quote-nudge', category: 'Sales & quotes', name: 'Quote follow-up nudge', recipient: 'Prospect', kind: 'email', buildState: 'draft',
    trigger: 'Gentle reminder when a quote has been sent but not signed after a few days.',
    render: emailRender('Still thinking it over?',
`Hi ${SAMPLE.first},

Just following up on the cleaning proposal we sent for ${SAMPLE.company}. It is ready whenever you are, and the pricing holds for 30 days.

Happy to answer questions or adjust the scope. You can review and sign here: ${SAMPLE.link}

The ${NAME} team`),
  },

  // ---------- Onboarding (customer) ----------
  {
    id: 'reminder-welcome', category: 'Onboarding', name: 'Welcome email', recipient: 'Customer', kind: 'email', buildState: 'off',
    trigger: 'Sent to a new customer when their account is set up.',
    render: reminder('welcome_email'),
  },
  {
    id: 'service-setup', category: 'Onboarding', name: 'Service setup confirmation', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Confirms the schedule, crew, and expectations once a new account is live.',
    render: emailRender(`You are all set with ${NAME}`,
`Hi ${SAMPLE.first},

Welcome aboard. Here is your setup at a glance:

Site: ${SAMPLE.site}
Service: Janitorial cleaning, weekly (Wednesdays)
First visit: ${SAMPLE.date}

Your crew lead is ${OWNER}. You will get a reminder before each visit and a quick check-in after. Questions any time at ${SAMPLE.phone}.

The ${NAME} team`),
  },

  // ---------- Scheduling & visits (customer) ----------
  {
    id: 'reminder-booking', category: 'Scheduling & visits', name: 'Booking confirmation', recipient: 'Customer', kind: 'email', buildState: 'off',
    trigger: 'Confirms a cleaning when it is booked.',
    render: reminder('booking_confirmation'),
  },
  {
    id: 'sms-24h', category: 'Scheduling & visits', name: '24-hour reminder', recipient: 'Customer', kind: 'sms', buildState: 'off',
    trigger: 'Text reminder the day before a scheduled clean.',
    render: reminder('reminder_24h'),
  },
  {
    id: 'sms-day-of', category: 'Scheduling & visits', name: 'Day-of reminder', recipient: 'Customer', kind: 'sms', buildState: 'off',
    trigger: 'Text reminder the morning of a scheduled clean.',
    render: reminder('day_of_eta'),
  },
  {
    id: 'on-the-way', category: 'Scheduling & visits', name: 'Crew on the way', recipient: 'Customer', kind: 'sms', buildState: 'draft',
    trigger: 'Text sent when the crew is en route to the site.',
    render: smsRender(`${NAME}: your crew is on the way to ${SAMPLE.site} and will arrive around ${SAMPLE.time}. Reply here with any access notes.`),
  },
  {
    id: 'reschedule', category: 'Scheduling & visits', name: 'Reschedule notice', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent when a scheduled cleaning is moved to a new time.',
    render: emailRender('We have moved your cleaning',
`Hi ${SAMPLE.first},

Your cleaning at ${SAMPLE.site} has been rescheduled to ${SAMPLE.date} at ${SAMPLE.time}. No action needed on your end.

If that time does not work, reply here or call ${SAMPLE.phone} and we will find a better window.

The ${NAME} team`),
  },
  {
    id: 'cancellation', category: 'Scheduling & visits', name: 'Cancellation notice', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent when a scheduled cleaning is cancelled.',
    render: emailRender('Your cleaning has been cancelled',
`Hi ${SAMPLE.first},

We have cancelled the cleaning scheduled for ${SAMPLE.site} on ${SAMPLE.date}. If this was a mistake or you would like to rebook, let us know and we will get it back on the calendar.

The ${NAME} team`),
  },
  {
    id: 'visit-summary', category: 'Scheduling & visits', name: 'Visit-completed summary', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent after a visit is completed, summarizing what was done.',
    render: emailRender('Your space was cleaned today',
`Hi ${SAMPLE.first},

Your crew completed today's cleaning at ${SAMPLE.site}. Everything on the checklist was covered, and your crew lead noted the space is in good shape.

If anything needs a second look, reply here and we will take care of it right away.

The ${NAME} team`),
  },
  {
    id: 'missed-visit', category: 'Scheduling & visits', name: 'Missed-visit apology', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent when a scheduled visit is missed, to apologize and reschedule.',
    render: emailRender('We missed today, and we are on it',
`Hi ${SAMPLE.first},

We are sorry. Our crew was not able to complete today's scheduled cleaning at ${SAMPLE.site}. That is not our standard, and we want to make it right.

We would like to reschedule at the earliest time that works for you. Reply here or call ${SAMPLE.phone}.

The ${NAME} team`),
  },

  // ---------- Billing & payments (customer) ----------
  {
    id: 'invoice-sent', category: 'Billing & payments', name: 'Invoice sent', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Emails the customer their invoice with a pay link when it is issued.',
    render: emailRender(`Invoice ${SAMPLE.invoiceNo} from ${NAME}`,
`Hi ${SAMPLE.first},

Your invoice for cleaning services is ready.

Invoice: ${SAMPLE.invoiceNo}
Amount due: ${SAMPLE.amount}
Terms: Net 30

You can view and pay it here: ${SAMPLE.link}. Questions about the invoice? Just reply.

The ${NAME} team`),
  },
  {
    id: 'upcoming-due', category: 'Billing & payments', name: 'Upcoming-due reminder', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'A friendly reminder a week before an invoice is due (Net-30).',
    render: emailRender(`Invoice ${SAMPLE.invoiceNo} is due soon`,
`Hi ${SAMPLE.first},

A friendly reminder that invoice ${SAMPLE.invoiceNo} for ${SAMPLE.amount} is due in 7 days under your Net-30 terms.

You can pay online here: ${SAMPLE.link}. If you have already sent payment, thank you, and please disregard.

The ${NAME} team`),
  },
  {
    id: 'payment-receipt', category: 'Billing & payments', name: 'Payment receipt', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent automatically when a payment is recorded.',
    render: emailRender('Payment received, thank you',
`Hi ${SAMPLE.first},

We have received your payment of ${SAMPLE.amount} toward invoice ${SAMPLE.invoiceNo}. This email is your receipt.

Thank you for your business. We appreciate you.

The ${NAME} team`),
  },
  {
    id: 'past-due', category: 'Billing & payments', name: 'Past-due notice', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent when an invoice passes its due date.',
    render: emailRender(`Invoice ${SAMPLE.invoiceNo} is now past due`,
`Hi ${SAMPLE.first},

Our records show invoice ${SAMPLE.invoiceNo} for ${SAMPLE.amount} is now past due. If payment is already on its way, thank you.

If you would like to sort out payment or have any questions, reply here or call ${SAMPLE.phone} and we will be glad to help.

The ${NAME} team`),
  },
  {
    id: 'payment-reminder-sms', category: 'Billing & payments', name: 'Payment reminder (text)', recipient: 'Customer', kind: 'sms', buildState: 'draft',
    trigger: 'A short text reminder for an outstanding invoice.',
    render: smsRender(`${NAME}: a friendly reminder that invoice ${SAMPLE.invoiceNo} (${SAMPLE.amount}) is due. Pay here: ${SAMPLE.link}. Reply with any questions.`),
  },
  {
    id: 'failed-payment', category: 'Billing & payments', name: 'Failed payment', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent when an automatic payment is declined.',
    render: emailRender('Your payment did not go through',
`Hi ${SAMPLE.first},

We tried to process your payment of ${SAMPLE.amount} for invoice ${SAMPLE.invoiceNo}, but it did not go through. No action has been taken on your account.

You can update your payment details and try again here: ${SAMPLE.link}. Need a hand? Call ${SAMPLE.phone}.

The ${NAME} team`),
  },
  {
    id: 'statement', category: 'Billing & payments', name: 'Monthly statement', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'A monthly account statement of invoices and payments.',
    render: emailRender(`Your ${NAME} statement`,
`Hi ${SAMPLE.first},

Attached is your monthly account statement for ${SAMPLE.company}, covering all invoices and payments for the period.

Current balance: ${SAMPLE.amount}. Let us know if anything looks off.

The ${NAME} team`),
  },

  // ---------- Quality & feedback (customer) ----------
  {
    id: 'inspection-report', category: 'Quality & feedback', name: 'Quality inspection report', recipient: 'Customer', kind: 'document', buildState: 'live',
    trigger: 'The scored quality inspection shared with a customer after a visit.',
    render: () => ({ subject: `Your ${NAME} quality inspection`, html: buildInspectionReportHtml(SAMPLE_INSPECTION_REPORT) }),
  },
  {
    id: 'reminder-post-service', category: 'Quality & feedback', name: 'Post-service check-in', recipient: 'Customer', kind: 'email', buildState: 'off',
    trigger: 'Checks in with a customer after their first clean.',
    render: reminder('post_service'),
  },
  {
    id: 'review-request', category: 'Quality & feedback', name: 'Review request', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Asks a happy customer for a Google review after a good visit.',
    render: emailRender('How are we doing?',
`Hi ${SAMPLE.first},

We hope ${NAME} has been keeping ${SAMPLE.site} looking its best. If you have been happy with the service, a quick Google review would mean a lot and helps other local businesses find us.

It takes about a minute: ${SAMPLE.link}. And if anything has fallen short, please tell us first so we can fix it.

The ${NAME} team`),
  },
  {
    id: 'review-request-sms', category: 'Quality & feedback', name: 'Review request (text)', recipient: 'Customer', kind: 'sms', buildState: 'draft',
    trigger: 'A short text asking a happy customer for a review.',
    render: smsRender(`${NAME}: hope your space is looking great! If you have a minute, we would love a quick Google review: ${SAMPLE.link}. Thank you!`),
  },
  {
    id: 'complaint-ack', category: 'Quality & feedback', name: 'Complaint acknowledgement', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent as soon as a customer complaint is logged.',
    render: emailRender('We hear you, and we are on it',
`Hi ${SAMPLE.first},

Thank you for letting us know. We have logged your concern about ${SAMPLE.site}, and it is with our team now.

We will follow up shortly with next steps. If it is urgent, call us directly at ${SAMPLE.phone}.

The ${NAME} team`),
  },
  {
    id: 'complaint-resolution', category: 'Quality & feedback', name: 'Complaint resolution', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent when a complaint is resolved, describing what was done.',
    render: emailRender('Here is how we resolved it',
`Hi ${SAMPLE.first},

Following up on the concern you raised, here is what we did: our crew lead reviewed the area and corrected it on the next visit, and we have added a note so the team keeps an eye on it going forward.

Please let us know if it is fully resolved on your end. Thank you for giving us the chance to make it right.

The ${NAME} team`),
  },
  {
    id: 'satisfaction-survey', category: 'Quality & feedback', name: 'Satisfaction survey', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'A periodic short survey to gauge satisfaction.',
    render: emailRender('Two minutes to tell us how we are doing?',
`Hi ${SAMPLE.first},

We are always working to give ${SAMPLE.company} real oversight, not constant follow-up. Would you take two minutes to tell us how we are doing?

Start the short survey here: ${SAMPLE.link}. Your feedback goes straight to our operations team.

The ${NAME} team`),
  },

  // ---------- Retention & account (customer) ----------
  {
    id: 'renewal-notice', category: 'Retention & account', name: 'Renewal notice', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Sent when a service agreement is approaching renewal.',
    render: emailRender(`Your ${NAME} agreement is up for renewal`,
`Hi ${SAMPLE.first},

Your service agreement for ${SAMPLE.company} is coming up for renewal. We have valued keeping your space clean and would love to continue.

Nothing changes on your end unless you would like it to. We will reach out with renewal details shortly, or reply here any time.

The ${NAME} team`),
  },
  {
    id: 'renewal-offer', category: 'Retention & account', name: 'Renewal offer', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Renewal outreach that checks whether the plan still fits.',
    render: emailRender('Let us keep your space covered',
`Hi ${SAMPLE.first},

As we renew your ${NAME} agreement, we want to make sure the plan still fits. If your needs have changed, whether that is frequency, scope, or an added location, this is a great time to adjust.

Want to hop on a quick call? Reply here or call ${SAMPLE.phone}.

The ${NAME} team`),
  },
  {
    id: 'upsell', category: 'Retention & account', name: 'Upsell / add services', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Offers additional services to an existing customer.',
    render: emailRender('A few ways we can do more for you',
`Hi ${SAMPLE.first},

Your crew is already on site regularly, so a few extras are easy to add: floor stripping and waxing, carpet care, or restroom deep-cleans on a schedule.

If any of those would help, reply here and we will add them to your plan with clear pricing.

The ${NAME} team`),
  },
  {
    id: 'service-change', category: 'Retention & account', name: 'Service-change confirmation', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Confirms a change to frequency, scope, or pricing on an account.',
    render: emailRender(`Your ${NAME} service has been updated`,
`Hi ${SAMPLE.first},

This confirms the change to your cleaning plan for ${SAMPLE.site}:

New schedule: twice weekly (Tuesdays and Fridays)
Effective: ${SAMPLE.date}

Everything else stays the same. If this does not match what you expected, reply here right away.

The ${NAME} team`),
  },
  {
    id: 'price-increase', category: 'Retention & account', name: 'Price-increase notice', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Advance notice of a rate change.',
    render: emailRender(`An update to your ${NAME} pricing`,
`Hi ${SAMPLE.first},

We want to give you plenty of notice: starting next month, your monthly rate for ${SAMPLE.site} will adjust to reflect rising labor and supply costs. Your service and crew stay exactly the same.

We have worked to keep the change as small as possible. Happy to walk through the details, just reply or call ${SAMPLE.phone}.

The ${NAME} team`),
  },
  {
    id: 'win-back', category: 'Retention & account', name: 'Win-back', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Re-engages a customer who has gone inactive.',
    render: emailRender('We would love to have you back',
`Hi ${SAMPLE.first},

It has been a while since ${NAME} cleaned ${SAMPLE.site}, and we would love the chance to earn your business again. A lot of clients come back for the oversight. We do not just clean, we make sure it is done right.

If you are open to it, reply here and we will put together a fresh quote, no pressure.

The ${NAME} team`),
  },
  {
    id: 'offboarding', category: 'Retention & account', name: 'Offboarding thank-you', recipient: 'Customer', kind: 'email', buildState: 'draft',
    trigger: 'Acknowledges a cancellation and thanks the customer.',
    render: emailRender(`Thank you from all of us at ${NAME}`,
`Hi ${SAMPLE.first},

We have processed the cancellation of your cleaning service for ${SAMPLE.company}, effective at the end of your current term. It has been a pleasure keeping your space clean.

If we can ever help again, the door is always open. Reply here or call ${SAMPLE.phone}.

The ${NAME} team`),
  },

  // ---------- Staff ----------
  {
    id: 'team-invite', category: 'Staff', name: 'Team invitation', recipient: 'Staff', kind: 'email', buildState: 'live',
    trigger: `Invites a new team member to join the ${NAME} workspace.`,
    render: () => buildInviteEmail({ inviteeName: 'Alex Rivera', inviterName: IDENTITY.company.signatory.name, companyName: NAME, roleLabel: 'Cleaner', token: 'SAMPLE', expiresAt: SAMPLE_INVITE_EXPIRES }),
  },
];

// Guard: the catalog and the lightweight id list must stay in lockstep (the
// Sidebar counts pending drafts from the id list, the page renders the catalog).
if (import.meta.env?.DEV) {
  const catalogIds = EMAIL_DRAFTS.map((d) => d.id).join(',');
  if (catalogIds !== EMAIL_DRAFT_IDS.join(',')) {
    // eslint-disable-next-line no-console
    console.error('[emailDrafts] EMAIL_DRAFTS ids drifted from EMAIL_DRAFT_IDS', catalogIds, EMAIL_DRAFT_IDS);
  }
}
