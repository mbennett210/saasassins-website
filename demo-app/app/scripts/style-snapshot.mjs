#!/usr/bin/env node
// style-snapshot — prove a CSS refactor changes NOTHING on screen.
//
// A token migration (literal → var(--token)) is supposed to be a visual no-op. "Looks the same"
// is not proof: a 1px padding drift or a lost hover colour is invisible in a glance. This drives
// the REAL app and records, for every element on every route at each width, its box (x, y, w, h)
// and the computed values of the properties that make up a look. Take one snapshot before the
// change and one after; `--diff` must report zero differences.
//
//   npm --prefix app run dev -- --mode demo --port 5393          (seeded, login-free)
//   node app/scripts/style-snapshot.mjs --url http://localhost:5393 --out before.json.gz
//   … make the change …
//   node app/scripts/style-snapshot.mjs --url http://localhost:5393 --out after.json.gz
//   node app/scripts/style-snapshot.mjs --diff before.json.gz after.json.gz
//
// Deterministic by construction: a fresh browser profile per run (the demo seed re-bootstraps),
// the clock frozen at one instant and Math.random seeded, so runtime-relative seed dates, "5m ago"
// labels and random ids render identically in both runs. Animations and transitions are disabled.
// CHROME_PATH overrides the browser (same env var as responsive-sweep.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { appRoutes, publicRoutes, DEMO_PATHS, missingRecord } from './app-routes.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };

// Every surface App.jsx routes to (scripts/app-routes.mjs, shared with lint:responsive and lint:reskin;
// detail routes carry seeded demo ids).
const ROUTES = appRoutes();
const SHELL_LESS = new Set(publicRoutes());
const PROPS = [
  'display', 'position', 'box-sizing', 'width', 'height', 'min-height', 'max-width',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'color', 'background-color', 'background-image', 'box-shadow', 'opacity', 'outline-width', 'outline-color', 'outline-offset',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align',
  'gap', 'row-gap', 'column-gap', 'align-items', 'justify-content', 'flex-grow', 'flex-shrink', 'flex-basis',
  'grid-template-columns', 'overflow-x', 'overflow-y', 'z-index', 'visibility', 'fill', 'stroke', 'stroke-width',
];

function read(file) {
  const buf = fs.readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}

if (process.argv.includes('--diff')) {
  const [a, b] = process.argv.slice(process.argv.indexOf('--diff') + 1).map(read);
  let diffs = 0;
  const shown = [];
  const renamed = [];
  // Every difference counts toward its page, so the scope of a change is visible even past the
  // first 60 lines shown (a change meant for one surface must not touch another).
  const perPage = new Map();
  const hit = (page) => { diffs++; perPage.set(page, (perPage.get(page) || 0) + 1); };
  // An element's key carries its classes, so a refactor that swaps a class (a bespoke colour class
  // for a kit variant) would read as "gone" + "new". Unmatched elements are therefore paired by
  // POSITION (the key with its classes stripped) and compared like any other; the class change
  // itself is listed separately, as information.
  const posKey = (k) => k.replace(/\.[^:>]+(?=:\d+(?:>|$))/g, '');
  const tail = (k) => k.split('>').pop();
  const compare = (page, label, ea, eb) => {
    if (ea[1] !== eb[1]) { hit(page); if (shown.length < 60) shown.push(`${page}  ${label}: box ${ea[1]} → ${eb[1]}`); }
    // Compare the style STRINGS: each snapshot numbers its own dictionary, so equal indices
    // across two files mean nothing.
    if (a.styles[ea[2]] !== b.styles[eb[2]]) {
      const sa = a.styles[ea[2]].split('␟');
      const sb = b.styles[eb[2]].split('␟');
      const props = a.props.filter((p, i) => sa[i] !== sb[i]).map((p) => `${p}: ${sa[a.props.indexOf(p)]} → ${sb[a.props.indexOf(p)]}`);
      if (props.length) { hit(page); if (shown.length < 60) shown.push(`${page}  ${label}: ${props.join('; ')}`); }
    }
  };
  for (const [page, before] of Object.entries(a.pages)) {
    const after = b.pages[page];
    if (!after) { hit(page); shown.push(`${page}: missing from the second snapshot`); continue; }
    const mapA = new Map(before.map((e) => [e[0], e]));
    const mapB = new Map(after.map((e) => [e[0], e]));
    const goneA = [];
    const newB = [];
    for (const [key, ea] of mapA) { const eb = mapB.get(key); if (eb) compare(page, key, ea, eb); else goneA.push(ea); }
    for (const [key, eb] of mapB) if (!mapA.has(key)) newB.push(eb);
    const byPos = new Map(); // position key → the unmatched new element (null when ambiguous)
    for (const eb of newB) { const p = posKey(eb[0]); byPos.set(p, byPos.has(p) ? null : eb); }
    const paired = new Set();
    for (const ea of goneA) {
      const eb = byPos.get(posKey(ea[0]));
      if (!eb) { hit(page); if (shown.length < 60) shown.push(`${page}  ${ea[0]}: element gone`); continue; }
      paired.add(eb);
      if (tail(ea[0]) !== tail(eb[0])) renamed.push(`${tail(ea[0])} → ${tail(eb[0])}`);
      compare(page, eb[0], ea, eb);
    }
    for (const eb of newB) if (!paired.has(eb)) { hit(page); if (shown.length < 60) shown.push(`${page}  ${eb[0]}: new element`); }
  }
  for (const page of Object.keys(b.pages)) if (!a.pages[page]) { hit(page); shown.push(`${page}: only in the second snapshot`); }
  const els = Object.values(a.pages).reduce((n, p) => n + p.length, 0);
  console.log(`style-snapshot diff: ${Object.keys(a.pages).length} route×width pages, ${els} elements compared on ${PROPS.length} properties + box.`);
  if (renamed.length) console.log(`${renamed.length} element(s) changed class and kept their place (compared by position):\n  ${[...new Set(renamed)].join('\n  ')}`);
  if (diffs) {
    console.log(shown.join('\n'));
    console.log(`\ndifferences by page (${perPage.size} of ${Object.keys(a.pages).length}):\n  ${[...perPage].map(([p, c]) => `${p} ×${c}`).join('\n  ')}`);
    console.error(`\n✖ ${diffs} difference(s).`);
    process.exit(1);
  }
  console.log('✓ identical: no element moved, resized or changed a computed style.');
  process.exit(0);
}

