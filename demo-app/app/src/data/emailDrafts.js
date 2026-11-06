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
//   'quickbooks', QuickBooks sends it, not the app (Matt's notes, 2026-09-30)
// Stable ids come from ./emailDraftIds.js so review state survives catalog edits.
//
// 🔴 The customer messages (Matt's approved messages, 2026-10-19) render from THE catalog,
// lib/customerMessages.js, through its one composer (composeMessage) — the same text and the same
// composer the reminders cron sends with, so this preview IS the message (opt-out line included).
//
// The sign-in emails (src/lib/signInEmail.js) and the customer-hub emails (src/lib/clientHubEmails.js)
// are the SERVER's own builders, shared so this preview is the email the routes send (2026-10-20).
// Retired drafts (quote-email, team-invite, the review requests, and the four quote drafts of
// 2026-10-23) keep their ids in the frozen manifest (reviewManifest.json retiredDrafts).
import { buildInspectionReportHtml } from '../lib/inspectionReportTemplate';
import { MESSAGE_BY_DRAFT_ID, composeMessage } from '../lib/customerMessages.js';
import { setPasswordEmail } from '../lib/signInEmail.js';
import {
  hubTicketStatusEmail, hubTicketReplyEmail, hubInspectionEmail, hubMessageReplyEmail,
  hubAppLink, hubTicketPath, hubInspectionPath, hubMessagesPath,
} from '../lib/clientHubEmails.js';
import { woClientStage } from '../lib/workOrders.js';
import { resultLabel } from '../lib/inspections.js';
import { hubPersonName } from '../lib/clientHub.js';
import { EMAIL_DRAFT_IDS } from './emailDraftIds';
import { IDENTITY } from '../brand/identity.generated.js';
import { DOC } from '../brand/doc.js';

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
// Every token the customer messages use (lib/customerMessages.js header), filled with the sample.
export const SAMPLE_TOKENS = Object.freeze({
  client_contact: SAMPLE.contactName,
  first_name: SAMPLE.first,
  customer: SAMPLE.company,
  company: NAME,
  company_phone: SAMPLE.phone,
  service: 'Janitorial cleaning',
  schedule: 'weekly (Wednesdays)',
  first_visit: SAMPLE.date,
  crew_lead: OWNER,
  site_name: SAMPLE.site,
  date: SAMPLE.date,
  time: SAMPLE.time,
  invoice_number: SAMPLE.invoiceNo,
  amount: SAMPLE.amount,
  balance: SAMPLE.amount,
  pay_link: SAMPLE.link,
  survey_link: SAMPLE.link,
  change_summary: 'New schedule: twice weekly (Tuesdays and Fridays)',
  effective_date: SAMPLE.date,
});
const SAMPLE_UNSUBSCRIBE = `${IDENTITY.appUrl}/api/unsubscribe?t=SAMPLE`;
const SAMPLE_PERFORMED_AT = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
// The set-password link the sign-in emails carry (a one-time recovery link to the app's /login).
export const SAMPLE_SIGN_IN_LINK = `${IDENTITY.appUrl}/login#SAMPLE`;
// What api/_lib/clientHub/notify.js hands the customer-hub builders, filled with the sample: the
// building is the customer's name, a request's stage the client's own words (WO-8), a person is
// first name + last initial, a link the hub page on the app's address.
export const SAMPLE_HUB = Object.freeze({
  brandName: NAME,
  buildingName: SAMPLE.company,
  ticketTitle: 'Soap dispenser empty in the 2nd-floor restroom',
  stageLabel: woClientStage('in_progress').label,
  author: hubPersonName(OWNER),
  replyBody: 'Thanks for flagging this. Tonight’s crew will refill it and check the other floors.',
  messageBody: `Your crew will arrive at ${SAMPLE.time} on ${SAMPLE.date} this week, an hour earlier than usual.`,
  inspectionName: 'Monthly Quality Inspection',
  resultLabel: resultLabel('pass'),
  score: 92,
  ticketLink: hubAppLink(IDENTITY.appUrl, hubTicketPath('SAMPLE', 'SAMPLE')),
  inspectionLink: hubAppLink(IDENTITY.appUrl, hubInspectionPath('SAMPLE', 'SAMPLE')),
  messagesLink: hubAppLink(IDENTITY.appUrl, hubMessagesPath('SAMPLE')),
});
const hubMail = (m) => ({ subject: m.subject, html: m.html });

