// The phone scroll lock belongs to the office shell, and only to it (UI_RULES §106).
//
// WHY. On a phone the office shell must not scroll as a document: in the iOS standalone PWA a
// scrolling document floats the fixed nav mid-screen and lets the page slide behind an open
// menu. So index.css pins html, body and #root to the measured screen height with overflow
// hidden, and `.main` scrolls inside them (AppLayout measures `--cs-vh`). Until 2026-10-03 that
// lock was written for EVERY page: html, body and #root, unscoped, at 640px and below. A page
// outside the shell has no `.main`, so nothing on it scrolled: on a phone the public quote, the
// inspection report, the QR scan page and the customer hub were cut off at the bottom of the
// screen with no way to reach their last line. The horizontal-scroll sweep could not see it,
// because a clipped page still FITS.
//
// The fix: AppLayout sets `html.<APP_SHELL_CLASS>` (src/lib/appShell.js) while it is mounted,
// and the lock is written under that class alone. Every page outside the shell is an ordinary
// document, with nothing to opt into or out of.
//
//   §1  the CSS: no rule in app/src locks scrolling on html, body, :root or #root (overflow-y
//       hidden or clip, or position fixed) unless it is scoped to html.<APP_SHELL_CLASS>; and
//       the shell's own lock is still there under it (html and body hidden, #root at the
//       measured --cs-vh, `.main` the scroller), so the office shell behaves as before
//   §2  the detector on fixtures: it catches the old unscoped lock in every spelling, and passes
//       the scoped one, the horizontal `overflow-x: clip` guard and a pseudo-element
//   §3  AppLayout sets the class in a layout effect (before the first paint) and removes it on
//       unmount, and nothing else in the app sets it
//   §4  no page outside the shell keeps a scroller of its own for this (the scan page had one)
//   §5  the browser half: lint:responsive drives it at 390×844 (each page outside the shell
//       reaches its last element by scrolling the DOCUMENT; an office route keeps a locked
//       document with `.main` scrolling); CI can't run a browser, so this holds that it exists
//
// REGRESSION (THE LAW II.3): on ab55e180 the lock is unscoped, src/lib/appShell.js does not
// exist, AppLayout sets no class and the sweep has no phone pass, so §1, §3 and §5 fail there.
//
//   node app/scripts/test-phone-scroll-lock.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(APP, 'src');
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// The source of truth for the class name. Missing on the pre-change tree: every check that
// needs it then fails rather than falling back to a restated literal.
let APP_SHELL_CLASS = null;
try {
  ({ APP_SHELL_CLASS } = await import(pathToFileURL(path.join(SRC, 'lib', 'appShell.js')).href));
} catch { /* reported below */ }

// ── the detector ──────────────────────────────────────────────────────────────────────────────

/**
 * Every style rule in a stylesheet: its selector, its declarations, the at-rules it sits in, its line.
 * Not scripts/css-rules.mjs `styleRules`: its walker carries a statement at-rule (`@import …;`) into the
 * next rule's prelude, reads that prelude as an @-block and drops the rule, so the first rule after
 * index.css's four imports is invisible to it, and the top of index.css is where html/body rules live.
 */
function cssRules(source) {
  // Comments become spaces of the same shape, so a commented-out rule is not a rule and the line
  // numbers still match the file.
  const text = source.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  const rules = [];
  const at = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(start, i);
      const trimmed = prelude.trim();
      if (trimmed.startsWith('@')) { at.push(trimmed); start = i + 1; continue; }
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; j += 1; }
      const lead = prelude.length - prelude.trimStart().length;
      rules.push({ selector: trimmed, body: text.slice(i + 1, j - 1), at: [...at], line: lineAt(start + lead) });
      i = j - 1;
      start = j;
    } else if (ch === '}') {
      at.pop();
      start = i + 1;
    } else if (ch === ';') {
      start = i + 1; // a statement at-rule (@import, @charset) ends here
    }
  }
  return rules;
}

/** A selector list split at its top-level commas (never inside :is(…) or [attr="a,b"]). */
const splitSelectors = (list) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const compounds = (sel) => sel.trim().split(/\s*[\s>+~]\s*/).filter(Boolean);

/** True when a selector's subject is the document's own scroll box: html, :root, body or #root (never a pseudo-element). */
function targetsDocument(sel) {
  const subject = compounds(sel).pop() || '';
  if (/::|:(before|after)\b/.test(subject)) return false;
  return /^(html|body|:root)(?![\w-])/.test(subject) || /#root(?![\w-])/.test(subject);
}

/** True when a selector is scoped to the office shell: its first compound is html (or :root) carrying the class. */
function scopedToShell(sel, cls) {
  if (!cls) return false;
  const first = compounds(sel)[0] || '';
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^(html|:root)(?![\w-])/.test(first) && new RegExp(`\\.${escaped}(?![\\w-])`).test(first);
}

