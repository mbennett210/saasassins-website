// The sidebar navigation model — the single source of truth for the primary nav
// leaves, their routes, icons, permission gates and role/viewport modifiers.
//
// ── WHY THIS IS ITS OWN (JSX-FREE) MODULE ───────────────────────────────────
// It used to live inside Sidebar.jsx. It moved out so NON-component code can read
// it without importing React: the master-search registry derives its "Pages" from
// this array, and `scripts/search-lint.mjs` ESM-imports it under node to reconcile
// the registry against App.jsx (that lint cannot import a .jsx component module).
// Keep this file pure data + pure helpers — no React, no JSX. Its one import is the
// pure feature-flag module, with an explicit .js so node can load it too.
//
// A top-level entry is either a LEAF ({to,label,icon,perm,...}) or a GROUP
// ({group,icon,children:[leaf,...]}). Operations & Finances group the secondary tools for search
// and the phone; the desktop menu no longer draws these groups: it regroups every leaf into the
// Launcher's sections (LAUNCHER_SECTIONS below, UI_RULES §182). A group whose visible children all
// resolve away (e.g. one of only desktop-only leaves, on mobile) is dropped. The sidebar, the
// tray and search are the OFFICE shell's; a cleaner gets the crew shell (UI_RULES §165), which
// draws none of them. The crew modifiers below still describe what a cleaner can open — the
// offline worker's crew screens are derived from them (scripts/test-offline-shell.mjs §6) and
// search keeps crew-only pages out. Modifiers on a leaf:
//   managerOnly — not a crew screen (Schedule, Customers, Reports)
//   crewOnly    — a crew screen only (My Day, the cleaner's Home)
//   desktopOnly — hidden on the mobile nav (≤640) for desktop-bound surfaces (Kanban
//                 board, drag/drop builders, the quote/e-signature flow); the route
//                 still resolves on deep-link
//   hideWhen    — hidden while the given perm is held (/clients hides when contacts.view holds)
//   teamOnly    — the TEAM pages (S131): the owner's, an admin's and an Operations Manager's,
//                 never an account manager's (they read their own buildings on Customers). It needs
//                 the viewer, so visible() takes `{ team }` (lib/teamScope seesTeamPages); a caller
//                 that passes none hides the entry (fails closed)
//   enabled     — false hides the entry everywhere (a dormant feature, lib/features.js)
//   badge       — a "NEW"-style pill (opts the row out of the in-review marker)
//   end         — NavLink `end` (exact-match active) for '/'
//   descKey     — the page's one-line description under its name in the Launcher (UI_RULES §182)
//
// LANGUAGES (CS-193): every leaf and group carries `labelKey` (`groupKey`), its line in the
// translation catalog (src/i18n/catalog/en.js); the sidebar and the phone's tray SHOW that,
// in the reader's language. `label` / `group` stay the English the master-search registry
// and search-lint read (search is office-only and English for now). test-i18n-coverage.mjs
// holds every `label` equal to its key's English, so the two cannot drift.
import { MARKETING_ENABLED, QUOTES_ENABLED } from './features.js';

