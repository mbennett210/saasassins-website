// THE CUSTOMER HUB'S CHROME READS ONE NAV LIST AND ONE SLOT LIST (UI_RULES §144; the client hub
// redesign, Matt's design, 2026-10-08).
//
// The hub's desktop sidebar and its phone tabs are two drawings of ONE list (src/pages/hub/hubNav.js),
// and the Message / Call / bell controls are ONE list each (src/pages/hub/hubSlots.js), so a section or
// a control added once appears everywhere it should — the shape two more builders extend the same week
// (Messages and the bell; Invoices and Documents). This suite holds that shape mechanically:
//   1. every place that draws the nav reads hubNav.js, and the list is well formed: unique keys, every
//      building section has its route in App.jsx (so a nav entry can never point at the catch-all), and
//      Home and Account are phone tabs;
//   2. every place that draws the action row or the bell reads hubSlots.js, and no screen draws a Call
//      button of its own;
//   3. a section page draws its OWN <BackLink> (lint:backnav finds back-arrow pages by the BackLink in
//      the page module; one hidden in the shared heading would take the page out of that lint);
//   4. the old one-page building screen is gone (replace means delete) and its `?tab=` links land on the
//      section pages.
//
// REGRESSION (THE LAW II.3): on the pre-redesign tree there is no hubNav.js, no hubSlots.js and no
// section page, so every check below fails.
//
//   node app/scripts/test-hub-shell.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(APP, 'src', 'pages', 'hub');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

const nav = existsSync(path.join(HUB, 'hubNav.js')) ? await import(pathToFileURL(path.join(HUB, 'hubNav.js')).href) : {};
const entries = Array.isArray(nav.HUB_NAV) ? nav.HUB_NAV : [];
const app = code('src/App.jsx');

// ── 1. one nav list ──────────────────────────────────────────────────────────
ok('N1 the hub has ONE nav list (pages/hub/hubNav.js HUB_NAV)', () => entries.length >= 5);
ok('N2 …with unique keys', () => new Set(entries.map((e) => e.key)).size === entries.length && entries.length > 0);
for (const e of entries.filter((x) => typeof x.section === 'string' && x.section)) {
  ok(`N3 the "${e.label}" section has its route in App.jsx (/hub/b/:buildingId/${e.section})`,
    () => app.includes(`path="/hub/b/:buildingId/${e.section}"`), `no <Route path="/hub/b/:buildingId/${e.section}">`);
}
for (const e of entries.filter((x) => x.section === null || x.section === undefined)) {
  ok(`N3b the "${e.label}" page has its route in App.jsx (${e.path})`, () => !!e.path && app.includes(`path="${e.path}"`));
}
ok('N4 Home and Account are phone tabs (Matt\'s Home · Messages · Account)', () => ['home', 'account'].every((k) => entries.find((e) => e.key === k)?.tab === true));
const layout = code('src/layouts/HubLayout.jsx');
ok('N5 the layout draws the sidebar AND the phone tabs from that list, and from nothing else',
  () => /hubNavMain\(\)/.test(layout) && /hubNavBottom\(\)/.test(layout) && /hubNavTabs\(\)/.test(layout) && !/to=["'`]\/hub\/b\//.test(layout));
const backWords = code('src/hooks/useFromHere.js');
ok('N6 the back pill names a section by its nav label (one list, so a new section is named too)', () => /HUB_NAV/.test(backWords));

// ── 2. one slot list ─────────────────────────────────────────────────────────
const slots = code('src/pages/hub/hubSlots.js');
ok('S1 the action row and the bell are ONE list each (pages/hub/hubSlots.js)', () => /export const HUB_ACTIONS/.test(slots) && /export const HUB_BELL/.test(slots));
const home = code('src/pages/hub/HubHome.jsx');
const visit = code('src/pages/hub/HubVisit.jsx');
ok('S2 Home and Today\'s Visit draw the action row from it', () => /hubActions\(\)/.test(home) && /hubActions\(\)/.test(visit));
ok('S3 the layout\'s phone top bar and Home\'s desktop bar draw the bell from it', () => /HUB_BELL\.map/.test(layout) && /HUB_BELL\.map/.test(home));
const pages = existsSync(HUB) ? readdirSync(HUB).filter((f) => /\.jsx$/.test(f)) : [];
const ownCall = pages.filter((f) => f !== 'HubCallButton.jsx' && /href=\{?`?tel:/.test(code(`src/pages/hub/${f}`)));
ok('S4 no hub screen draws a Call link of its own (HubCallButton, through the slot)', () => pages.length > 0 && ownCall.length === 0, ownCall.join(', '));

// ── 3. a section page draws its own back arrow ───────────────────────────────
const withHead = pages.filter((f) => f !== 'HubSectionHead.jsx' && /HubSectionHead/.test(code(`src/pages/hub/${f}`)));
const noBack = withHead.filter((f) => !/<BackLink\b/.test(code(`src/pages/hub/${f}`)));
ok('B1 every page with a section heading draws its own <BackLink> (lint:backnav sees it)', () => withHead.length >= 6 && noBack.length === 0, noBack.join(', '));
ok('B2 the shared heading draws no back arrow of its own', () => !/<BackLink\b/.test(code('src/pages/hub/HubSectionHead.jsx')) && existsSync(path.join(HUB, 'HubSectionHead.jsx')));

// ── 4. the old building page is gone ─────────────────────────────────────────
ok('D1 the one-page building screen and the buildings list are deleted (replace means delete)',
  () => !existsSync(path.join(HUB, 'HubBuilding.jsx')) && !existsSync(path.join(HUB, 'HubBuildings.jsx')) && !/HubBuildings?\b/.test(app));
ok('D2 an old link\'s ?tab= lands on that section\'s page', () => /searchParams\.get\('tab'\)/.test(home) && /HUB_SECTIONS\(\)\.includes\(tab\)/.test(home));
ok('D3 /hub opens the current building (HubLanding), not a list', () => /<Route index element=\{<HubLanding \/>\}/.test(app));

console.log(`\nhub shell: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
