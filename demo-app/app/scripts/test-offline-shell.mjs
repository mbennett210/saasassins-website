// CS-665 — offline, a cleaner who opens a clean (or any screen not yet loaded) loses the app.
//
// WHAT WAS WRONG. Every route is a lazy chunk. A chunk that fails to load was treated as a
// stale build and answered with `location.reload()` (App.jsx lazyRoute, main.jsx
// vite:preloadError, lib/staleBuild), and the service worker had no fetch handler — so with
// no signal the reload landed on the browser's "no internet" page and the app was gone; an
// installed app could not start offline at all. Hashed build files were also served
// `max-age=0, must-revalidate`, so even a chunk fetched yesterday could not be reused offline.
//
// WHAT THIS PINS, layer by layer:
//   §1  the decision (pure): offline → never reload; online and the server answers → reload
//       onto the new build (cooldown-guarded); reloaded moments ago → surface the error
//   §2  the decision EXECUTED against a stand-in browser (navigator.onLine, the probe,
//       sessionStorage, location.reload) — offline it never reloads
//   §3  the service worker, run in a sandbox with a fake network and Cache Storage: install
//       keeps the shell + the crew screens (and refuses a page from another build), a page
//       with no signal gets the kept shell, a kept build file is served with no signal, /api
//       and other sites are never touched, the dev server's worker caches nothing
//   §4  the build half: which files a phone keeps (the shell, each crew screen and what it
//       imports, the language catalogs, the page's icons), written into sw.js — and a missing
//       placeholder or screen fails the build
//   §5  vercel.json: hashed /assets/* are immutable; the page and the worker are not
//   §6  wiring: main.jsx registers the worker in every build and routes a failed chunk
//       through the offline-aware door; lazyRoute shows the offline screen; the kept screens
//       cover the crew's nav and the visit (derived from navData + App.jsx, so a crew screen
//       added later cannot be left out)
//   §7  an installed app started with no signal and an expired token stays signed in on the
//       phone's own session (it used to land on the sign-in page, which needs a signal)
//   §8  the offline screen's words are the catalog's
//
// REGRESSION (THE LAW II.3): on the pre-fix tree the new exports and the build module do not
// exist and sw.js has no fetch handler, so every section reports what it wanted.
//
//   node scripts/test-offline-shell.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

// The app's own imports omit the extension (Vite resolves them); a few read import.meta.env.
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec)) {
        for (const ext of ['.js', '.jsx', '/index.js']) { try { return next(spec + ext, ctx); } catch { /* next */ } }
      }
      throw e;
    }
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (/\/app\/src\//.test(url) && r.source && String(r.source).includes('import.meta.env')) {
      r.source = `if (!import.meta.env) import.meta.env = { MODE: 'test', PROD: false, DEV: true };\n${r.source}`;
    }
    return r;
  },
});
const imp = (rel, q = '') => import(pathToFileURL(path.join(APP, rel)).href + q).catch(() => ({}));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const stale = await imp('src/lib/staleBuild.js');
const swb = await imp('vite-plugins/sw-precache.mjs');
const offlineSession = await imp('src/lib/offlineSession.js');

// ── §1 the decision, pure ──────────────────────────────────────────────────────────────
{
  const act = typeof stale.chunkFailureAction === 'function' ? stale.chunkFailureAction : () => undefined;
  const A = stale.CHUNK_FAILURE || {};
  const now = 1_790_000_000_000;
  const cool = stale.RELOAD_COOLDOWN_MS || 30_000;
  ok('§1 the outcomes are named (offline / reload / error)', A.OFFLINE === 'offline' && A.RELOAD === 'reload' && A.ERROR === 'error');
  eq('§1 no signal → offline, never a reload', act({ online: false, reachable: true, lastReloadAt: null, now }), 'offline');
  eq('§1 signal bars but no answer from the server → offline', act({ online: true, reachable: false, lastReloadAt: null, now }), 'offline');
  eq('§1 …even when a reload would otherwise be due', act({ online: false, reachable: false, lastReloadAt: String(now - 10 * cool), now }), 'offline');
  eq('§1 online, the server answers, the chunk is gone → a deploy replaced it: reload', act({ online: true, reachable: true, lastReloadAt: null, now }), 'reload');
  eq('§1 a later deploy in a long session still reloads', act({ online: true, reachable: true, lastReloadAt: String(now - cool - 1), now }), 'reload');
  eq('§1 reloaded seconds ago and still failing → surface the error (no loop)', act({ online: true, reachable: true, lastReloadAt: String(now - 2_000), now }), 'error');
}

