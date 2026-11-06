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
// A dormant feature (navData leaf `enabled: false`, e.g. Marketing behind MARKETING_ENABLED,
// Quotes behind QUOTES_ENABLED) keeps its page entry — its route is still in App.jsx, so the lint still reconciles it —
// but `enabled` passes through, and the shared visible() predicate hides it from everyone.
//
// Explicit .js extensions: this module is ESM-imported by scripts/search-lint.mjs and
// tests under plain node, which (unlike Vite) does not resolve extensionless paths. Every
// target is a pure module whose own imports are explicit .js too, so node can load them.
import { navLeaves, visible, mobileTabs, navPath } from '../navData.js';
import { SETTINGS_PINNED, SETTINGS_GROUPS } from '../../pages/settings/settingsNav.js';
import { normalize } from './rank.js';
import { QUOTES_ENABLED } from '../features.js';

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
  '/approvals': ['approve time', 'timesheet approval', 'overtime approval', 'missing time', 'pending punches', 'clock in approval'],
  '/time': ['punches', 'clock', 'timesheet', 'attendance', 'clock in history'],
  '/variance': ['labor', 'scheduled vs actual', 'overtime', 'drive time'],
  '/payroll': ['pay run', 'wages', 'gross', 'pay period', 'compensation', 'export'],
  '/inspections': ['inspections', 'quality', 'checklists', 'work orders', 'complaints', 'templates', 'qc'],
  // Builder C (the manager view redesign, 2026-10-09): Client Requests.
  '/requests': ['client requests', 'requests', 'complaints', 'work orders', 'tickets', 'respond', 'deadlines', 'sla', 'overdue'],
  // S131: an Operations Manager's (and the office's) accounts with their account managers.
  '/team-accounts': ['accounts', 'account managers', 'operations manager', 'team', 'reassign', 'change account manager', 'buildings'],
  '/keys': ['access', 'lockbox', 'check out', 'check in', 'codes'],
  '/supplies': ['inventory', 'requests', 'approved items', 'restock', 'products'],
  '/quotes': ['estimates', 'proposals', 'e-signature', 'bids'],
  '/contracts': ['contract', 'agreement', 'renewal', 'renewals', 'term', 'price increase', 'cancellation notice', 'auto renew', 'book value', 'annual value', 'signed contract'],
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
  '/settings/client-logins': ['customer login', 'client login', 'client portal', 'customer portal', 'hub',
    'property manager', 'facility director', 'management company', 'building group', 'who can see this building'],
  '/settings/integrations': ['twilio', 'sms', 'texting', 'a2p', 'webhooks', 'lead webhooks', 'email provider', 'payments'],
  '/settings/inboxes': ['connected inboxes', 'mailboxes', 'email accounts'],
  '/settings/account': ['profile', 'password', 'notifications', 'push notifications', 'your account'],
  '/settings/quickstart': ['quick start', 'onboarding', 'setup guide'],
  // ── Manager view (Builder A, 2026-10-09): the today screens ──
  '/check-in': ['shift check in', 'check-in', 'who is on site', 'on site now', 'late', 'no show', 'not checked in', 'attendance today'],
  '/checklists': ['checklists today', 'checklist status', 'tonight', 'not finished', 'checklist progress'],
  // Every building's QR codes (Matt, 2026-10-30: "How do I create them? I'm not able to find that").
  '/qr-codes': ['qr', 'qr code', 'qr codes', 'scan codes', 'labels', 'print labels', 'area codes', 'stickers', 'create qr code'],
};