export const NAV = [
  { to: '/',          label: 'Dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', perm: 'dashboard.view', end: true },
  // Daily-work surface, split by ROLE (managerOnly / crewOnly). Both are universal
  // — their perms live in ALWAYS_GRANTED (non-revocable); the split only decides
  // which one shows in the nav. Managers get the full Schedule…
  { to: '/schedule',  label: 'Schedule',  labelKey: 'nav.schedule', descKey: 'nav.desc.schedule', icon: 'schedule',  perm: 'schedule.view', managerOnly: true },
  // …crew get My Day — today's cleans, inline clock-in/out, service instructions +
  // what's upcoming, on one page. (Both routes still resolve on deep-link.)
  { to: '/my-day', label: 'My Day', labelKey: 'nav.myDay', icon: 'schedule', perm: 'time.clock', crewOnly: true },
  { to: '/messaging', label: 'Messaging', labelKey: 'nav.messaging', icon: 'messaging', perm: 'messaging.use' },
  // NB: Drafts is intentionally NOT in this list — Sidebar renders it as a standalone
  // leaf pinned to the bottom of the rail.
  // Customers is a NON-crew surface — crew work from their job cards, not the people list
  // (Daniel; on mobile crew get Quality/Work Orders in that slot instead, see FloatingNav).
  { to: '/contacts',  label: 'Customers', labelKey: 'nav.customers', descKey: 'nav.desc.customers', icon: 'clients',   perm: 'contacts.view', managerOnly: true },
  { to: '/clients',   label: 'Customers', labelKey: 'nav.customers', descKey: 'nav.desc.customers', icon: 'clients',   perm: 'clients.view', hideWhen: 'contacts.view', managerOnly: true },
  { to: '/reports',   label: 'Reports',   labelKey: 'nav.reports', descKey: 'nav.desc.reports', icon: 'chart',     perm: 'reports.view', managerOnly: true },
  // Pipeline is a top-level leaf with the $ icon; there is no "Sales" group (Daniel,
  // 2026-10-03). Desktop only, like the Kanban board it opens.
  { to: '/pipeline',  label: 'Pipeline',  labelKey: 'nav.pipeline', descKey: 'nav.desc.pipeline', icon: 'dollarCircle', perm: 'pipeline.view',  desktopOnly: true },
  // Marketing is dormant (not a contracted section) — gated OFF via MARKETING_ENABLED
  // (lib/features.js). Flip the flag to restore this entry; the route/page still exist.
  { to: '/marketing', label: 'Marketing', labelKey: 'nav.marketing', descKey: 'nav.desc.marketing', icon: 'mail',  perm: 'marketing.view', desktopOnly: true, enabled: MARKETING_ENABLED },
  { group: 'Operations', groupKey: 'nav.operations', icon: 'building', children: [
    // ── Accounts (S131): every account with its account manager — an Operations Manager's team, the
    // office's every account, by OM → AM. Gated like the customer list (clients.view) and to the
    // team pages' viewers (teamOnly). For an OM it is the row after Home (MANAGER_NAV_ORDER).
    // The building, as Matt's Option D draws it: Customers sits beside it in one panel (UI_RULES §182).
    { to: '/team-accounts', label: 'Accounts', labelKey: 'nav.teamAccounts', descKey: 'nav.desc.teamAccounts', icon: 'building', perm: 'clients.view', managerOnly: true, teamOnly: true },
    // ── Manager view (Builder A, 2026-10-09): Shift Check-in, today's clock-ins by visit — who
    // arrived, who is late, who hasn't checked in (Matt's board). Before Approvals; office only. The
    // clock, as Matt's Option D and his own menu (MANAGER_NAV_ORDER) draw it: never Schedule's calendar.
    { to: '/check-in',    label: 'Shift Check-in', labelKey: 'nav.shiftCheckIn', descKey: 'nav.desc.shiftCheckIn', icon: 'clock', perm: 'time.approve', managerOnly: true },
    // Approvals = the manager's daily desk: approve every clock-in/out, missing time and
    // overtime before payroll (W2-U). Gold "NEW" pill; phones allowed. Sits before Time Clock.
    { to: '/approvals',   label: 'Approvals', labelKey: 'nav.approvals', descKey: 'nav.desc.approvals', icon: 'check', perm: 'time.approve', badge: 'NEW' },
    // Time Clock = the crew punch history (Sept 3: managers could not find it —
    // it only lived inside the Variance report's last-night window).
    { to: '/time',        label: 'Time Clock', labelKey: 'nav.timeClock', descKey: 'nav.desc.timeClock', icon: 'schedule', perm: 'time.view' },
    { to: '/variance',    label: 'Variance', labelKey: 'nav.variance', descKey: 'nav.desc.variance', icon: 'chart', perm: 'variance.view' },
    // Payroll — the pay run (hours × rate → gross, custom lines, export). Carries a
    // gold "NEW" badge instead of the in-review marker (badge wins in NavRowMarker).
    { to: '/payroll',     label: 'Payroll', labelKey: 'nav.payroll', descKey: 'nav.desc.payroll', icon: 'invoices', perm: 'payroll.view', badge: 'NEW' },
    // Quality hub folds Inspections · Checklists · Work Orders · Templates into one page.
    // Work Orders is where customer complaints now live (raised from the portal or logged
    // by staff) alongside requests + issues — the standalone Complaints log was folded in. The
    // shield, as Option D and Matt's own menu draw it: Checklists keeps the tick in the same panel.
    { to: '/inspections', label: 'Quality',  labelKey: 'nav.quality', descKey: 'nav.desc.quality', icon: 'shield', perm: 'qc.view' },
    // ── Builder C (the manager view redesign, 2026-10-09) ──
    // Client Requests — the open work orders as Matt's board draws them (D4): the Quality hub's
    // Work Orders list underneath, with the deadlines and a time-left column. Gated as that tab
    // is (problems.manage); managers only, since crew answer from their own visit.
    { to: '/requests', label: 'Client Requests', labelKey: 'nav.clientRequests', descKey: 'nav.desc.clientRequests', icon: 'forms', perm: 'problems.manage', managerOnly: true },
    // ── end Builder C ──
    // ── Manager view (Builder A, 2026-10-09): Checklists, today's checklist for each visit
    // (Matt's board). After Quality, whose Checklists tab keeps the full history; office only.
    { to: '/checklists',  label: 'Checklists', labelKey: 'nav.checklistsToday', descKey: 'nav.desc.checklistsToday', icon: 'check', perm: 'qc.view', managerOnly: true },
    // QR codes (Matt, 2026-10-30: "what about the QR codes? How do I create them? I'm not able to find
    // that"): every building's codes on one page, each location's areas and labels a click away
    // (pages/QrCodes, UI_RULES §183). Gated as the codes are (sites.edit; the page also asks for an
    // office role, lib/scanCodes scanCodesAllowed). On the phone too (its menu, MOBILE_MENU, and
    // search): the page stacks into cards there, and the reply to Matt says it's in the menu.
    { to: '/qr-codes',    label: 'QR codes', labelKey: 'nav.qrCodes', descKey: 'nav.desc.qrCodes', icon: 'qr', perm: 'sites.edit', managerOnly: true },
    { to: '/keys',       label: 'Keys',       labelKey: 'nav.keys', descKey: 'nav.desc.keys', icon: 'lock',    perm: 'keys.view' },
    // Supplies — per-location approved lists + the request queue (S58). Gold "NEW"
    // pill (badge wins over the in-review marker in NavRowMarker). Crew never hold
    // supplies.* so it drops from their flattened Operations nav automatically.
    { to: '/supplies',   label: 'Supplies',   labelKey: 'nav.supplies', descKey: 'nav.desc.supplies', icon: 'box',     perm: 'supplies.view', badge: 'NEW' },
    // Supply Catalog — the org's master supply list, a row of its own under Supplies (task #125): the
    // Supplies page on its Catalog tab, the page a Supply Manager's own Supply Catalog row opens. Its
    // gate and NEW pill are Supplies'; a price tag, so it never repeats the box on the row above.
    // Lit only on that tab (navRowOn), Supplies on the page's other tabs.
    { to: '/supplies?tab=catalog', label: 'Supply Catalog', labelKey: 'nav.supplyCatalog', descKey: 'nav.desc.supplyCatalog', icon: 'tag', perm: 'supplies.view', badge: 'NEW' },
    // Deliveries — the driver's list of what the office sent, and its Delivered button (the
    // delivery step, 2026-10-12). For supplies.deliver holders only: the owner and admin by default,
    // and a driver given the key on a crew login, whose flattened nav shows it like My Day.
    { to: '/deliveries', label: 'Deliveries', labelKey: 'nav.deliveries', descKey: 'nav.desc.deliveries', icon: 'mapPin', perm: 'supplies.deliver' },
    // Reviews hidden for now (not an original ask; needs a live Google connection to be
    // meaningful). Route still exists in App.jsx — re-add this nav item to restore it.
  ] },
  { group: 'Finances', groupKey: 'nav.finances', icon: 'invoices', children: [
    // Quotes is dormant (Matt uses PandaDoc, MISC-7) — gated OFF via QUOTES_ENABLED (lib/features.js).
    { to: '/quotes',   label: 'Quotes',   labelKey: 'nav.quotes', descKey: 'nav.desc.quotes', icon: 'tag',      perm: 'quotes.view', desktopOnly: true, enabled: QUOTES_ENABLED },
    // Contracts — the signed agreements, their year prices, renewals and the book total
    // (CON-1..CON-14). Phones allowed: a manager chasing a renewal is rarely at a desk.
    // Gold "NEW" pill (badge wins over the in-review marker in NavRowMarker).
    { to: '/contracts', label: 'Contracts', labelKey: 'nav.contracts', descKey: 'nav.desc.contracts', icon: 'tag',    perm: 'contracts.view', badge: 'NEW' },
    { to: '/invoices', label: 'Invoices', labelKey: 'nav.invoices', descKey: 'nav.desc.invoices', icon: 'invoices', perm: 'invoices.view' },
  ] },
  // HR — employees, special-service pay, reimbursements, PTO & documents. Top-level
  // leaf with a gold "NEW" pill (owner/manager only, so crew never see it).
  { to: '/hr', label: 'HR', labelKey: 'nav.hr', descKey: 'nav.desc.hr', icon: 'clients', perm: 'hr.view', badge: 'NEW' },
];

