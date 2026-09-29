#!/usr/bin/env node
// playbook-cs-lists.mjs — keep DEV_PLAYBOOK.md §2.0's "CS coverage" table and every phase
// section's "- CS (N): …" line in sync with the findings register INDEX
// (docs/playbook/FINDINGS_REGISTER.md, the single source of truth for CS IDs). Offline;
// reads only the repo. §2.0 already states the rule this enforces: "If a phase list below
// disagrees with this output, the register wins; fix this part in the same commit." This
// tool IS that fix, made mechanical and CI-gated (test-playbook-cs-lists.mjs runs --check
// against the real files inside run-tests, so a register change without a regenerate fails CI).
//
//   node app/scripts/playbook-cs-lists.mjs            # print the regenerated table + phase lines (preview; no write)
//   node app/scripts/playbook-cs-lists.mjs --check    # exit 1 on any table/phase-line drift (the gate)
//   node app/scripts/playbook-cs-lists.mjs --write    # rewrite ONLY those lines in DEV_PLAYBOOK.md (its line endings — LF or CRLF — and every other byte preserved)
//
// 🔁 AFTER ANY REGISTER CHANGE, REGENERATE:  node app/scripts/playbook-cs-lists.mjs --write
//    and commit DEV_PLAYBOOK.md in the same change. A parallel session (S102) landing register
//    rows CS-356..CS-368 and CS-374..CS-375 MUST run --write when it rebases, or the --check
//    gate (test-playbook-cs-lists.mjs, inside run-tests) fails.
//
// What it does NOT touch: the prose sentences near the table that also restate the total —
// the "**CS coverage (union = the register, N; …)**" heading and the "…it prints `total N`,
// with per-phase counts …" paragraph. Each is bundled with re-baseline provenance (a sha and
// date the register does not carry), so editing just the number would make a false provenance
// claim. The tool reports those for a human to update instead of corrupting them.
//
// Format contract (matched to the file's existing convention):
//   • table rows:  | P{n} | {Critical} | {High} | {Medium} | {Low} | {Total} | {Needs decision} |
//                  then the bold  | **Total** | **…** | … |  grand-total row.
//   • phase line:  - CS ({total}): {Sev} {ids} · {Sev} {ids} ….
//                  Severities in Critical, High, Medium, Low order; only non-empty ones shown;
//                  the separator is " · " (U+00B7). Needs-decision = a Status starting "needs-decision".
//   • ids ordered by number within a severity; a run of 3+ CONSECUTIVE ids compresses to
//     "CS-a to CS-b" (deterministic — this normalizes the file's earlier hand-authored,
//     inconsistent runs); a trailing parenthetical on a phase line (e.g. P10's
//     "(Matt's team has no logins)") is preserved verbatim.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REGISTER = path.join(ROOT, 'docs/playbook/FINDINGS_REGISTER.md');
const DEV_PLAYBOOK = path.join(ROOT, 'DEV_PLAYBOOK.md');

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const PHASES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const MIDDOT = '·';
const SEP = ` ${MIDDOT} `;
const RUN_MIN = 3; // a run of this many consecutive ids (or more) compresses to "CS-a to CS-b"
const TABLE_HEADER = '| Phase | Critical | High | Medium | Low | Total | Needs decision |';
const REGEN_HINT =
  'The register moved. Regenerate:  node app/scripts/playbook-cs-lists.mjs --write   then commit DEV_PLAYBOOK.md in the same change.';

export const csId = (n) => `CS-${String(n).padStart(3, '0')}`;

