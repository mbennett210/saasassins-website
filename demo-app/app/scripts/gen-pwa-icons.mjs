// One-shot generator for PWA icons. Composites the brand logo onto a
// brand-colored square at the sizes the PWA manifest references.
//
// Source of truth for the logo file + background color is src/brand.config.js
// — so re-skinning per client is one edit to that file, then `node scripts/gen-pwa-icons.mjs`.
//
// Run:
//   node scripts/gen-pwa-icons.mjs

import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'public', BRAND.logoFile);
const OUT = (name) => join(root, 'public', name);
const BG = BRAND.primaryRgb;

async function makeIcon(size, padPct, outFile) {
  const inner = Math.round(size * (1 - 2 * padPct));
  const logo = await sharp(SRC)
    .resize({ width: inner, height: inner, fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  const meta = await sharp(logo).metadata();
  const left = Math.round((size - meta.width) / 2);
  const top = Math.round((size - meta.height) / 2);
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, left, top }])
    .png()
    .toFile(OUT(outFile));
  console.log(`wrote ${outFile} (${size}x${size}, pad ${(padPct * 100).toFixed(0)}%)`);
}

await makeIcon(64,  0.10, 'favicon.png');
await makeIcon(180, 0.10, 'apple-touch-icon.png');
await makeIcon(192, 0.10, 'icon-192.png');
await makeIcon(512, 0.10, 'icon-512.png');
await makeIcon(512, 0.20, 'icon-maskable-512.png');
