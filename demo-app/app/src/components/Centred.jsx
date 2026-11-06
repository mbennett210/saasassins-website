import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

// TEXT CENTRED BY CODE IN WHAT HOLDS IT (the styling vault's "Icons sit in the middle of what holds
// them" and "A button's words sit in its middle", as Forge's styling check measures them). A flex
// holder centres the text's LINE, which isn't where the text shows: Poppins' line isn't centred on
// its capitals, each letter's sides differ, and a line rounds the font's ascent and descent. Measured
// in Forge on 2026-11-02: the customer hub's initials 0.3 to 0.65px low, a kit button's words 0.5px
// high, the pop-up's × 1.46px low. So the offset is worked out in the page, the way the measure reads
// it, and set on the text as `translate`:
//   · kind "ink": a count, initials or a symbol alone in a badge, an avatar or a round button. The
//     font's own glyph box (canvas measureText) from the run's start and its baseline (a zero-size
//     mark on its line, there for the moment), against the holder's middle inside its borders.
//   · kind "run": a button's words. The run's box as the font sets it, against the same middle.
// The holder is this span's parent, and the text is its only child (a string). Every Centred drawn
// in one commit is worked out together before the page paints (one layout for a list of them), and
// again when the fonts finish loading and when the window's size changes; `watch` names anything
// else that moves the text (the holder's look).
//
// OPT-IN, where a screen was asked to be centred: the customer hub's faces (HUB-19), and the
// add-member pop-up's × and its buttons (Daniel's pick, 2026-11-02: "Only this pop-up").
// New screens since opt in from the start: Import team's pop-up (task 466), and a new customer's
// onboarding bar's buttons with its skip and cleaners pop-ups (task 471, UI_RULES §190),
// Settings → Team's avatars (`<Avatar centred>`, UI_RULES §191), and a building's Special services
// card with its add, remove and Mark done pop-ups (task 507, UI_RULES §192).
// The kit's buttons and pop-ups elsewhere are as they were.
let inkCtx = null;
const queue = new Map(); // span → kind
let flushQueued = false;
const MARK_CSS = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0';

function holderMiddle(holder) {
  const box = holder.getBoundingClientRect();
  const cs = getComputedStyle(holder);
  const [bl, br, bt, bb] = [cs.borderLeftWidth, cs.borderRightWidth, cs.borderTopWidth, cs.borderBottomWidth].map(parseFloat);
  return { x: box.left + bl + (box.width - bl - br) / 2, y: box.top + bt + (box.height - bt - bb) / 2 };
}

function inkMiddle(span, text, mark) {
  const cs = getComputedStyle(span);
  inkCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if ('letterSpacing' in inkCtx) inkCtx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  const m = inkCtx.measureText(cs.textTransform === 'uppercase' ? text.textContent.toUpperCase() : text.textContent);
  const range = document.createRange();
  range.selectNodeContents(text);
  const run = range.getBoundingClientRect();
  const base = mark.getBoundingClientRect().bottom;
  // A run drawn scaled has its ink scaled with it: its drawn advance against the font's.
  const k = m.width > 0 && run.width > 0 && Math.abs(run.width / m.width - 1) >= 0.01 ? run.width / m.width : 1;
  return {
    x: run.left + (k * (m.actualBoundingBoxRight - m.actualBoundingBoxLeft)) / 2,
    y: base - (k * (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent)) / 2,
  };
}

function runMiddle(text) {
  const range = document.createRange();
  range.selectNodeContents(text);
  const run = range.getBoundingClientRect();
  return { x: run.left + run.width / 2, y: run.top + run.height / 2 };
}

function flush() {
  flushQueued = false;
  const items = [...queue].filter(([span]) => span.isConnected && span.parentElement);
  queue.clear();
  if (!items.length) return;
  if (!inkCtx) inkCtx = document.createElement('canvas').getContext('2d');
  // Writes (each unnudged, a baseline mark on each ink's line), then every read, then the writes back.
  const marks = items.map(([span, kind]) => {
    span.style.translate = '';
    if (kind !== 'ink' || !inkCtx) return null;
    const mark = document.createElement('span');
    mark.style.cssText = MARK_CSS;
    span.appendChild(mark);
    return mark;
  });
  const nudges = items.map(([span, kind], i) => {
    const text = span.firstChild;
    if (!text || text.nodeType !== 3 || !text.textContent.trim()) return '';
    const at = kind === 'ink' ? (marks[i] ? inkMiddle(span, text, marks[i]) : null) : runMiddle(text);
    if (!at) return '';
    const mid = holderMiddle(span.parentElement);
    const dx = mid.x - at.x;
    const dy = mid.y - at.y;
    return Number.isFinite(dx) && Number.isFinite(dy) ? `${dx.toFixed(2)}px ${dy.toFixed(2)}px` : '';
  });
  items.forEach(([span], i) => {
    marks[i]?.remove();
    span.style.translate = nudges[i];
  });
}

function centre(span, kind) {
  if (!span) return;
  queue.set(span, kind);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

// One signal for every Centred: the fonts finished loading, or the window's size changed (once a frame).
let epoch = 0;
let frame = 0;
const listeners = new Set();
function bump() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    epoch += 1;
    for (const fn of listeners) fn();
  });
}
let watching = false;
function subscribe(fn) {
  if (!watching) {
    watching = true;
    window.addEventListener('resize', bump);
    document.fonts?.addEventListener?.('loadingdone', bump);
    document.fonts?.ready?.then(bump);
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export default function Centred({ kind = 'run', className = '', watch = null, children }) {
  const ref = useRef(null);
  const seen = useSyncExternalStore(subscribe, () => epoch, () => 0);
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : '';
  useLayoutEffect(() => { centre(ref.current, kind); }, [text, kind, watch, seen]);
  return <span ref={ref} className={className || undefined}>{children}</span>;
}
