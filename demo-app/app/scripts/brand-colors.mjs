// brand-colors — a brand's palette, derived from the four base colours in its brand file
// (brands/<id>/brand.json `colors`), and the contrast law every palette must pass (UI_RULES §121, §129).
//
// The brand file gives four colours:
//   primary    the brand ink: headings, primary buttons, the header bands, nav-active (it takes white text)
//   secondary  the accent: the CTA, hover, the active marker (it takes the primary's ink)
//   link       links and tappable names
//   neutral    the grey family's 500: greys, the page ground, the wells, the hairlines
// Each ramp step and surface is derived by mixing its base with white or black (fixed ratios, fitted to the
// shell's hand-tuned scales), and any of them can be pinned: `colors.pins["primary-600"] = "#0F0F12"` writes
// that value instead. A pin keeps its spelling, so a brand that pins every step (Clean Space) regenerates its
// theme byte for byte. Status colours (success, warning, error) and the accents are constant across brands
// (THEME_CLEANSPACE R3) and stay in the client theme's hand-written part.
//
// The palette is written into the client theme's BRAND PALETTE block by `npm --prefix app run brand`, which
// refuses a palette that fails a contrast check.

export const HEX = /^#[0-9a-f]{6}$/i;
const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
export const channels = (h) => parse(h).join(', ');