// Surfaces with no nav row, plus deep-linkable sub-tabs. Sub-tabs carry a '?' in `to`, so
// the lint validates only their base route (not their perm). Sub-tab LABELS are the page's
// own tab labels (what the user sees there) and their SUBLABEL names the page they live on.
// `permsAll` mirrors a tab the page itself gates tighter than its route (Work orders:
// problems.manage) so a result never lands on a tab the viewer can't see. (Supplies' old
// "Approved items" tab is gone: a building's supply list lives on its customer page since
// 2026-10-06, which the customer search already finds.)
const EXTRA_PAGES = [
  { to: '/settings', label: 'Settings', icon: 'settings', perm: 'settings.account', source: 'extra' },

  // HR sub-tabs (?tab=) — Employees is the default (the /hr entry covers it).
  { to: '/hr?tab=special', label: 'Special services', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['special service pay', 'bonus'] },
  { to: '/hr?tab=reimbursements', label: 'Reimbursements', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['expenses', 'reimburse'] },
  { to: '/hr?tab=pto', label: 'PTO', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['time off', 'vacation', 'leave'] },
  { to: '/hr?tab=warnings', label: 'Warnings', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['write up', 'write-up', 'discipline', 'disciplinary', 'warning'] },
  { to: '/hr?tab=incidents', label: 'Incidents', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['incident', 'incident report', 'accident', 'injury', 'injured', 'safety'] },
  { to: '/hr?tab=terminations', label: 'Terminations', sublabel: 'HR', icon: 'clients', perm: 'hr.view', keywords: ['termination', 'terminate', 'fired', 'let go', 'resignation', 'last day', 'offboarding'] },

  // Quality hub sub-tabs (?tab=) — Inspections is the default (the /inspections entry covers it).
  { to: '/inspections?tab=checklists', label: 'Checklists', sublabel: 'Quality', icon: 'check', perm: 'qc.view', keywords: ['nightly checklist', 'crew checklist'] },
  { to: '/inspections?tab=assignments', label: 'Assignments', sublabel: 'Quality', icon: 'check', perm: 'qc.view', permsAll: ['ops.edit'], keywords: ['checklist assignments', 'who has which checklist', 'assign a checklist', 'reassign'] },
  { to: '/inspections?tab=workorders', label: 'Work Orders', sublabel: 'Quality', icon: 'check', perm: 'qc.view', permsAll: ['problems.manage'], keywords: ['complaints', 'issues', 'requests', 'problems'] },
  { to: '/inspections?tab=templates', label: 'Templates', sublabel: 'Quality', icon: 'check', perm: 'qc.view', keywords: ['inspection template', 'checklist template', 'qc templates'] },

  { to: '/variance?view=drive', label: 'Drive time', sublabel: 'Variance', icon: 'chart', perm: 'variance.view', keywords: ['mileage', 'travel', 'commute'] },

  // ── Manager view (Builder A, 2026-10-09): the Schedule's Today view (?view=Today) — today's
  // visits by Day / Evening with where each stands. Office only, like the Schedule leaf.
  { to: '/schedule?view=Today', label: 'Today', sublabel: 'Schedule', icon: 'schedule', perm: 'schedule.view', managerOnly: true, keywords: ['today', 'today schedule', 'today visits', 'day porter', 'evening crews'] },

  // Reports (?r=) — every report is findable by its own name (labels = Reports.jsx tabs).
  // Each report is found only by whoever Reports lists it for: the route's key plus the key its read
  // needs (pages/Reports.jsx `perm`, S131), so a supply manager is never offered a report the page
  // would not show them.
  { to: '/reports?r=not-clocked', label: 'Not clocked in / out', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['time.view'], keywords: ['attendance', 'missing punch', 'no clock in'] },
  { to: '/reports?r=called-out', label: 'Called out', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['time.view'], keywords: ['absence', 'time off', 'no show'] },
  { to: '/reports?r=inspections', label: 'Inspections / site', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['qc.view'], keywords: ['inspection scores', 'inspections by site'] },
  { to: '/reports?r=checklists', label: 'Checklists / site', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['qc.view'], keywords: ['checklist completion', 'checklists by site'] },
  // Matt's KPI (the Oct 6 call). Its label is the English of Reports' `resolveTime.report.tab`; the
  // report is listed only for a qc.view holder (its route needs both keys), so search asks for both.
  { to: '/reports?r=resolve-time', label: 'Time to resolve', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['qc.view'], keywords: ['average time to resolve', 'resolution time', 'ticket close time', 'how long to close a ticket', 'response time', 'kpi'] },
  { to: '/reports?r=visitor-ratings', label: 'Visitor ratings', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['qc.view'], managerOnly: true, keywords: ['thumbs up', 'thumbs down', 'qr code ratings', 'how does this area look', 'visitor feedback'] },
  { to: '/reports?r=hours', label: 'Hours by cleaner', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['variance.view'], keywords: ['payroll hours', 'overtime', 'labor hours'] },
  { to: '/reports?r=supply-usage', label: 'Supply usage', sublabel: 'Reports', icon: 'chart', perm: 'reports.view', permsAll: ['supplies.view'], keywords: ['supplies used', 'toilet paper', 'how many boxes', 'supply spend'] },
  // CS-379. `perm` is the report's OWN key, not the hub's: the hub opens on reports.view, and
  // this report needs activity.view on top (the server refuses it otherwise).
  { to: '/reports?r=activity', label: 'Activity log', sublabel: 'Reports', icon: 'chart', perm: 'activity.view', keywords: ['audit trail', 'who did what', 'history', 'who changed', 'who cancelled'] },

  // Messaging inboxes (?inbox=) — Inbox is the default (the /messaging entry covers it).
  { to: '/messaging?inbox=internal', label: 'Channels', sublabel: 'Messaging', icon: 'messaging', perm: 'messaging.use', keywords: ['team chat', 'internal', 'staff chat'] },
  { to: '/messaging?inbox=dm', label: 'DMs', sublabel: 'Messaging', icon: 'messaging', perm: 'messaging.use', keywords: ['direct messages', 'dm'] },

  // ── the manager view redesign (Builder B): the P&L board on its own page (D3), reached from
  // the manager Home's tile; no nav row, so search carries it. Gated like its route.
  { to: '/pnl', label: 'Property P&L', icon: 'dollarCircle', perm: 'financials.view', source: 'extra',
    keywords: ['profit and loss', 'p&l', 'pnl', 'profit', 'margin', 'quickbooks', 'health triage', 'property performance'] },
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
  { slug: 'add-customer', label: 'Add customer', glyph: 'clients', to: '/clients?new=1', perm: 'clients.edit', keywords: ['new customer', 'new account', 'new company', 'create'] },
  { slug: 'new-job', label: 'New job', glyph: 'schedule', to: '/schedule?new=1', perm: 'schedule.edit', keywords: ['schedule a clean', 'book', 'create job', 'new clean'] },
  { slug: 'new-invoice', label: 'New invoice', glyph: 'invoices', to: '/invoices?new=1', perm: 'invoices.edit', keywords: ['bill', 'create invoice'] },
  { slug: 'new-quote', label: 'New quote', glyph: 'tag', to: '/quotes?new=1', perm: 'quotes.create', desktopOnly: true, enabled: QUOTES_ENABLED, keywords: ['estimate', 'proposal', 'create quote'] },
  { slug: 'add-key', label: 'Add key', glyph: 'lock', to: '/keys?new=1', perm: 'keys.manage', keywords: ['new key', 'lockbox', 'create key'] },
  { slug: 'request-supplies', label: 'Request supplies', glyph: 'box', to: '/supplies?new=1', perm: 'supplies.request', keywords: ['supply request', 'restock', 'order supplies'] },
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
  // ── The Cleaner Hub (Builder C, 2026-10-13): the cleaner's phone app, reached from Home's tiles.
  // Crew have no search (MasterSearch gates them out), and the office reads the same data on its own
  // screens (Client Requests, the Time Clock), so an entry here would lead nobody anywhere new.
  { path: '/my-day/requests', reason: 'The Cleaner Hub\'s Client Requests: a cleaner\'s own list, reached from Home\'s tile; crew have no search and the office works the queue at /requests.' },
  { path: '/my-day/hours', reason: 'The Cleaner Hub\'s My Hours: a cleaner\'s own pay period, reached from Home\'s tile; crew have no search and the office reads hours on /time and /approvals.' },
  // The Cleaner Hub (Builder D, 2026-10-13): the cleaner's own phone screens, reached from their Home
  // (plan 2026-10-13 D6: no tab bar, no search for crew). The office has its own pages for both.
  { path: '/my-day/supplies', reason: 'The cleaner\'s Request Supplies, opened from their Home for a stop (?b=); the office asks for supplies on /supplies.' },
  { path: '/my-day/scan', reason: 'The cleaner\'s QR camera, opened from their Home; a scan needs the phone at the wall, not a search.' },
  // QR Wave 2: the office's own QR camera, opened from its Scan button (the manager's Home, the phone's
  // menu, the desktop sidebar's footer).
  { path: '/areas/scan', reason: 'The office\'s QR camera, opened from the Scan button on the manager\'s Home, the phone menu and the sidebar; a scan needs the code in front of the camera, not a search.' },
  // The Cleaner Hub (brief A, 2026-10-13): a cleaner's own screen. Search is office-only (crew have no
  // search, owner 2026-09-22) and the page shows only the viewer's own day, so it is reached from Home.
  { path: '/my-day/stops', reason: 'The Cleaner Hub\'s My Stops Today: the viewer\'s own stops, reached from Home; crew have no search.' },
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
    teamOnly: raw.teamOnly,
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
  // A dormant feature's action (New quote behind QUOTES_ENABLED) carries its flag like its page.
  enabled: a.enabled,
}));

