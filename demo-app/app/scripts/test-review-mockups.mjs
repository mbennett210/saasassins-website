// A design question in Review shows its mockup, and what Matt picks from it is saved and seen
// (UI_RULES §179, Daniel 2026-10-23: "whatever he chooses can be SELECTED and saved ... show 5 views
// in total ... we MUST be able to see what selection he chose"). This holds the three parts to each
// other, so a mockup can't be published that can't be answered, or answered with no way to see it:
//
//   the registry   src/review-mockups/index.js: id → file, views, the as-it-is-now view
//   the templates  src/review-mockups/*.html: no colour and no name of their own (the app fills in its
//                  theme, names and the view it opens on), each placeholder once, talking to Review only
//                  by postMessage, and every view as tall as the tallest
//   the questions  data/buildDecisions.js: a question with `mockup` has an answer for every view, a
//                  "keep it as it is" answer on the as-it-is-now view, and a needs-a-note "another way"
//
// The colour and name checks run the real ledgers' scanners over each template, and are shown to bite
// on a template with a colour or the product's name written into it. Offline.
//   node app/scripts/test-review-mockups.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_MOCKUPS } from '../src/review-mockups/index.js';
import { DECISIONS } from '../src/data/buildDecisions.js';
import { scanText as scanColours, universe } from './color-ledger.mjs';
import { scanText as scanNames } from './name-ledger.mjs';
import { activeBrandId, loadBrand } from './brand.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const APP = fileURLToPath(new URL('..', import.meta.url));
const DIR = path.join(APP, 'src', 'review-mockups');
const rel = (f) => path.relative(APP, f).split(path.sep).join('/');
const active = loadBrand(activeBrandId());
if (active.error) { console.error(active.error); process.exit(1); }
const BRAND = active.brand;

// ── the registry ↔ the files ────────────────────────────────────────────────────────────────
const entries = Object.entries(REVIEW_MOCKUPS);
const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.html'));
ok(entries.length > 0, 'the registry lists at least one mockup');
ok(onDisk.every((f) => entries.some(([, m]) => m.file === f)),
  `every template in src/review-mockups is in the registry (not: ${onDisk.filter((f) => !entries.some(([, m]) => m.file === f)).join(', ') || 'none'})`);
for (const [id, m] of entries) {
  ok(onDisk.includes(m.file), `${id}: its file ${m.file} is in src/review-mockups`);
  ok(Array.isArray(m.views) && m.views.length >= 2 && new Set(m.views).size === m.views.length, `${id}: two or more views, each once`);
  ok(m.views.includes(m.today), `${id}: its as-it-is-now view (${m.today}) is one of its views`);
  ok(typeof m.load === 'function', `${id}: it loads its template on demand (its own chunk)`);
}

