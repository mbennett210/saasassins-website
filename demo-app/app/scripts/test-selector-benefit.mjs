// useSelector migrations must actually DO something (§8 0.4 / E3).
//
// ══ THE TRAP THIS CATCHES ═════════════════════════════════════════════════════
// selectionCache.js made useSelector loop-proof by construction: keying on
// (snapshot, selector, isEqual) identity means the worst case is "no perf gain"
// rather than the React #185 white screen the naive value-equality cache produced.
//
// That safety has a cost — THE FAILURE IS NOW SILENT. An ALLOCATING selector
// (`.filter`, `.map`, an object literal, `|| []`) with the DEFAULT Object.is comparer
// returns a fresh reference on every store change, so `isEqual` never holds, so the
// consumer re-renders on every dispatch. Which is exactly what useStore() already did.
// The file looks migrated. The diff looks like progress. Nothing got faster.
//
// That is the same class of defect as the blob-budget guard that shipped INERT by
// checking field names that did not exist: working-looking code, zero effect, and a
// test suite written from the same premise as the code would agree with it.
//
// So: every useSelector call whose selector ALLOCATES must pass a comparer.
// Reference-returning selectors (`s => s.company`) must NOT — Object.is is correct
// and shallowEqual would just be a slower Object.is.
//
//   node scripts/test-selector-benefit.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(jsx?|tsx?)$/.test(p)) out.push(p);
  }
  return out;
}

