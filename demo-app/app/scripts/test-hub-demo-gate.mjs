// THE HUB'S DEMO IS DEAD IN A PRODUCTION BUILD — and the demo it shows is the real thing.
//
// Daniel has to SEE the customer hub without a production customer login, so the login-free
// demo (`--mode demo`) offers a preview of it: a seeded customer contact (Coral Bay HOA's
// property manager, with a second building through a group) over the demo's own data. Round 1
// refused any hub stub for a reason that still holds: a pretend ACCESS CONTROL must never
// ship. So this suite holds two things, mechanically:
//
//   1. 🔴 THE DEMO PATH CANNOT REACH PRODUCTION. Every demo branch sits behind the STATIC
//      `import.meta.env.MODE === 'demo'` that Vite folds to `false` in `npm run build` (the CS-038
//      pattern), and also behind the runtime `demoBackendsEngaged()`; the demo module itself is
//      reached only through a dynamic import inside such a branch; and check-bundle-stubs (run
//      on a real production build by test-bundle-stubs.mjs) knows the hub's sentinel and the
//      demo's own fixtures, so a production bundle that carried either fails CI.
//   2. THE DEMO'S ANSWERS ARE THE SERVER'S ANSWERS. The demo adapter runs the SAME pure
//      projections (src/lib/clientHubView.js) and the SAME scope rule (resolveAllowedClientIds),
//      and the production gate in HubRoot (isClientSession) is unchanged.
//
// REGRESSION (THE LAW II.3): on the pre-change tree there is no demo, no sentinel and no
// projections module, so every check below fails.
//
//   node app/scripts/test-hub-demo-gate.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CRLF-safe: the integration worktree checks out CRLF (S110 hit two source pins that did not).
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const STATIC_GATE = /import\.meta\.env\.MODE\s*===\s*'demo'/;

// ── 1. the gates ─────────────────────────────────────────────────────────────
const api = code('src/lib/clientHubApi.js');
ok('G1 the hub API declares its demo gate on the STATIC build mode', STATIC_GATE.test(api));
ok('G2 …and asks the runtime demo switch too (no demo where a real backend is configured)', /demoBackendsEngaged\(\)/.test(api));
ok('G3 …and marks the stub sentinel only inside the static gate', /if\s*\(\s*HUB_DEMO\s*\)\s*markStub\('cs-stub:hub'\)/.test(api));
const dyn = [...api.matchAll(/import\(\s*'\.\/hubDemo\.js'\s*\)/g)];
ok('G4 the demo module is reached ONLY by a dynamic import (never a static one that ships)',
  dyn.length >= 1 && !/^import[^\n]*hubDemo/m.test(api), `${dyn.length} dynamic import(s)`);
ok('G5 …and that import sits behind the static gate', /HUB_DEMO\s*\?\s*\([^)]*\)\s*=>\s*import\('\.\/hubDemo\.js'\)/.test(api));
const root = code('src/pages/hub/HubRoot.jsx');
ok('G6 HubRoot\'s demo session sits behind the same static gate and the runtime switch',
  STATIC_GATE.test(root) && /demoBackendsEngaged\(\)/.test(root));
ok('🔴 G7 …and the PRODUCTION gate is unchanged: a non-client session is sent back to the office',
  /isClientSession\(session\)/.test(root) && /<Navigate to="\/" replace \/>/.test(root));
const sw = code('src/components/UserSwitcher.jsx');
// Its words come from the translation catalog (CS-193, Round 3): the switcher names the key and
// the English catalog carries the words.
ok('G8 the demo\'s "Preview the customer hub" entry sits behind the static gate', STATIC_GATE.test(sw)
  && sw.includes("t('userMenu.previewHub')")
  && read('src/i18n/catalog/en.js').includes("'userMenu.previewHub': 'Preview the customer hub'"));

