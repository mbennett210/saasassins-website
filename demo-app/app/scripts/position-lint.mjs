#!/usr/bin/env node
/**
 * position-lint — offsets must match the positioning scheme they resolve against.
 *
 * WHY THIS EXISTS (2026-07-29). The quote-builder dropdowns "did nothing" for a week. Nobody
 * wrote a bug; a correct declaration changed meaning underneath itself.
 *
 *   dc31a22 (inherited)  .contact-picker-menu { position: absolute; top: calc(100% + 4px) }
 *   9c8997d (2026-07-27) .contact-picker-menu.is-portal { position: fixed; /* silent on top *\/ }
 *
 * In the base design the menu rendered INSIDE the trigger's `position: relative` wrapper, so
 * `100%` was the trigger's height and the rule meant "4px below the trigger" — correct, and it
 * is still correct in cleanspace-app and shell-build, which never portalled the menu. Portalling
 * it to <body> and making it `fixed` re-pointed `%` at the VIEWPORT, so the same thirty
 * characters came to mean "4px below the bottom of the screen" (`top: innerHeight + 4`).
 *
 * `position` is not just another property: it redefines the coordinate system that
 * top/right/bottom/left — and every percentage on them — resolve against. A variant class has
 * to cancel not only the properties it is CHANGING, but the properties whose MEANING it changed.
 *
 * THREE INVARIANTS
 *   1. scheme-flip  — if `X.variant` changes `position` between absolute/fixed and the base `X`
 *                     declares top/right/bottom/left, the variant must neutralise those.
 *   2. pct-on-fixed — a `position: fixed` rule must not carry a percentage offset. Under fixed,
 *                     `%` is the viewport; a component-scoped rule almost never means that.
 *   3. both-axes    — a `flip ? … : …` inline-style ternary must set BOTH ends of BOTH axes, so
 *                     the unused end is actively cancelled rather than left to the stylesheet.
 *
 * Verified against the two clean upstreams: cleanspace-app and shell-build have 0 `.is-portal`
 * rules and carry the same base declaration harmlessly, which is why this never bit there.
 *
 * Run: node scripts/position-lint.mjs   (npm run lint:position)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OFFSETS = ['top', 'right', 'bottom', 'left'];
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const violations = [];
const add = (file, line, msg) => violations.push({ file, line, msg });

/* ── CSS ────────────────────────────────────────────────────────────────── */

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const lineOf = (t, i) => t.slice(0, i).split('\n').length;
const hasPct = (v) => /(^|[^\w-])\d*\.?\d+%/.test(v);

function parseRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    const decls = {};
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      decls[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    out.push({ selector, decls, index: m.index });
  }
  return out;
}

function checkCss(file) {
  const css = stripComments(readFileSync(file, 'utf8'));
  const rules = parseRules(css);

  for (const r of rules) {
    const pos = r.decls.position;

    // ── 2. percentage offset on a fixed rule ──
    if (pos === 'fixed') {
      for (const axis of OFFSETS) {
        const v = r.decls[axis];
        if (v && hasPct(v)) {
          add(file, lineOf(css, r.index),
            `\`${r.selector}\` is position:fixed with \`${axis}: ${v}\`.\n` +
            `      Under \`fixed\` a percentage resolves against the VIEWPORT, not the trigger or\n` +
            `      parent — \`top: 100%\` means "the full height of the window". Use an explicit\n` +
            `      length, or set the offset inline from a measured rect.`);
        }
      }
    }

    // ── 1. a compound variant that flips the positioning scheme ──
    // `.a.b`, `.a.b:hover`, `.a.b .c` → base compound is the leading `.a`
    if (!pos || !/^(fixed|absolute)$/.test(pos)) continue;
    const lead = r.selector.split(/[\s>+~,]/)[0];
    const classes = lead.match(/\.[A-Za-z0-9_-]+/g) || [];
    if (classes.length < 2) continue; // not a variant of a simpler rule

    for (const base of classes) {
      const baseRules = rules.filter(
        (o) => o !== r && o.selector === base && o.decls.position &&
               /^(fixed|absolute)$/.test(o.decls.position) && o.decls.position !== pos,
      );
      for (const b of baseRules) {
        for (const axis of OFFSETS) {
          const bv = b.decls[axis];
          if (bv === undefined) continue;
          if (r.decls[axis] !== undefined) continue; // neutralised — fine
          add(file, lineOf(css, r.index),
            `\`${r.selector}\` changes position to \`${pos}\` but leaves \`${axis}\` to \`${base}\`,\n` +
            `      which sets \`${axis}: ${bv}\` for \`${b.decls.position}\` (line ${lineOf(css, b.index)})` +
            `${hasPct(bv) ? ' — and it is a PERCENTAGE, so its meaning changes with the scheme' : ''}.\n` +
            `      Changing \`position\` re-points every offset. Add \`${axis}: auto;\` (or an explicit\n` +
            `      value) to the variant so it owns what it re-pointed.`);
        }
      }
    }
  }
}

