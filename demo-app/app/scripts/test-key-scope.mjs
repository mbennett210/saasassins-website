// Crew key visibility (src/lib/keyScope.js) — the ONE rule behind the Keys page,
// selectVisibleKeysFor and global search. Executes the pure predicate, then asserts every
// consumer routes through it (lockstep), so a key hidden on the Keys page can never
// surface in search again (the S70 review found search listing ALL keys to crew).
//
//   node scripts/test-key-scope.mjs
import { readFileSync } from 'node:fs';
import { makeKeyScope, normKeyCompany } from '../src/lib/keyScope.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const crew = { id: 'u_crew', role: 'crew' };
const manager = { id: 'u_mgr', role: 'manager' };
const assigned = [{ id: 'cl_a', name: '  Acme Cleaning ' }];

// ── non-crew see everything ────────────────────────────────────────────────────
{
  const scope = makeKeyScope(manager, assigned);
  ok('manager sees an unassigned linked key', scope({ id: 'k1', clientId: 'cl_other' }));
  ok('manager sees an unlinked key', scope({ id: 'k2', clientName: 'Nobody Co' }));
  ok('no user → no crew restriction (callers gate by permission)', makeKeyScope(null, [])({ id: 'k' }));
}

// ── crew: assigned companies + keys in their own hands ─────────────────────────
{
  const scope = makeKeyScope(crew, assigned);
  ok('crew sees a linked key at an assigned company', scope({ id: 'k1', clientId: 'cl_a' }));
  ok('crew does NOT see a linked key elsewhere', !scope({ id: 'k2', clientId: 'cl_b' }));
  ok('crew sees an imported key matched by name (case/space-insensitive)', scope({ id: 'k3', clientName: 'acme cleaning' }));
  ok('crew does NOT see an imported key at another company', !scope({ id: 'k4', clientName: 'Beta Corp' }));
  ok('a blank company name is not a wildcard', !scope({ id: 'k5', clientName: '   ' }));
  ok('crew always sees a key checked out to them', scope({ id: 'k6', clientId: 'cl_b', heldByUserId: 'u_crew' }));
  ok('a key held by someone else elsewhere stays hidden', !scope({ id: 'k7', clientId: 'cl_b', heldByUserId: 'u_other' }));
  ok('a missing key is not visible', !scope(null));
}
ok('normalizer trims + lowercases', normKeyCompany('  Acme  ') === 'acme');

// ── 🔴 LOCKSTEP: every consumer routes through the shared rule ─────────────────
const keysPage = read('../src/pages/Keys.jsx');
const selectors = read('../src/store/selectors.js');
const sources = read('../src/lib/masterSearch/sources.js');
ok('Keys page builds its scope with makeKeyScope', /makeKeyScope\(currentUser,/.test(keysPage));
ok('Keys page has no private copy of the name normalizer', !/const normName\s*=/.test(keysPage));
ok('selectVisibleKeysFor uses makeKeyScope', /selectVisibleKeysFor[\s\S]{0,300}makeKeyScope\(/.test(selectors));
ok('selectKeysForClient uses the shared normalizer (no local copy)', !/const normKeyCompany\s*=/.test(selectors));
ok('search keys adapter uses selectVisibleKeysFor', /type: 'key'[\s\S]{0,300}selectVisibleKeysFor\(s, user\)/.test(sources));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nkey scope: ${pass}/${pass} passed`);
