// masterSearch/registry.js — the static "Pages" and "Actions" catalog for global
// search. JSX-FREE on purpose: scripts/search-lint.mjs ESM-imports this under node to
// reconcile it against App.jsx's routes, and it must not drag in React. Imports only pure
// modules (navData, settingsNav, rank).
//
// PAGES are DERIVED, never hand-re-declared:
//   • every nav leaf (lib/navData.NAV) — owner of label / icon / perm / role+viewport modifiers
//   • every settings page (settingsNav SETTINGS_PINNED + SETTINGS_GROUPS), prefixed /settings/
//   • EXTRA_PAGES — surfaces with no NAV-array row (/review, the /settings hub) and deep-linkable
//     SUB-TABS (?tab / ?view / ?r / ?inbox) that are worth finding on their own.
// DECORATIONS bolt search keywords (what an operator would TYPE, including the functions a
// page configures, e.g. "pay schedule" → Operations) onto a page by its path, without
// duplicating the nav's ownership of the structural fields.
//
// The carry-through guarantee: scripts/search-lint.mjs fails the build if a route in
// App.jsx has no page entry here (and no EXCLUDED_ROUTES reason), if any entry points at a
// route that no longer exists, or if a canonical page entry's perm disagrees with the
// route's <RequirePerm>. So a module cannot be added, renamed or removed without search
// following — the index cannot silently drift.
//
// A dormant feature (navData leaf `enabled: false`, e.g. Marketing behind MARKETING_ENABLED)
// keeps its page entry — its route is still in App.jsx, so the lint still reconciles it —
// but `enabled` passes through, and the shared visible() predicate hides it from everyone.
//
// Explicit .js extensions: this module is ESM-imported by scripts/search-lint.mjs and
// tests under plain node, which (unlike Vite) does not resolve extensionless paths. Every
// target is a pure module whose own imports are explicit .js too, so node can load them.
import { navLeaves, visible, mobileTabs } from '../navData.js';
import { SETTINGS_PINNED, SETTINGS_GROUPS } from '../../pages/settings/settingsNav.js';
import { normalize } from './rank.js';

// path (before any '?') → extra search keywords. Evidence-based: each settings entry lists
// the controls actually on that page, so "where do I change X?" finds it.
const DECORATIONS = {
  '/': ['home', 'overview', 'kpis'],
  '/schedule': ['calendar', 'jobs', 'cleans', 'book', 'appointments'],
  '/messaging': ['inbox', 'sms', 'text', 'email', 'chat', 'conversations'],
  '/contacts': ['customers', 'accounts', 'people', 'companies', 'clients'],
  '/clients': ['customers', 'accounts', 'companies'],
  '/reports': ['attendance', 'hours', 'analytics', 'export'],
  '/pipeline': ['deals', 'sales', 'opportunities', 'kanban', 'stages'],
  '/marketing': ['email sequences', 'campaigns', 'drip', 'outreach'],
  '/time': ['punches', 'clock', 'timesheet', 'attendance', 'clock in history'],
  '/variance': ['labor', 'scheduled vs actual', 'overtime', 'drive time'],
  '/payroll': ['pay run', 'wages', 'gross', 'pay period', 'compensation', 'export'],
  '/inspections': ['inspections', 'quality', 'checklists', 'work orders', 'complaints', 'templates', 'qc'],
  '/keys': ['access', 'lockbox', 'check out', 'check in', 'codes'],
  '/supplies': ['inventory', 'requests', 'approved items', 'restock', 'products'],
  '/quotes': ['estimates', 'proposals', 'e-signature', 'bids'],
  '/invoices': ['billing', 'payments', 'receivables', 'statements'],
  '/hr': ['employees', 'pto', 'reimbursements', 'documents', 'human resources', 'staff'],
  '/review': ['review', 'drafts', 'decisions', 'questions', 'questionnaire', 'sign off', 'email review', 'templates', 'outbound'],
  '/settings': ['preferences', 'configuration', 'admin', 'setup'],
  '/settings/company': ['business name', 'address', 'phone', 'logo', 'timezone', 'business hours', 'invoice prefix', 'tax rate'],
  '/settings/services': ['services', 'pricing', 'frequencies', 'work you sell'],
  '/settings/tags': ['tags', 'labels', 'variables', 'merge fields'],
  '/settings/operations': ['geofence', 'clock in radius', 'auto-close', 'grace', 'variance threshold', 'drive time', 'mileage',
    'pay schedule', 'pay period', 'semi-monthly', 'biweekly', 'overtime', 'shift alerts', 'late', 'missed shift'],
  '/settings/reminders': ['reminders', 'nudges', 'follow up'],
  '/settings/team': ['team', 'staff', 'users', 'employees', 'invite', 'roster'],
  '/settings/roles': ['roles', 'permissions', 'access', 'who can', 'overrides'],
  '/settings/integrations': ['twilio', 'sms', 'texting', 'a2p', 'webhooks', 'lead webhooks', 'email provider', 'payments'],
  '/settings/inboxes': ['connected inboxes', 'mailboxes', 'email accounts'],
  '/settings/account': ['profile', 'password', 'notifications', 'push notifications', 'your account'],
  '/settings/quickstart': ['quick start', 'onboarding', 'setup guide'],
};