// ── Parse the register INDEX ────────────────────────────────────────────────
// Rows look like: | [CS-001](#cs-001) | Critical | SEC | Title | P1 | V | verified |
// The register holds only CS entries, so a row in the INDEX section that does not parse, an
// id/anchor mismatch, a duplicate id, or an unknown severity/phase is an error (we do not guess).
export function parseRegisterIndex(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## INDEX\s*$/.test(l));
  if (start < 0) throw new Error('FINDINGS_REGISTER.md: no "## INDEX" heading found.');
  const rowRe = /^\| \[CS-(\d+)\]\(#cs-(\d+)\) \| ([^|]+?) \| ([^|]+?) \| (.+?) \| ([^|]+?) \| ([^|]+?) \| ([^|]+?) \|$/;
  const rows = [];
  const seen = new Set();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^## /.test(line)) break; // end of the INDEX section
    if (!/^\| \[CS-/.test(line)) continue; // header / divider / blank / prose
    const m = rowRe.exec(line);
    if (!m) throw new Error(`FINDINGS_REGISTER.md INDEX: malformed CS row:\n  ${line}`);
    const [, num, anchor, sev, area, , phase, ev, status] = m;
    if (num !== anchor) throw new Error(`FINDINGS_REGISTER.md INDEX: id/anchor mismatch (CS-${num} vs #cs-${anchor}).`);
    const n = parseInt(num, 10);
    if (seen.has(n)) throw new Error(`FINDINGS_REGISTER.md INDEX: duplicate id ${csId(n)}.`);
    seen.add(n);
    const severity = sev.trim();
    if (!SEVERITIES.includes(severity)) throw new Error(`FINDINGS_REGISTER.md INDEX: ${csId(n)} has unknown severity "${severity}".`);
    const ph = phase.trim();
    if (!PHASES.includes(ph)) throw new Error(`FINDINGS_REGISTER.md INDEX: ${csId(n)} has unknown phase "${ph}".`);
    rows.push({ num: n, severity, area: area.trim(), phase: ph, ev: ev.trim(), status: status.trim() });
  }
  if (!rows.length) throw new Error('FINDINGS_REGISTER.md INDEX: no CS rows parsed.');
  return rows;
}

// ── Compute per-phase coverage ──────────────────────────────────────────────
export function computeCoverage(rows) {
  const byPhase = {};
  for (const p of PHASES) byPhase[p] = { bySev: { Critical: [], High: [], Medium: [], Low: [] }, nd: 0 };
  for (const r of rows) {
    byPhase[r.phase].bySev[r.severity].push(r.num);
    if (r.status.startsWith('needs-decision')) byPhase[r.phase].nd += 1;
  }
  const grand = { c: 0, h: 0, m: 0, l: 0, total: 0, nd: 0 };
  for (const p of PHASES) {
    const g = byPhase[p];
    for (const s of SEVERITIES) g.bySev[s].sort((a, b) => a - b);
    g.c = g.bySev.Critical.length;
    g.h = g.bySev.High.length;
    g.m = g.bySev.Medium.length;
    g.l = g.bySev.Low.length;
    g.total = g.c + g.h + g.m + g.l;
    grand.c += g.c; grand.h += g.h; grand.m += g.m; grand.l += g.l;
    grand.total += g.total; grand.nd += g.nd;
  }
  return { byPhase, grand };
}

// ── Rendering ───────────────────────────────────────────────────────────────
// Compress an ascending list of ints: a maximal run of >= RUN_MIN consecutive values becomes
// "CS-a to CS-b"; shorter runs list every id. Returns display tokens in numeric order.
export function compressRuns(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j += 1;
    if (j - i + 1 >= RUN_MIN) out.push(`${csId(s[i])} to ${csId(s[j])}`);
    else for (let k = i; k <= j; k += 1) out.push(csId(s[k]));
    i = j + 1;
  }
  return out;
}

export function renderPhaseBody(bySev) {
  const parts = [];
  for (const s of SEVERITIES) {
    const nums = bySev[s];
    if (nums && nums.length) parts.push(`${s} ${compressRuns(nums).join(', ')}`);
  }
  return parts.join(SEP);
}

export function renderPhaseLine(total, bySev, annotation) {
  const body = renderPhaseBody(bySev);
  return `- CS (${total}): ${body}${annotation ? ` ${annotation}` : ''}.`;
}

export function renderTableRows(cov) {
  const rows = [];
  for (const p of PHASES) {
    const g = cov.byPhase[p];
    rows.push(`| ${p} | ${g.c} | ${g.h} | ${g.m} | ${g.l} | ${g.total} | ${g.nd} |`);
  }
  const gr = cov.grand;
  rows.push(`| **Total** | **${gr.c}** | **${gr.h}** | **${gr.m}** | **${gr.l}** | **${gr.total}** | **${gr.nd}** |`);
  return rows;
}

// A phase line's ids never contain "(" or ")", so any trailing "(…)" before the period is a
// note to keep. A parenthetical anywhere else is unexpected — refuse rather than drop it.
export function extractAnnotation(line) {
  const m = /^- CS \(\d+\): (.*)\.$/.exec(line);
  if (!m) throw new Error(`extractAnnotation: not a "- CS (N):" line:\n  ${line}`);
  let inner = m[1];
  let annotation = null;
  const am = / (\([^()]*\))$/.exec(inner);
  if (am) {
    annotation = am[1];
    inner = inner.slice(0, am.index);
  }
  if (inner.includes('(') || inner.includes(')')) {
    throw new Error(`DEV_PLAYBOOK.md: a "- CS" line carries a non-trailing parenthetical; refusing to regenerate it by machine:\n  ${line}`);
  }
  return annotation;
}