/** The declarations in a rule body that stop the box scrolling vertically. */
function scrollLocks(body) {
  const out = [];
  for (const decl of body.split(';')) {
    const m = decl.match(/^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/i);
    if (!m) continue;
    const prop = m[1].toLowerCase();
    const value = m[2].replace(/!important/i, '').trim().toLowerCase();
    if (prop === 'overflow') {
      const parts = value.split(/\s+/);
      if (/^(hidden|clip)$/.test(parts[1] || parts[0])) out.push(`overflow: ${value}`);
    } else if (prop === 'overflow-y' || prop === 'overflow-block') {
      if (/^(hidden|clip)$/.test(value)) out.push(`${prop}: ${value}`);
    } else if (prop === 'position' && value === 'fixed') {
      out.push('position: fixed');
    }
  }
  return out;
}

/** Every selector in a stylesheet that locks the document's scrolling without the office shell's scope. */
function unscopedLocks(source, cls) {
  const out = [];
  for (const r of cssRules(source)) {
    const locks = scrollLocks(r.body);
    if (!locks.length) continue;
    for (const sel of splitSelectors(r.selector)) {
      if (targetsDocument(sel) && !scopedToShell(sel, cls)) out.push({ line: r.line, selector: sel, locks, at: r.at });
    }
  }
  return out;
}

// ── §1 the app's stylesheets ──────────────────────────────────────────────────────────────────
const cssFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.css$/.test(e.name)) cssFiles.push(p);
  }
};
walk(SRC);
ok('the app has stylesheets to read', cssFiles.length > 0);
ok('src/lib/appShell.js names the office shell\'s class (APP_SHELL_CLASS)', typeof APP_SHELL_CLASS === 'string' && /^[a-z][a-z0-9-]*$/.test(APP_SHELL_CLASS),
  `got ${JSON.stringify(APP_SHELL_CLASS)}`);

const found = [];
for (const f of cssFiles) {
  const rel = path.relative(APP, f).split(path.sep).join('/');
  for (const u of unscopedLocks(fs.readFileSync(f, 'utf8'), APP_SHELL_CLASS)) found.push(`${rel}:${u.line} ${u.selector} { ${u.locks.join('; ')} }`);
}
ok('no stylesheet locks html, body, :root or #root outside the office shell', found.length === 0,
  `${found.length} unscoped: ${found.join(' · ')} (scope it to html.${APP_SHELL_CLASS || '<APP_SHELL_CLASS>'}, which AppLayout sets)`);

const indexRules = cssRules(read('src/index.css'));
const phone = (r) => r.at.some((a) => /@media[^{]*max-width:\s*640px/.test(a));
const shellRule = (subject) => indexRules.filter((r) => phone(r) && splitSelectors(r.selector)
  .some((s) => scopedToShell(s, APP_SHELL_CLASS) && (compounds(s).pop() || '').startsWith(subject)));
const has = (rules, re) => rules.some((r) => re.test(r.body));
const htmlRules = shellRule('html');
const bodyRules = shellRule('body');
const rootRules = shellRule('#root');
ok('…the shell still locks html on a phone (height 100%, overflow hidden)', has(htmlRules, /overflow:\s*hidden/) && has(htmlRules, /height:\s*100%/));
ok('…and body', has(bodyRules, /overflow:\s*hidden/) && has(bodyRules, /height:\s*100%/));
ok('…and #root at the measured screen height (--cs-vh, min-height 0, overflow hidden)',
  has(rootRules, /height:\s*var\(--cs-vh/) && has(rootRules, /min-height:\s*0/) && has(rootRules, /overflow:\s*hidden/));
ok('…and `.main` is still the box that scrolls inside it',
  indexRules.some((r) => phone(r) && splitSelectors(r.selector).includes('.main') && /overflow-y:\s*auto/.test(r.body) && /height:\s*100%/.test(r.body)));

// ── §2 the detector, on fixtures ──────────────────────────────────────────────────────────────
const FX = 'fixture-shell';
const OLD = `@media (max-width: 640px) {
  .sidebar { overflow: hidden; }
  /* html, body { overflow: hidden; }  (a comment is not a rule) */
  html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
  #root { height: var(--cs-vh, 100dvh); min-height: 0; overflow: hidden; }
}`;
const oldHits = unscopedLocks(OLD, FX);
ok('the detector flags the pre-fix lock: html, body and #root', oldHits.map((h) => h.selector).join('|') === 'html|body|#root', JSON.stringify(oldHits.map((h) => h.selector)));
ok('…at the lines they are on, inside their media query', oldHits.map((h) => h.line).join(',') === '4,4,5' && oldHits.every((h) => /max-width: 640px/.test(h.at.join(' '))),
  JSON.stringify(oldHits.map((h) => [h.line, h.at])));
const NEW = `@media (max-width: 640px) {
  html.${FX}, html.${FX} body { height: 100%; overflow: hidden; }
  html.${FX} #root { height: var(--cs-vh, 100dvh); overflow: hidden; }
  :root.${FX} body { overflow-y: clip; }
}`;
ok('…and passes the same lock scoped to the shell', unscopedLocks(NEW, FX).length === 0, JSON.stringify(unscopedLocks(NEW, FX)));
const spellings = {
  'body { overflow-y: clip; }': true,
  ':root { overflow: auto hidden; }': true,
  'body { position: fixed; }': true,
  'div#root { overflow: hidden !important; }': true,
  'html.some-other-class body { overflow: hidden; }': true,
  '.page body { overflow: hidden; }': true,
  [`html.${FX}-x body { overflow: hidden; }`]: true,
  'html, body { overflow-x: clip; }': false,
  'html { overflow: hidden auto; }': false,
  'body::before { position: fixed; inset: 0; }': false,
  '.public-report { overflow: hidden; }': false,
  'body:has(.x) .cs-fnav { position: fixed; }': false,
  '#rooted { overflow: hidden; }': false,
};
for (const [css, flagged] of Object.entries(spellings)) {
  ok(`…${flagged ? 'flags' : 'passes'} \`${css}\``, (unscopedLocks(css, FX).length > 0) === flagged);
}
ok('…and with no class to scope to, even a scoped-looking rule is unscoped', unscopedLocks(NEW, null).length === 4);

// ── §3 who sets the class ─────────────────────────────────────────────────────────────────────
const layout = stripJsComments(read('src/layouts/AppLayout.jsx'));
ok('AppLayout reads the class from src/lib/appShell', /import\s*\{[^}]*\bAPP_SHELL_CLASS\b[^}]*\}\s*from\s*'\.\.\/lib\/appShell(\.js)?'/.test(layout));
const effect = layout.match(/useLayoutEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\[\s*\]\s*\);/);
ok('…sets it on <html> in a layout effect, so the first paint is already locked',
  !!effect && /document\.documentElement[\s\S]*?classList\.add\(\s*APP_SHELL_CLASS\s*\)/.test(effect[1]));
