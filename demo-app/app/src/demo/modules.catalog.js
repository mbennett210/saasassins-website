// Demo catalog — the single source of truth for the demo's commercial packaging:
// the Core platform plus every sellable add-on shown in the demo.
//
// DISPLAY data only (name, copy, the price shown to the user). The Stripe price
// mapping that actually charges the card lives SERVER-SIDE in api/_modules.js, so
// a tampered client can never set its own price — keep the two in sync.
//
// Prices are the agreed pricing-sheet figures — the MIDPOINT of each quoted range
// (one-time, USD). Modules with `route` have a live page in the app; the rest are
// paywall-gated add-ons (an info dialog + add-to-cart, no clickable feature page
// yet) sold to be built/configured per client. Either way they're purchasable.
//
//   tier        'core' (the always-included base) vs 'addon' (à la carte).
//   route       set when the module has a live page in the app (Marketing); the
//               nav links straight to it. Page-less add-ons open an info dialog.
//   navLabel    short label for the sidebar (the full `name` is too long there).
//   placements  where a module's in-context "Add to cart" CTA appears inside the
//               live app (consumed by components/ModuleCTA on the feature pages).
//
// Extend this list as new add-ons ship; everything downstream (sidebar, landing,
// cart, checkout) is driven off it.

// The Core platform — included in every plan and charged as the base line item at
// checkout (see api/_modules.js, which always adds it to the Stripe session).
export const CORE = {
  id: 'core',
  name: 'Core Platform',
  tier: 'core',
  price: 2000,
  blurb: 'The full operations suite every plan starts with.',
  features: [
    'Operations Dashboard',
    'Scheduling & Calendar',
    'Client Database (Contacts + Accounts)',
    'Sales Pipeline',
    'Messaging Suite',
    'Invoice & Payment logging',
    'Automated Reminders',
    'Team, Roles & Permissions',
  ],
};

