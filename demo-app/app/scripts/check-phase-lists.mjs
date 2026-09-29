#!/usr/bin/env node
// check-phase-lists.mjs — keep DEV_PLAYBOOK Part 2's per-phase "Checks:" lists in sync
// with the check catalogs in docs/playbook/checks/*.md (DEV_PLAYBOOK 2.0). Offline, read-only.
//
// It fails (exit 1) when:
//   • a catalog row whose `Phase(s)` column names phase P is MISSING from P's Checks list, or
//   • a phase list names an ID that exists in NO catalog (an UNKNOWN id).
// On 2026-09-23 the lists matched the 609 catalog rows with 0 missing and 0 unknown; this
// script is the gate that keeps it so, and runs at every phase gate (Part 4.10).
//
//   node scripts/check-phase-lists.mjs            # the gate (exit 0 clean, 1 on drift)
//   node scripts/check-phase-lists.mjs --verbose  # list every catalog row / phase count too
//
// The phase lists use a compact grammar this file expands: en-dash ranges (`SEC-01–38`),
// "to" ranges (`TEST-NET-01 to 04`), prefix-carried bare numbers (`DATA-10, 29, 30`), and
// prose descriptors (`SECURITY rows with P3 (63): …`, `plus the negative matrix`, `Tools 1-15`).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHECKS_DIR = path.join(ROOT, 'docs/playbook/checks');
const DEV_PLAYBOOK = path.join(ROOT, 'DEV_PLAYBOOK.md');

// Canonical form of a check id: keep the (possibly multi-part) prefix, strip zero-padding
// on the trailing number. SEC-01 and SEC-1 → "SEC-1"; TEST-E2E-09 → "TEST-E2E-9".
export function canonicalId(id) {
  const m = /^(.*)-0*(\d+)$/.exec(String(id).trim());
  return m ? `${m[1]}-${parseInt(m[2], 10)}` : String(id).trim();
}

// The check-id grammar: a letter-led, hyphen-joined prefix then a numeric suffix.
const FULL_ID = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*';

// Expand one phase "Checks:" list into a Set of canonical ids. Prose and stray numbers
// (which never form `PREFIX-<n>`) are ignored; only runs anchored on a full id count.
export function expandChecksList(text) {
  const ids = new Set();
  const s = String(text).replace(/\([^)]*\)/g, ' '); // drop "(63)", "(every data-op)" etc.
  // A run = a full id, then a chain of continuations joined by , – — or "to".
  const RUN = new RegExp(`(${FULL_ID})-(\\d+)((?:\\s*(?:,|\\u2013|\\u2014|\\bto\\b)\\s*(?:${FULL_ID}-)?\\d+)*)`, 'g');
  const CHAIN = new RegExp(`(,|\\u2013|\\u2014|\\bto\\b)\\s*(?:(${FULL_ID})-)?(\\d+)`, 'g');
  let m;
  while ((m = RUN.exec(s))) { // scan the paren-stripped text for runs
    let curPrefix = m[1];
    let lastNum = parseInt(m[2], 10);
    ids.add(canonicalId(`${curPrefix}-${lastNum}`));
    const chain = m[3] || '';
    let cm;
    CHAIN.lastIndex = 0;
    while ((cm = CHAIN.exec(chain))) {
      const sep = cm[1];
      const pfx = cm[2] || curPrefix;
      const num = parseInt(cm[3], 10);
      if (sep === ',') {
        ids.add(canonicalId(`${pfx}-${num}`));
      } else { // en-dash / em-dash / "to" → inclusive range from the previous number
        const lo = Math.min(lastNum, num);
        const hi = Math.max(lastNum, num);
        for (let i = lo; i <= hi; i += 1) ids.add(canonicalId(`${pfx}-${i}`));
      }
      curPrefix = pfx;
      lastNum = num;
    }
  }
  return ids;
}

