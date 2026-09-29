// test-playbook-cs-lists.mjs — offline suite for playbook-cs-lists.mjs (auto-discovered by
// run-tests.mjs). Three halves:
//   1. FIXTURE tests of the pure functions — parse, grouping/counts, run compression,
//      annotation handling, and round-trip/drift through planPlaybookUpdate on BOTH LF and
//      CRLF fixtures (bytes preserved either way).
//   2. A REGRESSION for the CI break: the LF form of the REAL files — exactly what a Linux CI
//      runner checks out (the repo stores LF; core.autocrlf only shows CRLF in a Windows
//      working tree). The tool must parse, plan and stay LF. This threw on the pre-fix tool
//      ("coverage-table header not found") because it split on '\r\n' only.
//   3. A REAL-FILES gate: it runs `playbook-cs-lists.mjs --check` against the actual
//      DEV_PLAYBOOK.md + FINDINGS_REGISTER.md and requires exit 0 — CI (and the full ladder)
//      fail if someone edits the register without running `--write`, making DEV_PLAYBOOK §2.0's
//      standing rule ("the register wins; fix this part in the same commit") enforced.
//
//   node app/scripts/test-playbook-cs-lists.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseRegisterIndex,
  computeCoverage,
  compressRuns,
  renderPhaseBody,
  renderPhaseLine,
  renderTableRows,
  extractAnnotation,
  bodyToNums,
  planPlaybookUpdate,
  csId,
  PHASES,
} from './playbook-cs-lists.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond) => { if (cond) pass += 1; else { fail += 1; console.error(`✖ ${name}`); } };
const throws = (name, fn) => { try { fn(); ok(name, false); } catch { ok(name, true); } };
const countEol = (s, eol) => s.split(eol).length - 1;
// A "foreign" line ending for the chosen EOL: for LF, any CR at all; for CRLF, a lone LF.
const hasForeignEol = (s, eol) => (eol === '\n' ? s.includes('\r') : /(^|[^\r])\n/.test(s));

// ── a tiny synthetic register INDEX, one+ entry per phase ─────────────────────
const row = (n, sev, area, phase, status) =>
  `| [${csId(n)}](#cs-${String(n).padStart(3, '0')}) | ${sev} | ${area} | Sample title ${n} | ${phase} | V | ${status} |`;

const FIXTURE_INDEX = [
  '## INDEX',
  '',
  '| ID | Sev | Area | Title | Phase | Evidence | Status |',
  '|---|---|---|---|---|---|---|',
  row(40, 'Low', 'DOC', 'P0', 'verified'),
  row(1, 'Critical', 'SEC', 'P1', 'needs-decision (Mike)'),
  row(2, 'Critical', 'SEC', 'P1', 'verified'),
  row(10, 'High', 'FUNC', 'P1', 'verified'),
  row(11, 'High', 'FUNC', 'P1', 'verified'),
  row(12, 'High', 'FUNC', 'P1', 'verified'),
  row(13, 'High', 'FUNC', 'P1', 'verified'), // CS-010..013 → a 4-run, compresses
  row(20, 'Medium', 'UX', 'P2', 'verified'),
  row(21, 'Medium', 'UX', 'P2', 'verified'), // CS-020,021 → a 2-run, stays listed
  row(30, 'Low', 'DOC', 'P2', 'needs-decision (Matt)'),
  row(50, 'Medium', 'DATA', 'P3', 'verified'),
  row(60, 'High', 'INT', 'P4', 'verified'),
  row(65, 'Medium', 'PERF', 'P5', 'verified'),
  row(66, 'Low', 'OPS', 'P6', 'verified'),
  row(67, 'Low', 'TEST', 'P7', 'verified'),
  row(68, 'Low', 'UX', 'P8', 'verified'),
  row(69, 'Low', 'SCOPE', 'P9', 'verified'),
  row(70, 'High', 'SCOPE', 'P10', 'verified'),
  '',
  '## Entries: Critical', // out-of-INDEX section — its CS row must be ignored
  '| [CS-999](#cs-999) | Low | DOC | outside the index | P2 | C | verified |',
  '',
].join('\r\n');

// ── 1. parse ─────────────────────────────────────────────────────────────────
const rows = parseRegisterIndex(FIXTURE_INDEX);
ok('parse: 18 rows (ignores the row outside the INDEX section)', rows.length === 18);
ok('parse: no CS-999 leaked in from a later section', !rows.some((r) => r.num === 999));
ok('parse: CS-001 fields', rows[1].num === 1 && rows[1].severity === 'Critical' && rows[1].phase === 'P1' && rows[1].status.startsWith('needs-decision'));
ok('parse: EOL-agnostic (an LF-joined index parses the same)', parseRegisterIndex(FIXTURE_INDEX.replace(/\r\n/g, '\n')).length === 18);

