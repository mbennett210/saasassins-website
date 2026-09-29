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
// A top-level entry is either a LEAF ({to,label,icon,perm,...}) or a collapsible
// GROUP ({group,icon,children:[leaf,...]}). Sales, Operations & Finances group the
// secondary tools; the active route's group auto-expands. Crew (no schedule.edit)
// instead get the Operations children flattened to top-level leaves — a flat nav, no
// group header (see Sidebar's render loop). A group whose visible children all resolve
// away (e.g. Sales on mobile) is dropped. Modifiers on a leaf:
//   managerOnly — hidden from crew (Schedule, Customers, Reports)
//   crewOnly    — shown only to crew (My Day)
//   desktopOnly — hidden on the mobile nav (≤640) for desktop-bound surfaces (Kanban
//                 board, drag/drop builders, the quote/e-signature flow); the route
//                 still resolves on deep-link
//   hideWhen    — hidden while the given perm is held (/clients hides when contacts.view holds)
//   enabled     — false hides the entry everywhere (a dormant feature, lib/features.js)
//   badge       — a "NEW"-style pill (opts the row out of the in-review marker)
//   end         — NavLink `end` (exact-match active) for '/'
import { MARKETING_ENABLED } from './features.js';
import { HOME_PATH } from '../demo/demoConfig';

