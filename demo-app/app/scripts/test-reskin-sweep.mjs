// test-reskin-sweep — the canary sweep's offline half, in CI (UI_RULES §121).
//
// reskin-sweep.mjs renders the app under a canary brand and fails on any painted colour that did not follow
// the swap. It needs a running app and Chrome, so it runs locally (`npm --prefix app run lint:reskin`,
// like lint:responsive). What CI holds here, so the sweep can't quietly stop looking:
//   1. the canary replaces EVERY colour palette entry and channel token of the theme cascade (counted
//      independently of the sweep's own filter), with colours no theme uses;
//   2. it re-draws the client theme's GENERATED values (the data-URI chevron) in the canary.
// Its routes are every surface App.jsx routes to (scripts/app-routes.mjs, shared with lint:responsive and
// style-snapshot); test-app-routes.mjs holds that list.
import { buildCanary } from './reskin-sweep.mjs';
import { readCascade } from './design-system-lib.mjs';

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

console.log('the canary');
const { css, canary, original, entries, names } = buildCanary();
// the palette, counted here with a different rule: a declared value that is one colour literal (hex or
// rgb/rgba) or one "r, g, b" triplet
const isColour = (v) => /^\s*(#[0-9a-f]{3,8}|rgba?\(\s*\d+\s*[, ]\s*\d+\s*[, ]\s*\d+\s*(?:[,/]\s*[\d.]+%?\s*)?\))\s*$/i.test(v);
const isTriplet = (v) => /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$/.test(v);
const palette = readCascade().filter((t) => isColour(t.declared) || isTriplet(t.declared)).map((t) => t.name);
ok(palette.length > 50 && palette.length === entries, `the canary swaps all ${palette.length} palette entries (it swapped ${entries})`);
const missing = palette.filter((n) => !names.includes(n) || !css.includes(`--${n}:`));
ok(missing.length === 0, `every palette entry is in the injected style${missing.length ? ` (missing: ${missing.slice(0, 6).join(', ')})` : ''}`);
const clash = [...canary].filter((k) => original.has(k));
ok(clash.length === 0 && canary.size >= entries, `${canary.size} canary colours, none of them a theme colour`);
ok(/--icon-select-chevron: url\("data:image\/svg\+xml,[^"]*stroke='%23([0-9a-f]{6})'/.test(css) && !css.includes("stroke='%2394a3b8'"), "the GENERATED chevron is re-drawn in the canary's neutral-400");
ok(/^:root:root \{/.test(css) && css.includes('transition: none !important'), 'the injected style outranks :root and stops transitions (no mid-transition colours)');

if (failed) { console.error(`\n✗ test-reskin-sweep: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-reskin-sweep: the canary swaps every palette entry and re-draws the GENERATED values (its routes: test-app-routes.mjs)');