// Expand a rendered phase-line (or body) back into the set of ids it names — for drift diffs.
export function bodyToNums(text) {
  const nums = new Set();
  const re = /CS-(\d+)(?:\s+to\s+CS-(\d+))?/g;
  let m;
  while ((m = re.exec(text))) {
    const a = parseInt(m[1], 10);
    if (m[2]) { const b = parseInt(m[2], 10); for (let i = a; i <= b; i += 1) nums.add(i); }
    else nums.add(a);
  }
  return nums;
}

// ── Plan an update against DEV_PLAYBOOK.md ───────────────────────────────────
// Locates the coverage table and each phase's "- CS (N):" line, renders their canonical form,
// and returns the changes plus the fully-rewritten text (only those lines differ). Structure
// surprises (missing table, out-of-order rows, missing phase line) throw — the tool never guesses.
export function planPlaybookUpdate(devText, cov) {
  // EOL-agnostic. The repo stores LF and a Linux CI checkout is LF, while a Windows working
  // tree is CRLF (core.autocrlf). Detect the file's own line ending, split and join on it, so
  // every non-target byte — line endings included — round-trips unchanged on both forms.
  const eol = devText.includes('\r\n') ? '\r\n' : '\n';
  const lines = devText.split(eol);
  const changes = [];
  const afterByPhase = new Map();

  // ---- coverage table ----
  const headerIdx = lines.indexOf(TABLE_HEADER);
  if (headerIdx < 0) throw new Error(`DEV_PLAYBOOK.md: coverage-table header not found:\n  ${TABLE_HEADER}`);
  const dividerIdx = headerIdx + 1;
  if (!/^\|[-|]+\|$/.test(lines[dividerIdx] || '')) {
    throw new Error(`DEV_PLAYBOOK.md: expected a table divider at line ${dividerIdx + 1}, found:\n  ${lines[dividerIdx]}`);
  }
  const newTableRows = renderTableRows(cov);
  for (let k = 0; k < PHASES.length; k += 1) {
    const idx = dividerIdx + 1 + k;
    const p = PHASES[k];
    if (!new RegExp(`^\\| ${p} \\|`).test(lines[idx] || '')) {
      throw new Error(`DEV_PLAYBOOK.md: expected the ${p} table row at line ${idx + 1}, found:\n  ${lines[idx]}`);
    }
    if (lines[idx] !== newTableRows[k]) changes.push({ kind: 'table', key: p, index: idx, before: lines[idx], after: newTableRows[k] });
  }
  const totalIdx = dividerIdx + 1 + PHASES.length;
  if (!/^\| \*\*Total\*\* \|/.test(lines[totalIdx] || '')) {
    throw new Error(`DEV_PLAYBOOK.md: expected the "**Total**" table row at line ${totalIdx + 1}, found:\n  ${lines[totalIdx]}`);
  }
  const newTotalRow = newTableRows[PHASES.length];
  if (lines[totalIdx] !== newTotalRow) changes.push({ kind: 'table', key: 'Total', index: totalIdx, before: lines[totalIdx], after: newTotalRow });

  // ---- each phase's "- CS (N):" line (first one after the phase heading) ----
  const csIndexByPhase = new Map();
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^#{2,4}\s+P(\d+)\b/.exec(lines[i]);
    if (h) { cur = `P${h[1]}`; continue; }
    if (cur && /^- CS \(/.test(lines[i]) && !csIndexByPhase.has(cur)) csIndexByPhase.set(cur, i);
  }
  for (const p of PHASES) {
    if (!csIndexByPhase.has(p)) throw new Error(`DEV_PLAYBOOK.md: no "- CS (N):" line found in the ${p} section.`);
    const idx = csIndexByPhase.get(p);
    const annotation = extractAnnotation(lines[idx]);
    const g = cov.byPhase[p];
    const after = renderPhaseLine(g.total, g.bySev, annotation);
    afterByPhase.set(p, after);
    if (lines[idx] !== after) changes.push({ kind: 'phase', key: p, index: idx, before: lines[idx], after });
  }

  // ---- apply ----
  const newLines = lines.slice();
  for (const c of changes) newLines[c.index] = c.after;
  const newText = newLines.join(eol);

  // ---- prose the tool deliberately leaves alone (report only) ----
  const proseWarnings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const u = /union = the register, (\d+)/.exec(lines[i]);
    if (u && parseInt(u[1], 10) !== cov.grand.total) {
      proseWarnings.push(`line ${i + 1}: prose says "union = the register, ${u[1]}"; register total is ${cov.grand.total}. Bundled with re-baseline provenance (sha + date) — update by hand.`);
    }
    const t = /prints `total (\d+)`/.exec(lines[i]);
    if (t && parseInt(t[1], 10) !== cov.grand.total) {
      const perPhase = PHASES.map((p) => `${p} ${cov.byPhase[p].total}`).join(', ');
      proseWarnings.push(`line ${i + 1}: prose says "prints \`total ${t[1]}\`"; register total is ${cov.grand.total} (per-phase now ${perPhase}). Bundled with a dated reconcile run — update by hand.`);
    }
  }

  return { changes, newText, proseWarnings, cov, tableRows: newTableRows, afterByPhase };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function fmtNums(nums) {
  return [...nums].sort((a, b) => a - b).map(csId).join(', ');
}

