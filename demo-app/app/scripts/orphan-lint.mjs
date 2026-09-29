// orphan-lint — the build-failing sweep for imported-but-never-used bindings.
//
// WHY THIS EXISTS. `no-unused-vars` in eslint.config.js runs with
// `varsIgnorePattern: '^[A-Z_]'`, which exempts every capitalised identifier — i.e. every
// React component — so an orphaned component import is structurally invisible to eslint.
// That is deliberate, not a misconfiguration: base `no-unused-vars` cannot see JSX usage,
// the rule that teaches it to (`react/jsx-uses-vars`) lives in `eslint-plugin-react` which
// is NOT a dependency here, and tightening the pattern was measured at 598 false positives.
//
// The gap was real: a dead `import Select from '../components/Select'` sat in
// ChangeOrders.jsx while BUILD_INTEGRITY §1.5 claimed "an orphan or unwired reference FAILS
// A LINT — it does not ship." It didn't. Playbook audit §5.2, and §9.18 more generally: the
// shared primitives existed, the SWEEP did not. This is the sweep.
//
// 🔴 AST-BASED, NOT REGEX, AND THAT IS LOAD-BEARING. The first cut of this file stripped
// comments and strings with regexes and reported 126 orphans, essentially ALL FALSE: an
// apostrophe in ordinary prose ("edit per-user overrides from a member's page") opens a
// string literal that swallows the rest of the file, so every later usage disappeared. A
// sweep with false positives is worse than the gap it closes — people learn to ignore it.
// Parse properly or do not ship. @babel/parser is already available via
// @vitejs/plugin-react; wiring-lint.mjs uses the same import + walker pattern.
//
// Usage:
//   node scripts/orphan-lint.mjs             # from app/ — exit 1 on any orphan
//   node scripts/orphan-lint.mjs --verbose   # also list files scanned
//
// Escape hatch, mirroring design-lint's:
//   // orphan-lint:allow <name> — reason        (on the import line, or the line above)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

// Same posture as wiring-lint: a missing parser must never look like a clean run, and
// must never block a ship either.
let parse;
try {
  ({ parse } = await import('@babel/parser'));
} catch {
  console.log('\norphan-lint: SKIPPED — @babel/parser not resolvable. Run `npm --prefix app install`.');
  console.log('  (this is NOT a clean result — no files were checked)\n');
  process.exit(0);
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    if (fs.statSync(p).isDirectory()) walkFiles(p, out);
    else if (/\.(jsx?|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

// Tiny AST walker — no @babel/traverse dependency (wiring-lint.mjs:59).
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    walk(node[key], visit);
  }
}

const rel = (f) => path.relative(SRC, f).replace(/\\/g, '/');
const files = walkFiles(SRC);
const findings = [];
let parsed = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  let ast;
  try {
    ast = parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  } catch (e) {
    if (VERBOSE) console.log(`  (unparseable, skipped) ${rel(file)} — ${e.message}`);
    continue;
  }
  parsed += 1;

  // 1. Collect every binding an import statement introduces.
  //
  // `skip` holds the Identifier NODES that are declarations or non-reference positions,
  // by OBJECT IDENTITY. Identity matters: the walker visits a node and then recurses into
  // its children regardless of what the visitor returns, so "return early on
  // ImportDeclaration" does NOT prune its subtree — the specifier's own Identifier would
  // still be counted as a reference and every import would look used. That bug made the
  // first AST cut report a clean codebase while a known dead import sat in the probe file.
  const bindings = new Map(); // localName -> line
  const skip = new Set();     // Identifier nodes that are NOT references
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration') {
      for (const s of n.specifiers || []) {
        if (s.local?.name) {
          bindings.set(s.local.name, s.local.loc?.start.line ?? n.loc?.start.line ?? 0);
          skip.add(s.local);
        }
        if (s.imported) skip.add(s.imported); // `{ a as b }` — `a` is the source name
      }
      return;
    }
    // `obj.Select` — the property is not a reference to the binding.
    if (n.type === 'MemberExpression' && !n.computed && n.property?.type === 'Identifier') skip.add(n.property);
    // `{ Select: 1 }` — a literal key is not a reference. Shorthand `{ Select }` IS.
    if ((n.type === 'ObjectProperty' || n.type === 'Property') && !n.computed && !n.shorthand
        && n.key?.type === 'Identifier') skip.add(n.key);
    // `<div Select="x" />` — an attribute NAME is not a reference.
    if (n.type === 'JSXAttribute' && n.name?.type === 'JSXIdentifier') skip.add(n.name);
    // Declarations shadowing a name are not references to the import either.
    if (n.type === 'ObjectMethod' && !n.computed && n.key?.type === 'Identifier') skip.add(n.key);
  });
  if (!bindings.size) continue;

  // 2. Every remaining Identifier / JSXIdentifier is a genuine reference.
  const used = new Set();
  walk(ast, (n) => {
    if ((n.type === 'Identifier' || n.type === 'JSXIdentifier') && !skip.has(n)) used.add(n.name);
  });

  for (const [name, line] of bindings) {
    if (used.has(name)) continue;

    // Escape hatch
    const allowed = [line - 1, line - 2].some((i) => {
      const ln = lines[i];
      const m = ln && ln.match(/orphan-lint:allow\s+([A-Za-z_$][\w$]*)/);
      return m && m[1] === name;
    });
    if (allowed) continue;

    findings.push({ file: rel(file), line, name });
  }
}

console.log(`\norphan-lint — ${parsed}/${files.length} files parsed under src/`);
if (findings.length) {
  console.error(`\n✖ ${findings.length} orphaned import(s) — imported but never referenced:\n`);
  for (const f of findings) console.error(`    ${f.file}:${f.line}  ${f.name}`);
  console.error('\n  Delete the import, or annotate it:  // orphan-lint:allow <name> — reason\n');
  process.exit(1);
}
console.log('  ✓ no orphaned imports\n');
