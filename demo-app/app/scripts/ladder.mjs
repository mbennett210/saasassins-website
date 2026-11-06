#!/usr/bin/env node
// ladder — the whole BUILD_INTEGRITY.md §6a verification ladder, plus the steps CI adds, in one command.
//
//   npm --prefix app run ladder                                   # every step; one table, one exit code
//   npm --prefix app run ladder -- --only run-tests,eslint        # a subset while building
//   npm --prefix app run ladder -- --skip build:demo
//   npm --prefix app run ladder -- --deletions                    # + lint:deletions (a delete path changed)
//   npm --prefix app run ladder -- --responsive http://localhost:5213   # + lint:responsive, against a demo server you started
//   npm --prefix app run ladder -- --list                         # the steps, nothing run
//
// WHY. Builders fired every step as its own command: about 38 gate commands per builder run, each
// one a model round trip (measured in S107, HANDOFF 2026-09-28). One command, one table.
//
// HOW IT RUNS
// - Every step except the two builds runs in parallel (--jobs, default 4). The builds then run one
//   after the other, alone, because both write app/dist.
// - brain-lint is red on main (CS-188). Here it passes when it has no violation that the base does
//   not already have: DEV_PLAYBOOK 3.1.4's "pre-existing red with its count unchanged or lower".
//   The base is `git merge-base HEAD origin/main` (--base <ref> to change it). Its report comes from
//   a temporary worktree and is cached per base sha. The table marks that step ◐, not ✓, because a
//   pre-existing red is still red (DEV_PLAYBOOK 0.1.5): PASS means nothing failed and nothing new;
//   it is "ladder green" only when no step shows ◐.
// - Each step's full output goes to a log file. The table shows each step's last line, and a failing
//   step's last lines are printed under the table.
// - test-ladder-steps.mjs holds STEPS to §6a and to .github/workflows/ci.yml: a step added to either
//   fails CI until it is added here too.
//
// Exit 0 pass · 1 a step failed · 2 the ladder itself broke. No process.exit() (see run-tests.mjs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// §6a in its order, then what CI adds. `doc` is the command exactly as §6a and ci.yml spell it.
export const STEPS = [
  { name: 'run-tests', doc: 'node app/scripts/run-tests.mjs' },
  { name: 'eslint', doc: 'npm --prefix app run lint' },
  { name: 'lint:wiring', doc: 'npm --prefix app run lint:wiring' },
  { name: 'lint:orphans', doc: 'npm --prefix app run lint:orphans' },
  { name: 'lint:sql', doc: 'npm --prefix app run lint:sql' },
  { name: 'lint:endpoints', doc: 'npm --prefix app run lint:endpoints' },
  { name: 'lint:paging', doc: 'npm --prefix app run lint:paging' },
  { name: 'lint:design', doc: 'npm --prefix app run lint:design' },
  { name: 'lint:queue', doc: 'npm --prefix app run lint:queue' },
  { name: 'lint:tables', doc: 'npm --prefix app run lint:tables' },
  { name: 'lint:backnav', doc: 'npm --prefix app run lint:backnav' },
  { name: 'lint:search', doc: 'npm --prefix app run lint:search' },
  { name: 'brain-lint', doc: 'node app/scripts/brain-lint.mjs' },
  { name: 'build', doc: 'npm --prefix app run build', build: true },
  { name: 'lint:position', doc: 'npm --prefix app run lint:position' },
  { name: 'build:demo', doc: 'npm --prefix app run build:demo', build: true },
];

// The conditional steps (DEV_PLAYBOOK 3.2 step 10), each added by its flag.
export const OPTIONAL = [
  { name: 'lint:deletions', doc: 'npm --prefix app run lint:deletions', flag: '--deletions' },
  { name: 'lint:responsive', doc: 'npm --prefix app run lint:responsive', flag: '--responsive <url>' },
];

