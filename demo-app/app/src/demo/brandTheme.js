// Demo-only brand personalization ("Try it with your brand"). Lets a prospect
// see the demo in their own company name + a brand palette. The palette choice is
// persisted (survives reloads and carries into the live CRM); the company name is
// persisted via the store. resetDemo() clears both.
//
// Palettes reuse the shell's pre-generated theme files — the exact ones a real
// per-client deployment picks from — injected at runtime as a <style> override,
// so there's no rebuild or color math. Blue is the baseline already imported in
// index.css, so selecting it simply removes the override.

import forgeCss from '../theme-polishpoint-forge.css?inline';
import midnightCss from '../theme-polishpoint-midnight.css?inline';
import pinkCss from '../theme-polishpoint-pink.css?inline';

export const PALETTES = {
  blue:     { label: 'Ocean',    swatch: '#1E8FE8', css: null }, // baseline (index.css) — no override
  forge:    { label: 'Forge',    swatch: '#F97316', css: forgeCss },
  midnight: { label: 'Midnight', swatch: '#C9A84C', css: midnightCss },
  pink:     { label: 'Rose',     swatch: '#EC4899', css: pinkCss },
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

export const BRAND_STORAGE_KEY = KEY;

// First letters of the first two words → initials for the sidebar logo badge.
export function initialsFrom(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'CO';
  return parts.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