// ── §2 the decision, executed against a stand-in browser ───────────────────────────────
// A fresh module instance per case (a query string makes node load a separate copy), so its
// single-flight and reload flags start clear.
let fresh = 0;
async function runFailure({ online = true, probe = 'answers', stored = null }) {
  const store = new Map(stored == null ? [] : [[stale.RELOAD_KEY || 'rfs.chunkReload', String(stored)]]);
  let reloads = 0;
  const probes = [];
  globalThis.window = { location: { reload: () => { reloads += 1; } } };
  globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: online }, configurable: true, writable: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    probes.push({ url: String(url), method: init.method || 'GET', cache: init.cache || null });
    if (probe === 'answers') return new Response('', { status: 200 });
    if (probe === '404') return new Response('', { status: 404 });
    throw new TypeError('Failed to fetch');
  };
  fresh += 1;
  const mod = await imp('src/lib/staleBuild.js', `?case=${fresh}`);
  let action;
  try { action = typeof mod.onChunkLoadFailure === 'function' ? await mod.onChunkLoadFailure() : (mod.recoverFromStaleBuild?.() ? 'reload' : 'error'); }
  finally { globalThis.fetch = realFetch; }
  delete globalThis.window; delete globalThis.sessionStorage;
  return { action, reloads, probes };
}
{
  const r = await runFailure({ online: false });
  eq('§2 navigator offline → the app stays (no reload)', r.reloads, 0);
  eq('§2 …and the answer is "offline"', r.action, 'offline');
  eq('§2 …without even asking the network', r.probes.length, 0);
}
{
  const r = await runFailure({ online: true, probe: 'fails' });
  eq('§2 "online" but the server does not answer → no reload', r.reloads, 0);
  eq('§2 …"offline"', r.action, 'offline');
  ok('§2 the probe is the app\'s own page, never a cached copy, never /api', r.probes.length === 1 && /\/index\.html/.test(r.probes[0].url) && r.probes[0].cache === 'no-store' && !/\/api\//.test(r.probes[0].url), JSON.stringify(r.probes));
}
{
  const r = await runFailure({ online: true, probe: 'answers' });
  eq('§2 online and the server answers → the stale-build reload still happens', r.reloads, 1);
  eq('§2 …"reload"', r.action, 'reload');
}
{
  const r = await runFailure({ online: true, probe: '404' });
  eq('§2 any HTTP answer (even a 404) means the server is there → reload', r.reloads, 1);
}
{
  const r = await runFailure({ online: true, probe: 'answers', stored: Date.now() - 2_000 });
  eq('§2 reloaded 2 s ago and still failing → no loop', r.reloads, 0);
  eq('§2 …"error"', r.action, 'error');
}
Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });

