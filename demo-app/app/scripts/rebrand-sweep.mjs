#!/usr/bin/env node
// rebrand-sweep — the rendered proof of the name guarantee and the brand's colours (UI_RULES §121, §129).
//
// The name ledger proves no source file writes the brand's identity. This proves the RESULT: it renders every
// surface App.jsx routes to (scripts/app-routes.mjs, the list lint:responsive, lint:reskin and style-snapshot
// share) at a phone and a desktop width, and reads what a person sees or a screen reader announces: the visible
// text, the document title, and every alt, aria-label, title and placeholder. It also reads every painted
// colour (the re-skin sweep's collector: text, fills, borders, outlines, shadows, gradients, SVG paint,
// pseudo-elements, placeholders).
//
//   npm --prefix app run lint:rebrand -- --url http://localhost:5481 [--forbid <id>[,<id>…]] [--no-colours]
//       fails on any page that shows a forbidden brand's identity (brand.mjs identityStrings), or paints one of
//       its palette's colours that the active brand's palette does not share. Default --forbid: every brand under
//       brands/ except the active one. Run it on a build re-branded to another brand (REBRAND.md, "Prove it"):
//       nothing of the old client may remain.
//   node scripts/rebrand-sweep.mjs --url … --snapshot out.json.gz     every page's text, for a no-op diff
//   node scripts/rebrand-sweep.mjs --diff a.json.gz b.json.gz         exit 1 on any difference
//
// Deterministic like style-snapshot: a fresh profile per run, the clock frozen and Math.random seeded.
// CHROME_PATH overrides the browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { appRoutes, publicRoutes, DEMO_PATHS, missingRecord } from './app-routes.mjs';
import { activeBrandId, loadBrand, brandIds, identityStrings } from './brand.mjs';
import { classify, needles } from './name-ledger.mjs';
import { derivePalette } from './brand-colors.mjs';
import { collect, colorsInValue } from './reskin-sweep.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const read = (f) => { const b = fs.readFileSync(f); return JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8')); };

/**
 * A page's findings for the forbidden brands: [{ brand, where, text, excerpt }]. The ledger's classifier reads
 * the page's text, title and attributes, so a kept identifier on screen (a header name such as
 * X-CleanSpace-Signature in the integration settings) is not a finding; any other match is.
 */
export function findForbidden(page, forbidden) {
  const out = [];
  const hay = [['text', page.text], ['document title', page.title], ...page.attrs];
  for (const b of forbidden) {
    const list = needles(b);
    for (const [where, v] of hay) {
      if (!v) continue;
      for (const row of classify('(rendered)', v, list, { kind: 'text' }).rows) {
        if (row.cls !== 'leak') continue;
        const i = v.indexOf(row.text);
        out.push({ brand: b.id, where, text: row.text, excerpt: v.slice(Math.max(0, i - 30), i + row.text.length + 30) });
      }
    }
  }
  return out;
}

/**
 * The colours a forbidden brand would paint and the active brand does not: channel key "r,g,b" → the palette
 * steps it is ("cleanspace neutral-200"). White and black belong to every brand.
 */
export function forbiddenColours(forbidden, active) {
  const key = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
  const own = new Set(Object.values(derivePalette(active.colors).values).map(key));
  const out = new Map();
  for (const b of forbidden) {
    for (const [step, hex] of Object.entries(derivePalette(b.colors).values)) {
      const k = key(hex);
      if (own.has(k) || k === '255,255,255' || k === '0,0,0') continue;
      out.set(k, out.has(k) ? `${out.get(k)}, ${step}` : `${b.id} ${step}`);
    }
  }
  return out;
}

/** A page's painted colours from the forbidden palettes: [{ where, prop, colour, step, doc }]. */
export function paintedForbidden(painted, colours) {
  const out = [];
  for (const p of painted) {
    for (const c of colorsInValue(p.value)) {
      const k = c.rgb.join(',');
      if (colours.has(k)) out.push({ where: p.where, prop: p.prop, colour: `rgb(${k})`, step: colours.get(k), doc: p.doc });
    }
  }
  return out;
}

if (process.argv.includes('--diff')) {
  const [a, b] = process.argv.slice(process.argv.indexOf('--diff') + 1).map(read);
  const diffs = [];
  for (const [page, pa] of Object.entries(a.pages)) {
    const pb = b.pages[page];
    if (!pb) { diffs.push(`${page}: missing from the second snapshot`); continue; }
    if (pa.title !== pb.title) diffs.push(`${page}  title: ${JSON.stringify(pa.title)} → ${JSON.stringify(pb.title)}`);
    if (pa.text !== pb.text) {
      let i = 0; while (pa.text[i] === pb.text[i]) i++;
      diffs.push(`${page}  text at ${i}: …${JSON.stringify(pa.text.slice(Math.max(0, i - 40), i + 60))} → …${JSON.stringify(pb.text.slice(Math.max(0, i - 40), i + 60))}`);
    }
    if (JSON.stringify(pa.attrs) !== JSON.stringify(pb.attrs)) {
      const sa = new Set(pa.attrs.map((x) => x.join('=')));
      const sb = new Set(pb.attrs.map((x) => x.join('=')));
      const gone = [...sa].filter((x) => !sb.has(x)); const added = [...sb].filter((x) => !sa.has(x));
      diffs.push(`${page}  attributes: −${JSON.stringify(gone.slice(0, 4))} +${JSON.stringify(added.slice(0, 4))}`);
    }
  }
  for (const page of Object.keys(b.pages)) if (!a.pages[page]) diffs.push(`${page}: new in the second snapshot`);
  if (diffs.length) { console.log(diffs.join('\n')); console.error(`\n✖ ${diffs.length} difference(s) in ${Object.keys(a.pages).length} pages.`); process.exit(1); }
  console.log(`✓ identical: the same text, titles and attributes on all ${Object.keys(a.pages).length} pages.`);
  process.exit(0);
}

