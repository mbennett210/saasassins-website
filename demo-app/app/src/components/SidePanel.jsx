import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeLayer } from '../hooks/useEscapeLayer';

// SidePanel: the one panel that slides in from the right over a page and back out (UI_RULES §105).
// The work order panel (components/WorkOrderDrawer) and the Payroll line panel
// (pages/payroll/PayrollLineDrawer) both draw through it; their own class adds only a width and
// their content's look.
//
// `item` is what the panel shows (a ticket, a pay row), null when it is closed. While it slides
// out, the panel keeps drawing the last item through `children(item)`, so it never empties on its
// way out. Pressed again mid-way it turns round from where it is: the slide is a CSS transition
// between two classes, and a transition reverses from its current place. Ways out: its own ×, a
// tap on the dim and Esc, when it is the newest layer (UI_RULES §181). The dim takes no drags, so
// the page behind it stays put.
//
// It draws at the page's top level, through a portal to <body> like Modal and MobileSheet, so no
// page's stacking can put anything over it (the pages hold `.main` at z-index 1, under the phone's
// floating menu bar: Matt's work order panel, 2026-11-02). And on a phone the menu bar slides away
// while it is open (`.side-panel-layer` is on the pop-up list in index.css, held by
// test-popup-layers.mjs).
const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// A phone or tablet: a text field there brings up the on-screen keyboard.
const touchScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
const isTextField = (el) => !!el && (el.matches?.('textarea, select, [contenteditable="true"]')
  || (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i.test(el.type)));
// iOS holds the page's drawing for 140 to 170ms as its keyboard starts down: a slide started inside
// that hold runs unseen, and its first drawn frame has the panel half gone.
const KEYBOARD_HOLD_MS = 150;

// How long the slide out runs, read from the stylesheet, plus a frame: the backstop that takes the
// panel off the page if the browser never reports the slide's end (a hidden tab runs no slide).
function slideOutMs(el) {
  const style = getComputedStyle(el);
  const longest = (list) => Math.max(0, ...list.split(',').map((s) => parseFloat(s) || 0));
  return (longest(style.transitionDuration) + longest(style.transitionDelay)) * 1000 + 50;
}

export default function SidePanel({ item, onClose, className = '', label, children }) {
  const open = item != null;
  // The last thing it showed, which it keeps drawing while it slides out.
  const [last, setLast] = useState(item);
  if (open && item !== last) setLast(item);
  // On the page: from the moment it opens until its slide out has ended.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  // At its open place (the class the slide runs to).
  const [shown, setShown] = useState(false);
  const panelRef = useRef(null);
  // When a text field in the panel last let the cursor go (the keyboard starts down then).
  const letGoAt = useRef(-Infinity);

  useEscapeLayer(open, onClose);

  // In: drawn first at its closed place, then moved to its open one before the frame is painted,
  // so the slide has a start (the read below fixes it; without it the panel would appear in place
  // at once). Out, or back in mid-way: the class flips and the slide turns round where it is.
  // Closed while typing on a phone, it goes after the keyboard: the field lets the cursor go now
  // (often the press that closed it already has), and the panel holds still until iOS's hold in
  // drawing is over, then slides where it can be seen.
  useLayoutEffect(() => {
    if (!mounted) return undefined;
    if (open) {
      panelRef.current?.getBoundingClientRect();
      setShown(true);
      return undefined;
    }
    let wait = 0;
    if (touchScreen() && !prefersReducedMotion()) {
      const field = document.activeElement;
      if (panelRef.current?.contains(field) && isTextField(field)) {
        field.blur();
        letGoAt.current = performance.now();
      }
      wait = Math.max(0, KEYBOARD_HOLD_MS - (performance.now() - letGoAt.current));
    }
    if (!wait) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(false), wait);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  // Off the page once the slide out has ended (at once under reduced motion: no slide runs).
  useEffect(() => {
    if (open || shown || !mounted) return undefined;
    const panel = panelRef.current;
    if (!panel || prefersReducedMotion()) {
      setMounted(false);
      return undefined;
    }
    const done = () => setMounted(false);
    const onEnd = (e) => { if (e.target === panel && e.propertyName === 'transform') done(); };
    panel.addEventListener('transitionend', onEnd);
    const backstop = setTimeout(done, slideOutMs(panel));
    return () => {
      panel.removeEventListener('transitionend', onEnd);
      clearTimeout(backstop);
    };
  }, [open, shown, mounted]);

  if (!mounted) return null;
  const shownItem = open ? item : last;
  return createPortal(
    <div className={`side-panel-layer${shown ? ' is-shown' : ''}`}>
      <div className="side-panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className={`side-panel${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-label={typeof label === 'function' ? label(shownItem) : label}
        onBlur={(e) => { if (isTextField(e.target)) letGoAt.current = performance.now(); }}
      >
        {children(shownItem)}
      </aside>
    </div>,
    document.body,
  );
}
