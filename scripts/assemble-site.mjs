// Assemble the deployable output directory (`dist/`): the static marketing site (root *.html, css/, js/, images/,
// etc.), without the repo's machinery, which stays out of what's public.
//
// The root "build" script runs it. Vercel serves `dist/` (outputDirectory) and the /api functions are picked up from
// the repo root separately, so they aren't copied here. The PolishPoint demo that used to be built in here
// (/polishpoint) moved to polishpointdev.com/demo on 2026-11-10; vercel.json redirects its old addresses there.

import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');

// Build machinery / config — never part of the served static site.
const EXCLUDE = new Set([
  'node_modules', 'api', 'scripts', 'dist',
  '.git', '.vercel', '.claude',
  'package.json', 'package-lock.json', 'vercel.json', 'README.md', '.gitignore',
]);
const EXCLUDE_PREFIX = ['.env'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// The static marketing site = everything in root except machinery/config.
for (const entry of await readdir(root, { withFileTypes: true })) {
  const name = entry.name;
  if (EXCLUDE.has(name) || EXCLUDE_PREFIX.some((p) => name.startsWith(p))) continue;
  await cp(join(root, name), join(dist, name), { recursive: true });
}

console.log(`assemble-site: assembled the static site into ${dist}`);
