#!/usr/bin/env node
// Rebuild demo-app/ (the PolishPoint demo at /polishpoint) from Clean Space's committed code, then put the
// PolishPoint layer back on top. Run it whenever the demo has fallen behind Clean Space:
//
//   node scripts/sync-polishpoint-demo.mjs                 # Clean Space's origin/main
//   node scripts/sync-polishpoint-demo.mjs --ref <sha>     # any commit
//   node scripts/sync-polishpoint-demo.mjs --cleanspace <path> --no-build
//
// Clean Space is only read (`git rev-parse` and `git archive` of a committed ref); nothing in its checkout changes.
// Fetch there first if origin/main should be newer.
//
// The PolishPoint layer:
//   - the demo build stays login-free: Clean Space's own `--mode demo` (.env.demo blanks every backend), so the
//     app runs on the seeded sample data and the user menu keeps its "switch to any team member" list;
//   - the SPA is mounted on the SaaSassins site: assets under /polishpoint/, the public landing at /polishpoint,
//     the live app at /polishpoint/demo (its own router root, so every "/" inside the app is the app's home);
//   - the PolishPoint brand pack (demo-app/brands/polishpoint) applied with Clean Space's brand step;
//   - Clean Space's build-review chrome (the Review page, the NEW pills, the layout-review banners on Dashboard and
//     Payroll, Report an issue) hidden, and the one
//     on-screen mention of Clean Space (the webhook signature header's name) shown as PolishPoint's;
//   - Quotes and Marketing switched on (Daniel's pick, 2026-11-05); Reviews stays off;
//   - every panel and pop-up drawn at the page's top level (a portal to <body>), as the styling rules want: the
//     notification bells, the messaging filters, the messages dock, the menu's section panel and the toasts, which
//     Clean Space draws inside the page (src/demo/AnchoredPortal.jsx keeps the dropdowns where their CSS puts them;
//     src/demo/ToastLayer.jsx keeps the toasts off the bars pinned to the bottom and off a page's last buttons);
//   - Clean Space's shared parts with their words in their middle in Poppins (src/demo/centering.css): counts,
//     badges, tabs, chips, small buttons, avatars, the section tabs' underline, the Pipeline icon's dollar sign.
// Each edit names the exact text it replaces and how many times it must be there. If Clean Space's code moved and
// one doesn't match, the script stops before anything in demo-app/ changes and names the file.
//
// Files the demo owns (carried over from the current demo-app/ on every run, never from Clean Space):
//   app/src/demo/          the landing, its modules catalog, its styles, the demo config
//   app/src/lib/assetUrl.js
//   brands/polishpoint/    the brand pack
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'demo-app');
const WORK = path.join(DEMO, '.sync');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const CLEAN_SPACE = path.resolve(flag('--cleanspace', path.join(os.homedir(), 'Claude', 'Clean Space')));
const REF = flag('--ref', 'origin/main');
const BUILD = !argv.includes('--no-build');

const die = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };
const step = (msg) => console.log(`• ${msg}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed:\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-30).join('\n')}`);
  return r.stdout;
}

const CARRY = [
  ['app/src/demo', { dir: true }],
  ['app/src/lib/assetUrl.js', {}],
  ['brands/polishpoint', { dir: true, skip: new Set(['review.html']) }],
];

