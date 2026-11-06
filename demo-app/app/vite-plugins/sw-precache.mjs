// The BUILD half of the offline shell (CS-665): which files a cleaner's phone keeps, written
// into the service worker of every build.
//
// public/sw.js carries three GENERATED lines whose defaults mean "the dev server, cache
// nothing". After Vite writes a build, swPrecachePlugin (vite.config.js) reads the output
// bundle and rewrites them in <outDir>/sw.js:
//   PRECACHE    the app's shell (the entry script, everything it imports, its CSS), each screen
//               in OFFLINE_SCREENS with everything IT imports, the language catalogs (a Spanish
//               cleaner's words are their own download), and the page's own icons and manifest;
//   SHELL_ENTRY the entry script, so the worker can refuse a page that belongs to another build;
//   BUILD_ID    a digest of all of it (names AND the unhashed files' bytes), so a build that
//               changes anything kept is a new worker and an unchanged one is not.
// A missing placeholder, entry or screen FAILS THE BUILD: offline must never be switched off
// silently by an edit somewhere else.
//
// OFFLINE_SCREENS is the crew's day on the phone: the visit (JobDetail) and every screen the
// crew nav reaches. test-offline-shell.mjs derives that set from navData + App.jsx and fails
// when a crew screen is missing here, so a crew screen added later cannot be left out. Every
// other screen (an office page, a lazy library) is kept the first time it is opened online.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OFFLINE_SCREENS = Object.freeze([
  'src/pages/MyDay.jsx',
  // the Cleaner Hub's checklist page (Brief B)
  'src/pages/crew/CrewChecklist.jsx',
  // the Cleaner Hub (brief A): Today's Stops and the Clock In / Clock Out screen
  'src/pages/crew/CrewStops.jsx',
  'src/pages/crew/CrewClock.jsx',
  'src/pages/JobDetail.jsx',
  'src/pages/Messaging.jsx',
  'src/pages/Inspections.jsx',
  'src/pages/Keys.jsx',
  'src/pages/settings/SettingsLayout.jsx',
  'src/pages/settings/SettingsHub.jsx',
  'src/pages/settings/Account.jsx',
  'src/pages/settings/QuickStart.jsx',
  // The Cleaner Hub (Builder C, 2026-10-13): Client Requests and My Hours, reached from Home's tiles.
  'src/pages/crew/CrewRequests.jsx',
  'src/pages/crew/CrewRequest.jsx',
  'src/pages/crew/CrewHours.jsx',
  // ── the Cleaner Hub (Builder D, 2026-10-13): Request Supplies and the QR scan ──
  'src/pages/crew/CrewSupplies.jsx',
  'src/pages/crew/CrewScan.jsx',
  // S131 Builder C: one supply order — the cleaner's supply bells open it, signal or not.
  'src/pages/crew/CrewSupplyOrder.jsx',
]);

// The LAZY libraries an offline screen loads on demand (a dynamic import, which keep() above does
// not follow): kept up front with the screens, so a cleaner who opens the scan page with a weak
// signal still gets the camera. Each is a node_modules path its chunk is built from; one the build
// lacks FAILS THE BUILD, like a screen.
//   qr-scanner — the scan page's camera (components/QrScanner imports it lazily), and its decoding
//                worker, which the library imports lazily in turn (the main bundle carries neither).
export const OFFLINE_LAZY_MODULES = Object.freeze([
  'node_modules/qr-scanner/qr-scanner.min.js',
  'node_modules/qr-scanner/qr-scanner-worker.min.js',
]);

export const SW_FILE = 'sw.js';
const SHELL_FILE = 'index.html';
const CATALOG = /\/src\/i18n\/catalog\/[^/]+\.js$/;

// The three lines, exactly as public/sw.js writes them for the dev server.
const PLACEHOLDERS = [
  ['BUILD_ID', /^const BUILD_ID = 'dev';$/m],
  ['SHELL_ENTRY', /^const SHELL_ENTRY = '';$/m],
  ['PRECACHE', /^const PRECACHE = \[\];$/m],
];

const norm = (id) => String(id || '').split('\\').join('/');
const isModule = (facadeModuleId, rel) => norm(facadeModuleId).endsWith(`/${rel}`);