const BASE = arg('--url', 'http://localhost:5393').replace(/\/$/, '');
const OUT = arg('--out', 'style-snapshot.json.gz');
const WIDTHS = arg('--widths', '1280,375').split(',').map(Number);
// --routes takes paths with or without the leading slash (Git Bash rewrites a leading "/" into a
// Windows path, so "invoices,settings/company" is the portable spelling).
const ONLY = arg('--routes', '') ? arg('--routes').split(',').map((r) => (r.startsWith('/') ? r : '/' + r)) : ROUTES;
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const res = await fetch(BASE).catch(() => null);
if (!res || !res.ok) { console.error(`✖ No dev server at ${BASE}. Start one: npm --prefix app run dev -- --mode demo --port 5393`); process.exit(2); }
const puppeteer = (await import('puppeteer-core')).default;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'style-snapshot-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-sandbox', '--font-render-hinting=none'] });
const styles = [];
const styleIndex = new Map();
const pages = {};
const vacuous = [];
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const T = new Date('2026-09-24T12:00:00').getTime();
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(T); }
      static now() { return T; }
    }
    window.Date = FrozenDate;
    let s = 42;
    Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  for (const w of WIDTHS) {
    await page.setViewport({ width: w, height: w < 640 ? 812 : 900 });
    for (const route of ONLY) {
      await page.goto(BASE + route, { waitUntil: 'networkidle2', timeout: 30000 });
      if (!SHELL_LESS.has(route)) await page.waitForFunction(() => document.querySelector('.main')?.childElementCount > 0, { timeout: 5000 }).catch(() => {});
      if (DEMO_PATHS.has(route) && await page.evaluate(missingRecord)) vacuous.push(`${route} @${w}`);
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 250));
      const rows = await page.evaluate((PROPS) => {
        const out = [];
        const keyOf = (el) => {
          const parts = [];
          for (let n = el; n && n !== document.body; n = n.parentElement) {
            const i = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
            const cls = typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).join('.') : '';
            parts.push(`${n.tagName.toLowerCase()}${cls}:${i}`);
          }
          return parts.reverse().join('>');
        };
        for (const el of document.body.querySelectorAll('*')) {
          if (['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName)) continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          out.push([keyOf(el), [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(','), PROPS.map((p) => cs.getPropertyValue(p)).join('\u241f')]);
        }
        return out;
      }, PROPS);
      pages[`${route} @${w}`] = rows.map(([k, box, style]) => {
        if (!styleIndex.has(style)) { styleIndex.set(style, styles.length); styles.push(style); }
        return [k, box, styleIndex.get(style)];
      });
      process.stdout.write('.');
    }
  }
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
const body = JSON.stringify({ base: BASE, widths: WIDTHS, props: PROPS, styles, pages });
fs.writeFileSync(OUT, OUT.endsWith('.gz') ? zlib.gzipSync(body) : body);
const els = Object.values(pages).reduce((n, p) => n + p.length, 0);
console.log(`\nstyle-snapshot: ${Object.keys(pages).length} pages, ${els} elements, ${styles.length} distinct computed styles → ${OUT}`);
if (vacuous.length) {
  console.error(`✖ ${vacuous.length} demo page(s) could not find their record (fix the id in scripts/app-routes.mjs PARAMS): ${vacuous.join(', ')}`);
  process.exitCode = 1;
}