export const NAV = [
  { to: HOME_PATH,   label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view', end: true },
  // Daily-work surface, split by ROLE (managerOnly / crewOnly). Both are universal
  // — their perms live in ALWAYS_GRANTED (non-revocable); the split only decides
  // which one shows in the nav. Managers get the full Schedule…
  { to: '/schedule',  label: 'Schedule',  icon: 'schedule',  perm: 'schedule.view', managerOnly: true },
  // …crew get My Day — today's cleans, inline clock-in/out, service instructions +
  // what's upcoming, on one page. (Both routes still resolve on deep-link.)
  { to: '/my-day', label: 'My Day', icon: 'schedule', perm: 'time.clock', crewOnly: true },
  { to: '/messaging', label: 'Messaging', icon: 'messaging', perm: 'messaging.use' },
  // NB: Drafts is intentionally NOT in this list — Sidebar renders it as a standalone
  // leaf pinned to the bottom of the rail.
  // Customers is a NON-crew surface — crew work from their job cards, not the people list
  // (Daniel; on mobile crew get Quality/Work Orders in that slot instead, see FloatingNav).
  { to: '/contacts',  label: 'Customers', icon: 'clients',   perm: 'contacts.view', managerOnly: true },
  { to: '/clients',   label: 'Customers',   icon: 'clients',   perm: 'clients.view', hideWhen: 'contacts.view', managerOnly: true },
  { to: '/reports',   label: 'Reports',   icon: 'chart',     perm: 'reports.view', managerOnly: true },
  { group: 'Sales', icon: 'dollarCircle', children: [
    { to: '/pipeline',  label: 'Pipeline',  icon: 'chart', perm: 'pipeline.view',  desktopOnly: true },
    // Marketing is dormant (not a contracted section) — gated OFF via MARKETING_ENABLED
    // (lib/features.js). Flip the flag to restore this entry; the route/page still exist.
    { to: '/marketing', label: 'Marketing', icon: 'mail',  perm: 'marketing.view', desktopOnly: true, enabled: MARKETING_ENABLED },
  ] },
  { group: 'Operations', icon: 'building', children: [
    // Time Clock = the crew punch history (Sept 3: managers could not find it —
    // it only lived inside the Variance report's last-night window).
    { to: '/time',        label: 'Time Clock', icon: 'schedule', perm: 'time.view' },
    { to: '/variance',    label: 'Variance', icon: 'chart', perm: 'variance.view' },
    // Payroll — the pay run (hours × rate → gross, custom lines, export). Carries a
    // gold "NEW" badge instead of the in-review marker (badge wins in NavRowMarker).
    { to: '/payroll',     label: 'Payroll', icon: 'invoices', perm: 'payroll.view', badge: 'NEW' },
    // Quality hub folds Inspections · Checklists · Work Orders · Templates into one page.
    // Work Orders is where customer complaints now live (raised from the portal or logged
    // by staff) alongside requests + issues — the standalone Complaints log was folded in.
    { to: '/inspections', label: 'Quality',  icon: 'check', perm: 'qc.view' },
    { to: '/keys',       label: 'Keys',       icon: 'lock',    perm: 'keys.view' },
    // Supplies — per-location approved lists + the request queue (S58). Gold "NEW"
    // pill (badge wins over the in-review marker in NavRowMarker). Crew never hold
    // supplies.* so it drops from their flattened Operations nav automatically.
    { to: '/supplies',   label: 'Supplies',   icon: 'box',     perm: 'supplies.view', badge: 'NEW' },
    // Reviews hidden for now (not an original ask; needs a live Google connection to be
    // meaningful). Route still exists in App.jsx — re-add this nav item to restore it.
  ] },
  { group: 'Finances', icon: 'invoices', children: [
    { to: '/quotes',   label: 'Quotes',   icon: 'tag',      perm: 'quotes.view', desktopOnly: true },
    { to: '/invoices', label: 'Invoices', icon: 'invoices', perm: 'invoices.view' },
  ] },
  // HR — employees, special-service pay, reimbursements, PTO & documents. Top-level
  // leaf with a gold "NEW" pill (owner/manager only, so crew never see it).
  { to: '/hr', label: 'HR', icon: 'clients', perm: 'hr.view', badge: 'NEW' },
];

// The visibility predicate shared by the sidebar render AND the master-search results
// filter: an entry shows only when it isn't switched off (`enabled`), its perm is held,
// its hideWhen perm is NOT held, and its role/viewport modifiers allow it. `perm` is a
// single key; `permsAny` (used by search actions like "Add customer", visible with
// clients.edit OR contacts.edit) passes when ANY listed key is held; `permsAll` adds keys
// that must ALSO be held (a search sub-tab its page gates tighter than the route, e.g.
// Work orders needs problems.manage on top of qc.view). Nav leaves carry only `perm`, so
// their behavior is unchanged.
export const visible = (n, check, isMobile, isCrew) =>
  n.enabled !== false
  && (n.permsAny ? n.permsAny.some((k) => check(k)) : check(n.perm))
  && (!n.permsAll || n.permsAll.every((k) => check(k)))
  && (!n.hideWhen || !check(n.hideWhen)) && !(n.desktopOnly && isMobile)
  && !(n.crewOnly && !isCrew) && !(n.managerOnly && isCrew);

// The mobile FloatingNav's always-visible tray: up to four primary tabs. Shared (not
// re-declared) so the search launchpad's "Go to" grid skips exactly what the tray
// already shows. Managers get Schedule; crew get My Day. Customers resolves to /contacts
// (people list) or /clients, matching the sidebar. Crew don't get the Customers
// people-list (everything they need is on the job cards): their 4th slot is Quality
// (Work Orders, where the complaints/issues they respond to live).
export function mobileTabs(check, isCrew) {
  const custPerm = check('contacts.view') ? 'contacts.view' : check('clients.view') ? 'clients.view' : null;
  const custTo = check('contacts.view') ? '/contacts' : '/clients';
  const sched = isCrew
    ? { to: '/my-day', label: 'My Day', perm: 'time.clock' }
    : { to: '/schedule', label: 'Schedule', perm: 'schedule.view' };
  const fourthTab = isCrew
    ? { to: '/inspections', label: 'Quality', icon: 'check', perm: 'qc.view' }
    : (custPerm ? { to: custTo, label: 'Customers', icon: 'clients', perm: custPerm } : null);
  return [
    { to: HOME_PATH, label: 'Dashboard', icon: 'dashboard', end: true, perm: 'dashboard.view' },
    { to: sched.to, label: sched.label, icon: 'schedule', perm: sched.perm },
    { to: '/messaging', label: 'Messaging', icon: 'messaging', perm: 'messaging.use' },
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
