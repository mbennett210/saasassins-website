// Demo catalog — the single source of truth for the demo's commercial packaging:
// the Core platform plus every sellable add-on shown in the demo.
//
// DISPLAY data only (name, copy, the price shown to the user). The Stripe price
// mapping that actually charges the card lives SERVER-SIDE in api/_modules.js, so
// a tampered client can never set its own price — keep the two in sync.
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
  price: 1500,
  blurb: 'The full operations suite every plan starts with.',
  features: [
    'Operations Dashboard',
    'Scheduling & Calendar',
    'Client Database (Contacts + Accounts)',
    'Sales Pipeline',
    'Messaging Suite',
    'SMS via Twilio + A2P',
    'Invoice & Payment logging',
    'Automated Reminders',
    'Team, Roles & Permissions',
  ],
};

export const MODULE_CATALOG = [
  {
    id: 'marketing',
    name: 'Marketing — Cold Email',
    navLabel: 'Marketing',
    icon: '📣',
    category: 'Growth',
    tier: 'addon',
    price: 600,
    route: '/marketing', // has a live page in the app — nav links straight to it
    blurb: 'Multi-step cold-email sequences with shared rotation inboxes and AI-routed replies.',
    longDescription:
      'Turn outbound into a system. Build multi-step email drip sequences that send from company-shared rotation inboxes, auto-route inbound replies to the right pipeline stage, and track every contact’s enrollment — all inside PolishPoint.',
    features: [
      'Multi-step drip sequences',
      'Company-shared rotation inboxes',
      'AI-routed inbound replies',
      'Per-contact enrollments',
      'Send-window + daily-cap controls',
      'Reply-to-pipeline routing',
    ],
    placements: [],
    featured: true,
  },
  {
    id: 'ipr',
    name: 'Invoice & Payment Routing',
    navLabel: 'Invoice Routing',
    icon: '💳',
    category: 'Billing & Payments',
    tier: 'addon',
    price: 400,
    blurb: 'Customizable invoice templates, automated reminders, and online card payments.',
    longDescription:
      'Turn the Core invoice log into a full billing engine. Customers pay by card online, reminders chase overdue balances automatically, and recurring jobs bill themselves on a schedule.',
    features: [
      'Customizable invoice templates',
      'Automated overdue-invoice reminders',
      'Online card payments via Stripe Connect',
      'Recurring / subscription billing',
      'Tipping at checkout',
      'Payment routing to the right account',
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
    price: 300,
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
    id: 'inventory',
    name: 'Inventory Management',
    navLabel: 'Inventory',
    icon: '📦',
    category: 'Operations',
    tier: 'addon',
    price: 400,
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
    id: 'ems',
    name: 'Employee Management System',
    navLabel: 'Employee Mgmt',
    icon: '👥',
    category: 'Workforce',
    tier: 'addon',
    price: 800,
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
    id: 'fieldops',
    name: 'Field Ops',
    navLabel: 'Field Ops',
    icon: '📋',
    category: 'Operations',
    tier: 'addon',
    price: 600,
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
