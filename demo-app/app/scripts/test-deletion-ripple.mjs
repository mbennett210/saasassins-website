// The deletion-ripple CI suite (auto-discovered by run-tests.mjs; offline — imports only
// the pure store). For every (delete action × reference cell) it dispatches the REAL
// delete against fixture-enriched seed and verdicts the result: a surviving reference to
// the deleted record is a DANGLING orphan. A cell PASSES when it clears as its manifest
// policy requires, or when it is a KNOWN finding accepted in deletion.baseline.json.
//
//   node app/scripts/test-deletion-ripple.mjs
//
// The regression mechanism (BUILD_INTEGRITY §6a — a fix's test must fail pre-fix): when a
// dangle is fixed its verdict flips to a clear, and this suite then FAILS on the now-stale
// baseline entry until it is removed — so the green is proof the fix landed, and the red
// ledger row in git history is proof it was broken.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadStore, loadManifest, runAudit } from './deletion-harness.mjs';
import * as fixtures from './deletion-fixtures.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('../deletion.baseline.json', import.meta.url)), 'utf8'));
const accepted = baseline.accepted || {};
const store = await loadStore();
const manifest = loadManifest();
const { results, unmapped } = runAudit(store, manifest, fixtures);

const keyOf = (r) => `${r.action}×${r.cell}`;
const failKeys = new Set(results.filter((r) => !r.pass).map(keyOf));

// ── one assertion per (action × cell): its name IS the ledger evidence id ──
for (const r of results) {
  const key = keyOf(r);
  const baselined = key in accepted;
  ok(r.pass || baselined, `DL ${key} → ${r.verdict}` + (baselined ? ` (accepted ${accepted[key].dr})` : ''));
}

// ── coverage: no cell may pass vacuously (every manifest cell witnessed by a fixture) ──
const notExercised = results.filter((r) => r.verdict === 'NOT-EXERCISED').map((r) => r.cell);
ok(notExercised.length === 0, `RIPPLE coverage: every audited cell is exercised (${notExercised.join(', ')})`);

// ── safety net: no dangle at a path the manifest never classified ──
ok(unmapped.length === 0, `RIPPLE scan: no dangle at an unmapped path (${[...new Set(unmapped.map((u) => u.path))].slice(0, 6).join(', ')})`);

// ── baseline hygiene: a fixed cell must be removed from the baseline ──
const staleBaseline = Object.keys(accepted).filter((k) => !failKeys.has(k));
ok(staleBaseline.length === 0, `RIPPLE baseline: no stale accepted entry — these now PASS, remove them: ${staleBaseline.join(', ')}`);

// ── pinned regressions: the shipped LW fixes must stay green ──
const byKey = Object.fromEntries(results.map((r) => [keyOf(r), r]));
// (LW-01's supply pins retired with SUP-13: the supply rows left the blob, and a deleted customer's
// list and requests are deleted from their tables by the org-state route — test-supplies-route.mjs.)
ok(byKey['DELETE_TAG×marketingSequences[].replyTags']?.pass, 'LW-02: DELETE_TAG still scrubs marketingSequences.replyTags (regression pin)');
// CS-663 (Matt: "Never delete customers"): there is no customer delete to ripple — the archive
// replaces it, so every cell that names a customer or its site has no delete path to fire.
ok(!('DELETE_CLIENT' in store.ACTIONS), 'CS-663: customers are archived, never deleted (no DELETE_CLIENT)');
ok(Object.values(manifest.fields).filter((s) => s.target === 'clients' || s.target === 'sites').every((s) => s.policy === 'NOT-EXERCISABLE'),
  'CS-663: every customer and site reference cell is NOT-EXERCISABLE (nothing deletes either)');

// ── coverage: every exercisable cell must be audited by some scenario ──
// A cell is covered when a scenario verdicts it (by its target or its explicit cell list).
// NOT-EXERCISABLE cells are exempt (no delete path exists to fire the ripple).
const coveredCells = new Set(results.map((r) => r.cell));
const pending = Object.entries(manifest.fields)
  .filter(([c, s]) => s.policy !== 'NOT-EXERCISABLE' && !coveredCells.has(c))
  .map(([c]) => c);
ok(pending.length === 0, `RIPPLE coverage: every exercisable cell is scenario-audited (${pending.length} pending: ${pending.slice(0, 8).join(', ')})`);

const dangling = results.filter((r) => !r.pass && r.verdict === 'DANGLING').length;
console.log(`\n${pass}/${pass + fail} deletion-ripple assertions passed  ·  ${results.length} cells audited across ${new Set(results.map((r) => r.action)).size} delete actions · ${dangling} DANGLING (accepted) · ${unmapped.length} unmapped · ${pending.length} pending`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
