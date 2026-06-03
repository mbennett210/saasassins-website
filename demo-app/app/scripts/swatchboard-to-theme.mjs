#!/usr/bin/env node
// =============================================================================
// swatchboard-to-theme.mjs
// -----------------------------------------------------------------------------
// Convert a legacy swatchboard HTML file into a shell-ready theme-<slug>.css
// that matches app/src/STYLING.md's canonical token vocabulary.
//
// Usage:
//   node app/scripts/swatchboard-to-theme.mjs <swatchboard.html> \
//        --slug <slug> [--name "Display Name"] [--mode auto|light|dark]
//
// Example:
//   node app/scripts/swatchboard-to-theme.mjs \
//     swatchboard/unzipped/theme_polishpoint_forge_swatchboard.html \
//     --slug polishpoint-forge --name "PolishPoint Forge"
//
// Output:
//   app/src/theme-<slug>.css
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = path.resolve(__dirname, '..', 'src');
const TEMPLATES = path.resolve(__dirname, 'templates');

// ----------------------------------------------------------------------------
// CLI parsing
// ----------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ----------------------------------------------------------------------------
// Color math: hex <-> sRGB <-> linear <-> OKLab <-> OKLCH
// ----------------------------------------------------------------------------
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  hex = hex.trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  const c = (n) => clamp(n).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