// Parse a catalog markdown file into [{ id, rawId, phases:Set<'P#'> }] from its check
// table (the one whose header has an "ID" cell and a "Phase(s)" cell).
export function parseCatalogRows(md) {
  const rows = [];
  let phaseCol = -1;
  let idCol = -1;
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.includes('id') && lower.some((c) => /phase/.test(c))) {
      idCol = lower.indexOf('id');
      phaseCol = lower.findIndex((c) => /phase/.test(c));
      continue;
    }
    if (/^-+$/.test(cells[0])) continue; // divider
    if (phaseCol < 0 || idCol < 0) continue; // not inside a check table yet
    const rawId = cells[idCol].replace(/`/g, '').trim();
    if (!new RegExp(`^${FULL_ID}-\\d+$`).test(rawId)) continue; // not an id row (e.g. the stage table)
    const phases = new Set((cells[phaseCol].match(/P\d+/g) || []));
    rows.push({ id: canonicalId(rawId), rawId, phases });
  }
  return rows;
}

// Parse DEV_PLAYBOOK Part 2 into Map<'P#', Set<canonicalId>> from each phase's "- Checks:"
// (or "- Checks (P10 rows):") bullet.
export function parsePhaseLists(devText) {
  const lists = new Map();
  let phase = null;
  for (const line of devText.split(/\r?\n/)) {
    const h = /^#{2,4}\s+P(\d+)\b/.exec(line);
    if (h) { phase = `P${h[1]}`; continue; }
    const c = /^-\s*Checks\s*(?:\([^)]*\))?\s*:(.*)$/.exec(line);
    if (phase && c && !lists.has(phase)) lists.set(phase, expandChecksList(c[1]));
  }
  return lists;
}

// Cross-check the catalogs against the phase lists.
export function reconcile(catalogRows, phaseLists) {
  const allIds = new Set(catalogRows.map((r) => r.id));
  const missing = [];
  for (const r of catalogRows) {
    for (const ph of r.phases) {
      const list = phaseLists.get(ph);
      if (!list || !list.has(r.id)) missing.push({ phase: ph, id: r.id });
    }
  }
  const unknown = [];
  for (const [ph, list] of phaseLists) {
    for (const id of list) if (!allIds.has(id)) unknown.push({ phase: ph, id });
  }
  return { missing, unknown };
}

function main(argv) {
  const verbose = argv.includes('--verbose');
  const catalogRows = [];
  const perCatalog = {};
  for (const f of readdirSync(CHECKS_DIR).filter((n) => n.endsWith('.md')).sort()) {
    const rows = parseCatalogRows(readFileSync(path.join(CHECKS_DIR, f), 'utf8'));
    perCatalog[f] = rows.length;
    catalogRows.push(...rows);
  }
  const phaseLists = parsePhaseLists(readFileSync(DEV_PLAYBOOK, 'utf8'));
  const { missing, unknown } = reconcile(catalogRows, phaseLists);

  console.log(`check-phase-lists: ${catalogRows.length} catalog rows, ${phaseLists.size} phase lists`);
  if (verbose) {
    for (const [f, n] of Object.entries(perCatalog)) console.log(`    ${f}: ${n}`);
    for (const [ph, set] of [...phaseLists].sort()) console.log(`    ${ph}: ${set.size} ids`);
  }
  if (missing.length || unknown.length) {
    if (missing.length) {
      console.error(`\n✗ ${missing.length} catalog row(s) tagged for a phase but missing from its list:`);
      for (const m of missing) console.error(`    ${m.phase} ← ${m.id}`);
    }
    if (unknown.length) {
      console.error(`\n✗ ${unknown.length} listed id(s) that exist in no catalog:`);
      for (const u of unknown) console.error(`    ${u.phase} → ${u.id}`);
    }
    process.exit(1);
  }
  console.log('✓ every tagged catalog row is listed, and every listed id exists (0 missing, 0 unknown).');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv);