throws('parse: duplicate id is an error', () => parseRegisterIndex([
  '## INDEX', '| [CS-001](#cs-001) | Critical | SEC | t | P1 | V | verified |',
  '| [CS-001](#cs-001) | High | SEC | t | P1 | V | verified |',
].join('\r\n')));
throws('parse: malformed row (too few columns) is an error', () => parseRegisterIndex([
  '## INDEX', '| [CS-002](#cs-002) | Critical | SEC | P1 | verified |',
].join('\r\n')));
throws('parse: id/anchor mismatch is an error', () => parseRegisterIndex([
  '## INDEX', '| [CS-003](#cs-004) | Critical | SEC | t | P1 | V | verified |',
].join('\r\n')));
throws('parse: unknown phase is an error', () => parseRegisterIndex([
  '## INDEX', '| [CS-005](#cs-005) | Critical | SEC | t | P99 | V | verified |',
].join('\r\n')));
throws('parse: unknown severity is an error', () => parseRegisterIndex([
  '## INDEX', '| [CS-006](#cs-006) | Sev0 | SEC | t | P1 | V | verified |',
].join('\r\n')));

// ── 2. grouping / counts / needs-decision ────────────────────────────────────
const cov = computeCoverage(rows);
ok('coverage: grand total 18', cov.grand.total === 18);
ok('coverage: grand by severity 2/6/4/6', cov.grand.c === 2 && cov.grand.h === 6 && cov.grand.m === 4 && cov.grand.l === 6);
ok('coverage: grand needs-decision 2', cov.grand.nd === 2);
ok('coverage: P1 = 2C/4H, total 6, nd 1', (() => { const g = cov.byPhase.P1; return g.c === 2 && g.h === 4 && g.total === 6 && g.nd === 1; })());
ok('coverage: P2 = 2M/1L, total 3, nd 1', (() => { const g = cov.byPhase.P2; return g.m === 2 && g.l === 1 && g.total === 3 && g.nd === 1; })());
ok('coverage: every phase present, P7 total 1', cov.byPhase.P7 && cov.byPhase.P7.total === 1);

// ── 3. run compression ───────────────────────────────────────────────────────
ok('compress: a 3-run compresses', compressRuns([10, 11, 12]).join('|') === 'CS-010 to CS-012');
ok('compress: a 4-run compresses to its ends', compressRuns([10, 11, 12, 13]).join('|') === 'CS-010 to CS-013');
ok('compress: a 2-run stays listed', compressRuns([20, 21]).join('|') === 'CS-020|CS-021');
ok('compress: mixed runs and singletons', compressRuns([1, 2, 3, 7, 9, 10, 11]).join('|') === 'CS-001 to CS-003|CS-007|CS-009 to CS-011');
ok('compress: unsorted input is sorted first', compressRuns([12, 10, 11]).join('|') === 'CS-010 to CS-012');
ok('compress: a break of 2 does not merge', compressRuns([10, 12, 13, 14]).join('|') === 'CS-010|CS-012 to CS-014');

// ── 4. rendering ─────────────────────────────────────────────────────────────
ok('render P1 line: severity order, · separator, range',
  renderPhaseLine(cov.byPhase.P1.total, cov.byPhase.P1.bySev, null)
  === '- CS (6): Critical CS-001, CS-002 · High CS-010 to CS-013.');
ok('render P2 line: 2-run stays listed',
  renderPhaseLine(cov.byPhase.P2.total, cov.byPhase.P2.bySev, null)
  === '- CS (3): Medium CS-020, CS-021 · Low CS-030.');
ok('render body only skips empty severities',
  renderPhaseBody({ Critical: [], High: [5], Medium: [], Low: [8, 9] }) === 'High CS-005 · Low CS-008, CS-009');
ok('render table row P1', renderTableRows(cov)[1] === '| P1 | 2 | 4 | 0 | 0 | 6 | 1 |');
ok('render table Total row is bold', renderTableRows(cov)[PHASES.length] === '| **Total** | **2** | **6** | **4** | **6** | **18** | **2** |');

// ── 5. annotation handling ───────────────────────────────────────────────────
ok('annotation: trailing note extracted', extractAnnotation("- CS (1): High CS-070 (Matt's team has no logins).") === "(Matt's team has no logins)");
ok('annotation: none when absent', extractAnnotation('- CS (3): Medium CS-020, CS-021 · Low CS-030.') === null);
ok('render preserves a trailing note', renderPhaseLine(1, { Critical: [], High: [70], Medium: [], Low: [] }, "(Matt's team has no logins)") === "- CS (1): High CS-070 (Matt's team has no logins).");
throws('annotation: a non-trailing parenthesis is refused', () => extractAnnotation('- CS (2): High CS-010 (mid) · Low CS-020.'));

