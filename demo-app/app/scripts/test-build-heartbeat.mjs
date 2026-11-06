// CS-651 — the build heartbeat (components/BuildHeartbeat.jsx) POSTs /api/state/heartbeat only
// where there IS a backend session to post with. In the login-free demo (no Supabase auth
// configured — the demo build blanks it) the route can only answer 401, so every page logged a
// 401 in the console (and hid real errors among them). The rule is the one the other server-only
// pings already use: lib/supabaseClient `isAuthConfigured()` (lib/push's flush backend, the service
// worker registration in main.jsx, the store's shared sync) — not a second rule.
//
// The REAL component, bundled once (rolldown, as test-product-name.mjs bundles its views), with
// React's `useEffect` replaced by a recorder so its effect can be run here, and its four imports
// stubbed: whether auth is configured, the auth header, the build id, and the punch counts. Then:
//   H1  demo (no auth configured): the effect posts NOTHING, and registers no 6-hour timer and no
//       visibility listener that would retry the 401 for as long as the tab is open
//   H2  connected (auth configured): one POST to /api/state/heartbeat with the build, the device key and
//       the punch counts, a timer and a listener — and its cleanup removes them (a control)
//   H3  the component reads the shared predicate and holds no rule of its own
//
// REGRESSION (THE LAW II.3): on the tree before the fix H1 and H3 fail (it posts in every mode).
//
//   node app/scripts/test-build-heartbeat.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENT = path.join(APP, 'src', 'components', 'BuildHeartbeat.jsx');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

// What the bundle's stubs read and record.
const HB = { auth: false, effects: [], fetches: [], timers: [], cleared: [], listeners: [] };
globalThis.__HB = HB;

const SHIMS = {
  '\0react': `export function useEffect(fn) { globalThis.__HB.effects.push(fn); }`,
  '\0supabase-client': `export const supabase = null;
export const supabaseRead = null;
export const isAuthConfigured = () => !!globalThis.__HB.auth;`,
  '\0auth-header': `export async function authHeaders() { return globalThis.__HB.auth ? { Authorization: 'Bearer test-session' } : {}; }`,
  '\0app-build': `export const APP_BUILD = 'build-under-test'; export const TAB_ID = 'tab-under-test'; export function deviceKey() { return 'device-under-test'; }`,
  '\0time-api': `export async function pendingPunchCount({ includeFailed = false } = {}) { return includeFailed ? 3 : 2; }
export function isTimeStub() { return !globalThis.__HB.auth; }`,
};
const plugin = {
  name: 'build-heartbeat-test',
  resolveId(id) {
    if (id === 'react') return '\0react';
    if (/(^|[\\/])supabaseClient(\.js)?$/.test(id)) return '\0supabase-client';
    if (/(^|[\\/])authHeader(\.js)?$/.test(id)) return '\0auth-header';
    if (/(^|[\\/])appBuild(\.js)?$/.test(id)) return '\0app-build';
    if (/(^|[\\/])timeApi(\.js)?$/.test(id)) return '\0time-api';
    return null;
  },
  load(id) { return Object.hasOwn(SHIMS, id) ? SHIMS[id] : null; },
};

const CACHE = path.join(APP, 'node_modules', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(CACHE, 'test-build-heartbeat-'));
let BuildHeartbeat = null;
try {
  const bundle = await rolldown({
    input: COMPONENT, platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: true }) } },
  });
  await bundle.write({ file: path.join(tmp, 'heartbeat.mjs'), format: 'esm' });
  BuildHeartbeat = (await import(pathToFileURL(path.join(tmp, 'heartbeat.mjs')).href)).default;
} catch (e) {
  fails.push(`the component bundles and loads (${String(e?.message || e).split('\n')[0]})`);
}

// The browser globals the effect touches, recorded.
globalThis.fetch = async (url, init) => { HB.fetches.push({ url: String(url), init }); return new Response('{}', { status: 200 }); };
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (ev, fn) => { HB.listeners.push({ ev, fn, on: true }); },
  removeEventListener: (ev, fn) => { const l = HB.listeners.find((x) => x.ev === ev && x.fn === fn); if (l) l.on = false; },
};
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { const id = { fn, ms }; HB.timers.push(id); return id; };
globalThis.clearInterval = (id) => { HB.cleared.push(id); };
const settle = () => new Promise((r) => setTimeout(r, 20));

// Render once: call the component (it registers its effect), run the effect, let its beat finish.
async function mount(auth) {
  Object.assign(HB, { auth, effects: [], fetches: [], timers: [], cleared: [], listeners: [] });
  BuildHeartbeat();
  const cleanups = HB.effects.map((fn) => fn());
  await settle();
  return () => cleanups.forEach((c) => { if (typeof c === 'function') c(); });
}
const beats = () => HB.fetches.filter((f) => f.url.includes('/api/state/heartbeat'));

if (BuildHeartbeat) {
  // ── H1. the demo: no backend session, no heartbeat ──
  const offDemo = await mount(false);
  ok('🔴 H1a demo (no auth configured): the heartbeat posts nothing — no 401 on every page', () => beats().length === 0, JSON.stringify(beats().map((b) => b.url)));
  ok('🔴 H1b …and sets no 6-hour timer and no visibility listener to retry it', () => HB.timers.length === 0 && HB.listeners.length === 0,
    `${HB.timers.length} timer(s), ${HB.listeners.length} listener(s)`);
  offDemo();

  // ── H2. connected: the heartbeat is unchanged (a control) ──
  const offLive = await mount(true);
  const b = beats()[0];
  let sent = null;
  try { sent = JSON.parse(b?.init?.body || 'null'); } catch { sent = null; }
  ok('H2a connected: ONE POST to /api/state/heartbeat with the session\'s header', () => beats().length === 1 && b.init?.method === 'POST' && b.init.headers?.Authorization === 'Bearer test-session', JSON.stringify(b));
  ok('H2b …carrying the build, the DEVICE key as its tab (one row per phone, CS-727) and the punch counts', () => sent && sent.build === 'build-under-test' && sent.tab === 'device-under-test'
    && sent.pendingPunches === 2 && sent.failedPunches === 1 && sent.stub === false, JSON.stringify(sent));
  ok('H2c …with its 6-hour timer and its visibility listener', () => HB.timers.length === 1 && HB.timers[0].ms === 6 * 60 * 60 * 1000 && HB.listeners.some((l) => l.ev === 'visibilitychange' && l.on));
  offLive();
  ok('H2d …both removed when the component goes', () => HB.cleared.length === 1 && HB.listeners.every((l) => !l.on));
}

// ── H3. one rule, shared ──
{
  const src = fs.readFileSync(COMPONENT, 'utf8');
  ok('🔴 H3a the component reads the shared predicate (lib/supabaseClient isAuthConfigured)', () => /import \{[^}]*\bisAuthConfigured\b[^}]*\} from '\.\.\/lib\/supabaseClient(\.js)?';/.test(src) && /isAuthConfigured\(\)/.test(src));
  ok('H3b …and holds no rule of its own (no env read, no mode test)', () => !/import\.meta\.env/.test(src) && !/MODE\b/.test(src) && !/VITE_/.test(src));
}

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\ntest-build-heartbeat: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