// ── §3 the service worker, in a sandbox ─────────────────────────────────────────────────
const ORIGIN = 'https://app.test';
const FILES = {
  '/index.html': { body: '<!doctype html><script type="module" src="/assets/index-AAA.js"></script>', type: 'text/html' },
  '/assets/index-AAA.js': { body: 'export const shell = 1;', type: 'text/javascript' },
  '/assets/index-AAA.css': { body: 'body{}', type: 'text/css' },
  '/assets/MyDay-BBB.js': { body: 'export const myDay = 1;', type: 'text/javascript' },
  '/assets/JobDetail-CCC.js': { body: 'export const visit = 1;', type: 'text/javascript' },
  '/assets/Reports-DDD.js': { body: 'export const office = 1;', type: 'text/javascript' },
  '/icon-192.png': { body: 'png', type: 'image/png' },
  '/api/time/mine': { body: '{"entries":[]}', type: 'application/json' },
};
const MANIFEST = {
  buildId: 'b1', entry: '/assets/index-AAA.js',
  precache: ['/assets/JobDetail-CCC.js', '/assets/MyDay-BBB.js', '/assets/index-AAA.css', '/assets/index-AAA.js', '/icon-192.png'],
};

function swSandbox(source, net) {
  const listeners = {};
  const stores = new Map();               // cache name → Map(absolute url → { status, headers, body })
  const abs = (u) => new URL(typeof u === 'string' ? u : u.url, ORIGIN).href;
  const toResponse = (rec) => new Response(rec.body, { status: rec.status, headers: rec.headers });
  const cacheApi = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (req) => (m.has(abs(req)) ? toResponse(m.get(abs(req))) : undefined),
      put: async (req, res) => { m.set(abs(req), { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }); },
      keys: async () => [...m.keys()],
    };
  };
  const caches = {
    open: async (name) => cacheApi(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    has: async (name) => stores.has(name),
    match: async (req) => {
      for (const m of stores.values()) if (m.has(abs(req))) return toResponse(m.get(abs(req)));
      return undefined;
    },
  };
  const fetchFake = async (req, init = {}) => {
    const url = new URL(abs(req));
    net.log.push(url.pathname);
    if (net.hang) return new Promise(() => {});
    if (!net.online) throw new TypeError('Failed to fetch');
    const pathKey = url.pathname === '/' ? '/index.html' : url.pathname;
    const rec = (net.files || FILES)[pathKey] || (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/api/') ? null : (net.files || FILES)['/index.html']);
    void init;
    if (!rec) return new Response('not found', { status: 404 });
    return new Response(rec.body, { status: 200, headers: { 'content-type': rec.type } });
  };
  const ctx = {
    console, URL, Response, Request, Headers, Promise, JSON, Object, Array, Map, Set, Error, TypeError,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 25)),   // fast-forward the worker's timers
    clearTimeout,
    caches, fetch: fetchFake,
    location: new URL(`${ORIGIN}/sw.js`),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
    registration: { showNotification: async () => {} },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'sw.js' });
  const fire = async (type, extra = {}) => {
    const waits = [];
    let responded = null;
    const ev = { ...extra, waitUntil: (p) => { waits.push(p); }, respondWith: (p) => { responded = p; } };
    for (const fn of listeners[type] || []) fn(ev);
    const res = responded ? await responded : 'passthrough';
    await Promise.allSettled(waits);
    return { res, waits };
  };
  const navigate = (p) => fire('fetch', { request: { url: `${ORIGIN}${p}`, method: 'GET', mode: 'navigate' } });
  const get = (p, method = 'GET', origin = ORIGIN) => fire('fetch', { request: { url: `${origin}${p}`, method, mode: 'cors' } });
  return { listeners, stores, fire, navigate, get, caches };
}
const swSource = read('public/sw.js');
const inject = typeof swb.injectPrecache === 'function' ? swb.injectPrecache : (src) => src;
let built = '';
try { built = inject(swSource, MANIFEST); } catch (e) { built = swSource; ok('§3 the real sw.js takes a manifest', false, e.message); }
{
  const net = { online: true, log: [] };
  const sw = swSandbox(built, net);
  ok('§3 the worker answers requests (a fetch handler exists)', !!sw.listeners.fetch?.length);
  const inst = await sw.fire('install');
  const settled = await Promise.allSettled(inst.waits);
  ok('§3 install completes', settled.every((s) => s.status === 'fulfilled'), JSON.stringify(settled.map((s) => s.reason?.message)));
  const names = [...sw.stores.keys()];
  const kept = names.length ? [...sw.stores.get(names[0]).keys()].map((u) => new URL(u).pathname).sort() : [];
  ok('§3 install keeps the page and every listed file', ['/index.html', ...MANIFEST.precache].every((p) => kept.includes(p)), JSON.stringify(kept));
  ok('§3 …and nothing that is not listed (an office screen waits until it is opened)', !kept.includes('/assets/Reports-DDD.js'));
  ok('§3 the cache is named for this build', names.length === 1 && names[0].endsWith('b1'), JSON.stringify(names));

  // online: pages come from the network (a new deploy is picked up at once)
  net.log.length = 0;
  const onlinePage = await sw.navigate('/my-day');
  ok('§3 online, a page comes from the network first', onlinePage.res !== 'passthrough' && net.log.includes('/my-day'), JSON.stringify(net.log));

  // offline: the kept shell, the kept screens; never a dead end for what was kept
  net.online = false;
  const page = await sw.navigate('/schedule/j_seed_md-callout');
  ok('§3 offline, opening the app (or a deep link) answers with the kept page', page.res instanceof Response && page.res.status === 200 && /index-AAA\.js/.test(await page.res.text()));
  const visit = await sw.get('/assets/JobDetail-CCC.js');
  ok('§3 offline, a kept screen\'s code is served from the phone', visit.res instanceof Response && /visit/.test(await visit.res.text()));
  let office = null;
  try { office = await sw.get('/assets/Reports-DDD.js'); } catch (e) { office = { res: e }; }
  ok('§3 offline, a screen never opened fails as a network error (the app then says it opens online)', office.res instanceof TypeError || (office.res instanceof Response && !office.res.ok), String(office.res));

  // never touched: /api, other sites, anything but GET
  net.online = true; net.log.length = 0;
  eq('§3 /api is never answered by the worker', (await sw.get('/api/time/mine')).res, 'passthrough');
  eq('§3 a POST is never answered by the worker', (await sw.get('/assets/MyDay-BBB.js', 'POST')).res, 'passthrough');
  eq('§3 another site is never answered by the worker', (await sw.get('/x.js', 'GET', 'https://fonts.example')).res, 'passthrough');

  // a build file opened online is kept for next time (an office screen, a lazy library)
  net.online = true;
  const first = await sw.get('/assets/Reports-DDD.js');
  ok('§3 a build file fetched online is answered', first.res instanceof Response && first.res.ok);
  net.online = false;
  const second = await sw.get('/assets/Reports-DDD.js');
  ok('§3 …and kept: offline it opens the second time', second.res instanceof Response && second.res.ok);

  // a hung network: the page falls back to the kept shell instead of a long white screen
  net.online = true; net.hang = true;
  const slow = await sw.navigate('/my-day');
  ok('§3 a network that never answers falls back to the kept page', slow.res instanceof Response && slow.res.status === 200);
  net.hang = false;

  // a new build activates: older builds' caches go
  const next = swSandbox(inject(swSource, { ...MANIFEST, buildId: 'b2' }), { online: true, log: [] });
  for (const [k, v] of sw.stores) next.stores.set(k, v);       // the phone's Cache Storage carries over
  await next.fire('install');
  await next.fire('activate');
  const after = [...next.stores.keys()];
  ok('§3 activating a new build drops the old build\'s cache', after.length === 1 && after[0].endsWith('b2'), JSON.stringify(after));
}
{
  // a deploy landing mid-install: the page on the server is another build's → install fails,
  // so the worker already on the phone (and its consistent cache) stays in charge
  const net = { online: true, log: [], files: { ...FILES, '/index.html': { body: '<script src="/assets/index-ZZZ.js"></script>', type: 'text/html' } } };
  const sw = swSandbox(built, net);
  const inst = await sw.fire('install');
  const settled = await Promise.allSettled(inst.waits);
  ok('§3 a page from another build is refused at install', settled.some((s) => s.status === 'rejected'));
}
{
  // the dev server: the GENERATED lines keep their defaults → the worker caches nothing and
  // answers nothing (push only, as before)
  const net = { online: true, log: [] };
  const sw = swSandbox(swSource, net);
  await sw.fire('install');
  eq('§3 dev server: nothing is cached at install', sw.stores.size, 0);
  eq('§3 dev server: a page is not answered by the worker', (await sw.navigate('/my-day')).res, 'passthrough');
  ok('§3 push and its click-through are still handled', !!sw.listeners.push?.length && !!sw.listeners.notificationclick?.length);
}

