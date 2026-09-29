#!/usr/bin/env node
/**
 * design-lint — PolishPoint STRUCTURE v2 enforcer (zero-dependency).
 *
 * Ported from the PolishPoint Design Kit (Kronelius/Styling · STRUCTURE.md §10) and
 * extended with three FLAT-TREATMENT rules for this shell (UI_RULES §40): the kit's
 * lexical rules catch raw hex/px/off-grid/inline-style drift, but none of them
 * catch a var()-based gradient or a var()-based glow — exactly what the flatten pass
 * removed. `no-decorative-gradient`, `flat-shadow`, and `no-glow-filter` close that
 * gap, so a stray gradient / glow / drop-shadow in COMPONENT css or jsx fails the
 * push. Theme files (theme*.css) are never scanned — they legitimately own the
 * recipe layer; theme-flat.css flattens it. Nor is src/brand/tokens.generated.js: it is
 * the theme's colours resolved for code that cannot read a CSS variable, written by
 * brand-js.mjs and held to the cascade by test-design-system.mjs. (The complete colour
 * gate, over the server and the static shell too, is color-ledger.mjs; UI_RULES §121.)
 *
 * Existing debt is frozen in a per-file per-rule baseline; only NEW violations fail.
 * The baseline ratchets DOWN only. The flat rules baseline to 0 on the flattened tree.
 *
 * Usage:
 *   node design-lint.mjs [--root <dir>] [--update-baseline] [--json] [--verbose] [paths...]
 *   node design-lint.mjs --rebaseline "<reason>"   the ONE way to RAISE cells: records the reason and
 *     date in the baseline file (rebaselined[]), so a reset is deliberate and visible in review.
 *
 * Escape hatch (same line or the line immediately above a flagged line):
 *   / * design:allow no-raw-px — reason * /       (CSS)
 *   {/ * design:allow no-inline-px — reason * /}   (JSX)
 *
 * Exit: 0 pass / 1 new violations or malformed allow / 2 internal error.
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(opt('--root', 'src'));
const BASELINE_FILE = path.resolve(opt('--baseline', 'design-lint.baseline.json'));
const UPDATE = flag('--update-baseline');
const REBASELINE = opt('--rebaseline', null);
const JSON_OUT = flag('--json');
const VERBOSE = flag('--verbose');
const RULE_FILTER = opt('--rule', null);
const explicitPaths = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--') || ['--root', '--baseline', '--rule', '--rebaseline'].indexOf(args[i - 1]) < 0));

const RULES = {
  'no-raw-hex':      { sev: 'error', desc: 'colour literal — use a token' },
  'no-raw-px':       { sev: 'error', desc: 'raw px on a spacing/size prop — use var(--space-*)/--control-height-*' },
  'no-inline-px':    { sev: 'error', desc: 'literal px in a JSX style prop — use a class or var(--token)' },
  'off-grid':        { sev: 'error', desc: 'px value off the 4px grid' },
  'scaffold-inline': { sev: 'error', desc: 'inline style on a scaffold element — scaffold classes own their geometry' },
  // ── flat-treatment rules (UI_RULES §40) ──
  'no-decorative-gradient': { sev: 'error', desc: 'gradient in component CSS/JSX — flat treatment forbids it (border-box flat-fill + masks exempt; recipes live in theme*.css)' },
  'flat-shadow':            { sev: 'error', desc: 'box-shadow with a colour literal — flat surfaces carry a hairline; overlays use var(--shadow-overlay)/none' },
  'shadow-tier':            { sev: 'error', desc: 'a shadow tier other than the one overlay tier — floating surfaces read var(--shadow-overlay) (STRUCTURE §5)' },
  'no-glow-filter':         { sev: 'error', desc: 'filter: drop-shadow(...) — glows are gone under the flat treatment' },
};

// ---- helpers ------------------------------------------------------------
const SPACING_PROPS = /(?:^|[;{\s])(margin|margin-top|margin-right|margin-bottom|margin-left|padding|padding-top|padding-right|padding-bottom|padding-left|gap|row-gap|column-gap|height|min-height|max-height|font-size|top|right|bottom|left|inset)\s*:/i;
const JSX_SPACING_KEYS = /\b(margin|marginTop|marginRight|marginBottom|marginLeft|padding|paddingTop|paddingRight|paddingBottom|paddingLeft|gap|rowGap|columnGap|height|minHeight|maxHeight|fontSize|top|right|bottom|left|inset)\b/;
const SCAFFOLD = ['page-head', 'filter-bar', 'toolbar', 'bulk-bar', 'card', 'form-row', 'section-head', 'stack', 'split'];

function walk(dir, out) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(jsx?|css)$/.test(e.name) && !/^theme.*\.css$/.test(e.name) && !(e.name === 'tokens.generated.js' && path.basename(dir) === 'brand')) out.push(full);
  }
  return out;
}

// design:allow map — line number -> Set of allowed rule ids (applies to that line and the next)
function collectAllows(lines) {
  const map = new Map();
  const bad = [];
  lines.forEach((ln, i) => {
    if (!/design:allow/.test(ln)) return;
    const raw = ln.match(/design:allow\s+([a-z0-9,\- ]+?)(?:\s+[—-]{1,2}\s+(.*))?(?:\*\/|\}|$)/i);
    if (!raw) { bad.push({ line: i + 1, why: 'malformed design:allow' }); return; }
    const ids = raw[1].split(',').map(s => s.trim()).filter(Boolean);
    const reason = (raw[2] || '').trim();
    if (!ids.length || !reason) { bad.push({ line: i + 1, why: 'design:allow needs <rule-id> and a reason' }); return; }
    [i + 1, i + 2].forEach(l => { if (!map.has(l)) map.set(l, new Set()); ids.forEach(id => map.get(l).add(id)); });
  });
  return { map, bad };
}

function stripLineComment(s) { return s.replace(/\/\/.*$/, ''); }

// Gather a specific declaration's value — from `<prop>:` on line i to the terminating
// ';' — so a co-located earlier declaration (e.g. `background: rgba(...); box-shadow: …`)
// on the same line isn't captured. box-shadow / filter values may span lines.
function declValue(lines, i, propRe) {
  const m = lines[i].match(propRe);
  const startIdx = m ? lines[i].indexOf(m[0]) + m[0].length : (lines[i].indexOf(':') + 1);
  let seg = lines[i].slice(startIdx);
  if (seg.includes(';')) return seg.slice(0, seg.indexOf(';'));
  let acc = seg;
  for (let j = i + 1; j < lines.length && j < i + 12; j++) {
    const l = lines[j];
    if (l.includes(';')) { acc += ' ' + l.slice(0, l.indexOf(';')); break; }
    acc += ' ' + l;
  }
  return acc;
}

// ---- scanners -----------------------------------------------------------
function scanCss(file, lines) {
  const viol = [];
  lines.forEach((line, i) => {
    const ln = line;
    // no-raw-hex (allow rgba(var(...)) and data-URI icons handled by skipping url())
    if (!/url\(/.test(ln)) {
      const hex = ln.match(/#[0-9a-fA-F]{3,8}\b/);
      if (hex) viol.push({ line: i + 1, rule: 'no-raw-hex', snip: hex[0] });
    }
    // spacing/size prop lines
    if (SPACING_PROPS.test(ln) && !/^\s*--/.test(ln)) {
      const pxs = [...ln.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(m => parseFloat(m[1]));
      const isFontOrLh = /font-size|line-height/i.test(ln);
      const isBorderish = /border|outline|shadow/i.test(ln);
      for (const v of pxs) {
        if (v === 0) continue;
        if (!/height|min-height|font-size/i.test(ln) && /width/i.test(ln)) continue; // width family exempt
        viol.push({ line: i + 1, rule: 'no-raw-px', snip: v + 'px' });
        if (!isFontOrLh && !isBorderish && Math.abs(v) > 2 && v % 4 !== 0) viol.push({ line: i + 1, rule: 'off-grid', snip: v + 'px' });
      }
    }
    // (seg-flush-fill, the kit's padding-0 segmented-track rule, was retired in STRUCTURE 2.1.0: this build
    // pads segmented tracks 3px, UI_RULES §7; register CS-346.)

    // ── FLAT TREATMENT (UI_RULES §40) ──
    // no-decorative-gradient — every gradient in component CSS is depth, EXCEPT:
    //   (a) the border-box flat-fill idiom  linear-gradient(var(--X), var(--X))  (renders as a solid fill)
    //   (b) a mask context (mask-image / -webkit-mask / mask:) on this or the 2 preceding lines
    if (/(?:linear|radial|conic)-gradient\s*\(/.test(ln)) {
      const maskCtx = /mask/i.test(ln) || /mask/i.test(lines[i - 1] || '') || /mask/i.test(lines[i - 2] || '');
      const re = /(linear|radial|conic)-gradient\s*\(/g;
      let gm;
      while ((gm = re.exec(ln))) {
        const rest = ln.slice(gm.index);
        const flatFill = /^linear-gradient\(\s*var\((--[\w-]+)\)\s*,\s*var\(\1\)\s*\)/.test(rest);
        if (!flatFill && !maskCtx) viol.push({ line: i + 1, rule: 'no-decorative-gradient', snip: gm[1] + '-gradient(' });
      }
    }
    // flat-shadow — a box-shadow whose value carries a colour literal (hex or rgb/rgba/hsl,
    // incl. the rgba(var(--…-rgb),α) recipe form) is a coloured/neumorphic shadow. Flat
    // surfaces use `none`; overlays use var(--shadow-overlay). Value may span lines.
    // shadow-tier — the one shadow is the overlay tier (STRUCTURE §5, register CS-344): a
    // box-shadow that reads any other --shadow-* step (sm / md / lg / xl…) fails.
    if (/(?:^|[;{\s])box-shadow\s*:/.test(ln) && !/^\s*--/.test(ln)) {
      const val = declValue(lines, i, /box-shadow\s*:/);
      if (/#[0-9a-fA-F]{3,8}\b/.test(val) || /\b(?:rgb|hsl)a?\(/i.test(val)) viol.push({ line: i + 1, rule: 'flat-shadow', snip: 'box-shadow' });
      const tier = val.match(/var\(\s*--shadow-(?!overlay\b)([\w-]+)/);
      if (tier) viol.push({ line: i + 1, rule: 'shadow-tier', snip: `--shadow-${tier[1]}` });
    }
    // no-glow-filter — filter: drop-shadow(...) is a glow
    if (/(?:^|[;{\s])filter\s*:/.test(ln)) {
      const val = declValue(lines, i, /filter\s*:/);
      if (/drop-shadow\s*\(/i.test(val)) viol.push({ line: i + 1, rule: 'no-glow-filter', snip: 'drop-shadow(' });
    }
  });
  return viol;
}

function scanJsx(file, lines, text) {
  const viol = [];
  lines.forEach((line, i) => {
    const ln = stripLineComment(line);
    // no-raw-hex in JSX (strings/style values), skip #route and #id anchors and data-URIs
    if (!/url\(|href=|to=/.test(ln)) {
      const hex = ln.match(/['":\s(]#[0-9a-fA-F]{3}\b|['":\s(]#[0-9a-fA-F]{6}\b/);
      if (hex) viol.push({ line: i + 1, rule: 'no-raw-hex', snip: hex[0].trim() });
      const rgb = ln.match(/\b(rgb|hsl)a?\(\s*\d/);
      if (rgb) viol.push({ line: i + 1, rule: 'no-raw-hex', snip: rgb[0] });
    }
    // no-inline-px inside style={{ ... }}
    if (/style=\{\{/.test(ln)) {
      const styleFrag = ln.slice(ln.indexOf('style={{'));
      const pairRe = /([a-zA-Z]+)\s*:\s*(['"]?)([^,'"}]+)\2/g;
      let m;
      while ((m = pairRe.exec(styleFrag))) {
        const key = m[1], val = m[3].trim();
        if (!JSX_SPACING_KEYS.test(key)) continue;
        if (/[$]\{|\bvar\(|\bcalc\(|%|\bauto\b|[a-zA-Z_]\w*\s*[.?(]|\?/.test(val)) continue;
        if (/^-?\d+(\.\d+)?(px)?$/.test(val) && val !== '0') viol.push({ line: i + 1, rule: 'no-inline-px', snip: key + ':' + val });
      }
    }
    // scaffold-inline: element with a scaffold class AND a style= attribute
    const cls = ln.match(/className=["'`]([^"'`]+)["'`]/);
    if (cls && /\bstyle=/.test(ln)) {
      const classes = cls[1].split(/\s+/);
      if (classes.some(c => SCAFFOLD.includes(c))) viol.push({ line: i + 1, rule: 'scaffold-inline', snip: cls[1].slice(0, 40) });
    }
    // ── FLAT TREATMENT (UI_RULES §40) in JSX inline styles ──
    // exempt the border-box flat-fill idiom linear-gradient(var(--X), var(--X)) (same as the CSS rule)
    if (/(?:linear|radial|conic)-gradient\s*\(/.test(ln) && !/linear-gradient\(\s*var\((--[\w-]+)\)\s*,\s*var\(\1\)\s*\)/.test(ln)) viol.push({ line: i + 1, rule: 'no-decorative-gradient', snip: 'gradient in style' });
    if (/drop-shadow\s*\(/.test(ln)) viol.push({ line: i + 1, rule: 'no-glow-filter', snip: 'drop-shadow in style' });
    if (/boxShadow\s*:/.test(ln)) {
      const seg = ln.slice(ln.indexOf('boxShadow'));
      if (/#[0-9a-fA-F]{3,8}\b/.test(seg) || /\b(?:rgb|hsl)a?\(/i.test(seg)) viol.push({ line: i + 1, rule: 'flat-shadow', snip: 'boxShadow in style' });
      if (/var\(\s*--shadow-(?!overlay\b)[\w-]+/.test(seg)) viol.push({ line: i + 1, rule: 'shadow-tier', snip: 'boxShadow tier in style' });
    }
  });
  return viol;
}

// ---- run ----------------------------------------------------------------
function relPosix(f) { return path.relative(ROOT, f).split(path.sep).join('/'); }

function main() {
  const files = explicitPaths.length ? explicitPaths.map(p => path.resolve(p)) : walk(ROOT, []);
  const perFile = {}; // rel -> {rule: count}
  const details = []; // {rel, line, rule, snip}
  const allowBad = [];

  for (const file of files) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const { map: allows, bad } = collectAllows(lines);
    bad.forEach(b => allowBad.push({ rel: relPosix(file), ...b }));
    const isCss = file.endsWith('.css');
    let viol = isCss ? scanCss(file, lines) : scanJsx(file, lines, text);
    if (RULE_FILTER) viol = viol.filter(v => RULE_FILTER.split(',').includes(v.rule));
    const rel = relPosix(file);
    for (const v of viol) {
      if (allows.get(v.line) && allows.get(v.line).has(v.rule)) continue; // suppressed
      perFile[rel] = perFile[rel] || {};
      perFile[rel][v.rule] = (perFile[rel][v.rule] || 0) + 1;
      details.push({ rel, ...v });
    }
  }

  // baseline
  let baseline = { version: 1, files: {} };
  if (fs.existsSync(BASELINE_FILE)) { try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch {} }

  if (UPDATE || REBASELINE !== null) {
    if (REBASELINE !== null && !REBASELINE.trim()) { console.error('--rebaseline needs a reason: --rebaseline "<why these cells rise>"'); process.exit(1); }
    const raised = [];
    for (const rel of Object.keys(perFile)) for (const rule of Object.keys(perFile[rel])) {
      const base = (baseline.files[rel] && baseline.files[rel][rule]) || 0;
      if (perFile[rel][rule] > base && fs.existsSync(BASELINE_FILE)) raised.push(`${rel} ${rule}: ${perFile[rel][rule]} > ${base}`);
    }
    if (raised.length && REBASELINE === null) { console.error('Refusing to RAISE the baseline (it only ratchets down). Fix or design:allow, or reset deliberately with --rebaseline "<reason>":\n  ' + raised.join('\n  ')); process.exit(1); }
    const history = baseline.rebaselined || [];
    if (REBASELINE !== null) history.push({ at: new Date().toISOString().slice(0, 10), reason: REBASELINE.trim(), raisedCells: raised.length });
    const totals = {};
    for (const rel of Object.keys(perFile)) for (const rule of Object.keys(perFile[rel])) totals[rule] = (totals[rule] || 0) + perFile[rel][rule];
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), ...(history.length ? { rebaselined: history } : {}), totals, files: perFile }, null, 2) + '\n');
    console.log('Baseline written: ' + Object.entries(totals).map(([k, v]) => k + ' ' + v).join(' · '));
    process.exit(0);
  }

  // compare to baseline
  const newViol = [];
  for (const rel of Object.keys(perFile)) for (const rule of Object.keys(perFile[rel])) {
    const base = (baseline.files[rel] && baseline.files[rel][rule]) || 0;
    if (perFile[rel][rule] > base) {
      const sites = details.filter(d => d.rel === rel && d.rule === rule);
      newViol.push({ rel, rule, count: perFile[rel][rule], base, sites });
    }
  }
  const ratchetable = [];
  for (const rel of Object.keys(baseline.files || {})) for (const rule of Object.keys(baseline.files[rel])) {
    const cur = (perFile[rel] && perFile[rel][rule]) || 0;
    if (cur < baseline.files[rel][rule]) ratchetable.push(`${rel} ${rule}: ${cur} < ${baseline.files[rel][rule]}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ pass: newViol.length === 0 && allowBad.length === 0, newViolations: newViol, allowBad, ratchetable }, null, 2));
    process.exit(newViol.length || allowBad.length ? 1 : 0);
  }

  const total = details.length;
  console.log(`design-lint — STRUCTURE 2.1.0 + flat (§40) · ${files.length} files · ${total} tracked findings`);
  if (allowBad.length) { console.log('\nMALFORMED design:allow:'); allowBad.forEach(b => console.log(`  ${b.rel}:${b.line} — ${b.why}`)); }
  if (newViol.length) {
    console.log('\nNEW violations (above baseline):');
    for (const v of newViol) {
      console.log(`  ${v.rel} — ${v.rule}: ${v.count} > ${v.base} baseline`);
      v.sites.slice(0, 6).forEach(s => console.log(`    L${s.line}  ${s.snip}   (${RULES[s.rule] ? RULES[s.rule].desc : ''})`));
    }
    console.log(`\n${newViol.reduce((a, v) => a + (v.count - v.base), 0)} new finding(s) — FAIL`);
  } else {
    console.log('\nNo new violations. ✓');
  }
  if (ratchetable.length && !UPDATE) console.log(`\nratchet available (run --update-baseline): ${ratchetable.length} cell(s) improved`);
  if (baseline.totals) console.log('baseline: ' + Object.entries(baseline.totals).map(([k, v]) => k + ' ' + v).join(' · '));
  process.exit(newViol.length || allowBad.length ? 1 : 0);
}

try { main(); } catch (e) { console.error('design-lint internal error:', e.message); process.exit(2); }
