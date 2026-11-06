// npm --prefix app run i18n:sources [-- --check]
//
// Writes src/i18n/catalog/sources.js (CS-851): for every Spanish and Creole line in es.js / ht.js,
// the hash of the English it was translated from, so the server can tell a line whose English has
// since moved on (api/_lib/i18nSource.js pendingLines) and translate the new English itself.
//
//   • a line that already has a source keeps it (re-stamping would hide a change);
//   • a line with none is stamped with the English beside it today (the 2026-10-15 seed, or a
//     line added by hand next to the English it translates);
//   • a source for a key neither language holds is dropped.
// `i18n:import` keeps the map current for the lines it loads. `--check` writes nothing and exits 1
// when the file is not what this would write. Offline.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_DIR, loadCatalog } from './i18n-lib.mjs';
import { buildSources, renderSources } from '../api/_lib/i18nSource.js';

export const SOURCES_FILE = 'sources.js';

export async function loadSources(dir = CATALOG_DIR) {
  if (!existsSync(path.join(dir, SOURCES_FILE))) return {};
  return loadCatalog('sources', dir);
}

// The file's text for the catalogs in `dir`, given `restamp` (see buildSources).
export async function sourcesText(dir = CATALOG_DIR, { restamp = null } = {}) {
  const [en, es, ht, previous] = await Promise.all([loadCatalog('en', dir), loadCatalog('es', dir), loadCatalog('ht', dir), loadSources(dir)]);
  return renderSources(buildSources({ en, catalogs: { es, ht }, previous, restamp }));
}

export async function writeSources(dir = CATALOG_DIR, opts = {}) {
  const text = await sourcesText(dir, opts);
  writeFileSync(path.join(dir, SOURCES_FILE), text);
  return text;
}

async function main() {
  const check = process.argv.includes('--check');
  const target = path.join(CATALOG_DIR, SOURCES_FILE);
  const text = await sourcesText();
  if (check) {
    const now = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (now !== text) { console.error('i18n:sources — src/i18n/catalog/sources.js is not current; run npm --prefix app run i18n:sources'); return 1; }
    console.log('i18n:sources — current');
    return 0;
  }
  writeFileSync(target, text);
  const n = (text.match(/^ {2}"/gm) || []).length;
  console.log(`i18n:sources — wrote ${path.relative(process.cwd(), target)} (${n} keys)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`i18n:sources failed: ${e.message}`); process.exitCode = 2; });
}
