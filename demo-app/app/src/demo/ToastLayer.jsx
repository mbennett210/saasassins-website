// ToastLayer: Clean Space's toast stack (components/Toast.jsx), drawn at the page's top level and kept off every
// button. Inside the page (#root is its own layer, z-index 1) the stack drew under everything portaled to <body>, so
// the messages dock's button lay over its Dismiss; at the top level it's over them again, as --z-toast means.
// toastLayer.css lifts it over the bars pinned to the bottom (the dock's button, the phone's floating menu, the
// customer hub's New request). While a toast shows, this gives the page that much more room at its end
// (`--pp-toast-room`, from the bottom of the window to the top of the stack), so a page's last buttons scroll up out
// from under it.
//
// The sync (scripts/sync-polishpoint-demo.mjs) wraps Toast.jsx's stack in it.
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './toastLayer.css';

const GAP = 12; // var(--space-3)

export default function ToastLayer({ children }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const stack = ref.current?.firstElementChild;
    if (!stack) return undefined;
    const root = document.documentElement;
    const place = () => {
      const room = stack.childElementCount ? Math.ceil(window.innerHeight - stack.getBoundingClientRect().top) + GAP : 0;
      root.style.setProperty('--pp-toast-room', `${room}px`);
    };
    place();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    ro?.observe(stack);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      root.style.removeProperty('--pp-toast-room');
    };
  }, []);

  return createPortal(<div ref={ref} className="pp-toast-layer">{children}</div>, document.body);
}
