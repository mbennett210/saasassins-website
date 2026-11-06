// The Supply Manager's shell (S131 Wave 2, plan docs/plans/2026-10-14-supply-orders.md §0 "Home and
// nav"; Matt's boards sm-web-01..03 / sm-mobile-01; UI_RULES §169).
//
//   1. HomeRoute sends a supply_manager to SupplyHome (the Order Queue) at `/` — never the
//      operational Dashboard (whose Missed Cleans line carries a money figure);
//   2. supplyNav(): Order Queue · Supply Catalog · Reports, a line, Messages · Account, then "More"
//      with every other page the role can open — nothing they can't open, nothing twice, and the
//      Supplies page once (the Supply Catalog row IS that page, on its Catalog tab);
//   3. the phone: the role's own bar — Order Queue · Supply Catalog · Messages — every tab a page
//      they can open (no Schedule, no Customers); the menu never repeats a bar tab; every other
//      office role's bar is untouched (test-manager-shell.mjs §4 pins it);
//   4. the owner's Supply view (`?view=supply`): SupplyHome acting as the owner, nav unchanged;
//      leaving it drops the view and the queue's own URL keys (lib/ownerViews);
//   5. the search launchpad skips exactly the Supply Manager's bar;
//   6. the office's Supply Catalog row (task #125): the owner's and an admin's Operations menu, an
//      account manager's order and the owner's phone menu carry it right after Supplies, gated as
//      Supplies, once; only one of the two rows is lit at a time (navRowOn), and search offers it;
//   7. every row of an open sidebar group can be seen: no fixed height on a group (a 320px cap cut
//      Supplies and every row after Client Requests off the owner's Operations menu), and the rail
//      scrolls when it is taller than the window, so the footer and the last rows stay in reach.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying on the
// first missing export. Offline. Run: node scripts/test-supply-shell.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const show = (v) => JSON.stringify(v);

const nav = await import('../src/lib/navData.js').catch(() => ({}));
const roles = await import('../src/lib/roles.js');
const core = await import('../src/i18n/core.js');
const registry = await import('../src/lib/masterSearch/registry.js').catch(() => ({}));
const views = await import('../src/lib/ownerViews.js').catch(() => ({}));
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);

const SM = 'supply_manager';
const checkerFor = (role, revokes = []) => {
  const user = { id: `u_${role}`, role };
  const overrides = revokes.length ? [{ userId: user.id, grants: [], revokes }] : [];
  return (key) => roles.can(user, key, undefined, overrides);
};
const paths = (list) => (list || []).map((e) => (e.divider ? '—' : e.to));
const sm = checkerFor(SM);

