// The Settings map — ONE definition, read by both the hub landing and the
// sub-page header. Adding a settings page is a single line in a single group.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Settings used to be a flat row of pills in `SettingsLayout.jsx`, laid out with
// `flex-wrap: wrap` + `justify-content: center`. Twelve peers with no hierarchy,
// centre-wrapped — so there was no shared left edge to scan down, and every new
// page re-flowed the rows above it. The row you learned last week was not the row
// you saw this week. That is a structural problem, not a cosmetic one, and it was
// getting worse: the order/invoice automations and the customer-email previews all
// needed a home (Daniel, 2026-07-27).
//
// The GROUPING is the durable decision here; the container is not. If the hub's
// extra click ever grates, these same groups drop straight into a left rail
// without touching this file.
//
// `desc` is not decoration. The owner is a cleaning operator, not a CRM operator —
// name each page by what it DOES for them in their own words, not by the system
// label, so an owner who does not share our vocabulary still knows where to go (the
// UI_RULES copy rule: name things by what people recognise, not how the system is built).

// LANGUAGES (CS-193): every card carries `labelKey` / `descKey` and every group `labelKey`,
// its lines in the catalog — what the hub SHOWS, in the reader's language. `label` / `desc`
// stay the English, which master search reads; test-i18n-coverage holds the two equal.
//
// Quick Start is ONBOARDING, not a setting — it sat as a peer to Roles &
// Permissions, which is part of why the old row read as noise. Pinned above the
// groups, and it retires from the surface once he has finished it.
import { IDENTITY } from '../../brand/identity.generated.js';
export const SETTINGS_PINNED = {
  to: 'quickstart',
  label: 'Quick Start',
  labelKey: 'settingsHub.quickStart',
  icon: 'star',
  perm: 'settings.account',
  // setting up the SOFTWARE (IDENTITY.product: the company's name when the pack names no product, UI_RULES §129)
  desc: `Finish setting up ${IDENTITY.product.name}.`,
  descKey: 'settingsHub.quickStartDesc',
  descParams: { name: IDENTITY.product.name },
};

export const SETTINGS_GROUPS = [
  {
    key: 'business',
    label: 'Your business',
    labelKey: 'settingsHub.group.business',
    items: [
      { to: 'company',    label: 'Company',            labelKey: 'settingsHub.company',  descKey: 'settingsHub.companyDesc',  icon: 'building', perm: 'settings.company',  desc: 'Name, address, logo and the office email customers reply to.' },
      { to: 'services',   label: 'Services',           labelKey: 'settingsHub.services', descKey: 'settingsHub.servicesDesc', icon: 'invoices', perm: 'settings.services', desc: 'The work you sell, and what it is called on a quote.' },
      { to: 'tags',       label: 'Tags & Variables',   labelKey: 'settingsHub.tags',     descKey: 'settingsHub.tagsDesc',     icon: 'tag',      perm: 'tags.manage',       desc: 'Reusable tags for customers, and the merge fields used in messages.' },
    ],
  },
  {
    key: 'operations',
    label: 'How you work',
    labelKey: 'settingsHub.group.operations',
    items: [
      { to: 'operations', label: 'Operations',        labelKey: 'settingsHub.operations', descKey: 'settingsHub.operationsDesc', icon: 'schedule',  perm: 'time.config',    desc: 'Clock-in geofence, auto-close grace and the variance thresholds.' },
      { to: 'reminders',  label: 'Customer Reminders', labelKey: 'settingsHub.reminders', descKey: 'settingsHub.remindersDesc', icon: 'reminders', perm: 'reminders.view', desc: 'Automatic nudges before and after a visit.' },
    ],
  },
  {
    key: 'people',
    label: 'People & access',
    labelKey: 'settingsHub.group.people',
    items: [
      { to: 'team',  label: 'Team',                 labelKey: 'settingsHub.team',  descKey: 'settingsHub.teamDesc',  icon: 'clients', perm: 'settings.team.view',  desc: 'Who can log in, and what each person may see.' },
      { to: 'roles', label: 'Roles & Permissions',  labelKey: 'settingsHub.roles', descKey: 'settingsHub.rolesDesc', icon: 'lock',    perm: 'settings.roles.edit', desc: 'What Admin and Crew are allowed to do.' },
      // The CUSTOMER's side of access, not the office's: a property manager or a facility
      // director signing in to see their own buildings. Same group as Team because the
      // question ("who can get in?") is the same one.
      { to: 'client-logins', label: 'Customer Logins', labelKey: 'settingsHub.clientLogins', descKey: 'settingsHub.clientLoginsDesc', icon: 'building', perm: 'hub.users.view', desc: 'Let a customer contact sign in to see the buildings they look after.' },
    ],
  },
  {
    key: 'connections',
    label: 'Connections',
    labelKey: 'settingsHub.group.connections',
    items: [
      // Connecting an inbox is a manager task — gated on startConversation
      // (owner/admin), not messaging.use, which crew hold. Crew don't connect inboxes.
      { to: 'integrations', label: 'Integrations',      labelKey: 'settingsHub.integrations', descKey: 'settingsHub.integrationsDesc', icon: 'phone', perm: 'integrations.view',            desc: 'Texting, email delivery and payments.' },
      { to: 'inboxes',      label: 'Connected Inboxes', labelKey: 'settingsHub.inboxes',      descKey: 'settingsHub.inboxesDesc',      icon: 'mail',  perm: 'messaging.startConversation',  desc: 'Mailboxes the app sends and receives from.' },
    ],
  },
  {
    // Personal, not organisational — and deliberately its own group rather than
    // padded into Connections to even up the grid. A profile is not a connection.
    key: 'you',
    label: 'You',
    labelKey: 'settingsHub.group.you',
    items: [
      { to: 'account', label: 'Account', labelKey: 'settingsHub.account', descKey: 'settingsHub.accountDesc', icon: 'user', perm: 'settings.account', desc: 'Your own profile, password and notification preferences.' },
    ],
  },
];

// Flat lookup for the sub-page header. Matches on the leading path segment so a
// nested route (`team/:userId`) still resolves to its parent entry rather than
// falling through to a blank breadcrumb.
export function findSettingsEntry(pathname) {
  const seg = String(pathname || '').replace(/^\/+settings\/?/, '').split('/')[0];
  if (!seg) return null;
  if (seg === SETTINGS_PINNED.to) return { item: SETTINGS_PINNED, group: null };
  for (const group of SETTINGS_GROUPS) {
    const item = group.items.find((i) => i.to === seg);
    if (item) return { item, group };
  }
  return null;
}
