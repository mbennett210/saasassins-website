// Master-search registry integrity (src/lib/masterSearch/registry.js). Node-imports the
// real registry (JSX-free by contract) and asserts every entry is well-formed: unique ids,
// absolute paths, permissions that exist in the vocabulary, icon names that exist in
// Icon.jsx (which returns null — a blank — on an unknown name), exclusions with reasons,
// and that nav modifiers survived the derivation.
//
//   node scripts/test-master-search-registry.mjs
import { readFileSync } from 'node:fs';
import { PAGE_ENTRIES, ACTION_ENTRIES, NAV_ENTRIES, EXCLUDED_ROUTES, DETAIL_ROUTES, basePathOf, buildLaunchpad, LAUNCHPAD_ACTIONS } from '../src/lib/masterSearch/registry.js';
import { mobileTabs, visible } from '../src/lib/navData.js';
import { MARKETING_ENABLED } from '../src/lib/features.js';
import { PERMISSIONS, ALWAYS_GRANTED } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// Icon names that actually exist (Icon.jsx renders null for anything else).
const iconSrc = readFileSync(new URL('../src/components/Icon.jsx', import.meta.url), 'utf8');
const ICON_NAMES = new Set([...iconSrc.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
ok('parsed a plausible icon set', ICON_NAMES.size > 20 && ICON_NAMES.has('search'));

const PERM_VOCAB = new Set([...Object.keys(PERMISSIONS), ...ALWAYS_GRANTED]);
const permsOf = (e) => [...(e.permsAny ? e.permsAny : [e.perm]), ...(e.permsAll || [])].filter(Boolean);

// ── unique ids ─────────────────────────────────────────────────────────────────
const ids = NAV_ENTRIES.map((e) => e.id);
ok('all entry ids are unique', new Set(ids).size === ids.length);

// ── every entry well-formed ──────────────────────────────────────────────────────
for (const e of NAV_ENTRIES) {
  ok(`${e.id}: to starts with /`, typeof e.to === 'string' && e.to.startsWith('/'));
  ok(`${e.id}: has a label`, typeof e.label === 'string' && e.label.length > 0);
  ok(`${e.id}: icon "${e.icon}" exists`, ICON_NAMES.has(e.icon));
  ok(`${e.id}: has at least one perm`, permsOf(e).length > 0);
  for (const p of permsOf(e)) ok(`${e.id}: perm "${p}" in vocabulary`, PERM_VOCAB.has(p));
  ok(`${e.id}: no em dash in label`, !/[—–]/.test(e.label));
}

// ── pages vs actions split ────────────────────────────────────────────────────
ok('pages have rankBucket 0', PAGE_ENTRIES.every((e) => e.rankBucket === 0 && e.kind === 'page'));
ok('actions have rankBucket 1', ACTION_ENTRIES.every((e) => e.rankBucket === 1 && e.kind === 'action'));

// ── exclusions carry reasons + real-looking paths ───────────────────────────────
ok('every exclusion has a non-empty reason', EXCLUDED_ROUTES.every((x) => x.path.startsWith('/') && x.reason && x.reason.length > 10));
ok('reviews is excluded', EXCLUDED_ROUTES.some((x) => x.path === '/reviews'));

// ── detail routes are param templates ────────────────────────────────────────────
ok('detail routes are param templates', DETAIL_ROUTES.length >= 4 && DETAIL_ROUTES.every((p) => p.includes('/:')));

// ── nav modifiers survived the derivation ────────────────────────────────────────
const byTo = (to) => PAGE_ENTRIES.find((e) => e.to === to);
ok('/clients carries hideWhen contacts.view', byTo('/clients')?.hideWhen === 'contacts.view');
ok('/schedule carries managerOnly', byTo('/schedule')?.managerOnly === true);
ok('/my-day carries crewOnly', byTo('/my-day')?.crewOnly === true);
ok('/pipeline carries desktopOnly', byTo('/pipeline')?.desktopOnly === true);
// A dormant feature keeps its page entry (its route is still in App.jsx, so the lint still
// reconciles it) but carries its flag, and the shared predicate hides it from everyone.
ok('/marketing carries the MARKETING_ENABLED flag through', byTo('/marketing')?.enabled === MARKETING_ENABLED);
{
  const marketing = NAV_ENTRIES.filter((e) => e.to === '/marketing');
  ok('dormant Marketing never surfaces in search, even with every permission (desktop or phone)',
    marketing.length === 1 && marketing.every((e) => visible(e, () => true, false, false) === MARKETING_ENABLED
      && visible(e, () => true, true, false) === false));
}
ok('Add customer action uses permsAny', ACTION_ENTRIES.find((e) => e.id === 'action:add-customer')?.permsAny?.length === 2);

// ── 🔴 crew have NO search (owner 2026-09-22): nothing here may exist only for crew ──
// MasterSearch renders nothing for crew, so a crew-only action or keyword set is dead weight.
// Crew-only NAV pages (My Day) still derive, and their crewOnly flag keeps them out of
// every non-crew search.
const crewOnlyPages = PAGE_ENTRIES.filter((e) => e.crewOnly);
const crewOnlyPaths = new Set(crewOnlyPages.map((e) => e.to));
ok('no action targets a crew-only page', ACTION_ENTRIES.every((e) => !crewOnlyPaths.has(basePathOf(e.to))));
ok('crew-only pages carry no search keywords', crewOnlyPages.every((e) => e.keywords.length === 0));
ok('no hand-authored (non-nav) page is crew-only', PAGE_ENTRIES.filter((e) => e.source !== 'nav').every((e) => !e.crewOnly));

// ── settings pages all present (11 from settingsNav) ─────────────────────────────
const settingsPages = PAGE_ENTRIES.filter((e) => e.source === 'settings');
ok('11 settings pages derived', settingsPages.length === 11);
ok('settings pages carry a sublabel (desc)', settingsPages.every((e) => typeof e.sublabel === 'string' && e.sublabel.length > 0));

// ── keywords are always an array; normalized text + display fields precomputed ────
ok('every entry keywords is an array', NAV_ENTRIES.every((e) => Array.isArray(e.keywords)));
ok('every entry carries precomputed _l/_k', NAV_ENTRIES.every((e) => typeof e._l === 'string' && Array.isArray(e._k) && e._k.length === e.keywords.length));
ok('every entry has a type label + a larger group cap', NAV_ENTRIES.every((e) => (e.typeLabel === 'Page' || e.typeLabel === 'Action') && e.groupCap === 8));
ok('basePathOf strips the query', basePathOf('/hr?tab=special') === '/hr');

// ── actions are honest about what they open ─────────────────────────────────────
const act = (slug) => ACTION_ENTRIES.find((e) => e.id === `action:${slug}`);
ok('"New inspection" opens ?fill=1, gated qc.inspect', act('new-inspection')?.to === '/inspections?fill=1' && act('new-inspection')?.perm === 'qc.inspect');
ok('"Fill a checklist" opens ?checklist=1, gated qc.checklist.perform', act('fill-checklist')?.to === '/inspections?checklist=1' && act('fill-checklist')?.perm === 'qc.checklist.perform');
ok('desktop-bound actions are desktopOnly (quote editor, pipeline board)', act('new-quote')?.desktopOnly === true && act('new-deal')?.desktopOnly === true);

// ── sub-tabs carry ONLY their own keywords (no parent-page inheritance noise) ────
ok('Work orders does not inherit Quality\'s keywords', !byTo('/inspections?tab=workorders')?.keywords.includes('checklists'));
ok('an HR sub-tab does not inherit HR\'s keywords', !byTo('/hr?tab=special')?.keywords.includes('pto'));
ok('the canonical page keeps its decorations', byTo('/inspections')?.keywords.includes('checklists'));

// ── sub-tabs a page gates tighter than its route carry permsAll ─────────────────
ok('Work orders needs problems.manage too', byTo('/inspections?tab=workorders')?.permsAll?.includes('problems.manage'));
ok('Approved supply items needs supplies.manage too', byTo('/supplies?tab=approved')?.permsAll?.includes('supplies.manage'));

// ── the mobile LAUNCHPAD: permission-filtered tiles + the pages the tray doesn't show ──
const allow = () => true;
const without = (...denied) => (k) => !denied.includes(k);
for (const a of ACTION_ENTRIES) ok(`${a.id}: tile glyph "${a.glyph}" exists`, ICON_NAMES.has(a.glyph));
ok('curated launchpad slugs all exist', LAUNCHPAD_ACTIONS.every((slug) => ACTION_ENTRIES.some((a) => a.slug === slug)));
{
  const lp = buildLaunchpad(allow, true, false);
  ok('full access: the curated six, in order', JSON.stringify(lp.actions.map((a) => a.slug)) === JSON.stringify(LAUNCHPAD_ACTIONS));
  ok('full access: Go to = primary pages minus the tray, max 8',
    JSON.stringify(lp.pages.map((p) => p.to)) === JSON.stringify(['/reports', '/time', '/variance', '/payroll', '/inspections', '/keys', '/supplies', '/invoices']));
  const tray = mobileTabs(allow, false).map((t) => t.to);
  ok('the tray is Dashboard / Schedule / Messaging / Customers', JSON.stringify(tray) === JSON.stringify(['/', '/schedule', '/messaging', '/contacts']));
  ok('Go to never repeats a tray tab', lp.pages.every((p) => !tray.includes(p.to)));
}
{
  // No invoices.edit / keys.manage: those tiles drop and the grid backfills in registry order.
  const lp = buildLaunchpad(without('invoices.edit', 'keys.manage'), true, false);
  const slugs = lp.actions.map((a) => a.slug);
  ok('a tile never offers a flow the viewer cannot open', !slugs.includes('new-invoice') && !slugs.includes('add-key'));
  ok('curated first, then registry-order backfill to six',
    JSON.stringify(slugs) === JSON.stringify(['add-customer', 'new-job', 'new-message', 'request-supplies', 'add-supply-item', 'invite-team']));
  ok('desktop-bound actions never reach the phone', !slugs.includes('new-quote') && !slugs.includes('new-deal'));
}
{
  // Customers as /clients (no contacts.view): the tray carries /clients, so Go to skips it.
  const check = without('contacts.view', 'contacts.edit');
  ok('tray follows the Customers perm', mobileTabs(check, false).some((t) => t.to === '/clients'));
  ok('Go to skips /clients when the tray has it', !buildLaunchpad(check, true, false).pages.some((p) => p.to === '/clients'));
}
{
  const actionPerms = new Set(ACTION_ENTRIES.flatMap((a) => [a.perm, ...(a.permsAny || [])]).filter(Boolean));
  const lp = buildLaunchpad((k) => !actionPerms.has(k), true, false);
  ok('no create permissions → no tiles', lp.actions.length === 0);
}
ok('crew tray: My Day + Quality (the nav split lives in one place)',
  JSON.stringify(mobileTabs(allow, true).map((t) => t.to)) === JSON.stringify(['/', '/my-day', '/messaging', '/inspections']));

// ── 🔴 TOTALITY: every report and every non-default HR tab is findable by name ───
// Parsed from the pages themselves, so adding a report / tab without a search entry fails.
const reportsSrc = readFileSync(new URL('../src/pages/Reports.jsx', import.meta.url), 'utf8');
const reportIds = [...reportsSrc.slice(reportsSrc.indexOf('const REPORTS')).matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
ok('parsed the report list', reportIds.length >= 5);
for (const id of reportIds) ok(`report "${id}" has a search entry`, !!byTo(`/reports?r=${id}`));
const hrSrc = readFileSync(new URL('../src/pages/Hr.jsx', import.meta.url), 'utf8');
const hrDefault = hrSrc.match(/DEFAULT_TAB\s*=\s*'([^']+)'/)?.[1];
const hrTabs = [...hrSrc.slice(hrSrc.indexOf('const TABS')).matchAll(/\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]);
ok('parsed the HR tab list', hrTabs.length >= 4 && !!hrDefault);
for (const key of hrTabs.filter((k) => k !== hrDefault)) ok(`HR tab "${key}" has a search entry`, !!byTo(`/hr?tab=${key}`));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nmaster-search registry: ${pass}/${pass} passed`);
