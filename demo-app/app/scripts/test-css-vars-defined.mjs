// Every CSS custom property the app READS resolves to a DEFINITION (UI_RULES §119).
//
// A `var(--x)` whose --x nothing defines is silent at build time and at runtime: the
// browser treats the declaration as invalid (a box-shadow becomes `none`, a colour
// falls back to inherit) and a fallback — `var(--x, #fee2e2)` — renders forever and
// hides the typo. That is how the whole field focus ring went dark: theme-flat.css's
// --input-focus-shadow read --focus-ring-width / --focus-ring-color, which no theme
// layer defined after the clone, so every .input / .select / .select-trigger /
// .msearch-shell / .crew-trigger focused with no ring. 21 such names were live on
// 2026-09-24 (10 in CSS, 11 in JSX inline styles, incl. the DemoBackendsBanner
// safety strip rendering with no fill); this suite is why the next one fails CI.
//
// Coverage is MECHANICAL (BUILD_INTEGRITY audit-rigor law): the universe is every
// .css/.js/.jsx/.mjs under app/src plus app/index.html; comments are stripped first
// (a commented-out declaration is not a definition, a commented read is not a read).
//   READ        var(--name …)                       — a fallback does NOT excuse a miss
//   DEFINITION  --name: …   in CSS, or CSS text inside a JS string (report templates)
//               '--name': … / setProperty('--name', …)  — runtime vars set from JS
//               @property --name
// A var name built at runtime (`var(--x-${n})`) can't be checked, so it fails until
// its possible names are listed in DYNAMIC_OK. Scope: "defined somewhere", not "in
// the cascade scope of every read" — a var defined only under .a and read under .b
// still passes; keep app-wide tokens in the theme files' :root.
// app/public/*.html are standalone design mockups, not the app, and are not scanned.
//
//   node scripts/test-css-vars-defined.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));

// name-prefix → why a runtime-built var name is safe (and which names it can produce).
const DYNAMIC_OK = {};

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── the scanner ────────────────────────────────────────────────────────────────
const keepLines = (m) => m.replace(/[^\n]/g, ' ');
function stripComments(text, isCss) {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, keepLines);          // CSS, JS and JSX {/* */} blocks
  if (!isCss) t = t.replace(/^[ \t]*\/\/.*$/gm, keepLines);       // whole-line // comments
  return t;
}

const NAME = '--[A-Za-z0-9_-]+';
const READ_RE = new RegExp(`var\\(\\s*(${NAME})(\\$\\{|['"\`]\\s*\\+)?`, 'g');
const CSS_DEF_RE = new RegExp(`(?:^|[{;\\s])(${NAME})\\s*:`, 'gm');
const PROP_RE = new RegExp(`@property\\s+(${NAME})`, 'g');
const JS_KEY_RE = new RegExp(`['"\`](${NAME})['"\`]\\s*[:\\],]`, 'g');

function scan(files) {
  const reads = new Map();
  const defs = new Set();
  const dynamic = [];
  for (const { rel, text } of files) {
    const isCss = rel.endsWith('.css');
    const src = stripComments(text, isCss);
    const lines = src.split(/\r?\n/);
    lines.forEach((ln, i) => {
      for (const m of ln.matchAll(READ_RE)) {
        if (m[2]) { dynamic.push({ rel, line: i + 1, name: m[1] }); continue; }
        if (!reads.has(m[1])) reads.set(m[1], []);
        reads.get(m[1]).push(`${rel}:${i + 1}`);
      }
      for (const m of ln.matchAll(CSS_DEF_RE)) defs.add(m[1]);   // CSS, or CSS text in a JS string
      for (const m of ln.matchAll(PROP_RE)) defs.add(m[1]);
      if (!isCss) for (const m of ln.matchAll(JS_KEY_RE)) defs.add(m[1]);
    });
  }
  const undefinedReads = [...reads.keys()].filter((n) => !defs.has(n)).sort();
  return { reads, defs, dynamic, undefinedReads };
}