// ── §4 the build half ───────────────────────────────────────────────────────────────────
{
  const manifestOf = typeof swb.precacheManifest === 'function' ? swb.precacheManifest : () => ({ precache: [] });
  const SCREENS = Array.isArray(swb.OFFLINE_SCREENS) ? swb.OFFLINE_SCREENS : [];
  // The lazy libraries an offline screen loads on demand (the QR scanner and its worker, the Cleaner
  // Hub's scan page): their own chunks, reached by a DYNAMIC import that keep() does not follow.
  const LAZY = Array.isArray(swb.OFFLINE_LAZY_MODULES) ? swb.OFFLINE_LAZY_MODULES : [];
  const root = 'C:/app';
  const chunk = (fileName, id, extra = {}) => ({ type: 'chunk', fileName, facadeModuleId: id ? `${root}/${id}` : null, imports: [], dynamicImports: [], isEntry: false, viteMetadata: { importedCss: new Set(), importedAssets: new Set() }, ...extra });
  const bundle = {};
  const add = (c) => { bundle[c.fileName] = c; return c; };
  add(chunk('assets/index-E.js', 'index.html', { isEntry: true, imports: ['assets/react-R.js', 'assets/store-S.js'], dynamicImports: SCREENS.map((s) => `assets/${path.basename(s, '.jsx')}-X.js`).concat(['assets/Reports-O.js', 'assets/es-L.js']), viteMetadata: { importedCss: new Set(['assets/index-E.css']), importedAssets: new Set() } }));
  add(chunk('assets/react-R.js', null));
  add(chunk('assets/store-S.js', null, { imports: ['assets/react-R.js'] }));
  add(chunk('assets/Shared-H.js', null));
  add(chunk('assets/Heavy-P.js', null));
  for (const s of SCREENS) add(chunk(`assets/${path.basename(s, '.jsx')}-X.js`, s, { imports: ['assets/Shared-H.js'] }));
  add(chunk('assets/Reports-O.js', 'src/pages/Reports.jsx', { imports: ['assets/Heavy-P.js'] }));
  LAZY.forEach((mod, i) => add(chunk(`assets/lazy${i}-Q.js`, mod)));
  add(chunk('assets/es-L.js', 'src/i18n/catalog/es.js'));
  bundle['assets/index-E.css'] = { type: 'asset', fileName: 'assets/index-E.css' };
  let m = { precache: [] };
  try { m = manifestOf(bundle, { rootFiles: ['icon-192.png', 'manifest.json'] }); } catch (e) { ok('§4 the manifest builds', false, e.message); }
  const has = (f) => (m.precache || []).includes(f);
  ok('§4 the shell is kept: the entry, what it imports, its CSS', has('/assets/index-E.js') && has('/assets/react-R.js') && has('/assets/store-S.js') && has('/assets/index-E.css'), JSON.stringify(m.precache));
  ok('§4 every offline screen is kept with what it imports', SCREENS.length > 0 && SCREENS.every((s) => has(`/assets/${path.basename(s, '.jsx')}-X.js`)) && has('/assets/Shared-H.js'));
  ok('§4 the language catalogs are kept (a Spanish cleaner\'s words are their own download)', has('/assets/es-L.js'));
  ok('§4 an office screen and what only it imports are NOT kept up front', !has('/assets/Reports-O.js') && !has('/assets/Heavy-P.js'));
  ok('§4 the page\'s own icons and manifest are kept; the page and the worker are not listed', has('/icon-192.png') && has('/manifest.json') && !has('/index.html') && !has('/sw.js'));
  eq('§4 the entry is named, so the worker can refuse a page from another build', m.entry, '/assets/index-E.js');
  ok('§4 the build id is a digest of what is kept', typeof m.buildId === 'string' && /^[0-9a-f]{8,}$/.test(m.buildId), String(m.buildId));
  let m2 = null;
  try { m2 = manifestOf({ ...bundle, 'assets/index-E.js': { ...bundle['assets/index-E.js'], fileName: 'assets/index-F.js' } }, { rootFiles: ['icon-192.png', 'manifest.json'] }); } catch { m2 = null; }
  ok('§4 a build that changes what is kept is a new build id', !!m2 && m2.buildId !== m.buildId);
  let threw = false;
  try { const b = { ...bundle }; delete b[`assets/${path.basename(SCREENS[0] || 'x', '.jsx')}-X.js`]; manifestOf(b, {}); } catch { threw = true; }
  ok('§4 a crew screen missing from the build FAILS the build (offline is never switched off silently)', threw);
  ok('§4 the lazy libraries an offline screen loads (the QR scanner and its worker) are kept up front',
    LAZY.length >= 2 && LAZY.every((_, i) => has(`/assets/lazy${i}-Q.js`)), JSON.stringify(LAZY));
  let lazyThrew = false;
  try { const b = { ...bundle }; delete b['assets/lazy0-Q.js']; manifestOf(b, {}); } catch { lazyThrew = true; }
  ok('§4 …and one the build lacks FAILS the build', lazyThrew);

  // the placeholders in the real sw.js, and the injection
  ok('§4 sw.js carries the three generated lines with their dev defaults', /^const BUILD_ID = 'dev';$/m.test(swSource) && /^const SHELL_ENTRY = '';$/m.test(swSource) && /^const PRECACHE = \[\];$/m.test(swSource));
  let out = '';
  try { out = inject(swSource, MANIFEST); } catch { out = ''; }
  ok('§4 the injection writes the build id, the entry and the list', /const BUILD_ID = 'b1';/.test(out) && /const SHELL_ENTRY = '\/assets\/index-AAA\.js';/.test(out) && out.includes('"/assets/MyDay-BBB.js"'));
  ok('§4 …and leaves the brand\'s generated line alone', /^const APP_NAME = ".*?"; \/\/ GENERATED by `npm --prefix app run brand`/m.test(out));
  let refused = false;
  try { inject('self.addEventListener("push", () => {});', MANIFEST); } catch { refused = true; }
  ok('§4 a worker that lost its placeholders FAILS the build', typeof swb.injectPrecache === 'function' && refused);

  // the plugin end to end on a temp build directory
  if (typeof swb.swPrecachePlugin === 'function') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-precache-'));
    try {
      fs.writeFileSync(path.join(dir, 'sw.js'), swSource);
      fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/index-E.js"></script>');
      fs.writeFileSync(path.join(dir, 'icon-192.png'), 'png');
      const plugin = swb.swPrecachePlugin();
      await plugin.writeBundle.call({}, { dir }, bundle);
      const written = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
      ok('§4 the plugin rewrites <outDir>/sw.js after the build', /const BUILD_ID = '[0-9a-f]{8,}';/.test(written) && written.includes('"/assets/index-E.js"') && written.includes('"/icon-192.png"'));
      ok('§4 the plugin runs only for a build', plugin.apply === 'build');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } else ok('§4 the Vite plugin exists', false);
  ok('§4 vite.config.js runs the plugin', /swPrecachePlugin\(\)/.test(read('vite.config.js')) && /from '\.\/vite-plugins\/sw-precache\.mjs'/.test(read('vite.config.js')));
}

