// test-supply-home-render — the Supply Manager's Home, RENDERED (S131, brief S §4: "Prove it in a
// render test now"; Builder R mounts it as the `supply_manager` role's `/` in Wave 2).
//
// pages/SupplyHome.jsx is bundled once (rolldown, as test-product-name renders its views) and drawn
// with react-dom/server for a signed-in Supply Manager, with routing, the session, the store, the
// permissions, the toasts and the supplies read stubbed — the read never answers, so the page draws
// its first state, the one a phone shows before the queue lands. What it proves, from the markup:
//   1. "Hey, {first name}" and the role line (lib/roles roleLabel — the reader's role, in its words)
//   2. the four tiles in the board's order — New orders · With supplier · Partially fulfilled ·
//      Completed today — each linking to its tab (?status=)
//   3. the "Order Queue" heading over the ONE queue (components/SupplyQueue), its tabs approved onward
//      (lib/supplies SUPPLY_MANAGER_TABS — New · With supplier · Partially fulfilled · Completed):
//      never Pending approval or Declined (Matt: only approved orders reach the Supply Manager)
//   4. the queue's honest first state (loading), never an empty claim before the read lands
//
//   node scripts/test-supply-home-render.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated, because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const { en } = await import('../src/i18n/catalog/en.js').then((m) => ({ en: m.default || m.EN || m.en || m }));
const word = (key) => (typeof en[key] === 'string' ? en[key] : '');
const lib = await import('../src/lib/supplies.js');
const roles = await import('../src/lib/roles.js');

