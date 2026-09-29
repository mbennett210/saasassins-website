// lint:backnav — every link into a page with a BACK ARROW must carry a referrer.
//
// 🔴 WHY (Daniel, 2026-07-28): "Purchasing → Distributors (press Manage) takes you to
// settings, then it's just a back arrow and takes you to 'Settings', which is not back.
// This needs to be resolved everywhere else it occurs throughout the app."
//
// The contract, from CLAUDE.md: a page with a back arrow reads `location.state.from`, and
// the linking side supplies it with `useFromHere()`. Miss it on one entry point and Back
// silently sends the user somewhere they have never been — from THAT entry point only,
// which is why it survives manual testing and why it needs a build-failing sweep.
//
// 🔴 DETECTED BY SHAPE, NOT BY A NAME LIST. The set of "pages with a back arrow" is
// derived by reading which page modules use DetailHeader / BackLink / useBackTarget, then
// mapping those components back to their route paths through App.jsx. Add a new detail
// page and it is covered automatically; a hardcoded list would rot exactly the way
// `useFromHere`'s label if-chain rotted.
//
//   node scripts/backnav-lint.mjs            # fail on any violation
//   node scripts/backnav-lint.mjs --list     # show the derived back-page routes, then exit
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'src';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.jsx?$/.test(p)) files.push(p);
  }
})(ROOT);
const read = (p) => readFileSync(p, 'utf8');

