// lint:search — the master-search carry-through gate. Global search must never silently
// drift from the app's real routes, so this reconciles the search registry against App.jsx
// and FAILS the build when they disagree.
//
// 🔴 WHY. A module added, renamed or removed without updating the registry would quietly
// vanish from (or dangle in) global search — the exact "documented-as-dead route went live
// again" class of drift BUILD_INTEGRITY §2/§3 exist to kill. Coverage is MECHANICAL: the
// registry is ESM-imported (real objects, not a regex guess), the routes are parsed from
// App.jsx (reusing backnav-lint's comment-stripping + settings-path absolutiser), and the
// two must reconcile.
//
// It fails when:
//   (a) a page route in App.jsx has neither a registry entry nor an EXCLUDED_ROUTES reason
//   (b) a registry entry / exclusion / detail route points at a route that no longer exists
//   (c) a CANONICAL page entry (no '?query') gates on a perm ≠ the route's <RequirePerm>
//   (d) any registered perm is not in the permission vocabulary
// Param routes are exempt from (a) (reached via record sources); their templates are
// checked through DETAIL_ROUTES. Actions are exempt from (c) (they carry a CREATE perm,
// not the route's view perm).
//
//   node scripts/search-lint.mjs            # the gate
//   node scripts/search-lint.mjs --list     # show the derived routes, then exit
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Same comment-blanking as backnav-lint: strip block + line comments (keeping line numbers)
// so commented-out routes and prose that names <Route> never fool the parser.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n')
  .map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l.replace(/\s\/\/[^'"`]*$/, '')))
  .join('\n');

// Parse App.jsx into { pageRoutes: Map(path -> perm|null), paramRoutes: Set, publicPaths }.
export function parseRoutes(appSrcRaw) {
  const app = stripComments(appSrcRaw);
  const authedStart = app.indexOf('<Route element={<AuthedShell');
  const settingsOpen = app.indexOf('<Route path="settings"');
  const settingsEnd = settingsOpen < 0 ? -1 : app.indexOf('</Route>', settingsOpen);
  const insideSettings = (i) => settingsOpen >= 0 && i > settingsOpen && i < settingsEnd;
  const absolutise = (p, i) => (p.startsWith('/') ? p : (insideSettings(i) ? `/settings/${p}` : `/${p}`));

  const pageRoutes = new Map();
  const paramRoutes = new Set();
  const publicPaths = new Set();

  for (const m of app.matchAll(/<Route\s+path="([^"]+)"[^>]*element=\{([\s\S]{0,220}?)\}\s*\/?>/g)) {
    const [, rawPath, element] = m;
    const i = m.index;
    if (rawPath === '*') continue;                       // catch-all
    if (/<Navigate\b/.test(element)) continue;           // redirect — not a target, needs no entry
    const path = absolutise(rawPath, i);
    if (authedStart >= 0 && i < authedStart) { publicPaths.add(path); continue; } // public shell-less
    if (path.includes('/:')) { paramRoutes.add(path); continue; }
    const permM = element.match(/perm="([^"]+)"/);
    pageRoutes.set(path, permM ? permM[1] : null);
  }
  // The top-level index route is '/'; the settings index is '/settings' (already captured as
  // the layout route). Only the top-level one needs adding as a valid target.
  for (const m of app.matchAll(/<Route\s+index\s+element=\{[\s\S]{0,160}?\}\s*\/?>/g)) {
    const i = m.index;
    if ((authedStart >= 0 && i < authedStart) || insideSettings(i)) continue;
    pageRoutes.set('/', null);
  }
  return { pageRoutes, paramRoutes, publicPaths };
}

const basePathOf = (to) => String(to || '').split('?')[0];

