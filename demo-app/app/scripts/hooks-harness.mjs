// A small hooks runtime that drives ONE real page component in node, with no DOM and no React:
// the component file is bundled with rolldown (as test-public-inspection-page.mjs and
// test-product-name.mjs bundle theirs), `react` and `react/jsx-runtime` become this runtime, and
// every module a test names is replaced by its shim. State updates re-render; effects run after
// each render (their cleanups first); `settle()` renders until nothing changes.
//
// ⚠️ ONE hook list, for the page. The tree is a plain object tree, and `view()` calls a child
// component inline only to read what it draws, so a test replaces every child that has hooks of
// its own with a recorder (`recorder(name)`): a component that keeps its latest props in
// `R.seen[name]` and draws nothing (or its children). The page's own hooks — and the custom hooks
// it calls inline — are what runs for real.
//
// Not a test (the name does not start with `test-`), so run-tests never runs it on its own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The runtime every bundle reads (one per process: suites run one at a time).
export const R = globalThis.__HR || (globalThis.__HR = {
  slots: [], cursor: 0, effects: [], dirty: false, seen: {}, calls: [],
});

// A page's pollers (setInterval in an effect) must never keep the suite's process alive: every
// interval made here is unref'd, and `unmount()` runs the cleanups as React would.
if (!globalThis.__HR_TIMERS) {
  globalThis.__HR_TIMERS = true;
  const setI = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...a) => { const t = setI(fn, ms, ...a); t?.unref?.(); return t; };
}

const REACT = `const R = globalThis.__HR;
const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
export function useState(init) {
  const i = R.cursor++;
  if (!(i in R.slots)) R.slots[i] = { v: typeof init === 'function' ? init() : init };
  const slot = R.slots[i];
  const set = (v) => { const nv = typeof v === 'function' ? v(slot.v) : v; if (!Object.is(nv, slot.v)) { slot.v = nv; R.dirty = true; } };
  return [slot.v, set];
}
export function useReducer(fn, init, initFn) {
  const [s, set] = useState(() => (initFn ? initFn(init) : init));
  return [s, (a) => set((prev) => fn(prev, a))];
}
export function useRef(init) {
  const i = R.cursor++;
  if (!(i in R.slots)) R.slots[i] = { current: init };
  return R.slots[i];
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
function effect(fn, deps) {
  const i = R.cursor++;
  const s = R.slots[i];
  if (s && deps && !changed(s.deps, deps)) return;
  const prev = s && s.cleanup;
  R.slots[i] = { deps, cleanup: null };
  R.effects.push(() => { if (typeof prev === 'function') prev(); const c = fn(); R.slots[i].cleanup = typeof c === 'function' ? c : null; });
}
export const useEffect = effect;
export const useLayoutEffect = effect;
export function useId() { const r = useRef(null); if (!r.current) r.current = 'hid' + (R.cursor); return r.current; }
export function useContext(ctx) { return ctx && ctx._value; }
export function createContext(v) { return { _value: v, Provider: (p) => p.children }; }
export function memo(c) { return c; }
export function forwardRef(c) { return (p) => c(p, null); }
export function createElement(type, props, ...children) { return { type, props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }; }
export const Fragment = Symbol.for('react.fragment');
export default { useState, useReducer, useRef, useCallback, useMemo, useEffect, useLayoutEffect, useId, useContext, createContext, memo, forwardRef, createElement, Fragment };`;
const JSX = `export function jsx(type, props, key) { return { type, props: props || {}, key }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol.for('react.fragment');`;

// A child component that records the props it was last drawn with, under `R.seen[name]`, and
// draws only its children (so text a test asserts on can sit inside it).
export const recorder = (name, { draw = 'children' } = {}) => `export default function ${name.replace(/\W/g, '')}(p) {
  const R = globalThis.__HR; (R.seen[${JSON.stringify(name)}] ||= []).push(p);
  return ${draw === 'children' ? 'p.children ?? null' : 'null'};
}`;

// Bundle `entry` (a path under app/src) with `shims`: [{ test: RegExp, code }] matched against
// each import's specifier. → the module's exports.
export async function bundle(entry, shims = [], { tag = 'page', env = {} } = {}) {
  const table = [
    { test: /^react$/, code: REACT },
    { test: /^react\/jsx-(dev-)?runtime$/, code: JSX },
    ...shims,
  ];
  const plugin = {
    name: 'hooks-harness',
    resolveId(id) {
      const k = table.findIndex((s) => s.test.test(id));
      return k === -1 ? null : `\0shim:${k}`;
    },
    load(id) {
      const m = /^\0shim:(\d+)$/.exec(id);
      return m ? table[Number(m[1])].code : null;
    },
  };
  // Inside app/node_modules/.cache, so anything left unshimmed resolves to the app's own copies.
  const CACHE = path.join(APP, 'node_modules', '.cache');
  fs.mkdirSync(CACHE, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE, `hooks-harness-${tag}-`));
  try {
    const b = await rolldown({
      input: path.join(APP, entry), platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
      transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: true, ...env }) } },
    });
    const out = path.join(tmp, 'page.mjs');
    await b.write({ file: out, format: 'esm' });
    return await import(pathToFileURL(out).href);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Render `Page(props)` until it settles: effects run, awaited reads land, state stops changing.
export async function settle(Page, props = {}, { rounds = 30 } = {}) {
  let tree = null;
  for (let n = 0; n < rounds; n += 1) {
    R.cursor = 0;
    R.dirty = false;
    R.seen = {};
    tree = Page(props);
    const effects = R.effects.splice(0);
    for (const run of effects) run();
    await new Promise((r) => setTimeout(r, 2));
    if (!R.dirty && !R.effects.length) break;
  }
  return tree;
}
// Run every effect's cleanup, as an unmount would.
export function unmount() {
  for (const s of R.slots) if (s && typeof s.cleanup === 'function') { try { s.cleanup(); } catch { /* unmounting */ } }
  R.slots = [];
  R.effects = [];
}
// A fresh mount: the last page unmounted, every hook slot, recording and call log cleared first.
export async function mount(Page, props = {}) {
  unmount();
  Object.assign(R, { slots: [], cursor: 0, effects: [], dirty: false, seen: {}, calls: [] });
  return settle(Page, props);
}

// What the tree draws: its text, its buttons (label, onClick, disabled) and every element with
// its props, walking function components inline.
export function view(tree) {
  const text = [];
  const buttons = [];
  const nodes = [];
  const walk = (node) => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type === 'function') { walk(node.type(node.props || {})); return; }
    nodes.push(node);
    const before = text.length;
    walk(node.props?.children);
    if (node.type === 'button') buttons.push({ label: text.slice(before).join(''), onClick: node.props.onClick, disabled: !!node.props.disabled, props: node.props });
  };
  walk(tree);
  return { text: text.join(' '), buttons, nodes, byClass: (cls) => nodes.filter((n) => String(n.props?.className || '').split(/\s+/).includes(cls)) };
}
