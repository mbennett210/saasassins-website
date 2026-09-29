// test-css-duplicates — no stylesheet declares the same property for the same selector twice with different
// values (register CS-341; UI_RULES §122).
//
// Two top-level rules for one selector, where the later silently overrides the earlier, hid real bugs: the
// schedule's timeline dots contradicted THEME_CLEANSPACE R7 (CS-340), `.btn-link` and `.tab-btn` were each
// defined twice with different looks, and a shared rule plus a later one-selector override made a value depend
// on source order. A selector list counts as a declaration for each member, so "shared base, then override"
// is split instead (each member states its own value). @media / @supports / @container blocks are scoped on
// purpose and are skipped; each file is checked on its own (the theme files re-point tokens across files by
// design).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Top-level rules of a stylesheet: [{ sel, line, decl: {prop: value} }], one entry per selector of a list. */
export function topLevelRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const rules = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '}') { start = i + 1; continue; }
    if (text[i] !== '{') continue;
    const sel = text.slice(start, i).trim();
    let depth = 1, j = i + 1;
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    if (!sel.startsWith('@')) {
      const line = text.slice(0, i).split('\n').length - (sel.split('\n').length - 1);
      const decl = {};
      for (const part of text.slice(i + 1, j - 1).split(';')) {
        const k = part.split(':')[0].trim();
        const v = part.split(':').slice(1).join(':').trim();
        if (k && v && !/[{}]/.test(k)) decl[k] = v.replace(/\s+/g, ' ');
      }
      for (const s of sel.split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) rules.push({ sel: s, line, decl });
    }
    i = j - 1; start = j;
  }
  return rules;
}

/** Conflicts: a property set for one selector by two rules with different values. */
export function conflicts(css) {
  const bySel = new Map();
  for (const r of topLevelRules(css)) { if (!bySel.has(r.sel)) bySel.set(r.sel, []); bySel.get(r.sel).push(r); }
  const out = [];
  for (const [sel, list] of bySel) {
    if (list.length < 2) continue;
    const seen = new Map();
    for (const r of list) for (const [k, v] of Object.entries(r.decl)) {
      const prev = seen.get(k);
      if (prev && prev.v !== v) out.push({ sel, prop: k, first: `L${prev.line} ${prev.v}`, then: `L${r.line} ${v}` });
      seen.set(k, { v, line: r.line });
    }
  }
  return out;
}

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

console.log('the detector');
ok(conflicts('.a { color: red; }\n.b { color: blue; }\n.a { color: green; }').length === 1, 'a selector declared twice with a different value is a conflict');
ok(conflicts('.a, .b { margin: 4px; }\n.b { margin: 8px; }').length === 1, 'a shared list followed by a one-selector override is a conflict');
ok(conflicts('.a { color: red; }\n.a { padding: 4px; }').length === 0, 'two rules setting different properties are not');
ok(conflicts('.a { color: red; }\n.a { color:  red; }').length === 0, 'the same value twice is not');
ok(conflicts('.a { color: red; }\n@media (max-width: 640px) { .a { color: blue; } }').length === 0, 'a scoped @media override is not');
ok(conflicts('/* .a { color: blue; } */\n.a { color: red; }').length === 0, 'commented-out rules are ignored');

console.log('the stylesheets');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.css') ? [path.join(d, e.name)] : []);
const files = walk(SRC);
ok(files.length >= 5 && files.some((f) => f.endsWith('index.css')), `${files.length} stylesheets under src`);
for (const f of files) {
  const c = conflicts(fs.readFileSync(f, 'utf8'));
  ok(c.length === 0, `${path.relative(SRC, f).split(path.sep).join('/')}: no conflicting duplicate declarations${c.length ? ` (${c.length}: ${c.slice(0, 4).map((x) => `${x.sel} { ${x.prop} } ${x.first} → ${x.then}`).join('; ')})` : ''}`);
}

if (failed) { console.error(`\n✗ test-css-duplicates: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-css-duplicates: every selector states each property once');
