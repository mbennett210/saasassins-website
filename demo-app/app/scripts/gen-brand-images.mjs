#!/usr/bin/env node
// gen-brand-images — the brand's images, drawn from its brand pack (brands/<id>/, brand.json `logos`) in the
// theme's colours (UI_RULES §121, §129). `npm --prefix app run brand -- <id>` runs it; alone:
//   node scripts/gen-brand-images.mjs            write the active brand's images into public/
//   node scripts/gen-brand-images.mjs --check    exit 1 when a committed image's pixels differ
//
// Two sources, both in the brand's folder:
//   logos.mark    the monogram: a light glyph on a dark field (any opacity). The generator keeps what is
//                 lighter than mid-grey inside `box` (the glyph's bounding box; the whole image when absent).
//                 → the app icons and favicon (the glyph in white on a tile of the brand ink) and the phone
//                   nav's mark (the glyph in the deepest ink, on transparent).
//   logos.lockup  the horizontal logo: dark on a light background, cropped to `box`. The sidebar is the deep
//                 brand ink, so the logo is knocked out to the colour of text on it (alpha = 1 - luminance).
// The output file names are kept identifiers (UI_RULES §129): the org's saved data and the app point at them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast } from './brand-colors.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = path.join(APP, 'public');
const BRANDS = path.join(APP, '..', 'brands');

// The generated module the documents' letterhead reads (src/brand/logo.js): the client's colour lockup as an
// inline PNG data URI, or null (then the letterhead is the generated monogram).
export const DOC_LOGO_OUT = path.join(APP, 'src', 'brand', 'logo.generated.js');
// A colour logo mark must clear the graphics-object contrast floor (WCAG 1.4.11, 3:1) against a ground to read
// on it; below it the sidebar keeps the white knock-out.
export const LOGO_GROUND_CONTRAST = 3;
// The theme tokens the sidebar logo (company.logoUrl) is shown on: the sidebar rail and the login card. When
// the login card resolves to the same colour as the sidebar, the ground is checked once.
export const LOGO_GROUND_TOKENS = [['the sidebar', 'color-brand-primary-700'], ['the login card', 'card-bg']];
// Modest raster sizes: a letterhead the documents print at ~190px, a sidebar logo shown at ~200px.
const MAX_DOC_W = 600;
const MAX_SIDEBAR_W = 800;
// design:allow no-raw-hex — the white icon tile behind a brand's colour mark (logos.mark.tile "white"): structural, not a brand colour
const WHITE_TILE = '#ffffff';

/** The grounds the sidebar logo sits on, resolved from a token→colour map; identical grounds are merged. */
export function logoGrounds(byName) {
  const seen = new Set();
  const out = [];
  for (const [label, token] of LOGO_GROUND_TOKENS) {
    const color = byName.get(token);
    if (!color || seen.has(color.toLowerCase())) continue;
    seen.add(color.toLowerCase());
    out.push({ label, color });
  }
  return out;
}

/**
 * The coverage-weighted mean WCAG contrast of a raster's opaque pixels against a ground: each pixel's contrast
 * weighted by its coverage (alpha), so anti-aliased edges count in proportion. `raw` is RGBA (or RGB) pixels.
 */
export function coverageWeightedContrast(raw, info, groundHex) {
  const ch = info.channels;
  let wsum = 0;
  let csum = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const a = ch === 4 ? raw[i * ch + 3] : 255;
    if (a <= 0) continue;
    wsum += a;
    csum += a * contrast([raw[i * ch], raw[i * ch + 1], raw[i * ch + 2]], groundHex);
  }
  return wsum ? csum / wsum : 0;
}

/**
 * The client's colour lockup (logos.lockup.color), trimmed and sized for the sidebar, and whether it reads on
 * every ground it is shown on (coverage-weighted mean contrast ≥ LOGO_GROUND_CONTRAST on each). Returns
 * { color, min, grounds:[{label,color,ratio}], raster } — or null when the pack has no colour lockup.
 */