const ME = { id: 'u_sm', name: 'Renee Park', role: 'manager', status: 'active' };
const CACHE = path.join(APP, 'node_modules', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(CACHE, 'test-supply-home-'));
const abs = (...p) => JSON.stringify(path.join(APP, ...p).split(path.sep).join('/'));
const entry = path.join(tmp, 'entry.jsx');
fs.writeFileSync(entry, `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import SupplyHome from ${abs('src', 'pages', 'SupplyHome.jsx')};
export const home = () => renderToStaticMarkup(createElement(SupplyHome));
`);
const SHIMS = {
  '\0rrd': `import { createElement } from 'react';
export function Link({ to, state, children, ...rest }) { return createElement('a', { href: typeof to === 'string' ? to : '#', ...rest }, children); }
export function Outlet() { return null; }
export function useNavigate() { return () => {}; }
export function useLocation() { return { pathname: '/', search: '', hash: '', state: null, key: 'default' }; }
export function useParams() { return {}; }
export function useSearchParams() { return [new URLSearchParams(''), () => {}]; }`,
  // useSelector too: the queue's per-order rules (hooks/useSupplyRules, S131 Wave 2) read the roster,
  // the customers and the ops settings as slices.
  '\0store': `const STATE = { users: [${JSON.stringify(ME)}], clients: [], sites: [], permissions: [], userPermissionOverrides: [], opsSettings: {}, company: {} };
export function useStore() { return STATE; }
export function useSelector(select) { return select(STATE); }
export function useDispatch() { return () => {}; }`,
  '\0auth': `export function useAuth() { return { currentUser: ${JSON.stringify(ME)} }; }`,
  // The Supply Manager's keys: view, manage, deliver — never approve.
  '\0perm': `const HELD = new Set(['supplies.view', 'supplies.manage', 'supplies.deliver', 'supplies.request']);
export function usePermission(key) { return HELD.has(key); }`,
  '\0online': 'export function useOnlineStatus() { return true; }',
  '\0toast': `const no = () => {};
export function useToast() { return { success: no, error: no, info: no, warning: no }; }
export default function Toast() { return null; }`,
  // The read never answers: the page draws the state before the queue lands.
  '\0supplies-api': `export const SUPPLY_PAGE_SIZE = 20;
const never = () => new Promise(() => {});
export const listOrders = never; export const decideRequests = never; export const submitOrders = never; export const cancelRequest = never;`,
  '\0i18n-runtime': `const snap = { choice: 'auto', phone: null, lang: 'en', version: 0 };
export function subscribeLanguage() { return () => {}; }
export function getLanguageSnapshot() { return snap; }
export function currentLanguage() { return 'en'; }
export function setLanguageChoice() {}
export function ensureCatalog() { return Promise.resolve(true); }
export function preloadCurrentLanguage() { return Promise.resolve(true); }`,
};
const plugin = {
  name: 'supply-home-render-test',
  resolveId(id, importer) {
    if (id === 'react-router-dom') return '\0rrd';
    if (/(^|[\\/])store(\/index(\.jsx)?)?$/.test(id) && /^\.\.?\//.test(id) && !/selectors/.test(id)) return '\0store';
    if (/(^|[\\/])useAuth(\.js)?$/.test(id)) return '\0auth';
    if (/(^|[\\/])usePermission(\.js)?$/.test(id)) return '\0perm';
    if (/(^|[\\/])useOnlineStatus(\.js)?$/.test(id)) return '\0online';
    if (/(^|[\\/])components[\\/]Toast(\.jsx)?$/.test(id) || (/(^|[\\/])Toast(\.jsx)?$/.test(id) && /[\\/]components[\\/]/.test(importer || ''))) return '\0toast';
    if (/(^|[\\/])suppliesApi(\.js)?$/.test(id)) return '\0supplies-api';
    if (/(^|[\\/])runtime(\.js)?$/.test(id) && /[\\/]src[\\/]i18n[\\/]/.test(importer || '')) return '\0i18n-runtime';
    return null;
  },
  load(id) { return Object.hasOwn(SHIMS, id) ? SHIMS[id] : null; },
};

let html = '';
try {
  const bundle = await rolldown({
    input: entry, platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: true, SSR: true }) } },
  });
  await bundle.write({ file: path.join(tmp, 'views.mjs'), format: 'esm' });
  const views = await import(pathToFileURL(path.join(tmp, 'views.mjs')).href);
  html = views.home();
} catch (e) {
  fails.push(`the Supply Manager's Home bundles and renders (${String(e?.message || e).split('\n')[0]})`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const text = (s) => String(s || '').replace(/<!-- -->/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const flat = text(html);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
const greeting = fill(word('supplyPage.home.greeting'), { name: 'Renee' });
ok(`1. the Home greets the Supply Manager by first name ("${greeting}")`, !!html && !!word('supplyPage.home.greeting') && /<h1[^>]*>/.test(html) && text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]) === greeting, flat.slice(0, 200));
const roleLine = roles.roleLabel((k) => word(k), ME.role);
ok(`1. … with the role line ("${roleLine}")`, !!roleLine && new RegExp(`class="page-sub"[^>]*>${roleLine}<`).test(html), html.slice(0, 400));

const TILES = [['supplyPage.tiles.new', 'approved'], ['supplyPage.tiles.supplier', 'sent'], ['supplyPage.tiles.partial', 'partial'], ['supplyPage.tiles.completedToday', 'completed']];
const tileLabels = [...html.matchAll(/class="stat-label"[^>]*>([^<]*)</g)].map((m) => m[1]);
ok('2. the four tiles, in the board\'s order: New orders · With supplier · Partially fulfilled · Completed today',
  JSON.stringify(tileLabels) === JSON.stringify(TILES.map(([k]) => word(k))), JSON.stringify(tileLabels));
const tileLinks = [...html.matchAll(/<a [^>]*class="stat-card stat-card-link"[^>]*>/g)].map((m) => (/href="([^"]*)"/.exec(m[0]) || [])[1]);
ok('2. … each opening its tab (?status=)', JSON.stringify(tileLinks) === JSON.stringify(TILES.map(([, s]) => `?status=${s}`)), JSON.stringify(tileLinks));

ok(`3. the "${word('supplyPage.home.queueTitle')}" heading over the queue`, html.includes(`>${word('supplyPage.home.queueTitle')}</h3>`) && html.indexOf(word('supplyPage.home.queueTitle')) < html.indexOf('supply-status-tabs'));
const tabLabels = [...html.matchAll(/<button type="button" class="tab-btn[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
ok('3. the ONE queue from approved onward: New · With supplier · Partially fulfilled · Completed (SUPPLY_MANAGER_TABS)',
  JSON.stringify(tabLabels) === JSON.stringify(lib.SUPPLY_MANAGER_TABS.map((s) => word(lib.SUPPLY_QUEUE_TAB_KEYS[s]))), JSON.stringify(tabLabels));
ok('3. … never Pending approval or Declined', !tabLabels.includes(word('supplyPage.queue.tab.pending')) && !tabLabels.includes(word('supplyPage.queue.tab.declined')));
ok('4. before the read lands it says it is loading (never an empty claim)', flat.includes(word('common.loading')) && !flat.includes(word('supplyPage.empty.approved')));

console.log(`\ntest-supply-home-render: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
