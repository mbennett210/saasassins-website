import { useEffect, useRef } from 'react';

// Small popover that opens BESIDE an info pin (not a centered modal) and explains
// what a feature does. Positioned in viewport coords from the pin's rect + a
// `side`, clamped on-screen. Dismisses on Escape or an outside click.

const W = 264;
const GAP = 10;
const PAD = 12;

export default function InfoBubble({ pinRect, side = 'bottom', title, body, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('keydown', onKey);
    // Defer the outside-click listener a tick so the click that opened the bubble
    // doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  if (!pinRect) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top;
  let left;
  if (side === 'left') { left = pinRect.left - W - GAP; top = pinRect.top; }
  else if (side === 'right') { left = pinRect.right + GAP; top = pinRect.top; }
  else { left = pinRect.left; top = pinRect.bottom + GAP; } // 'bottom' (default)
  left = Math.max(PAD, Math.min(left, vw - W - PAD));
  top = Math.max(PAD, Math.min(top, vh - 150));

  return (
    <div ref={ref} className="pp-pin-bubble" style={{ top, left, width: W }} role="dialog" aria-label={title}>
      <button type="button" className="pp-pin-bubble-close" onClick={onClose} aria-label="Close">×</button>
      <h4 className="pp-pin-bubble-title">{title}</h4>
      <p className="pp-pin-bubble-body">{body}</p>
    </div>
  );
}