/* ── JSX ────────────────────────────────────────────────────────────────── */

function balanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth--; if (!depth) return text.slice(openIdx, i + 1); }
  }
  return null;
}

function checkJsx(file) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('is-portal')) return;
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const re = /\.\.\.\s*\(/g;
  let m;
  let saw = false;
  while ((m = re.exec(code))) {
    const expr = balanced(code, m.index + m[0].length - 1);
    if (!expr || !/\bflip\b/.test(expr) || !expr.includes('?')) continue;
    saw = true;
    const q = expr.indexOf('?');
    let depth = 0, colon = -1;
    for (let i = q + 1; i < expr.length; i++) {
      const c = expr[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ':' && !depth) { colon = i; break; }
    }
    if (colon < 0) continue;
    const branches = {
      'flip (opens upward)': expr.slice(q + 1, colon),
      'no-flip (opens downward)': expr.slice(colon + 1, expr.length - 1),
    };
    for (const [name, body] of Object.entries(branches)) {
      const set = OFFSETS.filter((a) => new RegExp(`\\b${a}\\s*:`).test(body));
      // whichever axis-end is driving, its opposite must be cancelled too
      const missing = set.map((a) => OPPOSITE[a]).filter((o) => !set.includes(o));
      if (missing.length) {
        add(file, code.slice(0, m.index).split('\n').length,
          `portalled menu's \`${name}\` branch sets ${set.map((x) => `\`${x}\``).join(' + ')} ` +
          `but not ${[...new Set(missing)].map((x) => `\`${x}\``).join(' + ')}.\n` +
          `      The stylesheet's value for the unset end then survives on a fixed element. Set it\n` +
          `      to 'auto' explicitly: { ${missing[0]}: 'auto', … }`);
      }
    }
  }
  if (!saw) {
    add(file, 1,
      'renders `is-portal` but no flip ternary was found to check. If the anchoring moved,\n' +
      '      update scripts/position-lint.mjs so this invariant keeps being enforced.');
  }
}

/* ── run ────────────────────────────────────────────────────────────────── */

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

const files = walk(SRC);
files.filter((f) => f.endsWith('.css')).forEach(checkCss);
files.filter((f) => f.endsWith('.jsx')).forEach(checkJsx);

if (violations.length) {
  console.error(`\n✗ position-lint — ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${relative(ROOT, v.file)}:${v.line}\n      ${v.msg}\n`);
  console.error('An offset must match the positioning scheme it resolves against.\n');
  process.exit(1);
}

const cssCount = files.filter((f) => f.endsWith('.css')).length;
const jsxCount = files.filter((f) => f.endsWith('.jsx') && readFileSync(f, 'utf8').includes('is-portal')).length;
console.log(
  `✓ position-lint — ${cssCount} stylesheet(s) and ${jsxCount} portalled menu(s): no scheme-flip ` +
    `leaks, no percentage offsets on fixed, both axes owned.`,
);
