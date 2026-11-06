// test-ladder-steps — `npm run ladder` (scripts/ladder.mjs) runs exactly the BUILD_INTEGRITY.md §6a
// ladder plus the steps CI's `verify` job runs. A step added to §6a or to .github/workflows/ci.yml
// fails here until ladder.mjs runs it too, and a ladder step that neither lists fails as unexplained.
// Offline and pure: it reads two files and imports STEPS (importing ladder.mjs runs nothing).
// Run: node scripts/test-ladder-steps.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, OPTIONAL, parseArgs, plan } from './ladder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const failures = [];
const expect = (cond, msg) => { if (!cond) failures.push(msg); };

// §6a: the commands in the first fenced block after the "### 6a" heading, comments stripped.
const bi = read('BUILD_INTEGRITY.md');
const at = bi.indexOf('### 6a');
const open = bi.indexOf('```', at);
const close = bi.indexOf('```', open + 3);
const s6a = at < 0 || open < 0 || close < 0 ? [] : bi.slice(bi.indexOf('\n', open) + 1, close)
  .split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
expect(s6a.length >= 10, `could not read the §6a command block in BUILD_INTEGRITY.md (found ${s6a.length} commands)`);

// CI: every `run:` step of the workflow except the install.
const ci = read('.github/workflows/ci.yml').split('\n')
  .map((l) => l.match(/^\s*run:\s*(.+?)\s*$/)).filter(Boolean).map((m) => m[1])
  .filter((c) => c !== 'npm --prefix app ci');
expect(ci.length >= 5, `could not read the run: steps in .github/workflows/ci.yml (found ${ci.length})`);

const ladder = STEPS.map((s) => s.doc);
for (const c of s6a) expect(ladder.includes(c), `a §6a step the ladder does not run: ${c}`);
for (const c of ci) expect(ladder.includes(c), `a CI step the ladder does not run: ${c}`);
for (const c of ladder) expect(s6a.includes(c) || ci.includes(c), `a ladder step in neither §6a nor CI: ${c}`);
const order = STEPS.filter((s) => s6a.includes(s.doc)).map((s) => s.doc);
expect(order.join('\n') === s6a.join('\n'), 'the ladder does not list the §6a steps in §6a order');

// Every step name is unique, and every npm step names a script app/package.json defines.
const pkg = JSON.parse(read('app/package.json'));
const names = [...STEPS, ...OPTIONAL].map((s) => s.name);
expect(new Set(names).size === names.length, `duplicate step names: ${names.join(', ')}`);
for (const s of [...STEPS, ...OPTIONAL]) {
  const m = s.doc.match(/^npm --prefix app run (\S+)$/);
  if (m) expect(m[1] in pkg.scripts, `${s.name} runs npm script "${m[1]}", which app/package.json does not define`);
  else expect(/^node app\/scripts\/[\w-]+\.mjs$/.test(s.doc), `${s.name} is neither an npm script nor a node app/scripts file: ${s.doc}`);
}
expect(pkg.scripts.ladder === 'node scripts/ladder.mjs', 'app/package.json has no "ladder": "node scripts/ladder.mjs" script');

// The two builds run last, one at a time (both write app/dist).
expect(STEPS.filter((s) => s.build).map((s) => s.name).sort().join() === 'build,build:demo', 'build and build:demo must be the serial steps');

// Flags: --only/--skip filter, the optional steps come in by flag, unknown names are refused.
const names0 = (argv) => plan(parseArgs(argv)).map((s) => s.name);
expect(names0([]).length === STEPS.length, 'no flags should plan every step');
expect(names0(['--only', 'eslint,lint:sql']).join() === 'eslint,lint:sql', '--only should keep just the named steps');
expect(!names0(['--skip', 'build:demo']).includes('build:demo'), '--skip should drop the named step');
expect(names0(['--deletions']).includes('lint:deletions'), '--deletions should add lint:deletions');
const resp = plan(parseArgs(['--responsive', 'http://localhost:5213'])).find((s) => s.name === 'lint:responsive');
expect(resp && resp.args.join(' ') === '--url http://localhost:5213', '--responsive <url> should add lint:responsive with that url');
let refused = false;
try { plan(parseArgs(['--only', 'lint:nope'])); } catch { refused = true; }
expect(refused, 'an unknown step name should be refused');

if (failures.length) {
  console.error(`✗ test-ladder-steps: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-ladder-steps: the ladder runs all ${s6a.length} §6a steps and all ${ci.length} CI steps (${STEPS.length} in all), builds last; flags plan as documented`);
}
