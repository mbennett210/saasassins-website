// The manager's shell (the manager view redesign, plan §2.1 D2; UI_RULES §152).
//
// Daniel, 2026-10-09: "As long as the bottom elements are the same, go ahead and match to what he
// wanted for the breakout nav bar." So:
//   1. a MANAGER's sidebar and phone "Go to" menu show Matt's order (Home, Schedule, Shift
//      Check-in, Inspections, Hours Approval, Client Requests, Checklists, Supplies, Supply Catalog
//      (task #125), a line, Messages, Account), each leaf looked up BY PATH so one not on this branch
//      yet is skipped;
//   2. NO PAGE IS LOST: every leaf a manager could open before is in that order or under "More";
//   3. the phone's bottom bar (`mobileTabs`) is EXACTLY what it was, for every role;
//   4. the owner and admin keep today's nav; the search launchpad still skips what the bar shows;
//   5. Home: `HomeRoute` sends a manager to ManagerHome, the owner gets the cockpit with a
//      "Owner cockpit · Manager view" switch, and the P&L board has its own page (`/pnl`,
//      `financials.view`) with a search entry and a back-pill name.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying on
// the first missing export. Offline. Run: node scripts/test-manager-shell.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const nav = await import('../src/lib/navData.js').catch(() => ({}));
const roles = await import('../src/lib/roles.js');
const core = await import('../src/i18n/core.js');
const registry = await import('../src/lib/masterSearch/registry.js').catch(() => ({}));
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);

// A permission checker for a role on the shipped defaults, with optional per-user revokes.
const checkerFor = (role, revokes = []) => {
  const user = { id: `u_${role}`, role };
  const overrides = revokes.length ? [{ userId: user.id, grants: [], revokes }] : [];
  return (key) => roles.can(user, key, undefined, overrides);
};
const paths = (list) => (list || []).map((e) => (e.divider ? '—' : e.to));
const show = (v) => JSON.stringify(v);

// ── 1. Matt's order, as drawn (web-0N sidebar; plan §2.1 D2) ─────────────────────────────────
// The spec itself: the paths of his sidebar, top to bottom, with the line between Supplies and
// Messages. MANAGER_NAV_ORDER is the constant the shell renders from; it must say this. Task #125
// put the Supply Catalog (the Supplies page on its Catalog tab) right after Supplies.
const MATT = ['/', '/schedule', '/check-in', '/inspections', '/approvals', '/requests', '/checklists', '/supplies', '/supplies?tab=catalog', '—', '/messaging', '/settings/account'];
// S131 (plan 2026-10-14 §0): an Operations Manager's Accounts page is the row right after Home —
// theirs only (teamOnly): an account manager's order is Matt's, exactly as before.
const OM_ORDER = ['/', '/team-accounts', ...MATT.slice(1)];
const ORDER = nav.MANAGER_NAV_ORDER || [];
ok(`MANAGER_NAV_ORDER is Matt's order with the OM's Accounts row after Home (${show(paths(ORDER))})`, show(paths(ORDER)) === show(OM_ORDER));
const labelOf = (to) => ORDER.find((o) => o.to === to)?.labelKey;
ok('the manager\'s first row reads "Home" (the bottom tab keeps "Dashboard")',
  labelOf('/') === 'nav.home' && core.english('nav.home') === 'Home' && core.english('nav.dashboard') === 'Dashboard');
ok('the Quality hub row reads "Inspections" for a manager', labelOf('/inspections') === 'nav.inspections' && core.english('nav.inspections') === 'Inspections');
ok('Approvals reads "Hours Approval" for a manager', labelOf('/approvals') === 'nav.hoursApproval' && core.english('nav.hoursApproval') === 'Hours Approval');
ok('Messaging reads "Messages" for a manager', labelOf('/messaging') === 'nav.messages' && core.english('nav.messages') === 'Messages');
const overridden = ORDER.filter((o) => o.labelKey);
ok(`every relabelled row's English label is its key's English (${overridden.filter((o) => core.english(o.labelKey) !== o.label).map((o) => o.to).join(', ') || 'none'})`,
  overridden.length > 0 && overridden.every((o) => o.label && core.english(o.labelKey) === o.label));

