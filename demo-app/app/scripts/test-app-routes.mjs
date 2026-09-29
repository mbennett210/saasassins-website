// test-app-routes — the browser sweeps' shared route list, in CI.
//
// lint:responsive (the responsive BUILD GATE), lint:reskin (UI_RULES §121) and style-snapshot (§120's
// no-op proof) need a running app and Chrome, so CI can't run them. What CI holds here, so none of them can
// quietly stop looking at a surface:
//   1. the list is every surface App.jsx routes to: each page route, each parameter route through its
//      seeded demo ids, the login and public pages, and the catch-all's not-found page; a redirect is
//      not a surface;
//   2. a new route that takes a parameter fails until it has a demo id, and PARAMS keeps no id for a route
//      App.jsx no longer declares;
//   3. all three sweeps read this list (no hand list of their own, the drift that let two of them sweep
//      a dead `/complaints` and miss eight surfaces), and each fails a demo page that says "not found".
import fs from 'node:fs';
import { appRoutes, publicRoutes, staleParams, PARAMS, NOT_FOUND, DEMO_PATHS, missingRecord } from './app-routes.mjs';
import { parseRoutes } from './search-lint.mjs';

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };
const src = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

console.log('the list');
const appSrc = src('../src/App.jsx');
const routes = appRoutes();
const { pageRoutes, paramRoutes, publicPaths } = parseRoutes(appSrc);
const pages = [...pageRoutes.keys()];
ok(pages.every((p) => routes.includes(p)), `all ${pages.length} page routes are swept`);
const params = [...paramRoutes, ...publicPaths].filter((p) => p.includes('/:'));
ok(params.every((p) => (PARAMS[p] || []).length && PARAMS[p].every((c) => routes.includes(c))), `all ${params.length} parameter routes are swept through their demo ids`);
const plain = [...publicPaths].filter((p) => !p.includes('/:'));
ok(plain.every((p) => routes.includes(p)), `the shell-less pages are swept (${plain.join(', ')})`);
ok(routes.includes(NOT_FOUND) && /<Route\s+path="\*"/.test(appSrc), `the not-found page is swept (${NOT_FOUND})`);
for (const r of ['/', '/review', '/reports', '/time', '/login', '/quotes/new', '/quotes/quote_aventura', '/messaging/cv_seed_c1', '/quote/tokquote_aventura', '/inspect/tok_ir_lasolas']) ok(routes.includes(r), `includes ${r}`);
for (const r of ['/complaints', '/contacts/ct_seed_pat', '/clients/contact/ct_seed_pat', '/reminders', '/drafts']) ok(!routes.includes(r), `leaves out ${r} (not a route, or a redirect)`);
ok(routes.length === new Set(routes).size && routes.length >= 43, `${routes.length} paths, no duplicates`);
const shellLess = publicRoutes();
ok(shellLess.includes('/login') && shellLess.every((p) => routes.includes(p)) && shellLess.every((p) => !pages.includes(p)), `the shell-less paths are the public ones (${shellLess.join(', ')})`);

console.log('the demo ids');
let threw = null;
try { appRoutes('<Routes><Route element={<AuthedShell />}><Route path="widgets/:widgetId" element={<Widget />} /></Route></Routes>'); } catch (e) { threw = e.message; }
ok(/no demo id for the route \/widgets\/:widgetId/.test(threw || ''), 'a new route with a parameter and no demo id fails');
ok(staleParams().length === 0, `PARAMS keeps no id for a route App.jsx no longer declares${staleParams().length ? ` (${staleParams().join(', ')})` : ''}`);
ok(staleParams('<Routes><Route element={<AuthedShell />}></Route></Routes>').length === Object.keys(PARAMS).length, 'a removed route shows up as a stale PARAMS key');
ok(DEMO_PATHS.size >= params.length && !DEMO_PATHS.has('/quotes/new'), `${DEMO_PATHS.size} demo paths must find their record (the new-quote editor has none to find)`);

console.log('the not-found probe');
const probe = (text) => { const g = globalThis.document; globalThis.document = { body: { innerText: text } }; try { return missingRecord(); } finally { globalThis.document = g; } };
for (const t of ['Company not found', 'Invoice not found', 'Job not found', 'Team member not found', 'Quote not found.', 'Document not found', 'Report not found']) ok(probe(`Back\n${t}\n`), `flags "${t}"`);
ok(!probe('Evergreen Medical Center\nMain Hospital\nWeekly janitorial'), 'passes a page that found its record');

console.log('the sweeps read it');
for (const f of ['responsive-sweep.mjs', 'reskin-sweep.mjs', 'style-snapshot.mjs']) {
  const s = src(`./${f}`);
  ok(/from '\.\/app-routes\.mjs'/.test(s) && /\bappRoutes\(\)/.test(s), `${f} takes its routes from app-routes.mjs`);
  ok(!/'\/settings\/(quickstart|reminders)'/.test(s) && !/const\s+(ROUTES|PARAMS)\s*=\s*[[{]/.test(s), `${f} keeps no route list of its own`);
  ok(/DEMO_PATHS\.has\(/.test(s) && /page\.evaluate\(missingRecord\)/.test(s), `${f} fails a demo page that says "not found"`);
  ok(/publicRoutes\(\)/.test(s), `${f} doesn't wait for a .main on the shell-less pages`);
}

if (failed) { console.error(`\n✗ test-app-routes: ${failed} check(s) failed`); process.exit(1); }
console.log(`\n✓ test-app-routes: the sweeps share one list of ${routes.length} paths, every surface App.jsx routes to`);
