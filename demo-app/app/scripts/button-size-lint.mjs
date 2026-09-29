#!/usr/bin/env node
// button-size-lint — UI_RULES: standalone action buttons render at the 32px `.btn` standard.
// The 28px `.btn-sm` size is reserved for DENSE contexts only: data-table rows and a small,
// named set of cohesive control clusters. A `btn-sm` anywhere else is what made button heights
// drift between surfaces (the Messaging header, detail-page action rows, modal footers all sat
// at 28px next to 32px page/modal buttons). This sweep keeps the 32px standard from eroding.
//
// WHY A SWEEP. On 2026-09-22 an audit found 179 `btn-sm` buttons; 171 were standalone actions
// rendering 28px while page headers/modal footers were 32px. Nothing failed — the app simply
// looked inconsistent, and every new `btn-sm btn` in a header would silently rejoin the drift.
//
// WHAT IT CHECKS. Every `btn-sm` in a .jsx file must be either (a) inside a <table> block
// (a dense data row) or (b) in an ALLOW-listed cohesive cluster file. Anything else fails.
//
// ALSO (UI_RULES §115): every `.btn` carries a colour variant (VARIANTS below), written in the
// same className expression or held by a same-file `const` whose string values are all variants
// (`const variant = isDelete ? 'btn-danger' : 'btn-primary'` + `btn ${variant}`). A bespoke
// colour class in place of a variant is how buttons drift from the role convention (§11).
//
// AND the two tiers are the only sizes: `.btn` (32) and `.btn-sm` (28). A `btn-xs` / `btn-md` /
// `btn-lg` / `btn-xl` fails (the retired `.btn-xs` kept the 32px height and shrank only the text to
// 10px). And no stylesheet rule paints a button green (§11, register CS-338): a rule whose selector
// names `.btn` or a `.btn-*` class may not set a colour, background or border from a success token.
// Green is status only; the affirmative action is gold (`.btn-gold`, `.btn-success`).
//
// AND no labelled button carries a plus (§12, register CS-352): no `<Icon name="plus">` inside a
// <button> that has a text label, and no literal "+ " prefix on its label. The verb carries the
// affordance ("Add Customer", "New Job"). An icon-only create button (no text, an aria-label)
// keeps the plus: there it is the label.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : 'src';

// file → why btn-sm is allowed OUTSIDE a <table> here. Each is a COHESIVE dense control
// cluster where the small size is intentional and internally consistent (not a lone action
// button competing with 32px siblings). Adding a file here is a design decision to defend,
// not a way to quiet the sweep.
const ALLOW = new Map([
  ['components/BulkActionBar.jsx', 'the bulk-selection action bar — a dense strip of compact actions'],
  ['components/ConversationMessagePanel.jsx', 'the Reply/Reply-All/Forward segmented mode toggle + the compose Send (own 48px rule)'],
  ['components/SignatureCapture.jsx', 'the signature mode / font segmented pickers'],
  ['components/CsvImportModal.jsx', 'the create-&-update / update-only segmented import-mode toggle'],
  ['components/AddCompanyModal.jsx', 'the customer / vendor segmented type toggle'],
  ['pages/Schedule.jsx', 'the schedule nav cluster — Today matches the 28px prev/next arrows (.schedule-nav-controls)'],
  ['components/ClockControl.jsx', 'crew clock field buttons (min-height 42px; btn-sm only trims padding/font)'],
]);

// The colour variants a `.btn` must carry (index.css: the §11 role convention).
const VARIANTS = ['btn-primary', 'btn-secondary', 'btn-success', 'btn-gold', 'btn-danger', 'btn-outline', 'btn-link'];
// file:line → why this `.btn` may carry a bespoke colour instead of a variant. The same bar as
// ALLOW: a design decision to defend, and each entry is an open question for the owner.
const VARIANT_ALLOW = new Map([
  ['components/WorkOrdersPanel.jsx#Escalate', 'Escalate uses a soft-danger tint (.wo-btn-danger); no kit variant matches. Owner call: solid .btn-danger, or a new kit variant'],
]);
// file#marker → why a plus may sit inside this labelled button (§12).
const PLUS_ALLOW = new Map([
  ['components/MasterSearch.jsx#msearch-lp-tile-plus', 'the Launchpad create tiles: a small plus badge on the domain icon marks the create group (a deliberate design, register CS-352)'],
]);
// A button's own label: text outside tags and {…}, or a child {…} expression (a string, a
// variable like {a.label}, a call) — anything but a comment. An icon-only button has neither.
function hasLabel(inner) {
  const noTags = inner.replace(/<(?:\{(?:[^{}]|\{[^{}]*\})*\}|[^<>{}])*>/g, ' ');
  const outside = noTags.replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ');
  if (/[A-Za-z]/.test(outside)) return true;
  const exprs = noTags.match(/\{(?:[^{}]|\{[^{}]*\})*\}/g) || [];
  return exprs.some((e) => !/^\{\s*\/\*[\s\S]*\*\/\s*\}$/.test(e) && /[A-Za-z]/.test(e));
}

