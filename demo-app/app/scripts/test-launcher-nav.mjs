// The Launcher (DES-1, UI_RULES §182). Matt (2026-10-30): "I selected Option D for the launcher, as I
// believe it is easier to see than the dropdown option. Could we please update that?" He had picked D
// in Review on 2026-10-27 and the menu was never built. Daniel's pick (2026-10-30): everyone gets it.
//
//   1. the model (lib/navData LAUNCHER_SECTIONS): five sections, their groups, every NAV page in exactly
//      one place, so none goes missing;
//   2. who sees what: the owner and an admin get Dashboard and Messaging, then the sections; a manager
//      and a supply manager keep their own rows and their "More" becomes the sections; Settings and
//      Review are the foot, never a tile;
//   3. the words: each section's line, each page's description, all catalog lines;
//   4. the menu (components/Sidebar): the section rows open one panel beside the menu (a dialog that
//      closes on Esc, a click outside and a new page, and turns round mid-way), the foot, and the
//      capped groups it replaced are gone.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying on the
// first missing export. Offline. Run: node scripts/test-launcher-nav.mjs
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
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
const checkerFor = (role, extra = {}) => {
  const user = { id: `u_${role}`, role, ...extra };
  return (key) => roles.can(user, key, undefined, []);
};
const visible = fn(nav, 'visible');
const sectionsOf = fn(nav, 'launcherSections');
const ids = (secs) => (secs || []).map((s) => s.id);
const tos = (secs) => (secs || []).flatMap((s) => s.leaves || []).map((l) => l.to);

// ── 1. The model ──────────────────────────────────────────────────────────────────────────────────
const SECTIONS = nav.LAUNCHER_SECTIONS || [];
{
  ok(`🔴 five sections, in the order Matt picked (${show(ids(SECTIONS))})`, show(ids(SECTIONS)) === show(['ops', 'team', 'cust', 'supply', 'money']));
  ok('the owner\'s rows above them are Dashboard and Messaging', show(nav.LAUNCHER_HOME) === show(['/', '/messaging']));
  const listed = SECTIONS.flatMap((s) => (s.groups || []).flatMap((g) => g.paths || []));
  ok(`no page is listed twice (${listed.length} listed)`, listed.length > 0 && new Set(listed).size === listed.length);
  const leaves = fn(nav, 'navLeaves')() || [];
  const leafTos = new Set(leaves.map((l) => l.to));
  ok(`every listed path is a page in NAV (stale: ${show(listed.filter((p) => !leafTos.has(p)))})`, listed.every((p) => leafTos.has(p)));
  const placeable = leaves.filter((l) => !l.crewOnly && !(nav.LAUNCHER_HOME || []).includes(l.to));
  const unlisted = placeable.filter((l) => !listed.includes(l.to)).map((l) => l.to);
  ok(`🔴 every office page in NAV has its place in a section (unlisted: ${show(unlisted)})`, placeable.length > 10 && unlisted.length === 0);
  const groupOf = (to) => { for (const s of SECTIONS) for (const g of s.groups || []) if ((g.paths || []).includes(to)) return `${s.id}/${g.labelKey}`; return null; };
  ok('the groups are the mockup\'s: Today, Service quality, Time, Pay & people, Directory, Sales',
    groupOf('/schedule') === 'ops/nav.group.today' && groupOf('/inspections') === 'ops/nav.group.serviceQuality'
    && groupOf('/approvals') === 'team/nav.group.time' && groupOf('/payroll') === 'team/nav.group.payPeople'
    && groupOf('/contacts') === 'cust/nav.group.directory' && groupOf('/contracts') === 'cust/nav.group.sales'
    && groupOf('/deliveries') === 'supply/null' && groupOf('/invoices') === 'money/null');
  ok('🔴 QR codes is a page, under Operations › Service quality (Matt: "I\'m not able to find that")',
    leafTos.has('/qr-codes') && groupOf('/qr-codes') === 'ops/nav.group.serviceQuality');
  const qr = leaves.find((l) => l.to === '/qr-codes');
  ok('…gated as the codes are (sites.edit), office only', qr?.perm === 'sites.edit' && qr?.managerOnly === true && qr?.icon === 'qr');
  // The reply to Matt says the codes are "in the menu", and he may read it on his phone: the page is in
  // the phone's menu (and its search) too, never a desk's page only.
  const phoneMenu = fn(nav, 'mobileMenu')(checkerFor('owner'), { team: true }) || [];
  ok('🔴 …and on a phone too: in its menu, gated the same', !qr?.desktopOnly && phoneMenu.some((m) => m.to === '/qr-codes')
    && (nav.MOBILE_MENU || []).some((m) => m.to === '/qr-codes' && m.perm === 'sites.edit' && m.icon === 'qr')
    && !(fn(nav, 'mobileMenu')(checkerFor('crew'), { team: false }) || []).some((m) => m.to === '/qr-codes'));
  const stray = sectionsOf([{ to: '/somewhere-new', label: 'New', labelKey: 'nav.more' }]);
  ok('a page the table doesn\'t list still shows, in a last "More" section (nothing can go missing)', show(ids(stray)) === show(['more']) && show(tos(stray)) === show(['/somewhere-new']));
}

