// Demo module catalog — the sellable add-ons showcased in the marketing demo.
//
// This file holds DISPLAY data only (name, copy, the price shown to the user).
// The Stripe price mapping that actually charges the card lives SERVER-SIDE in
// api/checkout.js, so a tampered client can never set its own price. Prices here
// are one-time setup fees (USD), matching the "Future add-on modules" section of
// SHELL_ROADMAP.md.
//
// `placements` controls where a module's in-context "Add to cart" CTA appears
// inside the live app (consumed by components/ModuleCTA on the feature pages).
// Extend this array — and the catalog itself — as new add-ons ship; everything
// downstream (landing, cart, checkout) is driven off this list.

export const MODULE_CATALOG = [
  {
    id: 'ipr',
    name: 'Invoice & Payment Routing',
    icon: '💳',
    category: 'Billing & Payments',
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
    icon: '🔄',
    category: 'Billing & Payments',
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
    icon: '📦',
    category: 'Operations',
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
    icon: '👥',
    category: 'Workforce',
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
    icon: '📋',
    category: 'Operations',
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