// className values in a JSX source: "…", '…', or {…} (balanced braces).
function classNames(src) {
  const out = [];
  const re = /className\s*=\s*/g; let m;
  while ((m = re.exec(src))) {
    const i = m.index + m[0].length; const c = src[i];
    if (c === '"' || c === "'") { out.push({ at: m.index, text: src.slice(i + 1, src.indexOf(c, i + 1)) }); continue; }
    if (c === '{') { let d = 0, j = i; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && !--d) break; } out.push({ at: m.index, text: src.slice(i + 1, j) }); }
  }
  return out;
}
const hasVariant = (text) => VARIANTS.some((v) => new RegExp(`(^|[^\\w-])${v}(?![\\w-])`).test(text));
// `${ident}` whose same-file `const ident = …;` initializer holds only variant strings
function constVariant(src, text) {
  const ids = [...text.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((x) => x[1]);
  return ids.some((id) => {
    const d = new RegExp(`\\bconst\\s+${id}\\s*=\\s*([^;\\n]+)`).exec(src);
    if (!d) return false;
    const strs = [...d[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
    return strs.length > 0 && strs.every((s) => VARIANTS.includes(s));
  });
}

const files = [];
const sheets = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (p.endsWith('.jsx')) files.push(p);
    if (p.endsWith('.css')) sheets.push(p);
  }
})(ROOT);

// the size classes a `.btn` may not carry (the tiers are `.btn` 32 and `.btn-sm` 28)
const RETIRED_SIZE = /(^|[^\w-])(btn-(?:xs|md|lg|xl))(?![\w-])/;
// a declaration that paints green: colour / background / border from a success token
const GREEN = /(^|[;{\s])(color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?)\s*:[^;}]*(var\(--success\)|--color-semantic-success-)/;
const sizeFindings = [];
const greenFindings = [];
for (const file of sheets) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (sel.startsWith('@') || !/\.btn(?:-[\w-]+)?(?![\w-])/.test(sel)) continue;
    if (!GREEN.test(m[2])) continue;
    greenFindings.push({ rel, line: css.slice(0, m.index + m[0].indexOf(sel)).split('\n').length, text: sel.replace(/\s+/g, ' ').slice(0, 80) });
  }
}

