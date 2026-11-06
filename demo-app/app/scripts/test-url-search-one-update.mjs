// CS-720 — a search box and its page reset are ONE address update, everywhere.
//
// react-router's `setSearchParams` builds its next address from the params of the LAST RENDER,
// in its object form and its functional form alike (`nextInit(new URLSearchParams(searchParams))`).
// So two updates in one event start from the same old address, and the second one wins: on
// Supplies, `setQ(v); setParam({ page: null })` dropped the search on every key, on the plain
// demo too — the requests search, the By building search (`setBq`/`bp`) and the master supply
// list's search (`cq`/`cp`) never kept a letter (S128 full-app pass, F11-02). The same defect was
// fixed once before, only in ChecklistAssignments (CS-525).
//
//   1. Mechanically, across app/src: no statement list calls two address writers in a row —
//      the setters of useSearchParams / useTableSearch / useUrlFilters, a pager that keeps its
//      page in the address, and every local helper built on one (to a fixpoint).
//   2. useTableSearch takes the params a new search must clear (`{ reset }`) and writes them in
//      the SAME update; Supplies' two searches and the Catalog's use it.
//
// Offline. Run: node scripts/test-url-search-one-update.mjs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const walkFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (
  d.isDirectory() ? walkFiles(path.join(dir, d.name)) : (/\.(jsx?)$/.test(d.name) ? [path.join(dir, d.name)] : [])
));
function visit(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'parent') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => visit(c, fn, node));
    else if (v && typeof v.type === 'string') visit(v, fn, node);
  }
}
const calleeName = (callee) => {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') return `${callee.object.name}.${callee.property.name}`;
  return null;
};
const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');
const fnOfInit = (init) => {
  if (isFn(init)) return init;
  if (init && init.type === 'CallExpression' && calleeName(init.callee) === 'useCallback' && isFn(init.arguments[0])) return init.arguments[0];
  return null;
};

// The address writers a file binds (by name, file-wide: a setter handed down as a prop keeps it).
function writersOf(ast) {
  const w = new Set(['setSearchParams']);
  const helpers = [];
  visit(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || !n.init) return;
    const init = n.init;
    const hook = init.type === 'CallExpression' ? calleeName(init.callee) : null;
    if ((hook === 'useSearchParams' || hook === 'useTableSearch') && n.id.type === 'ArrayPattern' && n.id.elements[1]?.type === 'Identifier') w.add(n.id.elements[1].name);
    if (hook === 'useUrlFilters') {
      if (n.id.type === 'ObjectPattern') {
        for (const p of n.id.properties) {
          const key = p.key && p.key.name;
          if ((key === 'setValue' || key === 'clearAll') && p.value.type === 'Identifier') w.add(p.value.name);
        }
      } else if (n.id.type === 'Identifier') { w.add(`${n.id.name}.setValue`); w.add(`${n.id.name}.clearAll`); }
    }
    if (hook === 'usePagedRows' && n.id.type === 'Identifier') {
      const opts = init.arguments[1];
      if (opts && opts.type === 'ObjectExpression' && opts.properties.some((p) => p.key && p.key.name === 'param')) { w.add(`${n.id.name}.setPage`); w.add(`${n.id.name}.goToLast`); }
    }
    if (hook === 'useServerPager' && n.id.type === 'Identifier') w.add(`${n.id.name}.setPage`);
    const fn = fnOfInit(init);
    if (fn && n.id.type === 'Identifier') helpers.push([n.id.name, fn]);
  });
  // A helper that calls a writer is a writer (to a fixpoint: a helper of a helper).
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, fn] of helpers) {
      if (w.has(name)) continue;
      let calls = false;
      visit(fn.body, (n) => { if (n.type === 'CallExpression' && w.has(calleeName(n.callee))) calls = true; });
      if (calls) { w.add(name); changed = true; }
    }
  }
  return w;
}

