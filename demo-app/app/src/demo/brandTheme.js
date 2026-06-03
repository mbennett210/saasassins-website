// Demo-only brand styling.
//
// The swatchboard themes can't faithfully reskin the live React app without a
// heavy lift — each swatchboard is a full design language (neumorphic depth,
// gradient/glow buttons, ambient backgrounds, bespoke radii/fonts), not just a
// palette the app's tokens can absorb. So we DON'T live-reskin the demo. Instead
// the checkout shows faithful example IMAGES of each swatchboard and the client
// confirms which brand style their deployment ships in; the demo stays in the
// clean PolishPoint look.
//
// Images live in public/theme-previews/ (rendered from the canonical swatchboards
// in Client-theme-picker/shared/swatchboards). The choice persists as
// `deployTheme`; resetDemo clears it.

const ASSET = (name) => `${import.meta.env.BASE_URL}theme-previews/${name}`;

export const PALETTES = {
  blue:     { label: 'Blue',     swatch: '#1E8FE8', image: ASSET('blue.jpg') },
  forge:    { label: 'Forge',    swatch: '#F97316', image: ASSET('forge.jpg') },
  midnight: { label: 'Midnight', swatch: '#C9A84C', image: ASSET('midnight.jpg') },
  pink:     { label: 'Pink',     swatch: '#EC4899', image: ASSET('pink.jpg') },
};

export const PALETTE_KEYS = ['blue', 'forge', 'midnight', 'pink'];

// Display label (Blue surfaces as the PolishPoint default).
export const themeLabel = (key) => (key === 'blue' ? 'PolishPoint (Blue)' : (PALETTES[key] || PALETTES.blue).label);

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
