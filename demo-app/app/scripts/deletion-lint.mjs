// deletion-lint.mjs — the artifact gate + ledger generator for the deletion-ripple audit.
//
// Modes (endpoint-lint.mjs two-mode precedent):
//   node scripts/deletion-lint.mjs                # GATE: reconcile manifest vs a fresh
//                                                 #   enumeration; exit 1 on any UNCLASSIFIED
//                                                 #   touchpoint, stale manifest entry, or
//                                                 #   (once wired) ledger drift.
//   node scripts/deletion-lint.mjs --bootstrap    # merge newly-enumerated cells into
//                                                 #   deletion.manifest.json as UNCLASSIFIED,
//                                                 #   preserving every existing classification.
//   node scripts/deletion-lint.mjs --write        # regenerate DELETION_LEDGER.md   (Phase C)
//   node scripts/deletion-lint.mjs --matrix       # regenerate deletion-matrix.html (Phase C)
//
// THE LAW (BUILD_INTEGRITY audit-rigor): coverage is mechanical + reconciles; "a new
// unclassified touchpoint fails the check (CI-enforced)". This file is that check for the
// deletion domain. It NEVER touches app/api (stripped from main); the server section is
// classified statically from source, so the gate runs on every branch.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadStore, enumerateUniverse } from './deletion-core.mjs';

