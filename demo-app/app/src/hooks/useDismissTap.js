import { useEffect, useRef } from 'react';

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
// `escape` (default true) also closes on Escape. `onDismiss` may be an inline arrow — it's
// read through a ref so the listener isn't re-subscribed every render.
export function useDismissTap({ open = true, ref, ref2 = null, onDismiss, escape = true }) {
  const cb = useRef(onDismiss);
  // Keep the latest onDismiss in a ref (written in an effect, not during render) so the
  // subscribe effect below can stay off `onDismiss` in its deps and not re-subscribe
  // every render when callers pass an inline arrow.
  useEffect(() => {
    cb.current = onDismiss;
  });
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (ref?.current?.contains(e.target)) return;
      if (ref2?.current?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      cb.current?.();
    };
    const onKey = escape
      ? (e) => { if (e.key === 'Escape') { e.stopPropagation(); cb.current?.(); } }
      : null;
    document.addEventListener('click', onClick, true);
    if (onKey) window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick, true);
      if (onKey) window.removeEventListener('keydown', onKey);
    };
  }, [open, ref, ref2, escape]);
}

export default useDismissTap;
