#!/usr/bin/env node
// reskin-sweep — the rendered proof of the re-skin guarantee (UI_RULES §121).
//
// color-ledger.mjs reads source. This renders the app itself under a CANARY brand: every colour palette
// entry of the theme cascade (every custom property whose value is a colour literal) and every rgb channel
// token is replaced at runtime by a garish colour no theme uses, the client theme's GENERATED values are
// re-drawn in the canary, and every route App.jsx declares (scripts/app-routes.mjs) is rendered at a phone and a desktop width. Then
// every painted colour is read back: text, fills, borders, outlines, text decoration, shadows, gradients,
// data-URI icons, SVG paint, ::before / ::after and placeholders. A colour that is not a canary colour did
// not follow the swap: it is baked in somewhere a re-skin cannot reach (a literal, an inherited browser
// default, a colour composed from numbers). Exit 1 on any.
//
// The documents (.qdoc, .ir) take their colours from BRAND, which brand:js regenerates for a brand; a
// runtime swap can't reach a JS constant, so they are reported apart as "document" and are checked by
// test-color-ledger.mjs's rendered section instead.
//
//   npm --prefix app run dev -- --mode demo --port 5213
//   node app/scripts/reskin-sweep.mjs --url http://localhost:5213 [--route /invoices] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCascade } from './design-system-lib.mjs';
import { generatedDecls } from './brand-js.mjs';
import { appRoutes, publicRoutes, DEMO_PATHS, missingRecord } from './app-routes.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('--url', 'http://localhost:5213').replace(/\/$/, '');
const ONLY = arg('--route', null);
const JSON_OUT = arg('--json', null);
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const VIEWPORTS = [{ w: 375, h: 812, label: 'phone' }, { w: 1280, h: 900, label: 'desktop' }];

// ── colours ─────────────────────────────────────────────────────────────────────────────────────
const HEX = /^#([0-9a-f]{3,8})$/i;
export function toRgb(v) {
  const s = String(v).trim();
  const h = HEX.exec(s);
  if (h) {
    let x = h[1];
    if (x.length <= 4) x = x.split('').map((c) => c + c).join('');
    const a = x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1;
    return { rgb: [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)), a };
  }
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
  return null;
}
const key = (rgb) => rgb.join(',');
const CHANNELS = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/;
// every colour inside a value (a gradient, a shadow, a data-URI icon)
export function colorsInValue(v) {
  const out = [];
  for (const m of String(v).matchAll(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|%23[0-9a-f]{6}\b|%23[0-9a-f]{3}\b/gi)) {
    const c = toRgb(m[0].replace('%23', '#'));
    if (c) out.push(c);
  }
  return out;
}

// garish, distinct, and never one of the real theme's colours
function canaryPalette(n, avoid) {
  const out = [];
  const used = new Set(avoid);
  let i = 0;
  while (out.length < n) {
    const hue = (i * 137.508) % 360;
    const light = [45, 58, 38, 64, 52][i % 5];
    i += 1;
    const c = (1 - Math.abs(2 * light / 100 - 1)) * 0.95;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = light / 100 - c / 2;
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    const rgb = [r, g, b].map((v) => Math.round((v + m) * 255));
    if (used.has(key(rgb))) continue;
    used.add(key(rgb));
    out.push(rgb);
  }
  return out;
}

export function buildCanary() {
  const cascade = readCascade();
  const original = new Set();
  for (const t of cascade) {
    const ch = CHANNELS.exec(t.resolved);
    if (ch) original.add(key([+ch[1], +ch[2], +ch[3]]));
    for (const c of colorsInValue(t.resolved)) original.add(key(c.rgb));
  }
  // the palette entries: a colour literal as the whole declared value, or an rgb channel triplet
  const entries = cascade.filter((t) => toRgb(t.declared) || CHANNELS.test(t.declared));
  const colours = canaryPalette(entries.length, original);
  const decls = [];
  const canary = new Set();
  const byName = new Map(cascade.map((t) => [t.name, t.resolved]));
  entries.forEach((t, i) => {
    const rgb = colours[i];
    canary.add(key(rgb));
    if (CHANNELS.test(t.declared)) { decls.push(`--${t.name}: ${rgb.join(', ')}`); return; }
    const { a } = toRgb(t.declared);
    const hex = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    decls.push(`--${t.name}: ${a < 1 ? `rgba(${rgb.join(', ')}, ${a})` : hex}`);
    byName.set(t.name, hex);
  });
  // what brand:js would write into the canary's GENERATED block
  const { decls: gen, error } = generatedDecls(byName);
  if (error) throw new Error('reskin-sweep: ' + error);
  for (const [n, v] of gen) { decls.push(`--${n}: ${v}`); for (const c of colorsInValue(v)) canary.add(key(c.rgb)); }
  const css = `:root:root { ${decls.join('; ')}; }\n*, *::before, *::after { transition: none !important; animation: none !important; }`;
  return { css, canary, original, entries: entries.length, names: entries.map((t) => t.name) };
}