// The pure reconciliation core (testable with synthetic inputs — test-search-lint.mjs).
export function lintSearch({ appSrc, entries, excluded, detailRoutes, permVocab }) {
  const { pageRoutes, paramRoutes } = parseRoutes(appSrc);
  const violations = [];
  // Rule (a) requires a navigable PAGE entry (an action alone does not make a route
  // findable as a destination); rules (b)/(d) validate every entry, page or action.
  const pageBasePaths = new Set(entries.filter((e) => e.kind === 'page').map((e) => basePathOf(e.to)));
  const excludedPaths = new Set(excluded.map((x) => x.path));

  // (a) every page route has a page entry or an exclusion
  for (const [path] of pageRoutes) {
    if (!pageBasePaths.has(path) && !excludedPaths.has(path)) {
      violations.push(`no search entry for route ${path} — add a page entry to registry.js, or an EXCLUDED_ROUTES reason`);
    }
  }
  // (b) every entry / exclusion / detail route points at a real route
  for (const e of entries) {
    const bp = basePathOf(e.to);
    if (!pageRoutes.has(bp) && !paramRoutes.has(bp)) {
      violations.push(`entry ${e.id} → ${e.to} points at no route (base ${bp})`);
    }
  }
  for (const x of excluded) {
    if (!pageRoutes.has(x.path) && !paramRoutes.has(x.path)) {
      violations.push(`stale exclusion ${x.path} matches no route`);
    }
  }
  for (const d of detailRoutes || []) {
    if (!paramRoutes.has(d)) violations.push(`stale detail route ${d} matches no param route`);
  }
  // (c) canonical page entries' perm matches the route's <RequirePerm>
  for (const e of entries) {
    if (e.kind !== 'page' || String(e.to).includes('?')) continue;
    const routePerm = pageRoutes.get(basePathOf(e.to));
    if (routePerm == null) continue; // index / ungated layout
    if (e.perm !== routePerm) {
      violations.push(`perm mismatch: ${e.id} gates "${e.perm}" but route ${basePathOf(e.to)} gates "${routePerm}"`);
    }
  }
  // (d) every registered perm exists in the vocabulary (perm / permsAny / permsAll)
  for (const e of entries) {
    for (const p of [...(e.permsAny ? e.permsAny : [e.perm]), ...(e.permsAll || [])]) {
      if (p && !permVocab.has(p)) violations.push(`unknown perm "${p}" in ${e.id}`);
    }
  }
  return violations;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Run ONLY when invoked directly (basename match — NOT when imported by
// test-search-lint.mjs, whose basename would satisfy a naive endsWith check).
if (process.argv[1] && basename(process.argv[1]) === 'search-lint.mjs') {
  const appSrc = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const registry = await import('../src/lib/masterSearch/registry.js');
  const roles = await import('../src/lib/roles.js');
  const permVocab = new Set([...Object.keys(roles.PERMISSIONS), ...roles.ALWAYS_GRANTED]);

  if (process.argv.includes('--list')) {
    const { pageRoutes, paramRoutes } = parseRoutes(appSrc);
    console.log('\npage routes (path → perm):');
    for (const [p, perm] of [...pageRoutes].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${p.padEnd(30)} ${perm || '(ungated)'}`);
    console.log('\nparam routes:');
    for (const p of [...paramRoutes].sort()) console.log(`  ${p}`);
    console.log(`\n${registry.NAV_ENTRIES.length} registry entries · ${registry.EXCLUDED_ROUTES.length} exclusion(s)\n`);
    process.exit(0);
  }

  const violations = lintSearch({
    appSrc,
    entries: registry.NAV_ENTRIES,
    excluded: registry.EXCLUDED_ROUTES,
    detailRoutes: registry.DETAIL_ROUTES,
    permVocab,
  });

  console.log(`\nsearch-lint — ${registry.NAV_ENTRIES.length} registry entries reconciled against App.jsx\n`);
  if (!violations.length) {
    console.log('  Registry and routes are in sync. ✓\n');
    process.exit(0);
  }
  for (const v of violations) console.log(`  ✗ ${v}`);
  console.log(`\n${violations.length} search-registry drift(s) — FAIL\n`);
  process.exit(1);
}
