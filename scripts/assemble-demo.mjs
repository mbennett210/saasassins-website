// Assemble the deployable output directory (`dist/`):
//   1. Copy the static marketing site (root *.html, css/, js/, images/, etc.).
//   2. Drop the built Vite SPA in at dist/polishpoint/.
//
// Run after the SPA build (see the root "build" script). Vercel serves `dist/`
// (outputDirectory) and the /api functions are picked up from the repo root
// separately, so they aren't copied here.

import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const spaDist = resolve(root, 'demo-app/app/dist');

// Build machinery / config — never part of the served static site.
const EXCLUDE = new Set([
  'node_modules', 'demo-app', 'api', 'scripts', 'dist',
  '.git', '.vercel', '.claude',
  'package.json', 'package-lock.json', 'vercel.json', 'README.md', '.gitignore',
]);
const EXCLUDE_PREFIX = ['.env'];

if (!existsSync(spaDist)) {
  console.error(`assemble-demo: SPA build not found at ${spaDist} — run the Vite build first.`);
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1. Static marketing site = everything in root except machinery/config.
for (const entry of await readdir(root, { withFileTypes: true })) {
  const name = entry.name;
  if (EXCLUDE.has(name) || EXCLUDE_PREFIX.some((p) => name.startsWith(p))) continue;
  await cp(join(root, name), join(dist, name), { recursive: true });
}

// 2. The interactive demo SPA, mounted at /polishpoint.
await cp(spaDist, join(dist, 'polishpoint'), { recursive: true });

console.log(`assemble-demo: assembled static site + /polishpoint SPA into ${dist}`);