// ── 2. the order renders BY PATH, skipping what this branch does not carry yet ───────────────
const managerNav = fn(nav, 'managerNav');
const mgr = checkerFor('manager');
const desk = managerNav(mgr, { isMobile: false }) || {};
const leafPaths = new Set([...(fn(nav, 'navLeaves')() || []).map((l) => l.to), '/settings', '/review', '/settings/account']);
const expectedDesk = MATT.filter((p) => p === '—' || leafPaths.has(p));
ok(`a manager's sidebar is Matt's order with absent leaves skipped (${show(paths(desk.primary))})`,
  show(paths(desk.primary)) === show(expectedDesk));
ok('the "/" row is exact-match (end) and labelled Home', (desk.primary || []).some((l) => l.to === '/' && l.end === true && l.labelKey === 'nav.home'));
ok('the account row reads "Account" and opens the account settings', (desk.primary || []).some((l) => l.to === '/settings/account' && l.labelKey === 'nav.account' && l.perm === 'settings.account')
  && core.english('nav.account') === 'Account');
// The leaves Builders A and C add arrive with their branches: given them, they slot in place.
const extra = [
  { to: '/check-in', label: 'Shift Check-in', labelKey: 'nav.dashboard', icon: 'schedule', perm: 'time.approve' },
  { to: '/requests', label: 'Client Requests', labelKey: 'nav.dashboard', icon: 'forms', perm: 'qc.view' },
  { to: '/checklists', label: 'Checklists', labelKey: 'nav.dashboard', icon: 'check', perm: 'qc.view' },
];
const merged = managerNav(mgr, { isMobile: false, leaves: [...(fn(nav, 'navLeaves')() || []), ...extra] }) || {};
ok(`once A's and C's leaves exist they take their places in the order (${show(paths(merged.primary))})`,
  show(paths(merged.primary)) === show(MATT));

// ── 2b. the Operations Manager's row (S131) ─────────────────────────────────────────────────
{
  const omDesk = managerNav(mgr, { isMobile: false, team: true }) || {};
  const expectedOm = OM_ORDER.filter((p) => p === '—' || leafPaths.has(p));
  ok(`an OM's sidebar: Home, then Accounts, then Matt's order (${show(paths(omDesk.primary))})`, show(paths(omDesk.primary)) === show(expectedOm)
    && paths(omDesk.primary)[1] === '/team-accounts');
  const amAll = [...(desk.primary || []), ...(desk.more || [])].map((l) => l.to);
  ok('🔴 an account manager never gets Accounts — not in the order, not under More', !amAll.includes('/team-accounts'));
  const leaf = (fn(nav, 'navLeaves')() || []).find((l) => l.to === '/team-accounts');
  ok('the Accounts leaf is the team pages\' (teamOnly), gated like the customer list', !!leaf && leaf.teamOnly === true && leaf.perm === 'clients.view' && leaf.labelKey === 'nav.teamAccounts'
    && core.english('nav.teamAccounts') === 'Accounts');
  const owner = checkerFor('owner');
  ok('the owner\'s NAV shows Accounts (team: true); a viewer the predicate is not told about never does',
    nav.visible?.(leaf, owner, false, false, { team: true }) === true && nav.visible?.(leaf, owner, false, false) === false);
  ok('the owner\'s and admin\'s phone menu lists Accounts; without the team flag it does not',
    (fn(nav, 'mobileMenu')(owner, { team: true }) || []).some((m) => m.to === '/team-accounts')
    && !(fn(nav, 'mobileMenu')(owner) || []).some((m) => m.to === '/team-accounts'));
  const omPhone = managerNav(mgr, { isMobile: true, tray: ['/', '/schedule', '/messaging', '/contacts'], team: true }) || {};
  ok('an OM\'s phone menu carries Accounts once, after Home', paths(omPhone.primary)[0] === '/team-accounts'
    && [...(omPhone.primary || []), ...(omPhone.more || [])].filter((l) => l.to === '/team-accounts').length === 1);
  const side = read('src/components/Sidebar.jsx');
  const fnav = read('src/components/FloatingNav.jsx');
  ok('the sidebar and the phone menu pass the team flag (lib/teamScope seesTeamPages)', /const team = seesTeamPages\(currentUser\);/.test(side)
    && /managerNav\(check, \{ isMobile, team \}\)/.test(side) && /const team = seesTeamPages\(user\);/.test(fnav) && /mobileMenu\(check, \{ team \}\)/.test(fnav));
  const page = (registry.PAGE_ENTRIES || []).find((e) => e.to === '/team-accounts');
  ok('search finds Accounts for the team viewers only, gated like its route',
    !!page && page.perm === 'clients.view' && page.teamOnly === true
    && (fn(registry, 'buildNavEntries')(owner, false, { team: true }) || []).some((e) => e.to === '/team-accounts')
    && !(fn(registry, 'buildNavEntries')(mgr, false, { team: false }) || []).some((e) => e.to === '/team-accounts'));
  ok('the back pill names Accounts', /pathname === '\/team-accounts'\) return 'nav\.teamAccounts'/.test(read('src/hooks/useFromHere.js')));
  const owner2 = read('src/pages/OwnerHome.jsx');
  // Leaving a view drops its own filters (the OM pick `om` among them): lib/ownerViews, run under
  // node in test-supply-shell.mjs §4.
  ok('the owner\'s switch gains the Operations view (?view=ops), the OM Home acting as the owner', /const OPS_VIEW = 'ops';/.test(owner2)
    && /<ManagerHome opsView \/>/.test(owner2) && core.english('mgrHome.switch.ops') === 'Operations view'
    && /ownerViewParams\(params, next\)/.test(owner2) && /'om'/.test(read('src/lib/ownerViews.js')));
}