// ══ WHAT ACTUALLY MATTERS IS THE RETURN VALUE, NOT THE BODY ═══════════════════
// The first version of this checker tested whether a selector's body CONTAINED an
// allocating operation. That is the wrong question twice over:
//   · selectUnreadNotificationCount uses `.reduce` over `s.notifications || []` and
//     returns A NUMBER. Object.is compares that perfectly — flagging it is crying wolf.
//   · a selector can allocate internally and still return an existing element.
// So classify the RETURN EXPRESSIONS: does the value handed to the comparer come back
// as a fresh reference each call?
const FRESH_TAIL = /\.(filter|map|sort|slice|concat|flatMap|reverse|split)\s*\([\s\S]*\)\s*$/;
const PRIMITIVE = /^(\d|['"`]|true\b|false\b|null\b|!|.*\.length\s*$)/;

// 'fresh' = new reference every call (needs a comparer)
// 'stable' = existing reference or a primitive (Object.is is correct)
// 'unknown' = could not judge; REPORTED rather than silently skipped
// ⚠️ PRECEDENCE IS THE WHOLE ALGORITHM. The first version tested `|| []` before
// `.reduce`, so `(s.notifications || []).reduce(…, 0)` was called 'fresh' when it
// returns a NUMBER. The outermost operation decides the return shape; an inner
// allocation the outer op consumes is irrelevant to the comparer.
function classifyReturn(expr) {
  const e = expr.trim().replace(/\s+/g, ' ');
  if (!e) return 'unknown';

  // 1. A terminal fold collapses whatever it consumed. The SEED decides the shape.
  if (/\.reduce\s*\([\s\S]*\)\s*$/.test(e)) {
    if (/,\s*(\{\}|\[\]|new (Map|Set)\([^)]*\))\s*\)\s*$/.test(e)) return 'fresh';
    if (/,\s*(-?\d+|''|""|``|null|true|false)\s*\)\s*$/.test(e)) return 'stable';
    return 'unknown';
  }
  // 2. Terminal predicates/lookups return primitives or EXISTING elements.
  if (/\.(some|every|includes|indexOf|findIndex|join)\s*\([\s\S]*\)\s*$/.test(e)) return 'stable';
  if (/\.(find|at|pop|shift)\s*\([\s\S]*\)\s*$/.test(e)) return 'stable';
  if (/\.(find|at)\s*\([\s\S]*\)\s*\|\|\s*null\s*$/.test(e)) return 'stable';
  // 3. The shared frozen empty is the fix this checker exists to promote.
  if (/\|\|\s*EMPTY_ARRAY\s*$/.test(e)) return 'stable';
  // 4. Genuine fresh references.
  if (/^\[/.test(e)) return 'fresh';                             // array literal
  if (/^\{/.test(e) || /^\(\s*\{/.test(e)) return 'fresh';       // object literal
  if (/\|\|\s*\[\]\s*$|\|\|\s*\{\}\s*$/.test(e)) return 'fresh'; // allocating fallback
  if (/^Object\.(keys|values|entries)\s*\(/.test(e)) return 'fresh';
  if (/^new (Map|Set|Date)\s*\(/.test(e)) return 'fresh';
  if (FRESH_TAIL.test(e)) return 'fresh';                        // chain ENDING in an allocator
  // 4b. A ternary is as fresh as its freshest branch — same principle as the OR chain
  // below, and the shape `Array.isArray(x) ? x : EMPTY_ARRAY` is common here. Split on
  // the top-level `?` first, then the `:` of the remainder, so nested calls are safe.
  {
    const q = splitTopLevel(e, '?');
    if (q.length === 2) {
      const arms = splitTopLevel(q[1], ':');
      if (arms.length === 2) {
        const kinds = arms.map((a) => classifyReturn(a));
        if (kinds.includes('fresh')) return 'fresh';
        if (kinds.every((k) => k === 'stable')) return 'stable';
        return 'unknown';
      }
    }
  }
  // 5. An OR chain is as fresh as its freshest alternative. `s.x.find(…) || null` is
  // stable (existing element or a primitive); `site?.areas || []` is fresh HALF the
  // time, which is enough — the fallback branch allocates whenever the key is missing.
  // Splitting on top-level `||` is what lets the commonest shape in this file
  // (`.find(…) || null`) be judged instead of landing in 'unknown'.
  {
    const parts = splitTopLevel(e, '||');
    if (parts.length > 1) {
      const kinds = parts.map((p) => classifyReturn(p));
      if (kinds.includes('fresh')) return 'fresh';
      if (kinds.every((k) => k === 'stable')) return 'stable';
      return 'unknown';
    }
  }
  // 6. Primitives and plain reads.
  if (PRIMITIVE.test(e)) return 'stable';
  if (/^[\w.?[\]'"$]+$/.test(e)) return 'stable';                // a property/element read
  if (/^[\w.?[\]'"$]+\s*(\?\?|\|\|)\s*(null|0|''|""|false|true|-?\d+)\s*$/.test(e)) return 'stable';
  if (/^select\w+\s*\(/.test(e)) return 'delegate';              // resolved by the caller
  return 'unknown';
}

// Split on a top-level operator, ignoring anything nested in brackets. A naive
// String.split('||') would cut inside `(a || b).find(…)` and misjudge the whole thing.
function splitTopLevel(expr, op) {
  const out = []; let depth = 0; let last = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth === 0 && expr.startsWith(op, i)) {
      // A lone `?` is only a ternary if it is not `?.` (optional chaining) or `??`
      // (nullish coalescing). Without this, any selector using `site?.field` was
      // unjudgeable — and `x?.y ? a : b` is one of the commonest shapes in this file.
      if (op === '?' && (expr[i + 1] === '.' || expr[i + 1] === '?' || expr[i - 1] === '?')) continue;
      out.push(expr.slice(last, i)); i += op.length - 1; last = i + 1;
    }
  }
  out.push(expr.slice(last));
  return out.map((p) => p.trim()).filter(Boolean);
}

// Return expressions of a selector body. A concise arrow's body IS its return.
function returnExprs(body) {
  const b = body.trim();
  if (!/^\{/.test(b)) return [b.replace(/;$/, '')];
  return [...b.matchAll(/\breturn\s+([\s\S]*?);/g)].map((m) => m[1]);
}

// Combine a selector's returns into one verdict — any fresh return makes it fresh.
function combine(kinds, resolve, seen = new Set()) {
  let sawUnknown = false;
  for (const k of kinds) {
    if (k === 'fresh') return 'fresh';
    if (k === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'stable';
}

// ── build the selector map from selectors.js ────────────────────────────
// Read as source rather than imported: the same truth-source discipline the blob-budget
// test uses. NOTE the signature pattern — `[^)]*` was wrong and silently dropped every
// selector with a default argument containing parens, e.g.
// `selectTodayCleansForUser(s, userId, now = Date.now())`. Those were skipped, not
// judged, which is the failure mode this whole file exists to prevent.
const selectorsSrc = readFileSync(join(SRC, 'store', 'selectors.js'), 'utf8');
const selectorKind = new Map();
const selectorDeps = new Map();
function record(name, body) {
  const returns = returnExprs(body);
  const kinds = returns.map(classifyReturn);
  const delegated = [];
  returns.forEach((r, i) => {
    if (kinds[i] === 'delegate') {
      const d = /^(select\w+)/.exec(r.trim());
      if (d) delegated.push(d[1]);
    }
  });
  selectorDeps.set(name, delegated);
  selectorKind.set(name, combine(kinds.filter((k) => k !== 'delegate')));
  if (kinds.every((k) => k === 'delegate')) selectorKind.set(name, 'delegate');
}
// ⚠️ `(?![\s\S])`, NOT `$`. With the /m flag `$` matches the end of EVERY LINE, so the
// lazy body capture stopped at the first newline and every multi-line selector was
// recorded as the single character `{` — which classified as an object literal or as
// unknown. 61 selectors were being mis-judged by a one-character regex bug, in the very
// file whose purpose is to stop silent misclassification.
for (const m of selectorsSrc.matchAll(/^export const (select\w+)\s*=\s*\([\s\S]*?\)\s*=>\s*([\s\S]*?)(?=\nexport |\n\/\/ |(?![\s\S]))/gm)) record(m[1], m[2]);
for (const m of selectorsSrc.matchAll(/^export function (select\w+)\s*\([\s\S]*?\)\s*(\{[\s\S]*?\n\})/gm)) record(m[1], m[2]);

// Resolve delegates transitively (a selector that just forwards to another).
for (const [name, kind] of [...selectorKind]) {
  if (kind !== 'delegate') continue;
  const seen = new Set();
  let cur = name; let resolved = 'unknown';
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const deps = selectorDeps.get(cur) || [];
    if (!deps.length) break;
    const k = selectorKind.get(deps[0]);
    if (k && k !== 'delegate') { resolved = k; break; }
    cur = deps[0];
  }
  selectorKind.set(name, resolved);
}

const allocates = (expr) => classifyReturn(expr) === 'fresh';

ok(`selectors.js parsed (${selectorKind.size} selectors)`, selectorKind.size > 100);
ok('  ...a plain property read is stable', selectorKind.get('selectCompany') === 'stable');
ok('  ...a .filter() selector is fresh', selectorKind.get('selectActiveUsers') === 'fresh');
ok('  🔴 ...a default-arg signature is PARSED, not skipped (it was silently dropped)',
  selectorKind.get('selectTodayCleansForUser') === 'fresh');
ok('  🔴 ...a .reduce to a NUMBER is stable, not a false positive',
  selectorKind.get('selectUnreadNotificationCount') === 'stable');
ok('  ...a .find() returning an existing element is stable', selectorKind.get('selectJobById') === 'stable');
{
  const unknown = [...selectorKind].filter(([, k]) => k === 'unknown').map(([n]) => n);
  // Unknowns are REPORTED, never silently skipped — that is how the first version hid
  // selectTodayCleansForUser from itself.
  console.log(`  (unjudged selectors: ${unknown.length}${unknown.length ? ` — ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? '…' : ''}` : ''})`);
  ok('fewer than a third of selectors are unjudged', unknown.length < selectorKind.size / 3);
}

// ── scan every useSelector call site ────────────────────────────────────
const offenders = [];
const good = [];
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('useSelector(')) continue;
  if (file.endsWith(join('store', 'index.jsx'))) continue; // the definition itself

  // ⚠️ BALANCED SCAN, not a regex. `useSelector\(([\s\S]*?)\)\s*[;,)\]]` stops at the
  // first `)` followed by a delimiter — which for
  // `useSelector((s) => selectX(s, a, b), shallowEqual)` is the INNER call's paren. The
  // comparer was sliced off and a correctly-written call site was reported as a defect.
  // A checker that cries wolf gets ignored, which is worse than not having one.
  for (let i = src.indexOf('useSelector('); i !== -1; i = src.indexOf('useSelector(', i + 1)) {
    const open = i + 'useSelector('.length;
    let callDepth = 1; let j = open;
    for (; j < src.length && callDepth > 0; j += 1) {
      const c = src[j];
      if ('([{'.includes(c)) callDepth += 1;
      else if (')]}'.includes(c)) callDepth -= 1;
    }
    if (callDepth !== 0) continue; // unbalanced — not our business
    const args = src.slice(open, j - 1);
    // Split top-level comma to find a second argument (the comparer).
    let depth = 0; let split = -1;
    for (let i = 0; i < args.length; i += 1) {
      const c = args[i];
      if ('([{'.includes(c)) depth += 1;
      else if (')]}'.includes(c)) depth -= 1;
      else if (c === ',' && depth === 0) { split = i; break; }
    }
    const selectorExpr = (split === -1 ? args : args.slice(0, split)).trim();
    const comparer = split === -1 ? null : args.slice(split + 1).trim();

    // Does this selector allocate?
    //   1. a bare named selector          -> look it up
    //   2. an inline arrow that DELEGATES  -> inherit from the named selectors it calls
    //   3. an inline arrow that allocates itself -> inspect the text
    //
    // (2) matters and is easy to miss: `(s) => selectSiteById(s, id)` contains no
    // .filter/.map/literal of its own, so a text-only check would call it
    // reference-returning no matter what selectSiteById actually does. The parameterised
    // wrapper is the NORMAL shape for a migrated component, so this is the common case,
    // not an edge one.
    let allocating;
    const bare = /^select\w+$/.exec(selectorExpr);
    if (bare) {
      const k = selectorKind.get(bare[0]);
      allocating = k === 'fresh' ? true : k === 'stable' ? false : undefined;
    } else {
      // An inline arrow. Strip the parameter list so `(s) => …` is judged on its body.
      const body = selectorExpr.replace(/^\([^)]*\)\s*=>\s*/, '').replace(/^\w+\s*=>\s*/, '');
      const delegates = [...body.matchAll(/\b(select\w+)\s*\(/g)].map((x) => x[1]);
      const known = delegates.filter((d) => selectorKind.has(d) && selectorKind.get(d) !== 'unknown');
      if (allocates(body)) allocating = true;                     // allocates in its own right
      else if (known.length) allocating = known.some((d) => selectorKind.get(d) === 'fresh');
      else if (delegates.length) allocating = undefined;          // delegates to something unjudged
      else allocating = classifyReturn(body) === 'unknown' ? undefined : false;
    }

    const where = `${relative(SRC, file).replace(/\\/g, '/')}: useSelector(${selectorExpr.slice(0, 46).replace(/\s+/g, ' ')}…)`;
    if (allocating === undefined) continue; // unknown named selector — not our call to judge
    if (allocating && !comparer) offenders.push(where);
    else good.push(where);
  }
}

// ── 🔴 the assertion ────────────────────────────────────────────────────
ok(`every allocating useSelector passes a comparer (${good.length} call sites checked)`,
  offenders.length === 0);
if (offenders.length) {
  for (const o of offenders) fails.push(`  ↳ ALLOCATES BUT NO COMPARER (re-renders on every dispatch, so the migration bought nothing): ${o}`);
}
ok('there is at least one useSelector consumer to check', good.length + offenders.length > 0);

// ── the inverse: a reference selector must not carry shallowEqual ───────
// Harmless but misleading — it implies the selector allocates when it does not, and
// the next person copies the wrong pattern.
{
  const misleading = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/useSelector\(\s*(select\w+)\s*,\s*shallowEqual\s*\)/g)) {
      if (selectorKind.get(m[1]) === "stable") misleading.push(`${relative(SRC, file).replace(/\\/g, '/')}: ${m[1]}`);
    }
  }
  ok(`no reference-returning selector carries a needless shallowEqual (${misleading.join(', ') || 'none'})`,
    misleading.length === 0);
}

// ── the cache contract these rules depend on ────────────────────────────
{
  const cache = readFileSync(join(SRC, 'store', 'selectionCache.js'), 'utf8');
  ok('the cache keys on snapshot+selector+isEqual IDENTITY (the loop-breaker)',
    /lastSnapshot === snapshot && lastSelector === selector && lastIsEqual === isEqual/.test(cache));
  ok('  ...and only runs isEqual ACROSS snapshots', /has && lastIsEqual === isEqual && isEqual\(lastValue, next\)/.test(cache));
  const index = readFileSync(join(SRC, 'store', 'index.jsx'), 'utf8');
  ok('useSelector defaults to Object.is', /useSelector\(selector, isEqual = Object\.is\)/.test(index));
  ok('  ...and shallowEqual is exported for allocating selectors', /export function shallowEqual/.test(index));
}

console.log(`\nselector benefit: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
