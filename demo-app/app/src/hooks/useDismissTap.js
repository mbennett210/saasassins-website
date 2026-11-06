import { useEffect, useRef } from 'react';
import { useEscapeLayer } from './useEscapeLayer';

// useDismissTap — the canonical "outside tap closes the popover and NOTHING else" hook
// (UI_RULES §100: a dismiss layer must EAT the dismiss tap).
//
// The bug it fixes: a popover that closes on a plain `mousedown`/`click` outside listener
// still lets that same tap reach whatever is behind it — so on mobile, tapping away to
// clear a menu/picker also navigates into or activates the thing you happened to tap. The
// fix is a CAPTURE-phase `click` listener that, for a tap outside the popover, calls
// preventDefault + stopPropagation + stopImmediatePropagation BEFORE the event reaches its
// target, then dismisses. The trigger + popover container (passed as `ref`, and optional
// `ref2` for a portaled popover) are spared so their own clicks still run.
//
// Usage: give it the wrapper ref(s), the `open` flag, and an `onDismiss` callback:
//   useDismissTap({ open, ref: wrapRef, onDismiss: () => setOpen(false) });
// `escape` (default true) also closes on Escape, through the one Escape stack (UI_RULES §181):
// only while this popover is the newest layer open, so Esc on a dropdown inside a pop-up closes
// the dropdown and never the pop-up. `onDismiss` may be an inline arrow — it's read through a
// ref so the listener isn't re-subscribed every render. `spare(target)` lets through any other
// click that is the popover's own business (the menu's Launcher: a click in a pop-up portaled
// over it, such as a page tile's confirm, UI_RULES §182); read through a ref the same way.
export function useDismissTap({ open = true, ref, ref2 = null, onDismiss, escape = true, spare = null }) {
  const cb = useRef(onDismiss);
  const spareCb = useRef(spare);
  // Keep the latest onDismiss in a ref (written in an effect, not during render) so the
  // subscribe effect below can stay off `onDismiss` in its deps and not re-subscribe
  // every render when callers pass an inline arrow.
  useEffect(() => {
    cb.current = onDismiss;
    spareCb.current = spare;
  });
  useEscapeLayer(open && escape, () => cb.current?.());
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (ref?.current?.contains(e.target)) return;
      if (ref2?.current?.contains(e.target)) return;
      if (spareCb.current?.(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      cb.current?.();
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
    };
  }, [open, ref, ref2]);
}

export default useDismissTap;