const USAGE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const clean = (s) => s.replace(ANSI, '').trimEnd();
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function parseArgs(argv) {
  const out = { only: null, skip: [], jobs: 4, deletions: false, responsive: null, base: 'origin/main', list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--only') out.only = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--skip') out.skip = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--jobs') out.jobs = Math.max(1, Math.floor(Number(value())) || 1);
    else if (a === '--deletions') out.deletions = true;
    else if (a === '--responsive') out.responsive = value();
    else if (a === '--base') out.base = value();
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${a} (see --help)`);
  }
  return out;
}

export function plan(opts) {
  const known = new Set([...STEPS, ...OPTIONAL].map((s) => s.name));
  for (const n of [...(opts.only || []), ...opts.skip]) if (!known.has(n)) throw new Error(`no step named ${n} (see --list)`);
  let steps = [...STEPS];
  if (opts.deletions || opts.only?.includes('lint:deletions')) steps.push(OPTIONAL[0]);
  if (opts.responsive) steps.push({ ...OPTIONAL[1], args: ['--url', opts.responsive] });
  else if (opts.only?.includes('lint:responsive')) throw new Error('lint:responsive needs --responsive <url> (a running demo server)');
  if (opts.only) steps = steps.filter((s) => opts.only.includes(s.name));
  return steps.filter((s) => !opts.skip.includes(s.name));
}

// One child process; output streamed to a log file, the last lines kept for the table.
function exec(command, args, { cwd = ROOT, logFile = null, shell = false } = {}) {
  return new Promise((resolve) => {
    const log = logFile ? fs.createWriteStream(logFile) : null;
    const chunks = [];
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (log) log.end();
      resolve({ code, text });
    };
    // With shell: true the command is one string: an args array plus a shell is deprecated
    // (DEP0190), and npm is npm.cmd on Windows, which only a shell resolves.
    const child = shell
      ? spawn([command, ...args].join(' '), { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
      : spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    const take = (b) => { chunks.push(b); if (log) log.write(b); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { take(Buffer.from(`\n[ladder] could not start ${command}: ${e.message}\n`)); finish(2); });
    child.on('close', (code) => finish(code ?? 2));
  });
}

const lastLine = (text) => clean(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '(no output)';
const tailOf = (text, n) => clean(text).split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');
const logName = (dir, step) => path.join(dir, `${step.name.replace(/:/g, '-')}.log`);

async function runStep(step, logDir) {
  const t0 = Date.now();
  const logFile = logName(logDir, step);
  const [head, ...rest] = step.doc.split(' ');
  let r;
  if (head === 'node') {
    r = await exec(process.execPath, rest, { logFile });
  } else {
    // --silent keeps npm's banner and its error footer out of the step's last line.
    const at = rest.indexOf('run');
    const args = [...rest.slice(0, at + 1), '--silent', ...rest.slice(at + 1)];
    if (step.args) args.push('--', ...step.args);
    r = await exec('npm', args, { logFile, shell: true });
  }
  return { step, code: r.code, ms: Date.now() - t0, summary: lastLine(r.text), tail: tailOf(r.text, 20), logFile };
}

// brain-lint --json from a checkout: { violations: [{ tier, file, msg }] }.
async function brainViolations(dir) {
  const r = await exec(process.execPath, [path.join(dir, 'app', 'scripts', 'brain-lint.mjs'), '--json'], { cwd: dir });
  if (r.code !== 0 && r.code !== 1) throw new Error(`brain-lint exited ${r.code}: ${tailOf(r.text, 3)}`);
  const at = r.text.indexOf('{');
  return JSON.parse(r.text.slice(at)).violations;
}

async function git(args) {
  const r = await exec('git', args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${tailOf(r.text, 2)}`);
  return r.text.trim();
}

// The base's brain-lint report, from a temporary worktree, cached per sha.
async function baseViolations(sha) {
  const cacheDir = path.join(os.tmpdir(), 'cs-ladder-cache');
  const cache = path.join(cacheDir, `brain-lint-${sha}.json`);
  if (fs.existsSync(cache)) return { violations: JSON.parse(fs.readFileSync(cache, 'utf8')), cached: true };
  // The REAL path of the temp folder: on macOS os.tmpdir() is /var/folders/…, a symlink to
  // /private/var/…, and brain-lint's main-module guard (import.meta.url vs argv[1]) never fires
  // through a symlinked path — it printed nothing and the step died on "Unexpected end of JSON
  // input" (S130). The base checkout runs the BASE's brain-lint, so the fix belongs here.
  const dir = path.join(fs.realpathSync(os.tmpdir()), `cs-ladder-base-${sha.slice(0, 7)}-${process.pid}`);
  await git(['worktree', 'add', '--detach', '--quiet', dir, sha]);
  try {
    const violations = await brainViolations(dir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(violations));
    return { violations, cached: false };
  } finally {
    await exec('git', ['worktree', 'remove', '--force', dir]); // a failure leaves it for `git worktree prune`
  }
}

