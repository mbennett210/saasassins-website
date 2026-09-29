// Regression suite for scripts/check-phase-lists.mjs (DEV_PLAYBOOK 2.0). Offline, pure.
// It exercises the check-id range/prefix parser (the phase "Checks:" lists use ranges,
// "to", prefix-carried bare numbers and prose descriptors), the catalog Phase(s) parse,
// and the two failure modes: a catalog row tagged for a phase but missing from that
// phase's list, and a listed ID that exists in no catalog.
// Run: node scripts/test-check-phase-lists.mjs
import assert from 'node:assert/strict';
const M = await import('./check-phase-lists.mjs');
const { canonicalId, expandChecksList, parseCatalogRows, parsePhaseLists, reconcile } = M;

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };
const S = (set) => [...set].sort();

// ── canonicalId: strip zero-padding on the numeric suffix; keep multi-part prefixes ──
ok('canonicalId normalizes zero-padding, keeps sub-family prefixes', () => {
  assert.equal(canonicalId('SEC-01'), 'SEC-1');
  assert.equal(canonicalId('SEC-1'), 'SEC-1');
  assert.equal(canonicalId('TEST-E2E-09'), 'TEST-E2E-9');
  assert.equal(canonicalId('OPS-AG-16'), 'OPS-AG-16');
});

// ── expandChecksList: ranges, "to", prefix-carry, parens/colon descriptors, prose ──
ok('en-dash range expands, prefix carried', () => {
  assert.deepEqual(S(expandChecksList('SEC-01–03, 05')), ['SEC-1', 'SEC-2', 'SEC-3', 'SEC-5']);
});
ok('"to" range with a bare right endpoint carries the sub-family prefix', () => {
  assert.deepEqual(S(expandChecksList('TEST-NET-01 to 04')), ['TEST-NET-1', 'TEST-NET-2', 'TEST-NET-3', 'TEST-NET-4']);
});
ok('"to" range with a full right endpoint', () => {
  assert.deepEqual(S(expandChecksList('TEST-AUTHZ-01 to TEST-AUTHZ-03')), ['TEST-AUTHZ-1', 'TEST-AUTHZ-2', 'TEST-AUTHZ-3']);
});
ok('bare numbers carry the last full prefix', () => {
  assert.deepEqual(S(expandChecksList('DATA-10, 29, 30')), ['DATA-10', 'DATA-29', 'DATA-30']);
});
ok('a "(NN):" descriptor and trailing prose are ignored, real IDs after "plus" are kept', () => {
  const got = S(expandChecksList('SECURITY rows with P3 (63): SEC-01–02, plus the SECURITY per-role negative matrix; DATA-35'));
  assert.deepEqual(got, ['DATA-35', 'SEC-1', 'SEC-2']);
});
ok('a semicolon starts a new family; en-dash chains inside one family', () => {
  const got = S(expandChecksList('PERF-01–03, 05; UX-01, UX-02'));
  assert.deepEqual(got, ['PERF-1', 'PERF-2', 'PERF-3', 'PERF-5', 'UX-1', 'UX-2']);
});
ok('prose with stray numbers ("Tools 1-15", "budget template") yields no IDs', () => {
  assert.deepEqual(S(expandChecksList('with Tools 1-15 and the budget template')), []);
});

// ── catalog parse: ID column + Phase(s) column ───────────────────────────────
const CATALOG = [
  '| ID | Check | How to verify | Phase(s) | Clean Space note |',
  '|---|---|---|---|---|',
  '| SEC-01 | RLS enabled | sql | P0 baseline, P3; after every migration | — |',
  '| SEC-02 | advisors clean | cli | P1, P3 | — |',
  '| DATA-35 | every data-op | proc | P4 | — |',
  '| TEST-E2E-09 | drive | pw | P5, P10 | — |',
].join('\n');

ok('parseCatalogRows reads the ID and every P# in the Phase(s) column', () => {
  const rows = parseCatalogRows(CATALOG);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual(S(byId.get('SEC-1').phases), ['P0', 'P3']);
  assert.deepEqual(S(byId.get('SEC-2').phases), ['P1', 'P3']);
  assert.deepEqual(S(byId.get('DATA-35').phases), ['P4']);
  assert.deepEqual(S(byId.get('TEST-E2E-9').phases), ['P10', 'P5']);
});

// ── reconcile: the two failure modes ─────────────────────────────────────────
const catRows = parseCatalogRows(CATALOG);

ok('reconcile is clean when every tagged row is listed and every listed ID exists', () => {
  const lists = new Map([
    ['P0', expandChecksList('SEC-01')],
    ['P1', expandChecksList('SEC-02')],
    ['P3', expandChecksList('SEC-01, SEC-02')],
    ['P4', expandChecksList('DATA-35')],
    ['P5', expandChecksList('TEST-E2E-09')],
    ['P10', expandChecksList('TEST-E2E-09')],
  ]);
  const { missing, unknown } = reconcile(catRows, lists);
  assert.equal(missing.length, 0, JSON.stringify(missing));
  assert.equal(unknown.length, 0, JSON.stringify(unknown));
});

ok('MISSING: a catalog row tagged P3 but absent from P3’s list fails', () => {
  const lists = new Map([
    ['P0', expandChecksList('SEC-01')],
    ['P1', expandChecksList('SEC-02')],
    ['P3', expandChecksList('SEC-01')],          // SEC-02 (tagged P3) dropped
    ['P4', expandChecksList('DATA-35')],
    ['P5', expandChecksList('TEST-E2E-09')],
    ['P10', expandChecksList('TEST-E2E-09')],
  ]);
  const { missing } = reconcile(catRows, lists);
  assert.ok(missing.some((m) => m.phase === 'P3' && m.id === 'SEC-2'), JSON.stringify(missing));
});

ok('UNKNOWN: an ID listed in a phase but present in no catalog fails', () => {
  const lists = new Map([
    ['P0', expandChecksList('SEC-01')],
    ['P1', expandChecksList('SEC-02')],
    ['P3', expandChecksList('SEC-01, SEC-02, SEC-999')], // SEC-999 does not exist
    ['P4', expandChecksList('DATA-35')],
    ['P5', expandChecksList('TEST-E2E-09')],
    ['P10', expandChecksList('TEST-E2E-09')],
  ]);
  const { unknown } = reconcile(catRows, lists);
  assert.ok(unknown.some((u) => u.phase === 'P3' && u.id === 'SEC-999'), JSON.stringify(unknown));
});

// ── phase-list parse from a DEV_PLAYBOOK-shaped fragment ─────────────────────
const DEV = [
  '### P0 — Orient & re-baseline',
  '**Inputs.**',
  '- Checks: SEC-01, DATA-01.',
  '### P10 — Release readiness & sign-off',
  '- Checks (P10 rows): SEC-02, 03; DATA-35.',
].join('\n');

ok('parsePhaseLists handles "- Checks:" and "- Checks (P10 rows):"', () => {
  const lists = parsePhaseLists(DEV);
  assert.deepEqual(S(lists.get('P0')), ['DATA-1', 'SEC-1']);
  assert.deepEqual(S(lists.get('P10')), ['DATA-35', 'SEC-2', 'SEC-3']);
});

console.log(`\ntest-check-phase-lists: ${pass}/${pass} assertions passed ✓\n`);