// Surfaces with no nav row, plus deep-linkable sub-tabs. Sub-tabs carry a '?' in `to`, so
// the lint validates only their base route (not their perm). Sub-tab LABELS are the page's
// own tab labels (what the user sees there) and their SUBLABEL names the page they live on.
// `permsAll` mirrors a tab the page itself gates tighter than its route (Work orders:
// problems.manage; Approved items: supplies.manage) so a result never lands on a tab the
// viewer can't see.
const EXTRA_PAGES = [
  { to: '/settings', label: 'Settings', icon: 'settings', perm: 'settings.account', source: 'extra' },
  { to: '/review', label: 'Review', icon: 'edit', perm: 'drafts.view', source: 'extra', desktopOnly: true },

  // HR sub-tabs (?tab=) — Employees is the default (the /hr entry covers it).
  { to: '/hr?tab=special', label: 'Special services', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['special service pay', 'bonus'] },
  { to: '/hr?tab=reimbursements', label: 'Reimbursements', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['expenses', 'reimburse'] },
  { to: '/hr?tab=pto', label: 'PTO', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['time off', 'vacation', 'leave'] },

  // Quality hub sub-tabs (?tab=) — Inspections is the default (the /inspections entry covers it).
  { to: '/inspections?tab=checklists', label: 'Checklists', sublabel: 'Quality', icon: 'check', perm: 'qc.view', keywords: ['nightly checklist', 'crew checklist'] },
  { to: '/inspections?tab=workorders', label: 'Work Orders', sublabel: 'Quality', icon: 'check', perm: 'qc.view', permsAll: ['problems.manage'], keywords: ['complaints', 'issues', 'requests', 'problems'] },
  { to: '/inspections?tab=templates', label: 'Templates', sublabel: 'Quality', icon: 'check', perm: 'qc.view', keywords: ['inspection template', 'checklist template', 'qc templates'] },

  { to: '/variance?view=drive', label: 'Drive time', sublabel: 'Variance', icon: 'chart', perm: 'variance.view', keywords: ['mileage', 'travel', 'commute'] },
  { to: '/supplies?tab=approved', label: 'Approved items', sublabel: 'Supplies', icon: 'box', perm: 'supplies.view', permsAll: ['supplies.manage'], keywords: ['approved supply items', 'inventory', 'catalog'] },

  // Reports (?r=) — every report is findable by its own name (labels = Reports.jsx tabs).
  { to: '/reports?r=not-clocked', label: 'Not clocked in / out', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', keywords: ['attendance', 'missing punch', 'no clock in'] },
  { to: '/reports?r=called-out', label: 'Called out', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', keywords: ['absence', 'time off', 'no show'] },
  { to: '/reports?r=inspections', label: 'Inspections / site', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', keywords: ['inspection scores', 'inspections by site'] },
  { to: '/reports?r=checklists', label: 'Checklists / site', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', keywords: ['checklist completion', 'checklists by site'] },
  { to: '/reports?r=hours', label: 'Hours by cleaner', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', keywords: ['payroll hours', 'overtime', 'labor hours'] },

  // Messaging inboxes (?inbox=) — Inbox is the default (the /messaging entry covers it).
  { to: '/messaging?inbox=internal', label: 'Channels', sublabel: 'Messaging', icon: 'messaging', perm: 'messaging.use', keywords: ['team chat', 'internal', 'staff chat'] },
  { to: '/messaging?inbox=dm', label: 'DMs', sublabel: 'Messaging', icon: 'messaging', perm: 'messaging.use', keywords: ['direct messages', 'dm'] },
];

// Quick actions — each jumps into a create flow, gated by its own CREATE/EDIT perm (NOT the
// route's view perm; the lint therefore does not perm-reconcile actions). `to` carries a
// consume-and-strip param where the target page opens its modal from it (?new=1, and the
// Quality hub's ?fill=1 / ?checklist=1); the no-query targets open an inline form or land
// the user where they create. desktopOnly mirrors a desktop-bound destination (the quote
// editor, the pipeline board). Crew have no search (MasterSearch gates them out), so an
// entry that only crew could see would be dead: none here is crewOnly. A result ROW shows
// every action with the "plus" icon; `glyph` is the thing it creates, drawn on the mobile
// launchpad's tile (with a small plus badge).
const ACTIONS = [
  { slug: 'add-customer', label: 'Add customer', glyph: 'clients', to: '/clients?new=1', permsAny: ['clients.edit', 'contacts.edit'], keywords: ['new customer', 'new account', 'new company', 'create'] },
  { slug: 'new-job', label: 'New job', glyph: 'schedule', to: '/schedule?new=1', perm: 'schedule.edit', keywords: ['schedule a clean', 'book', 'create job', 'new clean'] },
  { slug: 'new-invoice', label: 'New invoice', glyph: 'invoices', to: '/invoices?new=1', perm: 'invoices.edit', keywords: ['bill', 'create invoice'] },
  { slug: 'new-quote', label: 'New quote', glyph: 'tag', to: '/quotes?new=1', perm: 'quotes.create', desktopOnly: true, keywords: ['estimate', 'proposal', 'create quote'] },
  { slug: 'add-key', label: 'Add key', glyph: 'lock', to: '/keys?new=1', perm: 'keys.manage', keywords: ['new key', 'lockbox', 'create key'] },
  { slug: 'request-supplies', label: 'Request supplies', glyph: 'box', to: '/supplies?new=1', perm: 'supplies.request', keywords: ['supply request', 'restock', 'order supplies'] },
  { slug: 'add-supply-item', label: 'Add supply item', glyph: 'box', to: '/supplies?tab=approved', perm: 'supplies.manage', keywords: ['approved item', 'new product'] },
  { slug: 'invite-team', label: 'Invite team member', glyph: 'user', to: '/settings/team?new=1', perm: 'settings.team.edit', keywords: ['add user', 'add staff', 'add employee', 'new member'] },
  { slug: 'add-tag', label: 'Add tag', glyph: 'tag', to: '/settings/tags', perm: 'tags.manage', keywords: ['new tag', 'label'] },
  { slug: 'add-service', label: 'Add service', glyph: 'invoices', to: '/settings/services', perm: 'settings.services', keywords: ['new service', 'pricing'] },
  { slug: 'new-deal', label: 'New deal', glyph: 'dollarCircle', to: '/pipeline', perm: 'pipeline.edit', desktopOnly: true, keywords: ['opportunity', 'add deal', 'sales'] },
  { slug: 'new-message', label: 'New message', glyph: 'messaging', to: '/messaging?new=1', perm: 'messaging.startConversation', keywords: ['start conversation', 'text', 'email', 'compose'] },
  { slug: 'new-inspection', label: 'New inspection', glyph: 'check', to: '/inspections?fill=1', perm: 'qc.inspect', keywords: ['inspect', 'score a site', 'qc'] },
  { slug: 'fill-checklist', label: 'Fill a checklist', glyph: 'check', to: '/inspections?checklist=1', perm: 'qc.checklist.perform', keywords: ['checklist', 'complete checklist', 'nightly checklist'] },
];

// Routes that deliberately have NO page entry, each with a reason (the lint requires one).
export const EXCLUDED_ROUTES = [
  { path: '/reviews', reason: 'Reviews route exists but is deliberately hidden from the nav until a live Google Business connection exists (see NAV comment in Sidebar.jsx). Convert to a page entry when the nav row returns.' },
];

// Record detail templates that record SOURCES navigate into (sources.js builds the concrete
// path). Listed so the lint can confirm each param route it targets still exists in App.jsx.
export const DETAIL_ROUTES = [
  '/clients/:clientId',
  '/schedule/:jobId',
  '/invoices/:invoiceId',
  '/settings/team/:userId',
  '/messaging/:conversationId',
];

export function basePathOf(to) {
  return String(to || '').split('?')[0];
}

// Pages and actions are this app's functions — hiding one behind a cap is worse than a
// slightly longer list, so their groups cap higher than record groups.
const NAV_GROUP_CAP = 8;

// ── build the static PAGE_ENTRIES (derived at module load) ──────────────────
// Decorations attach by EXACT path: a sub-tab (/inspections?tab=workorders) carries only
// its own keywords, never its parent page's — otherwise every Quality tab matched
// "checklist" and every HR tab matched "pto", burying the right result in look-alikes.
function decorate(to, base = []) {
  const extra = DECORATIONS[to] || [];
  return [...base, ...extra];
}

function withNormalized(entry) {
  return { ...entry, _l: normalize(entry.label), _k: entry.keywords.map(normalize) };
}

function pageEntry(raw) {
  const to = raw.to;
  return withNormalized({
    id: `page:${to}`,
    kind: 'page',
    typeLabel: 'Page',
    rankBucket: 0,
    group: 'pages',
    groupLabel: 'Pages',
    groupCap: NAV_GROUP_CAP,
    to,
    label: raw.label,
    sublabel: raw.sublabel,
    icon: raw.icon,
    keywords: decorate(to, raw.keywords || []),
    perm: raw.perm,
    permsAll: raw.permsAll,
    hideWhen: raw.hideWhen,
    enabled: raw.enabled,
    managerOnly: raw.managerOnly,
    crewOnly: raw.crewOnly,
    desktopOnly: raw.desktopOnly,
    source: raw.source || 'nav',
  });
}

const navPages = navLeaves().map((leaf) => pageEntry({ ...leaf, source: 'nav' }));

const settingsItems = [SETTINGS_PINNED, ...SETTINGS_GROUPS.flatMap((g) => g.items)];
const settingsPages = settingsItems.map((item) => pageEntry({
  to: `/settings/${item.to}`,
  label: item.label,
  icon: item.icon,
  perm: item.perm,
  sublabel: item.desc,
  source: 'settings',
}));

const extraPages = EXTRA_PAGES.map(pageEntry);

export const PAGE_ENTRIES = [...navPages, ...settingsPages, ...extraPages];

export const ACTION_ENTRIES = ACTIONS.map((a) => withNormalized({
  id: `action:${a.slug}`,
  slug: a.slug,
  glyph: a.glyph,
  kind: 'action',
  typeLabel: 'Action',
  rankBucket: 1,
  group: 'actions',
  groupLabel: 'Actions',
  groupCap: NAV_GROUP_CAP,
  to: a.to,
  label: a.label,
  icon: 'plus',
  keywords: a.keywords || [],
  perm: a.perm,
  permsAny: a.permsAny,
  desktopOnly: a.desktopOnly,
}));

// All static (page + action) entries — what search-lint reconciles against App.jsx.
export const NAV_ENTRIES = [...PAGE_ENTRIES, ...ACTION_ENTRIES];

// Page + action entries the given user may see, filtered by the SAME predicate the sidebar
// uses (perm + permsAll + hideWhen + role/viewport modifiers) so search visibility mirrors
// nav exactly.
export function buildNavEntries(check, isMobile, isCrew) {
  return NAV_ENTRIES.filter((e) => visible(e, check, isMobile, isCrew));
}

// The user's visible PRIMARY modules (top-level nav leaves, in NAV order) — the empty-query
// "Pages" suggestions.
export function visiblePrimaryPages(check, isMobile, isCrew) {
  return PAGE_ENTRIES.filter((e) => e.source === 'nav' && visible(e, check, isMobile, isCrew));
}

// ── the mobile LAUNCHPAD (UI_RULES §116): what the phone search shows before you type ──
// Quick actions: the curated six a manager reaches for most on a phone, in this order,
// then any other action the viewer can open to fill the grid. Go to: the viewer's primary
// pages that the FloatingNav tray does NOT already show (the tray is one tap away anyway).
// Both go through the same visibility predicate as everything else, so a tile never
// offers a flow or a page the viewer can't open.
export const LAUNCHPAD_ACTIONS = ['add-customer', 'new-job', 'new-invoice', 'new-message', 'request-supplies', 'add-key'];
const LAUNCHPAD_TILES = 6;
const LAUNCHPAD_PAGES = 8;

export function buildLaunchpad(check, isMobile, isCrew) {
  const order = (e) => {
    const i = LAUNCHPAD_ACTIONS.indexOf(e.slug);
    return i < 0 ? LAUNCHPAD_ACTIONS.length : i;
  };
  // Array#sort is stable, so the backfill keeps registry order behind the curated six.
  const actions = ACTION_ENTRIES
    .filter((e) => visible(e, check, isMobile, isCrew))
    .sort((a, b) => order(a) - order(b))
    .slice(0, LAUNCHPAD_TILES);
  const tray = new Set(mobileTabs(check, isCrew).map((t) => t.to));
  const pages = visiblePrimaryPages(check, isMobile, isCrew).filter((p) => !tray.has(p.to)).slice(0, LAUNCHPAD_PAGES);
  return { actions, pages };
}
