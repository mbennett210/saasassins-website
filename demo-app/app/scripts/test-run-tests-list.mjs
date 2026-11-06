// The test runner's own contract — `app/scripts/run-tests.mjs`.
//
// WHY THIS EXISTS. `knownChecks` (design-system-lib.mjs:275) runs the runner with
// `--list` and PARSES what comes back, so the list is a machine-read interface, not just
// something a human skims. On 2026-09-28 CI went red on `fd5f7dd` with
//
//   Error: run-tests --list announced 190 suites but listed 188
//
// The runner printed ~200 lines with console.log and then called `process.exit(0)` in the
// same tick. Node's own contract for that call is explicit: it ends the process "even if
// there are still asynchronous operations pending that have not yet completed fully,
// including I/O operations to process.stdout and process.stderr", and whether a write to
// stdout is synchronous depends on the platform AND on what stdout is connected to. Under
// `execFileSync` stdout is a PIPE. So the tail of the list was dropped on the Ubuntu
// runner, the parser counted fewer suites than the runner had announced two hundred lines
// earlier, and the gate failed. It passed at 189 suites and on Windows, where pipe writes
// are synchronous — a race, not a threshold.
//
// ⚠️ WHY A STRUCTURAL CHECK AND NOT ONLY AN OUTPUT CHECK. The truncation is a POSIX-pipe
// race. On Windows the write completes before the exit every single time, so an
// output-only assertion is GREEN on the broken code here and can never fail first (THE
// LAW II.3). The guard therefore pins the CAUSE — no synchronous process exit after the
// runner has written anything — which is checkable on every platform. The output
// assertions ride along as the symptom check for the machine that can see it.
//
// Run: node app/scripts/test-run-tests-list.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'run-tests.mjs');
const SRC = readFileSync(RUNNER, 'utf8');
// Comment lines are stripped: the header above has to be able to name the hazard.
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

// ── the cause: nothing ends the process out from under a pending write ──────
{
  ok(!/process\.exit\(/.test(CODE),
    'the runner never ends the process itself — a queued write to a pipe would be dropped');
  ok(/process\.exitCode\s*=/.test(CODE),
    '…it sets process.exitCode and returns, so node drains stdout and stderr before exiting');
  // The list is the machine-read path, so it is ONE write rather than two hundred: there
  // is nothing left queued for an exit to race even if one were reintroduced.
  const listBranch = SRC.slice(SRC.indexOf('if (LIST)'), SRC.indexOf('// ── run'));
  ok(listBranch.length > 100, 'the --list branch is findable, and the run section follows it');
  eq('the whole list goes out in a single write', (listBranch.match(/process\.stdout\.write\(/g) || []).length, 1);
  eq('…so the branch prints nothing line by line', (listBranch.match(/console\.log\(/g) || []).length, 0);
  // The red summary prints each failing suite's tail. If that raced an exit, CI would lose
  // the very output it exists to show.
  const redSummary = SRC.slice(SRC.indexOf('if (red.length)'));
  ok(redSummary.length > 0 && !/process\.exit\(/.test(redSummary),
    'the red summary sets an exit code too, so a failing run keeps its own error output');
}

// ── the symptom: the list survives a pipe, whole ─────────────────────────────
// Exactly how `knownChecks` reads it — execFileSync, so stdout is a pipe, not a terminal.
{
  const out = execFileSync(process.execPath, [RUNNER, '--list'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');

  // the head: the offline block, and the count the runner announced for it
  const m = /offline suites \((\d+)\):\n((?: {2}\S+\n?)+)/.exec(out);
  ok(m, 'the list names the offline suites, in the shape design-system-lib.mjs parses');
  const listedOffline = new Set(m[2].trim().split('\n').map((l) => l.trim()));
  eq(`every announced offline suite is actually listed (announced ${m[1]})`, listedOffline.size, Number(m[1]));
  ok(listedOffline.has('test-run-tests-list.mjs'), 'this suite is one of them, so the list is the real one');

  // the TAIL: the live-effect block is last, and it is whole. This is what a dropped
  // write eats first, and losing it silently would take the suite list with it.
  const lm = /skipped — live effect \((\d+)\):\n((?: {2}\S+[^\n]*\n?)+)/.exec(out);
  ok(lm, 'the live-effect section is present');
  eq(`every announced live-effect script reaches the reader (announced ${lm?.[1]})`,
    (lm?.[2] || '').trim().split('\n').length, Number(lm?.[1]));
  ok(out.indexOf('skipped — live effect') > out.lastIndexOf('\n  test-run-tests-list.mjs'),
    'the live-effect block really is after the suite list, so a whole tail means a whole list');
  ok(out.endsWith('\n\n'), 'the stream ends with the blank line the runner prints last — nothing was cut');
}

console.log(`\nrun-tests --list: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
