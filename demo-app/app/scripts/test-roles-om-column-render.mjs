// test-roles-om-column-render — Settings → Roles, RENDERED, with an Operations Manager column of its
// own (CS-858, plan docs/plans/2026-10-16-om-permission-column.md; Daniel 2026-10-16: "why is supply
// manager there and ops manager not?").
//
// pages/settings/Roles.jsx is bundled once (rolldown, as test-supply-home-render draws its page) and
// drawn with react-dom/server, with routing and the store stubbed and the REAL selectors, roles
// model and catalog underneath. What it proves, from the markup:
//   1. the legend reads six columns in order — Super Admin · Admin · Account Manager · Operations
//      Manager · Supply Manager · Crew (lib/roles PERMISSION_COLUMNS) — each with its own words:
//      "Account Manager" is the AMs' alone now (role.managerColumn.desc no longer says both levels
//      share it) and the OM column has its own (role.opsManager.desc);
//   2. every section's header carries six master switches in that order, so a whole section can be
//      switched for Operations Managers on its own;
//   3. the OM switches show the OM column's data, not the Account Manager's (a key off in the OM
//      column only reads "mixed" for OMs and "on" for AMs);
//   4. view-as an OM shows the OM column's effect: a key their column lacks is locked for them to
//      grant (CS-331), where an AM viewer could grant it.
//
//   node scripts/test-roles-om-column-render.mjs
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
// The store's own imports are extensionless (Vite resolves them); this lets node load the REAL
// selectors for the view-as check below.
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated, because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const show = (v) => JSON.stringify(v);

const en = await import('../src/i18n/catalog/en.js').then((m) => m.default || m);
const word = (key) => (typeof en[key] === 'string' ? en[key] : '');
const R = await import('../src/lib/roles.js');
const OM_COL = 'operations_manager';