// WCAG relative luminance and contrast ratio
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
export const contrast = (a, b) => {
  const [x, y] = [luminance(Array.isArray(a) ? a : parse(a)), luminance(Array.isArray(b) ? b : parse(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
// a colour at an opacity over a ground, as the eye sees it
const over = (fg, alpha, ground) => mixRgb(parse(ground), parse(fg), alpha);

// Each palette key: its base, and how it is mixed from it ([toward, ratio]; ratio 0 = the base itself).
// The ratios are fitted to the shell's scales (slate for the neutral; the Clean Space ramps for the brand).
export const DERIVE = {
  'neutral-50': ['neutral', WHITE, 0.964], 'neutral-100': ['neutral', WHITE, 0.929], 'neutral-200': ['neutral', WHITE, 0.84],
  'neutral-300': ['neutral', WHITE, 0.70], 'neutral-400': ['neutral', WHITE, 0.345], 'neutral-500': ['neutral', WHITE, 0],
  'neutral-600': ['neutral', BLACK, 0.267], 'neutral-700': ['neutral', BLACK, 0.44], 'neutral-800': ['neutral', BLACK, 0.64],
  'neutral-900': ['neutral', BLACK, 0.78],
  'primary-50': ['primary', WHITE, 0.95], 'primary-100': ['primary', WHITE, 0.88], 'primary-400': ['primary', WHITE, 0.25],
  'primary-500': ['primary', WHITE, 0], 'primary-600': ['primary', BLACK, 0.35], 'primary-700': ['primary', BLACK, 0.6],
  'secondary-50': ['secondary', WHITE, 0.88], 'secondary-100': ['secondary', WHITE, 0.65], 'secondary-400': ['secondary', WHITE, 0.2],
  'secondary-500': ['secondary', WHITE, 0], 'secondary-600': ['secondary', BLACK, 0.12], 'secondary-700': ['secondary', BLACK, 0.3],
  // the surface ladder and the lines, from the neutral (THEME_CLEANSPACE R1, R6): page, well, hairline, field
  'surface-page': ['neutral', WHITE, 0.93], 'surface-sunken': ['neutral', WHITE, 0.855], border: ['neutral', WHITE, 0.827],
  field: ['neutral', WHITE, 0.9], zebra: ['neutral', WHITE, 0.94], bubble: ['neutral', WHITE, 0.9],
  link: ['link', WHITE, 0],
  // the schedule's upcoming card (R7): the accent's lightest tint, and a hairline of it dulled toward the neutral
  'upcoming-bg': ['secondary', WHITE, 0.88],
};

// palette key → the client theme's custom property (a channel triplet `-rgb` token follows its colour)
export const TOKENS = [
  ...[50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((s) => [`neutral-${s}`, `color-neutral-${s}`]),
  ['neutral-rgb', 'color-neutral-rgb', 'neutral-900'],
  ...[50, 100, 400, 500, 600, 700].map((s) => [`primary-${s}`, `color-brand-primary-${s}`]),
  ['primary-rgb', 'color-brand-primary-rgb', 'primary-500'],
  ['primary-400-rgb', 'color-brand-primary-400-rgb', 'primary-400'],
  ['primary-600-rgb', 'color-brand-primary-600-rgb', 'primary-600'],
  ...[50, 100, 400, 500, 600, 700].map((s) => [`secondary-${s}`, `color-brand-secondary-${s}`]),
  ['secondary-rgb', 'color-brand-secondary-rgb', 'secondary-500'],
  ['surface-page', 'color-surface-offwhite'],
  ['surface-sunken', 'color-surface-sunken'],
  ['border', 'card-border'],
  ['field', 'field-bg'],
  ['zebra', 'table-row-odd'],
  ['bubble', 'bubble-incoming-bg'],
  ['link', 'color-link'],
  ['upcoming-bg', 'sched-card-upcoming-bg'],
  ['upcoming-border', 'sched-card-upcoming-bd'],
];
export const PIN_KEYS = new Set([...Object.keys(DERIVE), 'upcoming-border']);

/** The palette for a brand's `colors`: { values: key → hex (pins win), derived: key → hex, pinned: [key] }. */
export function derivePalette(colors) {
  const base = { primary: parse(colors.primary), secondary: parse(colors.secondary), link: parse(colors.link), neutral: parse(colors.neutral) };
  const derived = {};
  for (const [key, [from, toward, t]] of Object.entries(DERIVE)) derived[key] = toHex(mixRgb(base[from], toward, t));
  // a hairline of the accent's light tint, dulled a little toward the neutral
  derived['upcoming-border'] = toHex(mixRgb(mixRgb(base.secondary, WHITE, 0.7), base.neutral, 0.08));
  const pins = colors.pins || {};
  const values = {};
  for (const key of PIN_KEYS) values[key] = pins[key] || derived[key];
  return { values, derived, pinned: Object.keys(pins).filter((k) => PIN_KEYS.has(k)) };
}

// The contrast law a palette must pass: [name, foreground, background, floor, the rule it holds]. The
// surface floors are the smallest steps the tuned Clean Space ladder takes, less a margin: a derived
// ladder flatter than that would blend (R6).
export function contrastChecks(values, { onPrimary = '#ffffff' } = {}) {
  const v = values;
  const ring = (ground) => toHex(over(v['primary-500'], 0.6, ground)); // --focus-ring-color over a surface (§119)
  const rows = [
    ['text on the brand ink (bands, primary buttons)', onPrimary, v['primary-500'], 4.5, 'R2, R3'],
    ['text on the deepest ink (login, phone header)', onPrimary, v['primary-700'], 4.5, 'R3'],
    ['the ink on the accent (gold CTA text)', v['primary-500'], v['secondary-500'], 4.5, 'R3'],
    // a gold CTA under the pointer darkens one step and keeps its ink (.btn-gold, .btn-success); the lighter
    // steps the accent also fills (400, 50) only raise the ink's contrast
    ["the ink on the accent's hover (gold CTA under the pointer)", v['primary-500'], v['secondary-600'], 4.5, 'R3'],
    ['the ink on white (headings)', v['primary-500'], '#ffffff', 4.5, 'R3'],
    ['links on white', v.link, '#ffffff', 4.5, 'R3, R5'],
    ['links on the page', v.link, v['surface-page'], 4.5, 'R3, R5'],
    ['neutral 500 on white (the lightest text grey)', v['neutral-500'], '#ffffff', 4.5, 'R5'],
    ['neutral 600 on the page (faint text)', v['neutral-600'], v['surface-page'], 4.5, 'R5'],
    ['body text (neutral 800) on white', v['neutral-800'], '#ffffff', 7, 'R5'],
    ['body text on a well', v['neutral-800'], v['surface-sunken'], 4.5, 'R5, R6'],
    ['body text on the upcoming card', v['neutral-800'], v['upcoming-bg'], 4.5, 'R7'],
    ['the focus ring on white', ring('#ffffff'), '#ffffff', 3, '§119'],
    ['the focus ring on a field', ring(v.field), v.field, 3, '§119'],
    ['the focus ring on the page', ring(v['surface-page']), v['surface-page'], 3, '§119'],
    ['the focus ring on a well', ring(v['surface-sunken']), v['surface-sunken'], 3, '§119'],
    ['the focus ring against the focused border', ring('#ffffff'), v['primary-500'], 3, '§119'],
    ['a hairline on white', v.border, '#ffffff', 1.2, 'R5'],
    ['a hairline on the page', v.border, v['surface-page'], 1.1, 'R5'],
    ['the page against a card (white)', v['surface-page'], '#ffffff', 1.06, 'R1, R6'],
    ['a well against the page', v['surface-sunken'], v['surface-page'], 1.06, 'R6'],
    ['the zebra row against white', v.zebra, '#ffffff', 1.04, 'R2'],
  ];
  return rows.map(([name, fg, bg, floor, rule]) => {
    const ratio = contrast(fg, bg);
    return { name, fg, bg, floor, rule, ratio: Math.round(ratio * 100) / 100, pass: ratio >= floor };
  });
}

// The client theme's BRAND PALETTE block: the markers and every palette declaration.
export const PALETTE_BLOCK = /([ \t]*)\/\* ── BRAND PALETTE: GENERATED by `npm --prefix app run brand`[\s\S]*?\/\* ── end BRAND PALETTE ── \*\//;
export function paletteBlock(brand, indent = '  ') {
  const { values, pinned } = derivePalette(brand.colors);
  const checks = contrastChecks(values);
  const group = (prefix) => {
    const keys = [...PIN_KEYS].filter((k) => k.startsWith(prefix));
    const p = keys.filter((k) => pinned.includes(k));
    return p.length === keys.length ? 'every step pinned' : p.length ? `pinned: ${p.map((k) => k.slice(prefix.length)).join(', ')}` : 'derived';
  };
  const decl = ([key, token, of]) => `${indent}--${token}: ${of ? channels(values[of]) : values[key]};`;
  const pick = (re) => TOKENS.filter(([k]) => re.test(k)).map(decl);
  const lines = [
    `${indent}/* ── BRAND PALETTE: GENERATED by \`npm --prefix app run brand\` from brands/${brand.id}/brand.json; do not edit ──`,
    `${indent}   Derived from colors.primary, secondary, link and neutral (scripts/brand-colors.mjs); a pinned step is`,
    `${indent}   the brand file's own value. ${checks.filter((c) => c.pass).length} of ${checks.length} contrast checks pass (THEME_CLEANSPACE R1-R7, UI_RULES §119). */`,
    `${indent}/* neutral: greys, the ground and the lines (${group('neutral-')}) */`,
    ...pick(/^neutral-/),
    `${indent}/* primary: the brand ink; 500 is the brand, 400 its hover tone, 600/700 pressed and deepest, 50/100 tints (${group('primary-')}) */`,
    ...pick(/^primary-/),
    `${indent}/* secondary: the accent, light enough to carry the ink (${group('secondary-')}) */`,
    ...pick(/^secondary-/),
    `${indent}/* the surface ladder, lines and fields, from the neutral (R1, R6), and the link */`,
    ...pick(/^(surface-|border$|field$|zebra$|bubble$|link$)/),
    `${indent}/* the schedule's upcoming card (R7) */`,
    ...pick(/^upcoming-/),
    `${indent}/* ── end BRAND PALETTE ── */`,
  ];
  return { text: lines.join('\n'), checks };
}
