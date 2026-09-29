// test-button-lint — puts lint:buttons (scripts/button-size-lint.mjs) in CI through run-tests.
//
// CI cannot gain a workflow step here (the deploy token has no `workflow` scope), so a lint becomes a
// gate by being run from a test-*.mjs suite. This one runs the lint on the real tree (it must pass)
// and on fixtures that prove it still catches each violation it exists for, so a lint that silently
// stopped matching would fail here too:
//   - a standalone `btn-sm` outside a <table> and outside the ALLOW-listed clusters (UI_RULES §115);
//   - a `.btn` with no colour variant (UI_RULES §115, the §11 role convention);
// and still passes what it must: a `btn-sm` in a table row, and a variant held by a same-file const.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINT = fileURLToPath(new URL('./button-size-lint.mjs', import.meta.url));
const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass++; else fails.push(label); };
const run = (args, cwd) => {
  try { return { code: 0, out: execFileSync(process.execPath, [LINT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

// 1. the real tree
const real = run([], APP);
ok(`lint:buttons passes on app/src (exit ${real.code}):\n${real.out.trim()}`, real.code === 0);

// 2. fixtures
const dir = mkdtempSync(join(tmpdir(), 'button-lint-'));
try {
  const fixture = (name, jsx) => { const d = join(dir, name); mkdirSync(d); writeFileSync(join(d, 'Fixture.jsx'), jsx); return run(['--root', d], APP); };
  const noVariant = fixture('no-variant', 'export default () => <button className="btn">Save</button>;\n');
  ok('a .btn with no colour variant fails', noVariant.code === 1 && /without a colour variant/.test(noVariant.out));
  const bespoke = fixture('bespoke', 'export default () => <button className="btn my-gold">Save</button>;\n');
  ok('a .btn with only a bespoke colour class fails', bespoke.code === 1 && /without a colour variant/.test(bespoke.out));
  const standaloneSm = fixture('standalone-sm', 'export default () => <div><button className="btn btn-sm btn-primary">Save</button></div>;\n');
  ok('a standalone btn-sm outside a table fails', standaloneSm.code === 1 && /standalone btn-sm/.test(standaloneSm.out));
  const tableSm = fixture('table-sm', 'export default () => <table><tbody><tr><td><button className="btn btn-sm btn-outline">Edit</button></td></tr></tbody></table>;\n');
  ok('a btn-sm inside a table row passes', tableSm.code === 0);
  const constVar = fixture('const-variant', "export default ({ del }) => { const variant = del ? 'btn-danger' : 'btn-primary'; return <button className={`btn ${variant}`}>Go</button>; };\n");
  ok('a variant held by a same-file const passes', constVar.code === 0);
  const constBad = fixture('const-bespoke', "export default ({ on }) => { const tone = on ? 'my-on' : 'my-off'; return <button className={`btn ${tone}`}>Go</button>; };\n");
  ok('a const holding bespoke classes fails', constBad.code === 1);
  const xs = fixture('retired-size', 'export default () => <button className="btn btn-outline btn-xs">Reschedule</button>;\n');
  ok('a .btn with a retired size class (btn-xs) fails', xs.code === 1 && /size class other than btn-sm/.test(xs.out) && /btn-xs/.test(xs.out));
  const sheet = (name, css) => { const d = join(dir, name); mkdirSync(d); writeFileSync(join(d, 'Fixture.jsx'), 'export default () => <button className="btn btn-gold">Approve</button>;\n'); writeFileSync(join(d, 'fixture.css'), css); return run(['--root', d], APP); };
  const green = sheet('green-button', '.row-actions .btn-approve { color: var(--success); border-color: var(--color-semantic-success-200); }\n');
  ok('a stylesheet rule that paints a .btn-* class green fails (CS-338)', green.code === 1 && /paint a button green/.test(green.out));
  const greenHover = sheet('green-hover', '.btn.approve:hover { background: var(--color-semantic-success-50); }\n');
  ok('a green hover fill on a .btn fails too', greenHover.code === 1 && /paint a button green/.test(greenHover.out));
  const notButton = sheet('green-badge', '.badge.green { background: var(--success); }\n.btn-gold { background: var(--color-brand-secondary-500); }\n');
  ok('a green badge and a gold button pass', notButton.code === 0);
  const plusIcon = fixture('plus-icon', 'import Icon from "./Icon";\nexport default () => <button className="btn btn-primary"><Icon name="plus" size={16} /> New quote</button>;\n');
  ok('a plus icon beside a button label fails (§12, CS-352)', plusIcon.code === 1 && /with a plus/.test(plusIcon.out));
  const plusSpan = fixture('plus-span', 'import Icon from "./Icon";\nexport default () => <button className="btn btn-primary">\n  <Icon name="plus" size={16} />\n  <span>New DM</span>\n</button>;\n');
  ok('a plus icon beside a <span> label fails too', plusSpan.code === 1 && /with a plus/.test(plusSpan.out));
  const plusVar = fixture('plus-var', 'import Icon from "./Icon";\nexport default ({ a }) => <button className="btn btn-primary"><Icon name="plus" size={16} />{a.label}</button>;\n');
  ok('a plus icon beside a variable label ({a.label}) fails', plusVar.code === 1 && /with a plus/.test(plusVar.out));
  const plusCond = fixture('plus-cond', 'import Icon from "./Icon";\nexport default ({ open, t }) => <button className="btn btn-link" onClick={t}><Icon name={open ? \'x\' : \'plus\'} size={12} />{open ? \'Hide detail\' : \'Add detail\'}</button>;\n');
  ok('a plus behind a conditional icon name fails too (the Log Invoice disclosure slipped past)', plusCond.code === 1 && /with a plus/.test(plusCond.out));
  const plusPrefix = fixture('plus-prefix', 'export default () => <button className="btn btn-primary">+ New sequence</button>;\n');
  ok('a "+ " prefix on a button label fails', plusPrefix.code === 1 && /with a plus/.test(plusPrefix.out));
  const iconOnly = fixture('plus-icon-only', 'import Icon from "./Icon";\nexport default ({ open }) => <button className="btn btn-gold" aria-label="New Job" onClick={() => open(true)}><Icon name="plus" size={18} /></button>;\n');
  ok('an icon-only create button (aria-label, an arrow-function handler) keeps its plus', iconOnly.code === 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`test-button-lint: ${fails.length} failure(s)\n  ✗ ${fails.join('\n  ✗ ')}`);
  process.exit(1);
}
console.log(`test-button-lint: ${pass}/${pass} — lint:buttons passes on the tree and catches every fixture`);