// ── 1. Home ───────────────────────────────────────────────────────────────────────────────────
{
  const app = read('src/App.jsx');
  const home = (app.match(/function HomeRoute\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('App.jsx loads SupplyHome lazily, like every page', /const SupplyHome = lazyRoute\(\(\) => import\('\.\/pages\/SupplyHome'\)\);/.test(app));
  ok('🔴 HomeRoute sends a supply manager to SupplyHome (the Order Queue)',
    /(role === 'supply_manager'|isSupplyRole\(currentUser\))\) return <SupplyHome \/>/.test(home));
  ok('…before the operational Dashboard, which stays the admin\'s', home.indexOf('<SupplyHome />') > -1
    && home.indexOf('<SupplyHome />') < home.indexOf('return <Dashboard />'));
  ok('isSupplyRole names the role (the ONE rule the shell splits on, like isCrewRole)',
    fn(nav, 'isSupplyRole')({ role: SM }) === true && fn(nav, 'isSupplyRole')({ role: 'manager' }) === false && fn(nav, 'isSupplyRole')(null) === false);
}

// ── 2. supplyNav: the board's order, then "More" ─────────────────────────────────────────────
const ORDER = ['/', '/supplies?tab=catalog', '/reports', '—', '/messaging', '/settings/account'];
{
  const rows = nav.SUPPLY_NAV_ORDER || [];
  ok(`SUPPLY_NAV_ORDER is the board's order (${show(paths(rows))})`, show(paths(rows)) === show(ORDER));
  const labelOf = (to) => rows.find((r) => r.to === to)?.labelKey;
  ok('"/" reads Order Queue, the catalog row Supply Catalog, Messaging Messages',
    labelOf('/') === 'nav.orderQueue' && core.english('nav.orderQueue') === 'Order Queue'
    && labelOf('/supplies?tab=catalog') === 'nav.supplyCatalog' && core.english('nav.supplyCatalog') === 'Supply Catalog'
    && labelOf('/messaging') === 'nav.messages');
  const relabelled = rows.filter((r) => r.labelKey);
  ok('every relabelled row\'s English label is its key\'s English', relabelled.length >= 3 && relabelled.every((r) => r.label && core.english(r.labelKey) === r.label));
  ok('the board\'s glyphs: the queue a grid, the catalog a box, Reports a chart',
    rows.find((r) => r.to === '/')?.icon === 'dashboard' && rows.find((r) => r.to === '/supplies?tab=catalog')?.icon === 'box');
}
const supplyNav = fn(nav, 'supplyNav');
const desk = supplyNav(sm, { isMobile: false }) || {};
{
  ok(`a supply manager's sidebar is the board's order (${show(paths(desk.primary))})`, show(paths(desk.primary)) === show(ORDER));
  ok('the queue row is exact-match ("/" end) and carries the Dashboard leaf\'s gate',
    (desk.primary || []).some((r) => r.to === '/' && r.end === true && r.perm === 'dashboard.view'));
  ok('the catalog row is the Supplies page\'s gate, opened on its Catalog tab',
    (desk.primary || []).some((r) => r.to === '/supplies?tab=catalog' && r.perm === 'supplies.view'));
  const more = paths(desk.more);
  ok(`"More" holds every other page the role can open, in NAV order (${show(more)})`, show(more) === show(['/schedule', '/deliveries', '/settings']));
  const all = [...(desk.primary || []), ...(desk.more || [])].filter((r) => !r.divider);
  ok('🔴 nothing the supply manager cannot open is offered', all.length > 0 && all.every((r) => nav.visible?.(r, sm, false, false)));
  ok('…not Customers, Quality, Hours Approval, Payroll or HR', !all.some((r) => ['/contacts', '/clients', '/inspections', '/approvals', '/payroll', '/hr'].includes(r.to)));
  ok('nothing twice, and the Supplies page once (the catalog row is that page)', all.length === new Set(all.map((r) => r.to)).size
    && !all.some((r) => r.to === '/supplies'));
  // Every page the sidebar offered the role before (NAV + Settings + Review) is still offered.
  // By PATH on both sides: the office's Supply Catalog leaf (task #125) is the Supplies page too.
  const before = [...(fn(nav, 'navLeaves')() || []), nav.SETTINGS_LEAF, nav.REVIEW_LEAF]
    .filter((l) => l && nav.visible?.(l, sm, false, false)).map((l) => l.to.split('?')[0]);
  const now = new Set(all.map((r) => r.to.split('?')[0]));
  ok(`no page is lost (lost: ${before.filter((p) => !now.has(p)).join(', ') || 'none'})`, before.length > 0 && before.every((p) => now.has(p)));
  // Pared back: a row the role no longer holds drops, and the line never ends up first, last or doubled.
  const lean = supplyNav(checkerFor(SM, ['supplies.view', 'reports.view']), { isMobile: false }) || {};
  ok(`pared back (no supplies.view, no reports.view): only what they still hold (${show(paths(lean.primary))})`,
    show(paths(lean.primary)) === show(['/', '—', '/messaging', '/settings/account']));
  const noHome = supplyNav(checkerFor(SM, ['dashboard.view', 'supplies.view', 'reports.view']), { isMobile: false }) || {};
  const p = paths(noHome.primary);
  ok(`the line is never first, last or doubled (${show(p)})`, p.length > 0 && p[0] !== '—' && p[p.length - 1] !== '—' && !p.some((x, i) => x === '—' && p[i + 1] === '—'));
}

// ── 3. the phone ──────────────────────────────────────────────────────────────────────────────
{
  const bar = (fn(nav, 'mobileTabs')(sm, { supply: true }) || []).map((t) => [t.to, t.labelKey]);
  ok(`the supply manager's bar is their own: Orders · Catalog · Messages, the short words a narrow tab holds (${show(bar)})`,
    show(bar) === show([['/', 'nav.tab.orders'], ['/supplies?tab=catalog', 'nav.tab.catalog'], ['/messaging', 'nav.messages']])
    && core.english('nav.tab.orders') === 'Orders' && core.english('nav.tab.catalog') === 'Catalog');
  const tabs = fn(nav, 'mobileTabs')(sm, { supply: true }) || [];
  ok('🔴 every tab of it is a page the role can open', tabs.length > 0 && tabs.every((t) => sm(t.perm)));
  ok('…and no Schedule or Customers tab', !tabs.some((t) => ['/schedule', '/contacts', '/clients'].includes(t.to)));
  const lean = (fn(nav, 'mobileTabs')(checkerFor(SM, ['supplies.view']), { supply: true }) || []).map((t) => t.to);
  ok(`a tab the role loses leaves the bar (${show(lean)})`, show(lean) === show(['/', '/messaging']));
  ok('the bar\'s English labels are their keys\' English', tabs.every((t) => t.label && core.english(t.labelKey) === t.label));
  ok('mobileTabs still takes ONE required argument (the office bar is the default)', nav.mobileTabs?.length === 1
    && show((fn(nav, 'mobileTabs')(sm) || []).map((t) => t.to)) === show(['/', '/schedule', '/messaging']));
  const tray = tabs.map((t) => t.to);
  const phone = supplyNav(sm, { isMobile: true, tray }) || {};
  ok(`the phone menu: Reports, a line, Account (${show(paths(phone.primary))})`, show(paths(phone.primary)) === show(['/reports', '—', '/settings/account']));
  ok(`…then More (${show(paths(phone.more))})`, show(paths(phone.more)) === show(['/schedule', '/deliveries', '/settings']));
  const menuAll = [...(phone.primary || []), ...(phone.more || [])].filter((r) => !r.divider).map((r) => r.to);
  ok('the menu never repeats a bar tab', menuAll.length > 0 && menuAll.every((to) => !tray.includes(to)));
  ok('navPath gives a row\'s path without its query (what "active" compares)', fn(nav, 'navPath')('/supplies?tab=catalog') === '/supplies' && fn(nav, 'navPath')('/') === '/');

  const side = read('src/components/Sidebar.jsx');
  ok('the sidebar draws supplyNav for a supply manager (isSupplyRole), the manager order for a manager, NAV for the rest',
    /isSupplyRole\(currentUser\)/.test(side) && /supplyNav\(check, \{ isMobile \}\)/.test(side) && /managerNav\(check, \{ isMobile, team \}\)/.test(side) && /NAV\.flatMap\(/.test(side));
  const fnav = read('src/components/FloatingNav.jsx');
  ok('the phone draws the role\'s bar from mobileTabs and its menu from supplyNav', /const tabDefs = mobileTabs\(check, \{ supply \}\);/.test(fnav)
    && /supplyNav\(check, \{ isMobile: true, tray: tabDefs\.map\(\(t\) => t\.to\) \}\)/.test(fnav) && /isSupplyRole\(user\)/.test(fnav));
  ok('a row\'s "active" reads its path, not its query (the catalog tab is the Supplies page)', /navPath\(to\)/.test(fnav));
}

// ── 4. the owner's Supply view ──────────────────────────────────────────────────────────────
{
  const owner = read('src/pages/OwnerHome.jsx');
  ok('OwnerHome has a Supply view (?view=supply) drawing SupplyHome, acting as the owner',
    /SUPPLY_VIEW/.test(owner) && /<SupplyHome \/>/.test(owner) && /import SupplyHome from '\.\/SupplyHome';/.test(owner));
  ok('its tab reads "Supply view", after the Operations view', core.english('mgrHome.switch.supply') === 'Supply view'
    && owner.indexOf("t('mgrHome.switch.ops')") > -1 && owner.indexOf("t('mgrHome.switch.supply')") > owner.indexOf("t('mgrHome.switch.ops')"));
  ok('the switch decides its URL through lib/ownerViews (one rule)', /ownerViewParams\(/.test(owner));
  const step = fn(views, 'ownerViewParams');
  const go = (from, next) => { const r = step(new URLSearchParams(from), next); return r ? r.toString() : null; };
  ok(`cockpit → Supply view: ?view=supply, the cockpit's period dropped (${go('window=30d', 'supply')})`, go('window=30d', 'supply') === 'view=supply');
  ok(`Supply view → cockpit drops the view and the queue's own keys (${go('view=supply&status=sent&q=SO-10&page=2', '')})`,
    go('view=supply&status=sent&q=SO-10&page=2', '') === '');
  ok(`Supply view → Manager view starts clean (${go('view=supply&status=sent&q=x&page=2', 'manager')})`, go('view=supply&status=sent&q=x&page=2', 'manager') === 'view=manager');
  ok(`Operations view → Supply view drops the OM and the manager picks (${go('view=ops&om=u_om&mgr=u_am', 'supply')})`, go('view=ops&om=u_om&mgr=u_am', 'supply') === 'view=supply');
  ok(`Manager view → Operations view drops the manager pick (${go('view=manager&mgr=u_am', 'ops')})`, go('view=manager&mgr=u_am', 'ops') === 'view=ops');
  ok(`tapping the view you are on keeps its own filters (${go('view=supply&status=sent', 'supply')})`, go('view=supply&status=sent', 'supply') === 'view=supply&status=sent');
  ok('the views are named once', show(views.OWNER_VIEWS) === show(['manager', 'ops', 'supply']));
  ok('…and SupplyHome says it is mounted (no longer "until Builder R mounts it")', !/until then it is proven/.test(read('src/pages/SupplyHome.jsx')));
}

// ── 5. search ─────────────────────────────────────────────────────────────────────────────────
{
  const lp = fn(registry, 'buildLaunchpad')(sm, true, { supply: true }) || { pages: [] };
  const trayPaths = new Set((fn(nav, 'mobileTabs')(sm, { supply: true }) || []).map((t) => t.to.split('?')[0]));
  ok(`the launchpad skips exactly the supply manager's bar (${show(lp.pages.map((p) => p.to))})`,
    trayPaths.size === 3 && lp.pages.every((p) => !trayPaths.has(p.to.split('?')[0])));
  ok('MasterSearch hands the launchpad the supply flag', /supply: isSupplyRole\(user\)/.test(read('src/components/MasterSearch.jsx')));
  // Reports lists each report only for a holder of the key its read needs (Reports.jsx `perm`, S131);
  // search must offer the same, or a supply manager searching "Not clocked in" lands on Supply usage.
  const reportsSrc = read('src/pages/Reports.jsx');
  const listed = [...reportsSrc.matchAll(/\{ id: '([^']+)'[^\n]*?perm: '([^']+)'/g)].map((m) => ({ id: m[1], perm: m[2] }));
  const entryOf = (id) => (registry.PAGE_ENTRIES || []).find((e) => e.to === `/reports?r=${id}`);
  const loose = listed.filter(({ id, perm }) => { const e = entryOf(id); return !e || !(e.perm === perm || (e.permsAll || []).includes(perm)); });
  ok(`🔴 search offers each report only to whoever Reports lists it for (loose: ${loose.map((r) => r.id).join(', ') || 'none'})`, listed.length >= 8 && loose.length === 0);
  const found = (fn(registry, 'buildNavEntries')(sm, false, { supply: true }) || []).filter((e) => /^\/reports\?r=/.test(e.to)).map((e) => e.to);
  ok(`…so a supply manager finds Supply usage alone (${show(found)})`, show(found) === show(['/reports?r=supply-usage']));
}

// ── 6. the office's Supply Catalog row (task #125) ───────────────────────────────────────────
// The catalog was a tab of the Supplies page, with a row of its own only in the Supply Manager's
// nav. The owner's and an admin's Operations menu, an account manager's order and the owner's phone
// menu now carry a Supply Catalog row right after Supplies (the Supplies page on its Catalog tab),
// and the two rows are never lit together.
{
  const CAT = '/supplies?tab=catalog';
  const ops = (nav.NAV || []).find((e) => e.group === 'Operations');
  const kids = ops?.children || [];
  const leaf = kids.find((c) => c.to === CAT);
  const after = (list, a, b) => list.includes(b) && list.indexOf(b) === list.indexOf(a) + 1;
  ok(`🔴 the Operations menu has Supply Catalog right after Supplies (${show(kids.map((c) => c.to))})`, after(kids.map((c) => c.to), '/supplies', CAT));
  ok('…labelled Supply Catalog, gated as Supplies, with Supplies\' NEW pill and a glyph of its own',
    leaf?.labelKey === 'nav.supplyCatalog' && leaf?.label === core.english('nav.supplyCatalog') && leaf?.perm === 'supplies.view'
    && leaf?.badge === 'NEW' && !!leaf?.icon && leaf.icon !== 'box');
  for (const role of ['owner', 'admin']) {
    const shown = kids.filter((x) => nav.visible?.(x, checkerFor(role), false, false, { team: true })).map((x) => x.to);
    ok(`the ${role}'s desktop Operations menu shows it after Supplies (${show(shown)})`, after(shown, '/supplies', CAT));
  }
  const ownerMenu = (fn(nav, 'mobileMenu')(checkerFor('owner'), { team: true }) || []).map((m) => m.to);
  ok(`🔴 the owner's phone menu has it right after Supplies (${show(ownerMenu)})`, after(ownerMenu, '/supplies', CAT));
  const menuRow = (nav.MOBILE_MENU || []).find((m) => m.to === CAT);
  ok('…with the same words, gate, glyph and NEW pill as the sidebar row', menuRow?.labelKey === leaf?.labelKey && menuRow?.perm === leaf?.perm
    && menuRow?.icon === leaf?.icon && menuRow?.isNew === true);
  const mgr = checkerFor('manager');
  const mDesk = fn(nav, 'managerNav')(mgr, { isMobile: false }) || {};
  ok(`🔴 an account manager's sidebar has it right after Supplies (${show(paths(mDesk.primary))})`, after(paths(mDesk.primary), '/supplies', CAT));
  ok('…and never again under More', !paths(mDesk.more).includes(CAT));
  const mTray = (fn(nav, 'mobileTabs')(mgr) || []).map((t) => t.to);
  const mPhone = fn(nav, 'managerNav')(mgr, { isMobile: true, tray: mTray }) || {};
  ok(`…the same on their phone menu, once (${show(paths(mPhone.primary))})`, after(paths(mPhone.primary), '/supplies', CAT)
    && [...paths(mPhone.primary), ...paths(mPhone.more)].filter((p) => p === CAT).length === 1);
  const leanA = checkerFor('admin', ['supplies.view']);
  ok('pared back (no supplies.view): gone from the Operations menu and the phone menu',
    !kids.some((x) => x.to === CAT && nav.visible?.(x, leanA, false, false, { team: true }))
    && !(fn(nav, 'mobileMenu')(leanA, { team: true }) || []).some((m) => m.to === CAT));
  const leanM = fn(nav, 'managerNav')(checkerFor('manager', ['supplies.view']), { isMobile: false }) || {};
  ok('…and from a manager\'s sidebar', !!leanM.primary && ![...paths(leanM.primary), ...paths(leanM.more)].includes(CAT));

  // Which row is lit (the caller has matched the path; navRowOn settles rows that share it).
  const on = fn(nav, 'navRowOn');
  const office = [{ to: '/supplies' }, { to: CAT }, { to: '/deliveries' }];
  const lit = (search) => office.filter((r) => on(r, office, search) === true).map((r) => r.to);
  ok(`on the Supplies page, Supplies is lit, not the catalog (${show(lit(''))})`, show(lit('')) === show(['/supplies', '/deliveries']));
  ok(`on its Catalog tab, the catalog is lit, not Supplies (${show(lit('?tab=catalog'))})`, show(lit('?tab=catalog')) === show([CAT, '/deliveries']));
  ok(`…with the catalog's own search in the URL too (${show(lit('?tab=catalog&cq=gloves'))})`, show(lit('?tab=catalog&cq=gloves')) === show([CAT, '/deliveries']));
  ok(`on another tab (Usage), Supplies again (${show(lit('?tab=usage'))})`, show(lit('?tab=usage')) === show(['/supplies', '/deliveries']));
  const smRows = [{ to: '/' }, { to: CAT }, { to: '/reports' }];
  ok('the Supply Manager\'s lone catalog row is still lit on the whole Supplies page (UI_RULES §169)',
    on({ to: CAT }, smRows, '') === true && on({ to: CAT }, smRows, '?status=approved') === true);
  const side = read('src/components/Sidebar.jsx');
  const fnav = read('src/components/FloatingNav.jsx');
  ok('the sidebar lights its rows (and aria-current) through navRowOn',
    (side.match(/navRowOn\(item, rows, search\)/g) || []).length >= 2 && (side.match(/aria-current=\{mine \? 'page' : false\}/g) || []).length >= 2
    && /leafOn\(l, rows, pathname, search\)/.test(side));
  ok('the phone lights its rows through navRowOn, and a pending tap clears on a new query',
    /navRowOn\(\{ to \}, drawn, shownSearch\)/.test(fnav) && /setPendingTo\(null\); \}, \[pathname, search\]\)/.test(fnav));

  const entry = (registry.PAGE_ENTRIES || []).find((e) => e.to === CAT);
  ok('search offers "Supply Catalog" as a page, gated as Supplies', entry?.label === 'Supply Catalog' && entry?.perm === 'supplies.view');
  ok('…to the owner, not to someone without supplies.view',
    (fn(registry, 'buildNavEntries')(checkerFor('owner'), false, { team: true }) || []).some((e) => e.to === CAT)
    && !(fn(registry, 'buildNavEntries')(leanA, false, { team: true }) || []).some((e) => e.to === CAT));
}

// ── 7. every page of a section can be seen (task #125, then the Launcher, UI_RULES §182) ──────────
// The catalog had no row to find, and Supplies itself, the page it is a tab of, could not be seen:
// an open group was capped at 320px with its overflow clipped (Checklists, Keys, Supplies and
// Deliveries hidden). The groups became the Launcher's sections (2026-10-30): a section's panel holds
// every page it offers, never capped by a fixed height, scrolling inside when taller than the window;
// and the rail scrolls rather than running off the bottom of the window.
{
  const css = read('src/index.css');
  const side = read('src/components/Sidebar.jsx');
  const rule = (sel) => { const i = css.indexOf(`${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
  const panel = rule('.launcher-panel');
  ok(`🔴 a section's panel has no fixed height: it holds all its pages, scrolling inside past the window (${panel.replace(/\s+/g, ' ')})`,
    !!panel && /overflow-y: auto/.test(panel) && !/(?:^|[\s;])height:/.test(panel) && !/max-height: \d/.test(panel)
    && /el\.style\.maxHeight = `\$\{vh - 24\}px`/.test(side));
  ok('…every page of the section is a tile in it (no slice, no cap)', /g\.leaves\.map\(\(leaf\) => \(/.test(side) && !/leaves\.slice\(/.test(side));
  ok('…and the old capped groups are gone (replace means delete)', !/nav-section-/.test(css) && !/NavSection|nav-section/.test(side));
  ok('…and reduced motion skips the motion', /prefers-reduced-motion: reduce\) \{ \.launcher-chev/.test(css) && /if \(reducedMotion\(\)\)/.test(side));
  const railRule = rule('.sidebar-nav');
  ok(`🔴 the rail scrolls when taller than the window, so the footer stays in reach (${railRule.replace(/\s+/g, ' ')})`,
    /overflow-y: auto/.test(railRule) && /min-height: 0/.test(railRule) && !/overflow: visible/.test(railRule));
}

console.log(`\ntest-supply-shell: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
