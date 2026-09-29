// The text-field focus ring is visible: ≥3:1 against every surface a field sits on
// (UI_RULES §119, STRUCTURE.md §1 "--focus-ring-color … ≥3:1 against adjacent surfaces").
//
// The ring is `--input-focus-shadow` = 0 0 0 var(--focus-ring-width) var(--focus-ring-color),
// painted OUTSIDE the field's ink border, over whatever is behind the field. Until
// 2026-09-24 neither token was defined in any layer, so the whole shadow was invalid and
// every field focused with no ring at all. This suite asserts against the SOURCE OF TRUTH —
// the theme files, resolved through index.css's own @import order — never a restated hex:
//   · the recipe reads both tokens and resolves to a real 2px+ ring;
//   · the ring colour (composited, if translucent, over each surface) holds ≥3:1 against the
//     white card / focused fill, the unfocused field fill (--field-bg), the page ground, the
//     L0 well, a zebra row and a gold-hovered row;
//   · it holds ≥3:1 against the ink border it wraps — else it reads as a thicker border, not a ring;
//   · the SHELL default (the cascade without the client colour overlay) also holds, on the
//     surfaces and against the shell's own ink border, so a clone that forgets to re-tint still
//     gets a visible ring (register CS-343: it was the border's own colour, 1:1);
//   · a `.btn` shows keyboard focus with the §119 outline ring (register CS-342);
//   · the field primitives' focus states paint the ring, and no focus state uses the
//     decorative --ring-focus (2.2:1 — the list search + reply box used it until this fix).
//
//   node scripts/test-focus-ring-contrast.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (f) => readFileSync(SRC + f, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── the cascade, from index.css's @import order ────────────────────────────────
const indexCss = stripComments(read('index.css'));
const imports = [...indexCss.matchAll(/@import\s+['"]\.\/([\w.-]+\.css)['"]/g)].map((m) => m[1]);
const overlays = imports.filter((f) => /^theme-[\w-]+\.css$/.test(f) && f !== 'theme-flat.css');

// Top-level :root declarations only (a :root inside @media is a conditional override).
function rootDecls(css) {
  const out = new Map();
  let depth = 0;
  let start = 0;                                    // where the current top-level prelude began
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0 && css.slice(start, i).trim() === ':root') {
        const end = css.indexOf('}', i);            // a :root block holds declarations only
        for (const m of `${css.slice(i + 1, end)};`.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
        i = end;
        start = end + 1;
        continue;
      }
      depth += 1;
      start = i + 1;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      start = i + 1;
    } else if (ch === ';' && depth === 0) {
      start = i + 1;                                // a top-level @import / @charset statement
    }
  }
  return out;
}
function cascade(files) {
  const vars = new Map();
  for (const f of files) for (const [k, v] of rootDecls(f === 'index.css' ? indexCss : stripComments(read(f)))) vars.set(k, v);
  return vars;
}
function substitute(value, vars, seen = []) {
  let out = value;
  for (let guard = 0; /var\(/.test(out); guard += 1) {
    if (guard > 50) throw new Error(`runaway var() in ${value}`);
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/, (m, name, fallback) => {
      if (seen.includes(name)) throw new Error(`cycle through ${name}`);
      if (vars.has(name)) return substitute(vars.get(name), vars, [...seen, name]);
      if (fallback !== undefined) return fallback.trim();
      throw new Error(`${name} is not defined in the cascade`);
    });
  }
  return out;
}
function color(s) {
  s = s.trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return { rgb: [0, 2, 4].map((j) => parseInt(h.slice(j, j + 2), 16)), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`not a colour: ${s}`);
}
const over = (fg, bg) => fg.rgb.map((c, j) => c * fg.a + bg[j] * (1 - fg.a));
const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// A translucent ring composites over the surface behind the field.
const ringOn = (ring, surfaceRgb) => contrast(over(ring, surfaceRgb), surfaceRgb);
const opaque = (vars, name) => { const c = color(substitute(`var(${name})`, vars)); return c.a === 1 ? c.rgb : over(c, [255, 255, 255]); };
// Resolve or report: an unresolvable token is a named failure, never a crash.
function resolved(label, fn) {
  try { return fn(); } catch (e) { ok(`${label} resolves (${e.message})`, false); return null; }
}

// ── fixtures: the maths and the resolver ───────────────────────────────────────
{
  ok('black on white is 21:1', Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
  ok('#767676 on white is the classic 4.54:1', Math.abs(contrast(color('#767676').rgb, [255, 255, 255]) - 4.54) < 0.01);
  const v = new Map([['--rgb', '24, 24, 27'], ['--c', 'rgba(var(--rgb), 0.6)'], ['--alias', 'var(--c)']]);
  ok('var() chains + rgb triplets resolve', substitute('var(--alias)', v) === 'rgba(24, 24, 27, 0.6)');
  let threw = false; try { substitute('var(--nope)', v); } catch { threw = true; }
  ok('an undefined token throws instead of resolving to nothing', threw);
  ok('35% ink (the old --ring-focus) FAILS 3:1 on white — the check has teeth',
    ringOn(color('rgba(24, 24, 27, 0.35)'), [255, 255, 255]) < 3);
  ok('top-level :root only (a :root inside @media is ignored)',
    rootDecls(':root { --a: 1px; }\n@media (max-width: 640px) { :root { --a: 9px; } }\n.x { --a: 7px; }').get('--a') === '1px');
}

// ── the real cascade ───────────────────────────────────────────────────────────
ok(`index.css imports theme.css first and theme-flat.css last (got ${imports.join(' → ')})`,
  imports[0] === 'theme.css' && imports[imports.length - 1] === 'theme-flat.css');
ok('exactly one client colour overlay sits between them', overlays.length === 1);

const LIVE = cascade([...imports, 'index.css']);
const SHELL = cascade(imports.filter((f) => !overlays.includes(f)));

for (const [label, vars] of [['live', LIVE], ['shell default', SHELL]]) {
  const recipe = resolved(`${label}: --input-focus-shadow`, () => substitute('var(--input-focus-shadow)', vars));
  if (recipe === null) continue;
  const raw = vars.get('--input-focus-shadow') || '';
  ok(`${label}: the recipe reads --focus-ring-width and --focus-ring-color`, raw.includes('var(--focus-ring-width)') && raw.includes('var(--focus-ring-color)'));
  const m = recipe.match(/^0 0 0 (\d+(?:\.\d+)?)px (.+)$/);
  ok(`${label}: the recipe resolves to a solid spread ring (got "${recipe}")`, !!m);
  if (m) ok(`${label}: the ring is ≥2px (STRUCTURE §1 / WCAG 2.4.13 perimeter)`, +m[1] >= 2);
}

const SURFACES = [
  ['white card · modal · focused field fill', '--card-bg'],
  ['unfocused field fill', '--field-bg'],
  ['page ground', '--page-bg'],
  ['L0 well', '--inset-bg'],
  ['zebra row', '--table-row-odd'],
];
const results = [];
const liveRing = resolved('live: --focus-ring-color', () => color(substitute('var(--focus-ring-color)', LIVE)));
if (liveRing) {
  for (const [label, token] of SURFACES) {
    const bg = resolved(`live: ${token}`, () => opaque(LIVE, token));
    if (!bg) continue;
    const cr = ringOn(liveRing, bg);
    results.push(`${token} ${cr.toFixed(2)}`);
    ok(`live ring ≥3:1 on the ${label} (${token}): ${cr.toFixed(2)}:1`, cr >= 3);
  }
  const hovered = resolved('live: a gold-hovered row', () => over(color(substitute('var(--table-row-hover)', LIVE)), opaque(LIVE, '--table-row-even')));
  if (hovered) {
    const cr = ringOn(liveRing, hovered);
    results.push(`hover ${cr.toFixed(2)}`);
    ok(`live ring ≥3:1 on a gold-hovered row: ${cr.toFixed(2)}:1`, cr >= 3);
  }
  const ink = resolved('live: --primary (the focused border)', () => opaque(LIVE, '--primary'));
  if (ink) {
    const crInk = contrast(over(liveRing, opaque(LIVE, '--card-bg')), ink);
    results.push(`vs ink border ${crInk.toFixed(2)}`);
    ok(`live ring ≥3:1 against the ink border it wraps (else it reads as a thicker border): ${crInk.toFixed(2)}:1`, crInk >= 3);
  }
}
const shellRing = resolved('shell default: --focus-ring-color', () => color(substitute('var(--focus-ring-color)', SHELL)));
if (shellRing) {
  for (const token of ['--card-bg', '--page-bg', '--inset-bg']) {
    const cr = ringOn(shellRing, opaque(SHELL, token));
    ok(`shell-default ring ≥3:1 on ${token}: ${cr.toFixed(2)}:1`, cr >= 3);
  }
  const shellInk = resolved('shell default: --primary (the focused border)', () => opaque(SHELL, '--primary'));
  if (shellInk) {
    const cr = contrast(over(shellRing, opaque(SHELL, '--card-bg')), shellInk);
    ok(`shell-default ring ≥3:1 against the ink border it wraps (CS-343): ${cr.toFixed(2)}:1`, cr >= 3);
  }
}

// ── the focus states that paint it ─────────────────────────────────────────────
const rules = [...indexCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] }));
const FIELD_FOCUS = [
  '.input:focus', '.select-trigger:focus', 'textarea.input.note-field:focus', '.crew-trigger:focus-within',
  '.tag-picker-row:focus-within', '.msearch-shell:focus-within', '.table-search:focus-within', '.email-modal-reply-input:focus',
];
for (const sel of FIELD_FOCUS) {
  const own = rules.filter((r) => r.sel.split(',').map((s) => s.trim()).includes(sel));
  ok(`${sel} paints var(--input-focus-shadow)`, own.some((r) => /box-shadow\s*:\s*var\(--input-focus-shadow\)/.test(r.body)));
}
// CS-342: a button shows keyboard focus with the §119 outline ring (≥2px, off the button by the offset)
{
  const own = rules.filter((r) => r.sel.split(',').map((s) => s.trim()).includes('.btn:focus-visible'));
  ok('.btn:focus-visible paints an outline of --focus-ring-width', own.some((r) => /outline\s*:\s*var\(--focus-ring-width\)\s+solid\s+var\(--[\w-]+\)/.test(r.body)));
  ok('.btn:focus-visible sets it off the button by --focus-ring-offset', own.some((r) => /outline-offset\s*:\s*var\(--focus-ring-offset\)/.test(r.body)));
}
for (const r of rules.filter((x) => /:focus/.test(x.sel) && /var\(--ring-focus\)/.test(x.body))) {
  ok(`${r.sel} paints the decorative --ring-focus (2.2:1) as a focus ring — use var(--input-focus-shadow)`, false);
}

console.log(`focus-ring: live ${results.join(' · ')}`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed (${pass} passed):`);
  for (const f of fails) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(`✔ ${pass} checks passed`);
