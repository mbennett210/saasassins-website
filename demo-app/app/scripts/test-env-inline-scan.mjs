// test-env-inline-scan.mjs — the CS-398 source gate (BUILD_INTEGRITY II.3, playbook II.9).
//
// WHY THIS EXISTS. Vite/Rolldown replaces a NAMED read (`import.meta.env.KEY` /
// `import.meta.env?.KEY`) with just that one value, but a WHOLE-OBJECT read of
// `import.meta.env` is replaced with the ENTIRE env object literal — every VITE_-prefixed
// variable at build time. On Vercel that object carries the deployment's system vars
// (VITE_VERCEL_GIT_COMMIT_MESSAGE, the commit author login, repo owner/slug/id, the commit
// ref and previous sha, project/deployment ids, the branch URL, and the observability
// config). A single stray whole-object read therefore publishes all of it in the client
// bundle — on the unauthenticated sign-in page (CS-398, confirmed live on store-*.js). The
// alias `const env = import.meta.env` in teamApi.js:22 did exactly that even though only one
// key (VITE_FORMS_BACKEND_URL) was ever used from it.
//
// WHAT IT ASSERTS. No source in app/src or app/api reads `import.meta.env` as a whole object.
// A read is allowed ONLY when it is immediately continued by a property access — `.KEY` or
// `?.KEY`. Everything else is a whole-object read and fails here, including:
//   - an alias / truthiness test  (`const env = import.meta.env`, `!!import.meta.env`)
//   - a ternary / logical operand  (`import.meta.env ? … : …`, `import.meta.env || {}`)
//   - COMPUTED access             (`import.meta.env['VITE_X']`) — Vite's define matches DOT
//     access only, so bracket access inlines the whole object too.
// Comments and string / template / regex-literal contents are excluded (the codebase has
// many prose mentions of `import.meta.env` in comments, e.g. lib/email.js, connectedInboxes.js,
// integrationsApi.js, teamApi.js). This is the fast, offline half of the gate; the execution
// half is check-bundle-stubs.mjs --build (an unreferenced VITE_ canary must not reach dist).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url)); // app/
// Roots to scan. Built from parts so this file never contains a quoted "<dots>/api/" or the
// bare backend word — run-tests.mjs would otherwise skip it as a backend-only suite.
const ROOTS = [join(APP_DIR, 'src'), join(APP_DIR, 'api')];
const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

// ── strip comments + string/template/regex literals, preserving length + newlines ──────────
// Replaces every non-code character with a space (newlines kept), so a match index in the
// stripped text maps to the same line/column as the original. Regex-literal start is
// disambiguated from division by the previous meaningful token (the standard heuristic), so a
// pattern like /['"]/ is not mistaken for a string and does not swallow the code after it.
const ID = (c) => c != null && /[A-Za-z0-9_$]/.test(c);
const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'do', 'else', 'yield', 'await', 'case',
]);
function stripToCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevChar = '';   // last meaningful (non-space) code char emitted
  let prevWord = '';    // last identifier run in code
  const push = (ch) => { out += ch; };
  const blank = (ch) => { out += ch === '\n' ? '\n' : ' '; };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // line comment
    if (c === '/' && c2 === '/') { out += '  '; i += 2; while (i < n && src[i] !== '\n') { blank(src[i]); i++; } continue; }
    // block comment
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(src[i]); i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // strings
    if (c === "'" || c === '"') {
      const q = c; blank(c); i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') { blank(src[i]); i++; if (i < n) { blank(src[i]); i++; } } else { blank(src[i]); i++; } }
      if (i < n) { blank(src[i]); i++; }
      prevChar = q; prevWord = ''; continue;
    }
    // template literal (nested ${} are rare around env reads; treat the whole literal as text)
    if (c === '`') {
      blank(c); i++;
      while (i < n && src[i] !== '`') { if (src[i] === '\\') { blank(src[i]); i++; if (i < n) { blank(src[i]); i++; } } else { blank(src[i]); i++; } }
      if (i < n) { blank(src[i]); i++; }
      prevChar = '`'; prevWord = ''; continue;
    }
    // regex vs division
    if (c === '/') {
      const isRegex = prevChar === '' || REGEX_PREV_WORDS.has(prevWord) ||
        '([{,;:=!&|?+-*%<>~^'.includes(prevChar) || prevChar === '\n' || prevChar === 'return';
      if (isRegex) {
        blank(c); i++;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === '\\') { blank(ch); i++; if (i < n) { blank(src[i]); i++; } continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { blank(ch); i++; break; }
          else if (ch === '\n') break;
          blank(ch); i++;
        }
        prevChar = '/'; prevWord = ''; continue;
      }
    }
    // normal code char
    push(c);
    if (!/\s/.test(c)) { prevChar = c; if (ID(c)) prevWord += c; else prevWord = ''; }
    i++;
  }
  return out;
}

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) { if (e === 'node_modules' || e === 'dist') continue; out.push(...walk(p)); }
    else { const dot = e.lastIndexOf('.'); if (dot >= 0 && CODE_EXT.has(e.slice(dot))) out.push(p); }
  }
  return out;
}

// A read is OK iff `import.meta.env` is immediately followed by `.identifier` or `?.identifier`.
const READ = /import\.meta\.env/g;
const OK_AFTER = /^(?:\?\.|\.)[A-Za-z_$]/;

const files = ROOTS.flatMap(walk);
const violations = [];
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const code = stripToCode(raw);
  READ.lastIndex = 0;
  let m;
  while ((m = READ.exec(code)) !== null) {
    const after = code.slice(m.index + 'import.meta.env'.length);
    if (OK_AFTER.test(after)) continue; // named read — fine
    const line = code.slice(0, m.index).split('\n').length;
    const lineText = raw.split('\n')[line - 1] || '';
    violations.push({ file: relative(APP_DIR, f).replace(/\\/g, '/'), line, text: lineText.trim() });
  }
}

if (violations.length) {
  console.error(`\n✖ env-inline-scan: ${violations.length} whole-object import.meta.env read(s) in app/src or app/api`);
  console.error('  A whole-object read inlines EVERY VITE_* var (incl. Vercel system vars) into the bundle (CS-398).');
  console.error('  Read named keys instead: import.meta.env.KEY or import.meta.env?.KEY.\n');
  for (const v of violations) console.error(`    ${v.file}:${v.line}\n        ${v.text}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ env-inline-scan: ${files.length} code file(s), 0 whole-object import.meta.env reads`);
process.exit(0);