// ── 2. Who sees what ──────────────────────────────────────────────────────────────────────────────
{
  const owner = checkerFor('owner');
  const leaves = (fn(nav, 'navLeaves')() || []).filter((l) => visible(l, owner, false, false, { team: true }));
  const secs = sectionsOf(leaves, { home: nav.LAUNCHER_HOME || [] }) || [];
  ok(`the owner: all five sections, no stray "More" (${show(ids(secs))})`, show(ids(secs)) === show(['ops', 'team', 'cust', 'supply', 'money']));
  ok('…never a home row or a foot row as a tile', !tos(secs).some((t) => ['/', '/messaging', '/settings', '/review'].includes(t)));
  const shown = new Set([...(nav.LAUNCHER_HOME || []), ...tos(secs)]);
  ok(`…and every page the owner may open is a row or a tile (missing: ${show(leaves.map((l) => l.to).filter((t) => !shown.has(t)))})`, leaves.every((l) => shown.has(l.to)));
  ok('Team\'s groups are Time, then Pay & people', show((secs.find((s) => s.id === 'team')?.groups || []).map((g) => g.labelKey)) === show(['nav.group.time', 'nav.group.payPeople']));

  const mgr = checkerFor('manager');
  const desk = fn(nav, 'managerNav')(mgr, { isMobile: false, team: false }) || {};
  const mSecs = sectionsOf(desk.more || []) || [];
  const primary = new Set((desk.primary || []).filter((r) => !r.divider).map((r) => r.to));
  ok(`🔴 a manager's "More" becomes the sections (${show(ids(mSecs))})`, mSecs.length >= 3 && !ids(mSecs).includes('more'));
  ok('…none of their own rows is repeated as a tile', !tos(mSecs).some((t) => primary.has(t)));
  const moreTos = (desk.more || []).map((l) => l.to).filter((t) => !['/settings', '/review'].includes(t));
  ok(`…and every page of their "More" is a tile (lost: ${show(moreTos.filter((t) => !tos(mSecs).includes(t)))})`, moreTos.length > 0 && moreTos.every((t) => tos(mSecs).includes(t)));

  const sm = checkerFor('supply_manager');
  const sDesk = fn(nav, 'supplyNav')(sm, { isMobile: false }) || {};
  const sSecs = sectionsOf(sDesk.more || []) || [];
  ok(`a supply manager's "More" (Schedule, Deliveries) becomes Operations and Supplies (${show(sSecs.map((s) => `${s.id}:${(s.leaves || []).map((l) => l.to).join(',')}`))})`,
    show(sSecs.map((s) => `${s.id}:${(s.leaves || []).map((l) => l.to).join(',')}`)) === show(['ops:/schedule', 'supply:/deliveries']));
}