export const MODULE_CATALOG = [
  {
    id: 'marketing',
    name: 'Email Marketing',
    navLabel: 'Email Marketing',
    icon: '📣',
    category: 'Growth',
    tier: 'addon',
    price: 2000,
    route: '/marketing', // has a live page in the app — nav links straight to it
    blurb: 'Multi-step email outreach with shared rotation inboxes, domain/inbox warmup, and AI-routed replies.',
    longDescription:
      'Turn outbound into a system. Build multi-step email sequences that send from company-shared rotation inboxes — with full domain/inbox/DNS warmup standup — auto-route inbound replies to the right pipeline stage, and track every contact’s enrollment, all inside PolishPoint.',
    features: [
      'Multi-step email sequences',
      'Company-shared rotation inboxes',
      'Domain / inbox / DNS warmup standup',
      'AI-routed inbound replies',
      'Per-contact enrollments',
      'Send-window + daily-cap controls',
    ],
    placements: [],
    featured: true,
  },
  {
    id: 'ipr',
    name: 'Invoicing + Quoting',
    navLabel: 'Invoicing + Quoting',
    icon: '💳',
    category: 'Billing & Payments',
    tier: 'addon',
    price: 1500,
    blurb: 'Quotes that convert to invoices, customizable templates, automated reminders, and online card payments.',
    longDescription:
      'Turn the Core invoice log into a full billing engine. Send branded quotes that convert to invoices in a click, take card payments online, chase overdue balances automatically, and bill recurring jobs on a schedule.',
    features: [
      'Quote builder → one-click convert to invoice',
      'Customizable invoice & quote templates',
      'Online card payments via Stripe Connect',
      'Automated overdue-invoice reminders',
      'Recurring / subscription billing',
      'Tipping at checkout',
    ],
    placements: ['invoices', 'integrations'],
    featured: true,
  },
  {
    id: 'forms',
    name: 'Forms / Lead Capture',
    navLabel: 'Forms',
    icon: '📝',
    category: 'Growth',
    tier: 'addon',
    price: 750,
    blurb: 'Drag-and-drop form builder with submissions, analytics, and webhooks that feed straight into your CRM.',
    longDescription:
      'Capture leads from anywhere. Build branded forms with a drag-and-drop editor, embed them on your site, and route every submission straight into the CRM — with submission analytics and webhooks to wire into the rest of your stack.',
    features: [
      'Drag-and-drop form builder',
      'Submissions inbox + analytics',
      'Auto-create contacts / leads in the CRM',
      'Webhooks & integrations',
      'Spam protection',
    ],
    placements: [],
    featured: true,
  },
  {
    id: 'sms',
    name: 'SMS / Texting (Twilio + A2P)',
    navLabel: 'SMS / Texting',
    icon: '💬',
    category: 'Communication',
    tier: 'addon',
    price: 625,
    blurb: 'Two-way business texting over Twilio — including A2P 10DLC registration and number provisioning.',
    longDescription:
      'Text customers from PolishPoint with a compliant business number. We handle A2P 10DLC brand & campaign registration and number provisioning, then wire two-way SMS into your messaging inbox and automated reminders.',
    features: [
      'A2P 10DLC brand + campaign registration',
      'Business number provisioning',
      'Two-way SMS in the messaging inbox',
      'SMS reminders & notifications',
      'Opt-out / compliance handling',
    ],
    placements: [],
    featured: true,
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks Integration',
    navLabel: 'QuickBooks',
    icon: '🔄',
    category: 'Billing & Payments',
    tier: 'addon',
    price: 2000,
    blurb: 'Two-way sync with QuickBooks Online — customers, invoices, and payments.',
    longDescription:
      'Keep PolishPoint and QuickBooks Online perfectly in step. Customers, invoices, and payments sync in both directions, and AR aging surfaces right inside your books — no double entry.',
    features: [
      'Bidirectional customer sync',
      'Bidirectional invoice sync',
      'Bidirectional payment sync',
      'AR aging surfaces',
    ],
    placements: ['integrations'],
    featured: true,
  },
  {
    id: 'fieldops',
    name: 'Field Ops',
    navLabel: 'Field Ops',
    icon: '📋',
    category: 'Operations',
    tier: 'addon',
    price: 2750,
    blurb: 'Digital checklists, before/after photos, and GPS job-completion verification.',
    longDescription:
      'Verify every job is done right. Crews work digital cleaning checklists, capture before/after photos, and confirm completion with GPS — even offline, syncing automatically when they reconnect.',
    features: [
      'Digital cleaning checklists',
      'Before / after photos',
      'Offline capability',
      'Job-completion verification (checklist + photos + GPS)',
    ],
    placements: ['schedule'],
    featured: true,
  },
  {
    id: 'ems',
    name: 'Employee Management System',
    navLabel: 'Employee Mgmt',
    icon: '👥',
    category: 'Workforce',
    tier: 'addon',
    price: 3500,
    blurb: 'Document storage, certifications, GPS clock-in/out, onboarding, and HR workflows.',
    longDescription:
      'A complete HR layer for your crew. Store documents with expiration tracking, manage certifications and training, capture GPS clock-in/out, run compliant digital onboarding, and handle raises, inspections, and time-off in one place.',
    features: [
      'Document storage with expiration tracking',
      'Certifications & training records',
      'GPS clock-in / clock-out',
      'ESIGN/UETA-compliant onboarding',
      'Supervisor inspections',
      'Raise & promotion workflow',
      'Time-off requests',
      'Gusto payroll integration',
    ],
    placements: ['team'],
    featured: true,
  },
  {
    id: 'inventory',
    name: 'Inventory / Key Tracking',
    navLabel: 'Inventory',
    icon: '📦',
    category: 'Operations',
    tier: 'addon',
    price: 1500,
    blurb: 'Track physical keys and general inventory with low-stock alerts.',
    longDescription:
      'Never lose a client key or run out of supplies again. Track physical keys per site plus general inventory — supplies, equipment, and stock — with automatic low-stock alerts.',
    features: [
      'Physical key tracking per site',
      'General inventory (supplies, equipment)',
      'Stock-level tracking',
      'Low-stock alerts',
    ],
    placements: ['dashboard'],
    featured: true,
  },
  {
    id: 'salesautomation',
    name: 'Sales Automation',
    navLabel: 'Sales Automation',
    icon: '⚙️',
    category: 'Growth',
    tier: 'addon',
    price: 1500,
    blurb: 'Timed, trigger-based workflows that move deals, send follow-ups, and assign tasks automatically.',
    longDescription:
      'Put your follow-up on autopilot. Build timed, trigger-based workflows that advance pipeline stages, fire follow-up emails and texts, create tasks, and notify owners — so nothing slips through the cracks.',
    features: [
      'Trigger-based + timed workflows',
      'Auto-advance pipeline stages',
      'Scheduled follow-up email / SMS',
      'Task creation & owner assignment',
      'Branching conditions',
    ],
    placements: [],
    featured: true,
  },
  {
    id: 'datamigration',
    name: 'Data Migration',
    navLabel: 'Data Migration',
    icon: '📥',
    category: 'Onboarding',
    tier: 'addon',
    price: 500,
    blurb: 'Per-source import of your existing customers, jobs, and history (e.g. from GoHighLevel) — clean and mapped.',
    longDescription:
      'Start with your data already in place. We migrate your contacts, accounts, jobs, and history from your current system (e.g. GoHighLevel), per source — using the built-in CSV import wizard plus per-source field mapping and cleanup.',
    features: [
      'Per-source migration (e.g. GoHighLevel)',
      'CSV import wizard',
      'Field mapping & de-duplication',
      'Historical jobs & notes',
      'Validation & dry-run',
    ],
    placements: [],
    featured: true,
  },
];

export const getModule = (id) => MODULE_CATALOG.find((m) => m.id === id) || null;

export const modulesForPlacement = (placement) =>
  MODULE_CATALOG.filter((m) => m.placements.includes(placement));

export const featuredModules = () => MODULE_CATALOG.filter((m) => m.featured);

// Whole-dollar USD formatter — prices are one-time fees with no cents.
export const formatPrice = (n) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