// ── 2. the production bundle cannot carry it ─────────────────────────────────
const cbs = read('scripts/check-bundle-stubs.mjs');
const sentinel = /re:\s*\/cs-stub:\(([^)]*)\)/.exec(cbs)?.[1] || '';
ok('🔴 B1 check-bundle-stubs fails a production bundle carrying the hub\'s stub sentinel', sentinel.split('|').includes('hub'), sentinel);
ok('🔴 B2 …or the demo\'s own fixtures (the demo group exists nowhere else)', /hub-demo-fixtures/.test(cbs) && /Royal Palm Property Management/.test(cbs));
const demo = read('src/lib/hubDemo.js');
ok('B3 that fixture string lives in the demo module and NOWHERE that ships',
  demo.includes('Royal Palm Property Management')
    && !['src/data/demoStubs.js', 'src/lib/clientHubApi.js', 'src/pages/hub/HubRoot.jsx', 'src/data/seed.js'].some((f) => read(f).includes('Royal Palm Property Management')));
ok('B4 test-bundle-stubs builds a PRODUCTION bundle and runs the check on it', /--build/.test(read('scripts/test-bundle-stubs.mjs')));

// ── 3. the demo's answers are the server's ───────────────────────────────────
const demoCode = code('src/lib/hubDemo.js');
ok('S1 the demo exists', demoCode.length > 200);
ok('S2 …and resolves its scope with the ONE rule the server gate runs (resolveAllowedClientIds)', /resolveAllowedClientIds\(/.test(demoCode));
for (const fn of ['projectHubBuilding', 'hubOnSiteList', 'projectHubChecklistRow', 'projectHubChecklist', 'projectHubInspectionRow', 'projectHubInspection', 'projectHubTicketRow', 'projectHubTicket', 'projectHubEvent', 'hubTicketInput', 'hubMessageInput']) {
  ok(`S3 the demo answers through ${fn}, the server's own projection`, new RegExp(`\\b${fn}\\(`).test(demoCode));
}
ok('S4 the server route answers through the same projections', ['hubOnSiteList', 'projectHubChecklist(', 'projectHubInspection(', 'projectHubTicket(', 'projectHubEvent'].every((f) => code('api/hub/[...path].js').includes(f)));
ok('S5 the demo never reads an internal ticket note into a client thread', /hubVisibleMessages|projectHubTicket/.test(demoCode) && !/internal\s*:\s*true/.test(demoCode));

// ── 4. the demo data Daniel will be shown (src/data/demoStubs.js), read mechanically ──
const stubs = read('src/data/demoStubs.js');
ok('D1 a client ticket thread at Coral Bay carries an INTERNAL note (hidden from the hub)', /internal:\s*true/.test(stubs) && /pr_coralbay_windows/.test(stubs));
ok('D2 one ticket completed inside the reopen window and one outside it', /pr_coralbay_carpet/.test(stubs) && /pr_coralbay_pool/.test(stubs));
ok('D3 a checklist with a cleaner\'s notes and a photo', /cr_coralbay_floors_2/.test(stubs) && /notes:\s*\{/.test(stubs));
ok('D4 a failed inspection whose redo the cleaners were sent', /ir_coralbay_fail/.test(stubs));
ok('D5 someone on site now at Coral Bay', /openMinsAgo/.test(read('src/data/demoTimeLedger.js')) && /site:\s*'mtb-clbhs'[^}]*openMinsAgo|openMinsAgo[^}]*site:\s*'mtb-clbhs'/.test(read('src/data/demoTimeLedger.js')));
ok('D6 the demo client user is recorded on the seeded client messages (author_client_user_id)', /author_client_user_id/.test(stubs) && /raised_by_client_user_id/.test(stubs));
ok('D7 the seeded routes the browser sweeps read are the demo\'s own ids', ['/hub/b/cl_seed_mtbaker'].every((p) => read('scripts/app-routes.mjs').includes(p)));
ok('D8 the demo module exists on disk', existsSync(path.join(APP, 'src/lib/hubDemo.js')));

console.log(`\nhub demo gate: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
