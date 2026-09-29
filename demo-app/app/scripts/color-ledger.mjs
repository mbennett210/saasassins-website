#!/usr/bin/env node
// color-ledger — every colour the app ships outside its theme, and why it may stay.
//
// THE RE-SKIN GUARANTEE. A new brand is a new set of token VALUES (theme-<client>.css plus the
// generated brand data); nothing else changes. Any colour written anywhere else survives the swap and
// leaks the old brand, on desktop or on a phone, in the app or in an email or PDF it sends. This
// enumerates the whole shipped surface mechanically (BUILD_INTEGRITY: coverage is an enumerator, never
// judgment) and fails on every colour literal that is not in the theme layer and not explicitly allowed.
//
// UNIVERSE (every file the app serves or renders from):
//   src/**/*.{css,js,jsx,mjs}   components, pages, report/quote templates, canvas, demo data
//   api/**/*.{js,mjs}           emails, PDF rendering, public pages
//   index.html                  meta theme-color and any inline style
//   public/**/*.{json,webmanifest,svg,js,html}   the PWA manifest, icons, the service worker
//   scripts/gen-*.mjs           the brand-asset generators: their colours ship inside the icons and logos
//   scripts/test-email.mjs      mails the branded email shell
//   scripts/seed-backend.mjs    writes the demo book (and its placeholder photos) into the backend
// Theme layer (the palette, where values belong): src/theme.css, src/theme-*.css.
// Excluded, with the reason on record: EXCLUDE below.
//
// A COLOUR LITERAL is a hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa, also %23-encoded in a data URI),
// an rgb()/rgba()/hsl()/hsla() with a numeric first argument, or a CSS named colour in a value position.
// In CSS and SVG/HTML every declaration's value counts (custom properties, gradients, filters, masks
// included; font, animation, grid and content names are not colours), and so do SVG paint attributes
// (fill='white'). In JS: a string that IS a colour; a colour inside a CSS- or SVG-looking string; a named
// colour under a colour key of an object (the bare `color` key only in a style: tag data such as
// { color: 'green' } names a Badge variant); a named paint on a JSX SVG element (<path fill="white">).
// A "#123" in prose ("Invoice #123") is not a colour.
//
// MASKS: a colour inside a mask (mask, mask-image, -webkit-mask…) is listed as `mask`, not a leak: a mask
// reads only alpha, so its black means opaque in every brand.
//
// ALLOWED: the design-lint escape hatch on the same line or the line above,
//   /* design:allow no-raw-hex — <reason> */      (or // … in JS)
// e.g. a third-party brand mark (Google's palette), ink a person chooses, demo artwork. A reason is
// required; an allow with no reason is itself a finding.
//
//   node scripts/color-ledger.mjs            summary + every unallowed literal; exit 1 if any
//   node scripts/color-ledger.mjs --json     the full ledger (every literal, allowed or not)
// CI: test-color-ledger.mjs runs it over the real tree (zero leaks) and proves each detection on fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const JSON_OUT = process.argv.includes('--json');

const EXCLUDE = new Map([
  ['public/icons.svg', 'the Vite starter\'s social-icon sprite: no app code references it'],
]);
// Shipped files whose colours are CONTENT, not chrome: they draw a picture of something, and a re-skin
// must leave them alone. Each entry is a decision to defend, with the reason on record.
const CONTENT = new Map([
  ['src/data/demoSiteMedia.js', 'demo-mode placeholder PHOTOS of client sites (buildings, windows, sky, grass), drawn as SVG so a pitch works offline; content standing in for real photos, never brand chrome'],
  ['scripts/seed-backend.mjs', 'the same placeholder site PHOTOS, drawn as SVG and written into the backend with the demo book; content standing in for real photos, never brand chrome'],
]);
const isTheme = (rel) => /^src\/theme(-[a-z0-9-]+)?\.css$/.test(rel);
// Brand outputs generated from the theme cascade by scripts/brand-js.mjs (and checked by the design-system
// gate): the resolved colours for non-CSS code, the manifest colours and the theme-color meta.
const brandOwned = (rel, lineText) => rel === 'src/brand/tokens.generated.js' || rel === 'public/manifest.json'
  || (rel === 'index.html' && /<meta name="theme-color"/.test(lineText));