function rgbToOklab({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

function oklabToRgb({ L, a, b }) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return { r: linearToSrgb(lr), g: linearToSrgb(lg), b: linearToSrgb(lb) };
}

function oklabToOklch({ L, a, b }) {
  return { L, C: Math.sqrt(a * a + b * b), h: Math.atan2(b, a) };
}
function oklchToOklab({ L, C, h }) {
  return { L, a: C * Math.cos(h), b: C * Math.sin(h) };
}

function hexToOklch(hex) {
  return oklabToOklch(rgbToOklab(hexToRgb(hex)));
}
function oklchToHex({ L, C, h }) {
  return rgbToHex(oklabToRgb(oklchToOklab({ L, C, h })));
}
function clamp01(n) { return Math.max(0, Math.min(1, n)); }

function rgbTriplet(hex) {
  const { r, g, b } = hexToRgb(hex);
  return `${r}, ${g}, ${b}`;
}

function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// ----------------------------------------------------------------------------
// Swatchboard parsing
// ----------------------------------------------------------------------------
async function parseSwatchboard(filePath) {
  const html = await fs.readFile(filePath, 'utf8');
  const match = html.match(/:root\s*\{([\s\S]*?)\}/);
  if (!match) throw new Error(`No :root { ... } block found in ${filePath}`);
  const body = match[1];
  const tokens = {};
  const re = /--([a-z][a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

function isSolidHex(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(s);
}

function rgbaToHex(rgbaStr) {
  // Extract rgb portion from rgba(R, G, B, A) — alpha ignored.
  const m = rgbaStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)/);
  if (!m) return null;
  return rgbToHex({ r: +m[1], g: +m[2], b: +m[3] });
}

function asSolidHex(v) {
  if (!v) return null;
  if (isSolidHex(v)) return v.startsWith('#') ? v : `#${v}`;
  const fromRgba = rgbaToHex(v);
  if (fromRgba) return fromRgba;
  return null;
}

// ----------------------------------------------------------------------------
// Mode detection
// ----------------------------------------------------------------------------
function detectMode(tokens, override) {
  if (override === 'light' || override === 'dark') return override;
  const pageBg = asSolidHex(tokens['page-bg']);
  if (!pageBg) {
    throw new Error('Cannot auto-detect mode: --page-bg is not a parseable color. Use --mode light|dark.');
  }
  const L = hexToOklch(pageBg).L;
  if (L > 0.65) return 'light';
  if (L < 0.40) return 'dark';
  throw new Error(`Ambiguous mode: --page-bg lightness L=${L.toFixed(2)} is in the 0.40-0.65 gap. Use --mode light|dark.`);
}

// ----------------------------------------------------------------------------
// Brand scale
// ----------------------------------------------------------------------------
function deriveBrandScale(tokens, mode) {
  const anchor = asSolidHex(tokens['primary']);
  if (!anchor) throw new Error(`--primary must be a parseable color; got: ${tokens['primary']}`);
  const anchorOK = hexToOklch(anchor);

  // Target lightness per step. 50/100 differ by mode (surface tints);
  // 400/500/600/700 flow uniformly from the anchor.
  const targetL = {
    50:  mode === 'dark' ? 0.18 : 0.97,
    100: mode === 'dark' ? 0.24 : 0.93,
    400: Math.min(0.85, anchorOK.L + 0.08),
    500: anchorOK.L,
    600: Math.max(0.10, anchorOK.L - 0.08),
    700: Math.max(0.06, anchorOK.L - 0.20),
  };

  const swatchKey = {
    50:  'primary-bg',
    100: 'primary-soft',
    400: 'primary-light',
    600: 'primary-hover',
    700: 'primary-deep',
  };

  const out = {};
  for (const step of [50, 100, 400, 500, 600, 700]) {
    if (step === 500) { out[step] = anchor; continue; }
    const swatchRaw = tokens[swatchKey[step]];
    const swatchIsSolid = swatchRaw && isSolidHex(swatchRaw);
    if (swatchIsSolid) {
      out[step] = asSolidHex(swatchRaw);
      continue;
    }
    // No solid-hex anchor in the swatchboard → derive via OKLCH.
    // For 50/100 (surface tints), reduce chroma so the result reads as a
    // "tinted surface" rather than a "saturated brand step at low lightness".
    // This is what prevents Forge's rgba(orange, 0.08) input from rendering
    // as a deep saturated brown.
    const isSurfaceTint = step === 50 || step === 100;
    const C = isSurfaceTint ? Math.min(0.04, anchorOK.C * 0.18) : anchorOK.C;
    out[step] = oklchToHex({ L: clamp01(targetL[step]), C, h: anchorOK.h });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Neutral scale
// ----------------------------------------------------------------------------
function deriveNeutralScale(tokens, mode) {
  // Snap to swatchboard anchors when they're solid hex; interpolate gaps in
  // OKLCH. This preserves Tailwind-like scales (e.g. slate for Blue) instead
  // of producing a slightly-off generated palette.
  const aliasMap = mode === 'dark'
    ? { 'page-bg': 900, 'inset-bg': 800, 'border-light': 800, 'border-mid': 700, 'card-border': 700, 'text-faint': 600, 'text-muted': 500, 'text-body': 200, 'text-primary': 50 }
    : { 'page-bg': 50,  'inset-bg': 50,  'border-light': 100, 'border-mid': 200, 'card-border': 200, 'text-faint': 400, 'text-muted': 500, 'text-body': 700, 'text-primary': 900 };

  const anchors = {};
  for (const [alias, step] of Object.entries(aliasMap)) {
    const v = asSolidHex(tokens[alias]);
    if (v && anchors[step] === undefined) anchors[step] = v;
  }

  if (Object.keys(anchors).length === 0) {
    return mode === 'dark'
      ? { 50:'#fafafa', 100:'#f5f5f5', 200:'#e5e5e5', 300:'#d4d4d4', 400:'#a3a3a3', 500:'#737373', 600:'#525252', 700:'#404040', 800:'#262626', 900:'#171717' }
      : { 50:'#f8fafc', 100:'#f1f5f9', 200:'#e2e8f0', 300:'#cbd5e1', 400:'#94a3b8', 500:'#64748b', 600:'#475569', 700:'#334155', 800:'#1e293b', 900:'#0f172a' };
  }

  const anchorSteps = Object.keys(anchors).map(Number).sort((a, b) => a - b);
  const allSteps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
  const out = {};
  for (const step of allSteps) {
    if (anchors[step]) { out[step] = anchors[step]; continue; }
    let lo = null, hi = null;
    for (const a of anchorSteps) {
      if (a < step) lo = a;
      if (a > step && hi === null) hi = a;
    }
    if (lo !== null && hi !== null) {
      const t = (step - lo) / (hi - lo);
      const okLo = hexToOklch(anchors[lo]);
      const okHi = hexToOklch(anchors[hi]);
      out[step] = oklchToHex({
        L: okLo.L + (okHi.L - okLo.L) * t,
        C: okLo.C + (okHi.C - okLo.C) * t,
        h: okLo.h,
      });
    } else if (lo !== null) {
      const okLo = hexToOklch(anchors[lo]);
      out[step] = oklchToHex({ L: Math.max(0.05, okLo.L - 0.08 * (step - lo) / 100), C: okLo.C, h: okLo.h });
    } else {
      const okHi = hexToOklch(anchors[hi]);
      out[step] = oklchToHex({ L: Math.min(0.99, okHi.L + 0.04 * (hi - step) / 100), C: okHi.C, h: okHi.h });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Semantic / accent scale (shared logic)
// ----------------------------------------------------------------------------
function deriveColoredScale(bgVal, textVal, borderVal, mode) {
  // text is the saturated readable anchor → step 500.
  // bg/border map to 50 and 200 when solid hex; otherwise we derive every
  // step at low chroma to keep tint-surfaces from rendering as saturated.
  const textHex = asSolidHex(textVal);
  if (!textHex) return null;
  const anchor = hexToOklch(textHex);

  const targets = mode === 'dark'
    ? { 50: 0.20, 100: 0.26, 200: 0.34, 400: Math.min(0.86, anchor.L + 0.10), 500: anchor.L, 600: Math.max(0.15, anchor.L - 0.10), 700: Math.max(0.10, anchor.L - 0.22) }
    : { 50: 0.96, 100: 0.92, 200: 0.86, 400: Math.min(0.85, anchor.L + 0.10), 500: anchor.L, 600: Math.max(0.15, anchor.L - 0.08), 700: Math.max(0.10, anchor.L - 0.18) };

  // For tint steps when source is rgba (dark themes typically), reduce chroma.
  const tintC = Math.min(0.045, anchor.C * 0.22);

  const out = {};
  for (const step of [50, 100, 200, 400, 500, 600, 700]) {
    if (step === 500) { out[step] = textHex; continue; }

    // Honor swatchboard solid-hex anchors for 50 (bg) and 200 (border).
    if (step === 50) {
      if (isSolidHex(bgVal)) { out[step] = asSolidHex(bgVal); continue; }
    }
    if (step === 200) {
      if (isSolidHex(borderVal)) { out[step] = asSolidHex(borderVal); continue; }
    }

    const isTint = step === 50 || step === 100 || step === 200;
    const C = isTint ? tintC : anchor.C;
    out[step] = oklchToHex({ L: clamp01(targets[step]), C, h: anchor.h });
  }
  return out;
}

// ----------------------------------------------------------------------------
// text-on-primary
// ----------------------------------------------------------------------------
function pickTextOnPrimary(brandPrimary500Hex) {
  // WCAG Y threshold biased toward white. > 0.38 → primary is bright enough
  // that dark text wins (gold, yellow, pale pink); ≤ 0.38 → white text.
  // Validated against the four anchor brands:
  //   Blue Y=0.26, Forge Y=0.32, Pink Y=0.25 → all white
  //   Midnight gold Y=0.41 → dark (white-on-gold fails WCAG)
  const Y = relativeLuminance(hexToRgb(brandPrimary500Hex));
  return Y > 0.38 ? '#0f172a' : '#ffffff';
}

// ----------------------------------------------------------------------------
// Output rendering helpers
// ----------------------------------------------------------------------------
const PAD_TARGET = 35;

function renderSimple(name, value) {
  const left = `  --${name}:`;
  const fill = Math.max(1, PAD_TARGET - left.length);
  return `  --${name}:${' '.repeat(fill)}${value};`;
}

function renderScale(prefix, scale) {
  return Object.keys(scale).map((step) => renderSimple(`${prefix}-${step}`, scale[step])).join('\n');
}

function renderRgb(name, hex) {
  return renderSimple(name, rgbTriplet(hex));
}

function makePrologue({ name, slug, mode, anchorHex, sourceFile }) {
  return `/* ============================================================
   THEME: ${name}
   ------------------------------------------------------------
   Auto-generated by swatchboard-to-theme.mjs.
   Source:  ${path.basename(sourceFile)}
   Slug:    ${slug}
   Mode:    ${mode}
   Anchor:  ${anchorHex}

   Overrides canonical tokens from app/src/theme.css, then adds
   a RECIPES section for theme-specific compositions. To apply,
   change the @import in app/src/index.css:

     @import './theme.css';
     @import './theme-${slug}.css';

   See app/src/STYLING.md for vocabulary rules. Do not hand-edit
   this file — re-run the generator instead.
   ============================================================ */
`;
}

function makeBrandConfigSnippet({ name, anchorHex, slug }) {
  const { r, g, b } = hexToRgb(anchorHex);
  const hx = (n) => `0x${n.toString(16).padStart(2, '0').toUpperCase()}`;
  return `// Paste into app/src/brand.config.js:
export const BRAND = {
  name: '${name}',
  shortName: '${name}',
  description: '${name} CRM',
  titleSuffix: '${name} CRM',
  logoFile: '${slug}-logo.png',
  primaryHex: '${anchorHex.toUpperCase()}',
  primaryRgb: { r: ${hx(r)}, g: ${hx(g)}, b: ${hx(b)}, alpha: 1 },
};`;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length === 0 || args.help) {
    console.log(`Usage:
  node app/scripts/swatchboard-to-theme.mjs <swatchboard.html> --slug <slug> [--name "Display Name"] [--mode auto|light|dark]
`);
    process.exit(args._.length === 0 ? 1 : 0);
  }

  const sourceFile = path.resolve(args._[0]);
  if (!args.slug) {
    console.error('ERROR: --slug is required (e.g. --slug polishpoint-forge).');
    process.exit(1);
  }
  const slug = args.slug;
  const name = args.name || slug.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' ');
  const modeOverride = args.mode && args.mode !== 'auto' ? args.mode : null;

  const tokens = await parseSwatchboard(sourceFile);
  const mode = detectMode(tokens, modeOverride);
  console.log(`mode: ${mode}`);

  // Brand scale ---------------------------------------------------------------
  const brand = deriveBrandScale(tokens, mode);
  const brandRgbStep = {
    400: rgbTriplet(brand[400]),
    500: rgbTriplet(brand[500]),
    600: rgbTriplet(brand[600]),
  };

  // Neutral scale -------------------------------------------------------------
  const neutral = deriveNeutralScale(tokens, mode);
  const neutralShadowRgbHex = neutral[900];

  // Surface -------------------------------------------------------------------
  const surface = {
    base:    asSolidHex(tokens['page-bg'])    || (mode === 'dark' ? '#0f172a' : '#f8fafc'),
    raised:  asSolidHex(tokens['card-bg'])    || (mode === 'dark' ? '#1e293b' : '#ffffff'),
    sunken:  asSolidHex(tokens['inset-bg'])   || (mode === 'dark' ? '#0f172a' : '#f8fafc'),
    overlay: asSolidHex(tokens['card-bg'])    || (mode === 'dark' ? '#1e293b' : '#ffffff'),
  };

  // Text ----------------------------------------------------------------------
  const text = {
    primary:    asSolidHex(tokens['text-primary']) || neutral[mode === 'dark' ? 50 : 900],
    body:       asSolidHex(tokens['text-body'])    || neutral[mode === 'dark' ? 200 : 700],
    muted:      asSolidHex(tokens['text-muted'])   || neutral[mode === 'dark' ? 400 : 500],
    faint:      asSolidHex(tokens['text-faint'])   || neutral[mode === 'dark' ? 600 : 400],
    onPrimary:  pickTextOnPrimary(brand[500]),
  };

  // Border --------------------------------------------------------------------
  const border = {
    subtle:  asSolidHex(tokens['border-light']) || neutral[mode === 'dark' ? 800 : 100],
    default: asSolidHex(tokens['border-mid'])   || asSolidHex(tokens['card-border']) || neutral[mode === 'dark' ? 700 : 200],
    strong:  neutral[mode === 'dark' ? 600 : 300],
  };

  // Semantic scales -----------------------------------------------------------
  const success = deriveColoredScale(tokens['green-bg'], tokens['green-text'], tokens['green-border'], mode)
               || { 50:'#ecfdf5', 100:'#d1fae5', 200:'#a7f3d0', 400:'#10b981', 500:'#059669', 600:'#047857', 700:'#065f46' };
  const warning = deriveColoredScale(tokens['amber-bg'], tokens['amber-text'], tokens['amber-border'], mode)
               || { 50:'#fffbeb', 100:'#fef3c7', 200:'#fde68a', 400:'#f59e0b', 500:'#d97706', 600:'#b45309', 700:'#92400e' };
  const error   = deriveColoredScale(tokens['red-bg'],   tokens['red-text'],   tokens['red-border'],   mode)
               || { 50:'#fef2f2', 100:'#fee2e2', 200:'#fecaca', 400:'#ef4444', 500:'#dc2626', 600:'#b91c1c', 700:'#991b1b' };

  // Accent (purple from swatchboard if present; orange + teal use shell defaults) ----
  const purpleAnchor = asSolidHex(tokens['purple-text']);
  const purple = purpleAnchor
    ? deriveColoredScale(tokens['purple-bg'], tokens['purple-text'], tokens['purple-border'], mode)
    : { 50:'#faf5ff', 100:'#f3e8ff', 200:'#e9d5ff', 400:'#a78bfa', 500:'#7c3aed', 600:'#6d28d9', 700:'#5b21b6' };

  const orange = { 50:'#ffedd5', 200:'#fed7aa', 400:'#fb923c', 500:'#ea580c', 600:'#c2410c' };
  const teal   = { 50:'#ccfbf1', 200:'#99f6e4', 400:'#2dd4bf', 500:'#14b8a6', 600:'#0d9488' };

  // Sidebar flat aliases ------------------------------------------------------
  const sidebar = {
    bg:     asSolidHex(tokens['sidebar-bg'])     || neutral[900],
    mid:    asSolidHex(tokens['sidebar-mid'])    || neutral[800],
    deep:   asSolidHex(tokens['sidebar-deep'])   || '#020617',
    hover:  asSolidHex(tokens['sidebar-hover'])  || neutral[800],
    active: asSolidHex(tokens['sidebar-active']) || brand[500],
  };

  // Radius --------------------------------------------------------------------
  const radius = {
    md: tokens['btn-radius']  || tokens['input-radius'] || '8px',
    lg: tokens['card-radius'] || '12px',
  };

  // Font ----------------------------------------------------------------------
  const fontFamily = tokens['font'];

  // Recipes -------------------------------------------------------------------
  const recipeFile = mode === 'dark' ? 'recipes-dark.css' : 'recipes-light.css';
  const recipes = await fs.readFile(path.join(TEMPLATES, recipeFile), 'utf8');

  // Assemble output -----------------------------------------------------------
  const prologue = makePrologue({ name, slug, mode, anchorHex: brand[500], sourceFile });

  const tokenBlock = [
    '  /* ── Base primitives ── */',
    '  --color-white-rgb:      255, 255, 255;',
    '  --color-black-rgb:      0, 0, 0;',
    '',
    '  /* ── Color — neutral ── */',
    renderScale('color-neutral', neutral),
    renderRgb('color-neutral-rgb', neutralShadowRgbHex),
    '',
    '  /* ── Color — brand primary ── */',
    renderScale('color-brand-primary', brand),
    renderRgb('color-brand-primary-rgb', brand[500]),
    renderRgb('color-brand-primary-400-rgb', brand[400]),
    renderRgb('color-brand-primary-600-rgb', brand[600]),
    '',
    '  /* ── Color — surface ── */',
    renderSimple('color-surface-base',    surface.base),
    renderSimple('color-surface-raised',  surface.raised),
    renderSimple('color-surface-sunken',  surface.sunken),
    renderSimple('color-surface-overlay', surface.overlay),
    '',
    '  /* ── Color — text ── */',
    renderSimple('color-text-primary',    text.primary),
    renderSimple('color-text-body',       text.body),
    renderSimple('color-text-muted',      text.muted),
    renderSimple('color-text-faint',      text.faint),
    renderSimple('color-text-on-primary', text.onPrimary),
    '',
    '  /* ── Color — border ── */',
    renderSimple('color-border-subtle',  border.subtle),
    renderSimple('color-border-default', border.default),
    renderSimple('color-border-strong',  border.strong),
    '',
    '  /* ── Color — semantic: success ── */',
    renderScale('color-semantic-success', success),
    renderRgb('color-semantic-success-rgb', success[500]),
    '',
    '  /* ── Color — semantic: warning ── */',
    renderScale('color-semantic-warning', warning),
    renderRgb('color-semantic-warning-rgb', warning[500]),
    '',
    '  /* ── Color — semantic: error ── */',
    renderScale('color-semantic-error', error),
    renderRgb('color-semantic-error-rgb', error[500]),
    '',
    '  /* ── Color — accent ── */',
    renderScale('color-accent-purple', purple),
    renderRgb('color-accent-purple-rgb', purple[500]),
    renderScale('color-accent-orange', orange),
    renderScale('color-accent-teal',   teal),
    '',
    '  /* ── Color — brand secondary (aliased to accent-teal so the un-fallback',
    '     reference to --color-brand-secondary-600 in index.css resolves) ── */',
    renderSimple('color-brand-secondary-50',  `var(--color-accent-teal-50)`),
    renderSimple('color-brand-secondary-100', `var(--color-accent-teal-200)`),
    renderSimple('color-brand-secondary-400', `var(--color-accent-teal-400)`),
    renderSimple('color-brand-secondary-500', `var(--color-accent-teal-500)`),
    renderSimple('color-brand-secondary-600', `var(--color-accent-teal-600)`),
    renderSimple('color-brand-secondary-700', `var(--color-accent-teal-600)`),
    renderRgb('color-brand-secondary-rgb', teal[500]),
    '',
    '  /* ── Radius (theme override) ── */',
    renderSimple('radius-md', radius.md),
    renderSimple('radius-lg', radius.lg),
    '',
    '  /* ── Sidebar flat aliases (swatchboard compatibility) ── */',
    renderSimple('sidebar-bg',     sidebar.bg),
    renderSimple('sidebar-mid',    sidebar.mid),
    renderSimple('sidebar-deep',   sidebar.deep),
    renderSimple('sidebar-hover',  sidebar.hover),
    renderSimple('sidebar-active', sidebar.active),
    '',
    '  /* ── Avatar accents ── */',
    renderSimple('color-avatar-1', `var(--color-brand-primary-500)`),
    renderSimple('color-avatar-2', `var(--color-semantic-success-500)`),
    renderSimple('color-avatar-3', `var(--color-accent-purple-500)`),
    renderSimple('color-avatar-4', `var(--color-accent-orange-500)`),
    renderSimple('color-avatar-5', `var(--color-accent-teal-600)`),
    renderSimple('avatar-1', `var(--color-avatar-1)`),
    renderSimple('avatar-2', `var(--color-avatar-2)`),
    renderSimple('avatar-3', `var(--color-avatar-3)`),
    renderSimple('avatar-4', `var(--color-avatar-4)`),
    renderSimple('avatar-5', `var(--color-avatar-5)`),
  ].join('\n');

  const fontBlock = fontFamily
    ? `\n  /* ── Typography (theme override) ── */\n${renderSimple('font-family-sans', fontFamily)}\n`
    : '';

  const output = `${prologue}
:root {
${tokenBlock}
${fontBlock}
${recipes}
}
`;

  const outPath = path.join(APP_SRC, `theme-${slug}.css`);
  await fs.writeFile(outPath, output, 'utf8');

  console.log(`\nwrote: ${outPath}`);
  console.log(`\nnext steps (run manually):`);
  console.log(`  1. ${makeBrandConfigSnippet({ name, anchorHex: brand[500], slug })}`);
  console.log(`  2. In app/src/index.css, change the theme @import to:`);
  console.log(`       @import './theme-${slug}.css';`);
  console.log(`  3. Drop logo into app/public/${slug}-logo.png`);
  console.log(`  4. node app/scripts/gen-pwa-icons.mjs`);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
