// control-families — every clickable control in app/src, grouped into families (UI_RULES §128, the control ledger).
//
// A control is a <button>, anything with role="button", or anything carrying the kit's `btn` class. Its family is
// the kit class it wears (`.btn`, `.btn-icon`, `.chip`, `.menu-option` …) or else its own first class, so a bespoke
// control (the old `.wo-x`, `.keys-filter-chip`) is its own family. A <button> with no class is grouped per file
// ("<button> in pages/Keys.jsx"). Comment lines are skipped: a `<button>` in a code comment is not a control.
//
// `test-control-ledger.mjs` (CI) holds app/design-system/controls.json to this list: every family is either a kit
// family or classified there, and no entry is stale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Class tokens of a className attribute value: string literals and template text, with ${…} removed. */
export function classTokens(v) {
  const parts = [...v.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' '));
  return parts.flatMap((p) => p.split(/\s+/)).filter((t) => /^[a-z][\w-]*$/i.test(t));
}

// state and role modifiers never name a family
const MODIFIER = /^(btn-(primary|secondary|outline|gold|success|danger|link|ghost|sm|dark)|active|selected|open|on|is-[\w-]+|has-[\w-]+|disabled)$/;

// the kit's control classes, most specific first: a control wearing one belongs to that kit family whatever else it
// carries (the other classes only place it). Each is documented in controls.json → kit.
export const KIT = [
  'btn-icon', 'btn.btn-link', 'btn.btn-sm', 'btn',
  'tab-btn', 'segmented-btn', 'inbox-toggle-btn', 'section-tab',
  'chip', 'chip-remove', 'toggle', 'select-trigger', 'menu-option', 'modal-close', 'linklike',
  'add-tile', 'input-clear', 'thumb-remove', 'badge-trigger', 'detail-back',
];
const wears = (name, toks) => name.split('.').every((c) => toks.includes(c));

export function familyOf(tag, toks, file) {
  for (const name of KIT) if (wears(name, toks)) return '.' + name;
  const own = toks.find((t) => !MODIFIER.test(t));
  if (own) return '.' + own;
  if (toks.length) return '.' + toks[0];
  return `<${tag}> in ${file}`;
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.jsx?$/.test(e.name) ? [path.join(d, e.name)] : []);

/** Source text with comments blanked out (line counts kept): `/* … *\/` blocks and whole `//` comment lines. */
export function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^([ \t]*)\/\/.*$/gm, '$1');
}

/** Every control in `srcDir`, grouped: Map(family → { n, at: ['file:line', …] }). */
export function controlFamilies(srcDir) {
  const fams = new Map();
  for (const f of walk(srcDir)) {
    const rel = path.relative(srcDir, f).split(path.sep).join('/');
    const t = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of t.matchAll(/<(button|a|div|span|label|li)\b((?:[^<>{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*)>/g)) {
      const [, tag, attrs] = m;
      const cm = attrs.match(/className=(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|"[^"]*"|'[^']*')/);
      const toks = cm ? classTokens(cm[1]) : [];
      if (!(tag === 'button' || /role=["']button["']/.test(attrs) || toks.includes('btn'))) continue;
      const fam = familyOf(tag, toks, rel);
      if (!fams.has(fam)) fams.set(fam, { n: 0, at: [] });
      const F = fams.get(fam);
      F.n += 1;
      F.at.push(`${rel}:${t.slice(0, m.index).split('\n').length}`);
    }
  }
  return fams;
}

// node app/scripts/control-families.mjs — print the families, most used first
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fams = controlFamilies(fileURLToPath(new URL('../src/', import.meta.url)));
  const list = [...fams].sort((a, b) => b[1].n - a[1].n);
  console.log(`${list.reduce((s, [, F]) => s + F.n, 0)} controls in ${list.length} families`);
  for (const [fam, F] of list) console.log(`${String(F.n).padStart(4)}  ${fam.padEnd(44)} ${F.at[0]}`);
}