// ── §5 vercel.json ───────────────────────────────────────────────────────────────────────
{
  let v = {};
  try { v = JSON.parse(read('vercel.json')); } catch { v = {}; }
  const rules = Array.isArray(v.headers) ? v.headers : [];
  // Vercel matches `source` as a path-to-regexp pattern; the two used here are literal paths
  // and `(.*)` groups, so this translation is exact for them.
  const re = (src) => new RegExp(`^${src.split('(.*)').map((part) => part.replace(/[.]/g, '\\.')).join('.*')}$`);
  const cacheFor = (p) => {
    let val = null;
    for (const r of rules) if (re(r.source).test(p)) for (const h of r.headers || []) if (String(h.key).toLowerCase() === 'cache-control') val = h.value;
    return val;
  };
  const a = cacheFor('/assets/JobDetail-C7fZ8ozv.js') || '';
  ok('§5 hashed build files are immutable for a year', /immutable/.test(a) && Number((/max-age=(\d+)/.exec(a) || [])[1]) >= 31536000, a);
  ok('§5 …CSS too', /immutable/.test(cacheFor('/assets/index-D6X17g-x.css') || ''));
  ok('§5 the page itself is never immutable (a deploy must reach it)', !/immutable/.test(cacheFor('/') || '') && !/immutable/.test(cacheFor('/index.html') || '') && !/immutable/.test(cacheFor('/my-day') || ''));
  ok('§5 the worker is always revalidated', /no-cache/.test(cacheFor('/sw.js') || ''));
}