async function brainStep(step, logDir, baseRef) {
  const t0 = Date.now();
  const logFile = logName(logDir, step);
  const done = (code, summary, lines, preexisting = false) => {
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`);
    return { step, code, ms: Date.now() - t0, summary, tail: lines.filter((l) => l.startsWith('NEW')).slice(0, 20).join('\n') || summary, logFile, preexisting };
  };
  try {
    const headSha = await git(['rev-parse', 'HEAD']);
    const head = await brainViolations(ROOT);
    let base = null;
    let why = '';
    try { base = await git(['merge-base', 'HEAD', baseRef]); } catch { why = `no merge-base with ${baseRef}`; }
    let had = null;
    let cached = false;
    if (base === headSha) had = head;
    else if (base) ({ violations: had, cached } = await baseViolations(base));
    const key = (v) => `${v.tier}\u0000${v.file}\u0000${v.msg}`;
    const seen = new Set((had || []).map(key));
    const fresh = had ? head.filter((v) => !seen.has(key(v))) : head;
    const lines = head.map((v) => `${seen.has(key(v)) ? '   ' : 'NEW'} [${v.tier}] ${v.file} — ${v.msg}`);
    const summary = had
      ? `${head.length} violations · ${fresh.length} new vs base ${base.slice(0, 7)} (${had.length})${base === headSha ? ' · HEAD is the base' : ''}${cached ? ' · base cached' : ''}`
      : `${head.length} violations · ${why}, so every one counts`;
    return done(fresh.length ? 1 : 0, summary, lines, !fresh.length && head.length > 0);
  } catch (e) {
    return done(2, `the ladder could not run brain-lint: ${e.message}`, [String(e.stack || e)]);
  }
}

async function pool(items, jobs, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
}

async function main() {
  let opts;
  let steps;
  try {
    opts = parseArgs(process.argv.slice(2));
    steps = plan(opts);
  } catch (e) {
    console.error(`ladder: ${e.message}`);
    return 2;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.list) {
    for (const s of steps) console.log(`${s.name.padEnd(16)} ${s.doc}${s.args ? ` -- ${s.args.join(' ')}` : ''}${s.build ? '   (after the rest, one at a time)' : ''}`);
    return 0;
  }
  if (!steps.length) { console.error('ladder: nothing to run'); return 2; }
  if (!fs.existsSync(path.join(ROOT, 'app', 'node_modules'))) {
    console.error('ladder: app/node_modules is missing. Run `npm --prefix app ci` first (DEV_PLAYBOOK 0.3 step 6).');
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const logDir = path.join(os.tmpdir(), 'cs-ladder', `${stamp}-${process.pid}`);
  fs.mkdirSync(logDir, { recursive: true });
  let sha = '?';
  try { sha = await git(['rev-parse', '--short', 'HEAD']); } catch { /* reported by the steps that need git */ }
  const t0 = Date.now();
  console.log(`ladder · HEAD ${sha} · ${steps.length} steps · ${opts.jobs} at a time · logs ${logDir}`);

  const mark = (r) => (r.code !== 0 ? '✗' : r.preexisting ? '◐' : '✓');
  const results = new Map();
  const run = async (s) => {
    const r = s.name === 'brain-lint' ? await brainStep(s, logDir, opts.base) : await runStep(s, logDir);
    results.set(s.name, r);
    if (process.stdout.isTTY) console.log(`  … ${mark(r)} ${s.name} ${secs(r.ms)}`);
  };
  await pool(steps.filter((s) => !s.build), opts.jobs, run);
  for (const s of steps.filter((x) => x.build)) await run(s);

  const rows = steps.map((s) => results.get(s.name));
  for (const r of rows) console.log(`  ${mark(r)} ${r.step.name.padEnd(15)} ${secs(r.ms).padStart(6)}  ${r.summary.slice(0, 120)}`);
  const failed = rows.filter((r) => r.code !== 0);
  const pre = rows.filter((r) => r.code === 0 && r.preexisting);
  const green = rows.length - failed.length - pre.length;
  const parts = [failed.length ? 'FAIL' : 'PASS', `${green} green`];
  if (pre.length) parts.push(`◐ ${pre.map((r) => r.step.name).join(', ')}: pre-existing red, nothing new`);
  if (failed.length) parts.push(`✗ ${failed.map((r) => r.step.name).join(', ')}`);
  parts.push(`${secs(Date.now() - t0)} wall`);
  console.log(parts.join(' · '));
  for (const r of failed) {
    console.log(`\n── ${r.step.name} (exit ${r.code}) · full log ${r.logFile}`);
    console.log(r.tail);
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`ladder: ${e.stack || e}`); process.exitCode = 2; });
}
