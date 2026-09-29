// paging-lint — the build-failing sweep for unordered paged reads.
//
// THE LAW (playbook II.7, "Fetch strategy"): "Count-first paged reads with bounded
// concurrency, per-page retry, deterministic `.order(id)` boundaries." And Part V,
// Performance: "Serial unordered paged fetches → count-first, bounded concurrency,
// per-page retry, `.order(id)`."
//
// THE DEFECT. `.range(from, to)` is OFFSET/LIMIT. Postgres makes NO promise that two
// statements return rows in the same order unless you ask for one, so a walk without an
// ORDER BY has planner-dependent page membership: under concurrent writes — the normal
// state of a crew app with crons, other tabs and the per-row mirror all writing — a row
// can move across a page boundary and be **skipped**, or land on both sides and be
// **duplicated**. Nothing downstream notices. The merge simply builds the wrong set.
//
// 🔴 WHY A SWEEP AND NOT A FIX. The playbook audit raised this as P-4 against
// `jobsSync.js`, and `f4c467d` fixed it — on the two CLIENT reads. The two SERVER reads
// in `api/_lib/jobsTable.js` had the identical defect and were untouched, one of them
// feeding the reminders cron. That is Part V verbatim: "Fixing an instance is not fixing
// the bug (four guarded/unguarded sibling pairs) → shared primitive + build-failing
// sweep." A grep someone remembers to run is not a guard.
//
// WHAT IT CHECKS. Every `.range(` call site in source (never `dist/`, never
// `node_modules/`): does the SAME query chain carry an `.order(` before it? Detection is
// by SHAPE — a chain is the text from the nearest preceding `.from(` to the `.range(` —
// not by a list of known functions, because a name-list cannot see the call written
// tomorrow. (`endpoint-lint` learned this the hard way: its first run called two routes
// ungated because they use `requireInboxOwner`, which no name-list contained.)
//
// Usage:
//   node scripts/paging-lint.mjs           # from app/ — exit 1 on any unordered paged read
//   node scripts/paging-lint.mjs --list    # show every .range() found and its verdict
//   node scripts/paging-lint.mjs --root D  # scan D instead of app/ (used by its own test)
//
// Escape hatch (needs a reason, and the reason should say why order cannot matter):
//   // paging-lint:allow — reason
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `--root` exists so `test-paging-lint.mjs` can point the sweep at a THROWAWAY tree of
// planted defects. A sweep that can only ever run against the real repo cannot be
// proven to fail, and an unfalsifiable sweep is decoration.
const rootArg = process.argv.indexOf('--root');
const APP = rootArg !== -1 && process.argv[rootArg + 1]
  ? path.resolve(process.argv[rootArg + 1])
  : fileURLToPath(new URL('../', import.meta.url));
const LIST = process.argv.includes('--list');

// Source only. `dist/` is a build artifact and would report the same defect twice —
// once truthfully and once from bundled output nobody can edit.
const ROOTS = ['src', 'api', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vercel', 'coverage', '.git']);
const EXTS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = ROOTS
  .map((r) => path.join(APP, r))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d));

if (files.length === 0) {
  console.log('\npaging-lint: SKIPPED — no source roots found.');
  console.log('  (this is NOT a clean result — no files were checked)\n');
  process.exit(0);
}

// Comments and string literals are stripped before the chain is examined, for two
// different reasons. A `.order(` mentioned in a NOTE above a range call must not vouch
// for it; and a `.range(` quoted inside a STRING is not a call — without this, the first
// run of this very file reported three findings against its own error messages, and a
// tool whose first output is three false positives is a tool nobody runs twice.
// Blanking (not deleting) preserves length, so reported line numbers stay true.
const blank = (m) => m.replace(/[^\n]/g, ' ');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
// Applied AFTER comments, so a quote mark inside a comment cannot open a phantom string.
// Deliberately generic rather than skipping this file by name: a name-list would also
// wave through a real defect written into it later.
const stripStrings = (s) => s
  .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
  .replace(/"(?:\\.|[^"\\\n])*"/g, blank)
  .replace(/`(?:\\.|[^`\\])*`/g, blank);

const rows = [];
for (const abs of files) {
  const raw = fs.readFileSync(abs, 'utf8');
  if (!raw.includes('.range(')) continue;
  const rel = path.relative(APP, abs).replace(/\\/g, '/');
  const code = stripStrings(stripComments(raw));

  let i = -1;
  while ((i = code.indexOf('.range(', i + 1)) !== -1) {
    // The chain is what precedes this .range() back to its own .from(. If there is no
    // .from( at all the call is not a PostgREST page walk (Array.prototype has no
    // .range, but a helper might) and is reported as unrecognised rather than clean.
    const start = code.lastIndexOf('.from(', i);
    const chain = start === -1 ? '' : code.slice(start, i);
    const line = code.slice(0, i).split('\n').length;
    // The allow annotation is read from the RAW text (it lives in a comment) and must
    // sit on the .range( line or the line above it — a file-wide opt-out would let one
    // annotation cover a call added later.
    const rawLines = raw.split('\n');
    const near = [rawLines[line - 2] || '', rawLines[line - 1] || ''].join('\n');
    const allowed = /paging-lint:allow/.test(near);
    rows.push({
      rel,
      line,
      recognised: start !== -1,
      ordered: start !== -1 && /\.order\s*\(/.test(chain),
      allowed,
    });
  }
}

const atRisk = rows.filter((r) => !r.allowed && (!r.recognised || !r.ordered));

if (LIST) {
  console.log(`\npaging-lint — ${files.length} source files · ${rows.length} paged read(s)\n`);
  for (const r of rows) {
    const verdict = !r.recognised ? '🔴 UNRECOGNISED — no .from() in the chain'
      : r.ordered ? 'ordered ✓'
        : r.allowed ? 'allow-listed' : '🔴 NO ORDER BY';
    console.log(`  ${(r.rel + ':' + r.line).padEnd(46)} ${verdict}`);
  }
  console.log('');
  process.exit(0);
}

console.log(`\npaging-lint — ${files.length} source files · ${rows.length} paged read(s) · `
  + `${rows.filter((r) => r.ordered).length} ordered · ${rows.filter((r) => r.allowed).length} allow-listed`);

if (atRisk.length) {
  console.error(`\n✖ ${atRisk.length} paged read(s) with no deterministic ordering:\n`);
  for (const r of atRisk) {
    console.error(`    ${r.rel}:${r.line}`);
    console.error(r.recognised
      ? '      .range() with no .order() — page membership is planner-dependent, so a'
      : '      .range() with no .from() in the chain — this sweep could not verify it.');
    if (r.recognised) console.error('      concurrently-written row can be SKIPPED or DUPLICATED, silently.');
  }
  console.error('\n  Add a total, indexed sort to the chain — the primary key is free:');
  console.error("    .order('id', { ascending: true })");
  console.error('  Or annotate the call site:  // paging-lint:allow — why order cannot matter\n');
  process.exit(1);
}
console.log('  ✓ every paged read orders its page boundaries\n');
