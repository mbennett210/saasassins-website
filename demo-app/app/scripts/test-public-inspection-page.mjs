// The shared inspection report page (/inspect/:token, src/pages/PublicInspection.jsx) tells the
// visitor WHY it shows no report. It said "Report not found" for every failure — a 404, but also
// the route's 503 (CS-648: "This report could not be loaded just now") and a phone with no signal
// — so a customer with a good link was told it was invalid, with no way to try again. Now a 404
// (or a link with no token, 400) is "not found", and a 503, any other answer or no answer at all
// is a try-again sentence with a Try again button. Its words are catalog lines rendered in English
// (the page is the customer's: LANG-8), with no hard-coded English left in it.
//
// The REAL page, bundled once (rolldown, as test-product-name.mjs bundles its views) with a small
// hooks runtime standing in for React, so its effect, its state and its Try again button run here;
// the report read, the router and the report template are stubbed.
//   N1 404 → not found · N2 503 → try again · N3 no answer (offline) → try again · N4 Try again
//   reads again and shows the report · N5 the demo stub's "no such report" (null) → not found ·
//   N6 the words are the catalog's, and the page shows no hard-coded English
//
// REGRESSION (THE LAW II.3): on the tree before the fix N2, N3, N4 and N6 fail (N1 and N5 too,
// for the catalog's words).
//
//   node app/scripts/test-public-inspection-page.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(APP, 'src', 'pages', 'PublicInspection.jsx');
const core = await import('../src/i18n/core.js');
const { scanFile } = await import('./test-i18n-coverage.mjs');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

// The page's words, from the catalog (a key that does not exist reads as missing, never as '').
const W = (key) => (typeof core.SOURCE_CATALOG[key] === 'string' && core.SOURCE_CATALOG[key] ? core.english(key) : `<missing ${key}>`);
const NOT_FOUND = W('publicReport.notFound.title');
const UNAVAILABLE = W('publicReport.unavailable.title');
const UNAVAILABLE_BODY = W('publicReport.unavailable.body');
const TRY_AGAIN = W('publicReport.tryAgain');

// ── a small hooks runtime (one component, rendered top-down) ──
const R = { slots: [], cursor: 0, effects: [], dirty: false, token: 'tok_shared', reads: [], next: [] };
globalThis.__R = R;
const SHIMS = {
  '\0react': `const R = globalThis.__R;
const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
export function useState(init) {
  const i = R.cursor++;
  if (!(i in R.slots)) R.slots[i] = { v: typeof init === 'function' ? init() : init };
  const slot = R.slots[i];
  const set = (v) => { const nv = typeof v === 'function' ? v(slot.v) : v; if (!Object.is(nv, slot.v)) { slot.v = nv; R.dirty = true; } };
  return [slot.v, set];
}
export function useCallback(fn, deps) {
  const i = R.cursor++;
  const s = R.slots[i];
  if (s && !changed(s.deps, deps)) return s.fn;
  R.slots[i] = { fn, deps };
  return fn;
}
export function useMemo(fn, deps) {
  const i = R.cursor++;
  const s = R.slots[i];
  if (s && !changed(s.deps, deps)) return s.v;
  const v = fn();
  R.slots[i] = { v, deps };
  return v;
}
export function useEffect(fn, deps) {
  const i = R.cursor++;
  const s = R.slots[i];
  if (s && !changed(s.deps, deps)) return;
  const prev = s && s.cleanup;
  R.slots[i] = { deps, cleanup: null };
  R.effects.push(() => { if (typeof prev === 'function') prev(); R.slots[i].cleanup = fn(); });
}
export const Fragment = Symbol.for('react.fragment');
export default { useState, useCallback, useMemo, useEffect, Fragment };`,
  '\0jsx': `export function jsx(type, props, key) { return { type, props: props || {}, key }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol.for('react.fragment');`,
  '\0router': 'export function useParams() { return { token: globalThis.__R.token }; }',
  '\0qc': `export function getPublicInspection(token) { globalThis.__R.reads.push(token); const n = globalThis.__R.next.shift(); return n ? n() : Promise.resolve(null); }
export async function downloadPublicInspectionPdf() {}`,
  '\0report': 'export function buildInspectionReportHtml(d) { return "<p>REPORT:" + (d && d.title) + "</p>"; }',
};
const plugin = {
  name: 'public-inspection-page-test',
  resolveId(id) {
    if (id === 'react') return '\0react';
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return '\0jsx';
    if (id === 'react-router-dom') return '\0router';
    if (/(^|[\\/])qcApi(\.js)?$/.test(id)) return '\0qc';
    if (/(^|[\\/])inspectionReportTemplate(\.js)?$/.test(id)) return '\0report';
    return null;
  },
  load(id) { return Object.hasOwn(SHIMS, id) ? SHIMS[id] : null; },
};

