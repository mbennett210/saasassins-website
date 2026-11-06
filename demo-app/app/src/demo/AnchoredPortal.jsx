// AnchoredPortal: a dropdown that hangs off its trigger, drawn at the page's top level. The styling rules want every
// panel and pop-up portaled to <body> (a floating bar stacked over the page covers one drawn inside it), and Clean
// Space draws some of its desktop dropdowns inside the page, placed by their own CSS against the trigger's wrapper
// (.bell-panel and .filters-popover: `position: absolute; top: calc(100% + …)` under a `position: relative` wrapper).
// This draws a stand-in for that wrapper's box at the top level, fixed over the trigger (`anchorRef`) and following it
// as the page scrolls or resizes, with the panel inside it, so the panel's own CSS still puts it where it was.
//
// The stand-in takes no clicks; the panel does. `ref` is the stand-in, for the dismiss hook's second ref
// (useDismissTap's `ref2`, PopMenu's `spareRef`): the panel is no longer inside the trigger's wrapper, and a click in
// it must not count as a click outside. `open` false draws nothing and follows nothing.
//
// The sync (scripts/sync-polishpoint-demo.mjs) wraps Clean Space's in-page dropdowns in it, and .claude/styling.json
// names it one of the repo's pop-up parts.
import { forwardRef, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './anchoredPortal.css';

const boxOf = (el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};
const same = (a, b) => !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

const AnchoredPortal = forwardRef(function AnchoredPortal({ anchorRef, open = true, children }, ref) {
  const [box, setBox] = useState(null);

  useLayoutEffect(() => {
    const el = anchorRef?.current;
    if (!open || !el) { setBox(null); return undefined; }
    let frame = 0;
    const place = () => setBox((b) => { const n = boxOf(el); return same(b, n) ? b : n; });
    const soon = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, true);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', soon);
      window.removeEventListener('scroll', soon, true);
      ro?.disconnect();
    };
  }, [open, anchorRef]);

  if (!open || !box) return null;
  return createPortal(
    <div ref={ref} className="pp-anchored" style={box}>{children}</div>,
    document.body,
  );
});

export default AnchoredPortal;