// [file under app/, the exact text, its replacement, how many times the text must appear]
const PATCHES = [
  // Mount under /polishpoint/: Vite's base (assets, index.html) and the router's root (src/demo/demoConfig.js).
  ['vite.config.js', '  return {\n    plugins:', "  return {\n    // polishpoint-demo: the SaaSassins site serves this build under /polishpoint/ (VITE_BASE_PATH, .env.demo).\n    base: env.VITE_BASE_PATH || '/',\n    plugins:", 1],
  ['src/App.jsx', '        <BrowserRouter>', '        <BrowserRouter basename={ROUTER_BASE}>', 1],
  ['src/main.jsx', '        <App />\n', '        {demoEntry() === \'landing\' ? <DemoLanding /> : <App />}\n', 1],
  // The worker would ask for /sw.js at the SaaSassins site's root (the build's is /polishpoint/sw.js) and claim the
  // whole site; the demo has no push and doesn't need the offline shell, so it registers only at a root mount.
  ['src/main.jsx', "if ((import.meta.env.PROD || isAuthConfigured()) && 'serviceWorker' in navigator) {", "if ((import.meta.env.PROD || isAuthConfigured()) && 'serviceWorker' in navigator && import.meta.env.BASE_URL === '/') { // polishpoint-demo", 1],

  // Runtime "/file.png" strings, which Vite doesn't rewrite for the base (assetUrl.js).
  ['src/brand/logo.js', "export const LIGHT_LOGO_URL = '/logo-on-light.png';", "export const LIGHT_LOGO_URL = assetUrl('/logo-on-light.png');", 1],
  ['src/brand/logo.js', "export const SIDEBAR_LOGO_URL = '/cleanspace-logo.png';", "export const SIDEBAR_LOGO_URL = assetUrl('/cleanspace-logo.png');", 1],
  ['src/data/seed.js', "  logoUrl: '/cleanspace-logo.png',", "  logoUrl: assetUrl('/cleanspace-logo.png'),", 1],
  ['src/data/seed.js', "  logoMark: '/cleanspace-glyph-ink.png',", "  logoMark: assetUrl('/cleanspace-glyph-ink.png'),", 1],
  ['src/components/FloatingNav.jsx', 'src="/cleanspace-glyph-ink.png"', "src={assetUrl('/cleanspace-glyph-ink.png')}", 1],
  ['src/components/AutoUpdater.jsx', 'fetch(`/index.html?ts=${Date.now()}`', 'fetch(assetUrl(`/index.html?ts=${Date.now()}`)', 1],
  ['src/lib/staleBuild.js', 'fetch(`/index.html?probe=${Date.now()}`', 'fetch(assetUrl(`/index.html?probe=${Date.now()}`)', 1],

  // Clean Space's build review is theirs alone: no Review page, no NEW pills, no Report an issue.
  ['src/components/Sidebar.jsx', "function NewBadge() {\n  const t = useT();\n  return <span className=\"nav-review nav-review-new\">{t('nav.new')}</span>;\n", 'function NewBadge() {\n  return null; // polishpoint-demo: no NEW pills\n', 1],
  ['src/components/Sidebar.jsx', 'const showReview = visible(REVIEW_LEAF, check, isMobile, false);', 'const showReview = false; // polishpoint-demo: no Review page', 1],
  ['src/components/FloatingNav.jsx', "(m.isNew || m.badge) && <span className=\"cs-fnav-badge\">{tr('nav.new')}</span>", 'null /* polishpoint-demo: no NEW pills */', 2],
  ['src/components/Sidebar.jsx', '            className="sidebar-icon-btn sidebar-report-btn"\n', "            className=\"sidebar-icon-btn sidebar-report-btn\"\n            style={{ display: 'none' }} // polishpoint-demo: no Report an issue\n", 1],
  ['src/components/FloatingNav.jsx', "          className=\"cs-fnav-mitem\"\n          tabIndex={menuOpen ? 0 : -1}\n          onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('cs:open-report')); }}\n", "          className=\"cs-fnav-mitem\"\n          style={{ display: 'none' }} // polishpoint-demo: no Report an issue\n          tabIndex={menuOpen ? 0 : -1}\n          onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('cs:open-report')); }}\n", 1],
  ['src/pages/MyDay.jsx', "          role=\"menuitem\"\n          onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('cs:open-report')); }}\n", "          role=\"menuitem\"\n          style={{ display: 'none' }} // polishpoint-demo: no Report an issue\n          onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('cs:open-report')); }}\n", 1],
  // The "choose your layout" review banners (their pick falls back to the default layout).
  ['src/pages/Dashboard.jsx', '      <DashboardLayoutReview />\n', '      {/* polishpoint-demo: no layout review banner */}\n', 1],
  ['src/pages/Payroll.jsx', '      <PayrollLayoutReview viewProps={viewProps} />\n', '      {/* polishpoint-demo: no layout review banner */}\n', 1],
  ['src/lib/navData.js', 'SETTINGS_LEAF, REVIEW_LEAF, ', 'SETTINGS_LEAF, ', 2],
  ['src/lib/masterSearch/registry.js', "  { to: '/review', label: 'Review', icon: 'edit', perm: 'drafts.view', source: 'extra', desktopOnly: true },\n", '', 1],
  ['src/App.jsx', '<Route path="review" element={<RequirePerm perm="drafts.view"><Review /></RequirePerm>} />', '<Route path="review" element={<Navigate to="/" replace />} />', 1],

  // The webhook help names its signature header after Clean Space; the demo has no server, so it reads as PolishPoint's.
  ['src/components/WebhooksSection.jsx', '<code>X-CleanSpace-Signature: sha256=…</code>', '<code>X-PolishPoint-Signature: sha256=…</code>', 1],
  ['src/components/LeadWebhooksSection.jsx', '<code>X-CleanSpace-Signature: sha256=…</code>', '<code>X-PolishPoint-Signature: sha256=…</code>', 1],

  // Daniel's pick (2026-11-05): the demo shows Quotes and Marketing, which Clean Space keeps switched off.
  ['src/lib/features.js', 'export const MARKETING_ENABLED = false;', 'export const MARKETING_ENABLED = true; // polishpoint-demo: on in the demo', 1],
  ['src/lib/features.js', 'export const QUOTES_ENABLED = false;', 'export const QUOTES_ENABLED = true; // polishpoint-demo: on in the demo', 1],

  // Every panel and pop-up at the page's top level (the styling rules: a portal to <body>, so a floating bar stacked
  // over the page never covers one; Forge's file check holds a dialog drawn inside the page). Clean Space draws these
  // inside it. The dropdowns placed by CSS under their trigger go through src/demo/AnchoredPortal.jsx, which keeps
  // that placement; the ones already pinned to the screen (the messages dock, the menu's section panel) portal as
  // they are. Each dismiss hook spares the portaled panel, which is no longer inside the trigger's wrapper.
  ['src/components/NotificationsBell.jsx', '  const wrapRef = useRef(null);\n', '  const wrapRef = useRef(null);\n  const panelRef = useRef(null); // polishpoint-demo: the desktop panel, at the page\'s top level\n', 1],
  ['src/components/NotificationsBell.jsx', 'useDismissTap({ open: open && !isMobile, ref: wrapRef, onDismiss: () => setOpen(false) });', 'useDismissTap({ open: open && !isMobile, ref: wrapRef, ref2: panelRef, onDismiss: () => setOpen(false) });', 1],
  ['src/components/NotificationsBell.jsx', '        <div className="bell-panel" role="dialog" aria-label={t(\'notif.title\')}>', '        <AnchoredPortal anchorRef={wrapRef} ref={panelRef}><div className="bell-panel" role="dialog" aria-label={t(\'notif.title\')}>', 1],
  ['src/components/NotificationsBell.jsx', '          {panelList}\n        </div>\n      ))}', '          {panelList}\n        </div></AnchoredPortal>\n      ))}', 1],
  ['src/pages/hub/HubBell.jsx', '  const wrapRef = useRef(null);\n', '  const wrapRef = useRef(null);\n  const panelRef = useRef(null); // polishpoint-demo: the desktop panel, at the page\'s top level\n', 1],
  ['src/pages/hub/HubBell.jsx', 'useDismissTap({ open: open && !isMobile, ref: wrapRef, onDismiss: () => setOpen(false) });', 'useDismissTap({ open: open && !isMobile, ref: wrapRef, ref2: panelRef, onDismiss: () => setOpen(false) });', 1],
  ['src/pages/hub/HubBell.jsx', '        <div className="bell-panel" role="dialog" aria-label="Updates">', '        <AnchoredPortal anchorRef={wrapRef} ref={panelRef}><div className="bell-panel" role="dialog" aria-label="Updates">', 1],
  ['src/pages/hub/HubBell.jsx', '          {body}\n        </div>\n      ))}', '          {body}\n        </div></AnchoredPortal>\n      ))}', 1],
  ['src/components/MessagingHeader.jsx', 'function FiltersPopover({ open, anchorRef, filters, onFiltersChange, onClose }) {\n  const t = useT();\n', 'function FiltersPopover({ open, anchorRef, filters, onFiltersChange, onClose }) {\n  const t = useT();\n  const boxRef = useRef(null); // polishpoint-demo: the panel\'s stand-in at the page\'s top level\n', 1],
  ['src/components/MessagingHeader.jsx', '    <PopMenu open={open} onClose={onClose} anchorRef={anchorRef} className="filters-popover" role="dialog"', '    <AnchoredPortal anchorRef={anchorRef} open={open} ref={boxRef}><PopMenu open={open} onClose={onClose} anchorRef={anchorRef} spareRef={boxRef} className="filters-popover" role="dialog"', 1],
  ['src/components/MessagingHeader.jsx', '    </PopMenu>\n  );\n}', '    </PopMenu></AnchoredPortal>\n  );\n}', 1],
  ['src/components/PopMenu.jsx', "sheetTitle, float = false, children, ...rest }) {", "sheetTitle, float = false, spareRef = null, children, ...rest }) { // polishpoint-demo: spareRef", 1],
  ['src/components/PopMenu.jsx', 'ref2: floating ? menuRef : null, onDismiss: onClose });', 'ref2: floating ? menuRef : spareRef, onDismiss: onClose }); // polishpoint-demo: a panel portaled by its caller', 1],
  ['src/components/MessagesDock.jsx', "  return (\n    <div ref={rootRef} className={`cs-msg-dock ${open ? 'is-open' : ''}`}>", "  return createPortal( // polishpoint-demo: the dock at the page's top level\n    <div ref={rootRef} className={`cs-msg-dock ${open ? 'is-open' : ''}`}>", 1],
  ['src/components/MessagesDock.jsx', "        <span className=\"cs-msg-launcher-label\">{t('messages.dock.messages')}</span>\n      </button>\n    </div>\n  );\n}", "        <span className=\"cs-msg-launcher-label\">{t('messages.dock.messages')}</span>\n      </button>\n    </div>,\n    document.body,\n  );\n}", 1],
  ['src/components/Sidebar.jsx', '  const panel = shown && (\n    <div ref={panelRef} id={PANEL_ID} className="launcher-panel"', '  const panel = shown && createPortal( // polishpoint-demo: the panel at the page\'s top level\n    <div ref={panelRef} id={PANEL_ID} className="launcher-panel"', 1],
  ['src/components/Sidebar.jsx', '      </div>\n    </div>\n  );\n  return (\n    <div className="nav-group launcher">', '      </div>\n    </div>,\n    document.body,\n  );\n  return (\n    <div className="nav-group launcher">', 1],
  ['src/components/Sidebar.jsx', "if (pressing || asideRef.current?.contains(e.target) || e.target?.closest?.('.modal-overlay')) return;", "if (pressing || asideRef.current?.contains(e.target) || panelRef.current?.contains(e.target) || e.target?.closest?.('.modal-overlay')) return; // polishpoint-demo: the panel is outside the menu now", 1],
  // The toast stack goes through src/demo/ToastLayer.jsx: at the top level, over the bars pinned to the bottom (the
  // dock's button, the phone's floating menu, the hub's New request), with room at a page's end while a toast shows.
  ['src/components/Toast.jsx', '      <div className="toast-stack" role="status" aria-live="polite">', '      <ToastLayer><div className="toast-stack" role="status" aria-live="polite">', 1],
  ['src/components/Toast.jsx', '      </div>\n    </ToastCtx.Provider>', '      </div></ToastLayer>\n    </ToastCtx.Provider>', 1],
  ['src/index.css', '.launcher-panel {\n  position: fixed; z-index: 10;', '.launcher-panel {\n  position: fixed; z-index: 51; /* polishpoint-demo: at the page\'s top level, over the menu (.sidebar, 50) */', 1],
  // Clean Space's shared parts with their words in their middle in Poppins (Daniel's pick, 2026-11-05):
  // src/demo/centering.css, after index.css so it wins at equal specificity.
  ['src/main.jsx', "import './index.css'\n", "import './index.css'\nimport './demo/centering.css' // polishpoint-demo: words in their parts' middle, in Poppins\n", 1],
  // The Pipeline icon's "$" was an SVG <text>; Forge's icon measure reads a text's baseline with an HTML probe, which
  // SVG doesn't draw, so it read 414px off. The same dollar sign as a path (Heroicons' currency-dollar), in its circle.
  ['src/components/Icon.jsx', "      <text\n        x=\"12\"\n        y=\"12\"\n        textAnchor=\"middle\"\n        dominantBaseline=\"central\"\n        fontSize=\"14\"\n        fontWeight=\"700\"\n        fontFamily=\"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif\"\n        fill=\"currentColor\"\n        stroke=\"none\"\n      >\n        $\n      </text>\n", "      {/* polishpoint-demo: the dollar sign as a path, not an SVG <text> */}\n      <path d=\"M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33\" />\n", 1],
  // The Review page's mockups go with it (it's routed away above); its one template draws a flyout of its own.
  ['src/review-mockups/index.js', "  'sidebar-directions': {\n    file: 'sidebar-directions.html',\n    views: ['a', 'b', 'c', 'd', 'e'],\n    today: 'e',\n    load: () => import('./sidebar-directions.html?raw').then((m) => m.default),\n  },\n", '  // polishpoint-demo: no Review page, so no mockups (sidebar-directions.html is left out)\n', 1],
];