const CACHE = path.join(APP, 'node_modules', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(CACHE, 'test-roles-om-'));
const abs = (...p) => JSON.stringify(path.join(APP, ...p).split(path.sep).join('/'));
const entry = path.join(tmp, 'entry.jsx');
fs.writeFileSync(entry, `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import SettingsRoles from ${abs('src', 'pages', 'settings', 'Roles.jsx')};
export const roles = (state) => { globalThis.__rolesTestState = state; return renderToStaticMarkup(createElement(SettingsRoles)); };
`);
const SHIMS = {
  '\0rrd': `import { createElement } from 'react';
export function Link({ to, state, children, ...rest }) { return createElement('a', { href: typeof to === 'string' ? to : '#', ...rest }, children); }
export function useNavigate() { return () => {}; }
export function useLocation() { return { pathname: '/settings/roles', search: '', hash: '', state: null, key: 'default' }; }
export function useParams() { return {}; }
export function useSearchParams() { return [new URLSearchParams(''), () => {}]; }`,
  '\0store': `export function useStore() { return globalThis.__rolesTestState; }
export function useSelector(select) { return select(globalThis.__rolesTestState); }
export function useDispatch() { return () => {}; }`,
  '\0i18n-runtime': `const snap = { choice: 'auto', phone: null, lang: 'en', version: 0 };
export function subscribeLanguage() { return () => {}; }
export function getLanguageSnapshot() { return snap; }
export function currentLanguage() { return 'en'; }
export function setLanguageChoice() {}
export function ensureCatalog() { return Promise.resolve(true); }
export function preloadCurrentLanguage() { return Promise.resolve(true); }`,
};
const plugin = {
  name: 'roles-om-column-render-test',
  resolveId(id, importer) {
    if (id === 'react-router-dom') return '\0rrd';
    if (/(^|[\\/])store(\/index(\.jsx)?)?$/.test(id) && /^\.\.?\//.test(id) && !/selectors/.test(id)) return '\0store';
    if (/(^|[\\/])runtime(\.js)?$/.test(id) && /[\\/]src[\\/]i18n[\\/]/.test(importer || '')) return '\0i18n-runtime';
    return null;
  },
  load(id) { return Object.hasOwn(SHIMS, id) ? SHIMS[id] : null; },
};

let views = null;
try {
  const bundle = await rolldown({
    input: entry, platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: true, SSR: true }) } },
  });
  await bundle.write({ file: path.join(tmp, 'views.mjs'), format: 'esm' });
  views = await import(pathToFileURL(path.join(tmp, 'views.mjs')).href);
} catch (e) {
  fails.push(`Settings → Roles bundles (${String(e?.message || e).split('\n')[0]})`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// A matrix where one key is OFF in the OM column only (time.approve): the OM switches must read it.
const matrix = R.seedPermissions().map((p) => (p.id === 'time.approve' ? { ...p, roles: p.roles.filter((r) => r !== OM_COL) } : p));
const USERS = [
  { id: 'u_owner', name: 'Owner', role: 'owner', status: 'active' },
  { id: 'u_om', name: 'Gabriel Ortiz', role: 'manager', managerLevel: 'operations', status: 'active' },
  { id: 'u_am', name: 'Renata Cruz', role: 'manager', managerLevel: 'account', status: 'active' },
];
const render = (state) => { try { return views ? views.roles(state) : ''; } catch (e) { fails.push(`Roles renders (${String(e?.message || e).split('\n')[0]})`); return ''; } };
const html = render({ users: USERS, currentUserId: 'u_owner', permissions: matrix, userPermissionOverrides: [] });
const text = (s) => String(s || '').replace(/<!-- -->/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&rsquo;/g, '’').replace(/\s+/g, ' ').trim();

// 1. the legend
const legend = [...html.matchAll(/<div class="rp-legend-name">([\s\S]*?)<\/div>/g)].map((m) => text(m[1]).replace(/\s*New$/, ''));
const WANT = ['Super Admin', 'Admin', 'Account Manager', 'Operations Manager', 'Supply Manager', 'Crew'];
ok(`1. the legend reads six columns in order (${show(legend)})`, show(legend) === show(WANT));
ok('1. …the order IS lib/roles PERMISSION_COLUMNS', Array.isArray(R.PERMISSION_COLUMNS) && R.PERMISSION_COLUMNS.length === legend.length);
const descs = [...html.matchAll(/<div class="rp-legend-desc">([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
const omDesc = word('role.opsManager.desc');
ok(`1. the Operations Manager column has its own description (role.opsManager.desc: "${omDesc}")`, !!omDesc && descs[3] === text(omDesc));
const amDesc = word('role.managerColumn.desc');
ok(`1. 🔴 "Account Manager" is the AMs' alone: its description no longer says both levels share it ("${amDesc}")`,
  !!amDesc && descs[2] === text(amDesc) && !/Operations Manager/i.test(amDesc) && !/share/i.test(amDesc));
ok('1. the one shared "Manager" heading is gone from the catalog (replace means delete)', !('role.managerColumn' in en));

// 2. the master switches: six per section, in the column order
const heads = [...html.matchAll(/<div class="rp-row rp-row--head">([\s\S]*?)(?=<div class="rp-row rp-row--head">|<\/div><\/div><\/div><\/div>)/g)].map((m) => m[1]);
const masterLabels = (head) => [...head.matchAll(/<span class="rp-master-label">([^<]*)<\/span>/g)].map((m) => text(m[1]));
ok(`2. there is a section head per permission section (${heads.length})`, heads.length >= 20);
ok(`2. every section head carries six master switches in the column order (${show(masterLabels(heads[0] || ''))})`,
  heads.length > 0 && heads.every((h) => show(masterLabels(h)) === show(WANT)));
ok('2. …each OM master names the section and the column', /aria-label="All of Time &amp; Labor for Operations Manager( \(partially on\))?"/.test(html)
  && /aria-label="All of Contracts for Operations Manager"/.test(html));

// 3. the OM switches show the OM column's data
const masterState = (section, column) => {
  const m = new RegExp(`aria-label="All of ${section.replace(/&/g, '&amp;')} for ${column}( \\(partially on\\))?"`).exec(html);
  if (!m) return null;
  const tag = html.lastIndexOf('<button', m.index);
  const cls = /class="rp-toggle rp-toggle--(\w+)"/.exec(html.slice(tag, m.index + m[0].length));
  return cls ? cls[1] : null;
};
ok(`3. 🔴 a key off in the OM column only: Time & Labor reads "mixed" for Operations Managers (${masterState('Time & Labor', 'Operations Manager')}) and "on" for Account Managers (${masterState('Time & Labor', 'Account Manager')})`,
  masterState('Time & Labor', 'Operations Manager') === 'mixed' && masterState('Time & Labor', 'Account Manager') === 'on');
// (Contracts, since the Quotes section, the example until then, is hidden with Quotes: 2026-10-23, QUOTES_ENABLED.)
ok('3. …a section both columns hold reads "on" for both', masterState('Contracts', 'Operations Manager') === 'on' && masterState('Contracts', 'Account Manager') === 'on');

// 4. view-as an OM: the page's viewer is selectCurrentUser (the REAL selector), and an owner viewing
// as Gabriel gets his roster row, level and all, so the page's grant lock (canGrant, CS-331) reads the
// OM column: a key off in it is locked for him to switch on, where an AM viewer could.
const S = await import('../src/store/selectors.js');
const viewAs = (id) => ({ users: USERS, currentUserId: 'u_owner', viewAsUserId: id, __auth: { claimRole: 'owner' }, permissions: matrix, userPermissionOverrides: [] });
const asOmUser = S.selectCurrentUser(viewAs('u_om'));
const asAmUser = S.selectCurrentUser(viewAs('u_am'));
ok('4. view-as an OM resolves to their roster row, level included', asOmUser?.id === 'u_om' && asOmUser?.managerLevel === 'operations');
const omCanGrant = R.canGrantPermission(asOmUser, 'time.approve', matrix, []);
const amCanGrant = R.canGrantPermission(asAmUser, 'time.approve', matrix, []);
ok(`4. 🔴 …so the grant lock follows the OM column: viewed as an OM, time.approve can't be switched on (${omCanGrant}); as an AM it can (${amCanGrant})`,
  omCanGrant === false && amCanGrant === true);
const asOm = render(viewAs('u_om'));
ok('4. …and the page, viewed as an OM, says they can switch on only what they hold', /You can switch on only the permissions you have yourself/.test(asOm));

console.log(`\ntest-roles-om-column-render: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