// ── 3. no page is lost ───────────────────────────────────────────────────────────────────────
// BEFORE = what each surface offered a manager on the pre-change tree: the sidebar's NAV leaves
// plus its two standalone rows (Settings, Review); the phone menu's own list (MOBILE_MENU, moved
// verbatim out of FloatingNav.jsx) minus what the bar already shows.
// (`/reviews` was on it until Google reviews were removed, 2026-10-20.)
const PRE_MENU = ['/time', '/variance', '/payroll', '/hr', '/inspections', '/keys', '/supplies', '/invoices', '/settings'];
// The owner's and admin's menu keeps every row it had, in its order; the manager view's new pages
// only JOIN it (D2), and the one office-only row is never a cleaner's.
const menuPaths = paths(nav.MOBILE_MENU);
ok(`MOBILE_MENU keeps the phone menu's pre-change list, in order (${show(menuPaths)})`,
  show(menuPaths.filter((p) => PRE_MENU.includes(p))) === show(PRE_MENU));
// A cleaner has no phone menu at all since the Cleaner Hub (the crew shell draws no tray, UI_RULES
// §165): their Client Requests are their own screen (lib/crewPaths requests).
ok('Client Requests joins the owner\'s and admin\'s phone menu, never a cleaner\'s',
  (fn(nav, 'mobileMenu')(checkerFor('owner')) || []).some((m) => m.to === '/requests')
  && (fn(nav, 'mobileMenu')(checkerFor('admin')) || []).some((m) => m.to === '/requests')
  && /if \(crew\) \{[\s\S]{0,1200}\}/.test(read('src/layouts/AppLayout.jsx')) && !/<FloatingNav\b/.test(read('src/layouts/AppLayout.jsx').split('if (crew) {')[1]?.split('\n  }\n')[0] || ''));