// A sample photo for the inspection report preview (Matt's note: "Where will the pictures go?"):
// a placeholder picture drawn in the document palette, labelled, so the preview shows WHERE a
// report's photos sit — never a real customer's photo.
const samplePhoto = (label) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220">`
    + `<rect width="320" height="220" fill="${DOC.wash}"/>`
    + `<rect x="12" y="12" width="296" height="196" fill="none" stroke="${DOC.divider}" stroke-width="2" stroke-dasharray="6 6"/>`
    + `<circle cx="160" cy="92" r="26" fill="none" stroke="${DOC.muted}" stroke-width="3"/>`
    + `<rect x="128" y="70" width="64" height="44" rx="6" fill="none" stroke="${DOC.muted}" stroke-width="3"/>`
    + `<text x="160" y="160" font-family="Arial, sans-serif" font-size="15" fill="${DOC.muted}" text-anchor="middle">${label}</text>`
    + '</svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

// A customer message, as it is sent: its catalog text through the cron's own composer.
const fromCatalog = (draftId) => () => {
  const m = MESSAGE_BY_DRAFT_ID[draftId];
  const { subject, body } = composeMessage(m, null, SAMPLE_TOKENS, { unsubscribeUrl: SAMPLE_UNSUBSCRIBE });
  return m.channel === 'sms' ? { body } : { subject, body };
};

// Inline-copy helpers (render fns) for placeholder comms.
const emailRender = (subject, body) => () => ({ subject, body });

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
  // Under each area, a Before and an After (captioned); the rest under "Additional photos".
  photos: [
    { id: 'p1', kind: 'image', areaId: 'a1', caption: 'Before: restroom sinks', url: samplePhoto('Restrooms, before') },
    { id: 'p2', kind: 'image', areaId: 'a1', caption: 'After: restroom sinks', url: samplePhoto('Restrooms, after') },
    { id: 'p3', kind: 'image', areaId: 'a2', caption: 'Before: lobby carpet', url: samplePhoto('Common areas, before') },
    { id: 'p4', kind: 'image', areaId: 'a2', caption: 'After: lobby carpet', url: samplePhoto('Common areas, after') },
    { id: 'p5', kind: 'image', areaId: 'a3', caption: 'Before: break room counters', url: samplePhoto('Break room, before') },
    { id: 'p6', kind: 'image', areaId: 'a3', caption: 'After: break room counters', url: samplePhoto('Break room, after') },
    { id: 'p7', kind: 'image', areaId: null, caption: 'Loading dock entrance', url: samplePhoto('Additional photo') },
    { id: 'p8', kind: 'image', areaId: null, caption: 'Parking garage stairwell', url: samplePhoto('Additional photo') },
  ],
};

