// A suite that SKIPS itself is a suite nobody runs. Some backend suites and lints skip when the
// repo's `supabase/migrations/` is absent (a no-backend demo clone carries only app/), and the
// runner counts a skip as green. test-gmb-wiring.mjs looked for it at `app/supabase/migrations/`
// — one level short of the repo's `supabase/migrations/` — so in THIS repo it printed "SKIPPED"
// on every run since the clone (2026-08-15) and its 44 pins never ran.
//
//   G1  every `new URL('…supabase/migrations/', import.meta.url)` guard under app/scripts/ resolves
//       to the repo's real migrations directory (while the repo has one)
// (G2 ran test-gmb-wiring.mjs itself and held it to no "SKIPPED"; that suite left with Google
// reviews on 2026-10-20, so G1, which holds every such guard, is what stays.)
//
// REGRESSION (THE LAW II.3): on the tree before the fix G1 failed.
//
//   node app/scripts/test-skip-guards.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS, '..', '..');
const MIGRATIONS = path.join(REPO, 'supabase', 'migrations');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

if (!existsSync(MIGRATIONS)) {
  // A no-backend clone: there is nothing for a guard to find, so nothing to hold here.
  console.log('\ntest-skip-guards: the repo has no supabase/migrations/ — nothing to check (a no-backend clone).');
} else {
  // ── G1. every migrations guard points at the real directory ──
  const GUARD = /new URL\('((?:\.\.\/)+)supabase\/migrations\/?'\s*,\s*import\.meta\.url\)/g;
  const guards = [];
  for (const name of readdirSync(SCRIPTS).filter((n) => /\.mjs$/.test(n))) {
    const src = readFileSync(path.join(SCRIPTS, name), 'utf8');
    for (const m of src.matchAll(GUARD)) {
      const resolved = fileURLToPath(new URL(`${m[1]}supabase/migrations/`, pathToFileURL(path.join(SCRIPTS, name))));
      guards.push({ name, rel: m[1], resolved });
    }
  }
  const wrong = guards.filter((g) => path.resolve(g.resolved) !== path.resolve(MIGRATIONS) + path.sep && path.resolve(g.resolved) !== path.resolve(MIGRATIONS));
  ok(`🔴 G1 every supabase/migrations guard under app/scripts/ resolves to the repo's migrations (${guards.length} guards; wrong: ${wrong.map((g) => `${g.name} → ${path.relative(REPO, g.resolved) || '.'}`).join(', ') || 'none'})`,
    () => guards.length >= 2 && wrong.length === 0);
}

console.log(`\ntest-skip-guards: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
