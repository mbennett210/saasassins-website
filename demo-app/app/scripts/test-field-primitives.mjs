// test-field-primitives — the field primitives render one height (UI_RULES §109, register CS-337).
//
// An input and a select trigger beside it must be the same height, radius and border "by construction": they
// share one declared shape. Until 2026-09-25 they did not quite: the trigger read the desktop font size while
// fields grew to 16px on phones (47px beside a 43px trigger), and with `line-height: normal` each element took
// its own font metrics (a native select rendered 42 / 45px beside 43 / 47px inputs). This suite reads the
// stylesheet and holds the shared shape; the rendered heights are checked by the local shape sweep.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { styleRules } from './css-rules.mjs';

const CSS = fs.readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

/** The declarations of the first top-level rule whose selector list is exactly `sel` (css-rules.mjs walks the
 *  braces, so a rule nested in @media is never mistaken for the top-level one). */
function rule(sel) {
  const want = sel.split(',').map((p) => p.trim().replace(/\s+/g, ' ')).join(', ');
  const r = styleRules(CSS).find((x) => x.at === '' && x.sels.join(', ') === want);
  return r ? r.decl : null;
}

const field = rule('.input, .select, textarea.input');
const trigger = rule('.select-trigger');
ok(!!field && !!trigger, 'the field rule (.input, .select, textarea.input) and .select-trigger both exist');
if (field && trigger) {
  for (const p of ['padding', 'border', 'border-radius', 'font-size', 'line-height']) {
    ok(field[p] && field[p] === trigger[p], `${p}: the fields and the select trigger declare the same value (${field[p] || '—'} / ${trigger[p] || '—'})`);
  }
  ok(field['font-size'] === 'var(--font-input-size)', 'the field font is the --font-input-size token (16px on phones, so iOS never zooms)');
  ok(/^var\(--line-height-[\w-]+\)$/.test(field['line-height'] || ''), 'the line-height is an explicit token, not `normal` (each element type measures `normal` differently)');
}
// the base control rule: a <button> / <input> / <select> / <textarea> no class dresses takes the page's colour and
// font family, never the browser's (a bare button rendered in Arial; UI_RULES §109 / §121)
{
  const base = [...CSS.matchAll(/(?<=^|\})\s*button, input, select, textarea\s*\{([^{}]*)\}/g)].map((m) => m[1]).join(';');
  ok(/color\s*:\s*inherit/.test(base) && /font-family\s*:\s*inherit/.test(base), 'the base control rule inherits colour and font family (no control renders in the browser font)');
}
// the phone re-assert covers every field primitive, the trigger included
const phone = [...CSS.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{/g)].map((m) => {
  let d = 1, j = m.index + m[0].length;
  while (j < CSS.length && d) { if (CSS[j] === '{') d++; else if (CSS[j] === '}') d--; j++; }
  return CSS.slice(m.index + m[0].length, j - 1);
}).join('\n');
const reassert = [...phone.matchAll(/([^{}]+)\{\s*font-size:\s*var\(--font-input-size\);\s*\}/g)].map((m) => m[1].split(',').map((s) => s.trim()));
ok(reassert.some((sels) => ['.input', '.select', 'textarea.input', '.select-trigger'].every((s) => sels.includes(s))), 'the ≤640px font re-assert covers .input, .select, textarea.input and .select-trigger');

if (failed) { console.error(`\n✗ test-field-primitives: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-field-primitives: fields and the select trigger share one shape');