const MANIFEST = fileURLToPath(new URL('../deletion.manifest.json', import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

// The set of field-leaves + excluded-leaves + source-locals a manifest accounts for,
// used to reconcile the N2 source-grep name universe.
function leavesOf(m) {
  const leaf = (cell) => cell.replace(/^\$\./, '').split('.').pop().replace(/\{(key|value)\}/, '').replace(/\[\]$/, '');
  const s = new Set();
  for (const k of Object.keys(m.fields || {})) s.add(leaf(k));
  for (const k of Object.keys(m.excluded || {})) s.add(leaf(k));
  for (const n of m.sourceLocals || []) s.add(n);
  return s;
}

const store = await loadStore();
const { INITIAL_STATE } = store;
// Optional fixtures enrich the enumeration so empty-in-seed slices surface their cells.
let enrich = (s) => s;
let fixtures = null;
try {
  fixtures = await import('./deletion-fixtures.mjs');
  if (typeof fixtures.enrichState === 'function') enrich = fixtures.enrichState;
} catch { /* fixtures not built yet (Phase A) */ }

const universe = enumerateUniverse(enrich(structuredClone(INITIAL_STATE)));
const enumeratedCells = [...universe.cells.keys()].sort();

if (has('--bootstrap')) {
  const m = loadManifest() || {
    version: 1,
    note: 'Deletion-ripple FK law book. Hand-classified; reconciled against a mechanical enumeration by deletion-lint.mjs. Policy vocabulary: SWEEP / NULLIFY / NULLIFY+name / REPOINT / BLOCK / KEEP-BY-DESIGN / EXTERNAL-NOT-FK / IDENTITY / NOT-EXERCISABLE. Disputed cells carry "decision".',
    targets: {}, fields: {}, excluded: {}, sourceLocals: [], actions: {},
  };
  let added = 0;
  for (const cell of enumeratedCells) {
    if (m.fields[cell] || m.excluded[cell]) continue;
    const info = universe.cells.get(cell);
    m.fields[cell] = {
      target: [...info.targets][0] || 'UNKNOWN',
      kind: info.kind,
      policy: 'UNCLASSIFIED',
      nets: [...info.nets].join('+'),
    };
    added += 1;
  }
  // Record the delete-action universe as UNCLASSIFIED modes too.
  for (const [name, where] of universe.actions) {
    if (m.actions[name]) continue;
    m.actions[name] = { mode: 'UNCLASSIFIED', case: where };
    added += 1;
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n', 'utf8');
  console.log(`\ndeletion-lint --bootstrap: manifest now has ${Object.keys(m.fields).length} fields · ${Object.keys(m.actions).length} actions (+${added} new UNCLASSIFIED)\n`);
  process.exit(0);
}

// ── GATE ─────────────────────────────────────────────────────────────────────
const m = loadManifest();
if (!m) {
  console.error('\n✖ deletion.manifest.json does not exist. Bootstrap it:');
  console.error('    node app/scripts/deletion-lint.mjs --bootstrap\n');
  process.exit(1);
}

// ── ledger artifact: --write regenerates, --matrix writes the HTML grid, and the
//    default gate diffs the committed ledger's verdicts against a fresh audit. ──
const LEDGER = fileURLToPath(new URL('../../DELETION_LEDGER.md', import.meta.url));
const MATRIX = fileURLToPath(new URL('../../deletion-matrix.html', import.meta.url));
const BASELINE = fileURLToPath(new URL('../deletion.baseline.json', import.meta.url));
const readBaseline = () => (fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { accepted: {} });

async function auditNow() {
  const harness = await import('./deletion-harness.mjs');
  return harness.runAudit(store, m, fixtures);
}

if (has('--write') || has('--matrix')) {
  const ledger = await import('./deletion-ledger.mjs');
  const { results } = await auditNow();
  const baseline = readBaseline();
  if (has('--write')) {
    const md = ledger.buildLedgerMarkdown({ results, manifest: m, baseline, enumerated: enumeratedCells.length, classified: new Set([...Object.keys(m.fields), ...Object.keys(m.excluded)]).size });
    fs.writeFileSync(LEDGER, md, 'utf8');
    console.log(`\ndeletion-lint --write: wrote DELETION_LEDGER.md (${results.length} cells)`);
  }
  if (has('--matrix')) {
    fs.writeFileSync(MATRIX, ledger.buildMatrixHtml({ results, baseline }), 'utf8');
    console.log(`deletion-lint --matrix: wrote deletion-matrix.html`);
  }
  console.log('');
  process.exit(0);
}

const classified = new Set([...Object.keys(m.fields), ...Object.keys(m.excluded)]);
const enumSet = new Set(enumeratedCells);

// 1. Every enumerated cell must be classified (field or excluded). Unclassified → fail.
const unclassified = enumeratedCells.filter((c) => !classified.has(c));
const stillUnclassifiedPolicy = Object.entries(m.fields)
  .filter(([, v]) => v.policy === 'UNCLASSIFIED').map(([k]) => k);

// 2. Every manifest field/excluded must still be enumerated (stale entry → fail),
//    EXCEPT entries flagged notExercisable (a real cell fixtures can't yet populate).
const stale = [...classified].filter((c) => !enumSet.has(c)
  && !(m.fields[c]?.policy === 'NOT-EXERCISABLE') && !(m.excluded[c]?.reason));

// 3. Action universe: every delete-family action classified.
const unclassifiedActions = [...universe.actions.keys()].filter((a) => !m.actions[a] || m.actions[a].mode === 'UNCLASSIFIED');

// 4. N2 name reconciliation: every source-grep name resolves to a classified leaf or a
//    declared source-local. Unaccounted id-shaped names are surfaced (warn, not fail —
//    high reducer-local false-positive rate; the adversarial pass audits this list).
const accountedLeaves = leavesOf(m);
const unaccountedNames = [...universe.names.keys()].filter((n) => !accountedLeaves.has(n));

const counts = {
  enumerated: enumeratedCells.length,
  classified: classified.size,
  actions: universe.actions.size,
};
console.log(`\ndeletion-lint — ${counts.enumerated} cells enumerated · ${Object.keys(m.fields).length} fields + ${Object.keys(m.excluded).length} excluded classified · ${counts.actions} delete actions`);

const problems = [];
if (unclassified.length) problems.push(['ENUMERATED but not in the manifest (classify as field or excluded)', unclassified]);
if (stillUnclassifiedPolicy.length) problems.push(['MANIFEST field with policy UNCLASSIFIED (assign a policy)', stillUnclassifiedPolicy]);
if (stale.length) problems.push(['IN THE MANIFEST but no longer enumerated (stale — remove or mark NOT-EXERCISABLE)', stale]);
if (unclassifiedActions.length) problems.push(['DELETE-FAMILY ACTION not classified in manifest.actions', unclassifiedActions]);

// 5. Ledger drift: the committed DELETION_LEDGER.md verdicts must match a fresh audit.
//    A behavior change (a fix, or a regression) that isn't reflected in the ledger fails.
const ledgerDrift = [];
if (fixtures) {
  if (!fs.existsSync(LEDGER)) {
    ledgerDrift.push('DELETION_LEDGER.md is missing — regenerate it');
  } else {
    const ledgerMod = await import('./deletion-ledger.mjs');
    const committed = ledgerMod.parseLedger(fs.readFileSync(LEDGER, 'utf8'));
    const { results } = await auditNow();
    const fresh = new Map(results.map((r) => [`${r.action}×${r.cell}`, r.verdict]));
    for (const [key, v] of fresh) if (committed.get(key) !== v) ledgerDrift.push(`${key}: ledger=${committed.get(key) || '(missing)'} · fresh=${v}`);
    for (const key of committed.keys()) if (!fresh.has(key)) ledgerDrift.push(`${key}: in ledger but not in a fresh audit`);
  }
  if (ledgerDrift.length) problems.push(['LEDGER DRIFT (regenerate: npm --prefix app run lint:deletions -- --write)', ledgerDrift]);
}

if (unaccountedNames.length) {
  console.warn(`\n⚠ ${unaccountedNames.length} source-grep name(s) not yet mapped to a field/excluded/source-local (review — likely reducer locals):`);
  console.warn('    ' + unaccountedNames.join('  '));
}

if (problems.length) {
  for (const [title, items] of problems) {
    console.error(`\n✖ ${title} (${items.length}):`);
    for (const i of items) console.error(`    ${i}`);
  }
  console.error('\n  Bootstrap new cells:  node app/scripts/deletion-lint.mjs --bootstrap');
  console.error('  Then classify each in app/deletion.manifest.json.\n');
  process.exit(1);
}
console.log('  ✓ every enumerated cell classified · no stale entries · every delete action has a mode');
console.log(`  RECONCILE: enumerated ${counts.enumerated} == classified (fields+excluded) matched · actions ${counts.actions} all moded\n`);