const findings = [];
const variantFindings = [];
const plusFindings = [];
let total = 0, inTableOk = 0, allowOk = 0, btnTotal = 0, variantAllowed = 0, plusAllowed = 0;
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  // §12: a labelled button carries no plus icon and no "+ " prefix
  for (const bm of src.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
    const block = bm[0];
    // the opening tag: a {…} attribute expression is taken whole first, so `onClick={() => …}` doesn't end the tag
    const open = block.match(/^<button\b(?:\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|[^<>{}])*>/);
    const inner = open ? block.slice(open[0].length, -'</button>'.length) : block;
    // a literal plus, or an expression that can be one (name={open ? 'x' : 'plus'})
    const icon = /<Icon\s[^>]*name=(?:["']plus["']|\{[^}]*["']plus["'][^}]*\})/.test(inner);
    const prefix = /(^|>|\n)\s*\+\s+[A-Za-z]/.test(inner.replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, ''));
    if (!(icon && hasLabel(inner)) && !prefix) continue;
    const allowKey = [...PLUS_ALLOW.keys()].find((k) => k.startsWith(rel + '#') && block.includes(k.slice(rel.length + 1)));
    if (allowKey) { plusAllowed++; continue; }
    const line = src.slice(0, bm.index).split('\n').length;
    plusFindings.push({ rel, line, text: (prefix ? 'a "+ " prefix on the label' : 'a plus icon beside the label') + ` — ${inner.replace(/\s+/g, ' ').trim().slice(0, 60)}` });
  }
  // table spans
  const spans = [];
  const tre = /<table[\s>]/g; let tm;
  while ((tm = tre.exec(src))) { const e = src.indexOf('</table>', tm.index); spans.push([tm.index, e === -1 ? src.length : e]); }
  const bre = /\bbtn-sm\b/g; let bm;
  const seen = new Set();
  while ((bm = bre.exec(src))) {
    const line = src.slice(0, bm.index).split('\n').length;
    if (seen.has(line)) continue; seen.add(line); // one finding per line
    total++;
    if (spans.some(([a, b]) => bm.index >= a && bm.index <= b)) { inTableOk++; continue; }
    if (ALLOW.has(rel)) { allowOk++; continue; }
    findings.push({ rel, line, text: src.split('\n')[line - 1].trim().slice(0, 80) });
  }
  // §115: every .btn carries a colour variant
  for (const cn of classNames(src)) {
    if (!/(^|[\s'"`])btn(?=$|[\s'"`])/.test(cn.text)) continue;
    btnTotal++;
    const size = RETIRED_SIZE.exec(cn.text);
    if (size) sizeFindings.push({ rel, line: src.slice(0, cn.at).split('\n').length, text: `${size[2]} in "${cn.text.replace(/\s+/g, ' ').slice(0, 60)}"` });
    if (hasVariant(cn.text) || constVariant(src, cn.text)) continue;
    const line = src.slice(0, cn.at).split('\n').length;
    const label = src.split('\n')[line - 1];
    const allowKey = [...VARIANT_ALLOW.keys()].find((k) => k.startsWith(rel + '#') && label.includes(k.slice(rel.length + 1)));
    if (allowKey) { variantAllowed++; continue; }
    variantFindings.push({ rel, line, text: cn.text.replace(/\s+/g, ' ').slice(0, 80) });
  }
}

const label = `button-size-lint — ${total} btn-sm · ${inTableOk} in tables · ${allowOk} in allowed clusters · ${btnTotal} .btn · ${variantAllowed} bespoke-colour allowed · ${sheets.length} stylesheets · ${plusAllowed} plus allowed`;
if (findings.length === 0 && variantFindings.length === 0 && sizeFindings.length === 0 && greenFindings.length === 0 && plusFindings.length === 0) {
  console.log(`\n${label}\n  ✓ no standalone btn-sm — action buttons hold the 32px standard\n  ✓ every .btn carries a colour variant (§115)\n  ✓ every .btn is one of the two tiers, .btn (32) or .btn-sm (28)\n  ✓ no stylesheet rule paints a button green (§11)\n  ✓ no labelled button carries a plus (§12)\n`);
  process.exit(0);
}
console.error(`\n${label}\n`);
if (plusFindings.length) {
  console.error(`  ${plusFindings.length} labelled button(s) with a plus (§12: the verb carries it — "Add Customer", "New Job"):\n`);
  for (const f of plusFindings) console.error(`  ✗ ${f.rel}:${f.line} — ${f.text}`);
  console.error('\n  Fix: drop the plus icon or the "+ " prefix. An icon-only create button (no text, an aria-label) may keep it.\n');
}
if (sizeFindings.length) {
  console.error(`  ${sizeFindings.length} .btn with a size class other than btn-sm (the tiers are .btn 32 and .btn-sm 28, §115):\n`);
  for (const f of sizeFindings) console.error(`  ✗ ${f.rel}:${f.line} — ${f.text}`);
  console.error('\n  Fix: drop the size class (32px), or use btn-sm in a table row or an ALLOW-listed cluster.\n');
}
if (greenFindings.length) {
  console.error(`  ${greenFindings.length} stylesheet rule(s) paint a button green (§11: green is status only; the affirmative action is gold):\n`);
  for (const f of greenFindings) console.error(`  ✗ ${f.rel}:${f.line} — ${f.text}`);
  console.error('\n  Fix: give the button a §11 role class (.btn-gold / .btn-success are gold) and delete the green rule.\n');
}
if (findings.length) {
  console.error(`  ${findings.length} standalone btn-sm (should be 32px .btn, drop btn-sm):\n`);
  for (const f of findings) console.error(`  ✗ ${f.rel}:${f.line} — ${f.text}`);
  console.error(`
  Fix: remove btn-sm so the button renders at the 32px .btn standard. If it is genuinely a
  dense data-table row, put it inside the <table>. If it is a cohesive control cluster
  (segmented toggle, nav group), add the file to ALLOW in this script WITH a reason.
`);
}
if (variantFindings.length) {
  console.error(`  ${variantFindings.length} .btn without a colour variant (§115: ${VARIANTS.join(' / ')}):\n`);
  for (const f of variantFindings) console.error(`  ✗ ${f.rel}:${f.line} — ${f.text}`);
  console.error(`
  Fix: add the variant whose colours the button means (a bespoke colour class that repeats a
  variant's colours is deleted, replace-means-delete). A genuinely different role is an owner
  decision: add it to VARIANT_ALLOW in this script WITH the reason, or add a kit variant.
`);
}
process.exit(1);