// All static (page + action) entries — what search-lint reconciles against App.jsx.
export const NAV_ENTRIES = [...PAGE_ENTRIES, ...ACTION_ENTRIES];

// Page + action entries the given user may see, filtered by the SAME predicate the sidebar
// uses (perm + permsAll + hideWhen + role/viewport modifiers) so search visibility mirrors
// nav exactly.
// Search is office-only (crew have no search, owner 2026-09-22; the crew shell mounts none), so
// the role modifier is always the office's: a crew-only page (My Day) never appears. `nav` carries
// `team` (lib/teamScope seesTeamPages, S131): the Accounts page is the team viewers' only.
export function buildNavEntries(check, isMobile, nav = {}) {
  return NAV_ENTRIES.filter((e) => visible(e, check, isMobile, false, nav));
}

// The user's visible PRIMARY modules (top-level nav leaves, in NAV order) — the empty-query
// "Pages" suggestions.
export function visiblePrimaryPages(check, isMobile, nav = {}) {
  return PAGE_ENTRIES.filter((e) => e.source === 'nav' && visible(e, check, isMobile, false, nav));
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

export function buildLaunchpad(check, isMobile, nav = {}) {
  const order = (e) => {
    const i = LAUNCHPAD_ACTIONS.indexOf(e.slug);
    return i < 0 ? LAUNCHPAD_ACTIONS.length : i;
  };
  // Array#sort is stable, so the backfill keeps registry order behind the curated six.
  const actions = ACTION_ENTRIES
    .filter((e) => visible(e, check, isMobile, false, nav))
    .sort((a, b) => order(a) - order(b))
    .slice(0, LAUNCHPAD_TILES);
  // The bar's pages by PATH (the supply manager's Supply Catalog tab is the Supplies page, S131).
  const tray = new Set(mobileTabs(check, { supply: !!nav.supply }).map((t) => navPath(t.to)));
  const pages = visiblePrimaryPages(check, isMobile, nav).filter((p) => !tray.has(navPath(p.to))).slice(0, LAUNCHPAD_PAGES);
  return { actions, pages };
}