// CSS named colours (CSS Color 4), minus the non-colours transparent/currentcolor.
const NAMED = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));
// Every declaration's value is a value position, custom properties included, except properties whose
// keywords can collide with a colour name (a font called "Tomato", an animation called "red").
const DECL = /(?:^|[{;"'`])\s*(--[\w-]+|-?[a-zA-Z][\w-]*)\s*:\s*([^;{}"'`]+)/gm;
const KEYWORD_PROPS = /^(?:font(?:-family)?|content|quotes|grid(?:-[a-z-]+)?|animation(?:-name)?|transition(?:-property)?|counter-(?:reset|increment|set)|list-style(?:-type)?|will-change|cursor|text-transform|white-space)$/i;
// A mask reads only alpha: black means opaque in every brand, so a colour in a mask is not chrome.
const MASK_PROPS = /^(?:-webkit-)?mask(?:-image|-border(?:-source)?)?$/i;
const MASK_REASON = 'a mask reads only alpha (black = opaque), the same in every brand';
// SVG paint attributes inside an HTML/SVG string: fill='white'
const SVG_ATTR = /\b(?:fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*(['"])\s*([a-zA-Z]+)\s*\1/gi;
// ...and on intrinsic SVG elements in JSX: <path fill="white" />
const JSX_PAINT = /\b(?:fill|stroke|stopColor|floodColor|lightingColor)\s*=\s*\{?\s*(['"`])([a-zA-Z]+)\1/g;
// A property or key that carries a colour (CSS or camelCase): borderTop, boxShadow, WebkitMaskImage, penColor…
const COLORISH = /colou?r|background|border|outline|shadow|fill|stroke|mask|filter|decoration|caret|accent|stop|flood|lighting|column-?rule/i;
// a JS object's `key: 'value'`
const JS_KEYED = /\b([A-Za-z][\w]*)\s*:\s*(['"`])([^'"`\n]*)\2/g;
// A string shaped like a CSS value or declaration. An all-digit "#555" counts as a colour only in one
// ("Order #123456" is prose); a hex with an a-f digit ("#e5e7eb") is a colour in any string.
const CSSY = /\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|pt)\b|\b(?:solid|dashed|dotted|double|inset|groove|ridge)\b|gradient\(|(?:^|[\s;{"'])(?:[a-z-]*colou?r|background(?:-[a-z]+)?|border(?:-[a-z]+)*|outline|box-shadow|text-shadow|fill|stroke|filter)\s*:/i;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
const ENC_HEX = /%23(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
const FN = /\b(?:rgba?|hsla?)\(\s*-?\d/gi;
const WHOLE = /^\s*(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})|(?:rgba?|hsla?)\(\s*-?\d[^)]*\))\s*$/i;

function walk(dir, ext, out = []) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out); else if (ext.test(e.name)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(APP, f).split(path.sep).join('/');
// the UNIVERSE above, as app-relative paths
export function universe() {
  return [
    ...walk(path.join(APP, 'src'), /\.(css|js|jsx|mjs)$/),
    ...walk(path.join(APP, 'api'), /\.(js|mjs)$/),
    path.join(APP, 'index.html'),
    ...walk(path.join(APP, 'public'), /\.(json|webmanifest|svg|js|html)$/),
    ...walk(path.join(APP, 'scripts'), /^gen-.*\.mjs$/),
    path.join(APP, 'scripts', 'test-email.mjs'),
    path.join(APP, 'scripts', 'seed-backend.mjs'),
  ].filter((f) => fs.existsSync(f)).map(rel);
}

// design:allow (design-lint's syntax) → the lines it covers
function allows(lines) {
  const map = new Map();
  const bad = [];
  lines.forEach((ln, i) => {
    if (!/design:allow/.test(ln)) return;
    const raw = ln.match(/design:allow\s+([a-z0-9,\- ]+?)(?:\s+[—-]{1,2}\s+(.*))?(?:\*\/|\}|-->|$)/i);
    const ids = raw ? raw[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const reason = raw ? (raw[2] || '').replace(/\*\/.*$/, '').trim() : '';
    if (!ids.includes('no-raw-hex')) return;
    if (!reason) { bad.push({ line: i + 1, why: 'design:allow no-raw-hex needs a reason' }); return; }
    [i + 1, i + 2].forEach((l) => map.set(l, reason));
  });
  return { map, bad };
}

// a named colour standing alone in a value (not part of an identifier such as .badge.green or --x-red)
function namedIn(value, valueAt, out) {
  for (const w of value.matchAll(/[a-zA-Z]+/g)) {
    const prev = value[w.index - 1] || ' ';
    if (NAMED.has(w[0].toLowerCase()) && !/[\w.#$-]/.test(prev) && !/^[\w-]/.test(value.slice(w.index + w[0].length))) out.push({ at: valueAt + w.index, lit: w[0] });
  }
}

// literals in a CSS/SVG/HTML-like text: every value position. `js` = the text is one JS string, where
// prose is possible: there a named colour counts only under a colour-carrying property, and an all-digit
// hex only when the string is shaped like CSS.
function cssLike(text, js = false) {
  const out = [];
  const masks = []; // [start, end) of every mask declaration's value
  for (const m of text.matchAll(DECL)) {
    const valueAt = m.index + m[0].length - m[2].length;
    if (MASK_PROPS.test(m[1])) masks.push([valueAt, valueAt + m[2].length]);
    if (KEYWORD_PROPS.test(m[1]) || (js && !COLORISH.test(m[1]))) continue;
    namedIn(m[2], valueAt, out);
  }
  for (const m of text.matchAll(SVG_ATTR)) if (NAMED.has(m[2].toLowerCase())) out.push({ at: m.index, lit: m[2] });
  const cssy = !js || CSSY.test(text);
  for (const m of text.matchAll(HEX)) {
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    if (/[\w&]/.test(before)) continue; // an id or entity, not a value
    if (/^#\d{4}$|^#\d{8}$/.test(m[0])) continue; // '#1042' is a number (a cheque, a unit), not a colour
    if (/^#\d+$/.test(m[0]) && !cssy) continue; // 'Order #123456' is prose; '1px solid #555' is CSS
    out.push({ at: m.index, lit: m[0] });
  }
  for (const m of text.matchAll(ENC_HEX)) out.push({ at: m.index, lit: m[0].replace('%23', '#') + ' (in a data URI)' });
  for (const m of text.matchAll(FN)) if (!/var\(/.test(text.slice(m.index, m.index + 40).split(')')[0])) out.push({ at: m.index, lit: m[0].replace(/\s+/g, '') + '…)' });
  for (const f of out) f.mask = masks.some(([a, b]) => f.at >= a && f.at < b);
  return out;
}

// strip CSS comments keeping offsets (so line numbers stay right)
const blank = (s) => s.replace(/[^\n]/g, ' ');
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (c) => (/design:allow/.test(c) ? c : blank(c)));

// one file's literals, classified. `r` is the app-relative path (it decides the file type and the rules
// that apply: theme layer, brand outputs, content, excluded); `raw` is its text.
export function scanText(r, raw) {
  const lines = raw.split(/\r?\n/);
  const { map, bad } = allows(lines);
  const found = [];
  const lineAt = (idx) => raw.slice(0, idx).split('\n').length;
  const push = (idx, lit, kind, mask = false) => found.push({ file: r, line: lineAt(idx), at: idx, lit, kind, mask });
  // The theme layer holds the palette, not every colour: a literal there is a palette entry (the whole
  // value of a custom property, which a client theme overrides) or a value brand:js writes into the
  // client theme's GENERATED block. A colour baked into a recipe (a shadow, a gradient, a data-URI icon)
  // is out of reach of a client theme's overrides, so it survives a re-skin: a leak.
  let themeOk = () => true;
  if (isTheme(r)) {
    const stripped = stripCssComments(raw);
    const whole = [];
    for (const m of stripped.matchAll(/--[\w-]+\s*:\s*([^;{}]+);/g)) {
      const v = m[1].trim();
      const at = m.index + m[0].indexOf(m[1]);
      if (WHOLE.test(v) || NAMED.has(v.toLowerCase())) whole.push([at, at + m[1].length]);
    }
    const g = /\/\* ── GENERATED by `npm --prefix app run brand:js`[\s\S]*?── end GENERATED ── \*\//.exec(raw);
    themeOk = (idx) => (g && idx >= g.index && idx < g.index + g[0].length) || whole.some(([a, b]) => idx >= a && idx < b);
  }
  if (/\.(css|svg|html|webmanifest|json)$/.test(r)) {
    const text = /\.css$/.test(r) ? stripCssComments(raw) : raw.replace(/<!--[\s\S]*?-->/g, (c) => (/design:allow/.test(c) ? c : blank(c)));
    if (/\.(json|webmanifest)$/.test(r)) {
      for (const m of text.matchAll(/"([^"\\]*)"/g)) if (WHOLE.test(m[1])) push(m.index, m[1], 'json');
    } else for (const f of cssLike(text)) push(f.at, f.lit, 'css', f.mask);
  } else {
    // JS / JSX: string literals and template literals
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => (/design:allow/.test(c) ? c : blank(c))).replace(/(^|[^:\\])\/\/[^\n]*/g, (c, p) => (/design:allow/.test(c) ? c : p + blank(c.slice(p.length))));
    const strRe = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
    // every string literal: a string that IS a colour, or a colour inside one (a CSS value such as
    // '1px solid #e5e7eb', an inline style, an SVG, a data URI)
    for (const m of text.matchAll(strRe)) {
      const body = m[0].slice(1, -1);
      const base = m.index + 1;
      if (WHOLE.test(body) && !/^\s*#(?:\d{4}|\d{8})\s*$/.test(body)) { push(base, body.trim(), 'js'); continue; }
      for (const f of cssLike(body, true)) push(base + f.at, f.lit, 'js-css', f.mask);
    }
    // a named colour under a colour-carrying key of a JS object (borderTop: '1px solid silver'); for the
    // bare `color` key only where the object is a style, since tag data such as { color: 'green' } names
    // a Badge variant, not a CSS colour
    for (const m of text.matchAll(JS_KEYED)) {
      if (!COLORISH.test(m[1])) continue;
      const lineText = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
      if (m[1] === 'color' && !/style/i.test(lineText)) continue;
      const valueAt = m.index + m[0].length - 1 - m[3].length;
      const found0 = [];
      namedIn(m[3], valueAt, found0);
      for (const f of found0) push(f.at, f.lit, 'js-named');
    }
    for (const m of text.matchAll(JSX_PAINT)) if (NAMED.has(m[2].toLowerCase())) push(m.index, m[2], 'jsx');
  }
  // de-duplicate (a literal seen by two passes) and mark allowed / theme / excluded
  const seen = new Set();
  const rows = [];
  for (const f of found.sort((a, b) => a.line - b.line)) {
    const key = `${f.line}|${f.lit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = EXCLUDE.has(r) ? 'excluded'
      : isTheme(r) ? (themeOk(f.at) ? 'theme' : 'leak')
      : brandOwned(r, lines[f.line - 1] || '') ? 'theme' : CONTENT.has(r) ? 'content' : f.mask ? 'mask' : map.has(f.line) ? 'allowed' : 'leak';
    const lit = status === 'leak' && isTheme(r) ? `${f.lit} (baked in a theme recipe)` : f.lit;
    rows.push({ ...f, lit, status, reason: status === 'allowed' ? map.get(f.line) : status === 'excluded' ? EXCLUDE.get(r) : status === 'content' ? CONTENT.get(r) : status === 'mask' ? MASK_REASON : undefined });
  }
  return { rows, bad: bad.map((b) => ({ file: r, ...b })) };
}

// Every colour VALUE in a rendered document or email (HTML with inline CSS), as full normalised strings,
// for comparing against the brand palette. Raster data URIs carry no CSS colour and are skipped; a
// number after "#" in the text ("Invoice #123") is not a colour unless it follows a ":".
export function colorsIn(html) {
  const text = html.replace(/data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+/g, '');
  const out = [];
  for (const m of text.matchAll(HEX)) {
    const before = text[m.index - 1] || ' ';
    if (/[\w&]/.test(before)) continue;
    if (/^#\d+$/.test(m[0]) && !/:\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index))) continue;
    out.push(m[0].toLowerCase());
  }
  for (const m of text.matchAll(ENC_HEX)) out.push(m[0].replace('%23', '#').toLowerCase());
  for (const m of text.matchAll(/\b(?:rgba?|hsla?)\(\s*-?\d[^)]*\)/gi)) out.push(m[0].replace(/\s+/g, '').toLowerCase());
  for (const m of text.matchAll(DECL)) {
    if (KEYWORD_PROPS.test(m[1])) continue;
    const found = [];
    namedIn(m[2], 0, found);
    out.push(...found.map((f) => f.lit.toLowerCase()));
  }
  for (const m of text.matchAll(SVG_ATTR)) if (NAMED.has(m[2].toLowerCase())) out.push(m[2].toLowerCase());
  return out;
}

// the whole ledger: every literal in the universe, classified
export function buildLedger() {
  const files = universe();
  const ledger = [];
  const badAllows = [];
  for (const f of files) {
    const { rows, bad } = scanText(f, fs.readFileSync(path.join(APP, f), 'utf8'));
    ledger.push(...rows);
    badAllows.push(...bad);
  }
  const by = (s) => ledger.filter((r) => r.status === s).length;
  const leaks = ledger.filter((r) => r.status === 'leak');
  const summary = { files: files.length, literals: ledger.length, theme: by('theme'), allowed: by('allowed'), mask: by('mask'), content: by('content'), excluded: by('excluded'), leaks: leaks.length, badAllows: badAllows.length };
  return { files, ledger, leaks, badAllows, summary };
}

const invoked = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (invoked) {
  const { ledger, leaks, badAllows, summary } = buildLedger();
  if (JSON_OUT) {
    console.log(JSON.stringify({ summary, ledger, badAllows }, null, 1));
  } else {
    const perFile = {};
    for (const l of leaks) perFile[l.file] = (perFile[l.file] || 0) + 1;
    console.log(`color-ledger — ${summary.files} files · ${summary.literals} colour literals: ${summary.theme} in the theme layer, ${summary.allowed} allowed with a reason, ${summary.mask} in masks (alpha only), ${summary.content} content (demo photos), ${summary.excluded} in excluded files, ${summary.leaks} leak(s)`);
    if (leaks.length) {
      console.log('\nleaks by file:\n  ' + Object.entries(perFile).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${String(n).padStart(4)}  ${f}`).join('\n  '));
      console.log('\nfirst leaks:\n  ' + leaks.slice(0, 40).map((l) => `${l.file}:${l.line}  ${l.lit}`).join('\n  '));
    }
    if (badAllows.length) console.log('\nmalformed allows:\n  ' + badAllows.map((b) => `${b.file}:${b.line} — ${b.why}`).join('\n  '));
  }
  process.exitCode = leaks.length || badAllows.length ? 1 : 0;
}