// → { buildId, entry, precache } from Rollup's output bundle (what Vite hands writeBundle).
// `rootFiles` = the files at the top of the build output besides the page and the worker (the
// icons, the logos, manifest.json); `digestExtra` = bytes that must change the build id when
// they change (those files' contents and the page).
export function precacheManifest(bundle, { rootFiles = [], screens = OFFLINE_SCREENS, lazyModules = OFFLINE_LAZY_MODULES, digestExtra = [] } = {}) {
  const chunks = Object.values(bundle || {}).filter((c) => c && c.type === 'chunk');
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const files = new Set();
  const keep = (c) => {
    if (!c || files.has(c.fileName)) return;
    files.add(c.fileName);
    for (const css of c.viteMetadata?.importedCss || []) files.add(css);
    for (const asset of c.viteMetadata?.importedAssets || []) files.add(asset);
    for (const dep of c.imports || []) keep(byFile.get(dep));
  };

  const entries = chunks.filter((c) => c.isEntry);
  if (entries.length !== 1) throw new Error(`sw-precache: expected one entry chunk, found ${entries.length}`);
  keep(entries[0]);
  for (const screen of screens) {
    const c = chunks.find((x) => isModule(x.facadeModuleId, screen));
    if (!c) throw new Error(`sw-precache: the build has no chunk for the offline screen ${screen}`);
    keep(c);
  }
  for (const mod of lazyModules) {
    const c = chunks.find((x) => isModule(x.facadeModuleId, mod));
    if (!c) throw new Error(`sw-precache: the build has no chunk for the offline library ${mod}`);
    keep(c);
  }
  for (const c of chunks) if (CATALOG.test(norm(c.facadeModuleId))) keep(c);

  const precache = [
    ...[...files].map((f) => `/${f}`),
    ...rootFiles.filter((f) => f !== SHELL_FILE && f !== SW_FILE).map((f) => `/${f}`),
  ].sort();
  const entry = `/${entries[0].fileName}`;
  const hash = crypto.createHash('sha256').update(entry).update('\n').update(precache.join('\n'));
  for (const bytes of digestExtra) hash.update('\n').update(bytes);
  return { buildId: hash.digest('hex').slice(0, 16), entry, precache };
}

// public/sw.js with its three GENERATED lines filled in. Throws when one is missing.
export function injectPrecache(source, { buildId, entry, precache }) {
  let out = String(source);
  const quoted = (v) => `'${String(v).replace(/[^\w./-]/g, '')}'`;   // a hex id and a build path: nothing to escape
  const values = {
    BUILD_ID: `const BUILD_ID = ${quoted(buildId)};`,
    SHELL_ENTRY: `const SHELL_ENTRY = ${quoted(entry)};`,
    PRECACHE: `const PRECACHE = ${JSON.stringify(precache || [])};`,
  };
  for (const [name, re] of PLACEHOLDERS) {
    if (!re.test(out)) throw new Error(`sw-precache: sw.js has lost its generated ${name} line`);
    out = out.replace(re, () => values[name]);
  }
  return out;
}

// The Vite plugin: after the bundle is written (Vite has copied public/sw.js into the output
// by then), rewrite <outDir>/sw.js with this build's list.
export function swPrecachePlugin() {
  let configuredDir = null;
  return {
    name: 'cleanspace-sw-precache',
    apply: 'build',
    configResolved(config) { configuredDir = path.resolve(config.root, config.build.outDir); },
    writeBundle(options, bundle) {
      const outDir = options?.dir || configuredDir;
      const swPath = path.join(outDir, SW_FILE);
      if (!fs.existsSync(swPath)) throw new Error(`sw-precache: the build has no ${SW_FILE}`);
      const rootFiles = fs.readdirSync(outDir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.startsWith('.') && d.name !== SW_FILE && d.name !== SHELL_FILE)
        .map((d) => d.name)
        .sort();
      const shellPath = path.join(outDir, SHELL_FILE);
      const digestExtra = [
        ...(fs.existsSync(shellPath) ? [fs.readFileSync(shellPath)] : []),
        ...rootFiles.map((f) => fs.readFileSync(path.join(outDir, f))),
      ];
      const manifest = precacheManifest(bundle, { rootFiles, digestExtra });
      fs.writeFileSync(swPath, injectPrecache(fs.readFileSync(swPath, 'utf8'), manifest));
    },
  };
}
