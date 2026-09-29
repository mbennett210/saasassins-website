// The persist migration chain must be able to reach INITIAL_STATE.version — E13.
//
// THE BUG: seed.js is at version 49 and STORAGE_KEY is 'pp.store.v49', but
// migrateV48toV49 DID NOT EXIST. The chain topped out at 48, so loadState() could
// never return 49, and the v49 fast path (which tested `parsed.version === 48`) never
// matched a correctly-versioned blob either. Local/demo persistence was DEAD — every
// load fell through to a reseed. Silent, because a reseed looks exactly like a working
// app with fresh data.
//
// It also mattered forward: C07's planned v49 -> v50 bump would have landed on a chain
// that already could not reach its own current version, and shipped inert.
//
// This asserts the PROPERTY rather than the specific hop, so the next bump that
// forgets its migration fails here instead of silently wiping local state.
//
//   node scripts/test-persist-chain.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const persist = src('../src/store/persist.js');
const seed = src('../src/data/seed.js');

// ── the three numbers that must agree ────────────────────────────────────
const seedVersion = Number((seed.match(/^\s*version:\s*(\d+)\s*,/m) || [])[1]);
const storageKey = (persist.match(/STORAGE_KEY\s*=\s*'([^']+)'/) || [])[1];
const keyVersion = Number((storageKey || '').match(/v(\d+)$/)?.[1]);

ok('seed.js declares a version', Number.isFinite(seedVersion));
ok('persist.js declares a STORAGE_KEY', !!storageKey);
ok(`STORAGE_KEY (${storageKey}) matches INITIAL_STATE.version (${seedVersion})`, keyVersion === seedVersion);

// ── the chain must reach it ──────────────────────────────────────────────
// CLAUDE.md requires the seed version and STORAGE_KEY to move in lockstep. Nothing
// enforced that a migration hop exists to GET there, which is exactly what broke.
const hops = [...persist.matchAll(/function migrateV(\d+)toV(\d+)\s*\(/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
const targets = new Set(hops.map(([, to]) => to));
ok(`a migration hop lands on ${seedVersion}`, targets.has(seedVersion));
ok(`  ...specifically migrateV${seedVersion - 1}toV${seedVersion}`, hops.some(([f, t]) => f === seedVersion - 1 && t === seedVersion));

// ── and the chain runner must invoke it ──────────────────────────────────
// A defined-but-uncalled hop is the same bug with extra steps.
ok(`the chain runner calls the v${seedVersion - 1} hop`,
  new RegExp(`version\\s*===\\s*${seedVersion - 1}\\)\\s*st\\s*=\\s*migrateV${seedVersion - 1}toV${seedVersion}`).test(persist));

// ── the fast path must accept the CURRENT version ───────────────────────
// It tested `=== 48` under the v49 key, so a correctly-versioned blob was rejected
// and reseeded. That is the half that made the bug invisible.
ok(`the current-key fast path accepts version ${seedVersion}`,
  new RegExp(`parsed\\.version\\s*===\\s*${seedVersion}`).test(persist));

// ── no gaps in the reachable chain ──────────────────────────────────────
// Every hop's target should itself be a hop's source (or the final version), or the
// chain has a hole that silently drops old local state on the floor.
{
  const sources = new Set(hops.map(([f]) => f));
  const dangling = [...targets].filter((t) => t !== seedVersion && !sources.has(t));
  ok(`no dangling migration targets (found: ${dangling.join(', ') || 'none'})`, dangling.length === 0);
}

// ── the new hop is additive-only ────────────────────────────────────────
// v49's additions are documented in seed.js as "additive default-safe slices". A hop
// that TRANSFORMS data would need a real reseed, not a default-fill, so pin that it
// only defaults.
{
  const body = (persist.match(/function migrateV48toV49\s*\([\s\S]*?\n}/) || [])[0] || '';
  ok('migrateV48toV49 exists', body.length > 0);
  ok('  ...spreads the prior state (never discards it)', /\.\.\.s\b/.test(body));
  ok('  ...sets version 49', /version:\s*49/.test(body));
  ok('  ...preserves a deliberate null rather than overwriting it', /\?\?\s*null/.test(body));
  ok('  ...lets a stored opsSettings win over the defaults',
    /\.\.\.OPS_SETTINGS_V49_DEFAULTS,\s*\.\.\.\(s\.opsSettings/.test(body));
  // Every slice it fills must actually exist in the seed, or we are inventing shape.
  const filled = [...body.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1])
    .filter((k) => k !== 'version');
  const missing = filled.filter((k) => !new RegExp(`^\\s*${k}:`, 'm').test(seed));
  ok(`every slice it fills exists in seed.js (${filled.length} checked, missing: ${missing.join(', ') || 'none'})`, missing.length === 0);
}

console.log(`\npersist chain: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