// ── 3. The words ──────────────────────────────────────────────────────────────────────────────────
{
  const blurb = fn(nav, 'launcherBlurbKeys');
  const two = { labelKey: 'nav.section.team', groups: [{ labelKey: 'nav.group.time', leaves: [] }, { labelKey: 'nav.group.payPeople', leaves: [] }], leaves: [] };
  const one = { labelKey: 'nav.supplies', groups: [{ labelKey: null }], leaves: [{ labelKey: 'nav.supplies' }, { labelKey: 'nav.supplyCatalog' }, { labelKey: 'nav.deliveries' }] };
  const solo = { labelKey: 'nav.supplies', groups: [{ labelKey: null }], leaves: [{ labelKey: 'nav.supplies' }] };
  ok('a section\'s line names its groups when two show ("Time · Pay & people")', show(blurb(two)) === show(['nav.group.time', 'nav.group.payPeople']));
  ok('…else its pages, leaving out the one named as the section ("Supply Catalog · Deliveries")', show(blurb(one)) === show(['nav.supplyCatalog', 'nav.deliveries']));
  ok('…unless it is all there is', show(blurb(solo)) === show(['nav.supplies']));
  // Option D's own words where a section has one (Supplies: "Orders and deliveries", which fits the row
  // where "Supply Catalog · Deliveries" was cut), while two or more of its pages show; one page alone is
  // named instead. An admin's Team (no Payroll, no HR) names the one group it keeps: "Time".
  const withLine = { ...one, lineKey: 'nav.line.supplies' };
  const oneGroup = { labelKey: 'nav.section.team', groups: [{ labelKey: 'nav.group.time', leaves: [] }], leaves: [{ labelKey: 'nav.timeClock' }, { labelKey: 'nav.approvals' }, { labelKey: 'nav.variance' }] };
  ok('…a section\'s own line where it has one, while two or more pages show ("Orders and deliveries")',
    show(blurb(withLine)) === show(['nav.line.supplies']) && show(blurb({ ...solo, lineKey: 'nav.line.supplies' })) === show(['nav.supplies'])
    && SECTIONS.find((s) => s.id === 'supply')?.lineKey === 'nav.line.supplies' && core.english('nav.line.supplies') === 'Orders and deliveries');
  ok('…and one named group names it ("Time", an admin\'s Team)', show(blurb(oneGroup)) === show(['nav.group.time']));
  const keys = [
    ...SECTIONS.map((s) => s.labelKey),
    ...SECTIONS.flatMap((s) => (s.groups || []).map((g) => g.labelKey).filter(Boolean)),
    'nav.pageCount', 'nav.closeSection', 'nav.qrCodes',
  ];
  ok(`every section and group name is a catalog line (missing: ${show(keys.filter((k) => !core.english(k, { count: 2 })))})`, keys.length > 8 && keys.every((k) => core.english(k, { count: 2 })));
  const tiles = (fn(nav, 'navLeaves')() || []).filter((l) => !l.crewOnly && !(nav.LAUNCHER_HOME || []).includes(l.to));
  const noDesc = tiles.filter((l) => !l.descKey || !core.english(l.descKey)).map((l) => l.to);
  ok(`🔴 every page in a section says what it is for (no line: ${show(noDesc)})`, tiles.length > 10 && noDesc.length === 0);
  ok('the section names read as drawn: Operations, Team, Customers, Supplies, Finance',
    show(SECTIONS.map((s) => core.english(s.labelKey))) === show(['Operations', 'Team', 'Customers', 'Supplies', 'Finance']));
}