// The visibility predicate shared by the sidebar render AND the master-search results
// filter: an entry shows only when it isn't switched off (`enabled`), its perm is held,
// its hideWhen perm is NOT held, and its role/viewport modifiers allow it. `perm` is a
// single key; `permsAny` (used by search actions like "Add customer", visible with
// clients.edit OR contacts.edit) passes when ANY listed key is held; `permsAll` adds keys
// that must ALSO be held (a search sub-tab its page gates tighter than the route, e.g.
// Work orders needs problems.manage on top of qc.view). Nav leaves carry only `perm`, so
// their behavior is unchanged.
// WHO IS CREW — the ONE rule the shell splits on since the Cleaner Hub (2026-10-13):
// layouts/AppLayout gives a crew viewer the phone app (no sidebar, no tray, no search). By the ROLE, not a
// revocable permission, so an override can never half-switch a person between the two shells. The
// owner's View-as a cleaner reads the viewed person's role, so the preview draws the cleaner's app.
export const isCrewRole = (user) => user?.role === 'crew';
// THE SUPPLY MANAGER (S131 Wave 2): by the ROLE too, like the manager's order — their sidebar, phone
// menu and bar are their own app's (supplyNav, SUPPLY_TABS below; UI_RULES §169).
export const isSupplyRole = (user) => user?.role === 'supply_manager';
// A row's PATH, without its query: what "active" compares (the Supply Catalog row opens the Supplies
// page on its Catalog tab, `/supplies?tab=catalog`, and is that page).
export const navPath = (to) => String(to || '').split('?')[0];

