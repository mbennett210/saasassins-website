// themeEngine.js — ES-module port of Client-theme-picker/shared/theme_engine.js.
// Takes a base theme name (+ optional overrides) and emits the full faithful
// token set for that swatchboard's design language (gradients, neumorphic
// shadows, page aurora, hero, tables, bubbles, badges), then a scoped <style>
// block. Used by the checkout dashboard preview's MiniApp so each brand renders
// truthfully — kept verbatim from the canonical picker so it stays in sync.

// ---------- Color helpers ----------
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}
function hslToRgb(h, s, l) {
  h /= 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}
function adjustLightness(hex, deltaL) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [r2, g2, b2] = hslToRgb(h, s, Math.max(0, Math.min(1, l + deltaL)));
  return rgbToHex(r2, g2, b2);
}
function withAlpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mix(hex1, hex2, ratio) {
  const a = hexToRgb(hex1), b = hexToRgb(hex2);
  return rgbToHex(
    a[0] * (1 - ratio) + b[0] * ratio,
    a[1] * (1 - ratio) + b[1] * ratio,
    a[2] * (1 - ratio) + b[2] * ratio,
  );
}

// ---------- Base themes ----------
export const BASE = {
  blue: {
    kind: 'light', font: "'Poppins', sans-serif",
    surface: { page: '#f8fafc', card: '#ffffff', cardBorder: '#e2e8f0', inset: '#f1f5f9' },
    text: { primary: '#0f172a', body: '#334155', muted: '#64748b', faint: '#94a3b8' },
    radii: { card: 20, btn: 10, input: 10 }, sidebarStyle: 'gradient', heroCardSurface: 'tinted',
  },
  forge: {
    kind: 'dark', font: "'Inter', sans-serif",
    surface: { page: '#0A0C10', card: '#1C1F26', cardBorder: '#343843', inset: '#262A33' },
    text: { primary: '#F5F5F3', body: '#CDD0D8', muted: '#8A8F9D', faint: '#5A5F6C' },
    radii: { card: 20, btn: 8, input: 8 }, sidebarStyle: 'solid-dark', heroCardSurface: 'raised',
  },
  midnight: {
    kind: 'dark', font: "'Plus Jakarta Sans', sans-serif",
    surface: { page: '#0C0C0C', card: '#1E1D1B', cardBorder: '#2E2C28', inset: '#161514' },
    text: { primary: '#E8E6E1', body: '#B8B5AE', muted: '#7A7872', faint: '#4A4842' },
    radii: { card: 20, btn: 10, input: 10 }, sidebarStyle: 'solid-dark', heroCardSurface: 'raised',
  },
  pink: {
    kind: 'light', font: "'Poppins', sans-serif",
    surface: { page: '#fdf2f8', card: '#ffffff', cardBorder: '#fce7f3', inset: '#fef7ff' },
    text: { primary: '#831843', body: '#6b214f', muted: '#a0527a', faint: '#d4a0bb' },
    radii: { card: 20, btn: 9999, input: 14 }, sidebarStyle: 'gradient', heroCardSurface: 'tinted',
  },
};

export const DEFAULT_PRIMARY = { blue: '#1E8FE8', forge: '#F97316', midnight: '#C9A84C', pink: '#EC4899' };