const CACHE = path.join(APP, 'node_modules', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(CACHE, 'test-public-inspection-page-'));
let Page = null;
try {
  const bundle = await rolldown({
    input: PAGE, platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: true }) } },
  });
  await bundle.write({ file: path.join(tmp, 'page.mjs'), format: 'esm' });
  Page = (await import(pathToFileURL(path.join(tmp, 'page.mjs')).href)).default;
} catch (e) {
  fails.push(`the page bundles and loads (${String(e?.message || e).split('\n')[0]})`);
}

// Render until the page settles (effects run, the read lands, state stops changing).
async function settle() {
  let tree = null;
  for (let n = 0; n < 20; n += 1) {
    R.cursor = 0;
    R.dirty = false;
    tree = Page();
    const effects = R.effects.splice(0);
    for (const run of effects) run();
    await new Promise((r) => setTimeout(r, 5));
    if (!R.dirty) break;
  }
  return tree;
}
async function mount(...answers) {
  Object.assign(R, { slots: [], cursor: 0, effects: [], dirty: false, reads: [], next: answers });
  return settle();
}
// What the tree shows: its text (and the report's HTML), and its buttons.
function view(tree) {
  const text = [];
  const buttons = [];
  const walk = (node) => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type === 'function') { walk(node.type(node.props)); return; }
    if (node.props?.dangerouslySetInnerHTML) text.push(node.props.dangerouslySetInnerHTML.__html);
    const before = text.length;
    walk(node.props?.children);
    if (node.type === 'button') buttons.push({ label: text.slice(before).join(''), onClick: node.props.onClick, disabled: !!node.props.disabled });
  };
  walk(tree);
  return { text: text.join(' '), buttons };
}
const httpError = (status) => () => Promise.reject(Object.assign(new Error(`Request failed (${status})`), { status }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const report = () => Promise.resolve({ title: 'Clubhouse inspection' });

if (Page) {
  const n1 = view(await mount(httpError(404)));
  ok('N1 a 404: the link names no report — "not found", and no Try again', () => n1.text.includes(NOT_FOUND) && !n1.text.includes(UNAVAILABLE) && !n1.buttons.some((b) => b.label === TRY_AGAIN), n1.text);

  const n2 = view(await mount(httpError(503)));
  ok('🔴 N2 a 503 (the report could not be loaded just now): a try-again sentence, never "not found"',
    () => n2.text.includes(UNAVAILABLE) && n2.text.includes(UNAVAILABLE_BODY) && !n2.text.includes(NOT_FOUND), n2.text);
  ok('🔴 N2b …with a Try again button', () => n2.buttons.some((b) => b.label === TRY_AGAIN && typeof b.onClick === 'function'), JSON.stringify(n2.buttons.map((b) => b.label)));

  const n3 = view(await mount(offline));
  ok('🔴 N3 no answer at all (no signal): the same try-again sentence', () => n3.text.includes(UNAVAILABLE) && !n3.text.includes(NOT_FOUND), n3.text);

  // N4: the first read fails (503), Try again reads again and the report shows.
  const first = view(await mount(httpError(503), report));
  const retry = first.buttons.find((b) => b.label === TRY_AGAIN);
  let after = { text: '', buttons: [] };
  if (retry) { retry.onClick(); after = view(await settle()); }
  ok('🔴 N4 Try again reads the report again, and shows it when it comes back', () => !!retry && R.reads.length === 2 && after.text.includes('REPORT:Clubhouse inspection') && !after.text.includes(UNAVAILABLE),
    `${R.reads.length} reads; ${after.text.slice(0, 120)}`);
  ok('N4b …with its Download PDF button', () => after.buttons.some((b) => b.label === W('publicReport.download')), JSON.stringify(after.buttons.map((b) => b.label)));

  const n5 = view(await mount(() => Promise.resolve(null)));
  ok('N5 the demo\'s "no such report" (an empty answer): not found', () => n5.text.includes(NOT_FOUND), n5.text);
}

// N6: the words are catalog lines, in English, and none are hard-coded.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  let hits = ['(scanner failed)'];
  try { hits = await scanFile('src/pages/PublicInspection.jsx'); } catch (e) { hits = [`scan threw: ${e?.message}`]; }
  ok('🔴 N6a the page reads its words from the catalog in English (LANG-8: the customer\'s page)', () => /import \{[^}]*\benglish\b[^}]*\} from '\.\.\/i18n\/core'/.test(src)
    && ['publicReport.notFound.title', 'publicReport.notFound.body', 'publicReport.unavailable.title', 'publicReport.unavailable.body', 'publicReport.tryAgain', 'publicReport.download']
      .every((k) => typeof core.SOURCE_CATALOG[k] === 'string' && src.includes(`'${k}'`)));
  ok(`🔴 N6b …and shows no hard-coded English (${hits.length}: ${hits.slice(0, 3).join(' | ')})`, () => hits.length === 0);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\ntest-public-inspection-page: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