// Clean Space's files the demo leaves out (each must be there, so a rename is caught like a patch's text).
const REMOVE = ['src/review-mockups/sidebar-directions.html'];

// Imports the patches above need, put first in their files.
const PREPEND = [
  ['src/App.jsx', "import { ROUTER_BASE } from './demo/demoConfig'; // polishpoint-demo\n"],
  ['src/main.jsx', "import DemoLanding from './demo/DemoLanding'; // polishpoint-demo\nimport { demoEntry } from './demo/demoConfig'; // polishpoint-demo\n"],
  ['src/brand/logo.js', "import { assetUrl } from '../lib/assetUrl.js'; // polishpoint-demo\n"],
  ['src/data/seed.js', "import { assetUrl } from '../lib/assetUrl.js'; // polishpoint-demo\n"],
  ['src/components/FloatingNav.jsx', "import { assetUrl } from '../lib/assetUrl'; // polishpoint-demo\n"],
  ['src/components/AutoUpdater.jsx', "import { assetUrl } from '../lib/assetUrl'; // polishpoint-demo\n"],
  ['src/lib/staleBuild.js', "import { assetUrl } from './assetUrl.js'; // polishpoint-demo\n"],
  ['src/components/NotificationsBell.jsx', "import AnchoredPortal from '../demo/AnchoredPortal'; // polishpoint-demo\n"],
  ['src/pages/hub/HubBell.jsx', "import AnchoredPortal from '../../demo/AnchoredPortal'; // polishpoint-demo\n"],
  ['src/components/MessagingHeader.jsx', "import AnchoredPortal from '../demo/AnchoredPortal'; // polishpoint-demo\n"],
  ['src/components/MessagesDock.jsx', "import { createPortal } from 'react-dom'; // polishpoint-demo\n"],
  ['src/components/Sidebar.jsx', "import { createPortal } from 'react-dom'; // polishpoint-demo\n"],
  ['src/components/Toast.jsx', "import ToastLayer from '../demo/ToastLayer'; // polishpoint-demo\n"],
];

