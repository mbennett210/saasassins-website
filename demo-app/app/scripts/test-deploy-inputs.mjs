// Every file the production build and the server functions import must reach Vercel.
//
// Vercel uploads app/ MINUS app/.vercelignore and runs `npm run build` on what arrived. Every
// local check builds in the full checkout, so an import of a file in an ignored folder passes
// all of them and fails only on Vercel: S128 round 2's first deploy (aab38cec, 2026-10-13)
// died in 7 s because vite.config.js imported ./scripts/sw-precache.mjs and .vercelignore
// drops scripts/. The site stayed on the build before it.
//
// This walks every relative import reachable from what Vercel runs (vite.config.js, the
// module scripts index.html loads, and every file under api/) with eslint's own parser, and
// fails on an import that resolves into a path .vercelignore drops, or to no file at all.
//
//   node app/scripts/test-deploy-inputs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (abs) => path.relative(APP, abs).split(path.sep).join('/');
let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// ── .vercelignore, read the way gitignore reads it ──────────────────────────────────────────
// A pattern with no inner slash matches a name at any depth; one with an inner slash is
// anchored at app/; a trailing slash matches folders only (and so everything inside them);
// `*` stays inside one name, `**` crosses folders; a later `!pattern` takes a path back.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export function parseIgnore(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const negate = line.startsWith('!');
    let p = negate ? line.slice(1) : line;
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    if (p.startsWith('/')) p = p.slice(1);
    return { line, negate, dirOnly, anchored: p.includes('/'), re: globToRe(p) };
  });
}
export function isIgnored(rules, relPath) {
  const segs = relPath.split('/');
  let ignored = false;
  for (const r of rules) {
    let hit = false;
    if (r.anchored) {
      for (let k = 1; k <= segs.length && !hit; k++) hit = (!r.dirOnly || k < segs.length) && r.re.test(segs.slice(0, k).join('/'));
    } else {
      const names = r.dirOnly ? segs.slice(0, -1) : segs;
      hit = names.some((s) => r.re.test(s));
    }
    if (hit) ignored = !r.negate;
  }
  return ignored;
}

// The matcher itself, pinned on the patterns this file exists for.
{
  const rules = parseIgnore('# c\nnode_modules/\ndist/\nsupabase/\nscripts/\n*.local\n*.log\n.DS_Store\n');
  ok('ignore: scripts/ drops a file in app/scripts', isIgnored(rules, 'scripts/sw-precache.mjs'));
  ok('ignore: a folder pattern drops the same name at any depth', isIgnored(rules, 'src/scripts/x.js'));
  ok('ignore: a folder pattern does not drop a FILE of that name', !isIgnored(rules, 'src/lib/scripts'));
  ok('ignore: *.local drops .env.local', isIgnored(rules, '.env.local'));
  ok('ignore: api/ is uploaded', !isIgnored(rules, 'api/state/view.js'));
  ok('ignore: src/ is uploaded', !isIgnored(rules, 'src/lib/jobsWindow.js'));
  ok('ignore: vite.config.js is uploaded', !isIgnored(rules, 'vite.config.js'));
  const anchored = parseIgnore('/build/out\ndocs/**/*.md\n!keep.local\n*.local');
  ok('ignore: an anchored pattern matches from app/ only', isIgnored(anchored, 'build/out/x.js') && !isIgnored(anchored, 'src/build/out/x.js'));
  ok('ignore: ** crosses folders', isIgnored(anchored, 'docs/a/b/c.md') && !isIgnored(anchored, 'docs/a/b/c.js'));
  ok('ignore: a later pattern wins over an earlier !', isIgnored(anchored, 'keep.local'));
}

// ── the import walk ─────────────────────────────────────────────────────────────────────────
const CODE = /\.(m?js|cjs|jsx)$/;
const EXTS = ['', '.js', '.mjs', '.jsx', '.cjs', '.json', '/index.js', '/index.jsx', '/index.mjs'];
function resolveFrom(fromAbs, spec) {
  const clean = spec.replace(/[?#].*$/, '');
  const base = clean.startsWith('/') ? path.join(APP, clean) : path.resolve(path.dirname(fromAbs), clean);
  for (const e of EXTS) {
    const p = base + e;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}
// Relative specifiers in a parsed module: static and dynamic imports, re-exports, require(),
// and new URL('./x', import.meta.url) — every one is a file the bundler or the function needs.
function specifiers(src, file) {
  let ast;
  try { ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } }); } catch (e) {
    fails.push(`parse ${rel(file)}: ${e.message}`);
    return [];
  }
  const out = [];
  const lit = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value
    : n && n.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration') && n.source) out.push(lit(n.source));
    if (n.type === 'ImportExpression') out.push(lit(n.source));
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') out.push(lit(n.arguments[0]));
    if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'URL' && n.arguments[1]
      && n.arguments[1].type === 'MemberExpression' && n.arguments[1].object.type === 'MetaProperty') out.push(lit(n.arguments[0]));
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
  return out.filter((s) => typeof s === 'string' && (s.startsWith('./') || s.startsWith('../') || s.startsWith('/')));
}
// CSS a module imports can @import more CSS and url() fonts or images by relative path.
function cssSpecifiers(src) {
  const out = [];
  for (const m of src.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)) out.push(m[1]);
  for (const m of src.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g)) out.push(m[1]);
  return out.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

const rules = parseIgnore(fs.readFileSync(path.join(APP, '.vercelignore'), 'utf8'));
const roots = [path.join(APP, 'vite.config.js')];
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) roots.push(path.join(APP, m[1]));
const walkDir = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walkDir(p) : CODE.test(e.name) ? [p] : [];
});
for (const f of walkDir(path.join(APP, 'api'))) if (!isIgnored(rules, rel(f))) roots.push(f);
ok('the walk starts at vite.config.js, the page\'s module script and the server functions', roots.length > 3 && roots.some((r) => rel(r) === 'src/main.jsx'));

const seen = new Map(); // abs → the file that first imported it
const queue = roots.map((r) => [r, null]);
const dropped = [];
const missing = [];
while (queue.length) {
  const [file, from] = queue.shift();
  if (seen.has(file)) continue;
  seen.set(file, from);
  const r = rel(file);
  if (r.startsWith('..')) continue; // outside app/: not under app/.vercelignore
  if (isIgnored(rules, r)) { dropped.push(`${r} (imported by ${from ? rel(from) : 'the build'})`); continue; }
  if (!fs.existsSync(file)) { missing.push(`${r} (imported by ${from ? rel(from) : 'the build'})`); continue; }
  const src = fs.readFileSync(file, 'utf8');
  const specs = CODE.test(file) ? specifiers(src, file) : /\.css$/.test(file) ? cssSpecifiers(src) : [];
  for (const s of specs) {
    const target = resolveFrom(file, s);
    if (!target) { missing.push(`${s} (imported by ${r})`); continue; }
    if (!seen.has(target)) queue.push([target, file]);
  }
}
ok(`no build or function import lands in a folder .vercelignore drops (${seen.size} files walked)`, dropped.length === 0, dropped.join('; '));
ok('every relative import resolves to a file', missing.length === 0, missing.join('; '));
ok('the walk reaches the server functions\' shared code', [...seen.keys()].some((f) => rel(f).startsWith('api/_lib/')));

if (fails.length) {
  console.log(`test-deploy-inputs: ${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  ✖ ${f}`);
  process.exitCode = 1;
} else console.log(`test-deploy-inputs: ${pass}/${pass} passed (${seen.size} files walked)`);