// Statement lists (a block, a program, a switch case) that call two writers in a row.
function twoWriterRuns(ast, w) {
  const hits = [];
  visit(ast, (n) => {
    const list = n.type === 'BlockStatement' || n.type === 'Program' ? n.body : (n.type === 'SwitchCase' ? n.consequent : null);
    if (!list) return;
    const calls = list
      .filter((s) => s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' && w.has(calleeName(s.expression.callee)))
      .map((s) => ({ name: calleeName(s.expression.callee), line: s.loc.start.line }));
    if (calls.length >= 2) hits.push(calls);
  });
  return hits;
}

const found = [];
let files = 0;
for (const file of walkFiles(SRC)) {
  const src = readFileSync(file, 'utf8');
  if (!/useSearchParams|useTableSearch|useUrlFilters|usePagedRows|useServerPager|setParam/.test(src)) continue;
  files += 1;
  let ast;
  try { ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true }); } catch (e) { fails.push(`parse ${path.relative(SRC, file)}: ${e.message}`); continue; }
  for (const run of twoWriterRuns(ast, writersOf(ast))) {
    found.push(`${path.relative(SRC, file).split(path.sep).join('/')}:${run[0].line} ${run.map((c) => c.name).join(' + ')}`);
  }
}
ok(`scanned the files that write the address (${files})`, files >= 20);
ok(`no handler writes the address twice in a row — found ${found.length}:\n        ${found.join('\n        ')}`, found.length === 0);

// The guard sees the shape it exists for (a fixture, so the scan can never go blind).
{
  const fixture = `import { useTableSearch } from 'x';
    export default function A() {
      const [q, setQ] = useTableSearch('q');
      const [params, setParams] = useSearchParams();
      const setParam = (patch) => setParams((prev) => prev);
      return <input onChange={(e) => { setQ(e.target.value); setParam({ page: null }); }} />;
    }`;
  const ast = espree.parse(fixture, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true });
  ok('the guard catches `setQ(v); setParam({ page: null })`', twoWriterRuns(ast, writersOf(ast)).length === 1);
  const branches = `export default function B() {
      const [p, setParams] = useSearchParams();
      const go = (a) => { if (a) setParams('x'); else setParams('y'); };
      return null;
    }`;
  const ast2 = espree.parse(branches, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true });
  ok('…and not one writer per branch of an if/else', twoWriterRuns(ast2, writersOf(ast2)).length === 0);
}

// 2. the hook writes a search and the params it clears in ONE update
{
  const hook = readFileSync(path.join(SRC, 'hooks/useTableSearch.js'), 'utf8');
  ok('useTableSearch takes the params a new search clears', /export function useTableSearch\(key = 'q', \{ reset/.test(hook));
  ok('…and deletes them inside the same setParams update', /setParams\(\(prev\) => \{[\s\S]{0,300}for \(const k of resetKeys\) next\.delete\(k\)[\s\S]{0,120}\}, \{ replace: true \}\)/.test(hook));
  const supplies = readFileSync(path.join(SRC, 'pages/Supplies.jsx'), 'utf8');
  // S131: the Requests tab's table is the order queue (components/SupplyQueue), one implementation.
  const queue = readFileSync(path.join(SRC, 'components/SupplyQueue.jsx'), 'utf8');
  ok('Supplies requests: the search clears ?page= in its own update', /useTableSearch\('q', \{ reset: \['page'\] \}\)/.test(queue) && /<TableSearch value=\{q\} onChange=\{setQ\}/.test(queue));
  ok('Supplies By building: the search clears ?bp= in its own update', /useTableSearch\('bq', \{ reset: \['bp'\] \}\)/.test(supplies) && /<TableSearch value=\{bq\} onChange=\{setBq\}/.test(supplies));
  const catalog = readFileSync(path.join(SRC, 'components/SupplyCatalog.jsx'), 'utf8');
  ok('the Catalog: the search clears ?cp= in its own update', /useTableSearch\('cq', \{ reset: \['cp'\] \}\)/.test(catalog) && /<TableSearch value=\{q\} onChange=\{setQ\}/.test(catalog));
  // The requests search lives in the table's head: a refetch that blanks the table to
  // "Loading…" unmounts the field after the first key. Only a different VIEW starts blank.
  ok('the requests table keeps its rows (and its search box) while a search loads',
    !/setQueueErr\(null\);\s*setQueue\(null\);/.test(queue) && /if \(shownView\.current !== viewKey\) \{ shownView\.current = viewKey; setQueue\(null\); \}/.test(queue));
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\nurl search one update: ${pass}/${pass} passed`);
}