// ---------- Computation ----------
export function computeTokens(baseName, overrides = {}) {
  const base = BASE[baseName] || BASE.blue;
  const kind = base.kind;
  const primary = overrides.primary || DEFAULT_PRIMARY[baseName];
  const font = overrides.font || base.font;
  const sidebarStyle = overrides.sidebarStyle || base.sidebarStyle;

  const primaryLight = adjustLightness(primary, kind === 'dark' ? 0.08 : 0.10);
  const primaryHover = adjustLightness(primary, -0.08);
  const primaryDeep = adjustLightness(primary, kind === 'dark' ? -0.22 : -0.20);
  const primarySoft = kind === 'dark' ? withAlpha(primary, 0.18) : mix('#ffffff', primary, 0.14);
  const primaryBg = kind === 'dark' ? withAlpha(primary, 0.08) : mix('#ffffff', primary, 0.06);

  const s = base.surface;
  const t = base.text;

  let sidebarGrad, sidebarText, sidebarTextActive, navActiveBg, navHoverBg;
  if (sidebarStyle === 'gradient') {
    sidebarGrad = `linear-gradient(180deg, ${s.card} 0%, ${mix(s.card, primary, 0.18)} 40%, ${primaryLight} 100%)`;
    sidebarText = t.body; sidebarTextActive = '#ffffff';
    navActiveBg = `linear-gradient(180deg, ${primaryLight}, ${primaryHover})`;
    navHoverBg = `linear-gradient(180deg, ${withAlpha(primaryLight, 0.18)}, ${withAlpha(primaryHover, 0.20)})`;
  } else if (sidebarStyle === 'solid-light') {
    sidebarGrad = s.card; sidebarText = t.body; sidebarTextActive = '#ffffff';
    navActiveBg = `linear-gradient(135deg, ${primaryLight}, ${primaryHover})`;
    navHoverBg = withAlpha(primary, 0.08);
  } else if (sidebarStyle === 'solid-dark') {
    sidebarGrad = kind === 'dark'
      ? `linear-gradient(180deg, ${adjustLightness(s.card, 0.03)} 0%, ${s.card} 50%, ${adjustLightness(s.card, -0.04)} 100%)`
      : `linear-gradient(180deg, #1c1f26 0%, #0d0f13 100%)`;
    sidebarText = kind === 'dark' ? t.body : '#CDD0D8'; sidebarTextActive = '#ffffff';
    navActiveBg = `linear-gradient(135deg, ${primaryLight}, ${primaryHover})`;
    navHoverBg = withAlpha(primary, 0.12);
  } else { // dark-inverse
    sidebarGrad = `linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%)`;
    sidebarText = '#CDD0D8'; sidebarTextActive = '#ffffff';
    navActiveBg = `linear-gradient(135deg, ${primaryLight}, ${primaryHover})`;
    navHoverBg = withAlpha(primary, 0.12);
  }

  const btnPrimaryGrad = `linear-gradient(135deg, ${primaryLight}, ${primaryHover})`;
  const btnPrimaryGradHover = `linear-gradient(135deg, ${primary}, ${primaryDeep})`;
  const btnPrimaryGlow = `inset 0 1px 0 rgba(255,255,255,.25), 0 0 22px ${withAlpha(primary, 0.35)}, 0 4px 14px ${withAlpha(primaryHover, 0.28)}`;

  let cardShadow, cardShadowHover;
  if (kind === 'light') {
    cardShadow = `inset 0 1px 0 rgba(255,255,255,.9), inset 0 0 0 1px ${withAlpha(primary, 0.18)}, 0 4px 14px ${withAlpha(primary, 0.12)}`;
    cardShadowHover = `inset 0 1px 0 rgba(255,255,255,.95), inset 0 0 0 1px ${withAlpha(primary, 0.28)}, 0 8px 22px ${withAlpha(primary, 0.18)}`;
  } else {
    cardShadow = `6px 6px 20px rgba(0,0,0,0.55), -1px -1px 2px rgba(255,255,255,0.03), inset 0 0 0 1px ${withAlpha(primary, 0.10)}`;
    cardShadowHover = `8px 8px 24px rgba(0,0,0,0.65), -2px -2px 3px rgba(255,255,255,0.05), inset 0 0 0 1px ${withAlpha(primary, 0.22)}`;
  }

  const pageAurora =
    `radial-gradient(ellipse 60% 40% at 18% 30%, ${withAlpha(primary, kind === 'dark' ? 0.10 : 0.25)} 0%, transparent 55%),` +
    `radial-gradient(ellipse 50% 35% at 78% 22%, ${withAlpha(primary, kind === 'dark' ? 0.05 : 0.18)} 0%, transparent 55%),` +
    `radial-gradient(ellipse 70% 45% at 50% 85%, ${withAlpha(primary, kind === 'dark' ? 0.045 : 0.20)} 0%, transparent 55%)`;

  let heroBg, heroBorder, heroAccent;
  if (base.heroCardSurface === 'tinted') {
    heroBg = `linear-gradient(135deg, ${primaryBg} 0%, ${primarySoft} 50%, ${s.card} 100%)`;
    heroBorder = withAlpha(primary, 0.20); heroAccent = primaryDeep;
  } else {
    heroBg = `linear-gradient(135deg, ${s.card} 0%, ${s.inset} 50%, ${s.card} 100%)`;
    heroBorder = withAlpha(primary, 0.25); heroAccent = primaryLight;
  }

  const tableHeadBg = kind === 'light' ? `linear-gradient(180deg, ${primarySoft}, ${primaryBg})` : s.inset;
  const tableHeadBorder = kind === 'light' ? withAlpha(primary, 0.25) : s.cardBorder;
  const tableStripe = kind === 'light' ? primaryBg : 'rgba(255,255,255,0.02)';
  const tableHover = withAlpha(primary, kind === 'light' ? 0.12 : 0.10);

  const bubbleThemBg = s.inset;
  const bubbleThemColor = t.body;
  const bubbleMeGrad = btnPrimaryGrad;

  const badgeBlue = btnPrimaryGrad;
  const badgeGreen = 'linear-gradient(135deg,#10B981,#047857)';
  const badgeAmber = 'linear-gradient(135deg,#f59e0b,#b45309)';
  const badgeRed = 'linear-gradient(135deg,#ef4444,#b91c1c)';
  const badgeSlate = kind === 'dark' ? `linear-gradient(135deg, #4a4e58, ${s.cardBorder})` : 'linear-gradient(135deg,#64748b,#475569)';

  return {
    font,
    primary, primaryLight, primaryHover, primaryDeep, primarySoft, primaryBg,
    pageBg: s.page, cardBg: s.card, cardBorder: s.cardBorder, insetBg: s.inset,
    textPrimary: t.primary, textBody: t.body, textMuted: t.muted, textFaint: t.faint,
    cardRadius: base.radii.card + 'px',
    btnRadius: base.radii.btn === 9999 ? '9999px' : base.radii.btn + 'px',
    inputRadius: base.radii.input + 'px',
    badgeRadius: '9999px',
    sidebarGrad, sidebarText, sidebarTextActive, navActiveBg, navHoverBg,
    btnPrimaryGrad, btnPrimaryGradHover, btnPrimaryGlow,
    cardShadow, cardShadowHover,
    pageAurora, heroBg, heroBorder, heroAccent,
    tableHeadBg, tableHeadBorder, tableStripe, tableHover,
    bubbleThemBg, bubbleThemColor, bubbleMeGrad,
    badgeGreen, badgeAmber, badgeRed, badgeBlue, badgeSlate,
    _base: baseName, _kind: kind,
  };
}

