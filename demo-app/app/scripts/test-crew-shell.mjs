// The Cleaner Hub's shell and screens are wired as the plan says (docs/plans/2026-10-13-cleaner-hub.md
// §3, brief A). The rules are structural — which component a crew viewer gets, which file owns the
// clock, which control is off while the owner previews — so they are read from the source, with
// comments stripped first (a comment that NAMES a thing is not the thing).
//
//   §1 the crew shell: a crew viewer gets no sidebar, no bottom tray, no global search, no Messages
//      dock and no floating bell; the content is one phone-width column; what must stay stays
//   §2 "Report an issue" answers from ONE host every role mounts (the Sidebar no longer owns it)
//   §3 the screens are routed (time.clock), kept offline and written on the catalog
//   §4 ONE clock: hooks/useClockActions is the only screen code that punches; ClockControl and the
//      Clock screen render it; "Open checklist" goes to the cleaner's checklist page
//   §5 the owner's View-as is a preview: one line says so and the write controls are off
//   §6 the live perimeter read is one fix per minute while visible, never watchPosition
//   §7 Home: the one action, the stops, the account manager, the tiles, the account menu
//   §8 Today's Stops and the Clock screens (PAY-17: off site is held, never "locked"; D9 photos)
//   §9 every page a cleaner reaches has a way back; the back pill names Home and My Stops
//   §10 replace means delete: the old My Day timeline and its styles are gone
//
//   node app/scripts/test-crew-shell.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const ok = (cond, label, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const raw = (rel) => (existsSync(path.join(APP, rel)) ? readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n') : '');
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\s\/\/[^'"`]*$/, ''))).join('\n');
const code = (rel) => strip(raw(rel));

const layout = code('src/layouts/AppLayout.jsx');
const sidebar = code('src/components/Sidebar.jsx');
const fnav = code('src/components/FloatingNav.jsx');
const navData = code('src/lib/navData.js');
const app = code('src/App.jsx');
const home = code('src/pages/MyDay.jsx');
const stops = code('src/pages/crew/CrewStops.jsx');
const clockPage = code('src/pages/crew/CrewClock.jsx');
const control = code('src/components/ClockControl.jsx');
const actions = code('src/hooks/useClockActions.js');
const presence = code('src/hooks/useGeoPresence.js');
const chrome = code('src/components/CrewChrome.jsx');
const host = code('src/components/ReportIssueHost.jsx');
const fromHere = code('src/hooks/useFromHere.js');
const css = raw('src/index.css');
const en = raw('src/i18n/catalog/en.js');

// ── §1 the crew shell ───────────────────────────────────────────────────────────────────────
ok(/export const isCrewRole = /.test(navData), '1.1 who is "crew" is ONE rule in lib/navData (isCrewRole)');
const msearch = code('src/components/MasterSearch.jsx');
ok(/\bisCrewRole\(/.test(layout) && ![layout, sidebar, fnav, msearch].some((s) => /role === 'crew'|\bisCrew\b/.test(s)),
  '1.2 the layout asks it, and the office chrome it hides keeps no crew branch of its own (the sidebar\'s flat crew nav, the crew tray and search\'s crew gate are gone)');
const crewAt = layout.indexOf('if (crew) {');
const crewBlock = crewAt >= 0 ? layout.slice(crewAt, layout.indexOf('\n  }\n', crewAt)) : '';
ok(!!crewBlock, '1.3 AppLayout has its own crew branch');
for (const [name, re] of [['Sidebar', /<Sidebar\b/], ['FloatingNav', /<FloatingNav\b/], ['MasterSearch', /<MasterSearch\b/], ['MessagesDock', /<MessagesDock\b/], ['the floating bell', /bell-floater|<NotificationsBell\b/]]) {
  ok(!!crewBlock && !re.test(crewBlock), `1.4 the crew shell has no ${name}`);
}
for (const [name, re] of [['OfflineQueueFailures', /<OfflineQueueFailures\b/], ['SyncProblemDialog', /<SyncProblemDialog\b/], ['RoleSyncBanner', /<RoleSyncBanner\b/], ['DemoBackendsBanner', /<DemoBackendsBanner\b/]]) {
  ok(re.test(crewBlock), `1.5 the crew shell keeps ${name}`);
}
// The route's page (its Suspense and the Outlet) is one element both shells draw.
const pageDecl = /const page = \(\s*<Suspense\b[\s\S]*?<Outlet \/>[\s\S]*?<\/Suspense>\s*\);/.test(layout);
ok(pageDecl && /\{page\}/.test(crewBlock), '1.5 the crew shell keeps the route Suspense and the Outlet (the page both shells share)');
ok(/className="main crew-shell-main"/.test(crewBlock), '1.6 the crew content is the crew shell\'s own .main (the iOS inner scroller stays .main)');
ok(/--crew-shell-w:\s*480px/.test(css) && /--crew-shell-gutter:\s*max\(var\(--space-4\), calc\(\(100% - var\(--crew-shell-w\)\) \/ 2\)\)/.test(css)
  && /\.main\.crew-shell-main \{[^}]*padding: var\(--main-pad-top\) var\(--main-pad-x\)/.test(css) && /--main-pad-x: var\(--crew-shell-gutter\)/.test(css),
  '1.7 the crew column is phone width (480 px, centred by the gutter) on every viewport, from the shell\'s own token');
ok(/<Sidebar\b/.test(layout) && /<FloatingNav\b/.test(layout) && /<MasterSearch\b/.test(layout), '1.8 office viewers keep the sidebar, the tray and search');

// ── §2 Report an issue ──────────────────────────────────────────────────────────────────────
ok(/addEventListener\('cs:open-report'/.test(host) && /removeEventListener\('cs:open-report'/.test(host) && /<ReportIssueModal\b/.test(host),
  '2.1 ReportIssueHost listens for cs:open-report and owns the one ReportIssueModal');
const officePart = crewAt >= 0 ? layout.slice(crewAt + crewBlock.length) : layout;
ok((crewBlock.match(/<ReportIssueHost\b/g) || []).length === 1 && (officePart.match(/<ReportIssueHost\b/g) || []).length === 1,
  '2.2 AppLayout mounts it once in each shell, so every role has it');
ok(!/<ReportIssueModal\b/.test(sidebar) && !/addEventListener\('cs:open-report'/.test(sidebar) && /dispatchEvent\(new CustomEvent\('cs:open-report'\)\)/.test(sidebar),
  '2.3 the Sidebar no longer owns the modal: its footer button asks the host (replace means delete)');

// ── §3 routes, offline, words ───────────────────────────────────────────────────────────────
ok(/<Route path="my-day\/stops" element=\{<RequirePerm perm="time\.clock"><CrewStops \/><\/RequirePerm>\} \/>/.test(app), '3.1 /my-day/stops is routed under time.clock');
ok(/<Route path="my-day\/clock\/:jobId" element=\{<RequirePerm perm="time\.clock"><KeyedByParam name="jobId"><CrewClock \/><\/KeyedByParam><\/RequirePerm>\} \/>/.test(app),
  '3.2 /my-day/clock/:jobId is routed under time.clock, remounting per clean');
ok(/const CrewStops = lazyRoute\(\(\) => import\('\.\/pages\/crew\/CrewStops'\)\)/.test(app) && /const CrewClock = lazyRoute\(\(\) => import\('\.\/pages\/crew\/CrewClock'\)\)/.test(app),
  '3.3 both screens are lazy route chunks');
const sw = raw('vite-plugins/sw-precache.mjs');
ok(/'src\/pages\/crew\/CrewStops\.jsx'/.test(sw) && /'src\/pages\/crew\/CrewClock\.jsx'/.test(sw), '3.4 the phone keeps both screens offline (OFFLINE_SCREENS)');
const cov = raw('scripts/test-i18n-coverage.mjs');
for (const f of ['src/pages/crew/CrewStops.jsx', 'src/pages/crew/CrewClock.jsx', 'src/components/CrewChrome.jsx', 'src/hooks/useClockActions.js']) {
  ok(cov.includes(`'${f}'`), `3.5 ${f} is on the catalog's converted list`);
}
const supplyOrderPage = code('src/pages/crew/CrewSupplyOrder.jsx');
const mine = { 'MyDay.jsx': home, 'CrewStops.jsx': stops, 'CrewClock.jsx': clockPage, 'CrewChrome.jsx': chrome, 'useClockActions.js': actions, 'CrewSupplyOrder.jsx': supplyOrderPage };
for (const [f, s] of Object.entries(mine)) {
  ok(!!s && !/['"`]\/my-day\//.test(s), `3.6 ${f} builds every cleaner-app path through lib/crewPaths (no hand-written /my-day/…)`);
}
// S131 Builder C: one supply order's page opens from the cleaner's bells, so the phone keeps it too.
ok(/'src\/pages\/crew\/CrewSupplyOrder\.jsx'/.test(sw), '3.7 the phone keeps the supply order page offline (a bell opened with no signal says so, not the offline screen)');

// ── §4 ONE clock ────────────────────────────────────────────────────────────────────────────
const screens = [];
(function walk(d) {
  for (const e of readdirSync(path.join(APP, d))) {
    const p = `${d}/${e}`;
    if (statSync(path.join(APP, p)).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(e)) screens.push(p);
  }
})('src/components');
for (const d of ['src/pages', 'src/hooks']) {
  (function walk(dd) {
    for (const e of readdirSync(path.join(APP, dd))) {
      const p = `${dd}/${e}`;
      if (statSync(path.join(APP, p)).isDirectory()) walk(p);
      else if (/\.(jsx?|mjs)$/.test(e)) screens.push(p);
    }
  })(d);
}
const punchers = screens.filter((f) => /timeApi\.clock(In|Out)\(/.test(code(f)));
ok(punchers.length === 1 && punchers[0] === 'src/hooks/useClockActions.js', '4.1 hooks/useClockActions is the only screen code that clocks in or out', JSON.stringify(punchers));
ok(/from '\.\.\/hooks\/useClockActions'/.test(control) && /useClockActions\(/.test(control), '4.2 ClockControl renders the shared actions');
ok(/from '\.\.\/\.\.\/hooks\/useClockActions'/.test(clockPage) && /useClockActions\(/.test(clockPage), '4.3 the Clock screen renders the same actions');
ok(!/ChecklistFill/.test(control) && /crewPaths\.checklist\(/.test(control), '4.4 ClockControl\'s "Open checklist" goes to the cleaner\'s checklist page (no modal of its own)');
ok(/useClockOutGate\(/.test(actions) && /clockOutButtonState\(/.test(actions) && /clockInRefusal\(/.test(actions) && /timeOffEntryFor\(/.test(actions),
  '4.5 the gate, the window and the booked-off ask live in the shared actions');

// ── §5 the owner's preview ──────────────────────────────────────────────────────────────────
ok(/useCrewPreview\(/.test(actions) && /previewing/.test(actions), '5.1 the shared clock knows about the preview');
ok(/if \(previewing\) return/.test(actions), '5.2 …and a punch does nothing while previewing (the server would record the owner)');
ok(/useCrewPreview\(/.test(chrome) && /t\('crewShell\.preview', \{ name/.test(chrome), '5.3 the shell says whose app this is, in one line');
ok(/'crewShell\.preview': 'Viewing as \{name\}\. Actions are turned off\.',/.test(en), '5.4 …in the words D8 gives');
ok(/<CrewPreviewLine\b/.test(crewBlock), '5.5 the crew shell draws that line');
for (const [f, s] of [['MyDay.jsx', home], ['CrewClock.jsx', clockPage]]) {
  ok(/useCrewPreview\(/.test(s), `5.6 ${f} reads the preview`);
}
ok(/disabled=\{[^}]*previewing/.test(home), '5.7 Home\'s write controls are off while previewing');
ok(/readOnly=\{previewing\}/.test(clockPage), '5.8 the Clock screen\'s photos are read-only while previewing');
const crewDay = code('src/hooks/useCrewDay.js');
ok(/timeApi\.entries\(/.test(crewDay) && /usePermission\('time\.view'\)/.test(crewDay) && /previewing && canViewTime/.test(crewDay)
  && [home, stops, clockPage].every((s) => /useCrewPunches\(/.test(s)), '5.9 the preview reads the viewed cleaner\'s punches through the office\'s time read (one read, every crew screen)');

// ── §6 the live perimeter read ──────────────────────────────────────────────────────────────
ok(/getCurrentPosition\(/.test(presence) && !/watchPosition/.test(presence), '6.1 one position read at a time, never watchPosition');
ok(/60[_ ]?000/.test(presence) && /visibilitychange/.test(presence) && /visibilityState/.test(presence), '6.2 every 60 s while the page is visible');
ok(/geoPresence\(/.test(presence) && /selectClockContextForJob/.test(presence), '6.3 the verdict is lib/crewHome\'s, over the clean\'s own context (radius, ring switches)');

// ── §7 Home ─────────────────────────────────────────────────────────────────────────────────
ok(/currentStop\(/.test(home) && /stopRows\(/.test(home), '7.1 Home reads the hero and the stops from the pure rules');
ok(/isTonight\(/.test(home) && /t\('crewHome\.stopsTonight'/.test(home) && /t\('crewHome\.stopsToday'/.test(home), '7.2 "{n} stops today / tonight" on the org\'s clock');
for (const p of ['stops', 'clock', 'checklist', 'hours', 'supplies', 'requests', 'scan']) {
  ok(new RegExp(`crewPaths\\.${p}\\(`).test(home), `7.3 Home links to crewPaths.${p}`);
}
ok(/selectDmConversationBetween\(/.test(home) && /ACTIONS\.ADD_DM_CONVERSATION/.test(home) && /newId\('cv'\)/.test(home), '7.4 Message AM opens the existing DM or creates one, as NewDmModal does');
ok(/`tel:\$\{/.test(home), '7.5 Call AM dials the account manager');
ok(/accountManager\(/.test(home), '7.6 the account manager comes from the pure rule (and says why when there is none)');
ok(/usePermission\('supplies\.request'\)/.test(home), '7.7 Request Supplies shows only for a holder of supplies.request');
ok(/usePermission\('keys\.view'\)/.test(home) && /usePermission\('supplies\.deliver'\)/.test(home), '7.8 the account menu offers My keys and Deliveries only to holders');
ok(/'\/settings\/account'/.test(home) && /cs:open-report/.test(home) && /signOut\(/.test(home), '7.9 the account menu: Your account, Report an issue, Sign out');
ok(/<NotificationsBell\b/.test(home) && /selectUnreadCountForInbox\(/.test(home), '7.10 the bell and the Messages count sit in Home\'s header');
ok(/IDENTITY\.product\.name/.test(home) && !/Clean (Space|Corner)/.test(home), '7.11 the header names the product from the brand file, never a literal');
ok(/<MyWarningsCard\b/.test(home) && /<StubRecoveryBanner\b/.test(home) && /myDay\.punchesFailed/.test(home) && /myDay\.punchesWaiting/.test(home)
  && /myDay\.timeOff\.title/.test(home) && /myDay\.error\.stillListed/.test(home), '7.12 none of My Day\'s banners is lost');
ok(/useClockOutGate\(/.test(home), '7.13 the hero\'s lock and the checklist tile read the shared clock-out gate');
// S131 Builder C (Matt's board: the tile reads "#SO-1047 partial"): the Request Supplies tile names the
// cleaner's newest supply order from ONE light read through the shared-read cache — never a read per
// render, never a read of its own on the page — and says "Order supplies" with none or on a failed read.
const supplyTileHook = code('src/hooks/useMySupplyOrders.js');
ok(/useMyLastSupplyOrder\(\{ enabled: canRequestSupplies \}\)/.test(home) && !/suppliesApi\./.test(home),
  '7.14 the supplies tile reads the newest order through ONE shared hook, only for a holder of supplies.request (no supplies read of the page\'s own)');
ok(/useSharedRead\(/.test(supplyTileHook) && /suppliesApi\.crewOrders\(/.test(supplyTileHook) && /paused: !online/.test(supplyTileHook) && /useCrewPreview\(\)/.test(supplyTileHook),
  '7.15 …the hook: the light read (EP-401) through the shared-read cache, paused with no signal, for the person on screen (the owner\'s View-as)');
ok(/t\('crewHome\.tile\.suppliesOrder', \{ no: lastOrder\.no, status: t\(supplyOrderLabelKey\(lastOrder, 'crew'\)\) \}\)/.test(home) && /t\('crewHome\.tile\.suppliesNone'\)/.test(home)
  && /'crewHome\.tile\.suppliesOrder': '#\{no\} · \{status\}'/.test(en) && /'crewHome\.tile\.suppliesNone': 'Order supplies'/.test(en),
  '7.16 its line: "#SO-1047 · {the cleaner\'s status words}", else "Order supplies"');
ok(['en', 'es', 'ht'].every((l) => !/['"]crewHome\.tile\.suppliesSub['"]/.test(raw(`src/i18n/catalog/${l}.js`))),
  '7.17 the old "Flag low or out items" line is gone from every catalog (replace means delete)');

// ── §8 Today's Stops, Clock In / Clock Out ──────────────────────────────────────────────────
ok(/stopRows\(/.test(stops) && /useGeoPresence\(/.test(stops) && /siteLine\(/.test(stops), '8.1 Stops: the ordered rows, the live read and the server\'s verdict');
ok(/crewPaths\.checklist\(/.test(stops) && /crewPaths\.clock\(/.test(stops) && /useFromHere\(/.test(stops) && /`\/schedule\/\$\{/.test(stops), '8.2 each stop opens its checklist, its clock and its details (with a referrer)');
ok(/<CrewSupplyNote\b/.test(stops), '8.3 each stop carries its supplies line');
ok(/myDay\.upcoming|crewStops\.comingUp/.test(stops), '8.4 the next 14 days are under the stops');
ok(!/\blocked\b/i.test((en.match(/'crew(Clock|Stops|Home)\.[^']+': [^\n]+/g) || []).join('\n')), '8.5 no line of the new screens says "locked" (PAY-17: an off-site clock-in is held, never locked)');
ok(/'crewClock\.outsideBody':[^\n]*You can still clock in/.test(en), '8.6 outside the ring the Clock In screen says the cleaner can still clock in and the time is held');
ok(/scope="clean"/.test(clockPage) && /areaId="before"/.test(clockPage) && /areaId="after"/.test(clockPage), '8.7 Before / After photos on the Clock Out screen (D9)');
ok(/<DriveHint\b|driveApi\.estimate\(/.test(clockPage) && /drivePayEnabled\(/.test(clockPage), '8.8 the next stop carries the drive estimate only when drive pay is on');
ok(/<ClockTimeOffDialog\b/.test(clockPage) && /<ClockTimeOffDialog\b/.test(control), '8.9 the booked-off ask is the same dialog on both clocks');

// ── §9 the way back ─────────────────────────────────────────────────────────────────────────
ok(/pathname === '\/my-day'\) return 'crewShell\.home'/.test(fromHere) && /pathname === '\/my-day\/stops'\) return 'crewStops\.title'/.test(fromHere),
  '9.1 the back pill names Home and My Stops Today (a clean opened from them reads "← Home", not "← Schedule")');
ok(/export function CrewBackBar\b/.test(chrome) && /<CrewBackBar\b/.test(crewBlock), '9.2 the crew shell draws a back bar for an office page with no back of its own');
ok(/needsCrewBackBar\(/.test(chrome) || /CREW_BACK_BAR_PATHS/.test(chrome), '9.3 which pages get it is one list');
ok(/useBackTarget\(/.test(chrome), '9.4 the crew pages\' back goes where the cleaner came from (the referrer), else Home');
ok(/pathname === '\/my-day\/supplies'\) return 'crewSupplies\.title'/.test(fromHere),
  '9.5 the back pill names Request Supplies (an order opened from its history reads "← Request Supplies")');

// ── §10 replace means delete ────────────────────────────────────────────────────────────────
ok(!/myday-tl/.test(home) && !/\.myday-tl-/.test(css), '10.1 the old My Day timeline is gone from the page and the stylesheet');
ok(!/function CarryoverClockCard\b/.test(home) && !/function TodayCleanCard\b/.test(home), '10.2 …and its cards with it');

// ── §11 integration: Home's live tiles and "Save checklist & clock out" ──────────────────────
ok(/useMyHoursSummary\(/.test(home) && /useMyRequestsCount\(/.test(home), '11.1 Home\'s My Hours and Client Requests tiles read C\'s shared reads');
ok(/hours\.label \|\| t\('crewHome\.tile\.hoursSub'\)|hours\.label\s*\?/.test(home), '11.2 …and keep their quiet line while the read is loading or failed (no number it does not have)');
ok(/checklistProgress\(/.test(home) && /readChecklistDraft\(/.test(home), '11.3 the checklist tile and the hero count the unsaved draft on the phone (B\'s draft)');
ok(/submitChecklistDraft\(/.test(actions) && /clockOutPlan\(/.test(actions), '11.4 the one clock saves the draft by B\'s submitChecklistDraft, by the pure plan');
const saveAt = actions.indexOf('submitChecklistDraft(');
const outAt = actions.indexOf('doClockOut()', saveAt);
ok(saveAt > 0 && outAt > saveAt, '11.5 …the save runs BEFORE the clock-out, in that order');
ok(/catch \(e\) \{[\s\S]{0,400}crewClock\.saveFailed[\s\S]{0,200}return;/.test(actions), '11.6 …and a failed save (lock on) clocks nothing out and says why');
ok(/'crewClock\.saveAndClockOut': 'Save checklist & clock out',/.test(en) && /finishClockOut/.test(control) && /finishClockOut/.test(clockPage),
  '11.7 both clocks offer "Save checklist & clock out" through the same action');

console.log(`\ntest-crew-shell: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exitCode = 1;
