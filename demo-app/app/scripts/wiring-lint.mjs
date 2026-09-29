#!/usr/bin/env node
/**
 * wiring-lint — write-path completeness checker (zero-token, AST-based).
 *
 * Catches the class of defect that shipped on 2026-07-20: a field the user can edit
 * that never reaches the write, and a field that reaches EVERY record because nothing
 * guards it. See app/wiring.contract.mjs for the full why.
 *
 *   R1 (silent drop)      field written by the SINGLE path, absent from the MULTI path
 *   R2 (unguarded spread) field in a fan-out patch whose presence is not conditional
 *   GREY                  a fan-out action dispatched from a file no pair declares
 *
 * Usage:
 *   node scripts/wiring-lint.mjs [--json] [--verbose] [paths...]
 *   node scripts/wiring-lint.mjs --accept "<id>" --note "<why>"
 *
 * EXITS 0 ALWAYS (except an internal error). This reports; it never blocks a deploy.
 * GREY findings cannot be baselined — declare the file in the contract instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SRC = path.join(APP, 'src');
const CONTRACT = path.join(APP, 'wiring.contract.mjs');
const BASELINE = path.join(APP, 'wiring.baseline.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const JSON_OUT = flag('--json');
const VERBOSE = flag('--verbose');
const ACCEPT = opt('--accept', null);
const NOTE = opt('--note', null);
const RESERVED = new Set(['--json', '--verbose', '--accept', '--note']);
const explicitPaths = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && RESERVED.has(args[i - 1]) && args[i - 1] !== '--json' && args[i - 1] !== '--verbose'));

// ── parser ───────────────────────────────────────────────────────────────────
// @babel/parser arrives via @vitejs/plugin-react (a direct devDependency), so it is
// present after a normal install. If it ever is not, say so and exit 0 — a missing
// linter must never look like a clean run, and must never block a ship either.
let parse;
try {
  ({ parse } = await import('@babel/parser'));
} catch {
  console.log('\nwiring-lint: SKIPPED — @babel/parser not resolvable. Run `npm --prefix app install`.');
  console.log('  (this is NOT a clean result — no files were checked)\n');
  process.exit(0);
}

const contract = await import(pathToFileURL(CONTRACT).href);
const { WRITE_PAIRS = [], FANOUT_ACTIONS = [], DISPATCH_NAMES = ['dispatch'] } = contract;
const contractHash = crypto.createHash('sha256')
  .update(fs.readFileSync(CONTRACT, 'utf8')).digest('hex').slice(0, 12);

// ── tiny AST walker (no @babel/traverse dependency) ──────────────────────────
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit, ancestors); return; }
  if (typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = ancestors.concat(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    walk(node[key], visit, next);
  }
}

const isGuarded = (ancestors) => ancestors.some((a) =>
  a.type === 'IfStatement' || a.type === 'ConditionalExpression' || a.type === 'LogicalExpression');

/**
 * Resolve an expression used as a `patch:` value into { fields: Map<name, guarded> }.
 * Handles the three shapes this codebase actually uses:
 *   1. object literal                       { a, b }                    → unguarded
 *   2. conditional spread                   { ...(c ? { a } : {}) }     → guarded
 *   3. identifier built by if-assignment    const s = {}; if (…) s.a=…  → guarded
 */
