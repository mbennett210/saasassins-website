// Shared by design-system.mjs (the generator) and test-design-system.mjs (the drift gate).
//
// The design system (app/design-system/, published as the "Clean Space" Design System
// artifact) is a MIRROR of the code, never a second source of truth. Everything a value can
// be read from is read here from the real sources:
//   - tokens:     the :root cascade in app load order (theme.css > theme-cleanspace.css >
//                 theme-flat.css > index.css), picked + annotated by design-system/tokens.config.json
//   - type:       the CSS rule of each text role (selector named in the config)
//   - components: app/src/components, listed in design-system/components.json
//   - rules:      every numbered rule in UI_RULES.md, THEME_CLEANSPACE.md, STYLING.md and
//                 STRUCTURE.md, classified in design-system/rules.json
// Pure functions only: no network, no writes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(APP, '..');
export const DS = path.join(APP, 'design-system');
const SRC = path.join(APP, 'src');
export const THEME_FILES = ['theme.css', 'theme-cleanspace.css', 'theme-flat.css', 'index.css'];

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const blankComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

// ── 1. The :root cascade ────────────────────────────────────────────────────────────
// Every custom property declared in a TOP-LEVEL `:root` block, in first-seen order, with the
// value that wins (later files override earlier ones, exactly as the browser applies them).
// `overrides` replaces a theme file's text by name (brand-review.mjs resolves a candidate brand's palette
// without writing it).
export function readCascade(overrides = {}) {
  const order = [];
  const final = new Map();
  for (const f of THEME_FILES) {
    const txt = blankComments(overrides[f] ?? fs.readFileSync(path.join(SRC, f), 'utf8'));
    let cur = '';
    const stack = [];
    for (const c of txt) {
      if (c === '{') { stack.push(cur.trim()); cur = ''; continue; }
      if (c === '}') { stack.pop(); cur = ''; continue; }
      if (c === ';') {
        const m = /^(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]*)$/.exec(cur.trim());
        cur = '';
        if (m && stack.length === 1 && stack[0] === ':root') {
          const name = m[1].slice(2);
          if (!final.has(name)) order.push(name);
          final.set(name, { name, declared: m[2].replace(/\s+/g, ' ').trim(), file: f });
        }
        continue;
      }
      cur += c;
    }
  }
  const resolve = (v, seen = new Set()) => v.replace(/var\(\s*--([A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (all, n, fb) => {
    if (seen.has(n)) return all;
    const d = final.get(n);
    if (!d) return fb !== undefined ? resolve(fb.trim(), seen) : all;
    return resolve(d.declared, new Set([...seen, n]));
  });
  return order.map((n) => ({ ...final.get(n), resolved: resolve(final.get(n).declared) }));
}

// Responsive token overrides: `@media (…) { :root { --x: … } }` blocks in the theme files. The
// cascade above is the desktop value; these re-point a token at a breakpoint (e.g. 16px fields on
// phones). The generator carries them into bundle.css so the published previews match the app.
export function readMediaOverrides() {
  const out = [];
  for (const f of THEME_FILES.filter((x) => x !== 'index.css')) {
    const txt = blankComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    let cur = '';
    const stack = [];
    for (const c of txt) {
      if (c === '{') { stack.push(cur.trim()); cur = ''; continue; }
      if (c === '}') { stack.pop(); cur = ''; continue; }
      if (c === ';') {
        const m = /^(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]*)$/.exec(cur.trim());
        cur = '';
        if (m && stack.length === 2 && stack[0].startsWith('@media') && stack[1] === ':root') {
          const media = stack[0].replace(/\s+/g, ' ');
          let block = out.find((b) => b.file === f && b.media === media);
          if (!block) out.push((block = { file: f, media, decls: [] }));
          block.decls.push([m[1].slice(2), m[2].replace(/\s+/g, ' ').trim()]);
        }
        continue;
      }
      cur += c;
    }
  }
  return out;
}

// ── 2. Top-level rules of a stylesheet (selector list → declarations) ─────────────────
export function parseRules(css) {
  const txt = blankComments(css);
  const out = [];
  let cur = '';
  const stack = [];
  for (let k = 0; k < txt.length; k++) {
    const c = txt[k];
    if (c === '{') { stack.push({ sel: cur.trim(), start: k }); cur = ''; continue; }
    if (c === '}') {
      const top = stack.pop();
      if (top) {
        const body = txt.slice(top.start + 1, k);
        if (!body.includes('{')) {
          const decls = {};
          for (const d of body.split(';')) {
            const i = d.indexOf(':');
            if (i > 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
          }
          out.push({ selectors: top.sel.split(',').map((s) => s.replace(/\s+/g, ' ').trim()), decls, media: stack.map((s) => s.sel) });
        }
      }
      cur = '';
      continue;
    }
    if (c === ';' && stack.length === 0) { cur = ''; continue; }
    cur += c;
  }
  return out;
}

export function readAppCss() {
  return fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
}

// ── 3. tokens.json ─────────────────────────────────────────────────────────────────
// Values come from the cascade; names, order, grouping and notes come from the config.
export function signatureFaces() {
  const src = fs.readFileSync(path.join(SRC, 'components', 'SignatureCapture.jsx'), 'utf8');
  return new Map([...src.matchAll(/css:\s*"'([^']+)',\s*cursive"/g)].map((m) => [m[1], `"${m[1]}", cursive`]));
}

export function buildTokens(config, { cascade = readCascade(), rules = parseRules(readAppCss()), faces = signatureFaces() } = {}) {
  const errors = [];
  const byName = new Map(cascade.map((r) => [r.name, r]));
  const decl = (n) => {
    const r = byName.get(n);
    if (!r) { errors.push(`--${n} is in tokens.config.json but no :root block defines it`); return null; }
    return r.declared;
  };
  // rgba(var(--x-rgb), a) → rgba(r, g, b, a); any other var() → the variable's literal value
  const lit = (v) => (v == null ? null : v
    .replace(/rgba\(\s*var\(--([a-z0-9-]+)\)\s*,\s*([0-9.]+)\s*\)/g, (_, n, a) => `rgba(${decl(n)}, ${a})`)
    .replace(/var\(--([a-z0-9-]+)\)/g, (_, n) => lit(decl(n))));
  const colorNames = new Set(config.color.tokens.map((t) => t.name));

  const colorValue = (name) => {
    const d = decl(name);
    if (d == null) return null;
    const alias = /^var\(--([a-z0-9-]+)\)$/.exec(d);
    if (/^#[0-9a-fA-F]{3,8}$/.test(d)) return d.toLowerCase();
    if (alias) return colorNames.has(alias[1]) ? `{${alias[1]}}` : lit(d);
    if (/^rgba?\(/.test(d)) return lit(d);
    errors.push(`--${name}: "${d}" is not a colour the design system can publish (hex, rgb[a] or an alias)`);
    return null;
  };

  const tokens = { name: config.name, version: 1, meta: config.meta };
  tokens.color = { note: config.color.note, themes: config.color.themes, tokens: config.color.tokens.map((t) => ({ name: t.name, value: colorValue(t.name), usage: t.usage })) };

  // type: families from the cascade / SignatureCapture.jsx, styles from their CSS rule
  const families = {};
  for (const [key, src] of Object.entries(config.type.families)) {
    if (src.var) families[key] = (decl(src.var) || '').replace(/'/g, '"');
    else if (src.signature) {
      if (!faces.has(src.signature)) errors.push(`signature face "${src.signature}" is not in SignatureCapture.jsx FONTS`);
      families[key] = faces.get(src.signature) || '';
    }
  }
  const ruleFor = (sel) => {
    const hits = rules.filter((r) => r.media.length === 0 && r.selectors.includes(sel));
    if (!hits.length) errors.push(`type style selector "${sel}" matches no top-level rule in index.css`);
    return Object.assign({}, ...hits.map((h) => h.decls)); // later rules win, as in the browser
  };
  const len = (v) => (v == null ? undefined : lit(v).replace(/\s+/g, ' '));
  const groups = config.type.groups.map((g) => ({
    name: g.name,
    ...(g.family ? { family: g.family } : {}),
    ...(g.note ? { note: g.note } : {}),
    styles: g.styles.map((s) => {
      if (s.literal) return { name: s.name, ...(s.family ? { family: s.family } : {}), ...s.literal, sample: s.sample, usage: s.usage };
      const d = { ...(s.inherit ? ruleFor(s.inherit) : {}), ...ruleFor(s.selector) };
      const size = len(d['font-size']);
      if (!size) errors.push(`type style ${s.name}: ${s.selector} sets no font-size`);
      const weight = d['font-weight'] ? Number(len(d['font-weight'])) : 400;
      const style = { name: s.name, fontSize: size, lineHeight: d['line-height'] ? Number(len(d['line-height'])) || len(d['line-height']) : 1.5, fontWeight: weight };
      if (d['letter-spacing'] && len(d['letter-spacing']) !== '0') style.letterSpacing = len(d['letter-spacing']);
      if (s.family) style.family = s.family;
      return { ...style, sample: s.sample, usage: s.usage };
    }),
  }));
  tokens.type = { fonts: [], families, groups };
  for (const [fam, f] of Object.entries(config.families)) {
    tokens[fam] = { ...(f.note ? { note: f.note } : {}), tokens: f.tokens.map((t) => ({ name: t.name, value: lit(decl(t.name)), usage: t.usage })) };
  }

  // coverage: every :root variable is a token or a recipe, exactly once
  const published = new Set([...config.color.tokens.map((t) => t.name), ...Object.values(config.families).flatMap((f) => f.tokens.map((t) => t.name))]);
  for (const v of Object.values(config.type.families)) if (v.var) published.add(v.var);
  const recipes = new Set(config.recipes);
  const seen = new Map();
  for (const n of [...published, ...recipes]) seen.set(n, (seen.get(n) || 0) + 1);
  for (const [n, c] of seen) if (c > 1) errors.push(`--${n} is classified twice (token and recipe, or listed twice)`);
  for (const r of cascade) {
    if (!published.has(r.name) && !recipes.has(r.name)) errors.push(`--${r.name} (${r.file}) is new: publish it as a token with a usage note, or list it under "recipes" in design-system/tokens.config.json`);
  }
  for (const n of recipes) if (!byName.has(n)) errors.push(`recipe --${n} is listed in tokens.config.json but no :root block defines it any more`);
  const media = readMediaOverrides();
  for (const b of media) {
    for (const [n] of b.decls) if (!byName.has(n)) errors.push(`--${n} is set inside ${b.media} (${b.file}) but has no top-level :root value; declare its base value first`);
  }
  // The responsive values are part of the contract too (fields at 16px and md controls at 40px on
  // phones), so the snapshot records them and a phone-only change fails the gate like any other.
  // They ride in `meta`, which the Design System page keeps but does not display.
  if (media.length) tokens.meta = { ...(config.meta || {}), responsive: media.map((b) => ({ media: b.media, file: b.file, tokens: b.decls.map(([n, v]) => ({ name: n, value: v, resolved: lit(v) })) })) };
  for (const t of [...config.color.tokens, ...Object.values(config.families).flatMap((f) => f.tokens)]) {
    if (!t.usage || !t.usage.trim()) errors.push(`--${t.name} has no usage note`);
  }
  return { tokens, errors };
}

// ── 4. Rules: every numbered rule in the four rule docs ─────────────────────────────
const words = (s, n) => s.replace(/`/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, n).join('-').toLowerCase();
export function enumerateRules() {
  const out = [];
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  // `## §0 — …` (the adoption contract) is a rule too, headed in its own style.
  for (const m of read('UI_RULES.md').matchAll(/^## §(\d+) — (.+)$/gm)) {
    out.push({ id: `UI-${m[1]}-${words(m[2], 3)}`, source: 'UI_RULES.md', ref: `§${m[1]}`, title: m[2].trim() });
  }
  for (const m of read('UI_RULES.md').matchAll(/^## (\d+(?:\/\d+)?)\. (.+)$/gm)) {
    out.push({ id: `UI-${m[1].replace('/', '-')}-${words(m[2], 3)}`, source: 'UI_RULES.md', ref: `§${m[1]}`, title: m[2].trim() });
  }
  for (const m of read('app/src/THEME_CLEANSPACE.md').matchAll(/^### (R\d+) — (.+?)(?:\s+⟵.*)?$/gm)) {
    out.push({ id: `THEME-${m[1]}`, source: 'app/src/THEME_CLEANSPACE.md', ref: m[1], title: m[2].trim() });
  }
  const styling = read('app/src/STYLING.md');
  const enforced = styling.slice(styling.indexOf('## Rules (enforced)'), styling.indexOf('## Freedoms'));
  for (const m of enforced.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)) {
    out.push({ id: `STYLING-${m[1]}`, source: 'app/src/STYLING.md', ref: `Rule ${m[1]}`, title: m[2].replace(/\.$/, '').trim() });
  }
  const structure = read('app/src/STRUCTURE.md');
  // Every section states rules except §10 (enumerated row by row below) and the history sections,
  // Provenance and Changelog. Skipped by title, not number, so a NEW section is enumerated and
  // fails the gate until it is classified.
  for (const m of structure.matchAll(/^## §(\d+) · (.+)$/gm)) {
    const n = Number(m[1]);
    if (n === 10 || /^(Provenance|Changelog)\b/.test(m[2].trim())) continue;
    out.push({ id: `STRUCTURE-${n}`, source: 'app/src/STRUCTURE.md', ref: `§${n}`, title: m[2].trim() });
  }
  const catalog = structure.slice(structure.indexOf('## §10'), structure.indexOf('## §11'));
  // A retired row stays in the catalog (and in rules.json, as superseded) so the record of what it held survives.
  for (const m of catalog.matchAll(/^\| `([a-z0-9-]+)` \| (error|warn|retired) \| (.+?) \|$/gm)) {
    out.push({ id: `STRUCTURE-LINT-${m[1]}`, source: 'app/src/STRUCTURE.md', ref: `§10 ${m[1]}`, title: m[3].replace(/`/g, '').trim() });
  }
  return out;
}

// The closed vocabulary rules.json may use, and the checks a rule may cite.
export const STATUSES = ['gated', 'checked', 'construction', 'review', 'superseded'];
export function knownChecks() {
  const pkg = readJson(path.join(APP, 'package.json'));
  const scripts = new Set(Object.keys(pkg.scripts).filter((k) => k.startsWith('lint') || k.startsWith('test')));
  const files = new Set(fs.readdirSync(path.join(APP, 'scripts')).filter((f) => /^test-.*\.mjs$/.test(f)));
  const lintSrc = fs.readFileSync(path.join(APP, 'scripts', 'design-lint.mjs'), 'utf8');
  const designRules = new Set([...lintSrc.slice(lintSrc.indexOf('const RULES = {'), lintSrc.indexOf('};', lintSrc.indexOf('const RULES = {'))).matchAll(/'([a-z0-9-]+)':\s*\{/g)].map((m) => m[1]));
  // What CI's `verify` job runs (.github/workflows/ci.yml): the offline suites + these lints.
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const gatedScripts = new Set([...ci.matchAll(/npm --prefix app run ([a-z:-]+)/g)].map((m) => m[1]));
  // The suites CI runs, asked of the runner itself (`run-tests.mjs --list`), so both of its exclusions
  // apply: the LIVE_EFFECT map and the backend suites it skips when app/api is absent. A "gated" entry
  // citing only an excluded suite is not gated. null = the runner printed no list.
  const listed = execFileSync(process.execPath, [path.join(APP, 'scripts', 'run-tests.mjs'), '--list'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
  const m = /offline suites \((\d+)\):\n((?: {2}\S+\n?)+)/.exec(listed);
  // …and only if CI still runs the runner at all.
  const ciRunsSuites = /node app\/scripts\/run-tests\.mjs/.test(ci);
  const ciTests = m && ciRunsSuites ? new Set(m[2].trim().split('\n').map((l) => l.trim())) : null;
  if (ciTests && ciTests.size !== Number(m[1])) throw new Error(`run-tests --list announced ${m[1]} suites but listed ${ciTests.size}`);
  return { scripts, files, designRules, gatedScripts, ciTests };
}

// ── 5. Components ──────────────────────────────────────────────────────────────────
// Props a component destructures (plus `rest.x` reads when it spreads a rest object).
export function sourceProps(file, fnName) {
  const src = fs.readFileSync(path.join(APP, file), 'utf8');
  const at = src.search(new RegExp(`function ${fnName}\\s*\\(`));
  if (at < 0) return null;
  let i = src.indexOf('(', at) + 1;
  while (/\s/.test(src[i])) i++;
  if (src[i] !== '{') return [];
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    if ('{[('.includes(src[j])) depth++;
    else if ('}])'.includes(src[j]) && --depth === 0) break;
  }
  const inner = src.slice(i + 1, j).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const parts = [];
  let d = 0;
  let cur = '';
  for (const c of inner) {
    if ('{[('.includes(c)) d++;
    if ('}])'.includes(c)) d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const keys = new Set();
  let rest = null;
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (p.startsWith('...')) rest = p.slice(3).trim();
    else keys.add(p.split(/[=:]/)[0].trim());
  }
  if (rest) for (const m of src.matchAll(new RegExp(`\\b${rest}\\.([A-Za-z_]\\w*)`, 'g'))) keys.add(m[1]);
  return [...keys];
}

export function dtsProps(dts, iface) {
  const at = dts.search(new RegExp(`interface ${iface}\\b[^{]*\\{`));
  if (at < 0) return null;
  const open = dts.indexOf('{', at);
  let depth = 0;
  let j = open;
  for (; j < dts.length; j++) {
    if (dts[j] === '{') depth++;
    else if (dts[j] === '}' && --depth === 0) break;
  }
  const body = dts.slice(open + 1, j);
  const keys = [];
  let d = 0;
  let tok = '';
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if ('{(<['.includes(c)) d++;
    if ('})]'.includes(c) || (c === '>' && body[k - 1] !== '=')) d--; // `=>` is an arrow, not a closing bracket
    if (d === 0 && (c === ';' || c === '\n')) { const m = /^\s*([A-Za-z_]\w*)\??\s*:/.exec(tok); if (m) keys.push(m[1]); tok = ''; } else tok += c;
  }
  const m = /^\s*([A-Za-z_]\w*)\??\s*:/.exec(tok);
  if (m) keys.push(m[1]);
  return keys;
}