function summarizeChanges(changes) {
  const out = [];
  for (const c of changes) {
    if (c.kind === 'phase') {
      const before = bodyToNums(c.before);
      const after = bodyToNums(c.after);
      const added = [...after].filter((x) => !before.has(x));
      const removed = [...before].filter((x) => !after.has(x));
      const parts = [`count ${before.size} → ${after.size}`];
      if (added.length) parts.push(`+${added.length} (${fmtNums(added)})`);
      if (removed.length) parts.push(`-${removed.length} (${fmtNums(removed)})`);
      if (!added.length && !removed.length) parts.push('range-compression only');
      out.push(`  ${c.key.padEnd(4)} ${parts.join('; ')}`);
    } else {
      out.push(`  table ${c.key.padEnd(6)} ${c.before.trim()}  →  ${c.after.trim()}`);
    }
  }
  return out;
}

function main(argv) {
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : 'preview';
  let cov;
  let plan;
  let devText;
  try {
    const rows = parseRegisterIndex(readFileSync(REGISTER, 'utf8'));
    cov = computeCoverage(rows);
    devText = readFileSync(DEV_PLAYBOOK, 'utf8');
    plan = planPlaybookUpdate(devText, cov);
  } catch (e) {
    console.error(`✖ playbook-cs-lists: ${e.message}`);
    process.exit(2);
  }

  if (mode === 'preview') {
    console.log(`# regenerated from FINDINGS_REGISTER.md INDEX — ${cov.grand.total} entries\n`);
    console.log(TABLE_HEADER);
    console.log('|---|---|---|---|---|---|---|');
    for (const r of plan.tableRows) console.log(r);
    console.log('');
    for (const p of PHASES) console.log(plan.afterByPhase.get(p));
    if (plan.proseWarnings.length) {
      console.log('\nprose near the table that also restates the total (left as-is; update by hand):');
      for (const w of plan.proseWarnings) console.log(`  ${w}`);
    }
    process.exit(0);
  }

  if (mode === 'check') {
    if (plan.changes.length) {
      console.error(`✖ playbook-cs-lists --check: ${plan.changes.length} line(s) in DEV_PLAYBOOK.md disagree with the register (register wins):\n`);
      for (const l of summarizeChanges(plan.changes)) console.error(l);
      if (plan.proseWarnings.length) {
        console.error('\n  also stale (prose, NOT auto-fixed by --write — update by hand):');
        for (const w of plan.proseWarnings) console.error(`    ${w}`);
      }
      console.error(`\n${REGEN_HINT}`);
      process.exit(1);
    }
    console.log(`✓ playbook-cs-lists --check: DEV_PLAYBOOK.md coverage table + all ${PHASES.length} phase lists match the register (${cov.grand.total} entries).`);
    if (plan.proseWarnings.length) {
      console.log('\n  note — prose near the table still restates an old total (not part of the gate; update by hand):');
      for (const w of plan.proseWarnings) console.log(`    ${w}`);
    }
    process.exit(0);
  }

  // mode === 'write'
  if (!plan.changes.length) {
    console.log(`✓ playbook-cs-lists --write: already in sync (${cov.grand.total} entries); no lines changed.`);
  } else {
    writeFileSync(DEV_PLAYBOOK, plan.newText); // utf8, the file's own line endings preserved (only the listed lines differ)
    console.log(`✓ playbook-cs-lists --write: rewrote ${plan.changes.length} line(s) in DEV_PLAYBOOK.md (register = ${cov.grand.total} entries):\n`);
    for (const l of summarizeChanges(plan.changes)) console.log(l);
  }
  if (plan.proseWarnings.length) {
    console.log('\n⚠ prose near the table still restates an old total and was NOT edited (provenance-entangled — update by hand):');
    for (const w of plan.proseWarnings) console.log(`  ${w}`);
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv);