const sidebarBefore = (check, isMobile) => [
  ...(fn(nav, 'navLeaves')() || []).filter((l) => nav.visible?.(l, check, isMobile, false)),
  ...[nav.SETTINGS_LEAF, nav.REVIEW_LEAF].filter((l) => l && nav.visible?.(l, check, isMobile, false)),
];
const CASES = [
  ['a manager on the shipped defaults', []],
  ['a manager pared back (no variance, payroll, HR or Review)', ['variance.view', 'payroll.view', 'hr.view', 'drafts.view']],
  ['a manager without supplies or approvals', ['supplies.view', 'time.approve']],
];
for (const [name, revokes] of CASES) {
  const check = checkerFor('manager', revokes);
  const d = managerNav(check, { isMobile: false }) || {};
  const nowDesk = new Set([...(d.primary || []), ...(d.more || [])].filter((l) => !l.divider).map((l) => l.to));
  const lostDesk = sidebarBefore(check, false).map((l) => l.to).filter((p) => !nowDesk.has(p));
  ok(`desktop, ${name}: every page from before is in the order or under More (lost: ${lostDesk.join(', ') || 'none'})`,
    nowDesk.size > 0 && lostDesk.length === 0);
  const tray = (fn(nav, 'mobileTabs')(check, false) || []).map((t) => t.to);
  const m = managerNav(check, { isMobile: true, tray }) || {};
  const nowPhone = new Set([...(m.primary || []), ...(m.more || [])].filter((l) => !l.divider).map((l) => l.to));
  const beforePhone = (fn(nav, 'mobileMenu')(check, false) || []).map((l) => l.to);
  const lostPhone = beforePhone.filter((p) => !nowPhone.has(p));
  ok(`phone, ${name}: every menu page from before is still in the menu (lost: ${lostPhone.join(', ') || 'none'})`,
    beforePhone.length > 0 && lostPhone.length === 0);
  ok(`phone, ${name}: the menu never repeats a bar tab`, nowPhone.size > 0 && [...nowPhone].every((p) => !tray.includes(p)));
  ok(`${name}: nothing appears twice`, (() => {
    const all = [...(d.primary || []), ...(d.more || [])].filter((l) => !l.divider).map((l) => l.to);
    return all.length > 0 && all.length === new Set(all).size;
  })());
  ok(`${name}: nothing hidden from the manager is offered`, nowDesk.size > 0 && [...(d.primary || []), ...(d.more || [])]
    .filter((l) => !l.divider).every((l) => nav.visible?.(l, check, false, false)));
}
ok('More keeps today\'s order (NAV order, then Settings, then Review)', (() => {
  const more = paths(desk.more);
  const ref = sidebarBefore(mgr, false).map((l) => l.to).filter((p) => more.includes(p));
  return more.length > 0 && show(more) === show(ref);
})());
ok('the line is never first or last, and never doubled', [desk, managerNav(mgr, { isMobile: true, tray: ['/', '/schedule', '/messaging', '/contacts'] }) || {}]
  .every((r) => { const p = paths(r.primary); return p.length > 0 && p[0] !== '—' && p[p.length - 1] !== '—' && !p.some((x, i) => x === '—' && p[i + 1] === '—'); }));