const BASE = arg('--url', 'http://localhost:5213').replace(/\/$/, '');
const SNAPSHOT = arg('--snapshot', null);
const WIDTHS = arg('--widths', '1280,375').split(',').map(Number);
const ONLY = arg('--routes', '') ? arg('--routes').split(',').map((r) => (r.startsWith('/') ? r : '/' + r)) : appRoutes();
const SHELL_LESS = new Set(publicRoutes());
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const invoked = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (invoked) {
  const activeId = activeBrandId();
  const forbidIds = SNAPSHOT ? [] : (arg('--forbid', '') ? arg('--forbid').split(',') : brandIds().filter((d) => d !== activeId));
  const forbidden = [];
  for (const id of forbidIds) {
    const { brand, error } = loadBrand(id);
    if (error) { console.error(error); process.exit(1); }
    forbidden.push(brand);
  }
  if (!SNAPSHOT && !forbidden.length) { console.error('rebrand-sweep: nothing to forbid (name a brand with --forbid, or add a second brand under brands/)'); process.exit(1); }
  const res = await fetch(BASE).catch(() => null);
  if (!res || !res.ok) { console.error(`✖ No dev server at ${BASE}. Start one: npm --prefix app run dev -- --mode demo --port 5481`); process.exit(2); }
  const puppeteer = (await import('puppeteer-core')).default;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rebrand-sweep-'));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-sandbox'] });
  const pages = {};
  const painted = {};
  const vacuous = [];
  const checkColours = !SNAPSHOT && !process.argv.includes('--no-colours');
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      const T = new Date('2026-09-24T12:00:00').getTime();
      const RealDate = Date;
      class FrozenDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(T); } static now() { return T; } }
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
        await page.evaluate(() => document.fonts.ready);
        await new Promise((r) => setTimeout(r, 250));
        pages[`${route} @${w}`] = await page.evaluate(() => {
          const attrs = [];
          for (const el of document.querySelectorAll('[alt],[aria-label],[title],[placeholder]')) {
            for (const a of ['alt', 'aria-label', 'title', 'placeholder']) { const v = el.getAttribute(a); if (v) attrs.push([a, v]); }
          }
          return { title: document.title, text: (document.body.innerText || '').replace(/\s+/g, ' ').trim(), attrs };
        });
        if (checkColours) painted[`${route} @${w}`] = await page.evaluate(collect);
        process.stdout.write('.');
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.stdout.write('\n');
  if (vacuous.length) { console.error(`✖ ${vacuous.length} demo page(s) could not find their record: ${vacuous.join(', ')}`); process.exit(1); }
  if (SNAPSHOT) {
    const body = JSON.stringify({ base: BASE, widths: WIDTHS, pages });
    fs.writeFileSync(SNAPSHOT, SNAPSHOT.endsWith('.gz') ? zlib.gzipSync(body) : body);
    console.log(`rebrand-sweep: ${Object.keys(pages).length} pages → ${SNAPSHOT}`);
  } else {
    // the server must be serving THIS tree's brand: every page's title carries its app title (index.html's
    // <title>, which brand.mjs writes). A sweep of a build that was never re-branded would prove nothing.
    const { appTitle } = loadBrand(activeId).brand;
    const untitled = Object.entries(pages).filter(([, pg]) => !pg.title.includes(appTitle)).map(([p]) => p);
    if (untitled.length) { console.error(`✖ ${untitled.length} page(s) lack the active brand's title "${appTitle}" (${untitled.slice(0, 4).join(', ')}): is the server running this tree, after npm run brand?`); process.exit(1); }
    const findings = Object.entries(pages).flatMap(([p, pg]) => findForbidden(pg, forbidden).map((f) => ({ page: p, ...f })));
    const colours = checkColours ? forbiddenColours(forbidden, loadBrand(activeId).brand) : new Map();
    const colourFindings = Object.entries(painted).flatMap(([p, list]) => paintedForbidden(list, colours).map((f) => ({ page: p, ...f })));
    const paintedCount = Object.values(painted).reduce((n, l) => n + l.length, 0);
    console.log(`rebrand-sweep: ${ONLY.length} routes × ${WIDTHS.length} widths under brand "${activeId}" (every page titled "${appTitle}"), forbidding ${forbidden.map((b) => `"${b.id}" (${identityStrings(b).length} strings)`).join(', ')}`);
    if (findings.length) {
      console.log(findings.slice(0, 60).map((f) => `  ${f.page}  "${f.text}" (${f.brand}) in ${f.where}: …${f.excerpt.replace(/\s+/g, ' ')}…`).join('\n'));
      console.error(`\n✖ ${findings.length} place(s) still show another brand.`);
      process.exitCode = 1;
    } else console.log('✓ no page shows another brand\'s identity (its name, wordmark, contacts, address, owner or senders).');
    if (checkColours) {
      if (colourFindings.length) {
        const by = new Map();
        for (const f of colourFindings) { const k = `${f.colour} (${f.step})`; by.set(k, [...(by.get(k) || []), f]); }
        for (const [k, list] of by) console.log(`  ${k}: ${list.length} paint(s), e.g. ${list.slice(0, 3).map((f) => `${f.page} ${f.where} ${f.prop}${f.doc ? ' [document]' : ''}`).join('; ')}`);
        console.error(`\n✖ ${colourFindings.length} painted colour(s) come from another brand's palette.`);
        process.exitCode = 1;
      } else console.log(`✓ none of ${paintedCount} painted colours comes from another brand's palette (${colours.size} forbidden values).`);
    }
  }
}
