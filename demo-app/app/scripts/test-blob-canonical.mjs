// The org_state content guard must compare CONTENT, not object key order.
//
// ══ THE DEFECT (2026-09-02) ══════════════════════════════════════════════════
// org_state.state is jsonb (keys re-sorted at every level on read). The guard's
// baseline is serialized from an ADOPTED copy (sorted keys); flush()'s snapshot
// from the live state (insertion order — a `{ ...job, ...patch }` spread re-orders
// keys). Equal content therefore serialized differently, the guard never matched,
// and every flush became a version-bumping no-op write that re-armed the OTHER
// tab: two office desktops ping-ponged one blob write every ~32 s all night, each
// write re-running the jobs delete-diff and keeping the CAS conflict window open.
// Live-verified: 17 consecutive versions with byte-identical content.
//
// Fix: one key-order-independent serializer (lib/canonicalJson.js) on BOTH sides.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalJson } from '../src/lib/canonicalJson.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── the serializer ───────────────────────────────────────────────────────────
{
  const a = { jobs: [{ id: 'j1', crewIds: ['u1', 'u2'], startAt: 'x' }], users: [{ id: 'u1', name: 'A' }] };
  const b = { users: [{ name: 'A', id: 'u1' }], jobs: [{ startAt: 'x', id: 'j1', crewIds: ['u1', 'u2'] }] };
  ok('🔴 same content in a different key order serializes identically', canonicalJson(a) === canonicalJson(b));
  ok('  ...and differs from plain JSON.stringify for that case (the defect)', JSON.stringify(a) !== JSON.stringify(b));
  const c = { ...a, jobs: [{ id: 'j1', crewIds: ['u2', 'u1'], startAt: 'x' }] };
  ok('🔴 array ORDER is content: a re-ordered array serializes differently', canonicalJson(a) !== canonicalJson(c));
  const d = { ...a, users: [{ id: 'u1', name: 'B' }] };
  ok('🔴 a changed value serializes differently', canonicalJson(a) !== canonicalJson(d));
  const nested = canonicalJson({ z: { b: { d: 1, c: 2 }, a: [3, { y: 1, x: 2 }] }, a: null });
  ok('  ...keys are sorted at EVERY level, arrays untouched', nested === '{"a":null,"z":{"a":[3,{"x":2,"y":1}],"b":{"c":2,"d":1}}}');
  ok('  ...undefined-valued keys drop on both sides (JSON semantics preserved)', canonicalJson({ a: 1, b: undefined }) === canonicalJson({ b: undefined, a: 1 }) && canonicalJson({ a: 1 }) === '{"a":1}');
  ok('  ...primitives and arrays pass through', canonicalJson([2, 1]) === '[2,1]' && canonicalJson('s') === '"s"' && canonicalJson(null) === 'null');
  ok('  ...a round-trip parses back to equal content', JSON.stringify(JSON.parse(canonicalJson(a))) === canonicalJson(a));
  // A key literally named "__proto__" is an own key after JSON.parse (and jsonb keeps it).
  // Copying it onto a plain {} set the copy's PROTOTYPE, so it vanished from the body while
  // the server kept it, and the field guard read every save as changing it (2026-09-23).
  const hostile = JSON.parse('{"timeOff":[{"id":"t1","__proto__":{"x":1},"userId":"u1"}],"b":{"__proto__":"s"}}');
  ok('🔴 an own "__proto__" key survives, sorted like any other key',
    canonicalJson(hostile) === '{"b":{"__proto__":"s"},"timeOff":[{"__proto__":{"x":1},"id":"t1","userId":"u1"}]}');
  ok('  ...and round-trips as the same own key', Object.keys(JSON.parse(canonicalJson(hostile)).timeOff[0]).includes('__proto__'));
}

// ── both sides of the guard use it ───────────────────────────────────────────
{
  const ts = read('src/store/tableSlices.js');
  // Explicit .js: tableSlices is imported by THIS plain-node suite, so its own
  // imports need the extension (Vite resolves either).
  ok('🔴 tableSlices imports canonicalJson (with the node-resolvable .js extension)', /import \{ canonicalJson \} from '\.\.\/lib\/canonicalJson\.js';/.test(ts));
  ok('🔴 the guard BASELINE (serializeSharedBlob) is canonical', /export function serializeSharedBlob\(state, freeze\) \{\s*const shared = toSharedBlob\(state, freeze\);\s*return shared === null \? null : canonicalJson\(shared\);\s*\}/.test(ts));

  const sy = read('src/store/sync.js');
  ok('🔴 sync imports canonicalJson', /import \{ canonicalJson \} from '\.\.\/lib\/canonicalJson';/.test(sy));
  ok('🔴 flush()\'s SNAPSHOT is canonical', /const sharedJson = canonicalJson\(shared\);/.test(sy));
  ok('  ...and no plain JSON.stringify of the shared blob survives in sync', !/JSON\.stringify\(shared\)/.test(sy));
  ok('  ...every baseline assignment still routes through serializeShared', (sy.match(/lastSavedStateJson = serializeShared\(/g) || []).length >= 4);
  ok('  ...and the post-commit baseline is the same canonical snapshot', /lastSavedStateJson = sharedJson;/.test(sy));
}

console.log(`\nblob canonical guard: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