// ── each template ──────────────────────────────────────────────────────────────────────────
// Its views, as its VIEWS list declares them (the tabs and sections are drawn from it).
const viewsOf = (html) => {
  const block = /const VIEWS = \[([\s\S]*?)\n\];/.exec(html);
  return block ? [...block[1].matchAll(/^\s*\{ id: '([\w-]+)'/gm)].map((x) => x[1]) : [];
};
const count = (s, needle) => s.split(needle).length - 1;
const coloursLeaking = (r, html) => scanColours(r, html).rows.filter((x) => x.status === 'leak').map((x) => x.lit);
const namesLeaking = (r, html) => scanNames(r, html, BRAND).rows.filter((x) => x.cls === 'leak').map((x) => x.text);

const inUniverse = universe();
for (const [id, m] of entries) {
  const file = path.join(DIR, m.file);
  if (!fs.existsSync(file)) continue;
  const r = rel(file);
  const html = fs.readFileSync(file, 'utf8');
  ok(JSON.stringify(viewsOf(html)) === JSON.stringify(m.views), `${id}: the template's views are the registry's, in order (template: ${viewsOf(html).join(', ') || 'none found'})`);
  ok(count(html, '/*THEME*/') === 1 && count(html, '/*WHO*/null') === 1 && count(html, '/*VIEW*/null') === 1,
    `${id}: each placeholder (/*THEME*/, /*WHO*/null, /*VIEW*/null) appears exactly once (a second, in a comment, takes the fill)`);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  ok(!!style && style[1].includes('/*THEME*/'), `${id}: /*THEME*/ is inside its <style>, where the app's theme goes`);
  ok(inUniverse.includes(r), `${id}: the colour and name ledgers scan it (${r} is in their universe)`);
  const cl = coloursLeaking(r, html);
  ok(cl.length === 0, `${id}: no colour of its own (found: ${cl.join(', ') || 'none'})`);
  const nl = namesLeaking(r, html);
  ok(nl.length === 0, `${id}: no name of its own (found: ${nl.join(', ') || 'none'})`);
  // Review and the mockup listen only to each other, and the mockup reports its content's height (the
  // page's scroll height is at least the frame's, so a frame drawn too tall never came back down).
  ok(/source: 'cs-mockup'/.test(html) && /e\.source === parent/.test(html) && /'cs-review'/.test(html),
    `${id}: it posts as cs-mockup and listens only to its parent's cs-review messages`);
  ok(/type: 'height', h: Math\.ceil\(document\.body\.getBoundingClientRect\(\)\.height\)/.test(html),
    `${id}: it reports its body's height, never the page's scroll height`);
  ok(/\.variant \{ grid-area: 1 \/ 1; visibility: hidden;/.test(html) && /\.variant\.cur \{ visibility: visible; \}/.test(html),
    `${id}: its views share one grid cell, so switching views never moves the answers under it`);

  // the checks bite: a colour or the product's name written into the template is caught
  const withColour = html.replace('</style>', '.x { color: #c0ffee; }\n</style>');
  ok(coloursLeaking(r, withColour).includes('#c0ffee'), `${id}: (guard) a colour written into its CSS is caught`);
  const withName = html.replace('<main id="grid"></main>', `<main id="grid"><p>${BRAND.product?.name || 'Clean Space'}</p></main>`);
  ok(namesLeaking(r, withName).length > 0, `${id}: (guard) the product's name written into it is caught`);
}

// ── the questions ───────────────────────────────────────────────────────────────────────────
const design = DECISIONS.filter((q) => q.mockup);
ok(design.length > 0, 'at least one question draws a mockup');
for (const q of design) {
  const m = REVIEW_MOCKUPS[q.mockup];
  ok(!!m, `${q.id}: its mockup "${q.mockup}" is in the registry`);
  if (!m) continue;
  const ids = (q.options || []).map((o) => o.id);
  ok(q.type === 'single', `${q.id}: one answer (single), so one pick is saved and shown`);
  ok(m.views.every((v) => ids.includes(v)), `${q.id}: an answer for every view (${m.views.filter((v) => !ids.includes(v)).join(', ') || 'all there'})`);
  ok(ids.includes(m.today), `${q.id}: a "keep it as it is" answer, on the as-it-is-now view (${m.today})`);
  const another = (q.options || []).filter((o) => !m.views.includes(o.id));
  ok(another.length === 1 && another[0].needsNote === true,
    `${q.id}: exactly one answer with no view of its own, the "another way", and it asks for a note (got ${another.map((o) => o.id).join(', ') || 'none'})`);
}

// ── the card draws it, and Review listens only to the mockup's own window ───────────────────
const card = fs.readFileSync(path.join(APP, 'src/pages/review/DecisionCard.jsx'), 'utf8');
const frame = fs.readFileSync(path.join(APP, 'src/pages/review/MockupFrame.jsx'), 'utf8');
ok(/<MockupFrame\b/.test(card) && /q\.mockup/.test(card), 'DecisionCard draws a question\'s mockup');
ok(/review-mockup-pick-chosen/.test(card) && /Chosen: \(\{chosen\?\.id\}\) \{chosen\?\.label\}/.test(card),
  'DecisionCard says over the mockup which answer was chosen');
ok(/e\.source !== f\.contentWindow/.test(frame), 'MockupFrame takes messages only from its own iframe');
ok(!/\bsandbox=/.test(frame) || /allow-same-origin/.test(frame), 'MockupFrame keeps the app\'s origin (its fonts and logo load)');

console.log(`review mockups: ${pass}/${pass + fail} passed  (${entries.length} mockup${entries.length === 1 ? '' : 's'}, ${design.length} question${design.length === 1 ? '' : 's'})`);
process.exit(fail ? 1 : 0);
