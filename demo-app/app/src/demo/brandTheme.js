// Demo-only brand theme picker. Lets a prospect preview the product in one of the
// brand palettes SaaSassins ships — the exact swatchboard-derived themes a real
// per-client deployment picks from. The choice is persisted (survives reloads and
// carries across the demo + live CRM); resetDemo() clears it.
//
// Palettes inject one of the shell's prebuilt theme files at runtime as a <style>
// override, so there's no rebuild or color math. "Blue" is the baseline already
// imported in index.css (the PolishPoint default), so selecting it removes the
// override. The theme CSS is generated from the swatchboards in
// Client-theme-picker/shared/swatchboards via scripts/swatchboard-to-theme.mjs.

import forgeCss from '../theme-polishpoint-forge.css?inline';
import midnightCss from '../theme-polishpoint-midnight.css?inline';
import pinkCss from '../theme-polishpoint-pink.css?inline';

export const PALETTES = {
  blue:     { label: 'Blue',     swatch: '#1E8FE8', css: null }, // PolishPoint default (index.css baseline)
  forge:    { label: 'Forge',    swatch: '#F97316', css: forgeCss },
  midnight: { label: 'Midnight', swatch: '#C9A84C', css: midnightCss },
  pink:     { label: 'Pink',     swatch: '#EC4899', css: pinkCss },
};

export const PALETTE_KEYS = ['blue', 'forge', 'midnight', 'pink'];

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
