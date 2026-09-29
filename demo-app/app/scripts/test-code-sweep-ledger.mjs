// Regression suite for scripts/code-sweep-ledger.mjs — the P0 code-sweep enumerator
// (DEV_PLAYBOOK 2.0.1). Offline, pure: it exercises the ownership rule table, the
// universe/EXCLUDE filters, the merge that preserves reviewed rows, and --check's
// two failure modes (a changed blob → unreviewed, and a file that matches no rule).
// No git, no network. Run: node scripts/test-code-sweep-ledger.mjs
import assert from 'node:assert/strict';
const M = await import('./code-sweep-ledger.mjs');
const {
  ownerPhase, isExcludedFromUniverse, excludeTableReason,
  parseLedgerRows, buildLedgerRows, renderLedger, runCheck,
  LIB_P4, LIB_P5,
} = M;

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

// ── ownership rule table: first match wins (2.0.1) ───────────────────────────
ok('css under app/src is P8 even when under lib (css rule is first)', () => {
  assert.equal(ownerPhase('app/src/index.css'), 'P8');
  assert.equal(ownerPhase('app/src/lib/whatever.css'), 'P8'); // css beats the P4 lib rule
  assert.equal(ownerPhase('app/src/theme.css'), 'P8');
});
ok('P2 owns scripts, tests, .github, config, env, gitignore', () => {
  assert.equal(ownerPhase('app/scripts/foo.mjs'), 'P2');
  assert.equal(ownerPhase('app/tests/foo.spec.js'), 'P2');
  assert.equal(ownerPhase('.github/workflows/ci.yml'), 'P2');
  assert.equal(ownerPhase('app/package.json'), 'P2');
  assert.equal(ownerPhase('app/vite.config.js'), 'P2');
  assert.equal(ownerPhase('app/playwright.config.js'), 'P2');
  assert.equal(ownerPhase('app/.env.demo'), 'P2');
  assert.equal(ownerPhase('app/.gitignore'), 'P2');
  assert.equal(ownerPhase('supabase/config.toml'), 'P2');
});
ok('P3 owns api, migrations, vercel.json and src/auth (auth beats the P5 catch-all)', () => {
  assert.equal(ownerPhase('app/api/state/org-state.js'), 'P3');
  assert.equal(ownerPhase('app/api/_lib/time/store.js'), 'P3');
  assert.equal(ownerPhase('supabase/migrations/20260101_x.sql'), 'P3');
  assert.equal(ownerPhase('app/vercel.json'), 'P3');
  assert.equal(ownerPhase('app/src/auth/AuthProvider.jsx'), 'P3');
});
ok('P4 owns store and the explicit data/sync/money/time lib list', () => {
  assert.equal(ownerPhase('app/src/store/reducer.js'), 'P4');
  assert.equal(ownerPhase('app/src/lib/money.js'), 'P4');
  assert.equal(ownerPhase('app/src/lib/dates.js'), 'P4');
  assert.equal(ownerPhase('app/src/lib/timeApi.js'), 'P4');
  assert.equal(ownerPhase('app/src/lib/reports/calledOut.js'), 'P4');
});
ok('P5 owns pages/components/hooks/layouts/data/brand/App.jsx and the rest of lib', () => {
  assert.equal(ownerPhase('app/src/pages/Variance.jsx'), 'P5');
  assert.equal(ownerPhase('app/src/components/Modal.jsx'), 'P5');
  assert.equal(ownerPhase('app/src/hooks/useX.js'), 'P5');
  assert.equal(ownerPhase('app/src/layouts/AppLayout.jsx'), 'P5');
  assert.equal(ownerPhase('app/src/data/seed.js'), 'P5');
  assert.equal(ownerPhase('app/src/App.jsx'), 'P5');
  assert.equal(ownerPhase('app/src/brand/doc.js'), 'P5');
  assert.equal(ownerPhase('app/src/lib/roles.js'), 'P5');      // grep candidate classified P5
  assert.equal(ownerPhase('app/src/lib/masterSearch/rank.js'), 'P5');
});
ok('the 9 orchestrator-promoted lib files resolve to P4 (DATA lens), not P5', () => {
  for (const p of [
    'app/src/lib/variance.js', 'app/src/lib/canonicalJson.js', 'app/src/lib/retention.js',
    'app/src/lib/timeMerge.js', 'app/src/lib/opsAlerts.js', 'app/src/lib/opsAlertApply.js',
    'app/src/lib/attendanceReport.js', 'app/src/lib/reports/qcReports.js', 'app/src/lib/seriesScope.js',
  ]) {
    assert.equal(ownerPhase(p), 'P4', p);
    assert.equal(LIB_P4.has(p), true, `${p} in LIB_P4`);
    assert.equal(LIB_P5.has(p), false, `${p} no longer in LIB_P5`);
  }
});
ok('a NEW lib file (in neither list) defaults to P4 until reclassified', () => {
  assert.equal(ownerPhase('app/src/lib/brandNewDataThing.js'), 'P4');
  assert.equal(LIB_P4.has('app/src/lib/brandNewDataThing.js'), false);
  assert.equal(LIB_P5.has('app/src/lib/brandNewDataThing.js'), false);
});
ok('P7 owns main.jsx, index.html and public (main.jsx is NOT P5)', () => {
  assert.equal(ownerPhase('app/src/main.jsx'), 'P7');
  assert.equal(ownerPhase('app/index.html'), 'P7');
  assert.equal(ownerPhase('app/public/sw.js'), 'P7');
});
ok('LIB_P4 and LIB_P5 are disjoint', () => {
  for (const p of LIB_P4) assert.equal(LIB_P5.has(p), false, `${p} in both`);
});