// Whether `row` is the lit one among the `rows` drawn beside it, once its PATH matches the page (the
// caller's own test: NavLink's, or the phone's navPath compare). `search` is the URL's query. A row
// alone on its path is lit on its whole page, whatever the query (the Supply Manager's Supply
// Catalog row IS the Supplies page, UI_RULES §169). Two rows on one path (the office's Supplies and
// Supply Catalog, task #125): the row whose query the URL carries is lit, and the plain row only
// while no such row's is.
const queryHeld = (to, search) => {
  const want = new URLSearchParams(String(to || '').split('?')[1] || '');
  const have = new URLSearchParams(search || '');
  for (const [k, v] of want) if (have.get(k) !== v) return false;
  return true;
};
export function navRowOn(row, rows, search) {
  const p = navPath(row.to);
  const twins = (rows || []).filter((r) => r && !r.divider && r.to !== row.to && navPath(r.to) === p);
  if (!twins.length) return true;
  if (String(row.to).includes('?')) return queryHeld(row.to, search);
  return !twins.some((r) => String(r.to).includes('?') && queryHeld(r.to, search));
}

export const visible = (n, check, isMobile, isCrew, { team = false } = {}) =>
  n.enabled !== false
  && (n.permsAny ? n.permsAny.some((k) => check(k)) : check(n.perm))
  && (!n.permsAll || n.permsAll.every((k) => check(k)))
  && (!n.hideWhen || !check(n.hideWhen)) && !(n.desktopOnly && isMobile)
  && !(n.crewOnly && !isCrew) && !(n.managerOnly && isCrew)
  && !(n.teamOnly && !team);

// The mobile FloatingNav's always-visible tray: up to four primary tabs. Shared (not
// re-declared) so the search launchpad's "Go to" grid skips exactly what the tray
// already shows. Customers resolves to /contacts (people list) or /clients, matching the
// sidebar. OFFICE viewers only: a cleaner's app has no tray at all since the Cleaner Hub
// (layouts/AppLayout's crew shell, UI_RULES §165) — the crew tray (My Day · Messaging ·
// Quality) went with it (2026-10-14).
// `supply`: the viewer is a SUPPLY MANAGER (isSupplyRole). Their app has its own bar (S131 Wave 2,
// UI_RULES §169): the Order Queue as Home, the Supply Catalog and Messages — the three pages of their
// day, each shown only while they hold it — never a tab of the office bar they have no use for or
// cannot open. A tab is narrow, so its word is the short one (Orders, Catalog), as the manager's bar
// says "Dashboard" where their menu says "Home". Every other office role's bar is exactly as it was
// (UI_RULES §152).
export const SUPPLY_TABS = [
  { to: '/', label: 'Orders', labelKey: 'nav.tab.orders', icon: 'dashboard', end: true, perm: 'dashboard.view' },
  { to: '/supplies?tab=catalog', label: 'Catalog', labelKey: 'nav.tab.catalog', icon: 'box', perm: 'supplies.view' },
  { to: '/messaging', label: 'Messages', labelKey: 'nav.messages', icon: 'messaging', perm: 'messaging.use' },
];
export function mobileTabs(check, { supply = false } = {}) {
  if (supply) return SUPPLY_TABS.filter((t) => check(t.perm));
  const custPerm = check('contacts.view') ? 'contacts.view' : check('clients.view') ? 'clients.view' : null;
  const custTo = check('contacts.view') ? '/contacts' : '/clients';
  const sched = { to: '/schedule', label: 'Schedule', labelKey: 'nav.schedule', perm: 'schedule.view' };
  const fourthTab = custPerm ? { to: custTo, label: 'Customers', labelKey: 'nav.customers', icon: 'clients', perm: custPerm } : null;
  return [
    { to: '/', label: 'Dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', end: true, perm: 'dashboard.view' },
    { to: sched.to, label: sched.label, labelKey: sched.labelKey, icon: 'schedule', perm: sched.perm },
    { to: '/messaging', label: 'Messaging', labelKey: 'nav.messaging', icon: 'messaging', perm: 'messaging.use' },
    fourthTab,
  ].filter(Boolean).filter((t) => check(t.perm));
}