// ── in the page: every painted colour, with where it was painted ────────────────────────────────
export function collect() {
  const out = [];
  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : '') + (el.id ? `#${el.id}` : '');
  };
  const inDoc = (el) => !!el.closest('.qdoc, .ir');
  const push = (el, prop, value, pseudo = '') => out.push({ where: label(el) + pseudo, prop, value, doc: inDoc(el) });
  const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const SVG_SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'text', 'tspan']);
  const readBox = (el, cs, pseudo = '') => {
    const bg = cs.backgroundColor;
    if (bg && !/rgba\([^)]*,\s*0\)$/.test(bg) && bg !== 'transparent') push(el, 'background-color', bg, pseudo);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (parseFloat(cs[`border-${side}-width`]) > 0 && !/none|hidden/.test(cs[`border-${side}-style`])) push(el, `border-${side}-color`, cs[`border-${side}-color`], pseudo);
    }
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) push(el, 'outline-color', cs.outlineColor, pseudo);
    if (cs.boxShadow && cs.boxShadow !== 'none') push(el, 'box-shadow', cs.boxShadow, pseudo);
    if (cs.textShadow && cs.textShadow !== 'none') push(el, 'text-shadow', cs.textShadow, pseudo);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') push(el, 'background-image', cs.backgroundImage, pseudo);
  };
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('iframe, script, style, noscript, template')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'video' || tag === 'canvas') continue;
    if (el instanceof SVGElement) {
      if (SVG_SHAPES.has(tag)) {
        if (cs.fill && cs.fill !== 'none' && !cs.fill.startsWith('url(')) push(el, 'fill', cs.fill);
        if (cs.stroke && cs.stroke !== 'none' && !cs.stroke.startsWith('url(')) push(el, 'stroke', cs.stroke);
      }
      continue;
    }
    if (hasText(el) || /^(input|textarea|select|button)$/.test(tag)) push(el, 'color', cs.color);
    if (cs.textDecorationLine && cs.textDecorationLine !== 'none' && hasText(el)) push(el, 'text-decoration-color', cs.textDecorationColor);
    readBox(el, cs);
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (!ps.content || ps.content === 'none' || ps.display === 'none') continue;
      if (ps.content !== '""' && ps.content !== "''") push(el, 'color', ps.color, pseudo);
      readBox(el, ps, pseudo);
    }
    if (/^(input|textarea)$/.test(tag) && el.placeholder) push(el, 'color', getComputedStyle(el, '::placeholder').color, '::placeholder');
  }
  return out;
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const invoked = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (invoked) {
  const res = await fetch(BASE).catch(() => null);
  if (!res || !res.ok) {
    console.error(`\n✖ No dev server at ${BASE}.\n  Start one:  npm --prefix app run dev -- --mode demo --port 5213\n`);
    process.exit(2);
  }
  const { css, canary, original, entries } = buildCanary();
  const routes = ONLY ? [ONLY] : appRoutes();
  const shellLess = new Set(publicRoutes());
  const vacuous = [];
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const leaks = new Map(); // "rgb|hint" → { rgb, hint, count, samples:Set }
  const docs = new Map();
  let painted = 0;
  try {
    const page = await browser.newPage();
    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.w, height: vp.h });
      for (const route of routes) {
        await page.goto(BASE + route, { waitUntil: 'networkidle2', timeout: 30000 });
        if (!shellLess.has(route)) await page.waitForFunction(() => document.querySelector('.main')?.childElementCount > 0, { timeout: 5000 }).catch(() => {});
        if (DEMO_PATHS.has(route) && await page.evaluate(missingRecord)) vacuous.push(`${route} @${vp.label}`);
        await page.addStyleTag({ content: css });
        await new Promise((r) => setTimeout(r, 150));
        const found = await page.evaluate(collect);
        for (const f of found) {
          const cols = f.prop === 'color' || f.prop.endsWith('-color') || f.prop === 'fill' || f.prop === 'stroke'
            ? [toRgb(f.value)].filter(Boolean) : colorsInValue(f.value);
          for (const c of cols) {
            if (c.a === 0) continue;
            painted += 1;
            const k = key(c.rgb);
            if (canary.has(k)) continue;
            const bucket = f.doc ? docs : leaks;
            const hint = f.doc ? 'document (BRAND)' : original.has(k) ? "a real theme value that didn't follow the swap" : 'not a theme value (a literal, a browser default, or composed)';
            const id = `${k}|${hint}`;
            if (!bucket.has(id)) bucket.set(id, { rgb: c.rgb, hint, count: 0, samples: new Set() });
            const b = bucket.get(id);
            b.count += 1;
            if (b.samples.size < 6) b.samples.add(`${route} @${vp.label}: ${f.where} ${f.prop}`);
          }
        }
      }
    }
  } finally { await browser.close(); }
  const list = (m) => [...m.values()].sort((a, b) => b.count - a.count);
  const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  console.log(`reskin-sweep — ${routes.length} routes × ${VIEWPORTS.length} viewports under a canary brand (${entries} palette entries swapped) · ${painted} painted colours read`);
  if (docs.size) console.log(`  documents: ${list(docs).reduce((n, d) => n + d.count, 0)} colours in .qdoc/.ir, BRAND values (checked by test-color-ledger.mjs's rendered section)`);
  const L = list(leaks);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ routes, leaks: L.map((l) => ({ ...l, hex: hex(l.rgb), samples: [...l.samples] })), docs: list(docs).map((d) => ({ ...d, hex: hex(d.rgb), samples: [...d.samples] })) }, null, 1));
  if (vacuous.length) {
    console.log(`  ✗ ${vacuous.length} demo page(s) could not find their record, so they swept nothing (fix the id in scripts/app-routes.mjs PARAMS):`);
    for (const v of vacuous) console.log(`        ${v}`);
  }
  if (!L.length && !vacuous.length) { console.log('  ✓ every painted colour followed the swap'); process.exitCode = 0; }
  else if (!L.length) process.exitCode = 1;
  else {
    console.log(`  ✗ ${L.length} colour(s) did not follow the swap (${L.reduce((n, l) => n + l.count, 0)} paints):`);
    for (const l of L) {
      console.log(`    ${hex(l.rgb)}  ×${l.count}  ${l.hint}`);
      for (const s of l.samples) console.log(`        ${s}`);
    }
    process.exitCode = 1;
  }
}