function resolveFields(expr, ast, seen = new Set()) {
  const fields = new Map();
  const add = (name, guarded) => {
    if (!fields.has(name)) fields.set(name, guarded);
    else if (!guarded) fields.set(name, false); // any unguarded write makes it unguarded
  };

  if (!expr) return fields;

  if (expr.type === 'ObjectExpression') {
    for (const p of expr.properties) {
      if (p.type === 'ObjectProperty' || p.type === 'Property') {
        const name = p.key?.name || p.key?.value;
        if (name) add(name, false);
      } else if (p.type === 'SpreadElement') {
        const arg = p.argument;
        if (arg.type === 'ConditionalExpression' || arg.type === 'LogicalExpression') {
          // ...(changed ? { crewIds } : {}) — every field inside is guarded
          for (const branch of [arg.consequent, arg.alternate, arg.left, arg.right]) {
            if (branch?.type === 'ObjectExpression') {
              for (const [n] of resolveFields(branch, ast, seen)) add(n, true);
            }
          }
        } else {
          for (const [n, g] of resolveFields(arg, ast, seen)) add(n, g);
        }
      }
    }
    return fields;
  }

  if (expr.type === 'Identifier') {
    if (seen.has(expr.name)) return fields;
    seen.add(expr.name);
    // init: const <name> = <expr>
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id?.name === expr.name && node.init) {
        for (const [n, g] of resolveFields(node.init, ast, seen)) add(n, g);
      }
    });
    // member assignment: <name>.<field> = …  (guarded iff inside an if/ternary)
    walk(ast, (node, anc) => {
      if (node.type === 'AssignmentExpression'
        && node.left?.type === 'MemberExpression'
        && node.left.object?.name === expr.name
        && !node.left.computed) {
        const name = node.left.property?.name;
        if (name) add(name, isGuarded(anc));
      }
    });
    return fields;
  }

  return fields;
}

/** Every `dispatch({ type: ACTIONS.X, … })` in a file. */
function findDispatches(ast) {
  const out = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    const name = callee?.name || (callee?.type === 'MemberExpression' ? callee.property?.name : null);
    if (!DISPATCH_NAMES.includes(name)) return;
    const arg = node.arguments?.[0];
    if (arg?.type !== 'ObjectExpression') return;
    let action = null; let patchExpr = null;
    for (const p of arg.properties) {
      if (p.type !== 'ObjectProperty' && p.type !== 'Property') continue;
      const k = p.key?.name || p.key?.value;
      if (k === 'type') {
        const v = p.value;
        action = v?.type === 'MemberExpression' ? v.property?.name : (v?.value ?? null);
      } else if (k === 'patch') {
        patchExpr = p.value;
      }
    }
    if (action) out.push({ action, patchExpr, line: node.loc?.start?.line ?? 0 });
  });
  return out;
}

// ── collect files ────────────────────────────────────────────────────────────
const listFiles = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(f));
    else if (/\.jsx?$/.test(e.name)) out.push(f);
  }
  return out;
};
const files = explicitPaths.length
  ? explicitPaths.map((p) => path.resolve(p))
  : listFiles(SRC);

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

// ── run the rules ────────────────────────────────────────────────────────────
const findings = [];
let parsedCount = 0;

