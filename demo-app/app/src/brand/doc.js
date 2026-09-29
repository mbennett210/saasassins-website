// The palette customer-facing documents and emails use: the quote, the inspection report, their PDFs
// and the emails the server sends. They follow the app brand (owner decision 2026-09-24): brand ink for
// bands, table heads and headings; the accent as a fill; status colours constant; greys from the
// theme's neutral scale. Every value comes from BRAND (generated from the theme cascade), so a re-skin
// changes the documents with the app. No colour literals belong in this file.
import { BRAND } from './tokens.generated.js';

// WCAG relative luminance / contrast of two opaque hex colours
const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const hexRgb = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lum = (hex) => { const [r, g, b] = hexRgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// a palette colour at an opacity: shadows and scrims tinted by the brand's ink, never a literal rgba()
export const alpha = (hex, a) => `rgba(${hexRgb(hex).join(', ')}, ${a})`;

// The accent may carry text only where it is legible (3:1, large type); a light accent such as
// CleanSpace's gold never can, so its text falls back to the strong neutral.
const accentText = contrast(BRAND.accent, BRAND.card) >= 3 ? BRAND.accent : BRAND.n600;

export const DOC = Object.freeze({
  brand: BRAND.primary, // bars, table heads, headings, label text
  onBrand: BRAND.onPrimary, // text on a brand fill
  tint: BRAND.primaryBg, // the lightest brand wash (label cells, badge cells)
  ink: BRAND.text, // headings and the page's text
  body: BRAND.body, // paragraph text in emails and pages
  muted: BRAND.n500, // captions, subtitles, placeholders (the lightest text-safe step)
  pen: BRAND.n600, // signature and fill-in lines, secondary headings
  line: BRAND.n300, // table and card borders
  rule: BRAND.n400, // decorative rules
  paper: BRAND.card, // the page
  wash: BRAND.n50, // zebra rows, card fills
  soft: BRAND.n100, // chips, row dividers
  divider: BRAND.n200, // tracks and quiet rules (the score gauge's track)
  accent: BRAND.accent, // highlight fills and borders (never text unless accentText says so)
  accentBg: BRAND.accentBg,
  accentSoft: BRAND.accentSoft, // fillable-field highlight
  accentText, // the accent as text where legible, else the strong neutral
  onAccent: BRAND.onAccent, // text on an accent fill
  good: BRAND.success, goodBg: BRAND.successBg, goodInk: BRAND.successInk,
  warn: BRAND.warning, warnBg: BRAND.warningBg, warnInk: BRAND.warningInk,
  bad: BRAND.danger, badBg: BRAND.dangerBg, badInk: BRAND.dangerInk,
});

// A solid 1×1 PNG of a colour, as a data URL. Chromium's PDF header/footer templates ignore background
// colours but do draw images, so a running bar is a stretched 1×1 image of the brand colour.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type, data) => { const t = [...type].map((ch) => ch.charCodeAt(0)); return [...u32(data.length), ...t, ...data, ...u32(crc32([...t, ...data]))]; };
export function solidPng(hex) {
  const [r, g, b] = hexRgb(hex);
  const raw = [0, r, g, b]; // one scanline: filter byte + RGB
  let a = 1, s = 0; for (const v of raw) { a = (a + v) % 65521; s = (s + a) % 65521; }
  const zlib = [0x78, 0x01, 0x01, raw.length, 0, raw.length ^ 0xff, 0xff, ...raw, ...u32(((s << 16) | a) >>> 0)]; // stored deflate block
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(1), ...u32(1), 8, 2, 0, 0, 0]), ...chunk('IDAT', zlib), ...chunk('IEND', [])];
  return `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
}