// ── 4. The menu ───────────────────────────────────────────────────────────────────────────────────
{
  const side = read('src/components/Sidebar.jsx');
  const css = read('src/index.css');
  ok('the sidebar draws the sections for the owner (from NAV) and for a manager (their More)',
    /launcherSections\(leaves, \{ home: LAUNCHER_HOME \}\)/.test(side) && /launcherSections\(mgr\.more\)/.test(side));
  ok('🔴 a section is a button that opens a dialog beside the menu, and says so',
    /className=\{`launcher-cat/.test(side) && /aria-expanded=\{open\}/.test(side) && /aria-haspopup="dialog"/.test(side)
    && /role="dialog"/.test(side) && /className="launcher-panel"/.test(side));
  ok('…each group a column, every page a tile with its description', /className="launcher-col"/.test(side) && /<LauncherTile/.test(side) && /t\(item\.descKey\)/.test(side));
  ok('…it closes on Esc and a click outside (which does nothing else), through the shared hook (UI_RULES §100, §181)', /useDismissTap\(\{/.test(side) && /ref2: asideRef/.test(side));
  ok('…and on a new page (a tile, or a row elsewhere in the menu)', /useEffect\(\(\) => \{ setOpenId\(null\); \}, \[pathname, search\]\);/.test(side));
  ok('…it grows out of its row and turns round mid-way (Smooth transitions)', /run\.reverse\(\)/.test(side) && /duration: open \? 220 : 160/.test(side) && /transformOrigin/.test(side));
  ok('…and stays on the page until it has gone (never off in one frame)', /else setShownId\(want\.current\)/.test(side) && /const \[shownId, setShownId\]/.test(side));
  ok('🔴 another section: the open panel goes back into its row first, then the new one grows out of its own (never a snap to a new size)',
    /if \(!shownId\) setShownId\(id\);/.test(side) && /if \(openId !== shownId\) \{[\s\S]{0,260}fly\(false\);[\s\S]{0,40}else setShownId\(openId\);/.test(side));
  ok('the panel comes right after its row, so Tab goes from the row into it and on to the next row',
    /<Fragment key=\{sec\.id\}>/.test(side) && /\{shownId === sec\.id && panel\}/.test(side));
  ok('…and a page picked, Esc or a click outside puts the focus back on its row', /onPick=\{\(\) => \{ focusRow\(\); close\(\);/.test(side) && /onDismiss: \(\) => \{ focusRow\(\); close\(\); \}/.test(side));
  ok('🔴 a pop-up over it (on <body>) takes its own clicks: the dismiss tap spares it',
    /spare: \(target\) => !!target\?\.closest\?\.\('\.modal-overlay'\)/.test(side) && /if \(spareCb\.current\?\.\(e\.target\)\) return;/.test(read('src/hooks/useDismissTap.js')));
  ok('it goes when the menu scrolls its row away, when the screen narrows to a phone\'s, and when focus leaves the menu without a press (Ctrl+K)',
    /scroller\?\.addEventListener\('scroll', close/.test(side) && /if \(isMobile\) setOpenId\(null\);/.test(side)
    && /document\.addEventListener\('focusin', onFocus\)/.test(side) && /if \(pressing \|\|/.test(side));
  ok('a column\'s pages sit 4px apart, so a hover fill never meets the gold of the page on screen', /\.launcher-col \{ display: grid; gap: var\(--space-1\)/.test(css));
  ok('§110\'s whole-pixel stroke on the pages\' glyphs and the foot\'s', /\.launcher-tile-ic svg path/.test(css) && /\.sidebar-icon-btn svg path/.test(css) && /\.sidebar-util svg path/.test(css));
  ok('its focus rings are never cut: the old groups\' clip went with them, and the solo row\'s rule', !/\.nav-group \{[^}]*overflow-y: clip/.test(css) && !/\.nav-btn-solo/.test(css));
  ok('the foot\'s pair stacks when one word doesn\'t fit ("Configuración", "Revisión") instead of cutting it',
    /\.sidebar-util-row \{ display: flex; flex-wrap: wrap;/.test(css) && /\.sidebar-util \{\s*flex: 1 1 0; min-width: max-content;/.test(css));
  // UI_RULES §185 (Daniel, 2026-10-31, the Review badging out of the menu): no row, tile or Settings button
  // carries an In Review or Approved marker; the Review button keeps its count, Payroll its NEW pill.
  const review = read('src/store/ClientReviewProvider.jsx');
  const en = read('src/i18n/catalog/en.js');
  ok('🔴 no page in the menu carries an In Review or Approved marker: not a row, not a tile, not Settings (§185)',
    !/SectionMarker|useSectionReview|nav-review-(ir|approved|compact)/.test(side)
    && !/nav-review-(ir|approved|compact)|\.nav-review\[role="button"\]/.test(css)
    && !/export function useSectionReview/.test(review)
    && !/'nav\.(inReview|approvedTitle|inReviewTitle|approvedAria|inReviewAria|reviewAgainTitle|reviewAgainMessage|reviewAgainConfirm)'/.test(en));
  ok('…while the Review button keeps its count and a NEW page its pill',
    /<ReviewCount \/>/.test(side) && /if \(badge\) return <NewBadge \/>;/.test(side) && /\.nav-review-count \{/.test(css) && /\.nav-review-new \{/.test(css));
  const icons = read('src/components/Icon.jsx');
  ok('the glyphs the menu draws alone in a tile or a button sit in their middle (worked out from their shapes)',
    /const ICON_CENTER = \{ warning: \[0, 1\.125\], forms: \[0, -0\.375\], mapPin: \[0, -0\.375\], messaging: \[0, -0\.375\] \};/.test(icons)
    && /<g transform=\{`translate\(\$\{shift\[0\]\} \$\{shift\[1\]\}\)`\}>/.test(icons));
  // Settings › Quick start says where each page is: every "Sidebar → …" line of the office's guide
  // names the section, group and page the menu draws it under now.
  const qs = read('src/pages/settings/QuickStart.jsx');
  const office = qs.slice(0, qs.indexOf("id: 'crew-"));
  const navLabel = (to) => { const l = (fn(nav, 'navLeaves')() || []).find((x) => x.to === to); return l ? core.english(l.labelKey) : null; };
  const wheres = [...office.matchAll(/where: 'Sidebar → ([^']+)'/g)].map((m) => m[1].split(' → '));
  const wrong = wheres.filter((parts) => {
    if (parts[0] === 'Settings') return false;
    if (parts.length === 1) return !(nav.LAUNCHER_HOME || []).map(navLabel).includes(parts[0]);
    const sec = SECTIONS.find((s) => core.english(s.labelKey) === parts[0]);
    if (!sec) return true;
    if (parts.length === 3) { const g = sec.groups.find((x) => x.labelKey && core.english(x.labelKey) === parts[1]); return !g || !g.paths.map(navLabel).includes(parts[2]); }
    return parts.length !== 2 || !sec.groups.flatMap((x) => x.paths).map(navLabel).includes(parts[1]);
  }).map((p) => p.join(' → '));
  ok(`Settings › Quick start sends people where the menu draws each page now (wrong: ${show(wrong)})`, wheres.length >= 10 && wrong.length === 0);
  ok('the row whose section holds the page on screen is marked', /has-on/.test(side) && /leafOn\(l, rows, pathname, search\)/.test(side) && /\.launcher-cat\.has-on \.launcher-cat-tile/.test(css));
  ok('🔴 the foot: Settings and Review side by side, then the account chip beside Scan and Report an issue',
    /className="sidebar-util-row"/.test(side) && /className="sidebar-foot-row"/.test(side) && /<UserSwitcher \/>/.test(side)
    && /sidebar-icon-btn sidebar-scan-btn/.test(side) && /sidebar-icon-btn sidebar-report-btn/.test(side));
  ok('…each icon button names itself for a screen reader', (side.match(/aria-label=\{t\('(officeScan\.menu|nav\.reportIssue)'\)\}/g) || []).length === 2);
  ok('the collapsing groups it replaced are gone (replace means delete)', !/NavSection|nav-section-/.test(side) && !/nav-section-/.test(css) && !/\.nav-group-bottom/.test(css) && !/\.sidebar-footer-btn/.test(css));
  ok('the panel scrolls inside when taller than the window', /\.launcher-panel \{[^}]*overflow-y: auto/.test(css));
}

console.log(`\ntest-launcher-nav: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
