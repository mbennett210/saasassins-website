import { useRef, useState, useEffect } from 'react';

// Renders children at a fixed native size and transform: scale()s them to fit the
// container (which carries a real aspect ratio via CSS). Mirrors the picker's
// ScaledPreview; uses ResizeObserver so it tracks the container element, not the
// window (some embedded preview contexts report a 0 window size).

export default function ScaledPreview({ nw, nh, children }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setScale(Math.min(r.width / nw, r.height / nh));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nw, nh]);

  return (
    <div ref={ref} className="pp-scaled">
      <div className="pp-scaled-inner" style={{ width: nw, height: nh, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