// ── The catalog ─────────────────────────────────────────────────────────────
// kind: 'document' (branded HTML) | 'email' (plain text) | 'sms' (phone bubble).
export const EMAIL_DRAFTS = [
  // ---------- Sales & quotes (prospect) ----------
  {
    id: 'lead-ack', category: 'Sales & quotes', name: 'New-lead acknowledgement', recipient: 'Prospect', kind: 'email', buildState: 'live',
    trigger: 'Auto-reply the moment a new lead comes in from your website or a webhook.',
    render: fromCatalog('lead-ack'),
  },
  {
    id: 'walkthrough-confirm', category: 'Sales & quotes', name: 'Walkthrough confirmation', recipient: 'Prospect', kind: 'email', buildState: 'live',
    trigger: 'Sent when a deal’s walkthrough date and time is set, and again if it changes.',
    render: fromCatalog('walkthrough-confirm'),
  },
  // (quote-doc, sign-request, quote-signed-copy, quote-nudge: retired 2026-10-23 with the Quotes page,
  // which Matt keeps in PandaDoc; reviewManifest.json retiredDrafts.)

  // ---------- Onboarding (customer) ----------
  {
    id: 'reminder-welcome', category: 'Onboarding', name: 'Welcome email', recipient: 'Customer', kind: 'email', buildState: 'off',
    trigger: 'Sent to a new customer when their account is set up.',
    render: fromCatalog('reminder-welcome'),
  },
  {
    id: 'service-setup', category: 'Onboarding', name: 'Service setup confirmation', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Confirms the schedule, crew, and expectations once a new account is live.',
    render: fromCatalog('service-setup'),
  },

  // ---------- Scheduling & visits (customer) ----------
  {
    id: 'reminder-booking', category: 'Scheduling & visits', name: 'Booking confirmation', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Confirms a cleaning when it is booked.',
    render: fromCatalog('reminder-booking'),
  },
  {
    id: 'sms-24h', category: 'Scheduling & visits', name: '24-hour reminder', recipient: 'Customer', kind: 'sms', buildState: 'live',
    trigger: 'Text reminder the day before a scheduled clean.',
    render: fromCatalog('sms-24h'),
  },
  {
    id: 'sms-day-of', category: 'Scheduling & visits', name: 'Day-of reminder', recipient: 'Customer', kind: 'sms', buildState: 'live',
    trigger: 'Text reminder the morning of a scheduled clean.',
    render: fromCatalog('sms-day-of'),
  },
  {
    id: 'on-the-way', category: 'Scheduling & visits', name: 'Crew on the way', recipient: 'Customer', kind: 'sms', buildState: 'live',
    trigger: 'Text sent when the crew is en route to the site.',
    render: fromCatalog('on-the-way'),
  },
  {
    id: 'reschedule', category: 'Scheduling & visits', name: 'Reschedule notice', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Sent when a scheduled cleaning is moved to a new time.',
    render: fromCatalog('reschedule'),
  },
  {
    id: 'cancellation', category: 'Scheduling & visits', name: 'Cancellation notice', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Sent when a scheduled cleaning is cancelled.',
    render: fromCatalog('cancellation'),
  },
  {
    id: 'visit-summary', category: 'Scheduling & visits', name: 'Visit-completed summary', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Sent after a visit is completed, summarizing what was done.',
    render: fromCatalog('visit-summary'),
  },
  {
    id: 'missed-visit', category: 'Scheduling & visits', name: 'Missed-visit apology', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Sent when a scheduled visit is missed, to apologize and reschedule.',
    render: fromCatalog('missed-visit'),
  },

  // ---------- Billing & payments (customer) ----------
  {
    id: 'invoice-sent', category: 'Billing & payments', name: 'Invoice sent', recipient: 'Customer', kind: 'email', buildState: 'quickbooks',
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
    id: 'upcoming-due', category: 'Billing & payments', name: 'Upcoming-due reminder', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'A friendly reminder a week before an invoice is due (Net-30).',
    render: fromCatalog('upcoming-due'),
  },
  {
    id: 'payment-receipt', category: 'Billing & payments', name: 'Payment receipt', recipient: 'Customer', kind: 'email', buildState: 'quickbooks',
    trigger: 'Sent automatically when a payment is recorded.',
    render: emailRender('Payment received, thank you',
`Hi ${SAMPLE.first},

We have received your payment of ${SAMPLE.amount} toward invoice ${SAMPLE.invoiceNo}. This email is your receipt.

Thank you for your business. We appreciate you.

The ${NAME} team`),
  },
  {
    id: 'past-due', category: 'Billing & payments', name: 'Past-due notice', recipient: 'Customer', kind: 'email', buildState: 'quickbooks',
    trigger: 'Sent when an invoice passes its due date.',
    render: emailRender(`Invoice ${SAMPLE.invoiceNo} is now past due`,
`Hi ${SAMPLE.first},

Our records show invoice ${SAMPLE.invoiceNo} for ${SAMPLE.amount} is now past due. If payment is already on its way, thank you.

If you would like to sort out payment or have any questions, reply here or call ${SAMPLE.phone} and we will be glad to help.

The ${NAME} team`),
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
    id: 'statement', category: 'Billing & payments', name: 'Monthly statement', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'A monthly account statement of invoices and payments.',
    render: fromCatalog('statement'),
  },

  // ---------- Quality & feedback (customer) ----------
  {
    id: 'inspection-report', category: 'Quality & feedback', name: 'Quality inspection report', recipient: 'Customer', kind: 'document', buildState: 'live',
    trigger: 'The scored quality inspection shared with a customer after a visit.',
    render: () => ({ subject: `Your ${NAME} quality inspection`, html: buildInspectionReportHtml(SAMPLE_INSPECTION_REPORT) }),
  },
  {
    id: 'reminder-post-service', category: 'Quality & feedback', name: 'Post-service check-in', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Checks in with a customer after their first clean.',
    render: fromCatalog('reminder-post-service'),
  },
  {
    id: 'complaint-ack', category: 'Quality & feedback', name: 'Complaint acknowledgement', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Sent as soon as a customer complaint is logged.',
    render: fromCatalog('complaint-ack'),
  },
  {
    id: 'complaint-resolution', category: 'Quality & feedback', name: 'Complaint resolution', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Sent when a complaint is resolved, describing what was done.',
    render: fromCatalog('complaint-resolution'),
  },
  {
    id: 'satisfaction-survey', category: 'Quality & feedback', name: 'Satisfaction survey', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'A periodic short survey to gauge satisfaction.',
    render: fromCatalog('satisfaction-survey'),
  },

  // ---------- Retention & account (customer) ----------
  {
    id: 'renewal-notice', category: 'Retention & account', name: 'Renewal notice', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Sent when a service agreement is approaching renewal.',
    render: fromCatalog('renewal-notice'),
  },
  {
    id: 'renewal-offer', category: 'Retention & account', name: 'Renewal offer', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Renewal outreach that checks whether the plan still fits.',
    render: fromCatalog('renewal-offer'),
  },
  {
    id: 'upsell', category: 'Retention & account', name: 'Upsell / add services', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Offers additional services to an existing customer.',
    render: fromCatalog('upsell'),
  },
  {
    id: 'service-change', category: 'Retention & account', name: 'Service-change confirmation', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Confirms a change to frequency, scope, or pricing on an account.',
    render: fromCatalog('service-change'),
  },
  {
    id: 'price-increase', category: 'Retention & account', name: 'Price-increase notice', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Advance notice of a rate change.',
    render: fromCatalog('price-increase'),
  },
  {
    id: 'win-back', category: 'Retention & account', name: 'Win-back', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Re-engages a customer who has gone inactive.',
    render: fromCatalog('win-back'),
  },
  {
    id: 'offboarding', category: 'Retention & account', name: 'Offboarding thank-you', recipient: 'Customer', kind: 'email', buildState: 'live',
    trigger: 'Acknowledges a cancellation and thanks the customer.',
    render: fromCatalog('offboarding'),
  },

  // ---------- Customer hub (a customer's hub login; api/_lib/clientHub/notify.js sends them) ----------
  {
    id: 'hub-request-update', category: 'Customer hub', name: 'Request update', recipient: 'Customer hub login', kind: 'email', buildState: 'live',
    trigger: 'Sent when a request the customer raised in the hub moves to a new stage (they can switch these off in the hub).',
    render: () => hubMail(hubTicketStatusEmail({ brandName: SAMPLE_HUB.brandName, buildingName: SAMPLE_HUB.buildingName, ticketTitle: SAMPLE_HUB.ticketTitle, stageLabel: SAMPLE_HUB.stageLabel, link: SAMPLE_HUB.ticketLink })),
  },
  {
    id: 'hub-request-reply', category: 'Customer hub', name: 'Reply on a request', recipient: 'Customer hub login', kind: 'email', buildState: 'live',
    trigger: 'Sent when the office replies on a request the customer raised (never an internal note).',
    render: () => hubMail(hubTicketReplyEmail({ brandName: SAMPLE_HUB.brandName, buildingName: SAMPLE_HUB.buildingName, ticketTitle: SAMPLE_HUB.ticketTitle, author: SAMPLE_HUB.author, replyBody: SAMPLE_HUB.replyBody, link: SAMPLE_HUB.ticketLink })),
  },
  {
    id: 'hub-inspection-posted', category: 'Customer hub', name: 'New inspection posted', recipient: 'Customer hub login', kind: 'email', buildState: 'live',
    trigger: 'Sent when a new inspection is posted for a building the customer can see.',
    render: () => hubMail(hubInspectionEmail({ brandName: SAMPLE_HUB.brandName, buildingName: SAMPLE_HUB.buildingName, inspectionName: SAMPLE_HUB.inspectionName, resultLabel: SAMPLE_HUB.resultLabel, score: SAMPLE_HUB.score, link: SAMPLE_HUB.inspectionLink })),
  },
  {
    id: 'hub-office-message', category: 'Customer hub', name: 'New message from the office', recipient: 'Customer hub login', kind: 'email', buildState: 'live',
    trigger: 'Sent when the office writes in a building’s Messages in the hub.',
    render: () => hubMail(hubMessageReplyEmail({ brandName: SAMPLE_HUB.brandName, buildingName: SAMPLE_HUB.buildingName, author: SAMPLE_HUB.author, replyBody: SAMPLE_HUB.messageBody, link: SAMPLE_HUB.messagesLink })),
  },

  // ---------- Staff and sign-in (the software's own sign-in emails; api/_lib/users.js sends them) ----------
  // The account-setup email takes the place of the old "Team invitation" (RETIRED 2026-10-20: a
  // demo-only invite staff never get), under a NEW id so no earlier acceptance carries over.
  {
    id: 'account-setup', category: 'Staff and sign-in', name: setPasswordEmail(SAMPLE_SIGN_IN_LINK, 'invite').subject, recipient: 'Team member or customer hub login', kind: 'email', buildState: 'live',
    trigger: 'Sent when a team member is added, or a customer is given a hub login: the link to set a password and sign in.',
    render: () => setPasswordEmail(SAMPLE_SIGN_IN_LINK, 'invite'),
  },
  {
    id: 'password-reset', category: 'Staff and sign-in', name: setPasswordEmail(SAMPLE_SIGN_IN_LINK, 'reset').subject, recipient: 'Team member or customer hub login', kind: 'email', buildState: 'live',
    trigger: 'Sent when someone asks to reset their password (Forgot password, or the office resets it).',
    render: () => setPasswordEmail(SAMPLE_SIGN_IN_LINK, 'reset'),
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