// Every leaf, flattened — top-level leaves plus the children of every group, in
// declared order. Group headers themselves are not routable, so they are dropped;
// each surviving leaf keeps its own modifiers. This is the raw material the search
// registry turns into "Pages".
export function navLeaves() {
  const out = [];
  for (const entry of NAV) {
    if (entry.children) out.push(...entry.children);
    else out.push(entry);
  }
  return out;
}

// ── THE MANAGER'S SHELL (the manager view redesign, Builder B — UI_RULES §152) ─────────────────
// Daniel's D2 (2026-10-09): "As long as the bottom elements are the same, go ahead and match to
// what he wanted for the breakout nav bar." For a MANAGER the desktop sidebar and the phone's
// "Go to" menu show Matt's order (his Account Manager Hub boards), then a line, Messages and
// Account, and EVERY other page the manager could open before under "More", in today's order —
// no page is lost. On the desktop that "More" is drawn as the Launcher's sections (UI_RULES §182),
// as the owner's and an admin's pages are; on the phone it stays a list. The bottom bar
// (`mobileTabs` above) does not change for anyone. test-manager-shell.mjs holds all of this.

// The two rail rows Sidebar draws OUTSIDE NAV (Settings, and Review pinned to the bottom), and
// the Account row the manager's order adds. Kept out of NAV on purpose: the search registry
// derives its Pages from NAV and already has its own rows for /settings, /settings/account and
// /review (a second would be a duplicate result).
export const SETTINGS_LEAF = { to: '/settings', label: 'Settings', labelKey: 'nav.settings', icon: 'settings', perm: 'settings.account' };
export const REVIEW_LEAF = { to: '/review', label: 'Review', labelKey: 'nav.review', icon: 'edit', perm: 'drafts.view', desktopOnly: true };
const ACCOUNT_LEAF = { to: '/settings/account', label: 'Account', labelKey: 'nav.account', icon: 'user', perm: 'settings.account' };

// The phone menu's own list for everyone who is not a manager (owner, admin, crew): the
// secondary sections, moved here verbatim from FloatingNav.jsx so the manager's menu can prove
// it keeps every one of them. Review is desktop-only, so it has no entry. `isNew` = the gold
// NEW pill. The manager view's new pages join it where they belong (D2:
// "the owner and admins keep today's nav; the new pages join it"): Client Requests after Quality,
// office-only like its NAV leaf (`managerOnly`: crew hold `problems.manage`, but not this page), and
// Shift Check-in and Checklists today the same way (office-only, beside the rows they follow in NAV).
export const MOBILE_MENU = [
  { to: '/team-accounts', labelKey: 'nav.teamAccounts', icon: 'clients', perm: 'clients.view', managerOnly: true, teamOnly: true },
  { to: '/check-in', labelKey: 'nav.shiftCheckIn', icon: 'schedule', perm: 'time.approve', managerOnly: true },
  { to: '/time', labelKey: 'nav.timeClock', icon: 'schedule', perm: 'time.view' },
  { to: '/variance', labelKey: 'nav.variance', icon: 'chart', perm: 'variance.view' },
  { to: '/payroll', labelKey: 'nav.payroll', icon: 'invoices', perm: 'payroll.view', isNew: true },
  { to: '/hr', labelKey: 'nav.hr', icon: 'clients', perm: 'hr.view', isNew: true },
  { to: '/inspections', labelKey: 'nav.quality', icon: 'check', perm: 'qc.view' },
  { to: '/requests', labelKey: 'nav.clientRequests', icon: 'forms', perm: 'problems.manage', managerOnly: true },
  { to: '/checklists', labelKey: 'nav.checklistsToday', icon: 'check', perm: 'qc.view', managerOnly: true },
  // Every building's QR codes (Matt, 2026-10-30; UI_RULES §183), after the checklists as in the
  // desktop's Operations, gated as its NAV leaf.
  { to: '/qr-codes', labelKey: 'nav.qrCodes', icon: 'qr', perm: 'sites.edit', managerOnly: true },
  { to: '/keys', labelKey: 'nav.keys', icon: 'lock', perm: 'keys.view' },
  { to: '/supplies', labelKey: 'nav.supplies', icon: 'box', perm: 'supplies.view', isNew: true },
  // The Supply Catalog, under Supplies as in the sidebar's Operations menu (task #125).
  { to: '/supplies?tab=catalog', labelKey: 'nav.supplyCatalog', icon: 'tag', perm: 'supplies.view', isNew: true },
  // The driver's page (the delivery step, 2026-10-12) — a driver on a crew login reads it here.
  { to: '/deliveries', labelKey: 'nav.deliveries', icon: 'mapPin', perm: 'supplies.deliver' },
  { to: '/invoices', labelKey: 'nav.invoices', icon: 'invoices', perm: 'invoices.view' },
  { to: '/settings', labelKey: 'nav.settings', icon: 'settings', perm: 'settings.account' },
];
// What that menu shows a viewer: what they may open, never a tab the bar already shows. Office
// viewers only, like the tray (the crew shell draws no menu). `team`: whether the viewer sees the
// team pages (lib/teamScope seesTeamPages) — Accounts is theirs only.
export function mobileMenu(check, { team = false } = {}) {
  const tray = new Set(mobileTabs(check).map((t) => t.to));
  return MOBILE_MENU.filter((m) => check(m.perm) && !tray.has(m.to) && !(m.teamOnly && !team));
}