// 🔴 STRIP COMMENTS BEFORE ANY DETECTION — BOTH halves of this lint were fooled by prose.
// The violation scan matched documentation that DESCRIBED the bug being fixed (two
// confident false positives on files that were already correct). Then the back-page
// detection matched a comment that merely NAMED `useBackTarget`, which promoted three
// LIST pages to "has a back arrow" and invented a violation against `/quotes`. A detector
// that reads comments measures the wrong thing in both directions, and a lint that flags
// its own documentation teaches people to ignore it.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))   // blank it, keep line numbers
  .split('\n')
  .map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l.replace(/\s\/\/[^'"`]*$/, '')))
  .join('\n');
const code = new Map(files.map((f) => [f, stripComments(read(f))]));

// ── 1. which page modules render a back affordance? ────────────────────────
const BACK_MARKERS = /\b(DetailHeader|BackLink|useBackTarget)\b/;
const backModules = new Set();
for (const f of files) {
  if (!f.includes(join('src', 'pages'))) continue;
  if (BACK_MARKERS.test(code.get(f))) backModules.add(relative(join(ROOT, 'pages'), f).replace(/\\/g, '/').replace(/\.jsx?$/, ''));
}

// ── 2. map component name → module, then route path → component ────────────
const app = read(join(ROOT, 'App.jsx'));
const nameToModule = new Map();
for (const m of app.matchAll(/const\s+(\w+)\s*=\s*lazyRoute\(\(\)\s*=>\s*import\('\.\/pages\/([^']+)'\)\)/g)) nameToModule.set(m[1], m[2]);
for (const m of app.matchAll(/import\s+(\w+)\s+from\s+'\.\/pages\/([^']+)'/g)) nameToModule.set(m[1], m[2]);

// Route paths are RELATIVE to the route they nest under. Two levels matter here: the
// authed shell (`<Route path="clients/:clientId" …>` → `/clients/:clientId`) and the
// SETTINGS block, whose children are relative AGAIN (`path="team/:userId"` is really
// `/settings/team/:userId`). Getting that wrong produced a phantom `/team/:userId` route
// that no link could ever match — a lint that silently checks nothing.
const settingsOpen = app.indexOf('<Route path="settings"');
const settingsEnd = settingsOpen < 0 ? -1 : app.indexOf('</Route>', settingsOpen);
const insideSettings = (i) => settingsOpen >= 0 && i > settingsOpen && i < settingsEnd;
const absolutise = (path, i) => (path.startsWith('/') ? path : (insideSettings(i) ? `/settings/${path}` : `/${path}`));

const backRoutes = [];
for (const m of app.matchAll(/<Route\s+path="([^"]+)"[^>]*element=\{([\s\S]{0,220}?)\}\s*\/?>/g)) {
  const [, path, element] = m;
  const comp = [...element.matchAll(/<(\w+)\s*\/?>/g)].map((x) => x[1]).find((n) => nameToModule.has(n));
  if (!comp) continue;
  const mod = nameToModule.get(comp);
  if (!backModules.has(mod)) continue;
  backRoutes.push({ path: absolutise(path, m.index), comp, mod });
}
// EVERY settings child renders under SettingsLayout, which owns the back arrow — the child
// component itself has no back affordance, so the scan above never sees it.
if (backModules.has('settings/SettingsLayout') && settingsOpen >= 0) {
  for (const m of app.slice(settingsOpen, settingsEnd).matchAll(/<Route\s+path="([^"]+)"/g)) {
    if (m[1] === 'settings') continue;
    const path = `/settings/${m[1]}`;
    if (!backRoutes.some((r) => r.path === path)) backRoutes.push({ path, comp: 'SettingsLayout', mod: 'settings/SettingsLayout' });
  }
}

if (process.argv.includes('--list')) {
  console.log('\nback-arrow routes derived from the code:\n');
  for (const r of [...backRoutes].sort((a, b) => a.path.localeCompare(b.path))) console.log(`  ${r.path.padEnd(32)} ${r.comp}`);
  console.log(`\n${backRoutes.length} route(s) · ${backModules.size} module(s) with a back affordance\n`);
  process.exit(0);
}

// A link target is captured up to the first interpolation, so `/orders/${id}` arrives as
// "/orders/" and `/settings/team` arrives whole. The PREFIX mode has to be tried first:
// "/quotes/doc/" is a prefix of `/quotes/doc/:id` but would also match `/quotes/:id`,
// reporting the right violation against the wrong route.
const staticPrefix = (path) => path.replace(/\/:[A-Za-z]+.*$/, '/');
const isParamRoute = (path) => path.includes('/:');
const reaches = (target, wasTruncated) => {
  if (wasTruncated) {
    // Longest prefix wins, so /quotes/doc/ beats /quotes/.
    return backRoutes.filter((r) => isParamRoute(r.path) && staticPrefix(r.path) === target)
      .sort((a, b) => b.path.length - a.path.length)[0];
  }
  return backRoutes.find((r) => !isParamRoute(r.path) && r.path === target);
};

// ── 3. scan every link/navigate for a missing referrer ─────────────────────
const violations = [];
for (const f of files) {
  if (/Public\w*\.jsx$/.test(f)) continue;   // public pages render no shell and no back arrow
  code.get(f).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/<(?:Link|NavLink)\s([^>]*?)>/g)) {
      const attrs = m[1];
      const to = attrs.match(/to=\{?[`"']([^`"'$]*)/);
      if (!to) continue;
      const raw = to[1];
      const hit = reaches(raw, raw.endsWith('/')) || reaches(raw.replace(/\/$/, ''), false);
      if (!hit || /\bstate=/.test(attrs)) continue;
      violations.push({ file: f, line: i + 1, kind: 'Link', target: raw, route: hit.path });
    }
    for (const m of line.matchAll(/navigate\(\s*[`"']([^`"'$]*)/g)) {
      const raw = m[1];
      const hit = reaches(raw, raw.endsWith('/')) || reaches(raw.replace(/\/$/, ''), false);
      if (!hit) continue;
      if (/\bstate\s*:/.test(line.slice(m.index))) continue;
      violations.push({ file: f, line: i + 1, kind: 'navigate', target: raw, route: hit.path });
    }
  });
}

console.log(`\nbacknav-lint — ${backRoutes.length} back-arrow route(s), ${files.length} files scanned\n`);
if (!violations.length) { console.log('  No links into a back-arrow page are missing their referrer. ✓\n'); process.exit(0); }
for (const v of violations) {
  console.log(`  ✗ ${v.file}:${v.line}`);
  console.log(`      ${v.kind} → ${v.target}   (route ${v.route}) has no referrer`);
  console.log(`      fix: const nav = useFromHere();  then ${v.kind === 'Link' ? 'state={nav}' : '{ state: nav }'}`);
}
console.log(`\n${violations.length} link(s) into a back-arrow page with no referrer — FAIL\n`);
process.exit(1);
