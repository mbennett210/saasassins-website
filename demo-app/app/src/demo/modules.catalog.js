// Demo catalog — the single source of truth for the demo's commercial packaging:
// the Core platform plus every sellable add-on shown in the demo.
//
// DISPLAY data only (name, copy, the price shown to the user). The Stripe price
// mapping that actually charges the card lives SERVER-SIDE in api/_modules.js, so
// a tampered client can never set its own price — keep the two in sync.
//
//   tier        'core' (the always-included base) vs 'addon' (à la carte).
//   route       set when the module has a live page in the app (Marketing,
//               Quality); the nav links straight to it. Page-less add-ons open
//               an info dialog.
//   navLabel    short label for the sidebar (the full `name` is too long there).
//   placements  where a module's in-context "Add to cart" CTA appears inside the
//               live app (consumed by components/PlacementCTAs on the feature
//               pages). Valid keys: dashboard / invoices / schedule / clients /
//               pipeline / team / integrations.
//
// Extend this list as new add-ons ship; everything downstream (sidebar, landing,
// cart, checkout, concierge) is driven off it.
//
// Pricing (2026-06 re-anchor): one-time BUILD fees. Core is the $2,000 door;
// add-ons are kept accessible so the value lands on the platform, not the menu.
// Integrations connect to the client's OWN third-party accounts (Twilio / Stripe
// / Gusto / QuickBooks), which bill separately — see the BYO-vendor note surfaced
// at checkout + on the landing.

// The Core platform — included in every plan and charged as the base line item at
// checkout (see api/_modules.js, which always adds it to the Stripe session).
// SMS/A2P is INCLUDED in Core (we stand up Twilio + A2P 10DLC as part of the
// build — a complimentary value-add). Sales automation (timed follow-up
// workflows) is built and ships with Core, so it is NOT a separate SKU.
// Reminders here are appointment/job reminders only; invoice/overdue reminders
// live in the Invoicing + Quoting add-on (kept worded distinctly so the two never
// read as the same feature).
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
    'Sales automation (timed follow-up workflows & triggers)',
    'Messaging Suite (email + in-app)',
    'SMS texting via Twilio — A2P 10DLC & number setup included',
    'Invoice & payment logging',
    'Automated appointment reminders (booking, 24h, day-of, post-service)',
    'Team, Roles & Permissions',
  ],
};