ok('…and removes it when the shell unmounts, so the page after it scrolls',
  !!effect && /return\s*\(\)\s*=>[\s\S]*?classList\.remove\(\s*APP_SHELL_CLASS\s*\)/.test(effect[1]));
ok('…with useLayoutEffect imported from react', /import\s*\{[^}]*\buseLayoutEffect\b[^}]*\}\s*from\s*'react'/.test(layout));

const setters = [];
const walkJs = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p);
    else if (/\.(jsx?|mjs)$/.test(e.name)) {
      const rel = path.relative(SRC, p).split(path.sep).join('/');
      const s = stripJsComments(fs.readFileSync(p, 'utf8'));
      if (rel === 'lib/appShell.js' || rel === 'layouts/AppLayout.jsx') continue;
      if (/\bAPP_SHELL_CLASS\b/.test(s) || (APP_SHELL_CLASS && s.includes(APP_SHELL_CLASS))) setters.push(rel);
    }
  }
};
walkJs(SRC);
ok('nothing but AppLayout puts a page into the shell\'s lock', setters.length === 0, setters.join(', '));

// ── §4 no page keeps its own scroller for this ────────────────────────────────────────────────
const scanShell = indexRules.filter((r) => splitSelectors(r.selector).includes('.scan-shell'));
ok('the scan page is in the stylesheet', scanShell.length > 0);
ok('…and scrolls as a document: no inner scroller, no pinned height of its own',
  scanShell.every((r) => !/overflow(-y)?:\s*(auto|scroll)/.test(r.body) && !/(^|[^-])height:\s*100%/.test(r.body)),
  scanShell.filter((r) => /overflow(-y)?:\s*(auto|scroll)|(^|[^-])height:\s*100%/.test(r.body)).map((r) => `index.css:${r.line}`).join(', '));

// ── §5 the browser half exists ────────────────────────────────────────────────────────────────
const sweep = stripJsComments(read('scripts/responsive-sweep.mjs'));
ok('lint:responsive drives a phone at 390×844', /\{\s*w:\s*390,\s*h:\s*844\s*\}/.test(sweep));
ok('…runs the scroll probe on every page outside the shell', /function\s+phoneScrollProbe\b/.test(sweep) && /for\s*\(const\s+\w+\s+of\s+\[\s*\.\.\.SHELL_LESS/.test(sweep));
ok('…and on an office route, where the document must stay locked', /PHONE_SHELL_PROBES/.test(sweep) && /docLocked/.test(sweep) && /mainScrolls/.test(sweep));

if (fails.length) { console.error('\nphone-scroll-lock FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nphone-scroll-lock: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