// ── fixtures: each rule pinned ─────────────────────────────────────────────────
{
  const f = (rel, text) => ({ rel, text });
  const r = scan([
    f('a.css', ':root { --ok: 1px; }\n.x { margin: var(--ok); color: var(--missing); }'),
    f('b.css', '.y { background: var(--fallback-hides, #fee2e2); }'),
    f('c.css', '/* :root { --commented: red; } */ .z { color: var(--commented); }'),
    f('d.css', '.w { box-shadow: 0 0 0 var(--ring-w) var(--ring-c); }\n.v { --ring-w: 2px; }'),
    f('e.jsx', "<div style={{ '--pane-left': a }} />; el.style.setProperty('--kb-inset', h); x = `var(--pane-left)` + 'var(--kb-inset)';"),
    f('f.js', "const css = `.doc{--navy:#1f2a6e;--ink:#111;} .h{color:var(--navy)} .b{color:var(--ink)}`;"),
    f('g.jsx', '// sets --only-in-comment: 1\nconst s = { color: "var(--only-in-comment)" };'),
    f('h.jsx', 'const s = { background: `var(--avatar-${n})`, color: "var(--tone-" + k + ")" };'),
    f('i.jsx', "const s = { color: 'var(--color-text-error, #b91c1c)' };"),
    f('j.css', '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }\n.k { rotate: var(--angle); }'),
  ]);
  const u = new Set(r.undefinedReads);
  ok('an undefined CSS read is caught', u.has('--missing'));
  ok('a read with a fallback is still caught (the fallback hides it at runtime)', u.has('--fallback-hides'));
  ok('a commented-out definition does not count', u.has('--commented'));
  ok('a whole-line // comment is not a definition', u.has('--only-in-comment'));
  ok('an undefined JSX inline-style read is caught', u.has('--color-text-error'));
  ok('a defined CSS token resolves', !u.has('--ok'));
  ok('a token defined under any selector resolves', !u.has('--ring-w'));
  ok('a JS style-object key defines a runtime var', !u.has('--pane-left'));
  ok('style.setProperty defines a runtime var', !u.has('--kb-inset'));
  ok('CSS text inside a JS template string defines its vars', !u.has('--navy') && !u.has('--ink'));
  ok('@property registers a var', !u.has('--angle'));
  ok('the undefined ring width+colour in one shadow are both caught', u.has('--ring-c') && !u.has('--ring-w'));
  ok('runtime-built names are flagged as dynamic, not silently passed',
    r.dynamic.length === 2 && r.dynamic.some((d) => d.name === '--avatar-') && r.dynamic.some((d) => d.name === '--tone-'));
  ok('the fixture caught exactly the planted misses',
    JSON.stringify(r.undefinedReads) === JSON.stringify(['--color-text-error', '--commented', '--fallback-hides', '--missing', '--only-in-comment', '--ring-c']));
}

// ── the real tree ──────────────────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(css|jsx?|mjs)$/.test(e.name)) files.push(full);
  }
})(join(APP, 'src'));
files.push(join(APP, 'index.html'));
const real = scan(files.map((p) => ({ rel: relative(APP, p).split(sep).join('/'), text: readFileSync(p, 'utf8') })));

const readSites = [...real.reads.values()].reduce((a, s) => a + s.length, 0);
// Sanity (the enumerator is not blind): one definition of each kind it must see — a theme
// token, a JS-set runtime var, a report template's CSS-in-JS var — and a floor on volume.
ok('the scan sees theme tokens, JS-set runtime vars and template-string vars',
  real.defs.has('--card-bg') && real.defs.has('--cs-vh') && real.defs.has('--doc-brand') && real.defs.size > 250 && readSites > 3000);

for (const name of real.undefinedReads) {
  const sites = real.reads.get(name);
  ok(`${name} is read but never defined — ${sites.slice(0, 4).join(', ')}${sites.length > 4 ? ` (+${sites.length - 4} more)` : ''}`, false);
}
for (const d of real.dynamic) {
  const allowed = Object.keys(DYNAMIC_OK).some((p) => d.name.startsWith(p));
  ok(`${d.rel}:${d.line} builds a var name at runtime (${d.name}…) — list its names in DYNAMIC_OK`, allowed);
}

console.log(`css-vars: ${files.length} files · ${readSites} var() reads of ${real.reads.size} names · ${real.defs.size} names defined · ${real.undefinedReads.length} undefined · ${real.dynamic.length} dynamic`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed (${pass} passed):`);
  for (const f of fails) console.error(`  ✖ ${f}`);
  console.error('\n  Define it in the right theme layer (tokens/aliases in theme.css, a client re-tint in its');
  console.error('  theme RECIPES, a runtime var from JS), or point the read at the token it meant (STYLING.md).');
  process.exit(1);
}
console.log(`✔ ${pass} checks passed`);