const ENV_DEMO = `
# polishpoint-demo: the SaaSassins site serves this build under /polishpoint/ (vite base). The landing is
# /polishpoint and the live app's router root is /polishpoint/demo (src/demo/demoConfig.js).
VITE_BASE_PATH=/polishpoint/
`;

// What must never be in the built demo: another brand's name or contacts, a key, a backend's address.
const LEAKS = [
// (Clean Space's own domain also sits in an old store migration, persist.js v34→v35, which only rewrites data saved
// before v35; it never shows, so the domain alone isn't a leak.)
  [/Clean Space|Clean Corner|CleanCorner|cleanspacetech|cleanspace-gilt|Giunco|Harbor & Pine|harborpine/, 'another brand'],
  [/sk_live_|sk_test_|service_role|SUPABASE_SERVICE/, 'a key'],
  [/[a-z0-9]{20}\.supabase\.co/, 'a backend address'],
];

// ── 1. Clean Space's code at the ref ───────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(CLEAN_SPACE, '.git'))) die(`Clean Space isn't at ${CLEAN_SPACE} (pass --cleanspace).`);
const sha = run('git', ['-C', CLEAN_SPACE, 'rev-parse', '--verify', `${REF}^{commit}`]).trim();
const [when, subject] = run('git', ['-C', CLEAN_SPACE, 'log', '-1', '--format=%cI%n%s', sha]).split('\n');
step(`Clean Space ${REF} = ${sha.slice(0, 8)} (${when})`);

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const archive = spawnSync('/bin/sh', ['-c', 'git -C "$1" archive "$2" app brands | tar -x -C "$3"', 'sh', CLEAN_SPACE, sha, WORK], { encoding: 'utf8' });
if (archive.status !== 0) die(`Exporting Clean Space failed: ${archive.stderr}`);