// ── §6 wiring ─────────────────────────────────────────────────────────────────────────────
{
  const main = read('src/main.jsx');
  ok('§6 the worker registers in every built bundle (the demo build too), not only with a backend', /import\.meta\.env\.PROD/.test(main) && /serviceWorker\.register\('\/sw\.js'/.test(main));
  ok('§6 a failed on-demand chunk goes through the offline-aware door, never a bare reload', /addEventListener\('vite:preloadError', \(\) => \{ onChunkLoadFailure\(\) \}\)/.test(main) && !/recoverFromStaleBuild/.test(main));
  const app = read('src/App.jsx');
  ok('§6 lazyRoute asks onChunkLoadFailure and shows the offline screen offline', /onChunkLoadFailure\(\)/.test(app) && /CHUNK_FAILURE\.OFFLINE/.test(app) && /<OfflineScreen\b/.test(app));
  ok('§6 the offline screen is part of the shell (a static import: it cannot be a download)', /^import OfflineScreen from '\.\/components\/OfflineScreen';$/m.test(app));
  ok('§6 back online, the route loads again by itself (a fresh lazy, not a reload)', /addEventListener\('online'/.test(read('src/components/OfflineScreen.jsx')) && /onRetry/.test(read('src/components/OfflineScreen.jsx')));

  // the kept screens cover the crew's day: every crew nav screen (as a phone shows it) + the visit
  const nav = await imp('src/lib/navData.js');
  const roles = await imp('src/lib/roles.js');
  const SCREENS = new Set(Array.isArray(swb.OFFLINE_SCREENS) ? swb.OFFLINE_SCREENS : []);
  const lazyMods = new Map([...app.matchAll(/const\s+(\w+)\s*=\s*lazyRoute\(\(\)\s*=>\s*import\('\.\/(pages\/[^']+)'\)\)/g)].map((x) => [x[1], `src/${x[2]}.jsx`]));
  const routeEl = (p) => {
    const r = new RegExp(`<Route path="${p.replace(/[/:]/g, (c) => `\\${c}`)}" element=\\{([^\\n]*?)\\}\\s*/?>`).exec(app);
    if (!r) return [];
    return [...r[1].matchAll(/<([A-Z]\w*)/g)].map((x) => x[1]).filter((n) => lazyMods.has(n)).map((n) => lazyMods.get(n));
  };
  if (typeof nav.navLeaves === 'function' && typeof roles.can === 'function') {
    const perms = roles.seedPermissions();
    const check = (k) => roles.can({ id: 'u_x', role: 'crew' }, k, perms, []);
    const leaves = [...nav.navLeaves(), nav.SETTINGS_LEAF].filter((n) => nav.visible(n, check, true, true));
    const need = new Set(routeEl('schedule/:jobId'));                     // the visit
    for (const leaf of leaves) {
      const p = leaf.to.replace(/^\//, '');
      if (p === 'settings') {
        need.add(lazyMods.get('SettingsLayout')); need.add(lazyMods.get('SettingsHub'));
        // the settings pages a cleaner can open from the hub
        for (const x of app.matchAll(/<Route path="(\w+)" element=\{<RequirePerm perm="([^"]+)"><(\w+) \/><\/RequirePerm>\} \/>/g)) {
          if (lazyMods.get(x[3])?.startsWith('src/pages/settings/') && check(x[2])) need.add(lazyMods.get(x[3]));
        }
      } else for (const mod of routeEl(p)) need.add(mod);
    }
    ok('§6 the crew nav resolved to screens (sanity)', need.size >= 6 && need.has('src/pages/MyDay.jsx') && need.has('src/pages/JobDetail.jsx'), JSON.stringify([...need]));
    const missing = [...need].filter((m) => !SCREENS.has(m));
    ok('§6 every screen a cleaner can reach from the nav (and the visit) is kept offline', missing.length === 0 && SCREENS.size > 0, `missing ${JSON.stringify(missing)}`);
    const unknown = [...SCREENS].filter((m) => ![...lazyMods.values()].includes(m));
    ok('§6 every kept screen is a real route page', unknown.length === 0, `unknown ${JSON.stringify(unknown)}`);
  } else ok('§6 navData and roles load', false);
}

// ── §7 an offline start with an expired token ───────────────────────────────────────────
{
  const fb = typeof offlineSession.offlineSessionFallback === 'function' ? offlineSession.offlineSessionFallback : () => undefined;
  const stored = { access_token: 'tok', refresh_token: 'r', expires_at: 1, user: { id: 'a1', app_metadata: { role: 'crew', org_user_id: 'u_c1' } } };
  const retryable = { name: 'AuthRetryableFetchError', status: 0 };
  eq('§7 offline, the token expired, a session on the phone → keep it (the app opens)', fb({ session: null, error: retryable, online: true, stored }), stored);
  eq('§7 navigator offline and no answer at all → keep it', fb({ session: null, error: null, online: false, stored }), stored);
  eq('§7 a session that loaded normally is used as it is', fb({ session: { access_token: 'live' }, error: null, online: true, stored })?.access_token, 'live');
  eq('§7 online, a refused refresh (revoked, signed out elsewhere) → no session: sign in again', fb({ session: null, error: { name: 'AuthApiError', status: 400 }, online: true, stored }), null);
  eq('§7 nothing on the phone → no session', fb({ session: null, error: retryable, online: false, stored: null }), null);
  eq('§7 a stored value without a token or a user is not a session', fb({ session: null, error: retryable, online: false, stored: { access_token: 'x' } }), null);
  const ap = read('src/auth/AuthProvider.jsx');
  ok('§7 AuthProvider uses it for the first read and for the initial auth event', /offlineSessionFallback\(/.test(ap) && /INITIAL_SESSION/.test(ap));
}

// ── §8 the words ─────────────────────────────────────────────────────────────────────────
{
  const en = read('src/i18n/catalog/en.js');
  ok('§8 the offline screen\'s words are catalog lines', /'offlineScreen\.title':/.test(en) && /'offlineScreen\.body':/.test(en) && /'offlineScreen\.back':/.test(en));
  ok('§8 the offline screen is a converted screen (no hard-coded English)', /'src\/components\/OfflineScreen\.jsx'/.test(read('scripts/test-i18n-coverage.mjs')));
}

if (fails.length) {
  console.error(`\ntest-offline-shell: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ntest-offline-shell: ${pass}/${pass} passed`);
}