// ── universe exclusions (the "minus" in 2.0.1) ───────────────────────────────
ok('binary assets, *.md, screenshots, lockfile and *.baseline.json are excluded', () => {
  assert.ok(isExcludedFromUniverse('app/public/icon-512.png'));
  assert.ok(isExcludedFromUniverse('app/public/brand.woff2'));
  assert.ok(isExcludedFromUniverse('README.md'));
  assert.ok(isExcludedFromUniverse('app/src/STRUCTURE.md'));
  assert.ok(isExcludedFromUniverse('app/tests/visual/__screenshots__/x.png'));
  assert.ok(isExcludedFromUniverse('app/package-lock.json'));
  assert.ok(isExcludedFromUniverse('app/wiring.baseline.json'));
});
ok('real source is NOT universe-excluded', () => {
  assert.equal(isExcludedFromUniverse('app/src/store/reducer.js'), null);
  assert.equal(isExcludedFromUniverse('app/api/foo.js'), null);
});

// ── EXCLUDE table: tracked, survives the universe filter, owned by no phase ───
ok('generated design-system + generated brand tokens are EXCLUDE-tabled', () => {
  assert.ok(excludeTableReason('app/design-system/tokens.json'));
  assert.ok(excludeTableReason('app/design-system/components.json'));
  assert.ok(excludeTableReason('app/src/brand/tokens.generated.js'));
});
ok('ordinary source is not in the EXCLUDE table', () => {
  assert.equal(excludeTableReason('app/src/store/reducer.js'), null);
  assert.equal(excludeTableReason('app/src/brand/doc.js'), null); // hand source → owned (P5)
});
ok('design-system/tokens.config.json is carved out to P8; the generated mirror stays excluded', () => {
  assert.equal(excludeTableReason('app/design-system/tokens.config.json'), null); // not excluded
  assert.equal(ownerPhase('app/design-system/tokens.config.json'), 'P8');         // hand source → UX lens
  assert.ok(excludeTableReason('app/design-system/tokens.json'));                 // generated → still excluded
  assert.ok(excludeTableReason('app/design-system/components.json'));
});

// ── merge preserves a review at the same blob, blanks it when the blob changes ─
const seed = [
  { path: 'app/src/lib/money.js', blob: 'AAA', lines: 10 },
  { path: 'app/src/store/reducer.js', blob: 'BBB', lines: 20 },
];
const reviewedMd = renderLedger(buildLedgerRows(seed, new Map([
  ['app/src/lib/money.js', { reviewedBlob: 'AAA', lens: 'DATA', linesRead: '1-10', findings: 'none', date: '2026-09-25' }],
])));

ok('a review at the current blob is preserved on regen', () => {
  const rows = parseLedgerRows(reviewedMd);
  assert.equal(rows.get('app/src/lib/money.js').reviewedBlob, 'AAA');
  assert.equal(rows.get('app/src/lib/money.js').findings, 'none');
});
ok('a changed blob drops the review (row present, review cols blank) — "unreviewed again"', () => {
  const existing = parseLedgerRows(reviewedMd);
  const moved = [{ path: 'app/src/lib/money.js', blob: 'CCC', lines: 11 }]; // blob AAA -> CCC
  const rows = parseLedgerRows(renderLedger(buildLedgerRows(moved, existing)));
  assert.equal(rows.get('app/src/lib/money.js').reviewedBlob, ''); // no longer reviewed
  assert.equal(rows.get('app/src/lib/money.js').lines, '11');       // line count refreshed
});

// ── --check: two failure modes ───────────────────────────────────────────────
ok('--check <phase> passes when every owned file has a review row at its blob', () => {
  const universe = [{ path: 'app/src/lib/money.js', blob: 'AAA', lines: 10 }];
  const existing = new Map([['app/src/lib/money.js', { reviewedBlob: 'AAA' }]]);
  assert.equal(runCheck('P4', universe, existing).failures.length, 0);
});
ok('--check fails a changed blob (owned file unreviewed at current blob)', () => {
  const universe = [{ path: 'app/src/lib/money.js', blob: 'CCC', lines: 10 }];
  const existing = new Map([['app/src/lib/money.js', { reviewedBlob: 'AAA' }]]);
  const { failures } = runCheck('P4', universe, existing);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].path, 'app/src/lib/money.js');
});
ok('--check fails a file that matches no rule (unowned), regardless of the phase asked', () => {
  const universe = [{ path: 'app/frobnicate.xyz', blob: 'ZZZ', lines: 3 }];
  const { failures } = runCheck('P4', universe, new Map());
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /no (rule|owner)/i);
});
ok('--check ignores EXCLUDE-tabled files (owned by no rule, but excused)', () => {
  const universe = [{ path: 'app/design-system/tokens.json', blob: 'D', lines: 5 }];
  assert.equal(runCheck('P4', universe, new Map()).failures.length, 0);
});

console.log(`\ntest-code-sweep-ledger: ${pass}/${pass} assertions passed ✓\n`);