// ── 2. The demo's own files ────────────────────────────────────────────────────────────────────────────────────
for (const [rel, { dir, skip }] of CARRY) {
  const from = path.join(DEMO, rel);
  if (!fs.existsSync(from)) die(`demo-app/${rel} is missing: it's the demo's own and can't come from Clean Space.`);
  const to = path.join(WORK, rel);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: !!dir, filter: (src) => !skip?.has(path.basename(src)) });
}
step(`Carried over the demo's own files: ${CARRY.map(([rel]) => rel).join(', ')}`);

// ── 3. The PolishPoint edits ───────────────────────────────────────────────────────────────────────────────────
const app = path.join(WORK, 'app');
const misses = [];
for (const [rel, from, to, times] of PATCHES) {
  const file = path.join(app, rel);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const n = text.split(from).length - 1;
  if (n !== times) { misses.push(`app/${rel}: found ${n} of ${JSON.stringify(from.length > 90 ? `${from.slice(0, 90)}…` : from)} (expected ${times})`); continue; }
  fs.writeFileSync(file, text.split(from).join(to));
}
for (const rel of REMOVE) {
  const file = path.join(app, rel);
  if (fs.existsSync(file)) fs.rmSync(file);
  else misses.push(`app/${rel}: not there to leave out`);
}
if (misses.length) {
  fs.rmSync(WORK, { recursive: true, force: true });
  die(`Clean Space's code changed under ${misses.length} PolishPoint edit(s). Update PATCHES in scripts/sync-polishpoint-demo.mjs to the new text; demo-app/ was not touched.\n  ${misses.join('\n  ')}`);
}
for (const [rel, line] of PREPEND) {
  const file = path.join(app, rel);
  fs.writeFileSync(file, line + fs.readFileSync(file, 'utf8'));
}
fs.appendFileSync(path.join(app, '.env.demo'), ENV_DEMO);
step(`Applied ${PATCHES.length} edits and ${PREPEND.length} imports, left out ${REMOVE.length} file(s)`);

