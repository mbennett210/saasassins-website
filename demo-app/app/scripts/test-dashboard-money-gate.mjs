// Q24: AN ADMIN SEES NO MONEY ON THE DASHBOARD (CS-020; S128 full-app pass F1-16).
//
// The operational Dashboard is the home an ADMIN lands on. Its hero "Collected" figure and the
// "Weekly Revenue (Paid)" chart were gated only on `!isCrew`, so every admin saw the month's
// collected revenue and the week's paid revenue — while Q24 gives money to `invoices.view`
// (owner + manager by default, never admin; lib/roles) and the page already gated its Financial
// Snapshot on exactly that key.
//
// The gate is JSX render logic, so this reads the page's AST (@babel/parser, as orphan-lint does):
// every element that shows a money figure — the hero's Collected, the weekly revenue chart, the
// Financial Snapshot — must sit under a conditional that tests `canInvoices`, which must be
// `usePermission('invoices.view')`. And the rule itself, from the source of truth: the default
// matrix gives `invoices.view` to the owner and the manager and not to the admin.
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`186fffb0`) the hero's Collected and
// the Weekly Revenue chart are gated on `!isCrew` alone (2 FAIL); the Snapshot control passes.
//
//   node app/scripts/test-dashboard-money-gate.mjs
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { PERMISSIONS, can } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). This suite is label-first.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// ── the rule, from the source of truth ───────────────────────────────────────
const holds = (role) => can({ id: 'u', role }, 'invoices.view', null, null);
ok('R1 invoices.view is the money key and exists', !!PERMISSIONS['invoices.view']);
ok('R2 the owner and the manager hold it by default', holds('owner') && holds('manager'));
ok('R3 🔴 an ADMIN does not (Q24)', !holds('admin'));
ok('R4 nor does crew', !holds('crew'));

// ── the page ─────────────────────────────────────────────────────────────────
const SRC = readFileSync(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8');
ok('P1 the page reads the key into canInvoices', /const canInvoices = usePermission\('invoices\.view'\);/.test(SRC));
const ast = parse(SRC, { sourceType: 'module', plugins: ['jsx'] });

// Walk the tree keeping the ancestor chain; record every JSX element whose own text (or a
// child's string literal) contains one of the money labels, with the conditionals above it.
const MONEY = [
  { label: 'the hero\'s Collected figure', match: (txt) => txt === 'Collected' },
  { label: 'the Weekly Revenue (Paid) chart', match: (txt) => txt === 'Weekly Revenue (Paid)' },
  { label: 'the Financial Snapshot (control)', match: (txt) => txt.startsWith('Financial Snapshot') },
];
const found = MONEY.map(() => []);
const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string';
const testsCanInvoices = (expr) => {
  let hit = false;
  const visit = (n) => {
    if (!isNode(n) || hit) return;
    if (n.type === 'Identifier' && n.name === 'canInvoices') { hit = true; return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit); else if (isNode(v)) visit(v);
    }
  };
  visit(expr);
  return hit;
};
function walk(node, chain) {
  if (!isNode(node)) return;
  if (node.type === 'JSXText') {
    const txt = node.value.replace(/\s+/g, ' ').trim();
    MONEY.forEach((m, i) => { if (txt && m.match(txt)) found[i].push(chain); });
  }
  const next = [...chain, node];
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, next)); else if (isNode(v)) walk(v, next);
  }
}
walk(ast.program, []);
// Gated = some ancestor is a `x && <jsx>` (or a ternary) whose TEST mentions canInvoices.
const gated = (chain) => chain.some((n, i) => {
  const child = chain[i + 1];
  if (n.type === 'LogicalExpression' && n.operator === '&&' && child === n.right) return testsCanInvoices(n.left);
  if (n.type === 'ConditionalExpression' && (child === n.consequent)) return testsCanInvoices(n.test);
  return false;
});
MONEY.forEach((m, i) => {
  ok(`G${i + 1} ${m.label} is on the page`, found[i].length > 0);
  ok(`G${i + 1} ${i < 2 ? '🔴 ' : ''}${m.label} is shown only to an invoices.view holder`, found[i].length > 0 && found[i].every(gated),
    `${found[i].filter((c) => !gated(c)).length} of ${found[i].length} ungated`);
});

console.log(`\n${pass}/${pass + fails.length} dashboard money-gate checks passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exitCode = fails.length ? 1 : 0;