export const MODULE_CATALOG = [
  {
    id: 'marketing',
    name: 'Marketing — Warm Outreach & Reviews',
    navLabel: 'Marketing',
    icon: '📣',
    category: 'Growth',
    tier: 'addon',
    price: 1500,
    route: '/marketing', // has a live page in the app — nav links straight to it
    blurb: 'Warm-email outreach at scale plus review generation and reputation management.',
    longDescription:
      'Two growth engines in one module. Outreach: multi-step warm-email sequences that send from company-shared rotation inboxes — we stand up the domain, DNS, and inbox warmup for you — with AI-routed replies and reply-to-pipeline routing. Reputation: automatically request reviews after a completed job, monitor what comes in, and respond — all inside PolishPoint.',
    features: [
      'Multi-step warm-email sequences',
      'Company-shared rotation inboxes',
      'Domain / DNS / inbox warmup setup',
      'AI-routed inbound replies',
      'Send-window + daily-cap controls',
      'Reply-to-pipeline routing',
      'Automated review requests',
      'Review monitoring & response',
      'Reputation dashboard',
    ],
    placements: [],
    featured: true,
  },
  {
    id: 'qc',
    name: 'Quality Control & Inspections',
    navLabel: 'Quality',
    icon: '🔍',
    category: 'Quality',
    tier: 'addon',
    price: 1000,
    route: '/inspections', // has a live page in the app — nav links straight to it
    blurb: 'Score every clean. Area-by-area inspections, a cross-account problems queue, branded client reports, and labor variance that catches what Swept misses.',
    longDescription:
      'The janitorial quality layer a Swept user switches to get — built natively in. Build versioned inspection templates, walk a site scoring each area pass/fail or 1–5 with per-item photos, and instantly get a cleaning score. Open issues roll into a cross-account problems / punch-list queue, and you can send the client a branded report proving their building scored 94%. Pairs with Labor Variance: actual clocked labor vs each account’s expected time, multi-cleaner-attributed (the case Swept gets wrong) and flagged over / under.',
    features: [
      'Scored site inspections (area-level cleaning scores)',
      'Drag-to-build, versioned inspection templates',
      'In-field scoring with per-item photos',
      'Cross-account problems / punch-list queue',
      'Client-facing shareable quality report',
      'Labor variance — clocked time vs expected (multi-cleaner-accurate)',
    ],
    placements: [],
    featured: true,
  },
  {
    id: 'leadscraper',
    name: 'AI Lead Scraper',
    navLabel: 'Lead Scraper',
    icon: '🧲',
    category: 'Growth',
    tier: 'addon',
    price: 1500,
    blurb: 'AI finds decision-makers that match your ICP and feeds them straight into your pipeline.',
    longDescription:
      'Constant top-of-funnel, on autopilot. The AI Lead Scraper searches for decision-makers that match your Ideal Customer Profile, enriches each with verified contact details, and drops them into a dedicated Pipeline stage — ready for your sequences and automations to work. Run it on a schedule for a steady drip of fresh leads, or trigger a search by hand whenever you want more. Standalone — but it plugs straight into your pipeline and automations for nonstop lead flow.',
    features: [
      'ICP-based decision-maker search',
      'AI contact enrichment (email, title, company)',
      'Auto-pipe into a Pipeline stage',
      'Feeds sequences & automations',
      'Scheduled or manual runs',
      'Dedup against existing contacts',
    ],
    placements: ['pipeline'],
    featured: true,
  },
  {
    id: 'forms',
    name: 'Forms & Lead Capture',
    navLabel: 'Forms',
    icon: '📝',
    category: 'Growth',
    tier: 'addon',
    price: 750,
    blurb: 'Drag-and-drop forms that capture leads straight into your CRM and pipeline.',
    longDescription:
      'Stop losing leads to a contact form that just emails someone’s inbox. Build hosted or embeddable forms with a drag-and-drop builder, collect submissions in one place, and auto-route every lead into Contacts and the right Pipeline stage — with conversion analytics and webhooks for whatever comes next.',
    features: [
      'Drag-and-drop form builder',
      'Hosted + embeddable forms',
      'Submission inbox',
      'Conversion analytics',
      'Webhooks',
      'Auto-route to Contacts + Pipeline',
    ],
    placements: ['clients'],
    featured: true,
  },
  {
    id: 'invoicing',
    name: 'Invoicing + Quoting',
    navLabel: 'Invoicing',
    icon: '🧾',
    category: 'Billing & Payments',
    tier: 'addon',
    price: 750,
    blurb: 'Quote-to-cash: branded quotes with e-sign, then online card payments and recurring billing.',
    longDescription:
      'Turn Core’s invoice log into a full quote-to-cash engine. Build and send branded quotes/estimates, collect an e-signature, and convert an accepted quote into an invoice in one click. Then get paid: customizable invoice templates, online card payments via Stripe Connect, recurring/subscription billing, tipping, payment routing, and automated overdue-invoice reminders (distinct from Core’s appointment reminders — these chase money owed).',
    features: [
      'Quote & estimate builder',
      'E-signature acceptance',
      'One-click quote → invoice',
      'Customizable invoice templates',
      'Online card payments (Stripe Connect)',
      'Recurring / subscription billing',
      'Tipping at checkout',
      'Automated overdue-invoice reminders',
      'Payment routing',
    ],
    placements: ['invoices', 'integrations'],
    featured: true,
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks Integration',
    navLabel: 'QuickBooks',
    icon: '🔄',
    category: 'Billing & Payments',
    tier: 'addon',
    price: 500,
    blurb: 'Two-way sync with QuickBooks Online — customers, invoices, and payments.',
    longDescription:
      'Keep PolishPoint and QuickBooks Online perfectly in step. Customers, invoices, and payments sync in both directions, and AR aging surfaces right inside your books — no double entry. Pairs best with Invoicing + Quoting, which turns on the card payments and recurring billing that make the two-way sync worth the most.',
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
    id: 'inventory',
    name: 'Inventory & Key Tracking',
    navLabel: 'Inventory',
    icon: '📦',
    category: 'Operations',
    tier: 'addon',
    price: 500,
    blurb: 'Track physical keys per site and general inventory with low-stock alerts.',
    longDescription:
      'Never lose a client key or run out of supplies again. Track physical keys per site plus general inventory — supplies, equipment, and stock — with automatic low-stock alerts that ride your existing notification preferences.',
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
    id: 'fieldops',
    name: 'Field Ops',
    navLabel: 'Field Ops',
    icon: '📋',
    category: 'Operations',
    tier: 'addon',
    price: 800,
    blurb: 'Run scheduled jobs in the field — a mobile crew app with checklists, photos, and GPS-verified completion.',
    longDescription:
      'Core schedules the work; Field Ops runs it in the field. Push each scheduled job to a mobile app your crews carry, where they work digital checklists, capture before/after photos, and confirm completion with GPS — even offline. Status rolls back into a live board so the office sees what’s done in real time. The field-execution layer you’d otherwise reach for a tool like Jobber to get, built natively in.',
    features: [
      'Mobile field app for crews',
      'Push assigned jobs to crews',
      'Digital job checklists',
      'Before / after photos',
      'GPS-verified completion (offline-capable)',
      'Live status board',
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
    price: 500,
    blurb: 'Document storage, certifications, GPS clock-in/out, onboarding, and HR workflows.',
    longDescription:
      'Core’s Team & Roles control who can log in and what they can do; EMS adds the HR layer on top. Store documents with expiration tracking, manage certifications and training, capture GPS clock-in/out, run compliant digital onboarding, and handle raises, inspections, and time-off in one place — with Gusto payroll wired in. Shares the crew mobile surface with Field Ops, so clock-in rides on the same app your crews already carry.',
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
    id: 'migration',
    name: 'Data Migration',
    navLabel: 'Data Migration',
    icon: '📥',
    category: 'Onboarding',
    tier: 'addon',
    price: 500,
    blurb: 'We import your existing data — priced per source (e.g. a GoHighLevel export).',
    longDescription:
      'Bring your history with you. We map and import your existing contacts, accounts, and activity from your current system — priced per data source (for example, a GoHighLevel export). Includes field mapping, email-keyed dedup, and validation so you start clean. (Shown here as a single source; multi-source migrations are quoted per source.)',
    features: [
      'Per-source field mapping',
      'Contacts + Accounts import',
      'Email-keyed dedup + validation',
      'Sample-CSV guidance',
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
