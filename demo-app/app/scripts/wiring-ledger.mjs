// app/scripts/wiring-ledger.mjs
// Deterministic wiring enumerator (playbook II.11: the L1 base for a Supabase-wiring audit).
// Mechanically lists every file that touches a PERSISTENCE primitive (localStorage /
// sessionStorage / IndexedDB / an offline queue) or a HARDCODED-DATA import (from src/data/),
// so coverage is proven by enumeration + reconciliation, not by an agent's judgment.
// Classifying each row (WIRE / KEEP-LOCAL / SEED-MOCK) is the only human step. Re-runnable in CI.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EXT = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);

function walk(dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'node_modules') walk(p, out); }
    else if (EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

const files = walk(SRC).sort();
const rows = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  const persist = [];
  const data = [];
  lines.forEach((ln, i) => {
    if (/\b(?:localStorage|sessionStorage)\s*\.\s*(?:get|set|remove)Item\s*\(|\bindexedDB\b|\bopenDB\s*\(/.test(ln)) persist.push(String(i + 1));
    if (/from\s+['"][^'"]*\/(?:timeQueue|mediaQueue|checklistQueue|offlineCache)['"]/.test(ln)) persist.push(`${i + 1}:queue`);
    const dm = ln.match(/from\s+['"][^'"]*\/data\/([A-Za-z0-9_-]+)['"]/);
    if (dm) data.push(`${i + 1}:${dm[1]}`);
  });
  if (persist.length || data.length) rows.push({ file: relative(SRC, f).replace(/\\/g, '/'), persist, data });
}

console.log('# Wiring ledger (deterministic enumeration): playbook II.11 L1 base');
console.log(`scanned: ${files.length} files under app/src`);
console.log(`candidates (persistence OR src/data import): ${rows.length}`);
console.log('');
for (const r of rows) {
  const bits = [];
  if (r.persist.length) bits.push(`persist@[${r.persist.join(',')}]`);
  if (r.data.length) bits.push(`data-import@[${r.data.join(',')}]`);
  console.log(`- ${r.file}  ${bits.join('  ')}`);
}
console.log('');
console.log(`RECONCILE: ${rows.length} candidates must each be classified WIRE / KEEP-LOCAL / SEED-MOCK before the wiring audit is complete.`);
