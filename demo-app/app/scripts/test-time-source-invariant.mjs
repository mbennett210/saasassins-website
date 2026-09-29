// Schema↔code invariant for time_entries.source (adversarial-review critical,
// Sept 2): the offline suites run against fake DBs that don't enforce CHECK
// constraints, so a source value the schema rejects sails through every test
// and 23514s only in production — which is exactly how the stub-recovery
// feature almost shipped dead on arrival. This test parses the ACTUAL allowed
// set out of the migrations (the original CHECK plus any later widening) and
// asserts every `source: '...'` literal the server store writes is in it.
//
//   node scripts/test-time-source-invariant.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'supabase', 'migrations');
const storePath = join(here, '..', 'api', '_lib', 'time', 'store.js');

// Collect every source-CHECK definition across all migrations, LAST ONE WINS
// (a widening migration drops + re-adds the constraint).
const checkRe = /check\s*\(\s*source\s+in\s*\(([^)]+)\)\)/gi;
let allowed = null;
for (const f of readdirSync(migrationsDir).sort()) {
  if (!f.endsWith('.sql')) continue;
  const sql = readFileSync(join(migrationsDir, f), 'utf8');
  let m;
  while ((m = checkRe.exec(sql))) {
    allowed = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
}
ok('a source CHECK exists in the migrations', allowed instanceof Set && allowed.size > 0);

// Every literal source the server store writes.
const store = readFileSync(storePath, 'utf8');
const written = [...store.matchAll(/source:\s*'([^']+)'/g)].map((m) => m[1]);
ok('the store writes at least one source literal', written.length > 0);
for (const s of new Set(written)) {
  ok(`source '${s}' written by store.js is allowed by the schema CHECK`, allowed?.has(s));
}
// And the recovery source specifically — the one that shipped unguarded.
ok("'stub_recovery' is in the schema's allowed set", allowed?.has('stub_recovery'));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\ntime source invariant: ${pass}/${pass} passed`);
