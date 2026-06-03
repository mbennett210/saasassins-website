// Demo-only brand styling.
//
// We don't live-reskin the demo (the swatchboards are full design languages that
// can't be faithfully reproduced in the live app without a heavy lift). Instead,
// at checkout the client previews an ABBREVIATED, themed dashboard mock — rendered
// in desktop + phone device frames — so they can see what their platform looks
// like in each brand. The mock is a small, self-contained component we fully
// control, so we can theme it accurately from each swatchboard's real palette
// (below) without touching the live app.
//
// Token values are lifted verbatim from the canonical swatchboards in
// Client-theme-picker/shared/swatchboards. The chosen style persists as
// `deployTheme`; resetDemo clears it.

export const PALETTES = {
  blue: {
    label: 'Blue',
    swatch: '#1E8FE8',
    t: {
      font: "'Poppins', sans-serif", dark: false,
      page: '#f8fafc', card: '#ffffff', border: '#e2e8f0', borderLight: '#f1f5f9',
      text: '#0f172a', body: '#334155', muted: '#64748b',
      primary: '#1E8FE8', grad: 'linear-gradient(135deg, #47A5ED, #1878C8)',
      sidebar: '#0f172a', green: '#047857', shadow: '0 4px 12px rgba(15,23,42,0.08)',
    },
  },
  forge: {
    label: 'Forge',
    swatch: '#F97316',
    t: {
      font: "'Inter', sans-serif", dark: true,
      page: '#0A0C10', card: '#1C1F26', border: '#343843', borderLight: '#262A33',
      text: '#F5F5F3', body: '#CDD0D8', muted: '#8A8F9D',
      primary: '#F97316', grad: 'linear-gradient(135deg, #FB923C, #EA580C)',
      sidebar: '#1C1F26', green: '#34D399', shadow: '0 4px 12px rgba(0,0,0,0.45)',
    },
  },
  midnight: {
    label: 'Midnight',
    swatch: '#C9A84C',
    t: {
      font: "'Plus Jakarta Sans', sans-serif", dark: true,
      page: '#0C0C0C', card: '#1E1D1B', border: '#2E2C28', borderLight: '#242220',
      text: '#E8E6E1', body: '#B8B5AE', muted: '#7A7872',
      primary: '#C9A84C', grad: 'linear-gradient(135deg, #D4B96A, #B8962E)',
      sidebar: '#0A0A0A', green: '#34D399', shadow: '0 4px 12px rgba(0,0,0,0.4)',
    },
  },
  pink: {
    label: 'Pink',
    swatch: '#ec4899',
    t: {
      font: "'Poppins', sans-serif", dark: false,
      page: '#fdf2f8', card: '#ffffff', border: '#fce7f3', borderLight: '#fce7f3',
      text: '#831843', body: '#6b214f', muted: '#a0527a',
      primary: '#ec4899', grad: 'linear-gradient(135deg, #f472b6, #be185d)',
      sidebar: '#831843', green: '#047857', shadow: '0 4px 12px rgba(236,72,153,0.10)',
    },
  },
};

export const PALETTE_KEYS = ['blue', 'forge', 'midnight', 'pink'];

// Display label (Blue surfaces as the PolishPoint default).
export const themeLabel = (key) => (key === 'blue' ? 'PolishPoint (Blue)' : (PALETTES[key] || PALETTES.blue).label);

// Inline CSS custom properties that theme the mock dashboard for a given palette.
export const mockVars = (key) => {
  const t = (PALETTES[key] || PALETTES.blue).t;
  return {
    '--m-font': t.font,
    '--m-page': t.page,
    '--m-card': t.card,
    '--m-border': t.border,
    '--m-bl': t.borderLight,
    '--m-text': t.text,
    '--m-body': t.body,
    '--m-muted': t.muted,
    '--m-primary': t.primary,
    '--m-grad': t.grad,
    '--m-side': t.sidebar,
    '--m-green': t.green,
    '--m-shadow': t.shadow,
  };
};

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
