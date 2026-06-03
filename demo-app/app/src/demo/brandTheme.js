// Demo-only brand theming. Two consumers:
//   • DemoControls (in the live CRM) — a live switcher that injects a palette
//     globally so the prospect can preview the product in different brand colors.
//   • CheckoutThemeSelect — a non-applying picker that shows small example tiles
//     so the client confirms which brand style their deployment ships in.
//
// Palettes inject one of the shell's prebuilt theme files at runtime as a <style>
// override (no rebuild / color math). "Blue" is the baseline already imported in
// index.css (the PolishPoint default), so selecting it removes the override. The
// theme CSS is generated from Client-theme-picker/shared/swatchboards via
// scripts/swatchboard-to-theme.mjs. `preview` colors drive the checkout tiles.

import forgeCss from '../theme-polishpoint-forge.css?inline';
import midnightCss from '../theme-polishpoint-midnight.css?inline';
import pinkCss from '../theme-polishpoint-pink.css?inline';

export const PALETTES = {
  blue: {
    label: 'Blue', swatch: '#1E8FE8', css: null, // PolishPoint default (index.css baseline)
    preview: { bg: '#F1F5F9', surface: '#FFFFFF', primary: '#1E8FE8', text: '#0F172A' },
  },
  forge: {
    label: 'Forge', swatch: '#F97316', css: forgeCss,
    preview: { bg: '#0A0C10', surface: '#161B22', primary: '#F97316', text: '#F5F5F3' },
  },
  midnight: {
    label: 'Midnight', swatch: '#C9A84C', css: midnightCss,
    preview: { bg: '#0B0E14', surface: '#161B22', primary: '#C9A84C', text: '#F5F5F3' },
  },
  pink: {
    label: 'Pink', swatch: '#EC4899', css: pinkCss,
    preview: { bg: '#FDF2F8', surface: '#FFFFFF', primary: '#EC4899', text: '#1F2937' },
  },
};

export const PALETTE_KEYS = ['blue', 'forge', 'midnight', 'pink'];

// Display label for a palette (Blue surfaces as the PolishPoint default).
export const themeLabel = (key) => (key === 'blue' ? 'PolishPoint (Blue)' : (PALETTES[key] || PALETTES.blue).label);

const STYLE_ID = 'pp-demo-theme';
const KEY = 'pp.demo.brand.v1';

// Inject (or clear) the chosen palette as a <style> override appended after the
// bundled theme, so its :root tokens win the cascade.
export function applyPalette(key) {
  if (typeof document === 'undefined') return;
  const p = PALETTES[key] || PALETTES.blue;
  const existing = document.getElementById(STYLE_ID);
  if (!p.css) {
    if (existing) existing.remove(); // blue baseline — drop any override
    return;
  }
  const el = existing || document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = p.css;
  if (!existing) document.head.appendChild(el);
}

// Remove the live override (used to force the checkout into the clean baseline).
export function clearPaletteOverride() {
  if (typeof document === 'undefined') return;
  document.getElementById(STYLE_ID)?.remove();
}

export function loadBrand() {
  try {
    return JSON.parse(window.localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export function saveBrand(patch) {
  try {
    const next = { ...loadBrand(), ...patch };
    window.localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadBrand();
  }
}
