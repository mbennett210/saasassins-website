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

// Quick Start is ONBOARDING, not a setting — it sat as a peer to Roles &
// Permissions, which is part of why the old row read as noise. Pinned above the
// groups, and it retires from the surface once he has finished it.
import { IDENTITY } from '../../brand/identity.generated.js';
export const SETTINGS_PINNED = {
  to: 'quickstart',
  label: 'Quick Start',
  icon: 'star',
  perm: 'settings.account',
  desc: `Finish setting up ${IDENTITY.name}.`,
};

export const SETTINGS_GROUPS = [
  {
    key: 'business',
    label: 'Your business',
    items: [
      { to: 'company',    label: 'Company',            icon: 'building', perm: 'settings.company',  desc: 'Name, address, logo and the office email customers reply to.' },
      { to: 'services',   label: 'Services',           icon: 'invoices', perm: 'settings.services', desc: 'The work you sell, and what it is called on a quote.' },
      { to: 'tags',       label: 'Tags & Variables',   icon: 'tag',      perm: 'tags.manage',       desc: 'Reusable tags for customers, and the merge fields used in messages.' },
    ],
  },
  {
    key: 'operations',
    label: 'How you work',
    items: [
      { to: 'operations', label: 'Operations',        icon: 'schedule',  perm: 'time.config',    desc: 'Clock-in geofence, auto-close grace and the variance thresholds.' },
      { to: 'reminders',  label: 'Customer Reminders', icon: 'reminders', perm: 'reminders.view', desc: 'Automatic nudges before and after a visit.' },
    ],
  },
  {
    key: 'people',
    label: 'People & access',
    items: [
      { to: 'team',  label: 'Team',                 icon: 'clients', perm: 'settings.team.view',  desc: 'Who can log in, and what each person may see.' },
      { to: 'roles', label: 'Roles & Permissions',  icon: 'lock',    perm: 'settings.roles.edit', desc: 'What Admin and Crew are allowed to do.' },
    ],
  },
  {
    key: 'connections',
    label: 'Connections',
    items: [
      // Connecting an inbox is a manager task — gated on startConversation
      // (owner/admin), not messaging.use, which crew hold. Crew don't connect inboxes.
      { to: 'integrations', label: 'Integrations',      icon: 'phone', perm: 'integrations.view',            desc: 'Texting, email delivery and payments.' },
      { to: 'inboxes',      label: 'Connected Inboxes', icon: 'mail',  perm: 'messaging.startConversation',  desc: 'Mailboxes the app sends and receives from.' },
    ],
  },
  {
    // Personal, not organisational — and deliberately its own group rather than
    // padded into Connections to even up the grid. A profile is not a connection.
    key: 'you',
    label: 'You',
    items: [
      { to: 'account', label: 'Account', icon: 'user', perm: 'settings.account', desc: 'Your own profile, password and notification preferences.' },
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
