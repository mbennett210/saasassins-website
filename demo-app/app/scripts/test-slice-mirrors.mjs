// Every table-owned slice must have a mirror — G2.
//
// 🔴 THE FAILURE THIS PREVENTS IS SILENT DATA LOSS, NOT AN ERROR.
//
// Increment 0.3 generalized the blob TRANSFORM across TABLE_SLICES but not the WRITE
// PATH: flush() captured every registered slice into `sliceNow`, then immediately
// narrowed to `sliceNow.jobs` and called the jobs-only mirror. So registering a second
// slice at phase 'mirror' would make the content-guard see "blob unchanged" for a
// slice-only edit, SKIP the org_state write — and nothing would mirror the slice.
// The edit just vanishes, with no error, no failed request, and a "synced" badge.
//
// That is exactly what tableSlices.js's own header warns about ("MISSING ONE IS
// SILENT"), and it is a hard prerequisite for Increment 3, which registers
// `notifications` — 1,428 rows and 42% of the blob.
//
// This test reads BOTH sources and asserts they stay in step, so adding a slice
// without its mirror fails the build instead of losing data in production.
//
//   node scripts/test-slice-mirrors.mjs
import { readFileSync } from 'node:fs';
import { TABLE_SLICES, PHASE, tableOwnedSliceKeys, strippedSliceKeys } from '../src/store/tableSlices.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const sync = readFileSync(new URL('../src/store/sync.js', import.meta.url), 'utf8');

// Extract the SLICE_MIRRORS keys from sync.js. It cannot be imported (it pulls in the
// Supabase client), so this is a source scan — deliberately anchored on the literal
// declaration so a rename fails loudly rather than silently matching nothing.
const block = (sync.match(/const SLICE_MIRRORS = \{([\s\S]*?)\n {2}\};/) || [])[1];
ok('SLICE_MIRRORS is declared in sync.js', typeof block === 'string' && block.length > 0);
const mirrored = new Set([...(block || '').matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)].map((m) => m[1]));
ok(`the scan found at least one mirror (found: ${[...mirrored].join(', ') || 'none'})`, mirrored.size > 0);

// ── 🔴 THE INVARIANT ─────────────────────────────────────────────────────
const registered = tableOwnedSliceKeys();
const missing = registered.filter((k) => !mirrored.has(k));
ok(`EVERY table-owned slice has a mirror (registered: ${registered.join(', ')}; missing: ${missing.join(', ') || 'none'})`,
  missing.length === 0);

// The reverse is a smell rather than a bug — a mirror for a slice nobody registered
// is dead code, and usually means a registration was reverted without its dispatcher.
const orphan = [...mirrored].filter((k) => !registered.includes(k));
ok(`no orphan mirrors (${orphan.join(', ') || 'none'})`, orphan.length === 0);

// ── the dispatcher must FAIL LOUD, not silently succeed ─────────────────
// If a missing mirror returned true, mirrorSlices would report success and the caller
// would advance its baseline — reproducing the exact loss this guards against.
ok('mirrorSlices exists and iterates the registry',
  /async function mirrorSlices\s*\(/.test(sync) && /for \(const key of tableOwnedSliceKeys\(\)\)/.test(sync));
ok('a missing mirror logs an ERROR (not a warn, not silence)',
  /console\.error\([^)]*SLICE_MIRRORS/.test(sync) || /has no mirror/.test(sync));
ok('a missing mirror marks the flush as FAILED', /allOk = false;/.test(sync));
ok('flush no longer narrows to a hardcoded jobs slice', !/const jobsNow = sliceNow\.jobs/.test(sync));
// All THREE flush outcomes (content-guard no-op, committed, CAS conflict) mirror
// through the registry-driven mirrorSlices — the conflict path was added 2026-08-13
// (jobs writes must not be starved by blob CAS contention). Each site captures the
// LIVE slices at mirror time (liveSlices()), never a flush-start snapshot: a stale
// snapshot re-POSTs rows a peer advanced mid-flush, overwriting newer data.
ok('all flush paths dispatch through mirrorSlices on live slices',
  (sync.match(/mirrorSlices\(liveSlices\(\)\)/g) || []).length >= 3);

// ── the registry's own invariants (regression cover for 0.3) ────────────
ok('jobs is registered', registered.includes('jobs'));
ok('jobs is at phase stripped (what ships today)',
  TABLE_SLICES.find((s) => s.key === 'jobs')?.phase === PHASE.STRIPPED);
ok('stripped is a subset of table-owned', strippedSliceKeys().every((k) => registered.includes(k)));
ok('every entry has a key, a table and a phase',
  TABLE_SLICES.every((s) => s.key && s.table && (s.phase === PHASE.MIRROR || s.phase === PHASE.STRIPPED)));
ok('no duplicate slice keys', new Set(registered).size === registered.length);
// A slice cannot be stripped from the blob unless something mirrors it — otherwise the
// data exists nowhere. This is the composition of the two invariants above and is the
// single most dangerous combination in the registry.
ok('NO stripped slice lacks a mirror', strippedSliceKeys().every((k) => mirrored.has(k)));

console.log(`\nslice mirrors: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