// Matt's order (web-0N's sidebar, top to bottom), BY PATH. Each row is looked up among the leaves
// that exist, so a page this branch does not carry yet (Shift Check-in, Client Requests,
// Checklists — Builders A and C) is simply skipped and takes its place the day its leaf lands in
// NAV. `label` / `labelKey` relabel a row for the manager only: the Quality hub reads
// "Inspections", Approvals "Hours Approval", Messaging "Messages", and "/" reads "Home" (the
// bottom tab keeps "Dashboard" — the bar does not change). `icon` redraws a row with the board's
// glyph (Wave B): Home's house, the clocks of Shift Check-in and Hours Approval, Inspections'
// shield — so no two neighbouring rows share a check.
export const MANAGER_NAV_ORDER = [
  { to: '/', label: 'Home', labelKey: 'nav.home', icon: 'home' },
  // S131: an Operations Manager's Accounts page, right after Home. teamOnly, so an account manager
  // never gets the row (managerNav's `team` is false for them) and it is never in their "More".
  { to: '/team-accounts' },
  { to: '/schedule' },
  { to: '/check-in', icon: 'clock' },
  { to: '/inspections', label: 'Inspections', labelKey: 'nav.inspections', icon: 'shield' },
  { to: '/approvals', label: 'Hours Approval', labelKey: 'nav.hoursApproval', icon: 'clock' },
  { to: '/requests' },
  { to: '/checklists' },
  { to: '/supplies' },
  // The Supply Catalog right after Supplies, as in the owner's Operations menu (task #125).
  { to: '/supplies?tab=catalog' },
  { divider: true },
  { to: '/messaging', label: 'Messages', labelKey: 'nav.messages' },
  { to: '/settings/account' },
];