export async function sidebarLogoDecision(brand, grounds = [], { dir = BRANDS, sharp } = {}) {
  const color = brand.logos?.lockup?.color;
  if (!color) return null;
  sharp = sharp || (await import('sharp')).default;
  const raster = await sharp(path.join(dir, brand.id, color)).trim().resize({ width: MAX_SIDEBAR_W, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const { data, info } = await sharp(raster).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const measured = grounds.map((g) => ({ ...g, ratio: Math.round(coverageWeightedContrast(data, info, g.color) * 100) / 100 }));
  const min = measured.length ? Math.min(...measured.map((m) => m.ratio)) : 0;
  return { color: measured.length > 0 && min >= LOGO_GROUND_CONTRAST, min, grounds: measured, raster };
}

/**
 * The documents' letterhead: the client's colour lockup (logos.lockup.color), trimmed and rasterized to a
 * modest inline PNG data URI (so the quote and inspection report carry no asset path, in the browser and in the
 * server's chromium PDF). null when the pack has no colour lockup, so DOC_LOGO stays the generated monogram.
 */
export async function renderDocLogo(brand, { dir = BRANDS, sharp } = {}) {
  const color = brand.logos?.lockup?.color;
  if (!color) return null;
  sharp = sharp || (await import('sharp')).default;
  const png = await sharp(path.join(dir, brand.id, color)).trim().resize({ width: MAX_DOC_W, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** The src/brand/logo.generated.js module text for a letterhead data URI (or null). */
export function docLogoModule(dataUri) {
  return `// GENERATED by \`npm --prefix app run brand\` from the brand pack's logos.lockup.color. Do not edit: change
// the brand pack, then regenerate. brand.mjs --check fails when this file no longer matches the pack. The
// documents' letterhead (the quote and inspection report, in the browser and the server's PDF) reads it through
// src/brand/logo.js; null falls back to the generated monogram.
export const DOC_LOGO_IMAGE = ${dataUri === null ? 'null' : JSON.stringify(dataUri)};
`;
}

/** The logo.generated.js output for a brand, as [file, before, after]. */
export async function docLogoTarget(brand, opts) {
  const before = fs.existsSync(DOC_LOGO_OUT) ? fs.readFileSync(DOC_LOGO_OUT, 'utf8') : '';
  return [DOC_LOGO_OUT, before, docLogoModule(await renderDocLogo(brand, opts))];
}

// [output under public/, how it is drawn]
export const OUTPUTS = [
  ['icon-512.png', { kind: 'icon', size: 512 }],
  ['icon-maskable-512.png', { kind: 'icon', size: 512, round: false, pad: 0.24 }], // full-bleed, inset for the circle mask
  ['icon-192.png', { kind: 'icon', size: 192 }],
  ['apple-touch-icon.png', { kind: 'icon', size: 180 }],
  ['favicon.png', { kind: 'icon', size: 48, pad: 0.12 }],
  ['cleanspace-glyph-ink.png', { kind: 'glyph', width: 540 }],
  ['cleanspace-logo.png', { kind: 'lockup' }],
];

const boxOf = async (sharp, file, box) => {
  const { width, height } = await sharp(file).metadata();
  const b = box || { left: 0, top: 0, width, height };
  if (b.left < 0 || b.top < 0 || b.left + b.width > width || b.top + b.height > height) {
    throw new Error(`${path.basename(file)}: box ${JSON.stringify(b)} falls outside the ${width}×${height} image`);
  }
  return b;
};

/**
 * Every image for a brand, as [file under public/, PNG Buffer]. `colours` are the theme's resolved values:
 * { primary (the icon tile), primaryDeep (the phone nav's glyph), onPrimary (the sidebar logo) }.
 */
export async function renderBrandImages(brand, colours, { grounds = [], dir: brandsDir = BRANDS } = {}) {
  const sharp = (await import('sharp')).default;
  const dir = path.join(brandsDir, brand.id);
  const markFile = path.join(dir, brand.logos.mark.file);
  const lockupFile = path.join(dir, brand.logos.lockup.file);
  for (const f of [markFile, lockupFile]) if (!fs.existsSync(f)) throw new Error(`no image at brands/${brand.id}/${path.basename(f)}`);
  const GLYPH_BOX = await boxOf(sharp, markFile, brand.logos.mark.box);
  const LOCKUP_BOX = await boxOf(sharp, lockupFile, brand.logos.lockup.box);
  // The sidebar/login logo becomes the client's colour lockup only when it reads on every ground it sits on
  // (below the floor: the white knock-out). The mark tile becomes the colour mark on white only when the pack
  // asks (logos.mark.tile "white"). Both are absent for a pack without the fields — then this is today's output.
  const decision = await sidebarLogoDecision(brand, grounds, { dir: brandsDir, sharp });
  const whiteTile = brand.logos.mark.tile === 'white';
  const markColorFile = brand.logos.mark.color ? path.join(dir, brand.logos.mark.color) : null;

  // The glyph, isolated: threshold at full resolution (drops a semi-transparent field), then resize. With tile
  // "white", the client's colour mark centred on a white tile instead (its own colours, kept as they print it).
  async function icon({ size, round = true, pad = 0.15 }) {
    const r = round ? Math.round(size * 0.22) : 0;
    const inner = Math.round(size * (1 - 2 * pad));
    if (whiteTile) {
      const tile = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${WHITE_TILE}"/></svg>`);
      const mark = await sharp(markColorFile).trim().resize({ width: inner, height: inner, fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      return sharp(tile).composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
    }
    const tile = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${colours.primary}"/></svg>`);
    const glyph = await sharp(markFile)
      .extract(GLYPH_BOX)
      .greyscale()
      .threshold(128)
      // design:allow no-raw-hex — the lighten blend's no-op field: pure black by the maths, not a brand colour
      .resize({ width: inner, height: inner, fit: 'contain', background: '#000000' })
      .png()
      .toBuffer();
    // lighten: the black field is a no-op over the tile, the white glyph paints through (no seam)
    return sharp(tile).composite([{ input: glyph, gravity: 'center', blend: 'lighten' }]).png().toBuffer();
  }
  // The glyph alone in the deepest brand ink on transparent, at its natural aspect (the phone nav's mark).
  async function glyph({ width }) {
    const height = Math.round((width * GLYPH_BOX.height) / GLYPH_BOX.width);
    const mask = await sharp(markFile).extract(GLYPH_BOX).greyscale().threshold(128).resize(width, height).toColourspace('b-w').raw().toBuffer();
    return sharp({ create: { width, height, channels: 3, background: colours.primaryDeep } })
      .joinChannel(mask, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
  }
  // The client's colour lockup when it reads on every ground it is shown on (decision.color), else the lockup
  // knocked out: alpha = negated luminance with a linear lift, so a near-white ground goes fully clear and the
  // strokes stay solid; painted in the colour of text on the brand ink; trimmed.
  async function lockup() {
    if (decision?.color) return decision.raster; // the colour lockup, already trimmed and sized
    const { width: W, height: H } = LOCKUP_BOX;
    const alpha = await sharp(lockupFile).extract(LOCKUP_BOX).greyscale().negate().linear(1.2, -18).raw().toBuffer();
    const knocked = await sharp({ create: { width: W, height: H, channels: 3, background: colours.onPrimary } })
      .joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();
    return sharp(knocked).trim().png().toBuffer();
  }
  const out = [];
  for (const [file, spec] of OUTPUTS) {
    out.push([file, await (spec.kind === 'icon' ? icon(spec) : spec.kind === 'glyph' ? glyph(spec) : lockup())]);
  }
  out.logoDecision = decision; // for the review page: which sidebar logo was used and its measured contrast
  return out;
}

/** The files whose decoded pixels differ from what the brand renders (a missing file counts). */
export async function staleImages(rendered) {
  const sharp = (await import('sharp')).default;
  const raw = async (input) => sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const stale = [];
  for (const [file, buf] of rendered) {
    const target = path.join(PUBLIC, file);
    if (!fs.existsSync(target)) { stale.push(file); continue; }
    const [a, b] = await Promise.all([raw(target), raw(buf)]);
    if (a.info.width !== b.info.width || a.info.height !== b.info.height || !a.data.equals(b.data)) stale.push(file);
  }
  return stale;
}

export const writeImages = (rendered) => { for (const [file, buf] of rendered) fs.writeFileSync(path.join(PUBLIC, file), buf); };

const invoked = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (invoked) {
  const { activeBrandId, loadBrand } = await import('./brand.mjs');
  const { BRAND } = await import('../src/brand/tokens.generated.js');
  const { readCascade } = await import('./design-system-lib.mjs');
  const { brand, error } = loadBrand(activeBrandId());
  if (error) { console.error(error); process.exit(1); }
  const grounds = logoGrounds(new Map(readCascade().map((r) => [r.name, r.resolved])));
  const rendered = await renderBrandImages(brand, { primary: BRAND.primary, primaryDeep: BRAND.primaryDeep, onPrimary: BRAND.onPrimary }, { grounds });
  const doc = await docLogoTarget(brand);
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const docStale = norm(doc[1]) !== norm(doc[2]);
  if (process.argv.includes('--check')) {
    const stale = await staleImages(rendered);
    if (docStale) stale.push('src/brand/logo.generated.js');
    if (stale.length) { console.error(`gen-brand-images (${brand.id}): stale: ${stale.join(', ')}. Run \`npm --prefix app run brand -- ${brand.id}\`.`); process.exitCode = 1; }
    else console.log(`gen-brand-images (${brand.id}): ${rendered.length} images and the letterhead module match brands/${brand.id}`);
  } else {
    writeImages(rendered);
    if (docStale) { fs.mkdirSync(path.dirname(doc[0]), { recursive: true }); fs.writeFileSync(doc[0], doc[2]); }
    console.log(`gen-brand-images (${brand.id}): wrote ${rendered.map(([f]) => f).join(', ')}, src/brand/logo.generated.js`);
  }
}
