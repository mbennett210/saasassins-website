// The Customers list's Status cell keeps every badge whole (CS-965).
//
// WHY. A customer carrying both of the list's flags (WO-14's "N tickets in 30 days" and SUP-7's
// "Over supply budget") had both cut at their ends on a phone: the stacked card's cell is a flex
// row that doesn't wrap (`.table-wrap.mobile-stack > table > tbody > tr > td` under 640px), the
// app-wide `* { min-width: 0; }` let each badge shrink as a flex item, and `.badge` keeps its words
// on one line, so they ran past the red pill (measured on the demo, 2026-11-03: at 320 × 568 the
// two pills drew 67.11 and 68.98px wide for words 106.08 and 110.3px wide; at 390 × 844, 96.63 and
// 99.67px; at 440 × 956 they still shrank, to 5.81px of their 10px padding). On a computer the same
// badges touched, side by side or one under another, with no space between them.
//
// The fix is the kit's own part for several chips in one table cell, `.cell-chip-stack` (index.css,
// first used by the Team page's Clock rules column): each badge in its own block, one per line, as
// wide as its words, following the cell's alignment (left in the desktop table, right in a phone's
// card), 4px apart.
//
//   §1  the kit: `.cell-chip-stack > *` is a block and the next one is spaced, outside any media
//       block, so the phone's card and the desktop table share it
//   §2  the Customers list: its Status cell is one `.cell-chip-stack`, every badge in its own
//       `<div>`, the status and both flags still there
//   §3  the checker on fixtures: badges side by side in the cell, a badge straight in the stack
//       (stretched to the widest) and a badge left outside it are caught; the fixed cell passes
//
// REGRESSION (THE LAW II.3): on eedb6757 the Status cell holds its three badges side by side,
// straight in the cell, so §2 fails there.
//
//   node app/scripts/test-customer-status-cell.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// ── §1 the kit ───────────────────────────────────────────────────────────────────────────────────

// The rules at the stylesheet's top level (outside every @media / @supports block): selector → body.
function topLevelRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0;
  let start = 0;
  let selector = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) { selector = src.slice(start, i).trim(); start = i + 1; }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        if (!selector.startsWith('@')) rules.push({ selector: selector.replace(/\s+/g, ' '), body: src.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return rules;
}

const css = read('src/index.css');
const top = topLevelRules(css);
const ruleFor = (sel) => top.find((r) => r.selector.split(',').map((s) => s.trim()).includes(sel));
const each = ruleFor('.cell-chip-stack > *');
const next = ruleFor('.cell-chip-stack > * + *');
ok('§1 `.cell-chip-stack > *` is a block, outside any media block', !!each && /display:\s*block/.test(each.body), each ? each.body.trim() : 'no top-level rule');
ok('§1 `.cell-chip-stack > * + *` spaces the next one, outside any media block', !!next && /margin-top:\s*var\(--space-1\)/.test(next.body), next ? next.body.trim() : 'no top-level rule');

// ── §2 the Customers list ────────────────────────────────────────────────────────────────────────

const stripJsxComments = (s) => s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

/** What is wrong with a table cell's JSX: [] when every badge stands whole in the kit's stack. */
function cellProblems(cellJsx) {
  const body = stripJsxComments(cellJsx).trim();
  const problems = [];
  const badges = (body.match(/<Badge\b/g) || []).length;
  if (!badges) return ['no badges'];
  const open = body.match(/^<div className="cell-chip-stack">/);
  if (!open || !/<\/div>$/.test(body)) problems.push('the cell is not one .cell-chip-stack (its badges stand straight in the cell, flex items on a phone)');
  const wrapped = (body.match(/<div>\s*<Badge\b[\s\S]*?<\/Badge>\s*<\/div>/g) || []).length;
  if (wrapped !== badges) problems.push(`${badges - wrapped} of ${badges} badges are not each in their own <div> (one straight in the stack is a block, stretched to the widest)`);
  return problems;
}

const clients = read('src/pages/Clients.jsx');
const cells = [...clients.matchAll(/<td data-label="Status">([\s\S]*?)<\/td>/g)].map((m) => m[1]);
ok('§2 the Customers list has one Status cell', cells.length === 1, `found ${cells.length}`);
const cell = cells[0] || '';
const problems = cellProblems(cell);
ok('§2 its badges stand whole: one .cell-chip-stack, each badge in its own <div>', problems.length === 0, problems.join('; '));
ok('§2 …the status is there', /<Badge variant=\{DERIVED_STATUS_VARIANTS\[st\]\}/.test(cell));
ok('§2 …the ticket flag is there (WO-14)', /ticketFlags\.isFlagged\(cl\.id\)[\s\S]*?<Badge variant="red"/.test(cell));
ok('§2 …the supply budget flag is there (SUP-7)', /supplyBudgets\.isOver\(cl\.id\)[\s\S]*?Over supply budget/.test(cell));

// ── §3 the checker on fixtures ───────────────────────────────────────────────────────────────────

const sideBySide = `
  <Badge variant="green">Active</Badge>
  {flagged && (<Badge variant="red">3 tickets in 30 days</Badge>)}`;
const straightInStack = `
  <div className="cell-chip-stack">
    <div><Badge variant="green">Active</Badge></div>
    <Badge variant="red">Over supply budget</Badge>
  </div>`;
const leftOutside = `
  <div className="cell-chip-stack">
    <div><Badge variant="green">Active</Badge></div>
  </div>
  <Badge variant="red">Over supply budget</Badge>`;
const fixed = `
  {/* a comment */}
  <div className="cell-chip-stack">
    <div><Badge variant="green">Active</Badge></div>
    {flagged && (
      <div><Badge variant="red" title={label}>{label}</Badge></div>
    )}
  </div>`;
ok('§3 badges side by side in the cell are caught', cellProblems(sideBySide).length > 0);
ok('§3 a badge straight in the stack is caught', cellProblems(straightInStack).some((p) => /own <div>/.test(p)), cellProblems(straightInStack).join('; '));
ok('§3 a badge left outside the stack is caught', cellProblems(leftOutside).length > 0, cellProblems(leftOutside).join('; '));
ok('§3 the fixed cell passes', cellProblems(fixed).length === 0, cellProblems(fixed).join('; '));
ok('§3 a top-level rule is found and one inside @media is not', (() => {
  const r = topLevelRules('@media (max-width: 640px) { .a > * { display: block; } }\n.b > * { display: block; }');
  return r.length === 1 && r[0].selector === '.b > *';
})());

console.log(`test-customer-status-cell: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