// An ORDERED nav for one surface → { primary: [leaf | { divider: true }], more: [leaf] }: the rows of
// `order`, each looked up BY PATH among the leaves that exist (a row's `leaf` names the page it opens
// when its own `to` adds a query: the Supply Catalog row is the Supplies page's leaf on its Catalog
// tab), then "More" with every other leaf the surface offered before.
//   isMobile  the phone (≤640): desktop-only pages drop, and the phone menu's own extras (its
//             Reviews row) join the candidates for More, so nothing the menu offered is lost;
//   tray      the bar's paths on the phone: never repeated in the menu (FloatingNav's rule);
//   leaves    the leaves to look the order up in (default: NAV's) — a test hands in A's and C's;
//   team      the viewer sees the team pages (an Operations Manager, S131): Accounts takes its row.
// "More" is every leaf the surface offered before (NAV's leaves in NAV order, then Settings, then
// Review; on the phone also MOBILE_MENU), minus what the order placed.
function orderedNav(order, check, { isMobile = false, tray = null, leaves = navLeaves(), team = false } = {}) {
  // The bar's pages by PATH: a tab with a query (the Supply Catalog's) is its page, which the menu
  // then never repeats.
  const trayPaths = new Set((tray || []).map(navPath));
  const shown = (leaf) => visible(leaf, check, isMobile, false, { team }) && !trayPaths.has(navPath(leaf.to));
  const pool = new Map();
  for (const leaf of [...leaves, SETTINGS_LEAF, ACCOUNT_LEAF]) if (!pool.has(leaf.to)) pool.set(leaf.to, leaf);
  const primary = [];
  const placed = new Set();
  for (const row of order) {
    if (row.divider) { primary.push({ divider: true }); continue; }
    const leaf = pool.get(row.leaf || row.to);
    if (!leaf) continue;
    const entry = {
      ...leaf,
      to: row.to,
      ...(row.labelKey ? { label: row.label, labelKey: row.labelKey } : {}),
      ...(row.icon ? { icon: row.icon } : {}),
    };
    if (!shown(entry)) continue;
    primary.push(entry);
    // The leaf AND the row's own path: the Supply Manager's Supply Catalog row is the Supplies leaf on
    // its Catalog tab, so the office's Supply Catalog leaf never shows a second time under More.
    placed.add(leaf.to);
    placed.add(entry.to);
  }
  // A line only BETWEEN rows: never first, last or doubled.
  const rows = primary.filter((r, i) => !r.divider || (i > 0 && !primary[i - 1].divider && primary.slice(i + 1).some((x) => !x.divider)));
  const more = [];
  const seen = new Set();
  for (const leaf of [...leaves, SETTINGS_LEAF, ...(isMobile ? MOBILE_MENU : [])]) {
    if (seen.has(leaf.to) || placed.has(leaf.to)) continue;
    seen.add(leaf.to);
    if (shown(leaf)) more.push(leaf);
  }
  return { primary: rows, more };
}

// The manager's nav for one surface (Matt's order, UI_RULES §152).
export function managerNav(check, opts = {}) {
  return orderedNav(MANAGER_NAV_ORDER, check, opts);
}

// ── THE SUPPLY MANAGER'S SHELL (S131 Wave 2, plan 2026-10-14 §0 "Home and nav"; UI_RULES §169) ──
// Matt's Supply Manager Hub (sm-web-01..03): the sidebar is Order Queue · Supply Catalog · Reports;
// here a line, Messages and Account follow (the manager's ending), then "More" with every other page
// the role can open (Schedule, Deliveries, Settings on the defaults), so nothing is lost; on the
// desktop that "More" is the Launcher's sections and Settings sits in the menu's foot (§182). The queue
// is `/` — HomeRoute draws pages/SupplyHome for this role — on the Dashboard leaf's own gate; the
// catalog is the Supplies page on its Catalog tab, so the Supplies page itself is never offered twice.
export const SUPPLY_NAV_ORDER = [
  { to: '/', label: 'Order Queue', labelKey: 'nav.orderQueue', icon: 'dashboard' },
  { to: '/supplies?tab=catalog', leaf: '/supplies', label: 'Supply Catalog', labelKey: 'nav.supplyCatalog', icon: 'box' },
  { to: '/reports' },
  { divider: true },
  { to: '/messaging', label: 'Messages', labelKey: 'nav.messages' },
  { to: '/settings/account' },
];
export function supplyNav(check, opts = {}) {
  return orderedNav(SUPPLY_NAV_ORDER, check, opts);
}