// ── 4. Packages, then the brand ────────────────────────────────────────────────────────────────────────────────
const oldLock = path.join(DEMO, 'app', 'package-lock.json');
const oldModules = path.join(DEMO, 'app', 'node_modules');
const sameLock = fs.existsSync(oldLock) && fs.readFileSync(oldLock, 'utf8') === fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8');
if (sameLock && fs.existsSync(oldModules)) {
  step('Same lockfile: reusing the installed packages');
  run('cp', ['-cR', oldModules, path.join(app, 'node_modules')]);
} else {
  step('Installing packages (npm ci)');
  run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: app });
}
step('Applying the PolishPoint brand pack');
console.log(`  ${run('node', ['scripts/brand.mjs', 'polishpoint'], { cwd: app }).trim()}`);
run('node', ['scripts/brand.mjs', '--check'], { cwd: app });

// ── 5. Swap it in ──────────────────────────────────────────────────────────────────────────────────────────────
for (const part of ['app', 'brands']) {
  fs.rmSync(path.join(DEMO, part), { recursive: true, force: true });
  fs.renameSync(path.join(WORK, part), path.join(DEMO, part));
}
fs.rmSync(WORK, { recursive: true, force: true });
fs.writeFileSync(path.join(DEMO, 'CLEAN_SPACE_BASE.txt'), `${sha}\n${when}\n${subject}\n`);
step(`demo-app/ now runs Clean Space ${sha.slice(0, 8)} (recorded in demo-app/CLEAN_SPACE_BASE.txt)`);

// ── 6. Build it and check what ships ───────────────────────────────────────────────────────────────────────────
if (BUILD) {
  step('Building the demo (npm run build:demo)');
  run('npm', ['run', 'build:demo'], { cwd: path.join(DEMO, 'app') });
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html|js|css|json|txt|svg|webmanifest)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const [re, what] of LEAKS) {
        const m = text.match(re);
        if (m) found.push(`${path.relative(DEMO, p)}: ${what} ("${m[0]}")`);
      }
    }
  };
  walk(path.join(DEMO, 'app', 'dist'));
  if (found.length) die(`The built demo holds what must not ship:\n  ${found.slice(0, 20).join('\n  ')}`);
  step('Built; the bundle names no other brand and holds no key or backend address');
}
console.log('\n✓ Synced. Next: run the site build (npm run build) and look at /polishpoint and /polishpoint/demo.');