export function toCss(tokens, scope) {
  const pairs = {
    '--font': tokens.font,
    '--primary': tokens.primary,
    '--primary-light': tokens.primaryLight,
    '--primary-hover': tokens.primaryHover,
    '--primary-deep': tokens.primaryDeep,
    '--primary-soft': tokens.primarySoft,
    '--primary-bg': tokens.primaryBg,
    '--page-bg': tokens.pageBg,
    '--card-bg': tokens.cardBg,
    '--card-border': tokens.cardBorder,
    '--inset-bg': tokens.insetBg,
    '--text-primary': tokens.textPrimary,
    '--text-body': tokens.textBody,
    '--text-muted': tokens.textMuted,
    '--text-faint': tokens.textFaint,
    '--card-radius': tokens.cardRadius,
    '--btn-radius': tokens.btnRadius,
    '--input-radius': tokens.inputRadius,
    '--badge-radius': tokens.badgeRadius,
    '--sidebar-grad': tokens.sidebarGrad,
    '--sidebar-text': tokens.sidebarText,
    '--sidebar-text-active': tokens.sidebarTextActive,
    '--nav-active-bg': tokens.navActiveBg,
    '--nav-hover-bg': tokens.navHoverBg,
    '--btn-primary-grad': tokens.btnPrimaryGrad,
    '--btn-primary-grad-hover': tokens.btnPrimaryGradHover,
    '--btn-primary-glow': tokens.btnPrimaryGlow,
    '--card-shadow': tokens.cardShadow,
    '--card-shadow-hover': tokens.cardShadowHover,
    '--page-aurora': tokens.pageAurora,
    '--hero-bg': tokens.heroBg,
    '--hero-border': tokens.heroBorder,
    '--hero-accent': tokens.heroAccent,
    '--table-head-bg': tokens.tableHeadBg,
    '--table-head-border': tokens.tableHeadBorder,
    '--table-stripe': tokens.tableStripe,
    '--table-hover': tokens.tableHover,
    '--bubble-them-bg': tokens.bubbleThemBg,
    '--bubble-them-color': tokens.bubbleThemColor,
    '--bubble-me-grad': tokens.bubbleMeGrad,
    '--badge-green': tokens.badgeGreen,
    '--badge-amber': tokens.badgeAmber,
    '--badge-red': tokens.badgeRed,
    '--badge-blue': tokens.badgeBlue,
    '--badge-slate': tokens.badgeSlate,
  };
  const lines = Object.entries(pairs).map(([k, v]) => `${k}: ${v};`).join(' ');
  return `${scope} { ${lines} }`;
}