// ── THE LAUNCHER (DES-1, Matt's pick "D", 2026-10-27; built 2026-10-30, UI_RULES §182) ──────────────
// Matt (2026-10-30): "I selected Option D for the launcher, as I believe it is easier to see than the
// dropdown option." The desktop menu holds a few rows and the SECTIONS, never their pages: a section
// opens a panel beside the menu with each group in its own column, every page named and described
// (components/Sidebar). Daniel's pick (2026-10-30): everyone gets it. The owner and an admin see Dashboard
// and Messaging, then the sections; a manager and a supply manager keep their own rows (Matt's boards)
// and their "More" becomes the sections. The phone keeps its bar and its menu's list (MOBILE_MENU).
//
// Each section's groups name their pages BY PATH, so a page shows only where it is listed and only
// to whoever may open it (the caller hands in the leaves it may draw, already filtered). The order of
// the paths is the order of the tiles. A page this table doesn't list still shows, in a last "More"
// section, so nothing can go missing (scripts/test-launcher-nav.mjs holds every NAV leaf to one place).
export const LAUNCHER_HOME = ['/', '/messaging'];
export const LAUNCHER_SECTIONS = [
  { id: 'ops', labelKey: 'nav.operations', icon: 'building', groups: [
    { labelKey: 'nav.group.today', paths: ['/schedule', '/check-in', '/checklists', '/keys'] },
    { labelKey: 'nav.group.serviceQuality', paths: ['/inspections', '/requests', '/qr-codes'] },
  ] },
  { id: 'team', labelKey: 'nav.section.team', icon: 'user', groups: [
    { labelKey: 'nav.group.time', paths: ['/time', '/approvals', '/variance'] },
    { labelKey: 'nav.group.payPeople', paths: ['/payroll', '/hr'] },
  ] },
  { id: 'cust', labelKey: 'nav.customers', icon: 'clients', groups: [
    { labelKey: 'nav.group.directory', paths: ['/contacts', '/clients', '/team-accounts'] },
    { labelKey: 'nav.group.sales', paths: ['/pipeline', '/quotes', '/contracts', '/marketing'] },
  ] },
  // `lineKey`: the line under the section's name while two or more of its pages show (Option D's own
  // words); one page alone is named instead.
  { id: 'supply', labelKey: 'nav.supplies', icon: 'box', lineKey: 'nav.line.supplies', groups: [
    { labelKey: null, paths: ['/supplies', '/supplies?tab=catalog', '/deliveries'] },
  ] },
  { id: 'money', labelKey: 'nav.section.finance', icon: 'invoices', groups: [
    { labelKey: null, paths: ['/invoices', '/reports'] },
  ] },
];
// The two rows the menu's foot draws (Settings and Review): never a tile.
const LAUNCHER_FOOT = new Set([SETTINGS_LEAF.to, REVIEW_LEAF.to]);

// The sections for `leaves` (the pages this viewer's menu offers, each already passed by visible()):
// [{ id, labelKey, icon, lineKey, groups: [{ labelKey, leaves }], leaves }], in the table's order, a group or
// section with no page left out. Home rows and the foot's rows are never tiles. `home`: the paths
// drawn as rows above the sections (the owner's Dashboard and Messaging); a manager's rows are not in
// `leaves` at all (their "More" is).
export function launcherSections(leaves, { home = [] } = {}) {
  const skip = new Set([...home, ...LAUNCHER_FOOT]);
  const byTo = new Map();
  for (const leaf of leaves || []) if (leaf && !leaf.divider && !skip.has(leaf.to) && !byTo.has(leaf.to)) byTo.set(leaf.to, leaf);
  const placed = new Set();
  const out = [];
  for (const sec of LAUNCHER_SECTIONS) {
    const groups = sec.groups.map((g) => ({
      labelKey: g.labelKey,
      leaves: g.paths.map((p) => byTo.get(p)).filter(Boolean),
    })).filter((g) => g.leaves.length > 0);
    if (!groups.length) continue;
    for (const g of groups) for (const l of g.leaves) placed.add(l.to);
    out.push({ id: sec.id, labelKey: sec.labelKey, icon: sec.icon, lineKey: sec.lineKey || null, groups, leaves: groups.flatMap((g) => g.leaves) });
  }
  const rest = [...byTo.values()].filter((l) => !placed.has(l.to));
  if (rest.length) out.push({ id: 'more', labelKey: 'nav.more', icon: 'dots', groups: [{ labelKey: null, leaves: rest }], leaves: rest });
  return out;
}

// What a section's row says under its name, short enough for its one line (Option D's words): the
// names of its groups that show ("Time · Pay & people"; an admin without Payroll or HR reads "Time"),
// or its own line while two or more of its pages show ("Orders and deliveries"), or else its pages'
// names ("Invoices · Reports"), so it never names a page the viewer can't open. A page named as its
// section is left out, unless it is all there is. Returns catalog keys; the caller translates and
// joins them with " · ". (Every page's name was too long: "Time Clock · Approvals · Variance" and
// "Supply Catalog · Deliveries" were cut off.)
export function launcherBlurbKeys(section) {
  const named = (section?.groups || []).filter((g) => g.labelKey);
  if (named.length) return named.map((g) => g.labelKey);
  const pages = (section?.leaves || []).map((l) => l.labelKey);
  if (section?.lineKey && pages.length > 1) return [section.lineKey];
  const others = pages.filter((k) => k !== section?.labelKey);
  return others.length ? others : pages;
}

// Whether `leaf` is the page on screen: its path is the page's (or the page is under it), '/' only
// exactly, and of two rows on one path the one whose query the URL carries (navRowOn).
export function leafOn(leaf, rows, pathname, search) {
  const p = navPath(leaf?.to);
  const here = String(pathname || '');
  const match = p === '/' ? here === '/' : (here === p || here.startsWith(`${p}/`));
  return match && navRowOn(leaf, rows, search);
}
