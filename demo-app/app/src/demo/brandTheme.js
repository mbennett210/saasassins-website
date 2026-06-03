// Demo-only brand styling.
//
// The checkout shows a persistent, themed dashboard preview (desktop + mobile
// device frames) so the client sees what their platform looks like in each brand,
// powered by the ported ThemeEngine + MiniApp (see ./preview/). This file just
// holds the toggle metadata (label + swatch gradient) and persists the choice as
// `deployTheme`; resetDemo clears it. The demo itself stays clean PolishPoint.
//
// NOTE: the PALETTES keys (blue/forge/midnight/pink) are STABLE internal ids —
// they back the saved `deployTheme`, the MiniApp scope classes (.ppd-<key> /
// .ppm-<key>), and the swatchboard filenames. The `label` is just the display
// name and can change freely without touching any of that (e.g. blue → "Cobalt").

export const PALETTES = {
  blue:     { label: 'Cobalt',   swatch: '#1E8FE8', grad: 'linear-gradient(135deg,#47A5ED,#1878C8)' },
  forge:    { label: 'Forge',    swatch: '#F97316', grad: 'linear-gradient(135deg,#FB923C,#EA580C)' },
  midnight: { label: 'Midnight', swatch: '#C9A84C', grad: 'linear-gradient(135deg,#D4B96A,#B8962E)' },
  pink:     { label: 'Orchid',   swatch: '#EC4899', grad: 'linear-gradient(135deg,#f472b6,#be185d)' },
};

export const PALETTE_KEYS = ['blue', 'forge', 'midnight', 'pink'];

// Display label for the brand toggle + order summary. Cobalt is the pre-selected
// default (see CheckoutPage's initial deployTheme).
export const themeLabel = (key) => (PALETTES[key] || PALETTES.blue).label;

const KEY = 'pp.demo.brand.v1';

export function loadBrand() {
  try { return JSON.parse(window.localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

export function saveBrand(patch) {
  try {
    const next = { ...loadBrand(), ...patch };
    window.localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch { return loadBrand(); }
}
