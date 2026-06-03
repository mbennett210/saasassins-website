// Pre-build step: materializes app/public/manifest.json from
// app/manifest.template.json + src/brand.config.js. Runs before `vite` and
// `vite build` via package.json scripts.
//
// public/manifest.json is git-ignored — this script is the only way it gets
// produced. To re-skin: edit src/brand.config.js, then re-run dev/build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../src/brand.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const TPL = path.join(root, 'manifest.template.json');
const OUT = path.join(root, 'public', 'manifest.json');

const tpl = fs.readFileSync(TPL, 'utf8');
const rendered = tpl
  .replaceAll('%BRAND_NAME%', BRAND.name)
  .replaceAll('%BRAND_SHORT_NAME%', BRAND.shortName)
  .replaceAll('%BRAND_DESCRIPTION%', BRAND.description)
  .replaceAll('%BRAND_PRIMARY%', BRAND.primaryHex);

fs.writeFileSync(OUT, rendered);
console.log(`build-manifest: wrote ${path.relative(root, OUT)}`);