for (const file of files) {
  let ast;
  try {
    ast = parse(fs.readFileSync(file, 'utf8'), {
      sourceType: 'module', plugins: ['jsx'], errorRecovery: true,
    });
  } catch (e) {
    if (VERBOSE) console.log(`  (unparseable, skipped) ${rel(file)} — ${e.message}`);
    continue;
  }
  parsedCount += 1;
  const r = rel(file);
  const dispatches = findDispatches(ast);
  if (!dispatches.length) continue;

  // ── R1: single path writes a field the multi path never carries ──────────
  for (const pair of WRITE_PAIRS) {
    if (!pair.files.includes(r)) continue;
    const singles = dispatches.filter((d) => d.action === pair.single);
    const multis = dispatches.filter((d) => d.action === pair.multi);
    if (!singles.length || !multis.length) continue;

    const singleFields = new Set();
    for (const d of singles) for (const [n] of resolveFields(d.patchExpr, ast)) singleFields.add(n);
    const multiFields = new Set();
    for (const d of multis) for (const [n] of resolveFields(d.patchExpr, ast)) multiFields.add(n);

    for (const f of singleFields) {
      if (multiFields.has(f)) continue;
      if (pair.multiExclusions && f in pair.multiExclusions) continue;
      findings.push({
        rule: 'R1', id: `R1:${r}:${pair.id}:${f}`, file: r, line: multis[0].line, field: f, pair: pair.id,
        msg: `\`${f}\` is written by ${pair.single} but never carried by ${pair.multi} — a multi-scope edit of this field reports success and changes nothing`,
      });
    }
  }

  // ── R2: a fan-out patch field whose presence is not conditional ──────────
  for (const d of dispatches) {
    if (!FANOUT_ACTIONS.includes(d.action)) continue;
    const declared = WRITE_PAIRS.find((p) => p.multi === d.action && p.files.includes(r));
    if (!declared) {
      findings.push({
        rule: 'GREY', id: `GREY:${r}:${d.action}`, file: r, line: d.line, field: null, pair: null,
        msg: `${d.action} is dispatched here, but no contract pair declares this file — undeclared write-path drift`,
      });
      continue;
    }
    for (const [f, guarded] of resolveFields(d.patchExpr, ast)) {
      if (guarded) continue;
      findings.push({
        rule: 'R2', id: `R2:${r}:${declared.id}:${f}`, file: r, line: d.line, field: f, pair: declared.id,
        msg: `\`${f}\` rides the ${d.action} patch unconditionally — it is spread onto every matched record, flattening that field across the set`,
      });
    }
  }
}

// ── baseline ─────────────────────────────────────────────────────────────────
const loadBaseline = () => {
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); }
  catch { return { version: 1, accepted: {} }; }
};
const baseline = loadBaseline();

if (ACCEPT) {
  if (ACCEPT.startsWith('GREY:')) {
    console.error(`\nwiring-lint: GREY findings cannot be baselined — declare the file in wiring.contract.mjs instead.\n`);
    process.exit(0);
  }
  if (!NOTE) {
    console.error(`\nwiring-lint: --accept requires --note "<why>" — an unexplained acceptance is indistinguishable from the bug.\n`);
    process.exit(0);
  }
  baseline.accepted[ACCEPT] = { note: NOTE, acceptedAt: new Date().toISOString(), contractHash };
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nwiring-lint: accepted ${ACCEPT}\n  reason: ${NOTE}\n`);
  process.exit(0);
}

const isAccepted = (f) => f.rule !== 'GREY' && !!baseline.accepted[f.id];
const open = findings.filter((f) => !isAccepted(f));
const silenced = findings.filter(isAccepted);

// ── report ───────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ contractHash, parsed: parsedCount, open, silenced }, null, 2));
  process.exit(0);
}

const BY = { R1: 'R1 silent drop', R2: 'R2 unguarded spread', GREY: 'GREY undeclared drift' };
console.log(`\nwiring-lint — ${parsedCount} files parsed · contract ${contractHash}`);
if (!open.length) {
  console.log(`  ✓ no open findings${silenced.length ? ` (${silenced.length} accepted in baseline)` : ''}\n`);
} else {
  for (const rule of ['GREY', 'R1', 'R2']) {
    const rows = open.filter((f) => f.rule === rule);
    if (!rows.length) continue;
    console.log(`\n  ${BY[rule]} — ${rows.length}`);
    for (const f of rows) {
      console.log(`    ${f.file}:${f.line}  ${f.msg}`);
      console.log(`      id: ${f.id}`);
    }
  }
  console.log(`\n  ${open.length} open finding(s). Fix, or accept one with a reason:`);
  console.log(`    npm --prefix app run lint:wiring -- --accept "<id>" --note "<why>"`);
  console.log(`  GREY cannot be accepted — declare the file in app/wiring.contract.mjs.\n`);
}
if (silenced.length && VERBOSE) {
  console.log(`  accepted (baseline):`);
  for (const f of silenced) console.log(`    ${f.id} — ${baseline.accepted[f.id].note}`);
  console.log('');
}
process.exit(0);