// ── 4. the bottom bar is EXACTLY as it was, for every OFFICE role (Daniel's condition) ─────
// The pre-change bar, per role on the shipped defaults. A pin on purpose: the bar must not move
// at all. A cleaner has no bar since the Cleaner Hub (the crew shell, UI_RULES §165).
const PRE_BAR = {
  owner: [['/', 'nav.dashboard'], ['/schedule', 'nav.schedule'], ['/messaging', 'nav.messaging'], ['/contacts', 'nav.customers']],
  admin: [['/', 'nav.dashboard'], ['/schedule', 'nav.schedule'], ['/messaging', 'nav.messaging'], ['/contacts', 'nav.customers']],
  manager: [['/', 'nav.dashboard'], ['/schedule', 'nav.schedule'], ['/messaging', 'nav.messaging'], ['/contacts', 'nav.customers']],
  // S131: the office bar as a supply manager's keys read it (no customer key, so no fourth tab).
  // FloatingNav never draws it for them: their phone is their own app, `mobileTabs(check, { supply })`
  // — Order Queue · Supply Catalog · Messages (S131 Wave 2, test-supply-shell.mjs §3).
  supply_manager: [['/', 'nav.dashboard'], ['/schedule', 'nav.schedule'], ['/messaging', 'nav.messaging']],
};
for (const role of roles.ROLES.filter((r) => r !== 'crew')) {
  const bar = (fn(nav, 'mobileTabs')(checkerFor(role)) || []).map((t) => [t.to, t.labelKey]);
  ok(`the ${role}'s bottom bar is unchanged (${show(bar)})`, show(bar) === show(PRE_BAR[role]));
}
const fnav = read('src/components/FloatingNav.jsx');
// One source for the bar: mobileTabs, which draws the office bar for every office role and the
// supply manager's own (S131 Wave 2, `{ supply }`; test-supply-shell.mjs §3).
ok('the bar is still drawn from mobileTabs alone, for every role', /const tabDefs = mobileTabs\(check, \{ supply \}\);/.test(fnav) && (fnav.match(/tabDefs\s*=/g) || []).length === 1);
ok('FloatingNav no longer declares its own menu list (moved to navData as MOBILE_MENU)', !/const menuDefs = \[/.test(fnav) && /mobileMenu\(/.test(fnav));
ok('the phone menu takes the manager order for a manager only', /isManager \?/.test(fnav) && /managerNav\(/.test(fnav) && /role === 'manager'/.test(fnav));
const side = read('src/components/Sidebar.jsx');
ok('the sidebar takes the manager order for a manager only (owner and admin draw NAV, in the Launcher\'s sections, UI_RULES §182)', /role === 'manager'/.test(side) && /managerNav\(/.test(side) && /NAV\.flatMap\(/.test(side) && /launcherSections\(leaves, \{ home: LAUNCHER_HOME \}\)/.test(side));
ok('…and a manager\'s "More" becomes the sections (Daniel, 2026-10-30)', /launcherSections\(mgr\.more\)/.test(side));
ok('the sidebar\'s Settings and Review rows come from the shared leaves', /SETTINGS_LEAF/.test(side) && /REVIEW_LEAF/.test(side));

// The search launchpad's "Go to" grid still skips exactly what the bar shows.
{
  const lp = fn(registry, 'buildLaunchpad')(mgr, true, false) || { pages: [] };
  const tray = new Set((fn(nav, 'mobileTabs')(mgr, false) || []).map((t) => t.to));
  ok('the launchpad skips exactly the bar\'s tabs', lp.pages.length > 0 && lp.pages.every((p) => !tray.has(p.to)));
}

// ── 5. Home and the P&L page ────────────────────────────────────────────────────────────────
const app = read('src/App.jsx');
const home = (app.match(/function HomeRoute\(\) \{[\s\S]*?\n\}/) || [''])[0];
ok('HomeRoute sends a manager to ManagerHome', /role === 'manager'\) return <ManagerHome \/>/.test(home));
ok('HomeRoute gives the owner the cockpit with its switch (OwnerHome)', /role === 'owner'\) return <OwnerHome \/>/.test(home));
ok('the admin keeps the operational Dashboard', /return <Dashboard \/>;/.test(home));
ok('the old manager home (variant D at "/") is gone from HomeRoute', !/variant="D"/.test(home) && !/AccountDashboard/.test(home));
ok('/pnl is its own page, gated financials.view', /<Route path="pnl" element=\{<RequirePerm perm="financials\.view"><PropertyPnl \/><\/RequirePerm>\} \/>/.test(app));
const pnl = read('src/pages/PropertyPnl.jsx');
ok('the P&L page renders the existing board, variant D, with its period picker', /<AccountDashboard[^>]*variant="D"/.test(pnl) && /BackLink/.test(pnl));
const owner = read('src/pages/OwnerHome.jsx');
ok('the owner\'s switch is a .tab-container-line pill pair on ?view=manager', /tab-container-line/.test(owner) && /'view'/.test(owner) && /'manager'/.test(owner)
  && /<ManagerHome \/>/.test(owner) && /<AccountDashboard variant="C" \/>/.test(owner));
ok('the switch\'s words are catalog lines', core.english('mgrHome.switch.owner') === 'Owner cockpit' && core.english('mgrHome.switch.manager') === 'Manager view');
{
  const page = (registry.PAGE_ENTRIES || []).find((e) => e.to === '/pnl');
  ok('search finds the P&L page, gated like its route', !!page && page.perm === 'financials.view');
}
ok('the back pill names the P&L page', /pathname === '\/pnl'\) return 'nav\.propertyPnl'/.test(read('src/hooks/useFromHere.js')) && core.english('nav.propertyPnl') === 'Property P&L');

// ── 6. Wave B: the board's glyphs, the count pills, the band and the "+" ─────────────────────
{
  const icons = read('src/components/Icon.jsx');
  ok('the icon set carries the board\'s house, clock and shield', /^\s+home:\s+<path/m.test(icons) && /^\s+clock:\s+<path/m.test(icons) && /^\s+shield:\s+<path/m.test(icons));
  const iconOf = (to) => (desk.primary || []).find((l) => l.to === to)?.icon;
  const merged2 = managerNav(mgr, { isMobile: false, leaves: [...(fn(nav, 'navLeaves')() || []), ...extra] }) || {};
  const iconOf2 = (to) => (merged2.primary || []).find((l) => l.to === to)?.icon;
  ok(`the manager's rows wear the board's glyphs: Home a house, Inspections a shield, Hours Approval and Shift Check-in a clock (${['/', '/inspections', '/approvals', '/check-in'].map(iconOf2).join(', ')})`,
    iconOf('/') === 'home' && iconOf('/inspections') === 'shield' && iconOf('/approvals') === 'clock' && iconOf2('/check-in') === 'clock');
  ok('Inspections and Hours Approval no longer share a glyph', iconOf('/inspections') !== iconOf('/approvals'));
  // The Launcher (UI_RULES §182) draws every page with Option D's glyphs, as Matt's board drew them:
  // Quality a shield, Shift Check-in a clock, Accounts a building; Approvals keeps its tick.
  const navIcon = (to) => (fn(nav, 'navLeaves')() || []).find((l) => l.to === to)?.icon;
  ok(`the owner's and an admin's pages wear Option D's glyphs (${['/inspections', '/check-in', '/team-accounts', '/approvals'].map(navIcon).join(', ')})`,
    navIcon('/inspections') === 'shield' && navIcon('/check-in') === 'clock' && navIcon('/team-accounts') === 'building' && navIcon('/approvals') === 'check');

  const side = read('src/components/Sidebar.jsx');
  ok('a sidebar pill draws nothing at zero (or before its figure is read)', /function NavCount\(\{ count \}\) \{[\s\S]{0,80}if \(!count\) return null;/.test(side));
  // Counts on the menu for a manager, and for the owner and an admin too (Daniel, 2026-10-30: Matt's
  // Option D drew them), one rule for the desktop's menu and the phone's (menuCountsFor).
  const reads = read('src/hooks/useManagerHomeReads.js');
  ok('the menu\'s pills are a manager\'s, the owner\'s and an admin\'s, never a supply manager\'s or a cleaner\'s',
    /export const menuCountsFor = \(role\) => role === 'manager' \|\| role === 'owner' \|\| role === 'admin';/.test(reads)
    && /useManagerNavCounts\(menuCountsFor\(currentUser\?\.role\)\)/.test(side) && /count=\{pills\[item\.to\]\}/.test(side)
    && /useManagerNavCounts\(menuCountsFor\(user\?\.role\)\)/.test(read('src/components/FloatingNav.jsx')));
  const fnav = read('src/components/FloatingNav.jsx');
  ok('the phone menu draws the same pills, nothing at zero', /pills\[m\.to\] > 0 \?/.test(fnav));

  const home = read('src/pages/ManagerHome.jsx');
  // Every link goes through lib/managerHome tileHref (CS-702: it carries the owner's pick), so the
  // page each one opens is read off TILE_PAGES.
  const pages = (await import('../src/lib/managerHome.js').catch(() => ({}))).TILE_PAGES || {};
  ok('the band links into Shift check-in WITH its referrer (lint:backnav)', /className="mgrh-cta mgrh-band-cta text-sm" to=\{to\} state=\{nav\}/.test(home)
    && /<ShiftBand [^>]*to=\{linkTo\('band'\)\}/.test(home) && pages.band?.path === '/check-in');
  ok('the Schedule tile opens the Schedule\'s Today view; Checklists opens /checklists', /to=\{linkTo\('schedule'\)\}/.test(home) && /to=\{linkTo\('checklists'\)\}/.test(home)
    && pages.schedule?.path === '/schedule?view=Today' && pages.checklists?.path === '/checklists');
  ok('every tile link carries its referrer', /<Link className="mgrh-cta text-sm" to=\{to\} state=\{nav\}>/.test(home));
  ok('the "+" opens a new inspection, only for whoever may make one', /const fab = !empty && check\('qc\.inspect'\)/.test(home)
    && /className="mgrh-fab" to=\{tileHref\('inspect'\)\} state=\{nav\}/.test(home) && pages.inspect?.path === '/inspections?fill=1');
  const css = read('src/index.css');
  ok('the "+" is a phone control: hidden by default, drawn under 640px clear of the bar (above the menu button)',
    /\.mgrh-fab \{ display: none; \}/.test(css) && /@media \(max-width: 640px\) \{[\s\S]*?\.mgrh-fab \{\s*position: fixed;[\s\S]*?bottom: calc\(var\(--space-16\) \+ var\(--space-7\) \+ env\(safe-area-inset-bottom/.test(css));
  ok('the band calms rather than hides: its title always renders, attention only switches the tokens',
    /<section className=\{`card mgrh-band\$\{attention \? ' is-attention' : ''\}`\}/.test(home) && /BAND_TITLE\[band\.state\]/.test(home));
}

console.log(`\ntest-manager-shell: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
