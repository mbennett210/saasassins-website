// Demo catalog: the Core platform and the modules shown on the landing (/polishpoint). DISPLAY data only.
//
// Every module here is in the live demo (Daniel's pick, 2026-11-05: "every module the demo has"), drawn from
// the app's own pages, so each card's features can be clicked into. Keep it in step with the app: when a sync
// from Clean Space (scripts/sync-polishpoint-demo.mjs) adds or retires a page, update its card here.
//
// There is NO pricing here. The demo does not sell modules directly: every commercial CTA points to a call
// ("Book a call"), where scope and cost are worked out for the specific business.
//
//   route   the module's page in the live app (under /polishpoint/demo); the card links straight to it
//   how     how to see it when it's a view rather than a page (the crew's phone app is a role); the card links
//           to the demo's home

export const CORE = {
  id: 'core',
  name: 'Core Platform',
  blurb: 'What every build starts with: the office runs the day, and every role sees its own view.',
  features: [
    'Dashboard with owner, manager, operations and supply views',
    'Schedule: every visit by day and crew',
    'Customers: people, companies and every building',
    'Sales pipeline: deals by stage',
    'Messaging: customers, team channels and direct messages in one inbox',
    'Email from your company mailbox, texts from your own number',
    'Customer messages on a schedule: reminders, receipts and "on my way"',
    'Invoices: billing and payments',
    'Reports to run and export: hours, missed clock-ins, inspections, supply usage',
    'Team, roles and permissions, down to each person',
  ],
};

export const MODULE_CATALOG = [
  {
    id: 'crew',
    name: 'Crew App',
    icon: '📱',
    how: 'In the demo, pick a cleaner from the user menu',
    blurb: 'The phone app your cleaners carry: tonight’s stops, clock in on site, and each visit’s checklist, in their own language.',
    features: [
      'Tonight’s stops and one-tap clock in and out',
      'Clock-in checked against the building’s location',
      'Each visit’s checklist, done on the phone',
      'Scan an area’s QR code',
      'Their hours, requests and supply asks',
      'English, Spanish and Haitian Creole',
    ],
  },
  {
    id: 'time',
    name: 'Time & Attendance',
    icon: '⏱️',
    route: '/check-in',
    blurb: 'See who showed up, approve every hour before payroll, and catch labor that runs over.',
    features: [
      'Shift Check-in: who arrived and who is late',
      'Time Clock: every punch in and out',
      'Hours to approve before payroll, missing time included',
      'Variance: clocked labor against expected, per clean',
      'Cleans that ran over or under, flagged',
    ],
  },
  {
    id: 'payroll-hr',
    name: 'Payroll & HR',
    icon: '👥',
    route: '/payroll',
    blurb: 'Pay runs built from approved hours, and every employee record in one place.',
    features: [
      'Pay runs by period, from approved hours',
      'Close the period and export it',
      'Employees with pay rates and overtime',
      'Special-service pay and reimbursements',
      'PTO tracked for each employee',
      'Warnings, incidents and terminations',
    ],
  },
  {
    id: 'quality',
    name: 'Quality & Client Requests',
    icon: '🔍',
    route: '/inspections',
    blurb: 'Score every building, answer what customers raise on time, and show them the proof.',
    features: [
      'Scored inspections, area by area',
      'Inspection templates you build',
      'Today’s checklist for each visit',
      'Client Requests with response deadlines',
      'A QR code label for every cleaning area',
      'Inspection reports to share with the customer',
    ],
  },
  {
    id: 'hub',
    name: 'Customer Hub',
    icon: '🏢',
    route: '/hub',
    blurb: 'A portal for your customers: their buildings, tonight’s crew, inspections, invoices and requests.',
    features: [
      'Every building they manage under one login',
      'Each visit’s crew check-in, check-out and photos',
      'Checklists and inspection scores',
      'Invoices and documents',
      'Raise a request and follow it to done',
      'Message their account manager',
    ],
  },
  {
    id: 'supplies',
    name: 'Supplies & Deliveries',
    icon: '📦',
    route: '/supplies',
    blurb: 'Approved supply lists for each building, one order queue, and deliveries the driver closes out.',
    features: [
      'An approved supply list for each building',
      'Requests approved one at a time or in bulk',
      'Orders tracked from new to with the supplier to fulfilled',
      'A master supply catalog',
      'Driver deliveries with a Delivered button',
      'Usage and budget by building',
    ],
  },
  {
    id: 'keys',
    name: 'Key Tracking',
    icon: '🔑',
    route: '/keys',
    blurb: 'Every building key: where it opens, who has it, and where it has been.',
    features: [
      'Keys by building and door',
      'Check out to a person, check back in',
      'In, out, unknown and lost at a glance',
      'A history for every key',
    ],
  },
  {
    id: 'contracts',
    name: 'Contracts & Renewals',
    icon: '📑',
    route: '/contracts',
    blurb: 'Every signed agreement with its yearly value, its term, and the reminders that protect the renewal.',
    features: [
      'Signed agreements by customer and manager',
      'Annual value and the total book',
      'Price-change and cancellation-notice reminders',
      'Terms and end dates',
      'Drafts, active and ended',
    ],
  },
  {
    id: 'pnl',
    name: 'Property P&L',
    icon: '📈',
    route: '/pnl',
    blurb: 'Margin for every building, so the accounts below target are the first thing you see.',
    features: [
      'Revenue, past due and margin for each building',
      'Below target, watch and on target',
      'Any date range',
      'The whole book’s margin on the owner’s dashboard',
    ],
  },
  {
    id: 'quotes',
    name: 'Quotes & E-Sign',
    icon: '✍️',
    route: '/quotes',
    blurb: 'Proposals from your own template, signed online and sent to the customer to sign.',
    features: [
      'Quotes from your own template',
      'Sign it and send it for signature',
      'The customer signs online from a link',
      'Draft, sent and signed at a glance',
      'Download the signed copy',
    ],
  },
  {
    id: 'marketing',
    name: 'Email Marketing',
    icon: '📣',
    route: '/marketing',
    blurb: 'Multi-step email sequences sent from your own inboxes, with replies routed to the pipeline.',
    features: [
      'Multi-step email sequences',
      'Sent from your connected inboxes',
      'Every reply in one place',
      'Send windows and daily caps',
      'Replies routed to a pipeline stage',
    ],
  },
];
