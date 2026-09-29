#!/usr/bin/env node
// table-truncation-lint — UI_RULES §50. Every <table> whose rows come from DATA must
// render a PAGED slice, not the whole collection.
//
// WHY A SWEEP AND NOT A CODE REVIEW. On 2026-07-27 an audit of the app found 3 tables
// with hand-rolled pagers at 3 different page sizes (25 / 25 / 10) and ~25 with none at
// all — every one of those rendered its entire collection. Nothing failed, nothing
// warned; the tables simply grew with the data. A demo org hides this completely, and a
// real Jobber import is where it would have been discovered.
//
// WHAT IT CHECKS. For each `<table>` in a .jsx file, find the `<tbody>` and the
// expression that produces its rows. A row source of the form `X.map(` is a violation
// unless X is a paged slice (`something.pageRows`) or the file is allow-listed.
//
// 🔴 THE ALLOW-LIST IS FOR STRUCTURE, NOT FOR "we didn't get to it". A table exempt here
// must have rows that are the APP's OWN VOCABULARY (the permission matrix, a form
// designer's matrix field) rather than records a customer creates. Adding a row to the
// list is a decision to be defended in UI_RULES §50's "Don't apply", not a way to make
// the sweep quiet.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : 'src';

// path → why it is exempt. Both reasons are "these rows are structure, not data".
const ALLOW = new Map([
  ['pages/settings/Roles.jsx', 'the permission MATRIX — rows are the app\'s permission vocabulary; paging it makes an operator hunt across pages for one checkbox'],
  ['pages/settings/TeamDetail.jsx', 'the per-user permission override matrix — same reason as Roles'],
  // The customer QUOTE DOCUMENT (CustomerView `.qb-doc-table`) — its rows are the quote\'s
  // line items shown IN FULL on the page the customer receives; paging them would hide
  // charges from the customer, and a quote\'s line count is bounded and small (combined
  // material categories + a few separate lines). A document is not a scrollable data list.
  // ⚠️ This exemption is FILE-LEVEL, so it also stops guarding the Internal-view table in
  // this file — that one IS paged via `usePagedRows(lines)` and must STAY so (UI_RULES §50).
  ['pages/QuoteBuilder.jsx', 'the customer quote DOCUMENT shows every line in full — paging a customer\'s quote would hide charges; the Internal-view table here stays paged via usePagedRows'],
]);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (p.endsWith('.jsx')) files.push(p);
  }
})(ROOT);

const findings = [];
let tables = 0;
let paged = 0;
let exempt = 0;

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  // Walk every <table …>, then take the slice up to its </table>.
  const re = /<table[\s>]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const end = src.indexOf('</table>', start);
    if (end === -1) continue;
    const block = src.slice(start, end);
    const bodyAt = block.indexOf('<tbody');
    if (bodyAt === -1) continue; // a <table> with no <tbody> renders no data rows
    const body = block.slice(bodyAt);
    tables += 1;

    const line = src.slice(0, start).split('\n').length;

    // 🔴 ONLY THE MAPS THAT PRODUCE ROWS. A `.map(` nested inside a `<tr>…</tr>` builds
    // CELLS — the CSV preview's column list, a <select>'s options in an editing row — and
    // flagging those was this sweep's first-draft behaviour: two false positives out of
    // three findings. So track `<tr>` depth and only count a map at depth 0.
    const maps = [];
    let depth = 0;
    const tok = /<tr[\s/>]|<\/tr>|([A-Za-z_$][\w$]*(?:\??\.[\w$]+)*)\.map\(/g;
    let t;
    while ((t = tok.exec(body)) !== null) {
      if (t[0].startsWith('</tr')) { depth = Math.max(0, depth - 1); continue; }
      if (t[0].startsWith('<tr')) { depth += 1; continue; }
      if (depth === 0) maps.push(t[1]);
    }
    if (maps.length === 0) continue; // a static tbody

    // Paged if EVERY row source is a `.pageRows` slice. `.slice(` alone does not count:
    // a silent hard cap ("first 50") is the failure mode this exists to catch, not a fix.
    const unpaged = maps.filter((expr) => !/\.pageRows$/.test(expr));
    if (unpaged.length === 0) { paged += 1; continue; }

    if (ALLOW.has(rel)) { exempt += 1; continue; }

    findings.push({ rel, line, sources: [...new Set(unpaged)] });
  }
}

const label = `table-truncation-lint — UI_RULES §50 · ${tables} data table(s) · ${paged} paged · ${exempt} exempt`;
if (findings.length === 0) {
  console.log(`\n${label}\n  ✓ every data table renders a paged slice\n`);
  process.exit(0);
}

console.error(`\n${label}`);
console.error(`\n  ${findings.length} table(s) render an UNPAGED collection:\n`);
for (const f of findings) {
  console.error(`  ✗ ${f.rel}:${f.line} — <tbody> maps ${f.sources.map((s) => `\`${s}\``).join(', ')}`);
}
console.error(`
  Fix: const pager = usePagedRows(rows, { param: 'page', resetKey: <filters> });
       …<tbody>{pager.pageRows.map(…)}</tbody></table>
       <ListPager pager={pager} noun="…" />

  If the rows are the app's own STRUCTURE rather than user data (a permission matrix,
  a form-designer matrix field), add the file to ALLOW in this script WITH a reason and
  record it under "Don't apply" in UI_RULES §50.
`);
process.exit(1);
