// test-design-lint — puts lint:design (scripts/design-lint.mjs) in CI through run-tests.
//
// CI cannot gain a workflow step here (the deploy token has no `workflow` scope), so the lint becomes
// a gate by being run from this suite. It fails when:
//   - a file × rule count rises above design-lint.baseline.json (a new raw hex, raw px, off-grid
//     value, inline px, scaffold inline style, gradient, coloured shadow or glow), or a
//     `design:allow` is malformed;
//   - a count has DROPPED below the baseline without the baseline following it (slack). Slack lets
//     the next violation in the same file hide in the room a fix made, so the ratchet must move
//     with every fix: run `npm --prefix app run lint:design -- --update-baseline` and commit it.
// Fixtures prove the rules still fire (a lint that silently stopped matching would pass the tree).
// A deliberate reset goes through `--rebaseline "<reason>"`, which records itself in the baseline.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINT = fileURLToPath(new URL('./design-lint.mjs', import.meta.url));
const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass++; else fails.push(label); };
const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [LINT, ...args], { cwd: APP, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

// 1. the real tree, against the committed baseline
const real = run(['--json']);
let report = null;
try { report = JSON.parse(real.out); } catch { /* reported below */ }
ok(`design-lint ran and printed its JSON report (exit ${real.code}): ${real.out.slice(0, 300)}`, !!report);
if (report) {
  const nv = report.newViolations || [];
  ok(`no new design-lint findings above the baseline:\n    ${nv.map((v) => `${v.rel} — ${v.rule}: ${v.count} > ${v.base}${v.sites?.length ? ` (e.g. line ${v.sites[0].line}: ${v.sites[0].snip})` : ''}`).join('\n    ')}`, nv.length === 0);
  ok(`no malformed design:allow comments: ${JSON.stringify(report.allowBad || [])}`, (report.allowBad || []).length === 0);
  const slack = report.ratchetable || [];
  ok(`the baseline follows every fix (no slack). Run \`npm --prefix app run lint:design -- --update-baseline\` and commit design-lint.baseline.json:\n    ${slack.join('\n    ')}`, slack.length === 0);
}

// 2. fixtures: each rule the re-skin and the flat treatment depend on still fires
const dir = mkdtempSync(join(tmpdir(), 'design-lint-'));
try {
  const empty = join(dir, 'empty-baseline.json');
  writeFileSync(empty, JSON.stringify({ version: 1, files: {} }));
  const fixture = (name, css) => { const f = join(dir, name); writeFileSync(f, css); return run(['--baseline', empty, '--json', f]); };
  const rules = (r) => { try { return (JSON.parse(r.out).newViolations || []).map((v) => v.rule); } catch { return []; } };
  const hex = fixture('hex.css', '.x { color: #ff6300; }\n');
  ok('a raw hex colour in component CSS fails (no-raw-hex)', hex.code === 1 && rules(hex).includes('no-raw-hex'));
  const px = fixture('px.css', '.x { padding: 13px; }\n');
  ok('a raw px spacing value fails (no-raw-px)', px.code === 1 && rules(px).includes('no-raw-px'));
  const grad = fixture('grad.css', '.x { background: linear-gradient(red, blue); }\n');
  ok('a decorative gradient fails (no-decorative-gradient)', grad.code === 1 && rules(grad).includes('no-decorative-gradient'));
  const tier = fixture('tier.css', '.menu { box-shadow: var(--shadow-md); }\n');
  ok('a shadow tier other than the overlay fails (shadow-tier, CS-344)', tier.code === 1 && rules(tier).includes('shadow-tier'));
  const overlay = fixture('overlay.css', '.menu { box-shadow: var(--shadow-overlay); }\n.row { box-shadow: none; }\n.col { box-shadow: var(--ring-inset); }\n');
  ok('the overlay tier, none and a ring token pass', overlay.code === 0);
  const clean = fixture('clean.css', '.x { color: var(--text-primary); padding: var(--space-3); }\n');
  ok('token-only CSS passes', clean.code === 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`test-design-lint: ${fails.length} failure(s)\n  ✗ ${fails.join('\n  ✗ ')}`);
  process.exit(1);
}
console.log(`test-design-lint: ${pass}/${pass} — lint:design holds its baseline with no slack, and its rules still fire`);