// ── 6. round-trip + drift through planPlaybookUpdate, on BOTH LF and CRLF ──────
// The tool must be EOL-agnostic: preserve the file's own line endings and introduce none of
// the other kind, on both a CRLF file (Windows working tree) and an LF file (repo / CI).
function buildFixturePlaybook(coverage, p10note, eol) {
  const L = [];
  L.push('# Fixture playbook');
  L.push('keep this line byte-exact   '); // trailing spaces must survive
  L.push('unicode kept: café · →'); // non-ASCII must survive
  L.push('');
  L.push('| Phase | Critical | High | Medium | Low | Total | Needs decision |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of renderTableRows(coverage)) L.push(r);
  L.push('');
  for (const p of PHASES) {
    const g = coverage.byPhase[p];
    L.push(`### ${p} — fixture section`);
    L.push('- Checks: none');
    L.push(renderPhaseLine(g.total, g.bySev, p === 'P10' ? p10note : null));
  }
  L.push(''); // trailing blank → text ends with the chosen EOL
  return L.join(eol);
}

for (const [label, eol] of [['CRLF', '\r\n'], ['LF', '\n']]) {
  const inSync = buildFixturePlaybook(cov, '(a preserved note)', eol);
  const planClean = planPlaybookUpdate(inSync, cov);
  ok(`${label}: an in-sync playbook needs 0 changes`, planClean.changes.length === 0);
  ok(`${label}: newText is byte-identical to input`, planClean.newText === inSync);
  ok(`${label}: line endings preserved, none of the other kind introduced`,
    countEol(planClean.newText, eol) === countEol(inSync, eol) && !hasForeignEol(planClean.newText, eol));

  // Drift: corrupt one table row + one phase line; plan catches both and restores exact bytes.
  const canonP1Row = renderTableRows(cov)[1];
  const canonP2Line = renderPhaseLine(cov.byPhase.P2.total, cov.byPhase.P2.bySev, null);
  const drift = inSync
    .replace(canonP1Row, '| P1 | 2 | 4 | 0 | 0 | 5 | 1 |') // wrong total
    .replace(canonP2Line, '- CS (2): Medium CS-020 · Low CS-030.'); // dropped CS-021
  const planDrift = planPlaybookUpdate(drift, cov);
  ok(`${label} drift: exactly 2 lines flagged`, planDrift.changes.length === 2);
  ok(`${label} drift: the P1 table row + P2 phase line are flagged`,
    planDrift.changes.some((c) => c.kind === 'table' && c.key === 'P1')
    && planDrift.changes.some((c) => c.kind === 'phase' && c.key === 'P2'));
  ok(`${label} drift: --write output restores the in-sync bytes exactly`, planDrift.newText === inSync);
  ok(`${label} drift: an untouched line with trailing spaces is preserved`, planDrift.newText.includes('keep this line byte-exact   '));
  ok(`${label} drift: output uses only ${label} endings`, !hasForeignEol(planDrift.newText, eol));
  ok(`${label} drift: the dropped id is reported as added back`, (() => {
    const c = planDrift.changes.find((x) => x.kind === 'phase' && x.key === 'P2');
    const added = [...bodyToNums(c.after)].filter((n) => !bodyToNums(c.before).has(n));
    return added.length === 1 && added[0] === 21;
  })());
}

// ── 7. REGRESSION (the CI break): the LF form of the REAL files ────────────────
// The repo stores DEV_PLAYBOOK.md and FINDINGS_REGISTER.md as LF, so a Linux CI runner checks
// them out as LF; a Windows working tree shows CRLF (core.autocrlf). This drives the tool over
// the exact LF content CI sees. On the pre-fix tool it THREW ("coverage-table header not
// found") because devText.split('\r\n') collapsed an LF file into one line.
const REGISTER_PATH = fileURLToPath(new URL('../../docs/playbook/FINDINGS_REGISTER.md', import.meta.url));
const DEV_PATH = fileURLToPath(new URL('../../DEV_PLAYBOOK.md', import.meta.url));
const toLF = (s) => s.replace(/\r\n/g, '\n');
let lfOk = false;
let lfErr = '';
try {
  const covLF = computeCoverage(parseRegisterIndex(toLF(readFileSync(REGISTER_PATH, 'utf8'))));
  const planLF = planPlaybookUpdate(toLF(readFileSync(DEV_PATH, 'utf8')), covLF);
  lfOk = planLF.changes.length === 0 && !planLF.newText.includes('\r');
} catch (e) {
  lfErr = e.message;
}
ok('LF (CI) form of the real files: parse + plan + --check works and stays LF', lfOk);
if (!lfOk) console.error(`  LF-form regression failed: ${lfErr || 'drift found, or a CR was introduced into the LF file'}`);

// ── 8. REAL-FILES gate: --check against the actual repo files must be green ────
// Fails until DEV_PLAYBOOK.md is regenerated with `--write`; that is the whole point.
const tool = fileURLToPath(new URL('./playbook-cs-lists.mjs', import.meta.url));
let realCheckGreen = false;
let realCheckOutput = '';
try {
  execFileSync(process.execPath, [tool, '--check'], { stdio: 'pipe' });
  realCheckGreen = true;
} catch (e) {
  realCheckOutput = `${e.stdout || ''}${e.stderr || ''}`.trim();
}
ok('real files: playbook-cs-lists --check is green (run --write if this fails)', realCheckGreen);
if (!realCheckGreen) {
  console.error('\n  DEV_PLAYBOOK.md is out of sync with the register. Regenerate it:');
  console.error('    node app/scripts/playbook-cs-lists.mjs --write');
  console.error(realCheckOutput.replace(/^/gm, '  '));
}

console.log(`\n${pass}/${pass + fail} playbook-cs-lists cases green`);
process.exit(fail ? 1 : 0);
